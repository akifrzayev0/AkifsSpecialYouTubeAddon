/*
 * Akif's Special YouTube Addon — content-script core (isolated world).
 *
 *  AYT.bridge     request/response + events with content/main-world.js (page's MAIN world)
 *  AYT.page       current page info ({ type: 'watch'|'shorts'|'other', videoId, listId, url }) + change events
 *  AYT.features   registry for non-toolbar features (cleanup, auto quality, shorts, ...)
 *  AYT.pageClass  toggles `ayt-<name>` classes on <html> (gates rules in content/page.css)
 *  AYT.player     helpers to reach the active player / <video> element
 *  AYT.keys       stops keyboard events from leaking from our UI to YouTube's shortcuts and drops script-made
 *                 (untrusted) events inside our shadow roots. AYT.testMode = true (set only by automated tests,
 *                 from this isolated world) lets synthetic events through.
 */
(function (g) {
  'use strict';
  const AYT = g.AYT;
  if (AYT.page) return;
  const U = AYT.util;

  /* =================================================================== bridge */
  const BRIDGE = 'AYT_BRIDGE_V1';
  let seq = 0;
  const pending = new Map();
  const bridgeListeners = new Map();
  let readyResolve;
  const readyPromise = new Promise((r) => (readyResolve = r));
  let isReady = false;

  function markReady() {
    if (isReady) return;
    isReady = true;
    readyResolve(true);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__ayt !== BRIDGE || d.dir !== 'm2i') return;
    if (d.re) {
      const p = pending.get(d.re);
      if (!p) return;
      pending.delete(d.re);
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.result);
      else {
        const err = new Error(d.error || 'Bridge error');
        err.code = d.code || 'bridge';
        p.reject(err);
      }
      return;
    }
    if (d.event) {
      if (d.event === 'ready') markReady();
      const set = bridgeListeners.get(d.event);
      if (set) set.forEach((fn) => { try { fn(d.payload); } catch (err) { console.error('[AYT] bridge listener', err); } });
    }
  });

  function post(msg) {
    window.postMessage(Object.assign({ __ayt: BRIDGE, dir: 'i2m' }, msg), location.origin);
  }

  function rawRequest(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = 'i' + ++seq + '_' + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        pending.delete(id);
        const err = new Error('The page did not answer (' + method + ')');
        err.code = 'timeout';
        reject(err);
      }, timeoutMs || 8000);
      pending.set(id, { resolve, reject, timer });
      post({ id, method, params: params || {} });
    });
  }

  AYT.bridge = {
    /** Resolves once the MAIN-world script answered. */
    ready() {
      if (isReady) return Promise.resolve(true);
      rawRequest('ping', {}, 1500).then(markReady, () => {});
      return readyPromise;
    },
    /**
     * request(method, params, timeoutMs) -> Promise<result>
     * NOTE: results come from the page context and must be treated as untrusted data.
     */
    async request(method, params, timeoutMs) {
      if (!isReady) {
        await Promise.race([AYT.bridge.ready(), U.sleep(4000)]);
      }
      return rawRequest(method, params, timeoutMs);
    },
    on(event, fn) {
      if (!bridgeListeners.has(event)) bridgeListeners.set(event, new Set());
      bridgeListeners.get(event).add(fn);
      return () => bridgeListeners.get(event).delete(fn);
    },
  };
  // Probe right away (MAIN world script is usually already there).
  rawRequest('ping', {}, 3000).then(markReady, () => {});

  /* =================================================================== page */
  function detect() {
    const url = location.href;
    const path = location.pathname;
    let type = 'other';
    let videoId = null;
    if (path === '/watch') {
      type = 'watch';
      videoId = new URLSearchParams(location.search).get('v');
    } else if (path.startsWith('/shorts/')) {
      type = 'shorts';
      videoId = path.split('/')[2] || null;
    } else if (path.startsWith('/live/')) {
      type = 'watch';
      videoId = path.split('/')[2] || null;
    }
    if (videoId && !/^[A-Za-z0-9_-]{11}$/.test(videoId)) videoId = null;
    if (!videoId && type !== 'other') type = 'other';
    return { type, videoId, listId: U.playlistIdFromUrl(url), url };
  }

  let current = detect();
  const pageListeners = new Set();

  function check(reason) {
    const next = detect();
    if (next.url === current.url && next.videoId === current.videoId && next.type === current.type) return;
    const prev = current;
    current = next;
    for (const fn of Array.from(pageListeners)) {
      try {
        fn(current, prev, reason);
      } catch (e) {
        console.error('[AYT] page listener failed', e);
      }
    }
  }

  // yt-navigate-finish fires on initial load, SPA navigation and every Shorts swipe; at that moment
  // movie_player.getPlayerResponse() already describes the new video (verified Nov 2026).
  document.addEventListener('yt-navigate-finish', () => check('navigate'), true);
  document.addEventListener('yt-navigate-start', () => setTimeout(() => check('navigate-start'), 0), true);
  window.addEventListener('popstate', () => check('popstate'));
  // Shorts swipes use the Navigation API ('replace' navigations), not history.pushState.
  try {
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigatesuccess', () => check('navigation'));
    }
  } catch (_) {
    /* Navigation API unavailable */
  }
  AYT.bridge.on('urlchange', () => check('history'));
  AYT.bridge.on('videochange', () => check('player'));
  // The events above cover YouTube's SPA router, history.pushState/replaceState (Navigation API) and
  // back/forward. A slow safety-net poll runs only while the tab is visible (no wake-ups in background tabs).
  const POLL_MS = 5000;
  let pollTimer = 0;
  function syncPoll() {
    const want = document.visibilityState !== 'hidden';
    if (want && !pollTimer) pollTimer = setInterval(() => check('poll'), POLL_MS);
    else if (!want && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
  }
  document.addEventListener('visibilitychange', () => {
    syncPoll();
    if (document.visibilityState !== 'hidden') check('visible');
  });
  syncPoll();

  AYT.page = {
    get info() {
      return Object.assign({}, current);
    },
    get type() {
      return current.type;
    },
    get videoId() {
      return current.videoId;
    },
    get listId() {
      return current.listId;
    },
    isWatch() {
      return current.type === 'watch';
    },
    isShorts() {
      return current.type === 'shorts';
    },
    /** fn(info, prevInfo, reason) on every page or video change. */
    onChange(fn) {
      pageListeners.add(fn);
      return () => pageListeners.delete(fn);
    },
    /** Force a re-check (e.g. after we know the player switched videos). */
    recheck() {
      check('manual');
    },
  };

  /* =================================================================== page classes */
  const activeClasses = new Set();
  AYT.pageClass = {
    set(name, on) {
      const cls = 'ayt-' + name;
      if (on) activeClasses.add(cls);
      else activeClasses.delete(cls);
      document.documentElement.classList.toggle(cls, !!on);
    },
    has(name) {
      return activeClasses.has('ayt-' + name);
    },
  };
  // YouTube occasionally rewrites <html> attributes; make sure our classes survive.
  try {
    new MutationObserver(() => {
      for (const cls of activeClasses) if (!document.documentElement.classList.contains(cls)) document.documentElement.classList.add(cls);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  } catch (_) {
    /* ignore */
  }

  /* =================================================================== features */
  const features = [];
  AYT.features = {
    /**
     * register({ id, init(), onPageChange(info, prev), onSettings(changes, all), commands: { name: fn } })
     * All hooks are optional. init() runs once after settings are loaded (see boot.js).
     */
    register(def) {
      if (!def || !def.id) throw new Error('feature needs an id');
      if (features.some((f) => f.id === def.id)) return;
      features.push(def);
    },
    list() {
      return features.slice();
    },
    get(id) {
      return features.find((f) => f.id === id) || null;
    },
  };

  /* =================================================================== player */
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  AYT.player = {
    /**
     * The YouTube player element for the current page.
     * watch: #movie_player. shorts (2026): one ytd-reel-video-renderer that moves between slots and
     * holds div#shorts-player.html5-video-player (there is no [is-active] attribute anymore).
     */
    root() {
      if (current.type === 'shorts') {
        const cands = document.querySelectorAll('ytd-shorts #shorts-player, #shorts-player, ytd-shorts .html5-video-player');
        for (const c of cands) if (visible(c)) return c;
        return cands[0] || null;
      }
      return document.querySelector('#movie_player') || document.querySelector('ytd-player .html5-video-player');
    },
    /** The <video> element that is actually playing the current video. */
    video() {
      const root = AYT.player.root();
      let v = root && root.querySelector('video.html5-main-video, video');
      if (v) return v;
      if (current.type === 'shorts') {
        const vids = Array.from(document.querySelectorAll('ytd-shorts video, #shorts-container video'));
        v = vids.find((x) => visible(x) && !x.paused) || vids.find(visible);
        if (v) return v;
      }
      return document.querySelector('#movie_player video.html5-main-video') || null;
    },
    /** True while an ad plays: the <video> element then shows the ad, not the content video. */
    isAdPlaying() {
      const root = AYT.player.root();
      return !!(root && (root.classList.contains('ad-showing') || root.classList.contains('ad-interrupting')));
    },
    currentTime() {
      const v = AYT.player.video();
      return v ? v.currentTime : 0;
    },
    duration() {
      const v = AYT.player.video();
      return v && isFinite(v.duration) ? v.duration : 0;
    },
    async seek(seconds) {
      try {
        await AYT.bridge.request('seekTo', { t: seconds, surface: current.type }, 2000);
      } catch (_) {
        const v = AYT.player.video();
        if (v) v.currentTime = seconds;
      }
    },
  };

  /* =================================================================== keyboard isolation + input guard */
  const KEY_EVENTS = ['keydown', 'keyup', 'keypress'];
  /**
   * Events that can make our UI do something. Our shadow roots are open, so a script in the page's MAIN world
   * (YouTube itself, an XSS, another extension's page script) could reach our controls and .click() them or
   * dispatch input/change/key events. Such script-made events have isTrusted === false; guard() drops them.
   * Real user input (mouse, keyboard activation of a button, label forwarding, screen readers) is trusted.
   */
  const GUARDED_EVENTS = ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'input', 'change', 'submit'];
  const guardedRoots = new WeakSet();

  /**
   * True for events made by the user (or by automated tests that set AYT.testMode = true in this isolated
   * world; page scripts live in another JS world and cannot set it). Use in handlers that start privileged
   * work, so even a control moved out of our shadow root by page script cannot be driven.
   */
  function trusted(e) {
    return !!e && (e.isTrusted === true || AYT.testMode === true);
  }

  /**
   * Drops untrusted (script-made) input events inside `root` before any of our listeners see them. There are no
   * exceptions: our own code never drives a control with el.click()/dispatchEvent (shared/ui.js segmented() selects
   * the next option directly on an arrow key).
   */
  function guard(root) {
    if (!root || typeof root.addEventListener !== 'function' || guardedRoots.has(root)) return root;
    guardedRoots.add(root);
    for (const type of GUARDED_EVENTS) {
      root.addEventListener(
        type,
        (e) => {
          if (e.isTrusted || AYT.testMode === true) return;
          e.stopImmediatePropagation();
          e.preventDefault();
        },
        true
      );
    }
    return root;
  }

  AYT.keys = {
    guard,
    trusted,
    /**
     * Stop key events originating inside `root` (a ShadowRoot or element) from reaching YouTube's
     * global shortcut handlers (space/k/j/l/f/m/0-9...), and guard the root against script-made events.
     * Escape keydown is passed to `onEscape` first; when it returns false the key counts as not handled.
     * opts.pass(event, target) → true lets that key event reach the page (e.g. YouTube shortcuts while focus
     * is on a non-interactive element of ours). `target` is the innermost element (composedPath()[0]).
     */
    isolate(root, onEscape, opts) {
      guard(root);
      const pass = opts && typeof opts.pass === 'function' ? opts.pass : null;
      for (const type of KEY_EVENTS) {
        root.addEventListener(type, (e) => {
          if (type === 'keydown' && e.key === 'Escape' && onEscape && onEscape(e) !== false) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (pass) {
            let through = false;
            try {
              through = !!pass(e, e.composedPath()[0]);
            } catch (err) {
              console.error('[AYT] keys.isolate pass() failed', err);
            }
            if (through) return;
          }
          e.stopPropagation();
        });
      }
    },
  };

  /* =================================================================== misc */
  AYT.isTopFrame = window.top === window;
  AYT.log = (...args) => console.debug('[AYT]', ...args);
})(globalThis);
