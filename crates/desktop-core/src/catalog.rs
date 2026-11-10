//! Signed catalog verification, rule for rule the same as `packages/core/src/catalog.ts` (the UI uses
//! the TypeScript one; this copy lets the Rust ContentStore and Station mode decide on their own, so
//! a compromised webview cannot make the native side download or serve a file outside the catalog).
//! Ed25519 over the exact bytes, pinned keys or a rotated key list, strict schema, anti-rollback.
//! `tests/catalog_parity.rs` runs both implementations' fixtures (catalog/embedded, e2e/mirror).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signature, VerifyingKey};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

pub const CATALOG_SCHEMA: u64 = 1;
/// Schema 2 (global maps, 2026-10-23): map and places packs may carry `region`. Older apps reject it
/// as a whole and keep their catalog (catalog.ts `CATALOG_SCHEMA_REGIONS`).
pub const CATALOG_SCHEMA_REGIONS: u64 = 2;
pub const KEY_LIST_SCHEMA: u64 = 1;
pub const CATALOG_CHUNK_SIZE: u64 = 64 * 1024 * 1024;

static HEX64: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{64}$").expect("regex"));
static PACK_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9._-]{1,79}$").expect("regex"));
static KEY_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9._-]{0,63}$").expect("regex"));
static ISO2: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z]{2}$").expect("regex"));
static PART_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,31}$").expect("regex"));
static FILE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$").expect("regex"));
static DOWNLOAD_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^https://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?(/[A-Za-z0-9._~!$&'()*+,;=:%/-]*)?$").expect("regex")
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum PackKind {
    Zim,
    Gguf,
    Pmtiles,
    Places,
}

impl PackKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "zim" => Some(Self::Zim),
            "gguf" => Some(Self::Gguf),
            "pmtiles" => Some(Self::Pmtiles),
            "places" => Some(Self::Places),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Zim => "zim",
            Self::Gguf => "gguf",
            Self::Pmtiles => "pmtiles",
            Self::Places => "places",
        }
    }

    /// File extension on disk.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Zim => ".zim",
            Self::Gguf => ".gguf",
            Self::Pmtiles => ".pmtiles",
            Self::Places => ".sqlite",
        }
    }

    /// Content sub-folder (architecture: `zim/ models/ maps/`).
    pub fn folder(self) -> &'static str {
        match self {
            Self::Zim => "zim",
            Self::Gguf => "models",
            Self::Pmtiles | Self::Places => "maps",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Title {
    pub en: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub el: Option<String>,
}

/// One part of a country split into several map packs: the first-level subdivisions it covers
/// (`regions`: English and local names, for search) and its own bounding box.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionPart {
    pub id: String,
    pub name: String,
    pub regions: Vec<String>,
    pub bbox: [f64; 4],
}

/// At most this many subdivision names per part (Italy: 110 provinces), as in catalog.ts.
const PART_REGIONS_MAX: usize = 500;

/// The country of a map or places pack (schema 2). `bbox` is west, south, east, north; west > east
/// crosses the antimeridian. `center` is longitude, latitude.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRegion {
    pub iso2: String,
    pub name: String,
    pub bbox: [f64; 4],
    pub center: [f64; 2],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<RegionPart>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPack {
    pub id: String,
    pub kind: PackKind,
    pub version: String,
    pub file: String,
    pub title: Title,
    pub lang: Vec<String>,
    pub size_bytes: u64,
    pub sha256: String,
    pub chunk_size: u64,
    pub chunk_sha256: Vec<String>,
    pub urls: Vec<String>,
    pub license: String,
    pub attribution: String,
    pub min_tier: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<PackRegion>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema: u64,
    pub sequence: u64,
    pub issued_at: String,
    pub key_id: String,
    pub packs: Vec<CatalogPack>,
    /// SHA-256 of pack files that are no longer trusted (optional; architecture "Pack trust across
    /// catalogs"). Apps before this field reject such a catalog as a whole and keep theirs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub revoked: Vec<String>,
}

impl Catalog {
    pub fn find_by_sha256(&self, digest: &str) -> Option<&CatalogPack> {
        let d = digest.to_ascii_lowercase();
        self.packs.iter().find(|p| p.sha256 == d)
    }

    /// True when the catalog withdraws trust from files with this SHA-256.
    pub fn is_revoked(&self, digest: &str) -> bool {
        let d = digest.to_ascii_lowercase();
        self.revoked.contains(&d)
    }

    pub fn find(&self, id: &str) -> Option<&CatalogPack> {
        self.packs.iter().find(|p| p.id == id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedKey {
    pub key_id: String,
    pub public_key: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Rejection {
    Malformed,
    Schema,
    UnknownKey,
    BadSignature,
    Rollback,
    SequenceReuse,
}

impl Rejection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::Schema => "schema",
            Self::UnknownKey => "unknown_key",
            Self::BadSignature => "bad_signature",
            Self::Rollback => "rollback",
            Self::SequenceReuse => "sequence_reuse",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}: {detail}", reason.as_str())]
pub struct Rejected {
    pub reason: Rejection,
    pub detail: String,
}

fn reject(reason: Rejection, detail: impl Into<String>) -> Rejected {
    Rejected { reason, detail: detail.into() }
}

/// Highest sequence accepted on this device and the SHA-256 of that document.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SequenceState {
    pub sequence: Option<u64>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Verified<T> {
    pub value: T,
    pub sequence: u64,
    pub sha256: String,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

/// Strict base64 (standard alphabet, padded), surrounding whitespace trimmed — as `fromBase64`.
pub fn from_base64(text: &str) -> Option<Vec<u8>> {
    STANDARD.decode(text.trim()).ok()
}

pub fn to_base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// A `.sig` file: base64 of the 64-byte signature, any whitespace ignored.
pub fn decode_signature(text: &str) -> Option<[u8; 64]> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    from_base64(&compact)?.try_into().ok()
}

fn decode_key(b64: &str) -> Option<[u8; 32]> {
    from_base64(b64)?.try_into().ok()
}

fn verify_bytes(bytes: &[u8], signature: &str, key: &TrustedKey) -> bool {
    let Some(sig) = decode_signature(signature) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&key.public_key) else { return false };
    // Strict RFC 8032 verification (noble: zip215 = false).
    vk.verify_strict(bytes, &Signature::from_bytes(&sig)).is_ok()
}

// ---- schema (the same checks, messages and order as catalog.ts) ----

type Obj = Map<String, Value>;

fn obj<'a>(v: &'a Value, path: &str) -> Result<&'a Obj, String> {
    v.as_object().ok_or_else(|| format!("{path}: expected an object"))
}

fn text<'a>(v: Option<&'a Value>, path: &str, re: Option<&Regex>) -> Result<&'a str, String> {
    match v.and_then(Value::as_str) {
        Some(s) if !s.is_empty() && re.is_none_or(|r| r.is_match(s)) => Ok(s),
        _ => Err(format!("{path}: invalid")),
    }
}

/// A JSON number that is a safe integer ≥ min (JavaScript's `Number.isSafeInteger`).
fn int(v: Option<&Value>, path: &str, min: u64) -> Result<u64, String> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let n = v.and_then(|v| {
        if let Some(u) = v.as_u64() {
            return Some(u as f64);
        }
        if let Some(i) = v.as_i64() {
            return Some(i as f64);
        }
        v.as_f64()
    });
    match n {
        Some(f) if f.fract() == 0.0 && f.abs() <= MAX_SAFE && f >= min as f64 => Ok(f as u64),
        _ => Err(format!("{path}: expected an integer ≥ {min}")),
    }
}

fn strings(v: Option<&Value>, path: &str, min_items: usize) -> Result<Vec<String>, String> {
    let arr = match v.and_then(Value::as_array) {
        Some(a) if a.len() >= min_items => a,
        _ => return Err(format!("{path}: expected at least {min_items} item(s)")),
    };
    arr.iter().enumerate().map(|(i, x)| text(Some(x), &format!("{path}[{i}]"), None).map(str::to_owned)).collect()
}

fn no_extra_keys(o: &Obj, allowed: &[&str], path: &str) -> Result<(), String> {
    let extra: Vec<&str> = o.keys().map(String::as_str).filter(|k| !allowed.contains(k)).collect();
    if extra.is_empty() { Ok(()) } else { Err(format!("{path}: unexpected field(s) {}", extra.join(", "))) }
}

pub fn is_allowed_download_url(url: &str) -> bool {
    DOWNLOAD_URL.is_match(url)
}

const PACK_FIELDS: &[&str] = &[
    "id",
    "kind",
    "version",
    "file",
    "title",
    "lang",
    "sizeBytes",
    "sha256",
    "chunkSize",
    "chunkSha256",
    "urls",
    "license",
    "attribution",
    "minTier",
    "tags",
];

fn coordinate(v: Option<&Value>, path: &str, limit: f64) -> Result<f64, String> {
    match v.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n.abs() <= limit => Ok(n),
        _ => Err(format!("{path}: invalid")),
    }
}

fn parse_bbox(v: Option<&Value>, path: &str) -> Result<[f64; 4], String> {
    let a = match v.and_then(Value::as_array) {
        Some(a) if a.len() == 4 => a,
        _ => return Err(format!("{path}: expected [west, south, east, north]")),
    };
    let bbox = [
        coordinate(a.first(), &format!("{path}[0]"), 180.0)?,
        coordinate(a.get(1), &format!("{path}[1]"), 90.0)?,
        coordinate(a.get(2), &format!("{path}[2]"), 180.0)?,
        coordinate(a.get(3), &format!("{path}[3]"), 90.0)?,
    ];
    if bbox[0] == bbox[2] || bbox[1] >= bbox[3] {
        return Err(format!("{path}: expected west ≠ east and south < north"));
    }
    Ok(bbox)
}

fn parse_part(v: &Value, path: &str) -> Result<RegionPart, String> {
    let o = v.as_object().ok_or_else(|| format!("{path}: expected an object"))?;
    no_extra_keys(o, &["id", "name", "regions", "bbox"], path)?;
    let list = match o.get("regions").and_then(Value::as_array) {
        Some(a) if !a.is_empty() && a.len() <= PART_REGIONS_MAX => a,
        _ => return Err(format!("{path}.regions: expected 1–{PART_REGIONS_MAX} names")),
    };
    let regions = list
        .iter()
        .enumerate()
        .map(|(i, r)| text(Some(r), &format!("{path}.regions[{i}]"), None).map(str::to_owned))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RegionPart {
        id: text(o.get("id"), &format!("{path}.id"), Some(&PART_ID))?.to_owned(),
        name: text(o.get("name"), &format!("{path}.name"), None)?.to_owned(),
        regions,
        bbox: parse_bbox(o.get("bbox"), &format!("{path}.bbox"))?,
    })
}

fn parse_region(v: &Value, path: &str) -> Result<PackRegion, String> {
    let o = obj(v, path)?;
    no_extra_keys(o, &["iso2", "name", "bbox", "center", "part"], path)?;
    let bbox = parse_bbox(o.get("bbox"), &format!("{path}.bbox"))?;
    let center_v = match o.get("center").and_then(Value::as_array) {
        Some(a) if a.len() == 2 => a,
        _ => return Err(format!("{path}.center: expected [longitude, latitude]")),
    };
    let center = [
        coordinate(center_v.first(), &format!("{path}.center[0]"), 180.0)?,
        coordinate(center_v.get(1), &format!("{path}.center[1]"), 90.0)?,
    ];
    let iso2 = text(o.get("iso2"), &format!("{path}.iso2"), Some(&ISO2))?.to_owned();
    let name = text(o.get("name"), &format!("{path}.name"), None)?.to_owned();
    let part = o.get("part").map(|p| parse_part(p, &format!("{path}.part"))).transpose()?;
    Ok(PackRegion { iso2, name, bbox, center, part })
}

fn parse_pack(v: &Value, path: &str, schema: u64) -> Result<CatalogPack, String> {
    let o = obj(v, path)?;
    if schema == CATALOG_SCHEMA_REGIONS {
        let mut fields = PACK_FIELDS.to_vec();
        fields.push("region");
        no_extra_keys(o, &fields, path)?;
    } else {
        no_extra_keys(o, PACK_FIELDS, path)?;
    }
    let kind = o.get("kind").and_then(Value::as_str).and_then(PackKind::parse).ok_or_else(|| format!("{path}.kind: invalid"))?;
    let file = text(o.get("file"), &format!("{path}.file"), Some(&FILE_NAME))?;
    if !file.to_ascii_lowercase().ends_with(kind.extension()) {
        return Err(format!("{path}.file: expected a {} file", kind.extension()));
    }
    let title_v = o.get("title").ok_or_else(|| format!("{path}.title: expected an object"))?;
    let title_o = title_v.as_object().ok_or_else(|| format!("{path}.title: expected an object"))?;
    no_extra_keys(title_o, &["en", "el"], &format!("{path}.title"))?;
    let title = Title {
        en: text(title_o.get("en"), &format!("{path}.title.en"), None)?.to_owned(),
        el: match title_o.get("el") {
            Some(v) => Some(text(Some(v), &format!("{path}.title.el"), None)?.to_owned()),
            None => None,
        },
    };
    let size_bytes = int(o.get("sizeBytes"), &format!("{path}.sizeBytes"), 1)?;
    let chunk_size = int(o.get("chunkSize"), &format!("{path}.chunkSize"), 1)?;
    let chunk_sha256 = strings(o.get("chunkSha256"), &format!("{path}.chunkSha256"), 1)?;
    if chunk_sha256.len() as u64 != size_bytes.div_ceil(chunk_size) {
        return Err(format!("{path}.chunkSha256: wrong number of chunks"));
    }
    for (i, h) in chunk_sha256.iter().enumerate() {
        if !HEX64.is_match(h) {
            return Err(format!("{path}.chunkSha256[{i}]: invalid"));
        }
    }
    let urls = strings(o.get("urls"), &format!("{path}.urls"), 1)?;
    for (i, u) in urls.iter().enumerate() {
        if !is_allowed_download_url(u) {
            return Err(format!("{path}.urls[{i}]: HTTPS without query string required"));
        }
    }
    let min_tier = match o.get("minTier").and_then(Value::as_str) {
        Some(t @ ("T0" | "T1" | "T2" | "T3")) => t.to_owned(),
        _ => return Err(format!("{path}.minTier: invalid")),
    };
    let id = text(o.get("id"), &format!("{path}.id"), Some(&PACK_ID))?.to_owned();
    let version = text(o.get("version"), &format!("{path}.version"), None)?.to_owned();
    let lang = strings(o.get("lang"), &format!("{path}.lang"), 1)?;
    let sha256 = text(o.get("sha256"), &format!("{path}.sha256"), Some(&HEX64))?.to_owned();
    let license = text(o.get("license"), &format!("{path}.license"), None)?.to_owned();
    let attribution = text(o.get("attribution"), &format!("{path}.attribution"), None)?.to_owned();
    let tags = strings(o.get("tags"), &format!("{path}.tags"), 0)?;
    let region = match o.get("region") {
        None => None,
        Some(r) => {
            if kind != PackKind::Pmtiles && kind != PackKind::Places {
                return Err(format!("{path}.region: only map and places packs have a region"));
            }
            Some(parse_region(r, &format!("{path}.region"))?)
        }
    };
    Ok(CatalogPack {
        id,
        kind,
        version,
        file: file.to_owned(),
        title,
        lang,
        size_bytes,
        sha256,
        chunk_size,
        chunk_sha256,
        urls,
        license,
        attribution,
        min_tier,
        tags,
        region,
    })
}

pub fn parse_catalog(data: &Value) -> Result<Catalog, String> {
    let o = obj(data, "catalog")?;
    no_extra_keys(o, &["schema", "sequence", "issuedAt", "keyId", "packs", "revoked"], "catalog")?;
    let schema = match o.get("schema").and_then(Value::as_f64) {
        Some(n) if n == CATALOG_SCHEMA as f64 => CATALOG_SCHEMA,
        Some(n) if n == CATALOG_SCHEMA_REGIONS as f64 => CATALOG_SCHEMA_REGIONS,
        _ => return Err(format!("catalog.schema: expected {CATALOG_SCHEMA} or {CATALOG_SCHEMA_REGIONS}")),
    };
    let packs_v = o.get("packs").and_then(Value::as_array).ok_or("catalog.packs: expected an array")?;
    let packs =
        packs_v.iter().enumerate().map(|(i, p)| parse_pack(p, &format!("catalog.packs[{i}]"), schema)).collect::<Result<Vec<_>, _>>()?;
    let mut ids = std::collections::HashSet::new();
    let mut files = std::collections::HashSet::new();
    for p in &packs {
        if !ids.insert(p.id.clone()) {
            return Err(format!("catalog.packs: duplicate id {}", p.id));
        }
        if !files.insert(format!("{}/{}", p.kind.as_str(), p.file)) {
            return Err(format!("catalog.packs: duplicate file {}", p.file));
        }
    }
    let revoked = match o.get("revoked") {
        None => Vec::new(),
        Some(v) => parse_revoked(v, &packs)?,
    };
    Ok(Catalog {
        schema,
        sequence: int(o.get("sequence"), "catalog.sequence", 1)?,
        issued_at: text(o.get("issuedAt"), "catalog.issuedAt", None)?.to_owned(),
        key_id: text(o.get("keyId"), "catalog.keyId", Some(&KEY_ID))?.to_owned(),
        packs,
        revoked,
    })
}

fn parse_revoked(v: &Value, packs: &[CatalogPack]) -> Result<Vec<String>, String> {
    let items = v.as_array().ok_or("catalog.revoked: expected an array")?;
    let listed: std::collections::HashSet<&str> = packs.iter().map(|p| p.sha256.as_str()).collect();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(items.len());
    for (i, h) in items.iter().enumerate() {
        let path = format!("catalog.revoked[{i}]");
        let sha = text(Some(h), &path, Some(&HEX64))?.to_owned();
        if !seen.insert(sha.clone()) {
            return Err(format!("catalog.revoked: duplicate {sha}"));
        }
        if listed.contains(sha.as_str()) {
            return Err(format!("{path}: a listed pack has this hash"));
        }
        out.push(sha);
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyListEntry {
    pub key_id: String,
    pub public_key: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyList {
    pub sequence: u64,
    pub issued_at: String,
    pub signed_by: String,
    pub keys: Vec<KeyListEntry>,
}

pub fn parse_key_list(data: &Value) -> Result<KeyList, String> {
    let o = obj(data, "keys")?;
    no_extra_keys(o, &["schema", "sequence", "issuedAt", "signedBy", "keys"], "keys")?;
    if o.get("schema").and_then(Value::as_f64) != Some(KEY_LIST_SCHEMA as f64) {
        return Err(format!("keys.schema: expected {KEY_LIST_SCHEMA}"));
    }
    let arr = match o.get("keys").and_then(Value::as_array) {
        Some(a) if !a.is_empty() => a,
        _ => return Err("keys.keys: expected at least one key".into()),
    };
    let mut keys = Vec::new();
    for (i, k) in arr.iter().enumerate() {
        let path = format!("keys.keys[{i}]");
        let ko = obj(k, &path)?;
        no_extra_keys(ko, &["keyId", "publicKey", "role"], &path)?;
        let role = match ko.get("role").and_then(Value::as_str) {
            Some(r @ ("active" | "backup")) => r.to_owned(),
            _ => return Err(format!("{path}.role: invalid")),
        };
        let public_key = text(ko.get("publicKey"), &format!("{path}.publicKey"), None)?;
        if decode_key(public_key).is_none() {
            return Err(format!("{path}.publicKey: expected 32 bytes (base64)"));
        }
        keys.push(KeyListEntry {
            key_id: text(ko.get("keyId"), &format!("{path}.keyId"), Some(&KEY_ID))?.to_owned(),
            public_key: public_key.to_owned(),
            role,
        });
    }
    if keys.iter().filter(|k| k.role == "active").count() != 1 {
        return Err("keys.keys: exactly one active key required".into());
    }
    Ok(KeyList {
        sequence: int(o.get("sequence"), "keys.sequence", 1)?,
        issued_at: text(o.get("issuedAt"), "keys.issuedAt", None)?.to_owned(),
        signed_by: text(o.get("signedBy"), "keys.signedBy", Some(&KEY_ID))?.to_owned(),
        keys,
    })
}

fn parse_json(bytes: &[u8]) -> Result<Value, Rejected> {
    let text = std::str::from_utf8(bytes).map_err(|e| reject(Rejection::Malformed, e.to_string()))?;
    serde_json::from_str(text).map_err(|e| reject(Rejection::Malformed, e.to_string()))
}

fn check_sequence(sequence: u64, digest: &str, state: &SequenceState) -> Result<(), Rejected> {
    let Some(accepted) = state.sequence else { return Ok(()) };
    if sequence < accepted {
        return Err(reject(Rejection::Rollback, format!("sequence {sequence} < accepted {accepted}")));
    }
    if sequence == accepted && state.sha256.as_deref().is_some_and(|s| s != digest) {
        return Err(reject(Rejection::SequenceReuse, format!("sequence {sequence} already accepted with different content")));
    }
    Ok(())
}

/// Signature over the exact bytes by the trusted key named in `keyId` (nothing else in the document
/// is used before that), then the schema, then anti-rollback.
pub fn verify_catalog(bytes: &[u8], signature: &str, trusted: &[TrustedKey], state: &SequenceState) -> Result<Verified<Catalog>, Rejected> {
    let data = parse_json(bytes)?;
    let key_id = data.get("keyId").and_then(Value::as_str).unwrap_or("");
    let key = trusted
        .iter()
        .find(|k| k.key_id == key_id)
        .ok_or_else(|| reject(Rejection::UnknownKey, format!("key \"{key_id}\" is not trusted")))?;
    if !verify_bytes(bytes, signature, key) {
        return Err(reject(Rejection::BadSignature, format!("signature does not verify with {key_id}")));
    }
    let catalog = parse_catalog(&data).map_err(|e| reject(Rejection::Schema, e))?;
    let digest = sha256_hex(bytes);
    check_sequence(catalog.sequence, &digest, state)?;
    Ok(Verified { sequence: catalog.sequence, value: catalog, sha256: digest })
}

/// Key rotation: signed by a currently trusted key, no rollback; its keys then replace the trusted set.
pub fn verify_key_list(
    bytes: &[u8],
    signature: &str,
    trusted: &[TrustedKey],
    state: &SequenceState,
) -> Result<Verified<(KeyList, Vec<TrustedKey>)>, Rejected> {
    let data = parse_json(bytes)?;
    let signer = data.get("signedBy").and_then(Value::as_str).unwrap_or("");
    let key = trusted
        .iter()
        .find(|k| k.key_id == signer)
        .ok_or_else(|| reject(Rejection::UnknownKey, format!("signer \"{signer}\" is not trusted")))?;
    if !verify_bytes(bytes, signature, key) {
        return Err(reject(Rejection::BadSignature, format!("signature does not verify with {signer}")));
    }
    let list = parse_key_list(&data).map_err(|e| reject(Rejection::Schema, e))?;
    let digest = sha256_hex(bytes);
    check_sequence(list.sequence, &digest, state)?;
    let keys = list
        .keys
        .iter()
        .filter_map(|k| decode_key(&k.public_key).map(|pk| TrustedKey { key_id: k.key_id.clone(), public_key: pk }))
        .collect();
    Ok(Verified { sequence: list.sequence, value: (list, keys), sha256: digest })
}

/// `catalog/keys/<purpose>.json`: the pinned active + offline backup key of a build.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PinnedKeysFile {
    pub schema: u64,
    pub purpose: String,
    pub active: PinnedKeyInput,
    pub backup: PinnedKeyInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedKeyInput {
    pub key_id: String,
    pub public_key: String,
}

pub fn pinned_keys(text: &str) -> Result<(String, Vec<TrustedKey>), String> {
    let f: PinnedKeysFile = serde_json::from_str(text).map_err(|e| format!("pinned keys: {e}"))?;
    if f.schema != 1 || (f.purpose != "release" && f.purpose != "test") {
        return Err("pinned keys: not a pinned keys file".into());
    }
    let decode = |k: &PinnedKeyInput| -> Result<TrustedKey, String> {
        let pk =
            decode_key(&k.public_key).filter(|_| KEY_ID.is_match(&k.key_id)).ok_or_else(|| format!("invalid pinned key {}", k.key_id))?;
        Ok(TrustedKey { key_id: k.key_id.clone(), public_key: pk })
    };
    Ok((f.purpose.clone(), vec![decode(&f.active)?, decode(&f.backup)?]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn key(seed: u8) -> (SigningKey, TrustedKey) {
        let sk = SigningKey::from_bytes(&[seed; 32]);
        let tk = TrustedKey { key_id: format!("k-{seed}"), public_key: sk.verifying_key().to_bytes() };
        (sk, tk)
    }

    fn catalog_json(key_id: &str, sequence: u64) -> String {
        let chunk = "a".repeat(64);
        format!(
            r#"{{"schema":1,"sequence":{sequence},"issuedAt":"2026-10-01T00:00:00Z","keyId":"{key_id}","packs":[{{"id":"test-pack","kind":"zim","version":"1","file":"t.zim","title":{{"en":"T"}},"lang":["en"],"sizeBytes":10,"sha256":"{chunk}","chunkSize":67108864,"chunkSha256":["{chunk}"],"urls":["https://example.org/t.zim"],"license":"CC0","attribution":"x","minTier":"T0","tags":[]}}]}}"#
        )
    }

    fn signed(sk: &SigningKey, body: &str) -> String {
        to_base64(&sk.sign(body.as_bytes()).to_bytes())
    }

    #[test]
    fn accepts_a_valid_catalog_and_finds_packs() {
        let (sk, tk) = key(1);
        let body = catalog_json("k-1", 3);
        let v = verify_catalog(body.as_bytes(), &signed(&sk, &body), &[tk], &SequenceState::default()).expect("valid");
        assert_eq!(v.sequence, 3);
        assert_eq!(v.sha256, sha256_hex(body.as_bytes()));
        assert!(v.value.find_by_sha256(&"A".repeat(64)).is_some());
    }

    #[test]
    fn rejects_flipped_bytes_unknown_keys_rollback_and_reuse() {
        let (sk, tk) = key(1);
        let (_, other) = key(2);
        let body = catalog_json("k-1", 3);
        let sig = signed(&sk, &body);
        let mut flipped = body.clone().into_bytes();
        flipped[20] ^= 1;
        assert_eq!(
            verify_catalog(&flipped, &sig, std::slice::from_ref(&tk), &SequenceState::default()).unwrap_err().reason,
            Rejection::BadSignature
        );
        assert_eq!(verify_catalog(body.as_bytes(), &sig, &[other], &SequenceState::default()).unwrap_err().reason, Rejection::UnknownKey);
        let newer = SequenceState { sequence: Some(4), sha256: None };
        assert_eq!(verify_catalog(body.as_bytes(), &sig, std::slice::from_ref(&tk), &newer).unwrap_err().reason, Rejection::Rollback);
        let same = SequenceState { sequence: Some(3), sha256: Some("b".repeat(64)) };
        assert_eq!(verify_catalog(body.as_bytes(), &sig, std::slice::from_ref(&tk), &same).unwrap_err().reason, Rejection::SequenceReuse);
    }

    #[test]
    fn revoked_hashes_are_parsed_and_checked() {
        let (sk, tk) = key(1);
        let with = |list: &str| catalog_json("k-1", 3).replacen(r#""packs":"#, &format!(r#""revoked":{list},"packs":"#), 1);
        let body = with(&format!(r#"["{}","{}"]"#, "d".repeat(64), "e".repeat(64)));
        let v = verify_catalog(body.as_bytes(), &signed(&sk, &body), std::slice::from_ref(&tk), &SequenceState::default()).expect("valid");
        assert_eq!(v.value.revoked, vec!["d".repeat(64), "e".repeat(64)]);
        assert!(v.value.is_revoked(&"D".repeat(64)));
        assert!(!v.value.is_revoked(&"a".repeat(64)));
        let plain = catalog_json("k-1", 3);
        let p =
            verify_catalog(plain.as_bytes(), &signed(&sk, &plain), std::slice::from_ref(&tk), &SequenceState::default()).expect("valid");
        assert!(p.value.revoked.is_empty() && !p.value.is_revoked(&"d".repeat(64)));
        for bad in [
            format!(r#""{}""#, "d".repeat(64)),
            r#"["ABC"]"#.to_owned(),
            format!(r#"["{}"]"#, "D".repeat(64)),
            format!(r#"["{0}","{0}"]"#, "d".repeat(64)),
            format!(r#"["{}"]"#, "a".repeat(64)),
        ] {
            let body = with(&bad);
            let r = verify_catalog(body.as_bytes(), &signed(&sk, &body), std::slice::from_ref(&tk), &SequenceState::default()).unwrap_err();
            assert_eq!(r.reason, Rejection::Schema, "{bad}: {}", r.detail);
        }
    }

    #[test]
    fn rejects_schema_violations_after_a_valid_signature() {
        let (sk, tk) = key(1);
        let body = catalog_json("k-1", 3).replace("https://example.org/t.zim", "http://example.org/t.zim");
        let r = verify_catalog(body.as_bytes(), &signed(&sk, &body), &[tk], &SequenceState::default()).unwrap_err();
        assert_eq!(r.reason, Rejection::Schema);
        assert!(r.detail.contains("urls[0]"), "{}", r.detail);
    }

    fn region_catalog(schema: u64, region: &str, kind: &str, file: &str) -> String {
        let chunk = "a".repeat(64);
        format!(
            r#"{{"schema":{schema},"sequence":3,"issuedAt":"2026-10-23T00:00:00Z","keyId":"k-1","packs":[{{"id":"map-cy","kind":"{kind}","version":"2026-10-22","file":"{file}","title":{{"en":"Map: Cyprus"}},"lang":["en"],"sizeBytes":10,"sha256":"{chunk}","chunkSize":67108864,"chunkSha256":["{chunk}"],"urls":["https://example.org/{file}"],"license":"ODbL-1.0","attribution":"x","minTier":"T0","tags":["map"],"region":{region}}}]}}"#
        )
    }

    fn verify_region(schema: u64, region: &str, kind: &str, file: &str) -> Result<Catalog, String> {
        let (sk, tk) = key(1);
        let body = region_catalog(schema, region, kind, file);
        verify_catalog(body.as_bytes(), &signed(&sk, &body), &[tk], &SequenceState::default())
            .map(|v| v.value)
            .map_err(|r| format!("{}: {}", r.reason.as_str(), r.detail))
    }

    const CY: &str = r#"{"iso2":"CY","name":"Cyprus","bbox":[32.2225,34.5224,34.642,35.7405],"center":[33.0842,34.9133]}"#;

    #[test]
    fn schema_2_regions_like_catalog_ts() {
        let c = verify_region(2, CY, "pmtiles", "map-cy.pmtiles").expect("valid schema 2");
        assert_eq!(c.schema, 2);
        let r = c.packs[0].region.as_ref().expect("region");
        assert_eq!(
            (r.iso2.as_str(), r.name.as_str(), r.bbox, r.center, r.part.clone()),
            ("CY", "Cyprus", [32.2225, 34.5224, 34.642, 35.7405], [33.0842, 34.9133], None)
        );
        let us = r#"{"iso2":"US","name":"United States of America","bbox":[172.4262,18.8564,-66.9282,71.4605],"center":[-97.4826,39.5385],"part":{"id":"alaska","name":"Alaska, Oregon","regions":["Alaska","Oregon"],"bbox":[172.4262,41.9,-116.4,71.4605]}}"#;
        assert_eq!(
            verify_region(2, us, "pmtiles", "map-us-alaska.pmtiles").expect("part").packs[0].region.as_ref().and_then(|r| r.part.clone()),
            Some(RegionPart {
                id: "alaska".into(),
                name: "Alaska, Oregon".into(),
                regions: vec!["Alaska".into(), "Oregon".into()],
                bbox: [172.4262, 41.9, -116.4, 71.4605]
            })
        );
        let part = r#""part":{"id":"west","name":"West","regions":["West"],"bbox":[32,34,33,35]}"#;
        assert!(verify_region(2, &CY.replace("}", &format!(",{part}}}")), "pmtiles", "map-cy.pmtiles").is_ok());
        let many = (0..501).map(|i| format!("\"R{i}\"")).collect::<Vec<_>>().join(",");
        for bad_part in [
            r#""part":{"id":"West","name":"West","regions":["West"],"bbox":[32,34,33,35]}"#.to_owned(),
            r#""part":{"id":"west","name":"West"}"#.to_owned(),
            r#""part":{"id":"west","name":"West","regions":[],"bbox":[32,34,33,35]}"#.to_owned(),
            r#""part":{"id":"west","name":"West","regions":[""],"bbox":[32,34,33,35]}"#.to_owned(),
            format!(r#""part":{{"id":"west","name":"West","regions":[{many}],"bbox":[32,34,33,35]}}"#),
            r#""part":{"id":"west","name":"West","regions":["West"],"bbox":[32,35,33,34]}"#.to_owned(),
            r#""part":{"id":"west","name":"West","regions":["West"],"bbox":[32,34,33,35],"extra":1}"#.to_owned(),
        ] {
            let bad = CY.replace("}", &format!(",{bad_part}}}"));
            assert!(verify_region(2, &bad, "pmtiles", "map-cy.pmtiles").unwrap_err().starts_with("schema"), "{bad}");
        }
        assert!(verify_region(1, CY, "pmtiles", "map-cy.pmtiles").unwrap_err().contains("unexpected field(s) region"));
        assert!(verify_region(3, CY, "pmtiles", "map-cy.pmtiles").unwrap_err().contains("catalog.schema: expected 1 or 2"));
        assert!(verify_region(2, CY, "zim", "w.zim").unwrap_err().contains("only map and places packs"));
        for bad in [
            CY.replace("\"CY\"", "\"cy\""),
            CY.replace("[32.2225,34.5224,34.642,35.7405]", "[32,34,34]"),
            CY.replace("[32.2225,34.5224,34.642,35.7405]", "[32,36,34,35]"),
            CY.replace("[32.2225,34.5224,34.642,35.7405]", "[32,34,32,35]"),
            CY.replace("[32.2225,34.5224,34.642,35.7405]", "[190,34,34,35]"),
            CY.replace("[33.0842,34.9133]", "[33]"),
            CY.replace("}", r#","extra":true}"#),
        ] {
            assert!(verify_region(2, &bad, "pmtiles", "map-cy.pmtiles").unwrap_err().starts_with("schema"), "{bad}");
        }
    }

    #[test]
    fn download_urls_are_https_without_query() {
        assert!(is_allowed_download_url("https://download.kiwix.org/zim/x.zim"));
        assert!(is_allowed_download_url("https://127.0.0.1:8443/packs/x.zim"));
        assert!(!is_allowed_download_url("https://example.org/x.zim?id=1"));
        assert!(!is_allowed_download_url("https://user@example.org/x.zim"));
        assert!(!is_allowed_download_url("http://example.org/x.zim"));
    }
}
