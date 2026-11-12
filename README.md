# Akif's Special YouTube Addon

A browser extension for Chrome, Edge and other Chromium browsers that adds a toolbar under every YouTube video:

| | Feature |
|---|---|
| 🎬 | **Download video** in any available quality, up to **8K / HDR / 60 fps** (MP4, MKV or WebM), including dubbed audio tracks, short clips, GIFs and whole playlists |
| 🎵 | **Download audio** as MP3 (64–320 kbps, 192 kbps recommended), M4A, Opus, FLAC or WAV, with an optional time range, cover art and tags |
| 💬 | **Download subtitles** in SRT, WebVTT, TTML, SRV3 or plain text, including auto-generated and machine-translated subtitles |
| 📷 | **Screenshot** of the current frame at the video's full resolution (PNG, JPG or WebP, save and/or copy) |
| 🖼️ | **Download the thumbnail** in any available size (up to 1280×720, plus the original aspect-ratio image) as JPG, PNG or WebP |
| 🙈 | **Hide comments** with one click |
| 🔁 | Loop the video or an **A-B section** |
| ⏩ | **Playback speed** from 0.1× to 16× (remembers your speed if you want) |
| 🔊 | **Volume boost** up to 400 % (adjustable up to 600 % in settings) |
| 🎚️ | **Video adjustments**: brightness, contrast, saturation, zoom, rotate and mirror |
| 🖥️ | **Picture-in-picture** and **cinema mode** (dims everything except the player) |
| 🧹 | **Clean up YouTube**: hide Shorts, related videos, end-screen cards and live chat |
| ⚙️ | **Auto quality**: always start videos at your preferred quality |
| 📱 | A **download button on Shorts** |
| 🌍 | 7 languages: English (the default), Azərbaycanca, Türkçe, Русский, Français, Deutsch, Español. Choose one in Settings → General → Language; **Auto** follows your browser's preferred languages |

Video and audio downloads use a small free **companion app** for Windows (yt-dlp + FFmpeg, run by Deno). Screenshots, thumbnails, subtitles and all the player tools work without it.

---

## Installation

### 1. Add the extension to the browser

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode** (top right). Keep it on: since Chrome 134, unpacked extensions are switched off when Developer mode is off.
3. Click **Load unpacked** and select the **`extension`** folder inside this project.
4. Optional: pin the extension (puzzle icon → pin) to reach the popup quickly.

> The extension cannot be published on the Chrome Web Store, because the store does not allow YouTube downloaders. That is why it is loaded as an unpacked extension.

### 2. Install the companion app (for video/audio downloads)

1. Open the **`companion`** folder.
2. Double-click **`install.bat`** (not "Run as administrator"). It needs no administrator rights and takes about a minute. It reuses yt-dlp, FFmpeg and Deno when suitable versions are already installed, and downloads the others from their official GitHub releases, checking their SHA-256 checksums (and Deno's digital signature).
3. The extension's settings page opened by itself after step 1 (later: click the extension's icon → **Settings**, or ⚙️ at the end of the toolbar under a video). In **Companion app**, press **Check again**. It should show **Companion connected**.

Run `install.bat` again at any time to repair or update. It keeps the tools it already has and downloads yt-dlp or Deno only when a newer version exists, so it also works offline. To remove the companion, run `uninstall.bat`.

---

## Using it

Open any YouTube video. The toolbar appears directly under the player, above the title:

`[logo] 🎬 Video · 🎵 Audio · 🖼️ Thumbnail · CC Subtitles · 📷 Screenshot | 🔁 Loop · ⏩ Speed · 🔊 Boost · 🎚️ Adjust · ⧉ PiP · 💡 Cinema · 💬 Comments | ⚙️ Settings`

* **Video**: pick a row (for example `MP4 · 2160p60 · 4K HDR 60FPS · 1.4 GB`) and the download starts. Use **Clip** to download only part of the video or to save it as a GIF. Use the audio-language menu for dubbed videos.
* **Audio**: choose the format and bitrate, optionally drag the time range, then press **Download**.
* **Subtitles**: choose the language (⚙︎ marks auto-generated ones), optionally a translation, and the format.
* **Screenshot**: one click saves the current frame. Shift+click copies it to the clipboard.
* Downloads show live progress in the panel and in the extension popup, where you can also open the file or its folder. If some videos of a playlist could not be downloaded, the list says how many and offers **Retry**.

Files are saved to `Downloads\Akif YouTube`. Video and audio can go to another folder: set **Download folder** in **Settings → Downloads** (a folder path can be up to 180 characters long, so that file names still fit within Windows' path limit). Screenshots, thumbnails and subtitles are saved by the browser into its own download folder, in the **Subfolder** set there.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Alt+Shift+S | Screenshot |
| Alt+Shift+D | Open the download panel |
| Alt+Shift+L | Loop on/off |
| Alt+Shift+M | Cinema mode on/off |

You can change these, and add shortcuts for PiP, comments and speed, at `chrome://extensions/shortcuts`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Companion app not installed" after installing | Close all browser windows, open the browser again, press **Check again**. |
| Every download suddenly fails | YouTube changed something. Press **Update yt-dlp** in Settings → Companion app. |
| "Sign in to confirm you're not a bot" / age-restricted / members-only | Sign in to YouTube in this browser, then turn on **Use my YouTube login** in Settings → Downloads. |
| The toolbar doesn't appear | Reload the YouTube tab (tabs opened before the extension was loaded or updated need a reload). |
| Moved the project folder, or use another browser | Load the **`extension`** folder again in that browser (**Load unpacked**, see above). The companion app does not depend on the project folder; if the extension still says it is not installed, run `companion\install.bat` again. |
| Downloads fail with "Windows blocked access" | Windows Security's **Controlled folder access** (or an antivirus) blocks the companion app in protected folders such as Videos or Documents. Allow the app in Windows Security, or choose another download folder. |
| **Update yt-dlp** fails behind a company proxy | The companion uses the proxy set in Windows (a manual proxy server) or `HTTPS_PROXY` / `HTTP_PROXY`, but not a proxy script (PAC) or a proxy that needs your Windows sign-in. If the installer downloaded yt-dlp itself, run `install.bat` again: it updates that copy through PowerShell, which handles both. A yt-dlp installed with pip or WinGet is updated with that tool (pip: `python -m pip install -U "yt-dlp[default]"`). |
| The installer, or **Choose…** for the download folder, says a policy of your organization blocks it | PowerShell policies `AllSigned`, `Restricted` and Constrained Language Mode are not supported. Type the folder path into **Download folder**, and ask your IT department to install the companion app. |

The companion's logs are in `%LOCALAPPDATA%\AkifYouTubeAddon\logs\`.

---

## Privacy and fair use

* No tracking or analytics, and no servers of our own. The extension only talks to YouTube and to the companion app on your computer. Settings and download history stay in your browser.
* **Use my YouTube login** (off by default) hands your YouTube cookies to the companion app for each download. It keeps them in a private file in its own folder (`%LOCALAPPDATA%\AkifYouTubeAddon\state\jobs`, never in your download folder) only while the download runs, and sends them nowhere except to YouTube.
* Download only what you have the right to download, for personal use. Respect creators' copyright and YouTube's Terms of Service. This project is not affiliated with YouTube or Google.

---

## For developers

* Architecture and module contracts: [`docs/DEVELOPER-SPEC.md`](docs/DEVELOPER-SPEC.md). Companion details: [`companion/README.md`](companion/README.md).
* Static checks: `node tools/check.mjs` (use `--strict` before a release: it also requires complete translations without stale keys).
* Unit tests: `node --test "tools/tests/*.test.mjs"` (the directory form `node --test tools/tests/` fails on Node 23) and `cd companion && deno test -A --no-config tests/unit_test.ts`.
* End-to-end tests on real YouTube (headless Chrome): `npm install --prefix tools/e2e` (once), then, from the project folder, `node tools/e2e/<module>.e2e.mjs`.
* Translations: English source strings live in `i18n/parts/en.*.json`, translations in `i18n/<lang>.json`; run `node tools/build-i18n.mjs` to rebuild `extension/shared/i18n/*.js` and the shortcut names in `extension/_locales`.

Built with [yt-dlp](https://github.com/yt-dlp/yt-dlp), [FFmpeg](https://ffmpeg.org) and [Deno](https://deno.com).

---

## Azərbaycanca qısa bələdçi

**Quraşdırma**

1. Chrome-da `chrome://extensions` səhifəsini açın və sağ yuxarıdakı **Developer mode** (tərtibatçı rejimi) açarını aktiv edin. Onu həmişə açıq saxlayın, yoxsa Chrome əlavəni söndürür.
2. **Load unpacked** düyməsini basın və bu layihənin içindəki **`extension`** qovluğunu seçin.
3. Video və audio endirmək üçün **`companion`** qovluğundakı **`install.bat`** faylına iki dəfə klikləyin (administrator kimi işə salmayın). Quraşdırma təxminən bir dəqiqə çəkir.
4. 2-ci addımdan sonra əlavənin ayarlar səhifəsi özü açılır (sonra: əlavənin ikonasına klikləyib **Settings / Ayarlar**, və ya videonun altındakı alətlər panelinin sonundakı ⚙️). **Companion app / Köməkçi proqram** bölməsində **Check again / Yenidən yoxlayın** düyməsini basın. **Companion connected / Köməkçi proqram qoşulub** yazısı görünməlidir.

**İstifadə**

YouTube-da istənilən videonu açın. Alətlər paneli videonun altında, başlığın üstündə görünür. Onunla bunları edə bilərsiniz:

* videonu endirmək (8K/HDR-ə qədər)
* audionu MP3 və ya başqa formatda endirmək
* subtitrləri endirmək
* ekran şəkli çəkmək
* miniatürü endirmək
* şərhləri gizlətmək
* təkrar, oxutma sürəti, səs gücləndirmə, kino rejimi və s.

Fayllar `Downloads\Akif YouTube` qovluğunda saxlanılır. Video və audio üçün başqa qovluğu **Ayarlar → Endirmələr** bölməsində seçə bilərsiniz.

Əlavə ingiliscə açılır. Dilini **Settings → General → Language** (Ayarlar → Ümumi → Dil) bölməsində **Azərbaycanca** seçə bilərsiniz. **Avtomatik** seçsəniz, brauzerin dil siyahısı əsas götürülür (Chrome: Settings → Languages): Azərbaycan dili siyahının ən yuxarısındadırsa, əlavə Azərbaycanca açılacaq.
