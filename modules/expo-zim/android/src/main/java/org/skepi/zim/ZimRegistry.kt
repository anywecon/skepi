package org.skepi.zim

import android.content.Context
import android.os.Build
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import org.kiwix.libkiwix.JNIKiwix
import org.kiwix.libzim.Archive
import org.kiwix.libzim.Searcher
import org.kiwix.libzim.SuggestionSearcher
import java.io.File
import java.util.concurrent.ConcurrentHashMap

internal const val TAG = "ExpoZim"

/** One open ZIM archive. Xapian handles are not thread-safe, so each searcher has its own lock. */
internal class OpenArchive(val id: String, val path: String, val archive: Archive) {
  val searchLock = Any()
  val suggestLock = Any()
  private var searcher: Searcher? = null
  private var suggestionSearcher: SuggestionSearcher? = null

  fun searcher(): Searcher = searcher ?: Searcher(archive).also { searcher = it }

  fun suggestionSearcher(): SuggestionSearcher =
    suggestionSearcher ?: SuggestionSearcher(archive).also { suggestionSearcher = it }

  fun dispose() {
    synchronized(searchLock) {
      searcher?.dispose()
      searcher = null
    }
    synchronized(suggestLock) {
      suggestionSearcher?.dispose()
      suggestionSearcher = null
    }
    archive.dispose()
  }
}

data class BlockedRequest(val url: String, val reason: String, val atMs: Long)

/**
 * Process-wide state shared by the module functions and the zim:// WebView handler.
 */
internal object ZimRegistry {
  private val archives = ConcurrentHashMap<String, OpenArchive>()
  private val blocked = ArrayDeque<BlockedRequest>()
  private const val MAX_BLOCKED = 200
  val CONTENT_DIRS = listOf("zim", "models", "maps", "icu", "bench")

  @Volatile private var initialised = false
  @Volatile var icuDataDir: String? = null
    private set
  @Volatile var nativeInitMs: Long = 0
    private set

  /** Loads the native libraries once and points ICU at provisioned data when present. */
  @Synchronized
  fun ensureInitialised(context: Context) {
    if (initialised) return
    val start = System.nanoTime()
    // The app must own its content folders: directories created by `adb shell` (uid shell,
    // mode 770) are not listable by the app on Android 11+.
    contentRoot(context)?.let { root -> CONTENT_DIRS.forEach { File(root, it).mkdirs() } }
    val kiwix = JNIKiwix(context.applicationContext)
    val icuDir = contentRoot(context)?.let { File(it, "icu") }
    if (icuDir != null && icuDir.listFiles { f -> f.name.startsWith("icudt") && f.name.endsWith(".dat") }?.isNotEmpty() == true) {
      kiwix.setDataDirectory(icuDir.absolutePath)
      icuDataDir = icuDir.absolutePath
    }
    nativeInitMs = (System.nanoTime() - start) / 1_000_000
    initialised = true
    Log.i(TAG, "native init ${nativeInitMs}ms, icu=${icuDataDir ?: "none"}")
  }

  /**
   * The ContentStore's root (ContentRules.contentRoot in expo-content-store): app-specific external
   * storage from Android 11, internal storage on Android 7–10 (other apps could write external there).
   */
  fun contentRoot(context: Context): File? =
    if (Build.VERSION.SDK_INT >= 30) context.getExternalFilesDir(null) else File(context.filesDir, "content")

  /**
   * Only files inside the app's own storage may be opened. Canonical paths defeat `..` and
   * symlink tricks.
   */
  fun requireAllowedFile(context: Context, rawPath: String, extension: String): File {
    val file = File(rawPath).canonicalFile
    val roots = listOfNotNull(contentRoot(context), context.filesDir)
      .plus(context.getExternalFilesDirs(null).filterNotNull())
      .map { it.canonicalFile }
    val allowed = roots.any { root -> file.path.startsWith(root.path + File.separator) }
    if (!allowed) throw ZimException("ERR_ZIM_PATH", "Path is outside app storage: $rawPath")
    if (!file.name.endsWith(extension, ignoreCase = true)) {
      throw ZimException("ERR_ZIM_PATH", "Expected a $extension file: $rawPath")
    }
    if (!file.isFile) throw ZimException("ERR_ZIM_NOT_FOUND", "File not found: $rawPath")
    return file
  }

  fun open(file: File): OpenArchive {
    archives.values.firstOrNull { it.path == file.path }?.let { return it }
    val archive = Archive(file.path)
    val id = archive.uuid
    val opened = OpenArchive(id, file.path, archive)
    val previous = archives.putIfAbsent(id, opened)
    if (previous != null) {
      archive.dispose()
      return previous
    }
    return opened
  }

  fun get(id: String): OpenArchive =
    archives[id] ?: throw ZimException("ERR_ZIM_NOT_OPEN", "Archive is not open: $id")

  fun find(id: String): OpenArchive? = archives[id]

  fun all(): List<OpenArchive> = archives.values.toList()

  fun close(id: String) {
    archives.remove(id)?.dispose()
  }

  fun recordBlocked(url: String, reason: String) {
    Log.w(TAG, "blocked request ($reason): $url")
    synchronized(blocked) {
      if (blocked.size >= MAX_BLOCKED) blocked.removeFirst()
      blocked.addLast(BlockedRequest(url, reason, System.currentTimeMillis()))
    }
  }

  fun blockedRequests(): List<BlockedRequest> = synchronized(blocked) { blocked.toList() }

  fun clearBlocked() = synchronized(blocked) { blocked.clear() }
}

internal class ZimException(code: String, message: String) : CodedException(code, message, null)
