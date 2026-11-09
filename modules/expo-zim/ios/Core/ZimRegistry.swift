import Foundation

/// Errors with the same codes as the Kotlin module (`ERR_ZIM_*`), mapped to JS exceptions by ExpoZim.
public struct ZimError: Error, CustomStringConvertible {
  public let code: String
  public let message: String

  public init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }

  public var description: String { "\(code): \(message)" }
}

public struct BlockedRequest: Equatable {
  public let url: String
  public let reason: String
  public let atMs: Int64
}

/// One open archive (the Swift twin of OpenArchive on Android).
public final class OpenArchive {
  public let id: String
  public let path: String
  public let archive: SKZArchive

  init(id: String, path: String, archive: SKZArchive) {
    self.id = id
    self.path = path
    self.archive = archive
  }
}

/// Hard cap on one entry's size (same as `MAX_ITEM_BYTES` on Android and the desktop).
public let zimMaxItemBytes: UInt64 = 16 * 1024 * 1024

/// Process-wide state shared by the module functions and the `zim://` scheme handler.
public final class ZimRegistry {
  public static let shared = ZimRegistry()

  /// The content folders the app owns under the content root (as on Android).
  public static let contentDirs = ["zim", "models", "maps", "icu", "bench", "tmp"]
  private static let maxBlocked = 200

  private let lock = NSLock()
  private var archives: [String: OpenArchive] = [:]
  private var blocked: [BlockedRequest] = []
  private var initialised = false
  public private(set) var nativeInitMs: Double = 0

  /// Application Support/skepi, excluded from backup (docs/architecture.md, "Files on disk"). The same
  /// folder as modules/expo-content-store's content root.
  public static func contentRoot() -> URL? {
    guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
    return support.appendingPathComponent("skepi", isDirectory: true)
  }

  /// Creates the content folders once and keeps the root out of iCloud / iTunes backups.
  public func ensureInitialised() {
    lock.lock()
    defer { lock.unlock() }
    if initialised { return }
    let start = DispatchTime.now()
    if var root = ZimRegistry.contentRoot() {
      for dir in ZimRegistry.contentDirs {
        try? FileManager.default.createDirectory(at: root.appendingPathComponent(dir, isDirectory: true), withIntermediateDirectories: true)
      }
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try? root.setResourceValues(values)
    }
    nativeInitMs = elapsedMs(since: start)
    initialised = true
  }

  /// Only files inside the app's own storage may be opened. Resolving symlinks and `..` first defeats
  /// path tricks (canonical paths on Android).
  public func requireAllowedFile(_ rawPath: String, extension ext: String) throws -> URL {
    let file = URL(fileURLWithPath: rawPath).standardizedFileURL.resolvingSymlinksInPath()
    let roots = [ZimRegistry.contentRoot(), FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first]
      .compactMap { $0?.standardizedFileURL.resolvingSymlinksInPath().path }
    let allowed = roots.contains { root in file.path.hasPrefix(root + "/") }
    if !allowed { throw ZimError("ERR_ZIM_PATH", "Path is outside app storage: \(rawPath)") }
    if !file.lastPathComponent.lowercased().hasSuffix(ext.lowercased()) {
      throw ZimError("ERR_ZIM_PATH", "Expected a \(ext) file: \(rawPath)")
    }
    var isDir: ObjCBool = false
    if !FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir) || isDir.boolValue {
      throw ZimError("ERR_ZIM_NOT_FOUND", "File not found: \(rawPath)")
    }
    return file
  }

  public func open(_ file: URL) throws -> OpenArchive {
    lock.lock()
    if let existing = archives.values.first(where: { $0.path == file.path }) {
      lock.unlock()
      return existing
    }
    lock.unlock()
    let archive: SKZArchive
    do {
      archive = try SKZArchive(path: file.path)
    } catch {
      throw ZimError("ERR_ZIM_OPEN", error.localizedDescription)
    }
    let opened = OpenArchive(id: archive.uuid, path: file.path, archive: archive)
    lock.lock()
    defer { lock.unlock() }
    if let previous = archives[opened.id] {
      // The UUID is self-declared: another file claiming an open archive's id is refused (the app
      // opens verified packs first), so it is never served or labelled as that archive.
      if previous.path == opened.path { return previous }
      throw ZimError("ERR_ZIM_DUPLICATE", "\(file.path) declares the id of the open archive \(previous.path)")
    }
    archives[opened.id] = opened
    return opened
  }

  public func get(_ id: String) throws -> OpenArchive {
    guard let open = find(id) else { throw ZimError("ERR_ZIM_NOT_OPEN", "Archive is not open: \(id)") }
    return open
  }

  public func find(_ id: String) -> OpenArchive? {
    lock.lock()
    defer { lock.unlock() }
    return archives[id]
  }

  public func all() -> [OpenArchive] {
    lock.lock()
    defer { lock.unlock() }
    return Array(archives.values)
  }

  public func close(_ id: String) {
    lock.lock()
    defer { lock.unlock() }
    archives.removeValue(forKey: id)
  }

  public func recordBlocked(_ url: String, _ reason: String) {
    NSLog("[ExpoZim] blocked request (%@): %@", reason, url)
    lock.lock()
    defer { lock.unlock() }
    if blocked.count >= ZimRegistry.maxBlocked { blocked.removeFirst() }
    blocked.append(BlockedRequest(url: url, reason: reason, atMs: Int64(Date().timeIntervalSince1970 * 1000)))
  }

  public func blockedRequests() -> [BlockedRequest] {
    lock.lock()
    defer { lock.unlock() }
    return blocked
  }

  public func clearBlocked() {
    lock.lock()
    defer { lock.unlock() }
    blocked.removeAll()
  }
}

public func elapsedMs(since start: DispatchTime) -> Double {
  Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
}
