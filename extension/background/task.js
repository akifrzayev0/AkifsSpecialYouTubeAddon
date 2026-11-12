/*
 * Akif's Special YouTube Addon — download task validation (owner: BACKGROUND). Pure functions.
 *
 *   AYT.task.validate(raw)                      -> normalized Task (spec §8.3) or throws { code:'bad_task' }
 *   AYT.task.validateMeta(raw, task)            -> { title, videoId, thumbnail, label }
 *   AYT.task.buildHostTask(task, settings, cookies, uiLang) -> the task sent to the companion
 *                                                  (throws { code:'bad_folder' } when settings.outputDir can't be used)
 *   AYT.task.checkOutputDir(dir)                -> { ok, value } | { ok:false, reason } (the companion's folder rules)
 *   AYT.task.cookiesToNetscape(cookies)         -> Netscape cookies.txt text for yt-dlp
 *   AYT.task.parseYouTubeUrl(url)               -> { videoId, listId } | null
 *
 * Every field coming from a UI context is untrusted: unknown fields are dropped, types/enums/ranges are checked,
 * URLs are rebuilt in canonical form (only https://www.youtube.com/watch?v=<id> or /playlist?list=<id>).
 * Settings-derived fields (outputDir, subfolder, filenameStyle, cookies) are never taken from the message.
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  const U = AYT.util;

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/;
  const CONTAINERS = ['mp4', 'mkv', 'webm'];
  const CODECS = ['auto', 'compat'];
  const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav'];
  const SUB_FORMATS = ['srt', 'vtt', 'ttml', 'srv3', 'json3', 'txt'];
  const FILENAME_STYLES = ['title', 'title_id', 'channel_title', 'date_title'];
  const MAX_SECTION_END = 7 * 24 * 3600; // a week: longer than any VOD
  const GIF_MAX_SECONDS = 60;
  /**
   * Longest download folder the companion accepts (MAX_OUTPUT_DIR in companion/host/lib/task.ts), so that
   * "<folder>\<title>.<ext>" stays within Windows' 260-character path limit. The options page uses the same value.
   */
  const MAX_OUTPUT_DIR = 180;
  const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

  function bad(field) {
    const msg = AYT.t('background.err.badTask', { field });
    const e = new Error(msg);
    e.code = 'bad_task';
    e.field = field;
    return e;
  }

  function isYouTubeHost(host) {
    return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host === 'www.youtube-nocookie.com';
  }

  /**
   * Parses an absolute YouTube URL. Returns { videoId, listId } (either may be null) or null for foreign URLs.
   * @param {string} url
   */
  function parseYouTubeUrl(url) {
    if (typeof url !== 'string' || !url || url.length > 2048) return null;
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return null;
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
    if (!isYouTubeHost(u.hostname.toLowerCase())) return null;
    return { videoId: U.videoIdFromUrl(u.href), listId: U.playlistIdFromUrl(u.href) };
  }

  function optBool(v, def, field) {
    if (v === undefined || v === null) return def;
    if (typeof v !== 'boolean') throw bad(field);
    return v;
  }

  function optEnum(v, list, def, field) {
    if (v === undefined || v === null || v === '') return def;
    if (typeof v !== 'string' || !list.includes(v)) throw bad(field);
    return v;
  }

  function optInt(v, min, max, def, field) {
    if (v === undefined || v === null || v === '') return def;
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw bad(field);
    return n;
  }

  function optLang(v, field) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > 24 || !LANG_RE.test(v)) throw bad(field);
    return v;
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  function section(v, required, maxLen) {
    if (v === undefined || v === null) {
      if (required) throw bad('section');
      return null;
    }
    if (typeof v !== 'object' || Array.isArray(v)) throw bad('section');
    const start = typeof v.start === 'number' ? v.start : NaN;
    const end = typeof v.end === 'number' ? v.end : NaN;
    if (!isFinite(start) || !isFinite(end) || start < 0 || end > MAX_SECTION_END || end - start < 0.05) throw bad('section');
    if (maxLen && end - start > maxLen + 0.5) throw bad('section');
    return { start: round3(start), end: round3(end) };
  }

  function cleanText(v, max) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  /**
   * Validates a task coming from a UI context (spec §8.3) and returns a normalized copy.
   * Fields the UI omits that have a settings default (container, codec, embeds, audio format/bitrate,
   * subtitle format) stay undefined here and are filled by buildHostTask() at dispatch time.
   * @throws Error with code 'bad_task'
   */
  function validate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('task');
    const kind = raw.kind;
    if (typeof kind !== 'string' || !AYT.JOB_KINDS.includes(kind)) throw bad('kind');

    let videoId = raw.videoId === undefined || raw.videoId === null || raw.videoId === '' ? null : raw.videoId;
    if (videoId !== null && (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId))) throw bad('videoId');
    const playlist = optBool(raw.playlist, false, 'playlist');

    let parsed = { videoId: null, listId: null };
    if (raw.url !== undefined && raw.url !== null && raw.url !== '') {
      parsed = parseYouTubeUrl(raw.url);
      if (!parsed) throw bad('url');
    }

    const task = { kind };
    if (playlist) {
      if (kind !== 'video' && kind !== 'audio') throw bad('playlist');
      if (!parsed.listId || U.isMixPlaylist(parsed.listId)) throw bad('url');
      task.videoId = videoId || parsed.videoId || null;
      task.url = U.playlistUrl(parsed.listId);
      task.playlist = true;
    } else {
      if (videoId && parsed.videoId && videoId !== parsed.videoId) throw bad('url');
      const id = videoId || parsed.videoId;
      if (!id) throw bad('videoId');
      task.videoId = id;
      task.url = U.watchUrl(id);
      task.playlist = false;
    }

    if (kind === 'video') {
      task.height = optInt(raw.height, 1, 16384, null, 'height');
      task.width = optInt(raw.width, 1, 16384, null, 'width');
      if (raw.hdr !== undefined && raw.hdr !== null && typeof raw.hdr !== 'boolean') throw bad('hdr');
      task.hdr = typeof raw.hdr === 'boolean' ? raw.hdr : null;
      task.fps = optInt(typeof raw.fps === 'number' && isFinite(raw.fps) ? Math.round(raw.fps) : raw.fps, 1, 480, null, 'fps');
      task.container = optEnum(raw.container, CONTAINERS, undefined, 'container');
      task.codec = optEnum(raw.codec, CODECS, undefined, 'codec');
      task.audioLang = optLang(raw.audioLang, 'audioLang');
      task.embedThumbnail = optBool(raw.embedThumbnail, undefined, 'embedThumbnail');
      task.embedMetadata = optBool(raw.embedMetadata, undefined, 'embedMetadata');
      task.embedChapters = optBool(raw.embedChapters, undefined, 'embedChapters');
      task.embedSubtitles = optBool(raw.embedSubtitles, undefined, 'embedSubtitles');
      task.section = section(raw.section, false, 0);
      task.preciseCut = optBool(raw.preciseCut, false, 'preciseCut');
    } else if (kind === 'audio') {
      task.audioFormat = optEnum(raw.audioFormat, AUDIO_FORMATS, undefined, 'audioFormat');
      if (raw.bitrate !== undefined && raw.bitrate !== null && raw.bitrate !== '') {
        const b = Number(raw.bitrate);
        if (!AYT.MP3_BITRATES.includes(b) || (typeof raw.bitrate !== 'number' && typeof raw.bitrate !== 'string')) throw bad('bitrate');
        task.bitrate = b;
      }
      task.audioLang = optLang(raw.audioLang, 'audioLang');
      task.embedThumbnail = optBool(raw.embedThumbnail, undefined, 'embedThumbnail');
      task.embedMetadata = optBool(raw.embedMetadata, undefined, 'embedMetadata');
      task.section = section(raw.section, false, 0);
    } else if (kind === 'subtitle') {
      task.subLang = optLang(raw.subLang, 'subLang');
      if (!task.subLang) throw bad('subLang');
      task.subAuto = optBool(raw.subAuto, false, 'subAuto');
      task.subFormat = optEnum(raw.subFormat, SUB_FORMATS, undefined, 'subFormat');
      task.subTranslateTo = optLang(raw.subTranslateTo, 'subTranslateTo');
    } else if (kind === 'gif') {
      task.section = section(raw.section, true, GIF_MAX_SECONDS);
      task.gifWidth = optInt(raw.gifWidth, 240, 1280, 480, 'gifWidth');
      task.gifFps = optInt(raw.gifFps, 5, 30, 15, 'gifFps');
    }
    // Drop undefined keys so persisted tasks stay compact and retries re-read the current settings.
    for (const k of Object.keys(task)) if (task[k] === undefined) delete task[k];
    return task;
  }

  function isThumbUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && (u.hostname === 'ytimg.com' || u.hostname.endsWith('.ytimg.com'));
    } catch (_) {
      return false;
    }
  }

  /**
   * Display-only job metadata from the UI: { title, videoId, thumbnail, label }.
   * Only https://*.ytimg.com/ thumbnails are kept (they are shown in <img> tags in our UI).
   */
  function validateMeta(raw, task) {
    const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const videoId = typeof m.videoId === 'string' && VIDEO_ID_RE.test(m.videoId) ? m.videoId : (task && task.videoId) || null;
    let thumbnail = typeof m.thumbnail === 'string' && m.thumbnail.length <= 1024 && isThumbUrl(m.thumbnail) ? m.thumbnail : null;
    if (!thumbnail && videoId) thumbnail = 'https://i.ytimg.com/vi/' + videoId + '/mqdefault.jpg';
    return {
      title: cleanText(m.title, 300),
      videoId,
      thumbnail,
      label: cleanText(m.label, 200),
    };
  }

  function pick(v, list, def) {
    return list.includes(v) ? v : def;
  }

  function bool(v, def) {
    return typeof v === 'boolean' ? v : !!def;
  }

  /**
   * Validates a download folder ('' = the companion's default folder) with the companion's rules
   * (normalizeAbsolutePath + MAX_OUTPUT_DIR in companion/host). Same rules as AYT.pages.checkOutputDir, which
   * validates the folder when it is saved; this copy catches values stored before those rules existed.
   * @returns {{ok:true, value:string}|{ok:false, reason:'absolute'|'chars'|'name'|'long'}}
   */
  function checkOutputDir(v) {
    if (typeof v !== 'string') return { ok: false, reason: 'absolute' };
    let s = v.trim().replace(/^"(.*)"$/, '$1').trim();
    if (!s) return { ok: true, value: '' };
    if (s.length > 1024) return { ok: false, reason: 'long' };
    s = s.replace(/\//g, '\\');
    const drive = /^[a-zA-Z]:\\/.test(s);
    const unc = /^\\\\[^\\]+\\[^\\]+/.test(s);
    if (!drive && !unc) return { ok: false, reason: 'absolute' };
    const rest = s.slice(2);
    if (/[<>:"|?*\u0000-\u001f\u007f]/.test(rest)) return { ok: false, reason: 'chars' };
    const parts = rest.split('\\').filter(Boolean);
    if (parts.some((p) => p === '..' || p === '.')) return { ok: false, reason: 'chars' };
    // Windows drops a trailing dot or space and reserves device names (con, aux, nul, com1...): the companion refuses them.
    const names = unc ? parts.slice(2) : parts;
    if ((unc && parts[0].startsWith('.')) || names.some((p) => /[ .]$/.test(p) || RESERVED_NAME.test(p))) return { ok: false, reason: 'name' };
    s = (drive ? s.slice(0, 2) + '\\' : '\\\\') + parts.join('\\');
    if (s.length > MAX_OUTPUT_DIR) return { ok: false, reason: 'long' };
    return { ok: true, value: s };
  }

  /**
   * The task actually sent to the host: the validated task plus settings-derived fields (spec §7.3).
   * @param {object} task validated task (AYT.task.validate)
   * @param {object} s settings snapshot (AYT.settings.all())
   * @param {string|null} cookies Netscape cookies.txt text, only when the useCookies setting is on
   * @param {string} [uiLang] current UI language (used by the host for --sub-langs "<ui-lang>.*,en.*")
   * @throws Error with code 'bad_folder' when settings.outputDir breaks the companion's folder rules (the host
   *         would refuse every job; the user has to pick another folder in Settings → Downloads)
   */
  function buildHostTask(task, s, cookies, uiLang) {
    const settings = s || {};
    const out = Object.assign({}, task);
    const dir = checkOutputDir(typeof settings.outputDir === 'string' ? settings.outputDir : '');
    if (!dir.ok) {
      const e = new Error(AYT.t('job.err.bad_folder'));
      e.code = 'bad_folder';
      e.detail = 'outputDir: ' + dir.reason;
      throw e;
    }
    out.outputDir = dir.value;
    out.subfolder = typeof settings.subfolder === 'string' ? settings.subfolder.trim().slice(0, 200) : '';
    out.filenameStyle = pick(settings.filenameStyle, FILENAME_STYLES, 'title');
    out.cookies = typeof cookies === 'string' && cookies ? cookies : null;
    out.uiLang = typeof uiLang === 'string' && LANG_RE.test(uiLang) ? uiLang : 'en';
    if (task.kind === 'video') {
      out.height = task.height == null ? null : task.height;
      out.width = task.width == null ? null : task.width;
      out.hdr = typeof task.hdr === 'boolean' ? task.hdr : null;
      out.fps = task.fps == null ? null : task.fps;
      out.container = task.container || pick(settings.videoContainer, CONTAINERS, 'mp4');
      out.codec = task.codec || pick(settings.videoCodec, CODECS, 'auto');
      out.audioLang = task.audioLang || null;
      out.embedThumbnail = bool(task.embedThumbnail, settings.embedThumbnail);
      out.embedMetadata = bool(task.embedMetadata, settings.embedMetadata);
      out.embedChapters = bool(task.embedChapters, settings.embedChapters);
      out.embedSubtitles = bool(task.embedSubtitles, settings.embedSubtitles);
      out.section = task.section || null;
      out.preciseCut = !!task.preciseCut;
    } else if (task.kind === 'audio') {
      out.audioFormat = task.audioFormat || pick(settings.audioFormat, AUDIO_FORMATS, 'mp3');
      const br = Number(settings.audioBitrate);
      out.bitrate = task.bitrate || (AYT.MP3_BITRATES.includes(br) ? br : AYT.RECOMMENDED_MP3_BITRATE);
      out.audioLang = task.audioLang || null;
      out.embedThumbnail = bool(task.embedThumbnail, settings.embedThumbnail);
      out.embedMetadata = bool(task.embedMetadata, settings.embedMetadata);
      // the Chapters setting applies to audio files too (yt-dlp would add them with the metadata otherwise)
      out.embedChapters = bool(task.embedChapters, settings.embedChapters);
      out.section = task.section || null;
    } else if (task.kind === 'subtitle') {
      out.subFormat = task.subFormat || pick(settings.subtitleFormat, SUB_FORMATS, 'srt');
      out.subAuto = !!task.subAuto;
      out.subTranslateTo = task.subTranslateTo || null;
    } else if (task.kind === 'gif') {
      out.section = task.section;
      out.gifWidth = task.gifWidth || 480;
      out.gifFps = task.gifFps || 15;
    }
    return out;
  }

  /**
   * Netscape cookies.txt (the format yt-dlp's --cookies reads) from chrome.cookies.Cookie objects.
   * HttpOnly cookies get the curl/yt-dlp '#HttpOnly_' prefix; session cookies get expiry 0.
   */
  function cookiesToNetscape(cookies) {
    const lines = ['# Netscape HTTP Cookie File', "# Written by Akif's Special YouTube Addon for yt-dlp. Do not share.", ''];
    for (const c of cookies || []) {
      if (!c || typeof c.name !== 'string' || !c.name || typeof c.domain !== 'string' || !c.domain) continue;
      const value = typeof c.value === 'string' ? c.value : '';
      const path = typeof c.path === 'string' && c.path ? c.path : '/';
      if (/[\t\r\n]/.test(c.name + value + c.domain + path)) continue;
      const hostOnly = !!c.hostOnly;
      const domain = hostOnly ? c.domain.replace(/^\./, '') : c.domain.startsWith('.') ? c.domain : '.' + c.domain;
      const expires = c.session || !c.expirationDate ? 0 : Math.max(0, Math.floor(c.expirationDate));
      lines.push([(c.httpOnly ? '#HttpOnly_' : '') + domain, hostOnly ? 'FALSE' : 'TRUE', path, c.secure ? 'TRUE' : 'FALSE', String(expires), c.name, value].join('\t'));
    }
    return lines.join('\n') + '\n';
  }

  AYT.task = {
    VIDEO_ID_RE,
    LANG_RE,
    CONTAINERS,
    CODECS,
    AUDIO_FORMATS,
    SUB_FORMATS,
    FILENAME_STYLES,
    GIF_MAX_SECONDS,
    MAX_OUTPUT_DIR,
    parseYouTubeUrl,
    validate,
    validateMeta,
    checkOutputDir,
    buildHostTask,
    cookiesToNetscape,
    isThumbUrl,
  };
})(globalThis);
