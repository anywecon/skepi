package org.skepi.transfer

import android.util.Log
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.security.MessageDigest
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket

private const val TAG = "SkepiTransfer"

/**
 * Unauthenticated sockets per peer address (below the 4 workers, so one address can never hold them
 * all; a phone requests one chunk at a time), and their deadline for the TLS handshake and the head.
 */
internal const val PREAUTH_PER_PEER = 2
internal const val PREAUTH_DEADLINE_MS = 5_000L

/**
 * Faults for the P2P E2E (debug builds only; the module refuses them in release builds): a chunk
 * corrupted once, a pack corrupted on every request, a connection dropped once mid-response.
 */
data class TransferFaults(
  /** `packId` and Range start whose response gets one byte flipped, once. */
  val corruptOnce: Pair<String, Long>? = null,
  /** Every response for this pack gets one byte flipped (a tampering host). */
  val corruptAlways: String? = null,
  /** `packId` and Range start whose response is cut after half its bytes, once. */
  val dropOnce: Pair<String, Long>? = null,
)

/**
 * The host's read-only HTTPS server (TLS 1.3 only, per-session certificate). Routes:
 *   GET /manifest      the session manifest (selected packs + the host's signed catalog)
 *   GET /pack/<id>     a selected pack, with `Range: bytes=a-b`
 * Every request needs `Authorization: Bearer <session token>` (compared in constant time). Only the
 * files passed in `packs` can ever be served: there is no path from a URL to the filesystem.
 * The server stops by itself after `idleTimeoutMs` without a request.
 */
class TransferServer(
  private val cert: SessionCert,
  private val token: String,
  private val manifest: ByteArray,
  packs: Map<String, File>,
  private val idleTimeoutMs: Long,
  private val bindAddress: InetAddress? = null,
  private val onStopped: (reason: String) -> Unit = {},
) {
  private val packs: Map<String, File> = packs.toMap()
  private val gate = PreAuthGate(PREAUTH_PER_PEER, PREAUTH_DEADLINE_MS)
  private val running = AtomicBoolean(false)
  private val lastActivity = AtomicLong(System.currentTimeMillis())
  private val requests = AtomicLong(0)
  private val bytesServed = AtomicLong(0)
  private val log = ArrayDeque<Map<String, Any>>()
  private var server: SSLServerSocket? = null
  private var workers: ExecutorService? = null
  @Volatile var faults: TransferFaults = TransferFaults()
  @Volatile var stopReason: String? = null
    private set

  val port: Int
    get() = server?.localPort ?: -1

  fun start(port: Int = 0): Int {
    check(running.compareAndSet(false, true)) { "already running" }
    val ss = cert.serverContext().serverSocketFactory.createServerSocket() as SSLServerSocket
    ss.enabledProtocols = arrayOf("TLSv1.3")
    ss.reuseAddress = true
    ss.bind(InetSocketAddress(bindAddress, port), 8)
    server = ss
    lastActivity.set(System.currentTimeMillis())
    // Four workers and a short bounded queue: extra connections are refused (the phone retries the chunk).
    val pool = ThreadPoolExecutor(4, 4, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue(16)) { r -> Thread(r, "skepi-p2p-conn").apply { isDaemon = true } }
    workers = pool
    Thread({ acceptLoop(ss, pool) }, "skepi-p2p-accept").apply { isDaemon = true }.start()
    Thread({ idleWatch() }, "skepi-p2p-idle").apply { isDaemon = true }.start()
    Log.i(TAG, "host listening on port ${ss.localPort} (${this.packs.size} packs)")
    return ss.localPort
  }

  fun stop(reason: String = "stopped") {
    if (!running.compareAndSet(true, false)) return
    stopReason = reason
    try {
      server?.close()
    } catch (_: IOException) {
    }
    workers?.shutdownNow()
    gate.shutdown()
    Log.i(TAG, "host stopped: $reason")
    onStopped(reason)
  }

  val isRunning: Boolean
    get() = running.get()

  fun status(): Map<String, Any?> = synchronized(log) {
    mapOf(
      "running" to running.get(),
      "requests" to requests.get().toDouble(),
      "bytesServed" to bytesServed.get().toDouble(),
      "lastActivityAtMs" to lastActivity.get().toDouble(),
      "stopReason" to stopReason,
      "log" to log.toList(),
    )
  }

  private fun record(method: String, path: String, status: Int) {
    synchronized(log) {
      if (log.size >= 200) log.removeFirst()
      log.addLast(mapOf("method" to method, "path" to path, "status" to status.toDouble(), "atMs" to System.currentTimeMillis().toDouble()))
    }
  }

  private fun idleWatch() {
    while (running.get()) {
      try {
        Thread.sleep(1_000)
      } catch (_: InterruptedException) {
        return
      }
      if (System.currentTimeMillis() - lastActivity.get() > idleTimeoutMs) stop("idle")
    }
  }

  private fun acceptLoop(ss: ServerSocket, pool: ExecutorService) {
    while (running.get()) {
      val socket = try {
        ss.accept()
      } catch (_: IOException) {
        break
      }
      // A peer without the token may hold only a few sockets, each for a few seconds.
      val ticket = gate.admit(socket)
      if (ticket == null) {
        socket.close()
        continue
      }
      try {
        pool.execute { serve(socket, ticket) }
      } catch (_: RejectedExecutionException) {
        ticket.release()
        socket.close()
      }
    }
  }

  private fun authorized(header: String?): Boolean {
    val given = header?.removePrefix("Bearer ")?.trim() ?: return false
    return MessageDigest.isEqual(given.toByteArray(Charsets.US_ASCII), token.toByteArray(Charsets.US_ASCII))
  }

  private fun serve(socket: Socket, ticket: PreAuthGate.Ticket) {
    socket.use { s ->
      try {
        ticket.startDeadline()
        s.soTimeout = PREAUTH_DEADLINE_MS.toInt()
        (s as SSLSocket).startHandshake()
        val req = Http.readRequest(s.getInputStream())
        val out = s.getOutputStream()
        if (!authorized(req.headers["authorization"])) {
          ticket.release()
          record(req.method, req.path.take(120), plain(out, 401, "Unauthorized"))
          out.flush()
          return
        }
        ticket.release()
        s.soTimeout = 30_000
        lastActivity.set(System.currentTimeMillis())
        requests.incrementAndGet()
        val status = route(req, out)
        record(req.method, req.path.take(120), status)
        out.flush()
      } catch (e: SocketException) {
        // Client went away, the pre-auth deadline closed it, or the session stopped: nothing to answer.
      } catch (e: IOException) {
        Log.w(TAG, "connection: ${e.message}")
      } finally {
        ticket.release()
      }
    }
  }

  private fun plain(out: OutputStream, status: Int, reason: String): Int {
    val body = reason.toByteArray(Charsets.UTF_8)
    Http.writeHead(out, status, reason, mapOf("Content-Type" to "text/plain; charset=utf-8", "Content-Length" to body.size.toString()))
    out.write(body)
    return status
  }

  private fun route(req: Http.Request, out: OutputStream): Int {
    if (!authorized(req.headers["authorization"])) return plain(out, 401, "Unauthorized")
    if (req.method != "GET") return plain(out, 405, "Method Not Allowed")
    if (req.path == "/manifest") {
      Http.writeHead(out, 200, "OK", mapOf("Content-Type" to "application/json", "Content-Length" to manifest.size.toString(), "Cache-Control" to "no-store"))
      out.write(manifest)
      bytesServed.addAndGet(manifest.size.toLong())
      return 200
    }
    val m = Regex("^/pack/([a-z0-9][a-z0-9._-]{1,79})$").matchEntire(req.path) ?: return plain(out, 404, "Not Found")
    val id = m.groupValues[1]
    val file = packs[id] ?: return plain(out, 404, "Not Found")
    val size = file.length()
    val range = try {
      Http.parseRange(req.headers["range"], size)
    } catch (_: IllegalArgumentException) {
      Http.writeHead(out, 416, "Range Not Satisfiable", mapOf("Content-Range" to "bytes */$size", "Content-Length" to "0"))
      return 416
    }
    val start = range?.first ?: 0L
    val end = range?.last ?: (size - 1)
    val length = end - start + 1
    val headers = mutableMapOf("Content-Type" to "application/octet-stream", "Content-Length" to length.toString(), "Accept-Ranges" to "bytes")
    if (range != null) headers["Content-Range"] = "bytes $start-$end/$size"
    Http.writeHead(out, if (range != null) 206 else 200, if (range != null) "Partial Content" else "OK", headers)
    sendFile(id, file, start, length, out)
    return if (range != null) 206 else 200
  }

  private fun sendFile(id: String, file: File, start: Long, length: Long, out: OutputStream) {
    val f = faults
    val corrupt = f.corruptAlways == id || f.corruptOnce == (id to start)
    if (f.corruptOnce == (id to start)) faults = f.copy(corruptOnce = null)
    val drop = f.dropOnce == (id to start)
    if (drop) faults = faults.copy(dropOnce = null)
    val limit = if (drop) length / 2 else length
    RandomAccessFile(file, "r").use { raf ->
      raf.seek(start)
      val buf = ByteArray(64 * 1024)
      var sent = 0L
      while (sent < limit) {
        val n = raf.read(buf, 0, minOf(buf.size.toLong(), limit - sent).toInt())
        if (n < 0) break
        if (corrupt && sent == 0L) buf[0] = (buf[0].toInt() xor 0xff).toByte()
        out.write(buf, 0, n)
        sent += n
        bytesServed.addAndGet(n.toLong())
        lastActivity.set(System.currentTimeMillis())
      }
    }
    if (drop) {
      out.flush()
      throw SocketException("fault: connection dropped after $limit of $length bytes")
    }
  }
}
