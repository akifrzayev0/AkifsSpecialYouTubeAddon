/*
 * Akif's Special YouTube Addon — DOWNLOADS module, part 1: the video panel + shared download helpers.
 *
 * Toolbar button 'video' (group download, order 10, surfaces watch + shorts). The panel lists one row per
 * distinct (resolution, high frame rate, HDR) group of the video's formats, best first, with the estimated size
 * of the file the companion app will produce (same codec preference as the host, DEVELOPER-SPEC §8.4).
 * Clicking a row starts a companion job. Extras: container switch (MP4/MKV/WebM), audio language for dubbed
 * videos, clip mode (range editor, precise cut, GIF), whole-playlist mode, live job list, save-folder footer.
 *
 * AYT.dl — helpers shared with audio.js (loaded right after this file). The pure part is unit-tested in
 * tools/tests/downloads.test.mjs against real player responses:
 *   codecOrder(container, codec)            host codec preference, e.g. ['av1','h264','vp9'] for mp4 + auto
 *   containerAccepts(container, vcodec)     can the output container hold this video codec?
 *   audioCodecFor(container, codec)         'aac' | 'opus' (audio the host picks for a video job)
 *   pickAudio(info, {codec, trackId, lang}) best matching audio format (non-DRC, highest bitrate)
 *   buildVideoOptions(info, {container, codec, trackId, audioLang}) -> rows (see buildVideoOptions)
 *   trackOptions(info)                      audio-language select options (original first)
 *   normalizeSection(duration, start, end)  {start,end} | null (null = whole video / invalid)
 *   sectionLabel(section, duration)         '✂ 01:00–02:30'
 *   scaleSize(size, section, duration)      size of a clip
 *   videoTask / videoMeta / gifTask / audioTask / audioLabel / estimateAudio / thumbUrl
 *   formatSize(bytes, approx)               '2.01 GB' / '~4.3 MB' (AYT.util.formatBytes, '~' when approximate)
 *   folderPath(status) / folderLabel(status) full save folder (never put in the DOM) / what the footer shows: the
 *                                           folder's own name ('YouTube saves', 'Downloads › Akif YouTube')
 * UI pieces: rangeEditor(opts), hostController(onChange), folderFooter(getStatus), fitPanel(el, ctx, state),
 *            needCompanion(status, kind, pulseEl), withTimeout(promise, ms), startJob(task, meta, opts),
 *            scrollBehavior() ('instant' under prefers-reduced-motion, else 'smooth'),
 *            focusUntouched(el) (keyboard opens: focus still on the panel container, so it may move to a control),
 *            openFromCommand(id, {viaKeyboard}) ('open-download'; viaKeyboard false = the popup link was clicked)
 * Our shadow roots are open, so page scripts can read their text: the panels never show the absolute save path
 * (it contains the Windows user name), and privileged handlers ignore script-made events (AYT.keys.trusted).
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || AYT.dl) return;
  const U = AYT.util;
  const t = (k, p) => AYT.t(k, p);

  /* =================================================================== constants */
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const LIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
  const CONTAINERS = ['mp4', 'mkv', 'webm'];
  const CONTAINER_LABEL = { mp4: 'MP4', mkv: 'MKV', webm: 'WebM' };
  const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav'];
  const AUDIO_LABEL = { mp3: 'MP3', m4a: 'M4A', opus: 'Opus', flac: 'FLAC', wav: 'WAV' };
  const CODEC_LABEL = { h264: 'H.264', vp9: 'VP9', av1: 'AV1', hevc: 'HEVC', aac: 'AAC', opus: 'Opus' };
  const GIF_MAX_SECONDS = 60;
  const GIF_WIDTH = 480;
  const GIF_FPS = 15;
  const MIN_SECTION = 1; // seconds
  const COVER_BYTES = 150 * 1024; // embedded cover art (1280x720 JPEG), added to audio estimates
  const START_TIMEOUT = 20000;
  const BAD_HOST = ['missing', 'forbidden', 'error', 'outdated'];

  /** Host codec preference (DEVELOPER-SPEC §8.4); the estimate must follow it so the size shown ≈ the file. */
  const CODEC_ORDER = {
    'mp4:auto': ['av1', 'h264', 'vp9'],
    'mp4:compat': ['h264', 'av1', 'vp9'],
    'webm:auto': ['vp9', 'av1'],
    'webm:compat': ['vp9', 'av1'],
    'mkv:auto': ['av1', 'vp9', 'h264'],
    'mkv:compat': ['h264', 'av1', 'vp9'],
  };
  /** Video codecs each output container can hold (null = anything). WebM is VP9/AV1 only. */
  const CONTAINER_CODECS = { mp4: ['h264', 'av1', 'vp9', 'hevc'], webm: ['vp9', 'av1'], mkv: null };

  /* =================================================================== pure helpers */
  const normContainer = (c) => (CONTAINERS.includes(c) ? c : 'mp4');
  const normCodec = (c) => (c === 'compat' ? 'compat' : 'auto');
  const normAudioFormat = (f) => (AUDIO_FORMATS.includes(f) ? f : 'mp3');
  const isNum = (n) => typeof n === 'number' && isFinite(n);
  const round3 = (n) => Math.round(n * 1000) / 1000;

  function normBitrate(b) {
    const n = Number(b);
    return AYT.MP3_BITRATES.includes(n) ? n : AYT.RECOMMENDED_MP3_BITRATE;
  }

  /** @returns {string[]} video codecs in the order the host tries them. */
  function codecOrder(container, codec) {
    return CODEC_ORDER[normContainer(container) + ':' + normCodec(codec)].slice();
  }

  function containerAccepts(container, vcodec) {
    const list = CONTAINER_CODECS[normContainer(container)];
    return !list || list.includes(vcodec);
  }

  /** Audio codec of a video job: mp4, or mkv with "most compatible", get AAC (m4a); webm / mkv+auto get Opus. */
  function audioCodecFor(container, codec) {
    const c = normContainer(container);
    return c === 'mp4' || (c === 'mkv' && normCodec(codec) === 'compat') ? 'aac' : 'opus';
  }

  /**
   * Audio format the host will most likely pick (yt-dlp `ba[...]`): matching track, then codec, non-DRC first,
   * highest bitrate. opts: { codec: 'aac'|'opus'|null, trackId, lang }. No track/lang = the original track.
   */
  function pickAudio(info, opts) {
    const o = opts || {};
    const list = ((info && info.audioFormats) || []).filter((a) => a && ((a.size > 0) || (a.bitrate > 0)));
    if (!list.length) return null;
    let pool = [];
    if (o.trackId) pool = list.filter((a) => a.trackId === o.trackId);
    if (!pool.length && o.lang) pool = list.filter((a) => a.lang && (a.lang === o.lang || a.lang.indexOf(o.lang + '-') === 0));
    if (!pool.length) pool = list.filter((a) => a.isOriginal);
    if (!pool.length) pool = list.filter((a) => a.isDefault);
    if (!pool.length) pool = list;
    const byCodec = o.codec ? pool.filter((a) => a.codec === o.codec) : [];
    const cands = byCodec.length ? byCodec : pool;
    return cands.slice().sort((a, b) => Number(!!a.isDrc) - Number(!!b.isDrc) || (b.bitrate || 0) - (a.bitrate || 0) || (b.size || 0) - (a.size || 0))[0] || null;
  }

  function qualityLabel(res, fps) {
    return res + 'p' + (fps > 30 ? fps : '');
  }

  /**
   * Fallback row when the page lists no video formats at all (the companion can still find them):
   * height/hdr/fps null = "best available" for the host.
   */
  function bestOption(container) {
    return {
      key: 'best',
      res: 0,
      width: null,
      height: null,
      fps: null,
      highFps: false,
      hdr: null,
      codec: null,
      itag: null,
      muxed: false,
      container: normContainer(container),
      videoSize: null,
      audioSize: null,
      size: null,
      sizeApprox: true,
      audio: null,
      best: true,
      label: t('video.bestAvailable'),
      badges: [],
    };
  }

  /** Badges of a row: resolution class (accent for ≥ 4K), HDR, high frame rate. */
  function badgesFor(res, fps, hdr) {
    const out = [];
    const rb = U.resolutionBadge(res);
    if (rb) out.push({ text: rb, variant: res >= 2160 ? 'accent' : null });
    if (hdr) out.push({ text: 'HDR', variant: 'hdr' });
    if (fps > 30) out.push({ text: fps + 'FPS', variant: null });
    return out;
  }

  /**
   * Rows of the video panel: one per distinct (res, fps > 30, hdr) group, best first.
   * The representative format of a group is the one the host picks: first codec of codecOrder() that the
   * container can hold, then the biggest stream. size = video + audio (bytes), sizeApprox when any part is
   * estimated. Groups the container cannot hold at all (H.264-only in WebM) are left out.
   * @returns {Array<{key,res,width,height,fps,highFps,hdr,codec,itag,muxed,container,videoSize,audioSize,size,
   *                  sizeApprox,audio,label,badges}>}
   */
  function buildVideoOptions(info, opts) {
    const o = opts || {};
    const container = normContainer(o.container);
    const codec = normCodec(o.codec);
    const order = codecOrder(container, codec);
    const rank = (c) => {
      const i = order.indexOf(c);
      return i >= 0 ? i : order.length + (c === 'hevc' ? 0 : 1);
    };
    const audio = pickAudio(info, { codec: audioCodecFor(container, codec), trackId: o.trackId, lang: o.audioLang });
    const groups = new Map();
    for (const f of (info && info.videoFormats) || []) {
      if (!f || !(f.res > 0) || !(f.height > 0) || !(f.width > 0)) continue;
      const key = f.res + '|' + (f.fps > 30 ? 1 : 0) + '|' + (f.hdr ? 1 : 0);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    const out = [];
    for (const [key, list] of groups) {
      const adaptive = list.filter((f) => !f.muxed);
      const pool = (adaptive.length ? adaptive : list).filter((f) => containerAccepts(container, f.codec));
      if (!pool.length) continue;
      pool.sort((a, b) => rank(a.codec) - rank(b.codec) || (b.size || 0) - (a.size || 0) || (b.bitrate || 0) - (a.bitrate || 0));
      const rep = pool[0];
      const fps = rep.fps || 30;
      const videoSize = rep.size > 0 ? rep.size : null;
      const audioSize = rep.muxed ? 0 : audio && audio.size > 0 ? audio.size : null;
      const size = videoSize == null ? null : videoSize + (audioSize || 0);
      out.push({
        key,
        res: rep.res,
        width: rep.width,
        height: rep.height,
        fps,
        highFps: fps > 30,
        hdr: !!rep.hdr,
        codec: rep.codec,
        itag: rep.itag,
        muxed: !!rep.muxed,
        container,
        videoSize,
        audioSize,
        size,
        sizeApprox: !!(rep.sizeApprox || audioSize == null || (audio && audio.sizeApprox && !rep.muxed)),
        audio: audio && !rep.muxed ? { itag: audio.itag, codec: audio.codec, bitrate: audio.bitrate, size: audio.size } : null,
        label: qualityLabel(rep.res, fps),
        badges: badgesFor(rep.res, fps, rep.hdr),
      });
    }
    out.sort((a, b) => b.res - a.res || Number(b.highFps) - Number(a.highFps) || Number(b.hdr) - Number(a.hdr) || b.fps - a.fps);
    return out;
  }

  /* ------------------------------------------------------------------ languages */
  let dnCache = { lang: null, dn: null };
  function capitalize(s, lang) {
    try {
      return s.charAt(0).toLocaleUpperCase(lang) + s.slice(1);
    } catch (_) {
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
  }

  /** Language name in the extension's UI language ('tr' -> 'Turkish'); falls back to YouTube's name. */
  function languageName(code, fallback) {
    const ui = (AYT.i18n && AYT.i18n.language) || 'en';
    if (code) {
      try {
        if (dnCache.lang !== ui) dnCache = { lang: ui, dn: new Intl.DisplayNames([ui, 'en'], { type: 'language', fallback: 'none' }) };
        const n = dnCache.dn.of(code);
        if (n && n.toLowerCase() !== String(code).toLowerCase()) return capitalize(n, ui);
      } catch (_) {
        /* invalid tag or no Intl.DisplayNames */
      }
    }
    return fallback || code || '';
  }

  /**
   * Options for the audio-language select (only when the video has 2+ audio tracks): original first (labelled
   * "(original)"), then the default track, then by localized name. value = track id ('en.4'), lang = 'en'.
   */
  function trackOptions(info) {
    const tracks = (info && info.audioTracks) || [];
    if (tracks.length < 2) return [];
    const ui = (AYT.i18n && AYT.i18n.language) || 'en';
    let coll;
    try {
      coll = new Intl.Collator(ui).compare;
    } catch (_) {
      coll = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    }
    const seen = new Set();
    const out = [];
    for (const tr of tracks) {
      if (!tr || !tr.id || seen.has(tr.id)) continue;
      seen.add(tr.id);
      out.push({ value: String(tr.id), lang: tr.lang || null, isOriginal: !!tr.isOriginal, isDefault: !!tr.isDefault, name: languageName(tr.lang, tr.name) });
    }
    out.sort((a, b) => Number(b.isOriginal) - Number(a.isOriginal) || Number(b.isDefault) - Number(a.isDefault) || coll(a.name, b.name));
    for (const op of out) op.label = op.isOriginal ? t('dl.trackOriginal', { name: op.name }) : op.name;
    return out;
  }

  /* ------------------------------------------------------------------ sections */
  /** {start,end} (seconds, ms precision) for a clip, or null for the whole video / an invalid range. */
  function normalizeSection(duration, start, end) {
    const d = Number(duration);
    let s = Number(start);
    let e = Number(end);
    if (!(d > 0) || !isFinite(s) || !isFinite(e)) return null;
    s = U.clamp(s, 0, d);
    e = U.clamp(e, 0, d);
    if (e - s < MIN_SECTION - 1e-6) return null;
    if (s <= 0.5 && e >= d - 0.5) return null;
    return { start: round3(s), end: round3(e) };
  }

  /** 75 -> '01:15'; with hours (or ≥ 1 h) -> '1:01:15'. */
  function shortClock(sec, withHours) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const x = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return withHours || h > 0 ? h + ':' + p(m) + ':' + p(x) : p(m) + ':' + p(x);
  }

  function sectionLabel(section, duration) {
    if (!section) return '';
    const long = Number(duration) >= 3600 || section.end >= 3600;
    return '✂ ' + shortClock(section.start, long) + '–' + shortClock(section.end, long);
  }

  function scaleSize(size, section, duration) {
    if (size == null || !section || !(duration > 0)) return size;
    return Math.round(size * U.clamp((section.end - section.start) / duration, 0, 1));
  }

  /** '963.6 MB', '0.99 GB', '2.01 GB' in the UI language (AYT.util.formatBytes: GB from 1000 MB on); '~' when approximate. */
  function formatSize(bytes, approx) {
    if (bytes == null || !isFinite(bytes) || bytes < 0) return '';
    const s = U.formatBytes(bytes);
    if (!s) return '';
    return approx ? t('common.approxSize', { size: s }) : s;
  }

  /* ------------------------------------------------------------------ tasks */
  function assertVideoId(videoId) {
    if (!VIDEO_ID_RE.test(String(videoId || ''))) {
      const e = new Error(t('error.noVideo'));
      e.code = 'no_video';
      throw e;
    }
  }

  function playlistOk(listId) {
    return !!(listId && LIST_ID_RE.test(listId) && !U.isMixPlaylist(listId));
  }

  function thumbUrl(videoId) {
    return 'https://i.ytimg.com/vi/' + encodeURIComponent(videoId) + '/mqdefault.jpg';
  }

  /**
   * Task for a video row (DEVELOPER-SPEC §8.3). o: { container, codec, audioLang, section, preciseCut, playlistId }.
   * Playlists use the playlist URL (host: height <= H semantics) and never a section.
   */
  function videoTask(videoId, option, opts) {
    assertVideoId(videoId);
    const o = opts || {};
    const playlist = playlistOk(o.playlistId);
    const section = playlist ? null : o.section || null;
    return {
      kind: 'video',
      videoId,
      url: playlist ? U.playlistUrl(o.playlistId) : U.watchUrl(videoId),
      playlist,
      height: option.height || null, // null = best available (host: bv*+ba/b)
      width: option.width || null,
      hdr: option.hdr == null ? null : !!option.hdr,
      fps: option.fps || null,
      container: normContainer(o.container),
      codec: normCodec(o.codec),
      audioLang: o.audioLang || null,
      section: section ? { start: section.start, end: section.end } : null,
      preciseCut: !!(section && o.preciseCut),
    };
  }

  /** 'MP4 · 2160p60 · HDR' (+ ' · Turkish') (+ ' · Playlist') (+ ' · ✂ 01:00–02:30'). */
  function videoLabel(option, opts) {
    const o = opts || {};
    return [
      CONTAINER_LABEL[normContainer(o.container)],
      option.label,
      option.hdr ? 'HDR' : '',
      o.langName || '',
      playlistOk(o.playlistId) ? t('dl.labelPlaylist') : '',
      !playlistOk(o.playlistId) && o.section ? sectionLabel(o.section, o.duration) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function videoMeta(videoId, title, label) {
    return { title: String(title || videoId).slice(0, 300), videoId, thumbnail: thumbUrl(videoId), label };
  }

  /** GIF job (DEVELOPER-SPEC §8.3): requires a section of at most 60 s. */
  function gifTask(videoId, section) {
    assertVideoId(videoId);
    if (!section || !(section.end - section.start > 0) || section.end - section.start > GIF_MAX_SECONDS + 1e-6) {
      const e = new Error(t('video.gifTooLong', { max: GIF_MAX_SECONDS }));
      e.code = 'bad_section';
      throw e;
    }
    return {
      kind: 'gif',
      videoId,
      url: U.watchUrl(videoId),
      playlist: false,
      section: { start: section.start, end: section.end },
      gifWidth: GIF_WIDTH,
      gifFps: GIF_FPS,
    };
  }

  function gifLabel(section, duration) {
    return ['GIF', GIF_WIDTH + 'px', sectionLabel(section, duration)].filter(Boolean).join(' · ');
  }

  /** Task for the audio panel. o: { format, bitrate, audioLang, section, playlistId, embedThumbnail, embedMetadata }. */
  function audioTask(videoId, opts) {
    assertVideoId(videoId);
    const o = opts || {};
    const playlist = playlistOk(o.playlistId);
    const section = playlist ? null : o.section || null;
    const fmt = normAudioFormat(o.format);
    return {
      kind: 'audio',
      videoId,
      url: playlist ? U.playlistUrl(o.playlistId) : U.watchUrl(videoId),
      playlist,
      audioFormat: fmt,
      bitrate: normBitrate(o.bitrate),
      audioLang: o.audioLang || null,
      section: section ? { start: section.start, end: section.end } : null,
      embedThumbnail: fmt === 'wav' ? false : !!o.embedThumbnail,
      embedMetadata: !!o.embedMetadata,
    };
  }

  /** 'MP3 · 192 kbps' / 'FLAC' (+ language, playlist, range). */
  function audioLabel(opts) {
    const o = opts || {};
    const fmt = normAudioFormat(o.format);
    return [
      AUDIO_LABEL[fmt],
      fmt === 'mp3' ? t('audio.kbps', { n: normBitrate(o.bitrate) }) : '',
      o.langName || '',
      playlistOk(o.playlistId) ? t('dl.labelPlaylist') : '',
      !playlistOk(o.playlistId) && o.section ? sectionLabel(o.section, o.duration) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /**
   * Estimated size of an audio job's file (always approximate):
   *  mp3: bitrate × length · m4a / opus: the source stream is copied → source size × range fraction ·
   *  wav: 16-bit PCM at the source rate (opus sources are 48 kHz) · flac: ~60 % of the wav size · + cover art.
   * o: { format, bitrate, trackId, lang, section, embedThumbnail }. Returns { size: number|null, approx: true }.
   */
  function estimateAudio(info, opts) {
    const o = opts || {};
    const fmt = normAudioFormat(o.format);
    const duration = Number(info && info.duration) || 0;
    const sec = o.section ? o.section.end - o.section.start : duration;
    if (!(sec > 0)) return { size: null, approx: true };
    let bytes = null;
    if (fmt === 'mp3') {
      bytes = ((normBitrate(o.bitrate) * 1000) / 8) * sec;
    } else if (fmt === 'm4a' || fmt === 'opus') {
      const want = fmt === 'm4a' ? 'aac' : 'opus';
      const a = pickAudio(info, { codec: want, trackId: o.trackId, lang: o.lang });
      if (a && a.codec === want && a.size > 0 && duration > 0) bytes = a.size * (sec / duration);
      else if (a && a.codec === want && a.bitrate > 0) bytes = (a.bitrate / 8) * sec;
      else bytes = ((want === 'aac' ? 170000 : (a && a.bitrate) || 128000) / 8) * sec; // re-encoded (rare)
    } else {
      // wav / flac are decoded from the best stream (normally Opus, 48 kHz stereo)
      const a = pickAudio(info, { codec: 'opus', trackId: o.trackId, lang: o.lang });
      const rate = (a && a.sampleRate) || 44100;
      const ch = (a && a.channels) || 2;
      const pcm = rate * ch * 2 * sec;
      bytes = fmt === 'wav' ? pcm + 44 : pcm * 0.6;
    }
    if (bytes != null && o.embedThumbnail && fmt !== 'wav') bytes += COVER_BYTES;
    return { size: bytes == null ? null : Math.round(bytes), approx: true };
  }

  /* ------------------------------------------------------------------ jobs */
  const isActive = (job) => !!(job && !AYT.JOB_DONE_STATES.includes(job.status));

  function sameSection(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return Math.abs(a.start - b.start) < 0.5 && Math.abs(a.end - b.end) < 0.5;
  }

  /** Does an (active) video job belong to this row? (same quality group, container and playlist mode) */
  function jobMatchesOption(job, videoId, option, container, playlist) {
    if (!job || job.videoId !== videoId || job.kind !== 'video') return false;
    const tk = job.task || {};
    return (
      tk.height === option.height &&
      !!tk.hdr === !!option.hdr &&
      (Number(tk.fps) || 0) > 30 === !!option.highFps &&
      (tk.container || 'mp4') === normContainer(container) &&
      !!tk.playlist === !!playlist
    );
  }

  /** An active job doing exactly the same work (prevents double starts). */
  function findDuplicate(task, jobs) {
    return (jobs || []).find((j) => {
      if (!isActive(j) || !j.task) return false;
      const a = j.task;
      if (a.kind !== task.kind || a.videoId !== task.videoId || !!a.playlist !== !!task.playlist) return false;
      if (!sameSection(a.section, task.section) || (a.audioLang || null) !== (task.audioLang || null)) return false;
      if (task.kind === 'video') return a.height === task.height && !!a.hdr === !!task.hdr && (a.fps > 30) === (task.fps > 30) && a.container === task.container;
      if (task.kind === 'audio') return a.audioFormat === task.audioFormat && (task.audioFormat !== 'mp3' || a.bitrate === task.bitrate);
      return true;
    }) || null;
  }

  /** Newest active job of the current page video whose kind is in `kinds`. */
  function newestActive(kinds, videoId) {
    const vid = videoId || AYT.page.videoId;
    if (!vid) return null;
    return AYT.client.jobs.list().find((j) => j.videoId === vid && kinds.includes(j.kind) && isActive(j)) || null;
  }

  /** Toolbar ring value for the newest active job of these kinds (null = no ring). */
  function toolbarProgress(kinds) {
    const job = newestActive(kinds);
    if (!job) return null;
    return isNum(job.percent) ? U.clamp(job.percent, 0, 100) : 0;
  }

  /* =================================================================== UI helpers */
  const { h, icon, clear } = AYT.dom;

  /**
   * True for a real user event (AYT.keys.trusted: also synthetic events while AYT.testMode is set by e2e scripts).
   * Handlers that start privileged work and are not built with AYT.ui.button check it: a control that page script
   * moved out of our shadow root is not covered by AYT.keys.guard.
   */
  function userEvent(e) {
    return AYT.keys && typeof AYT.keys.trusted === 'function' ? AYT.keys.trusted(e) : !!(e && e.isTrusted);
  }

  /** Rejects with a friendly error when `promise` takes longer than `ms`. */
  function withTimeout(promise, ms, code) {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(t('dl.noResponse'));
        e.code = code || 'timeout';
        reject(e);
      }, ms);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
  }

  function openOptions(section) {
    AYT.client.send(AYT.MSG.OPEN_OPTIONS, { section }).catch((e) => AYT.ui.showError(e));
  }

  /**
   * Companion status for a panel: follows pushes, refreshes with a timeout, never throws.
   * onChange(status) runs on every change. status.state: unknown|checking|connected|missing|forbidden|error|outdated.
   */
  function hostController(onChange) {
    let status = AYT.client.host.status || null;
    let pending = null;
    let destroyed = false;
    const notify = () => {
      if (!destroyed) {
        try {
          onChange(status);
        } catch (e) {
          console.error('[AYT] host listener', e);
        }
      }
    };
    const off = AYT.client.on('host', (s) => {
      status = s || null;
      notify();
    });
    function refresh(force) {
      if (pending) return pending;
      pending = withTimeout(AYT.client.host.refresh(!!force), force ? 25000 : 12000)
        .then((s) => {
          status = s || { state: 'unknown' };
          notify();
          return status;
        })
        .catch((e) => {
          if (!(e && e.code === 'invalidated')) {
            status = { state: 'error', error: (e && e.message) || String(e) };
            notify();
          }
          return status;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    }
    return {
      get status() {
        return status;
      },
      /** True when the companion is known to be unusable (notice shown, rows disabled). */
      get blocked() {
        return !!(status && BAD_HOST.includes(status.state));
      },
      get ready() {
        return !!(status && status.state === 'connected');
      },
      refresh,
      /** Resolves true when jobs can be started (waits for a pending check, at most ~2 attempts). */
      async ensure() {
        if (status && status.state === 'connected') return true;
        let s = await refresh(false);
        if (s && (s.state === 'checking' || s.state === 'unknown')) {
          await U.sleep(1500);
          s = await refresh(false);
        }
        return !!(s && s.state === 'connected');
      },
      destroy() {
        destroyed = true;
        off();
      },
    };
  }

  /** Scroll behavior for our own scrolls: 'instant' when the user asked the system for reduced motion. */
  function scrollBehavior() {
    try {
      return g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    } catch (_) {
      return 'smooth';
    }
  }

  /** Friendly explanation (toast + highlighted notice) when a download needs the companion. kind: 'video'|'audio'. */
  function needCompanion(status, kind, pulseEl) {
    const state = status && status.state;
    let text;
    if (state === 'outdated') text = t('dl.hostOutdated');
    else if (state === 'error') text = t('dl.hostBroken');
    else if (state === 'forbidden') text = (status && status.error) || t('job.err.host_forbidden');
    else text = kind === 'audio' ? t('audio.needCompanion') : t('video.needCompanion');
    AYT.ui.toast(text, {
      kind: 'warn',
      duration: 7000,
      action: { label: t('host.howToInstall'), onClick: () => openOptions('companion') },
    });
    if (pulseEl && pulseEl.firstElementChild) {
      const n = pulseEl.firstElementChild;
      try {
        n.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
      } catch (_) {
        /* ignore */
      }
      n.classList.remove('ayt-dl-pulse');
      void n.offsetWidth;
      n.classList.add('ayt-dl-pulse');
    }
  }

  /**
   * Starts a companion job with a timeout and friendly errors. Returns the job id or null.
   * opts: { host (hostController), kind ('video'|'audio'), pulseEl }
   */
  async function startJob(task, meta, opts) {
    const o = opts || {};
    const dup = findDuplicate(task, AYT.client.jobs.list());
    if (dup) {
      AYT.ui.toast(t('dl.alreadyRunning'), { kind: 'info' });
      return null;
    }
    try {
      const id = await withTimeout(AYT.client.jobs.start(task, meta), START_TIMEOUT);
      AYT.ui.toast(t('job.started'), { kind: 'success' });
      return id || true;
    } catch (e) {
      const code = (e && e.code) || '';
      if (code === 'invalidated') {
        // the extension was reloaded: one "refresh the page" toast with its action (AYT.ui.showError)
        AYT.ui.showError(e);
        return null;
      }
      if (/missing|forbidden|host|native|ytdlp/i.test(code) && o.host) {
        const s = await o.host.refresh(true);
        if (s && BAD_HOST.includes(s.state)) {
          needCompanion(s, o.kind, o.pulseEl);
          return null;
        }
      }
      AYT.ui.toast(t('dl.startFailed', { message: (e && e.message) || String(e) }), { kind: 'error' });
      return null;
    }
  }

  function middleEllipsis(s, max) {
    const str = String(s || '');
    if (str.length <= max) return str;
    const head = Math.ceil((max - 1) * 0.4);
    const tail = max - 1 - head;
    return str.slice(0, head) + '…' + str.slice(str.length - tail);
  }

  /**
   * Folder the companion saves into: { path } (absolute) or { text } (localized, while the companion has not
   * told us its Downloads folder). sub = the subfolder appended to the Windows Downloads folder.
   */
  function saveFolder(status) {
    let out = '';
    let sub = '';
    try {
      out = String(AYT.settings.get('outputDir') || '').trim();
      sub = String(AYT.settings.get('subfolder') || '').trim();
    } catch (_) {
      /* settings not loaded */
    }
    if (out) return { path: out };
    const st = status || {};
    const base = typeof st.downloadsDir === 'string' && st.downloadsDir ? st.downloadsDir : '';
    const text = sub ? t('dl.defaultFolderSub', { subfolder: sub }) : t('dl.defaultFolder');
    if (base) return { path: sub ? base.replace(/[\\/]+$/, '') + '\\' + sub : base, text, inDownloads: true };
    if (typeof st.defaultDir === 'string' && st.defaultDir) return { path: st.defaultDir };
    return { text };
  }

  /** Full save folder (or the localized description). Never put it in the page-reachable DOM (see folderLabel). */
  function folderPath(status) {
    const f = saveFolder(status);
    return f.path || f.text;
  }

  /** Last folder name of a path: 'C:\Users\a\Downloads\Akif YouTube' -> 'Akif YouTube', 'D:\' -> 'D:'. */
  function lastFolder(p) {
    const s = String(p || '').replace(/[\\/]+$/, '');
    return s.slice(Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')) + 1) || s;
  }

  /**
   * What the footer shows: the save folder's own name ('Downloads › Akif YouTube' inside the Windows Downloads
   * folder), never the absolute path. Our shadow roots are open, so page scripts could read a path, and it contains
   * the Windows user name. The options page (extension origin) shows the full path.
   */
  function folderLabel(status) {
    const f = saveFolder(status);
    if (f.inDownloads || !f.path) return f.text;
    return lastFolder(f.path);
  }

  /** Footer: "Saving to <folder> [Change]" (Change → options page, downloads section). update() also relabels. */
  function folderFooter(getStatus) {
    const labelEl = h('span', { class: 'ayt-dl-folder__label' });
    const pathEl = h('span', { class: 'ayt-dl-folder__path' });
    const btn = AYT.ui.button({ label: ' ', size: 'sm', variant: 'ghost', className: 'ayt-dl-folder__btn', onClick: () => openOptions('downloads') });
    const el = h('div', { class: 'ayt-dl-folder' }, icon('folder', { size: 16 }), labelEl, pathEl, btn);
    function update() {
      const name = folderLabel(getStatus ? getStatus() : null);
      labelEl.textContent = t('dl.savingTo');
      pathEl.textContent = middleEllipsis(name, 44);
      pathEl.title = name; // the name may be cut off by the ellipsis
      const span = btn.querySelector('span');
      if (span) span.textContent = t('dl.changeFolder');
      // The visible label "Change" names the button (WCAG 2.5.3); the title describes it.
      btn.title = t('dl.changeFolderTitle');
    }
    update();
    return { el, update };
  }

  /**
   * Makes a toolbar dropdown fit the viewport: caps the panel height to the visible space under the button and,
   * when that space is too small for the content, scrolls the page down (keeping the button visible under the
   * masthead). Scrolls only for real content (allowScroll), again only when the content grew, and retries once
   * when YouTube interrupted the smooth scroll (it scrolls the page itself while loading).
   * state: per-open object. Returns true when it started a scroll (call again ~1.3 s later to re-measure).
   */
  function fitPanel(el, ctx, state, allowScroll) {
    if (!ctx || ctx.surface !== 'toolbar' || !el || !el.isConnected) return false;
    const panel = el.closest('.ayt-panel');
    const body = panel && panel.querySelector('.ayt-panel__body');
    if (!panel || !body) return false;
    const st = state || {};
    const now = Date.now();
    const vh = window.innerHeight;
    const r = panel.getBoundingClientRect();
    const inFlight = st.target != null && now - st.targetAt < 1200;
    if (!inFlight && st.awaitCheck) {
      // first measurement after our scroll: if it was interrupted, allow exactly one more try
      st.awaitCheck = false;
      if (Math.abs(window.scrollY - st.target) > 8 && !st.retried) {
        st.retried = true;
        st.lastWant = 0;
      }
    }
    // While our own smooth scroll is still running, measure against where it will end.
    const top = inFlight ? r.top + window.scrollY - st.target : r.top;
    const natural = panel.offsetHeight - body.clientHeight + body.scrollHeight;
    const want = Math.min(natural, 640, vh - 140);
    let avail = vh - top - 12;
    let scrolled = false;
    if (allowScroll !== false && want > avail + 4 && want > (st.lastWant || 0) + 24) {
      const room = Math.max(0, top - 120); // keep the toolbar button below YouTube's masthead
      const delta = Math.round(Math.min(want - avail, room));
      if (delta > 4) {
        st.target = window.scrollY + delta;
        st.targetAt = now;
        st.lastWant = want;
        st.awaitCheck = true;
        scrolled = true;
        try {
          window.scrollTo({ top: st.target, behavior: scrollBehavior() });
        } catch (_) {
          window.scrollTo(0, st.target);
        }
        avail += delta;
      }
    }
    panel.style.setProperty('--ayt-panel-h', Math.max(300, Math.floor(avail)) + 'px');
    return scrolled;
  }

  /**
   * After a keyboard open: true while focus is still where the toolbar put it, on the panel container around `el`
   * (toolbar.js focusPanel), or was lost to <body> (the control that had it was re-rendered). A control the user
   * moved to in the meantime keeps its focus: another one in the panel (Close, the footer) or the toolbar.
   */
  function focusUntouched(el) {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) return true;
    const panelEl = el.closest('.ayt-panel');
    const rootNode = el.getRootNode();
    return !!(panelEl && rootNode.host === active && rootNode.activeElement === panelEl);
  }

  /**
   * Time-range editor: dual slider, From/To HH:MM:SS inputs, "use current time" buttons, length, reset.
   * opts: { duration, start, end, title, onChange({start, end, section}) }. Values in seconds.
   * Returns { el, start, end, section, set(start, end), reset(), destroy() }.
   */
  function rangeEditor(opts) {
    const o = opts || {};
    const duration = Math.max(MIN_SECTION + 1, Math.floor(Number(o.duration) || 0));
    const gap = MIN_SECTION;
    let start = U.clamp(Number(o.start) || 0, 0, duration - gap);
    let end = U.clamp(o.end != null ? Number(o.end) : duration, start + gap, duration);
    const long = duration >= 3600;
    let raf = 0;

    const lenEl = h('span', { class: 'ayt-dl-range__len' });
    const slider = AYT.ui.rangeSlider({
      min: 0,
      max: duration,
      step: 1,
      start,
      end,
      minGap: gap,
      showLabels: false,
      startLabel: t('common.start'),
      endLabel: t('common.end'),
      onInput: (a, b) => {
        start = a;
        end = b;
        fromIn.value = start;
        toIn.value = end;
        changed();
      },
    });
    const fromIn = AYT.ui.timeInput({ value: start, min: 0, max: duration, ariaLabel: t('common.from'), onChange: (v) => setStart(v) });
    const toIn = AYT.ui.timeInput({ value: end, min: 0, max: duration, ariaLabel: t('common.to'), onChange: (v) => setEnd(v) });
    const nowBtn = (which) =>
      AYT.ui.button({
        icon: 'clock',
        size: 'sm',
        variant: 'ghost',
        className: 'ayt-dl-range__now',
        title: which === 'start' ? t('dl.startAtCurrent') : t('dl.endAtCurrent'),
        onClick: () => {
          const now = currentTime();
          if (now == null) return;
          if (which === 'start') setStart(now);
          else setEnd(now);
        },
      });
    const resetBtn = AYT.ui.button({ icon: 'refresh', label: t('common.wholeVideo'), size: 'sm', variant: 'ghost', className: 'ayt-dl-range__reset', title: t('dl.resetRange'), onClick: () => reset() });

    // input.errorEl (hidden while valid) explains a rejected entry right under its field
    const timeCol = (label, input, btn) =>
      h('div', { class: 'ayt-dl-range__time' }, h('span', { class: 'ayt-dl-range__cap', 'aria-hidden': 'true' }, label), h('span', { class: 'ayt-dl-range__field' }, input.el, btn), input.errorEl || null);
    const el = h(
      'div',
      { class: 'ayt-dl-range' },
      h('div', { class: 'ayt-dl-range__head' }, h('span', { class: 'ayt-dl-range__title' }, icon('clock', { size: 16 }), o.title || t('dl.timeRange')), lenEl, resetBtn),
      slider.el,
      h('div', { class: 'ayt-dl-range__times' }, timeCol(t('common.from'), fromIn, nowBtn('start')), timeCol(t('common.to'), toIn, nowBtn('end')))
    );

    function currentTime() {
      try {
        if (AYT.player.isAdPlaying && AYT.player.isAdPlaying()) {
          AYT.ui.toast(t('dl.adPlaying'), { kind: 'info' });
          return null;
        }
        const now = AYT.player.currentTime();
        return isFinite(now) ? U.clamp(Math.floor(now), 0, duration) : null;
      } catch (_) {
        return null;
      }
    }

    function sync() {
      slider.set(start, end);
      fromIn.value = start;
      toIn.value = end;
      changed();
    }
    function setStart(v) {
      start = U.clamp(Number(v) || 0, 0, duration - gap);
      if (end - start < gap) end = Math.min(duration, start + gap);
      sync();
    }
    function setEnd(v) {
      end = U.clamp(Number(v) || 0, gap, duration);
      if (end - start < gap) start = Math.max(0, end - gap);
      sync();
    }
    function reset() {
      start = 0;
      end = duration;
      sync();
    }
    const thumbs = slider.el.querySelectorAll('input[type="range"]');
    function changed() {
      const whole = start <= 0.5 && end >= duration - 0.5;
      lenEl.textContent = t('dl.rangeLength', { time: shortClock(end - start, long) });
      resetBtn.classList.toggle('ayt-hidden', whole);
      // screen readers: "01:15" instead of "75"
      if (thumbs[0]) thumbs[0].setAttribute('aria-valuetext', shortClock(start, long));
      if (thumbs[1]) thumbs[1].setAttribute('aria-valuetext', shortClock(end, long));
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (o.onChange) o.onChange({ start, end, section: normalizeSection(duration, start, end) });
      });
    }
    changed();
    return {
      el,
      get start() {
        return start;
      },
      get end() {
        return end;
      },
      get section() {
        return normalizeSection(duration, start, end);
      },
      set(s, e) {
        start = U.clamp(Number(s) || 0, 0, duration - gap);
        end = U.clamp(Number(e), start + gap, duration);
        sync();
      },
      reset,
      destroy() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      },
    };
  }

  /* =================================================================== styles */
  AYT.ui.addStyles(`
.ayt-dl { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.ayt-dl-loading { display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 140px; font: 500 13px/1.3 var(--ayt-font); color: var(--ayt-text-2); }
.ayt-dl-host:empty { display: none; }
.ayt-dl-pulse { animation: ayt-dl-pulse .85s ease-out 2; }
@keyframes ayt-dl-pulse { 0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, .55); } 100% { box-shadow: 0 0 0 12px rgba(245, 158, 11, 0); } }
.ayt-dl-bar { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ayt-dl-bar > .ayt-grow { flex: 1 1 auto; }
.ayt-dl-card { display: flex; flex-direction: column; gap: 12px; padding: 12px 14px 14px; border-radius: 14px; background: var(--ayt-surface); border: 1px solid var(--ayt-border); }
.ayt-dl-lang .ayt-label .ayt-icon { color: var(--ayt-text-3); }
.ayt-dl-section-title { display: flex; align-items: center; gap: 8px; font: 600 12px/1 var(--ayt-font); letter-spacing: .5px; text-transform: uppercase; color: var(--ayt-text-3); margin: 2px 2px -4px; }
.ayt-dl-section-title::after { content: ""; flex: 1; height: 1px; background: var(--ayt-border); }

/* range editor */
.ayt-dl-range { display: flex; flex-direction: column; gap: 12px; }
.ayt-dl-range__head { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.ayt-dl-range__title { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; font: 600 13px/1.2 var(--ayt-font); color: var(--ayt-text); }
.ayt-dl-range__title .ayt-icon { color: var(--ayt-accent); }
.ayt-dl-range__len { flex: none; padding: 5px 10px; border-radius: 999px; background: var(--ayt-accent-soft); color: var(--ayt-accent-text); font: 600 12px/1 var(--ayt-font); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ayt-dl-range__reset { flex: none; }
.ayt-dl-range .ayt-dual { margin: 0 2px; }
.ayt-dl-range__times { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.ayt-dl-range__time { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ayt-dl-range__cap { font: 500 12px/1.2 var(--ayt-font); color: var(--ayt-text-2); }
.ayt-dl-range__field { display: flex; align-items: center; gap: 4px; min-width: 0; }
.ayt-dl-range__field .ayt-input--time { max-width: none; flex: 1 1 auto; min-width: 0; height: 36px; font-size: 14px; }
.ayt-dl-range__now { flex: none; color: var(--ayt-text-2); }
.ayt-dl-range__now:hover { color: var(--ayt-accent); }
.ayt-dl-range__time > .ayt-field-error { margin-top: 0; }

/* footer */
.ayt-dl-folder { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 7px; font: 400 12px/1.3 var(--ayt-font); color: var(--ayt-text-2); }
.ayt-dl-folder > .ayt-icon { color: var(--ayt-text-3); }
.ayt-dl-folder__label { flex: none; }
.ayt-dl-folder__path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ayt-text); font-weight: 500; }
.ayt-dl-folder__btn { flex: none; }

/* video rows */
.ayt-video-list { display: flex; flex-direction: column; gap: 4px; }
.ayt-video-row { grid-template-columns: 46px 76px minmax(0, 1fr) auto 18px; min-height: 46px; padding: 8px 10px 8px 12px; overflow: hidden; }
.ayt-video-row .ayt-row__ext { font: 600 12px/1 var(--ayt-font); letter-spacing: .6px; color: var(--ayt-text-3); }
.ayt-video-row .ayt-row__res { font-size: 15px; letter-spacing: .1px; }
.ayt-video-row .ayt-row__size { font-size: 13px; }
.ayt-video-row__go { display: grid; place-items: center; color: var(--ayt-text-3); opacity: 0; transform: translateY(-2px); transition: opacity .15s, transform .15s var(--ayt-ease), color .15s; }
.ayt-video-row:not(.is-disabled):hover, .ayt-video-row:not(.is-disabled):focus-visible {
  background: var(--ayt-surface-2);
  border-color: rgba(255, 45, 70, .6);
  box-shadow: 0 0 0 1px rgba(255, 45, 70, .35), 0 0 16px rgba(255, 45, 70, .3), inset 0 0 14px rgba(255, 45, 70, .08);
}
.ayt-video-row:not(.is-disabled):hover .ayt-video-row__go, .ayt-video-row:focus-visible .ayt-video-row__go,
.ayt-video-row.is-busy .ayt-video-row__go, .ayt-video-row.is-starting .ayt-video-row__go { opacity: 1; transform: none; color: var(--ayt-accent); }
.ayt-video-row.is-disabled { opacity: .5; cursor: not-allowed; }
.ayt-video-row.is-disabled:hover { background: var(--ayt-surface); }
.ayt-video-row.is-busy .ayt-row__size { color: var(--ayt-accent-text); font-weight: 600; }
.ayt-video-row.is-starting { pointer-events: none; }
.ayt-video-row.is-starting .ayt-video-row__go .ayt-icon { animation: ayt-dl-bob .8s ease-in-out infinite alternate; }
@keyframes ayt-dl-bob { from { transform: translateY(-2px); } to { transform: translateY(2px); } }
.ayt-video-row .ayt-row__progress { position: absolute; left: 12px; right: 12px; bottom: 3px; height: 3px; }
.ayt-video-row--best .ayt-row__res { grid-column: 2 / 4; }
.ayt-video-more { all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 6px; height: 32px; margin-top: 2px; border-radius: 10px; font: 500 13px/1 var(--ayt-font); color: var(--ayt-text-2); cursor: pointer; transition: background .15s, color .15s; }
.ayt-video-more:hover { background: var(--ayt-surface); color: var(--ayt-text); }
.ayt-video-more:focus-visible { outline: 2px solid var(--ayt-focus); outline-offset: 1px; }
.ayt-video-clip-toggle[aria-pressed="true"] { background: var(--ayt-accent-soft); color: var(--ayt-accent-text); box-shadow: inset 0 0 0 1px rgba(255, 45, 70, .45); }
.ayt-video-gifrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ayt-video-gifrow .ayt-hint { flex: 1 1 160px; min-width: 0; }
.ayt-video-warn { color: var(--ayt-warning); }
/* narrow surfaces (Shorts popover, ~380 px) */
.ayt-dl--compact .ayt-video-row { grid-template-columns: 40px 68px minmax(0, 1fr) auto; gap: 6px; padding: 8px 10px; }
.ayt-dl--compact .ayt-video-row__go { display: none; }
.ayt-dl--compact .ayt-video-row .ayt-row__res { font-size: 14px; }
.ayt-dl--compact .ayt-dl-range__head { flex-wrap: wrap; }
.ayt-dl--compact .ayt-dl-range__times { gap: 8px; }
.ayt-video-jobs-title.ayt-hidden + .ayt-jobs { margin-top: 0; }
`);

  /* =================================================================== video panel */
  function settingOr(name, fallback) {
    try {
      const v = AYT.settings.get(name);
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  function persist(name, value) {
    AYT.settings.set(name, value).catch((e) => console.warn('[AYT] could not save setting', name, e));
  }

  /** Visible rows before "Show more": everything ≥ 1080p, at least 4; never hide a single row. */
  function visibleCount(options) {
    let n = Math.max(options.filter((x) => x.res >= 1080).length, Math.min(4, options.length));
    if (options.length - n <= 1) n = options.length;
    return n;
  }

  function createVideoPanel(ctx) {
    const S = {
      videoId: ctx.videoId,
      listId: ctx.page && ctx.page.listId ? ctx.page.listId : null,
      info: null,
      seq: 0,
      destroyed: false,
      container: normContainer(settingOr('videoContainer', 'mp4')),
      codec: normCodec(settingOr('videoCodec', 'auto')),
      trackId: null,
      clip: false,
      range: null, // {start, end} kept across rebuilds
      section: null,
      preciseCut: false,
      playlist: false,
      showAll: false,
      starting: new Set(),
      fit: {}, // fitPanel() state for this open panel
      fitTimer: 0,
      autoFocus: !!ctx.viaKeyboard, // keyboard open: the first rows get focus (once, see focusFirstRow)
    };
    const root = h('div', { class: ['ayt-dl', 'ayt-video', ctx.surface === 'shorts' && 'ayt-dl--compact'] });
    const host = hostController(() => onHost());
    const footer = folderFooter(() => host.status);
    let C = null; // per-render UI state
    const offs = [];
    let rowsRaf = 0;
    let resizeTimer = 0;

    /* ---------------------------------------------------------------- loading */
    function showLoading() {
      clear(root);
      root.appendChild(h('div', { class: 'ayt-dl-loading' }, AYT.ui.spinner(), h('span', null, t('video.loading'))));
    }

    function showLoadError(e) {
      clear(root);
      root.appendChild(
        AYT.ui.notice({
          kind: 'error',
          title: t('dl.loadFailed'),
          text: (e && e.message) || String(e),
          actions: [{ label: t('common.retry'), icon: 'refresh', variant: 'primary', onClick: () => load(true) }],
        })
      );
      fit();
    }

    async function load(force) {
      const seq = ++S.seq;
      teardown();
      if (!VIDEO_ID_RE.test(String(S.videoId || ''))) {
        clear(root);
        root.appendChild(AYT.ui.notice({ kind: 'warn', text: t('error.noVideo') }));
        return;
      }
      showLoading();
      try {
        const info = await withTimeout(AYT.videoInfo.get(S.videoId, { force: !!force }), 15000);
        if (seq !== S.seq || S.destroyed) return;
        S.info = info;
        build(true);
      } catch (e) {
        if (seq !== S.seq || S.destroyed) return;
        showLoadError(e);
      }
    }

    function teardown() {
      if (!C) return;
      if (C.jobList) C.jobList.destroy();
      if (C.range) C.range.destroy();
      C.offs.forEach((off) => off());
      C = null;
    }

    /* ---------------------------------------------------------------- build */
    function build(first) {
      teardown();
      const info = S.info;
      C = { offs: [], rows: [], jobList: null, range: null };
      clear(root);
      const blocked = AYT.videoInfo.blockReason(info);
      if (blocked) {
        root.appendChild(AYT.ui.notice({ kind: 'warn', text: blocked }));
        root.appendChild(jobsSection());
        fit();
        return;
      }

      C.hostSlot = h('div', { class: 'ayt-dl-host' });

      // container + clip toggle
      C.seg = AYT.ui.segmented({
        ariaLabel: t('video.container'),
        value: S.container,
        options: [
          { value: 'mp4', label: 'MP4', title: t('video.mp4Title') },
          { value: 'mkv', label: 'MKV', title: t('video.mkvTitle') },
          { value: 'webm', label: 'WebM', title: t('video.webmTitle') },
        ],
        onChange: (v) => {
          S.container = normContainer(v);
          persist('videoContainer', S.container);
          renderRows();
        },
      });
      const canClip = info.duration > MIN_SECTION + 1;
      C.clipBtn = AYT.ui.button({
        icon: 'scissors',
        label: t('video.clip'),
        size: 'sm',
        className: 'ayt-video-clip-toggle',
        title: t('video.clipTitle'),
        disabled: !canClip || S.playlist,
        onClick: () => setClip(!S.clip),
      });
      C.clipBtn.setAttribute('aria-pressed', String(S.clip));
      root.append(C.hostSlot, h('div', { class: 'ayt-dl-bar' }, C.seg.el, h('span', { class: 'ayt-grow' }), canClip ? C.clipBtn : null));

      // audio language (dubbed videos)
      const tracks = trackOptions(info);
      C.tracks = tracks;
      if (tracks.length) {
        if (!S.trackId || !tracks.some((x) => x.value === S.trackId)) S.trackId = tracks[0].value;
        C.lang = AYT.ui.select({
          ariaLabel: t('dl.audioLanguage'),
          value: S.trackId,
          options: tracks.map((x) => ({ value: x.value, label: x.label })),
          onChange: (v) => {
            S.trackId = v;
            renderRows();
          },
        });
        root.appendChild(h('div', { class: 'ayt-dl-lang' }, AYT.ui.field([icon('globe', { size: 14 }), t('dl.audioLanguage')], C.lang.el)));
      } else S.trackId = null;

      // clip editor slot + playlist switch
      C.clipSlot = h('div', { class: 'ayt-video-clipslot' });
      root.appendChild(C.clipSlot);
      if (S.clip) renderClip();

      if (playlistOk(S.listId) && ctx.surface !== 'shorts') {
        C.playlist = AYT.ui.switchControl({
          label: t('dl.playlist'),
          desc: t('video.playlistDesc'),
          checked: S.playlist,
          onChange: (v) => {
            S.playlist = !!v;
            if (S.playlist && S.clip) setClip(false);
            C.clipBtn.disabled = S.playlist || !canClip;
            renderRows();
          },
        });
        root.appendChild(h('div', { class: 'ayt-dl-card ayt-video-playlist' }, C.playlist.el));
      }

      // rows
      C.list = h('div', { class: 'ayt-video-list', role: 'group', 'aria-label': t('video.qualities') });
      C.list.addEventListener('keydown', onRowsKey);
      C.more = h('button', { type: 'button', class: 'ayt-video-more', on: { click: () => { S.showAll = !S.showAll; applyVisibility(); } } });
      root.append(C.list, C.more);
      root.appendChild(jobsSection());
      renderRows();
      renderHost();

      C.offs.push(AYT.client.on('jobs', scheduleRowStates));
      if (first) focusFirstRow();
      fit();
    }

    function jobsSection() {
      const title = h('div', { class: 'ayt-dl-section-title ayt-video-jobs-title ayt-hidden' }, t('common.downloads'));
      const vid = S.videoId;
      C.jobList = AYT.ui.jobList({
        filter: (j) => j.videoId === vid && (j.kind === 'video' || j.kind === 'gif'),
        compact: true,
        max: 8,
        onChange: (jobs) => title.classList.toggle('ayt-hidden', !jobs.length),
      });
      return h('div', { class: 'ayt-col ayt-video-jobs' }, title, C.jobList.el);
    }

    /* ---------------------------------------------------------------- clip */
    function setClip(on) {
      if (!C) return;
      S.clip = !!on && !S.playlist;
      C.clipBtn.setAttribute('aria-pressed', String(S.clip));
      if (S.clip) renderClip();
      else {
        if (C.range) C.range.destroy();
        C.range = null;
        S.section = null;
        clear(C.clipSlot);
      }
      updateSizes();
      fit();
    }

    function renderClip() {
      const info = S.info;
      if (!S.range) {
        // default: 30 s from the current position (handy for GIFs), clamped to the video
        let now = 0;
        try {
          now = Math.floor(AYT.player.isAdPlaying() ? 0 : AYT.player.currentTime()) || 0;
        } catch (_) {
          now = 0;
        }
        let start = U.clamp(now, 0, Math.max(0, info.duration - MIN_SECTION));
        let end = Math.min(info.duration, start + 30);
        if (end - start < 5) {
          start = Math.max(0, info.duration - 30);
          end = info.duration;
        }
        S.range = { start, end };
      }
      if (C.range) C.range.destroy();
      C.range = rangeEditor({
        duration: info.duration,
        start: S.range.start,
        end: S.range.end,
        title: t('video.clipRange'),
        onChange: (r) => {
          S.range = { start: r.start, end: r.end };
          S.section = r.section;
          updateSizes();
          updateGif();
        },
      });
      S.section = C.range.section;
      const precise = AYT.ui.switchControl({
        label: t('video.preciseCut'),
        desc: t('video.preciseCutDesc'),
        checked: S.preciseCut,
        onChange: (v) => {
          S.preciseCut = !!v;
        },
      });
      C.gifBtn = AYT.ui.button({ icon: 'film', label: t('video.gif'), size: 'sm', className: 'ayt-video-gif', title: t('video.gifTitle'), onClick: onGif });
      C.gifHint = h('span', { class: 'ayt-hint' });
      clear(C.clipSlot);
      C.clipSlot.appendChild(h('div', { class: 'ayt-dl-card ayt-video-clip' }, C.range.el, precise.el, h('div', { class: 'ayt-video-gifrow' }, C.gifBtn, C.gifHint)));
      updateGif();
    }

    function updateGif() {
      if (!C || !C.gifBtn) return;
      const sec = S.section;
      const len = sec ? sec.end - sec.start : S.info.duration;
      const ok = len <= GIF_MAX_SECONDS + 1e-6;
      C.gifBtn.disabled = !ok;
      C.gifHint.textContent = ok ? t('video.gifHint', { width: GIF_WIDTH, fps: GIF_FPS }) : t('video.gifTooLong', { max: GIF_MAX_SECONDS });
      C.gifHint.classList.toggle('ayt-video-warn', !ok);
    }

    async function onGif() {
      try {
        const sec = S.section || (S.info.duration <= GIF_MAX_SECONDS ? { start: 0, end: S.info.duration } : null);
        const task = gifTask(S.videoId, sec);
        if (!(await host.ensure())) return needCompanion(host.status, 'video', C && C.hostSlot);
        C.gifBtn.disabled = true;
        await startJob(task, videoMeta(S.videoId, S.info.title, gifLabel(sec, S.info.duration)), { host, kind: 'video', pulseEl: C && C.hostSlot });
      } catch (e) {
        AYT.ui.showError(e);
      } finally {
        updateGif();
      }
    }

    /* ---------------------------------------------------------------- rows */
    function currentTrack() {
      return (C && C.tracks && C.tracks.find((x) => x.value === S.trackId)) || null;
    }

    function renderRows() {
      if (!C || !S.info) return;
      const track = currentTrack();
      const options = buildVideoOptions(S.info, { container: S.container, codec: S.codec, trackId: track ? track.value : null, audioLang: track ? track.lang : null });
      C.rows = [];
      clear(C.list);
      // The page listed no formats at all (rare): let the companion pick the best one instead of a dead end.
      if (!options.length && !(S.info.videoFormats || []).length) {
        options.push(bestOption(S.container));
        C.list.appendChild(AYT.ui.notice({ kind: 'info', text: t('video.noFormats') }));
      }
      C.options = options;
      if (!options.length) {
        C.list.appendChild(AYT.ui.notice({ kind: 'info', text: t('video.noWebm') }));
        C.more.classList.add('ayt-hidden');
        return;
      }
      for (const op of options) {
        const sizeEl = h('span', { class: 'ayt-row__size' });
        const prog = AYT.ui.progress({ value: 0 });
        prog.el.classList.add('ayt-row__progress', 'ayt-hidden');
        const el = h(
          'button',
          // a row starts a download: script-made clicks are ignored (see userEvent)
          { type: 'button', class: ['ayt-row', 'ayt-video-row', op.best && 'ayt-video-row--best'], dataset: { key: op.key }, on: { click: (e) => { if (userEvent(e)) onRow(op); } } },
          h('span', { class: 'ayt-row__ext' }, CONTAINER_LABEL[S.container]),
          h('span', { class: 'ayt-row__res' }, op.label),
          op.best ? null : h('span', { class: 'ayt-row__badges' }, op.badges.map((b) => AYT.ui.badge(b.text, b.variant))),
          sizeEl,
          h('span', { class: 'ayt-video-row__go', 'aria-hidden': 'true' }, icon('download', { size: 18 })),
          prog.el
        );
        C.rows.push({ op, el, sizeEl, prog });
        C.list.appendChild(el);
      }
      applyVisibility();
      updateSizes();
    }

    function applyVisibility() {
      if (!C || !C.rows.length) return;
      const n = visibleCount(C.options);
      C.rows.forEach((r, i) => r.el.classList.toggle('ayt-hidden', !S.showAll && i >= n));
      const hidden = C.rows.length - n;
      clear(C.more);
      if (hidden <= 0) {
        C.more.classList.add('ayt-hidden');
        return;
      }
      C.more.classList.remove('ayt-hidden');
      C.more.setAttribute('aria-expanded', String(S.showAll));
      C.more.append(h('span', null, S.showAll ? t('video.fewerQualities') : t('video.moreQualities', { count: hidden })), icon(S.showAll ? 'chevron-up' : 'chevron-down', { size: 16 }));
      fit();
    }

    function rowSize(op) {
      if (S.playlist) return { size: op.size, approx: true };
      const sec = S.clip ? S.section : null;
      return { size: scaleSize(op.size, sec, S.info.duration), approx: op.sizeApprox || !!sec };
    }

    function updateSizes() {
      if (!C) return;
      for (const r of C.rows) {
        const { size, approx } = rowSize(r.op);
        r.sizeText = formatSize(size, approx);
        const codec = CODEC_LABEL[r.op.codec] || String(r.op.codec || '').toUpperCase();
        const parts = r.op.best ? [t('video.noFormats')] : [t('video.rowTitle', { codec, width: r.op.width, height: r.op.height, fps: r.op.fps })];
        if (r.op.audio && r.op.videoSize != null) parts.push(t('video.rowSizes', { video: formatSize(scaleSize(r.op.videoSize, S.clip ? S.section : null, S.info.duration), false), audio: formatSize(scaleSize(r.op.audio.size, S.clip ? S.section : null, S.info.duration), false) }));
        if (S.playlist) parts.push(t('video.playlistSizes'));
        r.el.title = parts.join('\n');
        r.el.setAttribute('aria-label', t('video.rowAria', { format: CONTAINER_LABEL[S.container], quality: r.op.label + (r.op.hdr ? ' HDR' : ''), size: r.sizeText || t('common.unknown') }));
      }
      updateRowStates();
    }

    function scheduleRowStates() {
      if (rowsRaf) return;
      rowsRaf = requestAnimationFrame(() => {
        rowsRaf = 0;
        updateRowStates();
      });
    }

    function updateRowStates() {
      if (!C) return;
      const jobs = AYT.client.jobs.list();
      const disabled = host.blocked;
      for (const r of C.rows) {
        const job = jobs.find((j) => isActive(j) && jobMatchesOption(j, S.videoId, r.op, S.container, S.playlist));
        r.el.classList.toggle('is-busy', !!job);
        r.el.classList.toggle('is-starting', S.starting.has(r.op.key));
        r.el.classList.toggle('is-disabled', disabled);
        r.el.setAttribute('aria-disabled', String(disabled));
        r.prog.el.classList.toggle('ayt-hidden', !job);
        if (job) {
          const pct = isNum(job.percent) && job.status !== 'queued' && job.status !== 'starting' ? job.percent : null;
          r.prog.set(pct);
          r.sizeEl.textContent = pct != null ? U.formatPercent(Math.floor(pct)) : job.status === 'queued' ? t('job.status.queued') : '…';
        } else r.sizeEl.textContent = r.sizeText || '';
      }
    }

    function onRowsKey(e) {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !C) return;
      const rows = C.rows.filter((r) => !r.el.classList.contains('ayt-hidden')).map((r) => r.el);
      const cur = e.target && e.target.closest ? e.target.closest('.ayt-video-row') : null;
      const i = rows.indexOf(cur);
      if (i < 0) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : U.clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1);
      rows[next].focus();
    }

    /**
     * Keyboard opens only: put focus on the best row so ↑/↓ walk the qualities. After a mouse open focus stays on
     * the panel container (toolbar.js), so Space keeps controlling the video instead of starting the top download.
     * Once per open (a later video change leaves focus alone), and only while focus is still on the panel container:
     * a control the user moved to while the formats loaded (Close, the footer, the toolbar) keeps it.
     */
    function focusFirstRow() {
      if (!S.autoFocus) return;
      S.autoFocus = false;
      setTimeout(() => {
        if (!C || !C.rows.length || S.destroyed || !focusUntouched(root)) return;
        try {
          C.rows[0].el.focus({ preventScroll: true });
        } catch (_) {
          /* ignore */
        }
      }, 60);
    }

    async function onRow(op) {
      if (!C || S.starting.has(op.key)) return;
      try {
        if (host.blocked) return needCompanion(host.status, 'video', C.hostSlot);
        const track = currentTrack();
        const audioLang = track && !track.isOriginal ? track.lang : null;
        const section = S.clip ? S.section : null;
        const task = videoTask(S.videoId, op, {
          container: S.container,
          codec: S.codec,
          audioLang,
          section,
          preciseCut: S.preciseCut,
          playlistId: S.playlist ? S.listId : null,
        });
        const label = videoLabel(op, { container: S.container, langName: audioLang ? track.name : '', section, duration: S.info.duration, playlistId: S.playlist ? S.listId : null });
        S.starting.add(op.key);
        updateRowStates();
        if (!(await host.ensure())) {
          needCompanion(host.status, 'video', C && C.hostSlot);
          return;
        }
        await startJob(task, videoMeta(S.videoId, S.info.title, label), { host, kind: 'video', pulseEl: C && C.hostSlot });
      } catch (e) {
        AYT.ui.showError(e);
      } finally {
        S.starting.delete(op.key);
        updateRowStates();
      }
    }

    /* ---------------------------------------------------------------- host */
    function renderHost() {
      if (!C || !C.hostSlot) return;
      clear(C.hostSlot);
      if (host.blocked) C.hostSlot.appendChild(AYT.ui.hostNotice(host.status, { onRecheck: () => {} }));
      updateRowStates();
    }

    function onHost() {
      renderHost();
      footer.update();
      fit();
    }

    function fit() {
      if (S.destroyed) return;
      requestAnimationFrame(() => {
        if (S.destroyed || !fitPanel(root, ctx, S.fit, !!S.info)) return;
        clearTimeout(S.fitTimer);
        S.fitTimer = setTimeout(fit, 1300); // re-measure once the scroll settled
      });
    }

    /* ---------------------------------------------------------------- global listeners */
    offs.push(
      AYT.settings.onChange((changes) => {
        let rows = false;
        if ('videoContainer' in changes && normContainer(changes.videoContainer) !== S.container) {
          S.container = normContainer(changes.videoContainer);
          if (C && C.seg) C.seg.value = S.container;
          rows = true;
        }
        if ('videoCodec' in changes && normCodec(changes.videoCodec) !== S.codec) {
          S.codec = normCodec(changes.videoCodec);
          rows = true;
        }
        if (rows) renderRows();
        if ('outputDir' in changes || 'subfolder' in changes) footer.update();
      })
    );
    offs.push(
      AYT.i18n.onChange(() => {
        footer.update();
        if (S.info) build(false);
      })
    );
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fit, 150);
    };
    window.addEventListener('resize', onResize);
    offs.push(() => window.removeEventListener('resize', onResize));

    showLoading();
    load(false);

    return {
      el: root,
      footer: footer.el,
      onOpen() {
        host.refresh(false);
        fit();
      },
      onVideoChange(pageInfo) {
        if (!pageInfo || !pageInfo.videoId || pageInfo.videoId === S.videoId) return;
        S.videoId = pageInfo.videoId;
        S.listId = pageInfo.listId || null;
        Object.assign(S, { info: null, trackId: null, clip: false, range: null, section: null, playlist: false, showAll: false });
        S.starting.clear();
        // YouTube scrolls to the top on navigation: let the panel fit itself again for the new video
        clearTimeout(S.fitTimer);
        S.fit = {};
        load(false);
      },
      destroy() {
        if (S.destroyed) return;
        S.destroyed = true;
        S.seq++;
        teardown();
        host.destroy();
        offs.forEach((off) => off());
        if (rowsRaf) cancelAnimationFrame(rowsRaf);
        clearTimeout(resizeTimer);
        clearTimeout(S.fitTimer);
      },
    };
  }

  /* =================================================================== keyboard command */
  /**
   * 'open-download': a keyboard shortcut, or the popup's "open on the page" link. opts.viaKeyboard === false (the
   * link was clicked with the mouse) opens the panel like a mouse open: focus stays on its container, so Space keeps
   * controlling the video. Anything else counts as a keyboard open (focus on the best row).
   */
  function openFromCommand(id, opts) {
    const panelId = id || 'video';
    const viaKeyboard = !(opts && opts.viaKeyboard === false);
    if (AYT.page.isShorts()) {
      // Shorts popover (TOOLS module: AYT.tools.shorts) opens on the last used tab, Video by default
      const shorts = (AYT.tools && AYT.tools.shorts) || AYT.shorts;
      if (shorts && typeof shorts.open === 'function') return shorts.open(panelId);
      return AYT.ui.toast(t('dl.openVideoFirst'), { kind: 'info' });
    }
    if (!AYT.page.isWatch()) return AYT.ui.toast(t('dl.openVideoFirst'), { kind: 'info' });
    const tb = AYT.toolbar.host;
    if (tb && tb.isConnected) {
      const r = tb.getBoundingClientRect();
      if (r.top < 64 || r.bottom > window.innerHeight - 160) window.scrollBy({ top: r.top - Math.min(260, window.innerHeight * 0.3), behavior: 'auto' });
    }
    AYT.toolbar.open(panelId, { viaKeyboard });
    if (!AYT.toolbar.isOpen(panelId)) {
      const hidden = (settingOr('toolbarHidden', []) || []).includes(panelId);
      AYT.ui.toast(hidden ? t('dl.buttonHidden') : t('dl.openVideoFirst'), { kind: 'info' });
    }
  }

  /* =================================================================== exports + registration */
  AYT.dl = {
    VIDEO_ID_RE,
    CONTAINERS,
    CONTAINER_LABEL,
    AUDIO_FORMATS,
    AUDIO_LABEL,
    CODEC_LABEL,
    GIF_MAX_SECONDS,
    GIF_WIDTH,
    GIF_FPS,
    MIN_SECTION,
    BAD_HOST,
    codecOrder,
    containerAccepts,
    audioCodecFor,
    pickAudio,
    qualityLabel,
    badgesFor,
    bestOption,
    buildVideoOptions,
    languageName,
    trackOptions,
    normalizeSection,
    shortClock,
    sectionLabel,
    scaleSize,
    formatSize,
    playlistOk,
    thumbUrl,
    videoTask,
    videoLabel,
    videoMeta,
    gifTask,
    gifLabel,
    audioTask,
    audioLabel,
    estimateAudio,
    normBitrate,
    isActive,
    jobMatchesOption,
    findDuplicate,
    newestActive,
    toolbarProgress,
    withTimeout,
    hostController,
    needCompanion,
    startJob,
    folderPath,
    folderLabel,
    folderFooter,
    userEvent,
    fitPanel,
    focusUntouched,
    scrollBehavior,
    rangeEditor,
    settingOr,
    persist,
    openFromCommand,
    createVideoPanel,
  };

  if (AYT.toolbar && typeof AYT.toolbar.register === 'function') {
    AYT.toolbar.register({
      id: 'video',
      order: 10,
      group: 'download',
      icon: 'video',
      panelIcon: 'video',
      title: () => t('toolbar.video'),
      panelTitle: () => t('video.panelTitle'),
      surfaces: ['watch', 'shorts'],
      panel: { width: 480, render: (ctx) => createVideoPanel(ctx) },
      progress: () => toolbarProgress(['video', 'gif']),
      badge: () => {
        const vid = AYT.page.videoId;
        if (!vid) return null;
        const n = AYT.client.jobs.list().filter((j) => j.videoId === vid && isActive(j)).length;
        return n > 1 ? n : null;
      },
      commands: { 'open-download': (opts) => openFromCommand('video', opts) },
    });
  }
})(globalThis);
