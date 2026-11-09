# Release process (Android)

Decided 2026-10-12: **F-Droid first**, Google Play deferred to v1 (`docs/store-readiness.md`). Every
published APK is the reproducible **unsigned** APK built by CI, signed locally by the maintainer with the
SKEPI release key. The key never enters CI, the repository or the project's Gradle properties
(`docs/release-signing.md`).

```
push to main ──► android-repro (2 clean Linux builds, different paths) ──► identical? ──► artifact:
                                                                                         unsigned APK + SHA256SUMS.txt
maintainer: download artifact ──► scripts/release/sign-release-apk.ps1 (apksigner, release key)
            ──► checks: SHA-256, unsigned, aligned, certificate = published fingerprint, contents = artifact,
                F-Droid's signature copy (apksigcopier onto the artifact, apksigner verify, same bytes)
            ──► GitHub release asset skepi-<version>-arm64.apk ──► F-Droid builds the tag, compares, ships ours
```

## 1. Build switches

| Gradle property | Result | Used by |
| --- | --- | --- |
| *(none; keystore path and alias in `~/.gradle/gradle.properties`, passwords from `Use-SigningSecrets`, `--no-daemon`)* | Release signed with the SKEPI key (`docs/release-signing.md`) | Owner only, rarely; not the published artifact |
| `-PskepiUnsigned=true` | Release with no signing config: `app-arm64-v8a-release-unsigned.apk`, unsigned `app-release.aab` | CI (`android-release-guards`, `android-repro`), F-Droid |
| `-PskepiDebugSign=true` | Expo debug key, loud warning; never distributed | Local release-mode E2E (S23, emulators); needs no release password |
| *(none of the above)* | Fails at `skepiCheckReleaseSigning` | — |

`-PskepiUnsigned` and `-PskepiDebugSign` are exclusive. Preview builds add `SKEPI_PREVIEW=1` and
`-PskepiPreview=true` (the "Developer preview" label; since 2026-10-21 the cards ship their
source-checked steps in every build).
`-PskepiJdk21=true` (after `scripts/android/jdk21.sh`) builds with the JDK 21 toolchain and bytecode target
17, as F-Droid's Debian buildserver must; published APKs are built this way (`docs/architecture.md`).

Release builds compile everything native from source: llama.cpp (`rnllamaBuildFromSource`), React
Native libraries, op-sqlite/SQLCipher and, since 2026-10-12, every Expo module
(`expo.autolinking.android.buildFromSource: [".*"]` in `apps/mobile/package.json`; before, 15 Expo modules
came as prebuilt AARs from `node_modules`). Every CMake build loads `apps/mobile/plugins/reproducible.cmake`
(`-Wl,--build-id=none`; `-ffile-prefix-map` for the checkout, the Gradle user home and the NDK).

## 2. Release steps

1. **Version.** `apps/mobile/app.json`: `expo.version` and `android.versionCode` (and `ios.buildNumber`);
   `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`; `CHANGELOG.md`.
2. **CI.** Push to `main`. `CI` must be green and **Android reproducible build → `android-repro`**
   green: it writes the commit, version, run id and the APK's SHA-256 to the job summary and uploads the
   artifact `skepi-<version>-vc<versionCode>-<commit12>-unsigned` (`skepi-<version>-arm64-unsigned.apk` +
   `SHA256SUMS.txt`, kept 90 days).
3. **Tag (owner).** `git tag -a v<version> <commit> -m "S.K.E.P.I. v<version>"` on exactly that commit; push
   the tag. Tags are annotated, not signed (no GPG key is configured; `v0.1.1-preview` and `v0.1.2-preview`
   are annotated and unsigned).
4. **Download.**
   ```powershell
   gh run download <run-id> --repo anywecon/skepi -n skepi-<version>-vc<code>-<commit12>-unsigned -D $env:TEMP\skepi\release
   ```
5. **Sign locally (owner).**
   ```powershell
   ./scripts/release/sign-release-apk.ps1 -Tag v<version> -RunId <run-id> -Unsigned $env:TEMP\skepi\release\skepi-<version>-arm64-unsigned.apk
   ```
   Before anything else (no password yet) it checks provenance (`scripts/release/ReleaseProvenance.psm1`,
   unit test `scripts/release/test-release-provenance.ps1`): the pushed tag names a commit, the run is a
   successful `android-repro.yml` run of this repository (push or `workflow_dispatch` on `main`, not a
   fork), its artifact is `skepi-<version>-vc<code>-<commit12>-unsigned` for that commit, and the APK is
   byte for byte the APK in that artifact, downloaded again from the run. Then it checks the SHA-256 against `SHA256SUMS.txt`, that the APK is unsigned and zip-aligned (4
   bytes, 16 KB pages), signs with `apksigner` (APK Signature Scheme v2 only, like the Gradle release
   build; the key file and alias come from `~/.gradle/gradle.properties`, the passwords are prompted at
   run time by `tools/Signing.psm1` and passed to apksigner as process env vars only), then checks that
   the signer certificate is the published one (`7d61c382…447e`) and that the signed APK holds the
   artifact's entries byte for byte, plus only the signature. apksigner runs with
   `--alignment-preserved true` and the script checks `apk-compare.py copyable`: the signed APK must be
   the artifact byte for byte plus the APK Signing Block, or F-Droid cannot copy the signature onto its
   own build (v0.1.1-preview was re-aligned by apksigner and failed fdroiddata's build, 2026-10-22,
   `docs/store-readiness.md`). Last, it runs `check-fdroid-signature-copy.ps1`, F-Droid's own
   verification reproduced: apksigcopier 1.1.1 (the version fdroidserver vendors, installed with
   `pip --require-hashes` from `scripts/release/apksigcopier-requirements.txt` into a venv under
   `$env:TEMP\skepi`) copies the signature from the signed APK onto the CI artifact, `apksigner verify`
   must pass on the result and the result must be byte-identical to the signed APK
   (`F-DROID SIGNATURE COPY: PASS`). On any failure the signed APK is deleted. It prints the signed APK's
   SHA-256. **Nothing is published unless this check passed on the exact file uploaded**; it can be
   re-run on its own:
   ```powershell
   ./scripts/release/check-fdroid-signature-copy.ps1 -Signed <signed.apk> -Unsigned <unsigned.apk>
   ```
6. **Smoke test.** `adb install -r` the signed APK on the S23 and run `e2e/run-e2e.ps1` (airplane mode).
   It installs over the previous release (same certificate); never uninstall `org.skepi.app` (no backup:
   `allowBackup=false`). This is the only run of the release build on the phone: development runs use
   `org.skepi.app.dev`, so the release-only checks happen here, before publishing:
   - the full Maestro suite, including `onboarding.yaml` (release-only);
   - ICU data in the content folder is ignored: with an `icu/icudt*.dat` file in the content folder,
     `adb logcat -s ExpoZim` shows `icu=none` after a cold start (remove the file afterwards);
   - the app opens the packs installed by the previous version and keeps them verified;
   - the hand-offs, by hand (no Maestro flow taps them: `run-e2e.ps1` refuses such a flow and fails a run
     in which the app opened another app): Tools → "Send my location by SMS" opens the SMS app with the position text,
     Ask → Report → "Send…" opens the share sheet with the report, an emergency card's call button opens
     the dialler with the number; back out of each without sending or calling.
7. **Publish (owner).** GitHub release for the tag with `skepi-<version>-arm64.apk` (the name the F-Droid
   recipe's `Binaries:` expects), `SHA256SUMS.txt` with the signed APK's hash, the certificate fingerprint
   and the CI run id.
8. **F-Droid.** The fdroiddata recipe (`docs/store-readiness.md` §6) builds the tag unsigned on the
   buildserver, copies the signature from our `Binaries:` APK (`apksigcopier`) and verifies it; when the
   bytes match, F-Droid publishes our signed APK. On a mismatch F-Droid publishes nothing for that version
   and the build log shows the differing files.

## 3. Checking a published APK

Anyone can repeat the comparison:

```sh
python3 scripts/ci/apk-compare.py contents skepi-<version>-arm64.apk skepi-<version>-arm64-unsigned.apk
python3 scripts/ci/apk-compare.py copyable skepi-<version>-arm64.apk skepi-<version>-arm64-unsigned.apk  # what F-Droid needs
python3 scripts/release/fdroid-signature-copy.py skepi-<version>-arm64.apk skepi-<version>-arm64-unsigned.apk apksigner  # F-Droid's check (pip install -r scripts/release/apksigcopier-requirements.txt --require-hashes)
apksigner verify --print-certs skepi-<version>-arm64.apk   # Signer #1 certificate SHA-256 digest: 7d61c382…447e
```

or rebuild the tag on Linux (`.github/workflows/android-repro.yml` lists the exact steps: Node 24.21.0,
pnpm from `packageManager`, a JDK 21, `pnpm install --frozen-lockfile`, `bash scripts/android/jdk21.sh`,
`expo prebuild`, `SKEPI_PREVIEW=1 ./gradlew assembleRelease -PskepiUnsigned=true -PskepiPreview=true
-PskepiJdk21=true`) and compare with `apk-compare.py same`. The CI job `fdroid-build` does the same through
`fdroid build` and the F-Droid recipe in F-Droid's buildserver container.

## 4. Not part of this flow

- Local Gradle-signed builds (`gradlew --no-daemon assembleRelease` inside `Use-SigningSecrets`,
  `docs/release-signing.md`) are possible but not the published artifact; device testing uses debug or
  `-PskepiDebugSign=true` builds, or the signed release APK from step 5.
- Google Play (AAB, Play App Signing, account type, IARC, Health declaration): deferred to v1.
- Android developer verification (package + certificate registration): owner action before 2027
  (roadmap).
