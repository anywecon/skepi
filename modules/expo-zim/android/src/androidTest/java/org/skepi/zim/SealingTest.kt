package org.skepi.zim

import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Viewer sealing guarantees from docs/architecture.md ("Sealed article reading"), checked against a
 * real WebView and a real ZIM (src/androidTest/assets/sealing-fixture.zim, see fixtures/README.md).
 */
@RunWith(AndroidJUnit4::class)
class SealingTest {
  private class Recorder : SealedWebView.Listener {
    val blocked: MutableList<Pair<String, String>> = Collections.synchronizedList(mutableListOf())
    val external: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val finished: MutableList<Pair<String, String>> = Collections.synchronizedList(mutableListOf())
    @Volatile var loadEnd = CountDownLatch(1)

    override fun onBlockedRequest(url: String, reason: String) {
      blocked.add(url to reason)
    }

    override fun onExternalLink(url: String) {
      external.add(url)
    }

    override fun onLoadEnd(url: String, title: String) {
      finished.add(url to title)
      loadEnd.countDown()
    }
  }

  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private lateinit var recorder: Recorder
  private lateinit var view: SealedWebView

  @Before
  fun setUp() {
    ZimRegistry.clearBlocked()
    recorder = Recorder()
    instrumentation.runOnMainSync { view = SealedWebView(instrumentation.targetContext, recorder) }
  }

  @After
  fun tearDown() {
    instrumentation.runOnMainSync {
      view.stopLoading()
      view.destroy()
    }
  }

  // --- JavaScript ---------------------------------------------------------------------------

  @Test
  fun javascriptIsDisabled() {
    onMain { assertFalse(view.settings.javaScriptEnabled) }
    onMain { assertFalse(view.settings.javaScriptCanOpenWindowsAutomatically) }
  }

  @Test
  fun javascriptInterfaceCannotBeAttached() {
    onMain {
      assertThrows(UnsupportedOperationException::class.java) {
        view.addJavascriptInterface(Any(), "bridge")
      }
    }
    assertTrue(blockedLog().any { it.reason == "js-interface" && it.url == "javascript-interface:bridge" })
  }

  @Test
  fun inlineScriptDoesNotRunInRealPage() {
    // The fixture page sets document.title = 'pwned' from an inline <script>.
    val title = loadAndAwait(zim("index"))
    assertEquals("Sealing fixture", title)
    onMain { assertTrue(view.url!!.startsWith("zim://$archiveId/")) }
    // Anything the page tried outside zim:// was answered by the interceptor, never passed through.
    assertTrue(blockedLog().all { it.reason.startsWith("scheme:") })
  }

  // --- Non-zim requests -----------------------------------------------------------------------

  @Test
  fun nonZimSubresourceRequestsAreBlockedAndLogged() {
    val urls = listOf(
      "http://example.invalid/a.png",
      "https://example.invalid/a.png",
      "file:///system/etc/hosts",
      "file:///android_asset/index.html",
      "content://settings/system",
      "intent://scan/#Intent;scheme=zxing;end",
      "data:text/html,<p>x</p>",
      "javascript:alert(1)",
      "about:blank",
      "blob:zim://x",
    )
    for (url in urls) {
      val response = view.client.shouldInterceptRequest(view, request(url))
      assertEquals(url, 403, response.statusCode)
      assertEquals(url, 0, response.data.available())
      assertCsp(response)
      val scheme = Uri.parse(url).scheme
      assertTrue("not logged: $url", blockedLog().any { it.url == url && it.reason == "scheme:$scheme" })
    }
    instrumentation.waitForIdleSync()
    assertEquals(urls.size, recorder.blocked.size)
  }

  @Test
  fun nonZimNavigationsNeverLoadAndAreReported() {
    val urls = listOf(
      "http://example.invalid/",
      "https://example.invalid/",
      "intent://scan/#Intent;scheme=zxing;end",
      "file:///sdcard/Download/x.html",
      "content://media/external/file/1",
      "mailto:someone@example.invalid",
      "tel:112",
    )
    for (url in urls) {
      assertTrue(url, view.client.shouldOverrideUrlLoading(view, request(url, mainFrame = true)))
      val scheme = Uri.parse(url).scheme
      assertTrue("not logged: $url", blockedLog().any { it.url == url && it.reason == "navigation:$scheme" })
    }
    assertEquals(urls, recorder.external.toList())
    // A valid zim:// navigation stays inside the viewer.
    assertFalse(view.client.shouldOverrideUrlLoading(view, request(zim("en/Water_purification"), mainFrame = true)))
  }

  @Test
  fun loadEntryPointsRefuseAnythingButZim() {
    onMain {
      view.loadUrl("https://example.invalid/")
      view.loadUrl("http://example.invalid/", mutableMapOf("X-Test" to "1"))
      view.loadUrl("file:///system/etc/hosts")
      view.loadUrl("content://settings/system")
      view.loadUrl("intent://scan/#Intent;scheme=zxing;end")
      view.loadUrl("javascript:alert(1)")
      view.postUrl("https://example.invalid/", ByteArray(0))
      view.loadData("<p>x</p>", "text/html", "utf-8")
      view.loadDataWithBaseURL("https://example.invalid/", "<p>x</p>", "text/html", "utf-8", null)
    }
    instrumentation.waitForIdleSync()
    onMain { assertNull("nothing may have been loaded", view.url) }
    val reasons = recorder.blocked.map { it.second }
    assertEquals(listOf("invalid-source", "invalid-source", "invalid-source", "invalid-source", "invalid-source",
      "invalid-source", "post", "load-data", "load-data"), reasons)
    assertEquals(9, blockedLog().size)
  }

  // --- CSP --------------------------------------------------------------------------------------

  @Test
  fun everyZimResponseCarriesTheCsp() {
    val cases = mapOf(
      zim("index") to 200,
      zim("style.css") to 200,
      zim("img/dot.png") to 200,
      zim("en/Water_purification") to 200,
      zim("el/Καθαρισμός_νερού") to 200,
      zim("does/not/exist") to 404,
      zim("a/../index") to 403,
      "zim://not-an-open-archive/index" to 403,
      "zim:///index" to 403,
      "zim://$archiveId/" to 403,
      // The authority must be exactly the archive id (the app labels content by that string).
      "zim://x@$archiveId/index" to 403,
      "zim://$archiveId:80/index" to 403,
    )
    for ((url, status) in cases) {
      val response = ZimSchemeHandler.handle(Uri.parse(url))
      assertEquals(url, status, response.statusCode)
      assertCsp(response)
      assertEquals(url, "nosniff", response.responseHeaders["X-Content-Type-Options"])
    }
    // Defence in depth: HTML also carries the policy as a <meta> tag inside <head>.
    val html = ZimSchemeHandler.handle(Uri.parse(zim("index"))).data.readBytes().toString(Charsets.UTF_8)
    val meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"$EXPECTED_CSP\">"
    assertTrue(html.contains(meta))
    assertTrue(html.indexOf(meta) < html.indexOf("<script>"))
  }

  @Test
  fun blackoutThemeAddsDarkCssAndKeepsTheCsp() {
    val dark = ZimSchemeHandler.handle(Uri.parse(zim("index")), dark = true)
    assertEquals(200, dark.statusCode)
    assertCsp(dark)
    val html = dark.data.readBytes().toString(Charsets.UTF_8)
    val meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"$EXPECTED_CSP\">"
    assertTrue(html.contains(meta))
    assertTrue(html.contains("<style id=\"skepi-dark\">"))
    assertTrue(html.contains("background:#000"))
    // The style comes after the policy, and no script source is added.
    assertTrue(html.indexOf(meta) < html.indexOf("skepi-dark"))
    assertFalse(html.substringAfter("skepi-dark").substringBefore("</style>").contains("script"))
    val light = ZimSchemeHandler.handle(Uri.parse(zim("index"))).data.readBytes().toString(Charsets.UTF_8)
    assertFalse(light.contains("skepi-dark"))
    // Non-HTML responses are untouched.
    val css = ZimSchemeHandler.handle(Uri.parse(zim("style.css")), dark = true).data.readBytes().toString(Charsets.UTF_8)
    assertFalse(css.contains("skepi-dark"))
  }

  @Test
  fun cspMatchesTheArchitecture() {
    assertEquals(EXPECTED_CSP, ZimSchemeHandler.CSP)
  }

  // --- Path traversal ---------------------------------------------------------------------------

  @Test
  fun pathTraversalIsRejected() {
    val attempts = listOf(
      "zim://$archiveId/../index",
      "zim://$archiveId/./index",
      "zim://$archiveId/a/../index",
      "zim://$archiveId/a/b/../../index",
      "zim://$archiveId/a/b/page/../../../index",
      "zim://$archiveId/%2e%2e/index",
      "zim://$archiveId/%2E%2E/index",
      "zim://$archiveId/a/%2e%2e/%2e%2e/index",
      "zim://$archiveId/..%2findex",
      "zim://$archiveId/a%2f..%2f..%2findex",
      "zim://$archiveId/.%2e/index",
      "zim://$archiveId/%252e%252e/index",
      "zim://$archiveId/a/b/%252E%252E/page",
      "zim://$archiveId/a\\..\\index",
      "zim://$archiveId/a%5c..%5cindex",
      "zim://$archiveId/index%00.html",
    )
    for (url in attempts) {
      assertNull(url, ZimSchemeHandler.parse(Uri.parse(url)))
      val response = ZimSchemeHandler.handle(Uri.parse(url))
      assertEquals(url, 403, response.statusCode)
      assertTrue("not logged: $url", blockedLog().any { it.url == Uri.parse(url).toString() && it.reason == "invalid-zim-url" })
      onMain { assertFalse(url, view.loadZim(url)) }
    }
    // Controls: legitimate nested and non-ASCII paths still resolve.
    assertEquals(200, ZimSchemeHandler.handle(Uri.parse(zim("a/b/page"))).statusCode)
    assertEquals(200, ZimSchemeHandler.handle(Uri.parse(zim("el/Καθαρισμός_νερού"))).statusCode)
  }

  // --- File/content access and Safe Browsing ------------------------------------------------------

  @Test
  fun fileAndContentAccessAreOff() {
    onMain {
      val s = view.settings
      assertFalse(s.allowFileAccess)
      assertFalse(s.allowContentAccess)
      @Suppress("DEPRECATION")
      assertFalse(s.allowFileAccessFromFileURLs)
      @Suppress("DEPRECATION")
      assertFalse(s.allowUniversalAccessFromFileURLs)
      assertTrue(s.blockNetworkLoads)
      assertTrue(s.blockNetworkImage)
      assertFalse(s.domStorageEnabled)
    }
  }

  @Test
  fun safeBrowsingIsOff() {
    if (Build.VERSION.SDK_INT >= 26) onMain { assertFalse(view.settings.safeBrowsingEnabled) }
    val context = instrumentation.targetContext
    val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
    val meta = info.metaData
    assertNotNull("manifest meta-data missing", meta)
    assertFalse(meta!!.getBoolean("android.webkit.WebView.EnableSafeBrowsing", true))
    assertTrue(meta.getBoolean("android.webkit.WebView.MetricsOptOut", false))
  }

  // --- Helpers ----------------------------------------------------------------------------------

  private fun zim(path: String): String = "zim://$archiveId/" + path.split('/').joinToString("/") { Uri.encode(it) }

  private fun blockedLog(): List<BlockedRequest> = ZimRegistry.blockedRequests()

  private fun assertCsp(response: WebResourceResponse) {
    assertEquals(EXPECTED_CSP, response.responseHeaders["Content-Security-Policy"])
  }

  private fun onMain(block: () -> Unit) {
    var failure: Throwable? = null
    instrumentation.runOnMainSync {
      try {
        block()
      } catch (t: Throwable) {
        failure = t
      }
    }
    failure?.let { throw it }
  }

  private fun loadAndAwait(url: String): String {
    recorder.loadEnd = CountDownLatch(1)
    onMain { assertTrue(view.loadZim(url)) }
    assertTrue("page did not finish loading", recorder.loadEnd.await(20, TimeUnit.SECONDS))
    return recorder.finished.last().second
  }

  private fun request(url: String, mainFrame: Boolean = false): WebResourceRequest = object : WebResourceRequest {
    override fun getUrl(): Uri = Uri.parse(url)
    override fun isForMainFrame(): Boolean = mainFrame
    override fun isRedirect(): Boolean = false
    override fun hasGesture(): Boolean = mainFrame
    override fun getMethod(): String = "GET"
    override fun getRequestHeaders(): Map<String, String> = emptyMap()
  }

  companion object {
    /** Copied from docs/architecture.md, "Sealed article reading". */
    private const val EXPECTED_CSP =
      "default-src 'none'; img-src zim: data:; style-src zim: 'unsafe-inline'; font-src zim:; media-src zim:"

    private lateinit var archiveId: String

    @BeforeClass
    @JvmStatic
    fun openFixture() {
      val instrumentation = InstrumentationRegistry.getInstrumentation()
      val target: Context = instrumentation.targetContext
      val file = File(target.filesDir, "sealing-fixture.zim")
      instrumentation.context.assets.open("sealing-fixture.zim").use { input ->
        file.outputStream().use { input.copyTo(it) }
      }
      ZimRegistry.ensureInitialised(target)
      archiveId = ZimRegistry.open(file).id
    }
  }
}
