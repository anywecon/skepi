<#
.SYNOPSIS
  P2P E2E between two Android emulators on one virtual Wi-Fi LAN (debug build org.skepi.app.dev).
.DESCRIPTION
  Start the emulators with Wi-Fi forwarding so both join the same virtual access point (shared LAN,
  no internet needed by the app):
    emulator -avd skepi-host -port 5554 -wifi-server-port 9999
    emulator -avd skepi-recv -port 5556 -wifi-client-port 9999
  Build: gradlew assembleDebug -PskepiBundleDebug=true (arm64; x86_64 images run it through ARM translation).
  1. Fresh installs (pm clear). Host: adopts the newer test catalog (sequence 4) from the local HTTPS
     test mirror (adb reverse), then gets test-smoke-en (64 KiB chunks), test-mirror-fallback and
     p2p-propagation (known only to sequence 4) plus the map-gr and places-gr packs pushed into its
     content folders; the app registers them as verified on restart. The receiver keeps sequence 3.
  2. Scenarios (p2p-host.yaml on the host, p2p-receive.yaml on the receiver; the pairing code goes
     from the host's files/p2p/pairing.json to the receiver's files/p2p/pairing-in.json — debug only):
     propagate      newer signed catalog adopted; a corrupted chunk re-requested alone; a dropped
                    connection interrupts; the next Receive resumes from the verified chunks
     tampered       a host that alters every chunk: the pack is rejected, nothing installed
     bad-signature  the host's catalog with a wrong signature: not accepted
     rollback       the host's older catalog (sequence 3) after the receiver adopted 4: not accepted
  3. places.yaml on the host emulator (offline place search and emergency POI layer).
  Hotspot mode needs real Wi-Fi hardware (LocalOnlyHotspot); with one physical device it stays pending.
#>
[CmdletBinding()]
param(
  [string]$HostSerial = 'emulator-5554',
  [string]$ReceiverSerial = 'emulator-5556',
  [string]$AppId = 'org.skepi.app.dev',
  [string]$Maestro = (Join-Path $env:USERPROFILE '.maestro\maestro\bin\maestro.bat'),
  # Persistent cache (Phase 3a): SKEPI_CACHE_DIR, else %LOCALAPPDATA%\skepi\cache (never %TEMP%).
  [string]$CacheDir = $(if ($env:SKEPI_CACHE_DIR) { $env:SKEPI_CACHE_DIR } else { Join-Path $env:LOCALAPPDATA 'skepi\cache' }),
  [string[]]$Only = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Shared device lock (scripts/device-lock.ps1): waits while another project or session uses the
# device and never stops their processes; released in the finally block at the end of this script.
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\device-lock-lib.ps1')
. (Join-Path $PSScriptRoot 'mirror\mirror-certs.ps1')
$deviceLocks = @(@($HostSerial, $ReceiverSerial) | Sort-Object | ForEach-Object { Enter-DeviceLock -Serial $_ -Purpose 'e2e/run-p2p.ps1' })
try {

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$env:MAESTRO_CLI_NO_ANALYTICS = '1'
$env:MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED = 'true'
$files = "/sdcard/Android/data/$AppId/files"

function Adb([string]$Serial) { & adb.exe -s $Serial @args }

function Invoke-Flow([string]$Serial, [string]$Flow, [string]$Report, [hashtable]$Env = @{}) {
  $a = @('--device', $Serial, 'test', $Flow, '-e', "APP_ID=$AppId", '--format', 'junit', '--output', (Join-Path $out $Report), '--test-output-dir', $out)
  foreach ($k in $Env.Keys) { $a += @('-e', "$k=$($Env[$k])") }
  & $Maestro @a | Out-Host
  return $LASTEXITCODE
}

function Wait-AppFolders([string]$Serial) {
  for ($i = 0; $i -lt 90; $i++) {
    # Started again every 20 s: right after pm clear the first start is sometimes dropped.
    if ($i % 10 -eq 0) { Adb $Serial shell am start -n "$AppId/org.skepi.app.MainActivity" | Out-Null }
    $ls = (Adb $Serial shell "ls $files 2>/dev/null") -join ' '
    if ($ls -match 'zim') { return }
    Start-Sleep -Seconds 2
  }
  throw "$Serial`: the app did not create its content folders"
}

function Push-Content([string]$Serial, [string]$Local, [string]$Dir) {
  Adb $Serial push $Local "$files/$Dir/" | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "push $Local failed" }
}

$results = @()
$server = $null
Push-Location $root
try {
  # Test mirror certificates first: the host's debug app must embed this ca.crt (fail before any device change).
  Initialize-MirrorCerts
  Assert-InstalledAppTrustsMirror @('-s', $HostSerial) $AppId
  foreach ($s in @($HostSerial, $ReceiverSerial)) {
    Adb $s shell pm clear $AppId | Out-Null
    Start-Sleep -Seconds 2
    Wait-AppFolders $s
    Adb $s shell am force-stop $AppId | Out-Null
  }
  # Wi-Fi on (an earlier offline flow may have left airplane mode or Wi-Fi off), then wait for the LAN.
  foreach ($s in @($HostSerial, $ReceiverSerial)) {
    Adb $s shell cmd connectivity airplane-mode disable | Out-Null
    Adb $s shell svc wifi enable | Out-Null
    for ($i = 0; $i -lt 30 -and -not ((Adb $s shell ip -4 addr show wlan0) -match 'inet '); $i++) { Start-Sleep -Seconds 2 }
  }
  $hostIp = ((Adb $HostSerial shell ip -4 addr show wlan0) | Select-String -Pattern 'inet (\d+\.\d+\.\d+\.\d+)').Matches[0].Groups[1].Value
  $recvIp = ((Adb $ReceiverSerial shell ip -4 addr show wlan0) | Select-String -Pattern 'inet (\d+\.\d+\.\d+\.\d+)').Matches[0].Groups[1].Value
  Write-Host "host $hostIp, receiver $recvIp (shared virtual Wi-Fi)"

  # Host: newer catalog from the local test mirror (host emulator only).
  $server = Start-Process -FilePath node -ArgumentList (Join-Path $PSScriptRoot 'mirror\server.mjs') -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $out 'mirror-stdout.txt') -RedirectStandardError (Join-Path $out 'mirror-stderr.txt')
  Start-Sleep -Seconds 2
  Adb $HostSerial reverse tcp:8443 tcp:8443 | Out-Null
  $results += [pscustomobject]@{ Flow = 'host catalog 4'; Exit = (Invoke-Flow $HostSerial 'e2e/p2p-host-catalog.yaml' 'report-p2p-host-catalog.xml') }
  Adb $HostSerial reverse --remove tcp:8443 | Out-Null

  # Host content: registered as verified by the catalog on the next start.
  Push-Content $HostSerial (Join-Path $root 'tools\rag-eval\fixtures\eval-smoke-en.zim') 'zim'
  Push-Content $HostSerial (Join-Path $root 'tools\rag-eval\fixtures\eval-synthetic.zim') 'zim'
  Push-Content $HostSerial (Join-Path $root 'e2e\fixtures\p2p-propagation.zim') 'zim'
  Push-Content $HostSerial (Join-Path $CacheDir 'map-gr-20261005.pmtiles') 'maps'
  Push-Content $HostSerial (Join-Path $CacheDir 'places-gr-20261004.sqlite') 'maps'

  $scenarios = @(
    @{ Name = 'propagate'; Host = @{ PACK1 = 'test-smoke-en'; PACK2 = 'test-propagation'; CATALOG_FAULT = 'none'; FAULT_CORRUPT = 'true'; FAULT_DROP = 'true'; FAULT_TAMPER = 'false' } },
    @{ Name = 'tampered'; Host = @{ PACK1 = 'test-mirror-fallback'; PACK2 = ''; CATALOG_FAULT = 'none'; FAULT_CORRUPT = 'false'; FAULT_DROP = 'false'; FAULT_TAMPER = 'true' } },
    @{ Name = 'bad-signature'; Host = @{ PACK1 = 'test-mirror-fallback'; PACK2 = ''; CATALOG_FAULT = 'bad-signature'; FAULT_CORRUPT = 'false'; FAULT_DROP = 'false'; FAULT_TAMPER = 'false' } },
    @{ Name = 'rollback'; Host = @{ PACK1 = 'test-mirror-fallback'; PACK2 = ''; CATALOG_FAULT = 'embedded'; FAULT_CORRUPT = 'false'; FAULT_DROP = 'false'; FAULT_TAMPER = 'false' } }
  )
  $Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
  foreach ($sc in $scenarios) {
    if ($Only.Count -gt 0 -and $Only -notcontains $sc.Name) { continue }
    Adb $HostSerial shell "rm -f $files/p2p/pairing.json" | Out-Null
    $hostEnv = $sc.Host.Clone()
    $hostEnv.SCENARIO = $sc.Name
    $code = Invoke-Flow $HostSerial 'e2e/p2p-host.yaml' "report-p2p-host-$($sc.Name).xml" $hostEnv
    $results += [pscustomobject]@{ Flow = "host $($sc.Name)"; Exit = $code }
    if ($code -ne 0) { continue }
    $pairing = Join-Path $out 'pairing.json'
    Adb $HostSerial pull "$files/p2p/pairing.json" $pairing | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'no pairing code from the host' }
    Write-Host "pairing: $(Get-Content -Raw $pairing)"
    Adb $ReceiverSerial shell "mkdir -p $files/p2p" | Out-Null
    Adb $ReceiverSerial push $pairing "$files/p2p/pairing-in.json" | Out-Null
    $results += [pscustomobject]@{ Flow = "receiver $($sc.Name)"; Exit = (Invoke-Flow $ReceiverSerial 'e2e/p2p-receive.yaml' "report-p2p-recv-$($sc.Name).xml" @{ SCENARIO = $sc.Name }) }
  }

  # Evidence: what the receiver installed and where it came from.
  $installed = (Adb $ReceiverSerial shell "ls -l $files/zim $files/tmp 2>/dev/null") -join "`n"
  $installed | Set-Content -Encoding UTF8 (Join-Path $out 'p2p-receiver-files.txt')
  Write-Host $installed

  if ($Only.Count -eq 0 -or $Only -contains 'places') {
    $results += [pscustomobject]@{ Flow = 'places (host emulator)'; Exit = (Invoke-Flow $HostSerial 'e2e/places.yaml' 'report-places.xml') }
  }
} finally {
  if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Pop-Location
}

foreach ($r in $results) { Write-Host "$($r.Flow): exit $($r.Exit)" }
if (@($results | Where-Object { $_.Exit -ne 0 }).Count -gt 0) { Write-Error 'P2P E2E FAILED'; exit 1 }
Write-Host 'P2P E2E PASS'
} finally {
  $deviceLocks | ForEach-Object { Exit-DeviceLock $_ }
}
