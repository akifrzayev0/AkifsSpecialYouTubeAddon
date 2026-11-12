/*
 * Akif's Special YouTube Addon — Volume boost tool (owner: TOOLS).
 *
 * Toolbar panel `boost` (group tools, order 30): gain 100 %–boostMax % (step 10) + presets.
 * YouTube's setVolume caps at 100 (verified), so the boost uses Web Audio:
 *   MediaElementSource(<video>) → Gain → DynamicsCompressor (limiter) → destination
 * The graph is created lazily on the first boost above 100 % (from a user gesture, so the
 * AudioContext is allowed to run), one graph per <video> element (WeakMap — YouTube reuses the
 * element between videos). At 100 % the source is routed straight to the destination, so the
 * sound is untouched. A MediaElementSource can never be detached again; therefore a graph is only
 * created while the AudioContext is running (a suspended context would silence the video).
 * A running context costs ~2 % of a CPU core even when it only renders silence, so it is suspended
 * a few seconds after the last of its videos paused / ended, and resumed when one plays again
 * (the tab has user activation from the first boost, so no new gesture is needed).
 * The level is kept for this tab (also across SPA navigation); it is not persisted.
 *
 * Public: AYT.tools.boost = { level(), setLevel(pct), state(), presetsFor(max), gainToDb(gain), clampPercent() }
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || !AYT.toolbar || !AYT.dom || !AYT.ui) return;
  const NS = (AYT.tools = AYT.tools || {});
  if (NS.boost) return;
  const { h } = AYT.dom;
  const U = AYT.util;
  const t = (k, p) => AYT.t(k, p);

  const BASE_PRESETS = [100, 150, 200, 300, 400];

  /* ------------------------------------------------------------------ pure helpers */

  /** Max boost in percent from the setting (100..600). */
  function maxPercent(setting) {
    const n = Number(setting);
    return isFinite(n) ? U.clamp(Math.round(n / 10) * 10, 100, 600) : 400;
  }

  /** Preset chips for a given maximum: [100, 150, 200, 300, 400] ∩ [100, max], plus max itself. */
  function presetsFor(max) {
    const m = maxPercent(max);
    const list = BASE_PRESETS.filter((p) => p <= m);
    if (!list.includes(m)) list.push(m);
    return list;
  }

  /** Percent → allowed value (multiple of 10 in 100..max). */
  function clampPercent(pct, max) {
    const n = Number(pct);
    if (!isFinite(n)) return 100;
    return U.clamp(Math.round(n / 10) * 10, 100, maxPercent(max));
  }

  /** Linear gain → decibels (1 → 0, 2 → 6.02). */
  function gainToDb(gain) {
    return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
  }

  /* ------------------------------------------------------------------ audio graph */
  const graphs = new WeakMap(); // <video> -> { src, gain, comp, routed }
  const tracked = new Set(); // <video> elements with a graph: their sound only plays through actx
  const timing = { suspendDelay: 3000 }; // ms of silence before the context is suspended
  let actx = null;
  let percent = 100;
  let lastError = null;
  let resumeHooked = false;
  let suspendTimer = 0;
  let applying = 0; // applyTo() calls in progress (they need a running context)
  const subs = new Set();

  function notify() {
    subs.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        console.error('[AYT] boost listener failed', e);
      }
    });
    try {
      AYT.toolbar.refresh();
    } catch (_) {
      /* ignore */
    }
  }

  const level = () => percent / 100;
  const boosting = () => percent > 100;
  const settingMax = () => {
    try {
      return maxPercent(AYT.settings.get('boostMax'));
    } catch (_) {
      return 400;
    }
  };

  /** Creates/resumes the shared AudioContext. Resolves true when it is running. */
  async function ensureContext() {
    const AC = g.AudioContext || g.webkitAudioContext;
    if (!AC) return false;
    if (!actx) {
      actx = new AC();
      actx.addEventListener('statechange', () => {
        // Our own idle suspend must stay in place; anything else (device change…) is undone.
        if (actx.state !== 'running' && actx.state !== 'closed' && wantRunning()) hookResume();
        notify();
      });
    }
    if (actx.state !== 'running') {
      try {
        await Promise.race([actx.resume(), U.sleep(800)]);
      } catch (_) {
        /* not allowed without a user gesture */
      }
    }
    return actx.state === 'running';
  }

  /** If Chrome suspends the context while it is needed (device change…), resume on the next user gesture. */
  function hookResume() {
    if (resumeHooked) return;
    resumeHooked = true;
    const go = () => {
      resumeHooked = false;
      document.removeEventListener('pointerdown', go, true);
      document.removeEventListener('keydown', go, true);
      if (actx && actx.state !== 'running' && actx.state !== 'closed' && wantRunning()) actx.resume().catch(() => {});
    };
    document.addEventListener('pointerdown', go, true);
    document.addEventListener('keydown', go, true);
  }

  const isPlaying = (v) => !!v && !v.paused && !v.ended;

  /** The context must run while one of its videos plays (or a boost is being applied). */
  function wantRunning() {
    if (applying > 0) return true;
    for (const v of tracked) if (isPlaying(v)) return true;
    return false;
  }

  function cancelSuspend() {
    clearTimeout(suspendTimer);
    suspendTimer = 0;
  }

  /** Suspends the context after a short silence when none of its videos plays (saves CPU and battery). */
  function scheduleSuspend() {
    cancelSuspend();
    if (!actx || actx.state !== 'running' || wantRunning()) return;
    suspendTimer = setTimeout(() => {
      suspendTimer = 0;
      if (!actx || actx.state !== 'running' || wantRunning()) return;
      actx.suspend().catch(() => {});
    }, timing.suspendDelay);
  }

  /** A video with a graph starts playing: its sound needs the context. */
  function onMediaPlay() {
    cancelSuspend();
    if (!actx || actx.state === 'running' || actx.state === 'closed') return;
    actx.resume().catch(() => {});
    hookResume(); // fallback if the browser wants a fresh gesture
  }

  function createGraph(video) {
    const src = actx.createMediaElementSource(video); // throws if another graph owns the element
    const gain = actx.createGain();
    const comp = actx.createDynamicsCompressor();
    // Brick-wall-ish limiter: transparent below -1.5 dBFS, squashes peaks above it.
    comp.threshold.value = -1.5;
    comp.knee.value = 1;
    comp.ratio.value = 20;
    comp.attack.value = 0.002;
    comp.release.value = 0.2;
    gain.connect(comp);
    comp.connect(actx.destination);
    const gr = { src, gain, comp, routed: null };
    graphs.set(video, gr);
    tracked.add(video);
    // From now on this element is silent unless the context runs: follow its playback.
    for (const type of ['play', 'playing']) video.addEventListener(type, onMediaPlay);
    for (const type of ['pause', 'ended', 'emptied']) video.addEventListener(type, scheduleSuspend);
    return gr;
  }

  function route(gr) {
    const want = boosting() ? 'boost' : 'direct';
    if (gr.routed !== want) {
      try {
        gr.src.disconnect();
      } catch (_) {
        /* not connected yet */
      }
      gr.src.connect(want === 'boost' ? gr.gain : actx.destination);
      gr.routed = want;
    }
    try {
      gr.gain.gain.setTargetAtTime(level(), actx.currentTime, 0.015);
    } catch (_) {
      gr.gain.gain.value = level();
    }
  }

  /**
   * Applies the current level to `video` (creating its graph only when boosting). Afterwards the
   * context goes back to sleep after a short while when nothing plays.
   */
  async function applyTo(video) {
    if (!video) return false;
    applying++;
    try {
      let gr = graphs.get(video);
      if (!gr) {
        if (!boosting()) return true; // 100 %: nothing to do, keep YouTube's native audio path
        if (!(await ensureContext())) {
          const e = new Error(t('tools.boost.blocked'));
          e.code = 'suspended';
          throw e;
        }
        gr = graphs.get(video) || createGraph(video);
      } else if (actx && actx.state !== 'running') {
        await ensureContext();
      }
      route(gr);
      return true;
    } finally {
      applying--;
      scheduleSuspend();
    }
  }

  /**
   * Sets the boost in percent (100..boostMax). Resolves the applied percent.
   * Rejects (and falls back to 100 %) when Web Audio can't take over the video's audio.
   */
  async function setLevel(pct) {
    percent = clampPercent(pct, settingMax());
    lastError = null;
    notify();
    try {
      await applyTo(AYT.player.video());
    } catch (e) {
      lastError = e;
      percent = 100;
      notify();
      const err = new Error(e && e.code === 'suspended' ? e.message : t('tools.boost.unavailable'));
      err.code = (e && e.code) || 'webaudio';
      throw err;
    }
    notify();
    return percent;
  }

  /* ------------------------------------------------------------------ panel */
  AYT.ui.addStyles(`
.ayt-boost { display: flex; flex-direction: column; gap: 14px; }
.ayt-boost-head { display: flex; flex-direction: column; align-items: center; gap: 2px; padding-top: 4px; }
.ayt-boost-big { font: 700 46px/1.05 var(--ayt-font); letter-spacing: -1px; font-variant-numeric: tabular-nums; color: var(--ayt-text); transition: color .2s; }
.ayt-boost-big.is-on { color: var(--ayt-accent); }
.ayt-boost-db { min-height: 15px; font: 500 12px/1.25 var(--ayt-font); color: var(--ayt-text-3); font-variant-numeric: tabular-nums; }
.ayt-boost-meter { display: flex; gap: 3px; justify-content: center; height: 6px; margin-top: 6px; }
.ayt-boost-meter span { width: 22px; border-radius: 3px; background: var(--ayt-surface-hover); transition: background .2s; }
.ayt-boost-meter span.is-lit { background: linear-gradient(90deg, var(--ayt-accent-2), var(--ayt-accent)); }
.ayt-boost-meter span.is-hot { background: linear-gradient(90deg, #ffb020, #ff5b2e); }
`);

  /** 150 -> "150%" in the UI language (fr "150 %", tr "%150"). */
  function fmtPercent(p) {
    return U.formatPercent(Math.round(p));
  }

  let dbFormat = { lang: null, nf: null };
  function fmtDb(gain) {
    const db = gainToDb(gain);
    const lang = AYT.i18n.language;
    if (dbFormat.lang !== lang) {
      // cached per language: a new Intl.NumberFormat costs ~40 µs and this runs on every refresh
      let nf = null;
      try {
        nf = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      } catch (_) {
        nf = null;
      }
      dbFormat = { lang, nf };
    }
    return t('tools.boost.db', { value: dbFormat.nf ? dbFormat.nf.format(db) : db.toFixed(1) });
  }

  function renderPanel() {
    const root = h('div', { class: 'ayt-boost' });
    const big = h('div', { class: 'ayt-boost-big', 'aria-live': 'polite' });
    const db = h('div', { class: 'ayt-boost-db' });
    const meter = h('div', { class: 'ayt-boost-meter', 'aria-hidden': 'true' });
    const msg = h('div', { class: 'ayt-hint', role: 'status' });
    let max = settingMax();
    let sliding = false;

    const throttled = U.throttle((v) => uiSet(v), 80);
    const slider = AYT.ui.slider({
      min: 100,
      max,
      step: 10,
      value: percent,
      showValue: false,
      ariaLabel: t('tools.boost.level'),
      onInput: (v) => throttled(v),
      onChange: (v) => uiSet(v),
    });
    slider.input.addEventListener('pointerdown', () => (sliding = true));
    const endSlide = () => {
      sliding = false;
      sync();
    };
    slider.input.addEventListener('pointerup', endSlide);
    slider.input.addEventListener('pointercancel', endSlide);

    const chips = h('div', { class: 'ayt-tools-chips', role: 'group', 'aria-label': t('tools.boost.level') });
    let chipEls = [];
    function buildChips() {
      chipEls = presetsFor(max).map((p) =>
        h('button', { type: 'button', class: 'ayt-tools-chip', dataset: { pct: String(p) }, 'aria-pressed': 'false', on: { click: () => uiSet(p) } }, p === 100 ? t('common.off') : fmtPercent(p))
      );
      AYT.dom.render(chips, chipEls);
    }
    buildChips();

    const hint = AYT.ui.notice({ kind: 'info', text: t('tools.boost.hint') });

    root.append(
      h('div', { class: 'ayt-boost-head' }, big, db, meter),
      slider.el,
      chips,
      msg,
      hint
    );

    async function uiSet(p) {
      msg.textContent = '';
      try {
        await setLevel(p);
      } catch (e) {
        msg.textContent = e.message;
      }
      sync();
    }

    function sync() {
      const nm = settingMax();
      if (nm !== max) {
        max = nm;
        slider.setBounds(100, max);
        buildChips();
      }
      big.textContent = fmtPercent(percent);
      big.classList.toggle('is-on', boosting());
      db.textContent = boosting() ? fmtDb(level()) : t('tools.boost.original');
      if (!sliding) slider.value = percent;
      for (const c of chipEls) {
        const on = Number(c.dataset.pct) === percent;
        c.classList.toggle('is-selected', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      const bars = 10;
      const lit = Math.round(((percent - 100) / Math.max(10, max - 100)) * bars);
      AYT.dom.render(
        meter,
        Array.from({ length: bars }, (_, i) => h('span', { class: [i < lit && 'is-lit', i < lit && i >= 7 && 'is-hot'] }))
      );
    }

    subs.add(sync);
    sync();
    return {
      el: root,
      onVideoChange: sync,
      destroy() {
        subs.delete(sync);
      },
    };
  }

  /* ------------------------------------------------------------------ registration */
  AYT.toolbar.register({
    id: 'boost',
    group: 'tools',
    order: 30,
    icon: 'boost',
    title: () => t('toolbar.boost'),
    panel: { width: 380, render: renderPanel },
    isOn: () => boosting(),
  });

  let pageTimer = 0;
  AYT.features.register({
    id: 'boost',
    onPageChange() {
      // Shorts may use another <video>; keep the boost on whatever element plays now.
      if (!boosting()) return;
      clearTimeout(pageTimer);
      pageTimer = setTimeout(() => {
        applyTo(AYT.player.video()).catch((e) => {
          lastError = e;
        });
      }, 400);
    },
    onSettings(changes) {
      if (!('boostMax' in changes)) return;
      const m = maxPercent(changes.boostMax);
      if (percent > m) setLevel(m).catch(() => {});
      else notify();
    },
  });

  NS.boost = {
    level: () => percent,
    setLevel,
    presetsFor,
    clampPercent,
    gainToDb,
    maxPercent,
    fmtDb,
    fmtPercent,
    timing, // { suspendDelay } — tests shorten it
    state() {
      const v = AYT.player.video();
      const gr = v ? graphs.get(v) : null;
      return {
        percent,
        graph: !!gr,
        routed: gr ? gr.routed : null,
        gain: gr ? gr.gain.gain.value : null,
        contextState: actx ? actx.state : null,
        error: lastError ? lastError.message : null,
      };
    },
  };
})(globalThis);
