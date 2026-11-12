/*
 * Akif's Special YouTube Addon — shared constants.
 * Classic script: works in content scripts, extension pages and the service worker (importScripts).
 * Everything hangs off the global `AYT` namespace.
 */
(function (g) {
  'use strict';
  const AYT = (g.AYT = g.AYT || {});

  AYT.VERSION = '1.0.0';
  AYT.HOST_NAME = 'com.akif.youtube_addon';
  AYT.PROTOCOL_VERSION = 1;

  /** UI languages. English is the default/fallback language. */
  AYT.LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'az', name: 'Azərbaycanca' },
    { code: 'tr', name: 'Türkçe' },
    { code: 'ru', name: 'Русский' },
    { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
    { code: 'es', name: 'Español' },
  ];

  /**
   * Messages sent with chrome.runtime.sendMessage({ type, ...payload }) from content scripts,
   * the popup and the options page to the service worker. Every response is
   * { ok: true, ...data } or { ok: false, error: string, code?: string }.
   */
  AYT.MSG = Object.freeze({
    HOST_STATUS: 'host:status', // { refresh?: boolean } -> { status: HostStatus }
    HOST_OPEN: 'host:open', // { jobId, target: 'file'|'folder' } -> {}
    HOST_PICK_FOLDER: 'host:pickFolder', // {} -> { path: string|null }
    HOST_UPDATE_TOOLS: 'host:updateTools', // {} -> { output: string, version: string }
    JOB_START: 'job:start', // { task: Task, meta: JobMeta } -> { jobId }
    JOB_CANCEL: 'job:cancel', // { jobId } -> {}
    JOB_RETRY: 'job:retry', // { jobId } -> { jobId }
    JOB_REMOVE: 'job:remove', // { jobId } -> {}
    JOBS_LIST: 'jobs:list', // {} -> { jobs: Job[] }
    JOBS_CLEAR: 'jobs:clear', // {} -> {} (removes finished/failed/canceled jobs)
    DOWNLOAD_DATA: 'download:data', // { dataUrl? , text?, mime?, filename, kind } -> { downloadId }
    // url: https://*.ytimg.com/... OR a blob:https://www.youtube.com/... URL created by our content script
    // (the service worker can download page blob URLs; revoke them ~1 min later in the content script).
    DOWNLOAD_URL: 'download:url', // { url, filename, convert?: 'png'|'jpg'|'webp', kind } -> { downloadId }
    FETCH_IMAGE: 'fetch:image', // { url, convert?: 'png'|'jpg'|'webp' } -> { dataUrl, mime, width, height, bytes }
    THUMB_PROBE: 'thumb:probe', // { videoId } -> { items: ThumbItem[] }
    OPEN_OPTIONS: 'options:open', // { section?: string } -> {}
    OPEN_TAB: 'tab:open', // { url } -> {} (only chrome://extensions/shortcuts or extension pages)
  });

  /** Messages pushed from the service worker to UI ports (port name AYT.PORT_UI) and tabs. */
  AYT.PUSH = Object.freeze({
    JOBS: 'jobs', // { jobs: Job[] } full snapshot (sent on connect)
    JOB: 'job', // { job: Job } one job changed
    JOB_REMOVED: 'job:removed', // { jobId }
    HOST: 'host', // { status: HostStatus }
    COMMAND: 'command', // { command: string } keyboard shortcut / context command forwarded to a tab
  });

  AYT.PORT_UI = 'ayt-ui';

  /** Job kinds handled by the companion (native host). */
  AYT.JOB_KINDS = Object.freeze(['video', 'audio', 'subtitle', 'gif']);

  /** Terminal job states. */
  AYT.JOB_DONE_STATES = Object.freeze(['done', 'error', 'canceled']);

  /**
   * Default settings. Each setting is stored in chrome.storage.local under the key
   * `settings.<name>` (individual keys avoid read-modify-write races between contexts).
   */
  AYT.DEFAULT_SETTINGS = Object.freeze({
    // General
    language: 'en', // 'auto' | 'en' | 'az' | 'tr' | 'ru' | 'fr' | 'de' | 'es' — English is the main language; 'auto' follows the browser
    theme: 'auto', // panels theme: 'auto' (follow YouTube) | 'dark' | 'light'
    toolbarHidden: [], // ids of toolbar buttons the user hid
    showOnShorts: true, // inject the download button on Shorts

    // Downloads through the companion app
    outputDir: '', // '' = <Windows Downloads>\<subfolder>
    subfolder: 'Akif YouTube', // also used for browser-side downloads (screenshots, thumbnails, subtitles)
    filenameStyle: 'title', // 'title' | 'title_id' | 'channel_title' | 'date_title'
    videoContainer: 'mp4', // 'mp4' | 'mkv' | 'webm'
    videoCodec: 'auto', // 'auto' (best quality that fits the container) | 'compat' (prefer H.264/AAC)
    audioFormat: 'mp3', // 'mp3' | 'm4a' | 'opus' | 'flac' | 'wav'
    audioBitrate: 192, // kbps, MP3 only: 64 | 96 | 128 | 160 | 192 | 256 | 320
    embedThumbnail: true, // cover art in audio files / thumbnail in mp4/mkv
    embedMetadata: true, // title, artist, date...
    embedChapters: true,
    embedSubtitles: false, // embed available subtitles into mp4/mkv/webm
    useCookies: false, // pass the browser's YouTube cookies to yt-dlp (age-restricted / members-only)
    maxConcurrent: 2, // simultaneous companion jobs (1..4)
    notifyOnComplete: true,
    askWhereToSave: false, // browser-side downloads: show the Save As dialog

    // Screenshots
    screenshotFormat: 'png', // 'png' | 'jpg' | 'webp'
    screenshotQuality: 0.95, // jpg/webp quality 0.5..1
    screenshotAction: 'save', // 'save' | 'copy' | 'both'

    // Thumbnails
    thumbnailFormat: 'original', // 'original' | 'jpg' | 'png' | 'webp'

    // Subtitles
    subtitleFormat: 'srt', // 'srt' | 'vtt' | 'ttml' | 'srv3' | 'txt'
    subtitleLang: '', // preferred language code ('' = video default)

    // Player
    autoQuality: 'off', // 'off' | 'max' | '4320' | '2160' | '1440' | '1080' | '720' | '480' | '360'
    rememberSpeed: false,
    cinemaOpacity: 0.9, // 0.5..1
    boostMax: 400, // max volume boost in percent (100..600)

    // Interface cleanup
    hideComments: false,
    hideRelated: false,
    hideShorts: false,
    hideEndscreen: false,
    hideLiveChat: false,
    shortsToWatch: false, // open /shorts/<id> in the regular watch player
  });

  /** Keys of chrome.storage.local that are not settings. */
  AYT.STORAGE = Object.freeze({
    SETTINGS_PREFIX: 'settings.',
    JOBS: 'jobs', // persisted job list (most recent first, capped)
    LAST_SPEED: 'state.lastSpeed',
    HOST_STATUS: 'state.hostStatus',
  });

  AYT.LIMITS = Object.freeze({
    MAX_JOBS_KEPT: 150,
    MAX_DATA_URL_BYTES: 48 * 1024 * 1024, // above this, content scripts save through an <a download> fallback
  });

  /** YouTube player quality ids keyed by short-side resolution. */
  AYT.QUALITY_IDS = Object.freeze({
    4320: 'highres',
    2880: 'hd2880',
    2160: 'hd2160',
    1440: 'hd1440',
    1080: 'hd1080',
    720: 'hd720',
    480: 'large',
    360: 'medium',
    240: 'small',
    144: 'tiny',
  });

  AYT.MP3_BITRATES = Object.freeze([320, 256, 192, 160, 128, 96, 64]);
  AYT.RECOMMENDED_MP3_BITRATE = 192;

  /**
   * MIME types for browser-side downloads. Chrome RENAMES the file when the MIME type disagrees with the
   * extension (text/plain + .srt is saved as .txt), so these exact types must be used.
   */
  AYT.DOWNLOAD_MIME = Object.freeze({
    srt: 'application/x-subrip',
    vtt: 'text/vtt',
    ttml: 'application/ttml+xml',
    srv3: 'application/octet-stream',
    json3: 'application/octet-stream',
    txt: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    json: 'application/json',
  });
})(globalThis);
