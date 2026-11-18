# Import fixture for the document-picker step (dot-source it; used by run-download-e2e.ps1 and
# run-import-e2e.ps1). DocumentsUI lists Downloads newest first, and adb push keeps the host file's mtime,
# so on a device with newer downloads the fixture would sit below the fold, where Maestro's wait for it
# does not scroll. The fixture is touched after the push, and the run stops unless its mtime is current.
$script:DownloadFixtureSource = Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\rag-eval\fixtures\eval-heldout.zim'
$script:DownloadFixturePath = '/sdcard/Download/eval-heldout.zim'
$script:DownloadFixtureMaxAgeSeconds = 60

function Push-DownloadFixture([string[]]$AdbArgs) {
  & adb.exe @AdbArgs push $script:DownloadFixtureSource $script:DownloadFixturePath | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "adb push of $($script:DownloadFixtureSource) failed" }
  & adb.exe @AdbArgs shell touch $script:DownloadFixturePath
  if ($LASTEXITCODE -ne 0) { throw "touch $($script:DownloadFixturePath) on the device failed" }
  Assert-DownloadFixtureFresh $AdbArgs
}

# Throws unless the fixture's mtime is within a minute of the device clock (DocumentsUI orders by the
# device's own timestamps).
function Assert-DownloadFixtureFresh([string[]]$AdbArgs) {
  $stamps = @(& adb.exe @AdbArgs shell "stat -c %Y $($script:DownloadFixturePath) && date +%s" | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
  if ($LASTEXITCODE -ne 0 -or $stamps.Count -ne 2 -or $stamps[0] -notmatch '^\d+$' -or $stamps[1] -notmatch '^\d+$') {
    throw "could not read the mtime of $($script:DownloadFixturePath) on the device (got: $($stamps -join ' | '))"
  }
  $age = [int64]$stamps[1] - [int64]$stamps[0]
  if ([math]::Abs($age) -gt $script:DownloadFixtureMaxAgeSeconds) {
    throw "$($script:DownloadFixturePath) has mtime $($stamps[0]), $age s away from the device clock ($($stamps[1])): the picker would list it below newer downloads"
  }
  Write-Host "import fixture: $($script:DownloadFixturePath) pushed, mtime current (age $age s)"
}

function Remove-DownloadFixture([string[]]$AdbArgs) {
  & adb.exe @AdbArgs shell rm -f $script:DownloadFixturePath | Out-Null
}
