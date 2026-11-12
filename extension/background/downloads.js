/*
 * Akif's Special YouTube Addon — browser-side downloads + image helpers (owner: BACKGROUND, spec §7.4, §9.3).
 *
 *   AYT.downloads.downloadData(msg)          DOWNLOAD_DATA { dataUrl | (text, mime), filename, kind } -> { downloadId }
 *   AYT.downloads.downloadUrl(msg, sender)   DOWNLOAD_URL  { url, filename, convert?, kind }          -> { downloadId }
 *   AYT.downloads.fetchImage(msg, sender)    FETCH_IMAGE   { url, convert? } -> { dataUrl, mime, width, height, bytes }
 *   AYT.downloads.thumbProbe(msg)            THUMB_PROBE   { videoId } -> { items: [{ key, url, width, height, bytes, format }] }
 *
 * Only https://*.ytimg.com/ URLs and blob:https://www.youtube.com/<uuid> URLs (created by our content script) are
 * fetched or downloaded. Data URLs always get the MIME type of AYT.DOWNLOAD_MIME[ext] because Chrome renames files
 * whose extension disagrees with the MIME type (.srt saved as text/plain becomes .txt). Image blob URLs are
 * downloaded directly (no size limit); other allowed blob types are re-wrapped with the right MIME type.
 * Only the extensions listed in AYT.DOWNLOAD_MIME can be saved (no executables, shortcuts or HTML).
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  const U = AYT.util;
  const t = (key, params) => AYT.t(key, params);
  const E = (code, message, extra) => AYT.bg.error(code, message, extra);

  const config = {
    fetchTimeoutMs: 20000,
    probeTimeoutMs: 6000, // all candidates run in parallel; callers give THUMB_PROBE ~9 s

    thumbTtlMs: 10 * 60 * 1000,
    thumbCacheMax: 60,
  };
  const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
  const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' };
  const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
  const MAX_TEXT_CHARS = AYT.LIMITS.MAX_DATA_URL_BYTES;
  const MAX_DATA_URL_CHARS = Math.ceil(AYT.LIMITS.MAX_DATA_URL_BYTES * 1.4) + 1024;
  const BLOB_RE = /^blob:https:\/\/www\.youtube\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const JPG_KEYS = ['maxresdefault', 'hq720', 'sddefault', 'hqdefault', 'mqdefault', 'default'];
  const WEBP_KEYS = ['maxresdefault', 'sddefault', 'hqdefault'];

  /* ------------------------------------------------------------------ validation */

  /**
   * Accepts only https://*.ytimg.com/... or blob:https://www.youtube.com/<uuid> (the latter only from our content
   * script on www.youtube.com). Returns { kind: 'ytimg'|'blob', url }.
   */
  function checkUrl(raw, sender) {
    if (typeof raw !== 'string' || !raw || raw.length > 4096) throw E('bad_url', t('background.err.badUrl'));
    if (raw.startsWith('blob:')) {
      if (BLOB_RE.test(raw) && (!sender || AYT.bg.isYouTubeSender(sender))) return { kind: 'blob', url: raw };
      throw E('bad_url', t('background.err.badUrl'));
    }
    let u;
    try {
      u = new URL(raw);
    } catch (_) {
      throw E('bad_url', t('background.err.badUrl'));
    }
    const host = u.hostname.toLowerCase();
    if (u.protocol === 'https:' && (host === 'ytimg.com' || host.endsWith('.ytimg.com')) && !u.username && !u.password && (u.port === '' || u.port === '443')) {
      return { kind: 'ytimg', url: u.href };
    }
    throw E('bad_url', t('background.err.badUrl'));
  }

  function checkConvert(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !IMAGE_MIME[v]) throw E('bad_request', t('background.err.badRequest'));
    return v;
  }

  /** 'Title (en).srt' -> { base: 'Title (en)', ext: 'srt' }. Only the last path segment counts. */
  function splitName(filename) {
    if (typeof filename !== 'string' || !filename.trim() || filename.length > 1024) throw E('bad_filename', t('background.err.badFilename'));
    const name = filename.split(/[\\/]/).pop();
    const i = name.lastIndexOf('.');
    if (i > 0 && /^[A-Za-z0-9]{1,8}$/.test(name.slice(i + 1))) {
      let ext = name.slice(i + 1).toLowerCase();
      if (ext === 'jpeg') ext = 'jpg';
      return { base: name.slice(0, i), ext };
    }
    return { base: name, ext: '' };
  }

  function safeName(base, ext) {
    return U.sanitizeFilename(base, 150) + '.' + ext;
  }

  /** Replaces the MIME type of a data: URL (keeps the payload and a charset parameter). */
  function retagDataUrl(dataUrl, mime) {
    const comma = dataUrl.indexOf(',');
    if (!/^data:/i.test(dataUrl) || comma < 0 || comma > 512) throw E('bad_request', t('background.err.badRequest'));
    const header = dataUrl.slice(5, comma);
    const parts = header.split(';').map((p) => p.trim());
    const isBase64 = parts.some((p) => p.toLowerCase() === 'base64');
    const charset = parts.find((p) => /^charset=/i.test(p));
    return 'data:' + mime + (charset ? ';' + charset : '') + (isBase64 ? ';base64' : '') + dataUrl.slice(comma);
  }

  /* ------------------------------------------------------------------ chrome.downloads */

  /**
   * Starts a download into <Downloads>/<subfolder>/<name> (uniquified). Retries once without the subfolder
   * and with a plain name when Chrome rejects the file name.
   */
  async function startDownload(url, name) {
    const s = AYT.settings.all();
    const saveAs = !!s.askWhereToSave;
    const filename = U.downloadsPath(s.subfolder, name);
    try {
      const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs });
      if (typeof id !== 'number') throw new Error('no download id');
      return { downloadId: id, filename };
    } catch (e) {
      const message = String((e && e.message) || e);
      if (/filename/i.test(message)) {
        const ext = name.slice(name.lastIndexOf('.') + 1);
        const fallback = 'YouTube ' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.' + ext;
        try {
          const id = await chrome.downloads.download({ url, filename: fallback, conflictAction: 'uniquify', saveAs });
          if (typeof id === 'number') return { downloadId: id, filename: fallback };
        } catch (_) {
          /* fall through */
        }
      }
      throw E('download_failed', t('background.err.download', { message }), { detail: message });
    }
  }

  /** DOWNLOAD_DATA: subtitles, screenshots/thumbnails already encoded by the content script. */
  async function downloadData(msg) {
    const { base, ext } = splitName(msg.filename);
    const mime = AYT.DOWNLOAD_MIME[ext];
    if (!ext || !mime) throw E('bad_filename', t('background.err.badFileType', { ext: ext || '?' }));
    let url;
    if (typeof msg.dataUrl === 'string' && msg.dataUrl) {
      if (msg.dataUrl.length > MAX_DATA_URL_CHARS) throw E('too_large', t('background.err.tooLarge'));
      url = retagDataUrl(msg.dataUrl, mime);
    } else if (typeof msg.text === 'string') {
      if (msg.text.length > MAX_TEXT_CHARS) throw E('too_large', t('background.err.tooLarge'));
      url = U.textToDataUrl(msg.text, mime);
    } else {
      throw E('bad_request', t('background.err.badRequest'));
    }
    return startDownload(url, safeName(base, ext));
  }

  /* ------------------------------------------------------------------ fetching images */

  async function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { signal: ctrl.signal, credentials: 'omit', cache: 'default', redirect: 'follow' });
    } finally {
      clearTimeout(timer);
    }
  }

  function mimeOf(blob, res) {
    const fromBlob = String((blob && blob.type) || '').toLowerCase().split(';')[0].trim();
    if (MIME_EXT[fromBlob]) return fromBlob === 'image/jpg' ? 'image/jpeg' : fromBlob;
    const header = String((res && res.headers && res.headers.get('content-type')) || '').toLowerCase().split(';')[0].trim();
    return MIME_EXT[header] ? (header === 'image/jpg' ? 'image/jpeg' : header) : fromBlob || header || '';
  }

  /**
   * Fetches an allowed image URL, decodes it and optionally re-encodes it ('png'|'jpg'|'webp', quality 0.95).
   * @returns {Promise<{blob: Blob, mime: string, width: number, height: number}>}
   */
  async function loadImage(url, convert) {
    let res;
    try {
      res = await fetchWithTimeout(url, config.fetchTimeoutMs);
    } catch (e) {
      throw E('network', t('background.err.network'), { detail: String((e && e.message) || e) });
    }
    if (!res.ok) {
      AYT.bg.quiet(res.body && res.body.cancel && res.body.cancel());
      throw E(res.status === 404 ? 'not_found' : 'fetch_failed', t('background.err.fetch', { status: res.status }));
    }
    let blob = await res.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw E('too_large', t('background.err.tooLarge'));
    const mime = mimeOf(blob, res);
    if (mime && blob.type !== mime) blob = new Blob([blob], { type: mime });
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (e) {
      throw E('decode_failed', t('background.err.decode'));
    }
    const width = bitmap.width;
    const height = bitmap.height;
    if (!convert || IMAGE_MIME[convert] === mime) {
      bitmap.close();
      return { blob, mime, width, height };
    }
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (convert === 'jpg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(bitmap, 0, 0);
      const out = await canvas.convertToBlob({ type: IMAGE_MIME[convert], quality: 0.95 });
      return { blob: out, mime: out.type || IMAGE_MIME[convert], width, height };
    } catch (e) {
      throw E('convert_failed', t('background.err.convert'), { detail: String((e && e.message) || e) });
    } finally {
      bitmap.close();
    }
  }

  /** DOWNLOAD_URL: thumbnails (ytimg) and screenshots (page blob URLs), optionally converted. */
  async function downloadUrl(msg, sender) {
    const src = checkUrl(msg.url, sender);
    const convert = checkConvert(msg.convert);
    const { base, ext } = splitName(msg.filename);
    if (convert) {
      const img = await loadImage(src.url, convert);
      const outExt = MIME_EXT[img.mime] || convert;
      return startDownload(await U.blobToDataUrl(img.blob), safeName(base, outExt));
    }
    if (src.kind === 'ytimg') {
      // Fetch first: a missing size is a 404 with a placeholder image, which chrome.downloads would save as an
      // interrupted download. The real content type decides the extension (vi_webp -> .webp).
      const img = await loadImage(src.url, null);
      const outExt = MIME_EXT[img.mime] || (IMAGE_MIME[ext] ? ext : 'jpg');
      return startDownload(await U.blobToDataUrl(img.blob), safeName(base, outExt));
    }
    // Page blob URL. Images (screenshots): download directly, no size limit; the blob's type sets the MIME type.
    if (IMAGE_MIME[ext]) return startDownload(src.url, safeName(base, ext));
    // Other allowed types (subtitles, text): re-wrap with the MIME type that keeps the extension.
    const mime = AYT.DOWNLOAD_MIME[ext];
    if (!ext || !mime) throw E('bad_filename', t('background.err.badFileType', { ext: ext || '?' }));
    let res;
    try {
      res = await fetchWithTimeout(src.url, config.fetchTimeoutMs);
    } catch (e) {
      throw E('fetch_failed', t('background.err.fetch', { status: 0 }), { detail: String((e && e.message) || e) });
    }
    if (!res.ok) throw E('fetch_failed', t('background.err.fetch', { status: res.status }));
    const blob = await res.blob();
    if (blob.size > AYT.LIMITS.MAX_DATA_URL_BYTES) throw E('too_large', t('background.err.tooLarge'));
    return startDownload(await U.blobToDataUrl(new Blob([blob], { type: mime })), safeName(base, ext));
  }

  /** FETCH_IMAGE: { dataUrl, mime, width, height, bytes } (e.g. for copying a thumbnail as PNG). */
  async function fetchImage(msg, sender) {
    const src = checkUrl(msg.url, sender);
    const img = await loadImage(src.url, checkConvert(msg.convert));
    return { dataUrl: await U.blobToDataUrl(img.blob), mime: img.mime, width: img.width, height: img.height, bytes: img.blob.size };
  }

  /* ------------------------------------------------------------------ thumbnail probing (spec §9.3) */

  const thumbCache = new Map(); // videoId -> { at, promise }

  function thumbCandidates(videoId) {
    const jpg = JPG_KEYS.map((key, i) => ({ key, format: 'jpg', order: i, url: 'https://i.ytimg.com/vi/' + videoId + '/' + key + '.jpg' }));
    const webp = WEBP_KEYS.map((key, i) => ({ key, format: 'webp', order: 10 + i, url: 'https://i.ytimg.com/vi_webp/' + videoId + '/' + key + '.webp' }));
    return jpg.concat(webp);
  }

  async function probeOne(c) {
    let res;
    try {
      res = await fetchWithTimeout(c.url, config.probeTimeoutMs);
    } catch (e) {
      return Object.assign({}, c, { ok: false, networkError: true });
    }
    if (res.status !== 200) {
      AYT.bg.quiet(res.body && res.body.cancel && res.body.cancel());
      return Object.assign({}, c, { ok: false, status: res.status });
    }
    try {
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const r = Object.assign({}, c, { ok: true, status: 200, width: bitmap.width, height: bitmap.height, bytes: blob.size });
      bitmap.close();
      return r;
    } catch (e) {
      return Object.assign({}, c, { ok: false, status: 200, decodeError: true });
    }
  }

  /**
   * Picks the usable thumbnails from probe results: HTTP 200 + decoded; 120x90 placeholders are dropped (except
   * 'default' itself); sorted by pixels desc; de-duplicated by size, preferring jpg, then candidate order.
   * Pure function (unit-tested).
   */
  function selectThumbs(results) {
    const valid = (results || []).filter((r) => r && r.ok && r.width > 0 && r.height > 0 && !(r.width <= 120 && r.height <= 90 && r.key !== 'default'));
    valid.sort((a, b) => b.width * b.height - a.width * a.height || (a.format === 'jpg' ? 0 : 1) - (b.format === 'jpg' ? 0 : 1) || a.order - b.order);
    const sizes = new Set();
    const keys = new Set();
    const items = [];
    for (const r of valid) {
      const size = r.width + 'x' + r.height;
      if (sizes.has(size)) continue;
      sizes.add(size);
      const key = keys.has(r.key) ? r.key + '-' + r.format : r.key;
      keys.add(key);
      items.push({ key, url: r.url, width: r.width, height: r.height, bytes: r.bytes || 0, format: r.format });
    }
    return items;
  }

  async function runProbe(videoId) {
    const results = await Promise.all(thumbCandidates(videoId).map(probeOne));
    if (results.every((r) => r.networkError)) throw E('network', t('background.err.network'));
    return selectThumbs(results);
  }

  /** THUMB_PROBE with a 10-minute cache per video (failures are not cached; concurrent calls share one probe). */
  async function thumbProbe(msg) {
    const videoId = msg && msg.videoId;
    if (typeof videoId !== 'string' || !AYT.task.VIDEO_ID_RE.test(videoId)) throw E('bad_request', t('background.err.badRequest'));
    const now = Date.now();
    let entry = thumbCache.get(videoId);
    if (!entry || now - entry.at > config.thumbTtlMs) {
      entry = { at: now, promise: runProbe(videoId) };
      thumbCache.set(videoId, entry);
      const mine = entry;
      mine.promise.catch(() => {
        if (thumbCache.get(videoId) === mine) thumbCache.delete(videoId);
      });
      if (thumbCache.size > config.thumbCacheMax) {
        const oldest = Array.from(thumbCache.entries()).sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) thumbCache.delete(oldest[0]);
      }
    }
    const items = await entry.promise;
    return { items: items.map((it) => Object.assign({}, it)) };
  }

  AYT.downloads = {
    config,
    checkUrl,
    splitName,
    retagDataUrl,
    selectThumbs,
    thumbCandidates,
    downloadData,
    downloadUrl,
    fetchImage,
    thumbProbe,
    clearThumbCache: () => thumbCache.clear(),
  };
})(globalThis);
