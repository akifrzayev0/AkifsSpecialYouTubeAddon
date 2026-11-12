@echo off
rem Double-click uninstaller for the companion app of Akif's Special YouTube Addon.
rem The installer also puts a copy into the installation folder. cmd.exe prints errors when the folder
rem of a running batch file is deleted, so that copy first re-runs itself from %TEMP%.
rem uninstall.ps1 decides on its own (install marker) what it may delete; this file never does.
if defined AKIF_UNINSTALL_PS1 goto run
set "AKIF_UNINSTALL_PS1=%~dp0uninstall.ps1"
set "AKIF_UNINSTALL_ARGS="
if exist "%~dp0install.ps1" goto run
if not exist "%~dp0.akif-companion-install" goto run
set "AKIF_UNINSTALL_ARGS=-InstallDir "%~dp0.""
copy /y "%~dp0uninstall.ps1" "%TEMP%\akif-yt-uninstall.ps1" >nul 2>&1 || goto run
copy /y "%~f0" "%TEMP%\akif-yt-uninstall.bat" >nul 2>&1 || goto run
set "AKIF_UNINSTALL_PS1=%TEMP%\akif-yt-uninstall.ps1"
cd /d "%TEMP%"
"%TEMP%\akif-yt-uninstall.bat" %*
:run
cd /d "%TEMP%"
rem A Group Policy execution policy wins over -ExecutionPolicy Bypass. Unblock the script (the mark of
rem the web from a downloaded zip is copied along), and explain when only signed scripts may run.
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath $env:AKIF_UNINSTALL_PS1 -ErrorAction SilentlyContinue; $pol = [string](Get-ExecutionPolicy); if ($pol -eq 'AllSigned' -or $pol -eq 'Restricted') { Write-Host ('A Group Policy of your organization sets the PowerShell execution policy to ' + $pol + ', which does not allow unsigned scripts such as this uninstaller.') -ForegroundColor Red; Write-Host 'Ask your IT department to remove the companion app for you.' -ForegroundColor Red; exit 3 }"
if not "%ERRORLEVEL%"=="3" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%AKIF_UNINSTALL_PS1%" %AKIF_UNINSTALL_ARGS% %*
echo.
pause
if /i "%~f0"=="%TEMP%\akif-yt-uninstall.bat" (goto) 2>nul & del "%TEMP%\akif-yt-uninstall.ps1" & del "%~f0"
exit /b
