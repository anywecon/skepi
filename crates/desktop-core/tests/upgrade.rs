//! Release gate (docs/release-process.md, step 6), desktop side: upgrading from a published version keeps
//! every installed pack in its state. v0.1.2-preview (catalog 3) and v0.2.1-preview (catalog 4) left an
//! app.db at migration 3 (no file stamps) with their packs verified; the candidate migrates it, hashes each
//! pack once and must keep each one verified: the catalog-3 map and places as "verified by an older
//! catalog" (catalog 4 lists newer versions), everything else by the current catalog. Synthetic packs and
//! two test catalogs signed with a key made for this test stand in for the real ones (same ids, kinds and
//! file names; catalog 3 → 4 changed exactly the map and places files, as here).

use desktop_core::catalog::{CATALOG_CHUNK_SIZE, Catalog, to_base64};
use desktop_core::content::{ContentStore, EmbeddedCatalog};
use desktop_core::db::{AppDb, migrate, migrations};
use desktop_core::hash::digest_file;
use ed25519_dalek::{Signer, SigningKey};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const KEY: [u8; 32] = [5u8; 32];

struct Pack {
    id: &'static str,
    kind: &'static str,
    dir: &'static str,
    file: &'static str,
    bytes: Vec<u8>,
}

impl Pack {
    fn new(id: &'static str, kind: &'static str, dir: &'static str, file: &'static str, seed: u8) -> Self {
        Self { id, kind, dir, file, bytes: (0..8192u32).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect() }
    }
}

fn sha(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn entry(p: &Pack) -> Value {
    let h = sha(&p.bytes);
    json!({
        "id": p.id, "kind": p.kind, "version": "1", "file": p.file, "title": { "en": p.id }, "lang": ["en"],
        "sizeBytes": p.bytes.len(), "sha256": h, "chunkSize": CATALOG_CHUNK_SIZE, "chunkSha256": [h],
        "urls": [format!("https://example.org/{}", p.file)], "license": "CC0-1.0", "attribution": "test",
        "minTier": "T0", "tags": [],
    })
}

/// A schema 1 catalog with these packs, signed by the test key (sequence 3 or 4, as the real ones).
fn catalog(sequence: u64, packs: &[&Pack]) -> (Vec<u8>, String) {
    let body = json!({
        "schema": 1, "sequence": sequence, "issuedAt": "2026-10-24T00:00:00Z", "keyId": "cat-test-upgrade",
        "packs": packs.iter().map(|p| entry(p)).collect::<Vec<_>>(),
    });
    let bytes = serde_json::to_vec(&body).expect("bytes");
    let signature = to_base64(&signing_key().sign(&bytes).to_bytes());
    (bytes, signature)
}

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[77u8; 32])
}

fn pinned() -> String {
    let backup = SigningKey::from_bytes(&[78u8; 32]);
    json!({
        "schema": 1, "purpose": "test",
        "active": { "keyId": "cat-test-upgrade", "publicKey": to_base64(signing_key().verifying_key().as_bytes()) },
        "backup": { "keyId": "cat-test-upgrade-b", "publicKey": to_base64(backup.verifying_key().as_bytes()) },
    })
    .to_string()
}

fn store(dir: &Path, catalog: (Vec<u8>, String)) -> ContentStore {
    let db = Arc::new(AppDb::open(&dir.join("app.db"), &KEY, 2).expect("db"));
    let embedded = EmbeddedCatalog { catalog: catalog.0, signature: catalog.1, pinned_keys: pinned(), update_urls: vec![] };
    ContentStore::new(db, dir.join("appdata"), dir.join("content"), embedded).expect("store")
}

/// What a published version left behind: the pack files in the content folder and an app.db at
/// migration 3 whose rows say verified by `sequence` (the columns of that schema, no file stamp).
fn published_install(dir: &Path, sequence: u64, packs: &[&Pack]) {
    let root = dir.join("content");
    let mut conn = Connection::open(dir.join("app.db")).expect("open");
    conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", desktop_core::catalog::hex(&KEY))).expect("key");
    migrate(&mut conn, &migrations()[..3], 1).expect("migrations 1-3");
    for p in packs {
        let path: PathBuf = root.join(p.dir).join(p.file);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, &p.bytes).expect("write");
        let d = digest_file(&path, CATALOG_CHUNK_SIZE, None, |_, _| {}).expect("digest");
        conn.execute(
            "INSERT INTO packs (id, kind, version, title, path, size_bytes, sha256, verified, catalog_seq, license, source, consent_at, installed_at, last_opened_at)
             VALUES (?, ?, '1', ?, ?, ?, ?, 1, ?, 'CC0-1.0', 'download', NULL, 1, NULL)",
            params![p.id, p.kind, p.id, path.to_string_lossy(), d.size_bytes as i64, d.sha256, sequence as i64],
        )
        .expect("row");
    }
}

/// Every pack still listed and verified after the candidate's first start; returns the ids the current
/// catalog does not list (shown as "Verified (older catalog)").
fn upgrade(dir: &Path, current: (Vec<u8>, String), packs: &[&Pack]) -> Vec<String> {
    let s = store(dir, current);
    let report = s.reconcile(|_, _, _| {}).expect("reconcile");
    assert!(report.rejected_maps.is_empty() && report.rejected_models.is_empty(), "ignored after the upgrade: {report:?}");
    assert!(report.changed.is_empty() && report.missing.is_empty() && report.revoked.is_empty(), "{report:?}");
    let catalog: Catalog = s.catalog().expect("catalog");
    let mut older = Vec::new();
    for p in packs {
        let row = s.db.get_pack(p.id).expect("get").unwrap_or_else(|| panic!("{} is gone after the upgrade", p.id));
        assert!(row.verified, "{} lost its verified state", row.id);
        assert!(row.file_stamp.is_some(), "{} was not stamped", row.id);
        assert!(s.verify(p.id, None, |_, _| {}).expect("verify").ok, "{}: integrity check", p.id);
        if catalog.find_by_sha256(&row.sha256).is_none() {
            older.push(row.id);
        }
    }
    // A second start trusts the stamps: nothing changes.
    let again = s.reconcile(|_, _, _| {}).expect("second start");
    assert!(again.changed.is_empty() && again.rejected_maps.is_empty());
    older.sort();
    older
}

fn packs() -> (Pack, Pack, Pack, Pack, Pack) {
    (
        Pack::new("wikipedia_en_medicine_mini", "zim", "zim", "wikipedia_en_medicine_mini_2026-04.zim", 1),
        Pack::new("map-gr", "pmtiles", "maps", "map-gr-20261005.pmtiles", 2),
        Pack::new("places-gr", "places", "maps", "places-gr-20261004.sqlite", 3),
        Pack::new("map-gr", "pmtiles", "maps", "map-gr-20261024.pmtiles", 4),
        Pack::new("places-gr", "places", "maps", "places-gr-20261023.sqlite", 5),
    )
}

#[test]
fn from_v0_1_2_with_catalog_3_packs() {
    let (zim, map3, places3, map4, places4) = packs();
    let dir = tempfile::tempdir().expect("tmp");
    published_install(dir.path(), 3, &[&zim, &map3, &places3]);
    let older = upgrade(dir.path(), catalog(4, &[&zim, &map4, &places4]), &[&zim, &map3, &places3]);
    assert_eq!(older, vec!["map-gr".to_string(), "places-gr".to_string()]);
}

#[test]
fn from_v0_2_1_with_catalog_4_packs() {
    let (zim, _, _, map4, places4) = packs();
    let dir = tempfile::tempdir().expect("tmp");
    published_install(dir.path(), 4, &[&zim, &map4, &places4]);
    let older = upgrade(dir.path(), catalog(4, &[&zim, &map4, &places4]), &[&zim, &map4, &places4]);
    assert!(older.is_empty(), "{older:?}");
}
