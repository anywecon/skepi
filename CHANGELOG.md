# Changelog

All notable changes. Versions follow [Semantic Versioning](https://semver.org/); pre-releases carry a
suffix. Phase reports in `docs/` have the details and the measurements.

## [Unreleased]

## [0.2.3-preview] — Developer Preview (Android + Windows)

Sixth published preview, for developers and testers. **Not for emergency use.** A security hardening
update; it contains every change of the unreleased 0.2.2-preview and the fix for its upgrade regression.
The signed catalog, the packs and the emergency cards are unchanged.

### Security
- Installed packs are bound to the file on disk, not only to its size: any change to a pack file since
  the last start makes the app hash it again, and a pack whose bytes changed loses its verified state
  (Android and Windows).
- Packs verified by an earlier signed catalog stay verified while their bytes are unchanged, also when
  the current catalog lists a newer version: Library shows them as "Verified (older catalog)", so they can
  be updated. The signed catalog can now revoke pack hashes; a revoked pack is never opened
  again (a revoked Wikipedia pack becomes unverified), at the next start or right after a catalog update.
  The integrity check compares a pack with the hash that verified it.
- Android 7–10: packs are stored in the app's internal storage, where other apps cannot write. Packs of
  earlier versions move there at the first start; the old copy is removed only after the new one matched
  the signed catalog. If there is not enough space, nothing is deleted and Library says so.
- A second archive that claims the identity of an open one is refused; verified packs open first, and
  the "Unverified" label is shown whenever the app cannot prove an archive is verified.
- Article pages can no longer ask the system to look up or contact other hosts in advance.
- Windows: malformed archive content can no longer end the app.
- Imported files are hashed where they are installed. Release builds ignore extra data files placed in
  the content folder.
- Nearby sharing (Station and Android host): connections that have not paired yet get their own small
  budget and time limits, so they cannot block phones that are pairing; the Android host listens only on
  the address shown in its QR code; the APK download page limits connections and slow readers.
- The Station APK page shows the certificate fingerprint to compare instead of calling the APK official.
- The places database cannot open other database files.
- Downloads: one download at a time per pack on Windows; on Android a download stops as soon as it
  exceeds the size in the signed catalog.
- The held-out benchmark asks for consent before opening its archive.
- Release signing accepts only the reproducible CI build of the release tag's commit.

### Fixed
- Android 7.0–7.1: file moves no longer use an API that exists only from Android 8 (installs and catalog
  updates relied on it).

### Changed
- The repository moved to <https://github.com/anywecon/skepi>; the old address redirects.

## [0.2.2-preview] — not released

Not released (upgrade regression found before publishing): on the first start after the upgrade it
stopped trusting map and places packs that the catalog of 0.1.x had verified (the Greece map and places
of catalog 3), because the current catalog lists newer versions. Its tag was deleted; 0.2.3-preview
contains all of its changes and the fix.

## [0.2.1-preview] — Developer Preview (Android + Windows)

Fifth preview, for developers and testers. **Not for emergency use.** A security and fixes update; the
signed catalog, the packs and the emergency cards are unchanged.

### Security
- Desktop: maplibre-gl 5.24.0 → 6.16.0 (GHSA-jrc7-96c5-q579). The map worker now loads from the app itself
  and the content security policy no longer allows `blob:` workers. The map now needs WebGL2; without it
  the map screen shows an error instead of a blank map.
- Android: deep links longer than 2048 characters are ignored before they are parsed: the app stays on
  the screen it was on, or opens the start screen.

### Fixed
- Desktop: the emergency points and the highlight of a selected place were never drawn on the map, and
  clicking a point did nothing. Both now work.

### Changed
- Desktop: some street labels are placed differently at high zoom (MapLibre 6).
- Dependency updates. Tools and build only: simple-git 4, node-forge 1.4.1, uuid 11 and zod 4.6.7 through
  scoped overrides. Desktop: rustls 0.23.46, tokio 1.53.3, rustls-webpki 0.103.16, webpki-root-certs 1.0.11.
  Accepted risks are listed in `docs/threat-model.md`.

## [0.2.0-preview] — Developer Preview (Android + Windows)

Fourth preview, for developers and testers. **Not for emergency use.** Offline maps and places for
every country.

### Added
- Maps & places (Packs): every country's OpenStreetMap map and places pack, searchable by country name,
  ISO code or a region inside it, with download size, free-space check and a warning on phones with
  little space. Downloads start only when you press Download; every file is checked against the signed
  catalog before it opens. One map shows every installed country; place search and the emergency points
  cover all of them; the emergency number follows the installed country you are in.
- Parts: 19 large countries are split into map parts of neighbouring regions (each ≤ 1.5 GB; Canada's
  largest provinces at a lower zoom). Download one part or all; a region name ("Bayern", "Tokyo") finds
  the part that contains it; the country's places come with its first part and go with its last.
- Emergency numbers from official national sources for Japan (110 police, 119 fire and ambulance, 118
  coast guard) and Türkiye (112), each with its source and retrieval date, checked like the card
  sources. 35 of 239 countries have official numbers; the others show "112 — check the local number".

### Changed
- Signed catalog schema 2 (country and part of each map and places pack), sequence 4: 553 packs
  (547 country packs from the `packs-20261024` mirror, 141 GB in all; Wikipedia and the model unchanged).
  The Greece map and places packs are updated (same ids: an installed Greece pack shows an update).
  Apps before 0.2.0-preview keep their embedded catalog (they never fetch one).
- Onboarding offers the user's own country instead of Greece.

### Build and release
- Country packs are built in CI from pinned inputs (Protomaps daily build 20261024, Geofabrik extracts
  of 2026-10-23), one job per pack, measured again on the maintainer's machine and signed offline.
- Release builds check the emergency numbers against the last passed source check.

## [0.1.2-preview] — Developer Preview (Android + Windows)

Third preview, for developers and testers. **Not for emergency use.** The emergency cards now carry
their steps, quoted word for word from their sources with citations.

### Changed
- Emergency cards: every step is now a verbatim excerpt from the IFRC International First Aid,
  Resuscitation and Education Guidelines 2025 with its citation (section, page), headed "Call 112 first"
  (the country's number). 8 cards ship (CPR, severe bleeding, choking, burns, fractures, hypothermia,
  heatstroke, poisoning). The former adapted US public-domain steps and their Greek translation are gone.
  A CI source check proves every step against the pinned IFRC PDF.
- Emergency cards for fire (home and wildfire), earthquake, flood and making water safe to drink are
  back, now quoted word for word from US federal public-domain pages (FEMA Ready.gov, CDC) with their
  citation (title, URL, retrieval date) and the agencies' no-endorsement statement; passages specific to
  the United States (911, US agencies and programmes) are left out. 12 cards, 111 steps. The source
  check verifies these steps against committed dated snapshots of the pages, and a weekly CI job reports
  when a page changes.
- Medical questions never get an AI summary (no "Show unverified AI summary" button any more): cards and
  source excerpts only, with "AI summaries are not available for medical questions."
- One intended-purpose statement in the store description, About, README and privacy policy.

### Added
- Map: your live position and direction (puck, accuracy circle, compass heading cone, course when moving
  faster than walking), "My location" to centre and follow, a grey puck and "Waiting for GPS…" without a
  fix, and the coordinates under the map. Only while the map is open and the app is in front (slower in
  blackout mode); the position is never stored, logged or sent. Android and iOS; no new permission.
- "AI-generated summary" line in every shared or copied problem report that contains an AI summary.
- About → third-party notices: IFRC attribution and licence statement; CDC and FEMA Ready.gov sources
  with their terms and no-endorsement statements.

### Build and release
- The release APK is signed with its byte layout preserved (`apksigner --alignment-preserved`), so
  F-Droid can copy the upstream signature onto its own reproducible build. The 0.1.1-preview APK was
  re-aligned while signing and F-Droid could not use it. Before publishing, the maintainer copies the
  signature onto the CI's unsigned APK with `apksigcopier`, as F-Droid does, and checks the result.
- F-Droid recipe: esbuild (used by the build's checks) is built from source instead of a prebuilt
  binary; formatting and update-check fixes.

## [0.1.1-preview] — Developer Preview (Android + Windows)

Second preview, for developers and testers. **Not for emergency use.** Emergency card steps are still
under professional review and not included.

### Security
- Unicode normalisation before every structural check of source text: NFKC, zero-width and other format
  characters ignored, look-alike letters (Cyrillic/Greek for Latin) folded — for detection only; shown
  text stays as in the source.
- Layer 1 excerpts show "[link removed]" instead of a URL or e-mail address (the rule AI sentences
  already followed).
- Quoted or reported instructions addressed to an AI, assistant, model or summariser are removed like
  direct ones.
- Emergency questions: a phone number inside a source excerpt is flagged "Number from a source — use the
  emergency number shown above"; the bundled country numbers stay first.

### Fixed
- Phones: if the device's secure storage refuses the database key, the app shows "Secure storage
  unavailable" with the error code and Retry instead of a blank screen; it never opens the database with
  another key or without encryption.

### Added
- iOS and macOS builds in CI (Phase 3b-0, `docs/phase-3b0-report.md`): the iOS app for the Simulator
  (Swift binding over the official CoreKiwix build, sealed WKWebView viewer, Swift tests, Maestro flows)
  and the macOS desktop app (Metal, Keychain, unsigned app and dmg, egress check). Not released yet: no
  signing, no TestFlight.
- Android: "Report a problem with this answer" takes your description and opens the phone's share menu
  with the report ("Send…"); S.K.E.P.I. itself still sends nothing and needs no new permission.
- Reproducible Android builds: CI builds the unsigned release twice on different runners and paths and
  checks they are byte-identical (`android-repro`); published APKs are that artifact, signed locally
  (`docs/release-process.md`). F-Droid is the first store (`docs/store-readiness.md`).
- CI builds the F-Droid recipe with `fdroid build` in F-Droid's buildserver container (`fdroid-build`) and
  checks it gives the same bytes as `android-repro`.
- Device scripts share a per-device lock with other projects (`scripts/device-lock.ps1`).

### Changed
- The product name is written **S.K.E.P.I.** (the initials of Survival Knowledge & Emergency Pocket
  Intelligence) everywhere it is shown: Android launcher label, desktop window title, About screens,
  problem reports, store texts and the privacy policy. Package names, file names and the signing key are
  unchanged, so this version installs over 0.1.0-preview on both platforms; the Windows installers and
  the Start menu entry keep "SKEPI" (Windows derives the install folder and the upgrade from it).
- rag-eval held-out findings judge Layer 1 on what it shows (addresses removed) and note flagged numbers.
- Android release builds compile every Expo module from source, carry no build-id and no build paths,
  and the AAB holds only arm64-v8a libraries. Reanimated is compiled without ThinLTO.
- Published Android builds use the JDK 21 toolchain (bytecode target unchanged at 17) and Node 24, as on
  F-Droid's Debian buildserver; only the packaged llama.rn variants are compiled.

## [0.1.0-preview] — Developer Preview (Android + Windows)

First public build, for developers and testers. **Not for emergency use.**

### Added
- **Android app** (arm64): offline Wikipedia search and sealed article viewer, Ask with source excerpts
  (Layer 1) and an on-device AI summary (Qwen2.5-1.5B) with verified citations, Greece map and places
  packs with emergency points, emergency numbers per country, SOS torch, compass, GPS position,
  blackout mode, phone-to-phone sharing (QR pairing, pinned TLS, every chunk verified).
- **Windows app** (Tauri 2, x64): the same features with libzim 9.7.0 and llama.cpp (Vulkan GPU or
  CPU), SQLCipher storage with a DPAPI-protected key, a user-chosen content folder, and **Station
  mode** (shares selected packs with many phones on the local network).
- Signed content catalog (Ed25519, offline key, anti-rollback); release catalog sequence 3 propagates
  from the desktop Station to phones.
- About screen on both apps: licence, content/data/model licences, generated third-party notices
  (JavaScript, Rust, Android, native), release signing fingerprint, privacy statement.
- "Report a problem with this answer": prepares a text with the question, what was shown, the cited
  sources and the app version, to copy or save; nothing is sent.
- Developer Preview build mode: emergency cards ship without their steps ("Under professional
  review") plus the emergency numbers; a permanent "Developer preview — not for emergency use" label.
  The bundles are checked for card text at build time.

### Security
- **No AI summary on emergency intent**, in every build: the number, the card and the source excerpts
  only, with no summary button ("first-aid instructions are never generated by the LLM"). Medical
  questions without an emergency keep the AI summary on tap, labelled unverified.
- AI sentences with a web or e-mail address are never shown; comment-like spans are removed from
  source text; tables written as text are split into cells that are never highlighted on their own;
  Layer 1 is labelled "Source excerpts — not verified advice" (held-out adversarial set 2 decision).
- WebView2 runtime egress removed on Windows (Microsoft-account integration and background services
  off); measured online, idle and in use: no connection outside the computer.

### Known limitations
- Tested on a Samsung Galaxy S23 (Android 16) and Windows 11 x64 only. English only. Greece map only.
- Emergency card steps await professional review. Windows installers are not code-signed.
- Layer 1 shows source text verbatim; source integrity relies on the signed catalog of official packs.
  The pre-release held-out set 3 left injected text in Layer 1 for 6 of 16 invented articles; generic
  fixes are planned before v1 (docs/architecture.md). On the phone it also put one injected fracture
  instruction into an AI summary (copied verbatim, so the citation checks kept it); that question has
  emergency intent, which no longer gets an AI summary.
