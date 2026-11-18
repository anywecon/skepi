<#
.SYNOPSIS
  Station mode E2E (Phase 3a): the Windows app serves packs over the LAN; the phone receives them with
  every chunk checked against its own signed catalog.
  1. Desktop (real build through tauri-driver, apps/desktop/e2e/station-host.mjs): adopts the newer
     signed test catalog (sequence 4) from the local test mirror, registers p2p-propagation.zim (known
     only to that catalog), and serves wikipedia_en_medicine_mini + test-propagation on the LAN address.
  2. Release app (org.skepi.app, release catalog): its copy of wikipedia_en_medicine_mini is removed,
     then received from the desktop (3 x 64 MiB chunks, each verified). The desktop's test catalog is
     not accepted (another key): the packs are checked against the phone's release catalog.
  3. Debug app (org.skepi.app.dev, data cleared: embedded test catalog sequence 3): adopts the desktop's
     signed catalog sequence 4 and installs test-propagation, verified by it.
  4. The desktop's request log may only contain GET /manifest and GET /pack/<selected id>.
  The Windows Firewall must allow skepi-desktop.exe on this network (first Station start asks).
#>
[CmdletBinding()]
param(
  [string]$Serial = '',
  [string]$HostIp = '',
  [string]$App = '',
  [string]$Maestro = (Join-Path $env:USERPROFILE '.maestro\maestro\bin\maestro.bat'),
  [switch]$SkipRelease,
  [switch]$SkipDebug
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Shared device lock (scripts/device-lock.ps1): waits while another project or session uses the
# device and never stops their processes; released in the finally block at the end of this script.
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\device-lock-lib.ps1')
$deviceLocks = @(Enter-DeviceLock -Serial $Serial -Purpose 'e2e/run-station.ps1')
try {
$root = Split-Path -Parent $PSScriptRoot
if (-not $App) { $App = Join-Path $root 'target\debug\skepi-desktop.exe' }
$out = Join-Path $PSScriptRoot 'out\station'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null
$env:MAESTRO_CLI_NO_ANALYTICS = '1'
$env:MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED = 'true'
$adbArgs = @(); if ($Serial) { $adbArgs += @('-s', $Serial) }
$env:MSYS_NO_PATHCONV = '1'

if (-not $HostIp) {
  $HostIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } | Where-Object { $_.InterfaceAlias -notlike 'vEthernet*' -and $_.InterfaceAlias -notlike '*VPN*' -and $_.InterfaceAlias -notlike 'Nord*' } | Select-Object -First 1).IPAddress
}
if (-not $HostIp) { throw 'no LAN address found (connect this computer and the phone to the same router)' }
$state = (& adb @adbArgs get-state 2>$null)
if ($state -ne 'device') { throw "phone not connected over adb ($Serial): connect it (USB or e2e/adb-wireless.ps1) and retry" }
$phoneIp = ((& adb @adbArgs shell ip -4 addr show wlan0) | Select-String -Pattern 'inet (\d+\.\d+\.\d+\.\d+)').Matches[0].Groups[1].Value
Write-Host "desktop $HostIp, phone $phoneIp"

# Desktop content: the medicine pack (hard link to the cache) and, after the update, the propagation fixture.
$cache = $(if ($env:SKEPI_CACHE_DIR) { $env:SKEPI_CACHE_DIR } else { Join-Path $env:LOCALAPPDATA 'skepi\cache' })
$content = Join-Path $env:LOCALAPPDATA 'skepi\e2e-station\content'
$appData = Join-Path $env:LOCALAPPDATA 'skepi\e2e-station\appdata'
foreach ($d in @($content, $appData)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
New-Item -ItemType Directory -Force -Path (Join-Path $content 'zim') | Out-Null
cmd /c mklink /H (Join-Path $content 'zim\wikipedia_en_medicine_mini_2026-04.zim') (Join-Path $cache 'wikipedia_en_medicine_mini_2026-04.zim') | Out-Null

# The pairing code is JSON: values go into a generated copy of the flow instead of maestro.bat -e
# (cmd.exe mangles quotes). Single-quoted YAML scalars hold JSON as is.
function Invoke-Flow([string]$AppId, [string]$Pack, [string]$Deselect, [string]$CatalogText, [string]$Report, [string]$Code, [string]$Other = '-', [string]$OtherText = '') {
  $flow = Get-Content -Raw (Join-Path $PSScriptRoot 'station-receive.yaml')
  $flow = $flow.Replace("`${DESELECT != '-'}", $(if ($Deselect -ne '-') { 'true' } else { 'false' }))
  $flow = $flow.Replace("`${OTHER != '-'}", $(if ($Other -ne '-') { 'true' } else { 'false' }))
  $flow = $flow.Replace('${OTHER}', $Other).Replace('${OTHER_TEXT}', "'" + $OtherText.Replace("'", "''") + "'")
  $flow = $flow.Replace('${APP_ID}', $AppId).Replace('${PACK}', $Pack).Replace('${DESELECT}', $Deselect)
  $flow = $flow.Replace('${CATALOG_TEXT}', "'" + $CatalogText.Replace("'", "''") + "'").Replace('${CODE}', "'" + $Code + "'")
  $gen = Join-Path $PSScriptRoot 'station-receive.gen.yaml'
  [IO.File]::WriteAllText($gen, $flow)
  try {
    $maestroArgs = @('test', 'e2e/station-receive.gen.yaml', '--format', 'junit', '--output', (Join-Path $out $Report), '--test-output-dir', $out)
    if ($Serial) { $maestroArgs = @('--device', $Serial) + $maestroArgs }
    & $Maestro @maestroArgs | Out-Host
    return $LASTEXITCODE
  } finally {
    Remove-Item -Force $gen -ErrorAction SilentlyContinue
  }
}

# Test mirror certificates (generated on demand); the desktop debug build must embed this ca.crt.
. (Join-Path $root 'e2e\mirror\mirror-certs.ps1')
Initialize-MirrorCerts
Assert-DesktopTrustsMirror $App
$mirror = Start-Process -FilePath node -ArgumentList @((Join-Path $root 'e2e\mirror\server.mjs')) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$hostArgs = @((Join-Path $root 'apps\desktop\e2e\station-host.mjs'), '--app', $App, '--content', $content, '--appdata', $appData, '--host', $HostIp,
  '--packs', 'wikipedia_en_medicine_mini,test-propagation', '--out', $out, '--update', '--add-after-update', (Join-Path $root 'e2e\fixtures\p2p-propagation.zim'))
$hostProc = Start-Process -FilePath node -ArgumentList $hostArgs -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $out 'host.log') -RedirectStandardError (Join-Path $out 'host.err')
# Keep the process handle: without it PowerShell reports ExitCode as null after the process exits.
$null = $hostProc.Handle
$results = @()
Push-Location $root
try {
  $pairing = Join-Path $out 'pairing.json'
  $deadline = (Get-Date).AddMinutes(10)
  while (-not (Test-Path $pairing)) {
    if ($hostProc.HasExited) { throw "station host exited: $(Get-Content -Raw (Join-Path $out 'host.err'))" }
    if ((Get-Date) -gt $deadline) { throw 'no pairing code from the desktop' }
    Start-Sleep -Seconds 2
  }
  $code = (Get-Content -Raw $pairing).Trim()
  Write-Host "pairing code: $code"

  if (-not $SkipRelease) {
    # Release app: remove its medicine pack; the next start's reconcile forgets it.
    & adb @adbArgs shell am force-stop org.skepi.app | Out-Null
    & adb @adbArgs shell rm -f /sdcard/Android/data/org.skepi.app/files/zim/wikipedia_en_medicine_mini_2026-04.zim | Out-Null
    # The propagation pack is not in the release catalog: offered as unverified, never pre-selected.
    $results += [pscustomobject]@{ Run = 'release'; Exit = (Invoke-Flow 'org.skepi.app' 'wikipedia_en_medicine_mini' '-' '.*not accepted.*' 'report-station-release.xml' $code 'test-propagation' 'Unverified.*') }
    $sha = (((& adb @adbArgs shell "sha256sum /sdcard/Android/data/org.skepi.app/files/zim/wikipedia_en_medicine_mini_2026-04.zim 2>/dev/null") -join '') -split '\s+')[0]
    Write-Host "release app: received file sha256 $sha"
    $results += [pscustomobject]@{ Run = 'release-sha'; Exit = $(if ($sha -eq '55153075b0773ea9c04a3db295ec5898129434ab5cae087dcb7822f37a81f358') { 0 } else { 1 }) }
  }
  if (-not $SkipDebug) {
    # Debug app from scratch: embedded test catalog sequence 3; the desktop holds sequence 4.
    & adb @adbArgs shell pm clear org.skepi.app.dev | Out-Null
    $results += [pscustomobject]@{ Run = 'debug'; Exit = (Invoke-Flow 'org.skepi.app.dev' 'test-propagation' 'wikipedia_en_medicine_mini' 'Newer signed catalog received and verified \(sequence 4\)' 'report-station-debug.xml' $code) }
  }
} finally {
  New-Item -ItemType File -Force -Path (Join-Path $out 'phone-done') | Out-Null
  $hostProc.WaitForExit(120000) | Out-Null
  Stop-Process -Id $mirror.Id -Force -ErrorAction SilentlyContinue
  Pop-Location
}

# The desktop answered only the manifest and the selected packs.
$status = Get-Content -Raw (Join-Path $out 'station-status.json') | ConvertFrom-Json
$bad = @($status.rows | Where-Object { $_.Count -ge 5 -and -not (($_[2] -eq 'GET') -and ($_[3] -eq '/manifest' -or $_[3] -eq '/pack/wikipedia_en_medicine_mini' -or $_[3] -eq '/pack/test-propagation')) })
$fromPhone = @($status.rows | Where-Object { $_[1] -eq $phoneIp }).Count
Write-Host "desktop status: $($status.status); requests from the phone in the log: $fromPhone; unexpected: $($bad.Count)"
foreach ($r in $results) { Write-Host "$($r.Run): $($r.Exit)" }
if ($hostProc.ExitCode -ne 0) { Write-Error "station host failed (see $out\host.err)"; exit 2 }
if ($bad.Count -gt 0 -or $fromPhone -eq 0) { Write-Error 'unexpected requests in the desktop log, or none from the phone'; exit 3 }
$failed = @($results | Where-Object { $_.Exit -ne 0 })
if ($failed.Count -gt 0) { exit 1 }
Write-Host 'STATION E2E PASS'
} finally {
  $deviceLocks | ForEach-Object { Exit-DeviceLock $_ }
}
