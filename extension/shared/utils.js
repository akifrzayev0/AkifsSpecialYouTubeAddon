/*
 * Akif's Special YouTube Addon — small, dependency-free helpers shared by every context.
 * Classic script (content scripts, extension pages, service worker via importScripts).
 */
(function (g) {
  'use strict';
  const AYT = (g.AYT = g.AYT || {});

  function currentLang() {
    return (AYT.i18n && AYT.i18n.language) || 'en';
  }

  const nfCache = new Map();
  function numberFormat(maxFrac, minFrac) {
    const key = currentLang() + '|' + maxFrac + '|' + (minFrac || 0);
    let nf = nfCache.get(key);
    if (!nf) {
      try {
        nf = new Intl.NumberFormat(currentLang(), { maximumFractionDigits: maxFrac, minimumFractionDigits: minFrac || 0 });
      } catch (_) {
        nf = new Intl.NumberFormat('en', { maximumFractionDigits: maxFrac, minimumFractionDigits: minFrac || 0 });
      }
      nfCache.set(key, nf);
    }
    return nf;
  }

  /** Cached Intl formatter for a unit ('megabyte', 'kilobyte-per-second', 'percent', ...); null when unsupported. */
  const unitCache = new Map();
  function unitFormat(unit, maxFrac, minFrac) {
    const key = currentLang() + '|' + unit + '|' + maxFrac + '|' + minFrac;
    let nf = unitCache.get(key);
    if (nf === undefined) {
      try {
        nf = new Intl.NumberFormat(
          currentLang(),
          unit === 'percent'
            ? { style: 'percent', maximumFractionDigits: maxFrac, minimumFractionDigits: minFrac }
            : { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: maxFrac, minimumFractionDigits: minFrac }
        );
      } catch (_) {
        nf = null;
      }
      unitCache.set(key, nf);
    }
    return nf;
  }

  const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
  const BYTE_SYMBOLS = ['B', 'KB', 'MB', 'GB', 'TB']; // English (and fallback) symbols

  /**
   * Byte count (or bytes per second) in the UI language: "679.3 MB", fr "679,3 Mo", ru "679,3 МБ".
   * Steps up a unit (×1024) once the number would reach 1000, so a size never reads "1,011 MB".
   * Decimals: none for B/KB, up to 1 for MB, and 2/1/0 for GB+ (2.01 GB, 25.0 GB, 150 GB).
   */
  function formatByteUnit(bytes, perSecond) {
    if (bytes == null || !isFinite(bytes) || bytes < 0) return '';
    let n = Number(bytes);
    let i = 0;
    while (i < BYTE_UNITS.length - 1 && n >= (i === 2 ? 999.95 : 999.5)) {
      n /= 1024;
      i++;
    }
    const maxFrac = i <= 1 ? 0 : i === 2 ? 1 : n < 9.995 ? 2 : n < 99.95 ? 1 : 0;
    const minFrac = i >= 3 ? maxFrac : 0;
    const symbol = BYTE_SYMBOLS[i] + (perSecond ? '/s' : '');
    const nf = unitFormat(BYTE_UNITS[i] + (perSecond ? '-per-second' : ''), maxFrac, minFrac);
    if (!nf) return numberFormat(maxFrac, minFrac).format(n) + ' ' + symbol;
    if (currentLang() !== 'en') return nf.format(n);
    // English keeps the familiar B/KB/MB/GB/TB symbols (Intl would write "kB" and "byte").
    return nf.formatToParts(n).map((p) => (p.type === 'unit' ? symbol : p.value)).join('');
  }

  /* ------------------------------------------------------------------ job labels */
  /** UI text (the dictionaries load after this file; until then the key itself). */
  function t(key, params) {
    return AYT.t ? AYT.t(key, params) : key;
  }

  const FORMAT_NAMES = {
    mp4: 'MP4', mkv: 'MKV', webm: 'WebM', // containers
    mp3: 'MP3', m4a: 'M4A', opus: 'Opus', flac: 'FLAC', wav: 'WAV', // audio
    srt: 'SRT', vtt: 'WebVTT', ttml: 'TTML', srv3: 'SRV3', json3: 'JSON3', txt: 'TXT', // subtitles
    gif: 'GIF',
  };
  const CONTAINERS = ['mp4', 'mkv', 'webm'];
  const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav'];
  const SUB_FORMATS = ['srt', 'vtt', 'ttml', 'srv3', 'json3', 'txt'];
  /** YouTube's resolution steps ("1080p"). */
  const RES_STEPS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 2880, 4320];
  const GEAR = '⚙︎'; // auto-generated subtitles (same marker as the subtitles panel)

  function capitalize(s, lang) {
    if (!s) return '';
    try {
      return s.charAt(0).toLocaleUpperCase(lang) + s.slice(1);
    } catch (_) {
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
  }

  const languageNames = new Map(); // locale -> Intl.DisplayNames | null
  /**
   * The name of language `code` in `locale`, capitalized; '' when that locale has none. Chrome's ICU has almost no
   * language names in some UI languages: in Azerbaijani it names only Azerbaijani itself (and Intl does not fall
   * back to English for a single missing name).
   */
  function nameIn(locale, code) {
    let dn = languageNames.get(locale);
    if (dn === undefined) {
      try {
        dn = new Intl.DisplayNames([locale, 'en'], { type: 'language', fallback: 'none' });
      } catch (_) {
        dn = null;
      }
      languageNames.set(locale, dn);
    }
    try {
      const name = dn && dn.of(String(code));
      if (name && name.toLowerCase() !== String(code).toLowerCase()) return capitalize(name, locale);
    } catch (_) {
      /* not a valid language tag */
    }
    return '';
  }

  function languageName(code, fallback) {
    if (!code) return fallback || '';
    return nameIn(currentLang(), code) || fallback || nameIn('en', code) || String(code);
  }

  function formatName(code) {
    const c = String(code || '').toLowerCase();
    return FORMAT_NAMES[c] || c.toUpperCase();
  }

  /** The step YouTube names a width × height format after: the one whose 16:9 frame (portrait: 9:16) it fills. */
  function resolutionStep(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (!(w > 0)) return h;
    const fill = Math.max(Math.min(w, h), (Math.max(w, h) * 9) / 16);
    let step = RES_STEPS[0];
    for (const r of RES_STEPS) if (Math.abs(r - fill) <= Math.abs(step - fill)) step = r;
    return step;
  }

  /** 75 -> '01:15'; with hours -> '1:01:15' (the clock the download panels use in labels). */
  function labelClock(sec, withHours) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return withHours || h > 0 ? h + ':' + pad(m) + ':' + pad(s % 60) : pad(m) + ':' + pad(s % 60);
  }

  function sectionLabel(section) {
    if (!section || typeof section !== 'object' || !isFinite(section.start) || !isFinite(section.end)) return '';
    const long = section.end >= 3600;
    return '✂ ' + labelClock(section.start, long) + '–' + labelClock(section.end, long);
  }

  /** `value` when it is one of `list`. */
  const oneOf = (value, list) => (typeof value === 'string' && list.includes(value.toLowerCase()) ? value.toLowerCase() : null);
  const fileExt = (p) => {
    const m = /\.([a-z0-9]{2,5})$/i.exec(String(p || ''));
    return m ? m[1] : null;
  };
  const posInt = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v) : null);

  /**
   * Parts of a job's label rebuilt from its task, or null when the task can't describe the job faithfully (the
   * stored label is used then). Fields the UI left to the settings (a container, an MP3 bitrate) are only known
   * from the finished file's extension; without them the label made when the job started is the better one.
   * The same goes for a language the UI language has no name for (Chrome in Azerbaijani): the panel wrote the
   * stored label with YouTube's own name for it, which reads better than an English name or the bare code.
   */
  function labelParts(task, job, stored) {
    const kind = task.kind || job.kind;
    const languages = kind === 'subtitle' ? [task.subLang, task.subTranslateTo] : [task.audioLang];
    if (stored && languages.some((code) => code && !nameIn(currentLang(), code))) return null;
    const playlist = task.playlist === true ? t('job.label.playlist') : '';
    const section = task.playlist === true ? '' : sectionLabel(task.section);
    const language = task.audioLang ? languageName(task.audioLang) : '';
    switch (kind) {
      case 'video': {
        if (!('height' in task)) return null; // a job restored without its task
        const container = oneOf(task.container, CONTAINERS) || oneOf(fileExt(job.filePath), CONTAINERS);
        if (!container && stored) return null;
        const height = posInt(task.height);
        const fps = posInt(task.fps);
        const quality = height ? resolutionStep(task.width, height) + 'p' + (fps > 30 ? fps : '') : t('job.label.best');
        return [container ? formatName(container) : '', quality, task.hdr === true ? 'HDR' : '', language, playlist, section];
      }
      case 'audio': {
        const format = oneOf(task.audioFormat, AUDIO_FORMATS) || oneOf(fileExt(job.filePath), AUDIO_FORMATS);
        const bitrate = format === 'mp3' ? posInt(task.bitrate) : null;
        if ((!format || (format === 'mp3' && !bitrate)) && stored) return null;
        return [format ? formatName(format) : '', bitrate ? t('job.label.kbps', { n: bitrate }) : '', language, playlist, section];
      }
      case 'subtitle': {
        if (!task.subLang) return null;
        const format = oneOf(task.subFormat, SUB_FORMATS) || oneOf(fileExt(job.filePath), SUB_FORMATS);
        if (!format && stored) return null;
        const name =
          languageName(task.subLang) + (task.subAuto === true ? ' ' + GEAR : '') + (task.subTranslateTo ? ' → ' + languageName(task.subTranslateTo) : '');
        return [format ? formatName(format) : '', name];
      }
      case 'gif':
        return [formatName('gif'), (posInt(task.gifWidth) || 480) + 'px', sectionLabel(task.section)];
      default:
        return null;
    }
  }

  /* ------------------------------------------------------------------ paths in messages */
  /**
   * An absolute Windows path: a drive ("C:") or a UNC start ("\\server"), then every "\name" or "/name" (Python's
   * repr, which yt-dlp prints, doubles the backslashes). A name may hold spaces and quotes; it ends at a newline or
   * at a quote or colon followed (after closing punctuation) by a space or the end: the end of a quoted path, or an
   * OS message after an unquoted one ("C:\x\Akif YouTube: Access is denied").
   */
  const ABS_PATH_RE = /(?:\b[A-Za-z]:|(?<![\w.\\])(?=\\\\))(?:[\\/]+(?:(?![:'"][.,;:)\]]*(?:\s|$))[^\\/\r\n])*)+/g;

  /** The path's last name, or '…' when it could be the user's own folder (C:\Users\jdoe, \\server\share\jdoe). */
  function lastName(path) {
    const parts = path
      .replace(/^[\\/]+[?.](?=[\\/])/, '') // \\?\C:\… and \\.\… prefixes aside
      .replace(/^[\\/]+UNC(?=[\\/])/i, '') // \\?\UNC\server\share\… is \\server\share\…
      .split(/[\\/]+/)
      .filter(Boolean);
    return parts.length >= 4 ? parts[parts.length - 1] : '…';
  }

  const U = {
    clamp(n, min, max) {
      return Math.min(max, Math.max(min, n));
    },

    sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    },

    uuid() {
      if (g.crypto && typeof g.crypto.randomUUID === 'function') return g.crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    },

    debounce(fn, ms) {
      let t = 0;
      return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
      };
    },

    throttle(fn, ms) {
      let last = 0;
      let timer = 0;
      let pendingArgs = null;
      return function (...args) {
        const now = Date.now();
        const wait = ms - (now - last);
        if (wait <= 0) {
          last = now;
          fn.apply(this, args);
        } else {
          pendingArgs = args;
          if (!timer) {
            timer = setTimeout(() => {
              timer = 0;
              last = Date.now();
              const a = pendingArgs;
              pendingArgs = null;
              fn.apply(this, a);
            }, wait);
          }
        }
      };
    },

    /** "3.10 GB", "0.99 GB", "679.3 MB", "12 KB" in the UI language (fr "679,3 Mo"). Returns '' for unknown sizes. */
    formatBytes(bytes) {
      return formatByteUnit(bytes, false);
    },

    /** "2.4 MB/s" in the UI language (fr "2,4 Mo/s", ru "2,4 МБ/c"). */
    formatSpeed(bytesPerSec) {
      return formatByteUnit(bytesPerSec, true);
    },

    /** Percent in the UI language, value 0..100: 42 -> "42%" (fr "42 %", tr "%42"). Rounds; pass Math.floor(p) for progress. */
    formatPercent(value) {
      if (value == null || !isFinite(value)) return '';
      const nf = unitFormat('percent', 0, 0);
      return nf ? nf.format(value / 100) : Math.round(value) + '%';
    },

    /** 75 -> "1:15", 3725 -> "1:02:05" */
    formatDuration(totalSeconds) {
      if (totalSeconds == null || !isFinite(totalSeconds) || totalSeconds < 0) return '';
      const s = Math.floor(totalSeconds);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      const pad = (x) => String(x).padStart(2, '0');
      return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
    },

    /** 615 -> "00:10:15"; with ms -> "00:10:15.250" */
    formatClock(totalSeconds, withMs) {
      if (totalSeconds == null || !isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
      const ms = Math.round(totalSeconds * 1000);
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      const rest = ms % 1000;
      const pad = (x, n) => String(x).padStart(n || 2, '0');
      return `${pad(h)}:${pad(m)}:${pad(s)}` + (withMs ? '.' + pad(rest, 3) : '');
    },

    /**
     * Parses "1:02:03", "62:03", "123", "1:02:03.5", "1h2m3s", "2m", "90s" into seconds.
     * Returns NaN when the text cannot be parsed.
     */
    parseClock(text) {
      if (typeof text === 'number') return text;
      const str = String(text || '').trim().replace(',', '.');
      if (!str) return NaN;
      const hms = /^(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/i.exec(str);
      if (hms && (hms[1] || hms[2] || hms[3])) {
        return (parseFloat(hms[1] || 0) * 3600) + (parseFloat(hms[2] || 0) * 60) + parseFloat(hms[3] || 0);
      }
      if (!/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(str)) return NaN;
      const parts = str.split(':').map(Number);
      let secs = 0;
      for (const p of parts) secs = secs * 60 + p;
      return secs;
    },

    /** ETA seconds -> "1:23" / "1:02:03" / '' */
    formatEta(seconds) {
      if (seconds == null || !isFinite(seconds) || seconds < 0) return '';
      return U.formatDuration(seconds);
    },

    /**
     * Name of a language in the UI language, capitalized to stand on its own: 'tr' -> "Turkish" (ru "Турецкий"),
     * 'pt-BR' -> "Brazilian Portuguese". When the UI language has no name for it (Chrome in Azerbaijani names only
     * Azerbaijani), `fallback` (e.g. YouTube's own name), then the English name; unknown or invalid codes give
     * `fallback`, else the code itself.
     */
    languageName,

    /** Display name of a container / audio / subtitle format: 'webm' -> "WebM", 'opus' -> "Opus", 'vtt' -> "WebVTT". */
    formatName,

    /**
     * A download job's label in the current UI language, rebuilt from job.task so it follows a language change
     * (job.label is the text the UI wrote when the job was created and stays the fallback):
     *   video     "MP4 · 2160p60 · HDR · Turkish · Playlist" / "WebM · 1080p · ✂ 01:00–02:30" / "MP4 · Best quality"
     *   audio     "MP3 · 192 kbps · Turkish · ✂ 01:00–02:30" / "FLAC · Playlist"
     *   subtitle  "SRT · English ⚙︎ → Azerbaijani" (⚙︎ = auto-generated track)
     *   gif       "GIF · 480px · ✂ 00:10–00:20"
     * Language names come from Intl.DisplayNames; the resolution is YouTube's step for the task's width × height.
     * job.label is kept when the UI language has no name for the job's language (Chrome in Azerbaijani): the panel
     * wrote it with YouTube's name. Without a job.label such a language gets its English name.
     */
    jobLabel(job) {
      const j = job && typeof job === 'object' ? job : {};
      const stored = typeof j.label === 'string' ? j.label : '';
      const task = j.task && typeof j.task === 'object' ? j.task : null;
      if (!task) return stored;
      try {
        const parts = labelParts(task, j, stored);
        return parts ? parts.filter(Boolean).join(' · ') : stored;
      } catch (_) {
        return stored;
      }
    },

    /**
     * A message with every absolute Windows path cut to its last name: the folders hold the Windows user name, and
     * page scripts can read our open shadow roots (spec §0.6). For host and yt-dlp error texts:
     *   "Permission denied: 'C:\\Users\\jdoe\\Videos\\a.mp4.part'" -> "Permission denied: 'a.mp4.part'"
     *   "mkdir 'C:\Users\jdoe'" -> "mkdir '…'" (a name that could be the user's folder is hidden too)
     * URLs and relative paths are left alone; running it again changes nothing.
     */
    hidePaths(text) {
      return String(text == null ? '' : text).replace(ABS_PATH_RE, lastName);
    },

    /** Badge for a short-side resolution: 4320 -> "8K", 2160 -> "4K", 1440 -> "2K", 1080 -> "FHD", 720 -> "HD". */
    resolutionBadge(shortSide) {
      if (shortSide >= 4320) return '8K';
      if (shortSide >= 2880) return '5K';
      if (shortSide >= 2160) return '4K';
      if (shortSide >= 1440) return '2K';
      if (shortSide >= 1080) return 'FHD';
      if (shortSide >= 720) return 'HD';
      return '';
    },

    /**
     * Makes a string safe as a Windows/macOS/Linux file name (without extension).
     * Removes reserved characters and control chars, collapses whitespace, avoids reserved device names.
     */
    sanitizeFilename(name, maxLength) {
      const max = maxLength || 150;
      let s = String(name == null ? '' : name)
        .normalize('NFC')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/[\\/:*?"<>|]/g, (c) => ({ '\\': '-', '/': '-', ':': ' -', '*': '', '?': '', '"': "'", '<': '(', '>': ')', '|': '-' })[c])
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/g, '')
        .replace(/^\.+/, '');
      if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(s)) s = '_' + s;
      if (s.length > max) {
        // cut on a code point boundary
        s = Array.from(s).slice(0, max).join('').trim().replace(/[. ]+$/g, '');
      }
      return s || 'video';
    },

    /**
     * Builds a file name (with extension) for browser-side downloads, following settings.filenameStyle.
     * info: { title, id, author, date (YYYYMMDD or ISO) }, suffix: extra text like "1280x720" or "00-10-15".
     */
    buildFilename(style, info, ext, suffix) {
      const title = info.title || info.id || 'video';
      let base;
      switch (style) {
        case 'title_id':
          base = `${title} [${info.id}]`;
          break;
        case 'channel_title':
          base = info.author ? `${info.author} - ${title}` : title;
          break;
        case 'date_title': {
          const d = String(info.date || '').replace(/\D/g, '').slice(0, 8);
          base = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${title}` : title;
          break;
        }
        default:
          base = title;
      }
      if (suffix) base += ` (${suffix})`;
      return U.sanitizeFilename(base) + (ext ? '.' + String(ext).replace(/^\./, '') : '');
    },

    /** Joins a subfolder (may be '') and a file name into a chrome.downloads relative path. */
    downloadsPath(subfolder, filename) {
      const clean = String(subfolder || '')
        .split(/[\\/]+/)
        .map((p) => U.sanitizeFilename(p, 80))
        .filter((p) => p && p !== 'video' && p !== '.' && p !== '..');
      return clean.length ? clean.join('/') + '/' + filename : filename;
    },

    /** Extracts an 11-char video id from any YouTube URL form; null if none. */
    videoIdFromUrl(url) {
      try {
        const u = new URL(url, 'https://www.youtube.com');
        const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
        let id = null;
        if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
        else if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
          if (u.pathname === '/watch') id = u.searchParams.get('v');
          else {
            const m = /^\/(?:shorts|embed|live|v|e)\/([^/?#]+)/.exec(u.pathname);
            if (m) id = m[1];
          }
        }
        return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      } catch (_) {
        return null;
      }
    },

    /** Playlist id (list=...) from a URL; null when absent or a "radio"/mix list that can be endless. */
    playlistIdFromUrl(url) {
      try {
        const id = new URL(url, 'https://www.youtube.com').searchParams.get('list');
        return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
      } catch (_) {
        return null;
      }
    },

    isMixPlaylist(listId) {
      return /^RD/.test(String(listId || ''));
    },

    watchUrl(videoId) {
      return 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
    },

    playlistUrl(listId) {
      return 'https://www.youtube.com/playlist?list=' + encodeURIComponent(listId);
    },

    /** Uint8Array -> base64 (chunked, safe for large buffers, works in service workers). */
    bytesToBase64(bytes) {
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    },

    async blobToDataUrl(blob) {
      const buf = new Uint8Array(await blob.arrayBuffer());
      return `data:${blob.type || 'application/octet-stream'};base64,${U.bytesToBase64(buf)}`;
    },

    textToDataUrl(text, mime) {
      const bytes = new TextEncoder().encode(String(text));
      return `data:${mime || 'text/plain'};charset=utf-8;base64,${U.bytesToBase64(bytes)}`;
    },

    dataUrlToBlob(dataUrl) {
      const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(dataUrl);
      if (!m) throw new Error('Invalid data URL');
      const mime = m[1] || 'application/octet-stream';
      if (m[3]) {
        const bin = atob(m[4]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
      }
      return new Blob([decodeURIComponent(m[4])], { type: mime });
    },

    /** Escapes text for safe inclusion in XML/HTML text nodes (used by subtitle converters). */
    escapeXml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
    },
  };

  AYT.util = U;
})(globalThis);
