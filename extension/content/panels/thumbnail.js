/*
 * Akif's Special YouTube Addon — thumbnail panel (owner: MEDIA).
 *
 * Also defines AYT.media: small helpers shared by the MEDIA panels (thumbnail.js is loaded before
 * subtitles.js and screenshot.js, see manifest.json):
 *   AYT.media.withTimeout(promise, ms, code)       reject with { code } when a promise takes too long
 *   AYT.media.errorText(err)                       friendly message for an error (with .code)
 *   AYT.media.fileInfo(videoId, info?)             { title, id, author, date } for AYT.util.buildFilename
 *   AYT.media.filename(fileInfo, ext, suffix)      file name following settings.filenameStyle
 *   AYT.media.saveText(text, mime, filename, kind) DOWNLOAD_DATA, falls back to an <a download> in the page
 *   AYT.media.saveBlob(blob, filename, kind)       blob URL + DOWNLOAD_URL, falls back to <a download>
 *   AYT.media.saveUrl(url, filename, {convert})    ytimg URL via DOWNLOAD_URL, falls back to fetch + <a download>
 *   AYT.media.fetchImage(url, convert)             Blob of an i.ytimg.com image (FETCH_IMAGE, falls back to fetch)
 *   AYT.media.copyText(text) / copyImage(blobOrPromise)
 *   AYT.media.statusLine()                         { el, busy(text), success(text), error(text), clear() }
 *
 * Thumbnails: AYT.thumbnails.probe(videoId) -> [{ key, url, width, height, bytes, format }] (largest first).
 * Uses the service worker's THUMB_PROBE when available and an in-page <img> probe otherwise; it always adds
 * the "original aspect ratio" candidates (oar2/oardefault: 1920x1080 or vertical 1080x1920 for Shorts).
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || AYT.thumbnails) return;
  const { h, icon, clear } = AYT.dom;
  const t = (k, p) => AYT.t(k, p);
  const U = AYT.util;

  /* ================================================================== AYT.media helpers */

  const IMAGE_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  const REVOKE_AFTER_MS = 60000;

  function codedError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  /** Rejects with an Error({ code }) when `promise` does not settle within `ms`. */
  function withTimeout(promise, ms, code) {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(codedError(t('media.err.timeout'), code || 'timeout')), ms);
    });
    return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), timeout]);
  }

  /** Friendly text for an error coming from the bridge, the service worker or the browser. */
  function errorText(err) {
    const code = err && err.code;
    const name = err && err.name;
    if (code === 'invalidated') return t('toolbar.invalidated');
    if (code === 'timeout') return t('media.err.timeout');
    if (code === 'clipboard' || name === 'NotAllowedError' || name === 'SecurityError') return t('media.err.clipboard');
    const msg = err && (err.message || (typeof err === 'string' ? err : ''));
    return msg ? String(msg) : t('common.error');
  }

  function domTitle() {
    const s = String(document.title || '')
      .replace(/^\(\d+\+?\)\s*/, '')
      .replace(/\s*-\s*YouTube\s*$/, '')
      .trim();
    return s && s !== 'YouTube' ? s : '';
  }

  /** { title, id, author, date } for file names; never rejects. */
  async function fileInfo(videoId, knownInfo) {
    let info = knownInfo && knownInfo.videoId === videoId ? knownInfo : AYT.videoInfo.peek(videoId);
    if (!info) {
      try {
        info = await withTimeout(AYT.videoInfo.get(videoId), 4000);
      } catch (_) {
        info = null;
      }
    }
    if (info && info.videoId === videoId) {
      return { title: info.title || videoId, id: videoId, author: info.author || '', date: info.uploadDate || info.publishDate || '' };
    }
    const fromDom = AYT.page.videoId === videoId ? domTitle() : '';
    return { title: fromDom || videoId, id: videoId, author: '', date: '' };
  }

  function filename(fi, ext, suffix) {
    let style = 'title';
    try {
      style = AYT.settings.get('filenameStyle') || 'title';
    } catch (_) {
      /* settings not loaded */
    }
    return U.buildFilename(style, fi, ext, suffix);
  }

  /** Saves through a detached <a download> (not attached to the page, so YouTube's click router never sees it). */
  function anchorDownload(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.click();
  }

  /** With "Ask where to save" the service worker may wait for the Save As dialog: allow much more time. */
  function asksWhereToSave() {
    try {
      return !!AYT.settings.get('askWhereToSave');
    } catch (_) {
      return false;
    }
  }
  const downloadTimeout = () => (asksWhereToSave() ? 10 * 60000 : 30000);
  const revokeDelay = () => (asksWhereToSave() ? 10 * 60000 : REVOKE_AFTER_MS);

  function anchorSaveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    anchorDownload(url, name);
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }

  /**
   * Sends a download request to the service worker; on failure runs `fallback()` (save from the page).
   * No fallback after a timeout (the extension may still finish: no duplicate files) or when the extension
   * was reloaded.
   */
  async function viaExtension(type, payload, fallback) {
    try {
      const res = await withTimeout(AYT.client.send(type, payload), downloadTimeout());
      return { via: 'extension', downloadId: res.downloadId };
    } catch (e) {
      if (e && (e.code === 'invalidated' || e.code === 'timeout')) throw e;
      console.warn('[AYT] ' + type + ' through the extension failed, saving from the page instead:', (e && e.message) || e);
      await fallback();
      return { via: 'page' };
    }
  }

  /** Text file via DOWNLOAD_DATA (service worker: subfolder + Save As setting); page fallback. */
  function saveText(text, mime, name, kind) {
    return viaExtension(AYT.MSG.DOWNLOAD_DATA, { text, mime, filename: name, kind: kind || 'file' }, () =>
      anchorSaveBlob(new Blob([text], { type: mime || 'application/octet-stream' }), name)
    );
  }

  /** Blob via a blob: URL + DOWNLOAD_URL (no data-URL size limits); page fallback. The URL is revoked later. */
  function saveBlob(blob, name, kind) {
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), revokeDelay());
    return viaExtension(AYT.MSG.DOWNLOAD_URL, { url, filename: name, kind: kind || 'file' }, () => anchorDownload(url, name));
  }

  function canvasToBlob(canvas, mime, quality, timeoutMs) {
    return withTimeout(
      new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(codedError(t('media.err.encode'), 'encode'))), mime, quality);
      }),
      timeoutMs || 30000,
      'encode'
    );
  }

  /** Re-encodes an image blob as jpg/png/webp in the page (canvas). */
  async function convertImage(blob, fmt, quality) {
    const mime = IMAGE_MIME[fmt];
    if (!mime || blob.type === mime) return blob;
    const bmp = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const c2d = canvas.getContext('2d');
      if (fmt === 'jpg') {
        c2d.fillStyle = '#fff';
        c2d.fillRect(0, 0, canvas.width, canvas.height);
      }
      c2d.drawImage(bmp, 0, 0);
      return await canvasToBlob(canvas, mime, quality == null ? 0.95 : quality);
    } finally {
      if (bmp.close) bmp.close();
    }
  }

  function isThumbUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && /(^|\.)ytimg\.com$/.test(u.hostname);
    } catch (_) {
      return false;
    }
  }

  async function fetchImageInPage(url, convert) {
    if (!isThumbUrl(url)) throw codedError(t('media.err.badUrl'), 'bad_url');
    const res = await withTimeout(fetch(url, { credentials: 'omit' }), 20000);
    if (!res.ok) throw codedError(t('media.err.http', { status: res.status }), 'http');
    const blob = await res.blob();
    return convert ? convertImage(blob, convert) : blob;
  }

  /** Blob of a thumbnail (optionally converted): FETCH_IMAGE through the service worker, page fallback. */
  async function fetchImage(url, convert) {
    try {
      const res = await withTimeout(AYT.client.send(AYT.MSG.FETCH_IMAGE, { url, convert: convert || undefined }), 20000);
      if (!res || typeof res.dataUrl !== 'string' || !/^data:image\//.test(res.dataUrl)) throw codedError('Bad FETCH_IMAGE answer', 'bad_answer');
      const blob = U.dataUrlToBlob(res.dataUrl);
      return convert && blob.type !== IMAGE_MIME[convert] ? convertImage(blob, convert) : blob;
    } catch (e) {
      if (e && e.code === 'invalidated') throw e;
      return fetchImageInPage(url, convert);
    }
  }

  /** ytimg URL via DOWNLOAD_URL (the service worker converts when asked); page fallback. */
  function saveUrl(url, name, opts) {
    const o = opts || {};
    return viaExtension(AYT.MSG.DOWNLOAD_URL, { url, filename: name, convert: o.convert || undefined, kind: o.kind || 'file' }, async () =>
      anchorSaveBlob(await fetchImageInPage(url, o.convert), name)
    );
  }

  function deepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  /**
   * Copies text (async clipboard API, execCommand fallback). Accepts a string or a Promise<string>: with a
   * promise the clipboard write starts right away (inside the click's user activation).
   */
  async function copyText(textOrPromise) {
    if (typeof textOrPromise !== 'string' && navigator.clipboard && typeof g.ClipboardItem === 'function') {
      let sourceError = null;
      const blob = Promise.resolve(textOrPromise).then(
        (s) => new Blob([String(s)], { type: 'text/plain' }),
        (e) => {
          sourceError = e;
          throw e;
        }
      );
      try {
        await navigator.clipboard.write([new g.ClipboardItem({ 'text/plain': blob })]);
        return;
      } catch (e) {
        if (sourceError) throw sourceError;
        /* fall back to writeText / execCommand below */
      }
    }
    const text = String(await textOrPromise);
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e) {
      const prev = deepActiveElement();
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      (document.body || document.documentElement).appendChild(ta);
      let ok = false;
      try {
        ta.select();
        ok = document.execCommand('copy');
      } catch (_) {
        ok = false;
      } finally {
        ta.remove();
        if (prev && typeof prev.focus === 'function') {
          try {
            prev.focus({ preventScroll: true });
          } catch (_) {
            /* ignore */
          }
        }
      }
      if (!ok) throw codedError(t('media.err.clipboard'), 'clipboard');
    }
  }

  /**
   * Copies an image (PNG on the clipboard). Accepts a Blob or a Promise<Blob>: call it synchronously from a
   * click handler and pass the promise so the user activation is used before the image is ready.
   */
  async function copyImage(blobOrPromise) {
    if (!navigator.clipboard || typeof g.ClipboardItem !== 'function') throw codedError(t('media.err.clipboard'), 'clipboard');
    let sourceError = null;
    const png = Promise.resolve(blobOrPromise)
      .then((b) => (b.type === 'image/png' ? b : convertImage(b, 'png')))
      .catch((e) => {
        sourceError = e;
        throw e;
      });
    try {
      await navigator.clipboard.write([new g.ClipboardItem({ 'image/png': png })]);
    } catch (e) {
      throw sourceError || e;
    }
  }

  /** One-line status area: spinner + text, green success, red error. */
  function statusLine() {
    const el = h('div', { class: 'ayt-media-status', role: 'status', 'aria-live': 'polite' });
    const set = (kind, iconEl, text) => {
      clear(el);
      el.dataset.kind = kind;
      if (iconEl) el.appendChild(iconEl);
      el.appendChild(h('span', { class: 'ayt-media-status__text' }, text));
    };
    return {
      el,
      busy: (text) => set('busy', AYT.ui.spinner(), text),
      success: (text) => set('success', icon('check-circle', { size: 18 }), text),
      error: (text) => set('error', icon('warning', { size: 18 }), text),
      clear: () => {
        clear(el);
        delete el.dataset.kind;
      },
    };
  }

  AYT.media = {
    IMAGE_MIME,
    codedError,
    withTimeout,
    errorText,
    fileInfo,
    filename,
    saveText,
    saveBlob,
    saveUrl,
    fetchImage,
    convertImage,
    canvasToBlob,
    anchorDownload,
    copyText,
    copyImage,
    statusLine,
  };

  AYT.ui.addStyles(`
.ayt-media-status { display: flex; align-items: center; gap: 8px; min-height: 20px; font: 500 13px/1.4 var(--ayt-font); color: var(--ayt-text-2); }
.ayt-media-status:empty { display: none; }
.ayt-media-status .ayt-spinner { width: 16px; height: 16px; }
.ayt-media-status[data-kind="success"] { color: #2fd06b; }
.ayt-media-status[data-kind="error"] { color: #ff6b6b; }
.ayt-root[data-theme="light"] .ayt-media-status[data-kind="success"], :host([data-theme="light"]) .ayt-media-status[data-kind="success"] { color: #12803a; }
.ayt-root[data-theme="light"] .ayt-media-status[data-kind="error"], :host([data-theme="light"]) .ayt-media-status[data-kind="error"] { color: #c81e1e; }
.ayt-media-status__text { min-width: 0; overflow-wrap: anywhere; }
.ayt-media-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.ayt-media-actions > .ayt-btn--primary { flex: 1 1 auto; }
`);

  /* ================================================================== thumbnails */

  /** Probe candidates (spec §9.3) in preference order. */
  const SPEC_CANDIDATES = [
    ['maxresdefault', 'jpg'],
    ['hq720', 'jpg'],
    ['sddefault', 'jpg'],
    ['hqdefault', 'jpg'],
    ['mqdefault', 'jpg'],
    ['default', 'jpg'],
    ['maxresdefault', 'webp'],
    ['sddefault', 'webp'],
    ['hqdefault', 'webp'],
  ];
  /** "Original aspect ratio" thumbnails: oar2 is the full-size frame (1920x1080, or 1080x1920 for Shorts). */
  const EXTRA_CANDIDATES = [
    ['oar2', 'jpg'],
    ['oardefault', 'jpg'],
  ];
  const ORDER = SPEC_CANDIDATES.concat(EXTRA_CANDIDATES).map(([k, f]) => k + '.' + f);
  const PROBE_TTL = 10 * 60 * 1000;
  const probeCache = new Map(); // videoId -> { items, at }

  function candidateUrl(videoId, key, fmt) {
    return fmt === 'webp' ? `https://i.ytimg.com/vi_webp/${videoId}/${key}.webp` : `https://i.ytimg.com/vi/${videoId}/${key}.jpg`;
  }

  /** Natural size of an image URL (null on error/timeout). Missing thumbnails load a 120x90 placeholder. */
  function imageSize(url, timeoutMs) {
    return new Promise((resolve) => {
      const img = new Image();
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve(v);
      };
      const timer = setTimeout(() => {
        img.src = '';
        finish(null);
      }, timeoutMs || 8000);
      img.onload = () => finish(img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
      img.onerror = () => finish(null);
      img.decoding = 'async';
      img.src = url;
    });
  }

  async function probeCandidates(videoId, list) {
    const found = await Promise.all(
      list.map(async ([key, format]) => {
        const url = candidateUrl(videoId, key, format);
        const size = await imageSize(url);
        return size ? { key, url, width: size.width, height: size.height, bytes: null, format } : null;
      })
    );
    return found.filter(Boolean);
  }

  /** Validates an item coming from the service worker (or anywhere else). */
  function cleanItem(it, videoId) {
    if (!it || typeof it.url !== 'string') return null;
    let u;
    try {
      u = new URL(it.url);
    } catch (_) {
      return null;
    }
    if (u.protocol !== 'https:' || !/(^|\.)ytimg\.com$/.test(u.hostname) || u.pathname.indexOf('/' + videoId + '/') === -1) return null;
    const width = Math.round(Number(it.width));
    const height = Math.round(Number(it.height));
    if (!(width > 0 && height > 0 && width <= 10000 && height <= 10000)) return null;
    const file = u.pathname.split('/').pop() || '';
    const format = it.format === 'webp' || /\.webp$/i.test(file) ? 'webp' : 'jpg';
    const key = /^[a-z0-9_]{1,24}$/i.test(String(it.key || '')) ? String(it.key) : file.replace(/\.\w+$/, '');
    const bytes = Number(it.bytes);
    return { key, url: u.href, width, height, bytes: bytes > 0 ? bytes : null, format };
  }

  /** Drops placeholders, sorts by pixels (largest first) and keeps one item per size (jpg preferred). */
  function finalize(items) {
    const rank = (it) => {
      const i = ORDER.indexOf(it.key + '.' + it.format);
      return i === -1 ? 99 : i;
    };
    const sorted = items
      .filter((it) => !(it.width === 120 && it.height === 90 && it.key !== 'default'))
      .sort((a, b) => b.width * b.height - a.width * a.height || (a.format === 'jpg' ? 0 : 1) - (b.format === 'jpg' ? 0 : 1) || rank(a) - rank(b));
    const seen = new Set();
    return sorted.filter((it) => {
      const k = it.width + 'x' + it.height;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /**
   * Available thumbnails for a video, largest first. Never rejects (returns [] when nothing loads).
   * opts.force: ignore the cache. opts.inPageOnly: skip THUMB_PROBE (tests).
   */
  async function probe(videoId, opts) {
    const o = opts || {};
    const cached = probeCache.get(videoId);
    if (!o.force && cached && Date.now() - cached.at < PROBE_TTL) return cached.items.slice();
    const extra = probeCandidates(videoId, EXTRA_CANDIDATES);
    let base = null;
    if (!o.inPageOnly) {
      try {
        const res = await withTimeout(AYT.client.send(AYT.MSG.THUMB_PROBE, { videoId }), 9000);
        base = (Array.isArray(res && res.items) ? res.items : []).map((it) => cleanItem(it, videoId)).filter(Boolean);
        if (!base.length) base = null;
      } catch (e) {
        if (e && e.code === 'invalidated') throw e;
        base = null;
      }
    }
    if (!base) base = await probeCandidates(videoId, SPEC_CANDIDATES);
    const items = finalize(base.concat(await extra));
    if (items.length) probeCache.set(videoId, { items, at: Date.now() });
    return items.slice();
  }

  function qualityName(it) {
    switch (it.key) {
      case 'oar2':
      case 'oardefault':
        return t('thumbnail.qualityOriginalAspect');
      case 'maxresdefault':
      case 'hq720':
        return t('thumbnail.qualityMax');
      case 'sddefault':
        return t('thumbnail.qualityStandard');
      case 'hqdefault':
        return t('thumbnail.qualityHigh');
      case 'mqdefault':
        return t('thumbnail.qualityMedium');
      case 'default':
        return t('thumbnail.qualitySmall');
      default:
        if (it.width >= 1280) return t('thumbnail.qualityMax');
        if (it.width >= 640) return t('thumbnail.qualityStandard');
        if (it.width >= 480) return t('thumbnail.qualityHigh');
        if (it.width >= 320) return t('thumbnail.qualityMedium');
        return t('thumbnail.qualitySmall');
    }
  }

  const dims = (it) => it.width + '×' + it.height;
  const FORMAT_LABEL = { jpg: 'JPG', png: 'PNG', webp: 'WebP' };

  AYT.thumbnails = { probe, finalize, cleanItem, candidateUrl, SPEC_CANDIDATES, EXTRA_CANDIDATES };

  AYT.ui.addStyles(`
.ayt-thumb { display: flex; flex-direction: column; gap: 14px; }
.ayt-thumb__preview {
  position: relative; aspect-ratio: 16 / 9; width: 100%; overflow: hidden;
  border-radius: 12px; background: #0b0b0d; border: 1px solid var(--ayt-border);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .25);
}
.ayt-thumb__img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; transition: filter .25s var(--ayt-ease), opacity .25s; }
.ayt-thumb__preview.is-loading .ayt-thumb__img { filter: blur(8px) saturate(1.15); opacity: .75; }
.ayt-thumb__preview .ayt-spinner { position: absolute; left: calc(50% - 15px); top: calc(50% - 15px); width: 30px; height: 30px; border-width: 3px; }
.ayt-thumb__preview:not(.is-loading) .ayt-spinner { display: none; }
.ayt-thumb__dims {
  position: absolute; right: 8px; bottom: 8px; padding: 4px 8px; border-radius: 7px;
  background: rgba(0, 0, 0, .72); color: #fff; font: 600 12px/1 var(--ayt-font); font-variant-numeric: tabular-nums;
  letter-spacing: .2px; pointer-events: none;
}
.ayt-thumb__dims:empty { display: none; }
.ayt-thumb__broken { position: absolute; inset: 0; display: grid; place-items: center; color: #8a8a94; }
.ayt-thumb__preview:not(.is-broken) .ayt-thumb__broken { display: none; }
.ayt-thumb__meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font: 400 12px/1.4 var(--ayt-font); color: var(--ayt-text-3); }
.ayt-thumb__meta .ayt-badge { text-transform: none; }
.ayt-thumb .ayt-seg { align-self: flex-start; }
`);

  /** Panel = a view that is rebuilt when the UI language changes. */
  function renderPanel(ctx) {
    const holder = h('div');
    let videoId = ctx.videoId;
    let view = buildView(ctx, videoId);
    holder.appendChild(view.el);
    const offLang = AYT.i18n.onChange(() => {
      view.destroy();
      view = buildView(ctx, videoId);
      clear(holder);
      holder.appendChild(view.el);
    });
    return {
      el: holder,
      onVideoChange(pageInfo) {
        if (pageInfo && pageInfo.videoId) videoId = pageInfo.videoId;
        view.onVideoChange(pageInfo);
      },
      destroy() {
        offLang();
        view.destroy();
      },
    };
  }

  function buildView(ctx, initialVideoId) {
    let videoId = initialVideoId;
    let gen = 0;
    let items = [];
    let selected = null;
    let info = null;
    let destroyed = false;
    const offs = [];

    const status = statusLine();
    const img = h('img', { class: 'ayt-thumb__img', alt: '', decoding: 'async', draggable: false });
    const dimsEl = h('span', { class: 'ayt-thumb__dims' });
    const preview = h(
      'div',
      { class: 'ayt-thumb__preview is-loading' },
      img,
      h('div', { class: 'ayt-thumb__broken', 'aria-hidden': 'true' }, icon('image', { size: 36, strokeWidth: 1.5 })),
      AYT.ui.spinner(),
      dimsEl
    );
    let placeholderShown = false; // the low-res image shown while probing stays blurred
    img.addEventListener('load', () => {
      preview.classList.remove('is-broken');
      if (!placeholderShown) preview.classList.remove('is-loading');
    });
    img.addEventListener('error', () => {
      if (!img.getAttribute('src')) return;
      preview.classList.add('is-broken');
      preview.classList.remove('is-loading');
    });

    const quality = AYT.ui.select({ options: [], ariaLabel: t('common.quality'), onChange: (v) => choose(Number(v)) });
    quality.disabled = true;
    const metaEl = h('div', { class: 'ayt-thumb__meta' });

    const currentFormat = () => {
      const f = AYT.settings.get('thumbnailFormat');
      return ['original', 'jpg', 'png', 'webp'].includes(f) ? f : 'original';
    };
    const format = AYT.ui.segmented({
      options: [
        { value: 'original', label: t('thumbnail.formatOriginal'), title: t('thumbnail.formatOriginalHint') },
        { value: 'jpg', label: 'JPG' },
        { value: 'png', label: 'PNG' },
        { value: 'webp', label: 'WebP' },
      ],
      value: currentFormat(),
      ariaLabel: t('common.format'),
      onChange: (v) => {
        AYT.settings.set('thumbnailFormat', v).catch(() => {});
        updateDetails();
      },
    });

    const downloadBtn = AYT.ui.button({ label: t('common.download'), icon: 'download', variant: 'primary', disabled: true, onClick: () => onDownload() });
    const copyBtn = AYT.ui.button({ label: t('common.copy'), icon: 'copy', disabled: true, title: t('thumbnail.copyHint'), onClick: () => onCopy() });
    const openBtn = AYT.ui.button({ label: t('common.open'), icon: 'external', variant: 'ghost', disabled: true, title: t('thumbnail.openHint'), onClick: () => onOpen() });

    const controls = h(
      'div',
      { class: 'ayt-col' },
      AYT.ui.field(t('common.quality'), quality.el),
      AYT.ui.field(t('common.format'), format.el, metaEl)
    );
    const body = h('div', { class: 'ayt-thumb' }, preview, controls, h('div', { class: 'ayt-media-actions' }, downloadBtn, copyBtn, openBtn), status.el);
    const root = h('div', null, body);

    function targetFormat() {
      const f = format.value;
      return f === 'original' || !IMAGE_MIME[f] ? (selected ? selected.format : 'jpg') : f;
    }

    function setButtons(enabled) {
      downloadBtn.disabled = copyBtn.disabled = openBtn.disabled = !enabled;
      quality.disabled = !enabled || items.length < 2;
    }

    function updateDetails() {
      clear(metaEl);
      const fmt = targetFormat();
      const label = downloadBtn.querySelector('span');
      if (label) label.textContent = t('media.downloadAs', { format: FORMAT_LABEL[fmt] || fmt.toUpperCase() });
      if (!selected) return;
      const parts = [FORMAT_LABEL[selected.format] || selected.format, dims(selected)];
      if (selected.bytes) parts.push(U.formatBytes(selected.bytes));
      metaEl.appendChild(h('span', null, t('thumbnail.sourceFile', { details: parts.join(' · ') })));
      if (fmt !== selected.format) metaEl.appendChild(AYT.ui.badge(t('thumbnail.convertTo', { format: FORMAT_LABEL[fmt] }), 'soft'));
    }

    /** Shows `url`; the blur + spinner stay until it has loaded (and while `placeholder` is set). */
    function showPreview(url, placeholder) {
      placeholderShown = !!placeholder;
      if (img.getAttribute('src') === url) {
        if (!placeholder && img.complete && img.naturalWidth) preview.classList.remove('is-loading');
        return;
      }
      preview.classList.add('is-loading');
      preview.classList.remove('is-broken');
      img.src = url;
    }

    function choose(index) {
      selected = items[index] || items[0] || null;
      if (!selected) return;
      showPreview(selected.url, false);
      img.alt = t('thumbnail.previewAlt', { size: dims(selected) });
      dimsEl.textContent = dims(selected);
      updateDetails();
    }

    function showEmpty(my) {
      if (my !== gen) return;
      clear(root);
      root.appendChild(
        AYT.ui.notice({
          kind: 'warn',
          title: t('thumbnail.none'),
          text: t('thumbnail.noneHint'),
          actions: [{ label: t('common.retry'), icon: 'refresh', onClick: () => load(true) }],
        })
      );
    }

    async function load(force) {
      const my = ++gen;
      items = [];
      selected = null;
      if (!root.contains(body)) {
        clear(root);
        root.appendChild(body);
      }
      status.clear();
      setButtons(false);
      quality.setOptions([{ value: '', label: t('thumbnail.searching') }], '');
      dimsEl.textContent = '';
      clear(metaEl);
      // Instant low-res preview while the sizes are probed (mqdefault exists for every video).
      showPreview(candidateUrl(videoId, 'mqdefault', 'jpg'), true);
      const vid = videoId;
      (vid === ctx.videoId ? ctx.getInfo() : AYT.videoInfo.get(vid)).then(
        (i) => {
          if (my === gen) info = i;
        },
        () => {}
      );
      let found = [];
      try {
        found = await probe(vid, { force: !!force });
      } catch (e) {
        if (my !== gen || destroyed) return;
        status.error(errorText(e));
        return;
      }
      if (my !== gen || destroyed) return;
      if (!found.length) return showEmpty(my);
      items = found;
      quality.setOptions(
        items.map((it, i) => ({ value: String(i), label: t('thumbnail.qualityOption', { name: qualityName(it), size: dims(it) }) })),
        '0'
      );
      setButtons(true);
      choose(0);
    }

    async function onDownload() {
      if (!selected) return;
      const item = selected;
      const fmt = targetFormat();
      const convert = fmt !== item.format ? fmt : undefined;
      const my = gen;
      downloadBtn.disabled = true;
      status.busy(t('thumbnail.preparing'));
      try {
        const fi = await fileInfo(videoId, info);
        const name = filename(fi, fmt, item.width + 'x' + item.height);
        await saveUrl(item.url, name, { convert, kind: 'thumbnail' });
        if (my === gen && !destroyed) status.success(t('media.downloadStarted'));
      } catch (e) {
        if (my === gen && !destroyed) status.error(t('thumbnail.downloadFailed', { message: errorText(e) }));
      } finally {
        if (my === gen && !destroyed) downloadBtn.disabled = false;
      }
    }

    function onCopy() {
      if (!selected) return;
      const my = gen;
      status.busy(t('thumbnail.copying'));
      // Start the clipboard write synchronously (user activation), the PNG arrives later.
      copyImage(fetchImage(selected.url, 'png')).then(
        () => {
          if (my === gen && !destroyed) status.success(t('thumbnail.copied'));
        },
        (e) => {
          if (my === gen && !destroyed) status.error(t('thumbnail.copyFailed', { message: errorText(e) }));
        }
      );
    }

    function onOpen() {
      if (!selected || !isThumbUrl(selected.url)) return;
      window.open(selected.url, '_blank', 'noopener');
    }

    offs.push(
      AYT.settings.onChange((c) => {
        if ('thumbnailFormat' in c && format.value !== c.thumbnailFormat) {
          format.value = currentFormat();
          updateDetails();
        }
      })
    );

    load(false);

    return {
      el: root,
      onVideoChange(pageInfo) {
        if (!pageInfo || !pageInfo.videoId || pageInfo.videoId === videoId) return;
        videoId = pageInfo.videoId;
        info = null;
        load(false);
      },
      destroy() {
        destroyed = true;
        gen++;
        offs.forEach((off) => off());
        offs.length = 0;
        img.removeAttribute('src');
      },
    };
  }

  AYT.toolbar.register({
    id: 'thumbnail',
    order: 30,
    group: 'download',
    icon: 'image',
    title: () => t('toolbar.thumbnail'),
    panelTitle: () => t('toolbar.thumbnail'),
    surfaces: ['watch', 'shorts'],
    panel: { width: 440, render: renderPanel },
  });
})(globalThis);
