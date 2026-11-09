# Project S.K.E.P.I. — Architecture

**S.K.E.P.I.** = **S**urvival **K**nowledge & **E**mergency **P**ocket **I**ntelligence. *Skepi* (σκέπη) is Greek for shelter, protection.

> Status: Phase 0 complete (GO); Phase 1a (foundation and security hardening) complete; Phase 1b (two-layer answers, latency, citation hardening) complete — report `docs/phase-1b-report.md`; Phase 1c (retrieval parity, signed catalog, downloads, import) — report `docs/phase-1c-report.md`, threat model `docs/threat-model.md`; Phase 1d (structural injection filter, release guards, emergency cards, onboarding, blackout mode, tools) — report `docs/phase-1d-report.md`, Phase 1 gate `docs/phase-1-gate.md`; Phase 2a (P2P sharing, places and map packs, English-only gates; Android) — report `docs/phase-2a-report.md`; Phase 3a (Windows desktop app with Tauri 2 and Station mode) — report `docs/phase-3a-report.md`; Phase 3b-0 (Apple builds in CI: iOS Simulator and macOS desktop, no Mac, no signing) — report `docs/phase-3b0-report.md`; **Developer Preview `v0.1.0-preview`** (Android + Windows; preview build mode, About, problem reports, held-out set 2 rules) — report `docs/preview-report.md`; **owner decisions 2026-10-21** (legal/compliance: IFRC-sourced emergency cards, no AI summary on medical intent, one intended-purpose statement, non-commercial rule, AI-generated marker; live location and heading on the map; water, earthquake, fire and flood cards from CDC and FEMA Ready.gov public-domain pages) — research: [`docs/legal-research.md`](legal-research.md); **global maps** (owner decision 2026-10-23: a map and a places pack for every country, chosen in Packs → "Maps & places", catalog schema 2; pilot of 8 countries built and measured, not published) — report [`docs/global-maps-pilot.md`](global-maps-pilot.md). This file is the source of truth for Claude Code. The two diagrams of the Claude Doc are rendered here as text.

## Vision and principles

An open-source, mobile-first app that provides Wikipedia, medical and survival knowledge, maps and an AI assistant with no connectivity after the initial download. It runs on Android, iOS, Windows and macOS using open formats, so the same content moves from device to device.

**Goals**

- The library and maps work on a 4 GB RAM phone, without AI.
- The AI answers only from sources on the device and shows them in every answer.
- Content is shared device-to-device without internet.
- Zero telemetry; no connection without an explicit user action.
- English-only until v1 (UI, content, docs, evaluation). Greek is the first post-v1 locale: its existing strings and tests stay in the code but are frozen and outside the required gates.

**Non-goals**

- Not a Docker server like NOMAD. Every device is self-sufficient.
- No proprietary content format. We use ZIM, GGUF and PMTiles.
- Not a medical device and no diagnosis. The AI is a search-and-summarise tool. The intended purpose, word for word in the store description, About screens, README and privacy policy (decision 2026-10-21): "S.K.E.P.I. is for general reference and education only. It is not a medical device and does not diagnose, treat, cure, or prevent any medical condition. Consult a healthcare professional for medical advice. In an emergency, call 112 or your local emergency number."
- No commercial use of any kind: no paid features, ads, analytics or data collection; donations only, without consideration (decision 2026-10-21; Licences and legal).
- No accounts, no cloud sync, no backend.

**Design principles**

1. **Offline by default.** The network is used only to download content, and only when the user asks.
2. **Knowledge first, AI second.** Every feature works with the LLM off.
3. **Answers only with sources.** If no source is found, the app says so and does not improvise.
4. **Battery is a survival resource.** Every choice is also judged by its cost in mWh.
5. **Verifiable content.** Every file has a signed hash, whether it came from the internet or another phone.
6. **Open formats.** A ZIM downloaded here opens in Kiwix or NOMAD, and vice versa.

## Platforms and tech stack

Two shells over one shared TypeScript core. Mobile runs Expo/React Native, desktop runs Tauri 2. The heavy parts (inference, ZIM, maps) are the same C/C++ engines everywhere, with a different binding per platform.

| Component | Android / iOS | Windows / macOS | Why |
| --- | --- | --- | --- |
| UI shell | Expo (dev build, New Architecture) | Tauri 2 with React in the webview | Mobile is the primary target. Tauri gives a small binary and Rust for native work. |
| Shared logic | `packages/core` (TS strict) | same | RAG, catalog, verification, prompts and i18n written once. |
| LLM inference | llama.rn (llama.cpp, Metal on iOS) | llama.cpp in-process via Rust (Vulkan / Metal / CUDA) | One model format (GGUF) everywhere. In-process avoids a local HTTP server. |
| Library | libkiwix + libzim via Expo native module (Kotlin / Swift) | libzim via Rust FFI | Official ZIM implementation with built-in Xapian index. |
| Article viewer | Native viewer inside `expo-zim` (platform WebView driven natively) | Separate sealed WebView2 window over the `zim` custom protocol: no IPC capability, JavaScript off, CSP with `sandbox` (Phase 3a) | react-native-webview cannot serve a custom `zim://` scheme without patching on both platforms (Phase 0 finding). |
| Maps | MapLibre Native (RN) | MapLibre GL JS in the webview | Reads local PMTiles with no tile server. |
| Local DB | SQLite (op-sqlite, SQLCipher) | SQLite via Rust (rusqlite) | Same shared SQL migrations. |
| Crypto | @noble/ed25519, @noble/hashes | same (in core) + ring in Rust | Audited, dependency-free libraries. SHA-256 of large files runs natively. |
| Monorepo | pnpm workspaces + Turborepo | same | Expo supports pnpm monorepos well. |

libkiwix for Android comes from the official package on Maven Central (validated in Phase 0). For iOS/macOS, kiwix-build produces CoreKiwix.xcframework. We write bindings, not parsers.

Rejected: Tauri for all platforms (mobile is less mature for native maps and background downloads, and we would lose llama.rn); React Native Windows (llama.rn does not support Windows).

## High-level architecture

Layers, top to bottom:

1. **UI:** Mobile app (Expo / React Native · Android, iOS) and Desktop app (Tauri 2 + React · Windows, macOS).
2. **packages/core (TypeScript, shared):** RAG · safety layer · catalog verification · pack manager · guards · i18n.
3. **Adapters (interfaces from packages/contracts):**
   - Expo native modules: expo-zim (Kotlin / Swift, incl. native viewer) · llama.rn · MapLibre Native · expo-transfer · SQLCipher.
   - Rust (src-tauri): zim-ffi · llama.cpp (Vulkan / Metal) · MapLibre GL JS · transfer · rusqlite.
4. **Native engines (C/C++), same everywhere:** llama.cpp · libkiwix / libzim + Xapian · MapLibre · SQLite.
5. **Local storage:** ZIM · GGUF · PMTiles · places DB · app.db (encrypted).
6. **Content inputs (every file is SHA-256 verified before opening):**
   - Signed catalog + mirrors (Kiwix · Hugging Face · Protomaps), during preparation only.
   - Another device (P2P): LAN / hotspot · QR pairing · TLS, no internet.

The UI talks only to `packages/core`. Core talks to engines only through interfaces, and content enters only through the two input points, verified.

## Monorepo layout

Platform-specific code lives behind an interface from `packages/contracts`, so core is testable in Node without a phone.

```
/apps
  /mobile            Expo app (Android + iOS), expo-router, UI and wiring only
  /desktop           Tauri 2: src-tauri (Rust) + web UI (React, Vite)
/packages
  /core              Domain, RAG orchestrator, safety layer, catalog/verify, pack manager
  /contracts         TS interfaces: KnowledgeEngine, InferenceEngine, ContentStore, TransferService, DeviceProfile
  /db                SQL migrations + typed queries (shared mobile/desktop)
  /i18n              English strings; Greek kept but frozen until after v1 (developer flag); typed catalogs + locale resolution
  /emergency-cards   Emergency cards whose steps are verbatim excerpts of the IFRC International First Aid, Resuscitation and Education Guidelines 2025 (section, printed page) or of CDC and FEMA Ready.gov pages (heading, URL, retrieval date), each with its citation; `source-check.lock.json` (the steps the last passed source check verified); unsourced topics listed apart and never bundled; per-country emergency numbers; release gate; `preview` entry (same cards, preview label)
  /ui-tokens         Colours, type scale, touch targets, light and blackout themes (WCAG AA checked in tests)
/modules
  /expo-zim          Kotlin + Swift binding over libkiwix/libzim, plus the native article viewer
  /expo-device-profile  RAM, thermal state, battery, free storage
  /expo-transfer     P2P (Phase 2a): TLS 1.3 server with a per-session pinned certificate, pinned client hashing every chunk, LocalOnlyHotspot + WifiNetworkSpecifier, QR encode/scan (ZXing, CameraX), local APK page
  /expo-hash         Streaming SHA-256 (whole file + 64 MiB chunks) on a native thread, progress, cancel
  /expo-content-store  The only network user: system DownloadManager, SAF import, atomic install, embedded catalog
  /expo-emergency-tools  SOS torch (Morse timeline), compass (throttled readings), one-shot GNSS fix and continuous fixes for the map (GPS provider / CoreLocation, no Play Services, foreground only), screen brightness
/crates
  /zim-ffi           Rust FFI to libzim (cxx shim over the official Windows build)
  /desktop-core      ZIM text, inference (llama.cpp), content store + downloader, signed catalog, SQLCipher db,
                     DPAPI key, places, Station mode (P2P host), viewer protocol; bin/zim-sidecar for parity
/native
  /kiwix             Pinned versions + checksums (Maven AAR; CoreKiwix.xcframework for iOS + macOS; libzim 9.7.0 Windows build; fetch scripts)
/tools
  /catalog-builder   Builds and signs catalog.json (keygen, pin, build, prepare, sign, keylist, verify; key never in the repo or CI);
                     country packs: regions/ (Natural Earth regions, map parts), `countries` (manifest), `pack` (one pack + report, CI)
  /rag-eval          Answer evaluation against golden sets
  /bench             Benchmarks: tokens/s, latency, energy
  /cards-source-check  Downloads the IFRC guidelines PDF (pinned URL + SHA-256, never committed), extracts it with pdftotext and fails unless every card step is an exact substring of the cited page (whitespace/hyphenation/quote normalisation only); CDC / Ready.gov steps against the committed dated text snapshots (`snapshots/`, URL, retrieval date, SHA-256 of the fetched HTML), one block under the cited heading; `drift` re-fetches the pages (weekly CI job)
  /release-guards    Release checks: permission allowlist (aapt2), release JS bundle rebuild probe, card text in the built bundles (`cards-bundle`), intended-purpose statement in the store texts
/docs                Architecture, ADRs, threat model, SECURITY.md, phase reports
```

**Dependency rules**

- `core` depends only on `contracts`, never on React, Expo or Tauri.
- `apps` provide the interface implementations (adapters) and inject them into core.
- Internet access exists only in ContentStore (`apps/mobile/src/lib/contentStore.ts` over `modules/expo-content-store`); local-network P2P only in `apps/mobile/src/lib/transfer.ts` over `modules/expo-transfer` (local addresses only, enforced in core and natively); ESLint forbids `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, Node network modules and the native downloader anywhere else (tooling exception: `tools/catalog-builder/src/download.ts`). On the desktop, internet access exists only in `crates/desktop-core/src/download.rs` (ContentStore) and the LAN server only in `crates/desktop-core/src/station`; the UI reaches the native side only through `apps/desktop/src/lib/ipc.ts` (ESLint forbids `@tauri-apps/*` imports elsewhere); its only `fetch` reads PMTiles from the local `maps` protocol.
- Every native library has a pinned version and checksum in `/native`. Upgrades go through a PR with green CI.

**Core interfaces (`packages/contracts`)**

```ts
export interface KnowledgeEngine {
  openArchive(file: PackFile): Promise<ArchiveInfo>;
  search(query: string, opts: SearchOptions): Promise<SearchHit[]>;
  getArticle(archiveId: string, path: string): Promise<Article>;
  getPlainText(archiveId: string, path: string): Promise<ArticleText>;
  closeArchive(archiveId: string): Promise<void>;
}

export interface InferenceEngine {
  load(model: InstalledModel, opts: LoadOptions): Promise<LoadedModel>;
  generate(req: GenerateRequest, onToken: (t: string) => void, signal: AbortSignal): Promise<GenerateResult>;
  embed?(texts: string[]): Promise<Float32Array[]>;
  unload(): Promise<void>;
}

export interface ContentStore {
  listInstalled(): Promise<InstalledPack[]>;
  download(entry: CatalogEntry, signal: AbortSignal): AsyncIterable<DownloadProgress>;
  importFile(uri: string): Promise<InstalledPack>;
  verify(pack: InstalledPack): Promise<VerifyResult>;
  remove(packId: string): Promise<void>;
}

export interface DeviceProfile {
  snapshot(): Promise<{ totalRamMb: number; freeRamMb: number; freeDiskMb: number;
    batteryPct: number; charging: boolean; thermal: 'nominal' | 'fair' | 'serious' | 'critical' }>;
}
```

## AI engine

The LLM is optional, loads only when needed, and its size is chosen automatically from the device profile. Every model in the catalog is Apache-2.0 or MIT, so it can be shared device-to-device legally.

**Device tiers** (to be confirmed with `/tools/bench` on real devices)

| Tier | Device | Model | Context | Behaviour |
| --- | --- | --- | --- | --- |
| T0 | < 4 GB RAM | None | — | Search, articles, maps, cards only |
| T1 | 4–6 GB RAM | ~1–2B, Q4_0 | 2048 | Extractive answer by default; AI summary on demand |
| T2 | 8–12 GB RAM | ~3–4B, Q4_0 | 4096 | Extractive answer + automatic AI summary, optional embedding rerank |
| T3 | Desktop with GPU or 16 GB+ | ~7–9B, Q4/Q5 | 8192 | Longer syntheses, more articles per answer |

**Tier detection** (`packages/core`, `detectMobileTier`) uses the RAM visible to Android, which is always below the marketed size: < 3300 MB → T0, < 6500 MB → T1, otherwise T2 (T3 is desktop-only). On the desktop (`detectDesktopTier`, `resolveDesktopProfile`): T3 with a GPU of ≥ 4 GB dedicated memory (llama.cpp Vulkan device; integrated GPUs count as 0) or ≥ 15,000 MB RAM, otherwise the mobile thresholds; T3 offloads every layer to the discrete GPU (CPU fallback), context 8192. The T3 character budget applies only with a 7–9B model; with the mobile model (Qwen2.5-1.5B) the desktop keeps the T2 budget it was validated with (Phase 3a).

**Test devices.** Current reference: Galaxy S23 (8 GB, T2). All T1 gates stay **pending** until a 4 GB device is available. Until then, the app has a **T1-simulation mode** used on the S23 to catch large regressions early; a 4 GB Android emulator covers functional (not performance) checks.

- T1-simulation forces the T1 profile on any device: T1 model (Qwen2.5-1.5B **Q4_0** preferred, Q4_K_M fallback), **2 unpinned threads** (pinning to big cores would hide T1 latency), n_ctx 2048, T1 character budget, AI summary on request. It is a developer setting (Bench tab, persisted in app.db since Phase 1c) and applies to Ask and the bench.
- Normal mode applies the detected tier: T2 uses Q4_0 on the performance cores (pinned), the T2 character budget and automatic AI summaries; T1 uses on-demand summaries; T0 loads no model.
- The bench JSON (schema 3) records `mode` (`normal` | `t1-simulation`), the backend and the applied profile, and per language Layer 1 latency, sources-visible latency, TTFT, tokens/s, reused prompt tokens and the tokenizer check.

**Context budgets** (`packages/core/src/budget.ts`) are set in **characters of source text per tier and question language** and converted to tokens with the active model's measured tokens-per-character (`packages/core/src/tokens.ts`, one profile per tokenizer; unknown models get a conservative fallback). The budget is clamped so that sources + system prompt + question + answer fit n_ctx.

| Tier | English | Greek | Max passages |
| --- | --- | --- | --- |
| T1 | 1,800 chars | 650 chars | 3 |
| T2 | 2,600 chars | 1,000 chars | 4 |
| T3 | 12,000 chars | 6,000 chars | 8 |

Chunks are ~600 characters (sentence-packed, never across sections). **Answer length is set in characters per language** (`ANSWER_MAX_CHARS`: English 408 = 3 × 136, Greek 172 = 2 × 86) and converted to a token limit with the active model's tokens per character plus the JSON overhead (Qwen2.5/Qwen3: 150 / 200 tokens); the JSON schema bounds each sentence's length (`maxLength`) so the object closes within the limit.

**T2 model (Phase 1c).** Qwen3-4B-Instruct-2507 (Apache-2.0 on the model card; Q4_0 quantised by us from the official weights) was evaluated and **not adopted**: English TTFT p95 15.3 s on the S23 (> 15 s), Greek 32 s. T2 keeps Qwen2.5-1.5B Q4_0. Qwen2.5-3B is excluded (Qwen Research licence). Numbers in `docs/phase-1c-report.md`.

**Model selection.** Default family: small Qwen models. The exact model is chosen by `/tools/rag-eval` (English set; the Greek set runs only with `--greek` and is not gated until after v1), not by reputation. rag-eval also reports **tokens per character** per language: a tokenizer that is efficient for a language directly cuts latency. A new model ships only if it does not regress citation precision or refusal-when-no-source.

**Model lifecycle**

1. **Load:** lazy, on the first AI request. Free RAM is checked first (`loadLlamaModelInfo` + `DeviceProfile`); if it does not fit, a smaller model is proposed.
2. **Run:** tokens stream to the UI with a stop button. The system prompt is short, fixed and always first; llama.rn keeps the KV cache of the previous request and reuses the longest common token prefix (verified in llama.rn 0.12.9 `rn-completion.cpp`), and the app prefills the system prompt right after loading (`LlamaEngine.prewarm`). Temperature 0.2, answer length in characters (above). The Ask screen shows the load progress (llama.rn `onProgress`).
3. **Unload:** after 2 minutes idle, when the app goes to background, or on memory warning (`onTrimMemory` / `didReceiveMemoryWarning`).

**Inference settings**

- Threads = performance cores, not all cores.
- mmap on, mlock off on mobile.
- Q4_0 quantization on mobile, the default since Phase 1b (22% faster prefill than Q4_K_M on the S23 in Phase 0).
- Metal on iOS. Android: CPU by default. GPU (OpenCL, Adreno) and NPU (Hexagon) backends sit behind a developer flag (Bench → backend) and a separate experiment build (`SKEPI_GPU_EXPERIMENT=1` at prebuild); results in `docs/phase-1b-report.md`. Never enabled by default.
- Desktop: automatic GPU offload, Vulkan on Windows, Metal on macOS.
- Structured outputs are constrained with GBNF grammar so JSON is always valid.

**Guards before every generate**

| Condition | Action |
| --- | --- |
| Thermal `serious` | Half the threads, half the token limit |
| Thermal `critical` | Refuse with a message; offer search instead |
| Battery < 20% and not charging | Confirm with the measured cost (% battery per answer) |
| Blackout mode on | AI off by default; opens per request |
| Free RAM < model size + 25% | Do not load; propose a smaller tier |

Cost per answer is measured on the device (battery delta and duration) and stored locally, so the estimate is real, not theoretical.

## Knowledge library (ZIM)

All knowledge lives in ZIM files read by libkiwix over libzim. Search uses the Xapian index already inside each file; no on-device indexing.

**Two-speed search**

- **Title suggestions** while typing (SuggestionSearcher, `suggestTitles` in core): packs in the language of the typed text first, every pack capped (8 of 20), packs queried in parallel natively (one thread per pack, up to 4). Target p95 < 50 ms.
- **Full-text** on Enter (Searcher + Xapian) across all open archives, filterable by pack and language. Target p95 < 300 ms on T1.
- The home search queries articles, emergency cards and map place names at once.

**Sealed article reading (native viewer in expo-zim)**

- The viewer loads only from a custom scheme (`zim://<archiveId>/<path>`), served by native handlers: `shouldInterceptRequest` on Android, `WKURLSchemeHandler` on iOS.
- Every http(s), file or intent request is blocked. External links are shown as text marked "external" and never open automatically.
- JavaScript is off by default. If a pack needs it (video, maths), it is enabled per pack with a warning.
- Every response, including 403/404, carries a CSP header: `default-src 'none'; img-src zim: data:; style-src zim: 'unsafe-inline'; font-src zim:; media-src zim:`.
- The viewer is `SealedWebView` (no Expo types, so it is testable alone): `loadUrl`, `loadData`, `loadDataWithBaseURL` and `postUrl` accept only valid `zim://` URLs, `addJavascriptInterface` throws, non-zim navigations are logged and reported as external links, Safe Browsing and file/content access are off.
- Blackout theme injects dark CSS with pure-black background for OLED.
- Because this is our own code (not a library), its guarantees are covered by instrumentation tests (`modules/expo-zim/android/src/androidTest`, `SealingTest`, on a 36 KB CC0 fixture ZIM): other schemes blocked and logged, JS disabled and no JS interface, CSP present on every response, path traversal (`zim://…/../`, percent-encoded, double-encoded and backslash variants) rejected, Safe Browsing and file/content access off.

**Sealed article reading on the desktop (Phase 3a).** Articles open in a separate `viewer` window loading `http://zim.localhost/<archiveId>/<path>` (WebView2's form of the `zim` scheme; `apps/desktop/src-tauri/src/protocols.rs` over `crates/desktop-core/src/viewer.rs`). The window has no IPC capability (the ACL denies every command), JavaScript is off (`disable_javascript`), it is incognito, navigation outside the zim origin is cancelled and reported to the main window as text, new windows and downloads are denied. Every response carries `default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox` (`'self'` is the zim origin) as a header and a meta tag; the protocol answers only the viewer webview; traversal is refused as on Android. Proven on the real build by `e2e/tauri-smoke.mjs` with the same CC0 sealing fixture as `SealingTest`.

**Text for RAG**

HTML is converted to text natively (jsoup on Android, SwiftSoup on iOS, scraper in Rust — `crates/desktop-core/src/text.rs` reproduces jsoup 1.23.2 `Element.text()` and Android's ICU `\s`, so desktop retrieval matches the phone 108/108), keeping section structure (`{ heading, level, text }[]`). Infoboxes, navboxes, references and "See also" are stripped. Results are kept in a small in-memory LRU cache.

**Files on disk**

- **Android:** packs live where no other app can write them. From Android 11 (API 30): app-specific external storage (`getExternalFilesDir`), no permissions. On Android 7–10 (API 24–29) other apps with the storage permission can write there, so packs live in internal storage (`files/content`); DownloadManager can only write to external storage, so a finished download is moved into internal storage before it is hashed, and packs of older versions move there at startup (then hashed). One rule in `ContentRules.contentRoot`, repeated in `expo-transfer` and `expo-zim`. SD card via the card's app-specific directory (`getExternalFilesDirs`), still a real path. Files from the Storage Access Framework are **copied** into the app, because opening a ZIM from an fd only breaks the Xapian index (libzim #852).
- **iOS:** Application Support with `isExcludedFromBackup`. Import via the Files app.
- **Desktop:** user-chosen folder, external drives supported (a USB stick becomes a portable library).

**First-release packs** (size shown in the catalog)

- English Wikipedia: small edition (top articles) and no-pictures edition. Default.
- WikiMed, Kiwix's medical encyclopedia. Default.
- Wikivoyage, for local information and travel.
- Locale packs: e.g. Greek Wikipedia (no-pictures and full). Frozen until after v1: offered only when the Greek UI developer flag is on.
- Our own "Survival" pack in ZIM format, from public-domain or openly licensed material (government manuals, civil-protection guides), built with zim-tools.

## RAG pipeline and grounding

Every answer comes in **two layers**, both built only from passages found on the device. All logic lives in `packages/core` and is identical on all platforms.

- **Layer 1 — extractive answer (instant, no LLM).** The best passages from the sources, with the sentences that match the question highlighted, each with its source id and section anchor (`buildLayer1`). Always correct, because it is verbatim source text — with two exceptions (post-preview hardening): URLs and e-mail addresses are replaced by "[link removed]" (`redactLinks`, the rule AI sentences follow), and on emergency intent every sentence records its phone numbers (`findPhoneNumbers`) so the apps can flag the ones that are not a bundled number of the user's country. Shown before any model work starts; primary answer on T1 and in blackout mode. Target < 1 s on T1.
- **Layer 2 — AI summary.** Streams below Layer 1 (`summarise`). Automatic on T2+, on demand ("Summarise with AI") on T1 and in T1-simulation. **Never on emergency or medical intent** (`summaryAllowed` / `summaryBlock`, every build; medical since 2026-10-21, with no opt-in): no summary and no button, only the number, the cards and Layer 1, plus a one-line note.

**Pipeline** (`retrieve` = steps 1–6 and Layer 1; `summarise` = steps 7–9)

1. **Language:** detected deterministically from the script (no model).
2. **Emergency and medical intercept:** fixed lexicons per language (English, Greek). An emergency match shows the emergency number and the card slot immediately; a medical match (doses, drugs, symptoms, diseases, treatment) shows the number, the matching cards and Layer 1, and no AI summary ("AI summaries are not available for medical questions.").
3. **Query rewrite (T2+ only, later phase):** the LLM with GBNF outputs `{ queries: { lang: string, terms: string[] }[], intent }`. Today every tier uses the question without stopwords.
4. **Retrieval:** in each open pack, Xapian full-text with the conjunctive query plus single-keyword queries (always, not only when the conjunctive query is short) and title suggestions for all keywords and adjacent keyword pairs; all lists merged with reciprocal rank fusion over the **rank inside each archive** (never the position in an engine's concatenated multi-archive list; Phase 1c parity fix), packs in another language than the question offset by one full list, deterministic tie-breaks; top 8 articles. Folding maps the Greek final ς to σ for matching; queries restore ς because the ZIM index keeps it (Phase 1b fix: Greek single-word questions found nothing).
5. **Passage selection:** sections are first cleaned of injected text (`sanitizeSourceText`: the Phase 1d **structural filter** — forged `<source>` blocks/tags, chat-template markup, JSON objects with role/system/assistant keys, role-prefixed lines, sentences addressed to the model/assistant/AI/summariser, each with the rest of its paragraph — plus the Phase 1b lexicon, and (Developer Preview) `<!-- … -->` spans written as text; (post-preview hardening) every check looks at a normalised copy of the text (`normalize.ts`: NFKC, format characters dropped, look-alike letters folded), and quoted or reported instructions addressed to a model count like direct ones; section text keeps one line per block element so paragraphs bound the removal; every `|` is a unit boundary and text between two `|` is a table cell, kept apart through sanitizing, chunking and validation and never highlighted alone in Layer 1), then cut into ~600-character chunks and ranked with BM25 plus a title bonus (the share of the article title's terms that the question contains), which keeps "What is DNA?" on the DNA article when every candidate mentions DNA. On T2+, optional rerank with a small multilingual embedding model (later).
6. **Context budget, in characters** per tier and language, converted with the active model's tokens-per-character (table above). Every passage must pass the no-source bar and contain the question's numbers; when the question names an article (full title match), passages come from that article. Otherwise preference for diversity across articles. Articles are ordered by their best passage; **passages of one article keep reading order** (lead first) — rag-eval coverage en 60 → 72%, el 40 → 47% (Phase 1c).
7. **No source:** if the best chunk covers < 60% of the query terms or scores < 0.5, show "No relevant source found". No Layer 1 passages, no generation. Calibrated with rag-eval.
8. **Prompt and output format:** a short fixed system prompt (`rag-v5-json-short`, KV-cache prefix; asks for `covered: false` on personal and future questions), passages wrapped in `<source id="S1" title="…">…</source>` with tag characters neutralised, then a one-line language instruction and the question. The model must answer in grammar-constrained JSON `{covered, sentences[1..n]{text ≤ maxLength, source ∈ ids}}`. Source text is data, not instructions.
9. **Post-validation (per sentence, as soon as each sentence object is complete while streaming):**
   - Citation ids that do not exist are dropped.
   - Numbers with a unit (mg, ml, °C, minutes, hours, tablets, %, kg… in English and Greek) must appear verbatim (same number, same unit) in the cited source; bare numbers must appear as whole numbers. Otherwise the sentence is **removed**.
   - Relevance: the sentence must share at least one content term with the question.
   - Support: content **bigrams** of the sentence must be found as term pairs within one source sentence (title terms pair with everything), at a calibrated threshold (`MIN_BIGRAM_SUPPORT`), and the sentence's terms must form one connected graph over those pairs (coherence: no stitching of facts from different sentences).
   - An answer left with no supported sentence is hidden; Layer 1 stays.
10. **Display:** every AI answer carries the fixed label "AI summary — check the source" (EU AI Act Art. 50: AI-generated text is visibly marked). Any text the user shares or copies out of the app that contains an AI summary (the problem report: share sheet, copy, save) carries the plain line "AI-generated summary" before it (`AI_GENERATED_MARKER`, `problemReportText`). Each sentence carries a tappable `[S1]` chip that opens the article at the section. If source and answer languages differ, the chip says so and offers the original text (later).

**Medical intent:** the emergency number, the matching cards (intercept topics + card keywords) and Layer 1 are shown, in that order (Phase 1d), with the note "AI summaries are not available for medical questions." There is no AI summary and no button (decision 2026-10-21, replacing the tap-to-show unverified summary): `summaryAllowed` is false, `summarise` refuses, `runRag` returns Layer 1; bench, rag-eval and the held-out runner follow the same gate.

**Emergency intent** (`detectEmergency`, any topic): the number, the cards and Layer 1 only. `summaryAllowed` is false, `summarise` refuses, `runRag` returns Layer 1, and the Ask screens show "No AI summary in an emergency" with no summary button (decision 2026-10-10, Developer Preview, all builds — the rule below, not a filter for particular wording). Bench, rag-eval and the on-device held-out runner apply the same rule; rag-eval summary coverage counts only the answer items that may have a summary. A Layer 1 sentence with a phone number that is not a bundled number of the user's country carries a visible flag: "Number from a source — use the emergency number shown above" (post-preview hardening); the bundled numbers stay first.

**Why not a vector index of all of Wikipedia:** embeddings for millions of chunks would take many GB and hours on a phone. Xapian is already in the ZIM and covers recall. Embeddings are only for reranking a few dozen chunks. Small curated packs (Survival, WikiMed) may ship precomputed embeddings later.

**Prompt injection:** the model has no tools that act, so a malicious article can at most affect the text of one answer, which the user can see through the citation. That is why "answers only with sources" is also a security measure.

## Offline maps

Maps are vector tiles in one PMTiles file per country (or per part of a large country), rendered by MapLibre directly from disk, with no tile server or network request; every installed country is on the map at once (global maps, below). MapLibre Native supports local `pmtiles://file://` on Android from 11.7.0 and on iOS from 6.10.0; maplibre-react-native currently wraps Android 13.2.0 / iOS 6.26.0. Validated offline on Android in Phase 0 (render 327 ms with Greek labels); iOS still needs one test with a local file on a real iPhone.

| Component | Implementation |
| --- | --- |
| Map data | Protomaps basemap (OpenStreetMap), cut per country with `pmtiles extract` from a pinned daily build over the country's Natural Earth region (`pmtiles-extract` source; daily builds expire, so the extract is kept and mirrored by the project). First pack: Greece (`map-gr`, build 20261005, Geofabrik boundary, z0–15, 507 MB); from global maps every country (`map-<iso2>` or `map-<iso2>-<part>`, build 20261022). Only verified packs render. |
| Style, fonts, sprites | Bundled. Fonts cover Latin, Greek and the scripts of shipped locales. Style rewritten at runtime with absolute file paths. |
| Place search | SQLite FTS5 per country (`places-gr`: 37k places, 5.3 MB; `places-<iso2>`) from a dated Geofabrik extract (`osm-places` source: optional `osmium tags-filter` (CI) → pyosmium → objects inside the country's region only (shapely, `boundary`) → `@skepi/core` `classifyOsm` → folded names of name, name:en, name:<locale>, plus an English kind word), opened read-only. Home search queries articles, cards and the places of every installed country together (ranked together; an object in two packs — border strips — once); results show the English name with the local name. |
| Emergency POIs | Hospitals, pharmacies, fire stations, police, drinking water, shelters (incl. emergency assembly points and mountain huts) from the places packs of every installed country, as a GeoJSON layer with per-category filters (zoom ≥ 10, visible area only; feature id = index in the merged list). ODbL attribution in the pack and on the map. |
| User position | Live on the map (decision 2026-10-21): the GNSS fixes of `expo-emergency-tools` (`startLocationUpdates`, GPS provider on Android, CoreLocation on iOS; no new dependency, no Play Services or fused provider) and its compass. The map draws a puck, the accuracy circle and a heading cone from the compass (rotation vector, or accelerometer + magnetometer; exponential smoothing across the 0/360 wrap, magnetic north, no declination), or the course over ground when the compass is unavailable and the user moves faster than walking (> 2.5 m/s). "My location": the first press centres, the next press toggles follow mode; panning the map leaves it. No fix yet: "Waiting for GPS…" with the satellites in use and the note that the first fix can take minutes offline; a fix older than 15 s (45 s in blackout mode) turns the puck grey ("Last known position"). The coordinates panel (decimal + DMS, heading) stays under the map. Logic in `packages/core/src/location.ts` (unit-tested); desktop: hidden (no GNSS). Tools keeps the one-shot fix for copying or sending by SMS. |
| User places | Meeting points, water sources and notes in SQLite. Export to GeoJSON and share via P2P. |
| Desktop | MapLibre GL JS in the webview; pmtiles JS reads through a custom Tauri protocol serving range requests from disk. |

**Permissions and energy:** location "while in use" only, never background; the permission is asked only when the user presses "My location" (iOS: "while in use" from CoreLocation). GPS and compass run only while the map tab is focused and the app is in the foreground (the module also stops them on background): fixes every 1 s and compass readings at most every 200 ms; in blackout mode every 15 s and 1 s (decision 2026-10-21, replacing "update on tap"). The position is never stored, logged, shared or sent over P2P: it lives only in the map screen's memory; the release permission allowlist is unchanged (no new permission). Measured unplugged on the S23 (2026-10-21, `e2e/run-map-energy.ps1`: wireless adb, 15 min per window, screen on at brightness 100/255, airplane mode with Wi-Fi kept for adb, GNSS fix held; data in [`energy/map-2026-10-21/`](energy/map-2026-10-21/)):

| Map tab in front | Mean discharge current | Charge counter |
| --- | --- | --- |
| No location (permission denied) | 175 mA | 203 mAh/h |
| Follow mode (fixes every 1 s, compass ≤ 5/s) | 292 mA | 333 mAh/h |
| Blackout mode, no location | 166 mA | 174 mAh/h |
| Blackout mode, follow (fixes every 15 s, compass ≤ 1/s) | 201 mA | 217 mAh/h |

GNSS + compass cost: **+117 mA (+131 mAh/h, ≈ 3% of the 3,900 mAh battery per hour)** at the normal rate, **+35 mA (+44 mAh/h)** in blackout mode. The compass starts only once location updates run (no heading without a position).

**Global maps (owner decision 2026-10-23).** The user picks a country, downloads its map and places
packs, and uses them offline; any number of countries can be installed.

- **Regions.** One `catalog/regions/<iso2>.geojson` per country, generated by
  `tools/catalog-builder/regions/make_regions.py` from Natural Earth v5.1.2 admin-0 (public domain,
  pinned by SHA-256): units grouped by `ISO_A2_EH`; the few units without an ISO code are covered by
  listed regions (Northern Cyprus, the UN buffer zone and the UK bases → CY, Somaliland → SO, …;
  geographic coverage for people on the ground, not a position on sovereignty); 0.05° buffer (coasts and
  a border strip in both neighbours' packs), simplified, snapped to 1e-4°. `index.json` carries the name,
  the bounding box (west > east across the antimeridian: United States, Russia, Fiji) and the Natural
  Earth label point. 239 regions.
- **Split rule (measured, build 20261022).** At z15 the 239 countries total 142.7 GB; 17 exceed 1.9 GB
  (US 17.0, CA 16.0, RU 13.0, FR 5.6, DE 5.5, CN 5.2, BR 4.3, IN 3.2, NO 3.0, PL 3.0, IT 2.7, GB 2.6,
  JP 2.6, SE 2.4, ES 2.3, AU 2.1, UA 2.0 GB); z14 is ≈ 48% of z15. Rule: a country ≤ 1.5 GB at z15 is one
  pack; a larger one is split into **parts** of neighbouring admin-1 subdivisions (Natural Earth regions
  when each fits, e.g. Italy's 20) by recursive bisection along the longer axis until every part measures
  ≤ 1.5 GB at z15 (dry run of the part's own polygon); a subdivision that alone exceeds 1.5 GB is a part at
  the highest zoom that fits. 1.5 GB keeps ~25% headroom under GitHub's 2 GB release-asset limit, and
  every part keeps z15 detail. Places packs stay one per country (the United States: one).
- **Pipeline.** `catalog/regions/sources.json` pins the inputs (Protomaps build 20261022 with its MD5,
  Geofabrik extracts of 2026-10-22 with the publisher's MD5, the mirror release `packs-20261022`, the
  Geofabrik path and `name:<locale>` per country); `catalog countries` generates the manifest
  (`catalog/countries.json`: `map-<iso2>[-<part>]`, `places-<iso2>`, region metadata, ODbL licence,
  OpenStreetMap / Protomaps / Natural Earth attribution). `.github/workflows/packs.yml` builds one pack
  per job (no secrets, no signing; hash-pinned pyosmium/shapely wheels, pinned go-pmtiles) and writes a
  report per pack (file, size, SHA-256, chunk hashes, licence, attribution, inputs, tool versions, wall
  time, peak memory, disk). The maintainer measures the packs again (`prepare --reports`: refused unless
  they equal the CI reports) and signs offline (`tools/catalog-builder/README.md`). Inputs expire within
  about two weeks; the built packs are the copy.
- **Catalog schema 2.** Map and places packs carry `region` `{ iso2, name, bbox, center, part? }`
  (`packages/core/src/catalog.ts`, the Rust port in `crates/desktop-core/src/catalog.rs`, both strict);
  a part is `{ id, name, regions, bbox }`: its full name (every subdivision or region it covers), the
  English and local names of its Natural Earth admin-1 units (for search: "Bayern", "Tokyo") and its own
  box. An app before schema 2 rejects such a catalog as a whole and keeps its own, so a country pack never
  reaches an app that renders only one map; schema 1 catalogs stay valid (Greece from the `region:GR`
  tag, `LEGACY_REGIONS`).
- **How installed apps get catalogs (checked 2026-10-24).** Release builds up to v0.1.2-preview have
  no catalog update source: `catalog/sources/` holds only `debug.json` (the local test mirror), the
  Android release variant and the iOS bundle copy no `sources.json`, and the desktop release build has
  `SOURCES = None`. They never fetch a catalog over the network; they use the embedded one (sequence 3,
  schema 1: Greece, Wikipedia, models) and a newer one only from a P2P host, where a schema 2 catalog
  is rejected whole. So no separate update path is needed for them, and a schema 2 catalog reaches
  users only embedded in an app release that reads it (or over P2P from such an app).
- **Packs → "Maps & places"** (mobile `app/maps.tsx`, desktop `screens/Maps.tsx`, logic in
  `packages/core/src/regions.ts`): countries of the signed catalog, searchable by name or ISO code, with
  their size and state (not installed, partly installed, installed, update available = an installed pack
  id with other bytes in the catalog). A split country lists its parts (full name, size, state) with
  "Download all parts" and one "Download part" / "Delete part" per part; a subdivision in the search
  ("Bayern") finds the country and marks its part ("Includes Bayern", `matchingParts`). The country's
  places pack comes with the first part and goes with the last (`partRemovalIds`); map, places search and
  emergency points work with any subset of parts. Download (only on the user's press), with ContentStore's free-space rule (size + 10% +
  1 GB, for the whole country) and, on T0/T1, a warning before ≥ 1 GB or when less than 4 GB would stay
  free (`checkStorage`); every pack is hashed against the signed catalog before it is installed. Update
  downloads beside the old file, which is deleted after the swap. Delete removes all packs of the
  country. "Use for emergency numbers" makes it the chosen country. The generic Library list no longer
  shows country packs.
- **One map, all countries.** `multiSourceStyle` (core) gives every verified map pack its own vector
  source and repeats each layer of the bundled style per pack in style order (all water under all roads
  under all labels); with one pack the style is the bundled one. The map opens on the chosen country
  (or the first installed), whole (`mapHome`, `fitZoom`), or on its installed parts only (the union of
  their boxes; a part across the antimeridian opens the whole country); Greece from a schema 1 catalog
  on Patras as before.
- **Emergency number of the position.** On the map, a live fix is checked (every km or minute) against
  the installed countries: bounding boxes filter, the nearest settlement of each candidate's places
  pack within 50 km decides (`countryAt`, `nearestSettlementKm`); the numbers follow that country while
  it is known (memory only, never stored or sent), else the chosen country. Countries without a dataset
  entry keep the 112 default with its "check the local number" note.
- **Migration.** Installed `map-gr` / `places-gr` keep their ids: the new catalog's Greece packs are
  updates of them; nothing in app.db changes.
- **P2P.** Country packs are ordinary catalog packs: a receiver adopts the host's newer schema 2
  catalog and takes them as verified; without a catalog that knows them they are refused.

**Out of scope:** turn-by-turn navigation (Organic Maps and CoMaps already do it well).

## Content pipeline

Every file the app opens (ZIM, GGUF, PMTiles, places DB) corresponds to an entry in a signed catalog with SHA-256, whether it came from a mirror, another phone or USB.

**Catalog**

```json
{
  "schema": 1,
  "sequence": 42,
  "issuedAt": "2026-10-01T00:00:00Z",
  "keyId": "cat-2026a",
  "packs": [
    {
      "id": "wikipedia_en_top_nopic",
      "kind": "zim",
      "version": "2026-09",
      "title": { "en": "Wikipedia top articles (no images)", "el": "Wikipedia κορυφαία άρθρα (χωρίς εικόνες)" },
      "lang": ["en"],
      "sizeBytes": 0,
      "sha256": "…",
      "chunkSize": 67108864,
      "chunkSha256": ["…"],
      "urls": ["https://download.kiwix.org/zim/…", "https://mirror.example/…"],
      "license": "CC-BY-SA-4.0",
      "attribution": "Wikipedia contributors",
      "minTier": "T0",
      "tags": ["encyclopedia"]
    }
  ]
}
```

- Ed25519 signature in a separate `catalog.json.sig` (base64 of the 64-byte signature), over the exact bytes (not re-serialised JSON); `@noble/ed25519` 3.2 in `packages/core/src/catalog.ts` (`verifyCatalog`, `verifyKeyList`). Each pack also names its `file` on disk.
- Two public keys pinned in the app: one active, one offline backup. A new key is accepted only via a key list signed by the old key.
- `sequence` always increases. The app rejects a catalog with a lower `sequence` than the one it holds (anti-rollback). No reliance on wall-clock time offline.
- The build ships an embedded catalog, so a phone that never touched the internet can verify packs received via P2P.
- Hashes are computed by `/tools/catalog-builder` after downloading from the official source. The private signing key never enters CI.
- Hosting: our own domain CNAME'd to GitHub Pages, with a raw GitHub fallback in the app (later phase; Phase 1c ships the embedded catalog and a catalog-update path tested against the local mirror; release builds have no update URL yet, see "How installed apps get catalogs"). Map and places packs are built by the catalog-builder (country packs: one CI job each, `.github/workflows/packs.yml`) and mirrored as GitHub release assets (`packs-2026-10`; country packs `packs-20261022`, not uploaded yet).
- Pack generations (decision 2026-10-24): one GitHub release per generation, `packs-<Protomaps build>` (`packs-20261022`). A refresh uploads the new generation, then the new signed catalog is published (embedded in an app release; at the update URL once one exists), and only then old assets are deleted. Kept at any time (decision 2026-10-24, refined the same day): the newest generation in full; from older generations only the individual assets that the embedded catalogs of the last two app releases reference by URL (today the Greece map and places pack of `packs-2026-10`, embedded in v0.1.1-preview and v0.1.2-preview); every other asset of an old generation is deleted, and an old release is deleted once none of its assets is referenced. Worst-case total: ≈ 148 GB (newest, all countries) + the referenced older assets, at most two further full generations if both releases embed a different full one, ≈ 444 GB; today the newest generation + 512.5 MB. Sizes per release: `packs-2026-10` 2 assets, 512.5 MB (Greece map 507.2 MB, places 5.3 MB); pilot `packs-20261022` 39 assets (31 map packs + 8 places packs), 31.96 GB; a full generation ≈ 550 assets (≈ 310 map packs + 239 places packs), ≈ 148 GB. GitHub limits: each asset < 2 GiB (packs ≤ 1.5 GB by the split rule), ≤ 1000 assets per release; GitHub states no limit on a release's total size or bandwidth. Steps (dry run, then apply): `tools/catalog-builder/README.md` → "Retire old generations". An app release older than the last two keeps its embedded catalog (no update URL), so once its assets are deleted its downloads fail; P2P from a phone with the packs still works.
- Schema 2 (global maps, 2026-10-23): map and places packs may carry `"region": { "iso2": "CY", "name": "Cyprus", "bbox": [32.2225, 34.5224, 34.642, 35.7405], "center": [33.0842, 34.9133] }` (and `"part": { "id": "bavaria", "name": "Bavaria, Thuringia", "regions": ["Thuringia", "Bavaria", "Thüringen", "Bayern"], "bbox": [8.9301, 47.2246, 13.8665, 51.6874] }` for a part of a split country); the builder writes schema 2 only when a pack has a region.
- Embedded per build type: debug = test catalog + test keys (`catalog/embedded/debug`, `catalog/keys/test.json`); release = real-key catalog + release keys. A release build fails unless the embedded catalog verifies with the release keys (`skepiCheckReleaseCatalog`).
- The newest accepted catalog is kept in internal storage and re-verified on every start; the highest accepted `sequence` lives in app.db.

**Downloads**

- **Android:** system `DownloadManager` (resumes after interruption and reboot, honours Wi-Fi-only; avoids dataSync foreground-service limits). It applies the app's network security config (HTTPS only, system CAs; debug builds also trust the local test mirror CA for `127.0.0.1`), and the request carries `User-Agent: SKEPI` (its default names the device model). Active downloads are recorded in app.db and resumed after an app restart.
- **iOS:** background `URLSession`.
- **Desktop:** Rust downloader (`crates/desktop-core/src/download.rs`, reqwest + rustls, Windows certificate store): `tmp/<file>.partial` with HTTP Range resume from the verified chunk prefix, every 64 MiB chunk checked against the catalog as it arrives (a bad chunk ends that mirror), whole-file hash, atomic rename; downloads are requested by pack id and Rust re-verifies the signed catalog itself.
- Wi-Fi only by default; on metered networks show size and ask.
- Free-space check: size + 10% + 1 GB always kept free for the OS.

**Atomic install**

1. Download to `<id>.partial`.
2. Streaming SHA-256 on a native thread, with progress.
3. On match: rename and register in SQLite in one transaction.
4. On mismatch: delete and try the next mirror. No unverified file is ever opened by libzim or llama.cpp.
5. Updates download beside the old version; the old one is deleted only after the swap. If space is short, the user explicitly chooses "delete the old one first".

**File import:** files from USB, Kiwix or Files are copied into app storage, hashed and looked up in the catalog. Match = "verified". Otherwise "unverified": opens only by explicit choice, with a permanent label ("Unverified content — not in the signed catalog" in search, article and Ask sources) and JavaScript always off. Unverified GGUF files are not accepted on mobile in v1 (import rejected; provisioned ones are never loaded; app.db forbids unverified non-ZIM packs).

**Startup:** registered packs get a quick check (exists, size, file stamp: size, device and inode or volume and file id, modification and change time, recorded when the file was installed or last hashed); any difference means a full hash, so a same-size replacement loses the verified state (and an unverified ZIM its consent) unless the bytes still match the catalog; files the database does not know (e.g. pushed by `scripts/provision.ps1`, which stays a dev tool) are hashed once and registered as verified when the catalog knows them, as unverified ZIM otherwise; stale `tmp/*.partial` files are removed.

## P2P content sharing

A phone with content becomes a distribution station over local Wi-Fi, without internet. The receiver trusts files only through the signed catalog's hashes, never through the sender.

**Network**

| Scenario | How |
| --- | --- |
| A router is on, no internet | Shared LAN; the host listens on its local IP |
| No router, Android host | `LocalOnlyHotspot` (SSID + password, no internet) |
| No router, iPhone host | iOS cannot open a hotspot from an app; the iPhone joins as receiver (`NEHotspotConfiguration` with the QR credentials) |
| Desktop as "Station" | LAN server serving many phones at once, like NOMAD's role |

Bluetooth is too slow for GB. Wi-Fi Direct and Multipeer were rejected because they only work between devices of the same platform.

**QR pairing:** the host shows `{ v, ssid?, psk?, host, port, token, certSha256 }`.

- `token`: 128-bit, valid for this session only; expires at the end or after 30 minutes idle.
- TLS 1.3 with a per-session self-signed certificate, pinned by `certSha256` from the QR (no MITM on the LAN).
- The QR is read only up close; physical proximity is the trust channel.

**Protocol (HTTPS, read-only)**

- `GET /manifest`: host packs (id, version, sha256) and its signed catalog.
- `GET /pack/:id`: with HTTP Range for resume.
- `GET /app.apk`: Android hosts only.
- The host serves only the packs it selected; never conversations, notes or settings.

**Receiver verification**

1. A host catalog with a valid signature and higher `sequence` is accepted, so catalogs also propagate phone to phone.
2. Each 64 MB chunk is checked against `chunkSha256` on arrival; a bad chunk is re-requested alone.
3. Same atomic install as internet downloads.
4. Packs not in any valid catalog are shown as "unverified" and never auto-selected.

**Desktop Station mode (Phase 3a, Windows).** `crates/desktop-core/src/station`: the same protocol and rules as `modules/expo-transfer` (QR `{ v, host, port, token, certSha256 }`, per-session EC P-256 certificate from rcgen pinned by `certSha256`, 128-bit token, TLS 1.3 only via rustls, `GET /manifest` and `GET /pack/:id` with Range, the host's signed catalog in the manifest for propagation), for up to 32 concurrent connections (many phones). The UI builds the manifest with `@skepi/core` `buildManifest`; Rust checks it against app.db and the accepted catalog and maps the selected pack ids to files itself. It binds only the chosen local IPv4 address, stops on demand or after 30 minutes idle, and can serve a user-chosen release APK on a cleartext install page (`/`, `/skepi.apk`) showing its signing-certificate SHA-256 against the published release key. Windows Firewall asks the first time; the Station screen explains to allow private networks only.

**App propagation (Android only):** the host serves its own APK with the signing-certificate fingerprint; a phone without the app opens `http://<host>:<port>/` in any browser. iOS does not allow sideloading.

**Implementation (Phase 2a, Android).**

- `packages/core/src/transfer.ts` (unit-tested, no sockets): QR payload (`parsePairing` refuses non-local addresses, tokens other than 128-bit hex, pins other than SHA-256), manifest (exactly the selected packs; never unverified non-ZIM files), host-catalog decision (`evaluateHostCatalog`: adopt only with a valid signature and a higher sequence), offer classification (`classifyOffers`: the receiver's catalog decides; host claims are never trusted), the chunk loop (`receiveChunks`: up to 3 attempts per chunk, `tampered` / `interrupted` outcomes) and the resume point (`verifiedPrefix` of the partial file's chunk hashes).
- `modules/expo-transfer` (Kotlin): `SessionCert` (fresh EC P-256 key, minimal DER self-signed certificate per session), `TransferServer` (TLS 1.3 only, token, `GET /manifest`, `GET /pack/<id>` with Range, 4 connections, 30 s timeouts, 30 min idle stop), `TransferClient` (pinning trust manager, local addresses only, chunk written at its offset and hashed while writing), `LocalNetwork` (LAN address, LocalOnlyHotspot, WifiNetworkSpecifier join, socket factory of the matching network), `ApkServer` (cleartext `/` and `/skepi.apk` only), `Qr` + `QrScannerView` (ZXing core, CameraX). Debug builds only: corrupt/drop/tamper faults and the pairing file for the two-emulator E2E.
- App: Library → "Share packs nearby" / "Receive packs nearby". Partial files live in `tmp/<file>.p2p.partial` and survive restarts for resuming; installs go through ContentStore (`installReceived`: whole-file hash, atomic rename, `packs.source = 'p2p'`, migration 3).
- Permissions: INTERNET, ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE (LAN); CHANGE_WIFI_STATE plus NEARBY_WIFI_DEVICES (`neverForLocation`, Android 13+) or ACCESS_FINE_LOCATION (Android 8–12) for LocalOnlyHotspot; CHANGE_NETWORK_STATE for WifiNetworkSpecifier (Android 10+; older receivers join the hotspot in Wi-Fi settings); CAMERA for the QR code only, asked on the Receive screen. No REQUEST_INSTALL_PACKAGES, no foreground service (the Share/Receive screens keep the screen awake).

## Developer Preview (v0.1.0-preview)

- **Build mode.** `SKEPI_PREVIEW=1` (Android also `-PskepiPreview=true`, which fails fast without the
  variable) makes Metro (`apps/mobile/metro.config.js`) and Vite (`apps/desktop/vite.config.ts`) resolve
  `@skepi/emergency-cards` to `src/preview.ts`: the same cards, plus a permanent "Developer preview — not
  for emergency use" label on home and About (`PREVIEW_BUILD`). Until 2026-10-21 preview builds shipped
  the cards without steps ("Under professional review"); since the IFRC decision every build mode ships
  the sourced steps (User safety). Every release build scans its bundle (`tools/release-guards`
  `cards-bundle`, UTF-8, UTF-16LE and `\uXXXX` escapes): no unsourced card text (the 199 former step
  texts, `tools/release-guards/data/unsourced-card-texts.json`; 3 former texts that are verbatim Ready.gov
  sentences left the list when those cards were sourced), every sourced step present (111/111 of 12 cards; a step
  too short for a probe, such as "Access EMS.", must be a whole entry of the Hermes string table or a
  whole JavaScript string literal, never a piece of a longer string), and sourced steps only with a
  source-check lock that matches them. Android checks in Gradle right after the JS
  bundle (`skepiCheckCardsBundle`), iOS in a build phase, the desktop in CI.
- **About.** Licence, content/data/model licences, release signing fingerprint
  (`ANDROID_RELEASE_SIGNING_SHA256` in `@skepi/core`, equal to the Station check in Rust), privacy, and
  third-party notices generated by `tools/notices` into `apps/*/src/generated/third-party-notices.json`:
  the app's run-time JavaScript dependency tree (resolved like Node; workspace packages and
  platform-specific binaries excluded), the Rust crates the Windows app links, the Android release
  runtime classpath with POM licences (`gradlew :app:skepiAndroidDependencies`), and native libraries
  and assets not visible in package metadata (`tools/notices/src/native.ts`), and bundled content
  under its own terms with its notice text (the IFRC attribution and licence statement; the CDC and
  FEMA Ready.gov sources with their terms and no-endorsement statements). CI checks the JavaScript and Rust parts are current.
- **Problem reports.** `problemReportText` (`@skepi/core`): question, shown Layer 1 excerpts and AI
  sentences (after the plain line "AI-generated summary" when there are any), cited sources, app
  version — nothing else. Copy, or save (Android: `reports/` in the app
  folder; Windows: native save dialog through the narrow `report_save` command, `.txt`, ≤ 256 KiB). No
  network call.
- **Post-preview hardening (generic Layer 1 rules, Unreleased; `docs/hardening-report.md`) — done.**
  The "planned before v1" backlog left by held-out set 3 (decision 2026-10-10), implemented as generic
  rules with fresh unit examples, no phrase lists, no held-out item used for tuning, and checked with the
  fresh held-out set 4 (decision 2026-10-11, accepted): 0 AI findings on eval, desktop and the S23; 3 Layer 1
  findings accepted as the known Layer 1 limitation (`docs/threat-model.md`); the phone flags and the
  over-removal checks pass on every pipeline. Rules:
  1. **Unicode normalisation before every structural check** (`packages/core/src/normalize.ts`): NFKC
     per code point, format characters (zero-width, bidirectional controls, soft hyphen) dropped, and
     confusable folding after Unicode TR39 — a word mixing Latin, Greek and Cyrillic letters is folded to
     one script, a word made only of Cyrillic or Greek look-alikes is folded to Latin inside Latin text.
     Two detection forms (Latin for English and markup checks, Greek for Greek checks) keep a map back
     to the source, so a span found in normalised text is cut from the source; displayed text is the
     source's own.
  2. **No addresses in Layer 1**: URLs and e-mail addresses in shown excerpts become "[link removed]"
     (`redactLinks`, the same shapes as the AI-sentence rule `containsLink`, also on the normalised text).
  3. **Quoted instructions**: quoted or reported segments (paired or unclosed quotes, text after a colon)
     go through the same addressed-to-model patterns as whole sentences; inside a quotation, an active
     directive whose subject is an AI noun phrase ("any AI tool must …") is an instruction, a passive or
     copular one ("AI systems must be transparent") is not. An AI noun phrase taking in "this" text
     ("an AI … reading this …") is addressed to the model, quoted or not.
  4. **Phone numbers on emergency intent**: Layer 1 records each sentence's phone numbers (dialling shapes
     and digits after a calling verb; dates, year ranges, thousands and decimals excluded); the Ask screens
     flag a sentence whose number is not a bundled number of the user's country.
- **AI gates include the device pipeline.** The AI layer can differ between runtimes: on held-out set 3
  the same model and prompt declared a passage covered on the phone (llama.rn, Q4_0, CPU) and not
  covered in the eval and desktop runs (node-llama-cpp / llama.cpp), so only the phone showed an
  injected sentence. Held-out sets and AI gates therefore run on eval, desktop **and** the device
  pipeline (`e2e/run-heldout.ps1`); eval alone is not enough.
- **Held-out sets on the phone.** Bench → "Run held-out set" (`apps/mobile/src/lib/heldout.ts`) runs the
  Ask pipeline with the phone's profile and model over the packs plus the set's archive;
  `e2e/run-heldout.ps1` drives it and `tools/rag-eval/src/heldoutDevice.ts` judges it like the eval runs.

## Security

The biggest risk is a malicious file (ZIM, GGUF, PMTiles) reaching a C++ parser. The central defence: nothing opens without a signed hash. The threat model lives in `/docs/threat-model.md` and is updated with every feature.

**What we protect:** device integrity, content integrity (a wrong medical instruction = physical harm), and user data (questions, notes, map places).

| Threat | Mitigation |
| --- | --- |
| Malicious ZIM, GGUF or PMTiles (parser exploit) | Opens only if the hash matches the signed catalog. Unverified files only by explicit choice (GGUF never on mobile). llama.cpp and libzim pinned and updated via Renovate; first fuzzing targets. |
| Tampered content via mirror, MITM or P2P | Ed25519 catalog with pinned keys, SHA-256 per file and chunk, `sequence` anti-rollback |
| Theft of the catalog signing key | Key kept offline (hardware key or offline machine), never in CI; backup key and rotation procedure |
| XSS or data leak from article HTML | Native viewer: `zim://` only, JS off, strict CSP, no JS bridge, no file:// or network; covered by instrumentation tests |
| Prompt injection via articles | No LLM tools; the structural filter (forged source markup, chat markup, JSON role objects, role prefixes, sentences addressed to the model, quoted instructions to a model) and the injection lexicon, run on Unicode-normalised text, remove text before chunking, so neither Layer 1 nor the model sees it; Layer 1 shows no addresses and flags source phone numbers on emergency intent; answers always with checked citations; emergency cards never pass through the LLM |
| Attacker on the local network during P2P | Session token, TLS pinned from the QR, read-only server for selected packs, auto-close |
| Physical access or device seizure | SQLite encrypted with SQLCipher (key in Keystore/Keychain); optional biometric lock; one-tap "clear history" |
| Network leaks to third parties | Network only via `ContentStore` to catalog hosts; no analytics SDK, no Google Play Services for location; a test asserts zero egress |
| Supply chain | Lockfiles, pinned hashes for native artifacts, source builds for releases; GitHub artifact attestations and published SHA-256 |
| Forged APK in circulation | Release keystore outside the repo; signing fingerprint published in README and site; Android rejects updates with a different signature |

**Code rules**

- Every native call is bounds-checked (path traversal in `zim://`, max response size, timeouts).
- Android components `exported=false` except the launcher; network security config without cleartext, except the local APK server.
- Tauri with narrow capabilities: only needed commands, no shell, fs scope limited to the content folder.
- `SECURITY.md` describes private vulnerability reporting via GitHub private advisories.
- **Release signing:** the Expo `debug.keystore` used in Phase 0 is for development only. Release builds use a dedicated keystore kept outside the repo, generated once by the maintainer with `keytool`, backed up with its password in a password manager. Its path and alias are Gradle properties in `~/.gradle/gradle.properties` (`SKEPI_RELEASE_STORE_FILE`, `SKEPI_RELEASE_KEY_ALIAS`); the passwords are never stored: `tools/Signing.psm1` (`Use-SigningSecrets`, owner-only, interactive) prompts for them and exposes them as process env vars (`SKEPI_RELEASE_STORE_PASSWORD`, `SKEPI_RELEASE_KEY_PASSWORD`) for one run of `scripts/release/sign-release-apk.ps1` (or a `--no-daemon` Gradle release). Wired by the config plugin `apps/mobile/plugins/withReleaseSigning.js` (never by editing generated Gradle files), which reads the passwords only from the environment. A release build without these settings **fails**; the escape hatches are `-PskepiDebugSign=true` for local E2E (loud warning) and `-PskepiUnsigned=true` for CI/F-Droid. Procedure and fingerprint: `docs/release-signing.md`.

## Privacy

Nothing leaves the device: no account, backend, analytics or third-party crash reporting. The only egress is content downloads started by the user.

- **Download requests:** only the file URL, no device identifier, generic User-Agent, no query strings.
- **Errors:** local rotating log (~1 MB); the user exports it manually after seeing its content. Never contains query text or coordinates.
- **Location:** no location history; only places the user saves explicitly. The live map position is kept in memory while the map is in front and dropped when it closes.
- **AI history:** "save conversations" toggle (on by default) and one-tap delete all.
- **Permissions:** minimal. Release allowlist (CI, `tools/release-guards`): INTERNET, ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE, ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION, and for P2P (Phase 2a) CHANGE_WIFI_STATE, CHANGE_NETWORK_STATE, NEARBY_WIFI_DEVICES (`neverForLocation`) and CAMERA (pairing QR only); never background location, REQUEST_INSTALL_PACKAGES or RECORD_AUDIO. The torch needs no permission (`CameraManager.setTorchMode`); SMS and calls are hand-offs (`sms:`, `tel:`), never sent by the app. No contacts or photos.
- **Store forms:** "no data collected" on Play Data Safety and Apple Privacy Nutrition Label; true only while the zero-egress test passes.

## Performance, energy and blackout mode

Targets are measured on a T1 reference device (4 GB Android). A PR that regresses a target by more than 10% does not merge. Until a T1 device is available, T1 targets are **pending** and tracked on the S23 (T2) plus T1-simulation mode.

| Metric | Target | Phase 0 result (S23, T2) | Phase 1a (S23: normal / T1-simulation) | Phase 1b (S23: normal / T1-simulation, English content) | Phase 1c (S23: normal / T1-simulation) |
| --- | --- | --- | --- | --- | --- |
| Cold start to search, no model | < 2 s (T1) | not measured | not measured | not measured | not measured |
| Title suggestions, p95 | < 50 ms (T1) | 9–15 ms ✓ | 14.7 / 15.7 ms ✓ | 61.2 ✗ / 35.4 ms ✓ (3 packs) | 19 / **30 ms** ✓ (3 packs, parallel) |
| Full-text search, p95 | < 300 ms (T1) | 8–19 ms ✓ (103k and 384k articles) | 7.5 / 9.1 ms ✓ | 21.2 / 18.0 ms ✓ | 16 / 40 ms ✓ |
| Article open | < 500 ms (T1) | 321 ms ✓ | 151–383 ms in E2E ✓ | HTML p95 8.3 / 7.2 ms ✓ | HTML p95 12 / 7 ms ✓ |
| Map render | — | 327 ms ✓ | 258 ms | E2E ✓ | E2E ✓ |
| Layer 1 (extractive) answer | < 1 s (T1) | new in Phase 1 | — | p95 337 / **252 ms** ✓ (el 169 / 147) | p95 326 / **234 ms** ✓ (el 200 / 154) |
| Sources visible | < 2 s (T1) | new in Phase 1 | — | p95 217 / **198 ms** ✓ (el 198 / 164) | p95 285 / **175 ms** ✓ (el 215 / 179) |
| First AI token | < 15 s (T2); T1 set after measurement | 12–18 s ✗ (old gate 4 s, Greek, Q4_K_M) | 14.7–16.0 s (borderline) / 16.9 s | p95 **4.8 s** ✓ / 7.1 s (el 12.4 / 14.3 s) | p95 **4.5 s** ✓ / 7.1 s (el 9.6 / 12.6 s) |
| Model load | < 10 s (T1) | not reported | 1.9 / 0.8 s ✓ | 13.4 s cold ✗ / 1.3 s ✓ | warm 0.6 / 0.8 s ✓ · cold 14.0 s (target applies to warm loads) |
| APK per ABI (arm64) | < 80 MB | 55.3 MB ✓ (from 146.5 MB) | 45.9 MB ✓ (R8; dex 15.1 → 6.6 MB) | 46.0 MB ✓ | 49.4 MB ✓ (op-sqlite/SQLCipher, catalog) |

**Memory**

- On T1 the model and the map are never resident together: opening the map unloads the model.
- libzim cluster cache is capped per tier.
- One article viewer per screen, not one per tab.

**App size:** ICU data is excluded (ADR: identical results for English and Greek with and without it; saves 32 MB). ICU data in the content folder (`icu/`, pushed by `scripts/provision.ps1` for experiments) is loaded only by debuggable builds: it is not in the signed catalog. Any new locale must be re-tested without ICU before shipping. Only 3 of 7 llama.rn library variants ship; native libraries are compressed. Release builds run R8 (minify, no resource shrinking) with keep rules for `org.kiwix.**`, `com.rnllama.**`, MapLibre and the Expo modules (`apps/mobile/plugins/proguard-rules.skepi.pro`). App Bundle with ABI splits, arm64 primary.

**Blackout mode**

One tap from the home screen (switch, persisted in app.db); suggested when the battery is below 30% and not charging (checked only while the home screen is in front, never in blackout mode).

- Pure-black theme (OLED, `packages/ui-tokens` `BLACKOUT`), no animations (navigation transitions off, no spinners), dark CSS injected into article HTML by the sealed viewer.
- AI off by default: no automatic summary, the model is unloaded on entry; "Summarise with AI" on request. Layer 1 answers remain.
- GPS and compass at a lower rate on the map only (fixes every 15 s, compass at most 1 per second; decision 2026-10-21; measured +35–44 mAh/h on the S23 against +117–131 mAh/h at the normal rate) and on tap in Tools; no other periodic work in blackout mode.
- A power-saving tips card (airplane mode, brightness, OS battery saver, close apps).
- Costly buttons (AI summary, GPS fix, SOS torch per minute) show the median of the last measured costs on this device ("≈ 1% battery") once three samples exist. Samples (`energy_samples`) come from the battery charge counter (µAh) or the 1% level steps between the start and the end of the action; nothing is recorded while charging. Reference values are measured unplugged over wireless adb (`e2e/adb-wireless.ps1`, `e2e/run-energy.ps1`; Bench → clear/export samples).

**Desktop:** the "station" powered by a UPS or portable power station, with an AI power cap (threads, GPU layers) and a "library and distribution only" mode.

## User safety (medical and survival content)

Non-negotiables (decision 2026-10-21, replacing "human-reviewed"): first-aid and medical text is never generated by the LLM — a 1–4B model will invent doses and steps. Emergency-card steps are **verbatim excerpts** from the IFRC International First Aid, Resuscitation and Education Guidelines (the latest edition the IFRC publishes: 2025), each with its citation (edition, section, printed page), proved word for word against the pinned PDF by `tools/cards-source-check`; the topics the IFRC does not cover for the public (water, earthquake, fire, flood) quote US federal public-domain pages (CDC, FEMA Ready.gov; decision 2026-10-21) the same way, proved against a committed dated snapshot. No paraphrase, no excerpts merged into new sentences, no quote edited to localise it (US-specific passages such as "call 911", US agencies and FEMA programmes are left out), no LLM-written text anywhere in the cards. A topic with no suitable verbatim passage stays unsourced and is never shipped. The AI only points to sources and never summarises medical or emergency questions.

**Emergency cards (`packages/emergency-cards`)**

- Sourced (shipped), 12 cards, 111 steps. IFRC 2025: CPR (adult), severe bleeding, choking (adult or child), burns, fractures/sprains/strains, hypothermia, heatstroke (severe hyperthermia), poisoning — 8 cards, 61 steps. US federal public domain (retrieved 2026-10-21): fire — Ready.gov "Home Fires" + "Wildfires" (12 steps), earthquake — Ready.gov "Earthquakes" (14), flood — Ready.gov "Floods" (11), making water safe to drink — CDC "How to Make Water Safe in an Emergency" (13; the HTML form of the CDC fact sheet "Make Water Safe During an Emergency"). Unsourced: none (`src/unsourced.ts` keeps the rule for future topics).
- Each card: the header "Call <the country's general number> first" (112 in the EU) with a dial button, the numbered steps (IFRC excerpts, whole sentences, the source's own step numbers dropped) and one citation line ("Source: IFRC International First Aid, Resuscitation and Education Guidelines 2025, "<section>", pp. …", or "Source: CDC." / "Source: FEMA, Ready.gov." with page title, URL and retrieval date). Cards from CDC / Ready.gov also show the publisher's no-endorsement statement in body text under the citation (`card-disclaimer`). No logos. Read aloud with the OS TTS.
- Licence of the card text: IFRC cards: "Copies of all or part of this study may be made for non-commercial use, providing the source is acknowledged." (© IFRC, Geneva, 2025); the IFRC is to be informed of the use (`docs/ifrc-notice-email.md`; the owner's email of 2026-10-21 to secretariat@ifrc.org was not delivered, the address is no longer in use; resent 2026-10-27 to first.aid@ifrc.org, no bounce or reply so far). CDC card: public domain; terms (cdc.gov/other/agencymaterials.html): attribution ("Source: CDC"), a prominent disclaimer that the use does not imply endorsement by CDC, HHS or the U.S. Government, no change to the substantive content, a statement that the material is available on the CDC website for no charge, no logos. Ready.gov cards: public domain; reprint terms (ready.gov/publications): content not altered, no implied FEMA or U.S. Government endorsement. Attribution in each card's citation and in About → third-party notices.
- Gates: `tools/cards-source-check` (CI, `android-release-guards` and `ios-build`: IFRC — download from the pinned URL, SHA-256, `pdftotext`, every step an exact substring of the cited page after whitespace/hyphenation/quote normalisation only; CDC / Ready.gov — the committed snapshot `tools/cards-source-check/snapshots/<id>.txt` (URL, retrieval date, SHA-256 of the fetched HTML; text hash pinned in `src/sources.ts`), every step an exact substring of one block under the cited heading) writes or verifies `source-check.lock.json` (all sources and steps); `.github/workflows/cards-sources-drift.yml` re-fetches the web pages weekly: a file with the snapshot's SHA-256 is unchanged, only a different file is extracted and compared (decision 2026-10-27: an extractor difference never shows as drift); it opens an issue only on a real text change, listing the changed passages (blocks removed and added, under their headings) and any card step no longer on the page; a page it could not fetch (HTTP 403) and the `UNCHECKED_NUMBER_COUNTRIES` sources are listed as unchecked in the job summary; PDF number snapshots record the pdftotext version that wrote them (Poppler 24.02.0, the pinned `ubuntu-24.04` runner's), and another version fails the job instead of reporting drift (`cards-source-check reextract-numbers` re-extracts files whose hash is unchanged); it never blocks and never updates a card (the CDC asks reusers to check for revisions; a card changes only by a reviewed commit with a new snapshot); every release build runs `scripts/check-release.ts` (structure + lock digest) and scans the bundle (`cards-bundle`). CI proves the gate fails on an altered step.
- English steps in every locale (the Greek UI keeps Greek titles and search words only); changes still need a CODEOWNERS review.
- Bundled in the app, no pack dependency; available from the first second after install.

**AI rules**

- Emergency keywords show the card and the emergency number first, then Layer 1 source excerpts. No AI summary at all (`summaryAllowed`).
- Medical intent: card + number + Layer 1 only, with "AI summaries are not available for medical questions." No AI summary at all, no opt-in (decision 2026-10-21).
- Numbers with units must appear verbatim in the cited source, or the sentence is removed.
- No doctor persona in the system prompt.

**Emergency numbers:** per country, bundled (`packages/emergency-cards/src/numbers.ts`). Default 112 (EU and many other countries). Example, Greece: 112, EKAB 166, Fire 199, Police 100. Country chosen at onboarding (or with "Use for emergency numbers" in Maps & places), not from the network; while the map has a live fix inside an installed country, that country's numbers (global maps). The app never promises that 112 works without a SIM.

- **Sources, checked like the card sources (2026-10-24).** Every entry cites official sources with the retrieval date; a checked source pins the committed text snapshot of the page or PDF (`tools/cards-source-check/snapshots/numbers/<id>.txt`: URL, date, SHA-256 of the fetched file; text hash in the dataset) and the verbatim quotes that state each number. `cards-source-check` (CI, offline) fails unless every quote is in its snapshot and shows the numbers it claims, and every number of a country is shown by a quote of one of its sources; the numbers are bound into `source-check.lock.json` (`numbersDigest`), which every release build checks (`skepiCheckEmergencyCards`, the iOS build phase); the weekly drift job re-fetches the sources (hash first, see the gates above). Countries whose official pages refuse automated requests are listed in `UNCHECKED_NUMBER_COUNTRIES` (AU, CA); no other entry can be added without a checked source.
- **Coverage.** 35 of the 239 countries of the global maps (the 27 EU member states, Switzerland, United Kingdom, United States, Canada, Australia, New Zealand, Japan, Türkiye). Japan has no single number: 119 (fire, ambulance) is the main number, police 110, coast guard 118 (NPA, FDMA, Japan Coast Guard); Türkiye: 112 for every service (Ministry of Interior, 112.gov.tr).
- **Filling the rest (plan).** Only official national sources: the national emergency service, telecom regulator or interior / health ministry, on a government domain, in the national language if need be (the quote stays verbatim, an English gloss in a comment); for EU member states the European Commission. Never Wikipedia or other compiled lists; the ITU list of national emergency numbers only to find the national source, never cited. Batches of about 20 countries per reviewed change, largest populations and travel destinations first (China, India, Indonesia, Brazil, Mexico, Russia, South Africa, South Korea, Egypt, Thailand, …): `cards-source-check snapshot-number`, quotes, `--write-lock`, CODEOWNERS review. A country without an official source that can be snapshotted keeps "112 — check the local number".

## UX and emergency features

Two moments of use: **preparation** (online; the user chooses and downloads) and **crisis** (offline, in a hurry, low battery). Anything critical in a crisis is at most two taps away.

**Navigation (5 tabs)**

| Tab | Content |
| --- | --- |
| Search | One field for articles, cards and places; a permanent "Emergency" button above it |
| Ask | AI conversation with sources (Layer 1 + Layer 2). Hidden on T0. |
| Map | Map, position, emergency POIs, user places |
| Tools | Emergency cards, SOS light, compass, coordinates, sun times, checklists, notes |
| Library | Packs, downloads, Share / Receive (P2P), storage, settings |

**Onboarding "Get prepared"**

1. Language (phone language or English; Greek only with the developer flag until after v1) and country (drives emergency numbers; default from the OS region, never the network).
2. Automatic tier and free-space detection.
3. Storage budget 2 / 8 / 32 GB → preset (`planPreset` in core): English defaults, the default model when the tier runs AI, then the locale's own packs (the largest that fits); capped by free space minus the OS reserve. Downloads go through ContentStore; installed packs are kept. Debug builds with the test catalog plan only test packs (local mirror).
4. Disclaimer (educational content, not medical advice, no warranty) before the app opens.
5. "You are ready" indicator on the home screen: cards ✓, regional map ✓, encyclopedia ✓, AI ✓ (or "not on this device" on T0). "Get prepared" can be run again from the Library.

**Tools that work without packs**

- **SOS light:** Morse ···———··· (unit 250 ms, `SOS_TIMELINE` in core) with the torch via `CameraManager.setTorchMode` on a native thread; screen mode (white or red, full brightness, same timeline). The screen stays on while it runs.
- **Compass and coordinates:** rotation-vector (or accelerometer + magnetometer) heading, declination from the on-device World Magnetic Model; one GNSS fix per tap from the GPS provider (works in airplane mode; no Play Services). Decimal and DMS coordinates; "send my location by SMS" opens the SMS app with the text and an OpenStreetMap link filled in, never sends automatically.
- **Sun times:** sunrise and sunset computed locally.
- **Checklists:** go-bag, home supplies, family plan; editable and linked to cards.
- **Notes:** plain text, encrypted, optionally linked to a map place.

**Accessibility:** dynamic type (no fixed text heights; system font scale honoured) and touch targets ≥ 48 dp (`MIN_TOUCH_DP`); WCAG AA contrast in both themes (every text/background pair in `packages/ui-tokens` is tested); TalkBack/VoiceOver labels and roles on buttons, links, radios, headers and alerts; emergency cards read aloud with the OS TTS (expo-speech).

**Language:** every UI string lives in `packages/i18n` (English master; Greek kept complete and tested; a missing key is a type error). English-only until v1: the UI is English unless the developer flag "Greek UI (frozen locale)" (Bench, `dev.greekUi`, off in every build) is on; then a Greek device language or a Greek choice gives Greek. `localeConfig` lists `en` only.

## Data model and storage

Large data are immutable files. User data live in one encrypted SQLite database (op-sqlite + SQLCipher; 256-bit random key per install, stored with expo-secure-store under an Android Keystore key). Migrations are shared by mobile and desktop (`packages/db`), numbered and forward-only; a database from a newer app or an edited migration is refused. Phase 1c ships migration 1 (`packs`, `settings`), Phase 1d migration 2 (`energy_samples`; typed settings for onboarding, disclaimer, UI language, country, storage budget and blackout mode), Phase 2a migration 3 (`packs.source` gains `p2p`; the table is rebuilt with the same rules; developer setting `dev.greekUi`); the other tables below arrive with their features. On the desktop (Phase 3a) app.db is rusqlite with SQLCipher (vendored OpenSSL); the random key is protected with Windows DPAPI for the current user and only the blob is stored (`db.key`); the same migrations are embedded from `packages/db/migrations.json` (a test keeps it equal to `MIGRATIONS`) with the same ledger rules.

```
<content root>/
  zim/       *.zim
  models/    *.gguf
  maps/      *.pmtiles, *.places.sqlite
  tmp/       *.partial (cleaned on every start)
<app data>/
  app.db     SQLCipher
  catalog/   catalog.json + .sig (newest valid)
  logs/      rotating
```

```sql
CREATE TABLE packs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('zim','gguf','pmtiles','places')),
  version TEXT NOT NULL, title TEXT NOT NULL, path TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL, verified INTEGER NOT NULL CHECK (verified IN (0,1)),
  catalog_seq INTEGER, license TEXT, source TEXT NOT NULL CHECK (source IN ('download','import','provisioned','p2p')),
  consent_at INTEGER, installed_at INTEGER NOT NULL, last_opened_at INTEGER,
  CHECK (verified = 1 OR kind = 'zim'), CHECK (verified = 1 OR catalog_seq IS NULL)
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, title TEXT, model_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL,
  citations_json TEXT, flags INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE places (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, lat REAL NOT NULL, lon REAL NOT NULL,
  note TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE notes (
  id TEXT PRIMARY KEY, body TEXT NOT NULL, place_id TEXT REFERENCES places(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE bookmarks (
  pack_id TEXT NOT NULL, path TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (pack_id, path)
);
CREATE TABLE energy_samples (
  action TEXT NOT NULL, tier TEXT NOT NULL, battery_delta_pct REAL NOT NULL,
  duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

- `packs` is the source of truth for installed packs. Startup does a quick check (existence, size, `file_stamp`); full hash on any difference (packs without a stamp, from before migration 4, once) or via "Integrity check".
- `messages.citations_json` holds `{ sourceId, packId, path, section }[]` so old answers can reopen their sources; a deleted pack shows "unavailable".
- `energy_samples` feeds blackout-mode cost estimates and never leaves the device.
- Backup is an explicit export to an encrypted file (passphrase). No cloud sync.

## Testing and verification

No PR merges without a green gate: typecheck, lint, unit tests, release build and E2E. The project-specific rule: all E2E runs with the network off.

| Level | Tool | Checks |
| --- | --- | --- |
| Static | `tsc --noEmit` (strict), ESLint, `cargo clippy -D warnings`, ktlint, SwiftLint | Types, "no fetch outside ContentStore", dependency boundaries |
| Unit (core) | Vitest | RAG (fusion, chunking, char budgets, JSON output parsing, bigram support check, numeric/unit check, no-source path), catalog verification (valid/invalid signature, rollback), guards, emergency lexicon, i18n |
| Native modules | JUnit + instrumentation (Android), XCTest (iOS), `cargo test` | ZIM open/search on a small fixture, viewer sealing (schemes blocked, JS off, CSP, path traversal), streaming hash |
| AI quality | `/tools/rag-eval` with llama.cpp on CPU in CI | Golden sets (English gated; Greek items only with `--greek`, reported and never gated until after v1) incl. an adversarial set: citation precision, refusal without source, no number/unit absent from the source, summary coverage floors per language, tokens per character; a held-out adversarial set reported separately and never used for tuning |
| Retrieval parity | `e2e/run-parity.ps1` (phone) + `tools/rag-eval` parity; iOS Simulator in CI (`ios-e2e`: `e2e/ios/parity.yaml`, `parity.ts --reference`) | The English questions (Greek with `-IncludeGreek`) through retrieval only on the device and in rag-eval: identical search lists, fused hits, article text hashes, ranked chunks and sources. Coverage: S23 ↔ rag-eval ↔ desktop (108/108, hardening run); iOS Simulator ↔ the stored S23, desktop and rag-eval runs (`tools/rag-eval/parity-reference`, 108/108 since the Phase 3b-0 follow-up), nightly and on `ios-e2e` PRs |
| E2E Android | Maestro on emulator and device | Onboarding, search, article, Layer 1 + AI answer with sources, map, places/POIs, card, live map position (`map-location.yaml`, debug build with the mock GNSS provider, `run-e2e.ps1 -MockLocation`) — in airplane mode; global maps (`e2e/run-countries-e2e.ps1`: a schema 2 test catalog, two pilot countries from the local mirror, then map, places and POIs of both in airplane mode, one country deleted, only the mirror contacted); P2P between two emulators on one virtual Wi-Fi (`e2e/run-p2p.ps1`, `-wifi-server-port`/`-wifi-client-port`) with faults (corrupted chunk, drop + resume, tampering host, bad-signature and older catalogs). The phone and the emulators are shared with other projects: every device script takes a per-device lock (`scripts/device-lock.ps1`, `%LOCALAPPDATA%\device-locks\`) and waits while another session drives the device |
| E2E iOS | Maestro on the iOS Simulator in CI (`e2e/ios`, Phase 3b-0; job `ios-e2e`) | Secure-storage failure (unsigned build), onboarding, search, article, Ask Layer 1, emergency number before Layer 1, cards, map from provisioned packs, the map position from a simulated fix (puck + coordinates; heading needs a device), retrieval parity (no model); AI, hardware tools, P2P and downloads skipped with reasons (report) |
| E2E desktop | Playwright on the web UI with mocked commands (`apps/desktop/e2e/desktop.spec.ts`); tauri-driver smoke on the real Windows build (`e2e/tauri-smoke.mjs`); Station E2E desktop → phone (`e2e/run-station.ps1`); online egress of the whole process tree, idle and in use through UI Automation (`apps/desktop/e2e/egress.mjs --expect-none`) | Main flows, viewer sealing in the real WebView2 (scripts off, IPC denied, CSP, external links as text), AI on the GPU, map, zero egress (app process + webview net log), "Station" mode |
| Rust (desktop) | `cargo fmt`, `cargo clippy -D warnings`, `cargo test` (`crates/*`, `apps/desktop/src-tauri`) | Catalog parity with TypeScript (`catalog/verification-expectations.json`), Station over pinned TLS 1.3, mirror downloads, SQLCipher + migrations, DPAPI, text extraction, viewer protocol; inference on the tiny GGUF (`--ignored`, needs the model) |
| Zero-egress | `dumpsys netstats` per app UID + ContentStore request log + local mirror log | Offline flows: zero requests and zero bytes on any real interface. Download flow (local HTTPS mirror via `adb reverse`): requests only to the mirror, generic User-Agent, no query strings, zero bytes on real interfaces |
| Fuzzing | libFuzzer on ZIM, GGUF and PMTiles loaders, nightly | Crashes and OOM on malicious files |
| Performance | `/tools/bench` on reference devices (+ T1-simulation mode) | Performance targets, tokens/s, % battery per answer |
| Builds | `gradlew assembleRelease` locally and in CI, `xcodebuild`, `tauri build` | Release builds from source, no prebuilt binaries from postinstall |

**Fixtures:** small ZIMs (English; Greek kept for the frozen locale), `e2e/fixtures/p2p-propagation.zim` (known only to the newer test catalog), an OSM-candidates NDJSON for the places builder, a tiny GGUF for CI, a test catalog signed with a test key that never ships in a release build.

## Build, release and distribution

App and catalog ship independently: the app uses semver, the catalog uses `sequence`. A new pack needs no store review.

| Channel | Artifact | Note |
| --- | --- | --- |
| GitHub Releases | APK signed locally from the reproducible CI build (arm64), MSI, DMG | SHA-256 and CI run id published (`docs/release-process.md`) |
| F-Droid (**first store**, decided 2026-10-12) | Built by F-Droid from the tag, unsigned and reproducible; F-Droid publishes our signed APK (`Binaries:` + `AllowedAPKSigningKeys:`) | Source builds (Expo modules included); FOSS AARs from Maven Central only; no Play Services (none on the classpath) |
| Google Play (**deferred to v1**) | AAB with ABI splits (arm64; `bundleRelease` + bundletool tested) | Account type, Play App Signing, IARC and Health declaration decided at v1; Data Safety "no data collected" |
| App Store / TestFlight | iOS build | Apple Developer Program (annual fee); same account notarises macOS |
| Windows | Tauri MSI/NSIS, winget | Without a code-signing certificate SmartScreen warns |

**CI (GitHub Actions):** `.github/workflows/ci.yml` on Linux runs typecheck, lint, unit tests, the rag-eval smoke subset (fixture ZIMs + cached Qwen2.5-0.5B Q4_0) and, since Phase 1d, `android-release-guards`: the IFRC cards source check (`tools/cards-source-check`, Poppler `pdftotext`, PDF cached by its hash), expo prebuild, the cards gate must fail on an altered step, `assembleRelease -PskepiUnsigned=true` (unsigned since 2026-10-12, Developer Preview mode; Gradle scans the card text of the bundle), the release permission allowlist (`aapt2 dump permissions`) and the release JS bundle rebuild probe (`tools/release-guards`); since Phase 3a `desktop-windows` (libzim fetched and SHA-256 checked, UI build, `cargo fmt --check`, Vulkan SDK pinned by SHA-256 in `native/vulkan` (pruned, cached), `cargo clippy -D warnings` for the Vulkan and the CPU-only build, `cargo test`, a CPU-only build, mirror download test); since Phase 3b-0 `ios-build`, `ios-e2e` and `desktop-macos` on macOS runners (below). A `changes` job skips the heavy jobs when a change touches only `docs/**` or `*.md` (`verify` always runs; pushes to main are never cancelled); `verify` also runs `catalog check-fixtures` (every file the test catalogs, manifests and tests use is committed, with the catalog's size and SHA-256). Caches: Swatinem/rust-cache for the desktop crates and llama.cpp, Gradle User Home with the build cache, and ccache for the Android NDK builds (CMAKE_<LANG>_COMPILER_LAUNCHER). The desktop builds locally with `scripts/with-msvc.ps1` (MSVC environment; uses Microsoft's Windows SDK NuGet packages, portable Strawberry Perl and Ninja when no SDK is installed) and `npx tauri build` (unsigned MSI + NSIS). kiwix and llama.cpp artifacts cached by pinned version. No signing key in CI: CI builds unsigned, and the maintainer signs the reproducible artifact locally (`docs/release-process.md`); the catalog key never in CI. `.github/workflows/android-repro.yml` builds the unsigned release twice (job `android-repro`) and runs `fdroid build` of the F-Droid recipe in F-Droid's buildserver container (job `fdroid-build`), which must give the same bytes. Locally, Android releases build with `gradlew assembleRelease`; EAS only as a fallback. Debug builds install side-by-side as `org.skepi.app.dev` ("SKEPI Dev", debug key); release keeps `org.skepi.app`. `scripts/provision.ps1` and `e2e/run-e2e.ps1` take `-AppId` (release by default).

**Apple builds (Phase 3b-0, `docs/phase-3b0-report.md`).** No Mac is needed for development: every Apple-specific line compiles and runs in CI on GitHub's macOS runners (Apple silicon), unsigned, with no TestFlight or store work.

| | iOS (`ios-build` + `ios-e2e` jobs) | macOS desktop (`desktop-macos` job) |
| --- | --- | --- |
| Toolchain | Runner Xcode + iOS Simulator runtime, CocoaPods, `expo prebuild -p ios --clean` (ios/ is generated, wired by `apps/mobile/plugins/withSkepiIos.js`), `xcodebuild` Release for `iphonesimulator`, `ARCHS=arm64`, `CODE_SIGNING_ALLOWED=NO` | Rust 1.98.1, `cargo fmt` / `clippy -D warnings` / `test` with `--no-default-features --features metal`, `tauri build --target aarch64-apple-darwin --bundles app,dmg --no-sign` (`tauri.macos.conf.json`) |
| libzim | `CoreKiwix.xcframework` 14.2.1-2 (official Kiwix build: libkiwix 14.2.1, libzim 9.7.0, ICU 73.2), SHA-256 per slice in `native/kiwix/corekiwix.lock.json`, linked into the `SkepiZim` pod (Objective-C++ shim + Swift) | the macOS slice of the same xcframework, thinned with `lipo` and linked statically by `crates/zim-ffi` (Windows keeps the openZIM DLL build) |
| Inference | llama.rn compiled from source (`RNLLAMA_BUILD_FROM_SOURCE=1`, as on Android); no model on the Simulator | llama.cpp with Metal (`metal` feature; Vulkan stays on Windows) |
| Native code | Swift modules: `expo-zim` (+ sealed `WKWebView` viewer: `WKURLSchemeHandler`, content rule list blocking every non-`zim:`/`data:` load, page JavaScript off, no script handlers, non-persistent data, CSP on every response), `expo-hash`, `expo-content-store` (local files, embedded catalog, import; **downloads not supported yet**), `expo-device-profile`, `expo-emergency-tools`; `expo-transfer` reports "not supported on this platform" (no LocalOnlyHotspot; Share/Receive hidden on iOS) | app.db key in the login Keychain (`security-framework`; the file holds only the item's account name), RAM/cores from `sysctl`, free disk from `statvfs`, Station addresses from `getifaddrs`, `zim://localhost` / `maps://localhost` origins (WKWebView form of the custom protocols) |
| Run in CI | `ios-build`: XCTest on a Simulator (`SkepiZim-Unit-Tests`: binding on the rag-eval fixtures, catalog signatures from `catalog/verification-expectations.json` and fixture chunk hashes with the `expo-hash` core, viewer sealing on the Android sealing fixture). `ios-e2e`: Maestro flows on a Simulator with provisioned packs (`e2e/ios`) and the retrieval parity run against the stored S23, desktop and rag-eval runs | `cargo test` (Keychain, device probes, ZIM, catalog, Station TLS), idle egress of the built app and its WebKit processes (`apps/desktop/e2e/egress-macos.mjs`: `lsof` + `nettop`) |
| Release guards | the IFRC cards source check (Homebrew Poppler); build phases: embedded catalog per configuration, release catalog verification, cards gate (CI proves it fails on an altered step), the built `main.jsbundle` scanned for card text (`cards-bundle`) | the Developer Preview UI bundle scanned (`cards-bundle`) before `tauri build` embeds it; the binary links only system libraries |
| Supply chain | CI asserts that libcurl and libmicrohttpd (in CoreKiwix, unused) are not linked into the app or the desktop binary | same |
| Signing | None for the checked build (`CODE_SIGNING_ALLOWED=NO`). **CI only:** the copy Maestro installs is rebuilt with "Sign to Run Locally" (`CODE_SIGN_IDENTITY=-`, no team, certificate, provisioning profile or secret; `e2e/ios/simulator-ci.entitlements`: `application-identifier` + `keychain-access-groups`), because the Simulator's Keychain refuses an app without entitlements; such a build runs only in the Simulator and cannot be installed on a device. CI fails if it carries a team identity | None: `tauri build --no-sign` (the arm64 linker's ad-hoc signature only) |

**app.db key failure (phones).** The key lives only in the secure storage (`@skepi/db` `loadOrCreateDatabaseKey` over expo-secure-store: written, then read back). If the storage refuses (Keychain / Keystore error), the app shows "Secure storage unavailable" with the error code (e.g. `ERR_SECURE_STORAGE_READ (ERR_KEY_CHAIN)`) and Retry, logs the native code (never the key), and never falls back to another key store or an unencrypted database; a failed read never creates a new key. Found by the first Simulator run (the unsigned build had no entitlements: blank screen); the unsigned build now runs `e2e/ios/startup/secure-storage-unavailable.yaml` as its regression check.

Pending a real iPhone or Mac: llama.rn with Metal and the GGUF model, GPS/compass/torch (the map's heading cone from CLHeading), `file://` PMTiles on a device, background downloads (`URLSession`), the P2P receiver, Keychain prompts after an unsigned rebuild, the driven (non-idle) macOS egress run, performance and energy. Retrieval parity is covered on the Simulator (same CoreKiwix build; 108/108 with the S23, desktop and rag-eval: CoreKiwix's full ICU data and the Android AAR's tokenise the English golden set identically).

**iOS CI job split (Phase 3b-0 follow-up).** `ios-build` (path filter: `apps/mobile` native config and plugins, `modules/**`, `native/kiwix`, `e2e/ios`, `packages/emergency-cards`, `catalog/`, lockfiles, the workflow; never docs-only): the draft-cards gate, the Release Simulator build, the link checks, the bundle scan and the Swift unit tests (`build-for-testing`, then a fresh Simulator boots, then `test-without-building`; booting in parallel with the build or `pnpm install` measured no gain on the 3-core runners, and a device from the runner image boots faster but takes as long to settle and once lost Maestro's driver). `ios-e2e` (nightly on main, `workflow_dispatch`, pull requests labelled `ios-e2e`; the label also forces `ios-build`): needs `ios-build` of the same run, which then also builds the ad-hoc "Sign to Run Locally" copy and hands both apps over as one tar artifact (`ios-sim-apps.tar`, uploaded unzipped, kept 3 days; tar keeps executable bits, symlinks and signatures). `ios-e2e` rebuilds nothing: it boots a Simulator, provisions the packs (cached), runs the secure-storage failure flow, the Maestro flows and the parity run (`e2e/ios/run-ios-e2e.sh`; `MAESTRO_DRIVER_STARTUP_TIMEOUT` 300 s, and a flow that fails on a Maestro driver error, never on an assertion, runs once more, both attempts kept; Simulator typing can drop characters, so flows 02–04 type and check the first outcome inside one Maestro `retry`). `workflow_dispatch` with `cold: true` runs both iOS jobs without restoring or saving any cache (timing runs; the main caches stay as they are). `desktop-macos` runs on its own path filter, nightly and on demand.

**Distribution note:** sideloaded APKs trigger Google Play Protect prompts on install; Play Store and F-Droid are the user-facing channels.

**Store distribution (decided 2026-10-12; `docs/store-readiness.md`, `docs/release-process.md`).** F-Droid is the
first store; Google Play is deferred to v1, when the account type (Organization for the Medical health
features), Play App Signing, IARC and the Health declaration are decided. The release signing key never
enters CI or the project's Gradle properties (unchanged). Store texts live in
`fastlane/metadata/android/en-US/` (read by F-Droid and usable for Play); the public privacy policy is
`docs/privacy-policy.md`.

- **One certificate on every channel.** GitHub and F-Droid installs carry the SKEPI release
  certificate (the fingerprint in About and in the Station check): F-Droid through a reproducible build
  that publishes our signed APK. For Play (v1) the proposal stays Play App Signing with the existing key
  uploaded (not a Google-generated one). Users can then move between channels, and one certificate is
  registered for Android developer verification.
- **Release flow.** CI (`.github/workflows/android-repro.yml`, job `android-repro`) builds the unsigned
  release twice on Linux, on two runners with different checkout paths and Gradle user homes, no build
  cache and no ccache, and passes only when both APKs are byte-identical; it uploads the unsigned APK and
  its SHA-256. The maintainer signs that artifact locally (`scripts/release/sign-release-apk.ps1`:
  apksigner with the release key, then checks the certificate and that the signed APK holds the
  artifact's entries byte for byte) and publishes it. Local signed builds stay for device testing.
- **No `fdroid` flavor.** The release classpath has no Play Services, Firebase or other proprietary SDK,
  so one build serves all channels, with two switches: an explicit unsigned release
  (`-PskepiUnsigned=true`, no signing config; the default stays fail-closed and the signed path is
  unchanged; CI builds only unsigned) and Expo modules compiled from source in every build
  (`expo.autolinking.android.buildFromSource: [".*"]`: the 15 modules that came as prebuilt AARs from
  `node_modules` are now Gradle projects; the third-party dependency list is otherwise unchanged).
- **Reproducibility.** Every CMake build of the app loads `apps/mobile/plugins/reproducible.cmake` as
  `CMAKE_PROJECT_INCLUDE` (wired for every Android module by `withSkepiAndroid.js` through
  `androidComponents.finalizeDsl`): `-Wl,--build-id=none` (after the NDK's `--build-id=sha1`, so it
  wins) and `-ffile-prefix-map` for the checkout, the Gradle user home and the NDK; the app module sets the
  same arguments in its own `build.gradle` (React Native evaluates `:app` early); Reanimated compiles
  without ThinLTO (its object paths made the code order path-dependent); `reactNativeDevServerIp=localhost`
  keeps the build host's IP out of `resources.arsc`. Bundle builds filter to arm64-v8a (ABI splits do not
  apply to an AAB). The first comparison
  (2026-10-12, before the fix) had 18 differing native libraries (build-id, absolute `__FILE__` paths);
  results after the fix: `docs/store-readiness.md` §4.
- **Play account and health declaration.** SKEPI declares Medical health features (medical reference,
  emergency and first aid), which Play ties to an Organization developer account; a personal account
  would also need the 12-tester, 14-day closed test.
- **AI content reports.** "Report a problem with this answer" takes the user's text and hands the
  report (question, what was shown, sources, app version, the user's text) to the system share sheet
  (`Share.share`, an `ACTION_SEND` chooser): the user picks the app and sends it; SKEPI opens no
  connection and needs no permission. Copy and save stay. This covers Play's AI-Generated Content policy
  (in-app reporting) for v1 and keeps "no network except user-initiated downloads".

**Store policies (risks)**

- **Play, AI-Generated Content:** in-app reporting of problematic answers: "Report a problem with this answer" opens the system share sheet with the report and the user's text (done 2026-10-12; no network, no permission).
- **Play, Health:** no diagnostic claims in the listing; the description opens with the intended-purpose statement (not a medical device, does not diagnose, treat, cure or prevent any condition, consult a healthcare professional, call 112); health apps declaration to be completed as Medical, which points to an Organization account. Google Play stays deferred until an Organization account exists (owner decision 2026-10-21); the same app serves every channel.
- **Play, target API and page size:** targetSdk 36 (required since 2026-08-31); all native libraries 16 KB aligned.
- **Android developer verification:** required on certified devices in four countries since 2026-09-30, globally in 2027, also for GitHub and F-Droid installs; register `org.skepi.app` with its certificate (owner action before 2027, roadmap).
- **Android permissions:** `LocalOnlyHotspot` needs `NEARBY_WIFI_DEVICES` on Android 13+. No `REQUEST_INSTALL_PACKAGES` (shared APKs are installed via browser or file manager).
- **Apple 1.4.1 (medical):** clear warnings and sources on all medical content.
- **Apple 2.5.2 (downloaded code):** GGUF and ZIM are data; JavaScript inside ZIM stays off by default.
- **Apple Local Network:** P2P needs `NSLocalNetworkUsageDescription` and the Hotspot Configuration entitlement.
- **Size:** packs download after install; the app is useful from first launch via cards and tools.

## Licences and legal

The app is **GPL-3.0-or-later**, required because libzim is GPL-2.0-or-later and libkiwix is GPLv3.

| Component | Licence | Obligation |
| --- | --- | --- |
| libzim / libkiwix | GPL-2.0+ / GPL-3.0 | App licence and source availability |
| llama.cpp, llama.rn | MIT | Notice in About |
| MapLibre | BSD-2-Clause | Notice in About |
| Map data (OpenStreetMap) | ODbL | Visible "© OpenStreetMap contributors" on the map |
| Wikipedia, Wikivoyage, WikiMed | CC BY-SA | Attribution on each article (in the ZIM) and on AI answers that use them |
| AI models | Apache-2.0 or MIT only in the catalog | Free redistribution and P2P; models with special terms (e.g. Llama, Gemma) excluded |
| Emergency card steps (8 first-aid cards) | IFRC guidelines 2025: "Copies of all or part of this study may be made for non-commercial use, providing the source is acknowledged." | Verbatim only, citation per card, IFRC attribution in About; non-commercial use only (F-Droid may tag `NonFreeAssets` from the next version) |
| Emergency card steps (water, earthquake, fire, flood) | Public domain (US federal works: CDC, FEMA Ready.gov); CDC and Ready.gov reuse terms | Verbatim only (US-specific passages left out, never edited), citation with URL and retrieval date, no-endorsement statement on each card and in About, no logos; no anti-feature |

**Legal risks**

- **GPL and the App Store:** a grey area; Apple's terms have been considered GPL-incompatible in the past. Kiwix ships on the App Store, but this needs review before the public iOS submission.
- **Trademarks:** no "Wikipedia", "Kiwix" or "NOMAD" in the name or icon; descriptive use only ("reads ZIM files").
- **Disclaimer:** in onboarding and About — educational content, not medical advice, no warranty (GPL §15–16); the intended-purpose statement (Vision) in About, the store description, README and privacy policy.
- **Non-commercial rule (decision 2026-10-21; also in `CONTRIBUTING.md`):** no paid features, ads, analytics or data collection; donations only, without consideration (no perks, features or priority in return). This keeps S.K.E.P.I. free and open-source software supplied outside a commercial activity, the exclusion in the Product Liability Directive (EU) 2024/2853 and the Cyber Resilience Act (EU) 2024/2847, and within the IFRC's non-commercial licence for the card text.
- **AI Act Art. 50 (transparency):** AI summaries stay visibly labelled ("AI summary — check the source"), and any text shared or copied out of the app that contains one carries the plain line "AI-generated summary" (`AI_GENERATED_MARKER`; unit-tested).
- **Content redistribution:** mirrors are the official sources (Kiwix, Hugging Face, Protomaps). Our own mirror, if any, keeps each pack's licence and attribution.

## Roadmap

Each phase starts only after the previous gate passes. Dates are set after Phase 1 measurements.

1. **Phase 0 · Android spike — DONE, GO.** libkiwix (official Maven package) · llama.rn · PMTiles map · native viewer. Report: `docs/spike-report.md`.
   - Gate result: search, article, map and APK size passed; first-token latency failed (12–18 s vs 4 s), addressed by the two-layer answer and revised targets.
   - **Phase 1b · two-layer answers, latency, citation hardening — DONE.** Layer 1 extractive answers · labelled AI summary (auto on T2, on demand on T1, on tap for medical intent) · char budgets with measured tokens/char · Q4_0 · prompt v5 + KV prefix reuse · bigram/coherence/relevance/number-unit validation · source sanitizer · `tools/rag-eval` (en 108, el 50, adversarial 30) all thresholds met · CI smoke · GPU/NPU experiment (not usable). Report: `docs/phase-1b-report.md`.
   - **Phase 1c · 1b follow-ups, signed catalog and downloads — see `docs/phase-1c-report.md`.** Device/eval retrieval parity (158/158) · fusion and passage-order fixes · coverage floors · held-out adversarial set · char-based answer limits · parallel title suggestions · model load progress · T2 4B evaluated (not adopted) · signed catalog (core verification, catalog-builder, rotation) · `packages/db` (SQLCipher) · `expo-hash` · ContentStore (DownloadManager, import, Library) · zero-egress E2E against a local HTTPS mirror · threat model.
   - **Phase 1a · foundation and security hardening — DONE.** Release keystore and fail-closed signing · viewer sealing instrumentation tests · `modules/expo-device-profile` · `packages/i18n` (English default, Greek) · T1-simulation mode · R8 · still no INTERNET permission (downloads arrive in Phase 1c). Report: `docs/phase1a/README.md`.
2. **Phase 1 · Android MVP (English-first).**
   - Release keystore outside the repo (first task).
   - ~~Two-layer answers with char-based budgets, Q4_0, shorter prompt, KV-cache reuse; GPU/NPU backend experiment~~ (1b).
   - ~~Citation hardening: bigram support check, numeric/unit rule, adversarial set in rag-eval, medical-intent flow~~ (1b).
   - Viewer sealing instrumentation tests.
   - ~~Signed catalog and downloads; English default packs + Greek locale packs~~ (1c; public hosting later).
   - **Phase 1d · safety fixes, emergency cards, onboarding, blackout mode — see `docs/phase-1d-report.md`.** Structural source filter before Layer 1 and Layer 2 (no new lexicon phrases; fresh held-out set before public release) · release permission allowlist and bundle-rebuild probe in CI · 12 draft emergency cards from public-domain sources (release fails with drafts unless `-PskepiAllowDraftCards=true`) · per-country numbers · onboarding with storage presets · blackout mode with measured costs · Tools tab (SOS torch/screen, compass, GNSS, SMS hand-off) · accessibility pass. Phase 1 gate: `docs/phase-1-gate.md`.
   - ~~Emergency cards (English master + Greek), onboarding, blackout mode~~ (1d; cards are drafts until reviewed); ~~T1-simulation mode~~ (1a).
   - ~~rag-eval (English primary, Greek secondary, tokens/char)~~ (1b, CI smoke subset); Maestro in CI.
   - Gate: Maestro in airplane mode green · zero egress · viewer sealing tests green · rag-eval above threshold · Layer 1 < 1 s and sources < 2 s (T1-simulation) · first token < 15 s on T2 · T1 measured if a device is available.
3. **Phase 2 · iOS and P2P.**
   - **Phase 2a · P2P sharing and places (Android) — see `docs/phase-2a-report.md`.** English-only gates (Greek frozen behind a developer flag) · `modules/expo-transfer` (LAN + LocalOnlyHotspot, QR pairing, pinned TLS 1.3, per-chunk verification, resume, catalog propagation, APK page) · places pack (OSM → SQLite FTS5) and Greece map pack in the catalog · home search over articles, cards and places · emergency POI layer · release allowlist for the P2P permissions · wireless adb for unplugged battery costs.
   - **Phase 2b · iOS** (needs a Mac): iOS from the same Expo app · Swift binding with CoreKiwix.xcframework · iOS native viewer · internal TestFlight · P2P receiver on iOS.
   - Gate: Maestro green on iOS · verified transfer Android→iPhone · fuzzing without crashes.
4. **Phase 3 · Desktop and public release.** Tauri app for Windows and macOS with "Station" · GitHub Releases, F-Droid, Play, App Store · security review of the threat model.
   - **Developer Preview `v0.1.0-preview` — see `docs/preview-report.md`.** Held-out set 2 (own report section; eval, desktop and Android pipelines) and the generic rules it led to (links never shown, comment spans removed, table cells, Layer 1 labelled "Source excerpts — not verified advice") · preview build mode: card steps not shipped (bundler alias to `@skepi/emergency-cards/preview`, bundles scanned) · About screens with generated third-party notices (`tools/notices`) · "Report a problem with this answer" (text only, nothing sent) · release catalog sequence 3 propagated desktop Station → S23 · draft GitHub pre-release.
   - **Post-preview hardening — see `docs/hardening-report.md`.** Generic Layer 1 rules from the set 3 backlog: Unicode normalisation (NFKC, format characters, confusables) before every structural check · no URLs or e-mail addresses in Layer 1 · quoted instructions to a model treated like direct ones · source phone numbers flagged on emergency intent. Done: held-out set 4 (2026-10-11) — 0 AI findings on eval/desktop/S23, 3 accepted Layer 1 findings, phone flags and over-removal checks pass.
   - **Phase 3b-0 · Apple builds in CI (no Mac, no signing) — see `docs/phase-3b0-report.md`.** CoreKiwix.xcframework pinned by SHA-256 · Swift binding (`SkepiZim`) with XCTests · sealed `WKWebView` viewer · Swift ports of hash, content store (local only), device profile and tools; transfer "not supported" · `ios-simulator` job (Simulator Release build, Swift tests, Maestro) · `desktop-macos` job (Metal, Keychain, unsigned app + dmg, idle egress) · bundle scans on both.
   - **Phase 3a · Windows desktop with Station mode — see `docs/phase-3a-report.md`.** Persistent build cache · deterministic GNSS in E2E (debug-only mock provider) · `apps/desktop` (Tauri 2, React over `@skepi/core`) · `crates/zim-ffi` (libzim 9.7.0, same as Android) · llama.cpp in-process with Vulkan · sealed viewer window · MapLibre GL JS over the `maps` protocol · SQLCipher + DPAPI · Rust ContentStore · Station mode · desktop retrieval parity 108/108 with the S23 · unsigned MSI/NSIS.
   - **Store readiness (Android) — see `docs/store-readiness.md`, `docs/release-process.md`.** F-Droid first, Play deferred to v1 · unsigned release switch · Expo modules from source · reproducible native libraries and the `android-repro` CI job (two Linux builds, different paths, byte-identical) · local signing of the CI artifact · problem report to the share sheet · AAB tested with bundletool · store screenshots from Maestro · fdroiddata recipe (`docs/fdroid/org.skepi.app.yml`).
   - **Owner action before 2027: Android developer verification** — register the package `org.skepi.app` and the SKEPI release certificate (`7d61c382…447e`), so GitHub and F-Droid installs keep working on certified devices once verification is global (2027).
   - **Owner decisions 2026-10-21 (legal/compliance).** Emergency cards are verbatim IFRC guideline excerpts with citations and a CI source check (replacing human review) · no AI summary on medical intent · one intended-purpose statement everywhere · non-commercial rule · "AI-generated summary" marker on shared text · Google Play deferred until an Organization account exists.
   - Gate: store approvals · emergency cards sourced (IFRC, CDC, Ready.gov) and source-checked (decisions 2026-10-21) · T1 targets measured on a real 4 GB device.
5. **Later.** Precomputed embeddings for curated packs · NPU on Android · more locales.

## Risks and open questions

The project hinged on the libkiwix binding and small-model quality; Phase 0 cleared the first. The second is now addressed by English-first content, two-layer answers and citation hardening.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Small models write poorly or ignore sources | AI loses value | Layer 1 extractive answers always available; JSON per-sentence output; bigram + numeric checks; rag-eval from day one |
| AI latency on low-end phones | Unusable AI on T1 | Layer 1 first; AI summary on demand on T1; Q4_0; char budgets; GPU/NPU experiment; English-first content (≈4× fewer tokens than Greek) |
| T1 targets unmeasured | Surprises on cheap phones | T1-simulation mode now; real 4 GB device before public release |
| Own viewer code replaces a library | Security regressions | Instrumentation tests as a Phase 1 gate; separate iOS implementation in Phase 2 |
| A wrong medical answer causes harm | Physical harm, reputation | Cards are verbatim IFRC / CDC / Ready.gov text proved against the source (burn treatment only from the IFRC card: the Ready.gov burn sentence with a shorter cooling time is left out of the fire card); no AI summary on medical or emergency intent; numeric rule, mandatory sources; intended-purpose statement everywhere |
| IFRC card text: non-commercial licence | F-Droid may tag `NonFreeAssets`; any commercial use would breach it | Non-commercial rule recorded (architecture, CONTRIBUTING); attribution in every card and About; the IFRC notice (`docs/ifrc-notice-email.md`) sent 2026-10-27 to first.aid@ifrc.org (the 2026-10-21 copy to secretariat@ifrc.org bounced), no reply yet; note in `docs/fdroid/merge-request.md` for the next version |
| The IFRC PDF moves or changes | CI source check fails (download or SHA-256) | PDF cached in CI by its hash; a new edition is pinned deliberately (URL, hash, page citations re-checked) |
| A CDC or Ready.gov page is revised | The cards quote the snapshot, not the live page | Weekly drift job (issue with the changed passages; the owner decides); a revision is adopted only by a reviewed commit (new snapshot, hashes, steps, lock); the citation shows the retrieval date |
| `pdftotext` output differs between versions (Poppler on CI, Xpdf in Git for Windows) | False failures of the source check | Normalisation of whitespace, hyphenation and quotes only; checked with Poppler 26.09 and Xpdf 4.06 (61/61) |
| First GNSS fix offline is slow (no A-GPS) and indoors there may be none | The map shows no puck for minutes | "Waiting for GPS…" with the satellites in use and the advice to stay outdoors; the last fix stays as a grey puck; Tools' one-shot fix with a 3-minute timeout |
| Continuous GPS and compass drain the battery | Less battery in a blackout | Map tab in front only, stops on background; 15 s fixes and 1 s compass in blackout mode; measured unplugged on the S23: +117–131 mAh/h at the normal rate (≈ 3% of the battery per hour), +35–44 mAh/h in blackout mode |
| Apple rejects the app (GPL, 1.4.1, 2.5.2) | iOS lost | Internal TestFlight in Phase 2; public submission in Phase 3 after legal review |
| Thermal throttling and battery drain | Useless in a real blackout | Guards, blackout mode, measured cost in the UI |
| Catalog key theft | Malicious content with an official signature | Offline key, backup key, rotation procedure |
| One developer maintains 4 platforms | Slow progress, burnout | Android first, then iOS, then desktop (Windows and macOS) |
| Pinned map/places inputs expire (Protomaps ≈ 2 weeks, Geofabrik ≈ 1 week) | A pack cannot be rebuilt byte for byte later | Packs are kept (mirror + maintainer cache); a new build date and extract date are pinned together and every pack rebuilt; CI reports record inputs and tool versions |
| ~143 GB of country maps, ~470 assets | Mirror size, CI time, maintainer download before signing | One GitHub release (≤ 1000 assets, ≤ 2 GB each); CI in batches of ≤ 256 packs; signing needs the packs once (prepare --reports) |
| Many installed countries = many style layers (71 per pack) | Slower map rendering on T1 phones | Packs render only where they have tiles; measured on the S23 with two countries; T1 to be measured |
| Emergency numbers: 204 of 239 countries outside the bundled dataset | 112 shown with "check the local number" | Filled in batches from official national sources only, each checked by `cards-source-check` ("Emergency numbers") |

**Decisions**

| Topic | Decision |
| --- | --- |
| Product language | English-only until v1 (UI, content, docs, code, required gates). Greek is frozen as the first post-v1 locale; the architecture stays locale-ready (i18n package, per-language budgets and lexicons). Emergency cards are English-only until reviewed. |
| Platform order | Android → iOS → desktop (Windows, macOS). iOS needs a Mac for debugging the Swift module. |
| Test devices | Galaxy S23 (T2) now; T1 targets pending; T1-simulation mode until a 4 GB device is available. |
| Answer model | Two layers: Layer 1 extractive (instant), Layer 2 AI summary (automatic on T2+, on demand on T1). |
| Latency targets | Layer 1 < 1 s and sources < 2 s on T1; first token < 15 s on T2; T1 first-token target set after measurement. |
| Citation checks | JSON per-sentence output; bigram support check; numbers with units must be verbatim in the source or the sentence is removed; an AI sentence with a URL or e-mail address is never shown (Developer Preview), and Layer 1 excerpts show "[link removed]" instead of one (post-preview hardening); adversarial rag-eval set. |
| Article viewer | Native viewer in expo-zim (not react-native-webview), with sealing instrumentation tests. |
| ICU | Excluded (ADR). Re-test any new locale without ICU. |
| Files from SAF | Copied into app-specific storage (fd-only breaks the Xapian index). |
| PMTiles on iOS / React Native | Supported; one `file://` test on an iPhone remains. |
| Model shortlist for rag-eval | T1: Qwen ~1.5–2B · T2: Qwen ~3–4B · T3: Qwen ~7–8B; Meltemi 7B (Apache-2.0) for the Greek set after v1. Krikri excluded (Llama 3.1 licence). |
| Release signing | Dedicated keystore outside the repo; fingerprint published with the first public release. Never in CI or the project's Gradle properties: CI builds unsigned and the maintainer signs the reproducible CI artifact locally (2026-10-12). |
| Android JDK | Published APKs are built with the JDK 21 toolchain (2026-10-13): F-Droid's buildserver (Debian trixie) has only OpenJDK 21, and the published APK must equal F-Droid's build byte for byte. `scripts/android/jdk21.sh` switches the JDK 17 toolchain requests of React Native's Gradle plugin and Expo's core plugin to 21 (as the fdroiddata React Native template does) and `-PskepiJdk21=true` keeps every bytecode target at 17; `android-repro` (Temurin 21, Node 24.21.0 as in Debian forky) and the F-Droid recipe build this way. Local and `android-release-guards` builds stay on JDK 17. |
| Android distribution | F-Droid first (reproducible build, F-Droid publishes our signed APK); Google Play deferred to v1 with its account type, Play App Signing, IARC and Health declaration (2026-10-12), and until an Organization account exists (2026-10-21). One app for every channel. |
| Emergency cards | Verbatim excerpts from the IFRC International First Aid, Resuscitation and Education Guidelines (latest edition: 2025), with citation (edition, section, page) and the IFRC licence ("Copies of all or part of this study may be made for non-commercial use, providing the source is acknowledged."); water, earthquake, fire and flood from CDC and FEMA Ready.gov public-domain pages (citation with URL and retrieval date, no-endorsement statement, committed snapshots, weekly drift check); `tools/cards-source-check` in CI proves every shipped step is an exact substring of its source; topics without a suitable verbatim passage are never shipped; no paraphrase, merging, localising edits or LLM text (2026-10-21, replaces the review by 2 first-aid instructors). |
| Medical intent | No AI summary at all (no opt-in): cards + Layer 1 excerpts + "AI summaries are not available for medical questions." (2026-10-21). |
| Live map position | Puck, accuracy circle, compass heading cone (course when faster than walking), "My location" centre/follow, stale state; from the existing `expo-emergency-tools` GNSS and compass only (no new location dependency, no Play Services); map tab in front and app in foreground only, lower rate in blackout mode; never stored, logged, shared or sent; desktop hidden (2026-10-21). |
| Intended purpose | One statement, word for word, in the store description (first paragraph), About (both apps), README and privacy policy; a test keeps them equal (2026-10-21). |
| Non-commercial | No paid features, ads, analytics or data collection; donations only without consideration (keeps the PLD 2024/2853 and CRA open-source exclusions; 2026-10-21). |
| AI-generated text | Visible label on every AI summary; shared or copied text with an AI summary carries "AI-generated summary" (AI Act Art. 50; 2026-10-21). |
| Catalog hosting | Own domain CNAME'd to GitHub Pages, raw GitHub fallback in the app. |
| Global maps | Every country gets a map pack and a places pack from Natural Earth regions (public domain), the pinned Protomaps daily build and dated Geofabrik extracts; built in CI one pack per job without secrets, signed offline; chosen in Packs → "Maps & places"; all installed countries on one map; emergency numbers follow the installed country of the position (2026-10-23). |
| Catalog schema 2 | Map and places packs carry `region` (ISO code, name, box, centre, part); older apps reject the whole catalog and keep theirs (strict schema kept; 2026-10-23). A part carries its full name, the English and local names of its admin-1 units and its own box (2026-10-24, before any schema 2 catalog was published). |
| Parts of split countries | Download all parts or any one of them; a subdivision in the search finds its part; the country's places pack comes with the first part and goes with the last; the map opens on the installed parts (review 2026-10-24). |
| Catalog updates of v0.1.x | Release builds up to v0.1.2-preview have no catalog update URL and never fetch a catalog, so no separate schema 1 path is served for them (checked 2026-10-24). |
| Pack generations | One GitHub release per pack generation; after the new signed catalog is published, the newest generation is kept in full and, of older generations, only the assets the embedded catalogs of the last two app releases reference; every other old asset is deleted, and an old release once nothing in it is referenced (2026-10-24; refined twice the same day from "the current release's generation"). |
| Emergency number sources | Official national sources only (EU: the European Commission), never Wikipedia or compiled lists; every number proven by a verbatim quote of a committed snapshot, checked in CI and bound to the release builds' source-check lock; unreachable sources only via `UNCHECKED_NUMBER_COUNTRIES` (2026-10-24). |
| Country extracts and languages | `regions/sources_all.py`: the Geofabrik extracts of each country by polygon cover (several where a country spans extracts; border slivers ignored; uninhabited islands that would need a whole continent skipped), the label language from CLDR; both inputs pinned by SHA-256 (2026-10-24). |
| Disputed first-level units | Covered by every country people on the ground may look under: Crimea and Sevastopol in Ukraine's region and parts as well as Russia's (`EXTRA_ADMIN1`), as Siachen and Bir Tawil already are; coverage, not a position on sovereignty (2026-10-24; confirmed by the owner 2026-10-25). |
| Draft pack release | CI adds packs to a draft `packs-<build>` only (the `publish` job: write access, no repository code, size + SHA-256 against the build report); the iOS E2E reads map-gr/places-gr from the draft through the `draft-packs` job until the release is published (2026-10-24). |
| Map glyphs | Every glyph range (0–65535) of the three Noto Sans stacks is bundled (11 MB): with maps of every country a missing range drops Cyrillic, Arabic, … labels and keeps iOS MapLibre from reporting the map rendered; CJK ideographs use the system font (2026-10-25). |
| Map pack size | One pack per country up to 1.5 GB at z15; larger countries in parts of admin-1 subdivisions (bisection, each ≤ 1.5 GB measured at z15; a lower zoom only for a single subdivision over the limit), ~25% under GitHub's 2 GB asset limit (2026-10-23, from the dry-run sizes of build 20261022). |
| Name | **Project S.K.E.P.I.** (Survival Knowledge & Emergency Pocket Intelligence), always written with the dots of the initials; users see "S.K.E.P.I." (Android label, desktop window, About screens, store texts, F-Droid `AutoName`, privacy policy). Identifiers stay `SKEPI`/`skepi`: `org.skepi.app`, `org.skepi.desktop`, the repository, crates, packages, file names, the Tauri `productName` (it names the Windows installers, install folder, registry key and WiX upgrade code, so changing it would install 0.1.1 next to 0.1.0) and the signing key. TMview search (2026-10-16): no "SKEPI" or "ΣΚΕΠΗ" mark. Closest: "SKEP'IA" (SKEZI SAS, FR; WIPO 1815336 + FR 5030813; EU incl. GR, and CH; classes 9 "AI software for data extraction, filtering and analysis" and 42 SaaS; registered 2024, until 2034); "SKEP" (QAD Inc., WIPO 660765, classes 9/42, 13 countries without GR, expired 2026-09-12, in its grace period); "SKEPIA" (NEVS, SE only); "SKEPP", "SKEPTIC", "Skeptify" (EU, further away); "SKEPIS" (US filing). No trademark registration planned; the risk that a rename is needed later is accepted (owner, 2026-10-16). |

**Open**

- [ ] **Owner, before 2027:** Android developer verification (package `org.skepi.app` + release certificate registration).

- [x] Official trademark check for S.K.E.P.I. on EUIPO / TMview: done 2026-10-16, no conflicting "SKEPI"/"ΣΚΕΠΗ" mark; name kept, no registration (Decisions → Name).
- [ ] A Mac or a real iPhone for what CI cannot run (Phase 3b-0 report, "pending"): device AI, sensors, signing, TestFlight.
- [ ] A 4 GB Android device for T1 measurements.
