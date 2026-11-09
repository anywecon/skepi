package org.skepi.transfer

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.InetAddress
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

internal class TransferException(code: String, message: String) : CodedException(code, message, null)

class HostFile : Record {
  @Field val packId: String = ""
  @Field val path: String = ""
}

class HostOptions : Record {
  @Field val files: List<HostFile> = emptyList()
  /** The session manifest (JSON), built and checked in `@skepi/core` buildManifest. */
  @Field val manifest: String = ""
  /** `lan` (shared router) or `hotspot` (LocalOnlyHotspot). */
  @Field val mode: String = "lan"
  @Field val idleTimeoutMs: Double = 30.0 * 60 * 1000
  /** Also serve the app's own APK on a local cleartext page (app propagation). */
  @Field val shareApp: Boolean = false
}

class Pairing : Record {
  @Field val host: String = ""
  @Field val port: Int = 0
  @Field val token: String = ""
  @Field val certSha256: String = ""
  @Field val ssid: String? = null
  @Field val psk: String? = null
}

class Faults : Record {
  @Field val corruptOncePack: String? = null
  @Field val corruptOnceOffset: Double = 0.0
  @Field val corruptAlwaysPack: String? = null
  @Field val dropOncePack: String? = null
  @Field val dropOnceOffset: Double = 0.0
}

/**
 * Expo module for P2P sharing (docs/architecture.md, "P2P content sharing"; threat model "P2P").
 * Host: read-only TLS 1.3 server for the selected packs only, per-session certificate and 128-bit
 * token, LAN or LocalOnlyHotspot, optional local APK page. Receiver: pinned TLS client that writes
 * and hashes one chunk at a time into a partial file under tmp/. Trust decisions (catalog, chunk
 * hashes, install) are made in `@skepi/core` and the app's ContentStore, never here.
 */
class ExpoTransferModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private val network by lazy { LocalNetwork(context) }
  private var host: TransferServer? = null
  private var apkServer: ApkServer? = null
  private val sessions = ConcurrentHashMap<String, TransferClient>()
  private val jobs = ConcurrentHashMap<String, TransferClient>()
  private val random = SecureRandom()

  /** The ContentStore's root (ContentRules.contentRoot): internal storage on Android 7–10, app-specific external from 11. */
  private fun contentRoot(): File {
    val dir = if (Build.VERSION.SDK_INT >= 30) context.getExternalFilesDir(null) else File(context.filesDir, "content")
    return dir?.canonicalFile ?: throw TransferException("ERR_P2P_STORAGE", "content storage unavailable")
  }

  /** A file under one of the content folders (packs to serve) or tmp/ (partial files to write). */
  private fun contentFile(path: String, dirs: Set<String>): File {
    val f = File(path).canonicalFile
    val root = contentRoot()
    val parent = f.parentFile ?: throw TransferException("ERR_P2P_PATH", "invalid path")
    if (parent.parentFile?.canonicalPath != root.path || parent.name !in dirs) {
      throw TransferException("ERR_P2P_PATH", "path is outside the content folders: $path")
    }
    return f
  }

  private fun hex(bytes: Int): String = ByteArray(bytes).also { random.nextBytes(it) }.toHex()

  private fun stopAll(reason: String) {
    host?.stop(reason)
    host = null
    apkServer?.stop()
    apkServer = null
    network.stopHotspot()
  }

  private fun signingSha256(): String {
    val pm = context.packageManager
    val sig = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val info = pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
      info.signingInfo?.apkContentsSigners?.firstOrNull()
    } else {
      @Suppress("DEPRECATION")
      pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures?.firstOrNull()
    } ?: throw TransferException("ERR_P2P_APK", "no signing certificate")
    return MessageDigest.getInstance("SHA-256").digest(sig.toByteArray()).toHex()
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoTransfer")
    Events("onHostStopped")

    Function("capabilities") {
      mapOf(
        "apiLevel" to Build.VERSION.SDK_INT.toDouble(),
        "hotspot" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O),
        "joinHotspot" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q),
        // Debug builds only: the E2E injects corrupted chunks and dropped connections.
        "faultInjection" to BuildConfig.DEBUG,
      )
    }

    AsyncFunction("startHost") Coroutine { options: HostOptions ->
      withContext(Dispatchers.IO) {
        stopAll("restarted")
        val packs = options.files.associate { it.packId to contentFile(it.path, setOf("zim", "models", "maps")) }
        packs.values.forEach { if (!it.isFile) throw TransferException("ERR_P2P_NOT_FOUND", "missing ${it.name}") }
        val manifest = options.manifest.toByteArray(Charsets.UTF_8)
        if (manifest.size > 4 * 1024 * 1024) throw TransferException("ERR_P2P_MANIFEST", "manifest too large")
        var hotspot: LocalNetwork.Hotspot? = null
        val address = when (options.mode) {
          "hotspot" -> try {
            network.startHotspot().also { hotspot = it }.address
          } catch (e: LocalNetworkException) {
            throw TransferException(e.code, e.message ?: "hotspot failed")
          }
          "lan" -> network.lanAddress() ?: throw TransferException("ERR_P2P_NO_LAN", "not connected to a Wi-Fi network")
          else -> throw TransferException("ERR_P2P_MODE", "unknown mode ${options.mode}")
        }
        val cert = SessionCert.create()
        val token = hex(16)
        val server = TransferServer(cert, token, manifest, packs, options.idleTimeoutMs.toLong()) { reason ->
          network.stopHotspot()
          apkServer?.stop()
          sendEvent("onHostStopped", mapOf("reason" to reason))
        }
        val port = server.start()
        host = server
        var apkUrl: String? = null
        var apkSha: String? = null
        if (options.shareApp) {
          val info = context.applicationInfo
          val splits = info.splitSourceDirs
          if (splits != null && splits.isNotEmpty()) throw TransferException("ERR_P2P_APK", "this install is split (store bundle): the app cannot be shared as one APK")
          apkSha = signingSha256()
          val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
          val label = context.applicationInfo.loadLabel(context.packageManager).toString()
          val apk = ApkServer(File(info.sourceDir), label, pkg.versionName ?: "", apkSha)
          apkUrl = "http://$address:${apk.start()}/"
          apkServer = apk
        }
        Log.i("SkepiTransfer", "sharing ${packs.size} packs on $address:$port (${options.mode})")
        mapOf(
          "host" to address,
          "port" to port.toDouble(),
          "token" to token,
          "certSha256" to cert.sha256,
          "ssid" to hotspot?.ssid,
          "psk" to hotspot?.psk,
          "apkUrl" to apkUrl,
          "apkCertSha256" to apkSha,
        )
      }
    }

    Function("stopHost") { stopAll("stopped") }

    Function("hostStatus") { host?.status() ?: mapOf("running" to false) }

    Function("setFaults") { f: Faults ->
      if (!BuildConfig.DEBUG) throw TransferException("ERR_P2P_FAULTS", "fault injection exists only in debug builds")
      val server = host ?: throw TransferException("ERR_P2P_NOT_HOSTING", "not hosting")
      server.faults = TransferFaults(
        corruptOnce = f.corruptOncePack?.let { it to f.corruptOnceOffset.toLong() },
        corruptAlways = f.corruptAlwaysPack,
        dropOnce = f.dropOncePack?.let { it to f.dropOnceOffset.toLong() },
      )
    }

    /** Debug builds only: the pairing code as a file, so the two-emulator E2E can pass it on. */
    AsyncFunction("writePairingForTests") { text: String ->
      if (!BuildConfig.DEBUG) throw TransferException("ERR_P2P_FAULTS", "debug builds only")
      val dir = File(contentRoot(), "p2p").also { it.mkdirs() }
      File(dir, "pairing.json").writeText(text, Charsets.UTF_8)
    }

    /** Debug builds only: the pairing code pushed by the two-emulator E2E runner (adb push). */
    AsyncFunction("readPairingForTests") {
      if (!BuildConfig.DEBUG) throw TransferException("ERR_P2P_FAULTS", "debug builds only")
      val f = File(File(contentRoot(), "p2p"), "pairing-in.json")
      if (f.isFile && f.length() < 4096) f.readText(Charsets.UTF_8) else null
    }

    AsyncFunction("connect") Coroutine { p: Pairing ->
      withContext(Dispatchers.IO) {
        val address = try {
          TransferClient.parseLocal(p.host)
        } catch (e: TransferClientException) {
          throw TransferException(e.code, e.message ?: "invalid host")
        }
        val ssid = p.ssid
        val psk = p.psk
        val net = try {
          if (ssid != null && psk != null) network.joinHotspot(ssid, psk) else network.networkFor(address)
        } catch (e: LocalNetworkException) {
          throw TransferException(e.code, e.message ?: "network")
        }
        val id = hex(8)
        sessions[id] = TransferClient(p.host, p.port, p.token, p.certSha256, net?.socketFactory)
        id
      }
    }

    AsyncFunction("fetchManifest") Coroutine { sessionId: String ->
      withContext(Dispatchers.IO) {
        val client = sessions[sessionId] ?: throw TransferException("ERR_P2P_SESSION", "no such session")
        try {
          client.fetchManifest()
        } catch (e: TransferClientException) {
          throw TransferException(e.code, e.message ?: "manifest")
        } catch (e: IOException) {
          throw TransferException("ERR_P2P_CONNECT", e.message ?: "could not reach the host")
        }
      }
    }

    AsyncFunction("fetchChunk") Coroutine { sessionId: String, jobId: String, packId: String, offset: Double, length: Double, partialPath: String ->
      withContext(Dispatchers.IO) {
        val client = sessions[sessionId] ?: throw TransferException("ERR_P2P_SESSION", "no such session")
        val partial = contentFile(partialPath, setOf("tmp"))
        if (!Regex("^[a-z0-9][a-z0-9._-]{1,79}$").matches(packId)) throw TransferException("ERR_P2P_ARGS", "invalid pack id")
        jobs[jobId] = client
        try {
          val c = client.fetchChunk(packId, offset.toLong(), length.toLong(), partial)
          mapOf("sha256" to c.sha256, "bytes" to c.bytes.toDouble())
        } catch (e: TransferClientException) {
          throw TransferException(e.code, e.message ?: "chunk")
        } catch (e: IOException) {
          throw TransferException("ERR_P2P_INTERRUPTED", e.message ?: "connection lost")
        } finally {
          jobs.remove(jobId)
        }
      }
    }

    /** Keeps the verified prefix of a partial file (resume) or creates it empty. */
    AsyncFunction("truncatePartial") { partialPath: String, size: Double ->
      val partial = contentFile(partialPath, setOf("tmp"))
      partial.parentFile?.mkdirs()
      RandomAccessFile(partial, "rw").use { it.setLength(size.toLong()) }
      partial.length().toDouble()
    }

    Function("cancel") { jobId: String ->
      jobs[jobId]?.abort()
      Unit
    }

    Function("disconnect") { sessionId: String ->
      sessions.remove(sessionId)?.abort()
      if (sessions.isEmpty()) network.leave()
    }

    AsyncFunction("encodeQr") { text: String, size: Int -> Qr.pngDataUri(text, size) }

    Function("isLocalAddress") { host: String ->
      runCatching { TransferClient.isLocal(InetAddress.getByName(host)) && Regex("^[0-9a-fA-F:.]+$").matches(host) }.getOrDefault(false)
    }

    View(QrScannerView::class) {
      Events("onScanned", "onError")
    }

    OnDestroy {
      stopAll("app closed")
      sessions.values.forEach { it.abort() }
      sessions.clear()
      network.leave()
    }
  }
}
