package org.skepi.transfer

import java.io.IOException
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Admission for the local servers (TransferServer, ApkServer): a peer address may hold at most
 * `perPeer` sockets that have not finished their request head (counted from accept, queued ones
 * included), and once a worker starts on a socket it has `deadlineMs` in total for the TLS handshake
 * and the head (a read timeout alone restarts with every byte). A socket waiting for a busy worker is
 * not timed out: phones queue behind long chunk transfers as before. Peers without the token therefore cannot hold the workers the phones need. Over the limit a
 * socket is closed at once (the phone retries the chunk).
 */
class PreAuthGate(private val perPeer: Int, private val deadlineMs: Long) {
  private val pending = HashMap<InetAddress, Int>()
  private val timer: ScheduledExecutorService =
    Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "skepi-preauth").apply { isDaemon = true } }

  inner class Ticket internal constructor(private val peer: InetAddress, private val socket: Socket) {
    private var open = true
    private var deadline: ScheduledFuture<*>? = null

    /** A worker took the socket: from now on it has `deadlineMs` for the handshake and the head. */
    @Synchronized
    fun startDeadline() {
      if (!open || deadline != null) return
      deadline = timer.schedule({
        try {
          socket.close()
        } catch (_: IOException) {
        }
      }, deadlineMs, TimeUnit.MILLISECONDS)
    }

    /** The request head arrived (and, for the transfer server, the token was checked): no deadline any more. */
    @Synchronized
    fun release() {
      if (!open) return
      open = false
      deadline?.cancel(false)
      synchronized(pending) {
        val n = (pending[peer] ?: 1) - 1
        if (n <= 0) pending.remove(peer) else pending[peer] = n
      }
    }
  }

  /** A ticket for `socket`, or null when its address already holds `perPeer` unfinished sockets. */
  fun admit(socket: Socket): Ticket? {
    val peer = socket.inetAddress ?: return null
    synchronized(pending) {
      val n = pending[peer] ?: 0
      if (n >= perPeer) return null
      pending[peer] = n + 1
    }
    return Ticket(peer, socket)
  }

  /** Closes a socket unless `progress()` is called again within `timeoutMs` (a peer that stops reading). */
  inner class Watchdog internal constructor(private val socket: Socket, private val timeoutMs: Long) {
    private var current: ScheduledFuture<*>? = null

    @Synchronized
    fun progress() {
      current?.cancel(false)
      current = timer.schedule({
        try {
          socket.close()
        } catch (_: IOException) {
        }
      }, timeoutMs, TimeUnit.MILLISECONDS)
    }

    @Synchronized
    fun cancel() {
      current?.cancel(false)
    }
  }

  fun watchdog(socket: Socket, timeoutMs: Long): Watchdog = Watchdog(socket, timeoutMs).also { it.progress() }

  fun shutdown() {
    timer.shutdownNow()
  }
}
