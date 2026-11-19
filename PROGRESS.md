**Current:** v0.2.3-preview published 2026-11-10; `main` pushed with the Control Room review: test-mirror certificates generated on demand (untracked) + private-key guard, Expo SDK 58 (expo 58.0.24, RN 0.88.1, llama.rn iOS patch), import-fixture fix for the mirror E2E; CI and android-repro green on `a911874`
**Next step:** soupsieve bump (own commit, full rag-eval/parity); drop the llama.rn patch once 0.13.0 stable is 7 days old. Still open: delete `SKEPI_RELEASE_*_PASSWORD` from `~/.gradle/gradle.properties` (owner).
**Last session:** 2026-11-19 — mirror E2E green on the S23 (countries, download after the import-fixture fix); SDK 58 CI breaks fixed (stale mobile notices, llama.rn `RCTCxxBridge` on RN 0.88); CI green (ios-build after a rerun of the known flaky Swift sealing control), android-repro a = b = fdroid-build `00f0fe45…1ecf`; pushed


## Control Room review 2026-11-18: test-mirror certificates and Expo SDK 58 (not pushed, no release, no tag)
Commits on `main` after `dbf3d34`: `e9647b4`, `90a3bda` (Part 1), `bbbd162` (Part 2), `41b381c` (guard CLI fix).

**Part 1: test-mirror certificates generated on demand.**
- `e2e/mirror/gen-certs.mjs` (openssl CLI; Git's openssl on Windows, clear error without one): fresh "SKEPI Test
  Mirror CA" (EC P-256, pathlen 0) per machine, server cert for IP:127.0.0.1 only, 90 days, written to
  `e2e/mirror/certs/` (gitignored); the CA key is deleted right after signing; regenerates when missing, mismatched,
  long-lived or expiring within 7 days, `--force` always. `server.mjs` and the E2E scripts call it first; the Android
  E2E scripts compare the APK's `res/raw/skepi_test_mirror_ca.pem` SHA-256 with `ca.crt` ("rebuild the debug app");
  `run-station.ps1` checks the desktop exe; CI runs gen-certs before the desktop test-mirror cargo test; `build.rs`
  fails clearly without `ca.crt` when the feature is on.
- `withContentStore.js`: without `ca.crt` the debug network security config is written without the 127.0.0.1 entry
  and one notice is printed; release and the F-Droid path need no certs.
- `git rm --cached` of `ca.crt`, `server.crt`, `server.key`; README, threat model ("Debug trust leaking into
  release" rewritten, new row "Private key committed to the repository"), `.gitleaksignore` comment (the d927dc1
  `server.key` history entry stays).
- Guard: `tools/release-guards` private-keys (CI verify job): fails on tracked `*.key`/`.p12`/`.pfx`/`.jks`/
  `.keystore`/`.p8`/`.pk8`/`.ppk` or any file with a PEM private-key armour line; allowlist empty. Proven on a
  never-pushed scratch branch (exit 1 on a `.jks` and a text file with a key block; branch deleted).
- Verified: release APK byte-identical before/after on clean clones (`dbf3d34` and `90a3bda`: unsigned
  `375630ddf595da8fecdf20a2f8a33154b81d9637d682015831f768f69c815fa1`, local Windows JDK 21; the CI comparison runs
  after the push); pnpm verify 50/50; catalog-builder 52/52; release-guards 28/28; fmt, clippy (also with
  test-mirror), deny; desktop tauri build (MSI 43.07 MiB, NSIS 26.88 MiB) and smoke 34/34; upgrade gate v0.2.3 PASS;
  gitleaks clean. code-reviewer: one MUST-FIX (the guard flagged its own doc comment) fixed.

**Part 2: Expo SDK 57 -> 58.**
- expo ~58.0.24 (58.0.26 was 1 day old; 58.0.24 is the newest patch at least 7 days old), RN 0.88.1, React 19.3.0,
  expo-router 58.0.31 and the SDK's module set, resolved through the `minimumReleaseAge` gate (the stale 57.x/0.87.x
  peers of the `modules/*` packages had to be dropped from the lockfile once so pnpm re-resolved them). No stop
  condition: minSdk 24, NDK 27.1.12297006 (= F-Droid recipe), JDK 21 path unchanged; llama.rn, MapLibre, op-sqlite
  unchanged; expo-secure-store 58.0.3. `expo install --check` / expo-doctor: only the too-new patches (58.0.26,
  router 58.0.32) and the desktop's React 19.2.3 (react-dom 19.2.3 does not reach the Android bundle, checked in the
  Hermes string table). All five pnpm overrides still have consumers.
- expo-localization 58 breaks prebuild on a non-numeric versionName: `apps/mobile/plugins/withSkepiLocales.js`
  (tested) does its Android part; drop it when expo-localization is fixed. Hermes bytecode 99 added to the cards
  bundle scan.
- Supply chain (93 changed versions vs `90a3bda`): registry signatures 93/93 verified, provenance 76 (Expo SDK 58
  publishes through GitHub Actions with provenance, hence "publisher alanhughes -> GitHub Actions"); no install
  scripts anywhere; tarball diffs reviewed: the binaries are Expo's `local-maven-repo` AARs (unused, modules are built
  from source), iOS archives, RN's gradle-wrapper.jar and fbt language packs, hermesc, worklets' oxc plugins; added
  hosts are docs and Expo/RN services. New package `noxcturnal` (github.com/expo/noxcturnal, public, Expo maintainer,
  no provenance): Metro uses it only with `unstable_noxcturnalTransformWorker`, not set here. Nothing reverted.
- query-string/decode-uri-component gone: both osv ignores removed, threat-model row closed. New HIGH advisories
  accepted until 2027-02-18 (threat model + osv ignores): picomatch GHSA-fc5q-39xc-vjpf (no fixed release; build and
  test tooling only), soupsieve 2.10 in `tools/rag-eval` (fixed in 3.0.2/4.0.0; follow-up: bump the pin and rerun
  the rag-eval smoke). With `--config osv-scanner.toml`: 0 HIGH/CRITICAL.
- Upgrade gate (`-DebugSigned`, throwaway key per run, API 36 emulator): v0.1.2, v0.2.1, v0.2.3 -> SDK 58 candidate
  PASS (app.db opens with its old key straight to the home screen, every pack verified, no app.db or secure-storage
  error in logcat); v0.2.3 re-run with the reviewed script PASS.
- F-Droid recipe: no change for SDK 58 besides version/commit (note in `docs/fdroid/merge-request.md`); the CI
  `fdroid-build` job is the proof.
- Verified: pnpm verify 50/50; mobile 34/34; release-guards 28/28; catalog-builder 52/52; notices check (Gradle
  runtime classpath 158 maven modules, was 211: Compose and AndroidX activity/lifecycle are no longer pulled in);
  clean-clone frozen install + unsigned preview `assembleRelease` at `bbbd162`:
  `b4b1695f8a2bcdd27057979daf6b4b5e0683ec6cb272804f388d7f879c63ca70` (local Windows JDK 21, not comparable with CI),
  cards 111/111, permission allowlist PASS; `connectedAndroidTest` on the API 36 emulator 49/49 (content-store 15,
  emergency-tools 6, hash 3, zim 13, transfer 12); gitleaks on the 4 commits: no leaks; private-key guard over 2173
  tracked files PASS. code-reviewer: no MUST-FIX; both SHOULD-FIX (logcat pattern, debug-signed label) and most NITs
  applied.

**Not run / blocked (why the commits are not pushed).**
- S23 (connected later the same day, device lock): debug build of `9bd46e2` (SDK 58, bundled JS, preview
  0.2.3-preview (8), embeds the current `ca.crt` 13ae10f5) installed over org.skepi.app.dev with data kept;
  `connectedAndroidTest` 49/49 (content-store 15, emergency-tools 6, hash 3, transfer 12, zim 13; BUILD SUCCESSFUL);
  Maestro in airplane mode (`run-e2e.ps1 -AppId org.skepi.app.dev -MockLocation`): tools, map-location, ask-en,
  ask-t1, medical, cards, blackout, places 8/8, 0 blocked WebView requests, 0 downloads, 0 bytes, 0 hand-offs;
  `onboarding.yaml` failed as expected (release-only: the debug build shows the test catalog). Local Gradle needed
  `JAVA_TOOL_OPTIONS=-Djavax.net.ssl.trustStoreType=Windows-ROOT` (Norton) and `SKEPI_PREVIEW=1`.
- Mirror E2E: `run-download-e2e.ps1` on the emulator with the Part 1 debug build: the CA check passed (the installed
  app embeds the current `ca.crt`), the downloads failed with "Trust anchor for certification path not found"
  because Norton intercepts the TLS (`curl --cacert ca.crt https://127.0.0.1:8443`: issuer "OU=generated by Norton
  Antivirus for untrusted server certificates, O=Norton Web/Mail Shield, CN=Norton Web/Mail Shield Untrusted Root";
  the emulator's own Google TLS failed the same way). `run-countries-e2e.ps1`: same issuer, not run. After the run
  Norton removed `e2e/run-download-e2e.ps1` from the working tree; the owner restored it (blob equal to HEAD) and
  excluded `e2e/`. Rechecked later: `openssl s_client` from the PC still showed Norton's issuer with Safe Web/HTTPS
  scanning paused, so no download run yet.
- Mirror E2E on the S23 (2026-11-18/19, device lock, Web Shield off; issuer "SKEPI Test Mirror CA" from the PC and
  from the S23 through `adb reverse`): `run-countries-e2e.ps1` PASS (8 requests, all to the mirror); first
  `run-download-e2e.ps1`: onboarding-mirror passed, download.yaml failed at the picker ("eval-heldout.zim" not
  visible; 12 requests, all to the mirror). Root cause in the harness, not the app: DocumentsUI lists Downloads
  newest first, `adb push` kept the fixture's 2026-10-05 mtime, and the owner's S23 has newer downloads, so the file
  sat below the fold (Maestro's wait does not scroll). Not an SDK 58 regression: the import-only flow
  (`e2e/import.yaml`, no mirror) passed on the SDK 58 build (skepi-host) and on the older 0.0.1 build (skepi-recv);
  expo-document-picker 57→58 has no Android changes; MediaStore indexed the pushed file at once. On the S23 it
  failed with the pushed mtime and passed with the file touched. Fix: `e2e/download-fixture.ps1` pushes, touches and
  fails unless the mtime is within 60 s of the device clock (rejected a stale push on the S23); used by
  `run-download-e2e.ps1` and the new `run-import-e2e.ps1` (PASS on the S23). Flows and assertions unchanged. Rerun:
  `run-download-e2e.ps1` PASS (onboarding-mirror + download, 12 requests all to the mirror, 15 mirror requests,
  no query strings, generic User-Agent, 0 bytes over real interfaces). The unverified test pack left by the import
  runs was removed in the app (Library, Remove). `e2e/out/` is gitignored (never committed) and CI only uploads
  outputs made on GitHub-hosted runners, so the picker screenshots with the owner's file names stay local.
- Mistake: an emulator start with `-wipe-data` wiped the `skepi-host` AVD (P2P host). Re-provisioned the same day:
  the `9bd46e2` debug build (current `ca.crt`) and `provision.ps1 -AppId org.skepi.app.dev` (all hashes OK); ready
  for `run-p2p.ps1` (the receiver AVD still has the older SDK 57 debug build).
- Desktop: unchanged by Part 2 (same importer resolution, no Rust changes); build and smoke ran in Part 1 only.
- gitleaks on the 8 pushed commits: no leaks. CI on `76a351d` failed twice, both from the SDK 58 commit: desktop-windows
  "Third-party notices are current" (`third-party-notices.json` kept `@babel/helper-string-parser` 7.29.13 from an
  intermediate lockfile; the lockfile resolves 7.29.7; the local "notices check" earlier ran before that lockfile)
  and ios-build (`llama.rn` 0.12.9 casts to `RCTCxxBridge`, gone in RN 0.88). Fixed in `4b8d2bc` (regenerated notices)
  and `a911874` (pnpm patch, backport of llama.rn 0.13.0-rc's install method, iOS file only). CI on `a911874`: all
  green; ios-build passed on a rerun (first attempt: Release build and link passed, Swift `SealingTests` control
  "control web view never connected", the known hosted-runner WebKit flake); ios-e2e skipped by its path filter.
  android-repro: a = b = fdroid-build, unsigned `00f0fe45e6fde80c984c13eb18a80db6cae73d21b7a90a9e77dbf8eb61201ecf`
  (first attempt of (a) and fdroid-build failed resolving Gradle plugins from plugins.gradle.org; passed on rerun).
  Against CI on `76a351d` (`6b9a8e83…3e0a`) only `assets/index.android.bundle` differs (the notices string).
  Local clean clone at `a911874` (Windows JDK 21): `2a2b8760fc14971278204a152973d60e2b0afbe11df970114d46034acf59625e`;
  against the local `bbbd162` build (`b4b1695f…ca70`) only the bundle differs (Hermes: "7.29.7" for "7.29.13"); against
  CI only 19 CMake-built `.so` files differ (Windows host vs Linux), bundle and dex identical. Local `node_modules`
  repaired with `pnpm install --frozen-lockfile` from PowerShell with Windows tar first in PATH (Git Bash's GNU tar
  cannot extract llama.rn's postinstall archives on `F:` paths); jniLibs and xcframework markers match the manifest
  (`cda945a7…65ac`, `ae9a37ae…c4ae`); not used by release builds (`rnllamaBuildFromSource=true`).

**Follow-ups (owner decision 2026-11-18).**
- picomatch GHSA-fc5q-39xc-vjpf: accepted until 2027-02-18 (build and test tooling only, no fixed release); re-check
  then, or earlier when a fixed release passes the `minimumReleaseAge` gate.
- soupsieve (`tools/rag-eval` only): accepted until 2027-02-18. Bump the pin to the fixed release (3.0.2 or later) in
  its own commit, with a full rag-eval/parity run; the parity thresholds and the held-out sets stay unchanged. Then
  drop the three soupsieve ignores from `osv-scanner.toml` and close the threat-model row.
- llama.rn pnpm patch (`patches/llama.rn@0.12.9.patch`, iOS only: RN 0.88 removed `RCTCxxBridge`; backport of
  0.13.0-rc's install method): drop the patch and the `patchedDependencies` entry once llama.rn 0.13.0 stable is
  at least 7 days old (`minimumReleaseAge`), moving to it in its own commit with the iOS build and the Android gates.

## Supply-chain check and release-age guard 2026-11-13 (no release, no tag)
- Checked the 35 package versions that changed in e0adc98..0afbe9f (expo 57.0.33, @expo/cli 57.0.34, 33 others): `npm audit signatures` in a scratch project with the same versions: 548/548 registry signatures verified, 159 attestations. Provenance: Expo never published with provenance (previous versions neither); glob 14.0.6, minimatch 11.0.8, @expo/env 2.6.0 (GitHub Actions trusted publisher) have it; none lost it. Install scripts: no install/postinstall anywhere, unchanged (`prepare` only, not run for registry tarballs). Publisher of every Expo SDK 57 release is the same account; gitHeads are expo/expo "Publish packages" commits minutes before publishing. Tarball diffs vs the previous versions: new Android AARs are the per-version renames in `local-maven-repo` (sha256 sidecars match, same entries, no native libs, new @expo/ui classes all have sources); iOS xcframework tarballs and the create-expo template changed (not used by our Android/desktop builds); added-line scan found no new network calls, exfiltration paths or obfuscation (hits: the dev-server DevTools plugin executor in @expo/cli spawns `process.execPath`, xcode's existing `fork` refactored, brace-expansion `fromCharCode` in glob). expo/expo issues and advisories: no report about these versions. Verdict: nothing suspicious, kept.
- Guard: `minimumReleaseAge: 10080` in `pnpm-workspace.yaml` (pnpm 10.33.0); documented in `docs/release-process.md` §4 (exceptions only on the maintainer's decision, by exact version in `minimumReleaseAgeExclude`, with dates) and CONTRIBUTING. Tested: a fresh exact version fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, a range resolves to the newest week-old version, an exact-version exclude is honoured; frozen and plain `pnpm install` pass and leave the lockfile unchanged (all CI, android-repro and F-Droid installs are frozen), so no exclusions for the current fresh versions are needed. Clean clone: `pnpm install --frozen-lockfile` + `jdk21.sh` OK. `F:\DevCache\skepi-fd` deleted.
- Verified: `pnpm verify` 50/50, gitleaks clean.

## Expo SDK 57 patch update 2026-11-13 (no release, no tag)
- Done: `expo` ~57.0.33 (`@expo/cli` 57.0.34, no zod dependency) and `expo install --fix`: expo-constants ~57.0.24, expo-crypto ~57.0.4, expo-linking ~57.0.14, expo-router ~57.0.31; the six `modules/*` peers resolve the same expo 57.0.33. Dead override removed: `xcode>uuid` (`@expo/config-plugins` 57.0.13 uses xcode 4.0.0, no uuid); the other five overrides still have consumers. Notices regenerated; threat model: zod resolved; CHANGELOG [Unreleased].
- Verified: `pnpm verify` 50/50; notices check; osv-scanner: 0 HIGH/CRITICAL besides the 2 ignored ids (zod, deepmerge, glob 13 gone); gitleaks clean; code-reviewer: no MUST-FIX. Clean clone (`F:\DevCache\skepi-fd`, frozen install, jdk21.sh, prebuild): unsigned preview `assembleRelease` -PskepiJdk21, cards 111/111, unsigned check PASS (local `375630dd…5fa1`, Windows JDK 21, not comparable with CI). S23 (device lock): debug build 0.2.3-preview (8) installed over the dev app with data kept; `connectedAndroidTest` content-store 15/15, emergency-tools 6/6, hash 3/3, transfer 12/12, zim 13/13 (textproto; Norton breaks UTP collection; zim's first packaging attempt failed in the parallel run and passed alone); Maestro on org.skepi.app.dev in airplane mode, one flow at a time: tools, map-location (`-MockLocation`), ask-en, ask-t1, medical, cards, blackout, places 8/8, 0 blocked, 0 downloads, 0 bytes, 0 hand-offs. The first runs of the last six failed because the dev app's `zim/` and `models/` were empty since 2026-11-10; passed after `provision.ps1 -AppId org.skepi.app.dev`. Deep link guard with expo-router 57.0.31: 21,012-char link ignored on cold start (start screen) and while running (About stays), normal links navigate, same process. Desktop `tauri build` MSI 43.07 MiB, NSIS 26.87 MiB; tauri-smoke on the release exe 34/34.
- CI on `03445ef` (push events were lost after GitHub 500s on push; both workflows dispatched on main): run 43319557094 green (verify, android-release-guards, rag-eval-smoke, desktop-windows, desktop-macos, ios-build, ios-e2e); run 43319562891: repro (a) = (b) = `fdroid-build` = `bb3248d93503d6a65e38b1f6d4f346b42ebef4dbd2b8d44741e57956ffa639f8`.
- Risk: expo 57.0.33 / @expo/cli 57.0.34 were published on 2026-11-12, a few hours before this update.

## Dependency scan follow-up 2026-11-12
- requests 2.9.2 (PYSEC-2018-28) was an osv resolver artefact of the unpinned `places/requirements.txt`; it now pins the 8 versions of `requirements-ci.txt` (no hashes), and `tools/catalog-builder/test/requirements.test.ts` fails if they drift. A fresh venv installs exactly those 8 and runs `osm_extract.py` (with and without `--boundary`) on an extract built from the candidates fixture.
- `osv-scanner.toml`: GHSA-qr28-fpjm-wq7f, GHSA-vcc3-ghjq-m6fr ignored until 2027-02-12 (threat model, Dependency risk acceptance). Fixed path only via Expo 58.
- zod 3.25.76 (GHSA-mrhx-c7xc-m3w5) not ignored: `@expo/cli` 57.0.33 (2026-11-05) dropped zod; not upgraded then; resolved 2026-11-13 (expo 57.0.33).

## v0.2.3-preview published 2026-11-10
- GitHub pre-release https://github.com/anywecon/skepi/releases/tag/v0.2.3-preview (tag on `1e5f54cca367`): signed APK `c6f00304…4c34`, MSI `b982c945…75b2`, NSIS `5ebc14a8…bb1a`, SHA256SUMS.txt; the downloaded APK passes the F-Droid signature copy (owner).
- fdroiddata MR 53588 updated to 0.2.3-preview (branch commit 1e5d12f3, note 4203378090).
- Docs: the emergency cards are verbatim excerpts of IFRC 2025 / CDC / FEMA Ready.gov and the maintainer only checks each excerpt against its source (source check + weekly drift job); the open item "review by certified first-aid instructors" is gone from the threat model, CODEOWNERS and README say so. Dated reports unchanged.
- Cleaned up: tag worktree, its target dir, `%TEMP%\skepi\release*` and `verify-0.2.3`.

## 2026-11-10 (3): v0.2.3-preview step 6 on the signed APK (not published)
- Signed APK `skepi-0.2.3-preview-arm64.apk` SHA-256 `c6f003049c6f76ac3360c1f6bf2d4ca77ea923ca14c7f53efc22b0dac7a34c34`, v2 signer `7d61c382…447e` (= AllowedAPKSigningKeys), vc 8; unsigned `4a86b9af…5698` from run 42752077871.
- Upgrade gate (`e2e/run-upgrade-gate.ps1`, API 36 emulator): v0.1.2 PASS, v0.2.1 PASS → UPGRADE GATE: PASS.
- S23 (device lock, airplane mode): `install -r` over the signed v0.2.2 (vc 7 → 8): Library before/after identical, 5 packs Verified (Qwen Q4_0, places-gr, map-gr, WikiMed, Wikipedia top EN). The "ignored" note for the orphaned catalog-3 files (left by v0.2.2) was there before the upgrade and stays until the files are deleted.
- Maestro: onboarding, ask-en, ask-t1, medical, cards, blackout, places on the release app; tools and map-location on the debug build with `-MockLocation` (the release app gets no indoor fix and `-SimulateGnss` test-provider positions no longer reach it) — 10/10, 0 blocked, 0 downloads, 0 bytes, 0 intents, 0 foreign apps. ICU: `icu=none` with `icudt73l.dat` in the content folder (removed afterwards).
- Hand-offs checked by hand by the owner (dialler, share sheet, SMS with location): pass.
- S23: deleted the orphaned map-gr-20261005.pmtiles and places-gr-20261004.sqlite (device lock); Library shows no ignored files, 5 packs Verified.
- Windows installers built from tag `v0.2.3-preview` (1e5f54c) in a clean worktree (`CARGO_TARGET_DIR` short path: the worktree path overflowed MAX_PATH in ggml-vulkan's CMake; one Ninja race in the vulkan shader build passed on retry); desktop smoke on that exe 34/34. MSI `b982c945…75b2`, NSIS `5ebc14a8…bb1a`.
- Release folder `%TEMP%\skepi\release-0.2.3-preview`: signed APK, MSI, NSIS, SHA256SUMS.txt (those three, all OK), release-notes.md (placeholders filled, internal preamble dropped as for v0.2.1). F-Droid signature copy re-checked on the signed APK: PASS.
- Open: publish (owner).

## 2026-11-10 (2): v0.2.2-preview withdrawn, v0.2.3-preview prepared (no tag, no release)

- Found in release step 6 on the signed v0.2.2 (`install -r` over v0.2.1 on the S23): the first start after the file-stamp migration rehashed every pack and dropped map-gr-20261005 / places-gr-20261004 (verified by catalog 3, shipped with v0.1.x) because catalog 4 lists newer files. Owner: v0.2.2 not released, tag deleted; v0.2.3-preview (versionCode 8).
- Done:
  - pack trust across catalogs: unchanged bytes verified by an earlier signed catalog stay verified, shown as "Verified (older catalog)";
  - the signed catalog can revoke hashes (`revoked`, both parsers, builder `--revoked`, carried forward). Applied on every start, also to Android 7–10 packs still in external storage, and right after a catalog is adopted (revocation pass only; a running Station stops). Consent for a revoked ZIM sticks once given again; the integrity check uses the hash that verified the pack.
  - upgrade gate `e2e/run-upgrade-gate.ps1` (API 36 emulator, published v0.1.2 / v0.2.1 APKs with their catalog packs, then the signed candidate) and `crates/desktop-core/tests/upgrade.rs` (in CI); release-process step 6.
  - CHANGELOG (0.2.2 "not released"), release notes v0.2.3, changelogs/8.txt, F-Droid recipe draft at `1e5f54cca367`.
- Verified:
  - gate validated: v0.2.2 candidate → v0.1.2 scenario FAIL (map-gr gone), v0.2.1 scenario PASS; the desktop upgrade test fails with the trust rule switched off.
  - pnpm verify 50/50, mobile 30/30, cargo 62 + 5 Norton-blocked (CI 7/7), fmt, clippy, deny, tauri build, smoke 34/34, Playwright 17/17, gitleaks clean, osv HIGH only the 2 accepted (+ RUSTSEC-2026-0459, accepted).
  - Maestro 8/8 on org.skepi.app.dev in airplane mode (0 bytes, 0 hand-off intents).
  - CI 42752077817 and android-repro 42752077871 green; provenance check PASS without a tag.
  - Code review: 2 MUST-FIX fixed (revocation before the Android 7–10 skip; revocation-only pass after an update).
- S23:
  - org.skepi.app is the signed v0.2.2 (vc 7) from step 6. Its Greece packs were re-provisioned from catalog 4 (map-gr-20261024, places-gr-20261023, SHA-256 checked) and are Verified. The old catalog-3 files are still in its maps folder, listed as ignored (not deleted).
  - org.skepi.app.dev: current debug build, test packs removed again.
  - v0.2.2 files in `%TEMP%\skepi
elease` deleted.
- Open (review SHOULDs not done):
  - a revoked GGUF already loaded stays loaded until restart;
  - the post-update revocation report is not shown on the desktop until the next start;
  - the desktop upgrade test does not model anti-rollback state, a GGUF or a consented unverified ZIM;
  - unknown map files are hashed again on every start (pre-existing).

## 2026-11-10: device tests, push, v0.2.2-preview prepared (no tag, no release)

- Done: review fixes for the Android 7–10 migration (an internal file counts only after its SHA-256 matched; a native error keeps the pack and shows a notice); repo rename to `anywecon/skepi` in README, docs, SECURITY, About, fastlane, recipe, scripts (signed catalog untouched: old URL in `catalog/embedded/release/catalog.json` 547 lines, debug catalog 2, `e2e/mirror/catalogs/*` 2 each; sources `catalog/countries.json` 547, `catalog/regions/sources.json` 1); v0.2.2-preview prep (versionCode 7, CHANGELOG, changelogs/7.txt, release notes, recipe draft).
- E2E fix: a Maestro run hung (2026-11-09 15:57) with Samsung Messages' contact picker in front. Cause: `tools.yaml` tapped "Send my location by SMS"; the Messages task (VIEW `sms:`, called by org.skepi.app.dev) stayed behind and came to the front when provisioning stopped the app; Maestro then hung on the host without reaching the phone. Bugs: `tools.yaml` (VIEW sms:) and `ask-en.yaml` (share sheet CHOOSER) opened other apps. Now no flow taps a hand-off; `run-e2e.ps1` refuses such flows (subflows too), fails on hand-off intents from the app or a foreign foreground app, and stops a flow after 10 min (`-FlowTimeoutMinutes`, exit 124, airplane mode off, lock released). Hand-offs are checked by hand on the release candidate (release-process step 6).
- Verified: S23 `connectedAndroidTest` content-store 13/13, emergency-tools 6/6, hash 3/3, transfer 12/12 (incl. idle unauthenticated sockets), zim 13/13 (results from textproto: Norton breaks UTP collection); API 29 and API 24 AVDs: content-store (incl. LegacyMigrationTest) and zim pass; Maestro on org.skepi.app.dev in airplane mode: tools, map-location, ask-en, ask-t1, medical, cards, blackout, places 8/8 (medical/cards first failed on the dev app's stored country = US, passed once Greece was stored), heldout passed (report-only, 2 known Layer 1 findings); pnpm verify 50/50, fmt, clippy, cargo test (all but 5 Norton-blocked station_server; CI desktop-windows 6/6), deny, tauri build, smoke 34/34, Playwright 17/17, gitleaks clean (tracked files), osv: HIGH only the 2 accepted. CI run 42726446567 green; android-repro 42726446303 green after re-running build (b) (NDK download reset); provenance check (lead 11) PASS against the run, without a tag.
- Accepted: RUSTSEC-2026-0459 (SQLite < 3.54 with a crafted `-wal`): no libsqlite3-sys release bundles a fixed SQLCipher yet (0.39.x still has SQLite 3.53.4); `deny.toml` ignore + `docs/threat-model.md` row. osv also lists MEDIUM deepmerge, glob, minimatch (tooling) and glib (Linux only).
- S23 state: org.skepi.app never touched (v0.2.1, 2026-11-05). org.skepi.app.dev: the v0.2.1 base APK cannot run on the migrated app.db (migration 4, ERR_APP_DB), so the current debug build stays installed (data kept); packs pushed for this run were removed again (map-gr was there before); its stored country is now Greece (was United States). Settings at the recorded baseline. emulator-5554 (`selis-midrange-api36`, another project's) was left running.
- Open: local release APK builds come from the stale prebuild (versionCode 5); the versioned APK is CI's.

## Hardening pass 2026-11-09 (local commits, nothing pushed, no tag, no release)

- Done (one commit each, regression test first; "confirmed" = the test failed on the old code):
  - packs bound to their file identity, not their size (migration 4 `file_stamp`; re-hash on any change); Android 7–10 packs in internal storage — confirmed (desktop + mobile tests).
  - a second ZIM with an open archive's UUID is refused; verified packs open first — confirmed (desktop test).
  - resource hints stripped from sealed articles, DNS prefetch off — hints reached the page (confirmed); egress itself not observed with v0.2.1 (session net log of a crafted ZIM page: no hint host); the new smoke check passes.
  - crafted ZIM content can no longer end the desktop process: iterative text walk (stack overflow before: confirmed), byte accessors and lossy strings, cxx trycatch with catch(...) (Xapian path not reproduced).
  - imports hashed after the final move (confirmed, mobile test); release builds ignore ICU data in the content folder.
  - unauthenticated LAN connections have their own small budget (desktop Station, Android host, APK pages); test Norton-blocked here, Android test needs the S23.
  - Station APK page shows the certificate fingerprint without calling an APK official (confirmed by source).
  - places connections cannot ATTACH (confirmed: read another file's row before).
  - one download at a time per pack on the desktop (by source).
  - the Unverified label fails closed for deep links; zim:// authority must be exactly the archive id (confirmed by test of the old predicate).
  - signing takes `-Tag` and accepts only the android-repro artifact of the tag's commit, downloaded again from the run (checked read-only against the v0.2.1-preview run). The repository's current name on GitHub is `anywecon/skepi` (Fiouri/skepi redirects).
  - mobile downloads stop at the catalog size (confirmed); the held-out runner asks for consent (confirmed).
- Verified: see "Last session"; code review of the diff: 2 MUST-FIX (Android legacy move, pre-auth deadline at accept) fixed.
- Not run: `connectedAndroidTest` and Maestro on the S23 (device not connected); iOS/macOS builds (CI only).
- Open follow-ups: macOS `is_viewer_url` exact per platform; iOS `SKZArchive` search/suggest `catch (...)`; GGUF/llama.cpp parsing review (not done); one LAN peer with many addresses can still fill the total pre-auth budget; a very slow reader keeps an APK page slot; `scripts/provision.ps1` still pushes to external storage on Android 7–10.

## v0.2.1-preview released 2026-11-05

- Done (owner): GitHub pre-release https://github.com/anywecon/skepi/releases/tag/v0.2.1-preview, published 16:16:57 UTC; annotated tag `v0.2.1-preview` on `ebd321e03bdb65ee118e4ba592218e90e50514b2`. Signed APK `skepi-0.2.1-preview-arm64.apk` `a1c29b0505d399cbd8a7731aefcd250487bf51ca955c0a05540df8e0bd4c7761`, MSI `eabc6a7f6e98841730589d46ff3579862eedc8d993a4f1acb9bd13cf6e26701b`, NSIS `06b6966afe61fd77530664430e71cb6449822b64e281cf1dff150c2e43c41fb9`, `SHA256SUMS.txt`; no dmg.
- Verified: signature copy PASS on the downloaded APK (owner); GitHub asset digests of all four files match the staged files; tag and asset list read back from GitHub.
- Deleted after publishing, on the owner's request: `F:\DevCache\skepi-fd`, `gradle-skepi-fd`, `skepi-smoke-content`, `%TEMP%\skepi\release`, `release-0.2.1-preview`, `verify-0.2.1`. The clone held no commit missing from this repo; the unsigned artifact of run 41948574811 stays on GitHub until 2027-02-03. `%TEMP%\skepi\apksigcopier-venv` stays.
- MR 53588 (owner, 2026-11-05): branch at `b879aa18`, recipe byte-identical to this repo's, reply in the thread, pipeline 3032936740 running at the last check; description not updated; last reviewer note 2026-10-22 12:25 UTC (the entry above dated 2026-10-23 is that note). `docs/store-readiness.md` and `docs/fdroid/merge-request.md` updated to 0.2.1-preview; `159feda9…` and `06ae193c…`, recorded there as branch commits, are the files' SHA-256 (the commits are `372cc28c` and `db01bb98`). The iOS flows with the new waits have not run.

## v0.2.1-preview signed and smoke-tested 2026-11-05 (no tag, no release, no GitLab action)

- Signed APK (owner, from the CI artifact of run 41948574811, unsigned `a99ed9da…e74a`): `a1c29b0505d399cbd8a7731aefcd250487bf51ca955c0a05540df8e0bd4c7761`; v2 signer certificate `7d61c38241b178f84b12dd9a67af6b60b56159b1a0ff067fe672db45dd45447e`; `check-fdroid-signature-copy.ps1` PASS; `apk-compare.py copyable` passes (artifact plus a 7568-byte signing block).
- S23, device lock, airplane mode: `adb install -r` over 0.2.0-preview (5) with data kept; 0.2.1-preview (6) installed, base.apk pulled back is the same SHA-256. Passed on the signed build: `onboarding`, `ask-en`, `ask-t1`, `medical`, `cards`, `blackout`, `places`. Passed on the debug build (`-MockLocation`): `tools`, `map-location`. 0 blocked, 0 downloads, 0 bytes, SMS hand-off 1, CHOOSER 1. `map-location` failed once: the debug app had no map pack ("No verified map pack"); after `map-gr-20261005.pmtiles` was copied from the release app's folder (hash matches the debug catalog) it passed. No app data was cleared.
- countries E2E blocked locally by Norton TLS interception on 127.0.0.1; download code unchanged since 0.2.0 where it passed (2026-10-25). Checked with `git diff v0.2.0-preview ebd321e`: in `apps/mobile`, `modules` and `packages` only the deep link guard, version, notices, signing plugin and number sources changed.
- CI on `2e922a4` (`8dff852`, `e8f9c78`, `192d8a3` and the 30 s onboarding waits): run 42053503090 `verify`, `android-release-guards`, `desktop-windows`, `rag-eval-smoke`, `ios-build` green; Swift tests 26/26, `testContentBlockerStopsEveryNonZimLoad` (the control web view assertion) 6.4 s. `ios-e2e` and `desktop-macos` skipped on this push, so the iOS flows with the new waits have not run; the next nightly runs them. Run 42053503118 repro a and b green, `fdroid-build` skipped on this push.
- Release assets: signed APK, MSI `eabc6a7f…701b`, NSIS `06b6966a…1fb9` (built 2026-11-04 from `ebd321e`; no desktop source changed since), new `SHA256SUMS.txt`, staged with filled notes in `%TEMP%\skepi\release-0.2.1-preview`. `%TEMP%\skepi\release\SHA256SUMS.txt` lists the unsigned APK and must not be uploaded; the `desktop-macos` dmg is not a release asset.
- Open risks: files vanish from `F:\DevCache\Temp` (hash check first; the owner re-signs if the APK is lost).
- Device testing: S23.

## v0.2.1-preview pushed 2026-11-05 (no tag, no release, no GitLab action)

- CI on `ac9a7ee`: run 41943926913 green (`verify`, `rag-eval-smoke`, `android-release-guards`, `desktop-windows`, `ios-build`, `desktop-macos`; `ios-e2e` skipped on push). Run 41943926946: repro a and b byte-identical, `fdroid-build` byte-identical, SHA-256 `a99ed9da81c1440fa9962acb06a8a973e5d88ce580a0259c9345444b4f36e74a`.
- The recipe names `ebd321e`, so `android-repro` was also dispatched with `app_commit=ebd321e…`: run 41948574811 green, same SHA-256, `fdroid-build` built 0.2.1-preview (6) at that commit. Artifact to sign: `skepi-0.2.1-preview-vc6-ebd321e03bdb-unsigned`. The local Windows-host APK of `ebd321e` (`d2941dd9…5021`) differs from the CI bytes and is not the release artifact.
- `countries` on the S23, debug build, device lock, Web Shield paused by the owner: failed at "Catalog updated to 5", 0 mirror requests, 0 bytes, `Trust anchor for certification path not found`. Measured with the mirror running: `curl -vk https://127.0.0.1:8443/...` on the S23 through `adb reverse` shows issuer "Norton Web/Mail Shield Untrusted Root"; a Node client on the PC gets the same certificate (SHA-256 `A7:4E:02:77…`); the mirror's own `server.crt` is issued by "SKEPI Test Mirror CA" (`D9:43:B3:BE…`). Interception continues while Web Shield is paused; not worked around.
- Local, not pushed: `8dff852` article wait 60 s, Swift test control 60 s, onboarding tier wait 30 s; parity thresholds unchanged. YAML parses; `pnpm verify` 49/49; the Swift change and the flows have not run (macOS CI only). `e8f9c78` `docs/release-notes/v0.2.1-preview.md`.
- Release assets (as in 0.2.0-preview): APK, MSI, NSIS, `SHA256SUMS.txt`. No workflow publishes app releases and `tauri.conf.json` targets only msi and nsis; the dmg in the CI artifact `desktop-macos` is not a release asset.

## Open follow-ups (from the owner, 2026-11-05; not started)

- (a) The pinned Protomaps build 20261024 returns 404. Update the pack-build pin to a current build and record the new hash.
- (b) Add a `desktop-macos` map smoke step to CI (MapLibre 6 worker on WKWebView) before any macOS release.

## v0.2.1-preview prepared 2026-11-04 (local commits, nothing pushed or released)

- Done: version 0.2.1-preview, versionCode 6, iOS build 6, desktop 0.2.1-preview (WiX 0.2.1); CHANGELOG, `changelogs/6.txt`, README, SECURITY; draft recipe in `docs/fdroid/org.skepi.app.yml` (commit `ebd321e03bdb65ee118e4ba592218e90e50514b2`), MR 53588 untouched. No GitHub release notes file yet. Mobile source differs from `4a60d7f` only in `app.json`.
- Verified on `ebd321e`: `pnpm verify` 49/49; notices; fmt; clippy (Vulkan, CPU); `cargo deny`; `cargo test` all but the 4 `station_server` tests (Norton); `tauri build` MSI 42.92 MiB, NSIS 26.80 MiB; tauri-smoke 33/33 (not network-off); Playwright 17/17; gitleaks no leaks; osv HIGH only the 2 accepted. Clean clone, frozen install, unsigned APK 55.9 MB `d2941dd9…5021`, cards 111/111 (local JDK 21, not the F-Droid container). S23, debug build `org.skepi.app.dev` 0.2.1-preview / 6, one flow at a time, device lock, after `pm clear` of the debug app: `map-location`, `tools`, `ask-en`, `ask-t1`, `medical`, `cards`, `blackout`, `places` passed, 0 blocked, 0 downloads, 0 bytes.
- Failed or not run: `countries`: the app never reached the mirror (`Trust anchor for certification path not found`, 0 mirror requests); a direct TLS client on the PC gets Norton's certificate from 127.0.0.1:8443. `onboarding` cannot pass on the debug build (test catalog; the flow is for release builds); it passed on the signed build of `4a60d7f`. Android repro and `fdroid-build` need the push.
- CI nightly on main, `dab0e95`, run 41889500305: `ios-build` (first attempt failed on the Swift test control `control web view never connected`, rerun green; prebuild, `pod install` and Release build with uuid 11 passed in both), `ios-e2e` green on the rerun, `desktop-macos` green. `desktop-macos` does not open the map, so MapLibre 6's worker on WKWebView has not run.
- `ios-e2e` of 2026-11-03 and 2026-11-04 on `27c1cd7`: not related to that commit (no app code in it; same SHA passed on 11-01 and 11-02) and not parity (PASS both nights). 11-04: `02-search-article` waits 30 s, WebContent took 30.9 s to launch (0.4-1.1 s on other nights) and the article opened in 36.6 s. 11-03: `01-onboarding`, the Maestro driver stalled 11.5 s on the status bar during a 10 s wait; the element was on screen afterwards; why the first 5 s of polling missed it is not known. No code changed.
- Open risks: the Apple WebKit tests and flows are flaky on hosted runners (first WebContent launch); the same control assertion failed on 2026-10-31. The pinned Protomaps build 20261024 is gone (404): `run-countries-e2e.ps1` works only from packs already in the cache.
- Device testing: S23 (debug build) and Windows 11.

## Dependency advisories 2026-11-04 (pushed to main, nothing released)

- Done: maplibre-gl 5.24.0 → 6.16.0 on desktop (`setWorkerUrl` with a same-origin worker, `worker-src 'self'` without `blob:`, constructor errors shown because WebGL2 is now required; line labels at z ≥ 15 are placed differently, upstream's new `zoomLevelsToOverscale` default). Scoped pnpm overrides: `@expo/cli>node-forge` and `@expo/code-signing-certificates>node-forge` (exactly 1.4.1), `node-llama-cpp>simple-git` (4.0.2) with `simple-git>@simple-git/argv-parser` (2.0.1), `xcode>uuid` (11.1.1), `eslint-plugin-react-hooks>zod` (4.6.7). Rust: rustls 0.23.46, tokio 1.53.3, rustls-webpki 0.103.16, webpki-root-certs 1.0.11; new `deny.toml`. Deep links over 2048 chars are ignored before React Navigation parses them (`apps/mobile/src/app/+native-intent.ts`, `admitDeepLink` in core). `.gitleaksignore` with the 8 reviewed findings (public signing fingerprint, fixed test tokens, the test mirror's localhost key). Desktop map draws the POI and focus circles under their own ids (`skepi-pois`, `skepi-focus`); the base style's `pois` layer had hidden them since the feature was added. Accepted in `docs/threat-model.md`: decode-uri-component 0.2.2 (mobile runtime, behind the deep link guard; 0.5.1 breaks `query-string` 7 under Metro), zod 3.25.76 (tooling), proc-macro-error (Linux build only).
- Verified: `pnpm verify` 49/49; rag-eval smoke PASS with simple-git 4; osv-scanner 2.7.0: HIGH/CRITICAL left are only the two accepted packages; gitleaks no leaks; clippy `-D warnings` (Vulkan and CPU); `cargo fmt --check`; `cargo deny check`; `cargo test` all but 4 `station_server` tests (Norton intercepts loopback TLS, proved with a separate Node test); `tauri build` MSI 42.91 MiB, NSIS 26.78 MiB; tauri-smoke of the built app 33/33 with catalog packs GR and CY (map, place search, circles by pixel count, pan, zoom; zero egress measured, network not physically off); Playwright 17/17; clean clone: `pnpm install --frozen-lockfile` + `assembleRelease -PskepiPreview=true -PskepiUnsigned=true -PskepiJdk21=true`: unsigned APK 55.9 MB, `390fe72c…2f84`, cards 111/111 (local JDK 21, not the F-Droid container); owner-signed copy `5421df62…77e6` installed over the existing app on the S23: Maestro 8/8 in airplane mode with the device lock (ask-en and ask-t1 rerun alone after the known USB drop), 0 blocked, 0 downloads, 0 bytes; deep link guard on the S23: 21,017-char link ignored on launch and while running, normal links navigate, no crash.
- CI on `ebb9cbd`: run 41858308449 `verify`, `rag-eval-smoke`, `android-release-guards`, `desktop-windows` green (all 6 `station_server` tests pass there); run 41858308532 reproducible build and `fdroid-build` green. `ios-build` and `desktop-macos` cancelled in all 3 attempts, 15 min each ("not acquired by Runner", macOS arm64 capacity), so the run reads as failed and they never started.
- Not run: `map-location` and `countries` flows (they need the debug build), so the live position and heading layer on the phone were not exercised; mobile's MapLibre Native did not change.
- Open risks: a deep link of at most 2048 chars still reaches decode-uri-component 0.2.2 (3 ms on the PC); moderate/low left, not in scope: glob, minimatch, deepmerge (tooling).
- Device testing: S23 (owner-signed test APK) and Windows 11.

## Release signing without stored passwords 2026-10-31

- Done: `tools/Signing.psm1` (from `_templates/signing`); `withReleaseSigning.js` reads `SKEPI_RELEASE_STORE_PASSWORD` / `SKEPI_RELEASE_KEY_PASSWORD` only from the environment (path and alias stay Gradle properties; passwords left in a `gradle.properties` are ignored with a warning naming them); `sign-release-apk.ps1` prompts via `Use-SigningSecrets` and passes `--ks-pass env:` / `--key-pass env:` to apksigner; `keystore.properties` gitignored; README, `docs/release-signing.md`, `docs/release-process.md`, `docs/architecture.md` describe the new flow. Local device/E2E builds stay debug or `-PskepiDebugSign=true`.
- Verified: `pnpm verify` 49/49; PowerShell parse of the script and module; `expo prebuild --clean` + `assembleDebug` without any signing secret. Not run (owner-only by design): `sign-release-apk.ps1`, any key-signed release build.
- Open: the owner's first `sign-release-apk.ps1` run is the real test of the prompt path.

## IFRC notice sent 2026-10-27

- Done (owner): the notice in `docs/ifrc-notice-email.md` sent from anywecon@gmail.com to first.aid@ifrc.org (IFRC Global First Aid Reference Centre; address from the pinned 2025 guidelines PDF, p. 33), replacing the 2026-10-21 copy to secretariat@ifrc.org that bounced. `docs/ifrc-notice-email.md` and the architecture licence notes updated.
- Verified: no bounce or auto-reply so far (owner, 2026-10-27). Docs only; no code changed.
- Open: no reply from the IFRC yet; if first.aid@ifrc.org bounces, use https://www.ifrc.org/contact. A reply asking for changes goes into `docs/architecture.md` (User safety) and the cards.

## Drift check fix 2026-10-27

- Done: `cards-source-check drift` compares the file SHA-256 first (unchanged file → no extraction); only a changed file is extracted and its text compared. PDF number snapshots record `extractor-version`; the check requires one version for all of them and drift fails (exit 2) on another pdftotext instead of reporting drift; new `reextract-numbers` (file must keep its hash, retrieval date kept). The two Japan PDF snapshots were Xpdf 4.06 output (proved by re-extraction) and are now Poppler 24.02.0 (conda-forge build; identical to CI's output: same passages as #5); text hashes and `numbersDigest` updated. HTTP 403 sources and AU/CA are listed as "Unchecked (not drift)"; exit 1 (issue) only for a real text change; drift runner pinned to `ubuntu-24.04`. `ci.yml` android-release-guards: `apt-get update` + one retry before poppler-utils. Issue #5 closed with the run link.
- Verified: `pnpm verify` 49/49 (new unit tests: hash-first, extractor version, unchecked vs drift); cards source check 111/111 steps, numbers of 35 countries, lock matches; local drift with Poppler: no drift, with Xpdf: exit 2; drift run 40413605349: no drift, no issue, unchecked ec-112 (403), CA, AU; CI 40413597667 and Android reproducible build 40413597544 green.
- Open risks: ec-112 (digital-strategy.ec.europa.eu) answers 403 to GitHub runners, so it is only checked from other networks; a runner image with another Poppler needs a deliberate `reextract-numbers`.

## v0.2.0-preview published 2026-10-25

- Done (owner): pack release `packs-20261024` published (547 assets, 12:13 UTC), then GitHub pre-release `v0.2.0-preview` (12:51 UTC), tag on `4faad7c0e9cdd3fcf0994b95a56abd3e8c471f82`: signed APK `b6bebe1e96d927932fba8f12e4ce8507ec1b0ec99c0f8e523a94ccd5c671102b`, MSI `74c13ef6…bc75a`, NSIS `93f9c92e…1d416`; fdroiddata MR 53588 updated with the 0.2.0-preview recipe (`159feda9…`) and description. Release branch merged into main (fast-forward).
- Verified: signature copy PASS on the downloaded asset (owner); signed APK installed over 0.1.2-preview on the S23 (device lock, airplane mode): full Maestro suite 9/9 and the countries flow PASS; release asset digests on GitHub match the hashes above.
- Open: MR 53588 review; `packs-2026-10` kept (embedded by v0.1.1/v0.1.2).

## v0.2.0-preview prepared 2026-10-25 (branch `release/0.2.0-preview`, not tagged, nothing published)

- Done: owner signed catalog sequence 4 offline (`734e90cd…c6bc`); embedded in `catalog/embedded/release`; version 0.2.0-preview / versionCode 5 / iOS build 5 / desktop 0.2.0-preview (WiX 0.2.0); CHANGELOG, `changelogs/5.txt`, store description, README, `docs/release-notes/v0.2.0-preview.md`; CI `draft-packs` job (iOS E2E reads map-gr/places-gr from the draft); all glyph ranges bundled (iOS map flows failed with "Failed to load glyph range 1024-1279" on the new Greece extract, which reaches Cyrillic labels); countries flow waits for "Installed" (race with "Partly installed").
- Verified: pnpm verify 49/49; cargo fmt/clippy/test; cards-source-check PASS (111 steps, 35 countries' numbers); Android `assembleRelease` unsigned preview (versionCode 5, catalog OK seq 4, cards 111/111, permission allowlist PASS, 55.9 MB); `tauri build` MSI 42.79 MiB, NSIS 26.66 MiB; Playwright 17/17; Maestro S23 (device lock) countries flow PASS with the real CI-built files from the local mirror (CY, GR, JP Kanto), 0 bytes egress; CI run 40129038033 green incl. ios-build and ios-e2e (9/9 flows, parity PASS).
- Release candidate: commit `4faad7c0e9cdd3fcf0994b95a56abd3e8c471f82`; android-repro run 40140411948 (recipe at `fd57c98`): builds (a), (b) and `fdroid build` byte-identical, unsigned SHA-256 `a65f61242952bea358ce73c5e1d3c54ab002102566cbfa7cd4a06fd4f95df70d`, artifact `skepi-0.2.0-preview-vc5-4faad7c0e9cd-unsigned`; recipe in `docs/fdroid/org.skepi.app.yml` (only the 0.2.0-preview build, as for 0.1.2).
- Owner decision 2026-10-25: Crimea and Sevastopol stay in both the Ukraine and the Russia packs (confirmed).

## v0.2.0-preview: full country generation 2026-10-24 (branch `release/0.2.0-preview`, not merged)

- Done: inputs pinned — Protomaps build 20261024 (basemap 4.15.2, MD5 `+5cSBgQdfkut8W4suVfJAg==`), Geofabrik 261023; `regions/sources_all.py` chose the Geofabrik extracts of all 239 countries by polygon cover (213 extracts, 115 GB; several for FR, ES, NL, NZ, BT, UZ, TF, UM) and the CLDR 49 language; `osm-places` takes further extracts (`more`, each MD5-checked); parts planned with build 20261024 for AU BR CA CN ES FI FR GB ID IN NO PL RU SE UA (CA: BC, NWT, Ontario, Quebec at z14, Nunavut z13); Crimea and Sevastopol covered by Ukraine too (`EXTRA_ADMIN1`, coverage not sovereignty); `packs.yml` `release` input + `publish` job (contents: write only there, no repository code, draft-only, size + SHA-256 against the build report).
- Built: runs 40087516602, 40090513539, 40094094937 (3 batches): 1100 jobs, 0 failures, 32.7 runner-hours (29.0 build, 3.7 publish), 3 h 26 min wall; longest places-us 77 min. Draft `packs-20261024`: 547 assets, 140,981,862,539 bytes, largest 1,537,800,839.
- Verified: every asset downloaded to the maintainer machine; size + SHA-256 = CI report = GitHub asset digest (547/547); `catalog prepare --reports` re-measured every pack (SHA-256 + chunks) = report (547/547); pending catalog: schema 2, sequence 4, 553 packs (547 + 4 Wikipedia + 2 models), 144.29 GB, 844 KB, parses with the TS and Rust strict parsers.
- Open: owner signs offline; known limits: some parts of countries with overseas territories span far apart areas (FR, ES, NO), so their map home box is wide; Kenya's Ilemi Triangle (0.46%) and five uninhabited US atolls have no places.

## Global maps review fixes 2026-10-24 (merged into `main`)

- Done: per-part download/delete of split countries with part names from admin-1 regions, sizes, "Download all parts", subdivision search; `isSplit` by part (a catalog with some parts); `catalog countries --parts`; Japan (110/119/118) and Türkiye (112) numbers with official sources, snapshots and `numbersDigest` checked in release builds and CI; architecture: catalog delivery of v0.1.x (none: release builds never fetch), pack retention (newest in full + assets the last two app releases embed, worst case ≈ 444 GB), number coverage plan; runner wakes the S23 and stops behind a secure keyguard.
- Verified: pnpm verify 49/49; cargo fmt/clippy/test; Android `assembleRelease` (cards 111/111, permission allowlist PASS); `tauri build`; Playwright 17/17; cards-source-check PASS (35 countries, 10 checked sources); Maestro on the S23 (device lock) countries flow incl. Kanto part PASS, 0 bytes egress; CI incl. iOS green.
- Open risks: 204 countries still on 112 + note; AU/CA sources unchecked (bot walls); iOS downloads unsupported.
- Device testing: S23 + Windows 11; iOS Simulator in CI.

## Global maps pilot 2026-10-23 (branch `feat/global-maps`, not merged, nothing published)

- Done: `catalog/regions/<iso2>.geojson` for 239 countries (Natural Earth v5.1.2, pinned) + index with box/centre/z15 sizes; split rule from measured sizes (≤ 1.5 GB at z15 = one pack, else admin-1 parts by bisection, each ≤ 1.5 GB; US 16, DE 6, JP 3, IT 2 parts); `catalog countries` → `catalog/countries.json` (pinned Protomaps 20261022, Geofabrik 261022); `catalog pack` + reports, places boundary filter, osmium pre-filter, `.github/workflows/packs.yml` (no secrets), `prepare --reports`; catalog schema 2 (`region`) in TS + Rust; Packs → Maps & places (mobile `app/maps.tsx`, desktop `screens/Maps.tsx`), one style over all installed maps, places/POIs over all countries, emergency number of the position's installed country, T1 storage warnings, onboarding takes only the user's country; Greece ids kept (installed packs become updates). Report: `docs/global-maps-pilot.md`.
- Measured: pilot maps 31.74 GB (31 packs, largest 1.42 GB) + places 222 MB; CI run 40005452133 39/39 green, 30 min wall, 143 runner-min, places-us 25.5 min / 12.4 GB disk; projection for all countries ≈ 147 GB maps + ≈ 1 GB places, ≈ 550 assets.
- Verified: pnpm verify 49/49; cargo fmt/clippy/test desktop-core; Android `assembleRelease` (unsigned preview: cards 111/111, permission allowlist PASS, APK 50.7 MB); `tauri build` MSI + NSIS; Playwright 16/16; Maestro on the S23 (device lock, airplane mode) `e2e/run-countries-e2e.ps1` PASS (CY + GR from the local mirror, map/places/POIs of both offline, CY deleted; 0 bytes egress); CI run 40000021067 green incl. ios-build + ios-e2e; 37/37 packs byte-identical across two CI runs, CY/GR identical to the Windows builds.
- Open risks: pinned inputs expire ~2 weeks; a schema 2 catalog needs the new app (old apps keep theirs); JP/TR not in the emergency-number dataset (112 + note); multi-country rendering not measured on T1; iOS downloads still unsupported.
- Device testing: S23 (Android) + Windows 11 desktop; iOS Simulator in CI.

## v0.1.2-preview published, MR 53588 updated 2026-10-22/23

- Done (owner): GitHub pre-release v0.1.2-preview published 2026-10-22 20:50 UTC (https://github.com/anywecon/skepi/releases/tag/v0.1.2-preview), tag on `4af3b0c43daf6078abe46163d80d6daf18700e89`; signed APK `skepi-0.1.2-preview-arm64.apk` `80fd1071905978cfa67a7bd96e97b77177ab71d6c66a63163820a355921ac628`, MSI `2e1d327b…733f`, NSIS `6ae8dadb…b237`, SHA256SUMS.txt. fdroiddata MR 53588 updated 2026-10-23: branch commit `06ae193c…` with the 0.1.2-preview recipe and the description from `docs/fdroid/merge-request.md`.
- Verified: `check-fdroid-signature-copy.ps1` on the APK downloaded back from the release: PASS (owner); before publishing, the same signed APK installed over the current install on the S23 (device lock, airplane mode): Maestro 9/9, 0 blocked, 0 downloads, 0 bytes; release assets' digests match the hashes above (GitHub API).
- Open: Licaon_Kter (2026-10-23) asked whether both `SKEPI_PREVIEW=1` and `-PskepiPreview=true` are needed; the owner answered that only the env var changes the build (the property is a guard that fails without it) and offered to drop the property. Pending his reply; if he wants it, verify with an `android-repro` dispatch that the unsigned hash stays `9857b660808d9c5e1f53a3d1bfcd185a7489b8a0b2ded6ff04b1f7c1e9ad12c1` before changing the recipe. Recorded in `docs/store-readiness.md`.

## v0.1.2-preview prep 2026-10-22 (evening, not tagged)

- Done: owner decision: release v0.1.2-preview from main because the v0.1.1-preview APK cannot pass F-Droid's signature copy. Version 0.1.2-preview / versionCode 4 / iOS build 4, desktop 0.1.2-preview (WiX 0.1.2); CHANGELOG section, `changelogs/4.txt`, `docs/release-notes/v0.1.2-preview.md` (placeholders `@…@` filled at publish time), README and SECURITY. `scripts/release/check-fdroid-signature-copy.ps1` + `fdroid-signature-copy.py`: fdroidserver's `verify_apks` reproduced (apksigcopier 1.1.1 `do_copy` with `exclude_meta` onto the CI APK, apksigner verify) plus byte equality; apksigcopier, click and colorama pinned by hash; `sign-release-apk.ps1` runs it as step 7 and deletes the signed APK on failure; `docs/release-process.md`. Recipe: one build, 0.1.2-preview / 4 / `4af3b0c43daf6078abe46163d80d6daf18700e89`; `merge-request.md` describes 0.1.2-preview (NonFreeAssets for the 8 IFRC cards, live map position, reply for the thread). `fdroid-build` tolerates checkupdates' "current version is newer" between the release commit and its tag (warning).
- Verified: release commit `4af3b0c43daf`: `pnpm verify` 49/49; cards-source-check 111/111; Android preview release build (versionCode 4, cards gate 12/111, bundle scan 0/199 unsourced, 111/111 sourced, permission allowlist PASS); Windows `tauri build` MSI `2e1d327b…733f` and NSIS `6ae8dadb…b237` (staged in `%TEMP%\skepi\release-0.1.2-preview`), dist scan 111/111; Maestro on the S23 (release build installed over 0.1.1-preview, airplane mode, device lock, `-MockLocation`): 8/8 in run 1, places failed there on an adb drop ("Device server died") and passed alone, 0 blocked, 0 downloads, 0 bytes, SMS hand-off 1, CHOOSER 1; CI push 39778296484 green, CI dispatch 39782362542 green incl. iOS E2E; android-repro push 39778296502 (artifact `skepi-0.1.2-preview-vc4-4af3b0c43daf-unsigned`) and dispatch 39789851389 with the new recipe: (a), (b), fdroid-build all `9857b660808d9c5e1f53a3d1bfcd185a7489b8a0b2ded6ff04b1f7c1e9ad12c1`, prebuilt esbuild removed; main HEAD gives the same bytes (39789851809). Signing script dry run with the Android debug key (scratch only): copy check PASS; on the published v0.1.1 APK it fails with F-Droid's exact error.
- Open risks: the Windows installers were built locally from the release commit's tree (not reproducible); the signed APK `skepi-0.1.2-preview-arm64.apk` (SHA-256 `80fd1071905978cfa67a7bd96e97b77177ab71d6c66a63163820a355921ac628`, v2 signer = AllowedAPKSigningKeys) was installed over the current install on the S23 (device lock, airplane mode) and passed the full Maestro suite 9/9 (tools and map-location on the debug build with -MockLocation; 0 blocked, 0 downloads, 0 bytes; the first attempt stopped on an adb drop after tools). NonFreeAssets is expected for this version.

## F-Droid review: esbuild from source 2026-10-22 (afternoon)

- Done: review comment on MR 53588 ("get esbuild from Debian or build it"): the recipe builds esbuild 0.28.2 (the only esbuild in `pnpm-lock.yaml`, tsx 4.23.15's) from fdroiddata's `srclibs/esbuild.yml` with Debian's golang-go and exports `ESBUILD_BINARY_PATH` in the Gradle build's shell; `@esbuild/linux-x64` left scanignore, so scandelete removes the prebuilt. `fdroid-build` gets the srclib definition from a pinned fdroiddata commit (SHA-256), runs `fetchsrclibs` as fdroiddata's CI does, fails if the prebuilt is not removed, reinstalls sudo and runs `fdroid scanner --exit-code` on the APK. `android-repro.yml` takes `app_commit` to build a published commit with the current recipe. Docs: store-readiness §4/§6 and the MR status, `docs/fdroid/merge-request.md` (build notes + reply for the thread).
- Verified: run 39762528408 (dispatch, `app_commit` = a974d925, recipe from the branch): `android-repro` (a), (b), `fdroid-build` all SHA-256 `13fdec22987426743ec6aacaced71a341e0ccb23711c45c0f5fac509ef54fcdc`; log: srclib at v0.28.2 (609683d8), "Removing binary at node_modules/@esbuild/linux-x64/bin/esbuild", `go build` + `ESBUILD_BINARY_PATH`, catalog and card checks via tsx passed; APK scanner clean. The first dispatch (39757723717) built the same bytes and failed only at the scanner step (`--on-server` uninstalls sudo; fixed). Local fdroidserver 2.4.5: rewritemeta no diff, lint clean. `pnpm verify` 49/49.
- Report only: (1) Node 24 type stripping could replace tsx/esbuild in the Gradle and Xcode build scripts: blockers today are only extensionless relative imports (36 in the scripts' sources, `ERR_MODULE_NOT_FOUND` with plain node); `verbatimModuleSyntax` is on, no enums/namespaces/parameter properties found; needs `.ts` extensions + `allowImportingTsExtensions` and `erasableSyntaxOnly`. (2) hermes-compiler: likely the same comment from some reviewers (io.evcc.android, com.Colota still scanignore it; com.scariflabs.horus builds it from the `hermes` srclib at hermes-v250829098.0.16 with cmake + Ninja, ~10 min, and sets hermesCommand); for us `hermes@hermes-v250829098.0.17` (RN 0.86.3), `react.hermesCommand` via the config plugin, and android-repro would have to build hermesc the same way to keep one APK hash.

## F-Droid submission, IFRC notice, drift report 2026-10-22

- Done: recipe `AuthorName`/`AuthorEmail` (from the owner) committed; fdroiddata MR 53588 recorded in `docs/store-readiness.md` (opened 2026-10-22, open, labels New App + waiting-for-upstream). Its pipeline did run (2975487569) and failed: `rewritemeta` (line wrap; fixed), `checkupdates` (no version found, the version is in app.json; `UpdateCheckData` added, local `fdroid checkupdates` finds 0.1.1-preview (3)), `fdroid build` (F-Droid's build is byte-identical to our CI artifact `13fdec22…fcdc`, but the published APK was re-aligned by `apksigner` while signing, so its signature cannot be copied: reproduced locally with `apksigcopier` 1.1.1). `sign-release-apk.ps1` now signs with `--alignment-preserved true` and checks the new `apk-compare.py copyable`; the CI `fdroid-build` job also runs rewritemeta, lint and checkupdates. `docs/ifrc-notice-email.md` marked sent (2026-10-21, owner, anywecon@gmail.com to secretariat@ifrc.org). Water card unchanged: the CDC bleach doses exist only in the two tables (5–9 % and 1 %, per quart/liter, gallon, 5 gallons); no standalone dose sentence on the page. Drift report lists the changed passages (removed/added blocks under their headings) and the card steps gone; nothing is updated automatically; a page that cannot be fetched is reported as not checked. cdc.gov 403 from GitHub runners fixed (language/encoding headers, probe run 39752883835).
- Verified: `pnpm verify` 49/49 (cards-source-check 23 tests incl. 4 for the passage diff); cards-source-check 111/111, lock unchanged; local drift: no text drift (all 5 pages fetched); recipe: local `fdroid rewritemeta` no diff, `fdroid lint` clean, `fdroid checkupdates` finds the version; signing dry run with the Android debug key on F-Droid's build: `copyable` and `apksigcopier compare` pass, the published APK fails both with F-Droid's error; Android preview release build (cards gate 12/111, bundle scan 0/199 unsourced, 111/111 sourced; app inputs unchanged, tasks up to date); desktop `tauri build` MSI + NSIS, dist scan 111/111; Maestro cards on the S23 (airplane mode, device lock, fresh install): run 1 failed (scroll to `card-disclaimer` stalled, adb dropped in the same session), run 2 PASS (0 blocked, 0 downloads, 0 bytes).
- Open risks: the published v0.1.1-preview APK can never pass F-Droid's signature copy; re-signing replaces a published asset hash (or a new tag). Ready.gov floods: text unchanged on 2026-10-22; when the weekly job reports a change, the passages go to the owner, no auto-update. The S23 USB adb drops still cost E2E reruns.

## Public-domain emergency cards 2026-10-21 (evening)

- Done: fire (Ready.gov Home Fires + Wildfires, 12 steps), earthquake (Ready.gov Earthquakes, 14), flood (Ready.gov Floods, 11), water (CDC How to Make Water Safe in an Emergency, 13), verbatim, US-specific passages left out; citation (attribution, title, URL, retrieval date) + no-endorsement statement on each card and in About; `tools/cards-source-check` checks several sources (dated snapshots in `tools/cards-source-check/snapshots/`, `snapshot`/`drift` commands); weekly non-blocking `.github/workflows/cards-sources-drift.yml` (issue on drift); lock covers all sources; blocklist 202 → 199 (3 former texts are verbatim Ready.gov sentences); docs (architecture, legal-research, F-Droid note, README, CHANGELOG); `e2e/run-e2e.ps1` waits for adb after each flow.
- Verified: `pnpm verify` 49/49; cards-source-check 111/111 (IFRC PDF + 5 snapshots) and drift: no drift; Android preview release build (cards gate 12/111, Gradle bundle scan 0/199 unsourced, 111/111 sourced, permission allowlist PASS); desktop `tauri build` MSI + NSIS, dist scan 111/111, Playwright 15/15; Maestro on the S23 (airplane mode, device lock): cards and medical E2E PASS (0 blocked, 0 downloads, 0 bytes); CI on main green incl. iOS Simulator E2E (dispatch 39697366431: 9/9 flows incl. the new public-domain card flow; iOS emergency flow now scrolls past the long earthquake card to Layer 1), Android repro + F-Droid build. Correction (2026-10-22): the drift job run 39671621980 was green but opened issue #4, because cdc.gov answered 403 to the GitHub runner; the report did not say "no drift".
- Open risks: the Ready.gov burn sentence (cool 3–5 min) is left out of the fire card because it conflicts with the IFRC burns card; the CDC dosing tables are not quoted (multi-block), the card says to follow the bleach label; the S23 still drops off USB adb after Maestro sessions.

## Owner follow-ups 2026-10-21 (afternoon)

- Done: `docs/legal-research.md` committed and linked from `docs/architecture.md`; `cards-bundle` matches steps too short for a probe ("Access EMS.") as an exact whole string (parsed Hermes v98 string table, or a whole JS string literal), so release builds require 61/61 sourced steps; the map's compass now starts only with location updates; `e2e/run-map-energy.ps1` + `e2e/map-energy.yaml` + `e2e/energy-sampler.sh` (unplugged map energy, wireless adb).
- Verified: `pnpm verify` 49/49 (release-guards 19 tests, 4 new on real hermesc bytecode); Android preview release build (Gradle cards scan 61/61, permission allowlist pass) + debug build; desktop dist scan 61/61 (desktop sources unchanged, not rebuilt); Maestro on the S23 (airplane mode, device lock): all 9 flows passed with 0 blocked requests and 0 bytes egress (4 re-run after the phone dropped off adb post-flow).
- Measured (S23 unplugged, 15 min per window, brightness 100/255, fix held): map without location 175 mA / 203 mAh/h; follow 292 mA / 333 mAh/h; blackout without location 166 mA / 174 mAh/h; blackout follow 201 mA / 217 mAh/h. GNSS + compass: +117 mA (+131 mAh/h) normal, +35 mA (+44 mAh/h) blackout. Data: `docs/energy/map-2026-10-21/`.
- Open risks: the S23 still drops off adb after flows (cable/port); iOS heading cone needs a real iPhone; IFRC notice email not sent.

## Owner decisions 2026-10-21 (legal/compliance + live map position)

- Done: emergency cards = verbatim IFRC Guidelines 2025 excerpts with citation (8 cards, 61 steps; water purification, earthquake, fire, flood unsourced, never bundled); `tools/cards-source-check` (pinned URL + SHA-256, pdftotext) + `source-check.lock.json`, release gates and `cards-bundle` scan; IFRC notice in About; no AI summary on medical intent; one intended-purpose statement (store, About, README, privacy policy); non-commercial rule (architecture, CONTRIBUTING); "AI-generated summary" line in shared reports; live position/heading/follow on the map (Android + iOS module API, core logic, map UI); `docs/ifrc-notice-email.md` (not sent); F-Droid note for the next version.
- Verified: `pnpm verify` 49/49; cards-source-check 61/61 with Poppler 26.09 and Xpdf 4.06, and in CI on Linux and macOS; gate fails on an altered step (local + CI); Android preview release build (cards gate, bundle 0/202 unsourced, 60/60 sourced, permission allowlist unchanged); desktop `tauri build` MSI + NSIS, bundle scan, tauri-driver smoke 26/26, Playwright 15/15; Maestro on the S23 (airplane mode, device lock): tools, map-location (debug MockLocation), onboarding, ask-en, ask-t1, medical, cards, blackout, places all passed, 0 blocked requests, 0 bytes egress; CI push runs green (incl. ios-build, android-release-guards, android-repro).
- Open risks: IFRC licence is non-commercial (F-Droid NonFreeAssets possible); the S23 dropped off adb after most flows (cable/port) so the suite ran flow by flow; iOS heading cone needs a real iPhone.
- Device testing: S23 (Android) + iOS Simulator in CI (puck with a simulated fix); Windows 11 desktop.

## v0.1.1-preview release (2026-10-17)

- Done: GitHub pre-release https://github.com/anywecon/skepi/releases/tag/v0.1.1-preview (signed APK, MSI, NSIS, `SHA256SUMS.txt`); release notes with hashes; recipe `commit:` = tag hash; fdroiddata MR text.
- Verified: uploaded hashes re-downloaded and checked (APK `b3e35ed4…160e`, MSI `fe562fd9…6fb1b`, NSIS `78f5f56c…93a6`; unsigned `13fdec22…fcdc`); signed APK = unsigned entries + signature; S23 smoke test on the signed APK 8/8 (run 2; run 1 6/8 from a Maestro timeout and an adb server crash); Windows per-user upgrade one install, data kept; after the recipe change `android-repro` + `fdroid-build` again `13fdec22…fcdc` (run 38973901393).
- Open risks: MSI upgrade over 0.1.0 not tested (admin); the adb server on this PC stopped by itself several times on 2026-10-17 (cause unknown); F-Droid reviewers may question the scanignored Hermes compiler and esbuild.
- Device testing: S23 + this Windows 11 PC only.

## v0.1.1-preview prep (closed 2026-10-16, not tagged)

- Done: name decision recorded (Project S.K.E.P.I., no registration, rename risk accepted); visible name "S.K.E.P.I." in the Android label, desktop window/About, store texts, README, privacy policy; versions 0.1.1-preview / vc3; CHANGELOG, `changelogs/3.txt`, fdroiddata recipe, release-notes draft.
- Verified: `pnpm verify` 46/46, Rust fmt/clippy/test, signed preview `assembleRelease`, `tauri build` (MSI + NSIS), Maestro S23 8/8 (airplane mode, device lock), CI run 38947609658 green, `android-repro` + `fdroid-build` same SHA-256 `13fdec22…fcdc` (run 38947609768).
- Open risks: Windows installers keep the product name "SKEPI" (upgrade path); the MSI/NSIS upgrade over an installed 0.1.0 was not run; CI flakes this run (NDK download, iOS WKWebView test timeout) passed on rerun.
- Device testing: S23 only.

## Store readiness part 3 (closed 2026-10-16)

- Done: `fdroid build` in CI gives the same bytes as `android-repro`; JDK 21 toolchain for published builds; per-device lock in every SKEPI device script; Ask store screenshot from the S23 with the model.
- Verified: `pnpm verify` 46/46, Rust fmt/clippy/test, `android-repro` + `fdroid-build` same SHA-256 (at `36d712d`); Maestro on the S23 8/8 in one run (2026-10-16): 0 blocked WebView requests, 0 bytes over real interfaces, SMS hand-off 1, problem-report CHOOSER 1.
- Open risks: the S23 dropped off USB three times in 40 minutes on 2026-10-16 (cable or port); NordVPN on the S23 reconnects by itself (auto-connect); Selis does not take the device lock yet.
- Device testing: S23 only (owner's phone); untethered energy run still owner-only.
