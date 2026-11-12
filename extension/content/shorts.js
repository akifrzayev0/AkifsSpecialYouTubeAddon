/*
 * Akif's Special YouTube Addon — Shorts download button + popover (owner: TOOLS).
 *
 * On /shorts/<id> pages (setting showOnShorts) one extra round button (download icon + label,
 * styled like YouTube's own action buttons and following YouTube's dark/light theme) is inserted
 * into the active short's action column `ytd-shorts reel-action-bar-view-model`, before
 * `:scope > pivot-button-view-model` (or appended). YouTube re-creates that column on every swipe
 * (verified Nov 2026), so the same button element is re-inserted on yt-navigate-finish and from a
 * MutationObserver scoped to <ytd-shorts> (plus a slow safety timer while the tab is visible).
 *
 * Clicking it opens a popover (own shadow host appended to <body>, positioned next to the button;
 * closes on outside click, Escape, swipe/navigation) with one tab per registered toolbar panel
 * whose `surfaces` include 'shorts' (Video, Audio, Thumbnail, Subtitles — written by other
 * modules), rendered with AYT.toolbar.renderPanelInto(id, container, { surface: 'shorts', close }),
 * plus a Screenshot action when the `screenshot` toolbar action is registered.
 *
 * Public: AYT.tools.shorts = { open(), close(), isOpen(), ensure(), popoverPosition(), shortsPanels() }
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || !AYT.toolbar || !AYT.dom || !AYT.ui) return;
  const NS = (AYT.tools = AYT.tools || {});
  if (NS.shorts) return;
  const { h, icon, clear } = AYT.dom;
  const U = AYT.util;
  const t = (k, p) => AYT.t(k, p);

  const BAR_SEL = 'ytd-shorts reel-action-bar-view-model';
  const Z_POPOVER = 2100;
  const POP_WIDTH = 380;

  /* ------------------------------------------------------------------ pure helpers */

  /**
   * Fixed position for the popover next to the button: right of it when there is room, else left;
   * bottom-aligned with the button; always inside the viewport (and below the masthead).
   * btn: DOMRect-like {left, right, top, bottom}; size: {width, height}; viewport: {width, height}.
   */
  function popoverPosition(btn, size, viewport, minTop) {
    const M = 12;
    const top0 = minTop == null ? 64 : minTop;
    let left = btn.right + M;
    if (left + size.width > viewport.width - M) left = btn.left - M - size.width;
    left = U.clamp(left, M, Math.max(M, viewport.width - size.width - M));
    let top = btn.bottom - size.height;
    top = U.clamp(top, top0, Math.max(top0, viewport.height - size.height - M));
    return { left: Math.round(left), top: Math.round(top) };
  }

  /** Toolbar panel defs offered in the popover (surfaces include 'shorts', not hidden by the user). */
  function shortsPanels(defs, hidden) {
    const hid = new Set(Array.isArray(hidden) ? hidden : []);
    return (defs || []).filter((d) => d && d.panel && typeof d.panel.render === 'function' && Array.isArray(d.surfaces) && d.surfaces.includes('shorts') && !hid.has(d.id));
  }

  const call = (fn) => {
    try {
      return typeof fn === 'function' ? fn() : fn;
    } catch (_) {
      return null;
    }
  };

  function tabLabel(def) {
    switch (def.id) {
      case 'video':
        return t('tools.shorts.tabVideo');
      case 'audio':
        return t('tools.shorts.tabAudio');
      case 'thumbnail':
        return t('tools.shorts.tabThumbnail');
      case 'subtitles':
        return t('tools.shorts.tabSubtitles');
      default:
        return String(call(def.shortTitle) || call(def.title) || def.id);
    }
  }

  const setting = (name) => {
    try {
      return AYT.settings.get(name);
    } catch (_) {
      return AYT.DEFAULT_SETTINGS[name];
    }
  };
  const hiddenIds = () => setting('toolbarHidden') || [];
  const enabled = () => AYT.page.isShorts() && !!setting('showOnShorts');
  /** A real user event (or a synthetic one while AYT.testMode is set by e2e scripts). */
  const userEvent = (e) => (AYT.keys && typeof AYT.keys.trusted === 'function' ? AYT.keys.trusted(e) : !!(e && e.isTrusted));
  const visible = () => document.visibilityState === 'visible';

  /* ------------------------------------------------------------------ button */
  const BTN_CSS = `
:host { display: block; }
.ayt-sb-wrap {
  display: flex; flex-direction: column; align-items: center; width: 48px; padding-bottom: 8px; background: transparent;
  --ayt-sb-bg: rgba(0, 0, 0, .05); --ayt-sb-bg-hover: rgba(0, 0, 0, .1); --ayt-sb-fg: #0f0f0f;
  --ayt-focus: #1a73e8; /* the button follows YouTube's theme (data-dark), not ours: light focus ring */
}
:host([data-dark]) .ayt-sb-wrap { --ayt-sb-bg: rgba(255, 255, 255, .1); --ayt-sb-bg-hover: rgba(255, 255, 255, .2); --ayt-sb-fg: #f1f1f1; --ayt-focus: #3ea6ff; }
.ayt-sb {
  all: unset; box-sizing: border-box; position: relative; cursor: pointer;
  width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center;
  color: var(--ayt-sb-fg); background: var(--ayt-sb-bg);
  transition: background .15s, transform .1s, box-shadow .2s;
}
.ayt-sb:hover { background: var(--ayt-sb-bg-hover); }
.ayt-sb:active { transform: scale(.94); }
/* open popover: red ring; the keyboard focus ring (after it, so it wins) stays blue */
.ayt-sb[aria-expanded="true"] { background: var(--ayt-sb-bg-hover); box-shadow: 0 0 0 2px var(--ayt-accent); }
.ayt-sb:focus-visible { box-shadow: 0 0 0 2px var(--ayt-focus); }
.ayt-sb__brand { position: absolute; right: -2px; bottom: -2px; width: 18px; height: 18px; display: grid; place-items: center;
  border-radius: 6px; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .35)); }
.ayt-sb-label {
  margin-top: 4px; max-width: 72px; font: 400 12px/18px "Roboto", "Arial", sans-serif; color: var(--ayt-sb-fg);
  text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
}
`;
  let btnHost = null;
  let btnEl = null;
  let btnLabel = null;

  function buildButton() {
    if (btnHost) return btnHost;
    btnHost = h('div', { class: 'ayt-shorts-action', id: 'ayt-shorts-action' });
    const sh = btnHost.attachShadow({ mode: 'open' });
    AYT.ui.mountStyles(sh, BTN_CSS);
    btnEl = h(
      'button',
      {
        type: 'button',
        class: 'ayt-sb',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        on: {
          click: (e) => {
            // Script-made clicks are dropped at our shadow root (AYT.keys.isolate → guard); this also covers the
            // button being moved out of it by page script.
            if (!userEvent(e)) return;
            e.stopPropagation();
            togglePopover();
          },
        },
      },
      icon('download', { size: 24 }),
      h('span', { class: 'ayt-sb__brand', 'aria-hidden': 'true' }, icon('logo', { size: 16 }))
    );
    btnLabel = h('span', { class: 'ayt-sb-label', 'aria-hidden': 'true' });
    sh.appendChild(h('div', { class: 'ayt-root ayt-sb-wrap' }, btnEl, btnLabel));
    AYT.keys.isolate(sh); // Space/arrows on our button must not pause/swipe the short
    paintButton();
    AYT.i18n.onChange(paintButton);
    return btnHost;
  }

  function paintButton() {
    if (!btnEl) return;
    btnEl.setAttribute('aria-label', t('tools.shorts.button'));
    btnEl.title = t('tools.shorts.button');
    btnLabel.textContent = t('tools.shorts.label');
  }

  function findBar() {
    const bars = Array.from(document.querySelectorAll(BAR_SEL));
    if (bars.length <= 1) return bars[0] || null;
    const cy = window.innerHeight / 2;
    let best = null;
    let bestD = Infinity;
    for (const b of bars) {
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - cy);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best || bars[0];
  }

  /** Puts our button into the current action column (idempotent). Returns true when present. */
  function ensureButton() {
    if (!enabled()) {
      removeButton();
      return false;
    }
    const bar = findBar();
    if (!bar) return false;
    const host = buildButton();
    host.toggleAttribute('data-dark', document.documentElement.hasAttribute('dark'));
    const pivot = bar.querySelector(':scope > pivot-button-view-model');
    if (host.parentNode === bar && (!pivot || host.nextElementSibling === pivot)) return true;
    try {
      bar.insertBefore(host, pivot && pivot.parentNode === bar ? pivot : null);
    } catch (_) {
      try {
        bar.appendChild(host);
      } catch (__) {
        return false;
      }
    }
    if (popOpen) place();
    return true;
  }

  function removeButton() {
    if (btnHost && btnHost.isConnected) btnHost.remove();
  }

  /* ------------------------------------------------------------------ observing the Shorts page */
  let mo = null;
  let moTarget = null;
  let queued = false;
  let safetyTimer = 0;

  function queueEnsure() {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      ensureButton();
    }, 60);
  }

  function startObserving() {
    const target = document.querySelector('ytd-shorts');
    if (target && target !== moTarget) {
      if (mo) mo.disconnect();
      mo = new MutationObserver(queueEnsure);
      mo.observe(target, { childList: true, subtree: true });
      moTarget = target;
    }
    // the slow safety timer only runs while the tab is visible (no wake-ups in background tabs)
    if (!safetyTimer && visible()) safetyTimer = setInterval(safetyTick, 1500);
    ensureButton();
  }

  function stopSafetyTimer() {
    clearInterval(safetyTimer);
    safetyTimer = 0;
  }

  function safetyTick() {
    if (!visible()) return stopSafetyTimer();
    if (!enabled()) return sync();
    if (!moTarget || !moTarget.isConnected) startObserving();
    else ensureButton();
  }

  function onVisibility() {
    if (!visible()) stopSafetyTimer();
    else if (enabled()) startObserving(); // catch up on swipes made while hidden, restart the timer
  }

  function stopObserving() {
    if (mo) mo.disconnect();
    mo = null;
    moTarget = null;
    stopSafetyTimer();
  }

  function sync() {
    if (enabled()) startObserving();
    else {
      stopObserving();
      removeButton();
      closePopover();
    }
  }

  /* ------------------------------------------------------------------ popover */
  const POP_CSS = `
.ayt-shorts-pop {
  position: fixed; --ayt-panel-w: ${POP_WIDTH}px;
  max-height: min(760px, calc(100vh - 76px));
  transform-origin: right bottom;
}
.ayt-shorts-pop .ayt-panel__header { padding-bottom: 8px; }
.ayt-shorts-pop .ayt-panel__title .ayt-icon { flex: none; }
.ayt-shorts-tabs {
  display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 4px;
  padding: 0 12px 10px; flex: none; border-bottom: 1px solid var(--ayt-border);
}
.ayt-shorts-tab {
  all: unset; box-sizing: border-box; cursor: pointer; user-select: none; min-width: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  padding: 7px 4px 6px; border-radius: 12px;
  font: 500 12px/1.2 var(--ayt-font); color: var(--ayt-text-2);
  transition: background .15s, color .15s, box-shadow .2s;
}
.ayt-shorts-tab > span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ayt-shorts-tab:hover { background: var(--ayt-surface); color: var(--ayt-text); }
.ayt-shorts-tab:focus-visible { outline: 2px solid var(--ayt-focus); outline-offset: 1px; }
.ayt-shorts-tab[aria-selected="true"] { color: var(--ayt-text); background: var(--ayt-surface-2); box-shadow: inset 0 0 0 1px var(--ayt-border-strong); }
.ayt-shorts-tab[aria-selected="true"] .ayt-icon { color: var(--ayt-accent); }
.ayt-shorts-pop .ayt-panel__body { padding-top: 14px; min-height: 96px; }
.ayt-shorts-panel { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.ayt-shorts-pop .ayt-panel__footer { justify-content: flex-start; }
`;
  let popHost = null;
  let popWrap = null;
  let popEl = null;
  let tabEls = [];
  let panelBox = null;
  let current = null; // { id, inst: { destroy } }
  let popOpen = false;
  let lastTab = null;
  let ro = null;
  let popText = null; // popover elements whose text follows the UI language (see paintPopover)

  function ensurePopHost() {
    if (!popHost) {
      popHost = h('div', {
        id: 'ayt-shorts-pop-host',
        style: `all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: ${Z_POPOVER};`,
      });
      const sh = popHost.attachShadow({ mode: 'open' });
      AYT.ui.mountStyles(sh, POP_CSS);
      popWrap = h('div', { class: 'ayt-root' });
      AYT.ui.applyTheme(popWrap);
      sh.appendChild(popWrap);
      AYT.keys.isolate(sh, () => closePopover({ focusButton: true }));
      // Scrolling inside the popover must not swipe to the next short.
      popHost.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
      popHost.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
      // The open panel follows a language change by itself; the popover's own texts are relabelled in place, so the
      // panel keeps its state (a clip range, a chosen format…).
      AYT.i18n.onChange(paintPopover);
    }
    if (!popHost.isConnected) (document.body || document.documentElement).appendChild(popHost);
  }

  /** Writes the popover's own texts (title, tabs, close and Screenshot buttons) in the current UI language. */
  function paintPopover() {
    if (!popOpen || !popEl || !popText) return;
    const p = popText;
    popEl.setAttribute('aria-label', t('tools.shorts.button'));
    p.title.textContent = t('tools.shorts.title');
    p.close.title = t('common.close');
    p.close.setAttribute('aria-label', t('common.close'));
    if (p.tablist) p.tablist.setAttribute('aria-label', t('tools.shorts.tabs'));
    for (const b of tabEls) {
      const def = p.defs.find((d) => d.id === b.dataset.id);
      const label = def ? tabLabel(def) : b.dataset.id;
      b.title = label;
      const span = b.querySelector('span');
      if (span) span.textContent = label;
    }
    if (p.shotBtn) {
      const span = p.shotBtn.querySelector('span');
      if (span) span.textContent = t('tools.shorts.screenshot');
      p.shotBtn.title = String(call(p.shot.title) || t('tools.shorts.screenshot'));
    }
    if (!p.defs.length && panelBox) {
      clear(panelBox);
      panelBox.appendChild(AYT.ui.notice({ kind: 'info', text: t('tools.shorts.noPanels') }));
    }
    place();
  }

  function shortsCtx() {
    const videoId = AYT.page.videoId;
    return {
      surface: 'shorts',
      videoId,
      page: AYT.page.info,
      getInfo: (force) => AYT.videoInfo.get(videoId, { force: !!force }),
      close: () => closePopover(),
      refreshToolbar: () => {},
    };
  }

  function screenshotDef() {
    const d = AYT.toolbar.get('screenshot');
    return d && typeof d.onClick === 'function' && !hiddenIds().includes('screenshot') ? d : null;
  }

  function place() {
    if (!popOpen || !popEl) return;
    const anchor = btnHost && btnHost.isConnected ? (btnEl || btnHost).getBoundingClientRect() : null;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const size = { width: popEl.offsetWidth || POP_WIDTH, height: popEl.offsetHeight || 300 };
    const btn = anchor && anchor.width ? anchor : { left: vw - 80, right: vw - 32, top: vh - 120, bottom: vh - 72 };
    const pos = popoverPosition(btn, size, { width: vw, height: vh });
    popEl.style.left = pos.left + 'px';
    popEl.style.top = pos.top + 'px';
    popEl.style.transformOrigin = pos.left + size.width <= btn.left ? 'right bottom' : 'left bottom';
  }

  function destroyCurrent() {
    if (current && current.inst && typeof current.inst.destroy === 'function') {
      try {
        current.inst.destroy();
      } catch (e) {
        console.error('[AYT] shorts panel destroy failed', e);
      }
    }
    current = null;
  }

  function selectTab(id, focus) {
    if (!popOpen) return;
    destroyCurrent();
    clear(panelBox);
    for (const b of tabEls) {
      const sel = b.dataset.id === id;
      b.setAttribute('aria-selected', sel ? 'true' : 'false');
      b.tabIndex = sel ? 0 : -1;
      if (sel && focus) b.focus({ preventScroll: true });
    }
    panelBox.setAttribute('aria-labelledby', 'ayt-shorts-tab-' + id);
    try {
      const inst = AYT.toolbar.renderPanelInto(id, panelBox, { surface: 'shorts', close: () => closePopover() });
      current = { id, inst };
    } catch (e) {
      console.error('[AYT] shorts panel failed', e);
      clear(panelBox);
      panelBox.appendChild(AYT.ui.notice({ kind: 'error', text: t('tools.shorts.panelFailed', { message: (e && e.message) || String(e) }) }));
    }
    lastTab = id;
    place();
    // The panel usually replaces its loading state before the next frame (cached video info), so the
    // ResizeObserver may never see a size change: measure again once the new content is laid out.
    if (typeof g.requestAnimationFrame === 'function') g.requestAnimationFrame(() => place());
  }

  function onTabKey(e) {
    const i = tabEls.indexOf(e.currentTarget);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabEls.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabEls.length) % tabEls.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabEls.length - 1;
    if (next < 0) return;
    e.preventDefault();
    selectTab(tabEls[next].dataset.id, true);
  }

  async function runScreenshot(def, e) {
    try {
      await def.onClick(shortsCtx(), e);
    } catch (err) {
      AYT.ui.showError(err);
    }
  }

  function openPopover() {
    if (popOpen) return;
    if (AYT.client && AYT.client.invalidated) {
      AYT.ui.toast(t('toolbar.invalidated'), { kind: 'warn', duration: 0, action: { label: t('toolbar.refresh'), onClick: () => location.reload() } });
      return;
    }
    ensurePopHost();
    popOpen = true;
    const defs = shortsPanels(AYT.toolbar.list(), hiddenIds());
    const shot = screenshotDef();

    // texts are written by paintPopover() (again on a language change)
    tabEls = defs.map((d) =>
      h(
        'button',
        {
          type: 'button',
          class: 'ayt-shorts-tab',
          id: 'ayt-shorts-tab-' + d.id,
          role: 'tab',
          dataset: { id: d.id },
          'aria-selected': 'false',
          'aria-controls': 'ayt-shorts-panel',
          tabIndex: -1,
          on: { click: () => selectTab(d.id), keydown: onTabKey },
        },
        icon(String(call(d.icon) || 'download'), { size: 18 }),
        h('span')
      )
    );
    panelBox = h('div', { class: 'ayt-shorts-panel', id: 'ayt-shorts-panel', role: 'tabpanel' });

    const titleEl = h('span');
    const closeBtn = AYT.ui.button({ icon: 'x', size: 'sm', variant: 'ghost', className: 'ayt-panel__close', title: t('common.close'), onClick: () => closePopover({ focusButton: true }) });
    const header = h('div', { class: 'ayt-panel__header' }, h('div', { class: 'ayt-panel__title' }, icon('logo', { size: 20 }), titleEl), closeBtn);
    const parts = [header];
    const tablist = tabEls.length > 1 ? h('div', { class: 'ayt-shorts-tabs', role: 'tablist' }, tabEls) : null;
    if (tablist) parts.push(tablist);
    const body = h('div', { class: 'ayt-panel__body' }, panelBox);
    parts.push(body);
    let shotBtn = null;
    if (shot) {
      shotBtn = AYT.ui.button({ label: t('tools.shorts.screenshot'), icon: 'camera', size: 'sm', onClick: (e) => runScreenshot(shot, e) });
      parts.push(h('div', { class: 'ayt-panel__footer' }, shotBtn));
    }
    popEl = h('div', { class: 'ayt-panel ayt-shorts-pop', role: 'dialog' }, parts);
    popWrap.appendChild(popEl);
    popText = { title: titleEl, close: closeBtn, tablist, shotBtn, shot, defs };

    if (!defs.length) panelBox.removeAttribute('role');
    paintPopover();
    if (defs.length) {
      const first = defs.some((d) => d.id === lastTab) ? lastTab : defs[0].id;
      selectTab(first, false);
    }

    if (btnEl) btnEl.setAttribute('aria-expanded', 'true');
    place();
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => place());
      ro.observe(popEl);
    }
    document.addEventListener('pointerdown', onDocPointer, true);
    window.addEventListener('resize', place);
    document.addEventListener('yt-navigate-start', onNavigateStart, true);
    setTimeout(() => {
      if (!popOpen || !popEl) return;
      const f = popEl.querySelector('.ayt-shorts-tab[aria-selected="true"]') || popEl.querySelector('button:not(.ayt-panel__close), select, input, [tabindex="0"]');
      if (f) {
        try {
          f.focus({ preventScroll: true });
        } catch (_) {
          /* ignore */
        }
      }
    }, 30);
  }

  /** Closes the popover (no-op when closed). opts.focusButton returns focus to our Shorts button. */
  function closePopover(opts) {
    if (!popOpen) return;
    popOpen = false;
    destroyCurrent();
    if (ro) ro.disconnect();
    ro = null;
    document.removeEventListener('pointerdown', onDocPointer, true);
    window.removeEventListener('resize', place);
    document.removeEventListener('yt-navigate-start', onNavigateStart, true);
    if (popEl) popEl.remove();
    popEl = null;
    popText = null;
    tabEls = [];
    panelBox = null;
    if (btnEl) {
      btnEl.setAttribute('aria-expanded', 'false');
      if (opts && opts.focusButton && btnHost && btnHost.isConnected) {
        try {
          btnEl.focus({ preventScroll: true });
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  function togglePopover() {
    if (popOpen) closePopover();
    else openPopover();
  }

  function onDocPointer(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(popHost) || (btnHost && path.includes(btnHost))) return;
    closePopover();
  }

  function onNavigateStart() {
    closePopover();
  }

  /* ------------------------------------------------------------------ registration */
  AYT.features.register({
    id: 'shorts',
    init() {
      document.addEventListener('yt-navigate-finish', () => (enabled() ? startObserving() : sync()), true);
      document.addEventListener('visibilitychange', onVisibility);
      // Extension reloaded/updated: the open panels can't reach the background any more (the toolbar shows
      // the "refresh the page" notice); close them so they can't be clicked. A new click shows the notice.
      if (AYT.client && typeof AYT.client.on === 'function') AYT.client.on('invalidated', () => closePopover());
      sync();
    },
    onPageChange(info, prev) {
      if (info.videoId !== prev.videoId || info.type !== prev.type) closePopover();
      sync();
    },
    onSettings(changes) {
      if ('showOnShorts' in changes || 'toolbarHidden' in changes) {
        closePopover();
        sync();
      }
    },
  });

  NS.shorts = {
    open: openPopover,
    close: closePopover,
    toggle: togglePopover,
    isOpen: () => popOpen,
    ensure: ensureButton,
    button: () => btnHost,
    popoverPosition,
    shortsPanels,
  };
})(globalThis);
