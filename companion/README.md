# Companion app (Windows)

The browser extension cannot run yt-dlp or FFmpeg itself. This companion is a small
**native messaging host** (TypeScript run by Deno) that the extension starts on demand to download
videos, audio, clips/GIFs, playlists and subtitles with yt-dlp + FFmpeg.

## Install / update / remove

* **Install or update:** double-click `install.bat` (current user only, no administrator rights).
  Run it again at any time to update or repair; it updates in place.
* **Remove:** double-click `uninstall.bat` (a copy is also placed in the install folder).

What the installer does:

| | |
|---|---|
| Folder | `%LOCALAPPDATA%\AkifYouTubeAddon\` with `host\` (host.ts, host.bat, lib\), `bin\` (deno.exe; yt-dlp/FFmpeg only if downloaded), `state\`, `config.json`, `com.akif.youtube_addon.json`, `logs\host.log`, `.akif-companion-install`. The host runs with your rights, so the folder must be inside your user profile and must not be (or be inside) a link. The installer refuses a folder whose parent folders other users (Everyone, Users, …) can rename, a folder owned by another account, and an existing installation that other accounts can change; otherwise it removes the write access of other accounts from the folder (only you, SYSTEM and Administrators can change it). |
| Browsers | registers `com.akif.youtube_addon` for Chrome, Edge and Chromium under `HKCU\Software\...\NativeMessagingHosts`, and warns when a policy of your organization blocks it (`NativeMessagingUserLevelHosts` = 0, or the host on the `NativeMessagingBlocklist`) |
| Extension | allows only `chrome-extension://oicpmbpfimnoolnhfgdocfjelknjlcif/` (computed from the `key` in `extension\manifest.json`) |
| yt-dlp | reuses a working yt-dlp >= 2025.11 from PATH (WinGet / exe; a pip install only when it has `yt-dlp-ejs`, which solves YouTube's JavaScript challenges), otherwise downloads the official onedir build `yt-dlp_win.zip`, checked against the `SHA2-256SUMS` of the same release |
| FFmpeg | reuses FFmpeg from PATH when ffprobe is next to it (or on PATH) and it supports `-stats_period` and the http option `request_size` (every clip, GIF and cut needs both), otherwise downloads `yt-dlp/FFmpeg-Builds` (SHA-256 verified) |
| Deno | copies deno.exe (>= 2.0) from PATH into `bin\` (package-manager shims are resolved to the real deno.exe), otherwise downloads it: SHA-256 of the same release plus a valid Authenticode signature of Deno Land Inc. |
| Self-test | starts the host exactly like the browser does and checks that it answers `hello` |

Re-running the installer keeps working copies in `bin\`: yt-dlp and Deno are replaced only when a newer
release exists, FFmpeg (a rolling daily build) only with `-Redownload`. So a re-run downloads nothing it
already has, and it also works offline (a tool whose newest release cannot be looked up is kept). Downloads
come from the official GitHub releases, all files of one tool from the same release tag, and fail closed
when a checksum (or Deno's signature) does not match.

Options (PowerShell): `install.ps1 [-InstallDir <dir>] [-OwnYtDlp] [-OwnFfmpeg] [-OwnDeno] [-Redownload] [-NoRegister] [-SkipSelfTest] [-Force]`,
`uninstall.ps1 [-InstallDir <dir>] [-Force]`.

* `-InstallDir`: another folder, which must be inside your user profile (default `%LOCALAPPDATA%\AkifYouTubeAddon`).
* `-OwnYtDlp` / `-OwnFfmpeg` / `-OwnDeno`: use the copy in `bin\` even when PATH has the tool.
  `-Redownload`: download the tools kept in `bin\` again even when they work and are current.
* `-Force` (install): stop running host processes of this installation when files are in use, and install even
  when the installer runs as another account than the one signed in to the desktop. Without it, "Run as
  administrator" with another administrator's password is refused: it would install for that account, whose
  registry your browser never reads. `-Force` (uninstall): do not ask for confirmation.
* Not supported: a PowerShell execution policy of `AllSigned` or `Restricted` set by Group Policy, and
  PowerShell's Constrained Language Mode (set by AppLocker or Windows Defender Application Control).
  `install.bat`, `uninstall.bat` and the scripts say so instead of failing obscurely. The folder dialog in the
  extension's settings reports the same reason; the download folder can be typed in instead.

The uninstaller only touches a folder that carries the install marker `.akif-companion-install`
(or both `config.json` and the host manifest), never a folder that contains `install.ps1` (this
source folder) or a system/user folder, and it deletes only the items the installer created. It removes
only the browser registrations that point to the folder it removes, so another installation (for example
a test copy installed with `-InstallDir`) stays registered.

## How it works

* Chrome/Edge start `host.bat` through `cmd.exe` with stdin/stdout connected to named pipes; messages
  are length-prefixed UTF-8 JSON (protocol: `docs/DEVELOPER-SPEC.md` section 8). Nothing but protocol
  frames is ever written to stdout; logs go to `logs\host.log` (rotated at 2 MB).
* Temporary files of a job (`<root>` is the install folder):
  * `<output folder>\.akif-tmp\<8 hex>\` (hidden): partial files (yt-dlp `-P temp:`) on the same drive as the
    result, so finishing is a rename. Every job folder carries the marker file `.akif-job`.
  * `<root>\state\jobs\<pid>-<8 hex>\` (private: never synced or shared): with "Use my YouTube login", the
    `cookies.txt` for yt-dlp, which exists only while yt-dlp runs. Secrets never go into the output folder.
    All temp files of the job go here instead of `.akif-tmp` when the output folder is inside OneDrive,
    Dropbox, Google Drive, iCloud Drive or Box (recognised by `%OneDrive%`, Dropbox's `info.json` and the
    folder names), so the sync client only sees the finished file, and when `.akif-tmp` is a link rather
    than a plain folder.
  * Both are removed before the job reports done/error/canceled. What a killed host leaves behind is cleaned
    up later: private folders when the companion starts again (their host process is gone), `.akif-tmp`
    folders by the next job in the same output folder once they are 12 hours old (only folders with the
    `.akif-job` marker; links are never followed).
* Every child process runs in a Windows Job Object, so a cancel - or the browser closing the port, or even
  a crashed host - ends yt-dlp, Python and FFmpeg. A cancel that arrives while a job is still being set up
  stops it before anything runs.
* A transient failure (network drop, HTTP 403, a file locked by another program, FFmpeg stopping during a
  clip download) is retried once automatically and the partial files are kept, so yt-dlp continues where it
  stopped. A clip or GIF that came out without any video (YouTube sent no data for that part) is deleted and
  downloaded once more.
* Tasks are validated again in the host (URL must be `https://www.youtube.com/watch?v=<id>` or
  `.../playlist?list=<id>`, enums, ranges, absolute output folder). Nothing goes through a shell.
* `open` only launches media, subtitle and image files; `pickFolder` shows the Windows folder dialog, or says
  which policy of your organization blocks it.
* `updateTools` updates yt-dlp the way it was installed (pip, WinGet, `yt-dlp -U`, or a verified
  re-download of the onedir build: `yt-dlp_win.zip` and `SHA2-256SUMS` of the newest release, continued after
  a stalled connection). It has a 9-minute budget, is refused ("busy") while any browser window (Chrome, Edge,
  any profile) is downloading, and is finished even if the browser closes meanwhile - a half-done update would
  break yt-dlp.
* Proxies: yt-dlp, pip and WinGet use the proxy set in Windows themselves. The onedir re-download connects the
  way yt-dlp does: through `HTTPS_PROXY` when that is set (or `HTTP_PROXY` when only that one is set), with
  `NO_PROXY`, and otherwise through the proxy set in Windows (Settings > Network & internet > Proxy: a manual
  proxy server and its exceptions).
  Not supported there: an automatic configuration script (PAC/WPAD) and proxies that need your Windows sign-in;
  run `install.bat` instead, which downloads through PowerShell. `host.bat` also lets Deno trust the Windows
  certificate store (`DENO_TLS_CA_STORE=system,mozilla`), as TLS-inspecting company proxies require.

## Tests

```
deno check --no-config companion/host/host.ts
deno lint --no-config companion/host companion/tests
deno test --no-config -A companion/tests/unit_test.ts                 # no internet (temp folders, localhost, PowerShell)
python -X utf8 companion/tests/protocol_test.py [--host <host.bat>] [--out <dir>] [--only a,b]
```

`protocol_test.py` launches the installed `host.bat` exactly like Chrome (named pipes + `cmd.exe /d /s /c`,
see `tests/nmsim.py`) with `AKIF_HOST_TEST=1` (open/pickFolder/updateTools then never open windows or
change anything) and performs real downloads into `--out` (media is deleted afterwards unless `--keep`).
While developing, point `--host` at a copy instead: `<copy>\host\host.bat` next to `<copy>\config.json`
(logs then go to `<copy>\logs`). Test hooks, only together with `AKIF_HOST_TEST=1`:
`AKIF_TEST_FAIL_FIRST=1` (the first attempt of every job fails with a network error) and
`AKIF_TEST_START_DELAY_MS` (a slow output folder, so a cancel can arrive while a start waits).

## Troubleshooting

* Status "not installed" in the extension: run `install.bat`, then press "Check again".
* Status "error": look at `%LOCALAPPDATA%\AkifYouTubeAddon\logs\host.log` and `host-stderr.log`.
* Downloads fail with "Sign in to confirm ...": turn on "Use my YouTube login" in the settings (Downloads).
* Many downloads fail at once: update yt-dlp (options page, "Update yt-dlp") - YouTube changes often.
* "Update yt-dlp" fails with a network error behind a company proxy: the companion can use a manual proxy
  set in Windows or `HTTPS_PROXY` / `HTTP_PROXY`, but not a proxy configuration script or a proxy that needs your
  Windows sign-in. If the installer downloaded yt-dlp itself (`bin\`), run `install.bat` again: it updates that
  copy through PowerShell, which handles both. A yt-dlp from PATH (pip or WinGet) is never changed by the installer;
  update it with that tool (pip: `python -m pip install -U "yt-dlp[default]"`).
* The "Choose..." button for the download folder reports a PowerShell policy (`AllSigned`, `Restricted` or
  Constrained Language Mode): type the folder path into the "Download folder" field instead.
* Downloads fail with "access denied" in a protected folder (Videos, Documents, Pictures, Desktop with
  Windows Security's *Controlled folder access* on): allow the blocked app in Windows Security (the
  notification names it) or choose another download folder.
* "The file is being used by another process" (WinError 32): antivirus scanning or a cloud sync client
  holds the new file. The companion waits and retries; if it keeps happening, exclude the download folder
  from scanning/syncing or choose a folder outside OneDrive/Dropbox.
