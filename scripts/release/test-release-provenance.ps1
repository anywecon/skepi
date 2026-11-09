<#
.SYNOPSIS
  Unit test of Test-ReleaseProvenance (ReleaseProvenance.psm1): the decision that lets
  sign-release-apk.ps1 sign an APK. No network, no keys, no signing.

    powershell -NoProfile -File scripts/release/test-release-provenance.ps1
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'ReleaseProvenance.psm1') -Force

$repo = 'anywecon/skepi'
$tag = 'v0.2.1-preview'
$commit = 'ebd321e03bdb65ee118e4ba592218e90e50514b2'
$apk = 'a99ed9da81c1440fa9962acb06a8a973e5d88ce580a0259c9345444b4f36e74a'
$name = 'skepi-0.2.1-preview-vc6-ebd321e03bdb-unsigned'

function New-Run([hashtable]$Over = @{}) {
  $r = [ordered]@{
    id = 41948574811
    path = '.github/workflows/android-repro.yml'
    event = 'workflow_dispatch'
    conclusion = 'success'
    head_branch = 'main'
    repository = [pscustomobject]@{ full_name = $repo }
    head_repository = [pscustomobject]@{ full_name = $repo }
  }
  foreach ($k in $Over.Keys) { $r[$k] = $Over[$k] }
  [pscustomobject]$r
}

$failures = 0
function Check([string]$What, [string[]]$Problems, [bool]$ShouldPass, [string]$Expect = '') {
  $ok = if ($ShouldPass) { $Problems.Count -eq 0 } else { $Problems.Count -gt 0 -and (-not $Expect -or ($Problems -join ' ') -like "*$Expect*") }
  if ($ok) { Write-Host "PASS $What" } else { Write-Host "FAIL $What :: $($Problems -join '; ')"; $script:failures++ }
}

$p = @{ Repo = $repo; Tag = $tag; TagCommit = $commit; ArtifactName = $name; ArtifactApkSha256 = $apk; ApkSha256 = $apk }

Check 'the artifact of a dispatched run for the tag commit can be signed' (Test-ReleaseProvenance @p -Run (New-Run)) $true
Check 'a push run on main can be signed' (Test-ReleaseProvenance @p -Run (New-Run @{ event = 'push' })) $true
# The pre-fix script accepted any file whose SHA256SUMS.txt next to it agreed: the cases below were all signed.
$q = $p.Clone(); $q.ApkSha256 = 'b' * 64
Check 'a different local APK is refused' (Test-ReleaseProvenance @q -Run (New-Run)) $false 'is not the run artifact'
$q = $p.Clone(); $q.ArtifactName = 'skepi-0.2.1-preview-vc6-0123456789ab-unsigned'
Check 'an artifact built from another commit is refused' (Test-ReleaseProvenance @q -Run (New-Run)) $false 'is not the unsigned APK'
$q = $p.Clone(); $q.ArtifactName = 'skepi-0.2.0-preview-vc5-ebd321e03bdb-unsigned'
Check 'an artifact of another version is refused' (Test-ReleaseProvenance @q -Run (New-Run)) $false 'is not the unsigned APK'
Check 'a pull-request run is refused' (Test-ReleaseProvenance @p -Run (New-Run @{ event = 'pull_request' })) $false 'triggered by'
Check 'a run on a fork''s code is refused' (Test-ReleaseProvenance @p -Run (New-Run @{ head_repository = [pscustomobject]@{ full_name = 'someone/skepi' } })) $false 'head repository'
Check 'a run of another repository is refused' (Test-ReleaseProvenance @p -Run (New-Run @{ repository = [pscustomobject]@{ full_name = 'someone/skepi' }; head_repository = [pscustomobject]@{ full_name = 'someone/skepi' } })) $false 'not anywecon/skepi'
Check 'a failed run is refused' (Test-ReleaseProvenance @p -Run (New-Run @{ conclusion = 'failure' })) $false 'did not succeed'
Check 'another workflow is refused' (Test-ReleaseProvenance @p -Run (New-Run @{ path = '.github/workflows/ci.yml' })) $false 'is not .github/workflows/android-repro.yml'
Check 'a run on another branch is refused' (Test-ReleaseProvenance @p -Run (New-Run @{ head_branch = 'feature' })) $false 'not main'
$q = $p.Clone(); $q.ArtifactApkSha256 = ''
Check 'an artifact without an APK is refused' (Test-ReleaseProvenance @q -Run (New-Run)) $false 'no APK'
$q = $p.Clone(); $q.Tag = 'latest'
Check 'a non-release tag is refused' (Test-ReleaseProvenance @q -Run (New-Run)) $false 'not a release tag'

if ($failures -gt 0) { Write-Host "release provenance: $failures failed"; exit 1 }
Write-Host 'release provenance: all checks passed'
