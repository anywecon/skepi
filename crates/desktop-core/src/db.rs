//! app.db on the desktop: SQLCipher through rusqlite, the key from `keystore` (DPAPI), and exactly the
//! numbered migrations of `packages/db` (embedded from `packages/db/migrations.json`, which a unit test
//! keeps equal to `MIGRATIONS`). Same ledger rules as `migrate()` in packages/db/src/db.ts: a database
//! from a newer app or with an edited migration is refused.

use crate::catalog::{PackKind, SequenceState};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;

const MIGRATIONS_JSON: &str = include_str!("../../../packages/db/migrations.json");

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("database: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("migration: {0}")]
    Migration(String),
    #[error("setting {0}: {1}")]
    Setting(String, String),
}

#[derive(Debug, Clone, Deserialize)]
pub struct Migration {
    pub version: u32,
    pub name: String,
    pub statements: Vec<String>,
}

#[derive(Deserialize)]
struct MigrationsFile {
    schema: u32,
    migrations: Vec<Migration>,
}

pub fn migrations() -> Vec<Migration> {
    let f: MigrationsFile = serde_json::from_str(MIGRATIONS_JSON).expect("packages/db/migrations.json is valid");
    assert_eq!(f.schema, 1, "migrations.json schema");
    f.migrations
}

const LEDGER: &str = "CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)";

pub fn migrate(conn: &mut Connection, list: &[Migration], now_ms: i64) -> Result<Vec<u32>, DbError> {
    for (i, m) in list.iter().enumerate() {
        if m.version as usize != i + 1 {
            return Err(DbError::Migration(format!("migrations must be numbered 1..n without gaps (at index {i})")));
        }
    }
    conn.execute_batch(LEDGER)?;
    let applied: Vec<(u32, String)> = {
        let mut st = conn.prepare("SELECT version, name FROM schema_migrations ORDER BY version")?;
        st.query_map([], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?)))?.collect::<Result<_, _>>()?
    };
    for (v, name) in &applied {
        match list.iter().find(|m| m.version == *v) {
            None => {
                return Err(DbError::Migration(format!(
                    "database has migration {v} ({name}), newer than this app; downgrades are not supported"
                )));
            }
            Some(m) if &m.name != name => {
                return Err(DbError::Migration(format!("migration {v} is \"{name}\" in the database but \"{}\" in the code", m.name)));
            }
            _ => {}
        }
    }
    let mut ran = Vec::new();
    for m in list {
        if applied.iter().any(|(v, _)| *v == m.version) {
            continue;
        }
        let tx = conn.transaction()?;
        for sql in &m.statements {
            tx.execute_batch(sql)?;
        }
        tx.execute("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", params![m.version, m.name, now_ms])?;
        tx.commit()?;
        ran.push(m.version);
    }
    Ok(ran)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackSource {
    Download,
    Import,
    Provisioned,
    P2p,
}

impl PackSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Download => "download",
            Self::Import => "import",
            Self::Provisioned => "provisioned",
            Self::P2p => "p2p",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "download" => Self::Download,
            "import" => Self::Import,
            "p2p" => Self::P2p,
            _ => Self::Provisioned,
        }
    }
}

/// One installed file (packages/db `PackRow`, contracts `InstalledPack`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRow {
    pub id: String,
    pub kind: PackKind,
    pub version: String,
    pub title: String,
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub verified: bool,
    pub catalog_seq: Option<u64>,
    pub license: Option<String>,
    pub source: PackSource,
    pub consent_at: Option<i64>,
    pub installed_at: i64,
    pub last_opened_at: Option<i64>,
    /// `hash::file_stamp` of the file when it was last hashed (None: never stamped, hashed at startup).
    #[serde(default, skip_serializing)]
    pub file_stamp: Option<String>,
}

fn to_pack(r: &rusqlite::Row<'_>) -> rusqlite::Result<PackRow> {
    let kind: String = r.get("kind")?;
    let source: String = r.get("source")?;
    Ok(PackRow {
        id: r.get("id")?,
        kind: PackKind::parse(&kind).unwrap_or(PackKind::Zim),
        version: r.get("version")?,
        title: r.get("title")?,
        path: r.get("path")?,
        size_bytes: r.get::<_, i64>("size_bytes")? as u64,
        sha256: r.get("sha256")?,
        verified: r.get::<_, i64>("verified")? == 1,
        catalog_seq: r.get::<_, Option<i64>>("catalog_seq")?.map(|v| v as u64),
        license: r.get("license")?,
        source: PackSource::parse(&source),
        consent_at: r.get("consent_at")?,
        installed_at: r.get("installed_at")?,
        last_opened_at: r.get("last_opened_at")?,
        file_stamp: r.get("file_stamp")?,
    })
}

/// Settings the UI may read and write through IPC; everything else (catalog state, key list,
/// downloads in flight) is written only by the native side.
pub const UI_SETTINGS: &[&str] = &[
    "dev.simulateT1",
    "dev.greekUi",
    "downloads.allowMetered",
    "onboarding.completedAt",
    "disclaimer.acceptedAt",
    "ui.locale",
    "region.country",
    "storage.budgetGb",
    "blackout.enabled",
    "desktop.contentRoot",
    "desktop.aiPowerCap",
];

/// The same per-key type rules as packages/db `VALIDATORS` (plus the desktop-only keys).
pub fn validate_setting(key: &str, v: &Value) -> bool {
    let timestamp = |v: &Value| v.as_i64().is_some_and(|n| n > 0) || v.as_u64().is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991);
    match key {
        "dev.simulateT1" | "dev.greekUi" | "downloads.allowMetered" | "blackout.enabled" => v.is_boolean(),
        "onboarding.completedAt" | "disclaimer.acceptedAt" => timestamp(v),
        "ui.locale" => matches!(v.as_str(), Some("system" | "en" | "el")),
        "region.country" => v.as_str().is_some_and(|s| s.len() == 2 && s.bytes().all(|b| b.is_ascii_uppercase())),
        "storage.budgetGb" => v.as_f64().is_some_and(|n| n.is_finite() && n > 0.0 && n <= 4096.0),
        "desktop.contentRoot" => v.as_str().is_some_and(|s| !s.is_empty() && s.len() < 1024),
        "desktop.aiPowerCap" => matches!(v.as_str(), Some("full" | "balanced" | "low" | "off")),
        "catalog.accepted" => v.get("sequence").and_then(Value::as_u64).is_some() && v.get("sha256").and_then(Value::as_str).is_some(),
        "catalog.keyList" => v.get("sequence").and_then(Value::as_u64).is_some() && v.get("keys").and_then(Value::as_array).is_some(),
        _ => false,
    }
}

pub struct AppDb {
    conn: Mutex<Connection>,
}

impl AppDb {
    /// Opens (or creates) the encrypted database with a 32-byte raw key and applies the migrations.
    pub fn open(path: &Path, key: &[u8; 32], now_ms: i64) -> Result<Self, DbError> {
        let mut conn = Connection::open(path)?;
        // Raw key (no PBKDF2 on a random 256-bit key), as SQLCipher documents for `x'…'` keys.
        conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", crate::catalog::hex(key)))?;
        // Fails with "file is not a database" when the key is wrong.
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))?;
        let cipher: Option<String> = conn.query_row("PRAGMA cipher_version", [], |r| r.get(0)).optional()?;
        if cipher.is_none() {
            return Err(DbError::Migration("SQLCipher is not active (cipher_version empty)".into()));
        }
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        migrate(&mut conn, &migrations(), now_ms)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, DbError>) -> Result<T, DbError> {
        let mut c = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut c)
    }

    pub fn schema_version(&self) -> Result<u32, DbError> {
        self.with(|c| Ok(c.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |r| r.get(0))?))
    }

    pub fn upsert_pack(&self, p: &PackRow) -> Result<(), DbError> {
        self.with(|c| {
            c.execute(
                "INSERT INTO packs (id, kind, version, title, path, size_bytes, sha256, verified, catalog_seq, license, source, consent_at, installed_at, last_opened_at, file_stamp)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, version = excluded.version, title = excluded.title, path = excluded.path,
                   size_bytes = excluded.size_bytes, sha256 = excluded.sha256, verified = excluded.verified, catalog_seq = excluded.catalog_seq,
                   license = excluded.license, source = excluded.source, consent_at = excluded.consent_at, installed_at = excluded.installed_at,
                   last_opened_at = excluded.last_opened_at, file_stamp = excluded.file_stamp",
                params![
                    p.id,
                    p.kind.as_str(),
                    p.version,
                    p.title,
                    p.path,
                    p.size_bytes as i64,
                    p.sha256,
                    p.verified as i64,
                    p.catalog_seq.map(|v| v as i64),
                    p.license,
                    p.source.as_str(),
                    p.consent_at,
                    p.installed_at,
                    p.last_opened_at,
                    p.file_stamp
                ],
            )?;
            Ok(())
        })
    }

    pub fn list_packs(&self) -> Result<Vec<PackRow>, DbError> {
        self.with(|c| {
            let mut st = c.prepare("SELECT * FROM packs ORDER BY kind, id")?;
            let rows = st.query_map([], to_pack)?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn get_pack(&self, id: &str) -> Result<Option<PackRow>, DbError> {
        self.with(|c| Ok(c.query_row("SELECT * FROM packs WHERE id = ?", [id], to_pack).optional()?))
    }

    pub fn remove_pack(&self, id: &str) -> Result<(), DbError> {
        self.with(|c| {
            c.execute("DELETE FROM packs WHERE id = ?", [id])?;
            Ok(())
        })
    }

    pub fn set_consent(&self, id: &str, at: Option<i64>) -> Result<(), DbError> {
        self.with(|c| {
            c.execute("UPDATE packs SET consent_at = ? WHERE id = ? AND verified = 0", params![at, id])?;
            Ok(())
        })
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<Value>, DbError> {
        self.with(|c| {
            let raw: Option<String> = c.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)).optional()?;
            // A corrupt value never crashes startup: it reads as unset.
            Ok(raw.and_then(|s| serde_json::from_str::<Value>(&s).ok()).filter(|v| validate_setting(key, v)))
        })
    }

    pub fn set_setting(&self, key: &str, value: &Value) -> Result<(), DbError> {
        if !validate_setting(key, value) {
            return Err(DbError::Setting(key.into(), "invalid value".into()));
        }
        self.with(|c| {
            c.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value.to_string()],
            )?;
            Ok(())
        })
    }

    pub fn delete_setting(&self, key: &str) -> Result<(), DbError> {
        self.with(|c| {
            c.execute("DELETE FROM settings WHERE key = ?", [key])?;
            Ok(())
        })
    }

    /// Anti-rollback floor (`catalog.accepted`).
    pub fn accepted_catalog(&self) -> Result<SequenceState, DbError> {
        Ok(match self.get_setting("catalog.accepted")? {
            Some(v) => SequenceState {
                sequence: v.get("sequence").and_then(Value::as_u64),
                sha256: v.get("sha256").and_then(Value::as_str).map(str::to_owned),
            },
            None => SequenceState::default(),
        })
    }

    pub fn set_accepted_catalog(&self, sequence: u64, sha256: &str) -> Result<(), DbError> {
        self.set_setting("catalog.accepted", &serde_json::json!({ "sequence": sequence, "sha256": sha256 }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(id: &str, verified: bool, kind: PackKind) -> PackRow {
        PackRow {
            id: id.into(),
            kind,
            version: "1".into(),
            title: "T".into(),
            path: format!("C:/content/{id}"),
            size_bytes: 10,
            sha256: "a".repeat(64),
            verified,
            catalog_seq: verified.then_some(3),
            license: None,
            source: PackSource::Download,
            consent_at: None,
            installed_at: 1,
            last_opened_at: None,
            file_stamp: None,
        }
    }

    #[test]
    fn encrypted_database_with_the_shared_migrations() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("app.db");
        let key = [7u8; 32];
        let db = AppDb::open(&path, &key, 1).expect("open");
        assert_eq!(db.schema_version().expect("version") as usize, migrations().len());
        db.upsert_pack(&pack("p1", true, PackKind::Zim)).expect("insert");
        db.upsert_pack(&pack("p2", false, PackKind::Zim)).expect("unverified zim allowed");
        assert!(db.upsert_pack(&pack("p3", false, PackKind::Gguf)).is_err(), "unverified non-ZIM refused by CHECK");
        assert_eq!(db.list_packs().expect("list").len(), 2);
        drop(db);
        // Not plaintext SQLite, and the wrong key cannot open it.
        let header = std::fs::read(&path).expect("read");
        assert!(!header.starts_with(b"SQLite format 3"));
        assert!(AppDb::open(&path, &[8u8; 32], 1).is_err());
        let again = AppDb::open(&path, &key, 2).expect("reopen");
        assert_eq!(again.get_pack("p1").expect("get").map(|p| p.verified), Some(true));
    }

    #[test]
    fn refuses_newer_or_edited_databases() {
        let mut conn = Connection::open_in_memory().expect("mem");
        let list = migrations();
        migrate(&mut conn, &list, 1).expect("migrate");
        assert!(migrate(&mut conn, &list, 2).expect("again").is_empty());
        let mut edited = list.clone();
        edited[0].name = "renamed".into();
        assert!(migrate(&mut conn, &edited, 3).is_err());
        assert!(migrate(&mut conn, &list[..1], 4).is_err(), "database newer than the app");
    }

    #[test]
    fn settings_are_typed_and_allowlisted() {
        let dir = tempfile::tempdir().expect("tmp");
        let db = AppDb::open(&dir.path().join("s.db"), &[1u8; 32], 1).expect("open");
        db.set_setting("blackout.enabled", &Value::Bool(true)).expect("set");
        assert_eq!(db.get_setting("blackout.enabled").expect("get"), Some(Value::Bool(true)));
        assert!(db.set_setting("region.country", &Value::from("gr")).is_err());
        assert!(db.set_setting("unknown.key", &Value::Bool(true)).is_err());
        db.set_accepted_catalog(4, &"b".repeat(64)).expect("catalog");
        assert_eq!(db.accepted_catalog().expect("state").sequence, Some(4));
        assert!(!UI_SETTINGS.contains(&"catalog.accepted"));
    }
}
