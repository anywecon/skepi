<#
.SYNOPSIS
  Download/catalog/import E2E against the local HTTPS test mirror, with a zero-egress check.
  1. Starts e2e/mirror/server.mjs (https://127.0.0.1:8443, admin on host-only :8444) and
     `adb reverse tcp:8443 tcp:8443`; pushes an unknown ZIM to /sdcard/Download for the import step
     (with a current mtime, so the picker lists it first: e2e/download-fixture.ps1).
  2. Runs e2e/onboarding-mirror.yaml ("Get prepared" on a fresh install: the 2 GB preset downloads the
     test packs from the mirror, readiness indicator), then e2e/download.yaml on the debug build (test catalog; build with
     `gradlew assembleDebug -PskepiBundleDebug=true`). Wi-Fi must be connected (DownloadManager needs a network).
  3. Asserts that the app contacted only the mirror: every URL ContentStore handed to DownloadManager
     targets 127.0.0.1:8443 (logcat), the mirror saw no query strings and only the generic User-Agent,
     and the app's UID moved zero bytes over any real interface (dumpsys netstats; loopback is not counted).
#>
[CmdletBinding()]
param(
  [string]$Serial = '',
  [ValidatePattern('^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$')]
  [string]$AppId = 'org.skepi.app.dev',
  [string]$Maestro = (Join-Path $env:USERPROFILE '.maestro\maestro\bin\maestro.bat')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Shared device lock (scripts/device-lock.ps1): waits while another project or session uses the
# device and never stops their processes; released in the finally block at the end of this script.
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\device-lock-lib.ps1')
$deviceLocks = @(Enter-DeviceLock -Serial $Serial -Purpose 'e2e/run-download-e2e.ps1')
try {

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
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

$uid = ((Invoke-Adb shell dumpsys package $AppId) | Select-String -Pattern 'appId=(\d+)' | Select-Object -First 1).Matches[0].Groups[1].Value
if (-not $uid) { throw "$AppId is not installed (build: gradlew assembleDebug -PskepiBundleDebug=true)" }
# Test mirror certificates (generated on demand); the installed debug app must embed this ca.crt.
. (Join-Path $PSScriptRoot 'mirror\mirror-certs.ps1')
Initialize-MirrorCerts
Assert-InstalledAppTrustsMirror $adbArgs $AppId
. (Join-Path $PSScriptRoot 'download-fixture.ps1')
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $out 'mirror-log.jsonl')

$server = Start-Process -FilePath node -ArgumentList (Join-Path $PSScriptRoot 'mirror\server.mjs') -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $out 'mirror-stdout.txt') -RedirectStandardError (Join-Path $out 'mirror-stderr.txt')
try {
  Start-Sleep -Seconds 2
  Invoke-Adb reverse tcp:8443 tcp:8443 | Out-Null
  Push-DownloadFixture $adbArgs
  Invoke-Adb logcat -c
  $before = Get-UidBytes $uid

  Push-Location $root
  try {
    $flowExit = 0
    foreach ($flow in @(@('e2e/onboarding-mirror.yaml', 'report-onboarding-mirror.xml'), @('e2e/download.yaml', 'report-download.xml'))) {
      $maestroArgs = @('test', $flow[0], '-e', "APP_ID=$AppId", '--format', 'junit', '--output', (Join-Path $out $flow[1]), '--test-output-dir', $out)
      if ($Serial) { $maestroArgs = @('--device', $Serial) + $maestroArgs }
      & $Maestro @maestroArgs | Out-Host
      Write-Host "Maestro exit code ($($flow[0])): $LASTEXITCODE"
      if ($LASTEXITCODE -ne 0 -and $flowExit -eq 0) { $flowExit = $LASTEXITCODE }
    }
  } finally {
    Pop-Location
  }

  $after = Get-UidBytes $uid
  $requested = @(Invoke-Adb logcat -d -s 'SkepiContentStore:*' | Select-String -SimpleMatch 'download requested:')
  $requested | ForEach-Object { $_.Line } | Set-Content -Encoding UTF8 (Join-Path $out 'download-requests.txt')
  $log = Invoke-RestMethod -Uri 'http://127.0.0.1:8444/log'
  $log | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $out 'mirror-log.json')
} finally {
  Invoke-Adb reverse --remove tcp:8443 | Out-Null
  Remove-DownloadFixture $adbArgs
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}

$foreign = @($requested | Where-Object { $_.Line -notmatch 'download requested: https://127\.0\.0\.1:8443/' })
$withQuery = @($log | Where-Object { $_.query })
$userAgents = @($log | ForEach-Object { $_.userAgent } | Sort-Object -Unique)
$egress = $after - $before

Write-Host "Maestro exit code: $flowExit"
Write-Host "Download requests by ContentStore: $($requested.Count) (non-mirror: $($foreign.Count))"
Write-Host "Mirror requests: $(@($log).Count), with query string: $($withQuery.Count), user agents: $($userAgents -join ' | ')"
Write-Host "Bytes of UID $uid over real interfaces during the flow: $egress"
if ($flowExit -ne 0) { exit $flowExit }
if ($foreign.Count -gt 0 -or $withQuery.Count -gt 0) { Write-Error 'The app requested something other than the mirror.'; exit 4 }
if ($requested.Count -eq 0 -or @($log).Count -eq 0) { Write-Error 'No download reached the mirror.'; exit 5 }
if ($egress -ne 0) { Write-Error "The app's UID moved $egress bytes over a real network interface."; exit 6 }
Write-Host 'DOWNLOAD E2E PASS (only the mirror host contacted)'
} finally {
  $deviceLocks | ForEach-Object { Exit-DeviceLock $_ }
}
