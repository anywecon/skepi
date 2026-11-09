#include "zim-ffi/include/shim.h"

#include <stdexcept>

#include <zim/entry.h>
#include <zim/error.h>
#include <zim/item.h>

#include "zim-ffi/src/lib.rs.h"

namespace skepi_zim {

namespace {

std::string meta_or_empty(const zim::Archive& a, const char* key) {
  try {
    return a.getMetadata(key);
  } catch (const std::exception&) {
    return std::string();
  }
}

}  // namespace

Archive::Archive(const std::string& path) : archive_(path) {}

std::unique_ptr<Archive> open_archive(rust::Str path) {
  return std::make_unique<Archive>(std::string(path));
}

ArchiveMeta Archive::meta() const {
  ArchiveMeta m;
  m.uuid = rust::String::lossy(static_cast<std::string>(archive_.getUuid()));
  m.title = rust::String::lossy(meta_or_empty(archive_, "Title"));
  m.language = rust::String::lossy(meta_or_empty(archive_, "Language"));
  m.name = rust::String::lossy(meta_or_empty(archive_, "Name"));
  m.flavour = rust::String::lossy(meta_or_empty(archive_, "Flavour"));
  m.date = rust::String::lossy(meta_or_empty(archive_, "Date"));
  m.article_count = archive_.getArticleCount();
  m.has_fulltext_index = archive_.hasFulltextIndex();
  m.has_title_index = archive_.hasTitleIndex();
  m.has_main = false;
  if (archive_.hasMainEntry()) {
    try {
      m.main_path = rust::String::lossy(archive_.getMainEntry().getItem(true).getPath());
      m.has_main = true;
    } catch (const std::exception&) {
      m.has_main = false;
    }
  }
  m.file_size = archive_.getFilesize();
  return m;
}

rust::Vec<Hit> Archive::suggest(rust::Str query, uint32_t limit) const {
  std::lock_guard<std::mutex> guard(suggest_lock_);
  if (!suggester_) suggester_ = std::make_unique<zim::SuggestionSearcher>(archive_);
  auto search = suggester_->suggest(std::string(query));
  auto results = search.getResults(0, static_cast<int>(limit));
  rust::Vec<Hit> out;
  for (auto it = results.begin(); it != results.end(); ++it) {
    Hit h;
    h.path = rust::String::lossy(it->getPath());
    h.title = rust::String::lossy(it->getTitle());
    h.has_snippet = it->hasSnippet();
    h.snippet = rust::String::lossy(h.has_snippet ? it->getSnippet() : std::string());
    h.score = 0;
    h.has_score = false;
    out.push_back(std::move(h));
  }
  return out;
}

rust::Vec<Hit> Archive::search(rust::Str query, uint32_t limit, bool with_snippets) const {
  std::lock_guard<std::mutex> guard(search_lock_);
  rust::Vec<Hit> out;
  if (!archive_.hasFulltextIndex()) return out;
  if (!searcher_) searcher_ = std::make_unique<zim::Searcher>(archive_);
  zim::Query q{std::string(query)};
  auto search = searcher_->search(q);
  auto results = search.getResults(0, static_cast<int>(limit));
  for (auto it = results.begin(); it != results.end(); ++it) {
    Hit h;
    h.path = rust::String::lossy(it.getPath());
    h.title = rust::String::lossy(it.getTitle());
    h.score = it.getScore();
    h.has_score = true;
    h.has_snippet = with_snippets;
    h.snippet = rust::String::lossy(with_snippets ? it.getSnippet() : std::string());
    out.push_back(std::move(h));
  }
  return out;
}

std::unique_ptr<Item> Archive::read_item(rust::Str path, uint64_t max_bytes) const {
  zim::Entry entry = archive_.getEntryByPath(std::string(path));
  // getItem(true) follows redirect chains (libzim bounds the chain).
  zim::Item item = entry.getItem(true);
  if (static_cast<uint64_t>(item.getSize()) > max_bytes) throw std::runtime_error("entry is larger than the limit");
  return std::make_unique<Item>(item.getPath(), item.getTitle(), item.getMimetype(), item.getData());
}

bool Archive::has_entry(rust::Str path) const {
  return archive_.hasEntryByPath(std::string(path));
}

}  // namespace skepi_zim
