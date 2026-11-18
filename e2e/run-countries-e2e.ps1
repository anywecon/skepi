<#
.SYNOPSIS
  Global maps E2E (decision 2026-10-23): two pilot countries and one part of a split pilot country
  (Japan: Kanto) downloaded from the local HTTPS test mirror, then map, places and emergency POIs offline
  (airplane mode), then one country and the part deleted.
  1. Builds (or reuses from the catalog-builder cache) the country packs of -Countries (only the -Parts
     of split countries named there, each with its country's places pack) with the pinned
     inputs of catalog/regions/sources.json, and signs a schema 2 test catalog (sequence 5, the TEST key
     in %LOCALAPPDATA%\skepi\keys, never a release key) whose packs point at https://127.0.0.1:8443/maps/.
  2. Starts e2e/mirror/server.mjs (mode "countries", packs streamed from the cache), `adb reverse
     tcp:8443`, and runs e2e/countries.yaml on the debug build (org.skepi.app.dev; build with
     `gradlew assembleDebug -PskepiBundleDebug=true`). Wi-Fi must be connected for the downloads.
  3. Asserts that the app contacted only the mirror (logcat download requests, mirror log: no query
     strings, generic User-Agent) and moved zero bytes over any real interface (dumpsys netstats).
  Takes the shared device lock (scripts/device-lock.ps1) for the whole run.
#>
[CmdletBinding()]
param(
  [string]$Serial = '',
  [ValidatePattern('^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$')]
  [string]$AppId = 'org.skepi.app.dev',
  [ValidatePattern('^[A-Z]{2}(,[A-Z]{2})*$')]
  [string]$Countries = 'CY,GR,JP',
  [ValidatePattern('^[A-Z]{2}:[a-z0-9-]+(,[A-Z]{2}:[a-z0-9-]+)*$')]
  [string]$Parts = 'JP:kanto',
  [string]$Python = (Join-Path $env:LOCALAPPDATA 'skepi\venv-packs\Scripts\python.exe'),
  # Optional: a debug APK to install (adb install -r) under the device lock before the flow.
  [string]$Apk = '',
  [string]$Maestro = (Join-Path $env:USERPROFILE '.maestro\maestro\bin\maestro.bat')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$cli = @((Join-Path $root 'node_modules\tsx\dist\cli.mjs'), (Join-Path $root 'tools\catalog-builder\src\cli.ts'))
$cache = if ($env:SKEPI_CACHE_DIR) { $env:SKEPI_CACHE_DIR } else { Join-Path $env:LOCALAPPDATA 'skepi\cache' }
$testKey = Join-Path $env:LOCALAPPDATA 'skepi\keys\cat-test-2026a.key.json'
if (-not (Test-Path $testKey)) { throw "test signing key missing: $testKey (docs/phase-1c-report.md)" }
if (Test-Path $Python) { $env:SKEPI_PYTHON = $Python }

# 1. Country packs (cache) and the signed schema 2 test catalog.
$manifest = Join-Path $out 'countries-manifest.json'
$catalogDir = Join-Path $out 'countries-catalog'
& node @cli countries --iso $Countries --parts $Parts --mirror 'https://127.0.0.1:8443/maps/' --out $manifest
if ($LASTEXITCODE -ne 0) { throw 'catalog countries failed' }
& node @cli build --manifest $manifest --key $testKey --out $catalogDir `
  --previous (Join-Path $root 'e2e\mirror\catalogs\good\catalog.json') --sequence 5
if ($LASTEXITCODE -ne 0) { throw 'catalog build failed' }
& node @cli verify --dir $catalogDir --pinned (Join-Path $root 'catalog\keys\test.json')
if ($LASTEXITCODE -ne 0) { throw 'the countries test catalog does not verify' }

. (Join-Path $root 'scripts\device-lock-lib.ps1')
$deviceLocks = @(Enter-DeviceLock -Serial $Serial -Purpose 'e2e/run-countries-e2e.ps1')
try {
  $env:MAESTRO_CLI_NO_ANALYTICS = '1'
  $env:MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED = 'true'
  $adbArgs = @()
  if ($Serial) { $adbArgs += @('-s', $Serial) }
  function Invoke-Adb { & adb.exe @adbArgs @args }

  # Sum of rx+tx bytes of one UID over every non-loopback interface since boot.
  function Get-UidBytes([string]$Uid) {
    Invoke-Adb shell dumpsys netstats --poll | Out-Null
    $lines = Invoke-Adb shell dumpsys netstats detail
    $total = [int64]0
    $inUid = $false
    $section = $false
    foreach ($line in $lines) {
      if ($line -match '^\s*UID stats:') { $section = $true; continue }
      if ($section -and $line -match '^\s*UID tag stats:') { break }
      if (-not $section) { continue }
      if ($line -match '^\s*ident=.* uid=(-?\d+) ') { $inUid = ($Matches[1] -eq $Uid); continue }
      if ($inUid -and $line -match 'rb=(\d+) .*tb=(\d+)') { $total += [int64]$Matches[1] + [int64]$Matches[2] }
    }
    return $total
  }

  # Test mirror certificates (generated on demand); the debug app must embed this ca.crt.
  . (Join-Path $PSScriptRoot 'mirror\mirror-certs.ps1')
  Initialize-MirrorCerts
  if ($Apk) {
    Assert-ApkTrustsMirror $Apk
    Invoke-Adb install -r $Apk | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "adb install $Apk failed" }
  }
  $uid = ((Invoke-Adb shell dumpsys package $AppId) | Select-String -Pattern 'appId=(\d+)' | Select-Object -First 1).Matches[0].Groups[1].Value
  if (-not $uid) { throw "$AppId is not installed (build: gradlew assembleDebug -PskepiBundleDebug=true)" }
  Assert-InstalledAppTrustsMirror $adbArgs $AppId
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $out 'mirror-log.jsonl')

  $env:MIRROR_MAPS_DIR = $cache
  $server = Start-Process -FilePath node -ArgumentList (Join-Path $PSScriptRoot 'mirror\server.mjs') -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $out 'mirror-stdout.txt') -RedirectStandardError (Join-Path $out 'mirror-stderr.txt')
  try {
    Start-Sleep -Seconds 2
    Invoke-Adb reverse tcp:8443 tcp:8443 | Out-Null
    Invoke-Adb logcat -c
    $before = Get-UidBytes $uid
    # A dozing screen behind the keyguard keeps the app from drawing (app-ready.yaml times out).
    Invoke-Adb shell input keyevent KEYCODE_WAKEUP | Out-Null
    Invoke-Adb shell wm dismiss-keyguard | Out-Null
    Start-Sleep -Seconds 2
    if ((Invoke-Adb shell dumpsys window) -match 'isKeyguardShowing=true') { throw "$Serial is locked behind a secure keyguard: unlock it, then re-run" }
    Push-Location $root
    try {
      $maestroArgs = @('test', 'e2e/countries.yaml', '-e', "APP_ID=$AppId", '--format', 'junit', '--output', (Join-Path $out 'report-countries.xml'), '--test-output-dir', $out)
      if ($Serial) { $maestroArgs = @('--device', $Serial) + $maestroArgs }
      & $Maestro @maestroArgs | Out-Host
      $flowExit = $LASTEXITCODE
      Write-Host "Maestro exit code (e2e/countries.yaml): $flowExit"
    } finally {
      Pop-Location
    }
    $after = Get-UidBytes $uid
    $requested = @(Invoke-Adb logcat -d -s 'SkepiContentStore:*' | Select-String -SimpleMatch 'download requested:')
    $requested | ForEach-Object { $_.Line } | Set-Content -Encoding UTF8 (Join-Path $out 'countries-download-requests.txt')
    $log = Invoke-RestMethod -Uri 'http://127.0.0.1:8444/log'
    $log | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $out 'countries-mirror-log.json')
  } finally {
    Invoke-Adb reverse --remove tcp:8443 | Out-Null
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }

  $foreign = @($requested | Where-Object { $_.Line -notmatch 'download requested: https://127\.0\.0\.1:8443/' })
  $withQuery = @($log | Where-Object { $_.query })
  $maps = @($log | Where-Object { $_.path -like '/maps/*' -and $_.status -in 200, 206 })
  $userAgents = @($log | ForEach-Object { $_.userAgent } | Sort-Object -Unique)
  $egress = $after - $before
  Write-Host "Download requests by ContentStore: $($requested.Count) (non-mirror: $($foreign.Count))"
  Write-Host "Mirror requests: $(@($log).Count), country pack responses: $($maps.Count), with query string: $($withQuery.Count), user agents: $($userAgents -join ' | ')"
  Write-Host "Bytes of UID $uid over real interfaces during the flow: $egress"
  if ($flowExit -ne 0) { exit $flowExit }
  if ($foreign.Count -gt 0 -or $withQuery.Count -gt 0) { Write-Error 'The app requested something other than the mirror.'; exit 4 }
  if ($maps.Count -eq 0) { Write-Error 'No country pack was downloaded from the mirror.'; exit 5 }
  if ($egress -ne 0) { Write-Error "The app's UID moved $egress bytes over a real network interface."; exit 6 }
  Write-Host 'COUNTRIES E2E PASS (two countries and one part of a split country from the mirror, offline map/places/POIs, delete; only the mirror contacted)'
} finally {
  $deviceLocks | ForEach-Object { Exit-DeviceLock $_ }
}
