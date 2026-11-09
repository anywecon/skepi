//! The desktop's only internet code (architecture: "Network only in ContentStore"): downloads a
//! catalog pack from its HTTPS mirrors into `tmp/<file>.partial` with HTTP Range resume, checks every
//! 64 MiB chunk against the signed catalog as it arrives (a bad chunk ends that mirror, the next one
//! is tried), then hashes the whole file and installs it atomically. Requests carry a generic
//! `User-Agent: SKEPI`, no query strings (the catalog forbids them) and no identifiers.

use crate::catalog::{CatalogPack, hex, is_allowed_download_url};
use crate::content::{ContentError, ContentStore};
use crate::db::{PackRow, PackSource};
use crate::hash::chunk_hashes_prefix;
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const USER_AGENT: &str = "SKEPI";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub pack_id: String,
    /// contracts `DownloadPhase`.
    pub phase: &'static str,
    pub bytes: u64,
    pub total_bytes: u64,
    pub mirror: u32,
    pub rejected_mirrors: u32,
    pub error: Option<String>,
}

/// HTTPS clients: system roots (Windows store via the platform verifier) for every mirror; debug
/// builds with the `test-mirror` feature use a second client that trusts only the local test mirror
/// CA, and only for `https://127.0.0.1:8443`.
pub struct Http {
    public: reqwest::Client,
    #[cfg(feature = "test-mirror")]
    mirror: reqwest::Client,
}

#[cfg(feature = "test-mirror")]
const TEST_MIRROR_CA: &[u8] = include_bytes!("../../../e2e/mirror/certs/ca.crt");
#[cfg(feature = "test-mirror")]
const TEST_MIRROR_ORIGIN: &str = "https://127.0.0.1:8443/";

fn builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .https_only(true)
        .no_proxy()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        // Redirects stay on HTTPS (https_only); the bytes are trusted only through the catalog hash.
        .redirect(reqwest::redirect::Policy::limited(5))
}

impl Http {
    pub fn new() -> Result<Self, ContentError> {
        crate::install_crypto_provider();
        let public = builder().build().map_err(|e| ContentError::Download(e.to_string()))?;
        #[cfg(feature = "test-mirror")]
        let mirror = {
            let ca = reqwest::Certificate::from_pem(TEST_MIRROR_CA).map_err(|e| ContentError::Download(e.to_string()))?;
            builder().tls_certs_only([ca]).build().map_err(|e| ContentError::Download(e.to_string()))?
        };
        Ok(Self {
            public,
            #[cfg(feature = "test-mirror")]
            mirror,
        })
    }

    fn client(&self, url: &str) -> &reqwest::Client {
        #[cfg(feature = "test-mirror")]
        if url.starts_with(TEST_MIRROR_ORIGIN) {
            return &self.mirror;
        }
        let _ = url;
        &self.public
    }

    /// Small documents (catalog.json and its .sig), size-capped.
    pub async fn get_small(&self, url: &str, max: usize) -> Result<Vec<u8>, ContentError> {
        if !is_allowed_download_url(url) {
            return Err(ContentError::Download(format!("refused URL {url}")));
        }
        let res = self.client(url).get(url).send().await.map_err(|e| ContentError::Download(e.to_string()))?;
        if !res.status().is_success() {
            return Err(ContentError::Download(format!("GET {url}: HTTP {}", res.status())));
        }
        let mut out = Vec::new();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ContentError::Download(e.to_string()))?;
            if out.len() + chunk.len() > max {
                return Err(ContentError::Download(format!("{url}: larger than {max} bytes")));
            }
            out.extend_from_slice(&chunk);
        }
        Ok(out)
    }
}

/// "Check for catalog update": catalog.json + .sig from each update URL, adopted only when valid and newer.
pub async fn check_catalog_update(store: &ContentStore, http: &Http) -> Result<Option<u64>, ContentError> {
    let mut last_err = None;
    for base in store.update_urls() {
        let bytes = match http.get_small(&format!("{base}catalog.json"), 4 << 20).await {
            Ok(b) => b,
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        };
        let sig = match http.get_small(&format!("{base}catalog.json.sig"), 4096).await {
            Ok(s) => String::from_utf8_lossy(&s).into_owned(),
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        };
        return Ok(Some(store.adopt_catalog(&bytes, &sig, "update")?));
    }
    match last_err {
        Some(e) => Err(e),
        None => Ok(None),
    }
}

enum MirrorOutcome {
    Complete,
    /// Bytes did not match the catalog (the partial was deleted): try the next mirror.
    Rejected(String),
    /// Network trouble: the verified prefix stays for a resume; try the next mirror.
    Failed(String),
}

/// Verified prefix of an existing partial (whole chunks matching the catalog); the rest is cut off.
fn resume_point(partial: &Path, entry: &CatalogPack) -> std::io::Result<u64> {
    if !partial.exists() {
        return Ok(0);
    }
    let on_disk = chunk_hashes_prefix(partial, entry.chunk_size)?;
    let good = on_disk.iter().zip(&entry.chunk_sha256).take_while(|(a, b)| a == b).count() as u64;
    let offset = (good * entry.chunk_size).min(entry.size_bytes);
    let f = std::fs::OpenOptions::new().write(true).open(partial)?;
    f.set_len(offset)?;
    Ok(offset)
}

async fn fetch_mirror(
    http: &Http,
    url: &str,
    entry: &CatalogPack,
    partial: &Path,
    cancel: &AtomicBool,
    report: &mut (dyn FnMut(u64) + Send),
) -> Result<MirrorOutcome, ContentError> {
    let mut offset = resume_point(partial, entry)?;
    if offset == entry.size_bytes {
        return Ok(MirrorOutcome::Complete);
    }
    let mut req = http.client(url).get(url);
    if offset > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={offset}-"));
    }
    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => return Ok(MirrorOutcome::Failed(e.to_string())),
    };
    let status = res.status().as_u16();
    if offset > 0 && status == 200 {
        // The mirror ignored the range: start over.
        offset = 0;
    } else if !(status == 200 || status == 206) {
        return Ok(MirrorOutcome::Failed(format!("HTTP {status}")));
    }
    let mut file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(partial)?;
    file.set_len(offset)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut index = (offset / entry.chunk_size) as usize;
    let mut in_chunk = 0u64;
    let mut hasher = Sha256::new();
    let mut written = offset;
    let mut stream = res.bytes_stream();
    while let Some(next) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Err(ContentError::Cancelled);
        }
        let data = match next {
            Ok(d) => d,
            Err(e) => return Ok(MirrorOutcome::Failed(e.to_string())),
        };
        if written + data.len() as u64 > entry.size_bytes {
            drop(file);
            let _ = std::fs::remove_file(partial);
            return Ok(MirrorOutcome::Rejected("the mirror sent more bytes than the catalog size".into()));
        }
        file.write_all(&data)?;
        let mut pos = 0usize;
        while pos < data.len() {
            let chunk_len = entry.chunk_size.min(entry.size_bytes - index as u64 * entry.chunk_size);
            let take = ((chunk_len - in_chunk) as usize).min(data.len() - pos);
            hasher.update(&data[pos..pos + take]);
            in_chunk += take as u64;
            pos += take;
            if in_chunk == chunk_len {
                let got = hex(&std::mem::take(&mut hasher).finalize());
                if entry.chunk_sha256.get(index) != Some(&got) {
                    drop(file);
                    let _ = std::fs::remove_file(partial);
                    return Ok(MirrorOutcome::Rejected(format!("chunk {index} did not match the signed catalog")));
                }
                index += 1;
                in_chunk = 0;
            }
        }
        written += data.len() as u64;
        report(written);
    }
    file.flush()?;
    if written < entry.size_bytes {
        return Ok(MirrorOutcome::Failed(format!("connection closed at {written} of {} bytes", entry.size_bytes)));
    }
    Ok(MirrorOutcome::Complete)
}

/// Downloads, verifies and installs one catalog pack, trying the mirrors in order.
pub async fn download_pack(
    store: Arc<ContentStore>,
    http: &Http,
    pack_id: &str,
    cancel: Arc<AtomicBool>,
    mut on: impl FnMut(DownloadProgress) + Send,
) -> Result<PackRow, ContentError> {
    let entry = store.download_entry(pack_id)?;
    // Held until this function returns: no second download of this pack shares the partial file.
    let _slot = store.begin_download(&entry.id)?;
    store.check_space(entry.size_bytes)?;
    let partial = store.tmp_dir().join(format!("{}.partial", entry.file));
    let total = entry.size_bytes;
    let mut rejected = 0u32;
    let mut last_error = String::from("no mirror");
    let emit = |on: &mut (dyn FnMut(DownloadProgress) + Send),
                phase: &'static str,
                bytes: u64,
                mirror: u32,
                rejected: u32,
                error: Option<String>| {
        on(DownloadProgress { pack_id: entry.id.clone(), phase, bytes, total_bytes: total, mirror, rejected_mirrors: rejected, error });
    };
    for (i, url) in entry.urls.iter().enumerate() {
        if !is_allowed_download_url(url) {
            continue;
        }
        let mirror = i as u32;
        emit(&mut on, "downloading", 0, mirror, rejected, None);
        let mut last_emit = std::time::Instant::now();
        let outcome = {
            let mut report = |bytes: u64| {
                if last_emit.elapsed() >= Duration::from_millis(250) {
                    last_emit = std::time::Instant::now();
                    emit(&mut on, "downloading", bytes, mirror, rejected, None);
                }
            };
            fetch_mirror(http, url, &entry, &partial, &cancel, &mut report).await
        };
        match outcome {
            Err(ContentError::Cancelled) => {
                emit(&mut on, "cancelled", 0, mirror, rejected, None);
                return Err(ContentError::Cancelled);
            }
            Err(e) => return Err(e),
            Ok(MirrorOutcome::Rejected(why)) => {
                rejected += 1;
                last_error = why;
                continue;
            }
            Ok(MirrorOutcome::Failed(why)) => {
                last_error = why;
                continue;
            }
            Ok(MirrorOutcome::Complete) => {}
        }
        emit(&mut on, "verifying", 0, mirror, rejected, None);
        let store2 = store.clone();
        let entry2 = entry.clone();
        let partial2 = partial.clone();
        let cancel2 = cancel.clone();
        let installed = tokio::task::spawn_blocking(move || {
            store2.install_verified(&entry2, &partial2, PackSource::Download, Some(&cancel2), |_, _| {})
        })
        .await
        .map_err(|e| ContentError::Download(e.to_string()))?;
        match installed {
            Ok(row) => {
                emit(&mut on, "done", total, mirror, rejected, None);
                return Ok(row);
            }
            Err(ContentError::Download(why)) => {
                rejected += 1;
                last_error = why;
            }
            Err(e) => return Err(e),
        }
    }
    emit(&mut on, "failed", 0, 0, rejected, Some(last_error.clone()));
    Err(ContentError::Download(format!("{pack_id}: {last_error}")))
}
