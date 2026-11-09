// C++ side of the zim-ffi bridge: a thin, exception-safe wrapper over zim::Archive. Xapian handles
// are not thread-safe, so each archive keeps one searcher and one suggestion searcher behind locks
// (like OpenArchive in modules/expo-zim). Every libzim exception reaches Rust as Err (cxx Result).
#pragma once

#include <memory>
#include <mutex>
#include <string>

#include <zim/archive.h>
#include <zim/blob.h>
#include <zim/search.h>
#include <zim/suggestion.h>

#include "rust/cxx.h"

// Every bridged call that returns Result goes through this trycatch: cxx's default catches only
// std::exception, and an exception of any other type (Xapian's errors are not std::exceptions) would
// leave a noexcept function and terminate the process. Here it becomes an Err like any other.
namespace rust {
namespace behavior {
template <typename Try, typename Fail>
static void trycatch(Try&& func, Fail&& fail) noexcept try {
  func();
} catch (const std::exception& e) {
  fail(e.what());
} catch (...) {
  fail("search engine error (not a std::exception)");
}
}  // namespace behavior
}  // namespace rust

namespace skepi_zim {

struct ArchiveMeta;
struct Hit;

/// One entry's content: the blob stays owned by libzim's cache, Rust reads it as a slice (no copy).
/// Path, title and MIME type are bytes as the archive stores them: they need not be UTF-8, and a
/// rust::Str built from invalid UTF-8 throws where no exception may leave (Rust converts lossily).
class Item {
 public:
  Item(std::string path, std::string title, std::string mime, zim::Blob blob)
      : path_(std::move(path)), title_(std::move(title)), mime_(std::move(mime)), blob_(std::move(blob)) {}
  rust::Slice<const uint8_t> path() const { return bytes(path_); }
  rust::Slice<const uint8_t> title() const { return bytes(title_); }
  rust::Slice<const uint8_t> mime() const { return bytes(mime_); }
  rust::Slice<const uint8_t> data() const {
    return rust::Slice<const uint8_t>(reinterpret_cast<const uint8_t*>(blob_.data()), blob_.size());
  }

 private:
  static rust::Slice<const uint8_t> bytes(const std::string& s) {
    return rust::Slice<const uint8_t>(reinterpret_cast<const uint8_t*>(s.data()), s.size());
  }
  std::string path_, title_, mime_;
  zim::Blob blob_;
};

class Archive {
 public:
  explicit Archive(const std::string& path);

  ArchiveMeta meta() const;
  rust::Vec<Hit> suggest(rust::Str query, uint32_t limit) const;
  rust::Vec<Hit> search(rust::Str query, uint32_t limit, bool with_snippets) const;
  std::unique_ptr<Item> read_item(rust::Str path, uint64_t max_bytes) const;
  bool has_entry(rust::Str path) const;

 private:
  zim::Archive archive_;
  mutable std::mutex search_lock_;
  mutable std::mutex suggest_lock_;
  mutable std::unique_ptr<zim::Searcher> searcher_;
  mutable std::unique_ptr<zim::SuggestionSearcher> suggester_;
};

std::unique_ptr<Archive> open_archive(rust::Str path);

}  // namespace skepi_zim
