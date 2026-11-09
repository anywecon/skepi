//! Installed packs between sessions: a file replaced on disk after install keeps its size but not its
//! identity, and the startup reconcile must hash it again instead of trusting the size alone. A pack
//! whose bytes no longer match the signed catalog loses its verified state.

use desktop_core::content::{ContentStore, EmbeddedCatalog};
use desktop_core::db::{AppDb, PackRow};
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
