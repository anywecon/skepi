<#
.SYNOPSIS
  Runs the Maestro flows on the connected device in airplane mode and checks that the sealed
  WebView made zero network requests (blocked-request log must be empty).
  1. e2e/ask-en.yaml    English UI: search, article, Layer 1 + automatic AI summary with citation, problem report (not sent), no source, map.
  2. e2e/ask-t1.yaml    English UI, T1-simulation: Layer 1, then "Summarise with AI".
  3. e2e/medical.yaml   English UI: emergency number + Layer 1 only, no AI summary (not even on tap).
  4. e2e/onboarding.yaml "Get prepared" offline with the installed packs; readiness indicator.
  5. e2e/cards.yaml     Emergency button, numbers, an IFRC card and the Ready.gov / CDC cards with citation and disclaimer; an emergency question shows number + card first.
  6. e2e/tools.yaml     SOS torch and screen, compass, GNSS fix, SMS button (location permission granted here).
  6b. e2e/map-location.yaml (only with -MockLocation, debug build with map-gr) Live position on the map:
     puck, coordinates, "My location" centre/follow, panning leaves follow mode.
  7. e2e/blackout.yaml  Blackout mode with a simulated discharging battery at 25% (dumpsys battery), reset afterwards.
  7b. e2e/places.yaml  Place search (English and local names) and the emergency POI layer (map-gr, places-gr packs).
  8. e2e/locale-el.yaml Greek UI (frozen locale, only with -IncludeGreek): turns on the developer flag, app
     locale el-GR, Greek strings, a Greek Layer 1 answer (needs the zimLocale pack), English cards.
  The per-app locale (Android 13+) is reset to "follow the system" afterwards.
  -Only runs a subset (file names without .yaml).
  -AppId selects the installed build: org.skepi.app (release, default) or org.skepi.app.dev (debug).
  -MockLocation runs tools.yaml and map-location.yaml on the debug build (-ToolsAppId, default org.skepi.app.dev) with its
  debug-only mock GNSS provider (a fixed fix from files/e2e/mock-location.json, pushed here and removed
  afterwards): deterministic, no shell test provider. Release builds contain no mock code.
  No flow may open another app: a flow that taps a hand-off button (SMS, share sheet, dialler, system
  settings) is refused before anything runs, and a run in which the app started such an intent, or that
  leaves another app in front, fails. The hand-offs are checked by hand on the release candidate
  (docs/release-process.md, step 6).
  -FlowTimeoutMinutes (default 10): a flow still running then is stopped (Maestro's process tree), the
  remaining flows are skipped, the run ends with exit code 124 and the device lock is released.
#>
[CmdletBinding()]
param(
  [string]$Serial = '',
  [ValidatePattern('^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$')]
  [string]$AppId = 'org.skepi.app',
  [string]$Maestro = (Join-Path $env:USERPROFILE '.maestro\maestro\bin\maestro.bat'),
  [string[]]$Only = @(),
  # tools.yaml: deterministic fix from the debug build's mock provider (Phase 3a; replaces -SimulateGnss).
  [switch]$MockLocation,
  [ValidatePattern('^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$')]
  [string]$ToolsAppId = 'org.skepi.app.dev',
  # tools.yaml: feed the gps provider from a shell test provider (indoors, no sky view). Flaky on the S23
  # (positions stop arriving); kept for release-only runs.
  [switch]$SimulateGnss,
  # The frozen Greek UI flow (English-only until v1: optional, never part of the required suite).
  [switch]$IncludeGreek,
  [ValidateRange(1, 120)]
  [int]$FlowTimeoutMinutes = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Shared device lock (scripts/device-lock.ps1): waits while another project or session uses the
# device and never stops their processes; released in the finally block at the end of this script.
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\device-lock-lib.ps1')
$deviceLocks = @(Enter-DeviceLock -Serial $Serial -Purpose 'e2e/run-e2e.ps1')
try {

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$env:MAESTRO_CLI_NO_ANALYTICS = '1'
$env:MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED = 'true'

$adbArgs = @()
if ($Serial) { $adbArgs += @('-s', $Serial) }

# The S23 drops off adb for a few seconds when Maestro closes its session (USB re-enumeration): wait
# for it before the next flow, the restore steps and the egress checks instead of failing them.
function Wait-Adb([int]$Seconds = 90) {
  for ($i = 0; $i -lt $Seconds; $i += 1) {
    # Windows PowerShell turns adb's "device not found" on stderr into an error under 'Stop'.
    try { if (((& adb @adbArgs get-state 2>$null) -join '').Trim() -eq 'device') { return } } catch { }
    Start-Sleep -Seconds 1
  }
  throw "the device is not back on adb after $Seconds s"
}

$package = $AppId
if ($MockLocation -and $SimulateGnss) { throw '-MockLocation and -SimulateGnss are exclusive' }
if ($MockLocation -and $ToolsAppId -eq 'org.skepi.app') { throw '-MockLocation needs the debug build (release builds have no mock provider)' }
$toolsPackage = $(if ($MockLocation) { $ToolsAppId } else { $AppId })

function Set-AppLocale([string]$Locales, [string]$App = $package) {
  $localeArgs = @('shell', 'cmd', 'locale', 'set-app-locales', $App)
  if ($Locales) { $localeArgs += @('--locales', $Locales) }
  & adb @adbArgs @localeArgs
  if ($LASTEXITCODE -ne 0) { throw "could not set app locale '$Locales'" }
}

# Sum of rx+tx bytes of one UID over every non-loopback interface since boot (dumpsys netstats).
function Get-UidBytes([string]$Uid) {
  & adb @adbArgs shell dumpsys netstats --poll | Out-Null
  $lines = & adb @adbArgs shell dumpsys netstats detail
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

# Buttons that hand off to another app (SMS app, share sheet, dialler, system settings). A tap on one
# leaves that app's task behind (Samsung Messages' contact picker came back to the front whenever the
# app was stopped later, and a stray tap there could send a message): flows check them, never tap them.
$handOffIds = '^(location-sms|location-settings|report-share|card-call|call-[\w-]+)$'
$handOffTexts = '^(?i)(call\b|send\b|share\b|\u039a\u03bb\u03ae\u03c3\u03b7)'
function Assert-NoHandOffTaps([string]$Flow, [hashtable]$Seen = @{}) {
  $path = Join-Path $root $Flow
  if ($Seen.ContainsKey($path)) { return }
  $Seen[$path] = $true
  $lines = @(Get-Content -Encoding UTF8 $path)
  # Subflows (runFlow: x.yaml, or file: x.yaml under runFlow) are checked too, relative to this flow.
  foreach ($line in $lines) {
    if ($line -match '^\s*-?\s*(runFlow|file):\s*"?([\w./-]+\.ya?ml)"?\s*$') {
      Assert-NoHandOffTaps (Join-Path (Split-Path -Parent $Flow) $Matches[2]) $Seen
    }
  }
  for ($i = 0; $i -lt $lines.Count; $i += 1) {
    if ($lines[$i] -notmatch '^\s*-?\s*(tapOn|longPressOn|doubleTapOn):\s*(.*)$') { continue }
    # (kind, value): `tapOn: "Text"` and `text:` match visible text, `id:` a testID.
    $targets = @()
    $inline = $Matches[2].Trim().Trim('"', "'")
    if ($inline) { $targets += , @('text', $inline) }
    for ($j = $i + 1; $j -lt $lines.Count -and $lines[$j] -match '^\s+[^-\s#]'; $j += 1) {
      if ($lines[$j] -match '^\s+(id|text):\s*(.+)$') { $targets += , @($Matches[1], $Matches[2].Trim().Trim('"', "'")) }
    }
    foreach ($t in $targets) {
      if (($t[0] -eq 'id' -and $t[1] -match $handOffIds) -or ($t[0] -eq 'text' -and $t[1] -match $handOffTexts)) {
        throw "$Flow line $($i + 1): taps the hand-off '$($t[1])', which opens another app. Check it with assertVisible instead."
      }
    }
  }
}

# Intents that leave the app (logged by the system as START u0 {act=...}); none may appear during E2E.
$handOffIntent = 'START u0 \{act=(android\.intent\.action\.(VIEW dat=(sms|smsto|mms|tel|mailto|geo|https?):|CHOOSER|SEND|SENDTO|DIAL|CALL)|android\.settings\.)'
# Lines naming another caller ("from uid N") are system or other apps, not the app under test.
function Get-HandOffIntents {
  return @(& adb @adbArgs logcat -d | Select-String -Pattern $handOffIntent | ForEach-Object { $_.Line } |
    Where-Object { $_ -notmatch 'from uid (\d+)' -or $Matches[1] -in @($uid, $toolsUid) })
}
# Another app's activity in front after a flow (the launcher, the app under test and Maestro are fine).
function Get-ForeignForeground {
  $line = (& adb @adbArgs shell dumpsys activity activities) | Select-String -Pattern 'topResumedActivity=' | Select-Object -First 1
  if (-not $line -or $line.Line -notmatch ' u0 ([\w.]+)/') { return $null }
  $pkg = $Matches[1]
  if ($pkg -in @($package, $toolsPackage)) { return $null }
  if ($pkg -match '^(com\.sec\.android\.app\.launcher|com\.google\.android\.apps\.nexuslauncher|com\.android\.launcher3|dev\.mobile\.maestro.*|com\.(google\.)?android\.permissioncontroller)$') { return $null }
  return $pkg
}

function Invoke-Flow([string]$Flow, [string]$Report, [string]$App = $package) {
  # APP_ID is ASCII, so -e is safe here (Greek values stay in the flows' env blocks).
  $maestroArgs = @('test', $Flow, '-e', "APP_ID=$App", '--format', 'junit', '--output', (Join-Path $out $Report), '--test-output-dir', $out)
  if ($Serial) { $maestroArgs = @('--device', $Serial) + $maestroArgs }
  # A child process with a deadline: a hung Maestro (it once waited for hours without reaching the
  # device) must not hold the device lock. Its output goes to this console.
  $quoted = ($maestroArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $proc = Start-Process -FilePath $Maestro -ArgumentList $quoted -NoNewWindow -PassThru
  # Holding the handle keeps ExitCode readable after the process ends (otherwise it comes back empty).
  $null = $proc.Handle
  if (-not $proc.WaitForExit($FlowTimeoutMinutes * 60 * 1000)) {
    # /T: maestro.bat runs Maestro in a child java process.
    # taskkill writes to stderr when part of the tree has already exited: not an error here.
    try { & taskkill.exe /PID $proc.Id /T /F *>&1 | Out-Host } catch { }
    $proc.WaitForExit(30000) | Out-Null
    Write-Warning "$Flow still running after $FlowTimeoutMinutes min: Maestro stopped."
    # The killed flow's onFlowComplete never ran: leave the shared phone out of airplane mode.
    try { & adb @adbArgs shell cmd connectivity airplane-mode disable *>&1 | Out-Null } catch { }
    return 124
  }
  return $proc.ExitCode
}

& adb @adbArgs logcat -c
function Get-AppUid([string]$App) {
  $match = (& adb @adbArgs shell dumpsys package $App) | Select-String -Pattern 'appId=(\d+)' | Select-Object -First 1
  if (-not $match) { throw "$App is not installed" }
  return $match.Matches[0].Groups[1].Value
}
$uid = Get-AppUid $package
$bytesBefore = Get-UidBytes $uid
$toolsUid = Get-AppUid $toolsPackage
$toolsBytesBefore = $(if ($toolsUid -ne $uid) { Get-UidBytes $toolsUid } else { 0 })
$script:handOffs = @()
$script:foreign = @()
$flows = @(
  # tools.yaml first: with -SimulateGnss the test provider stopped receiving positions when tools.yaml ran
  # after other flows (cause not found; standalone and first-in-suite runs pass).
  @{ Flow = 'e2e/tools.yaml'; Report = 'report-tools.xml'; Locale = 'en-US'; Location = $true },
  @{ Flow = 'e2e/onboarding.yaml'; Report = 'report-onboarding.xml'; Locale = 'en-US' },
  @{ Flow = 'e2e/ask-en.yaml'; Report = 'report-en.xml'; Locale = 'en-US' },
  @{ Flow = 'e2e/ask-t1.yaml'; Report = 'report-t1.xml'; Locale = 'en-US' },
  @{ Flow = 'e2e/medical.yaml'; Report = 'report-medical.xml'; Locale = 'en-US' },
  @{ Flow = 'e2e/cards.yaml'; Report = 'report-cards.xml'; Locale = 'en-US' },
  @{ Flow = 'e2e/blackout.yaml'; Report = 'report-blackout.xml'; Locale = 'en-US'; Battery = $true },
  @{ Flow = 'e2e/places.yaml'; Report = 'report-places.xml'; Locale = 'en-US' }
)
# The live map position needs a deterministic fix: the debug build's mock provider (-MockLocation).
if ($MockLocation) { $flows = @($flows[0], @{ Flow = 'e2e/map-location.yaml'; Report = 'report-map-location.xml'; Locale = 'en-US'; Location = $true }) + @($flows | Select-Object -Skip 1) }
if ($IncludeGreek) { $flows += @{ Flow = 'e2e/locale-el.yaml'; Report = 'report-el.xml'; Locale = 'el-GR' } }
# -Only a,b arrives as one string through powershell -File: split it.
$Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
if ($Only.Count -gt 0) { $flows = @($flows | Where-Object { $Only -contains [IO.Path]::GetFileNameWithoutExtension($_.Flow) }) }
if ($flows.Count -eq 0) { throw "no flow matches -Only $($Only -join ',')" }

# Location "while in use" for the GNSS step of tools.yaml and the map position (map-location.yaml).
& adb @adbArgs shell pm grant $toolsPackage android.permission.ACCESS_FINE_LOCATION
& adb @adbArgs shell pm grant $toolsPackage android.permission.ACCESS_COARSE_LOCATION

# tools.yaml needs location services on (GNSS works in airplane mode); the previous state is restored.
$locationWasOn = ((& adb @adbArgs shell cmd location is-location-enabled) -join '').Trim() -eq 'true'
function Set-Location([bool]$On) {
  & adb @adbArgs shell cmd location set-location-enabled $(if ($On) { 'true' } else { 'false' })
}

# Indoors the phone gets no GNSS fix. -SimulateGnss replaces the gps provider with a shell test provider
# (Patras) for tools.yaml so the fix -> coordinates -> SMS path runs; without it the flow needs sky view.
function Start-TestGps {
  # The shell needs the MOCK_LOCATION app-op for test providers; Stop-TestGps sets it back to deny.
  # Airplane mode first, so the provider is set up in the radio state the flow runs in (the flow's own
  # setAirplaneMode step is then a no-op).
  & adb @adbArgs shell cmd connectivity airplane-mode enable | Out-Null
  Start-Sleep -Seconds 3
  & adb @adbArgs shell appops set com.android.shell MOCK_LOCATION allow | Out-Null
  & adb @adbArgs shell cmd location providers add-test-provider gps --requiresSatellite | Out-Null
  & adb @adbArgs shell cmd location providers set-test-provider-enabled gps true | Out-Null
  # A host-side feeder (e2e/gps-feeder.ps1): one adb call per position, each with a timeout, because
  # Maestro restarts its device driver during a flow (a loop on the device died after ~10 s).
  $feederArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'gps-feeder.ps1'), '-Adb', (Get-Command adb).Source)
  if ($Serial) { $feederArgs += @('-Serial', $Serial) }
  $script:gpsFeeder = Start-Process -FilePath powershell -ArgumentList $feederArgs -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 4
  $last = (& adb @adbArgs shell dumpsys location) | Select-String -SimpleMatch 'last location=Location[gps 38.246640,21.734570' | Select-Object -First 1
  if (-not $last) { Write-Warning 'test GPS provider is not delivering locations' } else { Write-Host 'test GPS provider active (simulated fix, Patras)' }
}
# -MockLocation: the debug build reads one fixed fix (Patras) from its files dir; nothing else changes.
$mockFile = "/sdcard/Android/data/$toolsPackage/files/e2e/mock-location.json"
function Start-MockLocation {
  $local = Join-Path $out 'mock-location.json'
  [IO.File]::WriteAllText($local, '{"latitude":38.24664,"longitude":21.73457,"accuracyM":5,"altitudeM":10}')
  $env:MSYS_NO_PATHCONV = '1'
  & adb @adbArgs shell mkdir -p "/sdcard/Android/data/$toolsPackage/files/e2e" | Out-Null
  & adb @adbArgs push $local $mockFile | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'could not push the mock location file' }
  Write-Host "mock location provider armed for $toolsPackage (fixed fix, Patras)"
}
function Stop-MockLocation {
  & adb @adbArgs shell rm -f $mockFile | Out-Null
}
function Stop-TestGps {
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*gps-feeder.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $script:gpsFeeder = $null
  & adb @adbArgs shell cmd location providers remove-test-provider gps | Out-Null
  & adb @adbArgs shell appops set com.android.shell MOCK_LOCATION deny | Out-Null
}

# Blackout flow: a discharging battery at 25% (the phone is on USB power during E2E).
function Set-SimulatedBattery([bool]$On) {
  if ($On) {
    & adb @adbArgs shell dumpsys battery unplug
    & adb @adbArgs shell dumpsys battery set status 3
    & adb @adbArgs shell dumpsys battery set level 25
  } else {
    & adb @adbArgs shell dumpsys battery reset
  }
}
foreach ($f in $flows) { Assert-NoHandOffTaps $f.Flow }
$results = @()
Push-Location $root
try {
  foreach ($f in $flows) {
    $location = $f.ContainsKey('Location')
    $app = $(if ($location) { $toolsPackage } else { $package })
    Set-AppLocale $f.Locale $app
    if ($location) { Set-Location $true; if ($SimulateGnss) { Start-TestGps }; if ($MockLocation) { Start-MockLocation } }
    $battery = $f.ContainsKey('Battery')
    if ($battery) { Set-SimulatedBattery $true }
    try {
      $exit = Invoke-Flow $f.Flow $f.Report $app
      $results += [pscustomobject]@{ Flow = $f.Flow; App = $app; Exit = $exit }
      Wait-Adb
      # Checked after every flow: later flows push the lines out of the log buffer.
      $new = @(Get-HandOffIntents | Where-Object { $_ -notin $script:handOffs })
      if ($new.Count -gt 0) { $new | ForEach-Object { Write-Warning "$($f.Flow): intent to another app: $_" }; $script:handOffs += $new }
      $pkg = Get-ForeignForeground
      if ($pkg) { Write-Warning "$($f.Flow): another app is in front afterwards: $pkg"; $script:foreign += "$($f.Flow): $pkg" }
      if ($exit -eq 124) { break }
    } finally {
      if ($battery) { Set-SimulatedBattery $false }
      if ($location -and $SimulateGnss) { Stop-TestGps }
      if ($location -and $MockLocation) { Stop-MockLocation; Set-AppLocale '' $toolsPackage }
      if ($location -and -not $locationWasOn) { Set-Location $false }
    }
  }
} finally {
  Wait-Adb
  Set-SimulatedBattery $false
  if (-not $locationWasOn) { Set-Location $false }
  Set-AppLocale ''
  Pop-Location
}

$egress = (Get-UidBytes $uid) - $bytesBefore
if ($toolsUid -ne $uid) { $egress += (Get-UidBytes $toolsUid) - $toolsBytesBefore }
$downloads = @(& adb @adbArgs logcat -d -s 'SkepiContentStore:*' | Select-String -SimpleMatch 'download requested:')
$log = & adb @adbArgs logcat -d -s 'ExpoZim:*'
$log | Set-Content -Encoding UTF8 (Join-Path $out 'expozim-logcat.txt')
$blocked = @($log | Select-String -SimpleMatch 'blocked request')
$blocked | ForEach-Object { $_.Line } | Set-Content -Encoding UTF8 (Join-Path $out 'blocked-requests.txt')

foreach ($r in $results) { Write-Host "Maestro exit code ($($r.Flow), $($r.App)): $($r.Exit)" }
Write-Host "Blocked WebView requests during E2E: $($blocked.Count)"
Write-Host "ContentStore download requests during E2E: $($downloads.Count)"
Write-Host "Bytes of UID $uid$(if ($toolsUid -ne $uid) { " + $toolsUid" }) over real interfaces during E2E: $egress"
Write-Host "Intents to other apps during E2E: $($script:handOffs.Count)"
Write-Host "Other apps left in front: $($script:foreign.Count)"
$failed = @($results | Where-Object { $_.Exit -ne 0 })
if (@($results | Where-Object { $_.Exit -eq 124 }).Count -gt 0) {
  Write-Error "A flow did not finish within $FlowTimeoutMinutes min; Maestro was stopped and the remaining flows skipped."
  exit 124
}
if ($script:handOffs.Count -gt 0 -or $script:foreign.Count -gt 0) {
  Write-Error 'A flow opened another app (SMS, share sheet, dialler or settings); no E2E step may.'
  exit 5
}
if ($failed.Count -gt 0) { exit $failed[0].Exit }
if ($downloads.Count -gt 0 -or $egress -ne 0) {
  Write-Error 'The app reached the network during the offline flows (zero-egress check).'
  exit 4
}
if ($blocked.Count -gt 0) {
  Write-Error 'WebView attempted non-zim requests during E2E (see e2e/out/blocked-requests.txt).'
  exit 3
}
Write-Host 'E2E PASS'
} finally {
  $deviceLocks | ForEach-Object { Exit-DeviceLock $_ }
}
