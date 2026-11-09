package org.skepi.contentstore

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest

/**
 * File moves that work from API 24 (java.nio.file only exists from API 26).
 */
internal object FileMoves {
  /** rename(2): atomic on one filesystem, replaces an existing target. */
  fun rename(from: File, to: File) {
    try {
      Os.rename(from.path, to.path)
    } catch (e: ErrnoException) {
      throw IOException("rename ${from.name} failed: ${e.message}", e)
    }
  }

  /** Copies [from] to [to] and flushes it to disk. */
  fun copy(from: File, to: File) {
    FileInputStream(from).use { input ->
      FileOutputStream(to).use { output ->
        input.copyTo(output, 1 shl 20)
        output.fd.sync()
      }
    }
  }

  /** Moves across filesystems if needed (copy, then delete the source). */
  fun move(from: File, to: File) {
    try {
      Os.rename(from.path, to.path)
      return
    } catch (e: ErrnoException) {
      if (e.errno != OsConstants.EXDEV) throw IOException("rename ${from.name} failed: ${e.message}", e)
    }
    copy(from, to)
    if (to.length() != from.length()) throw IOException("short copy of ${from.name}")
    if (!from.delete()) throw IOException("could not delete ${from.name} after copying it")
  }

  fun sha256(file: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(1 shl 20)
    FileInputStream(file).use { input ->
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
      }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }
}

/**
 * Android 7–10: packs an older version left in app-specific external storage move into the internal
 * content root (docs/architecture.md, "Storage"). The external copy is the only good copy until the
 * internal one has matched the SHA-256 the pack was verified against, so it is deleted only after that
 * match. Each step leaves a state the next start resumes from without loss:
 *  - killed during the copy: `tmp/<name>.migrating` is removed and the copy starts again;
 *  - killed after the rename, before the check: the internal copy is checked again;
 *  - killed after the check, before the external copy was deleted: checked again, then deleted;
 *  - not enough space, a failed copy or a mismatch: the internal copy is removed, the external one stays.
 */
class LegacyMigration(
  private val external: File,
  private val internal: File,
  private val freeBytes: (File) -> Long,
  /** Test hook: called after each step with (step, relative path); throwing there is a crash at that point. */
  private val checkpoint: (String, String) -> Unit = { _, _ -> },
) {
  data class Outcome(
    val moved: Boolean,
    /** "" when moved; otherwise space | copy | conflict | mismatch | missing. */
    val reason: String,
    /** Absolute path of the file the pack now lives in. */
    val path: String,
    /** SHA-256 of the file that was checked ("" when nothing was checked). */
    val sha256: String,
  )

  /** Packs still in external storage, as content-relative paths (zim/x.zim). */
  fun pending(): List<String> =
    CONTENT_DIRS.flatMap { dir ->
      (File(external, dir).listFiles() ?: emptyArray())
        .filter { it.isFile && ContentRules.isAllowedFileName(it.name) }
        .map { "$dir/${it.name}" }
    }.sorted()

  /**
   * Moves one pack and checks it against [expectedSha256]. The external copy is deleted only when the
   * internal copy matched; otherwise the internal copy is removed and the external one stays.
   */
  fun move(relativePath: String, expectedSha256: String): Outcome {
    val source = ContentRules.resolve(external, relativePath)
    val target = ContentRules.resolve(internal, relativePath)
    if (!source.isFile) {
      return if (target.isFile) Outcome(true, "", target.absolutePath, "") else Outcome(false, "missing", source.absolutePath, "")
    }
    val staging = ContentRules.resolve(internal, "tmp/${source.name}.migrating")
    // A copy interrupted by a crash or kill never looks finished: it only ever existed under this name.
    staging.delete()
    if (target.exists() && target.length() != source.length()) {
      // Not our copy (the rename is atomic and sizes are checked first): touch neither file.
      return Outcome(false, "conflict", source.absolutePath, "")
    }
    if (!target.exists()) {
      if (freeBytes(internal) < source.length() + RESERVE_BYTES) return Outcome(false, "space", source.absolutePath, "")
      try {
        staging.parentFile?.mkdirs()
        FileMoves.copy(source, staging)
        checkpoint("copied", relativePath)
        if (staging.length() != source.length()) throw IOException("short copy")
        target.parentFile?.mkdirs()
        FileMoves.rename(staging, target)
      } catch (e: IOException) {
        staging.delete()
        return Outcome(false, "copy", source.absolutePath, "")
      }
      checkpoint("renamed", relativePath)
    }
    val actual = try {
      FileMoves.sha256(target)
    } catch (e: IOException) {
      target.delete()
      return Outcome(false, "copy", source.absolutePath, "")
    }
    if (!actual.equals(expectedSha256, ignoreCase = true)) {
      target.delete()
      // Rare: hash the external file too, to tell a bad copy (tried again next start) from an
      // external file that no longer matches (kept, and no longer verified).
      val sourceSha = try { FileMoves.sha256(source) } catch (e: IOException) { "" }
      return if (sourceSha.equals(expectedSha256, ignoreCase = true)) {
        Outcome(false, "copy", source.absolutePath, sourceSha)
      } else {
        Outcome(false, "mismatch", source.absolutePath, sourceSha)
      }
    }
    checkpoint("verified", relativePath)
    // If this fails the next start finds both copies, checks the internal one again and retries.
    source.delete()
    return Outcome(true, "", target.absolutePath, actual)
  }

  companion object {
    val CONTENT_DIRS = listOf("zim", "models", "maps")

    /** Left free after a move (the OS needs room; DownloadManager's own minimum is far below). */
    const val RESERVE_BYTES = 64L * 1024 * 1024
  }
}
