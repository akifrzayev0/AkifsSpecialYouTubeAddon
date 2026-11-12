@echo off
rem Native messaging host launcher - Akif's Special YouTube Addon companion.
rem The browser runs this file through cmd.exe with stdin/stdout bound to named pipes.
rem STDOUT IS THE BINARY MESSAGE CHANNEL. Nothing in this file may print to stdout:
rem no echo, no chcp, no pause, no unredirected command output.
rem Keep this file ASCII with CRLF line endings and WITHOUT a UTF-8 BOM (a BOM breaks echo off).
rem The deno line must end at byte 1126 of this file (see the notes below).
setlocal EnableExtensions DisableDelayedExpansion
set "DENO_NO_UPDATE_CHECK=1"
set "DENO_NO_PROMPT=1"
set "NO_COLOR=1"
set "DENO_TLS_CA_STORE=system,mozilla"
set "DENO_DIR=%~dp0.deno-cache"
set "HOST_DENO=%~dp0..\bin\deno.exe"
if not exist "%HOST_DENO%" set "HOST_DENO=deno.exe"
rem cmd.exe skips the deno line when the stderr log cannot be opened: probe it first.
set "HOST_ERRLOG=%~dp0..\logs\host-stderr.log"
(type nul >>"%HOST_ERRLOG%") 2>nul || set "HOST_ERRLOG=NUL"
"%HOST_DENO%" run --quiet --no-config --no-lock --no-prompt --no-remote --no-npm --allow-all "%~dp0host.ts" %* 2>>"%HOST_ERRLOG%" & exit /b
rem The exit /b at the end of the deno line matters: cmd.exe re-reads this file after every command,
rem so an instance still waiting for deno must end there instead of running parts of an updated host.bat.
rem The first release had no exit /b there: its instances resume at byte 1126 of the new file, so the deno
rem line must end exactly at byte 1126 (then they read only these rem lines).
rem Never put absolute, possibly non-ASCII paths here: use paths relative to this file only.
rem DENO_TLS_CA_STORE: Deno trusts the Windows certificate store too, where TLS-inspecting company
rem proxies install their root certificate.
