<#
.SYNOPSIS
  Provenance of the unsigned APK before it is signed (sign-release-apk.ps1, docs/release-process.md):
  the bytes must be the artifact of a successful android-repro run of this repository, built from the
  commit the release tag names. A SHA256SUMS.txt next to the file proves nothing about where it came
  from; the artifact downloaded again from the run does.

  Test-ReleaseProvenance decides from plain objects (unit-tested by test-release-provenance.ps1);
  Assert-ReleaseProvenance gathers them with `gh` and downloads the run's artifact to compare bytes.
#>
Set-StrictMode -Version Latest

$script:Workflow = '.github/workflows/android-repro.yml'

<#
  Returns the reasons the run and artifact cannot vouch for the APK (empty: it can).
  $Run: GitHub's run object (path, event, conclusion, head_branch, head_repository.full_name, id).
  $ArtifactName: the run's artifact the APK came from. $ArtifactApkSha256: SHA-256 of the APK inside it,
  downloaded from the run. $ApkSha256: the file about to be signed.
#>
function Test-ReleaseProvenance {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$TagCommit,
    [Parameter(Mandatory = $true)]$Run,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ArtifactName,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ArtifactApkSha256,
    [Parameter(Mandatory = $true)][string]$ApkSha256
  )
  $problems = New-Object System.Collections.Generic.List[string]
  if ($Tag -notmatch '^v(\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?)$') {
    $problems.Add("tag $Tag is not a release tag (v<major>.<minor>.<patch>[-label])")
    return , $problems.ToArray()
  }
  $version = $Matches[1]
  if ($TagCommit -notmatch '^[0-9a-f]{40}$') { $problems.Add("tag commit '$TagCommit' is not a full commit hash") }
  if ([string]$Run.path -notlike "$script:Workflow*") { $problems.Add("run $($Run.id) is not $script:Workflow (path '$($Run.path)')") }
  if ($Run.event -notin @('push', 'workflow_dispatch')) { $problems.Add("run $($Run.id) was triggered by '$($Run.event)', not push or workflow_dispatch") }
  if ($Run.conclusion -ne 'success') { $problems.Add("run $($Run.id) did not succeed ('$($Run.conclusion)')") }
  if ($Run.head_branch -ne 'main') { $problems.Add("run $($Run.id) ran on '$($Run.head_branch)', not main") }
  # Both the repository the run belongs to and the one its code came from (not a fork).
  foreach ($field in @('repository', 'head_repository')) {
    $name = $null
    if ($Run.PSObject.Properties.Name -contains $field -and $Run.$field) { $name = $Run.$field.full_name }
    if ($name -ne $Repo) { $problems.Add("run $($Run.id) $($field -replace '_', ' ') is '$name', not $Repo") }
  }
  $short = if ($TagCommit.Length -ge 12) { $TagCommit.Substring(0, 12) } else { $TagCommit }
  $pattern = "^skepi-$([regex]::Escape($version))-vc\d+-$([regex]::Escape($short))-unsigned$"
  if ($ArtifactName -notmatch $pattern) { $problems.Add("artifact '$ArtifactName' is not the unsigned APK of $version at $short") }
  if ($ArtifactApkSha256 -notmatch '^[0-9a-f]{64}$') { $problems.Add('no APK in the run artifact') }
  elseif ($ArtifactApkSha256 -ne $ApkSha256) { $problems.Add("the APK ($ApkSha256) is not the run artifact's APK ($ArtifactApkSha256)") }
  return , $problems.ToArray()
}

function Invoke-Gh([string[]]$GhArgs) {
  $out = & gh @GhArgs
  if ($LASTEXITCODE -ne 0) { throw "gh $($GhArgs -join ' ') failed (exit $LASTEXITCODE)" }
  return ($out -join "`n")
}

<#
  Throws unless the APK at $Unsigned is the artifact of a successful android-repro run of $Repo for the
  commit $Tag names on GitHub. With -RunId that run is checked; otherwise the newest qualifying one.
#>
function Assert-ReleaseProvenance {
  param(
    [Parameter(Mandatory = $true)][string]$Unsigned,
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$Repo = 'anywecon/skepi',
    [string]$RunId = ''
  )
  $apkSha = (Get-FileHash -Algorithm SHA256 $Unsigned).Hash.ToLowerInvariant()
  # GitHub redirects a renamed or transferred repository: compare runs with its current name.
  $Repo = (Invoke-Gh @('api', "repos/$Repo") | ConvertFrom-Json).full_name
  $ref = Invoke-Gh @('api', "repos/$Repo/git/ref/tags/$Tag") | ConvertFrom-Json
  $commit = $ref.object.sha
  if ($ref.object.type -eq 'tag') { $commit = (Invoke-Gh @('api', "repos/$Repo/git/tags/$commit") | ConvertFrom-Json).object.sha }
  $short = $commit.Substring(0, 12)
  $runIds = if ($RunId) { @($RunId) } else {
    @((Invoke-Gh @('run', 'list', '--repo', $Repo, '--workflow', 'android-repro.yml', '--status', 'success', '--limit', '100', '--json', 'databaseId') | ConvertFrom-Json) | ForEach-Object { [string]$_.databaseId })
  }
  $tried = New-Object System.Collections.Generic.List[string]
  foreach ($id in $runIds) {
    $run = Invoke-Gh @('api', "repos/$Repo/actions/runs/$id") | ConvertFrom-Json
    $artifacts = @((Invoke-Gh @('api', "repos/$Repo/actions/runs/$id/artifacts") | ConvertFrom-Json).artifacts |
        Where-Object { -not $_.expired -and $_.name -like "*-$short-unsigned" })
    if ($artifacts.Count -eq 0) {
      if ($RunId) { $tried.Add("run ${id}: no unexpired artifact for $short") }
      continue
    }
    $name = $artifacts[0].name
    $dir = Join-Path ([IO.Path]::GetTempPath()) "skepi-provenance-$id-$([guid]::NewGuid().ToString('N'))"
    try {
      Invoke-Gh @('run', 'download', $id, '--repo', $Repo, '-n', $name, '-D', $dir) | Out-Null
      $apks = @(Get-ChildItem -Path $dir -Filter '*.apk' -File)
      $artifactSha = if ($apks.Count -eq 1) { (Get-FileHash -Algorithm SHA256 $apks[0].FullName).Hash.ToLowerInvariant() } else { '' }
    } finally {
      Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
    }
    $problems = Test-ReleaseProvenance -Repo $Repo -Tag $Tag -TagCommit $commit -Run $run -ArtifactName $name -ArtifactApkSha256 $artifactSha -ApkSha256 $apkSha
    if ($problems.Count -eq 0) {
      Write-Host "provenance: $Tag = $commit, run $id ($($run.event)), artifact $name, APK $apkSha"
      return
    }
    $tried.Add("run ${id}: $($problems -join '; ')")
  }
  if ($tried.Count -eq 0) { $tried.Add("no successful android-repro run of $Repo has an unexpired artifact for $short") }
  throw "the APK is not a CI artifact of $Tag ($commit): $($tried -join ' | ')"
}

Export-ModuleMember -Function Test-ReleaseProvenance, Assert-ReleaseProvenance
