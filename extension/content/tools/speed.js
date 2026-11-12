/*
 * Akif's Special YouTube Addon — Playback speed tool (owner: TOOLS).
 *
 * Toolbar panel `speed` (group tools, order 20): big current-speed display, slider 0.1–4×
 * (step 0.05), −/+ buttons, preset chips, a custom value (0.1–16×) and "Remember speed"
 * (setting rememberSpeed; value in chrome.storage.local[AYT.STORAGE.LAST_SPEED], written 400 ms after the
 * last change, or right away when the tab is hidden).
 *
 * Rates are applied through the bridge (`setPlaybackRate`): YouTube's API takes 0.25–2 (its list);
 * other rates are set on the <video> directly (verified: up to 16× sticks, 17 throws).
 * The chosen rate is kept for this tab: when YouTube resets it (new video, after an ad, quality
 * switch) it is applied again; when the user picks a speed in YouTube's own menu / with its
 * keyboard shortcuts, that speed is adopted instead. Ads always play at their own speed.
 *
 * Commands: speed-up / speed-down (±0.25 between 0.25× and 4×, then 0.5 steps up to 16×) and
 * speed-reset, each with a small centered on-player indicator.
 *
 * Public: AYT.tools.speed = { rate(), setRate(r, {osd}), step(dir), reset(), nextRate(), parseRate(),
 *                             clampRate(), formatRate(), state() }
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || !AYT.toolbar || !AYT.dom || !AYT.ui) return;
  const NS = (AYT.tools = AYT.tools || {});
  if (NS.speed) return;
  const { h, icon } = AYT.dom;
  const U = AYT.util;
  const t = (k, p) => AYT.t(k, p);

  const MIN = 0.1;
  const MAX = 16;
  const SLIDER_MIN = 0.1;
  const SLIDER_MAX = 4;
  const PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
  const EPS = 1e-6;
  const KEY = AYT.STORAGE.LAST_SPEED;

  /* ------------------------------------------------------------------ pure helpers */
  const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.001;

  /** Clamps to 0.1–16 and rounds to 2 decimals (slider steps produce float noise). */
  function clampRate(r) {
    const n = Number(r);
    if (!isFinite(n) || n <= 0) return 1;
    return U.clamp(Math.round(n * 100) / 100, MIN, MAX);
  }

  /** Parses user input like "1.5", "1,5", "1.5x", "2×" → number in 0.1–16, else NaN. */
  function parseRate(text) {
    const s = String(text == null ? '' : text)
      .trim()
      .replace(/\s*[x×]$/i, '')
      .replace(',', '.')
      .trim();
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    const n = Number(s);
    return n >= MIN - EPS && n <= MAX + EPS ? n : NaN;
  }

  /**
   * Next rate for the speed-up (dir > 0) / speed-down (dir < 0) commands:
   * 0.25 steps between 0.25× and 4×, then 0.5 steps up to 16×. Off-grid rates snap to the grid.
   */
  function nextRate(rate, dir) {
    const r = Number(rate) > 0 ? Number(rate) : 1;
    if (dir > 0) {
      if (r < 4 - EPS) return Math.min(4, Math.floor(r / 0.25 + EPS) * 0.25 + 0.25);
      return Math.min(MAX, Math.floor(r / 0.5 + EPS) * 0.5 + 0.5);
    }
    if (r > 4 + EPS) return Math.max(4, Math.ceil(r / 0.5 - EPS) * 0.5 - 0.5);
    if (r <= 0.25 + EPS) return r; // slower than the grid (only reachable with the slider): keep
    return Math.max(0.25, Math.ceil(r / 0.25 - EPS) * 0.25 - 0.25);
  }

  let rateFormat = { lang: null, nf: null };
  /**
   * Locale-aware number with up to 2 decimals: 1.5 → "1.5" (en) / "1,5" (de). The formatter is cached
   * per language: the toolbar badge calls this on every refresh, and a new Intl.NumberFormat costs ~40 µs.
   */
  function formatRate(rate) {
    const n = Math.round(Number(rate) * 100) / 100;
    const lang = AYT.i18n.language;
    if (rateFormat.lang !== lang) {
      let nf = null;
      try {
        nf = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
      } catch (_) {
        nf = null;
      }
      rateFormat = { lang, nf };
    }
    return rateFormat.nf ? rateFormat.nf.format(n) : String(n);
  }

  /* ------------------------------------------------------------------ state */
  let desired = null; // rate we keep applying (null = leave YouTube alone)
  let selfUntil = 0; // ignore ratechange events we caused until then
  let userAt = 0; // last interaction with YouTube's own speed controls
  let srcChangeAt = 0; // last loadstart/emptied/page change
  let reapplyTimer = 0;
  let verifyTimer = 0;
  let reapplies = 0;
  const subs = new Set();
  let notifyQueued = false;

  function coded(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  const surface = () => (AYT.page.isShorts() ? 'shorts' : 'watch');

  function notify() {
    if (notifyQueued) return;
    notifyQueued = true;
    const run = () => {
      notifyQueued = false;
      subs.forEach((fn) => {
        try {
          fn();
        } catch (e) {
          console.error('[AYT] speed listener failed', e);
        }
      });
      try {
        AYT.toolbar.refresh();
      } catch (_) {
        /* ignore */
      }
    };
    if (typeof g.requestAnimationFrame === 'function' && document.visibilityState === 'visible') g.requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /** Rate the user hears for the content (the <video> rate, or the pending rate during ads). */
  function currentRate() {
    const v = AYT.player.video();
    if (!v) return desired;
    if (AYT.player.isAdPlaying()) return desired != null ? desired : 1;
    return v.playbackRate;
  }

  function isMainVideo(el) {
    return !!el && el.tagName === 'VIDEO' && (el === AYT.player.video() || (el.classList && el.classList.contains('html5-main-video')));
  }

  function remember() {
    try {
      return !!AYT.settings.get('rememberSpeed');
    } catch (_) {
      return false;
    }
  }

  async function loadStored() {
    try {
      const o = await chrome.storage.local.get(KEY);
      const r = Number(o && o[KEY]);
      return r >= MIN && r <= MAX ? clampRate(r) : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Remembered speed: written STORE_DELAY ms after the last change. A slider drag changes the rate ~11×/s, and every
   * chrome.storage.local write is an IPC round trip plus an onChanged event in every extension context.
   * flushStore() writes a pending value right away (tab hidden or closing).
   */
  const STORE_DELAY = 400;
  let storeTimer = 0;
  let pendingStore = null;

  function storeRate(r) {
    pendingStore = clampRate(r);
    clearTimeout(storeTimer);
    storeTimer = setTimeout(flushStore, STORE_DELAY);
  }

  function flushStore() {
    clearTimeout(storeTimer);
    storeTimer = 0;
    if (pendingStore == null) return;
    const r = pendingStore;
    pendingStore = null;
    try {
      const p = chrome.storage.local.set({ [KEY]: r });
      if (p && p.catch) p.catch(() => {});
    } catch (_) {
      /* extension context gone */
    }
  }

  function clearStored() {
    clearTimeout(storeTimer);
    storeTimer = 0;
    pendingStore = null;
    try {
      const p = chrome.storage.local.remove(KEY);
      if (p && p.catch) p.catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ applying */
  async function applyRate(r) {
    const v = AYT.player.video();
    if (!v) throw coded(t('error.noVideo'), 'no_video');
    if (AYT.player.isAdPlaying()) return { deferred: true, rate: r };
    selfUntil = Date.now() + 700;
    try {
      await AYT.bridge.request('setPlaybackRate', { rate: r, surface: surface() }, 2500);
    } catch (_) {
      /* bridge unavailable: set the element directly below */
    }
    const vv = AYT.player.video() || v;
    if (!same(vv.playbackRate, r)) {
      selfUntil = Date.now() + 700;
      try {
        vv.playbackRate = r;
      } catch (_) {
        throw coded(t('tools.speed.failed'), 'rate');
      }
    }
    scheduleVerify();
    return { rate: vv.playbackRate };
  }

  /**
   * Sets the rate chosen by the user (panel, commands). Resolves { rate } or { deferred: true }
   * while an ad plays (applied when the content resumes).
   */
  async function setRate(rate, opts) {
    const r = clampRate(rate);
    desired = same(r, 1) ? null : r;
    reapplies = 0;
    if (remember()) storeRate(r);
    let res;
    try {
      res = await applyRate(r);
    } finally {
      notify();
    }
    if (opts && opts.osd) showOsd(res && res.deferred ? r : currentRate());
    return res;
  }

  /** YouTube changed the rate on its own: put ours back (bounded, so we never fight forever). */
  function scheduleReapply() {
    clearTimeout(reapplyTimer);
    reapplyTimer = setTimeout(() => {
      if (desired == null) return;
      const v = AYT.player.video();
      if (!v || AYT.player.isAdPlaying() || speedmasterActive()) return;
      if (same(v.playbackRate, desired)) return;
      if (++reapplies > 8) return;
      applyRate(desired).catch(() => {});
    }, 60);
  }

  function scheduleVerify() {
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(() => {
      const v = AYT.player.video();
      if (desired != null && v && !same(v.playbackRate, desired)) scheduleReapply();
    }, 1200);
  }

  /** YouTube's press-and-hold 2× ("speedmaster") is temporary: never fight or adopt it. */
  function speedmasterActive() {
    const root = AYT.player.root();
    const el = root && root.querySelector('.ytp-speedmaster-overlay');
    if (!el) return false;
    try {
      return getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
    } catch (_) {
      return false;
    }
  }

  /** The user picked a speed with YouTube's own controls: make it ours. */
  function adopt(r) {
    const c = clampRate(r);
    desired = same(c, 1) ? null : c;
    reapplies = 0;
    if (remember()) storeRate(c);
  }

  /* ------------------------------------------------------------------ media/user events */
  function onRateChange(e) {
    if (!isMainVideo(e.target)) return;
    notify();
    const now = Date.now();
    if (now < selfUntil) return;
    if (AYT.player.isAdPlaying() || speedmasterActive()) return;
    const r = e.target.playbackRate;
    if (desired != null && same(r, desired)) return;
    const sourceChanged = now - srcChangeAt < 4000;
    if (!sourceChanged && now - userAt < 1500) {
      adopt(r);
      return;
    }
    if (desired != null) scheduleReapply();
  }

  function onSourceChange(e) {
    if (isMainVideo(e.target)) srcChangeAt = Date.now();
  }

  function onPlayable(e) {
    if (isMainVideo(e.target) && desired != null) scheduleReapply();
  }

  const MENU_SEL = '.ytp-settings-menu, .ytp-popup, ytd-popup-container, tp-yt-iron-dropdown, yt-sheet-view-model, ytd-menu-popup-renderer';
  function onUserClick(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const n of path) {
      if (n && n.nodeType === 1 && typeof n.matches === 'function' && n.matches(MENU_SEL)) {
        userAt = Date.now();
        return;
      }
    }
  }

  function onUserKey(e) {
    if (e.key === '>' || e.key === '<') userAt = Date.now();
  }

  /* ------------------------------------------------------------------ on-player indicator */
  const OSD_CSS = `
.ayt-osd-wrap { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
.ayt-osd {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 12px 22px 12px 18px; border-radius: 999px;
  /* opaque, no backdrop-filter: blurring the playing video behind it costs a repaint on every frame */
  background: #121216; color: #fff;
  font: 600 24px/1 var(--ayt-font); font-variant-numeric: tabular-nums; letter-spacing: -.3px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .35);
  opacity: 0; transform: scale(.9);
  transition: opacity .16s ease, transform .2s cubic-bezier(.2, .8, .2, 1);
}
.ayt-osd.is-visible { opacity: 1; transform: none; }
.ayt-osd .ayt-icon { color: #ff5b61; }
`;
  let osdHost = null;
  let osdBubble = null;
  let osdTimer = 0;

  function showOsd(rate) {
    const root = AYT.player.root();
    if (!root) return;
    if (!osdHost) {
      osdHost = h('div', {
        class: 'ayt-osd-host',
        style: 'position: absolute; inset: 0; z-index: 75; pointer-events: none; display: block; margin: 0; padding: 0; border: 0;',
      });
      const sh = osdHost.attachShadow({ mode: 'open' });
      AYT.ui.mountStyles(sh, OSD_CSS);
      osdBubble = h('div', { class: 'ayt-osd', role: 'status', 'aria-live': 'polite' });
      sh.appendChild(h('div', { class: 'ayt-root ayt-osd-wrap' }, osdBubble));
    }
    if (osdHost.parentNode !== root) root.appendChild(osdHost);
    AYT.dom.render(osdBubble, icon('speed', { size: 26 }), h('span', null, t('tools.speed.value', { rate: formatRate(rate) })));
    void osdBubble.offsetWidth; // restart the transition
    osdBubble.classList.add('is-visible');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => osdBubble.classList.remove('is-visible'), 900);
  }

  /* ------------------------------------------------------------------ commands */
  async function step(dir) {
    if (!AYT.player.video()) {
      AYT.ui.toast(t('error.noVideo'), { kind: 'warn' });
      return null;
    }
    const cur = currentRate() || 1;
    const next = nextRate(desired != null && AYT.player.isAdPlaying() ? desired : cur, dir);
    try {
      await setRate(next, { osd: true });
      AYT.toolbar.flash('speed');
      return next;
    } catch (e) {
      AYT.ui.toast(e.message || t('tools.speed.failed'), { kind: 'error' });
      return null;
    }
  }

  async function reset() {
    if (!AYT.player.video()) {
      AYT.ui.toast(t('error.noVideo'), { kind: 'warn' });
      return null;
    }
    try {
      await setRate(1, { osd: true });
      return 1;
    } catch (e) {
      AYT.ui.toast(e.message || t('tools.speed.failed'), { kind: 'error' });
      return null;
    }
  }

  /* ------------------------------------------------------------------ panel */
  AYT.ui.addStyles(`
.ayt-speed { display: flex; flex-direction: column; gap: 14px; }
.ayt-speed-head { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 0 0; }
.ayt-speed-big {
  font: 700 46px/1.05 var(--ayt-font); letter-spacing: -1px; font-variant-numeric: tabular-nums;
  color: var(--ayt-text); transition: color .2s;
}
.ayt-speed-big.is-changed { color: var(--ayt-accent); }
.ayt-speed-sub { min-height: 15px; font: 500 12px/1.25 var(--ayt-font); color: var(--ayt-text-3); }
.ayt-speed-row { display: flex; align-items: center; gap: 6px; }
.ayt-speed-row .ayt-slider { flex: 1 1 auto; min-width: 0; }
.ayt-tools-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ayt-tools-chip {
  all: unset; box-sizing: border-box; cursor: pointer; user-select: none;
  height: 30px; min-width: 50px; padding: 0 10px; border-radius: 999px;
  display: inline-flex; align-items: center; justify-content: center;
  font: 500 13px/1 var(--ayt-font); font-variant-numeric: tabular-nums;
  color: var(--ayt-text); background: var(--ayt-surface-2);
  transition: background .15s, color .15s, box-shadow .2s, transform .1s;
}
.ayt-tools-chip:hover { background: var(--ayt-surface-hover); }
.ayt-tools-chip:active { transform: scale(.96); }
.ayt-tools-chip:focus-visible { outline: 2px solid var(--ayt-focus); outline-offset: 2px; }
.ayt-tools-chip.is-selected {
  color: #fff; background: var(--ayt-accent-fill);
  box-shadow: 0 4px 14px var(--ayt-accent-glow);
}
.ayt-speed-custom { display: grid; grid-template-columns: auto 92px minmax(0, 1fr); align-items: center; gap: 10px; }
.ayt-speed-custom .ayt-label { white-space: nowrap; }
.ayt-speed-custom .ayt-input { height: 34px; text-align: center; font-variant-numeric: tabular-nums; }
.ayt-speed-custom .ayt-hint { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ayt-speed-note:empty { display: none; }
`);

  function renderPanel() {
    const root = h('div', { class: 'ayt-speed' });
    const big = h('div', { class: 'ayt-speed-big', 'aria-live': 'polite' });
    const sub = h('div', { class: 'ayt-speed-sub' });
    let sliding = false;
    const throttledSet = U.throttle((v) => uiSet(v), 90);
    const slider = AYT.ui.slider({
      min: SLIDER_MIN,
      max: SLIDER_MAX,
      step: 0.05,
      value: U.clamp(currentRate() || 1, SLIDER_MIN, SLIDER_MAX),
      showValue: false,
      ariaLabel: t('toolbar.speed'),
      onInput: (v) => throttledSet(v),
      onChange: (v) => uiSet(v),
    });
    slider.input.addEventListener('pointerdown', () => (sliding = true));
    const endSlide = () => {
      if (!sliding) return;
      sliding = false;
      sync();
    };
    slider.input.addEventListener('pointerup', endSlide);
    slider.input.addEventListener('pointercancel', endSlide);
    slider.input.addEventListener('blur', endSlide);

    const minus = AYT.ui.button({ icon: 'minus', size: 'sm', variant: 'ghost', title: t('tools.speed.slower'), onClick: () => uiSet(nextRate(currentRate() || 1, -1)) });
    const plus = AYT.ui.button({ icon: 'plus', size: 'sm', variant: 'ghost', title: t('tools.speed.faster'), onClick: () => uiSet(nextRate(currentRate() || 1, 1)) });

    const chipEls = PRESETS.map((p) =>
      h(
        'button',
        { type: 'button', class: 'ayt-tools-chip', dataset: { rate: String(p) }, 'aria-pressed': 'false', on: { click: () => uiSet(p) } },
        t('tools.speed.value', { rate: formatRate(p) })
      )
    );
    const chips = h('div', { class: 'ayt-tools-chips', role: 'group', 'aria-label': t('tools.speed.presets') }, chipEls);

    const custom = h('input', {
      type: 'text',
      class: 'ayt-input',
      inputMode: 'decimal',
      spellcheck: false,
      autocomplete: 'off',
      'aria-label': t('tools.speed.custom'),
    });
    const commitCustom = () => {
      const r = parseRate(custom.value);
      if (!isFinite(r)) {
        custom.classList.add('is-invalid');
        note.textContent = t('tools.speed.invalid', { min: formatRate(MIN), max: formatRate(MAX) });
        return;
      }
      custom.classList.remove('is-invalid');
      uiSet(r);
    };
    custom.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitCustom();
      }
    });
    custom.addEventListener('change', commitCustom);
    const customRow = h(
      'div',
      { class: 'ayt-speed-custom' },
      h('span', { class: 'ayt-label' }, t('tools.speed.custom')),
      custom,
      h('span', { class: 'ayt-hint' }, t('tools.speed.customHint', { min: formatRate(MIN), max: formatRate(MAX) }))
    );

    const rememberSw = AYT.ui.switchControl({
      label: t('tools.speed.remember'),
      desc: t('tools.speed.rememberDesc'),
      checked: remember(),
      onChange: (on) => {
        AYT.settings.set('rememberSpeed', on).catch((e) => {
          rememberSw.checked = remember();
          AYT.ui.showError(e);
        });
      },
    });
    const note = h('div', { class: 'ayt-hint ayt-speed-note', role: 'status' });

    root.append(h('div', { class: 'ayt-speed-head' }, big, sub), h('div', { class: 'ayt-speed-row' }, minus, slider.el, plus), chips, customRow, rememberSw.el, note);

    const focused = (el) => {
      try {
        return el.matches(':focus');
      } catch (_) {
        return false;
      }
    };

    async function uiSet(r) {
      note.textContent = '';
      try {
        const res = await setRate(r);
        if (res && res.deferred) note.textContent = t('tools.speed.afterAd');
      } catch (e) {
        note.textContent = e.message || t('tools.speed.failed');
      }
      sync();
    }

    function sync() {
      const r = currentRate();
      const rate = r != null ? r : 1;
      big.textContent = t('tools.speed.value', { rate: formatRate(rate) });
      big.classList.toggle('is-changed', !same(rate, 1));
      sub.textContent = same(rate, 1) ? t('tools.speed.normal') : '';
      if (!sliding) slider.value = U.clamp(rate, SLIDER_MIN, SLIDER_MAX);
      for (const c of chipEls) {
        const on = same(Number(c.dataset.rate), rate);
        c.classList.toggle('is-selected', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (!focused(custom)) {
        custom.value = formatRate(rate);
        custom.classList.remove('is-invalid');
      }
      rememberSw.checked = remember();
      if (!AYT.player.video()) note.textContent = t('error.noVideo');
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
    id: 'speed',
    group: 'tools',
    order: 20,
    icon: 'speed',
    title: () => t('toolbar.speed'),
    panel: { width: 380, render: renderPanel },
    isOn: () => {
      const r = currentRate();
      return r != null && !same(r, 1);
    },
    badge: () => {
      const r = currentRate();
      return r != null && !same(r, 1) ? formatRate(r) : null;
    },
    badgeLabel: (value) => t('tools.speed.value', { rate: value }),
    commands: {
      'speed-up': () => step(1),
      'speed-down': () => step(-1),
      'speed-reset': () => reset(),
    },
  });

  AYT.features.register({
    id: 'speed',
    init() {
      document.addEventListener('ratechange', onRateChange, true);
      document.addEventListener('loadstart', onSourceChange, true);
      document.addEventListener('emptied', onSourceChange, true);
      document.addEventListener('loadeddata', onPlayable, true);
      document.addEventListener('playing', onPlayable, true);
      document.addEventListener('click', onUserClick, true);
      document.addEventListener('keydown', onUserKey, true);
      // a speed chosen less than STORE_DELAY ago is not lost when the tab is hidden or closed
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushStore();
      });
      if (remember()) {
        loadStored().then((r) => {
          if (r != null && desired == null && !same(r, 1)) {
            desired = r;
            scheduleReapply();
            notify();
          }
        });
      }
    },
    onPageChange(info, prev) {
      if (info.videoId !== prev.videoId) {
        srcChangeAt = Date.now();
        reapplies = 0;
        if (desired != null) {
          setTimeout(scheduleReapply, 600);
          setTimeout(scheduleReapply, 2000);
        }
      }
      notify();
    },
    onSettings(changes) {
      if (!('rememberSpeed' in changes)) return;
      if (changes.rememberSpeed) {
        const r = currentRate();
        storeRate(r != null ? r : 1);
      } else clearStored();
      notify();
    },
  });

  NS.speed = {
    MIN,
    MAX,
    PRESETS,
    rate: currentRate,
    setRate,
    step,
    reset,
    showOsd,
    nextRate,
    parseRate,
    clampRate,
    formatRate,
    state: () => ({ desired, rate: currentRate(), remember: remember() }),
  };
})(globalThis);
