<#
  install.ps1 - installs the companion app of "Akif's Special YouTube Addon" for the current user.

  * Windows PowerShell 5.1, no administrator rights. Re-running it updates the installation in place.
  * Installs to %LOCALAPPDATA%\AkifYouTubeAddon:
        host\host.ts, host\host.bat, host\lib\...   the native messaging host (run by Deno)
        bin\deno.exe                                 a copy of Deno (the .bat must use relative paths)
        bin\...                                      yt-dlp / FFmpeg only when they had to be downloaded
        config.json                                  absolute tool paths + versions (UTF-8, no BOM)
        com.akif.youtube_addon.json                  native messaging host manifest (UTF-8, no BOM)
        logs\host.log                                host log (rotated)
        .akif-companion-install                      marker: only folders with it are ever uninstalled
    The host runs with the user's full rights, so the folder must be inside the user's profile and no
    other account may be able to change it: write access of other accounts is removed from a new
    folder, and a folder (or parent folder) that other accounts can change or replace is refused.
  * Registers the host for Chrome, Edge and Chromium under HKCU\Software\...\NativeMessagingHosts and
    warns when a browser policy (NativeMessagingUserLevelHosts, NativeMessagingBlocklist) blocks it.
  * Tool policy: reuse a working yt-dlp (>= 2025.11; a pip install only when it has yt-dlp-ejs) and
    FFmpeg (with -stats_period and the http option request_size) from PATH, and copy Deno (>= 2.0)
    from PATH (package-manager shims are resolved to the real deno.exe). Everything else lives in
    bin\, and a working copy there is kept: yt-dlp and Deno are replaced only by a newer release,
    FFmpeg (a rolling daily build) only with -Redownload. So a re-run downloads nothing it already
    has, and works offline. Downloads come from the official GitHub releases, all files of one tool
    from the same release tag, and must match the SHA-256 published with that release (this proves
    the file is complete, not who built it); a downloaded deno.exe must also carry a valid
    Authenticode signature of Deno Land Inc.
  * Finishes with a self-test: the host is started exactly like the browser starts it
    (cmd.exe /d /s /c ""...\host.bat" chrome-extension://<id>/ --parent-window=0" with named pipes)
    and must answer hello.

  Options:
    -InstallDir <path>  install somewhere else inside your user profile
                        (default %LOCALAPPDATA%\AkifYouTubeAddon)
    -OwnYtDlp           use the official yt-dlp build in bin\ even if one is on PATH
    -OwnFfmpeg          use the FFmpeg build in bin\ even if one is on PATH
    -OwnDeno            use the official Deno build in bin\ even if one is on PATH
    -Redownload         download the tools kept in bin\ again even when they work and are current
    -NoRegister         do not write registry keys (testing)
    -SkipSelfTest       do not start the host at the end
    -Force              stop running host processes of this installation when files are in use, and
                        install even when started as another account than the desktop's user

  This file must stay pure ASCII (PowerShell 5.1 reads BOM-less scripts in the ANSI code page).
#>
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [switch]$OwnYtDlp,
  [switch]$OwnFfmpeg,
  [switch]$OwnDeno,
  [switch]$Redownload,
  [switch]$NoRegister,
  [switch]$SkipSelfTest,
  [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# AppLocker / WDAC policies run scripts in Constrained Language Mode, where the .NET calls below fail
# with obscure errors: say so clearly instead.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Host "PowerShell runs in $($ExecutionContext.SessionState.LanguageMode) mode on this computer (set by an AppLocker or" -ForegroundColor Red
  Write-Host 'Windows Defender Application Control policy of your organization). The installer needs the full' -ForegroundColor Red
  Write-Host 'language mode, so it cannot run here. Ask your IT department to install the companion app.' -ForegroundColor Red
  exit 1
}

$HostName = 'com.akif.youtube_addon'
$ExpectedExtensionId = 'oicpmbpfimnoolnhfgdocfjelknjlcif'
$HostVersion = '1.0.0'
$Marker = '.akif-companion-install'
$MinYtDlp = [version]'2025.11.0'
$RegBases = @(
  @{ Name = 'Chrome'; Key = 'Software\Google\Chrome\NativeMessagingHosts' },
  @{ Name = 'Edge'; Key = 'Software\Microsoft\Edge\NativeMessagingHosts' },
  @{ Name = 'Chromium'; Key = 'Software\Chromium\NativeMessagingHosts' }
)
$PyEnv = @{ PYTHONIOENCODING = 'utf-8'; PYTHONUTF8 = '1' }
# Browser policy keys below HKLM / HKCU \SOFTWARE\Policies.
$PolicyBrowsers = @(
  @{ Name = 'Chrome'; Key = 'Google\Chrome' },
  @{ Name = 'Edge'; Key = 'Microsoft\Edge' },
  @{ Name = 'Chromium'; Key = 'Chromium' }
)
$UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
# File system rights that let a principal change a folder's content or permissions: write/append data,
# write extended attributes/attributes, delete child, DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_ALL/WRITE.
$AnyWrite = 0x500D0156
# ... or rename/replace the folder itself: delete child, DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_ALL.
$CanRename = 0x100D0040

# ---------------------------------------------------------------------------- output helpers
function Write-Step([string]$m) { Write-Host ''; Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Info([string]$m) { Write-Host "    $m" }
function Write-Ok([string]$m) { Write-Host "    OK  $m" -ForegroundColor Green }
function Write-Warn2([string]$m) { Write-Host "    !   $m" -ForegroundColor Yellow }

# The message of an error, without the 'Exception calling "X" with "n" argument(s)' wrapper of .NET calls.
function Get-ErrorText($ErrorRecord) {
  $e = $ErrorRecord.Exception
  while ($e -is [System.Management.Automation.MethodInvocationException] -and $e.InnerException) { $e = $e.InnerException }
  return $e.Message
}

# ---------------------------------------------------------------------------- file helpers
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

function New-Dir([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { [void](New-Item -ItemType Directory -Path $Path -Force) }
}

function Resolve-RealPath([string]$Path) {
  try {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.LinkType -and $item.Target) {
      $t = @($item.Target)[0]
      if (-not [IO.Path]::IsPathRooted($t)) { $t = Join-Path (Split-Path -Parent $Path) $t }
      return [IO.Path]::GetFullPath($t)
    }
  } catch { }
  return $Path
}

function Find-OnPath([string]$Name) {
  $c = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -like '*.exe' } | Select-Object -First 1
  if ($c) { return $c.Source }
  return $null
}

# A drive/share root, a well-known system or user folder, or a folder that contains one of them.
function Test-ProtectedFolder([string]$Dir) {
  $d = $Dir.TrimEnd('\')
  if ($d -match '^[A-Za-z]:$' -or $d -match '^\\\\[^\\]+\\[^\\]+$') { return $true }
  $known = @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:TEMP, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:SystemRoot, $env:PUBLIC,
    [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('MyDocuments'), [Environment]::GetFolderPath('MyVideos'), [Environment]::GetFolderPath('MyMusic'))
  foreach ($k in $known) {
    if (-not $k) { continue }
    $kk = $k.TrimEnd('\')
    if ($d -ieq $kk -or $kk.StartsWith($d + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

# ---------------------------------------------------------------------------- folder security
# The profile folder (%LOCALAPPDATA%, else %USERPROFILE%) that contains $Dir, or $null.
function Get-ProfileRoot([string]$Dir) {
  foreach ($r in @($env:LOCALAPPDATA, $env:USERPROFILE)) {
    if (-not $r) { continue }
    $rr = [IO.Path]::GetFullPath($r).TrimEnd('\')
    if ($Dir.StartsWith($rr + '\', [StringComparison]::OrdinalIgnoreCase)) { return $rr }
  }
  return $null
}

# $Dir and its parent folders below $Root, deepest first.
function Get-PathChain([string]$Dir, [string]$Root) {
  $out = @()
  $p = $Dir.TrimEnd('\')
  while ($p -and $p.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) {
    $out += $p
    $p = Split-Path -Parent $p
  }
  return $out
}

# The user, SYSTEM, Administrators, TrustedInstaller, CREATOR OWNER (= whoever creates an item, here the
# user), OWNER RIGHTS, the built-in Administrator account, Domain Admins and Enterprise Admins.
function Test-TrustedSid([string]$Sid) {
  if ($Sid -eq $UserSid) { return $true }
  if (@('S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-3-4', 'S-1-5-80-956008885-3425870976-2464373232-1405862955-1316416154') -contains $Sid) { return $true }
  return $Sid -match '^S-1-5-21-\d+-\d+-\d+-(500|512|519)$'
}

# Groups that contain every (or every interactive / every domain) user: Everyone, Authenticated Users,
# Users, Interactive, Guests, Anonymous, Network, Local, Console Logon, Terminal Server User,
# Remote Interactive Logon, Domain Users, Domain Guests.
function Test-BroadSid([string]$Sid) {
  if (@('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-4', 'S-1-5-32-546', 'S-1-5-7', 'S-1-5-2', 'S-1-2-0', 'S-1-2-1', 'S-1-5-13', 'S-1-5-14') -contains $Sid) { return $true }
  return $Sid -match '^S-1-5-21-\d+-\d+-\d+-51[34]$'
}

function Get-SidNames([string[]]$Sids) {
  return (@($Sids | Select-Object -Unique | ForEach-Object {
        $sid = $_
        try { (New-Object Security.Principal.SecurityIdentifier $sid).Translate([Security.Principal.NTAccount]).Value } catch { $sid }
      }) -join ', ')
}

# SIDs other than the trusted ones that an Allow entry of the folder's DACL gives one of the rights in
# $Mask. -FolderOnly skips inherit-only entries (they apply to the children, not to the folder) and adds
# an untrusted owner (an owner can always give itself any right). AppContainer SIDs (S-1-15-...) are
# skipped: they never grant access on their own, the user's own rights are checked as well.
function Get-ForeignAccess([string]$Dir, [int]$Mask, [switch]$FolderOnly) {
  $acl = Get-Acl -LiteralPath $Dir
  $sids = @()
  if ($FolderOnly) {
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
    if ($owner -and -not (Test-TrustedSid $owner.Value)) { $sids += $owner.Value }
  }
  foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    if ($FolderOnly -and ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    $sid = $r.IdentityReference.Value
    if ($sid -like 'S-1-15-*' -or (Test-TrustedSid $sid)) { continue }
    if (([int]$r.FileSystemRights -band $Mask) -ne 0) { $sids += $sid }
  }
  return @($sids | Select-Object -Unique)
}

# Full control for the user, SYSTEM and Administrators only (inherited by everything inside); nothing
# is inherited from the parent folder any more.
function Set-PrivateAcl([string]$Dir) {
  $sec = New-Object Security.AccessControl.DirectorySecurity
  $sec.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  foreach ($sid in @($UserSid, 'S-1-5-18', 'S-1-5-32-544')) {
    $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid),
          [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)))
  }
  (Get-Item -LiteralPath $Dir -Force).SetAccessControl($sec)
}

# The host runs with the user's full rights, so no other account may change the install folder (host
# code, config.json with the tool paths that are executed, bin\) or rename one of its parent folders to
# put another folder in its place. $Created: folders this run created (deepest first), removed again
# when the location is refused.
function Protect-InstallDir([string]$Dir, [string]$Root, [bool]$WasInstalled, [string[]]$Created) {
  $default = Join-Path $env:LOCALAPPDATA 'AkifYouTubeAddon'
  $broad = @()
  $other = @()
  $broadAt = $null
  $otherAt = $null
  foreach ($p in @(Get-PathChain (Split-Path -Parent $Dir) $Root)) { # deepest first: the last hit is the highest folder
    $sids = @()
    try { $sids = @(Get-ForeignAccess $p $CanRename -FolderOnly) } catch { continue }
    $b = @($sids | Where-Object { Test-BroadSid $_ })
    $o = @($sids | Where-Object { -not (Test-BroadSid $_) })
    if ($b.Count) { $broad += $b; $broadAt = $p }
    if ($o.Count) { $other += $o; $otherAt = $p }
  }
  if ($broad.Count) {
    foreach ($c in $Created) { try { [IO.Directory]::Delete($c, $false) } catch { } }
    throw "Other accounts ($(Get-SidNames $broad)) can rename or replace $broadAt, a parent of the install folder. Choose a folder that only you can change, for example the default $default."
  }
  if ($other.Count) { Write-Warn2 "other accounts ($(Get-SidNames $other)) can rename $otherAt, a parent of the install folder (the default $default is private)" }
  $owner = (Get-Acl -LiteralPath $Dir).GetOwner([Security.Principal.SecurityIdentifier]).Value
  if (-not (Test-TrustedSid $owner)) { throw "$Dir belongs to another account ($(Get-SidNames @($owner))). Choose a folder you created yourself." }
  $writers = @(Get-ForeignAccess $Dir $AnyWrite)
  if (-not $writers.Count) { Write-Ok 'only you, SYSTEM and Administrators can change it'; return }
  if ($WasInstalled) {
    throw "Other accounts ($(Get-SidNames $writers)) can change the installation in $Dir, so its files cannot be trusted any more. Remove it (uninstall.ps1 -InstallDir `"$Dir`") and install again (the default $default is private)."
  }
  Set-PrivateAcl $Dir
  $left = @(Get-ForeignAccess $Dir $AnyWrite)
  if ($left.Count) { throw "could not take the write access of $(Get-SidNames $left) away from $Dir" }
  Write-Ok "removed the write access of other accounts ($(Get-SidNames $writers)); only you, SYSTEM and Administrators can change it"
}

# When the installer runs elevated as another account than the one that owns this desktop (explorer.exe
# of this session) - "Run as administrator" with another administrator's password - it would install
# into THAT account's profile and registry, where the user's browser never looks. Returns that desktop
# user, or $null.
function Get-OtherDesktopUser {
  try {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not (New-Object Security.Principal.WindowsPrincipal $me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { return $null }
    $session = (Get-Process -Id $PID).SessionId
    $users = @(Get-Process -Name explorer -IncludeUserName -ErrorAction Stop |
        Where-Object { $_.SessionId -eq $session -and $_.UserName } | ForEach-Object { $_.UserName } | Select-Object -Unique)
    if ($users.Count -eq 0 -or $users -contains $me.Name) { return $null }
    return ($users -join ', ')
  } catch { return $null }
}

# ---------------------------------------------------------------------------- browser policies
function Get-PolicyRoots {
  $roots = @()
  try { $roots += @{ Hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64); Prefix = 'SOFTWARE\Policies' } } catch { }
  $roots += @{ Hive = [Microsoft.Win32.Registry]::CurrentUser; Prefix = 'SOFTWARE\Policies' }
  return $roots
}

# A policy value; machine policy (the first root) wins over user policy.
function Get-PolicyValue([object[]]$Roots, [string]$Key, [string]$Name) {
  foreach ($r in $Roots) {
    $k = $null
    try {
      $k = $r.Hive.OpenSubKey("$($r.Prefix)\$Key")
      if ($k) {
        $v = $k.GetValue($Name)
        if ($null -ne $v) { return $v }
      }
    } catch { } finally { if ($k) { $k.Close() } }
  }
  return $null
}

# A list policy: a subkey whose values ("1", "2", ...) are the entries. $Names: current name, legacy name.
function Get-PolicyList([object[]]$Roots, [string]$Key, [string[]]$Names) {
  foreach ($r in $Roots) {
    foreach ($n in $Names) {
      $k = $null
      try {
        $k = $r.Hive.OpenSubKey("$($r.Prefix)\$Key\$n")
        if ($k) { return @($k.GetValueNames() | ForEach-Object { [string]$k.GetValue($_) }) }
      } catch { } finally { if ($k) { $k.Close() } }
    }
  }
  return @()
}

# Chrome/Edge ignore HKCU registrations when NativeMessagingUserLevelHosts is 0, and refuse hosts on the
# NativeMessagingBlocklist ('*' = all) unless the NativeMessagingAllowlist names them.
function Get-NativeMessagingPolicyIssues([object[]]$Roots) {
  $issues = @()
  foreach ($b in $PolicyBrowsers) {
    $userLevel = Get-PolicyValue $Roots $b.Key 'NativeMessagingUserLevelHosts'
    if ($null -ne $userLevel -and "$userLevel" -eq '0') {
      $issues += "$($b.Name): the policy NativeMessagingUserLevelHosts of your organization turns off companion apps installed per user, so $($b.Name) cannot start this one"
      continue
    }
    $block = @(Get-PolicyList $Roots $b.Key @('NativeMessagingBlocklist', 'NativeMessagingBlacklist'))
    $allow = @(Get-PolicyList $Roots $b.Key @('NativeMessagingAllowlist', 'NativeMessagingWhitelist'))
    if (($block -contains '*' -or $block -contains $HostName) -and -not ($allow -contains $HostName)) {
      $issues += "$($b.Name): the policy NativeMessagingBlocklist of your organization blocks this companion app"
    }
  }
  return $issues
}

# Quote one argument the way CommandLineToArgvW / the MSVC runtime parse it.
function ConvertTo-CmdArg([string]$a) {
  if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { return $a }
  $sb = New-Object Text.StringBuilder
  [void]$sb.Append('"')
  $bs = 0
  foreach ($ch in $a.ToCharArray()) {
    if ($ch -eq [char]'\') { $bs++; continue }
    if ($ch -eq [char]'"') { [void]$sb.Append(('\' * ($bs * 2 + 1)) + '"'); $bs = 0; continue }
    if ($bs) { [void]$sb.Append('\' * $bs); $bs = 0 }
    [void]$sb.Append($ch)
  }
  if ($bs) { [void]$sb.Append('\' * ($bs * 2)) }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function Stop-Tree([int]$ProcessId) {
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    $psi.Arguments = "/PID $ProcessId /T /F"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $k = [Diagnostics.Process]::Start($psi)
    [void]$k.WaitForExit(15000)
  } catch { }
}

# Run a program without a shell, capture UTF-8 output, enforce a timeout.
function Invoke-Tool([string]$Exe, [string[]]$Arguments = @(), [int]$TimeoutSec = 60, [hashtable]$Environment = @{}) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = (@($Arguments | ForEach-Object { ConvertTo-CmdArg $_ }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = New-Object Text.UTF8Encoding $false
  $psi.StandardErrorEncoding = New-Object Text.UTF8Encoding $false
  foreach ($k in $Environment.Keys) { $psi.EnvironmentVariables[$k] = [string]$Environment[$k] }
  $p = [Diagnostics.Process]::Start($psi)
  try { $p.StandardInput.BaseStream.Close() } catch { }
  $o = $p.StandardOutput.ReadToEndAsync()
  $e = $p.StandardError.ReadToEndAsync()
  $timedOut = $false
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { $timedOut = $true; Stop-Tree $p.Id }
  [void]$o.Wait(5000)
  [void]$e.Wait(5000)
  $code = -1
  if (-not $timedOut) { $code = $p.ExitCode }
  $out = ''
  $err = ''
  if ($o.IsCompleted) { $out = $o.Result }
  if ($e.IsCompleted) { $err = $e.Result }
  return [pscustomobject]@{ Code = $code; Out = $out; Err = $err; TimedOut = $timedOut }
}

# ---------------------------------------------------------------------------- network
function Initialize-Network {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  # Requests use the system proxy (Internet Options / PAC), but without credentials: an authenticating
  # (NTLM/Kerberos) office proxy would answer 407. Log on to it as the current Windows user.
  try {
    $proxy = [Net.WebRequest]::DefaultWebProxy
    if ($proxy) { $proxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials }
  } catch { }
}

function Get-Download([string]$Url, [string]$OutFile, [int]$TimeoutSec = 900) {
  Write-Info "downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec $TimeoutSec -UserAgent 'akif-youtube-addon-installer'
  if (-not (Test-Path -LiteralPath $OutFile)) { throw "download failed: $Url" }
}

# Tag of a repository's newest release, read from the redirect of /releases/latest (nothing is
# downloaded). Every file of a tool is then fetched from that one tag, so a file and its checksum can
# never come from two different releases.
function Get-LatestReleaseTag([string]$Repo) {
  $req = [Net.HttpWebRequest]::Create("https://github.com/$Repo/releases/latest")
  $req.AllowAutoRedirect = $false
  $req.UserAgent = 'akif-youtube-addon-installer'
  $req.Timeout = 30000
  $req.ReadWriteTimeout = 30000
  $resp = $req.GetResponse()
  try {
    $status = [int]$resp.StatusCode
    $loc = [string]$resp.Headers['Location']
  } finally { $resp.Close() }
  $m = [regex]::Match($loc, '/releases/tag/([A-Za-z0-9._-]+)$')
  if (-not $m.Success) { throw "GitHub did not name the latest release of $Repo (HTTP $status)" }
  return $m.Groups[1].Value
}

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Assert-Sha256([string]$Path, [string]$Expected) {
  $got = Get-Sha256 $Path
  if ($got -ne $Expected.ToLowerInvariant()) { throw "SHA-256 mismatch for $(Split-Path -Leaf $Path): expected $Expected, got $got" }
  Write-Ok "SHA-256 verified ($got)"
}

# "<sha256>  <file name>" lines -> hashtable name -> hash
function Read-SumsFile([string]$Path) {
  $h = @{}
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    $m = [regex]::Match($line.Trim(), '^([0-9a-fA-F]{64})\s+\*?(.+)$')
    if ($m.Success) { $h[$m.Groups[2].Value.Trim()] = $m.Groups[1].Value.ToLowerInvariant() }
  }
  return $h
}

function Expand-ZipTo([string]$Zip, [string]$Dest) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
  [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Dest)
}

# Running host processes of THIS installation (deno.exe / yt-dlp.exe / ffmpeg.exe started from bin\).
function Get-InstallProcesses {
  $prefix = $InstallDir.TrimEnd('\') + '\'
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $path = $null
      try { $path = $_.Path } catch { }
      $path -and $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
}

# Copy a tool into bin\. A running exe cannot be overwritten but it can be renamed, so a
# file in use is moved aside first (running hosts keep using the old copy).
function Copy-ToolFile([string]$Src, [string]$Dst) {
  if (Test-Path -LiteralPath $Dst) {
    $a = Get-Item -LiteralPath $Src
    $b = Get-Item -LiteralPath $Dst
    if ($a.Length -eq $b.Length -and $a.LastWriteTimeUtc -eq $b.LastWriteTimeUtc) { return $false }
    try {
      Remove-Item -LiteralPath $Dst -Force
    } catch {
      $aside = "$Dst.old-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
      try {
        Rename-Item -LiteralPath $Dst -NewName (Split-Path -Leaf $aside)
        Write-Warn2 "$(Split-Path -Leaf $Dst) is in use; the old copy was moved aside and is removed on the next install"
      } catch {
        if ($Force) {
          Get-InstallProcesses | ForEach-Object { Stop-Tree $_.Id }
          Start-Sleep -Milliseconds 800
          Remove-Item -LiteralPath $Dst -Force
        } else {
          throw "$Dst is in use by a running download. Close Chrome/Edge (or wait for the downloads to finish) and run the installer again, or use -Force."
        }
      }
    }
  }
  Copy-Item -LiteralPath $Src -Destination $Dst -Force
  return $true
}

# Is a program running from this file, or from a file inside this folder?
function Test-InUse([string]$Path) {
  $p = $Path.TrimEnd('\')
  $prefix = $p + '\'
  foreach ($proc in @(Get-Process -ErrorAction SilentlyContinue)) {
    $exe = $null
    try { $exe = $proc.Path } catch { }
    if ($exe -and ($exe -ieq $p -or $exe.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase))) { return $true }
  }
  return $false
}

function Remove-StaleCopies([string]$Dir) {
  Get-ChildItem -LiteralPath $Dir -Filter '*.old-*' -Force -ErrorAction SilentlyContinue | ForEach-Object {
    # an old onedir build that a download still runs from would lose files under it: leave it
    if ($_.PSIsContainer -and (Test-InUse $_.FullName)) { return }
    try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop } catch { }
  }
}

# Replace the folder $Dest (an onedir build) with a copy of $Src. A build that a running download uses
# must never be deleted in place - Remove-Item would strip its _internal files from under it before
# failing on the running exe. So the new copy is prepared next to it, the old folder is renamed aside
# (atomic; refused while one of its files is open), the new one renamed into place, and the old one
# deleted only when nothing runs from it any more (else Remove-StaleCopies does it on a later run).
# Returns $false, with nothing changed, when the old build is in use (and -Force was not given).
function Install-Folder([string]$Src, [string]$Dest) {
  $new = "$Dest.new"
  if (Test-Path -LiteralPath $new) { Remove-Item -LiteralPath $new -Recurse -Force }
  Copy-Item -LiteralPath $Src -Destination $new -Recurse -Force
  if (Test-Path -LiteralPath $Dest) {
    if (Test-InUse $Dest) {
      if (-not $Force) { Remove-Item -LiteralPath $new -Recurse -Force; return $false }
      Get-InstallProcesses | ForEach-Object { Stop-Tree $_.Id }
      Start-Sleep -Milliseconds 800
    }
    $aside = "$Dest.old-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
    try { Rename-Item -LiteralPath $Dest -NewName (Split-Path -Leaf $aside) -ErrorAction Stop }
    catch { Remove-Item -LiteralPath $new -Recurse -Force; return $false }
    try { Rename-Item -LiteralPath $new -NewName (Split-Path -Leaf $Dest) -ErrorAction Stop }
    catch { Rename-Item -LiteralPath $aside -NewName (Split-Path -Leaf $Dest); throw }
    if (-not (Test-InUse $aside)) { try { Remove-Item -LiteralPath $aside -Recurse -Force -ErrorAction Stop } catch { } }
  } else {
    Rename-Item -LiteralPath $new -NewName (Split-Path -Leaf $Dest)
  }
  return $true
}

# ---------------------------------------------------------------------------- extension id
function Get-ExtensionIdFromKey([string]$KeyBase64) {
  $bytes = [Convert]::FromBase64String($KeyBase64)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
  $sb = New-Object Text.StringBuilder
  for ($i = 0; $i -lt 16; $i++) {
    [void]$sb.Append([char]([int][char]'a' + ($hash[$i] -shr 4)))
    [void]$sb.Append([char]([int][char]'a' + ($hash[$i] -band 15)))
  }
  return $sb.ToString()
}

# ---------------------------------------------------------------------------- tools
function Get-YtDlpVersion([string]$Exe) {
  try { $r = Invoke-Tool $Exe @('--version') 90 $PyEnv } catch { return $null }
  $line = @(($r.Out -split "`r?`n") | Where-Object { $_ -match '^\d{4}\.\d{1,2}\.\d{1,2}' } | Select-Object -First 1)
  if ($line.Count -eq 0) { return $null }
  return $line[0].Trim()
}

function ConvertTo-YtVersion([string]$v) {
  $m = [regex]::Match($v, '^(\d{4})\.(\d{1,2})\.(\d{1,2})')
  if (-not $m.Success) { return [version]'0.0' }
  return [version]("{0}.{1}.{2}" -f $m.Groups[1].Value, [int]$m.Groups[2].Value, [int]$m.Groups[3].Value)
}

function Get-YtDlpVariant([string]$Exe) {
  $info = @{ Variant = 'exe'; Python = $null; VersionFile = $null }
  $real = Resolve-RealPath $Exe
  if ($Exe -match '\\WinGet\\' -or $real -match '\\WinGet\\') { $info.Variant = 'winget'; return $info }
  if ((Get-Item -LiteralPath $real).Length -lt 2MB) {
    # pip / pipx / venv: Scripts\yt-dlp.exe is a small launcher that embeds "#!<python.exe>"
    $text = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($real))
    $m = [regex]::Match($text, '#!\s*"?([A-Za-z]:\\[^"\r\n]*?\\pythonw?\.exe)"?')
    if ($m.Success -and (Test-Path -LiteralPath $m.Groups[1].Value)) {
      $info.Variant = 'pip'
      $info.Python = $m.Groups[1].Value
      $r = Invoke-Tool $info.Python @('-X', 'utf8', '-c', 'import yt_dlp.version as v, sys; sys.stdout.write(v.__file__)') 120 $PyEnv
      $vf = $r.Out.Trim()
      if ($r.Code -eq 0 -and $vf -and (Test-Path -LiteralPath $vf)) { $info.VersionFile = $vf }
    }
  }
  return $info
}

# Python modules (of $Modules) that the Python of a pip yt-dlp cannot import, or @() when unknown.
function Get-MissingPyModules([string]$Python, [string[]]$Modules) {
  $code = 'import importlib.util as u, sys; sys.stdout.write(" ".join(m for m in sys.argv[1:] if u.find_spec(m) is None))'
  try { $r = Invoke-Tool $Python (@('-X', 'utf8', '-c', $code) + $Modules) 120 $PyEnv } catch { return @() }
  if ($r.Code -ne 0) { return @() }
  return @($r.Out.Trim() -split '\s+' | Where-Object { $_ })
}

# The yt-dlp build a previous run put into bin\ (onedir preferred), if it runs.
function Get-OwnYtDlp([string]$Bin) {
  foreach ($c in @(@{ Path = (Join-Path $Bin 'yt-dlp\yt-dlp.exe'); Variant = 'onedir' }, @{ Path = (Join-Path $Bin 'yt-dlp.exe'); Variant = 'exe' })) {
    if (-not (Test-Path -LiteralPath $c.Path -PathType Leaf)) { continue }
    $v = Get-YtDlpVersion $c.Path
    if ($v) { return @{ Path = $c.Path; Variant = $c.Variant; Version = $v } }
  }
  return $null
}

# The official yt-dlp build in bin\: kept while it runs and no newer release exists (or none can be
# looked up, e.g. offline); otherwise the newest release is downloaded and verified against its
# SHA2-256SUMS. Returns @{ Path; Variant; Version }.
function Install-OwnYtDlp([string]$Work, [string]$Bin, [string]$State) {
  $have = Get-OwnYtDlp $Bin
  $stampFile = Join-Path $State 'ytdlp-onedir.sha256'
  try {
    $tag = Get-LatestReleaseTag 'yt-dlp/yt-dlp'
    $base = "https://github.com/yt-dlp/yt-dlp/releases/download/$tag/"
    $sumsFile = Join-Path $Work 'SHA2-256SUMS'
    Get-Download ($base + 'SHA2-256SUMS') $sumsFile 60
    $sums = Read-SumsFile $sumsFile
  } catch {
    if ($have) { Write-Warn2 "could not look for a newer yt-dlp ($(Get-ErrorText $_)); keeping $($have.Version)"; return $have }
    throw
  }
  if ($have -and -not $Redownload -and (ConvertTo-YtVersion $have.Version) -ge (ConvertTo-YtVersion $tag)) {
    if ($have.Variant -eq 'onedir' -and $have.Version -eq $tag -and $sums.ContainsKey('yt-dlp_win.zip')) {
      Write-Utf8NoBom $stampFile $sums['yt-dlp_win.zip'] # the host's "Update yt-dlp" compares it with SHA2-256SUMS
    }
    Write-Ok "yt-dlp $($have.Version) in bin\ is up to date"
    return $have
  }
  try {
    if ($sums.ContainsKey('yt-dlp_win.zip')) {
      # onedir build: starts 2-4x faster than the one-file exe and leaves no _MEI temp dirs behind
      $zip = Join-Path $Work 'yt-dlp_win.zip'
      Get-Download ($base + 'yt-dlp_win.zip') $zip
      Assert-Sha256 $zip $sums['yt-dlp_win.zip']
      $x = Join-Path $Work 'yt-dlp-x'
      Expand-ZipTo $zip $x
      $exe = Get-ChildItem -LiteralPath $x -Recurse -Filter 'yt-dlp.exe' | Select-Object -First 1
      if (-not $exe) { throw 'yt-dlp_win.zip does not contain yt-dlp.exe' }
      if (-not (Install-Folder $exe.DirectoryName (Join-Path $Bin 'yt-dlp'))) {
        $busy = 'bin\yt-dlp is in use by a running download'
        if ($have) { Write-Warn2 "$busy; keeping yt-dlp $($have.Version) (run the installer again later, or use -Force)"; return $have }
        throw "$busy. Close Chrome/Edge (or wait for the downloads to finish) and run the installer again, or use -Force."
      }
      Write-Utf8NoBom $stampFile $sums['yt-dlp_win.zip']
      $path = Join-Path $Bin 'yt-dlp\yt-dlp.exe'
      $variant = 'onedir'
    } else {
      if (-not $sums.ContainsKey('yt-dlp.exe')) { throw 'the yt-dlp release lists neither yt-dlp_win.zip nor yt-dlp.exe' }
      $tmpExe = Join-Path $Work 'yt-dlp.exe'
      Get-Download ($base + 'yt-dlp.exe') $tmpExe
      Assert-Sha256 $tmpExe $sums['yt-dlp.exe']
      $path = Join-Path $Bin 'yt-dlp.exe'
      [void](Copy-ToolFile $tmpExe $path)
      $variant = 'exe'
    }
  } catch {
    if ($have) { Write-Warn2 "yt-dlp could not be updated ($(Get-ErrorText $_)); keeping $($have.Version)"; return $have }
    throw
  }
  $v = Get-YtDlpVersion $path
  if (-not $v) { throw "the downloaded yt-dlp does not run: $path" }
  Write-Ok "installed yt-dlp $v ($variant)"
  return @{ Path = $path; Variant = $variant; Version = $v }
}

function Get-FfmpegVersion([string]$Exe) {
  if (-not $Exe -or -not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return $null }
  try { $r = Invoke-Tool $Exe @('-hide_banner', '-version') 60 } catch { return $null }
  $m = [regex]::Match($r.Out, '^(?:ffmpeg|ffprobe) version (\S+)')
  if ($r.Code -eq 0 -and $m.Success) { return $m.Groups[1].Value }
  return $null
}

# The host always passes -stats_period (FFmpeg 4.4+) and, for yt-dlp section downloads, the http
# option request_size: an FFmpeg without them fails every clip, GIF and cut. Returns what is missing.
function Get-FfmpegMissingFeatures([string]$Exe) {
  $missing = @()
  try {
    $r = Invoke-Tool $Exe @('-hide_banner', '-h', 'long') 60
    if (($r.Out + "`n" + $r.Err) -notmatch '(?m)^\s*-stats_period\b') { $missing += '-stats_period' }
    $r = Invoke-Tool $Exe @('-hide_banner', '-h', 'protocol=http') 60
    if (($r.Out + "`n" + $r.Err) -notmatch '(?m)^\s*-request_size\b') { $missing += 'the http option request_size' }
  } catch { $missing += "a working -h ($(Get-ErrorText $_))" }
  return $missing
}

# FFmpeg in bin\ (yt-dlp/FFmpeg-Builds): a working copy is kept - "latest" is rebuilt every day, so
# only -Redownload (or a missing, broken or too old copy) fetches the ~200 MB zip again. The checksum
# list of the release must list the zip (fail closed). Returns @{ Path; Version }.
function Install-OwnFfmpeg([string]$Work, [string]$Bin) {
  $exe = Join-Path $Bin 'ffmpeg.exe'
  $have = Get-FfmpegVersion $exe
  if ($have -and (-not (Get-FfmpegVersion (Join-Path $Bin 'ffprobe.exe')) -or @(Get-FfmpegMissingFeatures $exe).Count)) { $have = $null }
  if ($have -and -not $Redownload) {
    Write-Ok "FFmpeg $have in bin\ is kept (-Redownload fetches the newest build)"
    return @{ Path = $exe; Version = $have }
  }
  try {
    $base = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/'
    $name = 'ffmpeg-master-latest-win64-gpl.zip'
    $sumsFile = Join-Path $Work 'ffmpeg-checksums.sha256'
    Get-Download ($base + 'checksums.sha256') $sumsFile 60
    $sums = Read-SumsFile $sumsFile
    if (-not $sums.ContainsKey($name)) { throw "the FFmpeg release publishes no checksum for $name" }
    $zip = Join-Path $Work $name
    Get-Download ($base + $name) $zip
    if ((Get-Sha256 $zip) -ne $sums[$name]) {
      # "latest" is rebuilt in place: the checksum list may predate the zip
      Get-Download ($base + 'checksums.sha256') $sumsFile 60
      $sums = Read-SumsFile $sumsFile
      if (-not $sums.ContainsKey($name)) { throw "the FFmpeg release publishes no checksum for $name" }
    }
    Assert-Sha256 $zip $sums[$name]
    $x = Join-Path $Work 'ffmpeg-x'
    Expand-ZipTo $zip $x
    foreach ($tool in @('ffmpeg.exe', 'ffprobe.exe')) {
      $f = Get-ChildItem -LiteralPath $x -Recurse -Filter $tool | Select-Object -First 1
      if (-not $f) { throw "$name does not contain $tool" }
      [void](Copy-ToolFile $f.FullName (Join-Path $Bin $tool))
    }
  } catch {
    if ($have) { Write-Warn2 "FFmpeg could not be downloaded again ($(Get-ErrorText $_)); keeping $have"; return @{ Path = $exe; Version = $have } }
    throw
  }
  $v = Get-FfmpegVersion $exe
  if (-not $v) { throw "the downloaded ffmpeg does not run: $exe" }
  $lack = @(Get-FfmpegMissingFeatures $exe)
  if ($lack.Count) { Write-Warn2 "FFmpeg $v has no $($lack -join ' and '); clips, GIFs and cuts may fail" }
  Write-Ok "installed FFmpeg $v"
  return @{ Path = $exe; Version = $v }
}

function Get-DenoVersion([string]$Exe) {
  if (-not $Exe -or -not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return $null }
  try { $r = Invoke-Tool $Exe @('--version') 60 } catch { return $null }
  $m = [regex]::Match($r.Out, '^deno (\d+\.\d+\.\d+\S*)')
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

function ConvertTo-SemVer([string]$v) {
  $m = [regex]::Match([string]$v, '^v?(\d+)\.(\d+)\.(\d+)')
  if (-not $m.Success) { return [version]'0.0' }
  return [version]("{0}.{1}.{2}" -f $m.Groups[1].Value, $m.Groups[2].Value, $m.Groups[3].Value)
}

# deno.exe on PATH may be a package-manager shim that only forwards to the real binary (Scoop
# shims\deno.exe + deno.shim, Chocolatey bin\deno.exe, mise/proto shims): a copy of a shim does not
# run on its own. Deno knows where its executable really is. Returns that file, or $null when only a
# shim can be found (deno.exe itself is far larger than 10 MB).
function Resolve-DenoExecutable([string]$Exe, [string]$Work) {
  $denoEnv = @{ NO_COLOR = '1'; DENO_NO_UPDATE_CHECK = '1'; DENO_NO_PROMPT = '1'; DENO_DIR = (Join-Path $Work 'deno-dir') }
  $cand = $Exe
  try {
    $r = Invoke-Tool $Exe @('eval', '-q', 'console.log(Deno.execPath())') 60 $denoEnv
    $line = @(($r.Out -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -Last 1)
    if ($r.Code -eq 0 -and $line.Count -and (Test-Path -LiteralPath $line[0].Trim() -PathType Leaf)) { $cand = Resolve-RealPath $line[0].Trim() }
  } catch { }
  if (-not (Test-Path -LiteralPath $cand -PathType Leaf) -or (Get-Item -LiteralPath $cand).Length -lt 10MB) { return $null }
  return $cand
}

# Deno's Windows builds are Authenticode-signed by Deno Land Inc. Unlike the checksum (served next to
# the zip), the signature cannot be forged by whoever tampers with the download - and the host runs
# deno.exe with --allow-all.
function Assert-DenoSignature([string]$Exe) {
  $s = Get-AuthenticodeSignature -LiteralPath $Exe
  $who = ''
  if ($s.SignerCertificate) { $who = $s.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }
  if ($s.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $who -notlike 'Deno Land*') {
    throw "deno.exe does not carry a valid signature of Deno Land Inc. (status $($s.Status), signer '$who')"
  }
  Write-Ok "Authenticode signature verified ($who)"
}

# Deno in bin\ when none can be copied from PATH: kept while it runs and no newer release exists (or
# none can be looked up, e.g. offline); otherwise downloaded from the newest release, verified against
# that release's checksum (fail closed) and Deno's signature.
function Install-OwnDeno([string]$Work, [string]$DenoDst) {
  $have = Get-DenoVersion $DenoDst
  if ($have -and (ConvertTo-SemVer $have).Major -lt 2) { $have = $null }
  try { $tag = Get-LatestReleaseTag 'denoland/deno' }
  catch {
    if ($have) { Write-Warn2 "could not look for a newer Deno ($(Get-ErrorText $_)); keeping Deno $have"; return }
    throw
  }
  if ($have -and -not $Redownload -and (ConvertTo-SemVer $have) -ge (ConvertTo-SemVer $tag)) {
    Write-Ok "Deno $have in bin\ is up to date"
    return
  }
  try {
    $base = "https://github.com/denoland/deno/releases/download/$tag/"
    $name = 'deno-x86_64-pc-windows-msvc.zip'
    $zip = Join-Path $Work $name
    Get-Download ($base + $name) $zip
    $sumFile = Join-Path $Work "$name.sha256sum"
    Get-Download ($base + "$name.sha256sum") $sumFile 60
    $m = [regex]::Match([IO.File]::ReadAllText($sumFile), '\b([0-9a-fA-F]{64})\b')
    if (-not $m.Success) { throw "the Deno release publishes no readable checksum for $name" }
    Assert-Sha256 $zip $m.Groups[1].Value
    $x = Join-Path $Work 'deno-x'
    Expand-ZipTo $zip $x
    $exe = Join-Path $x 'deno.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "$name does not contain deno.exe" }
    Assert-DenoSignature $exe
    [void](Copy-ToolFile $exe $DenoDst)
    Write-Ok "installed Deno $($tag.TrimStart('v'))"
  } catch {
    if ($have) { Write-Warn2 "Deno could not be updated ($(Get-ErrorText $_)); keeping Deno $have"; return }
    throw
  }
}

# ---------------------------------------------------------------------------- self-test
function Read-Exact($Stream, [int]$Count, [int]$TimeoutSec) {
  $buf = New-Object byte[] $Count
  $off = 0
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
  while ($off -lt $Count) {
    $left = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
    if ($left -le 0) { throw "no answer from the host within $TimeoutSec s" }
    $t = $Stream.ReadAsync($buf, $off, $Count - $off)
    if (-not $t.Wait($left)) { throw "no answer from the host within $TimeoutSec s" }
    if ($t.Result -le 0) { throw 'the host closed its output without answering (see logs\host-stderr.log)' }
    $off += $t.Result
  }
  return , $buf
}

# Start host.bat exactly like Chrome does - two named pipes and cmd.exe redirection:
#   %COMSPEC% /d /s /c ""<host.bat>" chrome-extension://<id>/ --parent-window=0" < \\.\pipe\in > \\.\pipe\out
# (hidden console, cwd = host folder) - and send one framed {"type":"hello"}.
# .NET stdin redirection is deliberately NOT used: with a UTF-8 console code page its writer sends
# a BOM to the child as soon as the process starts, which is not what a browser does.
function Invoke-HostHello([string]$HostBat, [string]$Origin, [int]$TimeoutSec) {
  Add-Type -AssemblyName System.Core
  $tok = [guid]::NewGuid().ToString('N').Substring(0, 16)
  $inName = "akif-selftest.in.$tok"
  $outName = "akif-selftest.out.$tok"
  $pin = New-Object IO.Pipes.NamedPipeServerStream($inName, [IO.Pipes.PipeDirection]::Out, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous)
  $pout = New-Object IO.Pipes.NamedPipeServerStream($outName, [IO.Pipes.PipeDirection]::In, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous)
  $p = $null
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $env:ComSpec
    $psi.Arguments = '/d /s /c ""' + $HostBat + '" ' + $Origin + ' --parent-window=0" < \\.\pipe\' + $inName + ' > \\.\pipe\' + $outName
    $psi.WorkingDirectory = Split-Path -Parent $HostBat
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = [Diagnostics.Process]::Start($psi)
    $c1 = $pin.WaitForConnectionAsync()
    $c2 = $pout.WaitForConnectionAsync()
    if (-not $c1.Wait(30000) -or -not $c2.Wait(30000)) { throw 'cmd.exe did not open the host pipes' }
    $body = [Text.Encoding]::UTF8.GetBytes('{"id":"install-selftest","type":"hello"}')
    $pin.Write([BitConverter]::GetBytes([uint32]$body.Length), 0, 4)
    $pin.Write($body, 0, $body.Length)
    $pin.Flush()
    $len = [BitConverter]::ToUInt32((Read-Exact $pout 4 $TimeoutSec), 0)
    if ($len -eq 0 -or $len -gt 1048576) { throw "invalid frame header from the host ($len) - something printed to stdout" }
    $json = [Text.Encoding]::UTF8.GetString((Read-Exact $pout ([int]$len) 30))
    $ms = $sw.ElapsedMilliseconds
    $pin.Dispose() # stdin EOF: the host must exit by itself
    $pin = $null
    $exited = $p.WaitForExit(15000)
    if (-not $exited) { Stop-Tree $p.Id }
    return [pscustomobject]@{ Reply = ($json | ConvertFrom-Json); Ms = $ms; ExitedOnEof = $exited }
  } catch {
    if ($p) { Stop-Tree $p.Id }
    throw
  } finally {
    if ($pin) { $pin.Dispose() }
    $pout.Dispose()
  }
}

# ============================================================================ main
$Work = $null
try {
  Write-Host "Akif's Special YouTube Addon - companion app installer" -ForegroundColor White
  if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'AkifYouTubeAddon' }
  $InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  if ($InstallDir -match '[&^|<>%!"]') { throw "The install folder must not contain any of & ^ | < > % ! `" : $InstallDir" }
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'A 64-bit Windows is required.' }
  Initialize-Network

  $Src = Join-Path $PSScriptRoot 'host'
  foreach ($f in @('host.ts', 'host.bat', 'lib\guard.ts', 'lib\jobs.ts', 'lib\ps\pick_folder_vista.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Src $f))) { throw "Source file missing: $(Join-Path $Src $f). Run the installer from the extension's companion folder." }
  }
  $batBytes = [IO.File]::ReadAllBytes((Join-Path $Src 'host.bat'))
  if ($batBytes.Length -ge 3 -and $batBytes[0] -eq 0xEF -and $batBytes[1] -eq 0xBB -and $batBytes[2] -eq 0xBF) {
    throw 'host.bat has a UTF-8 BOM; that would corrupt the native messaging channel.'
  }

  # ------------------------------------------------------------ extension id
  Write-Step 'Extension ID'
  $ExtId = $ExpectedExtensionId
  $manifestSrc = Join-Path (Split-Path -Parent $PSScriptRoot) 'extension\manifest.json'
  if (Test-Path -LiteralPath $manifestSrc) {
    $mf = [IO.File]::ReadAllText($manifestSrc, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($mf.PSObject.Properties['key'] -and $mf.key) {
      $ExtId = Get-ExtensionIdFromKey ([string]$mf.key)
      if ($ExtId -ne $ExpectedExtensionId) { Write-Warn2 "manifest key gives $ExtId (expected $ExpectedExtensionId); using the manifest's ID" }
      else { Write-Ok "$ExtId (computed from extension\manifest.json)" }
    } else { Write-Warn2 "manifest.json has no key; using $ExtId" }
  } else { Write-Info "extension\manifest.json not found next to the companion folder; using $ExtId" }
  $Origin = "chrome-extension://$ExtId/"

  # ------------------------------------------------------------ folders (with safety checks)
  Write-Step "Install folder: $InstallDir"
  $srcRoot = $PSScriptRoot.TrimEnd('\')
  if ($InstallDir -ieq $srcRoot -or $InstallDir.StartsWith($srcRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
      $srcRoot.StartsWith($InstallDir + '\', [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath (Join-Path $InstallDir 'install.ps1'))) {
    throw "The install folder must not be (or contain, or be inside) the extension's source folder: $InstallDir"
  }
  if (Test-ProtectedFolder $InstallDir) { throw "Refusing to install into a system or user folder: $InstallDir" }
  # The host runs with your rights: a folder outside your profile (e.g. C:\Tools\...) can usually be
  # changed by every user of this PC.
  $ProfileRoot = Get-ProfileRoot $InstallDir
  if (-not $ProfileRoot) {
    throw "The install folder must be inside your user profile ($env:USERPROFILE), so that no other account can change the companion app (it runs with your rights). The default is $(Join-Path $env:LOCALAPPDATA 'AkifYouTubeAddon')."
  }
  foreach ($p in @(Get-PathChain $InstallDir $ProfileRoot)) {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $it = Get-Item -LiteralPath $p -Force
    if ($it.LinkType -eq 'Junction' -or $it.LinkType -eq 'SymbolicLink') { throw "The install folder must not be, or be inside, a link to another folder: $p" }
  }
  $wasInstalled = (Test-Path -LiteralPath (Join-Path $InstallDir $Marker)) -or
    ((Test-Path -LiteralPath (Join-Path $InstallDir 'config.json')) -and (Test-Path -LiteralPath (Join-Path $InstallDir "$HostName.json")))
  if ((Test-Path -LiteralPath $InstallDir) -and @(Get-ChildItem -LiteralPath $InstallDir -Force).Count -gt 0 -and -not $wasInstalled) {
    throw "$InstallDir exists and is not an installation of this companion app. Choose an empty folder."
  }
  $otherUser = Get-OtherDesktopUser
  if ($otherUser) {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $why = "The installer runs as $me, but this desktop belongs to $otherUser. The companion app is installed for one Windows account, so the browser of $otherUser would not find it."
    if (-not $Force) { throw "$why Start install.bat by double-clicking it (not with 'Run as administrator'), or use -Force to install for $me anyway." }
    Write-Warn2 "$why Installing for $me anyway (-Force)."
  }
  $HostDir = Join-Path $InstallDir 'host'
  $Bin = Join-Path $InstallDir 'bin'
  $Logs = Join-Path $InstallDir 'logs'
  $State = Join-Path $InstallDir 'state'
  $created = @(Get-PathChain $InstallDir $ProfileRoot | Where-Object { -not (Test-Path -LiteralPath $_) })
  New-Dir $InstallDir
  Protect-InstallDir $InstallDir $ProfileRoot $wasInstalled $created
  # marker first: only folders carrying it are ever removed by uninstall.ps1
  Write-Utf8NoBom (Join-Path $InstallDir $Marker) "Akif's Special YouTube Addon companion app. Remove it with uninstall.bat.`r`n"
  foreach ($d in @($HostDir, $Bin, $Logs, $State)) { New-Dir $d }
  Remove-StaleCopies $Bin
  $Work = Join-Path $env:TEMP ('akif-yt-companion-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Dir $Work

  # ------------------------------------------------------------ host files (mirror; keep .deno-cache)
  Write-Step 'Copying the host'
  $libDst = Join-Path $HostDir 'lib'
  if (Test-Path -LiteralPath $libDst) { Remove-Item -LiteralPath $libDst -Recurse -Force }
  Copy-Item -LiteralPath (Join-Path $Src 'lib') -Destination $libDst -Recurse -Force
  Get-ChildItem -LiteralPath $libDst -Recurse -Force | Where-Object { $_.PSIsContainer -and $_.Name -like '.*' } | Remove-Item -Recurse -Force
  foreach ($f in @('host.ts', 'host.bat')) { Copy-Item -LiteralPath (Join-Path $Src $f) -Destination (Join-Path $HostDir $f) -Force }
  foreach ($f in @('uninstall.ps1', 'uninstall.bat')) {
    $p = Join-Path $PSScriptRoot $f
    if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $InstallDir $f) -Force }
  }
  # Files extracted from a downloaded zip carry the mark of the web, and copies keep it: a RemoteSigned
  # execution policy would then refuse the installed folder picker script and the uninstaller.
  $copied = @(Get-ChildItem -LiteralPath $libDst -Recurse -File -Force) +
    @(@('host\host.ts', 'host\host.bat', 'uninstall.ps1', 'uninstall.bat') | ForEach-Object { Join-Path $InstallDir $_ } |
      Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Get-Item -LiteralPath $_ -Force })
  $copied | Unblock-File -ErrorAction SilentlyContinue
  $errLog = Join-Path $Logs 'host-stderr.log'
  if ((Test-Path -LiteralPath $errLog) -and (Get-Item -LiteralPath $errLog).Length -gt 1MB) {
    try { Move-Item -LiteralPath $errLog -Destination "$errLog.1" -Force } catch { }
  }
  Write-Ok "$HostDir"

  # ------------------------------------------------------------ Deno
  Write-Step 'Deno (runs the host and solves YouTube JS challenges for yt-dlp)'
  $DenoBin = Join-Path $Bin 'deno.exe'
  $denoSrc = $null
  if (-not $OwnDeno) { $denoSrc = Find-OnPath 'deno' }
  $denoOk = $false
  if ($denoSrc) {
    $real = Resolve-RealPath $denoSrc
    $pv = Get-DenoVersion $real
    if ($pv -and (ConvertTo-SemVer $pv).Major -ge 2) {
      $exe = Resolve-DenoExecutable $real $Work
      if (-not $exe) { Write-Warn2 "deno.exe on PATH ($denoSrc) is a package-manager shim whose real deno.exe was not found; using Deno in bin\ instead" }
      else {
        $copiedNow = Copy-ToolFile $exe $DenoBin
        if (Get-DenoVersion $DenoBin) {
          if ($copiedNow) { Write-Ok "copied Deno $pv from $exe" } else { Write-Ok "bin\deno.exe is up to date ($exe)" }
          $denoOk = $true
        } else {
          Write-Warn2 "the copy of $exe does not run on its own; using Deno in bin\ instead"
          try { Remove-Item -LiteralPath $DenoBin -Force -ErrorAction Stop } catch { }
        }
      }
    } else { Write-Warn2 "Deno on PATH does not run or is older than 2.0 ($denoSrc)" }
  }
  if (-not $denoOk) { Install-OwnDeno $Work $DenoBin }
  $DenoVersion = Get-DenoVersion $DenoBin
  if (-not $DenoVersion) { throw "bin\deno.exe does not run: $DenoBin" }
  Write-Ok "Deno $DenoVersion -> $DenoBin"

  # ------------------------------------------------------------ yt-dlp
  Write-Step 'yt-dlp'
  $yt = $null
  if (-not $OwnYtDlp) {
    $cand = Find-OnPath 'yt-dlp'
    if ($cand) {
      $v = Get-YtDlpVersion $cand
      if ($v -and (ConvertTo-YtVersion $v) -ge $MinYtDlp) {
        $info = Get-YtDlpVariant $cand
        # A plain "pip install yt-dlp" lacks the extras the official builds bundle: without yt-dlp-ejs
        # YouTube's JavaScript challenges cannot be solved (formats go missing), without curl_cffi no
        # browser impersonation (some subtitle requests need it).
        $missing = @()
        if ($info.Variant -eq 'pip' -and $info.Python) { $missing = @(Get-MissingPyModules $info.Python @('yt_dlp_ejs', 'curl_cffi')) }
        $fix = "`"$($info.Python)`" -m pip install -U `"yt-dlp[default,curl-cffi]`""
        if ($missing -contains 'yt_dlp_ejs') {
          Write-Warn2 "yt-dlp $v on PATH has no yt-dlp-ejs (needed for YouTube's JavaScript challenges); using the official build instead"
          Write-Info "to use your pip yt-dlp instead, run: $fix - then run the installer again"
        } else {
          if ($missing -contains 'curl_cffi') { Write-Warn2 "yt-dlp $v on PATH has no curl_cffi, so some subtitle downloads may fail; to add it run: $fix" }
          $yt = @{ Path = $cand; Variant = $info.Variant; Python = $info.Python; VersionFile = $info.VersionFile; Version = $v }
          Write-Ok "using yt-dlp $v from PATH ($($info.Variant)): $cand"
        }
      } elseif ($v) { Write-Warn2 "yt-dlp $v on PATH is older than $MinYtDlp; using the official build" }
      else { Write-Warn2 "yt-dlp on PATH does not run ($cand); using the official build" }
    }
  }
  if (-not $yt) {
    $own = Install-OwnYtDlp $Work $Bin $State
    $yt = @{ Path = $own.Path; Variant = $own.Variant; Python = $null; VersionFile = $null; Version = $own.Version }
    Write-Ok "yt-dlp $($yt.Version) ($($yt.Variant)) -> $($yt.Path)"
  }

  # ------------------------------------------------------------ FFmpeg
  Write-Step 'FFmpeg'
  $ff = $null
  if (-not $OwnFfmpeg) {
    $cand = Find-OnPath 'ffmpeg'
    if ($cand) {
      $fv = Get-FfmpegVersion $cand
      if ($fv) {
        $probe = Join-Path (Split-Path -Parent $cand) 'ffprobe.exe'
        if (-not (Test-Path -LiteralPath $probe)) { $probe = Find-OnPath 'ffprobe' }
        $lack = @()
        if ($probe) { $lack = @(Get-FfmpegMissingFeatures $cand) }
        if (-not $probe) { Write-Warn2 'ffprobe was not found next to ffmpeg; using the FFmpeg build in bin\' }
        elseif ($lack.Count) { Write-Warn2 "FFmpeg $fv on PATH is too old for the extension (no $($lack -join ' and ')); using the FFmpeg build in bin\" }
        else {
          $ff = @{ Path = $cand; Ffprobe = $probe; Version = $fv }
          Write-Ok "using FFmpeg $fv from PATH: $cand"
        }
      } else { Write-Warn2 "ffmpeg on PATH does not run ($cand)" }
    }
  }
  if (-not $ff) {
    $own = Install-OwnFfmpeg $Work $Bin
    $ff = @{ Path = $own.Path; Ffprobe = (Join-Path $Bin 'ffprobe.exe'); Version = $own.Version }
    Write-Ok "FFmpeg $($ff.Version) -> $($ff.Path)"
  }

  # ------------------------------------------------------------ config.json + host manifest
  Write-Step 'Configuration'
  $config = [ordered]@{
    schema      = 1
    hostVersion = $HostVersion
    installedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    installDir  = $InstallDir
    hostName    = $HostName
    extensionId = $ExtId
    tools       = [ordered]@{
      ytdlp  = [ordered]@{ path = $yt.Path; variant = $yt.Variant; version = $yt.Version; python = $yt.Python; versionFile = $yt.VersionFile }
      ffmpeg = [ordered]@{ path = $ff.Path; ffprobe = $ff.Ffprobe; version = $ff.Version }
      deno   = [ordered]@{ path = $DenoBin; version = $DenoVersion }
    }
  }
  $ConfigPath = Join-Path $InstallDir 'config.json'
  Write-Utf8NoBom $ConfigPath ($config | ConvertTo-Json -Depth 6)
  Write-Ok $ConfigPath

  $HostBat = Join-Path $HostDir 'host.bat'
  $manifest = [ordered]@{
    name            = $HostName
    description     = "Akif's Special YouTube Addon companion (yt-dlp + FFmpeg)"
    path            = $HostBat
    type            = 'stdio'
    allowed_origins = @($Origin)
  }
  $ManifestPath = Join-Path $InstallDir "$HostName.json"
  Write-Utf8NoBom $ManifestPath ($manifest | ConvertTo-Json -Depth 4)
  $check = [IO.File]::ReadAllText($ManifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($check.name -ne $HostName -or $check.path -ne $HostBat -or @($check.allowed_origins)[0] -ne $Origin) { throw 'the host manifest did not round-trip' }
  Write-Ok $ManifestPath

  # ------------------------------------------------------------ registry
  Write-Step 'Browser registration (HKCU)'
  $registered = @()
  $policyIssues = @()
  if ($NoRegister) { Write-Warn2 'skipped (-NoRegister)' }
  else {
    foreach ($b in $RegBases) {
      $sub = "$($b.Key)\$HostName"
      $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($sub)
      try { $k.SetValue('', $ManifestPath, [Microsoft.Win32.RegistryValueKind]::String) } finally { $k.Close() }
      $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub)
      try { $val = $k.GetValue('') } finally { $k.Close() }
      if ($val -ne $ManifestPath) { throw "registry value for $($b.Name) did not stick" }
      $registered += $b.Name
      Write-Ok "$($b.Name): HKCU\$sub"
    }
    # A registration that a browser policy ignores looks installed but never connects.
    $policyIssues = @(Get-NativeMessagingPolicyIssues @(Get-PolicyRoots))
    foreach ($issue in $policyIssues) { Write-Warn2 $issue }
  }

  # ------------------------------------------------------------ self-test (also warms the Deno cache)
  $selfTest = 'skipped'
  if (-not $SkipSelfTest) {
    Write-Step 'Self-test (starting the host the way the browser does)'
    $cold = Invoke-HostHello $HostBat $Origin 120
    $hello = $cold.Reply
    if (-not $hello.ok -or $hello.name -ne 'akif-youtube-addon-host' -or $hello.protocol -ne 1) {
      throw "unexpected answer from the host: $($cold.Reply | ConvertTo-Json -Compress -Depth 5)"
    }
    Write-Ok "hello answered in $($cold.Ms) ms (first start compiles the host)"
    $warm = Invoke-HostHello $HostBat $Origin 60
    Write-Ok "hello answered in $($warm.Ms) ms (warm start); host exited on stdin EOF: $($warm.ExitedOnEof)"
    if (-not $hello.tools.ytdlp.version) { throw "the host cannot run yt-dlp: $($hello.tools.ytdlp | ConvertTo-Json -Compress)" }
    if (-not $hello.tools.ffmpeg.version) { throw "the host cannot run ffmpeg: $($hello.tools.ffmpeg | ConvertTo-Json -Compress)" }
    $selfTest = "OK (hello in $($cold.Ms) ms cold, $($warm.Ms) ms warm)"
    Write-Ok "host sees yt-dlp $($hello.tools.ytdlp.version), FFmpeg $($hello.tools.ffmpeg.version), Deno $($hello.tools.deno.version)"
    Write-Ok "default download folder: $($hello.defaultDir)"
  }

  # ------------------------------------------------------------ summary
  Write-Host ''
  Write-Host 'Companion app installed.' -ForegroundColor Green
  Write-Host "  Folder        : $InstallDir"
  Write-Host "  Extension ID  : $ExtId"
  Write-Host "  Host name     : $HostName"
  Write-Host "  Host manifest : $ManifestPath"
  $regText = 'not registered (-NoRegister)'
  if ($registered.Count) { $regText = ($registered -join ', ') + ' (HKCU)' }
  Write-Host "  Registered for: $regText"
  Write-Host "  yt-dlp        : $($yt.Version) [$($yt.Variant)] $($yt.Path)"
  Write-Host "  FFmpeg        : $($ff.Version) $($ff.Path)"
  Write-Host "  Deno          : $DenoVersion $DenoBin"
  Write-Host "  Self-test     : $selfTest"
  if ($otherUser) { Write-Host "  Warning       : installed for $([Security.Principal.WindowsIdentity]::GetCurrent().Name), not for $otherUser" -ForegroundColor Yellow }
  foreach ($issue in $policyIssues) { Write-Host "  Blocked       : $issue" -ForegroundColor Yellow }
  Write-Host ''
  Write-Host 'Next: open the extension options -> Companion app -> "Check again".'
  exit 0
} catch {
  Write-Host ''
  Write-Host "Installation failed: $(Get-ErrorText $_)" -ForegroundColor Red
  if ($InstallDir) {
    foreach ($lf in @('logs\host-stderr.log', 'logs\host.log')) {
      $p = Join-Path $InstallDir $lf
      if (Test-Path -LiteralPath $p) {
        Write-Host "  last lines of ${lf}:"
        Get-Content -LiteralPath $p -Tail 8 -Encoding UTF8 | ForEach-Object { Write-Host "    $_" }
      }
    }
  }
  exit 1
} finally {
  if ($Work -and (Test-Path -LiteralPath $Work)) { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue }
}
