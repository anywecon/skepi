import ExpoModulesCore
import Foundation
import Network

private let maxSmallFileBytes = 4 * 1024 * 1024

private func csError(_ code: String, _ message: String) -> Exception {
  Exception(name: "ContentStoreError", description: message, code: code)
}

/// Rules of the ContentStore that need no system services (the Swift twin of ContentRules.kt).
enum ContentRules {
  static let contentDirs: Set<String> = ["zim", "models", "maps", "tmp"]
  private static let fileName = try! NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")

  static func isAllowedFileName(_ name: String) -> Bool {
    fileName.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil && !name.contains("..")
  }

  /// `<dir>/<file>` under `root`, with `dir` one of the content folders; symlinks and `..` resolved first.
  static func resolve(_ root: URL, _ relativePath: String) throws -> URL {
    let parts = relativePath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 2, contentDirs.contains(parts[0]), isAllowedFileName(parts[1]) else {
      throw csError("ERR_CS_PATH", "invalid content path: \(relativePath)")
    }
    let base = root.standardizedFileURL.resolvingSymlinksInPath()
    let file = base.appendingPathComponent(parts[0], isDirectory: true).appendingPathComponent(parts[1]).standardizedFileURL
    guard file.path.hasPrefix(base.path + "/") else { throw csError("ERR_CS_PATH", "path escapes the content root: \(relativePath)") }
    return file
  }

  /// Identity of a file without reading it (ContentRules.kt `fileStamp`): size, device, inode,
  /// modification and change time. Startup hashes a pack again whenever it differs.
  static func fileStamp(_ url: URL) -> String? {
    var st = stat()
    guard stat(url.path, &st) == 0 else { return nil }
    return "i2:\(st.st_size):\(st.st_ino):\(st.st_mtimespec.tv_sec).\(st.st_mtimespec.tv_nsec):\(st.st_ctimespec.tv_sec).\(st.st_ctimespec.tv_nsec)"
  }

  /// Free space needed before a download starts: the file, 10% headroom and 1 GiB for the OS.
  static func requiredFreeBytes(_ sizeBytes: Int64) -> Int64 {
    sizeBytes + sizeBytes / 10 + 1024 * 1024 * 1024
  }
}

/// iOS side of the app's ContentStore (apps/mobile/src/lib/contentStore.ts), Phase 3b-0: local content
/// only. Packs arrive provisioned or imported; this build makes no network request at all, so
/// `startDownload` reports "not supported on this platform" (background URLSession downloads are a later
/// phase) and the network log stays empty. Files are never opened here: hashing and catalog checks run
/// before `installFile` moves a verified file into place.
public class ExpoContentStoreModule: Module {
  private let pathMonitor = NWPathMonitor()
  private let monitorQueue = DispatchQueue(label: "org.skepi.contentstore.path")
  private let lock = NSLock()
  private var path: NWPath?

  /// Application Support/skepi, excluded from backup: the same folder as expo-zim's content root.
  private func root() throws -> URL {
    let fm = FileManager.default
    guard let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      throw csError("ERR_CS_NO_STORAGE", "Application Support unavailable")
    }
    var root = support.appendingPathComponent("skepi", isDirectory: true)
    for dir in ContentRules.contentDirs {
      try fm.createDirectory(at: root.appendingPathComponent(dir, isDirectory: true), withIntermediateDirectories: true)
    }
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? root.setResourceValues(values)
    return root.standardizedFileURL.resolvingSymlinksInPath()
  }

  private func content(_ relativePath: String) throws -> URL {
    try ContentRules.resolve(try root(), relativePath)
  }

  /// Newest accepted catalog: app-internal, outside the content folders.
  private func catalogDir() throws -> URL {
    let fm = FileManager.default
    guard let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      throw csError("ERR_CS_NO_STORAGE", "Application Support unavailable")
    }
    let dir = support.appendingPathComponent("skepi-catalog", isDirectory: true)
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private func isFile(_ url: URL) -> Bool {
    var isDir: ObjCBool = false
    return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && !isDir.boolValue
  }

  private func size(_ url: URL) -> Int64 {
    ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoContentStore")
    Events("onImportProgress")

    OnCreate {
      // Reads the device's current network path only (no connection is made).
      self.pathMonitor.pathUpdateHandler = { [weak self] path in
        self?.lock.lock()
        self?.path = path
        self?.lock.unlock()
      }
      self.pathMonitor.start(queue: self.monitorQueue)
    }

    OnDestroy {
      self.pathMonitor.cancel()
    }

    Function("getContentRoot") { () -> String in
      try self.root().path
    }

    Function("getNetworkState") { () -> [String: Bool] in
      self.lock.lock()
      let p = self.path
      self.lock.unlock()
      guard let p, p.status == .satisfied else { return ["connected": false, "wifi": false, "metered": false] }
      return [
        "connected": true,
        "wifi": p.usesInterfaceType(.wifi) || p.usesInterfaceType(.wiredEthernet),
        "metered": p.isExpensive || p.isConstrained,
      ]
    }

    Function("getFreeBytes") { () -> Double in
      let values = try (try self.root()).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
      return Double(values.volumeAvailableCapacityForImportantUsage ?? 0)
    }

    Function("requiredFreeBytes") { (sizeBytes: Double) -> Double in
      Double(ContentRules.requiredFreeBytes(Int64(sizeBytes)))
    }

    AsyncFunction("startDownload") { (_: String, _: String, _: String, _: Bool) -> Double in
      throw csError("ERR_CS_UNSUPPORTED", "Downloads are not supported on this platform yet (iOS: provisioned or imported packs only)")
    }

    Function("queryDownload") { (_: Double) -> [String: Any]? in
      nil
    }

    Function("removeDownload") { (_: Double) -> Bool in
      false
    }

    Function("fileInfo") { (relativePath: String) -> [String: Any] in
      let f = try self.content(relativePath)
      let exists = self.isFile(f)
      let stamp: Any = (exists ? ContentRules.fileStamp(f) : nil) ?? NSNull()
      return ["exists": exists, "sizeBytes": Double(exists ? self.size(f) : 0), "path": f.path, "stamp": stamp]
    }

    /// Downloads land under the content root already (and are not supported yet on iOS).
    AsyncFunction("adoptDownload") { (fileName: String) -> String in
      try self.content("tmp/\(fileName).partial").path
    }

    /// Android 7–10 only (packs moving into internal storage); nothing to move on iOS.
    Function("legacyContent") { () -> [String] in
      []
    }

    AsyncFunction("moveLegacyFile") { (relativePath: String, _: String) -> [String: Any] in
      throw csError("ERR_CS_PATH", "nothing to move on iOS: \(relativePath)")
    }

    Function("listDir") { (dir: String) -> [[String: Any]] in
      guard ContentRules.contentDirs.contains(dir) else { throw csError("ERR_CS_PATH", "invalid dir: \(dir)") }
      let base = try self.root().appendingPathComponent(dir, isDirectory: true)
      let files = (try? FileManager.default.contentsOfDirectory(at: base, includingPropertiesForKeys: nil)) ?? []
      return files.filter { self.isFile($0) }.sorted { $0.lastPathComponent < $1.lastPathComponent }.map {
        ["name": $0.lastPathComponent, "path": $0.path, "sizeBytes": Double(self.size($0))]
      }
    }

    /// Atomic move of a verified file into place (same volume), replacing an older copy.
    AsyncFunction("installFile") { (fromRelative: String, toRelative: String) -> String in
      let from = try self.content(fromRelative)
      let to = try self.content(toRelative)
      guard self.isFile(from) else { throw csError("ERR_CS_NOT_FOUND", "Nothing to install at \(fromRelative)") }
      try FileManager.default.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
      if rename(from.path, to.path) != 0 {
        throw csError("ERR_CS_IO", "Cannot install \(toRelative): \(String(cString: strerror(errno)))")
      }
      return to.path
    }

    AsyncFunction("deleteFile") { (relativePath: String) -> Bool in
      let f = try self.content(relativePath)
      if !FileManager.default.fileExists(atPath: f.path) { return true }
      return (try? FileManager.default.removeItem(at: f)) != nil
    }

    /// Copies a file picked in the Files app into tmp/ (libzim needs a real path inside app storage).
    AsyncFunction("importFromUri") { (uriString: String, fileName: String) -> [String: Any] in
      guard let source = URL(string: uriString), source.isFileURL else {
        throw csError("ERR_CS_URI", "Unsupported URI: \(URL(string: uriString)?.scheme ?? uriString)")
      }
      let scoped = source.startAccessingSecurityScopedResource()
      defer { if scoped { source.stopAccessingSecurityScopedResource() } }
      let relative = "tmp/\(fileName).partial"
      let target = try self.content(relative)
      let declared = self.size(source)
      var copied: Int64 = 0
      do {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        FileManager.default.createFile(atPath: target.path, contents: nil)
        let output = try FileHandle(forWritingTo: target)
        defer { try? output.close() }
        var reported: Int64 = 0
        while true {
          let data = try autoreleasepool { try input.read(upToCount: 1 << 20) ?? Data() }
          if data.isEmpty { break }
          try output.write(contentsOf: data)
          copied += Int64(data.count)
          if copied - reported >= 8 * 1024 * 1024 {
            reported = copied
            self.sendEvent("onImportProgress", ["copiedBytes": Double(copied), "totalBytes": Double(declared)])
          }
        }
      } catch {
        try? FileManager.default.removeItem(at: target)
        throw csError("ERR_CS_IMPORT", "Import failed: \(error.localizedDescription)")
      }
      return ["displayName": source.lastPathComponent, "sizeBytes": Double(copied), "relativePath": relative, "path": target.path]
    }

    /// Small text/binary files under the content root (downloaded catalogs), base64.
    AsyncFunction("readSmallFileBase64") { (relativePath: String) -> String? in
      let f = try self.content(relativePath)
      guard self.isFile(f) else { return nil }
      if self.size(f) > maxSmallFileBytes { throw csError("ERR_CS_TOO_LARGE", "\(relativePath) is too large") }
      return try Data(contentsOf: f).base64EncodedString()
    }

    /// The signed catalog and pinned keys bundled in the app (`catalog/` in the bundle, per build
    /// configuration: apps/mobile/plugins/withSkepiIos.js).
    AsyncFunction("readEmbeddedCatalog") { () -> [String: Any?]? in
      func resource(_ name: String) -> Data? {
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("catalog", isDirectory: true) else { return nil }
        return try? Data(contentsOf: dir.appendingPathComponent(name))
      }
      guard let catalog = resource("catalog.json"), let sig = resource("catalog.json.sig"), let keys = resource("keys.json") else {
        return nil
      }
      return [
        "catalog": catalog.base64EncodedString(),
        "signature": String(decoding: sig, as: UTF8.self),
        "pinnedKeys": String(decoding: keys, as: UTF8.self),
        // Catalog update sources of this build (debug: the local test mirror; release: none yet).
        "sources": resource("sources.json").map { String(decoding: $0, as: UTF8.self) },
      ]
    }

    /// Newest accepted catalog (app-internal storage), written only after verification in JS.
    AsyncFunction("writeAcceptedCatalog") { (catalogBase64: String, signature: String) in
      guard let bytes = Data(base64Encoded: catalogBase64) else { throw csError("ERR_CS_ARGS", "catalog is not base64") }
      let dir = try self.catalogDir()
      let tmp = dir.appendingPathComponent("catalog.json.tmp")
      try bytes.write(to: tmp)
      try Data(signature.utf8).write(to: dir.appendingPathComponent("catalog.json.sig"), options: .atomic)
      if rename(tmp.path, dir.appendingPathComponent("catalog.json").path) != 0 {
        throw csError("ERR_CS_IO", "Cannot store the accepted catalog: \(String(cString: strerror(errno)))")
      }
    }

    AsyncFunction("readAcceptedCatalog") { () -> [String: String]? in
      let dir = try self.catalogDir()
      let c = dir.appendingPathComponent("catalog.json")
      let s = dir.appendingPathComponent("catalog.json.sig")
      guard self.isFile(c), self.isFile(s) else { return nil }
      return ["catalog": try Data(contentsOf: c).base64EncodedString(), "signature": String(decoding: try Data(contentsOf: s), as: UTF8.self)]
    }

    /// No download is ever requested on iOS in this phase: the zero-egress evidence is an empty log.
    Function("getNetworkLog") { () -> [[String: Any]] in
      []
    }

    Function("clearNetworkLog") {}
  }
}
