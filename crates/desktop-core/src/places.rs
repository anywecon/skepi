//! Places packs (OSM -> SQLite FTS5, built by tools/catalog-builder): opened read-only, and only
//! verified packs. The UI runs `@skepi/core` `searchPlaces` / `emergencyPois` over this executor, so
//! the query logic stays shared with mobile; this side only guarantees that nothing can write
//! (read-only open, `PRAGMA query_only`, and every statement must be read-only) and that nothing
//! else can be read (no attached databases).

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Number, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum PlacesError {
    #[error("ERR_PLACES_NOT_OPEN: {0}")]
    NotOpen(String),
    #[error("ERR_PLACES_READONLY: only read-only statements are allowed")]
    NotReadOnly,
    #[error("ERR_PLACES: {0}")]
    Sql(#[from] rusqlite::Error),
}

const MAX_ROWS: usize = 5000;

#[derive(Default)]
pub struct Places {
    dbs: Mutex<HashMap<String, Connection>>,
}

fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => n.as_i64().map(SqlValue::Integer).unwrap_or_else(|| SqlValue::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Number(i.into()),
        ValueRef::Real(f) => Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

impl Places {
    /// Opens a verified places pack read-only (no writes, no WAL/journal files next to the pack).
    pub fn open(&self, pack_id: &str, path: &Path) -> Result<(), PlacesError> {
        let uri = format!("file:{}?immutable=1", path.display().to_string().replace('\\', "/").replace('?', "%3f").replace('#', "%23"));
        let conn = Connection::open_with_flags(
            uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.execute_batch("PRAGMA query_only = ON;")?;
        // ATTACH is a read-only statement too: without this limit a query could open any SQLite file
        // the process can read (another app's data, app.db's neighbours) through this connection.
        conn.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_ATTACHED, 0)?;
        self.dbs.lock().unwrap_or_else(|p| p.into_inner()).insert(pack_id.to_owned(), conn);
        Ok(())
    }

    pub fn close_all(&self) {
        self.dbs.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }

    pub fn is_open(&self, pack_id: &str) -> bool {
        self.dbs.lock().unwrap_or_else(|p| p.into_inner()).contains_key(pack_id)
    }

    /// One read-only statement; rows as JSON objects (column name -> value), at most MAX_ROWS.
    pub fn query(&self, pack_id: &str, sql: &str, params: &[Value]) -> Result<Vec<Map<String, Value>>, PlacesError> {
        let dbs = self.dbs.lock().unwrap_or_else(|p| p.into_inner());
        let conn = dbs.get(pack_id).ok_or_else(|| PlacesError::NotOpen(pack_id.into()))?;
        let mut st = conn.prepare(sql)?;
        if !st.readonly() {
            return Err(PlacesError::NotReadOnly);
        }
        let names: Vec<String> = st.column_names().into_iter().map(str::to_owned).collect();
        let sql_params: Vec<SqlValue> = params.iter().map(to_sql).collect();
        let mut rows = st.query(rusqlite::params_from_iter(sql_params))?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            let mut obj = Map::new();
            for (i, n) in names.iter().enumerate() {
                obj.insert(n.clone(), to_json(r.get_ref(i)?));
            }
            out.push(obj);
            if out.len() >= MAX_ROWS {
                break;
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_queries_only() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("p.sqlite");
        {
            let c = Connection::open(&path).expect("create");
            c.execute_batch(
                "CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT, lat REAL); INSERT INTO places VALUES (1, 'Patras', 38.24);",
            )
            .expect("seed");
        }
        let p = Places::default();
        p.open("places-test", &path).expect("open");
        let rows = p.query("places-test", "SELECT name, lat FROM places WHERE id = ?", &[Value::from(1)]).expect("select");
        assert_eq!(rows[0]["name"], Value::from("Patras"));
        assert!(matches!(p.query("places-test", "DELETE FROM places", &[]), Err(PlacesError::NotReadOnly)));
        assert!(matches!(p.query("places-test", "INSERT INTO places VALUES (2, 'x', 0)", &[]), Err(PlacesError::NotReadOnly)));
        assert!(
            p.query("places-test", "PRAGMA query_only = OFF", &[]).is_err() || p.query("places-test", "DELETE FROM places", &[]).is_err()
        );
        assert!(matches!(p.query("other", "SELECT 1", &[]), Err(PlacesError::NotOpen(_))));
    }

    #[test]
    fn no_other_database_can_be_attached() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("p.sqlite");
        Connection::open(&path).expect("create").execute_batch("CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT);").expect("seed");
        // Any other SQLite file the process can read, e.g. another app's or the user's.
        let other = dir.path().join("other.sqlite");
        Connection::open(&other)
            .expect("create")
            .execute_batch("CREATE TABLE secret (v TEXT); INSERT INTO secret VALUES ('private');")
            .expect("seed");
        let p = Places::default();
        p.open("places-test", &path).expect("open");
        let attach = format!("ATTACH DATABASE '{}' AS other", other.display());
        let attached = p.query("places-test", &attach, &[]);
        let leaked = p.query("places-test", "SELECT v FROM other.secret", &[]);
        assert!(attached.is_err() && leaked.is_err(), "attach: {attached:?}, read: {leaked:?}");
    }
}
