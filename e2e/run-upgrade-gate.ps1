<#
.SYNOPSIS
  Release gate (docs/release-process.md, step 6): upgrading from every published Android version keeps
  every installed pack in its state. Runs on a dedicated API 36 emulator (google_apis x86_64, which runs the
  arm64 release APKs through its ARM translation), one clean emulator per scenario:
    v0.1.2  v0.1.2-preview (catalog 3) with the catalog-3 packs map-gr-20261005, places-gr-20261004
    v0.2.1  v0.2.1-preview (catalog 4) with the catalog-4 packs map-gr-20261024, places-gr-20261023
    v0.2.3  v0.2.3-preview (catalog 4) with the same catalog-4 packs
  plus the English medicine ZIM in each. Each scenario installs the published APK (SHA-256 checked against
  the release), pushes the packs, records the state of every pack in Library (Maestro), installs the
  candidate with `adb install -r` (no uninstall, data kept) and requires the same packs in the same state:
  verified stays verified ("Verified" or "Verified (older catalog)"), and no map or places file is ignored.
  app.db (SQLCipher, key in the Android Keystore through expo-secure-store) must still open: after the
  upgrade the app goes straight to the home screen (onboarding completed before stays completed, no
  startup error) and logcat has no app.db error.
  `adb install -r` needs the same signer. By default the candidate must be signed with the release key (the
  published APKs are): the signed release candidate. With -DebugSigned the gate makes a throwaway key for
  this run (temp dir, random password, deleted at the end), re-signs each published APK (after its
  SHA-256 check) and the candidate with it, so an unsigned or debug-signed release-type build
  (org.skepi.app) can be checked before the release key is involved. Exit 0 only when every scenario passes.

  -Candidate   the candidate APK (org.skepi.app; signed with the release key unless -DebugSigned)
  -Scenarios   subset of v0.1.2, v0.2.1, v0.2.3 (default all)
  -DebugSigned re-sign the published APKs and the candidate with a throwaway key (see above)
  -ApkDir      published APKs (downloaded with gh when missing)
  -CacheDir    pack files (scripts/provision.ps1's cache; each file's SHA-256 is checked)
  -Port        emulator console port (default 5590; serial emulator-<Port>)
  -FlowTimeoutMinutes  per Maestro flow (default 30: the first start hashes about 670 MB)
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Candidate,
  [ValidateSet('v0.1.2', 'v0.2.1', 'v0.2.3')]
  [string[]]$Scenarios = @('v0.1.2', 'v0.2.1', 'v0.2.3'),
  [switch]$DebugSigned,
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
  # Same embedded catalog (sequence 4) and packs as v0.2.1.
  'v0.2.3' = @{
    Apk = 'skepi-0.2.3-preview-arm64.apk'; Sha256 = 'c6f003049c6f76ac3360c1f6bf2d4ca77ea923ca14c7f53efc22b0dac7a34c34'
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

# -DebugSigned: one throwaway signing key per run (never a project key), and the re-signing with it.
$script:gateKey = $null
function New-GateKey {
  $dir = Join-Path ([IO.Path]::GetTempPath()) ('skepi-upgrade-gate-' + [guid]::NewGuid().ToString('N'))
  $file = Join-Path $dir 'gate.p12'
  $script:gateKey = @{ Dir = $dir; File = $file }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # The password goes through the environment of this process only (not visible on a command line).
  $env:SKEPI_GATE_PASS = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
  $keytool = 'keytool'
  if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\keytool.exe'))) { $keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe' }
  $ErrorActionPreference = 'Continue'
  & $keytool -genkeypair -storetype PKCS12 -keystore $file -storepass:env SKEPI_GATE_PASS -keypass:env SKEPI_GATE_PASS -alias gate -keyalg EC -groupname secp256r1 -validity 2 -dname 'CN=SKEPI upgrade gate (throwaway)' -noprompt 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $file)) { throw 'keytool could not create the throwaway gate key' }
}
function Remove-GateKey {
  # The re-signed APKs live in the key's directory, so they go with it.
  if ($script:gateKey) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $script:gateKey.Dir; $script:gateKey = $null }
  Remove-Item Env:SKEPI_GATE_PASS -ErrorAction SilentlyContinue
}
function Get-Apksigner {
  $bt = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Where-Object { $_.Name -match '^\d+\.\d+' } | Sort-Object { [version]($_.Name -replace '[^0-9.].*$', '') } | Select-Object -Last 1
  $signer = Join-Path $bt.FullName 'apksigner.bat'
  if (-not (Test-Path $signer)) { throw "apksigner not found in $($bt.FullName)" }
  return $signer
}
function Invoke-GateResign([string]$Apk, [string]$Name) {
  $outApk = Join-Path $script:gateKey.Dir "$Name-gate-signed.apk"
  $ErrorActionPreference = 'Continue'
  & (Get-Apksigner) sign --ks $script:gateKey.File --ks-pass env:SKEPI_GATE_PASS --ks-key-alias gate --min-sdk-version 24 --out $outApk $Apk 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "apksigner could not re-sign $Apk" }
  return $outApk
}

# A Maestro flow that opens Library and requires every pack verified, and no ignored map or places file.
# -After: app.db must have opened with its old key (straight to the home screen: no onboarding again, no
# startup error) before Library is checked.
function Write-StateFlow([string]$Name, $Packs, [switch]$After) {
  if ($After) {
    $ready = @('- extendedWaitUntil:', '    visible:', '      id: tab-search', '    timeout: 120000', '- assertNotVisible:', '    id: onboarding')
  } else {
    $ready = @('- runFlow: ../../app-ready.yaml')
  }
  $lines = @(
    "appId: $package", "name: upgrade gate $Name", '---',
    '- launchApp:', '    stopApp: true'
  ) + $ready + @(
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
$mode = ''
if ($DebugSigned) {
  $mode = ' (debug-signed, not the release gate)'
  Write-Host 'upgrade gate: -DebugSigned, the published APKs and the candidate are re-signed with a throwaway key for this run'
}
try {
if ($DebugSigned) { New-GateKey }
$candidateApk = $Candidate
if ($DebugSigned) { $candidateApk = Invoke-GateResign $Candidate 'candidate' }
foreach ($s in $Scenarios) {
  $p = $published[$s]
  $apk = Get-PublishedApk $s
  if ($DebugSigned) { $apk = Invoke-GateResign $apk $s }
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
    # A larger log buffer: the startup line must survive a flow of up to 25 minutes.
    Invoke-Adb @('logcat', '-G', '16M') | Out-Null
    Invoke-Adb @('logcat', '-c') | Out-Null
    Invoke-Adb @('install', '-r', $candidateApk) | Out-Host
    $version = ((Invoke-Adb @('shell', 'dumpsys', 'package', $package)) | Select-String -Pattern 'versionName=' | Select-Object -First 1).Line.Trim()
    $after = Invoke-GateFlow (Write-StateFlow "$s-after" $p.Packs -After)
    $dbErrors = @((Invoke-Adb @('logcat', '-d')) | Where-Object { $_ -match '\[skepi\] app\.db|ERR_APP_DB|ERR_SECURE_STORAGE|SecureStorageError' })
    Set-Content -Encoding UTF8 -Path (Join-Path $out "$s-appdb-log.txt") -Value $dbErrors
    if ($dbErrors.Count -gt 0) { $result = "FAIL: app.db did not open after the upgrade to $version ($($dbErrors[0]))" }
    elseif ($after -eq 0) { $result = "PASS (candidate $version)$mode" }
    else { $result = "FAIL: app.db or a pack lost its state after the upgrade to $version (Maestro $after)" }
    $results += [pscustomobject]@{ Scenario = $s; Result = $result }
  } finally {
    Stop-GateEmulator $emu
    Exit-DeviceLock $lock
  }
}
} finally {
  Remove-GateKey
}
$results | Format-Table -AutoSize | Out-Host
if (@($results | Where-Object { $_.Result -notlike 'PASS*' }).Count -gt 0) {
  Write-Error 'UPGRADE GATE: FAIL'
  exit 1
}
Write-Host "UPGRADE GATE: PASS$mode"
