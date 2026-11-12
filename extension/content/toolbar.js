/*
 * Akif's Special YouTube Addon — toolbar framework (isolated world).
 *
 * A row of round icon buttons injected directly above the video title on watch pages.
 * Buttons are registered by panel/tool modules:
 *
 *   AYT.toolbar.register({
 *     id: 'video', order: 10, group: 'download',          // groups: 'download' | 'tools' | 'end'
 *     icon: 'video',                                       // or () => iconName
 *     title: () => AYT.t('toolbar.video'),
 *     panel: { width: 460, render(ctx) { return { el, onOpen, onClose, destroy }; } },   // dropdown panel
 *            // panel.selfFit: true = the panel sizes/scrolls itself (otherwise the toolbar fits it, see fitOpenPanel)
 *     onClick(ctx, event) {},                              // OR an action/toggle button (no panel)
 *     isOn: () => bool,                                    // optional: highlighted toggle state (aria-pressed on an
 *                                                          //   action button)
 *     ariaPressed: false,                                  // optional: a toggle whose title changes with its state
 *                                                          //   ("Hide comments" / "Show comments"): no aria-pressed
 *     badge: () => string|number|null,                     // optional: small red counter
 *     badgeLabel: (value) => string,                       // optional: spoken text of the badge, appended to the
 *                                                          //   button's name ("Playback speed, 1.5×"). Default: the
 *                                                          //   badge text; a number on a 'download' button reads
 *                                                          //   "2 active downloads"
 *     progress: () => number|null,                         // optional: 0..100 progress ring (aria-description
 *                                                          //   "Progress: 45%")
 *     surfaces: ['watch'] | ['watch','shorts'],            // where the panel can be shown (shorts popover)
 *     commands: { 'open-download': (opts) => AYT.toolbar.open('video', opts) },   // opts: { viaKeyboard: false }
 *                                                          //   when the popup link was clicked with the mouse
 *   });
 *
 * Panel ctx = { surface, videoId, page, getInfo(force), close(), refreshToolbar(), viaKeyboard }.
 * ctx.viaKeyboard is true when the panel was opened from the keyboard (Enter/Space on the button or a keyboard
 * command); panels should only move focus onto a control that Space/Enter would activate in that case.
 * Panels are rendered in a separate "portal" layer appended to <body> so they are never clipped.
 * Call AYT.toolbar.refresh() whenever a button's isOn/badge/progress/icon may have changed. A refresh only touches
 * the DOM where something changed (the ring and its description move in whole percent) and never measures the
 * layout: an open panel follows its button through resize observers (see watchLayout).
 *
 * Keyboard model: the bar is an ARIA toolbar with one Tab stop (roving tabindex; ←/→/Home/End move between
 * buttons). Only the keys the toolbar uses are kept from YouTube, so k/j/l/f/m/digits keep working while a button
 * has focus; a mouse click never leaves focus on a button. An opened panel gets focus on its container (not on a
 * control), keys pressed there still reach YouTube, Escape closes it and returns focus to its button.
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (AYT.toolbar) return;
  const { h, icon, clear } = AYT.dom;
  const t = (k, p) => AYT.t(k, p);

  const Z = { PORTAL: 2040, RAISED: 2031 };

  /**
   * Where to insert the toolbar host, in priority order: [selector, position].
   * Verified Nov 2026: ytd-watch-metadata.watch-active-metadata is one persistent element (survives SPA
   * navigation, theater mode, live<->VOD) placed directly under the player; '#title' is NOT unique on the
   * page (15 matches), so selectors are always scoped.
   */
  const ANCHORS = [
    ['ytd-watch-flexy ytd-watch-metadata.watch-active-metadata > #above-the-fold', 'before'],
    ['ytd-watch-flexy ytd-watch-metadata.watch-active-metadata', 'prepend'],
    ['ytd-watch-flexy #below ytd-watch-metadata #title-row', 'before'],
    ['ytd-watch-flexy #primary-inner > #below', 'prepend'],
    ['ytd-watch-flexy #primary-inner > #player', 'after'],
  ];

  /** Keys the toolbar handles itself; every other key (k, j, l, f, m, digits, ↑/↓ …) still reaches YouTube. */
  const TOOLBAR_KEYS = new Set([' ', 'Spacebar', 'Enter', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);
  /** Portal-only CSS: hoverable tooltips (WCAG 1.4.13) and no focus ring around a whole focused panel. */
  const PORTAL_CSS = '.ayt-tip.is-visible.is-hover { pointer-events: auto; } .ayt-panel:focus { outline: none; }';
  const TIP_HIDE_DELAY = 150; // ms: time to move the pointer from a button onto its tooltip
  const MOUNT_CHECK_MS = 800;

  const defs = [];
  let host = null; // light-DOM element in the watch page
  let shadow = null;
  let bar = null;
  let rootWrap = null;
  let portalHost = null;
  let portal = null; // shadow root of the panel layer
  let portalWrap = null;
  let tipEl = null;
  let tipTimer = 0;
  let tipBtn = null;
  let open = null; // { def, button, panelEl, body, instance, videoId, fit, ro, layoutRo, pos }
  let invalidated = false;
  let mountTimer = 0;
  let rovingId = null; // the one toolbar button that is a Tab stop
  let fitRaf = 0;
  let posRaf = 0;
  const buttons = new Map(); // id -> button element

  /* ------------------------------------------------------------------ registry */
  function register(def) {
    if (!def || !def.id) throw new Error('toolbar button needs an id');
    if (defs.some((d) => d.id === def.id)) return;
    defs.push(Object.assign({ order: 100, group: 'tools', surfaces: ['watch'] }, def));
    defs.sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.order - b.order);
    if (bar) renderButtons();
  }
  function groupRank(gr) {
    return { download: 0, tools: 1, end: 2 }[gr] != null ? { download: 0, tools: 1, end: 2 }[gr] : 1;
  }
  const getDef = (id) => defs.find((d) => d.id === id) || null;
  const call = (fn, ...a) => {
    try {
      return typeof fn === 'function' ? fn(...a) : fn;
    } catch (e) {
      console.error('[AYT] toolbar hook failed', e);
      return null;
    }
  };

  /* ------------------------------------------------------------------ portal (panels + tooltips) */
  function ensurePortal() {
    if (portalHost && portalHost.isConnected) return;
    portalHost = h('div', {
      id: 'ayt-portal-host',
      style: `all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: ${Z.PORTAL};`,
    });
    portal = portalHost.attachShadow({ mode: 'open' });
    AYT.ui.mountStyles(portal, PORTAL_CSS);
    portalWrap = h('div', { class: 'ayt-root', style: 'position: absolute; top: 0; left: 0;' });
    AYT.ui.applyTheme(portalWrap);
    tipEl = h('div', { class: 'ayt-tip', role: 'tooltip', on: { mouseenter: () => clearTimeout(tipTimer), mouseleave: scheduleHideTip } });
    portalWrap.appendChild(tipEl);
    portal.appendChild(portalWrap);
    // Keys on the focused panel container itself (not on one of its controls) go on to YouTube's shortcuts.
    AYT.keys.isolate(portal, onPortalEscape, { pass: (e, target) => !!open && target === open.panelEl });
    (document.body || document.documentElement).appendChild(portalHost);
  }

  function showTip(button, text, viaHover) {
    ensurePortal();
    clearTimeout(tipTimer);
    tipBtn = button;
    tipEl.textContent = text;
    tipEl.classList.add('is-visible');
    tipEl.classList.toggle('is-hover', !!viaHover);
    const r = button.getBoundingClientRect();
    const tr = tipEl.getBoundingClientRect();
    let left = r.left + window.scrollX + r.width / 2 - tr.width / 2;
    left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + document.documentElement.clientWidth - tr.width - 8));
    let top = r.top + window.scrollY - tr.height - 8;
    if (r.top - tr.height - 8 < 64) top = r.bottom + window.scrollY + 8; // below when too close to the masthead
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tipBtn = null;
    if (tipEl) tipEl.classList.remove('is-visible', 'is-hover');
  }
  /** Hover tooltips stay while the pointer moves from the button onto the tooltip. */
  function scheduleHideTip() {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(hideTip, TIP_HIDE_DELAY);
  }
  const tipVisible = () => !!(tipEl && tipEl.classList.contains('is-visible'));

  /** Escape inside the panel layer: hide the tooltip, close the panel, focus its toolbar button. */
  function onPortalEscape() {
    hideTip();
    if (!open) return false;
    close({ restoreFocus: true });
    return true;
  }

  /* ------------------------------------------------------------------ mounting */
  function findAnchor() {
    for (const [sel, pos] of ANCHORS) {
      const el = document.querySelector(sel);
      if (el && el.isConnected && (pos !== 'before' || el.parentNode)) return { el, pos };
    }
    return null;
  }

  function buildHost() {
    host = h('div', { id: 'ayt-toolbar-host', style: 'display: block; position: relative; min-height: 48px;' });
    shadow = host.attachShadow({ mode: 'open' });
    AYT.ui.mountStyles(shadow, ':host { display: block; } .ayt-root { position: relative; }');
    rootWrap = h('div', { class: 'ayt-root' });
    AYT.ui.applyTheme(host);
    AYT.ui.applyTheme(rootWrap);
    bar = h('div', { class: 'ayt-toolbar', role: 'toolbar', 'aria-label': "Akif's Special YouTube Addon", on: { keydown: onBarKey } });
    rootWrap.appendChild(bar);
    shadow.appendChild(rootWrap);
    AYT.keys.isolate(shadow, onToolbarEscape, { pass: (e) => !TOOLBAR_KEYS.has(e.key) });
    renderButtons();
  }

  /** Escape on a toolbar button: hide its tooltip and close an open panel; otherwise YouTube gets the key. */
  function onToolbarEscape() {
    const handled = tipVisible() || !!open;
    hideTip();
    if (open) close();
    return handled;
  }

  function placeHost() {
    const anchor = findAnchor();
    if (!anchor) return false;
    const { el, pos } = anchor;
    try {
      if (pos === 'before') {
        if (host.nextSibling === el && host.parentNode === el.parentNode) return true;
        el.parentNode.insertBefore(host, el);
      } else if (pos === 'after') {
        if (el.nextSibling === host && host.parentNode === el.parentNode) return true;
        el.parentNode.insertBefore(host, el.nextSibling);
      } else if (pos === 'prepend') {
        if (el.firstChild === host) return true;
        el.insertBefore(host, el.firstChild);
      } else {
        if (host.parentNode === el) return true;
        el.appendChild(host);
      }
    } catch (e) {
      console.warn('[AYT] toolbar insert failed', e);
      return false;
    }
    return true;
  }

  function ensureMounted() {
    if (invalidated) return;
    if (AYT.page.type !== 'watch') {
      if (host && host.isConnected) host.remove();
      return;
    }
    if (!host) buildHost();
    if (!host.isConnected || !findAnchorMatchesHost()) {
      if (placeHost()) {
        refresh();
        if (open && open.layoutRo) watchLayout(open); // the toolbar may now sit in another column
        schedulePosition(); // the toolbar moved: an open panel follows it
      }
    }
  }

  function findAnchorMatchesHost() {
    const anchor = findAnchor();
    if (!anchor) return host.isConnected;
    const { el, pos } = anchor;
    if (pos === 'before') return host.nextSibling === el;
    if (pos === 'after') return el.nextSibling === host;
    if (pos === 'prepend') return el.firstChild === host;
    return host.parentNode === el;
  }

  /**
   * The re-check timer (YouTube renders the anchor late and sometimes re-renders around it) only runs on watch
   * pages in a visible tab: no wake-ups on other pages or in background tabs. Navigation and becoming visible
   * re-check right away.
   */
  function syncMountTimer() {
    const want = !invalidated && AYT.page.type === 'watch' && document.visibilityState !== 'hidden';
    if (want && !mountTimer) mountTimer = setInterval(ensureMounted, MOUNT_CHECK_MS);
    else if (!want && mountTimer) {
      clearInterval(mountTimer);
      mountTimer = 0;
    }
  }

  function startMountLoop() {
    syncMountTimer();
    ensureMounted();
    document.addEventListener('visibilitychange', () => {
      syncMountTimer();
      if (document.visibilityState !== 'hidden') ensureMounted();
    });
  }

  /* ------------------------------------------------------------------ buttons */
  function isHidden(def) {
    try {
      return (AYT.settings.get('toolbarHidden') || []).includes(def.id);
    } catch (_) {
      return false;
    }
  }

  function showsOnWatch(def) {
    return def.surfaces.includes('watch') && !isHidden(def) && call(def.visible) !== false;
  }

  function renderButtons() {
    if (!bar) return;
    const focused = shadow && shadow.activeElement && shadow.activeElement.dataset ? shadow.activeElement.dataset.id : null;
    clear(bar);
    buttons.clear();
    bar.appendChild(
      h('span', { class: 'ayt-tb-brand', title: "Akif's Special YouTube Addon", 'aria-hidden': 'true' }, icon('logo', { size: 22 }))
    );
    let lastGroup = null;
    for (const def of defs) {
      if (!showsOnWatch(def)) continue;
      if (lastGroup && def.group !== lastGroup) bar.appendChild(h('span', { class: 'ayt-tb-sep', 'aria-hidden': 'true' }));
      lastGroup = def.group;
      const label = () => String(call(def.title) || def.id);
      const b = h('button', {
        type: 'button',
        class: 'ayt-tb-btn',
        dataset: { id: def.id },
        'aria-haspopup': def.panel ? 'dialog' : null,
        on: {
          // A mouse click must not leave focus on the button: the toolbar keeps Space/Enter from YouTube, so a
          // focused button would turn the next Space (play/pause) into another click. Tab still focuses it.
          mousedown: (e) => e.preventDefault(),
          click: (e) => onButton(def, b, e),
          mouseenter: () => showTip(b, label(), true),
          mouseleave: scheduleHideTip,
          focus: () => {
            setRoving(def.id);
            showTip(b, label(), false);
          },
          blur: () => {
            if (tipBtn === b && !(tipEl && tipEl.classList.contains('is-hover'))) hideTip();
          },
        },
      });
      buttons.set(def.id, b);
      bar.appendChild(b);
      paintButton(def, b);
    }
    applyRoving();
    if (open) {
      const nb = buttons.get(open.def.id);
      if (nb) open.button = nb;
      schedulePosition(); // the buttons may have moved
    }
    // Keep keyboard focus when the buttons are rebuilt (language change, buttons shown/hidden).
    if (focused && buttons.has(focused)) {
      try {
        buttons.get(focused).focus({ preventScroll: true });
      } catch (_) {
        /* ignore */
      }
    }
  }

  function visibleButtons() {
    return Array.from(buttons.values()).filter((b) => b.isConnected);
  }

  /** Roving tabindex: only the current button (default: the first) is in the Tab order. */
  function applyRoving() {
    if (!buttons.size) return;
    if (!buttons.has(rovingId)) rovingId = buttons.keys().next().value;
    for (const [id, b] of buttons) b.tabIndex = id === rovingId ? 0 : -1;
  }
  function setRoving(id) {
    if (rovingId === id || !buttons.has(id)) return;
    rovingId = id;
    applyRoving();
  }

  function focusToolbarButton(b) {
    if (!b || !b.isConnected) return;
    setRoving(b.dataset.id);
    try {
      b.focus({ preventScroll: true });
    } catch (_) {
      /* ignore */
    }
  }

  /** ←/→ (wrapping), Home/End between buttons; Tab on the button of the open panel moves into that panel. */
  function onBarKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const list = visibleButtons();
    const cur = list.indexOf(shadow.activeElement);
    if (cur < 0) return;
    if (e.key === 'Tab') {
      if (!e.shiftKey && open && open.def.id === list[cur].dataset.id && open.panelEl.isConnected) {
        e.preventDefault();
        focusPanel();
      }
      return;
    }
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const rtl = getComputedStyle(bar).direction === 'rtl';
      const step = (e.key === 'ArrowRight') !== rtl ? 1 : -1;
      next = (cur + step + list.length) % list.length;
    } else return;
    e.preventDefault(); // Home/End would also scroll the page
    focusToolbarButton(list[next]);
  }

  /** Sets an attribute (removes it for null), touching the DOM only when the value changes. */
  function setAttr(el, name, value) {
    if (value == null) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  /** Spoken text of a badge value: def.badgeLabel(value), else a count of downloads, else the badge itself. */
  function badgeText(def, value) {
    if (def.badgeLabel != null) {
      const s = call(def.badgeLabel, value);
      if (s != null && s !== '') return String(s);
    }
    const n = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
    if (def.group === 'download' && Number.isInteger(n)) return t('toolbar.a11y.downloads', { count: n });
    return String(value);
  }

  function paintButton(def, b) {
    const title = String(call(def.title) || def.id);
    const iconName = call(def.icon) || 'info';
    if (b.dataset.icon !== iconName) {
      clear(b);
      b.appendChild(icon(iconName, { size: 22 }));
      b.dataset.icon = iconName;
    }
    const on = !!call(def.isOn);
    b.classList.toggle('is-on', on);
    // ariaPressed:false — the title already says what a click does ("Show comments"); "pressed" would contradict it.
    if (!def.panel && def.isOn && def.ariaPressed !== false) setAttr(b, 'aria-pressed', String(on));
    b.classList.toggle('is-open', !!(open && open.def === def));
    if (def.panel) setAttr(b, 'aria-expanded', open && open.def === def ? 'true' : 'false');

    // Whole percent: progress pushes arrive several times a second, the ring and its text change far less often.
    let ring = b.querySelector('.ayt-tb-btn__ring');
    const p = call(def.progress);
    const pct = p != null && isFinite(p) ? Math.floor(Math.max(0, Math.min(100, Number(p)))) : null;
    if (pct != null) {
      if (!ring) {
        ring = h('span', { class: 'ayt-tb-btn__ring' });
        b.appendChild(ring);
      }
      const shown = String(Math.max(2, pct));
      if (ring.style.getPropertyValue('--p') !== shown) ring.style.setProperty('--p', shown);
    } else if (ring) ring.remove();

    let dot = b.querySelector('.ayt-tb-btn__dot');
    const badge = call(def.badge);
    const hasBadge = badge != null && badge !== false && badge !== '' && badge !== 0;
    if (hasBadge) {
      if (!dot) {
        dot = h('span', { class: 'ayt-tb-btn__dot' });
        b.appendChild(dot);
      }
      const text = String(badge);
      if (dot.textContent !== text) dot.textContent = text;
    } else if (dot) dot.remove();

    // Screen readers get what the eye gets: the badge is part of the name ("Download video, 2 active downloads"),
    // the ring is a description ("Progress: 45%").
    setAttr(b, 'aria-label', hasBadge ? title + ', ' + badgeText(def, badge) : title);
    setAttr(b, 'aria-description', pct != null ? t('toolbar.a11y.progress', { percent: AYT.util.formatPercent(pct) }) : null);
  }

  function refresh() {
    if (!bar) return;
    // structural changes (hidden/visible buttons) -> full re-render (which also re-positions an open panel)
    const expected = defs.filter(showsOnWatch).map((d) => d.id).join(',');
    if (expected !== Array.from(buttons.keys()).join(',')) renderButtons();
    for (const def of defs) {
      const b = buttons.get(def.id);
      if (b) paintButton(def, b);
    }
  }

  function flash(id) {
    const b = buttons.get(id);
    if (!b) return;
    b.classList.add('is-flash');
    setTimeout(() => b.classList.remove('is-flash'), 450);
  }

  async function onButton(def, b, e) {
    // Script-made clicks are already dropped at our shadow root; this also covers a button that page script moved
    // out of it. e === null: internal call (keyboard command, AYT.toolbar.open).
    if (e && !AYT.keys.trusted(e)) return;
    hideTip();
    if (b && buttons.get(def.id) === b) setRoving(def.id);
    if (invalidated) return showInvalidated();
    // Keyboard activation of a <button> fires a click with detail 0; mouse clicks have detail >= 1.
    const viaKeyboard = !e || e.detail === 0;
    if (def.panel) {
      if (open && open.def === def) close({ restoreFocus: viaKeyboard });
      else openPanel(def, { viaKeyboard });
      return;
    }
    if (def.onClick) {
      try {
        await def.onClick(makeCtx('toolbar', close), e);
      } catch (err) {
        AYT.ui.showError(err);
      }
      refresh();
    }
  }

  /* ------------------------------------------------------------------ panels */
  function makeCtx(surface, closeFn, extra) {
    const videoId = AYT.page.videoId;
    return Object.assign(
      {
        surface,
        videoId,
        page: AYT.page.info,
        getInfo: (force) => AYT.videoInfo.get(videoId, { force: !!force }),
        close: closeFn || (() => {}),
        refreshToolbar: refresh,
        viaKeyboard: false,
      },
      extra || {}
    );
  }

  function instantiate(def, ctx) {
    const inst = def.panel.render(ctx) || {};
    if (inst instanceof g.Node) return { el: inst };
    return inst;
  }

  /**
   * opts.viaKeyboard → ctx.viaKeyboard; opts.focus === false keeps focus where it is (re-open after a language
   * change). Otherwise focus moves to the panel container: Tab then walks into the panel, Escape closes it, and
   * Space/k/arrows still control the video (nothing in the panel is activated by accident).
   */
  function openPanel(def, opts) {
    const o = opts || {};
    close();
    ensurePortal();
    const button = buttons.get(def.id);
    if (!button) return;
    const panelEl = h('div', {
      class: 'ayt-panel',
      role: 'dialog',
      tabIndex: -1,
      'aria-label': String(call(def.title) || def.id),
      style: { '--ayt-panel-w': (def.panel.width || 440) + 'px' },
      on: { keydown: onPanelKey },
    });
    const state = { def, button, panelEl, body: null, instance: null, videoId: AYT.page.videoId, fit: newFitState(), ro: null, layoutRo: null, pos: null };
    open = state;
    const ctx = makeCtx('toolbar', () => close(), { viaKeyboard: !!o.viaKeyboard });
    let inst;
    try {
      inst = instantiate(def, ctx);
    } catch (err) {
      console.error('[AYT] panel render failed', err);
      inst = { el: AYT.ui.notice({ kind: 'error', text: t('error.generic', { message: err.message }) }) };
    }
    state.instance = inst;
    const header = h(
      'div',
      { class: 'ayt-panel__header' },
      h('div', { class: 'ayt-panel__title' }, icon(call(def.panelIcon) || call(def.icon) || 'info', { size: 18 }), h('span', null, String(call(def.panelTitle) || call(def.title) || ''))),
      AYT.ui.button({
        icon: 'x',
        size: 'sm',
        variant: 'ghost',
        className: 'ayt-panel__close',
        title: t('common.close'),
        // Keyboard activation (detail 0) returns focus to the toolbar button; a mouse click does not.
        onClick: (e) => close({ restoreFocus: !e || e.detail === 0 }),
      })
    );
    const body = h('div', { class: 'ayt-panel__body' }, inst.el || null);
    state.body = body;
    panelEl.append(header, body);
    if (inst.footer) panelEl.appendChild(h('div', { class: 'ayt-panel__footer' }, inst.footer));
    portalWrap.appendChild(panelEl);
    positionPanel();
    refresh();
    call(inst.onOpen);
    if (open !== state) return; // onOpen closed it again
    watchFit(state, inst);
    watchLayout(state);
    if (o.focus !== false) focusPanel();
  }

  function focusPanel() {
    if (!open || !open.panelEl.isConnected) return;
    try {
      open.panelEl.focus({ preventScroll: true });
    } catch (_) {
      /* ignore */
    }
  }

  /** Elements of `root` that are Tab stops, in DOM order. */
  function tabStops(root) {
    return Array.from(root.querySelectorAll('button, [href], input, select, textarea, [tabindex]')).filter((el) => {
      if (el === root || el.disabled || el.tabIndex < 0 || !el.getClientRects().length) return false;
      if (getComputedStyle(el).visibility === 'hidden') return false;
      if (el.type === 'radio' && el.name && !el.checked) {
        // only the checked radio of a group is a Tab stop (the first one while none is checked)
        const group = Array.from(root.querySelectorAll('input[type="radio"]')).filter((r) => r.name === el.name);
        return !group.some((r) => r.checked) && group[0] === el;
      }
      return true;
    });
  }

  /**
   * The portal sits at the end of <body>, far from the toolbar in Tab order. Make the open panel behave as if it
   * followed its button: Shift+Tab at its start goes back to the button, Tab after its last control goes on to
   * the next toolbar button.
   */
  function onPanelKey(e) {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey || !open) return;
    const st = open;
    const stops = tabStops(st.panelEl);
    const active = portal && portal.activeElement;
    if (e.shiftKey) {
      if (!stops.length || active === st.panelEl || active === stops[0]) {
        e.preventDefault();
        focusButtonOf(st.def.id, 0);
      }
    } else if (!stops.length || active === stops[stops.length - 1]) {
      e.preventDefault();
      focusButtonOf(st.def.id, 1);
    }
  }

  /** Focuses the toolbar button `id` (offset 0) or the one after it (offset 1, falls back to `id`). */
  function focusButtonOf(id, offset) {
    const list = visibleButtons();
    const i = list.findIndex((b) => b.dataset.id === id);
    if (i < 0) return;
    focusToolbarButton(list[i + offset] || list[i]);
  }

  /**
   * Places the open panel under its button, in document coordinates (scrolling never moves it). It runs only when
   * the layout may have moved the button: on open, after the buttons were re-rendered or the toolbar re-mounted,
   * on window resizes and from the resize observer of watchLayout. A position that did not change is not written.
   */
  function positionPanel() {
    if (!open) return;
    const st = open;
    const { panelEl } = st;
    let button = st.button;
    if (!button.isConnected) {
      // the buttons were re-rendered (language change, register(), hidden buttons): follow the new one
      button = buttons.get(st.def.id);
      if (!button || !button.isConnected) return close();
      st.button = button;
    }
    // Layout boxes, not the button's / panel's own getBoundingClientRect(): their press and pop-in animations scale
    // them, and a measurement taken mid-animation would stick now that the panel is not re-measured on every refresh.
    const op = button.offsetParent || bar;
    const pr = op.getBoundingClientRect();
    const bLeft = pr.left + op.clientLeft + button.offsetLeft;
    const bBottom = pr.top + op.clientTop + button.offsetTop + button.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const width = panelEl.offsetWidth || 440;
    let left = bLeft + window.scrollX - 8;
    left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + vw - width - 12));
    const top = bBottom + window.scrollY + 8;
    if (st.pos && st.pos.left === left && st.pos.top === top) return;
    const moved = !!st.pos;
    st.pos = { left, top };
    panelEl.style.left = left + 'px';
    panelEl.style.top = top + 'px';
    if (moved) scheduleFit(); // the room below the panel changed
  }

  /** positionPanel() once, in the next frame (several triggers in one frame measure the layout once). */
  function schedulePosition() {
    if (posRaf || !open) return;
    posRaf = requestAnimationFrame(() => {
      posRaf = 0;
      positionPanel();
    });
  }

  /**
   * The open panel follows layout changes that move its button without a window resize: the toolbar's own box
   * (buttons wrapping, column width), the player's box (theater mode, mini player), the toolbar's column #below
   * (YouTube fills its alert, info-panel and shopping-shelf slots above the toolbar late, even seconds after a
   * navigation; <html> and <body> are 0 px tall on YouTube, so the page's box never grows with them) and the page's
   * box (a scrollbar appearing or going away). Resize-observer callbacks run right after layout, so measuring there
   * forces no extra layout, and a notification that moved nothing (comments loading further down the column) writes
   * nothing; refreshes for download progress never measure at all. Runs again when the toolbar is re-mounted.
   */
  function watchLayout(state) {
    if (typeof ResizeObserver !== 'function') return;
    if (state.layoutRo) state.layoutRo.disconnect();
    state.layoutRo = new ResizeObserver(() => {
      if (open === state) positionPanel();
    });
    const player = AYT.player && typeof AYT.player.root === 'function' ? AYT.player.root() : null;
    const column = host && host.closest('#below'); // none while the toolbar sits right under the player (last anchor)
    for (const el of [host, player, column, document.documentElement]) if (el) state.layoutRo.observe(el);
  }

  /* ------------------------------------------------------------------ fitting a panel into the viewport */
  function newFitState() {
    return { cap: '', foreign: false, lastWant: 0, target: null, targetAt: 0 };
  }

  function watchFit(state, inst) {
    if (state.def.panel.selfFit) return;
    scheduleFit();
    if (typeof ResizeObserver !== 'function') return;
    // The content element keeps growing while async panels load, even when the panel body is capped and scrolls.
    const target = inst && inst.el instanceof g.Element ? inst.el : state.body;
    state.ro = new ResizeObserver(() => scheduleFit());
    state.ro.observe(target);
  }

  function scheduleFit() {
    if (fitRaf || !open) return;
    fitRaf = requestAnimationFrame(() => {
      fitRaf = 0;
      fitOpenPanel();
    });
  }

  /**
   * Panels open below their button. When the space down to the bottom of the window is too small for the content,
   * scroll the page once (again only when the content grew; the button stays below YouTube's masthead) and cap the
   * panel height to the visible space so its body scrolls. Same behaviour as the video/audio panels' own
   * AYT.dl.fitPanel; a panel that sizes itself (def.panel.selfFit, or another writer of --ayt-panel-h) is left alone.
   */
  function fitOpenPanel() {
    const st = open;
    if (!st || st.def.panel.selfFit || st.fit.foreign || !st.panelEl.isConnected || !st.body) return;
    const panel = st.panelEl;
    const fit = st.fit;
    const cur = panel.style.getPropertyValue('--ayt-panel-h');
    if (cur && cur !== fit.cap) {
      fit.foreign = true; // the panel fits itself (e.g. AYT.dl.fitPanel): stay out of its way
      if (st.ro) st.ro.disconnect();
      st.ro = null;
      return;
    }
    const vh = window.innerHeight;
    const now = Date.now();
    const r = panel.getBoundingClientRect();
    const inFlight = fit.target != null && now - fit.targetAt < 1200;
    // While our own smooth scroll is still running, measure against where it will end.
    const top = inFlight ? r.top + window.scrollY - fit.target : r.top;
    const natural = panel.offsetHeight - st.body.clientHeight + st.body.scrollHeight;
    const want = Math.min(natural, 640, vh - 140);
    let avail = vh - top - 12;
    if (want > avail + 4 && want > fit.lastWant + 24) {
      const delta = Math.round(Math.min(want - avail, Math.max(0, top - 120)));
      if (delta > 4) {
        fit.target = window.scrollY + delta;
        fit.targetAt = now;
        fit.lastWant = want;
        try {
          window.scrollTo({ top: fit.target, behavior: 'smooth' });
        } catch (_) {
          window.scrollTo(0, fit.target);
        }
        avail += delta;
      }
    }
    const cap = Math.max(300, Math.floor(avail)) + 'px';
    if (cap !== cur) panel.style.setProperty('--ayt-panel-h', cap);
    fit.cap = cap;
  }

  /** True when keyboard focus is inside `panelEl` (or was lost to <body>, e.g. its focused control re-rendered). */
  function focusWasInside(panelEl) {
    const a = portal && portal.activeElement;
    if (a && panelEl.contains(a)) return true;
    const d = document.activeElement;
    return !d || d === document.body || d === document.documentElement;
  }

  /** opts.restoreFocus: focus the panel's toolbar button when focus was inside the panel (keyboard closes). */
  function close(opts) {
    if (!open) return;
    const state = open;
    open = null;
    const restore = !!(opts && opts.restoreFocus) && focusWasInside(state.panelEl);
    if (state.ro) state.ro.disconnect();
    if (state.layoutRo) state.layoutRo.disconnect();
    if (posRaf) {
      cancelAnimationFrame(posRaf);
      posRaf = 0;
    }
    call(state.instance && state.instance.onClose);
    call(state.instance && state.instance.destroy);
    state.panelEl.remove();
    refresh();
    if (restore) focusButtonOf(state.def.id, 0);
  }

  /** Render a registered panel into an arbitrary container (used by the Shorts popover). */
  function renderPanelInto(id, container, extras) {
    const def = getDef(id);
    if (!def || !def.panel) throw new Error('no panel ' + id);
    const ctx = Object.assign(makeCtx(extras && extras.surface ? extras.surface : 'shorts', extras && extras.close), extras || {});
    const inst = instantiate(def, ctx);
    clear(container);
    if (inst.el) container.appendChild(inst.el);
    if (inst.footer) container.appendChild(h('div', { class: 'ayt-panel__footer', style: 'padding: 12px 0 0; border: 0;' }, inst.footer));
    call(inst.onOpen);
    return {
      destroy() {
        call(inst.onClose);
        call(inst.destroy);
        clear(container);
      },
    };
  }

  /* ------------------------------------------------------------------ global listeners */
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!open) return;
      const path = e.composedPath();
      if (path.includes(portalHost) || path.includes(host)) return;
      close();
    },
    true
  );
  window.addEventListener('resize', () => {
    schedulePosition();
    scheduleFit();
  });
  document.addEventListener('fullscreenchange', () => close());

  function showInvalidated() {
    AYT.ui.toast(t('toolbar.invalidated'), {
      kind: 'warn',
      duration: 0,
      action: { label: t('toolbar.refresh'), onClick: () => location.reload() },
    });
  }

  function teardown() {
    invalidated = true;
    close();
    clearInterval(mountTimer);
    mountTimer = 0;
    if (host) host.remove();
    if (portalHost) portalHost.remove();
  }

  AYT.toolbar = {
    Z,
    ANCHORS,
    register,
    get: getDef,
    list: () => defs.slice(),
    /**
     * Opens a panel / runs an action as if its button was used from the keyboard (shortcuts, commands).
     * opts.viaKeyboard === false opens it like a mouse open (the popup's "open on the page" link was clicked):
     * focus stays on the panel container.
     */
    open(id, opts) {
      const def = getDef(id);
      if (!def) return;
      ensureMounted();
      if (def.panel) {
        if (!(open && open.def === def)) openPanel(def, { viaKeyboard: !(opts && opts.viaKeyboard === false) });
      } else if (def.onClick) onButton(def, buttons.get(id), null);
    },
    close,
    toggle(id) {
      if (open && open.def && open.def.id === id) close();
      else AYT.toolbar.open(id);
    },
    isOpen: (id) => !!(open && (!id || open.def.id === id)),
    refresh,
    flash,
    renderPanelInto,
    /** Called once by boot.js. */
    start() {
      startMountLoop();
      AYT.page.onChange((info, prev) => {
        if (open && (info.videoId !== open.videoId || info.type !== 'watch')) {
          const inst = open.instance;
          if (info.type === 'watch' && inst && typeof inst.onVideoChange === 'function') {
            open.videoId = info.videoId;
            open.fit.lastWant = 0; // new content: fit it again
            open.fit.target = null;
            call(inst.onVideoChange, info);
          } else close();
        }
        syncMountTimer();
        ensureMounted();
        refresh();
        schedulePosition(); // a panel kept open for the next video: the page around it was re-laid out
      });
      AYT.client.on('jobs', () => refresh());
      AYT.settings.onChange((c) => {
        // A language change is handled by the i18n listener below (it also keeps an open panel open).
        if ('toolbarHidden' in c) renderButtons();
        refresh();
      });
      AYT.i18n.onChange(() => {
        renderButtons();
        // Re-open an open panel so its header (rendered once by the toolbar) follows the new language too.
        if (open) {
          const def = open.def;
          const a = portal && portal.activeElement;
          const hadFocus = !!(a && open.panelEl.contains(a));
          close();
          openPanel(def, { focus: hadFocus });
        }
      });
      AYT.client.on('invalidated', () => {
        teardown();
        showInvalidated();
      });
    },
    get host() {
      return host;
    },
    get mounted() {
      return !!(host && host.isConnected);
    },
  };
})(globalThis);
