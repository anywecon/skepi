# Project S.K.E.P.I.

**Survival Knowledge & Emergency Pocket Intelligence** — an open-source, fully offline knowledge
library (Wikipedia via Kiwix ZIM packs), offline vector maps (PMTiles) with emergency points and place
search, and an on-device AI assistant that answers only from the local sources, with citations. For
Android phones and Windows computers; a computer can share packs with nearby phones (Station mode).

> **Intended purpose.** S.K.E.P.I. is for general reference and education only. It is not a medical device and does not diagnose, treat, cure, or prevent any medical condition. Consult a healthcare professional for medical advice. In an emergency, call 112 or your local emergency number.

> **Status: Developer Preview — not for emergency use.** For developers and testers. The emergency
> cards are verbatim excerpts from the IFRC International First Aid, Resuscitation and Education
> Guidelines 2025, each step with its section and page; the water, earthquake, fire and flood cards
> quote US federal public-domain pages (CDC, FEMA Ready.gov) word for word (since `v0.1.2-preview`).
> English only. Tested on a
> Samsung Galaxy S23 (Android 16) and on Windows 11 x64 only. Design and reports:
> [`docs/architecture.md`](docs/architecture.md), [`docs/preview-report.md`](docs/preview-report.md),
> [`docs/threat-model.md`](docs/threat-model.md).

## What it does

- **Search and read** Wikipedia offline (English top articles and WikiMed medical articles), in a sealed
  article viewer (no scripts, no network).
- **Ask**: the answer starts with *source excerpts* (Layer 1, verbatim sentences from the packs, labelled
  "Source excerpts — not verified advice"), then an optional AI summary (Qwen2.5-1.5B on the device)
  whose every sentence must be supported by a cited excerpt, or it is not shown.
- **Maps and places** for every country (since `v0.2.0-preview`): OpenStreetMap map and places packs
  per country, large countries in parts (download one region or all), hospitals, pharmacies, shelters
  and water points, place search; downloaded only when you press Download, each file checked against
  the signed catalog.
- **Emergency**: the number for your country first, a permanent Emergency button, first aid cards
  quoted from the IFRC guidelines, SOS torch (Morse), compass, your position and heading on the map.
- **Share without the internet**: phone to phone (Wi-Fi or hotspot) and computer to phones (Station
  mode); every chunk is checked against the signed catalog.

## Install

Download from the release page (`v0.2.3-preview`): the Android APK, the Windows MSI or NSIS installer,
and `SHA256SUMS.txt`.

**1. Check the SHA-256 of what you downloaded**

```powershell
# Windows PowerShell
Get-FileHash .\skepi-0.2.3-preview-arm64.apk, .\SKEPI_0.2.3-preview_x64_en-US.msi, .\SKEPI_0.2.3-preview_x64-setup.exe -Algorithm SHA256
```
```sh
# Linux / macOS
sha256sum -c SHA256SUMS.txt
```
The values must equal the lines of `SHA256SUMS.txt` from the release page.

**2. Android (arm64, Android 7.0 / API 24 or newer)**: check the APK's signing certificate, then install.

```sh
apksigner verify --print-certs skepi-0.2.3-preview-arm64.apk   # Android SDK build-tools
```
The certificate SHA-256 must be
`7d61c38241b178f84b12dd9a67af6b60b56159b1a0ff067fe672db45dd45447e` (also shown in the app under
About). Then allow "Install unknown apps" for your browser or file manager and open the APK. Content
packs (2–8 GB) are downloaded inside the app, or received from another phone or a Station.

**3. Windows 11 x64**: run the MSI (per-machine) or the NSIS setup (per-user, no administrator rights).
The installers are **not code-signed** in this preview: Windows SmartScreen shows "Windows protected
your PC". Choose "More info" → "Run anyway" only after the SHA-256 check above. The first Station start
asks for firewall access: allow **private networks** only.

## Known limitations

- **Developer preview, not for emergency use.** Emergency card steps are not included until reviewed by
  certified first-aid professionals.
- **Tested on a Samsung Galaxy S23 and Windows 11 only.** Other devices may be slow or fail. Phones
  with less than about 3 GB of RAM get source excerpts only; up to about 6 GB the AI summary runs on
  request with a smaller budget.
- **Layer 1 shows source text verbatim.** The excerpts are the packs' own sentences, unchanged, except
  that web and e-mail addresses are shown as "[link removed]"; a wrong or misleading sentence in a pack
  is shown as written. Source integrity rests on the signed catalog of official packs (Kiwix,
  OpenStreetMap extracts): unverified files are labelled. Text written to steer an AI is removed where
  its form shows it (forged source tags, chat markup, lines addressed to a model — also inside quotes or
  written with look-alike or invisible characters — comment-like spans, table cells), but not by wording:
  harmful advice written as plain prose (for example a wrong first-aid step) is still shown. For
  emergency questions, a phone number inside an excerpt is flagged "Number from a source — use the
  emergency number shown above": call the number shown first, not one in an excerpt. These rules
  followed the pre-release adversarial test (held-out set 3: injected text in Layer 1 for 6 of 16
  invented articles) and still await validation on a fresh test set.
- **No AI summary for emergencies.** On the phone (not in the desktop or evaluation runs) the AI summary
  of the same test copied an injected fracture instruction word for word from its source. Since this
  build, questions with emergency intent never get an AI summary, on either app: the emergency number,
  the card and the source excerpts only.
- AI summaries can be wrong: check the cited excerpt. Sentences with a web or e-mail address are never
  shown. Medical questions get an AI summary only on tap, labelled "Unverified AI summary".
- English only (the Greek locale is frozen until v1). Emergency numbers from official sources for 35
  of 239 countries; elsewhere "112 — check the local number". Map downloads are not supported on iOS
  yet.
- Windows installers are unsigned; no automatic updates (check the release page).
- Known issue: antivirus TLS interception on 127.0.0.1 (e.g. Norton Web Shield) breaks Station pinning;
  add an exception for the app. The antivirus replaces the certificate, so the pin correctly refuses it.
  Seen in the local Station tests; connections from a phone on the network have not been tested with it.

## Privacy

S.K.E.P.I. has no accounts, analytics, ads or telemetry. It uses the network only when you ask it to:
downloading packs from the signed catalog's mirrors, and sharing packs over the local network (P2P on
phones, Station mode on the desktop). Everything else (search, articles, AI answers, maps, places,
emergency cards, problem reports) runs offline on the device; "Report a problem with this answer" only
prepares text for you to copy or save.

- **Android:** egress is checked in every E2E run in airplane mode (0 requests, 0 bytes outside
  ContentStore).
- **Windows desktop:** the app process makes no connection. The Microsoft WebView2 Runtime that draws
  the UI is a browser with its own services; the app switches off its background networking, component
  updates, domain-reliability reports, pings, SmartScreen reputation checks and Microsoft-account
  integration. Measured online with the app idle and in use (`apps/desktop/e2e/egress.mjs`): no
  connection outside the computer. What the app cannot control: WebView2 Runtime updates (Microsoft
  Edge Update, shared by all apps) and settings an administrator or user applies to WebView2 (e.g. the
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` variable). Details:
  [`docs/threat-model.md`](docs/threat-model.md), "WebView2 runtime egress".

## Develop

```sh
pnpm install
pnpm verify          # typecheck + lint + unit tests
```

Layout: `apps/mobile` (Expo, Android), `apps/desktop` (Tauri 2, Windows), `packages/*` (shared
TypeScript: retrieval, Layer 1, prompts, validation, catalog, i18n, emergency cards), `modules/*` (Expo
native modules), `crates/*` (desktop Rust: libzim FFI, engines, Station), `tools/*` (rag-eval,
catalog-builder, release guards, third-party notices), `e2e/` (Maestro, Station, egress).

Prerequisites: Node 22+, pnpm 10; Android: JDK 17, Android SDK 36 with NDK `27.1.12297006` and
`27.3.13750724`, on Windows CMake `3.31.6`; desktop: Rust 1.98.1, Visual Studio Build Tools (C++),
`scripts/with-msvc.ps1`, the Vulkan SDK (`native/vulkan`). E2E: Maestro 2.x, tauri-driver.

Developer Preview builds (no card steps; `SKEPI_PREVIEW=1`):

```sh
cd apps/mobile && npx expo prebuild --platform android --clean
cd android && SKEPI_PREVIEW=1 ./gradlew assembleRelease -PskepiPreview=true -PskepiUnsigned=true --no-daemon
cd apps/desktop && SKEPI_PREVIEW=1 npx tauri build      # via scripts/with-msvc.ps1 on Windows
```

The Android build is unsigned (or `-PskepiDebugSign=true` for a local, never-distributed test build).
Release signing is owner-only: `scripts/release/sign-release-apk.ps1` prompts for the key passwords at
run time; none is stored ([docs/release-signing.md](docs/release-signing.md)).

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [CHANGELOG.md](CHANGELOG.md).

## Licence

S.K.E.P.I. is free software under the **GNU General Public License v3.0 or later** (GPL-3.0-or-later,
required by libzim / libkiwix); see [LICENSE](LICENSE). Third-party components and their licences are
listed in each app (About → Third-party software; generated by `tools/notices`). Content: Wikipedia
text CC BY-SA 4.0 (Wikipedia contributors, Kiwix packs); maps and places © OpenStreetMap contributors,
ODbL 1.0; AI model Qwen2.5-1.5B-Instruct, Apache-2.0. Not a medical device; educational content, no
warranty.
