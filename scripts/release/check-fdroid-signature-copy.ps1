<#
.SYNOPSIS
  Reproduces F-Droid's verification of the signed release APK before it is published: copies the
  signature from the signed APK onto the CI's unsigned APK with apksigcopier (as fdroidserver does for
  a recipe with Binaries:), runs apksigner verify on the result and requires it to be byte-identical
  to the signed APK. docs/release-process.md.

  apksigcopier 1.1.1 (the version fdroidserver vendors) is installed with pip --require-hashes from
  scripts/release/apksigcopier-requirements.txt into a throwaway venv under $env:TEMP\skepi.
  No key is involved: the check reads the two APKs only.

.EXAMPLE
  ./scripts/release/check-fdroid-signature-copy.ps1 -Signed $env:TEMP\skepi\release\skepi-0.2.2-preview-arm64.apk -Unsigned $env:TEMP\skepi\release\skepi-0.2.2-preview-arm64-unsigned.apk
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Signed,
  [Parameter(Mandatory = $true)][string]$Unsigned,
  [string]$BuildTools = '',
  [string]$Venv = (Join-Path $env:TEMP 'skepi\apksigcopier-venv')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Signed = (Resolve-Path $Signed).Path
$Unsigned = (Resolve-Path $Unsigned).Path

if (-not $BuildTools) {
  $sdk = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT })
  if (-not $sdk) { throw 'ANDROID_HOME is not set' }
  $BuildTools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory |
    Sort-Object { [version]($_.Name -replace '-.*$', '') } | Select-Object -Last 1 -ExpandProperty FullName
}
$apksigner = Join-Path $BuildTools 'apksigner.bat'
if (-not (Test-Path $apksigner)) { throw "missing $apksigner" }

$python = Join-Path $Venv 'Scripts\python.exe'
if (-not (Test-Path $python)) {
  python -m venv $Venv
  if ($LASTEXITCODE -ne 0) { throw 'python -m venv failed' }
}
& $python -m pip install --quiet --disable-pip-version-check --require-hashes -r (Join-Path $root 'scripts\release\apksigcopier-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'pip install of apksigcopier failed' }

$work = Join-Path $env:TEMP "skepi\sigcp-$PID"
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
  & $python -I (Join-Path $root 'scripts\release\fdroid-signature-copy.py') $Signed $Unsigned $apksigner $work
  if ($LASTEXITCODE -ne 0) { throw 'F-Droid signature copy check failed: do not publish this APK' }
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
