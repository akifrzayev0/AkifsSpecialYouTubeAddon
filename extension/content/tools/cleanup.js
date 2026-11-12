/*
 * Akif's Special YouTube Addon — YouTube clean-up (owner: TOOLS).
 *
 *  - Keeps html.ayt-hide-comments / -related / -shorts / -endscreen / -livechat in sync with the
 *    settings hideComments / hideRelated / hideShorts / hideEndscreen / hideLiveChat
 *    (applied in init(), i.e. right after the settings load at document_start, so hidden parts
 *    never flash). The rules live in content/page.css.
 *  - Toolbar toggle `comments` (group tools, order 70) + command `toggle-comments`; while comments
 *    are hidden on a watch page a slim "Comments are hidden · Show" pill sits where they were.
 *  - Shorts guide entries: the full guide's Shorts entry has no href, so the MAIN-world bridge
 *    method `tagShortsGuide` marks it with [data-ayt-shorts] (re-run after navigation and when the
 *    guide opens).
 *  - shortsToWatch: /shorts/<id> → location.replace('/watch?v=<id>').
 *  - Toolbar action `settings` (group end, order 10) → OPEN_OPTIONS.
 *
 * Public: AYT.tools.cleanup = { setCommentsHidden(on, {toast}), classesFor(settings), shortsRedirect(path), openSettings() }
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (!AYT || !AYT.toolbar || !AYT.dom || !AYT.ui) return;
  const NS = (AYT.tools = AYT.tools || {});
  if (NS.cleanup) return;
  const { h, icon } = AYT.dom;
  const t = (k, p) => AYT.t(k, p);

  /** setting name → html class suffix */
  const CLASSES = Object.freeze({
    hideComments: 'hide-comments',
    hideRelated: 'hide-related',
    hideShorts: 'hide-shorts',
    hideEndscreen: 'hide-endscreen',
    hideLiveChat: 'hide-livechat',
  });

  /* ------------------------------------------------------------------ pure helpers */

  /** { 'hide-comments': bool, ... } for a settings object. */
  function classesFor(settings) {
    const out = {};
    for (const [name, cls] of Object.entries(CLASSES)) out[cls] = !!(settings && settings[name]);
    return out;
  }

  /** '/shorts/<id>' → '/watch?v=<id>' (null for anything else). */
  function shortsRedirect(pathname) {
    const m = /^\/shorts\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(String(pathname || ''));
    return m ? '/watch?v=' + m[1] : null;
  }

  /* ------------------------------------------------------------------ settings → page classes */
  const setting = (name) => {
    try {
      return AYT.settings.get(name);
    } catch (_) {
      return AYT.DEFAULT_SETTINGS[name];
    }
  };
  const commentsHidden = () => !!setting('hideComments');
  /** A real user event (or a synthetic one while AYT.testMode is set by e2e scripts). */
  const userEvent = (e) => (AYT.keys && typeof AYT.keys.trusted === 'function' ? AYT.keys.trusted(e) : !!(e && e.isTrusted));

  function applyClasses(all) {
    const map = classesFor(all || AYT.settings.all());
    for (const [cls, on] of Object.entries(map)) AYT.pageClass.set(cls, on);
  }

  function refreshToolbar() {
    try {
      AYT.toolbar.refresh();
    } catch (_) {
      /* ignore */
    }
  }

  /** Hides/shows comments (persisted setting). The page class flips first so it feels instant. */
  async function setCommentsHidden(on, opts) {
    const want = !!on;
    AYT.pageClass.set(CLASSES.hideComments, want);
    try {
      await AYT.settings.set('hideComments', want);
    } catch (e) {
      AYT.pageClass.set(CLASSES.hideComments, commentsHidden());
      refreshToolbar();
      AYT.ui.toast(t('error.generic', { message: (e && e.message) || String(e) }), { kind: 'error' });
      return commentsHidden();
    }
    syncPill();
    refreshToolbar();
    if (opts && opts.toast) AYT.ui.toast(want ? t('tools.comments.hiddenToast') : t('tools.comments.shownToast'), { kind: 'success', duration: 2000 });
    return want;
  }

  /* ------------------------------------------------------------------ "Comments are hidden" pill */
  const PILL_CSS = `
:host { display: block; }
.ayt-comments-wrap { display: block; background: transparent; }
.ayt-comments-pill {
  display: inline-flex; align-items: center; gap: 10px; max-width: 100%;
  padding: 5px 5px 5px 14px; border-radius: 999px;
  background: var(--ayt-surface); border: 1px solid var(--ayt-border);
  font: 500 14px/1.2 var(--ayt-font); color: var(--ayt-text-2);
}
.ayt-comments-pill > .ayt-icon { color: var(--ayt-text-3); }
.ayt-comments-dot { color: var(--ayt-text-3); }
.ayt-comments-show {
  all: unset; box-sizing: border-box; cursor: pointer; user-select: none;
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 14px 0 11px; border-radius: 999px;
  font: 500 13px/1 var(--ayt-font); color: var(--ayt-text); background: var(--ayt-surface-2);
  transition: background .15s, transform .1s;
}
.ayt-comments-show:hover { background: var(--ayt-surface-hover); }
.ayt-comments-show:active { transform: scale(.97); }
.ayt-comments-show:focus-visible { outline: 2px solid var(--ayt-focus); outline-offset: 2px; }
`;
  let pill = null;
  let pillText = null;
  let pillBtnText = null;
  let pillTimer = 0;

  function buildPill() {
    const host = h('div', { id: 'ayt-comments-pill' });
    const sh = host.attachShadow({ mode: 'open' });
    AYT.ui.mountStyles(sh, PILL_CSS);
    const wrap = h('div', { class: 'ayt-root ayt-comments-wrap' });
    AYT.ui.applyTheme(wrap);
    pillText = h('span', null);
    pillBtnText = h('span', null);
    // Changes a saved setting: script-made clicks are ignored (also if page script moved the button out of our root).
    const btn = h('button', { type: 'button', class: 'ayt-comments-show', on: { click: (e) => { if (userEvent(e)) setCommentsHidden(false); } } }, icon('eye', { size: 16 }), pillBtnText);
    wrap.appendChild(
      h('div', { class: 'ayt-comments-pill', role: 'status' }, icon('comments-off', { size: 18 }), pillText, h('span', { class: 'ayt-comments-dot', 'aria-hidden': 'true' }, '·'), btn)
    );
    sh.appendChild(wrap);
    AYT.keys.isolate(sh); // Space/Enter on our button must not trigger YouTube's shortcuts
    paintPill();
    AYT.i18n.onChange(paintPill);
    return host;
  }

  function paintPill() {
    if (!pillText) return;
    pillText.textContent = t('tools.comments.hidden');
    pillBtnText.textContent = t('tools.comments.show');
  }

  function ensurePill() {
    if (!AYT.page.isWatch() || !commentsHidden()) return;
    const comments = document.querySelector('ytd-watch-flexy ytd-comments#comments');
    if (!comments || !comments.parentNode) return;
    if (!pill) pill = buildPill();
    if (pill.parentNode === comments.parentNode && pill.nextSibling === comments) return;
    try {
      comments.parentNode.insertBefore(pill, comments);
    } catch (_) {
      /* YouTube re-rendered in between; the next tick retries */
    }
  }

  /**
   * The pill is only kept up to date while it can be seen (watch page + comments hidden); its 1.5 s re-insert timer
   * runs only while the tab is visible (no wake-ups in background tabs; visibilitychange calls this again).
   */
  function syncPill() {
    const want = AYT.page.isWatch() && commentsHidden();
    if (want) ensurePill();
    if (want && document.visibilityState === 'visible') {
      if (!pillTimer) pillTimer = setInterval(ensurePill, 1500);
    } else if (pillTimer) {
      clearInterval(pillTimer);
      pillTimer = 0;
    }
  }

  /* ------------------------------------------------------------------ Shorts guide entries */
  let tagTimers = [];
  function tagGuide(delays) {
    if (!setting('hideShorts')) return;
    tagTimers.forEach(clearTimeout);
    tagTimers = (delays || [0]).map((ms) =>
      setTimeout(() => {
        AYT.bridge.request('tagShortsGuide', {}, 2500).catch(() => {});
      }, ms)
    );
  }

  function onClickCapture(e) {
    const el = e.target;
    if (!el || !el.closest) return;
    if (setting('hideShorts') && el.closest('#guide-button, ytd-mini-guide-renderer, tp-yt-app-drawer#guide')) tagGuide([250, 1200]);
  }

  /* ------------------------------------------------------------------ Shorts → watch */
  let redirectedTo = null;
  function maybeRedirect() {
    if (!setting('shortsToWatch') || !AYT.page.isShorts()) return false;
    const target = shortsRedirect(location.pathname);
    if (!target || redirectedTo === target) return false;
    redirectedTo = target;
    try {
      location.replace(target);
      return true;
    } catch (_) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ settings action */
  async function openSettings() {
    try {
      await AYT.client.send(AYT.MSG.OPEN_OPTIONS, {});
      return true;
    } catch (e) {
      AYT.ui.toast(t('tools.settings.openFailed'), { kind: 'error' });
      return false;
    }
  }

  /* ------------------------------------------------------------------ registration */
  AYT.toolbar.register({
    id: 'comments',
    group: 'tools',
    order: 70,
    icon: () => (commentsHidden() ? 'comments-off' : 'comments'),
    // The name already says what a click does ("Show comments" while hidden), so the button must not
    // also announce a pressed state ("Show comments, pressed" would contradict it; WAI-ARIA APG).
    title: () => (commentsHidden() ? t('toolbar.commentsShow') : t('toolbar.commentsHide')),
    isOn: () => commentsHidden(), // visual highlight only
    ariaPressed: false,
    onClick: () => setCommentsHidden(!commentsHidden()),
    commands: { 'toggle-comments': () => setCommentsHidden(!commentsHidden(), { toast: true }) },
  });

  AYT.toolbar.register({
    id: 'settings',
    group: 'end',
    order: 10,
    icon: 'settings',
    title: () => t('toolbar.settings'),
    onClick: () => openSettings(),
  });

  AYT.features.register({
    id: 'cleanup',
    init() {
      applyClasses(AYT.settings.all());
      if (maybeRedirect()) return;
      document.addEventListener('click', onClickCapture, true);
      document.addEventListener('yt-page-data-updated', ensurePill, true);
      document.addEventListener('visibilitychange', syncPill);
      syncPill();
      tagGuide([0, 1500, 4000]);
    },
    onPageChange(info) {
      if (info.type === 'shorts' && maybeRedirect()) return;
      syncPill();
      tagGuide([400, 1800]);
    },
    onSettings(changes, all) {
      if (Object.keys(CLASSES).some((k) => k in changes)) applyClasses(all);
      if ('hideComments' in changes) {
        syncPill();
        refreshToolbar();
      }
      if (changes.hideShorts) tagGuide([0, 1200]);
      if (changes.shortsToWatch) maybeRedirect();
    },
  });

  NS.cleanup = { CLASSES, classesFor, shortsRedirect, setCommentsHidden, openSettings, applyClasses };
})(globalThis);
