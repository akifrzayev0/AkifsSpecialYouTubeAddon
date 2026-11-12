/*
 * Akif's Special YouTube Addon — Video adjustments tool (owner: TOOLS).
 *
 * Toolbar panel `adjust` (group tools, order 40): brightness, contrast, saturation (0–200 %),
 * zoom (100–300 %), rotation (0/90/180/270), horizontal/vertical flip, reset.
 * Implementation: CSS variables (--ayt-va-filter, --ayt-va-transform) set inline on the active
 * <video> only (AYT.player.video()) + html.ayt-video-adjust, whose rules in content/page.css target
 * #movie_player / #shorts-player video.html5-main-video. Variables on :root (as before) made every
 * slider step recalculate the style of YouTube's whole document (60–140 ms per step on big pages);
 * inline on the <video> only that element is recalculated. YouTube sets the video's width/height/
 * left/top one by one, which keeps our properties (verified across resize, theater, SPA navigation);
 * when the active <video> changes (watch ⇄ Shorts) the variables move with it. DOM writes are
 * coalesced to one per animation frame.
 * For 90°/270° the video is scaled to fit the player box (recomputed with a ResizeObserver).
 * Applies to this tab (also across SPA navigation) until reset; not persisted.
 *
 * AYT.videoAdjust (for screenshots): { active(), canvasFilter() → CSS filter string ('none' when
 * neutral), rotation() → 0|90|180|270, flipH(), flipV(), zoom() → factor, state() }.
 * Transform order (same as the CSS): scale(flipH ? -1 : 1, flipV ? -1 : 1) rotate(rotation) —
 * i.e. the flips are applied in screen space after the rotation.
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || !AYT.toolbar || !AYT.dom || !AYT.ui) return;
  const NS = (AYT.tools = AYT.tools || {});
  if (NS.adjust) return;
  const { h, icon } = AYT.dom;
  const U = AYT.util;
  const t = (k, p) => AYT.t(k, p);

  const DEFAULTS = Object.freeze({ brightness: 100, contrast: 100, saturation: 100, zoom: 100, rotate: 0, flipH: false, flipV: false });
  const LIMITS = Object.freeze({ brightness: [0, 200], contrast: [0, 200], saturation: [0, 200], zoom: [100, 300] });
  const ROTATIONS = [0, 90, 180, 270];

  /* ------------------------------------------------------------------ pure helpers */
  function isDefault(s) {
    return Object.keys(DEFAULTS).every((k) => s[k] === DEFAULTS[k]);
  }

  /** Sanitizes a partial state update. */
  function normalize(patch, base) {
    const out = Object.assign({}, base || DEFAULTS);
    for (const k of Object.keys(patch || {})) {
      if (!(k in DEFAULTS)) continue;
      const v = patch[k];
      if (k === 'flipH' || k === 'flipV') out[k] = !!v;
      else if (k === 'rotate') {
        const r = ((Math.round(Number(v) / 90) * 90) % 360 + 360) % 360;
        out.rotate = isFinite(r) ? r : 0;
      } else {
        const n = Math.round(Number(v));
        if (isFinite(n)) out[k] = U.clamp(n, LIMITS[k][0], LIMITS[k][1]);
      }
    }
    return out;
  }

  /** CSS/canvas filter for the colour adjustments ('none' when neutral). */
  function filterString(s) {
    const parts = [];
    if (s.brightness !== 100) parts.push(`brightness(${s.brightness / 100})`);
    if (s.contrast !== 100) parts.push(`contrast(${s.contrast / 100})`);
    if (s.saturation !== 100) parts.push(`saturate(${s.saturation / 100})`);
    return parts.length ? parts.join(' ') : 'none';
  }

  /**
   * Scale that makes a video rotated by 90/270° fit the player box.
   * box = { pw, ph } player size and { vw, vh } the (unrotated) video element size.
   */
  function fitScale(rotation, box) {
    if (!(rotation % 180)) return 1;
    const b = box || {};
    if (!(b.pw > 0 && b.ph > 0 && b.vw > 0 && b.vh > 0)) return 1;
    return Math.min(b.pw / b.vh, b.ph / b.vw);
  }

  /** CSS transform for the state ('none' when neutral). */
  function transformString(s, fit) {
    const fx = s.flipH ? -1 : 1;
    const fy = s.flipV ? -1 : 1;
    const z = (s.zoom / 100) * (s.rotate % 180 ? fit || 1 : 1);
    if (fx === 1 && fy === 1 && !s.rotate && Math.abs(z - 1) < 1e-4) return 'none';
    return `scale(${fx}, ${fy}) rotate(${s.rotate}deg) scale(${Math.round(z * 10000) / 10000})`;
  }

  /* ------------------------------------------------------------------ state + DOM */
  const VAR_FILTER = '--ayt-va-filter';
  const VAR_TRANSFORM = '--ayt-va-transform';
  let st = Object.assign({}, DEFAULTS);
  let fit = 1;
  let target = null; // the <video> that carries our inline variables
  let toolbarOn = false; // isOn() as the toolbar last painted it
  let frame = 0; // pending requestAnimationFrame for apply()
  let ro = null;
  let roTargets = [];
  const subs = new Set();

  function notify(on) {
    subs.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        console.error('[AYT] adjust listener failed', e);
      }
    });
    // The button only shows on/off: repainting the toolbar on every slider step is wasted work.
    if (on === toolbarOn) return;
    toolbarOn = on;
    try {
      AYT.toolbar.refresh();
    } catch (_) {
      /* ignore */
    }
  }

  function measureFit() {
    if (!(st.rotate % 180)) return 1;
    const v = AYT.player.video();
    const p = AYT.player.root();
    if (!v || !p) return fit;
    return fitScale(st.rotate, { pw: p.clientWidth, ph: p.clientHeight, vw: v.offsetWidth, vh: v.offsetHeight });
  }

  function clearVars(el) {
    if (!el || !el.style) return;
    try {
      el.style.removeProperty(VAR_FILTER);
      el.style.removeProperty(VAR_TRANSFORM);
    } catch (_) {
      /* element gone */
    }
  }

  function setVar(el, name, value) {
    if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
  }

  /**
   * Puts the variables inline on the active <video> (removes them when neutral, and from a <video>
   * that is no longer the active one). Only that element's style is recalculated.
   */
  function writeVars() {
    const v = isDefault(st) ? null : AYT.player.video();
    if (target && target !== v) clearVars(target);
    target = v && v.style ? v : null;
    if (!target) return;
    try {
      setVar(target, VAR_FILTER, filterString(st));
      setVar(target, VAR_TRANSFORM, transformString(st, fit));
    } catch (e) {
      console.warn('[AYT] adjust: could not style the video', e);
    }
  }

  function watchSize(on) {
    if (!on || typeof g.ResizeObserver !== 'function') {
      if (ro) ro.disconnect();
      roTargets = [];
      return;
    }
    const v = AYT.player.video();
    const p = AYT.player.root();
    const targets = [v, p].filter(Boolean);
    if (ro && targets.length === roTargets.length && targets.every((x, i) => x === roTargets[i])) return;
    if (!ro) {
      ro = new g.ResizeObserver(() => {
        const f = measureFit();
        if (Math.abs(f - fit) > 1e-3) {
          fit = f;
          writeVars();
        }
      });
    } else ro.disconnect();
    roTargets = targets;
    targets.forEach((x) => ro.observe(x));
  }

  function apply() {
    if (frame) {
      if (typeof g.cancelAnimationFrame === 'function') g.cancelAnimationFrame(frame);
      frame = 0;
    }
    const on = !isDefault(st);
    fit = measureFit();
    writeVars();
    watchSize(on && st.rotate % 180 !== 0);
    AYT.pageClass.set('video-adjust', on);
    notify(on);
  }

  /**
   * Coalesces state changes to one DOM update per animation frame (slider drags and key repeats
   * fire faster than that). Hidden tabs get no frames: apply right away there.
   */
  function scheduleApply() {
    if (frame) return;
    if (typeof g.requestAnimationFrame === 'function' && document.visibilityState === 'visible') {
      frame = g.requestAnimationFrame(() => {
        frame = 0;
        apply();
      });
    } else apply();
  }

  /** Updates some values: set({ brightness: 120, rotate: 90 }). The video follows on the next frame. */
  function set(patch) {
    st = normalize(patch, st);
    scheduleApply();
    return Object.assign({}, st);
  }

  function reset(key) {
    if (key && key in DEFAULTS) return set({ [key]: DEFAULTS[key] });
    st = Object.assign({}, DEFAULTS);
    scheduleApply();
    return Object.assign({}, st);
  }

  AYT.videoAdjust = {
    active: () => !isDefault(st),
    canvasFilter: () => filterString(st),
    rotation: () => st.rotate,
    flipH: () => st.flipH,
    flipV: () => st.flipV,
    zoom: () => st.zoom / 100,
    state: () => Object.assign({}, st),
  };

  /* ------------------------------------------------------------------ panel */
  AYT.ui.addStyles(`
.ayt-adjust { display: flex; flex-direction: column; gap: 6px; }
.ayt-adjust-row { display: grid; grid-template-columns: 22px 92px minmax(0, 1fr) 30px; align-items: center; gap: 8px; min-height: 38px; }
.ayt-adjust-row > .ayt-icon { color: var(--ayt-text-2); }
.ayt-adjust-name { font: 500 13px/1.25 var(--ayt-font); color: var(--ayt-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ayt-adjust-row .ayt-slider { min-width: 0; gap: 10px; }
.ayt-adjust-row .ayt-slider__value { min-width: 44px; }
.ayt-adjust-row .ayt-adjust-undo { visibility: hidden; }
.ayt-adjust-row.is-changed .ayt-adjust-undo { visibility: visible; }
.ayt-adjust-row.is-changed .ayt-adjust-name { color: var(--ayt-accent-text); }
.ayt-adjust-sep { height: 1px; background: var(--ayt-border); margin: 6px 0; }
.ayt-adjust-line { display: grid; grid-template-columns: 22px 92px minmax(0, 1fr); align-items: center; gap: 8px; min-height: 40px; }
.ayt-adjust-line > .ayt-icon { color: var(--ayt-text-2); }
.ayt-adjust-flips { display: flex; gap: 18px; flex-wrap: wrap; }
.ayt-adjust-flips .ayt-switch { padding: 2px 0; }
.ayt-adjust-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 6px; }
.ayt-adjust-foot .ayt-hint { flex: 1; min-width: 0; }
`);

  const SLIDERS = [
    { key: 'brightness', icon: 'sun', label: () => t('tools.adjust.brightness'), min: 0, max: 200, step: 5 },
    { key: 'contrast', icon: 'contrast', label: () => t('tools.adjust.contrast'), min: 0, max: 200, step: 5 },
    { key: 'saturation', icon: 'droplet', label: () => t('tools.adjust.saturation'), min: 0, max: 200, step: 5 },
    { key: 'zoom', icon: 'zoom', label: () => t('tools.adjust.zoom'), min: 100, max: 300, step: 5 },
  ];

  function renderPanel() {
    const root = h('div', { class: 'ayt-adjust' });
    const pct = (v) => U.formatPercent(Math.round(v)); // "120%" in the UI language (fr "120 %", tr "%120")
    const rows = SLIDERS.map((def) => {
      const slider = AYT.ui.slider({
        min: def.min,
        max: def.max,
        step: def.step,
        value: st[def.key],
        format: pct,
        ariaLabel: def.label(),
        onInput: (v) => set({ [def.key]: v }),
      });
      const undo = AYT.ui.button({
        icon: 'refresh',
        size: 'sm',
        variant: 'ghost',
        className: 'ayt-adjust-undo',
        title: t('tools.adjust.resetOne', { name: def.label() }),
        onClick: () => reset(def.key),
      });
      const row = h('div', { class: 'ayt-adjust-row', dataset: { key: def.key } }, icon(def.icon, { size: 18 }), h('span', { class: 'ayt-adjust-name' }, def.label()), slider.el, undo);
      // Double-click on the slider resets it, like many video editors.
      slider.input.addEventListener('dblclick', () => reset(def.key));
      return { def, slider, row };
    });

    const rotate = AYT.ui.segmented({
      options: ROTATIONS.map((r) => ({ value: r, label: t('tools.adjust.degrees', { value: r }) })),
      value: st.rotate,
      ariaLabel: t('tools.adjust.rotate'),
      onChange: (v) => set({ rotate: Number(v) }),
    });
    const flipH = AYT.ui.switchControl({ label: t('tools.adjust.flipH'), checked: st.flipH, onChange: (on) => set({ flipH: on }) });
    const flipV = AYT.ui.switchControl({ label: t('tools.adjust.flipV'), checked: st.flipV, onChange: (on) => set({ flipV: on }) });
    const resetAll = AYT.ui.button({ label: t('tools.adjust.resetAll'), icon: 'refresh', size: 'sm', onClick: () => reset() });

    root.append(
      ...rows.map((r) => r.row),
      h('div', { class: 'ayt-adjust-sep' }),
      h('div', { class: 'ayt-adjust-line' }, icon('rotate', { size: 18 }), h('span', { class: 'ayt-adjust-name' }, t('tools.adjust.rotate')), rotate.el),
      h('div', { class: 'ayt-adjust-line' }, icon('flip', { size: 18 }), h('span', { class: 'ayt-adjust-name' }, t('tools.adjust.flip')), h('div', { class: 'ayt-adjust-flips' }, flipH.el, flipV.el)),
      h('div', { class: 'ayt-adjust-foot' }, h('div', { class: 'ayt-hint' }, t('tools.adjust.hint')), resetAll)
    );

    function sync() {
      for (const r of rows) {
        if (r.slider.value !== st[r.def.key]) r.slider.value = st[r.def.key];
        r.row.classList.toggle('is-changed', st[r.def.key] !== DEFAULTS[r.def.key]);
      }
      if (rotate.value !== st.rotate) rotate.value = st.rotate;
      flipH.checked = st.flipH;
      flipV.checked = st.flipV;
      resetAll.disabled = isDefault(st);
    }

    subs.add(sync);
    sync();
    return {
      el: root,
      destroy() {
        subs.delete(sync);
      },
    };
  }

  /* ------------------------------------------------------------------ registration */
  AYT.toolbar.register({
    id: 'adjust',
    group: 'tools',
    order: 40,
    icon: 'sliders',
    title: () => t('toolbar.adjust'),
    panel: { width: 400, render: renderPanel },
    isOn: () => !isDefault(st),
  });

  let pageTimer = 0;
  AYT.features.register({
    id: 'adjust',
    onPageChange() {
      if (isDefault(st)) return;
      // Another <video> may be active now (watch ⇄ Shorts): move the variables to it right away,
      // then re-measure once the player box has settled (new aspect ratio).
      scheduleApply();
      clearTimeout(pageTimer);
      pageTimer = setTimeout(apply, 500);
    },
  });

  NS.adjust = {
    DEFAULTS,
    set,
    reset,
    state: () => Object.assign({}, st),
    isDefault,
    normalize,
    filterString,
    transformString,
    fitScale,
    fit: () => fit,
  };
})(globalThis);
