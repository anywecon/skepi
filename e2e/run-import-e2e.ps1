<#
.SYNOPSIS
  Import of an unknown ZIM through the document picker (e2e/import.yaml), without the mirror or a network:
  pushes the fixture to /sdcard/Download with a current mtime (e2e/download-fixture.ps1), runs the flow,
  removes the fixture. The app keeps the imported pack (download.yaml starts from clearState).
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

. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\device-lock-lib.ps1')
$deviceLocks = @(Enter-DeviceLock -Serial $Serial -Purpose 'e2e/run-import-e2e.ps1')
try {

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$env:MAESTRO_CLI_NO_ANALYTICS = '1'
$env:MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED = 'true'
$adbArgs = @()
if ($Serial) { $adbArgs += @('-s', $Serial) }

if (-not ((& adb.exe @adbArgs shell pm path $AppId) -match '^package:')) { throw "$AppId is not installed" }
. (Join-Path $PSScriptRoot 'download-fixture.ps1')

try {
  Push-DownloadFixture $adbArgs
  Push-Location $root
  try {
    $maestroArgs = @('test', 'e2e/import.yaml', '-e', "APP_ID=$AppId", '--format', 'junit', '--output', (Join-Path $out 'report-import.xml'), '--test-output-dir', $out)
    if ($Serial) { $maestroArgs = @('--device', $Serial) + $maestroArgs }
    & $Maestro @maestroArgs | Out-Host
    $flowExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  Remove-DownloadFixture $adbArgs
}

Write-Host "Maestro exit code (e2e/import.yaml): $flowExit"
if ($flowExit -ne 0) { exit $flowExit }
Write-Host 'IMPORT E2E PASS (unknown ZIM imported unverified, opened after consent, label kept)'
} finally {
  $deviceLocks | ForEach-Object { Exit-DeviceLock $_ }
}
