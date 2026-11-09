//! KnowledgeEngine over libzim (desktop counterpart of ZimRegistry + ExpoZimModule.kt): archives open
//! only from the content folder, title suggestions run per archive in parallel (results keep the
//! requested archive order), full-text search per archive, article HTML, and plain text through
//! `text::extract_sections` with a small LRU cache.

use crate::text::{Section, extract_sections};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use zim_ffi::Archive;

pub const MAX_LIMIT: u32 = 100;
const TEXT_CACHE: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum ZimError {
    #[error("ERR_ZIM_PATH: {0}")]
    Path(String),
    #[error("ERR_ZIM_NOT_OPEN: archive is not open: {0}")]
    NotOpen(String),
    #[error("ERR_ZIM_ENTRY_NOT_FOUND: {0}")]
    NotFound(String),
    #[error("ERR_ZIM_NOT_HTML: entry {0} is {1}")]
    NotHtml(String, String),
    #[error("ERR_ZIM: {0}")]
    Engine(String),
    #[error("ERR_ZIM_DUPLICATE: {0}")]
    Duplicate(String),
}

impl From<zim_ffi::ZimError> for ZimError {
    fn from(e: zim_ffi::ZimError) -> Self {
        ZimError::Engine(e.0)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    pub archive_id: String,
    pub path: String,
    pub title: String,
    pub language: String,
    pub name: String,
    pub flavour: String,
    pub date: String,
    pub article_count: u32,
    pub has_fulltext_index: bool,
    pub has_title_index: bool,
    pub main_path: Option<String>,
    pub size_bytes: u64,
    pub open_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub archive_id: String,
    pub path: String,
    pub title: String,
    pub snippet: Option<String>,
    pub score: Option<f64>,
    pub rank: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleHtml {
    pub archive_id: String,
    pub path: String,
    pub title: String,
    pub mime_type: String,
    pub html: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleText {
    pub archive_id: String,
    pub path: String,
    pub title: String,
    pub sections: Vec<Section>,
    pub cached: bool,
}

struct Open {
    path: PathBuf,
    archive: Archive,
}

/// Process-wide registry of open archives (shared by the commands and the zim:// protocol).
pub struct ZimRegistry {
    roots: RwLock<Vec<PathBuf>>,
    archives: RwLock<HashMap<String, Arc<Open>>>,
    order: RwLock<Vec<String>>,
    text_cache: Mutex<VecDeque<(String, ArticleText)>>,
}

impl Default for ZimRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ZimRegistry {
    pub fn new() -> Self {
        Self {
            roots: RwLock::new(Vec::new()),
            archives: RwLock::new(HashMap::new()),
            order: RwLock::new(Vec::new()),
            text_cache: Mutex::new(VecDeque::new()),
        }
    }

    /// Folders archives may be opened from (the content folder; canonicalised).
    pub fn set_roots(&self, roots: Vec<PathBuf>) {
        let canon = roots.into_iter().filter_map(|r| dunce_canonical(&r)).collect();
        *self.roots.write().unwrap_or_else(|p| p.into_inner()) = canon;
    }

    fn require_allowed(&self, raw: &Path) -> Result<PathBuf, ZimError> {
        let file = dunce_canonical(raw).ok_or_else(|| ZimError::Path(format!("file not found: {}", raw.display())))?;
        let roots = self.roots.read().unwrap_or_else(|p| p.into_inner());
        if !roots.iter().any(|root| file.starts_with(root) && file != *root) {
            return Err(ZimError::Path(format!("path is outside the content folder: {}", raw.display())));
        }
        if !file.extension().is_some_and(|e| e.eq_ignore_ascii_case("zim")) || !file.is_file() {
            return Err(ZimError::Path(format!("expected a .zim file: {}", raw.display())));
        }
        Ok(file)
    }

    pub fn open(&self, raw: &Path) -> Result<ArchiveInfo, ZimError> {
        let file = self.require_allowed(raw)?;
        let start = Instant::now();
        let existing = self.archives.read().unwrap_or_else(|p| p.into_inner()).values().find(|o| o.path == file).cloned();
        let open = match existing {
            Some(o) => o,
            None => {
                let archive = Archive::open(&file)?;
                let id = archive.meta()?.uuid.to_ascii_lowercase();
                let mut map = self.archives.write().unwrap_or_else(|p| p.into_inner());
                // The UUID is self-declared: another file claiming an open archive's id is refused, so
                // it can never be served (or labelled) as that archive. Callers open verified packs first.
                if let Some(other) = map.get(&id)
                    && other.path != file
                {
                    return Err(ZimError::Duplicate(format!(
                        "{} declares the id of the open archive {}",
                        file.display(),
                        other.path.display()
                    )));
                }
                let entry = map.entry(id.clone()).or_insert_with(|| Arc::new(Open { path: file.clone(), archive })).clone();
                let mut order = self.order.write().unwrap_or_else(|p| p.into_inner());
                if !order.contains(&id) {
                    order.push(id);
                }
                entry
            }
        };
        let m = open.archive.meta()?;
        Ok(ArchiveInfo {
            archive_id: m.uuid.to_ascii_lowercase(),
            path: open.path.display().to_string(),
            title: m.title,
            language: m.language,
            name: m.name,
            flavour: m.flavour,
            date: m.date,
            article_count: m.article_count,
            has_fulltext_index: m.has_fulltext_index,
            has_title_index: m.has_title_index,
            main_path: m.has_main.then_some(m.main_path),
            size_bytes: m.file_size,
            open_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }

    pub fn close(&self, id: &str) {
        self.archives.write().unwrap_or_else(|p| p.into_inner()).remove(id);
        self.order.write().unwrap_or_else(|p| p.into_inner()).retain(|x| x != id);
        self.text_cache.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }

    pub fn close_all(&self) {
        self.archives.write().unwrap_or_else(|p| p.into_inner()).clear();
        self.order.write().unwrap_or_else(|p| p.into_inner()).clear();
        self.text_cache.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }

    fn get(&self, id: &str) -> Result<Arc<Open>, ZimError> {
        self.archives.read().unwrap_or_else(|p| p.into_inner()).get(id).cloned().ok_or_else(|| ZimError::NotOpen(id.into()))
    }

    pub fn is_open(&self, id: &str) -> bool {
        self.archives.read().unwrap_or_else(|p| p.into_inner()).contains_key(id)
    }

    fn targets(&self, ids: Option<&[String]>) -> Result<Vec<(String, Arc<Open>)>, ZimError> {
        match ids {
            Some(list) if !list.is_empty() => list.iter().map(|id| Ok((id.clone(), self.get(id)?))).collect(),
            _ => {
                let order = self.order.read().unwrap_or_else(|p| p.into_inner()).clone();
                Ok(order.into_iter().filter_map(|id| self.get(&id).ok().map(|o| (id, o))).collect())
            }
        }
    }

    /// Title suggestions, per archive in parallel, concatenated in archive order.
    pub fn suggest(&self, query: &str, limit: u32, ids: Option<&[String]>) -> Result<Vec<SearchHit>, ZimError> {
        let per = limit.clamp(1, MAX_LIMIT);
        let targets = self.targets(ids)?;
        let results: Vec<Result<Vec<SearchHit>, ZimError>> = std::thread::scope(|s| {
            let handles: Vec<_> = targets
                .iter()
                .map(|(id, open)| {
                    s.spawn(move || -> Result<Vec<SearchHit>, ZimError> {
                        Ok(open
                            .archive
                            .suggest(query, per)?
                            .into_iter()
                            .enumerate()
                            .map(|(rank, h)| SearchHit {
                                archive_id: id.clone(),
                                path: h.path,
                                title: h.title,
                                snippet: h.has_snippet.then_some(h.snippet),
                                score: None,
                                rank: rank as u32,
                            })
                            .collect())
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err(ZimError::Engine("suggest thread panicked".into())))).collect()
        });
        let mut out = Vec::new();
        for r in results {
            out.extend(r?);
        }
        Ok(out)
    }

    /// Xapian full-text search, per archive (rank inside each archive), archives without an index skipped.
    pub fn search(&self, query: &str, limit: u32, ids: Option<&[String]>, with_snippets: bool) -> Result<Vec<SearchHit>, ZimError> {
        let per = limit.clamp(1, MAX_LIMIT);
        let mut out = Vec::new();
        for (id, open) in self.targets(ids)? {
            for (rank, h) in open.archive.search(query, per, with_snippets)?.into_iter().enumerate() {
                out.push(SearchHit {
                    archive_id: id.clone(),
                    path: h.path,
                    title: h.title,
                    snippet: h.has_snippet.then_some(h.snippet),
                    score: h.has_score.then_some(h.score as f64),
                    rank: rank as u32,
                });
            }
        }
        Ok(out)
    }

    pub fn read_item(&self, id: &str, path: &str) -> Result<zim_ffi::ItemData, ZimError> {
        let open = self.get(id)?;
        open.archive.read_item(path).map_err(|e| ZimError::NotFound(format!("no entry '{path}' in {id}: {e}")))
    }

    pub fn article_html(&self, id: &str, path: &str) -> Result<ArticleHtml, ZimError> {
        let item = self.read_item(id, path)?;
        Ok(ArticleHtml {
            archive_id: id.into(),
            path: item.path,
            title: item.title,
            mime_type: item.mime,
            html: String::from_utf8_lossy(&item.data).into_owned(),
        })
    }

    pub fn plain_text(&self, id: &str, path: &str) -> Result<ArticleText, ZimError> {
        let key = format!("{id}\n{path}");
        {
            let cache = self.text_cache.lock().unwrap_or_else(|p| p.into_inner());
            if let Some((_, hit)) = cache.iter().find(|(k, _)| *k == key) {
                return Ok(ArticleText { cached: true, ..hit.clone() });
            }
        }
        let item = self.read_item(id, path)?;
        if !item.mime.starts_with("text/html") {
            return Err(ZimError::NotHtml(path.into(), item.mime));
        }
        let html = String::from_utf8_lossy(&item.data);
        let title = if item.title.trim().is_empty() { path.to_owned() } else { item.title.clone() };
        let sections = extract_sections(&html, &title);
        let result = ArticleText { archive_id: id.into(), path: item.path, title, sections, cached: false };
        let mut cache = self.text_cache.lock().unwrap_or_else(|p| p.into_inner());
        if cache.len() >= TEXT_CACHE {
            cache.pop_front();
        }
        cache.push_back((key, result.clone()));
        Ok(result)
    }
}

/// Canonical path without the `\\?\` prefix (comparable with user-visible paths); None when missing.
pub fn dunce_canonical(p: &Path) -> Option<PathBuf> {
    let c = std::fs::canonicalize(p).ok()?;
    let s = c.to_string_lossy();
    Some(match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => c,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/rag-eval/fixtures")
    }

    #[test]
    fn opens_only_inside_the_content_roots() {
        let reg = ZimRegistry::new();
        assert!(matches!(reg.open(&fixtures().join("eval-smoke-en.zim")), Err(ZimError::Path(_))));
        reg.set_roots(vec![fixtures()]);
        let info = reg.open(&fixtures().join("eval-smoke-en.zim")).expect("open");
        assert_eq!(info.language, "eng");
        assert!(matches!(reg.open(&fixtures().join("../fixtures/../sets/en.json")), Err(ZimError::Path(_))));
        let again = reg.open(&fixtures().join("eval-smoke-en.zim")).expect("reopen");
        assert_eq!(again.archive_id, info.archive_id);
    }

    /// A copy of eval-synthetic.zim (different content) that claims eval-smoke-en.zim's UUID.
    fn uuid_clone(dir: &Path) -> PathBuf {
        let smoke = std::fs::read(fixtures().join("eval-smoke-en.zim")).expect("smoke");
        let mut other = std::fs::read(fixtures().join("eval-synthetic.zim")).expect("synthetic");
        other[8..24].copy_from_slice(&smoke[8..24]);
        let path = dir.join("claims-smoke-uuid.zim");
        std::fs::write(&path, other).expect("write");
        path
    }

    #[test]
    fn a_second_file_with_an_open_archive_id_is_refused() {
        let dir = tempfile::tempdir().expect("tmp");
        let genuine = dir.path().join("eval-smoke-en.zim");
        std::fs::copy(fixtures().join("eval-smoke-en.zim"), &genuine).expect("copy");
        let clone = uuid_clone(dir.path());
        let reg = ZimRegistry::new();
        reg.set_roots(vec![dir.path().to_path_buf()]);
        let first = reg.open(&genuine).expect("open genuine");
        // The clone must not come back as the genuine archive (or replace it).
        assert!(matches!(reg.open(&clone), Err(ZimError::Duplicate(_))), "same UUID from another file is refused");
        assert_eq!(reg.open(&genuine).expect("reopen").path, first.path);
        assert!(
            reg.suggest("canber", 3, Some(std::slice::from_ref(&first.archive_id))).expect("suggest").iter().any(|h| h.path == "Canberra")
        );
        // Whichever file opens first keeps the id: the other is refused (callers open verified packs first).
        reg.close_all();
        reg.open(&clone).expect("open clone first");
        assert!(matches!(reg.open(&genuine), Err(ZimError::Duplicate(_))));
    }

    #[test]
    fn suggest_search_and_text() {
        let reg = ZimRegistry::new();
        reg.set_roots(vec![fixtures()]);
        let en = reg.open(&fixtures().join("eval-smoke-en.zim")).expect("open").archive_id;
        let syn = reg.open(&fixtures().join("eval-synthetic.zim")).expect("open").archive_id;
        let s = reg.suggest("canber", 8, None).expect("suggest");
        assert_eq!(s.first().map(|h| (h.archive_id.as_str(), h.path.as_str(), h.rank)), Some((en.as_str(), "Canberra", 0)));
        let order: Vec<_> =
            reg.suggest("water", 3, Some(&[syn.clone(), en.clone()])).expect("ordered").into_iter().map(|h| h.archive_id).collect();
        // Requested archive order is kept: no synthetic hit after the first English one.
        let first_en = order.iter().position(|a| *a == en).unwrap_or(order.len());
        assert!(order[first_en..].iter().all(|a| *a == en), "{order:?}");
        let hits = reg.search("earthquake", 5, Some(std::slice::from_ref(&en)), false).expect("search");
        assert!(hits.iter().any(|h| h.path == "Earthquake"));
        let t = reg.plain_text(&en, "Canberra").expect("text");
        assert!(!t.sections.is_empty());
        assert!(!t.cached);
        assert!(reg.plain_text(&en, "Canberra").expect("cached").cached);
        assert!(matches!(reg.plain_text("nope", "x"), Err(ZimError::NotOpen(_))));
    }
}
