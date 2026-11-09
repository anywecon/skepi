<#
.SYNOPSIS
  Signs the reproducible unsigned APK from CI (android-repro) with the SKEPI release key, locally, and
  proves that the signed APK holds exactly the CI artifact's contents. docs/release-process.md.

  0. Provenance (ReleaseProvenance.psm1): -Tag names a commit on GitHub, and the unsigned APK is byte
     for byte the artifact of a successful android-repro run of this repository (push or
     workflow_dispatch on main) for that commit, downloaded again from the run. Before any password.
  1. The unsigned APK matches its SHA256SUMS.txt (from the same artifact) and carries no signature.
  2. It is already zip-aligned (4 bytes, native libraries on 16 KB pages): nothing is rewritten.
  3. apksigner signs it with the key named in ~/.gradle/gradle.properties (SKEPI_RELEASE_STORE_FILE,
     SKEPI_RELEASE_KEY_ALIAS; not secret). The passwords are prompted at run time by tools/Signing.psm1
     (Use-SigningSecrets) and reach apksigner only as process env vars SKEPI_RELEASE_STORE_PASSWORD and
     SKEPI_RELEASE_KEY_PASSWORD (--ks-pass env:/--key-pass env:), removed when it exits; never an argument
     value, a file or a log. Owner-only: refuses to run non-interactively, in CI or under an agent. Same
     scheme as the Gradle release build (APK Signature Scheme v2 only; no v1, minSdk 24).
  4. The signer certificate's SHA-256 is the published SKEPI fingerprint.
  5. The signed APK holds the unsigned APK's entries byte for byte (only the signature is added), and
     apksigner verify passes.
  6. The signed APK is the unsigned APK byte for byte plus an APK Signing Block, so F-Droid's
     apksigcopier can copy the signature onto its own reproducible build. apksigner signs with
     --alignment-preserved true: by default it re-aligns every entry, which keeps the contents (5) but
     not the bytes; that is why fdroiddata's build of v0.1.1-preview failed (merge request 53588,
     2026-10-22: "APK integrity check failed. CHUNKED_SHA512 digest mismatch").
  7. F-Droid's own verification, reproduced: check-fdroid-signature-copy.ps1 copies the signature onto
     the unsigned APK with apksigcopier 1.1.1, runs apksigner verify and requires byte equality.
  Prints the signed APK's SHA-256 for the release notes and SHA256SUMS.txt of the GitHub release.

.EXAMPLE
  gh run download <run-id> --repo anywecon/skepi -n <artifact> -D $env:TEMP\skepi\release
  ./scripts/release/sign-release-apk.ps1 -Tag v0.1.0-preview -Unsigned $env:TEMP\skepi\release\skepi-0.1.0-preview-arm64-unsigned.apk
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Unsigned,
  # The release tag (already pushed): the APK must be the CI artifact of the commit it names.
  [Parameter(Mandatory = $true)][ValidatePattern('^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$')][string]$Tag,
  [string]$Repo = 'anywecon/skepi',
  # The android-repro run the APK was downloaded from (default: the newest qualifying run).
  [string]$RunId = '',
  # Default: skepi-<version>-arm64.apk next to the unsigned APK (the GitHub release asset name).
  [string]$Out = '',
  [string]$GradleProperties = (Join-Path $env:USERPROFILE '.gradle\gradle.properties'),
  # Overrides for a dry run with a throwaway keystore; the defaults read ~/.gradle/gradle.properties.
  [string]$KeyStore = '',
  [string]$KeyAlias = '',
  [ValidatePattern('^[0-9a-f]{64}$')]
  [string]$ExpectedCertSha256 = '7d61c38241b178f84b12dd9a67af6b60b56159b1a0ff067fe672db45dd45447e',
  [string]$BuildTools = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$compare = Join-Path $root 'scripts\ci\apk-compare.py'
Import-Module (Join-Path $root 'tools\Signing.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'ReleaseProvenance.psm1') -Force

function Invoke-Checked([string]$What, [scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}

$Unsigned = (Resolve-Path $Unsigned).Path
if ([IO.Path]::GetFileName($Unsigned) -ne "skepi-$($Tag.Substring(1))-arm64-unsigned.apk") { throw "expected skepi-$($Tag.Substring(1))-arm64-unsigned.apk for $Tag, got $Unsigned" }
if (-not $Out) {
  $name = [IO.Path]::GetFileName($Unsigned) -replace '-unsigned\.apk$', '.apk'
  if ($name -eq [IO.Path]::GetFileName($Unsigned)) { throw "expected a file named *-unsigned.apk, got $Unsigned" }
  $Out = Join-Path (Split-Path -Parent $Unsigned) $name
}
if (Test-Path $Out) { throw "$Out exists; move it away first" }

if (-not $BuildTools) {
  $sdk = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT })
  if (-not $sdk) { throw 'ANDROID_HOME is not set' }
  $BuildTools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory |
    Sort-Object { [version]($_.Name -replace '-.*$', '') } | Select-Object -Last 1 -ExpandProperty FullName
}
$apksigner = Join-Path $BuildTools 'apksigner.bat'
$zipalign = Join-Path $BuildTools 'zipalign.exe'
foreach ($tool in @($apksigner, $zipalign)) { if (-not (Test-Path $tool)) { throw "missing $tool" } }

# 1. Checksum and no signature.
$sums = Join-Path (Split-Path -Parent $Unsigned) 'SHA256SUMS.txt'
if (-not (Test-Path $sums)) { throw "SHA256SUMS.txt from the CI artifact must sit next to $Unsigned" }
$fileName = [IO.Path]::GetFileName($Unsigned)
$expected = (Get-Content $sums | Where-Object { $_ -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape($fileName))$" } | ForEach-Object { $Matches[1] } | Select-Object -First 1)
if (-not $expected) { throw "$fileName is not listed in $sums" }
$actual = (Get-FileHash -Algorithm SHA256 $Unsigned).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA-256 mismatch: $actual, SHA256SUMS.txt says $expected" }
Write-Host "unsigned APK: $actual (matches SHA256SUMS.txt)"
Invoke-Checked 'unsigned check' { python $compare unsigned $Unsigned }

# 0. Provenance: the CI artifact of the tag's commit, not just a file with a matching checksum list.
Assert-ReleaseProvenance -Unsigned $Unsigned -Tag $Tag -Repo $Repo -RunId $RunId

# 2. Alignment (AGP writes the unsigned APK aligned; apksigner keeps it with --alignment-preserved).
Invoke-Checked 'zipalign check' { & $zipalign -c -P 16 4 $Unsigned }
Write-Host 'zip alignment: OK (4 bytes, 16 KB pages for native libraries)'

# 3. Sign.
if (-not $KeyStore -or -not $KeyAlias) {
  if (-not (Test-Path $GradleProperties)) { throw "missing $GradleProperties (docs/release-signing.md)" }
  $props = @{}
  foreach ($line in Get-Content $GradleProperties) {
    if ($line -match '^\s*(SKEPI_RELEASE_STORE_FILE|SKEPI_RELEASE_KEY_ALIAS)\s*=\s*(.+?)\s*$') { $props[$Matches[1]] = $Matches[2] }
  }
  if (-not $KeyStore) { $KeyStore = $props['SKEPI_RELEASE_STORE_FILE'] }
  if (-not $KeyAlias) { $KeyAlias = $props['SKEPI_RELEASE_KEY_ALIAS'] }
}
if (-not $KeyStore -or -not (Test-Path $KeyStore)) { throw "release keystore not found ($KeyStore)" }
if (-not $KeyAlias) { throw 'no key alias (SKEPI_RELEASE_KEY_ALIAS)' }
Write-Host "signing with alias '$KeyAlias' from $([IO.Path]::GetFileName($KeyStore))"
# PKCS12: store password == key password, so Enter at the second prompt reuses the first.
Use-SigningSecrets -Map ([ordered]@{
  SKEPI_RELEASE_STORE_PASSWORD = 'SKEPI keystore password'
  SKEPI_RELEASE_KEY_PASSWORD   = 'SKEPI key password (Enter = same as keystore)'
}) -ScriptBlock {
  Invoke-Checked 'apksigner sign' {
    & $apksigner sign --ks $KeyStore --ks-key-alias $KeyAlias `
      --ks-pass env:SKEPI_RELEASE_STORE_PASSWORD --key-pass env:SKEPI_RELEASE_KEY_PASSWORD `
      --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled false --v4-signing-enabled false `
      --alignment-preserved true --out $Out $Unsigned
  }
}

try {
  # 4. Certificate.
  $certs = & $apksigner verify --print-certs --verbose $Out
  if ($LASTEXITCODE -ne 0) { throw 'apksigner verify failed' }
  # "Signer #1 certificate SHA-256 digest" (v2) and "V3.0 Signer: certificate SHA-256 digest" (v3).
  $digests = @($certs | Select-String -Pattern 'certificate SHA-256 digest: ([0-9a-f]{64})' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object -Unique)
  if ($digests.Count -eq 0) { throw 'no signer certificate in the signed APK' }
  if ($digests.Count -ne 1 -or $digests[0] -ne $ExpectedCertSha256) { throw "signer certificate(s) $($digests -join ', ') are not the published SKEPI certificate $ExpectedCertSha256" }
  $digest = $digests[0]
  $certs | Select-String -Pattern 'Verified using v[0-9]' | ForEach-Object { Write-Host "  $($_.Line.Trim())" }
  Write-Host "certificate: $digest (published SKEPI fingerprint)"

  # 5. Contents equal the CI artifact.
  Invoke-Checked 'contents check' { python $compare contents $Out $Unsigned }

  # 6. Byte layout F-Droid can copy the signature from.
  Invoke-Checked 'apksigcopier layout check' { python $compare copyable $Out $Unsigned }

  # 7. F-Droid's verification: copy the signature onto the unsigned APK, verify, compare bytes.
  & (Join-Path $PSScriptRoot 'check-fdroid-signature-copy.ps1') -Signed $Out -Unsigned $Unsigned -BuildTools $BuildTools
} catch {
  Remove-Item -Force $Out -ErrorAction SilentlyContinue
  throw
}

$signedHash = (Get-FileHash -Algorithm SHA256 $Out).Hash.ToLowerInvariant()
Write-Host ''
Write-Host "signed APK: $Out"
Write-Host "$signedHash  $([IO.Path]::GetFileName($Out))"
