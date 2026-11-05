import Network
import SkepiZim
import UIKit
import WebKit
import XCTest

/// Viewer sealing guarantees from docs/architecture.md ("Sealed article reading") on iOS, checked against a
/// real WKWebView and the CC0 sealing fixture of the Android SealingTest. WebKit does not let an app
/// intercept http(s) the way Android's shouldInterceptRequest does, so "no network" is proven end to end
/// instead: a loopback listener sees the control web view connect and the sealed one never.
final class SealingTests: XCTestCase {
  private static var archiveId = ""
  private var recorder: Recorder!
  private var view: SealedWebView!

  /// docs/architecture.md, "Sealed article reading".
  private static let expectedCsp =
    "default-src 'none'; img-src zim: data:; style-src zim: 'unsafe-inline'; font-src zim:; media-src zim:"

  override class func setUp() {
    super.setUp()
    let open = try? ZimRegistry.shared.open(Fixtures.install(Fixtures.sealingZim))
    archiveId = open?.id ?? ""
  }

  override func setUpWithError() throws {
    XCTAssertFalse(Self.archiveId.isEmpty, "sealing fixture did not open")
    ZimRegistry.shared.clearBlocked()
    recorder = Recorder()
    view = SealedWebView(listener: recorder)
    attach(view)
  }

  override func tearDown() {
    view?.stopLoading()
    view?.removeFromSuperview()
    view = nil
    super.tearDown()
  }

  // MARK: - JavaScript

  func testJavaScriptIsDisabled() {
    XCTAssertFalse(view.configuration.defaultWebpagePreferences.allowsContentJavaScript)
    XCTAssertFalse(view.configuration.preferences.javaScriptCanOpenWindowsAutomatically)
  }

  func testScriptBridgesCannotBeAttached() {
    final class Handler: NSObject, WKScriptMessageHandler {
      func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {}
    }
    view.configuration.userContentController.add(Handler(), name: "bridge")
    view.configuration.userContentController.addUserScript(WKUserScript(source: "1", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    XCTAssertTrue(blockedLog().contains { $0.reason == "js-interface" && $0.url == "javascript-interface:bridge" })
    XCTAssertTrue(blockedLog().contains { $0.reason == "js-interface" && $0.url == "user-script" })
    XCTAssertTrue(view.configuration.userContentController.userScripts.isEmpty)
  }

  func testInlineScriptDoesNotRunInRealPage() {
    // The fixture page sets document.title = 'pwned' from an inline <script>.
    _ = loadAndAwait(zim("index"))
    // WKWebView can publish the document title just after didFinish: wait for it (bounded).
    let deadline = Date().addingTimeInterval(10)
    while (view.title ?? "").isEmpty && Date() < deadline {
      RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    }
    XCTAssertEqual(view.title, "Sealing fixture")
    XCTAssertTrue(view.url?.absoluteString.hasPrefix("zim://\(Self.archiveId)/") ?? false)
    // Whatever the page tried outside zim:// was refused (sub-frames are logged; the rest never left WebKit).
    XCTAssertTrue(blockedLog().allSatisfy { $0.reason.hasPrefix("scheme:") }, "\(blockedLog())")
    XCTAssertTrue(recorder.external.isEmpty)
  }

  // MARK: - Non-zim requests

  func testContentBlockerStopsEveryNonZimLoad() throws {
    func page(_ port: UInt16) -> String {
      """
      <html><body><img src="https://127.0.0.1:\(port)/a.png"><img src="http://127.0.0.1:\(port)/b.png">
      <link rel="stylesheet" href="https://127.0.0.1:\(port)/c.css"><iframe src="https://127.0.0.1:\(port)/d"></iframe>
      <video src="https://127.0.0.1:\(port)/e.mp4"></video></body></html>
      """
    }
    // Control: a default web view does reach its own listener, so the probe works.
    let controlServer = try LoopbackCounter()
    var control: WKWebView? = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: WKWebViewConfiguration())
    attach(control!)
    control?.loadHTMLString(page(controlServer.port), baseURL: nil)
    // 60 s: the first WebContent launch can take over 30 s on a stalled hosted runner.
    XCTAssertTrue(controlServer.waitForConnections(atLeast: 1, timeout: 60), "control web view never connected")
    control?.stopLoading()
    control?.removeFromSuperview()
    control = nil

    // Sealed configuration + content rule list, against a separate listener: nothing reaches it.
    let sealedServer = try LoopbackCounter()
    let ruleList = expectation(description: "rule list")
    var compiled: WKContentRuleList?
    SealedWebView.withRuleList { compiled = $0; ruleList.fulfill() }
    wait(for: [ruleList], timeout: 30)
    let sealedConfig = SealedWebView.makeConfiguration(handler: ZimSchemeHandler())
    sealedConfig.userContentController.add(try XCTUnwrap(compiled))
    let sealed = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: sealedConfig)
    attach(sealed)
    let finished = NavigationWaiter()
    sealed.navigationDelegate = finished
    sealed.loadHTMLString(page(sealedServer.port), baseURL: URL(string: "zim://\(Self.archiveId)/"))
    wait(for: [finished.done], timeout: 30)
    spin(3)
    XCTAssertEqual(sealedServer.connections, 0, "the sealed configuration let a request out")
    sealed.removeFromSuperview()
  }

  func testNonZimNavigationsNeverLoadAndAreReported() {
    let urls = [
      "http://example.invalid/",
      "https://example.invalid/",
      "file:///etc/hosts",
      "mailto:someone@example.invalid",
      "tel:112",
      "about:blank",
      "blob:zim://x",
      "data:text/html,<p>x</p>",
      "javascript:alert(1)",
    ]
    for raw in urls {
      let url = URL(string: raw) ?? URL(string: raw.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!)
      let main = SealedWebView.navigationPolicy(for: url, mainFrame: true)
      XCTAssertFalse(main.allow, raw)
      XCTAssertEqual(main.reason, "navigation:\(url?.scheme ?? "")", raw)
      let sub = SealedWebView.navigationPolicy(for: url, mainFrame: false)
      XCTAssertFalse(sub.allow, raw)
      XCTAssertEqual(sub.reason, "scheme:\(url?.scheme ?? "")", raw)
    }
    // A valid zim:// navigation stays inside the viewer; an invalid one does not.
    XCTAssertTrue(SealedWebView.navigationPolicy(for: URL(string: zim("en/Water_purification")), mainFrame: true).allow)
    XCTAssertFalse(SealedWebView.navigationPolicy(for: URL(string: "zim://\(Self.archiveId)/a/../index"), mainFrame: true).allow)
  }

  func testLoadEntryPointsRefuseAnythingButZim() {
    _ = view.load(URLRequest(url: URL(string: "https://example.invalid/")!))
    _ = view.load(URLRequest(url: URL(string: "file:///etc/hosts")!))
    _ = view.load(URLRequest(url: URL(string: "javascript:alert(1)")!))
    var post = URLRequest(url: URL(string: zim("index"))!)
    post.httpMethod = "POST"
    _ = view.load(post)
    _ = view.loadHTMLString("<p>x</p>", baseURL: URL(string: "https://example.invalid/"))
    _ = view.load(Data("<p>x</p>".utf8), mimeType: "text/html", characterEncodingName: "utf-8", baseURL: URL(string: "https://example.invalid/")!)
    _ = view.loadFileURL(URL(fileURLWithPath: "/etc/hosts"), allowingReadAccessTo: URL(fileURLWithPath: "/etc"))
    spin(1)
    XCTAssertNil(view.url, "nothing may have been loaded")
    XCTAssertEqual(recorder.blocked.map(\.reason), ["invalid-source", "invalid-source", "invalid-source", "post", "load-data", "load-data", "load-file"])
    XCTAssertEqual(blockedLog().count, 7)
  }

  // MARK: - CSP

  func testEveryZimResponseCarriesTheCsp() throws {
    let cases: [(String, Int)] = [
      (zim("index"), 200),
      (zim("style.css"), 200),
      (zim("img/dot.png"), 200),
      (zim("en/Water_purification"), 200),
      (zim("el/Καθαρισμός_νερού"), 200),
      (zim("does/not/exist"), 404),
      ("zim://\(Self.archiveId)/a/../index", 403),
      ("zim://not-an-open-archive/index", 403),
      ("zim:///index", 403),
      ("zim://\(Self.archiveId)/", 403),
    ]
    for (raw, status) in cases {
      let r = ZimSchemeHandler.respond(to: URL(string: raw), raw: raw)
      XCTAssertEqual(r.status, status, raw)
      XCTAssertEqual(r.headers["Content-Security-Policy"], Self.expectedCsp, raw)
      XCTAssertEqual(r.headers["X-Content-Type-Options"], "nosniff", raw)
      let http = ZimSchemeHandler.httpResponse(r, for: URL(string: "zim://x/y")!)
      XCTAssertEqual(http.value(forHTTPHeaderField: "Content-Security-Policy"), Self.expectedCsp, raw)
    }
    // Defence in depth: HTML also carries the policy as a <meta> tag inside <head>.
    let html = String(decoding: ZimSchemeHandler.respond(to: URL(string: zim("index"))).body, as: UTF8.self)
    let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(Self.expectedCsp)\">"
    let metaAt = try XCTUnwrap(html.range(of: meta))
    let scriptAt = try XCTUnwrap(html.range(of: "<script>"))
    XCTAssertLessThan(metaAt.lowerBound, scriptAt.lowerBound)
  }

  func testBlackoutThemeAddsDarkCssAndKeepsTheCsp() throws {
    let dark = ZimSchemeHandler.respond(to: URL(string: zim("index")), dark: true)
    XCTAssertEqual(dark.status, 200)
    XCTAssertEqual(dark.headers["Content-Security-Policy"], Self.expectedCsp)
    let html = String(decoding: dark.body, as: UTF8.self)
    let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(Self.expectedCsp)\">"
    let metaAt = try XCTUnwrap(html.range(of: meta))
    let styleAt = try XCTUnwrap(html.range(of: "<style id=\"skepi-dark\">"))
    XCTAssertTrue(html.contains("background:#000"))
    XCTAssertLessThan(metaAt.lowerBound, styleAt.lowerBound)
    let style = html[styleAt.upperBound...].components(separatedBy: "</style>").first ?? ""
    XCTAssertFalse(style.contains("script"))
    let light = String(decoding: ZimSchemeHandler.respond(to: URL(string: zim("index"))).body, as: UTF8.self)
    XCTAssertFalse(light.contains("skepi-dark"))
    // Non-HTML responses are untouched.
    let css = String(decoding: ZimSchemeHandler.respond(to: URL(string: zim("style.css")), dark: true).body, as: UTF8.self)
    XCTAssertFalse(css.contains("skepi-dark"))
  }

  func testCspMatchesTheArchitecture() {
    XCTAssertEqual(ZimSchemeHandler.csp, Self.expectedCsp)
  }

  // MARK: - Path traversal

  func testPathTraversalIsRejected() {
    let id = Self.archiveId
    let attempts = [
      "zim://\(id)/../index",
      "zim://\(id)/./index",
      "zim://\(id)/a/../index",
      "zim://\(id)/a/b/../../index",
      "zim://\(id)/a/b/page/../../../index",
      "zim://\(id)/%2e%2e/index",
      "zim://\(id)/%2E%2E/index",
      "zim://\(id)/a/%2e%2e/%2e%2e/index",
      "zim://\(id)/..%2findex",
      "zim://\(id)/a%2f..%2f..%2findex",
      "zim://\(id)/.%2e/index",
      "zim://\(id)/%252e%252e/index",
      "zim://\(id)/a/b/%252E%252E/page",
      "zim://\(id)/a\\..\\index",
      "zim://\(id)/a%5c..%5cindex",
      "zim://\(id)/index%00.html",
    ]
    for raw in attempts {
      XCTAssertNil(ZimSchemeHandler.parse(raw), raw)
      let r = ZimSchemeHandler.respond(to: URL(string: raw), raw: raw)
      XCTAssertEqual(r.status, 403, raw)
      XCTAssertTrue(blockedLog().contains { $0.url == raw && $0.reason == "invalid-zim-url" }, "not logged: \(raw)")
      XCTAssertFalse(view.loadZim(raw), raw)
    }
    // Controls: legitimate nested and non-ASCII paths still resolve.
    XCTAssertEqual(ZimSchemeHandler.respond(to: URL(string: zim("a/b/page"))).status, 200)
    XCTAssertEqual(ZimSchemeHandler.respond(to: URL(string: zim("el/Καθαρισμός_νερού"))).status, 200)
  }

  // MARK: - Storage, lookups, previews

  func testNoPersistentDataNoFraudLookupsNoLinkPreviews() {
    XCTAssertFalse(view.configuration.websiteDataStore.isPersistent)
    XCTAssertFalse(view.configuration.preferences.isFraudulentWebsiteWarningEnabled)
    XCTAssertFalse(view.allowsLinkPreview)
    XCTAssertEqual(view.configuration.dataDetectorTypes, [])
    XCTAssertNotNil(view.configuration.urlSchemeHandler(forURLScheme: "zim"))
  }

  // MARK: - Helpers

  private func zim(_ path: String) -> String {
    var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
    allowed.insert(charactersIn: "-._~")
    let encoded = path.split(separator: "/").map { String($0).addingPercentEncoding(withAllowedCharacters: allowed)! }
    return "zim://\(Self.archiveId)/" + encoded.joined(separator: "/")
  }

  private func blockedLog() -> [BlockedRequest] {
    ZimRegistry.shared.blockedRequests()
  }

  private func loadAndAwait(_ url: String) -> String {
    let done = expectation(description: "page finished")
    recorder.onFinish = { done.fulfill() }
    XCTAssertTrue(view.loadZim(url))
    wait(for: [done], timeout: 30)
    recorder.onFinish = nil
    return recorder.finished.last?.title ?? ""
  }

  private func attach(_ webView: WKWebView) {
    let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.windows.first }.first
    webView.frame = CGRect(x: 0, y: 0, width: 320, height: 480)
    window?.addSubview(webView)
  }
}

/// Counts TCP connections to a loopback port.
final class LoopbackCounter {
  private let listener: NWListener
  private let queue = DispatchQueue(label: "org.skepi.tests.loopback")
  private let lock = NSLock()
  private var count = 0
  private(set) var port: UInt16 = 0

  init() throws {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
    listener = try NWListener(using: params)
    let ready = DispatchSemaphore(value: 0)
    listener.stateUpdateHandler = { state in
      if case .ready = state { ready.signal() }
    }
    listener.newConnectionHandler = { [weak self] connection in
      self?.lock.lock()
      self?.count += 1
      self?.lock.unlock()
      connection.cancel()
    }
    listener.start(queue: queue)
    _ = ready.wait(timeout: .now() + 10)
    port = listener.port?.rawValue ?? 0
  }

  deinit {
    listener.cancel()
  }

  var connections: Int {
    lock.lock()
    defer { lock.unlock() }
    return count
  }

  func reset() {
    lock.lock()
    count = 0
    lock.unlock()
  }

  /// Polls while the main run loop keeps running (WebKit callbacks need it).
  func waitForConnections(atLeast n: Int, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if connections >= n { return true }
      RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    }
    return connections >= n
  }
}

final class NavigationWaiter: NSObject, WKNavigationDelegate {
  let done = XCTestExpectation(description: "navigation finished")

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    done.fulfill()
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    done.fulfill()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    done.fulfill()
  }
}
