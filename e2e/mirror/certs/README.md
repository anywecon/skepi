# Local test mirror certificates (generated, never committed)

The local HTTPS test mirror (`e2e/mirror/server.mjs`, `https://127.0.0.1:8443`, reached on the phone
through `adb reverse tcp:8443 tcp:8443`) uses certificates that `e2e/mirror/gen-certs.mjs` creates in this
folder. `.gitignore` keeps `*.crt` and `*.key` here out of git, and CI (`tools/release-guards`
`private-keys`) fails on any tracked private key.

## How and when they are generated

```sh
node e2e/mirror/gen-certs.mjs           # only when missing, mismatched or expiring within 7 days
node e2e/mirror/gen-certs.mjs --force   # always a new set
```

- A fresh **"SKEPI Test Mirror CA (debug builds only)"** (EC P-256) is made in a temporary directory. It
  signs exactly one certificate, the mirror's `server.crt` for **`IP:127.0.0.1` only** (EC P-256,
  `serverAuth`, 90 days, valid from one day back for devices whose clock lags). The CA private key is
  **deleted right after signing**, so nothing else can ever be issued under that CA.
- Output: `ca.crt`, `server.crt`, `server.key` (the mirror's key, mode 0600 where the OS supports it).
- Every consumer generates on demand: `server.mjs` on start, the E2E scripts (`run-download-e2e.ps1`,
  `run-countries-e2e.ps1`, `run-p2p.ps1`, `run-station.ps1`, through `e2e/mirror/mirror-certs.ps1`) before
  they start the mirror, and CI before the desktop `test-mirror` tests.
- Needs the `openssl` CLI: `$OPENSSL`, then `PATH`, then (Windows) the copy shipped with Git for Windows.

## Who trusts the CA

- **Android debug builds only, and only for `127.0.0.1`.** `apps/mobile/plugins/withContentStore.js`
  copies `ca.crt` into the debug source set (`res/raw/skepi_test_mirror_ca.pem`) and the debug
  `network_security_config.xml` names it for `127.0.0.1` alone. Without `ca.crt` prebuild still succeeds:
  the debug config simply has no test mirror entry and a notice is printed. Release builds, the
  reproducible build and the F-Droid recipe never read this folder.
- **Desktop debug builds with the `test-mirror` feature**, only for `https://127.0.0.1:8443`
  (`crates/desktop-core/src/download.rs`, `include_bytes!`); `crates/desktop-core/build.rs` stops with a
  clear message when the feature is on and `ca.crt` is missing; `apps/desktop/src-tauri/build.rs` refuses
  the feature in release builds.

## After a regeneration: rebuild the debug app

A debug app embeds the `ca.crt` that existed when it was built. After a new set (expiry, `--force`, a fresh
checkout), the old app cannot reach the mirror. The E2E scripts compare the SHA-256 of
`res/raw/skepi_test_mirror_ca.pem` in the installed (or given) debug APK with `ca.crt` and stop with
"rebuild the debug app" when they differ:

```sh
node e2e/mirror/gen-certs.mjs
pnpm --filter @skepi/mobile run prebuild
cd apps/mobile/android && ./gradlew assembleDebug -PskepiBundleDebug=true   # then adb install -r
```

Desktop (`run-station.ps1`): rebuild with `cargo build -p skepi-desktop --features test-mirror`
(through `scripts/with-msvc.ps1` on Windows).

## History

Until 2026-11-18 a hand-made 10-year set (RSA CA, server key included) was committed here. It was untracked
then; history is not rewritten, so that server key stays in git history (commit `d927dc1`, listed in
`.gitleaksignore`). No build made after 2026-11-18 trusts that CA; a debug app built before trusts it for
`127.0.0.1` only, until it is rebuilt.
