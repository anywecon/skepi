//! App propagation from the Station: a phone without SKEPI opens `http://<host>:<port>/` and downloads
//! a release APK the user chose on the desktop (as `ApkServer.kt`: cleartext, exactly `/` and
//! `/skepi.apk`, nothing else). The APK's signing certificate SHA-256 is read from its APK Signature
//! Scheme v3/v2 block and shown on the page and in the app, next to whether it matches the published
//! SKEPI release key. Android verifies the signature itself when installing.

use crate::catalog::sha256_hex;
use std::io::{Read, Seek, SeekFrom};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::{Notify, Semaphore, watch};

/// The APK page serves at most this many connections at once (more are closed at accept).
const MAX_CONNECTIONS: usize = 8;
/// Deadline for the request head; a download that accepts no bytes for `WRITE_STALL` is closed.
const HEAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const WRITE_STALL: std::time::Duration = std::time::Duration::from_secs(30);

/// docs/release-signing.md: SHA-256 of the release signing certificate of org.skepi.app.
pub const RELEASE_SIGNING_SHA256: &str = "7d61c38241b178f84b12dd9a67af6b60b56159b1a0ff067fe672db45dd45447e";

const V2_ID: u32 = 0x7109_871a;
const V3_ID: u32 = 0xf053_68c0;

fn read_at(f: &mut std::fs::File, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf)?;
    Ok(buf)
}

fn u32le(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn u64le(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

/// A u32-length-prefixed slice at `at`; returns (content, next offset).
fn lp(b: &[u8], at: usize) -> Option<(&[u8], usize)> {
    let len = u32le(b, at)? as usize;
    let start = at + 4;
    Some((b.get(start..start.checked_add(len)?)?, start + len))
}

/// SHA-256 of the first signer's certificate (v3 preferred, then v2), lowercase hex.
pub fn signing_cert_sha256(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    if size < 22 {
        return Err("not an APK (too small)".into());
    }
    // End of central directory: the last 0x06054b50 within the final 64 KiB + 22 bytes.
    let tail_len = size.min(65_557) as usize;
    let tail = read_at(&mut f, size - tail_len as u64, tail_len).map_err(|e| e.to_string())?;
    let eocd = (0..=tail_len - 22)
        .rev()
        .find(|&i| tail[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])
        .ok_or("not an APK (no end of central directory)")?;
    let cd_offset = u64::from(u32le(&tail, eocd + 16).ok_or("bad EOCD")?);
    if cd_offset < 32 {
        return Err("APK has no signing block".into());
    }
    let footer = read_at(&mut f, cd_offset - 24, 24).map_err(|e| e.to_string())?;
    if &footer[8..24] != b"APK Sig Block 42" {
        return Err("APK has no v2/v3 signing block".into());
    }
    let block_size = u64le(&footer, 0).ok_or("bad signing block")?;
    if block_size > cd_offset || block_size > 64 << 20 {
        return Err("bad signing block size".into());
    }
    let block = read_at(&mut f, cd_offset - block_size - 8, (block_size + 8) as usize).map_err(|e| e.to_string())?;
    // Pairs: u64 length, u32 id, value; between the leading size and the trailing size + magic.
    let mut at = 8usize;
    let end = block.len() - 24;
    let mut found: Vec<(u32, &[u8])> = Vec::new();
    while at + 12 <= end {
        let len = u64le(&block, at).ok_or("bad pair")? as usize;
        let id = u32le(&block, at + 8).ok_or("bad pair")?;
        let value = block.get(at + 12..at + 8 + len).ok_or("bad pair length")?;
        found.push((id, value));
        at += 8 + len;
    }
    let value = found
        .iter()
        .find(|(id, _)| *id == V3_ID)
        .or_else(|| found.iter().find(|(id, _)| *id == V2_ID))
        .map(|(_, v)| *v)
        .ok_or("no v2/v3 signature")?;
    // signers -> first signer -> signed data -> digests (skip) -> certificates -> first certificate.
    let (signers, _) = lp(value, 0).ok_or("bad signers")?;
    let (signer, _) = lp(signers, 0).ok_or("bad signer")?;
    let (signed_data, _) = lp(signer, 0).ok_or("bad signed data")?;
    let (_, after_digests) = lp(signed_data, 0).ok_or("bad digests")?;
    let (certs, _) = lp(signed_data, after_digests).ok_or("bad certificates")?;
    let (cert, _) = lp(certs, 0).ok_or("no certificate")?;
    Ok(sha256_hex(cert))
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn page(name: &str, size: u64, fingerprint: &str, official: bool) -> Vec<u8> {
    let fp = fingerprint
        .to_ascii_uppercase()
        .as_bytes()
        .chunks(2)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join(":");
    let mb = format!("{:.1}", size as f64 / 1_048_576.0);
    let note = if official {
        "This fingerprint matches the published SKEPI release key."
    } else {
        "This fingerprint does NOT match the published SKEPI release key. Install only if you trust where it came from."
    };
    format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{n} — install</title>
<style>body{{font-family:sans-serif;max-width:40em;margin:1em auto;padding:0 1em;line-height:1.5}}a.button{{display:inline-block;padding:.8em 1.2em;background:#1d4ed8;color:#fff;border-radius:8px;text-decoration:none;font-weight:600}}code{{word-break:break-all;font-size:.9em}}</style>
</head><body>
<h1>{n}</h1>
<p>Offline survival knowledge, maps and emergency cards. This copy comes from the SKEPI Station next to you, over the local network.</p>
<p><a class="button" href="/skepi.apk" download="skepi.apk">Download the app ({mb} MB)</a></p>
<p>Then open the downloaded file and allow installing from your browser or file manager when Android asks.</p>
<h2>Check the signature</h2>
<p>Signing certificate SHA-256 of this APK:</p>
<p><code>{fp}</code></p>
<p>{note} Compare it with the fingerprint the SKEPI project publishes. If it differs, do not install. Android also refuses later updates signed with another key.</p>
</body></html>
"#,
        n = esc(name),
    )
    .into_bytes()
}

pub struct ApkServer {
    port: u16,
    running: Arc<AtomicBool>,
    stop: Arc<Notify>,
    pub signing_sha256: String,
    pub official: bool,
}

impl ApkServer {
    pub async fn start(bind: SocketAddr, apk: PathBuf) -> Result<Self, String> {
        let signing = signing_cert_sha256(&apk)?;
        let official = signing == RELEASE_SIGNING_SHA256;
        let size = std::fs::metadata(&apk).map_err(|e| e.to_string())?.len();
        let body = Arc::new(page("SKEPI", size, &signing, official));
        let listener = TcpListener::bind(bind).await.map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let running = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(Notify::new());
        let (r, st) = (running.clone(), stop.clone());
        let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        // Ends every connection task when the page stops sharing.
        let (stopped_tx, stopped_rx) = watch::channel(false);
        tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    a = listener.accept() => a,
                    () = st.notified() => break,
                };
                if !r.load(Ordering::SeqCst) {
                    break;
                }
                let Ok((mut tcp, _)) = accepted else {
                    // Out of descriptors or similar: do not spin.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                };
                let Ok(permit) = permits.clone().try_acquire_owned() else { continue };
                let (body, apk) = (body.clone(), apk.clone());
                let mut stopped = stopped_rx.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let Ok(Ok(req)) = tokio::time::timeout(HEAD_TIMEOUT, super::http::read_request(&mut tcp)).await else { return };
                    let serve = async {
                        if req.method != "GET" {
                            super::http::plain(&mut tcp, 405, "Method Not Allowed").await?;
                        } else if req.path == "/" {
                            super::http::write_head(
                                &mut tcp,
                                200,
                                "OK",
                                &[
                                    ("Content-Type", "text/html; charset=utf-8".into()),
                                    ("Content-Length", body.len().to_string()),
                                    ("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'".into()),
                                ],
                            )
                            .await?;
                            tcp.write_all(&body).await?;
                        } else if req.path == "/skepi.apk" {
                            let mut f = tokio::fs::File::open(&apk).await?;
                            let len = f.metadata().await?.len();
                            super::http::write_head(
                                &mut tcp,
                                200,
                                "OK",
                                &[
                                    ("Content-Type", "application/vnd.android.package-archive".into()),
                                    ("Content-Length", len.to_string()),
                                    ("Content-Disposition", "attachment; filename=\"skepi.apk\"".into()),
                                ],
                            )
                            .await?;
                            let mut buf = vec![0u8; 256 * 1024];
                            loop {
                                let n = tokio::io::AsyncReadExt::read(&mut f, &mut buf).await?;
                                if n == 0 {
                                    break;
                                }
                                tokio::time::timeout(WRITE_STALL, tcp.write_all(&buf[..n]))
                                    .await
                                    .map_err(|_| std::io::Error::other("write stalled"))??;
                            }
                        } else {
                            super::http::plain(&mut tcp, 404, "Not Found").await?;
                        }
                        tcp.flush().await
                    };
                    tokio::select! {
                        _ = serve => {}
                        _ = stopped.wait_for(|s| *s) => {}
                    }
                });
            }
            let _ = stopped_tx.send(true);
        });
        Ok(Self { port, running, stop, signing_sha256: signing, official })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn stop(&self) {
        if self.running.swap(false, Ordering::SeqCst) {
            self.stop.notify_waiters();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal zip with an APK Signing Block holding one v2 signer and one certificate.
    pub(crate) fn fake_apk(cert: &[u8]) -> Vec<u8> {
        fn lp(v: &[u8]) -> Vec<u8> {
            let mut o = (v.len() as u32).to_le_bytes().to_vec();
            o.extend_from_slice(v);
            o
        }
        let certs = lp(&lp(cert));
        let mut signed = lp(&[]); // digests
        signed.extend(certs);
        let signer = lp(&lp(&signed));
        let value = lp(&signer);
        let mut pair = ((value.len() + 4) as u64).to_le_bytes().to_vec();
        pair.extend(V2_ID.to_le_bytes());
        pair.extend(&value);
        let block_size = (pair.len() + 24) as u64;
        let mut apk = b"PK\x03\x04 local file entries".to_vec();
        apk.extend(block_size.to_le_bytes());
        apk.extend(&pair);
        apk.extend(block_size.to_le_bytes());
        apk.extend(b"APK Sig Block 42");
        let cd_offset = apk.len() as u32;
        apk.extend(b"PK\x01\x02 central directory");
        let mut eocd = vec![0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 1, 0, 1, 0];
        eocd.extend(20u32.to_le_bytes());
        eocd.extend(cd_offset.to_le_bytes());
        eocd.extend(0u16.to_le_bytes());
        apk.extend(eocd);
        apk
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_apk_page_caps_and_times_out_idle_connections() {
        use tokio::io::AsyncReadExt;
        let dir = tempfile::tempdir().expect("tmp");
        let apk = dir.path().join("skepi.apk");
        std::fs::write(&apk, fake_apk(b"certificate")).expect("apk");
        let server = ApkServer::start("127.0.0.1:0".parse().expect("addr"), apk).await.expect("start");
        let addr: SocketAddr = format!("127.0.0.1:{}", server.port()).parse().expect("addr");
        let mut idle = Vec::with_capacity(20);
        for _ in 0..20 {
            idle.push(tokio::net::TcpStream::connect(addr).await.expect("connect"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let started = std::time::Instant::now();
        let waits: Vec<_> = idle
            .into_iter()
            .map(|mut s| {
                tokio::spawn(async move {
                    let mut b = [0u8; 1];
                    let r = tokio::time::timeout(std::time::Duration::from_secs(8), s.read(&mut b)).await;
                    (matches!(r, Ok(Ok(0)) | Ok(Err(_))), started.elapsed())
                })
            })
            .collect();
        let mut closed_at = Vec::new();
        for w in waits {
            let (closed, at) = w.await.expect("join");
            assert!(closed, "every idle connection is closed");
            closed_at.push(at);
        }
        // Beyond the cap they are closed at once; the others after the head deadline, not after 30 s.
        assert!(closed_at.iter().filter(|t| t.as_millis() < 1_000).count() >= 20 - MAX_CONNECTIONS, "{closed_at:?}");
        assert!(closed_at.iter().all(|t| *t < HEAD_TIMEOUT + std::time::Duration::from_secs(2)), "{closed_at:?}");
        server.stop();
    }

    #[test]
    fn reads_the_signing_certificate_hash() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("a.apk");
        std::fs::write(&path, fake_apk(b"certificate DER bytes")).expect("write");
        assert_eq!(signing_cert_sha256(&path).expect("parse"), sha256_hex(b"certificate DER bytes"));
        std::fs::write(&path, b"PK\x05\x06 not really an apk at all....").expect("write");
        assert!(signing_cert_sha256(&path).is_err());
    }
}
