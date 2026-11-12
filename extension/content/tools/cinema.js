/*
 * Akif's Special YouTube Addon — Cinema mode (owner: TOOLS).
 *
 * Toolbar toggle `cinema` (group tools, order 60) and command `toggle-cinema`.
 * A fixed overlay (#ayt-cinema-overlay, black at `cinemaOpacity`) covers the whole page at
 * z-index 2030 (above the masthead at 2020); html.ayt-cinema raises the player container
 * (#player-container-outer, #full-bleed-container in theater mode) and our toolbar host to 2031
 * (rules in content/page.css). Clicking the overlay or pressing Escape exits (Escape in a text field
 * or with one of our panels open is left to that field / panel); leaving the watch page turns it off.
 *
 * Public: AYT.tools.cinema = { isOn(), set(on), toggle() }
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || !AYT.toolbar || !AYT.dom || !AYT.ui) return;
  const NS = (AYT.tools = AYT.tools || {});
  if (NS.cinema) return;
  const { h } = AYT.dom;
  const U = AYT.util;
  const t = (k, p) => AYT.t(k, p);

  let on = false;
  let overlay = null;

  function opacity() {
    let v = 0.9;
    try {
      v = Number(AYT.settings.get('cinemaOpacity'));
    } catch (_) {
      /* defaults */
    }
    return isFinite(v) ? U.clamp(v, 0.5, 1) : 0.9;
  }

  function ensureOverlay() {
    if (!overlay) {
      // Decorative dimming layer: keyboard / screen-reader users leave with Escape or the toolbar toggle.
      overlay = h('div', {
        id: 'ayt-cinema-overlay',
        'aria-hidden': 'true',
        on: { click: () => set(false) },
      });
    }
    overlay.title = t('tools.cinema.exit');
    overlay.style.setProperty('--ayt-cinema-opacity', String(opacity()));
    if (!overlay.isConnected) (document.body || document.documentElement).appendChild(overlay);
  }

  /**
   * Escape exits cinema mode, but only when nothing else should take it first. This listener runs
   * in the capture phase on document, before our panels' own Escape handling (AYT.keys.isolate on
   * their shadow roots), and e.target is retargeted to the shadow host there — so the real target
   * comes from composedPath().
   */
  function onKey(e) {
    if (!on || e.key !== 'Escape' || document.fullscreenElement) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const el = path[0] || e.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''))) return; // typing
    const tb = AYT.toolbar;
    if (tb && typeof tb.isOpen === 'function' && tb.isOpen()) {
      // A panel is open: Escape closes it first, the next Escape leaves cinema mode. Panels close
      // themselves for Escape pressed inside them; for any other Escape, close the panel here.
      const portal = document.getElementById('ayt-portal-host');
      const fromPanel = (portal && path.includes(portal)) || (tb.host && path.includes(tb.host));
      if (!fromPanel && typeof tb.close === 'function') tb.close();
      return;
    }
    set(false);
  }

  /** 'instant' when the user asked the system for reduced motion. */
  function scrollBehavior() {
    try {
      return g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    } catch (_) {
      return 'smooth';
    }
  }

  /** Turns cinema mode on/off (only on watch pages). Returns the new state. */
  function set(next) {
    const want = !!next && AYT.page.isWatch();
    if (want === on) return on;
    on = want;
    if (on) {
      ensureOverlay();
      // Bring the player into view when the user had scrolled down to the comments.
      const p = document.querySelector('#movie_player');
      const r = p && p.getBoundingClientRect();
      if (r && (r.bottom < 80 || r.top > window.innerHeight - 80)) {
        try {
          window.scrollTo({ top: 0, behavior: scrollBehavior() });
        } catch (_) {
          window.scrollTo(0, 0);
        }
      }
      document.addEventListener('keydown', onKey, true);
    } else {
      document.removeEventListener('keydown', onKey, true);
    }
    AYT.pageClass.set('cinema', on);
    try {
      AYT.toolbar.refresh();
    } catch (_) {
      /* ignore */
    }
    return on;
  }

  function toggle() {
    if (!AYT.page.isWatch()) {
      AYT.ui.toast(t('error.noVideo'), { kind: 'warn' });
      return false;
    }
    const res = set(!on);
    AYT.toolbar.flash('cinema');
    return res;
  }

  AYT.toolbar.register({
    id: 'cinema',
    group: 'tools',
    order: 60,
    icon: 'bulb',
    title: () => t('toolbar.cinema'),
    isOn: () => on,
    onClick: () => toggle(),
    commands: { 'toggle-cinema': () => toggle() },
  });

  AYT.features.register({
    id: 'cinema',
    onPageChange(info) {
      if (on && info.type !== 'watch') set(false);
    },
    onSettings(changes) {
      if ('cinemaOpacity' in changes && overlay) overlay.style.setProperty('--ayt-cinema-opacity', String(opacity()));
    },
  });

  NS.cinema = { isOn: () => on, set, toggle };
})(globalThis);
