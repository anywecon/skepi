//! Installed packs between sessions: a file replaced on disk after install keeps its size but not its
//! identity, and the startup reconcile must hash it again instead of trusting the size alone. A pack
//! whose bytes no longer match the signed catalog loses its verified state.

use desktop_core::catalog::{CATALOG_CHUNK_SIZE, PackKind};
use desktop_core::content::{ContentStore, EmbeddedCatalog};
use desktop_core::db::{AppDb, PackRow};
use desktop_core::hash::digest_file;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn repo(p: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(p)
}

fn store(dir: &Path) -> ContentStore {
    let db = Arc::new(AppDb::open(&dir.join("app.db"), &[5u8; 32], 1).expect("db"));
    let embedded = EmbeddedCatalog {
        catalog: std::fs::read(repo("catalog/embedded/debug/catalog.json")).expect("catalog"),
        signature: std::fs::read_to_string(repo("catalog/embedded/debug/catalog.json.sig")).expect("sig"),
        pinned_keys: std::fs::read_to_string(repo("catalog/keys/test.json")).expect("keys"),
        update_urls: vec![],
    };
    ContentStore::new(db, dir.join("appdata"), dir.join("content"), embedded).expect("store")
}

/// Imports the catalog pack `test-smoke-en` (verified) and returns its row.
fn install_verified(s: &ContentStore) -> PackRow {
    let row = s.import_file(&repo("tools/rag-eval/fixtures/eval-smoke-en.zim"), None, |_, _| {}).expect("import");
    assert!(row.verified, "the fixture is in the debug catalog");
    // Real replacements happen later than the install; keep the clocks apart.
    std::thread::sleep(Duration::from_millis(50));
    row
}

fn flipped_last_byte(path: &Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    File::open(path).expect("open").read_to_end(&mut bytes).expect("read");
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    bytes
}

fn mtime(path: &Path) -> std::time::SystemTime {
    std::fs::metadata(path).expect("metadata").modified().expect("mtime")
}

/// Overwrites the last byte in place (same file, same size); optionally restores the old mtime.
fn tamper_in_place(path: &Path, restore_mtime: bool) {
    let before = mtime(path);
    let byte = *flipped_last_byte(path).last().expect("byte");
    let mut f = OpenOptions::new().write(true).open(path).expect("open rw");
    f.seek(SeekFrom::End(-1)).expect("seek");
    f.write_all(&[byte]).expect("write");
    if restore_mtime {
        f.set_modified(before).expect("set mtime");
    }
    drop(f);
    if restore_mtime {
        assert_eq!(mtime(path), before);
    }
}

/// Replaces the file with a new one of the same size and the old mtime (rename over it).
fn tamper_by_rename(path: &Path) {
    let before = mtime(path);
    let side = path.with_extension("swap");
    std::fs::write(&side, flipped_last_byte(path)).expect("write side");
    File::options().write(true).open(&side).expect("open side").set_modified(before).expect("set mtime");
    std::fs::rename(&side, path).expect("rename over");
    assert_eq!(mtime(path), before);
}

fn after_reconcile(s: &ContentStore, id: &str) -> (PackRow, Vec<String>) {
    let report = s.reconcile(|_, _, _| {}).expect("reconcile");
    let row = s.db.get_pack(id).expect("get").expect("still listed (a ZIM is kept unverified)");
    (row, report.changed)
}

#[test]
fn unchanged_pack_is_not_hashed_again() {
    let dir = tempfile::tempdir().expect("tmp");
    let s = store(dir.path());
    let row = install_verified(&s);
    let (after, changed) = after_reconcile(&s, &row.id);
    assert!(changed.is_empty(), "nothing changed on disk: {changed:?}");
    assert!(after.verified);
    // Stable across restarts: a second reconcile hashes nothing either.
    let (again, changed) = after_reconcile(&s, &row.id);
    assert!(changed.is_empty() && again.verified);
}

#[test]
fn same_size_overwrite_in_place_loses_verified() {
    let dir = tempfile::tempdir().expect("tmp");
    let s = store(dir.path());
    let row = install_verified(&s);
    tamper_in_place(Path::new(&row.path), false);
    let (after, changed) = after_reconcile(&s, &row.id);
    assert_eq!(changed, vec![row.id.clone()]);
    assert!(!after.verified, "bytes no longer match the catalog");
    assert_ne!(after.sha256, row.sha256);
}

#[test]
fn same_size_overwrite_with_restored_mtime_loses_verified() {
    let dir = tempfile::tempdir().expect("tmp");
    let s = store(dir.path());
    let row = install_verified(&s);
    tamper_in_place(Path::new(&row.path), true);
    let (after, changed) = after_reconcile(&s, &row.id);
    assert_eq!(changed, vec![row.id.clone()]);
    assert!(!after.verified);
}

#[test]
fn same_size_replacement_by_rename_with_restored_mtime_loses_verified() {
    let dir = tempfile::tempdir().expect("tmp");
    let s = store(dir.path());
    let row = install_verified(&s);
    tamper_by_rename(Path::new(&row.path));
    let (after, changed) = after_reconcile(&s, &row.id);
    assert_eq!(changed, vec![row.id.clone()]);
    assert!(!after.verified);
}

/// A pack verified by an earlier signed catalog that the current catalog no longer lists (v0.1.x shipped
/// catalog 3 with map-gr-20261005; catalog 4 lists map-gr-20261024), registered before file stamps.
fn pack_from_an_older_catalog(s: &ContentStore, kind: PackKind, rel: &str, bytes: &[u8]) -> PackRow {
    let base = install_verified(s);
    // The content root as the store spells it (<root>/zim/<file>).
    let root = Path::new(&base.path).parent().and_then(Path::parent).expect("content root").to_path_buf();
    let path = rel.split('/').fold(root, |p, part| p.join(part));
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    std::fs::write(&path, bytes).expect("write");
    let d = digest_file(&path, CATALOG_CHUNK_SIZE, None, |_, _| {}).expect("digest");
    let row = PackRow {
        id: format!("old-{}", rel.replace(['/', '.'], "-")),
        kind,
        path: path.to_string_lossy().into_owned(),
        size_bytes: d.size_bytes,
        sha256: d.sha256,
        verified: true,
        catalog_seq: Some(3),
        consent_at: None,
        file_stamp: None,
        ..base
    };
    s.db.upsert_pack(&row).expect("upsert");
    row
}

#[test]
fn packs_verified_by_an_earlier_catalog_stay_verified_after_the_upgrade() {
    let dir = tempfile::tempdir().expect("tmp");
    let s = store(dir.path());
    let map = pack_from_an_older_catalog(&s, PackKind::Pmtiles, "maps/map-xx-20261005.pmtiles", &[7u8; 4096]);
    let zim = pack_from_an_older_catalog(&s, PackKind::Zim, "zim/old_2026-07.zim", &[9u8; 4096]);
    let report = s.reconcile(|_, _, _| {}).expect("reconcile");
    assert!(report.rejected_maps.is_empty(), "{:?}", report.rejected_maps);
    assert!(report.changed.is_empty(), "{:?}", report.changed);
    for row in [&map, &zim] {
        let after = s.db.get_pack(&row.id).expect("get").expect("still listed");
        assert!(after.verified, "{} lost its verified state", row.id);
        assert_eq!(after.catalog_seq, Some(3));
        assert!(after.file_stamp.is_some());
        assert!(s.verify(&row.id, None, |_, _| {}).expect("verify").ok, "{}: integrity check", row.id);
    }
}

/// The debug test catalog re-signed with test keys and a `revoked` list (a newer sequence).
fn store_with_revoked(dir: &Path, revoked: &[&str]) -> ContentStore {
    let base: serde_json::Value =
        serde_json::from_slice(&std::fs::read(repo("catalog/embedded/debug/catalog.json")).expect("catalog")).expect("json");
    let mut c = base.clone();
    c["sequence"] = serde_json::Value::from(base["sequence"].as_u64().expect("sequence") + 1);
    c["revoked"] = serde_json::Value::from(revoked.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    // A key made for this test only, pinned as the active test key.
    let sk = ed25519_dalek::SigningKey::from_bytes(&[42u8; 32]);
    let b64 = |b: &[u8]| desktop_core::catalog::to_base64(b);
    let backup = ed25519_dalek::SigningKey::from_bytes(&[43u8; 32]);
    let pinned = serde_json::json!({
        "schema": 1,
        "purpose": "test",
        "active": { "keyId": "cat-test-revoke", "publicKey": b64(sk.verifying_key().as_bytes()) },
        "backup": { "keyId": "cat-test-revoke-b", "publicKey": b64(backup.verifying_key().as_bytes()) },
    });
    c["keyId"] = serde_json::Value::from("cat-test-revoke");
    let bytes = serde_json::to_vec(&c).expect("bytes");
    let signature = b64(&ed25519_dalek::Signer::sign(&sk, &bytes).to_bytes());
    let db = Arc::new(AppDb::open(&dir.join("app.db"), &[5u8; 32], 1).expect("db"));
    let embedded = EmbeddedCatalog { catalog: bytes, signature, pinned_keys: pinned.to_string(), update_urls: vec![] };
    ContentStore::new(db, dir.join("appdata"), dir.join("content"), embedded).expect("store")
}

#[test]
fn a_revoked_hash_loses_its_trust_at_once() {
    let dir = tempfile::tempdir().expect("tmp");
    let (map, zim) = {
        let s = store(dir.path());
        let map = pack_from_an_older_catalog(&s, PackKind::Pmtiles, "maps/map-xx-20261005.pmtiles", &[7u8; 4096]);
        let zim = pack_from_an_older_catalog(&s, PackKind::Zim, "zim/old_2026-07.zim", &[9u8; 4096]);
        s.reconcile(|_, _, _| {}).expect("first start stamps them");
        (map, zim)
    };
    let s = store_with_revoked(dir.path(), &[&map.sha256, &zim.sha256]);
    let report = s.reconcile(|_, _, _| {}).expect("reconcile");
    let mut revoked = report.revoked.clone();
    revoked.sort();
    let mut want = vec![map.id.clone(), zim.id.clone()];
    want.sort();
    assert_eq!(revoked, want);
    assert!(report.rejected_maps.contains(&"map-xx-20261005.pmtiles".to_string()));
    assert!(s.db.get_pack(&map.id).expect("get").is_none());
    let after = s.db.get_pack(&zim.id).expect("get").expect("a ZIM stays listed");
    assert!(!after.verified && after.consent_at.is_none());
    let check = s.verify(&zim.id, None, |_, _| {}).expect("verify");
    assert!(!check.ok && check.revoked);
}

#[test]
fn changed_bytes_of_a_pack_from_an_earlier_catalog_are_not_trusted() {
    let dir = tempfile::tempdir().expect("tmp");
    let s = store(dir.path());
    let map = pack_from_an_older_catalog(&s, PackKind::Pmtiles, "maps/map-xx-20261005.pmtiles", &[7u8; 4096]);
    tamper_in_place(Path::new(&map.path), true);
    let report = s.reconcile(|_, _, _| {}).expect("reconcile");
    assert!(report.rejected_maps.contains(&"map-xx-20261005.pmtiles".to_string()));
    assert!(s.db.get_pack(&map.id).expect("get").is_none());
}

#[tokio::test]
async fn a_pack_downloads_once_at_a_time() {
    let dir = tempfile::tempdir().expect("tmp");
    let s = Arc::new(store(dir.path()));
    let http = desktop_core::download::Http::new().expect("http");
    let slot = s.begin_download("test-smoke-en").expect("first download");
    // A second download of the same pack is refused before it touches the network or the partial file.
    let second = desktop_core::download::download_pack(s.clone(), &http, "test-smoke-en", Arc::default(), |_| {}).await;
    assert!(
        matches!(second, Err(desktop_core::content::ContentError::Download(ref m)) if m.contains("already downloading")),
        "{:?}",
        second.err()
    );
    assert!(!s.tmp_dir().join("eval-smoke-en.zim.partial").exists());
    // Another pack is not blocked; the same pack again once the first download ended.
    drop(s.begin_download("test-mirror-fallback").expect("other pack"));
    drop(slot);
    drop(s.begin_download("test-smoke-en").expect("after the first ended"));
}
