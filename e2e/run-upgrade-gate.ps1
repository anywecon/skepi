<#
.SYNOPSIS
  Release gate (docs/release-process.md, step 6): upgrading from every published Android version keeps
  every installed pack in its state. Runs on a dedicated API 36 emulator (google_apis x86_64, which runs the
  arm64 release APKs through its ARM translation), one clean emulator per scenario:
    v0.1.2  v0.1.2-preview (catalog 3) with the catalog-3 packs map-gr-20261005, places-gr-20261004
    v0.2.1  v0.2.1-preview (catalog 4) with the catalog-4 packs map-gr-20261024, places-gr-20261023
  plus the English medicine ZIM in both. Each scenario installs the published APK (SHA-256 checked against
  the release), pushes the packs, records the state of every pack in Library (Maestro), installs the
  candidate with `adb install -r` (no uninstall, data kept) and requires the same packs in the same state:
  verified stays verified ("Verified" or "Verified (older catalog)"), and no map or places file is ignored.
  The candidate must be signed with the release key (the published APKs are), so this runs on the signed
  release candidate. Exit 0 only when every scenario passes.

  -Candidate   the signed candidate APK
  -Scenarios   subset of v0.1.2, v0.2.1 (default both)
  -ApkDir      published APKs (downloaded with gh when missing)
  -CacheDir    pack files (scripts/provision.ps1's cache; each file's SHA-256 is checked)
  -Port        emulator console port (default 5590; serial emulator-<Port>)
  -FlowTimeoutMinutes  per Maestro flow (default 30: the first start hashes about 670 MB)
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Candidate,
  [ValidateSet('v0.1.2', 'v0.2.1')]
  [string[]]$Scenarios = @('v0.1.2', 'v0.2.1'),
  [string]$ApkDir = (Join-Path $env:LOCALAPPDATA 'skepi\upgrade-gate'),
  [string]$CacheDir = $(if ($env:SKEPI_CACHE_DIR) { $env:SKEPI_CACHE_DIR } else { Join-Path $env:LOCALAPPDATA 'skepi\cache' }),
  [string]$Avd = 'skepi-upgrade-api36',
  [ValidateRange(5554, 5682)]
  [int]$Port = 5590,
  [string]$Maestro = (Join-Path $env:USERPROFILE '.maestro\maestro\bin\maestro.bat'),
  [ValidateRange(5, 120)]
  [int]$FlowTimeoutMinutes = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $PSScriptRoot 'out\upgrade-gate'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$env:MAESTRO_CLI_NO_ANALYTICS = '1'
$env:MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED = 'true'
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$serial = "emulator-$Port"
$package = 'org.skepi.app'

# Published APKs (their SHA-256 as released) and the packs of the catalog each one embeds.
$zim = @{ Id = 'wikipedia_en_medicine_mini'; Dir = 'zim'; File = 'wikipedia_en_medicine_mini_2026-04.zim'; Sha256 = '' }
$published = @{
  'v0.1.2' = @{
    Apk = 'skepi-0.1.2-preview-arm64.apk'; Sha256 = '80fd1071905978cfa67a7bd96e97b77177ab71d6c66a63163820a355921ac628'
    Packs = @(
      $zim,
      @{ Id = 'map-gr'; Dir = 'maps'; File = 'map-gr-20261005.pmtiles'; Sha256 = 'e4b648dc5cad91469416157abf0ac2fcc26d96f23208de58ea5cc621aa1ebaad' },
      @{ Id = 'places-gr'; Dir = 'maps'; File = 'places-gr-20261004.sqlite'; Sha256 = '2431125abc15897e5fba32d18ff48791c579b1c1d1a9723f4d4811d85875f509' }
    )
  }
  'v0.2.1' = @{
    Apk = 'skepi-0.2.1-preview-arm64.apk'; Sha256 = 'a1c29b0505d399cbd8a7731aefcd250487bf51ca955c0a05540df8e0bd4c7761'
    Packs = @(
      $zim,
      @{ Id = 'map-gr'; Dir = 'maps'; File = 'map-gr-20261024.pmtiles'; Sha256 = '88cd15b2077f4d094adc4a0f82f36d15659a0812b47afc961535139b2ad3d061' },
      @{ Id = 'places-gr'; Dir = 'maps'; File = 'places-gr-20261023.sqlite'; Sha256 = 'e708169f5a14e7716b3a46c7427223258380dfb15350fadf78bf263e3de0babd' }
    )
  }
}
# The medicine ZIM is the same file in catalogs 3 and 4.
$catalog = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'catalog\embedded\release\catalog.json') | ConvertFrom-Json
$zim.Sha256 = ($catalog.packs | Where-Object { $_.id -eq $zim.Id }).sha256

function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Get-PublishedApk([string]$Version) {
  $p = $published[$Version]
  $dir = Join-Path $ApkDir $Version
  $path = Join-Path $dir $p.Apk
  if (-not (Test-Path $path)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    & gh release download "$Version-preview" --repo anywecon/skepi -p $p.Apk -D $dir --clobber
    if ($LASTEXITCODE -ne 0) { throw "could not download $($p.Apk)" }
  }
  if ((Get-Sha256 $path) -ne $p.Sha256) { throw "$path is not the published $Version APK" }
  return $path
}

function Invoke-Adb([string[]]$AdbArgs) {
  # Windows PowerShell turns native stderr into errors under 'Stop' (adb prints progress there).
  $ErrorActionPreference = 'Continue'
  $o = & adb -s $serial @AdbArgs 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { throw "adb $($AdbArgs -join ' '): $o" }
  return $o
}

function Start-GateEmulator {
  $avdIni = Join-Path $env:USERPROFILE ".android\avd\$Avd.ini"
  if (-not (Test-Path $avdIni)) {
    $avdmanager = Join-Path $sdk 'cmdline-tools\latest\bin\avdmanager.bat'
    'no' | & $avdmanager create avd -n $Avd -k 'system-images;android-36;google_apis;x86_64' -d pixel_6 | Out-Host
    $config = Join-Path $env:USERPROFILE ".android\avd\$Avd.avd\config.ini"
    Add-Content -Path $config -Value @('disk.dataPartition.size=8G', 'hw.ramSize=4096')
  }
  $emulator = Join-Path $sdk 'emulator\emulator.exe'
  $log = Join-Path $out "emulator-$Port.log"
  $proc = Start-Process -FilePath $emulator -ArgumentList @('-avd', $Avd, '-port', $Port, '-no-window', '-no-snapshot', '-wipe-data', '-no-boot-anim', '-no-audio', '-gpu', 'swiftshader_indirect') -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 300; $i += 2) {
    Start-Sleep -Seconds 2
    try { if (((& adb -s $serial shell getprop sys.boot_completed 2>$null) -join '').Trim() -eq '1') { return $proc } } catch { }
  }
  throw "$serial did not boot in 10 min (see $log)"
}

function Stop-GateEmulator($Proc) {
  try { & adb -s $serial emu kill 2>&1 | Out-Null } catch { }
  if ($Proc -and -not $Proc.WaitForExit(30000)) { & taskkill.exe /PID $Proc.Id /T /F 2>&1 | Out-Null }
}

# A Maestro flow that opens Library and requires every pack verified, and no ignored map or places file.
function Write-StateFlow([string]$Name, $Packs) {
  $lines = @(
    "appId: $package", "name: upgrade gate $Name", '---',
    '- launchApp:', '    stopApp: true',
    '- runFlow: ../../app-ready.yaml',
    # The first start after an upgrade hashes the packs (about 670 MB here) before content opens.
    # Ask shows "opening/verifying" until then (ContentGate), and the question field after.
    '- tapOn:', '    id: tab-ask',
    '- extendedWaitUntil:', '    visible:', '      id: "(ask-input|content-error|content-missing)"', '    timeout: 1500000',
    '- tapOn:', '    id: tab-library'
  )
  foreach ($p in $Packs) {
    # From the top each time: the order of the installed packs is not fixed.
    $lines += @(
      '- scrollUntilVisible:', '    element:', '      id: library-share', '    direction: UP', '    timeout: 30000',
      '- scrollUntilVisible:', '    element:', "      id: status-$($p.Id)", '    direction: DOWN', '    timeout: 60000',
      '- assertVisible:', "    id: status-$($p.Id)", '    text: "Verified.*"',
      "- takeScreenshot: e2e/out/upgrade-gate/$Name-$($p.Id)"
    )
  }
  $lines += @(
    '- scrollUntilVisible:', '    element:', '      id: library-import', '    direction: DOWN', '    timeout: 30000',
    '- assertNotVisible:', '    id: rejected-maps',
    '- assertNotVisible:', '    id: rejected-models',
    "- takeScreenshot: e2e/out/upgrade-gate/$Name-end"
  )
  $path = Join-Path $out "$Name.yaml"
  Set-Content -Encoding UTF8 -Path $path -Value $lines
  return $path
}

function Invoke-GateFlow([string]$Flow) {
  $maestroArgs = @('--device', $serial, 'test', $Flow, '-e', "APP_ID=$package", '--format', 'junit', '--output', "$Flow.xml", '--test-output-dir', $out)
  $quoted = ($maestroArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $proc = Start-Process -FilePath $Maestro -ArgumentList $quoted -NoNewWindow -PassThru -WorkingDirectory $root
  $null = $proc.Handle
  if (-not $proc.WaitForExit($FlowTimeoutMinutes * 60 * 1000)) {
    try { & taskkill.exe /PID $proc.Id /T /F *>&1 | Out-Host } catch { }
    Write-Warning "$Flow still running after $FlowTimeoutMinutes min: Maestro stopped."
    return 124
  }
  return $proc.ExitCode
}

if (-not (Test-Path $Candidate)) { throw "no candidate APK at $Candidate" }
$results = @()
. (Join-Path $root 'scripts\device-lock-lib.ps1')
foreach ($s in $Scenarios) {
  $p = $published[$s]
  $apk = Get-PublishedApk $s
  foreach ($pack in $p.Packs) {
    $f = Join-Path $CacheDir $pack.File
    if (-not (Test-Path $f)) { throw "missing $f (scripts/provision.ps1 -DownloadOnly, or the catalog's URL)" }
    if ((Get-Sha256 $f) -ne $pack.Sha256) { throw "$f does not match its catalog SHA-256" }
  }
  $lock = Enter-DeviceLock -Serial $serial -Purpose "e2e/run-upgrade-gate.ps1 $s"
  $emu = $null
  try {
    $emu = Start-GateEmulator
    Write-Host "== $s on $serial"
    Invoke-Adb @('install', $apk) | Out-Host
    # The app creates its own external files dir (correct owner) before anything is pushed into it.
    Invoke-Adb @('shell', 'monkey', '-p', $package, '-c', 'android.intent.category.LAUNCHER', '1') | Out-Null
    Start-Sleep -Seconds 15
    Invoke-Adb @('shell', 'am', 'force-stop', $package) | Out-Null
    $remote = "/sdcard/Android/data/$package/files"
    foreach ($pack in $p.Packs) {
      Invoke-Adb @('shell', 'mkdir', '-p', "$remote/$($pack.Dir)") | Out-Null
      Invoke-Adb @('push', (Join-Path $CacheDir $pack.File), "$remote/$($pack.Dir)/$($pack.File)") | Out-Host
    }
    $before = Invoke-GateFlow (Write-StateFlow "$s-before" $p.Packs)
    if ($before -ne 0) {
      $results += [pscustomobject]@{ Scenario = $s; Result = "SETUP FAILED: $s did not show every pack verified before the upgrade (Maestro $before)" }
      continue
    }
    Invoke-Adb @('install', '-r', $Candidate) | Out-Host
    $version = ((Invoke-Adb @('shell', 'dumpsys', 'package', $package)) | Select-String -Pattern 'versionName=' | Select-Object -First 1).Line.Trim()
    $after = Invoke-GateFlow (Write-StateFlow "$s-after" $p.Packs)
    $results += [pscustomobject]@{ Scenario = $s; Result = $(if ($after -eq 0) { "PASS (candidate $version)" } else { "FAIL: a pack lost its state after the upgrade to $version (Maestro $after)" }) }
  } finally {
    Stop-GateEmulator $emu
    Exit-DeviceLock $lock
  }
}
$results | Format-Table -AutoSize | Out-Host
if (@($results | Where-Object { $_.Result -notlike 'PASS*' }).Count -gt 0) {
  Write-Error 'UPGRADE GATE: FAIL'
  exit 1
}
Write-Host 'UPGRADE GATE: PASS'
