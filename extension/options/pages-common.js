/*
 * Akif's Special YouTube Addon — helpers shared by the popup and the options page (AYT.pages).
 * Classic script, loaded by popup.html and options.html right after shared/client.js.
 * The pure helpers (validation, backup parsing, tab parsing, host status view) are unit-tested in
 * tools/tests/pages.test.mjs.
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || AYT.pages) return;
  const t = (k, p) => AYT.t(k, p);

  /** Time limits for messages to the service worker (it may be missing, asleep or busy). */
  const TIMEOUTS = Object.freeze({
    quick: 8000, // OPEN_TAB, OPEN_OPTIONS, JOBS_CLEAR, JOB_REMOVE
    jobs: 10000, // JOBS_LIST
    job: 20000, // JOB_START
    status: 30000, // HOST_STATUS (a forced check starts the companion; the worker itself gives up after 25 s)
    pickFolder: 5 * 60 * 1000 + 15000, // the folder dialog stays open up to 5 min
    // yt-dlp update: the companion stops after 9 min (update_timeout), the service worker waits 10 min; this stays above both
    updateTools: 10 * 60 * 1000 + 20000,
  });

  const HOST_STATES = Object.freeze(['unknown', 'checking', 'connected', 'missing', 'forbidden', 'error', 'outdated']);

  /** Toolbar button ids (spec §3), in toolbar order, with the icon each owner uses. */
  const TOOLBAR_BUTTONS = Object.freeze([
    { id: 'video', group: 'download', icon: 'video' },
    { id: 'audio', group: 'download', icon: 'music' },
    { id: 'thumbnail', group: 'download', icon: 'image' },
    { id: 'subtitles', group: 'download', icon: 'cc' },
    { id: 'screenshot', group: 'download', icon: 'camera' },
    { id: 'loop', group: 'tools', icon: 'loop' },
    { id: 'speed', group: 'tools', icon: 'speed' },
    { id: 'boost', group: 'tools', icon: 'boost' },
    { id: 'adjust', group: 'tools', icon: 'sliders' },
    { id: 'pip', group: 'tools', icon: 'pip' },
    { id: 'cinema', group: 'tools', icon: 'bulb' },
    { id: 'comments', group: 'tools', icon: 'comments' },
    { id: 'settings', group: 'end', icon: 'settings' },
  ]);

  /** Localized label of a toolbar button (literal keys so the i18n checker can see them). */
  function toolbarLabel(id) {
    switch (id) {
      case 'video': return t('toolbar.video');
      case 'audio': return t('toolbar.audio');
      case 'thumbnail': return t('toolbar.thumbnail');
      case 'subtitles': return t('toolbar.subtitles');
      case 'screenshot': return t('toolbar.screenshot');
      case 'loop': return t('toolbar.loop');
      case 'speed': return t('toolbar.speed');
      case 'boost': return t('toolbar.boost');
      case 'adjust': return t('toolbar.adjust');
      case 'pip': return t('toolbar.pip');
      case 'cinema': return t('toolbar.cinema');
      case 'comments': return t('pages.toolbar.comments');
      case 'settings': return t('toolbar.settings');
      default: return id;
    }
  }

  /* ------------------------------------------------------------------ messaging */

  /** Resolves/rejects like `promise`, or rejects with Error(code 'timeout', local: true) after `ms`. */
  function withTimeout(promise, ms) {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(t('pages.err.timeout'));
        e.code = 'timeout';
        e.local = true; // our own limit: the service worker did not answer
        reject(e);
      }, ms);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
  }

  /** AYT.client.send() with a timeout. Throws Error with `.code` (see AYT.client.send). */
  function request(type, payload, ms) {
    let p;
    try {
      p = AYT.client.send(type, payload);
    } catch (e) {
      p = Promise.reject(e);
    }
    return withTimeout(p, ms || TIMEOUTS.quick);
  }

  /** True when an error means the service worker could not be reached at all. */
  function isUnreachable(e) {
    const code = e && e.code;
    // AYT.client may put Chrome's own message into .detail and a friendly text into .message
    const raw = String((e && e.message) || '') + '\n' + String((e && e.detail) || '');
    return code === 'no_response' || /receiving end does not exist|could not establish connection|message (?:port|channel) closed/i.test(raw);
  }

  /** User-friendly text for an error thrown by request()/AYT.client. */
  function errorText(e) {
    if (!e) return t('error.generic', { message: '?' });
    // A 'timeout' answered by the service worker (the companion did not answer) keeps the worker's own text.
    if (e.code === 'timeout') return !e.local && e.message ? String(e.message) : t('pages.err.timeout');
    if (e.code === 'invalidated') return t('pages.err.reloaded');
    if (isUnreachable(e)) return t('pages.err.noBackground');
    const msg = String(e.message || e);
    return msg || t('error.generic', { message: '?' });
  }

  /* ------------------------------------------------------------------ companion status */

  function normalizeStatus(st) {
    if (!st || typeof st !== 'object') return { state: 'unknown' };
    const state = HOST_STATES.includes(st.state) ? st.state : 'unknown';
    return Object.assign({}, st, { state });
  }

  /**
   * Fetches the companion status through AYT.client.host.refresh (which also notifies 'host' listeners).
   * Never throws: failures become { state: 'unknown', error }.
   */
  async function fetchHostStatus(force) {
    try {
      const st = await withTimeout(AYT.client.host.refresh(!!force), TIMEOUTS.status);
      return normalizeStatus(st);
    } catch (e) {
      return { state: 'unknown', error: errorText(e), code: (e && e.code) || 'error', checkedAt: Date.now() };
    }
  }

  /**
   * Last status the service worker stored (chrome.storage.local[AYT.STORAGE.HOST_STATUS]) for an instant first
   * paint; null when there is none. A real check (fetchHostStatus) should follow.
   */
  async function cachedHostStatus() {
    try {
      const key = AYT.STORAGE.HOST_STATUS;
      const res = await withTimeout(chrome.storage.local.get(key), 2000);
      const st = res && res[key];
      if (!st || typeof st !== 'object' || !HOST_STATES.includes(st.state) || st.state === 'checking') return null;
      return normalizeStatus(st);
    } catch (_) {
      return null;
    }
  }

  /**
   * Presentation of a HostStatus: { state, tone: 'ok'|'warn'|'error'|'busy'|'neutral', icon, pill, title, text }.
   */
  function hostView(status) {
    const st = normalizeStatus(status);
    const base = { state: st.state };
    switch (st.state) {
      case 'connected':
        return Object.assign(base, { tone: 'ok', icon: 'check-circle', pill: t('pages.host.pillReady'), title: t('host.connected'), text: t('pages.host.readyText') });
      case 'checking':
        return Object.assign(base, { tone: 'busy', icon: 'refresh', pill: t('pages.host.pillChecking'), title: t('host.checking'), text: t('pages.host.checkingText') });
      case 'missing':
        return Object.assign(base, { tone: 'warn', icon: 'plug', pill: t('pages.host.pillInstall'), title: t('host.missing.title'), text: t('host.missing.text') });
      case 'outdated':
        return Object.assign(base, { tone: 'warn', icon: 'warning', pill: t('pages.host.pillUpdate'), title: t('host.outdated.title'), text: t('host.outdated.text') });
      case 'forbidden':
        // registered for another extension ID, or blocked by a browser policy: the service worker's text tells which
        return Object.assign(base, { tone: 'error', icon: 'warning', pill: t('pages.host.pillError'), title: t('pages.host.forbiddenTitle'), text: (typeof st.error === 'string' && st.error) || t('pages.host.forbiddenText') });
      case 'error':
        return Object.assign(base, { tone: 'error', icon: 'warning', pill: t('pages.host.pillError'), title: t('host.error.title'), text: (typeof st.error === 'string' && st.error) || t('host.error.text') });
      default:
        return Object.assign(base, { tone: 'neutral', icon: 'help', pill: t('pages.host.pillUnknown'), title: t('pages.host.unknownTitle'), text: t('pages.host.unknownText') });
    }
  }

  /**
   * One line about the companion for small spaces (the popup's status pill and notice): for 'forbidden' and 'error'
   * the reason the service worker found (status.error: another extension ID, an administrator policy, no answer in
   * time, could not be started), like the options page and AYT.ui.hostNotice (spec §7.2 / §9.5); otherwise the title.
   */
  function hostLine(status) {
    const view = hostView(status);
    return view.state === 'forbidden' || view.state === 'error' ? view.text : view.title;
  }

  /** Folder the companion saves into, for hints. null when unknown. */
  function effectiveFolder(settings, status) {
    const s = settings || {};
    if (s.outputDir) return String(s.outputDir);
    const st = status || {};
    const sub = String(s.subfolder || '').replace(/^[\\/]+|[\\/]+$/g, '');
    if (typeof st.downloadsDir === 'string' && st.downloadsDir) {
      const base = st.downloadsDir.replace(/[\\/]+$/, '');
      return sub ? base + '\\' + sub.replace(/\//g, '\\') : base;
    }
    if (typeof st.defaultDir === 'string' && st.defaultDir) return st.defaultDir;
    return null;
  }

  /* ------------------------------------------------------------------ language */

  function languageName(code) {
    const l = (AYT.LANGUAGES || []).find((x) => x.code === code);
    return l ? l.name : code;
  }

  /**
   * Options for the language <select>: "Auto (English)" + every UI language in its own name. Each language carries
   * its code as `lang` (screen readers pronounce "Русский" with a Russian voice); "Auto (…)" is in the UI language.
   */
  function languageOptions() {
    const auto = AYT.i18n.resolve('auto');
    return [{ value: 'auto', label: t('pages.languageAuto', { language: languageName(auto) }) }].concat(
      (AYT.LANGUAGES || []).map((l) => ({ value: l.code, label: l.name, lang: l.code }))
    );
  }

  /** Copies each option's `lang` onto the matching <option> of a select built by AYT.ui.select. */
  function applyOptionLangs(select, options) {
    if (!select || !select.options) return;
    for (const el of Array.from(select.options)) {
      const op = (options || []).find((o) => String(o.value) === el.value);
      if (op && op.lang) el.lang = op.lang;
    }
  }

  /* ------------------------------------------------------------------ re-rendering */

  function ownSelector(el) {
    if (!el || !el.tagName || !el.dataset) return null;
    for (const attr of ['setting', 'action', 'section', 'button', 'command']) {
      const v = el.dataset[attr];
      if (typeof v === 'string' && /^[\w-]{1,64}$/.test(v)) return el.tagName.toLowerCase() + '[data-' + attr + '="' + v + '"]';
    }
    return null;
  }

  /**
   * CSS selector that finds "the same" control after a re-render: controls carry data-setting / data-action / ...,
   * options of a group control (segmented buttons) carry data-value inside an element with data-setting.
   */
  function focusSelector(el) {
    const own = ownSelector(el);
    if (own || !el || !el.dataset) return own;
    const v = el.dataset.value;
    const group = el.parentElement && typeof el.parentElement.closest === 'function' ? el.parentElement.closest('[data-setting]') : null;
    const g = group ? ownSelector(group) : null;
    return g && typeof v === 'string' && /^[\w.-]{1,64}$/.test(v) ? g + ' ' + el.tagName.toLowerCase() + '[data-value="' + v + '"]' : null;
  }

  /**
   * Runs render() (which rebuilds everything inside `root`) and puts the keyboard focus and the scroll position back:
   * changing the language with the arrow keys re-renders the page on every step and must not leave focus on <body>.
   */
  function keepFocus(root, render) {
    const doc = root && root.ownerDocument;
    const active = doc && doc.activeElement;
    const sel = active && active !== doc.body && root.contains(active) ? focusSelector(active) : null;
    const scroller = doc && doc.scrollingElement;
    const top = scroller ? scroller.scrollTop : 0;
    render();
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
    if (!sel) return;
    const el = root.querySelector(sel);
    if (el && typeof el.focus === 'function') {
      try {
        el.focus({ preventScroll: true });
      } catch (_) {
        /* ignore */
      }
    }
  }

  /** Visible names of the audio formats (codec names as their projects write them). */
  const AUDIO_FORMAT_LABELS = Object.freeze({ mp3: 'MP3', m4a: 'M4A', opus: 'Opus', flac: 'FLAC', wav: 'WAV' });

  function audioFormatLabel(fmt) {
    return AUDIO_FORMAT_LABELS[fmt] || String(fmt || '').toUpperCase();
  }

  /* ------------------------------------------------------------------ settings validation */

  const ENUMS = {
    theme: ['auto', 'dark', 'light'],
    filenameStyle: ['title', 'title_id', 'channel_title', 'date_title'],
    videoContainer: ['mp4', 'mkv', 'webm'],
    videoCodec: ['auto', 'compat'],
    audioFormat: ['mp3', 'm4a', 'opus', 'flac', 'wav'],
    audioBitrate: [64, 96, 128, 160, 192, 256, 320],
    screenshotFormat: ['png', 'jpg', 'webp'],
    screenshotAction: ['save', 'copy', 'both'],
    thumbnailFormat: ['original', 'jpg', 'png', 'webp'],
    subtitleFormat: ['srt', 'vtt', 'ttml', 'srv3', 'txt'],
    autoQuality: ['off', 'max', '4320', '2160', '1440', '1080', '720', '480', '360'],
  };
  const RANGES = {
    maxConcurrent: { min: 1, max: 4, int: true },
    screenshotQuality: { min: 0.5, max: 1 },
    cinemaOpacity: { min: 0.5, max: 1 },
    boostMax: { min: 100, max: 600, int: true },
  };

  function enumFor(name) {
    if (name === 'language') return ['auto'].concat(AYT.i18n.SUPPORTED || ['en']);
    return ENUMS[name] || null;
  }

  /**
   * Longest download folder the companion accepts (MAX_OUTPUT_DIR in companion/host/lib/task.ts), so that
   * "<folder>\<title>.<ext>" stays within Windows' 260-character path limit. The service worker checks the same.
   */
  const MAX_OUTPUT_DIR = 180;
  const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;

  /**
   * Validates an absolute Windows output folder ('' = companion default) with the companion's rules
   * (normalizeAbsolutePath in companion/host/lib/paths.ts + MAX_OUTPUT_DIR); AYT.task.checkOutputDir in the service
   * worker is the same function. Returns { ok, value } (normalized) or
   * { ok:false, reason: 'absolute'|'chars'|'name'|'long' } ('name': a folder name Windows reserves or that ends in
   * a dot or a space).
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
    // collapse doubled separators, drop a trailing one (but keep "C:\")
    s = (drive ? s.slice(0, 2) + '\\' : '\\\\') + parts.join('\\');
    if (s.length > MAX_OUTPUT_DIR) return { ok: false, reason: 'long' };
    return { ok: true, value: s };
  }

  /** True for a network (UNC) folder such as \\nas\share\videos or a WebDAV \\host@SSL\DavWWWRoot\... path. */
  function isNetworkFolder(dir) {
    return typeof dir === 'string' && /^[\\/]{2}/.test(dir.trim().replace(/^"/, ''));
  }

  /** Validates the subfolder name (relative, may contain nested folders). */
  function checkSubfolder(v) {
    if (typeof v !== 'string') return { ok: false, reason: 'chars' };
    const s = v.trim();
    if (!s) return { ok: true, value: '' };
    if (s.length > 120) return { ok: false, reason: 'long' };
    if (/^[\\/]/.test(s) || /^[a-zA-Z]:/.test(s)) return { ok: false, reason: 'relative' };
    if (/[<>:"|?*\u0000-\u001f]/.test(s)) return { ok: false, reason: 'chars' };
    const parts = s.split(/[\\/]+/).map((p) => p.trim()).filter(Boolean);
    const bad = parts.some((p) => p === '.' || p === '..' || /[. ]$/.test(p) || /^\./.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(p));
    if (bad || !parts.length) return { ok: false, reason: 'chars' };
    return { ok: true, value: parts.join('\\') };
  }

  /**
   * Validates one setting value against its default's type and the documented enums/ranges.
   * Returns { ok: true, value } (value possibly normalized) or { ok: false, reason? }.
   */
  function validateSetting(name, value) {
    const defs = AYT.DEFAULT_SETTINGS;
    if (!Object.prototype.hasOwnProperty.call(defs, name)) return { ok: false, reason: 'unknown' };
    const def = defs[name];
    const list = enumFor(name);
    if (list) {
      const v = typeof list[0] === 'number' ? (typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN) : value;
      return list.includes(v) ? { ok: true, value: v } : { ok: false, reason: 'enum' };
    }
    if (RANGES[name]) {
      if (typeof value !== 'number' && typeof value !== 'string') return { ok: false, reason: 'number' };
      let n = typeof value === 'string' && !value.trim() ? NaN : Number(value);
      if (!isFinite(n)) return { ok: false, reason: 'number' };
      const r = RANGES[name];
      if (r.int) n = Math.round(n);
      return { ok: true, value: Math.min(r.max, Math.max(r.min, n)) };
    }
    switch (name) {
      case 'toolbarHidden': {
        if (!Array.isArray(value)) return { ok: false, reason: 'array' };
        const ids = value.filter((x) => typeof x === 'string' && /^[a-z0-9_-]{1,40}$/i.test(x));
        return { ok: true, value: Array.from(new Set(ids)) };
      }
      case 'outputDir': {
        const r = checkOutputDir(value);
        return r.ok ? r : { ok: false, reason: r.reason };
      }
      case 'subfolder': {
        const r = checkSubfolder(value);
        return r.ok ? r : { ok: false, reason: r.reason };
      }
      case 'subtitleLang':
        return typeof value === 'string' && (value === '' || /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,2}$/.test(value)) ? { ok: true, value } : { ok: false, reason: 'lang' };
      default:
        break;
    }
    if (typeof def === 'boolean') return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: 'boolean' };
    if (typeof def === 'number') {
      if (typeof value !== 'number' && typeof value !== 'string') return { ok: false, reason: 'number' };
      const n = typeof value === 'string' && !value.trim() ? NaN : Number(value);
      return isFinite(n) ? { ok: true, value: n } : { ok: false, reason: 'number' };
    }
    if (typeof def === 'string') return typeof value === 'string' && value.length <= 2000 ? { ok: true, value } : { ok: false, reason: 'string' };
    if (Array.isArray(def)) return Array.isArray(value) ? { ok: true, value: value.slice() } : { ok: false, reason: 'array' };
    return value === undefined ? { ok: false, reason: 'missing' } : { ok: true, value };
  }

  /** Validates and stores one setting. Throws Error(code 'invalid') for invalid values. */
  async function saveSetting(name, value) {
    const r = validateSetting(name, value);
    if (!r.ok) {
      const e = new Error(t('pages.err.invalidValue'));
      e.code = 'invalid';
      e.reason = r.reason;
      throw e;
    }
    await AYT.settings.set(name, r.value);
    return r.value;
  }

  /* ------------------------------------------------------------------ backup */

  const BACKUP_TYPE = 'akif-youtube-addon-settings';
  const BACKUP_MAX_BYTES = 512 * 1024;

  function extVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (_) {
      return AYT.VERSION;
    }
  }

  function makeBackup(settings, now) {
    return {
      type: BACKUP_TYPE,
      version: 1,
      extensionVersion: extVersion(),
      exportedAt: (now || new Date()).toISOString(),
      settings: Object.assign({}, settings),
    };
  }

  /**
   * Parses a backup file (our wrapper format or a bare settings object).
   * Returns { ok: true, settings, skipped: [keys], count } or { ok: false, error: 'json'|'format'|'empty', skipped }.
   */
  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(String(text == null ? '' : text).replace(/^\uFEFF/, ''));
    } catch (_) {
      return { ok: false, error: 'json', skipped: [] };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'format', skipped: [] };
    let src = data;
    if (data.settings !== undefined) {
      if (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) return { ok: false, error: 'format', skipped: [] };
      if (data.type !== undefined && data.type !== BACKUP_TYPE) return { ok: false, error: 'format', skipped: [] };
      src = data.settings;
    }
    const settings = {};
    const skipped = [];
    for (const [k, v] of Object.entries(src)) {
      const r = validateSetting(k, v);
      if (r.ok) settings[k] = r.value;
      else skipped.push(k);
    }
    const count = Object.keys(settings).length;
    if (!count) return { ok: false, error: 'empty', skipped };
    return { ok: true, settings, skipped, count };
  }

  /**
   * Imported values that need the user's explicit OK first (a shared "preset" file could set them silently):
   * turning on "Use my YouTube login" (the YouTube login cookies go to the companion with every download) and a
   * network (UNC / WebDAV) download folder. Returns [{ name, value }] for the values that would change.
   */
  function importRisks(current, incoming) {
    const cur = current || {};
    const inc = incoming || {};
    const out = [];
    if (inc.useCookies === true && cur.useCookies !== true) out.push({ name: 'useCookies', value: true });
    if (typeof inc.outputDir === 'string' && inc.outputDir !== cur.outputDir && isNetworkFolder(inc.outputDir)) out.push({ name: 'outputDir', value: inc.outputDir });
    return out;
  }

  function backupFilename(date) {
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `akif-youtube-addon-settings-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  }

  /* ------------------------------------------------------------------ tabs */

  /** "(3) Title - YouTube" -> "Title". Returns '' when nothing useful is left. */
  function cleanTabTitle(title) {
    let s = String(title || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/^\(\d+\+?\)\s*/, '');
    s = s.replace(/\s*[-–—|]\s*YouTube(?:\s+Music)?$/i, '');
    s = s.trim();
    return /^YouTube(?:\s+Music)?$/i.test(s) ? '' : s;
  }

  /**
   * Describes the video shown in a tab: { videoId, surface: 'watch'|'shorts', title, listId, tabId, url } or null.
   * Only youtube.com watch/live/shorts pages and youtu.be links count.
   */
  function videoFromTab(tab) {
    if (!tab || typeof tab.url !== 'string') return null;
    let u;
    try {
      u = new URL(tab.url);
    } catch (_) {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase();
    const isYouTube = host === 'youtube.com' || host.endsWith('.youtube.com');
    if (!isYouTube && host !== 'youtu.be') return null;
    let surface = null;
    if (host === 'youtu.be') surface = 'watch';
    else if (u.pathname === '/watch' || /^\/live\/[^/]+/.test(u.pathname)) surface = 'watch';
    else if (/^\/shorts\/[^/]+/.test(u.pathname)) surface = 'shorts';
    if (!surface) return null;
    const videoId = AYT.util.videoIdFromUrl(tab.url);
    if (!videoId) return null;
    const listId = AYT.util.playlistIdFromUrl(tab.url);
    return {
      videoId,
      surface,
      title: cleanTabTitle(tab.title),
      listId: listId || null,
      tabId: typeof tab.id === 'number' ? tab.id : null,
      url: tab.url,
      // the content scripts (toolbar, panels) only run on www.youtube.com
      hasToolbar: surface === 'watch' && host === 'www.youtube.com',
    };
  }

  /** "Alt+Shift+S" -> ['Alt', 'Shift', 'S'] ("Ctrl++" -> ['Ctrl', '+']). */
  function shortcutKeys(shortcut) {
    const s = String(shortcut || '').trim();
    if (!s) return [];
    const keys = [];
    let rest = s;
    for (;;) {
      const i = rest.indexOf('+', 1);
      if (i === -1) {
        keys.push(rest);
        break;
      }
      keys.push(rest.slice(0, i));
      rest = rest.slice(i + 1);
      if (!rest) break;
    }
    return keys.map((k) => k.trim()).filter(Boolean);
  }

  /* ------------------------------------------------------------------ navigation helpers */

  /** Opens the options page (at a section) through the service worker, or directly when it is unreachable. */
  async function openOptions(section) {
    const payload = section ? { section } : {};
    try {
      await request(AYT.MSG.OPEN_OPTIONS, payload, TIMEOUTS.quick);
      return true;
    } catch (e) {
      if (e && e.code === 'timeout') throw e;
      await chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html' + (section ? '#' + encodeURIComponent(section) : '')) });
      return true;
    }
  }

  function isEdge() {
    try {
      const brands = (g.navigator && g.navigator.userAgentData && g.navigator.userAgentData.brands) || [];
      return brands.some((b) => /edge/i.test(b.brand)) || /\bEdg\//.test((g.navigator && g.navigator.userAgent) || '');
    } catch (_) {
      return false;
    }
  }

  /** Opens the browser's extension shortcut settings (chrome://extensions/shortcuts, edge://… in Edge). */
  async function openShortcuts() {
    const url = 'chrome://extensions/shortcuts';
    try {
      await request(AYT.MSG.OPEN_TAB, { url }, TIMEOUTS.quick);
    } catch (e) {
      if (e && e.code === 'timeout') throw e;
      await chrome.tabs.create({ url: isEdge() ? 'edge://extensions/shortcuts' : url });
    }
    return true;
  }

  /** Percent text in the UI language (fr: "95 %", tr: "%95"). value: 0..n (1 = 100 %); see AYT.util.formatPercent. */
  function formatPercent(value) {
    return AYT.util.formatPercent(Number(value) * 100);
  }

  /**
   * The name of a language in the UI language. AYT.util.languageName falls back to the English name where Chrome has
   * none in the UI language (in Azerbaijani, Chrome names only Azerbaijani itself), so the list never shows bare codes.
   */
  function displayLanguage(code) {
    const U = AYT.util;
    if (U && typeof U.languageName === 'function') return U.languageName(code) || code;
    try {
      const dn = new Intl.DisplayNames([AYT.i18n.language, 'en'], { type: 'language' });
      return dn.of(code) || code;
    } catch (_) {
      return code;
    }
  }

  AYT.pages = {
    TIMEOUTS,
    HOST_STATES,
    TOOLBAR_BUTTONS,
    ENUMS,
    RANGES,
    BACKUP_TYPE,
    BACKUP_MAX_BYTES,
    toolbarLabel,
    withTimeout,
    request,
    isUnreachable,
    errorText,
    normalizeStatus,
    fetchHostStatus,
    cachedHostStatus,
    hostView,
    hostLine,
    effectiveFolder,
    languageName,
    languageOptions,
    applyOptionLangs,
    focusSelector,
    keepFocus,
    AUDIO_FORMAT_LABELS,
    audioFormatLabel,
    enumFor,
    MAX_OUTPUT_DIR,
    checkOutputDir,
    isNetworkFolder,
    checkSubfolder,
    validateSetting,
    saveSetting,
    extVersion,
    makeBackup,
    parseBackup,
    importRisks,
    backupFilename,
    cleanTabTitle,
    videoFromTab,
    shortcutKeys,
    openOptions,
    openShortcuts,
    formatPercent,
    displayLanguage,
  };
})(globalThis);
