package org.skepi.contentstore

import android.os.Build
import android.system.Os
import java.io.File
import java.net.URI

/**
 * Rules of the ContentStore that need no Android services (instrumentation-tested alone):
 * which URLs may be requested, which paths may be written, where packs live and how a file is
 * recognised as unchanged.
 */
object ContentRules {
  /** Generic User-Agent: no device model, OS build or app version (architecture: privacy). */
  const val USER_AGENT = "SKEPI"

  private val FILE_NAME = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
  private val CONTENT_DIRS = setOf("zim", "models", "maps", "tmp")

  /**
   * HTTPS only, a host, no user info, query string or fragment: a download request carries the file
   * URL and nothing else.
   */
  fun isAllowedUrl(url: String): Boolean {
    val uri = try {
      URI(url)
    } catch (e: Exception) {
      return false
    }
    return uri.scheme == "https" &&
      !uri.host.isNullOrEmpty() &&
      uri.rawUserInfo == null &&
      uri.rawQuery == null &&
      uri.rawFragment == null &&
      !url.contains('?') &&
      !url.contains('#')
  }

  fun isAllowedFileName(name: String): Boolean = FILE_NAME.matches(name) && !name.contains("..")

  /**
   * `<dir>/<file>` under `root`, with `dir` one of the content folders. Canonical paths defeat `..`
   * and symlink escapes.
   */
  fun resolve(root: File, relativePath: String): File {
    val parts = relativePath.split('/')
    require(parts.size == 2 && parts[0] in CONTENT_DIRS && isAllowedFileName(parts[1])) { "invalid content path: $relativePath" }
    val base = root.canonicalFile
    val file = File(base, relativePath).canonicalFile
    require(file.path.startsWith(base.path + File.separator)) { "path escapes the content root: $relativePath" }
    return file
  }

  /**
   * First API level on which app-specific external storage is private to the app: from Android 11
   * other apps cannot read or write `Android/data/<package>`, whatever permissions they hold.
   */
  const val PRIVATE_EXTERNAL_FROM_API = 30

  /**
   * Where packs live (docs/architecture.md, "Storage"): app-specific external storage from Android 11;
   * on Android 7–10 another app with the storage permission could replace a verified file there, so
   * packs live in internal storage (`files/content`). DownloadManager still writes its partial files
   * to external storage on those versions; they are copied in before they are hashed.
   */
  fun contentRoot(sdkInt: Int, externalFilesDir: File?, filesDir: File): File? =
    if (sdkInt >= PRIVATE_EXTERNAL_FROM_API) externalFilesDir else File(filesDir, "content")

  /**
   * Identity of a file without reading it: size, inode, modification and change time. A
   * replacement (new inode) or any write (new change time, which no app can set back) changes it,
   * also when the old modification time is restored. Startup hashes a pack again when it differs.
   */
  fun fileStamp(file: File): String {
    val st = Os.stat(file.path)
    val mtime = if (Build.VERSION.SDK_INT >= 27) "${st.st_mtim.tv_sec}.${st.st_mtim.tv_nsec}" else "${file.lastModified()}"
    val ctime = if (Build.VERSION.SDK_INT >= 27) "${st.st_ctim.tv_sec}.${st.st_ctim.tv_nsec}" else "${st.st_ctime}"
    // No device number: FUSE-backed storage may get a new one after a remount (a full hash at every start).
    return "a2:${st.st_size}:${st.st_ino}:$mtime:$ctime"
  }

  /** Free space needed before a download starts: the file, 10% headroom and 1 GiB for the OS. */
  fun requiredFreeBytes(sizeBytes: Long): Long = sizeBytes + sizeBytes / 10 + 1024L * 1024 * 1024
}
