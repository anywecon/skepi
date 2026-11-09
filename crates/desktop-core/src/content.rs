//! ContentStore on the desktop (architecture: "Content pipeline"): the user-chosen content folder
//! (`zim/ models/ maps/ tmp/`), the signed catalog with anti-rollback, startup reconcile, file import
//! with the verified/unverified rules, atomic install, and the only internet use of the app:
//! downloads from catalog mirrors (`download.rs`). Nothing under `tmp/` is ever opened.

use crate::catalog::{
    self, Catalog, CatalogPack, PackKind, Rejected, Rejection, SequenceState, TrustedKey, verify_catalog, verify_key_list,
};
use crate::db::{AppDb, DbError, PackRow, PackSource};
use crate::hash::{digest_file, file_stamp};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};

#[derive(Debug, thiserror::Error)]
pub enum ContentError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("catalog: {0}")]
    Catalog(#[from] Rejected),
    #[error("ERR_NO_CATALOG: no valid signed catalog")]
    NoCatalog,
    #[error("ERR_UNKNOWN_PACK: {0} is not in the signed catalog")]
    UnknownPack(String),
    #[error("ERR_UNVERIFIED_REJECTED: {0}")]
    Rejected(String),
    #[error("ERR_NO_SPACE: need {need} bytes free, {free} available")]
    NoSpace { need: u64, free: u64 },
    #[error("ERR_DOWNLOAD: {0}")]
    Download(String),
    #[error("ERR_CANCELLED: cancelled")]
    Cancelled,
    #[error("ERR_PATH: {0}")]
    Path(String),
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Bundled with the build: debug = test catalog + test keys + local mirror sources; release = the
/// release catalog + release keys (apps/desktop/src-tauri/build.rs checks it verifies).
#[derive(Debug, Clone)]
pub struct EmbeddedCatalog {
    pub catalog: Vec<u8>,
    pub signature: String,
    pub pinned_keys: String,
    pub update_urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRejectionReport {
    pub origin: String,
    pub reason: &'static str,
    pub detail: String,
}

#[derive(Debug, Clone, Default)]
struct CatalogState {
    catalog: Option<Catalog>,
    bytes: Option<Vec<u8>>,
    signature: Option<String>,
    origin: Option<String>,
    sha256: Option<String>,
    purpose: Option<String>,
    trusted: Vec<TrustedKey>,
    rejected: Vec<CatalogRejectionReport>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSummary {
    pub catalog: Option<Catalog>,
    /// Exact bytes (base64) and signature, so the UI verifies the same document with packages/core.
    pub bytes_base64: Option<String>,
    pub signature: Option<String>,
    pub origin: Option<String>,
    pub sha256: Option<String>,
    pub purpose: Option<String>,
    pub rejected: Vec<CatalogRejectionReport>,
    pub update_urls: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub registered: Vec<String>,
    pub unverified: Vec<String>,
    pub rejected_models: Vec<String>,
    pub rejected_maps: Vec<String>,
    pub missing: Vec<String>,
    pub changed: Vec<String>,
    pub partials_removed: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub ok: bool,
    pub sha256: String,
    pub expected: Option<String>,
}

pub struct ContentStore {
    pub db: Arc<AppDb>,
    app_data: PathBuf,
    root: RwLock<PathBuf>,
    embedded: EmbeddedCatalog,
    state: RwLock<CatalogState>,
    /// Packs with a download in flight: each pack has one partial file, so one download at a time.
    downloading: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}

/// Held for the whole download of one pack; dropping it lets the next download of that pack start.
pub struct DownloadSlot {
    id: String,
    set: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}

impl Drop for DownloadSlot {
    fn drop(&mut self) {
        self.set.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.id);
    }
}

fn kind_of(dir: &str, name: &str) -> Option<PackKind> {
    let lower = name.to_ascii_lowercase();
    match dir {
        "zim" if lower.ends_with(".zim") => Some(PackKind::Zim),
        "models" if lower.ends_with(".gguf") => Some(PackKind::Gguf),
        "maps" if lower.ends_with(".pmtiles") => Some(PackKind::Pmtiles),
        "maps" if lower.ends_with(".sqlite") => Some(PackKind::Places),
        _ => None,
    }
}

const DIRS: [&str; 4] = ["zim", "models", "maps", "tmp"];

/// Hashes an installed file; an error unless it has exactly these bytes.
fn require_digest(path: &Path, sha256: &str, size: u64, cancel: Option<&AtomicBool>) -> Result<(), ContentError> {
    let d = digest_file(path, catalog::CATALOG_CHUNK_SIZE, cancel, |_, _| {})?;
    if d.sha256 != sha256 || d.size_bytes != size {
        return Err(ContentError::Rejected(format!("{}: the installed file is not the file that was checked", path.display())));
    }
    Ok(())
}

/// Verified ZIM packs, then unverified ones the user consented to (never anything else).
pub fn openable_zims(packs: Vec<PackRow>) -> Vec<PackRow> {
    let mut zims: Vec<PackRow> = packs.into_iter().filter(|p| p.kind == PackKind::Zim && (p.verified || p.consent_at.is_some())).collect();
    zims.sort_by_key(|p| !p.verified);
    zims
}

impl ContentStore {
    pub fn new(db: Arc<AppDb>, app_data: PathBuf, root: PathBuf, embedded: EmbeddedCatalog) -> Result<Self, ContentError> {
        for d in DIRS {
            std::fs::create_dir_all(root.join(d))?;
        }
        let s = Self {
            db,
            app_data,
            root: RwLock::new(root),
            embedded,
            state: RwLock::new(CatalogState::default()),
            downloading: Arc::default(),
        };
        s.load_catalog()?;
        Ok(s)
    }

    pub fn root(&self) -> PathBuf {
        self.root.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Switches the content folder (another drive, a USB stick); call `reconcile` afterwards.
    pub fn set_root(&self, root: PathBuf) -> Result<(), ContentError> {
        for d in DIRS {
            std::fs::create_dir_all(root.join(d))?;
        }
        *self.root.write().unwrap_or_else(|p| p.into_inner()) = root;
        Ok(())
    }

    pub fn tmp_dir(&self) -> PathBuf {
        self.root().join("tmp")
    }

    pub fn final_path(&self, entry: &CatalogPack) -> PathBuf {
        self.root().join(entry.kind.folder()).join(&entry.file)
    }

    fn stored_catalog_dir(&self) -> PathBuf {
        self.app_data.join("catalog")
    }

    fn trusted(&self, pinned: &[TrustedKey]) -> Result<Vec<TrustedKey>, ContentError> {
        // A key list accepted earlier (rotation) replaces the pinned pair.
        if let Some(v) = self.db.get_setting("catalog.keyList")?
            && let Some(keys) = v.get("keys").and_then(|k| k.as_array())
        {
            let rotated: Vec<TrustedKey> = keys
                .iter()
                .filter_map(|k| {
                    let id = k.get("keyId")?.as_str()?;
                    let pk: [u8; 32] = catalog::from_base64(k.get("publicKey")?.as_str()?)?.try_into().ok()?;
                    Some(TrustedKey { key_id: id.to_owned(), public_key: pk })
                })
                .collect();
            if !rotated.is_empty() {
                return Ok(rotated);
            }
        }
        Ok(pinned.to_vec())
    }

    /// Chooses the newest valid catalog among the embedded one and the stored one (selectCatalog in
    /// apps/mobile/src/lib/catalog.ts): anti-rollback against app.db, nothing unverified used.
    pub fn load_catalog(&self) -> Result<(), ContentError> {
        let (purpose, pinned) = catalog::pinned_keys(&self.embedded.pinned_keys).map_err(ContentError::Path)?;
        let trusted = self.trusted(&pinned)?;
        let mut sources: Vec<(String, Vec<u8>, String)> =
            vec![("embedded".into(), self.embedded.catalog.clone(), self.embedded.signature.clone())];
        let dir = self.stored_catalog_dir();
        if let (Ok(b), Ok(s)) = (std::fs::read(dir.join("catalog.json")), std::fs::read_to_string(dir.join("catalog.json.sig"))) {
            sources.push(("stored".into(), b, s));
        }
        let state = self.db.accepted_catalog()?;
        let mut best: Option<(String, Vec<u8>, String, catalog::Verified<Catalog>)> = None;
        let mut rejected = Vec::new();
        for (origin, bytes, sig) in sources {
            match verify_catalog(&bytes, &sig, &trusted, &state) {
                Ok(v) => {
                    if best.as_ref().is_none_or(|b| v.sequence > b.3.sequence) {
                        best = Some((origin, bytes, sig, v));
                    }
                }
                // An embedded catalog older than a stored one is expected (anti-rollback), not an error.
                Err(r) if origin == "embedded" && r.reason == Rejection::Rollback => {}
                Err(r) => rejected.push(CatalogRejectionReport { origin, reason: r.reason.as_str(), detail: r.detail }),
            }
        }
        let mut st = CatalogState { purpose: Some(purpose), trusted, rejected, ..Default::default() };
        if let Some((origin, bytes, sig, v)) = best {
            if state.sequence.is_none_or(|s| v.sequence > s) {
                self.db.set_accepted_catalog(v.sequence, &v.sha256)?;
            }
            if origin == "embedded" {
                self.write_stored(&bytes, &sig)?;
            }
            st.catalog = Some(v.value);
            st.bytes = Some(bytes);
            st.signature = Some(sig);
            st.origin = Some(origin);
            st.sha256 = Some(v.sha256);
        }
        *self.state.write().unwrap_or_else(|p| p.into_inner()) = st;
        Ok(())
    }

    fn write_stored(&self, bytes: &[u8], sig: &str) -> Result<(), ContentError> {
        let dir = self.stored_catalog_dir();
        std::fs::create_dir_all(&dir)?;
        for (name, data) in [("catalog.json", bytes), ("catalog.json.sig", sig.as_bytes())] {
            let tmp = dir.join(format!("{name}.tmp"));
            std::fs::write(&tmp, data)?;
            std::fs::rename(&tmp, dir.join(name))?;
        }
        Ok(())
    }

    /// Verifies and adopts a newer catalog (update download or a peer); returns its sequence.
    pub fn adopt_catalog(&self, bytes: &[u8], signature: &str, origin: &str) -> Result<u64, ContentError> {
        let (trusted, current) = {
            let st = self.state.read().unwrap_or_else(|p| p.into_inner());
            (st.trusted.clone(), st.catalog.as_ref().map(|c| c.sequence))
        };
        let state = self.db.accepted_catalog()?;
        let v = verify_catalog(bytes, signature, &trusted, &state)?;
        if current.is_some_and(|c| v.sequence <= c) {
            return Ok(v.sequence);
        }
        self.write_stored(bytes, signature)?;
        self.db.set_accepted_catalog(v.sequence, &v.sha256)?;
        let mut st = self.state.write().unwrap_or_else(|p| p.into_inner());
        st.catalog = Some(v.value);
        st.bytes = Some(bytes.to_vec());
        st.signature = Some(signature.to_owned());
        st.origin = Some(origin.to_owned());
        st.sha256 = Some(v.sha256);
        Ok(v.sequence)
    }

    /// Key rotation: a key list signed by a trusted key replaces the trusted set.
    pub fn adopt_key_list(&self, bytes: &[u8], signature: &str) -> Result<u64, ContentError> {
        let trusted = self.state.read().unwrap_or_else(|p| p.into_inner()).trusted.clone();
        let prev = self.db.get_setting("catalog.keyList")?;
        let state = SequenceState {
            sequence: prev.as_ref().and_then(|v| v.get("sequence")?.as_u64()),
            sha256: prev.as_ref().and_then(|v| v.get("sha256")?.as_str().map(str::to_owned)),
        };
        let v = verify_key_list(bytes, signature, &trusted, &state)?;
        let keys: Vec<serde_json::Value> =
            v.value.0.keys.iter().map(|k| serde_json::json!({ "keyId": k.key_id, "publicKey": k.public_key })).collect();
        self.db.set_setting("catalog.keyList", &serde_json::json!({ "sequence": v.sequence, "sha256": v.sha256, "keys": keys }))?;
        self.state.write().unwrap_or_else(|p| p.into_inner()).trusted = v.value.1;
        Ok(v.sequence)
    }

    pub fn catalog(&self) -> Option<Catalog> {
        self.state.read().unwrap_or_else(|p| p.into_inner()).catalog.clone()
    }

    /// The accepted catalog's exact bytes and signature (Station mode propagates them).
    pub fn catalog_document(&self) -> Option<(Vec<u8>, String)> {
        let st = self.state.read().unwrap_or_else(|p| p.into_inner());
        Some((st.bytes.clone()?, st.signature.clone()?))
    }

    pub fn summary(&self) -> CatalogSummary {
        let st = self.state.read().unwrap_or_else(|p| p.into_inner());
        CatalogSummary {
            catalog: st.catalog.clone(),
            bytes_base64: st.bytes.as_deref().map(catalog::to_base64),
            signature: st.signature.clone(),
            origin: st.origin.clone(),
            sha256: st.sha256.clone(),
            purpose: st.purpose.clone(),
            rejected: st.rejected.clone(),
            update_urls: self.embedded.update_urls.clone(),
        }
    }

    pub fn update_urls(&self) -> Vec<String> {
        self.embedded.update_urls.clone()
    }

    pub fn list_installed(&self) -> Result<Vec<PackRow>, ContentError> {
        Ok(self.db.list_packs()?)
    }

    fn entry(&self, id: &str) -> Result<CatalogPack, ContentError> {
        let catalog = self.catalog().ok_or(ContentError::NoCatalog)?;
        catalog.find(id).cloned().ok_or_else(|| ContentError::UnknownPack(id.into()))
    }

    /// Free space rule: size + 10% + 1 GB always kept for the OS.
    pub fn check_space(&self, size: u64) -> Result<(), ContentError> {
        let need = size + size / 10 + (1 << 30);
        if let Some(free) = crate::device::free_disk_bytes(&self.root())
            && free < need
        {
            return Err(ContentError::NoSpace { need, free });
        }
        Ok(())
    }

    fn row_for(&self, entry: &CatalogPack, path: &Path, digest_size: u64, sha: &str, source: PackSource) -> PackRow {
        PackRow {
            id: entry.id.clone(),
            kind: entry.kind,
            version: entry.version.clone(),
            title: entry.title.en.clone(),
            path: path.display().to_string(),
            size_bytes: digest_size,
            sha256: sha.to_owned(),
            verified: true,
            catalog_seq: self.catalog().map(|c| c.sequence),
            license: Some(entry.license.clone()),
            source,
            consent_at: None,
            installed_at: now_ms(),
            last_opened_at: None,
            file_stamp: file_stamp(path).ok(),
        }
    }

    /// Atomic install of a verified file from `tmp/`: whole-file hash, rename into place, register.
    /// An older version of the pack with another file name is deleted only after the swap.
    pub fn install_verified(
        &self,
        entry: &CatalogPack,
        partial: &Path,
        source: PackSource,
        cancel: Option<&AtomicBool>,
        progress: impl FnMut(u64, u64),
    ) -> Result<PackRow, ContentError> {
        let d = digest_file(partial, entry.chunk_size, cancel, progress)?;
        if d.sha256 != entry.sha256 || d.size_bytes != entry.size_bytes {
            let _ = std::fs::remove_file(partial);
            return Err(ContentError::Download(format!("{}: the file did not match the signed catalog", entry.id)));
        }
        let target = self.final_path(entry);
        std::fs::create_dir_all(target.parent().ok_or_else(|| ContentError::Path("no parent".into()))?)?;
        std::fs::rename(partial, &target)?;
        let previous = self.db.get_pack(&entry.id)?;
        let row = self.row_for(entry, &target, d.size_bytes, &d.sha256, source);
        self.db.upsert_pack(&row)?;
        if let Some(old) = previous
            && Path::new(&old.path) != target
        {
            let _ = std::fs::remove_file(&old.path);
        }
        Ok(row)
    }

    /// Imports a local file (USB, Kiwix, another folder): copied into `tmp/`, hashed, looked up in the
    /// catalog. Match = verified; otherwise only a ZIM is kept (unverified, consent before opening);
    /// unverified models, maps and places are rejected.
    pub fn import_file(
        &self,
        src: &Path,
        cancel: Option<&AtomicBool>,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<PackRow, ContentError> {
        let name = src.file_name().and_then(|n| n.to_str()).ok_or_else(|| ContentError::Path("invalid file name".into()))?.to_owned();
        let lower = name.to_ascii_lowercase();
        if ![".zim", ".gguf", ".pmtiles", ".sqlite"].iter().any(|e| lower.ends_with(e)) {
            return Err(ContentError::Rejected(format!("{name}: not a ZIM, GGUF, PMTiles or places file")));
        }
        let size = std::fs::metadata(src)?.len();
        self.check_space(size)?;
        let tmp = self.tmp_dir().join(format!("import-{}.partial", now_ms()));
        std::fs::copy(src, &tmp)?;
        let d = match digest_file(&tmp, catalog::CATALOG_CHUNK_SIZE, cancel, &mut progress) {
            Ok(d) => d,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e.into());
            }
        };
        if let Some(entry) = self.catalog().and_then(|c| c.find_by_sha256(&d.sha256).cloned())
            && entry.size_bytes == d.size_bytes
        {
            let row = self.install_verified(&entry, &tmp, PackSource::Import, cancel, &mut progress)?;
            // What is registered must be what was checked: hash the installed file again.
            if let Err(e) = require_digest(Path::new(&row.path), &row.sha256, row.size_bytes, cancel) {
                self.db.remove_pack(&row.id)?;
                let _ = std::fs::remove_file(&row.path);
                return Err(e);
            }
            return Ok(row);
        }
        if !lower.ends_with(".zim") {
            let _ = std::fs::remove_file(&tmp);
            return Err(ContentError::Rejected(format!("{name}: not in the signed catalog (only ZIM files may be added unverified)")));
        }
        let target = self.root().join("zim").join(format!("import-{}.zim", &d.sha256[..16]));
        std::fs::rename(&tmp, &target)?;
        if let Err(e) = require_digest(&target, &d.sha256, d.size_bytes, cancel) {
            let _ = std::fs::remove_file(&target);
            return Err(e);
        }
        let row = PackRow {
            id: format!("local-{}", &d.sha256[..12]),
            kind: PackKind::Zim,
            version: "unverified".into(),
            title: name,
            path: target.display().to_string(),
            size_bytes: d.size_bytes,
            sha256: d.sha256,
            verified: false,
            catalog_seq: None,
            license: None,
            source: PackSource::Import,
            consent_at: None,
            installed_at: now_ms(),
            last_opened_at: None,
            file_stamp: file_stamp(&target).ok(),
        };
        self.db.upsert_pack(&row)?;
        Ok(row)
    }

    pub fn verify(&self, id: &str, cancel: Option<&AtomicBool>, progress: impl FnMut(u64, u64)) -> Result<VerifyResult, ContentError> {
        let p = self.db.get_pack(id)?.ok_or_else(|| ContentError::UnknownPack(id.into()))?;
        let d = digest_file(Path::new(&p.path), catalog::CATALOG_CHUNK_SIZE, cancel, progress)?;
        let expected = self.catalog().and_then(|c| c.find(&p.id).map(|e| e.sha256.clone())).or(Some(p.sha256.clone()));
        Ok(VerifyResult { ok: expected.as_deref() == Some(d.sha256.as_str()), sha256: d.sha256, expected })
    }

    pub fn remove(&self, id: &str) -> Result<(), ContentError> {
        if let Some(p) = self.db.get_pack(id)? {
            let path = PathBuf::from(&p.path);
            if path.starts_with(self.root()) {
                let _ = std::fs::remove_file(&path);
            }
            self.db.remove_pack(id)?;
        }
        Ok(())
    }

    /// Startup check (mobile `reconcile`): registered packs exist with their size and file stamp (any
    /// other identity is hashed again: a same-size replacement must not keep the verified state); files
    /// the database does not know are hashed once and registered when the catalog knows them (unverified ZIM
    /// otherwise; unknown models, maps and places are listed and never opened); stale partials go.
    pub fn reconcile(&self, mut progress: impl FnMut(&str, u64, u64)) -> Result<ReconcileReport, ContentError> {
        let catalog = self.catalog();
        let root = self.root();
        let mut report = ReconcileReport::default();
        for p in self.db.list_packs()? {
            let path = PathBuf::from(&p.path);
            let Ok(meta) = std::fs::metadata(&path) else {
                self.db.remove_pack(&p.id)?;
                report.missing.push(p.id);
                continue;
            };
            if !path.starts_with(&root) {
                // Registered under another content folder (the user switched folders): forget it here.
                self.db.remove_pack(&p.id)?;
                report.missing.push(p.id);
                continue;
            }
            // Taken before hashing: a write during the hash changes it again, so the next start hashes again.
            let stamp = file_stamp(&path).ok();
            if meta.len() == p.size_bytes && stamp.is_some() && stamp == p.file_stamp {
                continue;
            }
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let d = digest_file(&path, catalog::CATALOG_CHUNK_SIZE, None, |h, t| progress(&name, h, t))?;
            let entry = catalog.as_ref().and_then(|c| c.find_by_sha256(&d.sha256).cloned());
            let same_bytes = d.sha256 == p.sha256 && d.size_bytes == p.size_bytes;
            if !same_bytes {
                report.changed.push(p.id.clone());
            }
            if p.kind != PackKind::Zim && entry.is_none() {
                self.db.remove_pack(&p.id)?;
                if p.kind == PackKind::Gguf {
                    report.rejected_models.push(name)
                } else {
                    report.rejected_maps.push(name)
                }
                continue;
            }
            let verified = entry.is_some();
            self.db.upsert_pack(&PackRow {
                sha256: d.sha256,
                size_bytes: d.size_bytes,
                verified,
                catalog_seq: if verified { catalog.as_ref().map(|c| c.sequence) } else { None },
                // Consent was given to the old bytes.
                consent_at: if verified || !same_bytes { None } else { p.consent_at },
                file_stamp: stamp,
                ..p
            })?;
        }
        let known: Vec<String> = self.db.list_packs()?.into_iter().map(|p| p.path).collect();
        for dir in ["zim", "models", "maps"] {
            let Ok(read) = std::fs::read_dir(root.join(dir)) else { continue };
            for f in read.flatten() {
                let path = f.path();
                if !path.is_file() || known.contains(&path.display().to_string()) {
                    continue;
                }
                let name = f.file_name().to_string_lossy().into_owned();
                let Some(kind) = kind_of(dir, &name) else { continue };
                let d = digest_file(&path, catalog::CATALOG_CHUNK_SIZE, None, |h, t| progress(&name, h, t))?;
                let entry = catalog.as_ref().and_then(|c| c.find_by_sha256(&d.sha256).cloned()).filter(|e| e.kind == kind);
                if let Some(entry) = entry {
                    let row = self.row_for(&entry, &path, d.size_bytes, &d.sha256, PackSource::Provisioned);
                    self.db.upsert_pack(&row)?;
                    report.registered.push(entry.id);
                } else if matches!(kind, PackKind::Pmtiles | PackKind::Places) {
                    report.rejected_maps.push(name);
                } else if kind == PackKind::Zim {
                    self.db.upsert_pack(&PackRow {
                        id: format!("local-{}", &d.sha256[..12]),
                        kind,
                        version: "unverified".into(),
                        title: name.clone(),
                        path: path.display().to_string(),
                        size_bytes: d.size_bytes,
                        sha256: d.sha256,
                        verified: false,
                        catalog_seq: None,
                        license: None,
                        source: PackSource::Provisioned,
                        consent_at: None,
                        installed_at: now_ms(),
                        last_opened_at: None,
                        file_stamp: file_stamp(&path).ok(),
                    })?;
                    report.unverified.push(name);
                } else {
                    report.rejected_models.push(name);
                }
            }
        }
        // Partials of catalog packs stay (their verified chunks are the resume point); others go.
        let keep: Vec<String> =
            catalog.as_ref().map(|c| c.packs.iter().map(|p| format!("{}.partial", p.file)).collect()).unwrap_or_default();
        if let Ok(read) = std::fs::read_dir(root.join("tmp")) {
            for f in read.flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                if keep.contains(&name) {
                    continue;
                }
                if std::fs::remove_file(f.path()).is_ok() {
                    report.partials_removed += 1;
                }
            }
        }
        Ok(report)
    }

    /// ZIM packs that may be opened, verified ones first: a ZIM declaring the UUID of an already open
    /// archive is refused by the registry, so the order decides that a verified pack keeps its id.
    pub fn openable_zims(&self) -> Result<Vec<PackRow>, ContentError> {
        Ok(openable_zims(self.list_installed()?))
    }

    pub fn set_consent(&self, id: &str) -> Result<(), ContentError> {
        Ok(self.db.set_consent(id, Some(now_ms()))?)
    }

    /// The only way to start a download: a second download of a pack already in flight would write
    /// the same partial file and could change bytes after they were hashed.
    pub fn begin_download(&self, id: &str) -> Result<DownloadSlot, ContentError> {
        let mut set = self.downloading.lock().unwrap_or_else(|p| p.into_inner());
        if !set.insert(id.to_owned()) {
            return Err(ContentError::Download(format!("{id} is already downloading")));
        }
        Ok(DownloadSlot { id: id.to_owned(), set: self.downloading.clone() })
    }

    /// The catalog entry a download needs (only catalog packs can be downloaded).
    pub fn download_entry(&self, id: &str) -> Result<CatalogPack, ContentError> {
        self.entry(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zim(id: &str, verified: bool, consent: bool) -> PackRow {
        PackRow {
            id: id.into(),
            kind: PackKind::Zim,
            version: "1".into(),
            title: id.into(),
            path: format!("C:/content/zim/{id}.zim"),
            size_bytes: 1,
            sha256: "a".repeat(64),
            verified,
            catalog_seq: verified.then_some(1),
            license: None,
            source: PackSource::Import,
            consent_at: consent.then_some(1),
            installed_at: 1,
            last_opened_at: None,
            file_stamp: None,
        }
    }

    #[test]
    fn verified_zims_open_before_consented_unverified_ones() {
        let mut model = zim("model", true, false);
        model.kind = PackKind::Gguf;
        let order: Vec<String> = openable_zims(vec![
            zim("a-unverified", false, true),
            zim("b-no-consent", false, false),
            model,
            zim("c-verified", true, false),
            zim("d-unverified", false, true),
            zim("e-verified", true, false),
        ])
        .into_iter()
        .map(|p| p.id)
        .collect();
        assert_eq!(order, ["c-verified", "e-verified", "a-unverified", "d-unverified"]);
    }
}
