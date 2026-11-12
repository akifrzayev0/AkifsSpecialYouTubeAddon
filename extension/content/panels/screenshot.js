/*
 * Akif's Special YouTube Addon — screenshot action (owner: MEDIA).
 *
 *   AYT.screenshot.capture(opts?) -> Promise<{ blob, width, height, filename, mime, ext, time, videoId, toPng() }>
 *       Grabs the current frame of the active <video> at its native resolution (videoWidth x videoHeight),
 *       applies AYT.videoAdjust (filters / rotation / flip) when present, encodes it per settings.
 *       opts: { format: 'png'|'jpg'|'webp', quality: 0.5..1, ignoreAdjust: boolean }
 *       Rejects with .code: no_video | ad | drm | not_ready | encode | timeout.
 *   AYT.screenshot.take(opts?) -> Promise<{ ok, shot?, saved?, copied?, error? }>   (never rejects)
 *       capture + save and/or copy (settings.screenshotAction, opts.copyOnly for Shift+click) + feedback
 *       (white flash over the player, toolbar flash, toast). Used by the toolbar button, the
 *       'take-screenshot' command and the Shorts popover.
 *
 * Verified (research, Nov 2026): the <video> canvas is not tainted; drawing right after a resolution switch
 * gives a black frame -> wait for one requestVideoFrameCallback (max 300 ms) while playing; during ads the
 * <video> shows the ad -> refuse.
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || AYT.screenshot || !AYT.media) return;
  const t = (k, p) => AYT.t(k, p);
  const U = AYT.util;
  const M = AYT.media;

  const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
  const FRAME_WAIT_MS = 300;
  const NO_ADJUST = Object.freeze({ filter: 'none', rotation: 0, flipH: false, flipV: false });

  function setting(name, fallback) {
    try {
      const v = AYT.settings.get(name);
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  /** Resolves after the next presented video frame (or right away when paused / unsupported / timeout). */
  function waitForFrame(video, timeoutMs) {
    return new Promise((resolve) => {
      if (video.paused || video.ended || typeof video.requestVideoFrameCallback !== 'function') {
        resolve(false);
        return;
      }
      let done = false;
      let handle = 0;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          video.cancelVideoFrameCallback(handle);
        } catch (_) {
          /* ignore */
        }
        resolve(false);
      }, timeoutMs);
      handle = video.requestVideoFrameCallback(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Current video adjustments from the TOOLS module (AYT.videoAdjust), validated. */
  function adjustments() {
    const va = AYT.videoAdjust;
    if (!va) return NO_ADJUST;
    try {
      if (typeof va.active === 'function' && !va.active()) return NO_ADJUST;
      const out = { filter: 'none', rotation: 0, flipH: false, flipV: false };
      const f = typeof va.canvasFilter === 'function' ? String(va.canvasFilter() || '').trim() : '';
      if (f && f.length < 400 && /^[a-z0-9\s().,%+-]+$/i.test(f)) out.filter = f;
      const r = typeof va.rotation === 'function' ? Number(va.rotation()) : 0;
      out.rotation = [0, 90, 180, 270].includes(r) ? r : 0;
      out.flipH = typeof va.flipH === 'function' && !!va.flipH();
      out.flipV = typeof va.flipV === 'function' && !!va.flipV();
      return out;
    } catch (e) {
      console.warn('[AYT] videoAdjust unavailable for the screenshot', e);
      return NO_ADJUST;
    }
  }

  function normalizeFormat(f) {
    const v = String(f || '').toLowerCase();
    if (v === 'jpeg') return 'jpg';
    return MIME[v] ? v : 'png';
  }

  /**
   * Captures the current frame. See the header comment for the result shape.
   * @param {{format?: string, quality?: number, ignoreAdjust?: boolean}} [opts]
   */
  async function capture(opts) {
    const o = opts || {};
    const videoId = AYT.page.videoId;
    if (!videoId) throw M.codedError(t('screenshot.noVideo'), 'no_video');
    if (AYT.player.isAdPlaying()) throw M.codedError(t('screenshot.adPlaying'), 'ad');
    // Protected (EME/DRM) video frames can't be read by a canvas: they would come out black.
    const known = AYT.videoInfo.peek(videoId);
    if (known && known.drm) throw M.codedError(t('screenshot.drm'), 'drm');
    const video = AYT.player.video();
    if (!video) throw M.codedError(t('screenshot.noVideo'), 'no_video');
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw M.codedError(t('screenshot.notReady'), 'not_ready');

    await waitForFrame(video, FRAME_WAIT_MS);
    if (AYT.player.isAdPlaying()) throw M.codedError(t('screenshot.adPlaying'), 'ad');
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) throw M.codedError(t('screenshot.notReady'), 'not_ready');
    const time = video.currentTime;

    const adj = o.ignoreAdjust ? NO_ADJUST : adjustments();
    const swap = adj.rotation === 90 || adj.rotation === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? vh : vw;
    canvas.height = swap ? vw : vh;
    const c2d = canvas.getContext('2d', { alpha: false });
    if (!c2d) throw M.codedError(t('media.err.encode'), 'encode');
    if (adj.filter !== 'none') c2d.filter = adj.filter;
    // Same order as the page CSS of content/tools/adjust.js, "scale(flipX, flipY) rotate(deg)": the frame is
    // rotated first, then flipped in screen space (canvas transforms apply to the drawing in reverse call order).
    c2d.translate(canvas.width / 2, canvas.height / 2);
    if (adj.flipH || adj.flipV) c2d.scale(adj.flipH ? -1 : 1, adj.flipV ? -1 : 1);
    if (adj.rotation) c2d.rotate((adj.rotation * Math.PI) / 180);
    c2d.drawImage(video, -vw / 2, -vh / 2, vw, vh);
    c2d.setTransform(1, 0, 0, 1, 0, 0);

    if (typeof o.onCaptured === 'function') {
      try {
        o.onCaptured();
      } catch (_) {
        /* feedback only */
      }
    }

    const ext = normalizeFormat(o.format || setting('screenshotFormat', 'png'));
    const quality = U.clamp(Number(o.quality != null ? o.quality : setting('screenshotQuality', 0.95)) || 0.95, 0.5, 1);
    const blob = await M.canvasToBlob(canvas, MIME[ext], ext === 'png' ? undefined : quality, 30000);
    const fi = await M.fileInfo(videoId);
    const stamp = U.formatClock(time, true).replace(/:/g, '-');
    const filename = M.filename(fi, ext, stamp);
    let png = ext === 'png' ? Promise.resolve(blob) : null;
    return {
      blob,
      width: canvas.width,
      height: canvas.height,
      filename,
      mime: MIME[ext],
      ext,
      time,
      videoId,
      /** PNG version (for the clipboard), encoded once on demand from the same frame. */
      toPng() {
        if (!png) png = M.canvasToBlob(canvas, 'image/png', undefined, 30000);
        return png;
      },
    };
  }

  /** Short white flash over the player (screenshot feedback). */
  function flash() {
    const root = AYT.player.root();
    if (!root) return;
    let reduce = false;
    try {
      reduce = g.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) {
      /* ignore */
    }
    const el = document.createElement('div');
    el.className = 'ayt-shot-flash';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText =
      'position:absolute;inset:0;z-index:2147483000;pointer-events:none;background:#fff;border-radius:inherit;' +
      'opacity:' + (reduce ? '0.3' : '0.85') + ';transition:opacity ' + (reduce ? '150ms' : '480ms') + ' ease-out;';
    root.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => (el.style.opacity = '0')));
    setTimeout(() => el.remove(), 800);
  }

  let inFlight = null;

  /**
   * Takes a screenshot with user feedback. Never rejects.
   * @param {{copyOnly?: boolean, action?: 'save'|'copy'|'both', format?: string, quality?: number, silent?: boolean}} [opts]
   */
  function take(opts) {
    if (inFlight) return inFlight;
    inFlight = run(opts || {}).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function run(o) {
    const actionSetting = String(o.action || setting('screenshotAction', 'save'));
    const action = o.copyOnly ? 'copy' : ['save', 'copy', 'both'].includes(actionSetting) ? actionSetting : 'save';
    const wantCopy = action === 'copy' || action === 'both';
    const wantSave = action === 'save' || action === 'both';
    const toast = (text, kind) => {
      if (!o.silent) AYT.ui.toast(text, { kind });
    };

    // Start the clipboard write synchronously (inside the click's user activation); the PNG arrives later.
    let feedPng = null;
    let failPng = null;
    let copying = null;
    if (wantCopy) {
      const png = new Promise((resolve, reject) => {
        feedPng = resolve;
        failPng = reject;
      });
      copying = M.copyImage(png);
      copying.catch(() => {}); // awaited below; avoid an unhandled rejection when capture fails first
    }

    let shot;
    try {
      shot = await capture({
        format: o.format,
        quality: o.quality,
        onCaptured: () => {
          if (o.silent) return;
          flash();
          AYT.toolbar.flash('screenshot');
        },
      });
    } catch (e) {
      if (failPng) failPng(e);
      const known = e && ['ad', 'not_ready', 'no_video', 'drm'].includes(e.code);
      toast(known ? e.message : t('screenshot.failed', { message: M.errorText(e) }), e && (e.code === 'ad' || e.code === 'not_ready') ? 'warn' : 'error');
      return { ok: false, error: e };
    }

    if (feedPng) shot.toPng().then(feedPng, failPng);
    const [saveRes, copyRes] = await Promise.allSettled([
      wantSave ? M.saveBlob(shot.blob, shot.filename, 'screenshot') : Promise.resolve(null),
      wantCopy ? copying : Promise.resolve(null),
    ]);
    const size = shot.width + '×' + shot.height;
    const saved = wantSave && saveRes.status === 'fulfilled';
    const copied = wantCopy && copyRes.status === 'fulfilled';
    const saveErr = wantSave && saveRes.status === 'rejected' ? M.errorText(saveRes.reason) : null;
    const copyErr = wantCopy && copyRes.status === 'rejected' ? M.errorText(copyRes.reason) : null;

    if (saved && copied) toast(t('screenshot.savedCopied', { size }), 'success');
    else if (saved && copyErr) toast(t('screenshot.savedCopyFailed', { size, message: copyErr }), 'warn');
    else if (copied && saveErr) toast(t('screenshot.copiedSaveFailed', { size, message: saveErr }), 'warn');
    else if (saved) toast(t('screenshot.saved', { size }), 'success');
    else if (copied) toast(t('screenshot.copied', { size }), 'success');
    else toast(t('screenshot.failed', { message: saveErr || copyErr || t('common.error') }), 'error');

    const result = Object.assign({}, shot);
    delete result.toPng;
    return { ok: saved || copied, shot: result, saved, copied, error: saveErr || copyErr || null };
  }

  AYT.screenshot = { capture, take, flash, adjustments };

  AYT.toolbar.register({
    id: 'screenshot',
    order: 50,
    group: 'download',
    icon: 'camera',
    title: () => t('screenshot.buttonTitle'),
    surfaces: ['watch', 'shorts'],
    onClick: (ctx, e) => take({ copyOnly: !!(e && e.shiftKey) }),
    commands: { 'take-screenshot': () => take({}) },
  });
})(globalThis);
