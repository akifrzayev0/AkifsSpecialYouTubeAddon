/*
 * Akif's Special YouTube Addon — Loop tool (owner: TOOLS).
 *
 * Toolbar panel `loop` (group tools, order 10):
 *  - "Loop this video": the player's own loop (bridge setLoop / getLoopVideo).
 *  - A-B loop: repeat the section between point A and point B. Uses the player's native
 *    setLoopRange (bridge `setLoopRange`, verified Nov 2026); when the player does not support it,
 *    a manual loop seeks back to A whenever currentTime reaches B (requestVideoFrameCallback when
 *    available, else timeupdate + a 200 ms timer). A light watchdog also covers the native mode.
 *    While active, the section is highlighted on YouTube's progress bar (.ytp-progress-bar).
 *    The A-B loop is reset on every video change.
 *  - Command `toggle-loop` toggles the plain loop (with a toast).
 *
 * Public: AYT.tools.loop = { state(), readPlayer(), setLoop(on), toggleLoop(), startAB(a, b),
 *                            stopAB(), normalizeRange(a, b, duration), placePoint(...), shouldWrap(...) }
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || !AYT.toolbar || !AYT.dom || !AYT.ui) return;
  const NS = (AYT.tools = AYT.tools || {});
  if (NS.loop) return;
  const { h } = AYT.dom;
  const U = AYT.util;
  const t = (k, p) => AYT.t(k, p);

  const MIN_GAP = 0.5; // shortest A-B section, seconds
  const DEFAULT_SPAN = 10; // section length used when only one point is known
  const NATIVE_SLACK = 0.6; // native mode: the watchdog only acts this far past B
  const round3 = (n) => Math.round(n * 1000) / 1000;

  /* ------------------------------------------------------------------ pure helpers */

  /**
   * Validates an A-B pair against the video duration.
   * @returns {{ok: true, a: number, b: number} | {ok: false, reason: 'invalid'|'order'|'short'}}
   */
  function normalizeRange(a, b, duration) {
    const A = Number(a);
    const B = Number(b);
    if (a == null || b == null || !isFinite(A) || !isFinite(B) || A < 0 || B < 0) return { ok: false, reason: 'invalid' };
    const d = Number(duration) > 0 && isFinite(Number(duration)) ? Number(duration) : Infinity;
    const lo = Math.min(A, d);
    const hi = Math.min(B, d);
    if (hi <= lo) return { ok: false, reason: 'order' };
    if (hi - lo < MIN_GAP) return { ok: false, reason: 'short' };
    return { ok: true, a: round3(lo), b: round3(hi) };
  }

  /**
   * New {a, b} after "Set A" / "Set B" at time `now`. The other point moves when the section
   * would otherwise be empty or shorter than MIN_GAP.
   */
  function placePoint(which, now, a, b, duration) {
    const d = Number(duration) > 0 && isFinite(Number(duration)) ? Number(duration) : Infinity;
    const at = U.clamp(round3(Number(now) || 0), 0, d);
    if (which === 'a') {
      let nb = b != null && isFinite(b) ? Math.min(b, d) : null;
      if (nb == null || nb - at < MIN_GAP) nb = Math.min(d, at + DEFAULT_SPAN);
      if (nb - at < MIN_GAP) return { a: round3(Math.max(0, nb - DEFAULT_SPAN)), b: round3(nb) };
      return { a: at, b: round3(nb) };
    }
    let na = a != null && isFinite(a) ? Math.max(0, a) : null;
    if (na == null || at - na < MIN_GAP) na = Math.max(0, at - DEFAULT_SPAN);
    if (at - na < MIN_GAP) return { a: round3(na), b: round3(Math.min(d, na + DEFAULT_SPAN)) };
    return { a: round3(na), b: at };
  }

  /** True when playback at `time` must jump back to A. */
  function shouldWrap(time, a, b, native) {
    if (!(b > a) || !isFinite(time)) return false;
    return native ? time >= b + NATIVE_SLACK : time >= b - 0.02;
  }

  let secFormat = { lang: null, nf: null };
  /** "4.5 s" below a minute, "1:05" above. */
  function formatSpan(sec) {
    if (!(sec >= 0)) return '';
    if (sec < 60) {
      const lang = AYT.i18n.language;
      if (secFormat.lang !== lang) {
        // cached per language: a new Intl.NumberFormat costs ~40 µs (this runs every second while the panel is open)
        let nf = null;
        try {
          nf = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
        } catch (_) {
          nf = null;
        }
        secFormat = { lang, nf };
      }
      return t('tools.loop.seconds', { value: secFormat.nf ? secFormat.nf.format(sec) : sec.toFixed(1) });
    }
    return U.formatDuration(sec);
  }

  /* ------------------------------------------------------------------ state */
  const st = {
    loop: false, // the player's own loop flag (cached)
    a: null, // A-B points for the current video (seconds)
    b: null,
    active: false, // A-B loop running
    mode: null, // 'native' | 'manual'
    duration: 0, // content duration from the player API (also correct during ads)
    videoId: null, // video the A-B loop belongs to
  };
  const subs = new Set();

  function refreshToolbar() {
    try {
      AYT.toolbar.refresh();
    } catch (_) {
      /* toolbar not mounted */
    }
  }

  function notify() {
    subs.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        console.error('[AYT] loop listener failed', e);
      }
    });
    refreshToolbar();
  }

  const surface = () => (AYT.page.isShorts() ? 'shorts' : 'watch');

  function coded(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  function duration() {
    if (st.duration > 0) return st.duration;
    return AYT.player.isAdPlaying() ? 0 : AYT.player.duration();
  }

  function isLive() {
    const info = AYT.page.videoId ? AYT.videoInfo.peek(AYT.page.videoId) : null;
    return !!(info && (info.isLive || info.isUpcoming));
  }

  /* ------------------------------------------------------------------ player access */

  /** Reads loop flag + duration from the player (bridge). Never throws. */
  async function readPlayer() {
    let s = null;
    try {
      s = await AYT.bridge.request('getPlayerState', { surface: surface() }, 2500);
    } catch (_) {
      s = null;
    }
    if (s && typeof s === 'object') {
      const prevLoop = st.loop;
      st.loop = s.loop === true;
      const d = Number(s.duration);
      if (s.videoId && s.videoId === AYT.page.videoId && isFinite(d) && d > 0) st.duration = d;
      if (prevLoop !== st.loop) notify();
    }
    return s;
  }

  /** Turns the player's own loop on/off. Throws when the player can't be reached. */
  async function setLoop(on) {
    const want = !!on;
    await AYT.bridge.request('setLoop', { on: want, surface: surface() }, 2500);
    st.loop = want;
    notify();
    return want;
  }

  /* ------------------------------------------------------------------ A-B loop */
  let watchTimer = 0;
  let frameVideo = null;
  let frameHandle = 0;
  let framePending = false;
  let timeupdateHooked = false;
  let lastReassert = 0;
  let abSeq = 0; // guards startAB continuations against a stop/restart in between

  function hasRvfc() {
    const v = AYT.player.video();
    return !!(v && typeof v.requestVideoFrameCallback === 'function');
  }

  function rangeError(reason) {
    if (reason === 'short') return coded(t('tools.loop.tooShort', { time: formatSpan(MIN_GAP) }), 'short');
    if (reason === 'order') return coded(t('tools.loop.order'), 'order');
    return coded(t('tools.loop.invalid'), 'invalid');
  }

  /**
   * Starts (or updates) the A-B loop. Resolves { a, b, mode }; rejects with a friendly message.
   */
  async function startAB(a, b) {
    if (isLive()) throw coded(t('tools.loop.live'), 'live');
    const n = normalizeRange(a, b, duration());
    if (!n.ok) throw rangeError(n.reason);
    const my = ++abSeq;
    st.a = n.a;
    st.b = n.b;
    let native = false;
    try {
      const r = await AYT.bridge.request('setLoopRange', { start: n.a, end: n.b, surface: surface() }, 2500);
      native = !!(r && r.supported && r.range);
    } catch (_) {
      native = false;
    }
    if (my !== abSeq) {
      // Stopped (switch off, navigation) or restarted while the player answered.
      if (native && !st.active) AYT.bridge.request('setLoopRange', { start: null, end: null, surface: surface() }, 2500).catch(() => {});
      return { a: n.a, b: n.b, mode: native ? 'native' : 'manual', cancelled: true };
    }
    st.active = true;
    st.mode = native ? 'native' : 'manual';
    st.videoId = AYT.page.videoId;
    startWatch();
    const v = AYT.player.video();
    if (v && !AYT.player.isAdPlaying() && (v.currentTime < n.a - 0.25 || v.currentTime >= n.b)) jumpToA(v);
    paintMarkers();
    notify();
    return { a: n.a, b: n.b, mode: st.mode };
  }

  /** Stops the A-B loop (keeps the points unless opts.resetPoints). */
  async function stopAB(opts) {
    const o = opts || {};
    abSeq++;
    const wasActive = st.active;
    const wasNative = st.mode === 'native';
    st.active = false;
    st.mode = null;
    if (o.resetPoints) {
      st.a = null;
      st.b = null;
    }
    stopWatch();
    paintMarkers();
    if (wasActive) notify();
    if (wasNative || o.clearNative) {
      try {
        await AYT.bridge.request('setLoopRange', { start: null, end: null, surface: surface() }, 2500);
      } catch (_) {
        /* player gone (navigation) — nothing to clear */
      }
    }
  }

  function jumpToA(v) {
    if (st.a == null) return;
    const ended = v.ended;
    try {
      v.currentTime = st.a;
    } catch (_) {
      AYT.player.seek(st.a);
    }
    if (ended) {
      try {
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      } catch (_) {
        /* autoplay refused */
      }
    }
  }

  /**
   * precise = per-frame / timeupdate check: wraps at B in both modes (YouTube's own range check is
   * coarse — at 3× it overshot B by >1 s in tests). The slow timer in native mode only acts as a
   * watchdog when the player dropped its range (and re-applies it).
   */
  function check(precise) {
    if (!st.active || AYT.player.isAdPlaying()) return;
    const v = AYT.player.video();
    if (!v || v.seeking) return;
    const slack = st.mode === 'native' && !precise;
    if (shouldWrap(v.currentTime, st.a, st.b, slack)) {
      jumpToA(v);
      if (slack) reassertNative();
    }
  }

  /** The player dropped its native range (ad, quality switch…): set it again (max every 2 s). */
  function reassertNative() {
    const now = Date.now();
    if (now - lastReassert < 2000) return;
    lastReassert = now;
    AYT.bridge.request('setLoopRange', { start: st.a, end: st.b, surface: surface() }, 2500).catch(() => {});
  }

  function hookFrames() {
    const v = AYT.player.video();
    if (!v || typeof v.requestVideoFrameCallback !== 'function') return;
    if (frameVideo === v && framePending) return;
    unhookFrames();
    frameVideo = v;
    const step = () => {
      framePending = false;
      if (!st.active || frameVideo !== v) return;
      check(true);
      try {
        frameHandle = v.requestVideoFrameCallback(step);
        framePending = true;
      } catch (_) {
        framePending = false;
      }
    };
    try {
      frameHandle = v.requestVideoFrameCallback(step);
      framePending = true;
    } catch (_) {
      framePending = false;
    }
  }

  function unhookFrames() {
    if (frameVideo && framePending && typeof frameVideo.cancelVideoFrameCallback === 'function') {
      try {
        frameVideo.cancelVideoFrameCallback(frameHandle);
      } catch (_) {
        /* ignore */
      }
    }
    frameVideo = null;
    framePending = false;
  }

  function onTimeUpdate(e) {
    if (e.target === AYT.player.video()) check(true);
  }

  function onEnded(e) {
    if (!st.active || e.target !== AYT.player.video() || AYT.player.isAdPlaying()) return;
    jumpToA(e.target);
  }

  function watchTick() {
    if (!st.active) return;
    if (st.videoId && AYT.page.videoId !== st.videoId) {
      stopAB({ resetPoints: true, clearNative: true });
      return;
    }
    check(st.mode === 'manual');
    if (hasRvfc()) hookFrames(); // re-hook when YouTube swapped the element or the chain stopped
    paintMarkers();
  }

  function startWatch() {
    stopWatch();
    const manual = st.mode === 'manual';
    const rvfc = hasRvfc();
    watchTimer = setInterval(watchTick, manual && !rvfc ? 200 : 500);
    if (rvfc) hookFrames();
    if (manual) {
      // rVFC does not fire in background tabs; timeupdate still does.
      document.addEventListener('timeupdate', onTimeUpdate, true);
      timeupdateHooked = true;
    }
    document.addEventListener('ended', onEnded, true);
  }

  function stopWatch() {
    clearInterval(watchTimer);
    watchTimer = 0;
    unhookFrames();
    if (timeupdateHooked) {
      document.removeEventListener('timeupdate', onTimeUpdate, true);
      timeupdateHooked = false;
    }
    document.removeEventListener('ended', onEnded, true);
  }

  /* ------------------------------------------------------------------ progress-bar markers */
  // Repainted every 200–500 ms while looping: keep a reference instead of searching the whole
  // document, and only touch the element's style when the section or the duration changed.
  let marker = null;
  let markerPos = '';

  function removeMarker() {
    if (marker) marker.remove();
    marker = null;
    markerPos = '';
  }

  function paintMarkers() {
    const root = AYT.page.isWatch() ? document.getElementById('movie_player') : null;
    const bar = root && root.querySelector('.ytp-progress-bar');
    const d = duration();
    if (!st.active || !bar || !(d > 0) || !isFinite(d) || AYT.player.isAdPlaying()) {
      removeMarker();
      return;
    }
    if (!marker || marker.parentNode !== bar) {
      removeMarker(); // YouTube rebuilt the progress bar (or ours is gone)
      marker = bar.querySelector(':scope > .ayt-loop-range') || h('div', { class: 'ayt-loop-range', 'aria-hidden': 'true' });
      if (marker.parentNode !== bar) bar.appendChild(marker);
    }
    const left = U.clamp((st.a / d) * 100, 0, 100);
    const width = U.clamp(((st.b - st.a) / d) * 100, 0, 100 - left);
    const pos = left.toFixed(3) + '|' + width.toFixed(3);
    if (pos === markerPos) return;
    markerPos = pos;
    marker.style.left = left.toFixed(3) + '%';
    marker.style.width = width.toFixed(3) + '%';
  }

  /* ------------------------------------------------------------------ command */
  async function toggleLoop() {
    if (!AYT.player.video()) {
      AYT.ui.toast(t('error.noVideo'), { kind: 'warn' });
      return null;
    }
    try {
      await readPlayer();
      const on = await setLoop(!st.loop);
      AYT.ui.toast(on ? t('tools.loop.on') : t('tools.loop.off'), { kind: 'success', duration: 2200 });
      AYT.toolbar.flash('loop');
      return on;
    } catch (_) {
      AYT.ui.toast(t('tools.loop.failed'), { kind: 'error' });
      return null;
    }
  }

  /* ------------------------------------------------------------------ panel */
  AYT.ui.addStyles(`
.ayt-loop { display: flex; flex-direction: column; gap: 12px; }
.ayt-loop-ab { display: flex; flex-direction: column; gap: 10px; }
.ayt-loop-points {
  display: flex; flex-direction: column; gap: 8px; padding: 12px;
  border-radius: 12px; background: var(--ayt-surface); border: 1px solid var(--ayt-border);
}
.ayt-loop-point { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.ayt-loop-tag {
  width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center;
  font: 700 14px/1 var(--ayt-font); color: #1b1300;
  background: linear-gradient(135deg, #ffe08a, #ffc400); box-shadow: 0 2px 8px rgba(255, 196, 0, .25);
}
.ayt-loop-point .ayt-input--time { max-width: none; height: 36px; }
.ayt-loop-point > .ayt-field-error { grid-column: 2 / -1; margin-top: -4px; }
.ayt-loop-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 30px; }
.ayt-loop-len { font: 500 13px/1.3 var(--ayt-font); color: var(--ayt-text-2); font-variant-numeric: tabular-nums; }
.ayt-loop-msg { font: 400 12px/1.4 var(--ayt-font); color: var(--ayt-danger); }
.ayt-loop-msg:empty { display: none; }
.ayt-loop.is-live .ayt-loop-ab, .ayt-loop.is-live .ayt-loop-main { opacity: .45; pointer-events: none; }
`);

  function renderPanel() {
    const root = h('div', { class: 'ayt-loop' });
    const liveNote = AYT.ui.notice({ kind: 'info', text: t('tools.loop.live') });
    liveNote.classList.add('ayt-hidden');

    const loopSw = AYT.ui.switchControl({
      label: t('tools.loop.loopVideo'),
      desc: t('tools.loop.loopVideoDesc'),
      checked: st.loop,
      onChange: async (on) => {
        try {
          await setLoop(on);
        } catch (_) {
          loopSw.checked = st.loop;
          AYT.ui.toast(t('tools.loop.failed'), { kind: 'error' });
        }
      },
    });

    const msgEl = h('div', { class: 'ayt-loop-msg', role: 'status', 'aria-live': 'polite' });
    const setMsg = (text) => (msgEl.textContent = text || '');

    const abSw = AYT.ui.switchControl({
      label: t('tools.loop.abSwitch'),
      desc: t('tools.loop.abDesc'),
      checked: st.active,
      onChange: (on) => {
        if (on) apply(st.a, st.b);
        else stopAB().then(sync, sync);
      },
    });

    const aIn = AYT.ui.timeInput({ value: st.a || 0, withMs: true, min: 0, ariaLabel: t('tools.loop.pointA'), onChange: (v) => edit('a', v) });
    const bIn = AYT.ui.timeInput({ value: st.b || 0, withMs: true, min: 0, ariaLabel: t('tools.loop.pointB'), onChange: (v) => edit('b', v) });
    const setA = AYT.ui.button({ label: t('tools.loop.setA'), icon: 'clock', size: 'sm', title: t('tools.loop.setAHint'), onClick: () => setPoint('a') });
    const setB = AYT.ui.button({ label: t('tools.loop.setB'), icon: 'clock', size: 'sm', title: t('tools.loop.setBHint'), onClick: () => setPoint('b') });
    const lenEl = h('div', { class: 'ayt-loop-len' });
    const clearBtn = AYT.ui.button({
      label: t('common.reset'),
      icon: 'refresh',
      size: 'sm',
      variant: 'ghost',
      onClick: () => {
        setMsg('');
        stopAB({ resetPoints: true }).then(() => {
          initPoints(true);
          sync();
        });
      },
    });

    root.append(
      liveNote,
      h('div', { class: 'ayt-loop-main' }, loopSw.el),
      h(
        'div',
        { class: 'ayt-loop-ab' },
        h('div', { class: 'ayt-group-title' }, t('tools.loop.abTitle')),
        abSw.el,
        h(
          'div',
          { class: 'ayt-loop-points' },
          // errorEl (hidden while valid): why a typed time was rejected, right under its field
          h('div', { class: 'ayt-loop-point' }, h('span', { class: 'ayt-loop-tag', 'aria-hidden': 'true' }, 'A'), aIn.el, setA, aIn.errorEl || null),
          h('div', { class: 'ayt-loop-point' }, h('span', { class: 'ayt-loop-tag', 'aria-hidden': 'true' }, 'B'), bIn.el, setB, bIn.errorEl || null),
          h('div', { class: 'ayt-loop-foot' }, lenEl, clearBtn)
        ),
        msgEl
      )
    );

    const focused = (input) => {
      try {
        return input.matches(':focus');
      } catch (_) {
        return false;
      }
    };

    function initPoints(force) {
      if (!force && st.a != null && st.b != null) return;
      const v = AYT.player.video();
      const now = v && !AYT.player.isAdPlaying() ? Math.floor(v.currentTime) : 0;
      const p = placePoint('a', now, null, null, duration());
      st.a = p.a;
      st.b = p.b;
    }

    function sync() {
      loopSw.checked = st.loop;
      abSw.checked = st.active;
      const d = duration();
      if (d > 0) {
        aIn.setMax(d);
        bIn.setMax(d);
      }
      if (st.a != null && !focused(aIn.el)) aIn.value = st.a;
      if (st.b != null && !focused(bIn.el)) bIn.value = st.b;
      const span = st.a != null && st.b != null && st.b > st.a ? st.b - st.a : null;
      lenEl.textContent = span != null ? t('tools.loop.length', { time: formatSpan(span) }) : '';
      const live = isLive();
      root.classList.toggle('is-live', live);
      liveNote.classList.toggle('ayt-hidden', !live);
    }

    async function apply(a, b) {
      setMsg('');
      try {
        await startAB(a, b);
      } catch (e) {
        setMsg(e.message);
        abSw.checked = st.active;
      }
      sync();
    }

    function edit(which, value) {
      setMsg('');
      const next = { a: st.a, b: st.b };
      next[which] = value;
      const n = normalizeRange(next.a, next.b, duration());
      if (!n.ok) {
        setMsg(rangeError(n.reason).message);
        // While looping, the running section stays untouched; otherwise keep the draft value.
        if (!st.active) st[which] = value;
        sync();
        return;
      }
      if (st.active) apply(n.a, n.b);
      else {
        st.a = n.a;
        st.b = n.b;
        sync();
      }
    }

    function setPoint(which) {
      setMsg('');
      const v = AYT.player.video();
      if (!v) return setMsg(t('error.noVideo'));
      if (AYT.player.isAdPlaying()) return setMsg(t('tools.common.adPlaying'));
      const p = placePoint(which, v.currentTime, st.a, st.b, duration());
      st.a = p.a;
      st.b = p.b;
      // Setting B completes the section: start looping right away.
      if (which === 'b' || st.active) apply(p.a, p.b);
      else sync();
    }

    subs.add(sync);
    let poll = 0;
    let destroyed = false;

    async function refreshFromPlayer() {
      await readPlayer();
      if (!destroyed) sync();
    }

    function prepare() {
      initPoints(false);
      sync();
      refreshFromPlayer();
      if (AYT.page.videoId) {
        AYT.videoInfo
          .get(AYT.page.videoId)
          .then(() => {
            if (!destroyed) sync();
          })
          .catch(() => {});
      }
    }
    prepare();

    return {
      el: root,
      onOpen() {
        clearInterval(poll);
        poll = setInterval(refreshFromPlayer, 1000);
      },
      onVideoChange() {
        setMsg('');
        st.a = null;
        st.b = null;
        prepare();
      },
      destroy() {
        destroyed = true;
        clearInterval(poll);
        subs.delete(sync);
      },
    };
  }

  /* ------------------------------------------------------------------ registration */
  AYT.toolbar.register({
    id: 'loop',
    group: 'tools',
    order: 10,
    icon: 'loop',
    title: () => t('toolbar.loop'),
    panel: { width: 380, render: renderPanel },
    isOn: () => st.loop || st.active,
    commands: { 'toggle-loop': () => toggleLoop() },
  });

  let readTimer = 0;
  function scheduleRead(ms) {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      if (AYT.page.videoId) readPlayer();
    }, ms);
  }

  AYT.features.register({
    id: 'loop',
    init() {
      // YouTube's right-click menu has its own "Loop" item: keep our button state in sync.
      document.addEventListener(
        'click',
        (e) => {
          const el = e.target;
          if (el && el.closest && el.closest('.ytp-contextmenu')) scheduleRead(250);
        },
        true
      );
      if (AYT.page.videoId) scheduleRead(1500);
    },
    onPageChange(info, prev) {
      if (info.videoId === prev.videoId && info.type === prev.type) return;
      st.duration = 0;
      const hadPoints = st.active || st.a != null;
      if (hadPoints) stopAB({ resetPoints: true, clearNative: true });
      if (info.videoId) scheduleRead(1200);
      else if (st.loop) {
        st.loop = false;
        notify();
      }
    },
  });

  NS.loop = {
    MIN_GAP,
    state: () => Object.assign({}, st),
    readPlayer,
    setLoop,
    toggleLoop,
    startAB,
    stopAB,
    normalizeRange,
    placePoint,
    shouldWrap,
    formatSpan,
  };
})(globalThis);
