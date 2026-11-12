<#
  uninstall.ps1 - removes the companion app of "Akif's Special YouTube Addon" for the current user.

  * Stops host processes started from the installation (their Job Objects end any running download).
  * Removes the HKCU native messaging registrations for Chrome, Edge and Chromium that point to THIS
    installation's host manifest; a registration of another installation (e.g. a second test copy
    installed with -InstallDir) is kept.
  * Deletes ONLY the items the installer created (host\, bin\, logs\, state\, config.json, the host
    manifest, the uninstall scripts, the install marker) and then the folder itself if it is empty.
  Tools that were only reused from PATH (Python/pip yt-dlp, WinGet FFmpeg/Deno) are not touched.
  Downloaded videos are never touched.

  Safety: a folder is only treated as an installation when it contains the install marker
  (.akif-companion-install) or both config.json (hostName com.akif.youtube_addon) and the host
  manifest - and never when it contains install.ps1 (that is the add-on's source folder) or is a
  drive root or a well-known system/user folder.

  Options:
    -InstallDir <path>  the installation to remove (default %LOCALAPPDATA%\AkifYouTubeAddon)
    -Force              do not ask for confirmation

  This file must stay pure ASCII (PowerShell 5.1 reads BOM-less scripts in the ANSI code page).
#>
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# AppLocker / WDAC policies run scripts in Constrained Language Mode, where the .NET calls below fail
# with obscure errors: say so clearly instead.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Host "PowerShell runs in $($ExecutionContext.SessionState.LanguageMode) mode on this computer (set by an AppLocker or" -ForegroundColor Red
  Write-Host 'Windows Defender Application Control policy of your organization). The uninstaller needs the full' -ForegroundColor Red
  Write-Host 'language mode, so it cannot run here. Ask your IT department to remove the companion app.' -ForegroundColor Red
  exit 1
}

$HostName = 'com.akif.youtube_addon'
$Marker = '.akif-companion-install'
$RegBases = @(
  @{ Name = 'Chrome'; Key = 'Software\Google\Chrome\NativeMessagingHosts' },
  @{ Name = 'Edge'; Key = 'Software\Microsoft\Edge\NativeMessagingHosts' },
  @{ Name = 'Chromium'; Key = 'Software\Chromium\NativeMessagingHosts' }
)
# Everything the installer creates inside the install folder - nothing else is ever deleted.
$OwnedItems = @('host', 'bin', 'logs', 'state', 'config.json', "$HostName.json", 'uninstall.ps1', 'uninstall.bat', $Marker)

function Test-IsInstallation([string]$Dir) {
  if (Test-Path -LiteralPath (Join-Path $Dir 'install.ps1')) { return $false } # the add-on's source folder
  if (Test-Path -LiteralPath (Join-Path $Dir $Marker) -PathType Leaf) { return $true }
  $cfg = Join-Path $Dir 'config.json'
  if (-not (Test-Path -LiteralPath $cfg -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $Dir "$HostName.json") -PathType Leaf)) { return $false }
  try {
    $j = [IO.File]::ReadAllText($cfg, [Text.Encoding]::UTF8) | ConvertFrom-Json
    return ($j.PSObject.Properties['hostName'] -and $j.hostName -eq $HostName)
  } catch { return $false }
}

function Test-ProtectedFolder([string]$Dir) {
  $d = $Dir.TrimEnd('\')
  if ($d -match '^[A-Za-z]:$' -or $d -match '^\\\\[^\\]+\\[^\\]+$') { return $true } # drive or share root
  $known = @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:TEMP, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:SystemRoot, $env:PUBLIC,
    [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('MyDocuments'), [Environment]::GetFolderPath('MyVideos'), [Environment]::GetFolderPath('MyMusic'))
  foreach ($k in $known) {
    if (-not $k) { continue }
    $kk = $k.TrimEnd('\')
    # the folder IS a well-known folder, or CONTAINS one (e.g. C:\Users)
    if ($d -ieq $kk -or $kk.StartsWith($d + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

# Delete the registrations whose default value is $Manifest (this installation's host manifest). The
# host name is the same for every installation, so a registration that points to another one belongs
# to it and is left alone. $Hive: [Microsoft.Win32.Registry]::CurrentUser (or a stand-in in tests).
function Remove-OwnRegistrations($Hive, [object[]]$Bases, [string]$Manifest) {
  foreach ($b in $Bases) {
    $sub = "$($b.Key)\$HostName"
    $k = $Hive.OpenSubKey($sub)
    if (-not $k) { continue }
    try { $val = [string]$k.GetValue('') } finally { $k.Close() }
    $mine = $false
    if ($val) { try { $mine = ([IO.Path]::GetFullPath($val) -ieq $Manifest) } catch { } }
    if ($mine) {
      $Hive.DeleteSubKeyTree($sub, $false)
      Write-Host "  removed HKCU\$sub" -ForegroundColor Green
    } else {
      Write-Host "  kept HKCU\$sub - it belongs to another installation ($val)" -ForegroundColor Yellow
    }
  }
}

try {
  Write-Host "Akif's Special YouTube Addon - companion app uninstaller" -ForegroundColor White
  if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'AkifYouTubeAddon' }
  $InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  # Never hold the folder open (cwd), or it could not be deleted.
  Set-Location -LiteralPath $env:TEMP

  $exists = Test-Path -LiteralPath $InstallDir -PathType Container
  if ($exists) {
    if (Test-ProtectedFolder $InstallDir) { throw "$InstallDir is a system or user folder; refusing to touch it." }
    if (-not (Test-IsInstallation $InstallDir)) { throw "$InstallDir does not look like an installation of this companion app; nothing was removed." }
  }

  if (-not $Force) {
    Write-Host ''
    Write-Host 'This removes the companion app (video/audio downloads in the browser stop working):'
    Write-Host "  folder   : $InstallDir"
    Write-Host '  registry : HKCU native messaging entries for Chrome, Edge and Chromium that point to this folder'
    $answer = Read-Host 'Continue? [y/N]'
    if ($answer -notmatch '^(y|yes)$') { Write-Host 'Nothing was changed.'; exit 2 }
  }

  # 1) running hosts / tools of this installation
  if ($exists) {
    $prefix = $InstallDir + '\'
    $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $path = $null
        try { $path = $_.Path } catch { }
        $path -and $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
      })
    foreach ($p in $procs) {
      try {
        Stop-Process -Id $p.Id -Force -ErrorAction Stop
        Write-Host "  stopped $($p.ProcessName) ($($p.Id))"
      } catch { Write-Host "  could not stop $($p.ProcessName) ($($p.Id)): $($_.Exception.Message)" -ForegroundColor Yellow }
    }
    if ($procs.Count) { Start-Sleep -Milliseconds 800 }
  }

  # 2) registry (only our own host name, and only when it points to this installation)
  Remove-OwnRegistrations ([Microsoft.Win32.Registry]::CurrentUser) $RegBases (Join-Path $InstallDir "$HostName.json")

  # 3) the installed items, then the folder if nothing else is in it
  if ($exists) {
    foreach ($item in $OwnedItems) {
      $p = Join-Path $InstallDir $item
      if (-not (Test-Path -LiteralPath $p)) { continue }
      $removed = $false
      for ($i = 0; $i -lt 20 -and -not $removed; $i++) {
        try {
          Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop
          $removed = $true
        } catch { Start-Sleep -Milliseconds 500 }
      }
      if (-not $removed) { throw "could not delete $p (a file is still in use). Close the browser and run the uninstaller again." }
    }
    $left = @(Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) {
      Remove-Item -LiteralPath $InstallDir -Force
      Write-Host "  removed $InstallDir" -ForegroundColor Green
    } else {
      Write-Host "  removed the companion files; $InstallDir still contains other files and was kept" -ForegroundColor Yellow
    }
  } else {
    Write-Host "  $InstallDir does not exist"
  }
  Write-Host ''
  Write-Host 'Companion app removed.' -ForegroundColor Green
  exit 0
} catch {
  Write-Host ''
  Write-Host "Uninstall failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
