# SKEPI threat model

Started in Phase 1c (catalog, downloads, import, viewer); Phase 1d added the structural source filter,
release guards, emergency cards, location and the tools; Phase 2a added P2P sharing, app propagation,
and the map and places packs; Phase 3a added the Windows desktop app (Tauri 2) and Station mode; the
post-preview hardening added Unicode normalisation, Layer 1 address removal, quoted-instruction checks and
source phone-number flags. Updated with every feature that adds an input,
a parser or a network path. Architecture context: `docs/architecture.md` ("Security", "Content pipeline").

## Assets

| Asset | Why it matters |
| --- | --- |
| Device integrity | ZIM, GGUF and PMTiles reach C/C++ parsers (libzim/Xapian, llama.cpp, MapLibre). |
| Content integrity | A modified medical article or model can cause physical harm. |
| User data | Questions, settings, later notes and places (app.db). |
| Privacy | Zero telemetry; no request may identify the device or the user. |
| Catalog signing key | Whoever holds it decides which files every device trusts. |

## Trust boundaries and entry points

1. **Signed catalog** (embedded in the APK, or a newer one from a catalog source).
2. **Downloads** from catalog mirrors (system DownloadManager, HTTPS).
3. **File import** (Storage Access Framework: USB, Files, another app).
4. **Article viewer** (HTML from ZIM files inside a WebView).
5. **Model output** (text shown to the user; covered by citation checks, `docs/architecture.md`).
6. **Article text as model input** (prompt injection inside ZIM passages; see "Source text").
7. **Bundled emergency cards and numbers** (safety-critical static content).
8. **Device sensors and intents** (GNSS, compass, torch, SMS/dialler hand-off; Phase 1d).
9. **P2P transfer** (Phase 2a): a host phone on the local network (shared LAN or LocalOnlyHotspot), the
   pairing QR code, and the local APK page.
10. **Map and places packs** (Phase 2a): PMTiles parsed by MapLibre, places SQLite parsed by SQLite.
11. **Desktop app** (Phase 3a): the main webview and its IPC to the native side, the sealed article
    viewer window, the `zim` and `maps` custom protocols, the Rust downloader, and Station mode (a LAN
    server reachable by any device on the network, behind the Windows Firewall).

## Source text (prompt injection)

| Threat | Mitigation | Verified by |
| --- | --- | --- |
| Injected instructions inside an article reach the model or Layer 1 | Before chunking, `sanitizeSourceText` removes **structural** injections — forged `<source>` blocks and tags, chat-template markup, JSON objects with role/system/assistant keys, role-prefixed lines (`SYSTEM:`, `[assistant]`), sentences addressed to the model/assistant/AI/summariser (vocatives, "note for …", persona assignments, answer-format orders, "this line supersedes …"), and the same addresses inside quoted or reported text (post-preview hardening); a structural hit also drops the rest of its paragraph — and the Phase 1b lexicon phrases. Paragraph breaks come from the extraction (one line per block element). | `packages/core/test/sanitize.test.ts`, `hardening.test.ts`, `rag.test.ts` (Layer 1 and the prompt); rag-eval adversarial set (gated) and held-out section (reported) |
| Markers disguised with Unicode (look-alike letters such as Cyrillic `Ѕ`/`Е`/`О`, full-width or mathematical letters, zero-width characters inside a word) | Every structural and lexicon check runs on detection forms (`normalize.ts`): NFKC, format characters dropped, TR39-style confusable folding of mixed-script words and of look-alike-only words inside Latin text; Greek text keeps Greek for the Greek checks. Spans are found in the normalised text and cut from the source; shown text is unchanged. Residual: look-alikes outside the folding table (other scripts, symbols) and words split by visible characters. | `packages/core/test/hardening.test.ts` (fresh examples, false-positive checks) |
| A Layer 1 excerpt sends the reader to an address | URLs and e-mail addresses in Layer 1 excerpts are replaced by "[link removed]" (`redactLinks`, the shapes of the AI-sentence rule, found in normalised text). The sealed article viewer shows the article itself; external links there are shown as text and never opened. | `hardening.test.ts`; Playwright (desktop, mocked native side) |
| A source gives a wrong number to call in an emergency | The bundled number of the user's country is shown first (banner, card). On emergency intent a Layer 1 sentence with any other phone number is flagged "Number from a source — use the emergency number shown above" (dialling shapes, or digits after a calling verb). Residual: a number written in words, or in a shape the detector does not cover, is shown unflagged — still below the bundled number. | `hardening.test.ts`; Playwright |
| Comment-like spans and tables written as text (Developer Preview, held-out set 2) | `<!-- … -->` written as visible text (also `&lt;!-- … --&gt;`, or unterminated to the end of its paragraph) is removed whole, whatever it says. A `|` is always a unit boundary: text between two `|` is a table cell, never merged with its neighbours into one "sentence" (so each cell meets the structural filter alone), and Layer 1 never highlights a cell on its own. Generic rules only: no phrase lists. | `packages/core/test/preview-rules.test.ts`; rag-eval held-out set 2 |
| An AI sentence sends the reader to an address | An AI sentence containing a URL (scheme, `www.`, or a bare lower-case host name) or an e-mail address is never shown (rejection `link`), even when copied verbatim from a passage: the app is offline and no answer has a legitimate use for one. | `preview-rules.test.ts` (fresh examples, false-positive checks) |
| An injection the filter misses | The model has no tools; every AI sentence must be supported by the cited source (bigram + number/unit checks); emergency cards never pass through the LLM. **Accepted residual risk (decision 2026-10-10, Developer Preview):** Layer 1 shows source text **verbatim** (since the post-preview hardening: addresses removed, source phone numbers flagged on emergency intent) — a fact-shaped or instruction-shaped sentence in a pack ("updated guidance: …", "developer mode enabled: …") is shown as written, labelled "Source excerpts — not verified advice". No phrase-based detection is added for such wording (it would be tuned to known examples and give false confidence). Source integrity rests on the **signed catalog of official packs** (Kiwix ZIMs of Wikipedia, OpenStreetMap extracts, pinned by SHA-256 and verified chunk by chunk); files outside the catalog are labelled unverified and need consent. | rag-eval held-out sets 1 and 2 (report only) |
| Injections the generic rules do not catch (accepted Layer 1 limitation, decision 2026-10-11, held-out set 4) | Three patterns stay visible in Layer 1 excerpts, verbatim and labelled "Source excerpts — not verified advice": **indirect instructions to AI tools** written as a reported request in prose ("the volunteers have asked that any AI tool … tell readers to …"); **obfuscated e-mail addresses** (`[at]`/`[dot]` spellings, which are not address shapes); **fake phone numbers outside emergency intent** (the source-number flag applies on emergency intent only; the bundled number stays first on emergency questions). No AI sentence showed any of them on eval, desktop or the S23. No phrase-based rule is added for them; content integrity rests on the signed catalog of official packs. | rag-eval held-out set 4 (report only; `docs/hardening-report.md`) |
| An injected instruction copied verbatim into an AI sentence (support 1.00 passes the citation checks) | **No AI summary on emergency intent** in any build (`summaryAllowed`; decision 2026-10-10 after held-out set 3 on the S23 showed an injected fracture instruction in a summary); **no AI summary on medical intent either** (decision 2026-10-21, no opt-in; `summaryBlock`). The rule is a product rule, not tuned to the set's wording. | `packages/core/test/rag.test.ts` (summarise refuses, runRag returns Layer 1, model never called, intent gate cases); Maestro `cards.yaml` and `medical.yaml`, Playwright and tauri-driver smoke (no summary button); held-out sets 2 and 3 on eval, desktop and Android |
| AI-layer behaviour differs between runtimes (llama.rn on the phone vs llama.cpp in eval/desktop: same model, different coverage decision) | Held-out sets and AI gates run on the device pipeline too (Bench → "Run held-out set", `e2e/run-heldout.ps1`), not on eval alone. | preview report, held-out sections per engine |

## Emergency cards and numbers

| Threat | Mitigation | Verified by |
| --- | --- | --- |
| Wrong first-aid instruction | Card steps are verbatim excerpts of the IFRC guidelines 2025 with section and page (decision 2026-10-21); never generated, never paraphrased; CODEOWNERS on the folder. | `tools/cards-source-check` in CI (`android-release-guards`, `ios-build`): every step an exact substring of the cited page of the pinned PDF (61/61) |
| A card step that is not the checked IFRC text reaches a release | Every release build runs `check-release.ts`: the steps must match `source-check.lock.json`, written only by a passed source check. | CI step "Release build must fail when a card step is not the source-checked IFRC text" (Android Gradle and iOS build phase, on an altered step) |
| Unsourced card text (the former US public-domain steps and their Greek translation) in a bundle | Unsourced topics are not imported by the package entry; every release bundle is scanned for the 202 former texts (UTF-8, UTF-16LE, `\uXXXX`) and must contain every sourced step, sourced steps only with a matching lock. | `tools/release-guards` `cards-bundle` (Gradle `skepiCheckCardsBundle`, iOS build phase, desktop in CI) and its unit tests |
| Wrong emergency number | Bundled per-country dataset with a documented official source per country; unknown country → 112 labelled "check the local number"; the country is chosen by the user, never from the network. Calls only open the dialler. | `numbers.test.ts` |

## Device sensors, permissions and intents

| Threat | Mitigation | Verified by |
| --- | --- | --- |
| Permission creep in release builds | Allowlist on the release APK (`aapt2 dump permissions`): INTERNET, ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE, ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION, and since Phase 2a exactly CHANGE_WIFI_STATE, CHANGE_NETWORK_STATE, NEARBY_WIFI_DEVICES (`neverForLocation`) and CAMERA (QR scanning only, asked on the Receive screen) (+ the app's own signature-level dynamic-receiver permission). ACCESS_BACKGROUND_LOCATION, REQUEST_INSTALL_PACKAGES and RECORD_AUDIO are forbidden. | `tools/release-guards` in CI (`android-release-guards`) |
| Location tracking | GPS provider only (no Play Services, no network location), one fix per tap, updates removed after the fix or timeout; no history stored; the compass and GNSS stop when the Tools tab loses focus or the app goes to background. | `ExpoEmergencyToolsModule`; `e2e/tools.yaml` |
| Silent SMS or calls | No SEND_SMS / CALL_PHONE permission: the app only opens the SMS app (`sms:?body=`) or the dialler (`tel:`); the user sends or calls. | permission allowlist; `run-e2e.ps1` (VIEW `sms:` intent) |
| Torch left on | The Morse player switches off on its own thread after stop, on errors and when the app goes to background. | `MorsePlayerTest` |
| Stale release bundle (old core code in a release) | Bundle task inputs include `packages/` and `modules/`; CI probe edits one file in each and requires a rebuilt bundle containing the change. | `tools/release-guards` bundle probe |

## P2P sharing (Phase 2a)

Design: `docs/architecture.md` ("P2P content sharing"); code: `packages/core/src/transfer.ts` (decisions),
`modules/expo-transfer` (sockets, TLS, hotspot, QR), `apps/mobile/src/lib/transfer.ts` (the only caller).
The receiver trusts files only through the signed catalog, never through the host.

| Threat | Mitigation | Verified by |
| --- | --- | --- |
| **LAN attacker** reads or alters a transfer, or impersonates the host | TLS 1.3 only, per-session self-signed certificate (fresh EC P-256 key, memory only); the receiver pins the certificate SHA-256 from the QR code and trusts no CA; every request carries the 128-bit session token (constant-time compare). A broken channel still cannot change content: every chunk is checked against the signed catalog. | `TransferServerTest` (other certificate refused, TLS 1.2 refused, token required); `transfer.test.ts` |
| LAN attacker probes the host for other files | The server maps only the selected pack ids to files; no URL reaches the filesystem (`/pack/<id>` with a strict id pattern, everything else 404, GET only). Conversations, notes, settings and app.db have no route. | `TransferServerTest.neverServesUnselectedPacksOrUserData` (traversal, encoded variants, other ids, app.db) |
| **Malicious host** sends altered or malicious bytes | A pack is accepted only when SHA-256, size and kind match the receiver's signed catalog; each chunk (64 MiB; 64 KiB for test packs) is hashed natively on arrival and compared with `chunkSha256`; a bad chunk is re-requested alone, at most 3 attempts, then the pack is rejected and its partial file deleted. The whole file is hashed again before the atomic install (as for downloads). Nothing under `tmp/` is opened. | `transfer.test.ts`; E2E `p2p-receive.yaml` (`propagate`, `tampered`) |
| Malicious host sends a forged, foreign-key or older catalog | Used only when the signature verifies with the receiver's trusted keys over the exact bytes and the sequence is higher (rollback and sequence reuse rejected); otherwise packs are checked against the receiver's own catalog. | `transfer.test.ts`; E2E `bad-signature`, `rollback` |
| Malicious host offers files outside any catalog (parser exploits) | Shown as unverified, never auto-selected; only a ZIM can be taken, by explicit choice, and it stays unverified (labelled, consent before opening, JavaScript off). Models, maps and places outside the catalog are refused. | `classifyOffers` tests; app.db `CHECK (verified = 1 OR kind = 'zim')` |
| Malicious host exhausts resources | Manifest ≤ 4 MiB and ≤ 256 packs, strict schema; responses must match the requested range and length; headers ≤ 8 KiB; free-space rules as downloads. | `transfer.test.ts`, `Http.kt` |
| **Malicious receiver** abuses the host | Read-only server (GET only), 4 concurrent connections, 30 s socket timeouts; the session ends when the host stops or after 30 minutes without a request; only packs the host selected are listed. | `TransferServerTest` (idle stop, methods) |
| **QR replay** (a photographed or old QR) | Token, key and certificate are per session: a new session means a new pin and token, and the old QR stops working when the session ends (stop or 30 minutes idle). Physical proximity is the trust channel; the code is shown only on the host's Share screen. | `sessionCertificatesAreFreshAndSelfConsistent`; idle stop test |
| A QR code that points to the internet | The pairing parser and the native client accept only local-network addresses (RFC 1918, link-local, IPv6 ULA/link-local); hostnames are refused (no DNS). | `transfer.test.ts`, `clientRefusesNonLocalHosts` |
| Hotspot credentials | LocalOnlyHotspot: random SSID and WPA2 password per start, no internet; the receiver joins it as a local-only network (WifiNetworkSpecifier, the user confirms). Both end with the session. | manual (hotspot E2E pending a second physical device) |
| Fault injection reaching users | Corrupt/drop/catalog faults exist only when the module's `BuildConfig.DEBUG` is true; release builds refuse them. | `capabilities().faultInjection` |

**App propagation (APK page).** The host can serve its own APK on `http://<host>:<port>/`, the only
cleartext server (outgoing cleartext stays forbidden by the network security config). It serves `/` and
`/skepi.apk` only, never packs or user data, and only while the user shares the app. The page shows the
signing-certificate SHA-256 to compare with the published fingerprint; Android refuses later updates
signed with another key. Residual risk: a LAN attacker can replace the cleartext page for a phone that
does not have the app yet; the fingerprint check is the defence. No `REQUEST_INSTALL_PACKAGES`. Split
(store) installs cannot be shared as one APK and are refused.

## Problem reports (Developer Preview)

| Threat | Mitigation | Verified by |
| --- | --- | --- |
| A report leaks more than the user expects | "Report a problem with this answer" builds text from the question, the shown Layer 1 excerpts and AI sentences, the cited sources (title, heading, article path) and the app version only (`@skepi/core` `problemReportText`): no time, device, location, settings, archive ids or other questions. The text is shown in full before any action. | `packages/core/test/report.test.ts`; Playwright "report a problem" |
| A report reaches the network | The app sends nothing: copy to the clipboard, or save (Android: `reports/` in the app folder; Windows: a native save dialog, `.txt` only, ≤ 256 KiB, command `report_save`). The user sends it. | Playwright (no network command); desktop egress check |

## Map and places packs (Phase 2a)

| Threat | Mitigation | Verified by |
| --- | --- | --- |
| Malicious PMTiles (MapLibre parser) or places SQLite | Only packs of a valid signed catalog are opened (verified `pmtiles` / `places` packs); unknown files in `maps/` are listed as ignored and never opened; app.db forbids unverified non-ZIM packs; places packs open read-only. | `reconcile` (`rejectedMaps`), `places.yaml` |
| Injection through place search | User text becomes quoted FTS5 prefix terms (`placesMatch`); no SQL is built from input. | `places.test.ts` |
| ODbL attribution | Stored in each places pack (`meta`) and shown on the map with the basemap attribution. | `places.test.ts`, `places.yaml` |
| Country packs built in CI (global maps, 2026-10-23): a compromised workflow or runner produces malicious packs | CI holds no secret and signs nothing; the maintainer measures every pack again on their own machine and `prepare --reports` refuses any pack whose size, SHA-256 or chunk hashes differ from the CI report before the offline signature; inputs are pinned (Protomaps build MD5, Geofabrik MD5, Natural Earth SHA-256, pmtiles CLI SHA-256, wheels by SHA-256). A malicious input is still parsed by MapLibre/SQLite only after the signed catalog names its hash (same exposure as any official pack). | `countries.test.ts` (`compareWithReport`), `packs.yml` |
| Catalog schema 2 downgrades the strict schema | `region` is accepted only in schema 2 and only on map and places packs, with typed fields (ISO code, finite coordinates, part id pattern, 1–500 non-empty part subdivision names, part box); unknown fields are still rejected; TypeScript and Rust apply the same rules. Older apps reject a schema 2 catalog whole (no partial parsing). | `catalog.test.ts`, `catalog.rs` tests |
| Position used for the emergency number | The live fix is compared with installed countries' boxes and their places packs in memory; only the country code is kept, in memory; nothing is stored, logged or sent. | `regions.test.ts` (`countryAt`) |

## Desktop app (Phase 3a)

Design: `docs/architecture.md` ("Desktop (Phase 3a)"); code: `apps/desktop` (UI; `src/lib/ipc.ts` is the
only module that calls the native side), `apps/desktop/src-tauri` (commands, protocols, capabilities),
`crates/desktop-core` (engines). The webview never names a file path: packs are named by id and resolved
from app.db; files and folders come from native pickers opened by Rust.

| Threat | Mitigation | Verified by |
| --- | --- | --- |
| **Article HTML reaches Tauri IPC** (a malicious ZIM calls `invoke`) | Articles open in a separate `viewer` window that no capability lists, so the ACL denies every command for it (`capabilities/main.json` names only `main`); JavaScript is off in that webview (`disable_javascript`, WebView2 `IsScriptEnabled = false`); every response carries a CSP without any script source and with `sandbox`; the `zim` protocol answers only the viewer webview. | `e2e/tauri-smoke.mjs` on the real debug and release builds: the sealing fixture's inline script did not run; a host-injected `invoke('zim_search')` was rejected ("not allowed on window viewer"); `fetch` to the IPC endpoint was blocked |
| Article HTML reaches the network or the disk | CSP `default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox` on every response (403/404 included) and as a meta tag; navigation to anything but the zim origin is cancelled and reported to the main window as text; new windows and downloads denied; incognito (nothing persisted). | `crates/desktop-core/src/viewer.rs` tests (CSP on every response, traversal variants rejected); smoke: external `http/https/file/content` images blocked, local image served, external link navigation cancelled and shown as text |
| Path traversal through `zim://` | The archive id must be a UUID-like token of an open archive; the ZIM path is percent-decoded once; raw, encoded, double-encoded and backslash dot segments and NULs are refused (as on Android). Paths are keys inside the archive; nothing maps to the filesystem. | `viewer.rs` tests |
| A compromised main webview abuses IPC | 30 narrow commands only (listed in `build.rs` and the capability); no shell, fs or http plugin permissions (the dialog plugin is used from Rust only); a download takes a pack **id** and Rust re-verifies the signed catalog itself (an Ed25519 port with the same rules as `@skepi/core`; `catalog/verification-expectations.json` is checked by both); settings are allowlisted (the catalog state and key list are written only by Rust); places queries must be read-only statements on read-only, verified packs. | `catalog_fixtures.rs` + `fixtures-catalog.test.ts`; `db.rs`, `places.rs` tests |
| Remote content in the main window | The main window loads only the bundled UI (`frontendDist`); CSP `default-src 'self'; script-src 'self'; connect-src ipc: http://ipc.localhost http://maps.localhost 'self'; object-src 'none'; frame-src 'none'`; MapLibre style, glyphs and sprites are bundled (SHA-256 checked when copied). `freezePrototype` is off (it broke a bundled library); accepted because no remote script can run. | smoke net log at start: only `tauri/ipc/zim/maps.localhost` |
| Malicious map pack (MapLibre) | The `maps` protocol serves only verified `pmtiles` packs by id, answers only the main webview, CORS limited to the app origin. | `protocols.rs`; smoke map |
| Malicious GGUF (llama.cpp) | `llm_load` takes a pack id and loads only verified GGUF packs (app.db `CHECK` too). | `commands.rs` |
| app.db key | 256-bit random key protected with DPAPI (current user, no UI, entropy bound to SKEPI); only the blob is on disk; SQLCipher refuses a wrong key. Residual: any process of the same Windows user can unprotect it (comparable to a Keystore key without user authentication). | `keystore.rs`, `db.rs` tests |
| Network use outside ContentStore | The Rust downloader (`download.rs`) is the only internet code: HTTPS only, catalog URLs only, `User-Agent: SKEPI`, no proxy discovery, per-chunk SHA-256; debug builds trust the test mirror CA only for `https://127.0.0.1:8443` (`test-mirror` feature, refused in release builds by `build.rs`). | `downloads.rs` against `e2e/mirror`; smoke: zero connections from `skepi-desktop.exe` |
| WebView2 runtime egress | See "WebView2 runtime egress" below: browser arguments switch off the runtime's background services and its Microsoft-account integration (`msOneAuthWAM`), and the WebView2 API turns off SmartScreen reputation checks. Measured online, idle and in use: no connection outside loopback. | `apps/desktop/e2e/egress.mjs --expect-none` (`docs/phase3a/egress`) |
| Unsigned installer | No code-signing certificate yet: SmartScreen warns on install; users check the published SHA-256 of the MSI/NSIS. | — |

### WebView2 runtime egress

The Microsoft WebView2 Runtime is a browser with its own services. The app restricts it:

- Browser arguments (`apps/desktop/src-tauri/src/commands.rs` `BROWSER_ARGS`, same for every webview):
  `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,msOneAuthWAM,msLoadOneAuthInBackground,msEdgeOSAccountInfoSubstrate --disable-background-networking --disable-component-update --disable-domain-reliability --no-pings --dns-prefetch-disable`.
- Sealed viewer (`crates/desktop-core/src/viewer.rs`): resource-hint links (`preconnect`, `dns-prefetch`,
  `prefetch`, `prerender`, `preload`, `modulepreload`) are removed from every page, parsed as the browser
  parses it, and every response sends `X-DNS-Prefetch-Control: off`: hints are resolved outside the CSP.
- WebView2 API (`src/webview2.rs`, every navigation of every webview): `IsReputationCheckingRequired = false`
  (no SmartScreen lookup of navigations or downloads).

Measurement (`apps/desktop/e2e/egress.mjs`): the release app starts directly (no WebDriver, so the
runtime runs with the app's own arguments), online, 120 s idle, then used through UI Automation
(search, article in the sealed viewer, Ask with the AI on the GPU, map, place search, emergency cards,
library, settings), then 60 s idle; every TCP/UDP endpoint of the `skepi-desktop.exe` process tree is
sampled (~0.5 s); names come from the Windows DNS cache and the Chromium net log.

| | Before (Phase 3a arguments) | After |
| --- | --- | --- |
| Remote connections | `msedgewebview2.exe` (browser process): 4 TLS connections to **`substrate.office.com`** (CNAME `outlook.cloud.microsoft`, Exchange Online addresses such as 40.104.205.130), from ~2–4 s after start until ~110 s; nothing during use or afterwards | **none** (idle, in use, after use) |
| Cause | The runtime's Microsoft-account integration (OneAuth over WAM: `oneauth.dll`, `MicrosoftAccountWAMExtension.dll` loaded, WinHTTP outside the Chromium network stack, so absent from the net log) fetching the Windows account's profile | — |

Controlled experiments (same binary, arguments overridden): `msOneAuthWAM` alone removes the
connection; `msEdgeOSAccountInfoSubstrate`, `msLoadOneAuthInBackground` or the account-info cache flags
alone do not. The app disables all three for defence in depth.

What remains, and what the app cannot switch off:

- **IPv6 reachability probe:** at start the network service "connects" a UDP socket to a Microsoft
  IPv6 address (`2603:1020:201:10::10f`) to learn whether IPv6 is routable. A UDP connect sends no
  packet (net log: `UDP_CONNECT`, then `-109` unreachable on this network); not egress.
- **WebView2 Runtime updates** are done by Microsoft Edge Update, a Windows service shared by all
  apps, not by this app; administrators control it by Edge Update policy.
- **Undocumented flags:** the `ms*` feature names are internal to the runtime (found in
  `msedge.dll`, runtime 154.0.4258.62). A future runtime could rename them: run
  `egress.mjs --expect-none` for every release and runtime upgrade.
- **Overrides outside the app:** the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable (or a
  WebView2 policy set by an administrator) replaces the app's arguments; a user or admin who sets it
  opts out of these protections.
- Deliberate network use is unchanged: pack downloads (ContentStore, on request) and Station mode
  (LAN, on request).

### Station mode

The desktop as a P2P host (`crates/desktop-core/src/station`), speaking the protocol of modules/expo-transfer.

| Threat | Mitigation | Verified by |
| --- | --- | --- |
| LAN attacker reads, alters or impersonates | TLS 1.3 only (rustls with ring), a per-session EC P-256 key and self-signed certificate (rcgen, memory only) pinned by the phone from the QR; 128-bit token compared in constant time. | `tests/station_server.rs`: pinned TLS 1.3, other pins refused, TLS 1.2 refused, token required |
| Serving unselected files or user data | The UI builds the manifest with `@skepi/core` `buildManifest`; Rust checks it lists exactly the selected installed packs (hash, size, kind, version) and carries no catalog or exactly the accepted one, then maps ids to files from app.db itself. Routes: `GET /manifest` and `GET /pack/<id>` (strict id pattern) only; anything else 404, other methods 405. | `station_server.rs` (16 paths incl. traversal and encoded variants, app.db, notes, settings: 404), `check_manifest` tests; Station E2E host log |
| Many phones / resource abuse | 32 concurrent connections, 30 s socket timeouts, headers ≤ 8 KiB, one request per connection; stops on demand or after 30 minutes without a request. | `station_server.rs` (16 parallel clients, idle stop) |
| The firewall opened too wide | Windows asks the first time Station mode listens; the app explains beforehand to allow **private** networks only. The server binds only the chosen LAN address (never `0.0.0.0`), and only local (RFC 1918 / link-local) addresses of this computer are offered. If the prompt is dismissed, Windows adds a block rule (seen in Phase 3a) and phones cannot connect until it is allowed. | `station/mod.rs` (`is_local`, address check) |
| APK page | Cleartext `/` and `/skepi.apk` only, from an APK the user picked; the v3/v2 signing-certificate SHA-256 named in it is shown for the user to compare with the published one; it is read, not verified, so the page never claims the APK is official (Android verifies the signature at install). Residual as on Android: a cleartext page on a hostile LAN; the fingerprint check is the defence. | `apk.rs` test |
| Phone with a VPN | Android refused to bind the P2P socket to the Wi-Fi network while a VPN was active (EPERM, S23); the client now falls back to normal routing. The host address is still checked as local, the certificate pinned and every chunk verified; a VPN that does not allow LAN traffic still blocks the session (enable LAN access or pause the VPN). | Station E2E finding |

## Catalog

| Threat | Mitigation | Verified by |
| --- | --- | --- |
| Forged or modified catalog (mirror, MITM, P2P) | Ed25519 signature over the **exact bytes** of `catalog.json` (`.sig` = base64 signature); nothing in the document is used before the signature verifies with a trusted key named by `keyId`. The JSON is never re-serialised before checking. | `packages/core/test/catalog.test.ts` (one flipped byte anywhere, re-serialised JSON, tampered signature); E2E `e2e/download.yaml` (tampered byte rejected on the phone) |
| Signature by an unknown key, or a key claiming a pinned id | Only pinned keys (active + offline backup) or keys from an accepted key list are trusted; the signature must verify with the named key. | unit tests (rogue key with a pinned id, unknown id); E2E wrong-key case |
| Rollback to an older catalog (re-enable a revoked file) | `sequence` must not go below the highest accepted one (stored in app.db); the same sequence with other content is rejected (`sequence_reuse`). No wall-clock time involved. | unit tests; E2E rollback case |
| A pack verified by an older catalog that should no longer be trusted (bad build, wrong content) | Packs verified by an earlier signed catalog stay trusted only while their bytes are unchanged; the signed catalog can **revoke** hashes (`revoked`), checked on every start and right after a catalog is adopted: revoked maps, places and models are never opened again, a revoked ZIM becomes unverified (new consent), its integrity check fails. Rollback cannot undo a revocation (`sequence`). Residual: an app before revocation lists rejects a catalog that has one and keeps its older catalog, so it keeps trusting the pack until the app is updated. | `packages/core/test/catalog.test.ts`, `apps/mobile/test/contentStore.test.ts`, `crates/desktop-core/tests/content_integrity.rs` |
| Malformed catalog after a valid signature (signer bug) | Strict schema: no unknown fields, HTTPS mirrors without query strings, 64-hex hashes, chunk count = ceil(size / 64 MiB), safe file names with the right extension, unique ids and files. | unit tests |
| Signing key theft | Key generated and kept **outside the repository**, offline, never in CI (`tools/catalog-builder` refuses key paths inside the repo). A backup key, kept separately, can sign a key list that rotates the active key out. | `tools/catalog-builder/test` |
| Test key reaching users | Debug builds embed a test catalog and test keys; release builds embed only release keys, and the release build **fails** unless `catalog/embedded/release` verifies with `catalog/keys/release.json` (purpose `release`, keys different from the test keys). | `skepiCheckReleaseCatalog` Gradle task |
| Loss of app.db (e.g. Keystore reset) | The database is recreated; the anti-rollback floor falls back to the embedded catalog's sequence. Accepted risk: an attacker would also need a validly signed older catalog. | — |

**Key rotation.** `catalog keylist` signs a key list (`keys.json` + `.sig`) with the key it replaces (or the
backup). The app accepts it only when the signer is trusted and the list's sequence does not roll back; from
then on exactly the listed keys are trusted. Verify path implemented and unit-tested in Phase 1c; distribution
of key lists arrives with catalog hosting.

## Downloads

| Threat | Mitigation | Verified by |
| --- | --- | --- |
| Corrupt or malicious file from a mirror | Download to `tmp/<file>.partial`; streaming SHA-256 on a native thread (`modules/expo-hash`); only a file whose hash and size match the signed catalog is moved into place (atomic rename) and registered. A mismatch deletes the file and tries the next mirror. Nothing under `tmp/` is ever opened by libzim or llama.cpp. | E2E: corrupt first mirror → next mirror; corrupt everywhere → rejected, never installed |
| Downgrade to HTTP / MITM | HTTPS only (ContentStore and catalog schema); network security config forbids cleartext and trusts only system CAs. DownloadManager uses the app's network security config. Integrity does not depend on TLS (signed hashes). | `ContentRulesTest`; unit tests |
| Tracking through requests | Generic `User-Agent: SKEPI` (DownloadManager's default contains the device model), no query strings, no device identifiers; URLs come only from the signed catalog. | mirror log in `e2e/run-download-e2e.ps1` |
| Network use outside ContentStore | Internet downloads only through `modules/expo-content-store`; local-network P2P only through `modules/expo-transfer`, called from `apps/mobile/src/lib/transfer.ts` alone (ESLint rule); ESLint forbids `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, Node network modules and the native downloader outside `apps/mobile/src/lib/contentStore.ts` (tooling exception: `tools/catalog-builder/src/download.ts`). | `pnpm lint`; zero-egress checks |
| Unexpected egress | Offline E2E (airplane mode): zero ContentStore requests and zero bytes for the app's UID on any real interface (`dumpsys netstats`). Download E2E: requests only to `127.0.0.1:8443` (the local mirror via `adb reverse`) and zero bytes on real interfaces. | `e2e/run-e2e.ps1`, `e2e/run-download-e2e.ps1` |
| Mobile data cost | Wi-Fi only by default; on a metered network the size is shown and the user confirms. | Library screen |
| Disk exhaustion | Free space ≥ size + 10% + 1 GB before a download starts. | `ContentRulesTest` |
| Debug trust leaking into release | The test mirror CA is trusted only by debug builds and only for `127.0.0.1`; its private key was deleted after issuing the mirror certificate. | `plugins/withContentStore.js` (debug source set only) |

## File import

| Threat | Mitigation |
| --- | --- |
| Malicious ZIM from USB / another app | Copied into app storage (libzim needs a real path), hashed, looked up in the catalog. Unknown ZIM = **unverified**: never opened without explicit consent, permanently labelled ("Unverified content — not in the signed catalog") in search results, articles and Ask sources; JavaScript stays off (the viewer never enables it). |
| Malicious GGUF (llama.cpp parser) | Unverified GGUF files are rejected (import) and never loaded (provisioned files that match no catalog entry are listed as rejected). The database forbids unverified non-ZIM packs (`CHECK`). |
| Path tricks in names | Files are stored under generated names (`import-<sha>.zim`); content paths are canonicalised and restricted to `zim/ models/ maps/ tmp/` (`ContentRules.resolve`). |

## Article viewer

Unchanged from Phase 1a (sealed `zim://` WebView, JS off, strict CSP, no JS bridge, path traversal rejected;
`SealingTest`). Phase 1d: blackout mode adds an inline `<style>` after the CSP meta in HTML responses (inline
style was already allowed); no script source changes (`SealingTest.blackoutThemeAddsDarkCssAndKeepsTheCsp`). Unverified packs render through the same viewer with the same restrictions plus the label.

## Data at rest

app.db is SQLCipher (op-sqlite); the 256-bit key is random per install and stored with expo-secure-store
(AES key in the Android Keystore). `allowBackup=false`.

## Dependency risk acceptance

From the osv-scanner report of 2026-11-04 (`osv-scanner scan source --lockfile pnpm-lock.yaml`, `cargo deny check`).
Everything else in that report at HIGH or CRITICAL was fixed; the fixes are scoped pnpm `overrides` in
`pnpm-workspace.yaml` and exact versions in the manifests. Re-check all rows by 2027-02-04, or at the Expo 58
upgrade if that comes first (`expo-router` 58 no longer depends on `query-string`, `@expo/cli` 58 no longer on zod).

| Package | Advisory | Ships in | Why it stays | Mitigation |
| --- | --- | --- | --- | --- |
| decode-uri-component 0.2.2 (`expo-router` 57 → `query-string` 7.1.3) | GHSA-qr28-fpjm-wq7f (HIGH), GHSA-vcc3-ghjq-m6fr (MODERATE): slow decoding of malformed percent-encoded input | **Mobile JS bundle** | **Not fixable today.** Fixed only in 0.5.1, which is ESM-only; `query-string` 7 `require`s it as a function, so under Metro (and Node) every `parse` throws `decodeComponent is not a function` (tested with a real Metro bundle) and route params break. Every `expo-router` 57 release needs `query-string` ^7. | **Reachable only through links of at most 2048 characters, which decode in milliseconds.** `expo-router` parses the query of an incoming `skepi://` link, and that scheme is BROWSABLE. Unguarded, a crafted link the user opens stalls the JS thread, and with it every screen including the emergency cards: measured on the maintainer's PC 32 KB 0.13 s, 128 KB 3 s, 224 KB 28 s (quadratic; slower on a phone). `apps/mobile/src/app/+native-intent.ts` (`admitDeepLink`, `packages/core/src/deepLink.ts`) therefore ignores links over 2048 characters, on launch and while running, before React Navigation parses them (malformed 2048 characters: 3 ms). The app's own routes do not pass through this guard; they carry well-formed params, which take the native decoder and never reach the slow path. |
| zod 3.25.76 (`@expo/cli` 57) | GHSA-mrhx-c7xc-m3w5 (HIGH): memory exhaustion validating a very large array | Nothing shipped (build and dev tooling) | No 3.x fix exists (fixed in 4.6.6); `@expo/cli` 57 is written for zod 3, so an override to 4 is not safe. | Used only to validate DevTools plugin metadata from our own `node_modules` when the dev server runs; no untrusted input, and the schemas never see user data. Not in the mobile or the desktop bundle. |
| libsqlite3-sys 0.38.2 (`rusqlite` 0.40.2, `bundled-sqlcipher-vendored-openssl`: SQLCipher 4.14.0 on SQLite 3.51.3); also SQLite 3.53.4 in `@op-engineering/op-sqlite`'s SQLCipher 4.19.0 (Android, not seen by the scanners) | RUSTSEC-2026-0459 / CVE-2026-119375 (added 2026-11-10): SQLite before 3.54.0 can return uninitialised page-cache memory when it opens a database together with a crafted `-wal` file of another page size | **Desktop app; Android app** | **No fixed SQLCipher build yet.** The advisory's fixed range (libsqlite3-sys ≥ 0.39.0) still bundles SQLite 3.53.4 when built with SQLCipher (`sqlcipher-src =419.0.6`); sqlcipher-src 420.0.0 (SQLite 3.54.1, 2026-10-30) is not used by any libsqlite3-sys release. Upgrading to `rusqlite` 0.41 would only make `cargo deny` pass. Ignored by id in `deny.toml`; re-check when libsqlite3-sys or op-sqlite moves to SQLite ≥ 3.54. | Needs a database and a crafted `-wal` next to it, written by someone else. SKEPI's SQLite databases are its own: `app.db` (SQLCipher-encrypted, in the app's private data folder) and the verified places packs, which the desktop opens read-only with `immutable=1` (no `-wal` is read). Android opens places packs read-only but not immutable; they live where only the app can write (app-specific storage from Android 11, internal storage on Android 7–10, `docs/architecture.md`, "Storage"). Writing a `-wal` there needs write access to the app's own files, which already allows far more. |
| proc-macro-error 1.0.4 (tauri → gtk 0.18 → glib-macros) | RUSTSEC-2024-0370: unmaintained | Nothing shipped (proc macro, Linux dependency graph only) | No fixed release; tauri has to move off gtk 0.18. | Runs only at compile time on source from crates.io, and SKEPI ships no Linux desktop build. Ignored by id in `deny.toml`. |

## Open items

- Catalog hosting and key-list distribution (later phase). Maps and places joined the catalog in Phase 2a;
  their mirror (GitHub release assets) is uploaded by the maintainer.
- Hotspot-mode P2P between two physical devices (only one was available in Phase 2a).
- Fuzzing of libzim / llama.cpp loaders (Phase 2 gate).
- Held-out adversarial sets 1–4 are used (decisions in Phase 1d, the Developer Preview and the
  post-preview hardening, 2026-10-11); a fresh unseen set is needed for any later decision.
- Emergency cards: review by certified first-aid instructors (release blocker).
- Desktop: code signing (SmartScreen); re-measure WebView2 egress on runtime upgrades (internal flag
  names); macOS (Keychain instead of DPAPI, WKWebView viewer).
