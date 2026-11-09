//! Rust FFI to libzim 9.7.0 (official Kiwix Windows build, pinned in `native/kiwix`), through a small
//! C++ shim (`src/shim.cc`). Same engine and version as the Android module (libkiwix AAR 2.6.0 with
//! libzim 9.7.0), so search results and article bytes match the phone for the parity harness.

#[cxx::bridge(namespace = "skepi_zim")]
mod ffi {
    struct ArchiveMeta {
        uuid: String,
        title: String,
        language: String,
        name: String,
        flavour: String,
        date: String,
        article_count: u32,
        has_fulltext_index: bool,
        has_title_index: bool,
        has_main: bool,
        main_path: String,
        file_size: u64,
    }

    struct Hit {
        path: String,
        title: String,
        has_snippet: bool,
        snippet: String,
        has_score: bool,
        score: i32,
    }

    unsafe extern "C++" {
        include!("zim-ffi/include/shim.h");

        type Archive;
        type Item;

        fn open_archive(path: &str) -> Result<UniquePtr<Archive>>;
        fn meta(self: &Archive) -> Result<ArchiveMeta>;
        fn suggest(self: &Archive, query: &str, limit: u32) -> Result<Vec<Hit>>;
        fn search(self: &Archive, query: &str, limit: u32, with_snippets: bool) -> Result<Vec<Hit>>;
        fn read_item(self: &Archive, path: &str, max_bytes: u64) -> Result<UniquePtr<Item>>;
        fn path(self: &Item) -> &[u8];
        fn title(self: &Item) -> &[u8];
        fn mime(self: &Item) -> &[u8];
        fn data(self: &Item) -> &[u8];
        fn has_entry(self: &Archive, path: &str) -> Result<bool>;
    }
}

pub use ffi::{ArchiveMeta, Hit};

/// One entry's content (redirects followed).
#[derive(Debug, Clone)]
pub struct ItemData {
    pub path: String,
    pub title: String,
    pub mime: String,
    pub data: Vec<u8>,
}

/// Hard cap on one entry's size (same as `MAX_ITEM_BYTES` in modules/expo-zim).
pub const MAX_ITEM_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug)]
pub struct ZimError(pub String);

impl std::fmt::Display for ZimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ZimError {}

impl From<cxx::Exception> for ZimError {
    fn from(e: cxx::Exception) -> Self {
        ZimError(e.what().to_owned())
    }
}

/// Archive strings are bytes (a ZIM need not store valid UTF-8): invalid sequences become U+FFFD.
fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// One open archive. zim::Archive reads are thread-safe; the shim serialises the Xapian searchers.
pub struct Archive {
    inner: cxx::UniquePtr<ffi::Archive>,
}

// SAFETY: zim::Archive is safe for concurrent reads (libzim documents it), and the shim guards the
// non-thread-safe searcher and suggestion searcher with their own mutexes.
unsafe impl Send for Archive {}
// SAFETY: see Send; every method takes &self and synchronises internally.
unsafe impl Sync for Archive {}

impl Archive {
    /// Opens a ZIM file. The path must be valid UTF-8 (libzim takes a UTF-8 path on Windows).
    pub fn open(path: &std::path::Path) -> Result<Self, ZimError> {
        let p = path.to_str().ok_or_else(|| ZimError(format!("path is not UTF-8: {}", path.display())))?;
        let inner = ffi::open_archive(p)?;
        if inner.is_null() {
            return Err(ZimError("libzim returned no archive".into()));
        }
        Ok(Self { inner })
    }

    fn get(&self) -> &ffi::Archive {
        self.inner.as_ref().expect("archive is never null after open")
    }

    pub fn meta(&self) -> Result<ArchiveMeta, ZimError> {
        Ok(self.get().meta()?)
    }

    /// Title suggestions (SuggestionSearcher), at most `limit`.
    pub fn suggest(&self, query: &str, limit: u32) -> Result<Vec<Hit>, ZimError> {
        Ok(self.get().suggest(query, limit)?)
    }

    /// Xapian full-text search, at most `limit`; empty when the archive has no full-text index.
    pub fn search(&self, query: &str, limit: u32, with_snippets: bool) -> Result<Vec<Hit>, ZimError> {
        Ok(self.get().search(query, limit, with_snippets)?)
    }

    /// Reads an entry (following redirects), refusing anything above `MAX_ITEM_BYTES`.
    pub fn read_item(&self, path: &str) -> Result<ItemData, ZimError> {
        let item = self.get().read_item(path, MAX_ITEM_BYTES)?;
        let item = item.as_ref().ok_or_else(|| ZimError(format!("no item for {path}")))?;
        Ok(ItemData { path: text(item.path()), title: text(item.title()), mime: text(item.mime()), data: item.data().to_vec() })
    }

    pub fn has_entry(&self, path: &str) -> Result<bool, ZimError> {
        Ok(self.get().has_entry(path)?)
    }
}

#[cfg(test)]
mod tests {
    use super::text;

    #[test]
    fn archive_strings_that_are_not_utf8_are_converted_not_trusted() {
        assert_eq!(text(b"Canberra"), "Canberra");
        assert_eq!(text("Καθαρισμός".as_bytes()), "Καθαρισμός");
        assert_eq!(text(b"Bad\xfftitle"), "Bad\u{fffd}title");
        assert_eq!(text(b"text/\xc3"), "text/\u{fffd}");
    }
}
