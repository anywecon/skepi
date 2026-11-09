package org.skepi.zim

import android.net.Uri
import android.util.Log
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream

/**
 * Serves `zim://<archiveId>/<path>` from an open archive. Everything else is refused.
 */
internal object ZimSchemeHandler {
  const val SCHEME = "zim"

  const val CSP =
    "default-src 'none'; img-src zim: data:; style-src zim: 'unsafe-inline'; font-src zim:; media-src zim:"

  private val SECURITY_HEADERS = mapOf(
    "Content-Security-Policy" to CSP,
    "X-Content-Type-Options" to "nosniff",
    "Referrer-Policy" to "no-referrer",
    "Cache-Control" to "no-store",
  )

  /**
   * Blackout theme: pure black for OLED panels (docs/architecture.md, "Blackout mode"). Inline style is
   * already allowed by the CSP (`style-src 'unsafe-inline'`); nothing else changes.
   */
  const val DARK_CSS =
    "html,body{background:#000!important;color:#e5e7eb!important}" +
      "*{background-color:transparent!important;color:inherit!important;border-color:#525252!important}" +
      "a,a:visited{color:#93c5fd!important}img,video{opacity:.8}"

  private val HEAD_OPEN = Regex("<head(\\s[^>]*)?>", RegexOption.IGNORE_CASE)

  data class Target(val archiveId: String, val path: String)

  /** Parses and validates a zim:// URL. Returns null for anything malformed. */
  fun parse(url: Uri): Target? {
    if (url.scheme != SCHEME) return null
    val archiveId = url.host?.takeIf { it.isNotEmpty() } ?: return null
    // The authority is the archive id and nothing else: no user info, no port (the app labels content
    // by the id it put in the URL, so the host must be exactly that string).
    if (url.encodedAuthority != archiveId) return null
    // Uri.path is already percent-decoded. ZIM paths are flat keys: reject NULs and any dot
    // segment, including backslash-separated and double-encoded (%252e%252e) forms.
    val path = url.path?.removePrefix("/")?.takeIf { it.isNotEmpty() } ?: return null
    if (path.contains('\u0000')) return null
    val segments = path.split('/', '\\')
    if (segments.any { it.isDotSegment() || Uri.decode(it).isDotSegment() }) return null
    return Target(archiveId, path)
  }

  private fun String.isDotSegment(): Boolean = this == "." || this == ".."

  fun blocked(url: String, reason: String): WebResourceResponse {
    ZimRegistry.recordBlocked(url, reason)
    return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", SECURITY_HEADERS, ByteArrayInputStream(ByteArray(0)))
  }

  private fun notFound(): WebResourceResponse =
    WebResourceResponse("text/plain", "utf-8", 404, "Not Found", SECURITY_HEADERS, ByteArrayInputStream(ByteArray(0)))

  fun handle(url: Uri, dark: Boolean = false): WebResourceResponse {
    val raw = url.toString()
    val target = parse(url) ?: return blocked(raw, "invalid-zim-url")
    val open = ZimRegistry.find(target.archiveId) ?: return blocked(raw, "archive-not-open")
    return try {
      val item = ZimContent.readItem(open, target.path)
      val (mime, charset) = splitMime(item.mimeType)
      val body = if (mime == "text/html") injectHead(item.data, dark) else item.data
      WebResourceResponse(mime, charset, 200, "OK", SECURITY_HEADERS, ByteArrayInputStream(body))
    } catch (e: ZimException) {
      Log.i(TAG, "zim:// miss ${target.path}: ${e.message}")
      notFound()
    } catch (e: Exception) {
      // Never let a native error escape the WebView's interceptor thread.
      Log.w(TAG, "zim:// error ${target.path}: ${e.message}")
      notFound()
    }
  }

  private fun splitMime(mimeType: String): Pair<String, String?> {
    val parts = mimeType.split(';').map { it.trim() }
    val mime = parts.first().lowercase()
    val charset = parts.drop(1).firstOrNull { it.startsWith("charset=", ignoreCase = true) }
      ?.substringAfter('=')?.trim('"')
    return mime to (charset ?: if (mime.startsWith("text/")) "utf-8" else null)
  }

  /** Defence in depth: the CSP also travels inside the document; the blackout CSS follows it. */
  private fun injectHead(html: ByteArray, dark: Boolean): ByteArray {
    val text = String(html, Charsets.UTF_8)
    val meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"$CSP\">" +
      if (dark) "<style id=\"skepi-dark\">$DARK_CSS</style>" else ""
    val match = HEAD_OPEN.find(text)
    val out = if (match != null) {
      text.substring(0, match.range.last + 1) + meta + text.substring(match.range.last + 1)
    } else {
      meta + text
    }
    return out.toByteArray(Charsets.UTF_8)
  }
}
