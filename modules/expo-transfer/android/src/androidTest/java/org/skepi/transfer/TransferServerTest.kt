package org.skepi.transfer

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLSocket

/**
 * The P2P host and client on one device (loopback): TLS 1.3 only with the pinned per-session
 * certificate, the token, Range, faults, and the rule that only the selected packs can be served —
 * no URL reaches any other file (app.db, notes, settings, other packs).
 */
@RunWith(AndroidJUnit4::class)
class TransferServerTest {
  private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
  private lateinit var dir: File
  private lateinit var packFile: File
  private lateinit var secretFile: File
  private lateinit var server: TransferServer
  private lateinit var cert: SessionCert
  private val token = "0123456789abcdef0123456789abcdef"
  private val manifest = """{"v":1,"catalog":null,"packs":[]}""".toByteArray()
  private val bytes = ByteArray(300_000) { (it * 31 + 7).toByte() }
  private var serverPort = 0

  @Before
  fun setUp() {
    dir = File(ctx.cacheDir, "p2p-test-${System.nanoTime()}").also { it.mkdirs() }
    packFile = File(dir, "selected.zim").also { it.writeBytes(bytes) }
    // A file next to the selected pack that must never be reachable.
    secretFile = File(dir, "app.db").also { it.writeText("secret") }
    cert = SessionCert.create()
    server = TransferServer(cert, token, manifest, mapOf("test-pack" to packFile), 60_000, InetAddress.getByName("127.0.0.1"))
    serverPort = server.start()
  }

  @After
  fun tearDown() {
    server.stop()
    dir.deleteRecursively()
  }

  private fun client(pin: String = cert.sha256, tok: String = token) =
    TransferClient("127.0.0.1", serverPort, tok, pin, null, allowLoopback = true)

  private fun sha(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).toHex()

  /** A raw request with the pinned TLS context; returns the status code. */
  private fun rawStatus(path: String, auth: String? = "Bearer $token", method: String = "GET"): Int {
    val ssl = SSLContext.getInstance("TLSv1.3").apply { init(null, arrayOf(PinningTrustManager(cert.sha256)), SecureRandom()) }
    val raw = Socket().apply { connect(InetSocketAddress("127.0.0.1", serverPort), 5_000); soTimeout = 5_000 }
    (ssl.socketFactory.createSocket(raw, "127.0.0.1", serverPort, true) as SSLSocket).use { s ->
      s.enabledProtocols = arrayOf("TLSv1.3")
      s.startHandshake()
      val head = StringBuilder("$method $path HTTP/1.1\r\nHost: x\r\n")
      if (auth != null) head.append("Authorization: $auth\r\n")
      head.append("Connection: close\r\n\r\n")
      s.outputStream.write(head.toString().toByteArray())
      return Http.readResponse(s.inputStream).status
    }
  }

  @Test
  fun idleUnauthenticatedSocketsDoNotLockOutPhones() {
    // Another device on the network (127.0.0.2 on the loopback /8) opens sockets and never sends a byte.
    val idle = (1..32).mapNotNull {
      try {
        Socket().apply {
          bind(InetSocketAddress("127.0.0.2", 0))
          connect(InetSocketAddress("127.0.0.1", serverPort), 2_000)
        }
      } catch (_: IOException) {
        null
      }
    }
    try {
      Thread.sleep(300)
      val started = System.nanoTime()
      assertEquals(String(manifest), client().fetchManifest())
      val ms = (System.nanoTime() - started) / 1_000_000
      assertTrue("served while the idle sockets are open (${ms} ms)", ms < 4_000)
      // Each idle socket is closed after the pre-auth deadline, not after the 30 s transfer timeout.
      val first = idle.first()
      first.soTimeout = 8_000
      val read = try {
        first.getInputStream().read()
      } catch (_: IOException) {
        -1
      }
      assertEquals(-1, read)
    } finally {
      idle.forEach { it.close() }
    }
  }

  @Test
  fun servesTheManifestAndChunksOverPinnedTls13() {
    assertEquals(String(manifest), client().fetchManifest())
    val partial = File(dir, "recv.partial")
    val c1 = client().fetchChunk("test-pack", 0, 65_536, partial)
    val c2 = client().fetchChunk("test-pack", 65_536, 100_000, partial)
    assertEquals(sha(bytes.copyOfRange(0, 65_536)), c1.sha256)
    assertEquals(sha(bytes.copyOfRange(65_536, 165_536)), c2.sha256)
    assertEquals(165_536L, partial.length())
  }

  @Test
  fun refusesAnyOtherCertificate() {
    val other = SessionCert.create()
    assertNotEquals(cert.sha256, other.sha256)
    try {
      client(pin = other.sha256).fetchManifest()
      fail("a certificate that is not the pinned one must be refused")
    } catch (e: SSLHandshakeException) {
      // expected
    }
  }

  @Test
  fun refusesTlsBelow13() {
    val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(PinningTrustManager(cert.sha256)), SecureRandom()) }
    val raw = Socket().apply { connect(InetSocketAddress("127.0.0.1", serverPort), 5_000); soTimeout = 5_000 }
    (ssl.socketFactory.createSocket(raw, "127.0.0.1", serverPort, true) as SSLSocket).use { s ->
      s.enabledProtocols = arrayOf("TLSv1.2")
      try {
        s.startHandshake()
        fail("TLS 1.2 must be refused")
      } catch (e: IOException) {
        // expected
      }
    }
  }

  @Test
  fun requiresTheSessionToken() {
    assertEquals(401, rawStatus("/manifest", auth = null))
    assertEquals(401, rawStatus("/manifest", auth = "Bearer ffffffffffffffffffffffffffffffff"))
    assertEquals(401, rawStatus("/pack/test-pack", auth = "Bearer "))
    try {
      client(tok = "ffffffffffffffffffffffffffffffff").fetchManifest()
      fail("wrong token must fail")
    } catch (e: TransferClientException) {
      assertEquals("ERR_P2P_TOKEN", e.code)
    }
  }

  @Test
  fun neverServesUnselectedPacksOrUserData() {
    val paths = listOf(
      "/pack/other-pack", "/pack/app.db", "/pack/../app.db", "/pack/..%2Fapp.db", "/pack/%2e%2e/app.db", "/app.db",
      "/", "/settings", "/notes", "/conversations", "/pack/", "/pack/test-pack/../app.db", "/manifest/../app.db",
      "/pack/TEST-PACK", "/catalog.json", "/files/app.db",
    )
    for (p in paths) assertEquals("$p must not be served", 404, rawStatus(p))
    assertEquals(405, rawStatus("/manifest", method = "PUT"))
    assertEquals(405, rawStatus("/pack/test-pack", method = "DELETE"))
    // Every request that answered 200/206 named the manifest or the selected pack.
    @Suppress("UNCHECKED_CAST")
    val log = server.status()["log"] as List<Map<String, Any>>
    assertTrue(log.filter { (it["status"] as Double) < 300 }.all { it["path"] == "/manifest" || it["path"] == "/pack/test-pack" })
  }

  @Test
  fun rangeRequestsAreBoundedAndValidated() {
    val partial = File(dir, "edge.partial")
    val last = client().fetchChunk("test-pack", 299_000, 1_000, partial)
    assertEquals(sha(bytes.copyOfRange(299_000, 300_000)), last.sha256)
    try {
      client().fetchChunk("test-pack", 300_000, 10, partial)
      fail("a range past the end must fail")
    } catch (e: TransferClientException) {
      assertEquals("ERR_P2P_HTTP", e.code)
    }
  }

  @Test
  fun faultsCorruptOnceAndDropOnce() {
    val partial = File(dir, "faults.partial")
    val good = sha(bytes.copyOfRange(65_536, 131_072))
    server.faults = TransferFaults(corruptOnce = "test-pack" to 65_536L)
    assertNotEquals(good, client().fetchChunk("test-pack", 65_536, 65_536, partial).sha256)
    assertEquals(good, client().fetchChunk("test-pack", 65_536, 65_536, partial).sha256)
    server.faults = TransferFaults(dropOnce = "test-pack" to 0L)
    try {
      client().fetchChunk("test-pack", 0, 65_536, partial)
      fail("a dropped connection must fail")
    } catch (e: IOException) {
      // expected: the receiver keeps its verified prefix and resumes
    }
    assertEquals(sha(bytes.copyOfRange(0, 65_536)), client().fetchChunk("test-pack", 0, 65_536, partial).sha256)
  }

  @Test
  fun stopsWhenIdle() {
    val idle = TransferServer(cert, token, manifest, emptyMap(), 1_500, InetAddress.getByName("127.0.0.1"))
    idle.start()
    Thread.sleep(4_000)
    assertFalse(idle.isRunning)
    assertEquals("idle", idle.stopReason)
  }

  @Test
  fun clientRefusesNonLocalHosts() {
    for (h in listOf("8.8.8.8", "example.com", "1.1.1.1")) {
      try {
        TransferClient(h, 443, token, cert.sha256)
        fail("$h must be refused")
      } catch (e: TransferClientException) {
        assertEquals("ERR_P2P_HOST", e.code)
      }
    }
    assertTrue(TransferClient.isLocal(InetAddress.getByName("192.168.49.1")))
    assertTrue(TransferClient.isLocal(InetAddress.getByName("10.0.2.2")))
    assertFalse(TransferClient.isLocal(InetAddress.getByName("100.64.0.1")))
  }

  @Test
  fun sessionCertificatesAreFreshAndSelfConsistent() {
    val a = SessionCert.create()
    val b = SessionCert.create()
    assertNotEquals(a.sha256, b.sha256)
    a.certificate.verify(a.keyPair.public)
    assertTrue(a.certificate.sigAlgName.uppercase().contains("SHA256"))
    assertEquals(64, a.sha256.length)
  }

  @Test
  fun apkPageServesOnlyThePageAndTheApk() {
    val apk = File(dir, "base.apk").also { it.writeBytes(ByteArray(1234) { 1 }) }
    val page = ApkServer(apk, "SKEPI", "1.0", "ab".repeat(32), InetAddress.getByName("127.0.0.1"))
    val p = page.start()
    try {
      fun status(path: String): Int = Socket("127.0.0.1", p).use { s ->
        s.soTimeout = 5_000
        s.outputStream.write("GET $path HTTP/1.1\r\nHost: x\r\n\r\n".toByteArray())
        Http.readResponse(s.inputStream).status
      }
      assertEquals(200, status("/"))
      assertEquals(200, status("/skepi.apk"))
      for (path in listOf("/app.db", "/pack/test-pack", "/manifest", "/../app.db", "/skepi.apk/../app.db")) assertEquals(path, 404, status(path))
    } finally {
      page.stop()
    }
  }
}
