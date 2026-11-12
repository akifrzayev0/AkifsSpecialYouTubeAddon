#!/usr/bin/env node
/*
 * Unit tests for the companion installer (companion/install.ps1, install.bat, uninstall.ps1, uninstall.bat).
 *   node --test tools/tests/installer.test.mjs        (Windows only; skipped elsewhere)
 *
 * The real functions are taken out of install.ps1 with the PowerShell parser (AST) and run in ONE
 * Windows PowerShell 5.1 process against temporary folders, fake tools (.cmd files) and fake registry
 * hives - nothing is installed, downloaded or registered. The .bat files' execution-policy pre-checks
 * are run as they are written, with Get-ExecutionPolicy overridden by a function.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPANION = path.join(ROOT, 'companion');
const INSTALL_PS1 = path.join(COMPANION, 'install.ps1');
const IS_WIN = process.platform === 'win32';
const POWERSHELL = IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
const winOnly = { skip: !IS_WIN && 'Windows only' };

function runPs(args, opts = {}) {
  return spawnSync(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    ...opts,
  });
}

// ---------------------------------------------------------------------------- static checks
test('installer scripts are pure ASCII, the .bat files use CRLF, nothing has a BOM', () => {
  for (const name of ['install.ps1', 'uninstall.ps1', 'install.bat', 'uninstall.bat']) {
    const b = fs.readFileSync(path.join(COMPANION, name));
    const bad = b.findIndex((x) => x > 127);
    assert.equal(bad, -1, `${name}: non-ASCII byte at offset ${bad} (PowerShell 5.1 reads BOM-less scripts as ANSI)`);
    if (name.endsWith('.bat')) {
      const text = b.toString('latin1');
      assert.equal((text.match(/\r\n/g) || []).length, (text.match(/\n/g) || []).length, `${name}: every line must end with CRLF`);
      assert.match(text, /^@echo off\r\n/, `${name}: must start with @echo off`);
    }
  }
});

// ---------------------------------------------------------------------------- function tests (one PowerShell run)
const DRIVER = String.raw`
param([string]$InstallPs1, [string]$UninstallPs1, [string]$Work)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$CRLF = [string][char]13 + [char]10 # (no PowerShell backtick escapes in a JS template literal)
$results = [ordered]@{}
function Check([string]$Name, [scriptblock]$Body) {
  try { $d = & $Body; $results[$Name] = @{ ok = $true; detail = [string]($d -join ' ') } }
  catch { $results[$Name] = @{ ok = $false; detail = "$($_.Exception.Message) (driver line $($_.InvocationInfo.ScriptLineNumber))" } }
}
function Assert($Cond, [string]$Msg) { if (-not $Cond) { throw "assertion failed: $Msg" } }

# parse both scripts
foreach ($s in @($InstallPs1, $UninstallPs1)) {
  $tokens = $null; $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($s, [ref]$tokens, [ref]$errors)
  $results["parse $(Split-Path -Leaf $s)"] = @{ ok = ($errors.Count -eq 0); detail = (@($errors | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Message)" }) -join '; ') }
}

# load the functions and the constants of install.ps1 (not its main block)
$ast = [System.Management.Automation.Language.Parser]::ParseFile($InstallPs1, [ref]$null, [ref]$null)
foreach ($st in $ast.EndBlock.Statements) {
  if ($st -is [System.Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($st.Extent.Text)) }
  elseif ($st -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $st.Left.Extent.Text -match '^\$(HostName|PolicyBrowsers|UserSid|AnyWrite|CanRename|PyEnv|MinYtDlp)$') { . ([scriptblock]::Create($st.Extent.Text)) }
}
$Force = $false
$Redownload = $false
$InstallDir = Join-Path $Work 'no-install'
function Write-Host { } # keep the installer's progress lines out of the result

function New-TestDir([string]$Name) { $d = Join-Path $Work $Name; [void](New-Item -ItemType Directory -Force -Path $d); return $d }
function Add-Ace([string]$Dir, [string]$Sid, [string]$Rights, [string]$Prop = 'None') {
  $acl = Get-Acl -LiteralPath $Dir
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $Sid),
        [Security.AccessControl.FileSystemRights]$Rights, [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [Security.AccessControl.PropagationFlags]$Prop, [Security.AccessControl.AccessControlType]::Allow)))
  (Get-Item -LiteralPath $Dir -Force).SetAccessControl($acl)
}
function New-FakeCmd([string]$Name, [string[]]$Lines) {
  $p = Join-Path $Work $Name
  [IO.File]::WriteAllText($p, (((@('@echo off') + $Lines) -join $CRLF) + $CRLF), [Text.Encoding]::ASCII)
  return $p
}
# fake registry hive: path -> @{ valueName = value }
function New-FakeHive([hashtable]$Keys) {
  $h = New-Object psobject
  $h | Add-Member -MemberType NoteProperty -Name Keys -Value $Keys
  $h | Add-Member -MemberType ScriptMethod -Name OpenSubKey -Value {
    param($p)
    if (-not $this.Keys.ContainsKey($p)) { return $null }
    $k = New-Object psobject
    $k | Add-Member -MemberType NoteProperty -Name Vals -Value $this.Keys[$p]
    $k | Add-Member -MemberType ScriptMethod -Name GetValue -Value { param($n) if ($this.Vals.ContainsKey($n)) { $this.Vals[$n] } else { $null } }
    $k | Add-Member -MemberType ScriptMethod -Name GetValueNames -Value { @($this.Vals.Keys) }
    $k | Add-Member -MemberType ScriptMethod -Name Close -Value { }
    return $k
  }
  return $h
}
function Get-Issues([hashtable]$Machine, [hashtable]$User) {
  return @(Get-NativeMessagingPolicyIssues @(@{ Hive = (New-FakeHive $Machine); Prefix = 'SOFTWARE\Policies' }, @{ Hive = (New-FakeHive $User); Prefix = 'SOFTWARE\Policies' }))
}

Check 'profile root and path chain' {
  $la = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
  $up = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
  Assert ((Get-ProfileRoot "$la\AkifYouTubeAddon") -eq $la) 'default folder -> LOCALAPPDATA'
  Assert ((Get-ProfileRoot "$up\Apps\Akif") -eq $up -or (Get-ProfileRoot "$up\Apps\Akif") -eq $la) 'inside the profile'
  Assert ($null -eq (Get-ProfileRoot 'C:\Tools\AkifYT')) 'C:\Tools is refused'
  Assert ($null -eq (Get-ProfileRoot "$up")) 'the profile folder itself is not inside it'
  Assert ($null -eq (Get-ProfileRoot "$($up)X\Akif")) 'a sibling with the same prefix is not inside it'
  $chain = @(Get-PathChain "$la\a\b\c" $la)
  Assert (($chain -join '|') -eq "$la\a\b\c|$la\a\b|$la\a") "chain: $($chain -join '|')"
  Assert (@(Get-PathChain "$la\a" $la).Count -eq 1) 'a direct child has a one-item chain'
}

Check 'SID classes' {
  Assert (Test-TrustedSid $UserSid) 'user'
  Assert (Test-TrustedSid 'S-1-5-18') 'SYSTEM'
  Assert (Test-TrustedSid 'S-1-5-32-544') 'Administrators'
  Assert (Test-TrustedSid 'S-1-5-21-1-2-3-512') 'Domain Admins'
  Assert (-not (Test-TrustedSid 'S-1-5-11')) 'Authenticated Users is not trusted'
  Assert (-not (Test-TrustedSid 'S-1-5-21-1-2-3-1013')) 'another account is not trusted'
  Assert (Test-BroadSid 'S-1-1-0') 'Everyone is broad'
  Assert (Test-BroadSid 'S-1-5-32-545') 'Users is broad'
  Assert (Test-BroadSid 'S-1-5-21-1-2-3-513') 'Domain Users is broad'
  Assert (-not (Test-BroadSid 'S-1-5-21-1-2-3-1013')) 'a single account is not broad'
}

Check 'foreign write access is found and removed by the private ACL' {
  $d = New-TestDir 'acl'
  Add-Ace $d 'S-1-5-11' 'Modify'
  Add-Ace $d 'S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681' 'FullControl'
  Assert (@(Get-ForeignAccess $d $AnyWrite) -contains 'S-1-5-11') 'Authenticated Users: Modify is foreign write access'
  Assert (-not (@(Get-ForeignAccess $d $AnyWrite) -like 'S-1-15-*')) 'AppContainer SIDs are ignored'
  $io = New-TestDir 'acl-io'
  Add-Ace $io 'S-1-5-11' 'Modify' 'InheritOnly'
  Assert (-not (@(Get-ForeignAccess $io $CanRename -FolderOnly) -contains 'S-1-5-11')) '-FolderOnly skips inherit-only entries'
  Assert (@(Get-ForeignAccess $io $AnyWrite) -contains 'S-1-5-11') 'inherit-only entries count for the content'
  $ro = New-TestDir 'acl-ro'
  Add-Ace $ro 'S-1-5-11' 'ReadAndExecute'
  Assert (-not (@(Get-ForeignAccess $ro $AnyWrite) -contains 'S-1-5-11')) 'read access is not write access'
  Set-PrivateAcl $d
  Assert (@(Get-ForeignAccess $d $AnyWrite).Count -eq 0) "after Set-PrivateAcl: $(@(Get-ForeignAccess $d $AnyWrite) -join ',')"
  $acl = Get-Acl -LiteralPath $d
  Assert $acl.AreAccessRulesProtected 'inheritance is cut'
  $f = Join-Path $d 'child.txt'; [IO.File]::WriteAllText($f, 'x')
  Assert (@((Get-Acl -LiteralPath $f).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-11' }).Count -eq 0) 'children inherit the private ACL'
}

Check 'Protect-InstallDir' {
  $root = New-TestDir 'prot'
  Set-PrivateAcl $root # deterministic: nothing inherited from %TEMP%
  # a parent folder that Everyone can modify (and so rename) -> refused, created folders removed again
  $shared = Join-Path $root 'shared'; [void](New-Item -ItemType Directory -Path $shared)
  Add-Ace $shared 'S-1-1-0' 'Modify'
  $dir = Join-Path $shared 'a\inst'
  $created = @(Get-PathChain $dir $root | Where-Object { -not (Test-Path -LiteralPath $_) })
  [void](New-Item -ItemType Directory -Path $dir)
  $msg = ''
  try { Protect-InstallDir $dir $root $false $created } catch { $msg = $_.Exception.Message }
  Assert ($msg -match 'can rename or replace' -and $msg -match [regex]::Escape($shared)) "refusal: $msg"
  Assert (-not (Test-Path -LiteralPath (Join-Path $shared 'a'))) 'the folders this run created are removed'
  # a new folder that other accounts can write -> private ACL
  $fresh = Join-Path $root 'fresh'; [void](New-Item -ItemType Directory -Path $fresh)
  Add-Ace $fresh 'S-1-5-11' 'Modify'
  Protect-InstallDir $fresh $root $false @()
  Assert (@(Get-ForeignAccess $fresh $AnyWrite).Count -eq 0) 'new folder locked down'
  # an existing installation that other accounts can write -> refused (its files cannot be trusted)
  $old = Join-Path $root 'old'; [void](New-Item -ItemType Directory -Path $old)
  Add-Ace $old 'S-1-5-11' 'Modify'
  $msg = ''
  try { Protect-InstallDir $old $root $true @() } catch { $msg = $_.Exception.Message }
  Assert ($msg -match 'cannot be trusted') "existing install: $msg"
  Assert (@(Get-ForeignAccess $old $AnyWrite) -contains 'S-1-5-11') 'an existing installation is not silently changed'
}

Check 'browser policies' {
  $chrome = 'SOFTWARE\Policies\Google\Chrome'
  $edge = 'SOFTWARE\Policies\Microsoft\Edge'
  Assert (@(Get-Issues @{} @{}).Count -eq 0) 'no policy, no issue'
  $i = @(Get-Issues @{ $chrome = @{ NativeMessagingUserLevelHosts = 0 } } @{})
  Assert ($i.Count -eq 1 -and $i[0] -match '^Chrome:.*NativeMessagingUserLevelHosts') "machine user-level off: $i"
  Assert (@(Get-Issues @{ $chrome = @{ NativeMessagingUserLevelHosts = 1 } } @{ $chrome = @{ NativeMessagingUserLevelHosts = 0 } }).Count -eq 0) 'machine policy wins over user policy'
  $i = @(Get-Issues @{} @{ "$edge\NativeMessagingBlocklist" = @{ '1' = '*' } })
  Assert ($i.Count -eq 1 -and $i[0] -match '^Edge:.*NativeMessagingBlocklist') "user blocklist *: $i"
  Assert (@(Get-Issues @{} @{ "$edge\NativeMessagingBlocklist" = @{ '1' = '*' }; "$edge\NativeMessagingAllowlist" = @{ '1' = $HostName } }).Count -eq 0) 'the allowlist wins over the blocklist'
  $i = @(Get-Issues @{ 'SOFTWARE\Policies\Chromium\NativeMessagingBlacklist' = @{ '1' = $HostName } } @{})
  Assert ($i.Count -eq 1 -and $i[0] -match '^Chromium:') "legacy blacklist name: $i"
  Assert (@(Get-Issues @{ "$chrome\NativeMessagingBlocklist" = @{ '1' = 'com.other.host' } } @{}).Count -eq 0) 'another host on the blocklist does not matter'
}

Check 'FFmpeg feature probe' {
  $old = New-FakeCmd 'ffmpeg-old.cmd' @('echo -progress url      write program-readable progress information')
  $new = New-FakeCmd 'ffmpeg-new.cmd' @('echo -stats_period ^<time^>  set the period at which ffmpeg updates stats', 'echo   -request_size      ^<int64^>      .D......... size (in bytes) of requests to make')
  $m = @(Get-FfmpegMissingFeatures $old)
  Assert ($m.Count -eq 2 -and $m[0] -eq '-stats_period' -and $m[1] -match 'request_size') "old: $($m -join ', ')"
  $m = @(Get-FfmpegMissingFeatures $new)
  Assert ($m.Count -eq 0) "new: $($m -join ', ')"
}

Check 'pip module probe' {
  $py = New-FakeCmd 'python-fake.cmd' @('echo yt_dlp_ejs')
  $m = @(Get-MissingPyModules $py @('yt_dlp_ejs', 'curl_cffi'))
  Assert ($m.Count -eq 1 -and $m[0] -eq 'yt_dlp_ejs') "missing: $($m -join ',')"
  $bad = New-FakeCmd 'python-broken.cmd' @('exit /b 1')
  Assert (@(Get-MissingPyModules $bad @('yt_dlp_ejs')).Count -eq 0) 'a python that fails tells nothing'
}

Check 'Deno shim resolution' {
  $big = Join-Path $Work 'real-deno.exe'
  $fs = [IO.File]::Create($big); $fs.SetLength(11MB); $fs.Close()
  $small = Join-Path $Work 'small-deno.exe'
  [IO.File]::WriteAllBytes($small, (New-Object byte[] 4096))
  $shim = New-FakeCmd 'deno-shim.cmd' @("echo $big")
  Assert ((Resolve-DenoExecutable $shim $Work) -eq $big) 'Deno.execPath() of a shim names the real binary'
  $tiny = New-FakeCmd 'deno-tiny.cmd' @("echo $small")
  Assert ($null -eq (Resolve-DenoExecutable $tiny $Work)) 'a file under 10 MB is a shim, not deno.exe'
  $broken = New-FakeCmd 'deno-broken.cmd' @('exit /b 1')
  Assert ($null -eq (Resolve-DenoExecutable $broken $Work)) 'unresolvable shim'
}

Check 'checksum list and version parsing' {
  $sums = Join-Path $Work 'SUMS'
  [IO.File]::WriteAllText($sums, (('A' * 64) + '  yt-dlp_win.zip' + $CRLF + ('b' * 64) + ' *yt-dlp.exe' + $CRLF + 'not a line' + $CRLF))
  $h = Read-SumsFile $sums
  Assert ($h['yt-dlp_win.zip'] -eq ('a' * 64) -and $h['yt-dlp.exe'] -eq ('b' * 64) -and $h.Count -eq 2) 'Read-SumsFile'
  Assert ((ConvertTo-SemVer 'v2.9.8') -gt (ConvertTo-SemVer '2.8.1')) 'semver order'
  Assert ((ConvertTo-SemVer 'v2.9.8') -eq (ConvertTo-SemVer '2.9.8')) 'v prefix'
  Assert ((ConvertTo-SemVer 'garbage') -eq [version]'0.0') 'unparsable'
  Assert ((ConvertTo-YtVersion '2026.10.26') -gt (ConvertTo-YtVersion '2026.9.30')) 'yt-dlp versions are dates'
}

Check 'Install-Folder never deletes a build in place' {
  $src = New-TestDir 'onedir-src'
  [IO.File]::WriteAllText((Join-Path $src 'new.txt'), 'new')
  $dest = Join-Path $Work 'onedir'
  [void](New-Item -ItemType Directory -Force -Path (Join-Path $dest '_internal'))
  [IO.File]::WriteAllText((Join-Path $dest '_internal\lib.txt'), 'old')
  # a file in the old build is open -> nothing changes
  $fs = [IO.File]::Open((Join-Path $dest '_internal\lib.txt'), 'Open', 'Read', 'ReadWrite')
  try { $r = Install-Folder $src $dest } finally { $fs.Close() }
  Assert ($r -eq $false) 'open file: refused'
  Assert (Test-Path -LiteralPath (Join-Path $dest '_internal\lib.txt')) 'open file: old build intact'
  Assert (-not (Test-Path -LiteralPath "$dest.new")) 'open file: no .new left behind'
  # a program runs from the old build -> nothing changes (without -Force)
  Copy-Item "$env:SystemRoot\System32\PING.EXE" (Join-Path $dest 'running.exe')
  $p = Start-Process -FilePath (Join-Path $dest 'running.exe') -ArgumentList '-n', '30', '127.0.0.1' -WindowStyle Hidden -PassThru
  try {
    Start-Sleep -Milliseconds 300
    Assert (Test-InUse $dest) 'Test-InUse sees the running program'
    Assert (-not (Test-InUse $src)) 'Test-InUse: nothing runs from the source'
    Assert ((Install-Folder $src $dest) -eq $false) 'running program: refused'
    Assert (@(Get-ChildItem -LiteralPath $dest -Recurse -File).Count -eq 2) 'running program: old build intact'
  } finally { try { $p.Kill(); $p.WaitForExit(5000) } catch { } }
  # free -> swapped, old copy gone
  Assert ((Install-Folder $src $dest) -eq $true) 'free: replaced'
  Assert ((Test-Path -LiteralPath (Join-Path $dest 'new.txt')) -and -not (Test-Path -LiteralPath (Join-Path $dest '_internal'))) 'free: new content only'
  $leftovers = @(Get-ChildItem -LiteralPath $Work | Where-Object { $_.Name -like 'onedir.*' } | ForEach-Object Name) # .new / .old-*
  Assert ($leftovers.Count -eq 0) "free: no leftovers ($($leftovers -join ','))"
}

Check 'downloads fail closed and keep a working copy' {
  # fake GitHub: Get-LatestReleaseTag / Get-Download are replaced (PowerShell resolves commands at call time)
  $script:files = @{}
  $script:offline = $false
  function Get-LatestReleaseTag([string]$Repo) { if ($script:offline) { throw 'Unable to connect to the remote server' }; 'v9.9.9' }
  function Get-Download([string]$Url, [string]$OutFile, [int]$TimeoutSec = 900) {
    $name = Split-Path -Leaf $Url
    if ($script:offline -or -not $script:files.ContainsKey($name)) { throw "(404) Not Found: $name" }
    [IO.File]::WriteAllBytes($OutFile, $script:files[$name])
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipSrc = New-TestDir 'fake-deno'
  [IO.File]::WriteAllBytes((Join-Path $zipSrc 'deno.exe'), [Text.Encoding]::ASCII.GetBytes('MZ not really deno'))
  $zipPath = Join-Path $Work 'fake-deno.zip'
  [IO.Compression.ZipFile]::CreateFromDirectory($zipSrc, $zipPath)
  $zipBytes = [IO.File]::ReadAllBytes($zipPath)
  $zipHash = Get-Sha256 $zipPath
  $denoZip = 'deno-x86_64-pc-windows-msvc.zip'
  $dst = Join-Path (New-TestDir 'fake-bin') 'deno.exe'
  function Get-DenoVersion([string]$Exe) { $script:haveDeno }
  $script:haveDeno = $null
  function Expect-Throw([scriptblock]$Do, [string]$Pattern, [string]$Label) {
    $msg = ''
    try { & $Do } catch { $msg = $_.Exception.Message }
    Assert ($msg -match $Pattern) "$Label -> '$msg'"
    Assert (-not (Test-Path -LiteralPath $dst)) "$Label -> nothing may be installed"
  }
  $script:files = @{ $denoZip = $zipBytes }
  Expect-Throw { Install-OwnDeno $Work $dst } '404' 'Deno: no checksum file'
  $script:files = @{ $denoZip = $zipBytes; "$denoZip.sha256sum" = [Text.Encoding]::ASCII.GetBytes('no hash in here') }
  Expect-Throw { Install-OwnDeno $Work $dst } 'no readable checksum' 'Deno: unreadable checksum file'
  $script:files = @{ $denoZip = $zipBytes; "$denoZip.sha256sum" = [Text.Encoding]::ASCII.GetBytes(('0' * 64) + '  ' + $denoZip) }
  Expect-Throw { Install-OwnDeno $Work $dst } 'SHA-256 mismatch' 'Deno: wrong checksum'
  $script:files = @{ $denoZip = $zipBytes; "$denoZip.sha256sum" = [Text.Encoding]::ASCII.GetBytes("Algorithm Hash Path$CRLF SHA256 $($zipHash.ToUpper()) $denoZip") }
  Expect-Throw { Install-OwnDeno $Work $dst } 'valid signature of Deno Land' 'Deno: matching checksum but unsigned deno.exe'
  # with a working copy in bin\: offline, or a failed update, keeps it
  $script:haveDeno = '2.0.0'
  $script:offline = $true
  Install-OwnDeno $Work $dst
  $script:offline = $false
  $script:files = @{ $denoZip = $zipBytes }
  Install-OwnDeno $Work $dst
  $script:haveDeno = '9.9.9'
  $script:files = @{}
  Install-OwnDeno $Work $dst # up to date: nothing is downloaded (every download would throw here)
  # FFmpeg: the zip must be listed in the release's checksums
  function Get-FfmpegVersion([string]$Exe) { $null }
  $ffBin = New-TestDir 'fake-ffbin'
  $ffZip = 'ffmpeg-master-latest-win64-gpl.zip'
  $script:files = @{ 'checksums.sha256' = [Text.Encoding]::ASCII.GetBytes(('1' * 64) + '  other.zip'); $ffZip = $zipBytes }
  $msg = ''; try { [void](Install-OwnFfmpeg $Work $ffBin) } catch { $msg = $_.Exception.Message }
  Assert ($msg -match 'publishes no checksum') "FFmpeg without checksum -> '$msg'"
  $script:files = @{ 'checksums.sha256' = [Text.Encoding]::ASCII.GetBytes(('1' * 64) + '  ' + $ffZip); $ffZip = $zipBytes }
  $msg = ''; try { [void](Install-OwnFfmpeg $Work $ffBin) } catch { $msg = $_.Exception.Message }
  Assert ($msg -match 'SHA-256 mismatch') "FFmpeg wrong checksum -> '$msg'"
  Assert (@(Get-ChildItem -LiteralPath $ffBin).Count -eq 0) 'FFmpeg: nothing installed'
  # yt-dlp: a zip that does not match SHA2-256SUMS is refused
  function Get-OwnYtDlp([string]$Bin) { $null }
  $ytBin = New-TestDir 'fake-ytbin'
  $script:files = @{ 'SHA2-256SUMS' = [Text.Encoding]::ASCII.GetBytes(('2' * 64) + '  yt-dlp_win.zip'); 'yt-dlp_win.zip' = $zipBytes }
  $msg = ''; try { [void](Install-OwnYtDlp $Work $ytBin (New-TestDir 'fake-state')) } catch { $msg = $_.Exception.Message }
  Assert ($msg -match 'SHA-256 mismatch') "yt-dlp wrong checksum -> '$msg'"
  Assert (@(Get-ChildItem -LiteralPath $ytBin).Count -eq 0) 'yt-dlp: nothing installed'
}

Check 'uninstall removes only its own registrations' {
  # Remove-OwnRegistrations from uninstall.ps1 against a stand-in hive (nothing is written to the registry)
  $uast = [System.Management.Automation.Language.Parser]::ParseFile($UninstallPs1, [ref]$null, [ref]$null)
  foreach ($st in $uast.EndBlock.Statements) {
    if ($st -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $st.Name -eq 'Remove-OwnRegistrations') { . ([scriptblock]::Create($st.Extent.Text)) }
  }
  $mine = 'C:\Users\x\AppData\Local\AkifYouTubeAddon\com.akif.youtube_addon.json'
  $hive = New-FakeHive @{
    "A\$HostName" = @{ '' = $mine }
    "B\$HostName" = @{ '' = 'C:\Users\x\AppData\Local\Other\com.akif.youtube_addon.json' }
    "C\$HostName" = @{ '' = 'c:\users\x\appdata\local\akifyoutubeaddon\.\com.akif.youtube_addon.json' }
  }
  $script:deleted = @()
  $hive | Add-Member -MemberType ScriptMethod -Name DeleteSubKeyTree -Value { param($p, $throw) $script:deleted += $p }
  Remove-OwnRegistrations $hive @(@{ Key = 'A' }, @{ Key = 'B' }, @{ Key = 'C' }, @{ Key = 'D' }) $mine
  Assert (($script:deleted -join '|') -eq "A\$HostName|C\$HostName") "deleted: $($script:deleted -join '|')"
}

Write-Output ('@@RESULT@@' + ($results | ConvertTo-Json -Depth 4 -Compress))
`;

let results = null;
let driverError = null;
if (IS_WIN) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'akif-installer-test-'));
  const script = path.join(work, 'driver.ps1');
  fs.writeFileSync(script, DRIVER, 'utf8');
  try {
    const r = runPs(['-File', script, '-InstallPs1', INSTALL_PS1, '-UninstallPs1', path.join(COMPANION, 'uninstall.ps1'), '-Work', path.join(work, 't')]);
    const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('@@RESULT@@'));
    if (line) results = JSON.parse(line.slice('@@RESULT@@'.length));
    else driverError = `driver failed (exit ${r.status}): ${r.stderr || r.stdout || r.error}`;
  } finally {
    // the driver made some folders private; they are still ours, so this works
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const CHECKS = [
  'parse install.ps1',
  'parse uninstall.ps1',
  'profile root and path chain',
  'SID classes',
  'foreign write access is found and removed by the private ACL',
  'Protect-InstallDir',
  'browser policies',
  'FFmpeg feature probe',
  'pip module probe',
  'Deno shim resolution',
  'checksum list and version parsing',
  'Install-Folder never deletes a build in place',
  'downloads fail closed and keep a working copy',
  'uninstall removes only its own registrations',
];
for (const name of CHECKS) {
  test(`install.ps1: ${name}`, winOnly, () => {
    assert.equal(driverError, null, driverError || '');
    const r = results[name];
    assert.ok(r, `check "${name}" did not run`);
    assert.ok(r.ok, r.detail);
  });
}

// ---------------------------------------------------------------------------- .bat execution-policy pre-checks
function batSnippet(file) {
  const text = fs.readFileSync(path.join(COMPANION, file), 'latin1');
  const m = /-Command "([^"]+)"/.exec(text);
  assert.ok(m, `${file} has no -Command pre-check`);
  return m[1];
}

function markedCopy(dir, name) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "'x'\r\n");
  fs.writeFileSync(`${p}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
  assert.ok(fs.existsSync(`${p}:Zone.Identifier`), 'test setup: alternate data stream');
  return p;
}

for (const [bat, envName, target] of [
  ['install.bat', 'AKIF_COMPANION_DIR', 'dir'],
  ['uninstall.bat', 'AKIF_UNINSTALL_PS1', 'file'],
]) {
  test(`${bat}: unblocks its script and runs it when the policy allows`, winOnly, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akif-bat-test-'));
    try {
      const ps1 = markedCopy(dir, bat === 'install.bat' ? 'install.ps1' : 'uninstall.ps1');
      const env = { ...process.env, [envName]: target === 'dir' ? dir + path.sep : ps1 };
      const r = runPs(['-Command', batSnippet(bat)], { env });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(!fs.existsSync(`${ps1}:Zone.Identifier`), 'the mark of the web is removed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  test(`${bat}: explains a Group Policy that allows only signed scripts`, winOnly, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akif-bat-test-'));
    try {
      const ps1 = markedCopy(dir, 'x.ps1');
      const env = { ...process.env, [envName]: target === 'dir' ? dir + path.sep : ps1 };
      for (const policy of ['AllSigned', 'Restricted']) {
        const r = runPs(['-Command', `function Get-ExecutionPolicy { '${policy}' }; ${batSnippet(bat)}`], { env });
        assert.equal(r.status, 3, `${policy}: ${r.stdout}${r.stderr}`);
        assert.match(r.stdout, new RegExp(`execution policy to ${policy}`));
      }
      for (const policy of ['RemoteSigned', 'Unrestricted', 'Bypass']) {
        const r = runPs(['-Command', `function Get-ExecutionPolicy { '${policy}' }; ${batSnippet(bat)}`], { env });
        assert.equal(r.status, 0, `${policy}: ${r.stdout}${r.stderr}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
