# Test mirror certificates for the E2E scripts (dot-source it; no parameters). The certificates are made
# on demand by gen-certs.mjs and never committed (certs/README.md); debug apps embed ca.crt at build time,
# so an app built before a regeneration no longer reaches the mirror and must be rebuilt.
$script:MirrorDir = $PSScriptRoot
$script:MirrorCaEntry = 'res/raw/skepi_test_mirror_ca.pem'
$script:MirrorRebuildHint = 'rebuild the debug app: pnpm --filter @skepi/mobile run prebuild, then gradlew assembleDebug -PskepiBundleDebug=true in apps/mobile/android, and install it'

# Creates the certificates when they are missing or expire within 7 days (e2e/mirror/gen-certs.mjs).
function Initialize-MirrorCerts {
  & node (Join-Path $script:MirrorDir 'gen-certs.mjs') | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'e2e/mirror/gen-certs.mjs failed (see above)' }
}

function Get-MirrorCaSha256 {
  $ca = Join-Path $script:MirrorDir 'certs\ca.crt'
  if (-not (Test-Path $ca)) { throw "$ca is missing: run Initialize-MirrorCerts (node e2e/mirror/gen-certs.mjs) first" }
  return (Get-FileHash -Algorithm SHA256 $ca).Hash.ToLowerInvariant()
}

# SHA-256 of the test mirror CA inside an APK file, or $null when the APK has none.
function Get-ApkMirrorCaSha256([string]$Apk) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $Apk).Path)
  try {
    $entry = $zip.GetEntry($script:MirrorCaEntry)
    if (-not $entry) { return $null }
    $stream = $entry.Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
  } finally { $zip.Dispose() }
}

# SHA-256 of the test mirror CA inside an installed app ($null when it has none). Hashes on the device
# (unzip + sha256sum); pulls base.apk only when the device has no unzip.
function Get-InstalledMirrorCaSha256([string[]]$AdbArgs, [string]$AppId) {
  $base = @(& adb.exe @AdbArgs shell pm path $AppId) | Where-Object { $_ -match '^package:(\S*base\.apk)\s*$' } | Select-Object -First 1
  if (-not $base) { throw "$AppId is not installed (build: gradlew assembleDebug -PskepiBundleDebug=true)" }
  $apkPath = ($base -replace '^package:', '').Trim()
  # Any unzip failure (missing tool, unreadable APK, another ziptool) answers "no-unzip": pull instead.
  $entry = $script:MirrorCaEntry
  $probe = "command -v unzip >/dev/null 2>&1 || { echo no-unzip; exit 0; }; " +
    "l=`$(unzip -l '$apkPath' 2>/dev/null) || { echo no-unzip; exit 0; }; " +
    "case `$l in *'$entry'*) ;; *) echo none; exit 0;; esac; " +
    "unzip -p '$apkPath' '$entry' > /data/local/tmp/skepi-mirror-ca.pem 2>/dev/null && [ -s /data/local/tmp/skepi-mirror-ca.pem ] || { rm -f /data/local/tmp/skepi-mirror-ca.pem; echo no-unzip; exit 0; }; " +
    "sha256sum /data/local/tmp/skepi-mirror-ca.pem; rm -f /data/local/tmp/skepi-mirror-ca.pem"
  $answer = (@(& adb.exe @AdbArgs shell $probe) -join ' ').Trim()
  if ($answer -match '^([0-9a-f]{64})\b') { return $Matches[1] }
  if ($answer -eq 'none') { return $null }
  $local = Join-Path ([IO.Path]::GetTempPath()) "skepi-mirror-ca-$PID.apk"
  try {
    & adb.exe @AdbArgs pull $apkPath $local | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "adb pull $apkPath failed" }
    return Get-ApkMirrorCaSha256 $local
  } finally { Remove-Item -Force -ErrorAction SilentlyContinue $local }
}

function Assert-MirrorCaMatches([AllowNull()][string]$Actual, [string]$What) {
  $expected = Get-MirrorCaSha256
  if (-not $Actual) { throw "$What does not trust any test mirror CA (built while e2e/mirror/certs/ca.crt was missing): $script:MirrorRebuildHint" }
  if ($Actual -ne $expected) {
    throw "$What trusts another test mirror CA ($($Actual.Substring(0, 16)), current ca.crt $($expected.Substring(0, 16))): the certificates were regenerated after it was built; $script:MirrorRebuildHint"
  }
  Write-Host "test mirror CA: $What embeds the current ca.crt ($($expected.Substring(0, 16)))"
}

# The installed debug app must embed the current ca.crt, or the mirror's TLS handshake fails on the device.
function Assert-InstalledAppTrustsMirror([string[]]$AdbArgs, [string]$AppId) {
  Assert-MirrorCaMatches (Get-InstalledMirrorCaSha256 $AdbArgs $AppId) "installed $AppId"
}

# A debug APK file (before it is installed).
function Assert-ApkTrustsMirror([string]$Apk) {
  Assert-MirrorCaMatches (Get-ApkMirrorCaSha256 $Apk) $Apk
}

# A desktop debug build with the test-mirror feature embeds ca.crt verbatim (include_bytes!).
function Assert-DesktopTrustsMirror([string]$Exe) {
  $ca = Join-Path $script:MirrorDir 'certs\ca.crt'
  if (-not (Test-Path -PathType Leaf $Exe)) { throw "$Exe not found: build the desktop debug app with the test-mirror feature (cargo build -p skepi-desktop --features test-mirror)" }
  & node -e 'const fs = require(''fs''); process.exit(fs.readFileSync(process.argv[1]).includes(fs.readFileSync(process.argv[2])) ? 0 : 1)' $Exe $ca
  if ($LASTEXITCODE -ne 0) {
    throw "$Exe does not embed the current e2e/mirror/certs/ca.crt: rebuild the desktop debug app with the test-mirror feature (cargo build -p skepi-desktop --features test-mirror)"
  }
  Write-Host "test mirror CA: $Exe embeds the current ca.crt"
}
