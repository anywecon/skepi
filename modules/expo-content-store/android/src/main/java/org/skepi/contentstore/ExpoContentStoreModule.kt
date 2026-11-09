package org.skepi.contentstore

import android.app.DownloadManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.StatFs
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileNotFoundException

private const val TAG = "SkepiContentStore"
private const val MAX_SMALL_FILE_BYTES = 4L * 1024 * 1024

internal class ContentStoreException(code: String, message: String) : CodedException(code, message, null)

/** Every URL handed to DownloadManager in this process (zero-egress evidence for E2E). */
internal object NetworkLog {
  private val entries = ArrayDeque<Map<String, Any>>()

  @Synchronized
  fun record(url: String) {
    val uri = Uri.parse(url)
    if (entries.size >= 500) entries.removeFirst()
    entries.addLast(mapOf("host" to (uri.host ?: ""), "port" to uri.port.toDouble(), "path" to (uri.path ?: ""), "atMs" to System.currentTimeMillis().toDouble()))
    Log.i(TAG, "download requested: https://${uri.host}${if (uri.port > 0) ":${uri.port}" else ""}${uri.path}")
  }

  @Synchronized
  fun all(): List<Map<String, Any>> = entries.toList()

  @Synchronized
  fun clear() = entries.clear()
}

/**
 * Native side of the app's ContentStore (apps/mobile/src/lib/contentStore.ts): the only code that
 * may reach the network, through the system DownloadManager (resumes after interruption and reboot,
 * honours Wi-Fi-only). It never opens a downloaded file; hashing and catalog checks happen before
 * `installFile` moves a verified file into place.
 */
class ExpoContentStoreModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  /** Packs: internal storage on Android 7–10, app-specific external storage from Android 11 (ContentRules.contentRoot). */
  private fun root(): File {
    val dir = ContentRules.contentRoot(Build.VERSION.SDK_INT, context.getExternalFilesDir(null), context.filesDir)
      ?: throw ContentStoreException("ERR_CS_NO_STORAGE", "Content storage unavailable")
    dir.mkdirs()
    return dir.canonicalFile
  }

  private fun privateExternal(): Boolean = Build.VERSION.SDK_INT >= ContentRules.PRIVATE_EXTERNAL_FROM_API

  /** DownloadManager writes only to external storage: on Android 7–10 its partial files land outside root(). */
  private fun downloadRoot(): File =
    if (privateExternal()) root() else context.getExternalFilesDir(null)?.canonicalFile ?: throw ContentStoreException("ERR_CS_NO_STORAGE", "External files dir unavailable")

  private fun downloadPartial(fileName: String): File = try {
    ContentRules.resolve(downloadRoot(), "tmp/$fileName.partial")
  } catch (e: IllegalArgumentException) {
    throw ContentStoreException("ERR_CS_PATH", e.message ?: "invalid path")
  }

  private fun content(relativePath: String): File = try {
    ContentRules.resolve(root(), relativePath)
  } catch (e: IllegalArgumentException) {
    throw ContentStoreException("ERR_CS_PATH", e.message ?: "invalid path")
  }

  private fun legacyMigration(): LegacyMigration? {
    val external = context.getExternalFilesDir(null)?.canonicalFile ?: return null
    return LegacyMigration(external, root(), { StatFs(it.path).availableBytes })
  }

  private fun downloads(): DownloadManager = context.getSystemService(DownloadManager::class.java)

  private fun catalogDir(): File = File(context.filesDir, "catalog").also { it.mkdirs() }

  private fun status(code: Int): String = when (code) {
    DownloadManager.STATUS_PENDING -> "pending"
    DownloadManager.STATUS_RUNNING -> "running"
    DownloadManager.STATUS_PAUSED -> "paused"
    DownloadManager.STATUS_SUCCESSFUL -> "successful"
    DownloadManager.STATUS_FAILED -> "failed"
    else -> "unknown"
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoContentStore")
    Events("onImportProgress")

    Function("getContentRoot") { root().absolutePath }

    Function("getNetworkState") {
      val cm = context.getSystemService(ConnectivityManager::class.java)
      val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
      mapOf(
        "connected" to (caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true),
        "wifi" to (caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true || caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true),
        "metered" to cm.isActiveNetworkMetered,
      )
    }

    Function("getFreeBytes") { StatFs(root().path).availableBytes.toDouble() }

    // Android 7–10: a finished download is copied from external into internal storage, so twice its size.
    Function("requiredFreeBytes") { sizeBytes: Double ->
      val size = sizeBytes.toLong()
      (ContentRules.requiredFreeBytes(size) + if (privateExternal()) 0L else size).toDouble()
    }

    /** Starts a system download into tmp/<file>.partial. Wi-Fi only unless `allowMetered`. */
    AsyncFunction("startDownload") { url: String, fileName: String, title: String, allowMetered: Boolean ->
      if (!ContentRules.isAllowedUrl(url)) throw ContentStoreException("ERR_CS_URL", "Only HTTPS URLs without query strings are allowed")
      val partial = downloadPartial(fileName)
      partial.parentFile?.mkdirs()
      if (partial.exists() && !partial.delete()) throw ContentStoreException("ERR_CS_IO", "Cannot replace ${partial.name}")
      val request = DownloadManager.Request(Uri.parse(url))
        .setTitle(title)
        .addRequestHeader("User-Agent", ContentRules.USER_AGENT)
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
        .setDestinationUri(Uri.fromFile(partial))
        .setAllowedOverRoaming(false)
        .setAllowedOverMetered(allowMetered)
        .setAllowedNetworkTypes(
          if (allowMetered) DownloadManager.Request.NETWORK_WIFI or DownloadManager.Request.NETWORK_MOBILE else DownloadManager.Request.NETWORK_WIFI,
        )
      NetworkLog.record(url)
      downloads().enqueue(request).toDouble()
    }

    Function("queryDownload") { id: Double ->
      downloads().query(DownloadManager.Query().setFilterById(id.toLong())).use { c ->
        if (!c.moveToFirst()) return@Function null
        mapOf(
          "status" to status(c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))),
          "reason" to c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)).toDouble(),
          "bytes" to c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)).toDouble(),
          "totalBytes" to c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)).toDouble(),
        )
      }
    }

    /** Cancels a system download (DownloadManager deletes its partial file). */
    Function("removeDownload") { id: Double -> downloads().remove(id.toLong()) > 0 }

    /**
     * Brings a finished download to tmp/<file>.partial under the content root, where nothing but the
     * app can write, before it is hashed. A no-op from Android 11 (the download is already there).
     */
    AsyncFunction("adoptDownload") { fileName: String ->
      val target = content("tmp/$fileName.partial")
      val downloaded = downloadPartial(fileName)
      if (downloaded.path != target.path) {
        if (!downloaded.isFile) throw ContentStoreException("ERR_CS_NOT_FOUND", "Nothing downloaded for $fileName")
        target.parentFile?.mkdirs()
        // Another file store: copy, then delete the source (not atomic, but nothing opens tmp/).
        target.delete()
        try {
          FileMoves.move(downloaded, target)
        } catch (e: java.io.IOException) {
          target.delete()
          throw ContentStoreException("ERR_CS_IO", e.message ?: "could not move the download")
        }
      }
      target.absolutePath
    }

    /**
     * Android 7–10 only: packs an older version left in external storage (content-relative paths);
     * empty from Android 11. The app moves each one with moveLegacyFile and the digest it was verified
     * against (LegacyMigration).
     */
    Function("legacyContent") {
      val pending: List<String> = if (privateExternal()) emptyList() else legacyMigration()?.pending() ?: emptyList()
      pending
    }

    /**
     * Copies one legacy pack into the internal content root and checks it against expectedSha256; the
     * external copy is deleted only after that match (LegacyMigration.move).
     */
    AsyncFunction("moveLegacyFile") { relativePath: String, expectedSha256: String ->
      if (privateExternal() || !ContentRules.isAllowedFileName(relativePath.substringAfterLast('/'))) {
        throw ContentStoreException("ERR_CS_PATH", "invalid path: $relativePath")
      }
      val migration = legacyMigration() ?: throw ContentStoreException("ERR_CS_NO_STORAGE", "External files dir unavailable")
      val outcome = try {
        migration.move(relativePath, expectedSha256)
      } catch (e: IllegalArgumentException) {
        throw ContentStoreException("ERR_CS_PATH", e.message ?: "invalid path")
      }
      if (!outcome.moved) Log.w(TAG, "${outcome.reason}: $relativePath stays in external storage")
      val moved = File(outcome.path)
      mapOf(
        "moved" to outcome.moved,
        "reason" to outcome.reason,
        "path" to outcome.path,
        "sha256" to outcome.sha256,
        "stamp" to (if (outcome.moved && moved.isFile) ContentRules.fileStamp(moved) else null),
      )
    }

    Function("fileInfo") { relativePath: String ->
      val f = content(relativePath)
      mapOf(
        "exists" to f.isFile,
        "sizeBytes" to (if (f.isFile) f.length() else 0L).toDouble(),
        "path" to f.absolutePath,
        "stamp" to (if (f.isFile) ContentRules.fileStamp(f) else null),
      )
    }

    Function("listDir") { dir: String ->
      val base = File(root(), dir).canonicalFile
      if (dir !in setOf("zim", "models", "maps", "tmp") || !base.path.startsWith(root().path)) {
        throw ContentStoreException("ERR_CS_PATH", "invalid dir: $dir")
      }
      (base.listFiles() ?: emptyArray()).filter { it.isFile }.sortedBy { it.name }.map {
        mapOf("name" to it.name, "path" to it.absolutePath, "sizeBytes" to it.length().toDouble())
      }
    }

    /** Atomic move of a verified file into place (same filesystem), replacing an older copy. */
    AsyncFunction("installFile") { fromRelative: String, toRelative: String ->
      val from = content(fromRelative)
      val to = content(toRelative)
      if (!from.isFile) throw ContentStoreException("ERR_CS_NOT_FOUND", "Nothing to install at $fromRelative")
      to.parentFile?.mkdirs()
      try {
        FileMoves.rename(from, to)
      } catch (e: java.io.IOException) {
        throw ContentStoreException("ERR_CS_IO", e.message ?: "could not install $toRelative")
      }
      to.absolutePath
    }

    AsyncFunction("deleteFile") { relativePath: String ->
      val f = content(relativePath)
      !f.exists() || f.delete()
    }

    /** Copies a file picked with the Storage Access Framework into tmp/ (libzim needs a real path). */
    AsyncFunction("importFromUri") { uriString: String, fileName: String ->
      val uri = Uri.parse(uriString)
      if (uri.scheme != "content" && uri.scheme != "file") throw ContentStoreException("ERR_CS_URI", "Unsupported URI: ${uri.scheme}")
      val resolver = context.contentResolver
      var displayName = fileName
      var declared = -1L
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          displayName = c.getString(0) ?: fileName
          declared = if (c.isNull(1)) -1L else c.getLong(1)
        }
      }
      val target = content("tmp/$fileName.partial")
      target.parentFile?.mkdirs()
      var copied = 0L
      var reported = 0L
      try {
        val input = resolver.openInputStream(uri) ?: throw FileNotFoundException(uriString)
        input.use { stream ->
          target.outputStream().use { out ->
            val buffer = ByteArray(1 shl 20)
            while (true) {
              val read = stream.read(buffer)
              if (read < 0) break
              out.write(buffer, 0, read)
              copied += read
              if (copied - reported >= 8L * 1024 * 1024) {
                reported = copied
                sendEvent("onImportProgress", mapOf("copiedBytes" to copied.toDouble(), "totalBytes" to declared.toDouble()))
              }
            }
          }
        }
      } catch (e: Exception) {
        target.delete()
        throw ContentStoreException("ERR_CS_IMPORT", "Import failed: ${e.message}")
      }
      mapOf("displayName" to displayName, "sizeBytes" to copied.toDouble(), "relativePath" to "tmp/$fileName.partial", "path" to target.absolutePath)
    }

    /** Small text/binary files under the content root (downloaded catalogs), base64. */
    AsyncFunction("readSmallFileBase64") { relativePath: String ->
      val f = content(relativePath)
      if (!f.isFile) return@AsyncFunction null
      if (f.length() > MAX_SMALL_FILE_BYTES) throw ContentStoreException("ERR_CS_TOO_LARGE", "$relativePath is too large")
      Base64.encodeToString(f.readBytes(), Base64.NO_WRAP)
    }

    /** The signed catalog and pinned keys bundled in the APK (assets/catalog, per build type). */
    AsyncFunction("readEmbeddedCatalog") {
      fun asset(name: String): ByteArray? = try {
        context.assets.open("catalog/$name").use { it.readBytes() }
      } catch (e: java.io.IOException) {
        null
      }
      val catalog = asset("catalog.json") ?: return@AsyncFunction null
      val sig = asset("catalog.json.sig") ?: return@AsyncFunction null
      val keys = asset("keys.json") ?: return@AsyncFunction null
      mapOf(
        "catalog" to Base64.encodeToString(catalog, Base64.NO_WRAP),
        "signature" to String(sig, Charsets.UTF_8),
        "pinnedKeys" to String(keys, Charsets.UTF_8),
        // Catalog update sources of this build (debug: the local test mirror; release: none yet).
        "sources" to asset("sources.json")?.let { String(it, Charsets.UTF_8) },
      )
    }

    /** Newest accepted catalog (internal storage), written only after verification in JS. */
    AsyncFunction("writeAcceptedCatalog") { catalogBase64: String, signature: String ->
      val dir = catalogDir()
      val tmp = File(dir, "catalog.json.tmp")
      tmp.writeBytes(Base64.decode(catalogBase64, Base64.NO_WRAP))
      File(dir, "catalog.json.sig").writeText(signature, Charsets.UTF_8)
      FileMoves.rename(tmp, File(dir, "catalog.json"))
      Unit
    }

    AsyncFunction("readAcceptedCatalog") {
      val dir = catalogDir()
      val c = File(dir, "catalog.json")
      val s = File(dir, "catalog.json.sig")
      if (!c.isFile || !s.isFile) return@AsyncFunction null
      mapOf("catalog" to Base64.encodeToString(c.readBytes(), Base64.NO_WRAP), "signature" to s.readText(Charsets.UTF_8))
    }

    Function("getNetworkLog") { NetworkLog.all() }

    Function("clearNetworkLog") { NetworkLog.clear() }
  }
}
