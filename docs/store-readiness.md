# Store readiness — Android (F-Droid and Google Play)

Part 1 (2026-10-12, audited commit `a1681ca`): research only. Part 2 (2026-10-12, below): owner
decisions and the build changes they need. Nothing was submitted and no account was touched in either
part; the release signing config is unchanged.

**Decisions (owner, 2026-10-12)**

- **F-Droid first.** Google Play is deferred to v1; the account type (B4/B5), Play App Signing (B8), IARC
  (§9) and the Health declaration (B4) are decided then. Recorded in `docs/architecture.md`
  (distribution).
- **The signing key never enters CI or the project's Gradle properties** (unchanged). CI builds unsigned;
  the maintainer signs the reproducible CI artifact locally (`docs/release-process.md`).

**Decision (owner, 2026-10-16): name.** The name stays and is always written **Project S.K.E.P.I.**
(initials of Survival Knowledge & Emergency Pocket Intelligence); every store text and the app label say
"S.K.E.P.I.". TMview (2026-10-16) has no "SKEPI"/"ΣΚΕΠΗ" mark; the closest is "SKEP'IA" (SKEZI SAS, FR;
WIPO 1815336 + FR 5030813; EU incl. GR, and CH; classes 9 "AI software for data extraction, filtering and
analysis" and 42; 2024–2034), then "SKEP" (QAD Inc., WIPO 660765, 9/42, 13 countries without GR, expired
2026-09-12, in its grace period), "SKEPIA" (NEVS, SE only), "SKEPP"/"SKEPTIC"/"Skeptify" (EU, further
away) and "SKEPIS" (US filing). No trademark registration is planned; a later rename is an accepted risk.
Identifiers (`org.skepi.app`, the repository, crates, packages, file names, signing) stay as they are
(`docs/architecture.md`, Decisions → Name).

**Part 2 result:** B1, B2, B3 and B6 are done (§1); the reproducible unsigned APK comes from the
`android-repro` CI job; the fdroiddata recipe is updated and linted (§6); AAB and screenshots are done
(§5). Verification at `bbd53be`: `pnpm verify` 46/46; Rust `fmt`, `clippy -D warnings`, `test` (local and
CI `desktop-windows`); signed preview `assembleRelease` (certificate `7d61c382…447e`); Maestro on the S23
in airplane mode 8/8 (problem report CHOOSER intent 1, SMS hand-off 1, 0 bytes over real interfaces,
0 blocked WebView requests); `android-repro` green (run 38301432599).

**Part 3 result (2026-10-13):** `fdroid build` of the recipe runs in CI in F-Droid's buildserver container
and produces the same bytes as `android-repro` (§6); published builds use the JDK 21 toolchain
(`docs/architecture.md`, "Android JDK"); the Ask store screenshot comes from the S23 with the model; every
SKEPI device script takes a shared per-device lock (open items, §5). Verification at `36d712d`: `pnpm verify` 46/46; Rust `fmt`, `clippy -D warnings`, `test` (local and CI); `android-repro` and `fdroid-build` green with the same SHA-256 `36599399…0069` (run 38319568319). Maestro on the S23 (signed preview build, airplane mode, under the device lock): every one of the 8 flows passed on this build, but no single run was clean: run 1 7/8 (blackout) and blackout alone then green, run 2 6/8 (ask-t1, blackout); each failure screenshot shows the Selis app, which another session brought to the foreground on the shared phone while SKEPI held the lock. Both runs: 0 bytes over real interfaces, 0 blocked WebView requests, problem-report CHOOSER 1, SMS hand-off 1.
**Clean run (2026-10-16, same preview build, flows at `794f997`):** Maestro on the S23 in airplane mode under the device lock, `run-e2e.ps1 -MockLocation`: 8/8 in one run, 0 blocked WebView requests, 0 bytes over real interfaces, SMS hand-off 1, problem-report CHOOSER 1. Two flow fixes on the way: the persisted T1-simulation switch, left on by the interrupted ask-t1 run of 2026-10-13, made ask-en wait for an automatic AI summary that T1 does not give (ask-en and store-screenshot-ask now turn it off first); ask-t1 could stop scrolling with "Summarise with AI" under the tab bar (now `centerElement`). Earlier runs that day were cut short by the phone dropping off USB (three times) and by a manual tap on the phone, not by app failures.

**v0.1.1-preview prep (2026-10-16, `a974d92`; not tagged):** versionName `0.1.1-preview`, versionCode 3,
desktop `0.1.1-preview`; the visible name is "S.K.E.P.I." (Android label, desktop window and About,
store texts, privacy policy). The Windows installers keep the Tauri `productName` "SKEPI": it sets the
installer file names, install folder, registry key and WiX upgrade code, so a change would install 0.1.1
next to 0.1.0 instead of over it. Verification: `pnpm verify` 46/46; Rust `fmt`, `clippy -D warnings`
(default and `--no-default-features`), `test`; signed preview `assembleRelease` (label "S.K.E.P.I.",
certificate `7d61c382…447e`); `tauri build` MSI + NSIS (preview-cards guard PASS; upgrade code
unchanged, an upgrade over an installed 0.1.0 was not run); Maestro on the S23 in airplane mode under the
device lock 8/8 (0 blocked WebView requests, 0 bytes over real interfaces, SMS hand-off 1, CHOOSER 1); CI
run 38947609658 green (ios-build rerun after a WKWebView test timeout); `android-repro` (a), (b) and
`fdroid-build` byte-identical, SHA-256 `13fdec22987426743ec6aacaced71a341e0ccb23711c45c0f5fac509ef54fcdc`
(run 38947609768, artifact `skepi-0.1.1-preview-vc3-a974d925a9dc-unsigned`; job (a) rerun after a corrupt
NDK download). The published APK comes from the same jobs at the tag.

**v0.1.1-preview released (2026-10-17):** GitHub pre-release
<https://github.com/anywecon/skepi/releases/tag/v0.1.1-preview>, tag on `a974d925a9dc`. The owner signed the
`android-repro` artifact of run 38947609768 (unsigned `13fdec22…fcdc`) with `sign-release-apk.ps1`; signed
APK `b3e35ed43fd6b29881e35a1d15a92fcd55468d64c091dbb0a5e7d9bf45ca160e` (v2, certificate `7d61c382…447e`,
the unsigned APK's 1349 entries plus signature files only), MSI `fe562fd9…6fb1b`, NSIS `78f5f56c…93a6`
(rebuilt from the tag's tree; installers are not reproducible, so their hashes differ from the prep build).
Uploaded assets re-downloaded and checked against `SHA256SUMS.txt`
(`docs/release-notes/v0.1.1-preview.SHA256SUMS.txt`). Smoke test: the signed APK installed with
`adb install -r` over the installed release on the S23, then `run-e2e.ps1 -MockLocation` (airplane
mode, device lock): run 1 6/8 (ask-en: Maestro's `scrollUntilVisible` timed out with `report-share` on
screen, two slow hierarchy dumps in 10 s; places: the host's adb server died mid-flow, "Connection
reset"), run 2 8/8 with 0 blocked WebView requests, 0 ContentStore downloads, 0 bytes over real
interfaces, SMS hand-off 1, CHOOSER 1. Windows upgrade (per-user): the released 0.1.0-preview
`setup.exe`, then the 0.1.1 `setup.exe` over it, both silent: one uninstall entry (HKCU, 0.1.1-preview),
exe 0.1.1-preview in the same folder, the 7 data files of 0.1.0 (`app.db`, key, catalog, a marker)
unchanged, 0.1.1 starts with the window title "S.K.E.P.I.", one Start menu shortcut "SKEPI". The
installer reused the folder of an earlier desktop E2E install (`HKCU\Software\SKEPI project\SKEPI`), as it
would for a user's earlier install. MSI upgrade not tested (needs administrator rights). Recipe `commit:`
is the tag's full hash; merge request text in `docs/fdroid/merge-request.md` (owner opens it). After the
recipe change, run 38973901393 (`e729f09`): `android-repro` (a), (b) and `fdroid-build` again
`13fdec22…fcdc` (fdroid-build rerun after an apt download error from deb.debian.org).

**F-Droid submission (owner, 2026-10-22):** fdroiddata merge request
<https://gitlab.com/fdroid/fdroiddata/-/merge_requests/53588> "New app: S.K.E.P.I. (org.skepi.app)",
opened 2026-10-22 (GitLab: 2026-10-21 22:06 UTC) from the owner's account, which is not identity-verified
by choice (the MR template allows that); recipe = `docs/fdroid/org.skepi.app.yml` with `AuthorName` and
`AuthorEmail` added. **Status (checked 2026-10-22, public API):** open, labels `New App`,
`waiting-for-upstream`; the MR pipeline did run (2975487569, 2026-10-22 08:23 UTC, after two earlier
ones) and **failed** in three jobs; the other six passed (lint, schema, source check, git redirect,
tools; `check apk` skipped):

| Job | Cause | Fix |
| --- | --- | --- |
| `fdroid rewritemeta` | the build command's line wrap is not fdroid's YAML format | recipe rewrapped as `rewritemeta` writes it (2026-10-22) |
| `checkupdates` | "Couldn't find any version information": `UpdateCheckMode: Tags` reads the Gradle files, and the version lives in `apps/mobile/app.json` | `UpdateCheckData: apps/mobile/app.json\|"versionCode":\s*(\d+)\|.\|"version":\s*"([^"]+)"`; local `fdroid checkupdates` (fdroidserver 2.4.5) now finds 0.1.1-preview (3) and 0.1.0-preview (2), the old recipe gives the same error as the MR |
| `fdroid build` | F-Droid's build of the tag is **byte-identical** to our CI artifact (`13fdec22…fcdc`), but our signature cannot be copied onto it: "APK Signature Scheme v2 signer #1: APK integrity check failed. CHUNKED_SHA512 digest mismatch". The published APK (`b3e35ed4…160e`) has the same 1349 entries, but `apksigner` re-aligned every entry while signing (alignment extra fields of 6 instead of 2 bytes from byte 285 on), so it is not "the unsigned APK plus a signing block" | `sign-release-apk.ps1` signs with `--alignment-preserved true` and checks the new `apk-compare.py copyable` (the apksigcopier condition). Dry run with the Android debug key on F-Droid's own build: copyable, and `apksigcopier compare` 1.1.1 passes; on the published APK both fail with F-Droid's exact error. **The v0.1.1-preview APK on GitHub can never pass:** the owner re-signs and publishes (§ below) |

The CI job `fdroid-build` now also runs `fdroid rewritemeta` (no diff allowed), `fdroid lint` and
`fdroid checkupdates` on the recipe as submitted.

**Review (Licaon_Kter, 2026-10-22):** "get esbuild from Debian or build it". Done in the recipe: esbuild
0.28.2 from fdroiddata's srclib (§6). Proof: `android-repro` dispatched with `app_commit` =
`a974d925a9dc…` and this recipe (run 39762528408): `android-repro` (a), (b) and `fdroid-build` all
`13fdec22…fcdc`, the scanner removed the prebuilt esbuild, `fdroid scanner --exit-code` on the APK clean.
The owner pushes the recipe to the MR branch and replies with the text in `docs/fdroid/merge-request.md`.

**v0.1.2-preview published (owner, 2026-10-22):** GitHub pre-release
<https://github.com/anywecon/skepi/releases/tag/v0.1.2-preview> (20:50 UTC), tag on
`4af3b0c43daf6078abe46163d80d6daf18700e89`; signed APK `skepi-0.1.2-preview-arm64.apk`
`80fd1071905978cfa67a7bd96e97b77177ab71d6c66a63163820a355921ac628` (signed with `--alignment-preserved`
from the CI artifact `9857b660…12c1`, run 39778296502); `check-fdroid-signature-copy.ps1` on the asset
downloaded back from the release: **PASS**. Before publishing it passed the full Maestro suite on the S23
(9/9, airplane mode).

**MR 53588 updated (owner, 2026-10-23):** MR branch commit `db01bb98` with the 0.1.2-preview recipe
(`docs/fdroid/org.skepi.app.yml`, file SHA-256 `06ae193c…`) and the MR description from
`docs/fdroid/merge-request.md`.
**Review (Licaon_Kter, 2026-10-22 12:25 UTC):** asked whether both `SKEPI_PREVIEW=1` and `-PskepiPreview=true` are
needed. Owner's answer: only the environment variable changes the build (Metro bundles the preview cards
entry and the preview label from it); the Gradle property is a guard that fails the build when it is set
without the variable (`apps/mobile/plugins/withEmergencyCards.js`), and the owner offered to drop it.
**Pending the reviewer's reply.** If the reviewer wants it dropped: remove `-PskepiPreview=true` from the
recipe's `build:` line only after an `android-repro` dispatch with the changed recipe shows `fdroid-build`
still at the current unsigned SHA-256, `a99ed9da81c1440fa9962acb06a8a973e5d88ce580a0259c9345444b4f36e74a`.

**v0.2.0-preview published (owner, 2026-10-25):** GitHub pre-release
<https://github.com/anywecon/skepi/releases/tag/v0.2.0-preview> (12:51 UTC), tag on
`4faad7c0e9cdd3fcf0994b95a56abd3e8c471f82`; signed APK `skepi-0.2.0-preview-arm64.apk`
`b6bebe1e96d927932fba8f12e4ce8507ec1b0ec99c0f8e523a94ccd5c671102b` (from the CI artifact
`a65f6124…f70d`, `android-repro` run 40140411948, where `fdroid-build` gave the same bytes), MSI
`74c13ef63b0fe20cb8b741a16798084814cee9bd0da1c6387d3b77da6b3bc75a`, NSIS
`93f9c92ee46e2fce799fea8cd183e81e8de8ae25466c17eadab1ec2e15a1d416`; `check-fdroid-signature-copy.ps1` on the
asset downloaded back from the release: **PASS**. Before publishing, the signed APK was installed over
0.1.2-preview on the S23 and passed the full Maestro suite (9/9, airplane mode) and the countries flow.
The pack release `packs-20261024` (547 assets, every country) was published first (12:13 UTC).

**MR 53588 updated (owner, 2026-10-25):** MR branch commit `372cc28c` with the 0.2.0-preview recipe
(`docs/fdroid/org.skepi.app.yml`: one build, versionCode 5, commit `4faad7c0e9cd…`, file SHA-256
`159feda9921c113e561a31794dde3feae9d7276754d6a8d1f32a62989b4d694c`) and the updated description. Pipeline
3008933505 on that commit passed on 2026-10-30.

**v0.2.1-preview published (owner, 2026-11-05):** GitHub pre-release
<https://github.com/anywecon/skepi/releases/tag/v0.2.1-preview> (16:16 UTC), versionCode 6, tag on
`ebd321e03bdb65ee118e4ba592218e90e50514b2`; signed APK `skepi-0.2.1-preview-arm64.apk`
`a1c29b0505d399cbd8a7731aefcd250487bf51ca955c0a05540df8e0bd4c7761` (from the CI artifact `a99ed9da…e74a`,
`android-repro` run 41948574811, where `fdroid-build` gave the same bytes), MSI
`eabc6a7f6e98841730589d46ff3579862eedc8d993a4f1acb9bd13cf6e26701b`, NSIS
`06b6966afe61fd77530664430e71cb6449822b64e281cf1dff150c2e43c41fb9`; `check-fdroid-signature-copy.ps1` on the
asset downloaded back from the release: **PASS**. Before publishing, the signed APK was installed over
0.2.0-preview on the S23: `onboarding`, `ask-en`, `ask-t1`, `medical`, `cards`, `blackout` and `places` passed
on it, `tools` and `map-location` on the debug build (airplane mode). `countries` was blocked locally by
Norton's TLS interception and accepted for this release. No pack release: the catalog and packs are unchanged.

**MR 53588 status (checked 2026-11-05, public GitLab data):** open, labels `New App`,
`waiting-for-upstream`. The owner updated the MR branch to 0.2.1-preview on 2026-11-05: commit `b879aa18`,
recipe byte-identical to `docs/fdroid/org.skepi.app.yml` (file SHA-256
`c62ab5d70dfcbac92cfcb7d8c002ab1f2ca4edadd7a337364ba81e714e601c5e`), reply in the thread; pipeline 3032936740
was running at this check. The MR's description still says 0.2.0-preview. Last reviewer note: 2026-10-22 12:25
UTC (the `-PskepiPreview=true` question above); the owner's later notes have no reply yet.

Status legend: **ready** · **blocked** (a repo change is needed first) · **owner** (needs an owner
decision or account action).

## 1. Findings that block or shape a submission

| # | Finding | Store | Status | Proposal |
| --- | --- | --- | --- | --- |
| B1 | A release build cannot be produced **unsigned**: without the four `SKEPI_RELEASE_*` properties it fails (`skepiCheckReleaseSigning`), and the only escape hatch signs with the debug key. F-Droid builds an unsigned APK and then either signs it or copies the upstream signature onto it. | F-Droid | **done** | `-PskepiUnsigned=true` in `withReleaseSigning.js`: release `signingConfig null`, a loud warning, exclusive with `-PskepiDebugSign`; without it the build stays fail-closed and the signed path is unchanged. Output `app-arm64-v8a-release-unsigned.apk`; CI builds only unsigned. |
| B2 | Expo modules are linked as **prebuilt AARs** from `node_modules/*/local-maven-repo` (11 `host.exp.exponent:*` artifacts on the release classpath). F-Droid requires binaries built from source (or from an allowed repository); `node_modules` is not one. | F-Droid | **done** | `buildFromSource: [".*"]` in `apps/mobile/package.json`, every build. `releaseRuntimeClasspath` before/after: the 15 prebuilt Expo artifacts (11 `host.exp.exponent:*`, 4 `expo.modules.*`) became the 15 `project :expo-*` modules of the same versions; the other 375 entries (all third-party Maven modules) are unchanged. |
| B3 | Release APKs are **not reproducible across checkout paths**: 18 of 1349 entries differ, all native libraries built in the build (build-id, absolute `__FILE__` paths, one link-order difference). Java/Kotlin, resources and the JS bundle are identical (§4). | F-Droid (reproducible, our signature) | **done** | `plugins/reproducible.cmake` for every CMake build (`--build-id=none`, `-ffile-prefix-map`; Reanimated without ThinLTO); two clean builds in different paths are byte-identical, locally and in CI (`android-repro`, §4). |
| B4 | The Health apps declaration must be accurate: SKEPI ships medical reference content (WikiMed packs) and emergency cards/numbers, i.e. the **Medical** group ("Medical Reference and Education", "Emergency and First Aid"). Play Console requirements list "Health apps, such as Medical apps" among the services that must register as an **Organization** account (D-U-N-S number). | Play | deferred (v1) | Decide the account type before creating it. A personal account would have to declare no health features, which would be inaccurate. Verify the exact trigger in Play Console when registering. |
| B5 | New **personal** accounts (created after 2023-11-13) must run a closed test with ≥ 12 testers opted in for 14 consecutive days before production access. | Play | deferred (v1) | Only if a personal account is chosen (see B4). Recruit 12 testers (e.g. from the GitHub preview) before the first upload. |
| B6 | **AI-Generated Content** policy: apps that generate content from user prompts must let users report offensive content "to developers without needing to exit the app". "Report a problem with this answer" only copied or saved text. | Play | **done** | The panel takes the user's text; "Send…" hands the report (question, what was shown, sources, app version, the user's text) to the system share sheet (`Share.share` → `ACTION_SEND` chooser, subject "Problem report (SKEPI <version> (Android))"). No permission, no network; the hint names github.com/anywecon/skepi/issues. Unit tests (`packages/core/test/report.test.ts`), Maestro step in `ask-en.yaml` + CHOOSER intent check in `run-e2e.ps1`. |
| B7 | Play delivers split APKs from an AAB. The app already refuses to share itself from a split install (`ERR_P2P_APK`), so "share the app" does not work in the Play build; packs still share. | Play | ready (documented) | Mention in the Play listing or the share screen later; no change needed for submission. |
| B8 | **Play App Signing** is mandatory for new apps. If Google generates the app signing key, Play installs carry a different certificate than GitHub/F-Droid builds: users cannot move between channels without uninstalling, and the fingerprint in About (`ANDROID_RELEASE_SIGNING_SHA256`) and the Station check would not match the Play install. | Play | deferred (v1) | Proposal unchanged: upload the existing SKEPI release key to Play App Signing (PEPK export) so every channel shares one certificate, with a separate upload key. Google then holds a copy of the key: owner decision at v1. |
| B9 | **Android developer verification**: from 2026-09-30 certified devices in Brazil, Indonesia, Singapore and Thailand install only apps from verified developers; global in 2027. This covers the GitHub APK and F-Droid installs too. | All | owner (roadmap, before 2027) | Register `org.skepi.app` and its signing certificate (Play Console registers Play apps and can register apps distributed outside Play). F-Droid publicly opposes the programme; a reproducible build (F-Droid publishing our signed APK) keeps one registered certificate. |

No Google Play Services, Firebase, analytics, ads or other proprietary SDK was found (§3). No
`fdroid` flavor is needed for dependencies; B1–B3 are build changes for all channels, not a flavor.

## 2. Checklist per store

### F-Droid

| Item | Status | Evidence / note |
| --- | --- | --- |
| FOSS licence | ready | GPL-3.0-or-later (`LICENSE`); all runtime dependencies are FOSS (§3) |
| No non-free dependencies (Play Services, Firebase, tracking, ads) | ready | Release runtime classpath audit (§3): none |
| Binary dependencies from source or allowed repositories | ready | Expo modules from source (B2); the rest are freely licensed Maven Central / Google Maven AARs (§3). `fdroid scanner` on the unsigned APK: no known non-free classes, no extra signing blocks |
| Prebuilt files in `node_modules` that the build does not use | ready (scanner run in CI) | `scandelete: node_modules` with the build-time tools and Gradle files the build needs scanignored (§6); the fdroid-build job runs the real scanner on every relevant change |
| llama.cpp native code | ready | Compiled from source (`rnllamaBuildFromSource=true`); APK has only the 3 CPU variants built by CMake |
| Toolchain on the Debian buildserver | ready (built in CI) | Node from forky (24.21.0, `sudo:`), pnpm 10.33.0 from npm, OpenJDK 21 with `scripts/android/jdk21.sh` + `-PskepiJdk21=true`, NDK 27.1.12297006, CMake from the SDK; exercised by the fdroid-build job in F-Droid's buildserver container (§6) |
| Unsigned release build | ready | `-PskepiUnsigned=true` (B1) |
| Reproducible build (publish our signed APK via `Binaries:` + `AllowedAPKSigningKeys:`) | ready (`fdroid build` gives the same bytes) | Byte-identical across paths, Gradle homes and runners (§4); `fdroid build` in the buildserver container compared with `android-repro` (§6) |
| Anti-features | ready | None expected: no tracking, ads or non-free assets; content hosts (Kiwix, Hugging Face, GitHub) serve freely licensed files, and every pack can also come from import or P2P, so the app does not "depend entirely" on a non-free service (NonFreeNet). Disclose the download hosts in the submission |
| Metadata | ready | `fastlane/metadata/android/en-US/` (title "S.K.E.P.I. Offline Survival", short and full description, `changelogs/2.txt` and `3.txt`, 6 phone screenshots; none shows the product name, so the rename needed no new ones); icon and feature graphic still to add (§5) |
| Version scheme | ready | Tags `v<version>`, versionCode in `apps/mobile/app.json` (2 for `v0.1.0-preview`, 3 for `v0.1.1-preview`, 4 for `v0.1.2-preview`, 5 for `v0.2.0-preview`, 6 for `v0.2.1-preview`); a recipe pins the full commit hash |
| fdroiddata recipe | owner | Submitted 2026-10-22: merge request [53588](https://gitlab.com/fdroid/fdroiddata/-/merge_requests/53588), open. First pipeline failed (rewritemeta, checkupdates, signature copy of the v0.1.1-preview APK, see "F-Droid submission" above); v0.1.2-preview published 2026-10-22 with a copyable signature (check PASS on the downloaded asset); MR branch updated 2026-10-23 with the 0.1.2-preview recipe (commit `db01bb98`, file SHA-256 `06ae193c…`); open review question on `-PskepiPreview=true`, waiting for the reviewer (last reviewer note 2026-10-22); v0.2.0-preview published 2026-10-25 (signature copy PASS on the downloaded asset), MR branch updated 2026-10-25 with the 0.2.0-preview recipe (commit `372cc28c`, file SHA-256 `159feda9…`); v0.2.1-preview published 2026-11-05 (versionCode 6, commit `ebd321e03bdb`, signature copy PASS on the downloaded asset), MR branch updated 2026-11-05 with the 0.2.1-preview recipe (commit `b879aa18`, file SHA-256 `c62ab5d7…`) |

### Google Play (deferred to v1)

Kept for v1; only the AAB and B6 changed in part 2.

| Item | Status | Evidence / note |
| --- | --- | --- |
| Target API level | ready | targetSdk 36 (`aapt2 dump badging`); required ≥ 36 for new apps and updates since 2026-08-31 |
| 16 KB page size | ready | All 39 native libraries have 16 KB (`0x4000`) LOAD alignment (`llvm-readelf`), `zipalign -c -P 16` passes |
| 64-bit | ready | arm64-v8a only (ABI split); no 32-bit code |
| AAB | ready | `bundleRelease -PskepiUnsigned=true` builds an arm64-only AAB (90.7 MB). Found and fixed on the way: ABI splits do not apply to bundles, so the AAB carried armeabi-v7a/x86/x86_64 copies of 20 prebuilt libraries (React Native, Hermes, libzim, MapLibre, …) without the app's own native code, and Play would have served those devices a crashing split; bundle tasks now turn the split off and filter to arm64-v8a (APK builds unchanged). bundletool 1.18.3: `validate`, `build-apks` (debug key, for the test only), `install-apks` on the `skepi-host` emulator (base + `arm64_v8a` + `xxhdpi` splits). Maestro on that install, airplane mode: `store-screenshots.yaml` (home, search, article, Ask with sources, map, tools), `cards.yaml`, `places.yaml` pass, 0 blocked WebView requests, 0 bytes over real interfaces; `onboarding.yaml` stops at its S23-specific tier assertion (`onboarding-tier-T2`; the emulator has 2 GB RAM). Not installed on the S23 (it would replace the release install and its data) |
| Developer account type, closed test | owner | B4, B5 |
| Play App Signing key | owner | B8 |
| Privacy policy URL | owner | `docs/privacy-policy.md`; public URL: `https://github.com/anywecon/skepi/blob/main/docs/privacy-policy.md` (repo is public) or GitHub Pages (not enabled; owner) |
| Data safety form | ready | Answers in §7 |
| Health apps declaration | owner | B4: declare Medical → Medical Reference and Education, Emergency and First Aid; description carries the required disclaimer |
| Health Content and Services policy | ready | Listing says "not a medical device and does not diagnose, treat, cure, or prevent any medical condition" and to consult a healthcare professional; no medical claims; "not for emergency use" |
| AI-Generated Content policy | ready | B6 (share sheet) |
| Permissions | ready | None needs a Play declaration form (§8) |
| Content downloaded after install | ready | Packs are data (ZIM, GGUF weights, PMTiles, SQLite); no dex/JAR/`.so` is downloaded; ZIM JavaScript is never run (sealed viewer). The Device and Network Abuse policy forbids downloading executable code only |
| Self-update / installing APKs | ready | No self-update, no `REQUEST_INSTALL_PACKAGES`; the APK share page is disabled on split (Play) installs (B7) |
| Content rating (IARC) | owner | Suggested answers in §9 |
| Target audience | owner | Suggest 18+ for the Developer Preview (medical content, AI summaries; keeps the app out of the Families policy) |
| Ads declaration | ready | No ads |
| Store listing text | ready | `fastlane/metadata/android/en-US/` (title 27/30, short 80/80, full 3160/4000 characters); graphics still to add (§5) |
| Developer verification | owner | B9 (roadmap, before 2027) |

## 3. Dependency audit (release runtime classpath)

`gradlew :app:dependencies --configuration releaseRuntimeClasspath` at `a1681ca`: 213 modules.
Search for `com.google.android.gms`, `com.google.firebase`, `com.google.android.play`, `com.google.mlkit`,
`installreferrer`, analytics/crash SDKs, Huawei HMS: **no match**. The only `com.google.*` modules are
open-source libraries (Material Components, Guava, Gson, ZXing core, Error Prone and JSR-305 annotations,
AutoValue annotations). The QR scanner uses CameraX + ZXing (no ML Kit); location uses the platform GPS
provider (no fused location).

Prebuilt native code in the release APK (39 libraries) and its origin:

| Library | Origin | Licence | F-Droid view |
| --- | --- | --- | --- |
| `libkiwix.so`, `libzim.so` (+ wrappers) | `org.kiwix:libkiwix:2.6.0`, Maven Central (official Kiwix build) | GPL-3.0 / GPL-2.0+ | allowed repository, FOSS |
| `libmaplibre.so` | `org.maplibre.gl:android-sdk-opengl:13.6.1`, Maven Central | BSD-2-Clause | allowed repository, FOSS |
| `libcrypto.so` (SQLCipher's OpenSSL) | `io.github.ronickg:openssl:3.3.2-1`, Maven Central | Apache-2.0 | allowed repository, FOSS; reviewers may ask for a source build |
| `libreactnative.so`, `libhermesvm.so`, `libjsi.so`, `libfbjni.so`, Fresco image libraries | `com.facebook.react:react-android`, `hermes-android`, Fresco, Maven Central | MIT | allowed (Hermes named in the inclusion policy) |
| `libzstd-kmp.so`, CameraX JNI, `libandroidx.graphics.path.so` | Maven Central / Google Maven | Apache-2.0 | allowed |
| `librnllama*.so` | llama.cpp compiled from source in the build | MIT | source-built |
| `libop-sqlite.so`, `libexpo-modules-core.so`, `libappmodules.so`, `libreanimated.so`, `libworklets.so`, screens/gesture-handler/codegen libraries | compiled from source in the build | MIT | source-built |

## 4. Reproducible build

**Result (part 2): reproducible.** Every CMake build loads `apps/mobile/plugins/reproducible.cmake`
(`CMAKE_PROJECT_INCLUDE`): `-Wl,--build-id=none`, `-ffile-prefix-map` for the checkout, the Gradle user
home and the NDK, and Reanimated without ThinLTO. Two more sources of difference were found and fixed
along the way:

| Difference | Cause | Fix |
| --- | --- | --- |
| `libappmodules` + 3 codegen libraries kept Gradle-home paths | React Native's root plugin evaluates `:app` before the root build script ends, so the root `subprojects` block never reached the app module | `app/build.gradle` sets the same CMake arguments itself (`withSkepiAndroid.js`) |
| `libreanimated.so`: same strings, different order of RTTI names and code | Reanimated compiles with `-flto=thin`; ThinLTO identifies modules by object file path, and CMake names the objects of sources outside the project directory (`../Common/cpp`) after their absolute path | `-fno-lto` for the Reanimated project only (+64 KB APK) |
| `resources.arsc` (CI only: two runners) | The React Native Gradle plugin writes the build host's first IPv4 address into `react_native_dev_server_ip` | `reactNativeDevServerIp=localhost` in `gradle.properties` |

| Run | Setup | Result |
| --- | --- | --- |
| Local (Windows 11, JDK 17.0.19) | Two clean clones of `8ef52ff`'s tree at `%TEMP%/skepi/rb2/a` and `…/build-bb`, separate Gradle user homes (`~/.gradle`, `…/gh-b`), `--no-build-cache`, built in parallel (41.5 and 46 min) | Before the app/Reanimated fixes: 5 entries differed (above); after them: **byte-identical**, SHA-256 `a662186075ff72d1…c791` |
| CI run 38295601966 (`8ef52ff`) | `android-repro`: two Ubuntu 24.04 runners, checkouts `a` and `build-bb/second-checkout`, Gradle homes `~/.gradle` and `~/gradle-home-bb`, no build cache, no ccache | All 1348 other entries identical, including every native library; `resources.arsc` differed (dev-server IP) |
| CI run 38301432599 (`bbd53be`, main) | same | **byte-identical**: SHA-256 `5f166f8071bd52ac810c1c9ab2d0324cbf8e8305ef2f0c9c722df51b2453d17c` (`skepi-0.1.0-preview-arm64-unsigned.apk`, artifact `skepi-0.1.0-preview-vc2-bbd53bedcdaf-unsigned`) |

The `android-repro` job also checks that the APK carries no signature and reports any native library that
still contains a checkout or Gradle-home path. The F-Droid buildserver is a third environment (Debian,
`/home/vagrant`, possibly another JDK; §6).

**Build tools from source (2026-10-22).** The recipe builds esbuild 0.28.2 from fdroiddata's srclib
instead of using the prebuilt `@esbuild/linux-x64` (§6). esbuild only runs at build time (tsx, for the
catalog, card and bundle checks) and writes nothing into the APK; `android-repro` (dispatch with
`app_commit` = `a974d925…`, run 39762528408) and `fdroid-build` with the new recipe both give the published
unsigned bytes `13fdec22…fcdc` again. `android-repro` itself still uses the npm esbuild binary (same
version, same output).

### Part 1 (before the fix)

**Result: not reproducible across checkout paths yet.** Two release builds from clean clones of
`a1681ca` (fresh `pnpm install --frozen-lockfile`, `expo prebuild --clean`, `SKEPI_PREVIEW=1 gradlew
--no-build-cache assembleRelease -PskepiPreview=true -PskepiDebugSign=true`; JDK 17.0.19, NDK 27.1/27.3,
Windows 11), the same machine and user, checkout paths `%TEMP%/skepi/rb/a` and
`%TEMP%/skepi/rb/build-bb`. Debug-signed so the release key was not used; the comparison ignores the
signature (F-Droid copies it onto its unsigned build). Builds took 21.6 and 24.1 min.

| | Result |
| --- | --- |
| APK entries, names and order | 1349 = 1349, same order |
| Identical entries | 1331, including every `classes*.dex`, `resources.arsc`, resources, `assets/index.android.bundle`, the embedded catalog, map assets and `assets/dexopt/baseline.prof(m)` |
| Differing entries | 18, all native libraries compiled in the build (prebuilt Maven libraries are identical) |
| — only `.note.gnu.build-id` differs (12) | `libappmodules`, `libexpo-modules-core`, `libgesturehandler`, `libop-sqlite`, `libreact_codegen_rngesturehandler_codegen`, `libreact_codegen_safeareacontext`, `librnllama_jni` (4 variants), `librnscreens`, `libworklets`: identical after `llvm-objcopy --remove-section=.note.gnu.build-id` |
| — absolute source paths embedded (5) | `librnllama` (4 CPU variants; ~210 `__FILE__` strings such as `…/rb/a/node_modules/llama.rn/cpp/common/chat-peg-parser.cpp`) and `libreact_codegen_rnscreens` (`RNSScreenShadowNode.cpp`); sizes differ |
| — layout only (1) | `libreanimated`: same strings, different order of RTTI names and relocations; cause not isolated (a same-path rebuild was byte-identical in the preview release, `docs/preview-report.md`) |
| Also machine-specific, identical here only because the user was the same | the Gradle cache path `C:/Users/<user>/.gradle/caches/…/react-android…` inside `libappmodules` and the codegen libraries (F-Droid builds in `/home/vagrant`, GitHub CI in `/home/runner`) |

**Proposed fix (part 1; implemented in part 2, above).** In
`withSkepiAndroid.js`, for every subproject with CMake (same pattern as the existing `subprojects`
block): `-DCMAKE_SHARED_LINKER_FLAGS=-Wl,--build-id=none` and C/C++ flags
`-ffile-prefix-map=<repo root>=. -ffile-prefix-map=<Gradle user home>=/gradle`; for llama.rn check that
its CMake does not override them. Then repeat this two-path comparison, and once it is identical, build
the published APK on Linux CI (same NDK as the F-Droid buildserver) at the tagged commit; the Windows host
toolchain is a second variable that a Linux-to-Linux comparison avoids. Until then the F-Droid fallback
is an F-Droid-signed build (different certificate, see B8/B9).

Tools: `apksigcopier` 1.1.1 (F-Droid's signature copier, installed for the check), a per-entry ZIP
comparison and `llvm-objcopy`/`llvm-readelf` from NDK 27.3 (diffoscope is not available on Windows).

## 5. Still to prepare

- Graphics: `fastlane/metadata/android/en-US/images/icon.png` (512×512) and `featureGraphic.png`
  (1024×500). **Phone screenshots: done** (`fastlane/metadata/android/en-US/images/phoneScreenshots/`: `1_home`, `2_search`, `3_article`, `5_map`, `6_tools` at 1080×2400 from `e2e/store-screenshots.yaml` on the `skepi-host` emulator (preview build installed from the AAB, airplane mode, demo-mode status bar); `4_ask_sources` at 1080×2340 from `e2e/store-screenshot-ask.yaml` on the S23 (release build, airplane mode, "How does a water filter work?": a Layer 1 source excerpt, then the labelled AI summary with its citation chip; Samsung ignores the demo-mode status bar, so the phone's own status icons show; retaken 2026-10-16 with the phone's VPN off, so only the mute, airplane and battery icons show). Card titles show "Draft", no card steps anywhere.)
- Privacy policy public URL (§2, Google Play; v1).
- **AAB: done** (§2, Google Play).
- A first test of the recipe on the F-Droid buildserver (§6).

### Open items

- **Shared-device incident (2026-10-12).** During the part 2 verification another Claude session (project
  Selis) ran its Maestro suite on the same S23 at the same time. Every SKEPI flow but one failed with
  "Maestro Android driver did not start up in time", and SKEPI's session then ran `am force-stop` on the
  Maestro driver app (`dev.mobile.maestro`, `dev.mobile.maestro.test`) on the S23 while Selis's
  `transfer.sh` was using it, which may have interrupted the Selis run. No Selis process was killed; the
  SKEPI suite passed 8/8 once the phone was free. Since part 3 every SKEPI device script takes a per-device
  lock (`scripts/device-lock.ps1`, `%LOCALAPPDATA%\device-locks\`) and refuses a device that another
  process drives, and the owner's global instructions forbid stopping another session's app, Maestro or
  process. On 2026-10-13 (01:22) a Selis Maestro run started on the S23 while SKEPI held the lock (Selis
  does not take it yet) and SKEPI's screenshot run failed; SKEPI stopped nothing and waited for the phone.
  Open: the Selis run of late 2026-10-12 should be checked (owner), and Selis's own scripts should take
  the same lock (`device-lock.ps1 acquire/release`).

## 6. fdroiddata recipe (submitted 2026-10-22, merge request 53588; `fdroid build` in CI gives the published bytes)

The recipe lives in `docs/fdroid/org.skepi.app.yml` (copied below). Since 2026-11-10 it is a **draft** for
`v0.2.3-preview`, versionCode 8, one build: `commit:` is `1e5f54cca3679f3a7e4f718d55b64e02f315412b` (to be
tagged by the owner); `android-repro` run 42752077871 at that commit: (a), (b) and `fdroid-build` all
`4a86b9af06bf8b646ff1bbbc57b77bc8d22ecff61eaaebff3c110c095e655698`. `v0.2.2-preview` (versionCode 7, commit
`1602ae71d7d3`, unsigned `02364b1c…5e98`, run 42726446303) was not released: an upgrade regression was found
before publishing and its tag was deleted. MR 53588 still carries the 0.2.1-preview file until the owner
updates it. From 2026-11-04 to 2026-11-10 it targeted `v0.2.1-preview`, versionCode 6: `commit:` was
`ebd321e03bdb65ee118e4ba592218e90e50514b2` (the tag, pushed 2026-11-05); `android-repro` run 41948574811: (a),
(b) and `fdroid-build` all `a99ed9da81c1440fa9962acb06a8a973e5d88ce580a0259c9345444b4f36e74a`
(`scripts/ci/fdroid-build.sh` expects one build in the recipe). MR 53588 carries that file since 2026-11-05
(`b879aa18`). From 2026-10-25
to 2026-11-04 it targeted `v0.2.0-preview`, versionCode 5: `commit:` was
`4faad7c0e9cdd3fcf0994b95a56abd3e8c471f82`, `android-repro` run 40140411948, (a), (b) and `fdroid-build` all
`a65f61242952bea358ce73c5e1d3c54ab002102566cbfa7cd4a06fd4f95df70d`. From 2026-10-22 to 2026-10-25 it targeted
`v0.1.2-preview`, versionCode 4, with one build only (F-Droid builds the latest): `commit:` was
`4af3b0c43daf6078abe46163d80d6daf18700e89`, the commit to tag `v0.1.2-preview` (owner decision 2026-10-22: the
`v0.1.1-preview` APK could not pass F-Droid's signature copy, see "F-Droid submission" above). CI at that
commit (run 39778296502): `android-repro` (a), (b) and `fdroid-build` all give the unsigned SHA-256
`9857b660808d9c5e1f53a3d1bfcd185a7489b8a0b2ded6ff04b1f7c1e9ad12c1`. Before, it targeted `v0.1.1-preview` (versionCode 3,
`a974d925a9dc…`); `v0.1.0-preview` cannot be built unsigned. The merge request text is in
`docs/fdroid/merge-request.md`.

**Part 3: `fdroid build` in CI.** Job `fdroid-build` (`.github/workflows/android-repro.yml`,
`scripts/ci/fdroid-build.sh`; on `workflow_dispatch` and on changes to `docs/fdroid/**`, the Android build
inputs and the lockfiles) runs `fdroid build --test --refresh-scanner --on-server` of this recipe at the
current commit inside `registry.gitlab.com/fdroid/fdroidserver:buildserver-trixie`, the way fdroiddata's
own CI job does (Debian trixie, OpenJDK 21, fdroidserver pinned to the commit fdroiddata uses, the build as
user `vagrant`, the source checked out by `fdroid fetch_repo`). The CI copy of the recipe only swaps in the
commit and the version from `app.json` and drops `Binaries:`; the job then compares the unsigned APK with
`android-repro`'s artifact of the same run.

What the buildserver run changed in the recipe and the build:

| Finding | Change |
| --- | --- |
| `subdir: apps/mobile/android/app` fails before `init` ("Missing subdir"): fdroid checks the subdir right after the checkout, and `android/` is generated by `expo prebuild` | `subdir: apps/mobile`; `build:` runs Gradle in `android/`; `output:` relative to `apps/mobile` |
| `pnpm install --filter …` installs the same 544 packages as a plain install (`nodeLinker: hoisted`) | plain `pnpm install --frozen-lockfile` |
| The scanner (fdroidserver's `scan_source`, run locally on a clean checkout and then for real in CI) flags ~100 files in `node_modules`: Expo's unused `local-maven-repo` AARs, prebuilt binaries (dotslash, turbo, playwright, node-llama-cpp, esbuild, React Native's fbt packs), iOS xcframework archives, and `unknown maven repo` lines in four libraries' Gradle files | `scandelete: node_modules` (flagged files are deleted; the build uses none of them); `scanignore` for what the build runs or reads: Hermes's compiler and the four Gradle files; `scandelete: tools/rag-eval/parity-reference` (eval data, gzip). esbuild: built from source since 2026-10-22 (next row) |
| fdroiddata review of MR 53588 (2026-10-22): "get esbuild from Debian or build it" | `srclibs: - esbuild@v0.28.2` (fdroiddata's `srclibs/esbuild.yml`, `https://github.com/evanw/esbuild.git`; 0.28.2 is the only esbuild in `pnpm-lock.yaml`, tsx 4.23.15's), Debian's `golang-go` in `sudo:`, `go build -C $$esbuild$$ ./cmd/esbuild` and `export ESBUILD_BINARY_PATH=$$esbuild$$/esbuild` in the Gradle build's shell; `@esbuild/linux-x64` left the scanignore list, so scandelete removes the prebuilt ("Removing binary at node_modules/@esbuild/linux-x64/bin/esbuild"). Debian forky's `esbuild` package is also exactly 0.28.2-1 (trixie: 0.25.5), but forky is testing and may move on before a rebuild; the srclib pins the tag (`609683d8`). CI: `fdroid-build` fetches the srclib definition from a pinned fdroiddata commit (SHA-256 checked), runs `fetchsrclibs` like fdroiddata's CI, fails if the prebuilt was not removed, and runs `fdroid scanner --exit-code` on the APK; run 39762528408 (tag commit, new recipe): `13fdec22…fcdc`, identical to `android-repro` (run 39757723717 built the same bytes and failed only at the scanner step: `--on-server` uninstalls sudo) |
| MapLibre's `build.gradle` names `play-services-location` (only for its non-default Google location engine) | `prebuild` deletes that line |
| The `ndk:` list is read as one string by the pinned fdroidserver | `ndk: 27.1.12297006`, the only NDK the build uses (every module takes the root `ndkVersion`) |
| Debian trixie has no JDK 17; React Native and Expo request a JDK 17 toolchain | `scripts/android/jdk21.sh` + `-PskepiJdk21=true` (`docs/architecture.md`, "Android JDK"); `android-repro` builds the same way |
| llama.rn's OpenCL/Hexagon variant links the prebuilt `libOpenCL.so` stub that `scandelete` removes | only the four packaged llama.rn variants are built (CMake `targets`) |
| Node | forky's `nodejs` (24.21.0) on the buildserver; `android-repro` pins Node 24.21.0 |

Results:

| Check | Result |
| --- | --- |
| `fdroid lint` (fdroidserver 2.4.5, fdroiddata category names) | clean |
| `fdroid scanner` on the unsigned APK | no known non-free classes, no extra signing blocks; since 2026-10-22 run by `fdroid-build` on every build (`--exit-code`) |
| `fdroid build` in the buildserver container | passes at `36d712d` (run 38319568319, job `fdroid-build`): the scanner deletes 150 flagged files under `node_modules` and ignores the 8 listed; Gradle `BUILD SUCCESSFUL in 19m 23s` |
| fdroid-build APK vs `android-repro` | **byte-identical**: `org.skepi.app_2.apk` and `android-repro`'s artifact of the same run both have SHA-256 `36599399dc9aa2bf36834309e2c05690e587b6d179ec4c1949419250c2bc0069`; run 38316630154 (`e7a4bed`, before llama.rn's unused variants stopped being built) gave the same hash |

Open points for the real submission: the Hermes compiler is still a scanignored prebuilt (several
fdroiddata React Native recipes keep it that way; one builds it from the `hermes` srclib, see the
answer in `docs/fdroid/merge-request.md`). The production buildserver may differ from the CI container
in details the comparison would then show.

```yaml
Categories:
  - Reading
  - Science & Education
License: GPL-3.0-or-later
AuthorName: Fiouri
AuthorEmail: anywecon@gmail.com
SourceCode: https://github.com/anywecon/skepi
IssueTracker: https://github.com/anywecon/skepi/issues
Changelog: https://github.com/anywecon/skepi/blob/HEAD/CHANGELOG.md

AutoName: S.K.E.P.I.

RepoType: git
Repo: https://github.com/anywecon/skepi.git
Binaries: https://github.com/anywecon/skepi/releases/download/v%v/skepi-%v-arm64.apk

Builds:
  - versionName: 0.2.3-preview
    versionCode: 8
    commit: 1e5f54cca3679f3a7e4f718d55b64e02f315412b
    subdir: apps/mobile
    sudo:
      - echo 'deb https://deb.debian.org/debian forky main' > /etc/apt/sources.list.d/forky.list
      - apt-get update
      - apt-get install -y -t forky nodejs npm
      - apt-get install -y golang-go
      - npm install -g pnpm@10.33.0
    init:
      - cd ../..
      - pnpm install --frozen-lockfile
    output: android/app/build/outputs/apk/release/app-arm64-v8a-release-unsigned.apk
    srclibs:
      - esbuild@v0.28.2
    prebuild:
      - bash ../../scripts/android/jdk21.sh
      - sed -i -e '/play-services-location/d' ../../node_modules/@maplibre/maplibre-react-native/android/build.gradle
      - npx expo prebuild --platform android --clean --no-install
    scanignore:
      - node_modules/hermes-compiler
      - node_modules/@react-native-masked-view/masked-view/android/build.gradle
      - node_modules/expo-modules-core/android/ExpoModulesCorePlugin.gradle
      - node_modules/react-native-safe-area-context/android/build.gradle
      - node_modules/react-native-screens/android/build.gradle
    scandelete:
      - node_modules
      - tools/rag-eval/parity-reference
    build:
      - go build -C $$esbuild$$ ./cmd/esbuild
      - export ESBUILD_BINARY_PATH=$$esbuild$$/esbuild
      - cd android
      - SKEPI_PREVIEW=1 gradle assembleRelease -PskepiPreview=true -PskepiUnsigned=true
        -PskepiJdk21=true --no-daemon
    ndk: 27.1.12297006

AllowedAPKSigningKeys: 7d61c38241b178f84b12dd9a67af6b60b56159b1a0ff067fe672db45dd45447e

AutoUpdateMode: Version
UpdateCheckMode: Tags ^v[0-9.]+(-preview)?$
UpdateCheckData: apps/mobile/app.json|"versionCode":\s*(\d+)|.|"version":\s*"([^"]+)"
CurrentVersion: 0.2.3-preview
CurrentVersionCode: 8
```

## 7. Play Data safety answers

| Question | Answer | Why |
| --- | --- | --- |
| Does your app collect or share any of the required user data types? | **No** | "Collect" means transmitting data off the device. SKEPI sends no user data anywhere: no accounts, analytics, crash reporting or SDK that phones home. Questions, answers, location and settings stay on the device. |
| Downloads from Kiwix / Hugging Face / GitHub | not collection | User-initiated file downloads with only the file URL and a generic User-Agent; the developer receives nothing. The host sees the IP address as with any download; the privacy policy says so. |
| P2P / Station transfers | not collection | Device-to-device on the local network, started by the user, no developer server |
| Problem reports | not collection | The app copies or saves text, or opens the system share sheet with it (B6); the user chooses whether, where and through which app to send it. SKEPI transmits nothing |
| Location | not collected | Read on demand for display only; never stored or sent |
| Is all user data encrypted in transit? / Can users request deletion? | not asked | Only shown when data is collected |
| Privacy policy | required | `docs/privacy-policy.md` (public URL, see §2) |

True only while the zero-egress E2E (`dumpsys netstats`, ContentStore request log) keeps passing and
B6 stays a share-sheet hand-off.

## 8. Permission justifications (Play Console and reviewers)

| Permission | Feature | Justification |
| --- | --- | --- |
| `INTERNET`, `ACCESS_NETWORK_STATE` | Downloads | Content packs the user selects, only from the signed catalog's hosts, through the system DownloadManager |
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | Map, Tools | One-shot GPS fix shown on the offline map and in Tools when the user taps; foreground only (`ACCESS_BACKGROUND_LOCATION` is blocked in `app.json`); no location is stored or sent |
| `CAMERA` | P2P pairing | Scans the pairing QR code of the other phone; no photos or video are taken or stored. `android.hardware.camera` is not required |
| `NEARBY_WIFI_DEVICES` (`neverForLocation`) | P2P | Required since Android 13 to start a `LocalOnlyHotspot` and join it with `WifiNetworkSpecifier`; never used to derive location |
| `ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE`, `CHANGE_NETWORK_STATE` | P2P | Create or join the local hotspot and bind the transfer socket to it |
| `org.skepi.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | — | Signature permission generated by AndroidX for non-exported runtime receivers |

None is on Play's declaration-form list (SMS/Call Log, background location, all-files access,
`QUERY_ALL_PACKAGES`, `REQUEST_INSTALL_PACKAGES`, photo/video, exact alarm, full-screen intent,
accessibility, Health Connect, VPN). The release allowlist in CI (`tools/release-guards`) keeps it so.

## 9. Content rating (IARC) — suggested answers

Category: **Reference, News, or Educational**. No violence, sexual content, profanity, drugs, gambling or
horror created by the app; the encyclopedia packs describe such topics in encyclopedic text (answer the
reference-content questions accordingly). No user-to-user communication or user-generated content
(P2P moves only catalog-verified packs between the user's own devices), no location sharing, no
digital purchases, no unrestricted web access (the viewer opens no web pages). The owner fills and
submits the questionnaire; re-do it if features change.

## Sources (checked 2026-10-12)

- F-Droid Inclusion Policy — https://f-droid.org/docs/Inclusion_Policy/
- F-Droid Anti-Features — https://f-droid.org/docs/Anti-Features/
- F-Droid Reproducible Builds — https://f-droid.org/docs/Reproducible_Builds/
- F-Droid Build Metadata Reference — https://f-droid.org/docs/Build_Metadata_Reference/
- F-Droid descriptions, graphics and screenshots (fastlane layout, limits) — https://f-droid.org/docs/All_About_Descriptions_Graphics_and_Screenshots/
- fdroiddata React Native template — https://gitlab.com/fdroid/fdroiddata/-/blob/master/templates/build-react-native.yml
- Example React Native reproducible-build plan (Node from Debian forky, Hermes, scandelete) — https://github.com/mmlado/keycard-pal/issues/316
- Debian `nodejs` versions — https://packages.debian.org/search?keywords=nodejs&searchon=names&exact=1&suite=all&section=all
- Play target API level — https://developer.android.com/google/play/requirements/target-sdk
- Play testing requirements for new personal accounts — https://support.google.com/googleplay/android-developer/answer/14151465
- Play Console requirements (Organization accounts, health apps) — https://support.google.com/googleplay/android-developer/answer/10788890
- Health apps declaration — https://support.google.com/googleplay/android-developer/answer/14738291
- Health Content and Services policy — https://support.google.com/googleplay/android-developer/answer/16679511
- Data safety section — https://support.google.com/googleplay/android-developer/answer/10787469
- AI-Generated Content policy — https://support.google.com/googleplay/android-developer/answer/13985936
- Device and Network Abuse policy — https://support.google.com/googleplay/android-developer/answer/16273414
- Permissions and APIs that access sensitive information — https://support.google.com/googleplay/android-developer/answer/16558241
- Content ratings — https://support.google.com/googleplay/android-developer/answer/188189
- Store listing limits — https://support.google.com/googleplay/android-developer/answer/9859152
- Android developer verification — https://developer.android.com/developer-verification
- F-Droid on developer verification — https://f-droid.org/2026/02/24/open-letter-opposing-developer-verification.html
- Local-only hotspot and `NEARBY_WIFI_DEVICES` — https://developer.android.com/develop/connectivity/wifi/localonlyhotspot
