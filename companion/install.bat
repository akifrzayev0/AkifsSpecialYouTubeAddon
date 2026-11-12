@echo off
rem Double-click installer for the companion app of Akif's Special YouTube Addon.
rem Installs for the current user only (no administrator rights needed). Safe to run again to update.
setlocal
set "AKIF_COMPANION_DIR=%~dp0"
rem "-ExecutionPolicy Bypass" only sets the process scope: an execution policy set by Group Policy wins.
rem Files extracted from a downloaded zip carry the mark of the web, which RemoteSigned refuses, so the
rem two scripts of this folder are unblocked first (you started this installer). When the policy allows
rem no unsigned scripts at all, say so instead of failing obscurely. (Policies do not apply to -Command.)
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "foreach ($f in 'install.ps1', 'uninstall.ps1') { $p = Join-Path $env:AKIF_COMPANION_DIR $f; if (Test-Path -LiteralPath $p) { Unblock-File -LiteralPath $p -ErrorAction SilentlyContinue } }; $pol = [string](Get-ExecutionPolicy); if ($pol -eq 'AllSigned' -or $pol -eq 'Restricted') { Write-Host ('A Group Policy of your organization sets the PowerShell execution policy to ' + $pol + ', which does not allow unsigned scripts such as this installer.') -ForegroundColor Red; Write-Host 'Ask your IT department to allow it, or to install the companion app for you.' -ForegroundColor Red; exit 3 }"
if "%ERRORLEVEL%"=="3" goto blocked
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "AKIF_RC=%ERRORLEVEL%"
echo.
if "%AKIF_RC%"=="0" (echo Done. You can close this window.) else (echo Installation failed - see the messages above.)
pause
exit /b %AKIF_RC%
:blocked
echo.
echo Installation failed - see the messages above.
pause
exit /b 1
