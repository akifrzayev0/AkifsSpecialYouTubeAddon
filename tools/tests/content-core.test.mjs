#!/usr/bin/env node
/*
 * Unit tests for the content-script foundation:
 *   content/core.js        AYT.keys (input guard against script-made events, key isolation), page poll gating
 *   content/main-world.js  caption cache bounds, PO-token map cap, own fetches not re-cached, ad handling
 *   content/boot.js        job snapshot only when a download can be active (stored list) or, with the job list in
 *                          the service worker's IndexedDB, once on the first visible watch page
 *   (content/toolbar.js has its own file: toolbar.test.mjs)
 * Run: node --test tools/tests/content-core.test.mjs
 *
 * The classic scripts run in a vm context with small stubs for the browser APIs they touch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = path.join(ROOT, 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Timers created by the scripts must not keep the test process alive.
const unref = (h) => {
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};

function load(sandbox, rel) {
  const file = path.join(EXT, rel);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
}

/* ================================================================== core.js */
function coreSandbox(opts = {}) {
  const docListeners = new Map();
  const intervals = [];
  const document = {
    visibilityState: opts.visibility || 'visible',
    documentElement: { classList: { toggle() {}, contains: () => false, add() {} } },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    setTimeout: (...a) => unref(setTimeout(...a)),
    clearTimeout,
    setInterval: (fn, ms) => {
      const h = unref(setInterval(fn, ms));
      intervals.push({ h, ms, cleared: false });
      return h;
    },
    clearInterval: (h) => {
      const it = intervals.find((x) => x.h === h);
      if (it) it.cleared = true;
      clearInterval(h);
    },
    document,
    location: { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', pathname: '/watch', search: '?v=dQw4w9WgXcQ', origin: 'https://www.youtube.com' },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    postMessage() {},
    addEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  sandbox.AYT = { util: { playlistIdFromUrl: () => null, sleep: (ms) => new Promise((r) => sandbox.setTimeout(r, ms)) } };
  load(sandbox, 'content/core.js');
  const fireDoc = (type) => (docListeners.get(type) || []).forEach((fn) => fn({ type }));
  return { sandbox, AYT: sandbox.AYT, document, intervals, fireDoc };
}

/** A root that records listeners; dispatch() runs capture listeners, then `atTarget`, then bubble listeners. */
function fakeRoot() {
  const ls = [];
  return {
    addEventListener(type, fn, capture) {
      ls.push({ type, fn, capture: capture === true || !!(capture && capture.capture) });
    },
    dispatch(ev, atTarget) {
      ev.eventPhase = 1;
      for (const l of ls) if (l.type === ev.type && l.capture && !ev.immediate) l.fn(ev);
      if (ev.stopped) return ev;
      ev.eventPhase = 2;
      if (atTarget) atTarget(ev);
      ev.eventPhase = 3;
      for (const l of ls) if (l.type === ev.type && !l.capture && !ev.stopped) l.fn(ev);
      ev.eventPhase = 0;
      return ev;
    },
  };
}

function fakeEvent(type, o = {}) {
  const target = o.target || el('div');
  return {
    type,
    key: o.key,
    isTrusted: !!o.trusted,
    eventPhase: 0,
    stopped: false,
    immediate: false,
    prevented: false,
    composedPath: () => [target],
    stopPropagation() {
      this.stopped = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
      this.immediate = true;
    },
    preventDefault() {
      this.prevented = true;
    },
  };
}

function el(tag, attrs = {}, parent = null) {
  return { tagName: tag.toUpperCase(), parentNode: parent, getAttribute: (n) => (n in attrs ? attrs[n] : null) };
}

test('keys.guard drops script-made (untrusted) events before our listeners, lets real input through', () => {
  const { AYT } = coreSandbox();
  const root = fakeRoot();
  AYT.keys.guard(root);
  AYT.keys.guard(root); // idempotent
  for (const type of ['click', 'mousedown', 'pointerdown', 'keydown', 'keypress', 'input', 'change', 'submit']) {
    let reached = false;
    const fake = root.dispatch(fakeEvent(type), () => (reached = true));
    assert.equal(reached, false, `${type}: untrusted event must not reach our handlers`);
    assert.ok(fake.immediate && fake.prevented, `${type}: stopped + default prevented`);
    reached = false;
    const real = root.dispatch(fakeEvent(type, { trusted: true }), () => (reached = true));
    assert.equal(reached, true, `${type}: trusted event passes`);
    assert.ok(!real.stopped && !real.prevented, `${type}: trusted event untouched`);
  }
});

test('keys.guard: AYT.testMode lets synthetic events through (automated tests only)', () => {
  const { AYT } = coreSandbox();
  const root = fakeRoot();
  AYT.keys.guard(root);
  AYT.testMode = true;
  let reached = false;
  root.dispatch(fakeEvent('click'), () => (reached = true));
  assert.equal(reached, true);
  AYT.testMode = 'yes'; // only the boolean true counts
  reached = false;
  root.dispatch(fakeEvent('click'), () => (reached = true));
  assert.equal(reached, false);
});

test('keys.guard has no exception for script-made clicks during a real keydown (segmented() selects directly)', () => {
  const { AYT } = coreSandbox();
  const root = fakeRoot();
  AYT.keys.guard(root);
  const group = el('div');
  const a = el('button', { role: 'radio' }, group);
  const b = el('button', { role: 'radio' }, group);
  let reached = null;
  // a key handler on radio `a` that calls b.click(): the scripted click never reaches our handlers
  root.dispatch(fakeEvent('keydown', { trusted: true, key: 'ArrowRight', target: a }), () => {
    reached = false;
    root.dispatch(fakeEvent('click', { target: b }), () => (reached = true));
  });
  assert.equal(reached, false);
});

test('keys.trusted()', () => {
  const { AYT } = coreSandbox();
  assert.equal(AYT.keys.trusted(null), false);
  assert.equal(AYT.keys.trusted({ isTrusted: false }), false);
  assert.equal(AYT.keys.trusted({ isTrusted: true }), true);
  AYT.testMode = true;
  assert.equal(AYT.keys.trusted({ isTrusted: false }), true);
});

test('keys.isolate: keys stop at our root by default; pass() and unhandled Escape reach the page', () => {
  const { AYT } = coreSandbox();
  // default (existing callers): every key is kept from YouTube, Escape goes to onEscape
  const r1 = fakeRoot();
  let esc = 0;
  AYT.keys.isolate(r1, () => {
    esc++;
  });
  const k = r1.dispatch(fakeEvent('keydown', { trusted: true, key: 'k' }));
  assert.ok(k.stopped && !k.prevented);
  const e1 = r1.dispatch(fakeEvent('keydown', { trusted: true, key: 'Escape' }));
  assert.equal(esc, 1);
  assert.ok(e1.stopped && e1.prevented);
  const up = r1.dispatch(fakeEvent('keyup', { trusted: true, key: ' ' }));
  assert.ok(up.stopped);
  // untrusted keys never reach onEscape
  r1.dispatch(fakeEvent('keydown', { key: 'Escape' }));
  assert.equal(esc, 1);

  // toolbar-style: only some keys are isolated, an unhandled Escape is passed on
  const r2 = fakeRoot();
  const target = el('button');
  const seen = [];
  AYT.keys.isolate(r2, () => false, {
    pass: (e, t) => {
      seen.push(t === target);
      return !['Enter', ' '].includes(e.key);
    },
  });
  assert.equal(r2.dispatch(fakeEvent('keydown', { trusted: true, key: 'k', target })).stopped, false, 'k reaches YouTube');
  assert.equal(r2.dispatch(fakeEvent('keydown', { trusted: true, key: ' ', target })).stopped, true, 'Space stays');
  const e2 = r2.dispatch(fakeEvent('keydown', { trusted: true, key: 'Escape', target }));
  assert.ok(!e2.stopped && !e2.prevented, 'unhandled Escape is not swallowed');
  assert.ok(seen.every(Boolean), 'pass() gets the innermost target');
});

test('page: the safety-net location poll runs every 5 s and only while the tab is visible', () => {
  const vis = coreSandbox({ visibility: 'visible' });
  const active = () => vis.intervals.filter((i) => !i.cleared);
  assert.deepEqual(active().map((i) => i.ms), [5000]);
  vis.document.visibilityState = 'hidden';
  vis.fireDoc('visibilitychange');
  assert.equal(active().length, 0, 'no timer in a background tab');
  vis.document.visibilityState = 'visible';
  vis.fireDoc('visibilitychange');
  assert.deepEqual(active().map((i) => i.ms), [5000]);

  const hidden = coreSandbox({ visibility: 'hidden' });
  assert.equal(hidden.intervals.length, 0);
});

/* ================================================================== main-world.js */
const VID = 'dQw4w9WgXcQ';
const BASE = 'https://www.youtube.com/api/timedtext?v=' + VID + '&exp=xpe&lang=en';

function mainWorld() {
  const posted = [];
  let onMessage = null;
  const fetchCalls = [];
  const clones = { n: 0 };
  const state = { player: null, now: null, fetchBody: 'BODY' };
  class FakeXHR {
    constructor() {
      this.listeners = {};
      this.responseType = '';
      this.responseText = '';
      this.responseURL = '';
    }
    addEventListener(t, fn) {
      (this.listeners[t] = this.listeners[t] || []).push(fn);
    }
  }
  FakeXHR.prototype.open = function () {};
  FakeXHR.prototype.send = function () {};
  const response = (body) => ({
    ok: true,
    url: '',
    text: async () => body,
    clone() {
      clones.n++;
      return response(body);
    },
  });
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextDecoder,
    setTimeout: (...a) => unref(setTimeout(...a)),
    clearTimeout,
    location: { origin: 'https://www.youtube.com', pathname: '/watch', href: 'https://www.youtube.com/watch?v=' + VID },
    document: {
      getElementById: (id) => (id === 'movie_player' ? state.player : null),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => ({ textContent: '', remove() {} }),
      head: { appendChild() {} },
      documentElement: {},
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    XMLHttpRequest: FakeXHR,
    fetch: async (url) => {
      fetchCalls.push(String(url));
      return response(state.fetchBody);
    },
    PerformanceObserver: class {
      observe() {}
    },
    postMessage: (msg) => posted.push(msg),
    addEventListener: (type, fn) => {
      if (type === 'message') onMessage = fn;
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext('const __realNow = Date.now; Date.now = () => (globalThis.__now != null ? globalThis.__now : __realNow());', sandbox);
  load(sandbox, 'content/main-world.js');
  const inner = vm.runInContext('globalThis', sandbox); // what `window` is inside the context (message source check)
  let seq = 0;
  return {
    sandbox,
    state,
    fetchCalls,
    clones,
    setNow(ms) {
      sandbox.__now = ms;
    },
    /** What the player's own XHR to /api/timedtext looks like to our hook. */
    playerXhr(url, body) {
      const x = new sandbox.XMLHttpRequest();
      x.open('GET', url);
      x.send();
      x.responseText = body || '';
      x.responseURL = url;
      for (const fn of x.listeners.load || []) fn();
    },
    async request(method, params) {
      const id = 'r' + ++seq;
      await onMessage({ source: inner, data: { __ayt: 'AYT_BRIDGE_V1', dir: 'i2m', id, method, params } });
      return posted.find((m) => m.re === id);
    },
  };
}

function fakePlayer(videoId, opts = {}) {
  const classes = new Set(opts.classes || []);
  const calls = [];
  const tracks = opts.tracks || ['en', 'de', 'fr', 'es', 'it', 'pt', 'tr', 'az'].map((l) => ({ languageCode: l, baseUrl: BASE.replace('lang=en', 'lang=' + l), kind: '', vssId: '.' + l }));
  return {
    id: 'movie_player',
    calls,
    classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
    getVideoData: () => ({ video_id: videoId }),
    getPlayerResponse: () => ({ videoDetails: { videoId }, captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } }),
    getOption: () => ({}),
    isSubtitlesOn: () => false,
    loadModule: () => calls.push('loadModule'),
    unloadModule: () => calls.push('unloadModule'),
    setOption: (...a) => {
      calls.push(['setOption', a[2]]);
      if (opts.onSetOption) opts.onSetOption(a[2]);
    },
    querySelector: () => null,
  };
}

const capParams = (lang, extra = {}) => Object.assign({ videoId: VID, languageCode: lang, kind: '', vssId: '', tlang: '', fmt: 'json3', surface: 'watch' }, extra);

test('main world: an ad playing with no caption token for the video fails fast with code "ad"', async () => {
  const mw = mainWorld();
  mw.state.player = fakePlayer(VID, { classes: ['ad-showing'] });
  const t0 = Date.now();
  const r = await mw.request('getCaptions', capParams('en'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ad');
  assert.ok(Date.now() - t0 < 1000, 'no ~21 s token trigger during the ad');
  assert.equal(mw.state.player.calls.length, 0, 'the caption track of the ad is not touched');
  mw.state.player = fakePlayer(VID, { classes: ['ad-interrupting'] });
  assert.equal((await mw.request('getCaptions', capParams('en'))).code, 'ad');
});

test('main world: the player\'s own captions are served from the page cache, at most 6 bodies (LRU)', async () => {
  const mw = mainWorld();
  mw.state.player = fakePlayer(VID, { classes: ['ad-showing'] }); // a cache miss then ends in code 'ad' at once
  const langs = ['en', 'de', 'fr', 'es', 'it', 'pt', 'tr'];
  for (const l of langs) mw.playerXhr(BASE.replace('lang=en', 'lang=' + l) + '&fmt=json3', '{"events":["' + l + '"]}');
  const got = {};
  for (const l of langs) {
    const r = await mw.request('getCaptions', capParams(l));
    got[l] = r.ok ? r.result.body : r.code;
  }
  assert.equal(got.en, 'ad', 'the least recently used body was dropped');
  for (const l of langs.slice(1)) assert.equal(got[l], '{"events":["' + l + '"]}');
});

test('main world: the caption cache has a size budget and forgets unused bodies after 30 min', async () => {
  const mw = mainWorld();
  mw.state.player = fakePlayer(VID, { classes: ['ad-showing'] });
  const big = (c) => c.repeat(3 * 1024 * 1024);
  mw.playerXhr(BASE + '&fmt=json3', big('a'));
  mw.playerXhr(BASE.replace('lang=en', 'lang=de') + '&fmt=json3', big('b'));
  assert.equal((await mw.request('getCaptions', capParams('en'))).code, 'ad', 'older big body evicted (over 4 Mi chars)');
  assert.equal((await mw.request('getCaptions', capParams('de'))).result.body.length, 3 * 1024 * 1024);
  mw.playerXhr(BASE.replace('lang=en', 'lang=fr') + '&fmt=json3', 'c'.repeat(5 * 1024 * 1024));
  assert.equal((await mw.request('getCaptions', capParams('fr'))).code, 'ad', 'a body above the whole budget is not kept');

  const t = Date.now();
  mw.setNow(t);
  mw.playerXhr(BASE.replace('lang=en', 'lang=es') + '&fmt=json3', 'small');
  mw.setNow(t + 29 * 60 * 1000);
  assert.equal((await mw.request('getCaptions', capParams('es'))).result.body, 'small');
  mw.setNow(t + 29 * 60 * 1000 + 31 * 60 * 1000); // 31 min after the last use
  assert.equal((await mw.request('getCaptions', capParams('es'))).code, 'ad');
});

test('main world: caption tokens are kept for the 50 most recent videos only', async () => {
  const mw = mainWorld();
  const ids = Array.from({ length: 60 }, (_, i) => ('vid' + String(i).padStart(2, '0') + 'xxxxxxx').slice(0, 11));
  for (const id of ids) mw.playerXhr('https://www.youtube.com/api/timedtext?v=' + id + '&lang=en&pot=TOKEN_' + id + '&c=WEB', '');
  const tryVideo = async (id) => {
    mw.state.player = fakePlayer(id, { classes: ['ad-showing'], tracks: [{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=' + id + '&exp=xpe&lang=en', kind: '' }] });
    return mw.request('getCaptions', Object.assign(capParams('en'), { videoId: id }));
  };
  assert.equal((await tryVideo(ids[0])).code, 'ad', 'oldest token dropped');
  const r = await tryVideo(ids[59]);
  assert.equal(r.ok, true, 'a known token works even during an ad');
  assert.ok(mw.fetchCalls.some((u) => u.includes('pot=TOKEN_' + ids[59])));
});

test('main world: our own caption fetch bypasses the timedtext hook (no second decode, no cache copy)', async () => {
  const mw = mainWorld();
  mw.playerXhr(BASE + '&pot=TOK&c=WEB&cver=2.1', '');
  mw.state.player = fakePlayer(VID);
  mw.state.fetchBody = 'WEBVTT\n\n00:00.000 --> 00:01.000\nhi';
  const r1 = await mw.request('getCaptions', capParams('en', { fmt: 'vtt' }));
  assert.equal(r1.ok, true);
  assert.equal(r1.result.body, mw.state.fetchBody);
  assert.ok(mw.fetchCalls[0].includes('pot=TOK') && mw.fetchCalls[0].includes('fmt=vtt'));
  assert.equal(mw.clones.n, 0, 'the fetch hook did not clone/read our response');
  await mw.request('getCaptions', capParams('en', { fmt: 'vtt' }));
  assert.equal(mw.fetchCalls.length, 2, 'not served from a cached copy of our own download');
  // the page's own fetches still go through the hook
  await mw.sandbox.fetch(BASE + '&fmt=srv3');
  await sleep(0);
  assert.equal(mw.clones.n, 1);
});

test('main world: token trigger switches the hidden caption track and restores it', async () => {
  const mw = mainWorld();
  const player = fakePlayer(VID, {
    onSetOption: (track) => {
      // the player fetches the track with its PO token
      if (track && track.languageCode) mw.playerXhr(BASE + '&fmt=json3&pot=PLAYERTOKEN&c=WEB', '');
    },
  });
  mw.state.player = player;
  const r = await mw.request('getCaptions', capParams('en', { fmt: 'srv3' }));
  assert.equal(r.ok, true);
  assert.ok(mw.fetchCalls[0].includes('pot=PLAYERTOKEN') && mw.fetchCalls[0].includes('fmt=srv3'));
  // (objects from the vm context: compare as JSON)
  assert.equal(JSON.stringify(player.calls), JSON.stringify(['loadModule', ['setOption', { languageCode: 'en' }], ['setOption', {}], 'unloadModule']));
});

/* ================================================================== boot.js */
function bootSandbox({ stored, storageFails = false, clientActive = [], pageType = 'watch', visibility = 'visible', defs = [], features = [] } = {}) {
  const storageListeners = [];
  const handlers = new Map();
  const pageListeners = new Set();
  const docListeners = new Map();
  const counts = { syncs: 0 };
  const page = { type: pageType };
  const document = {
    visibilityState: visibility,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (docListeners.has(type)) docListeners.get(type).delete(fn);
    },
  };
  const sandbox = {
    console,
    setTimeout: (...a) => unref(setTimeout(...a)),
    clearTimeout,
    document,
    chrome: {
      storage: {
        local: {
          get: async (k) => {
            if (storageFails) throw new Error('Extension context invalidated.');
            return { [k]: stored };
          },
        },
        onChanged: { addListener: (fn) => storageListeners.push(fn) },
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  load(sandbox, 'shared/constants.js');
  const AYT = sandbox.AYT;
  Object.assign(AYT, {
    isTopFrame: true,
    settings: { load: async () => ({}), get: () => 'en', onChange() {} },
    i18n: { setLanguage() {} },
    features: { list: () => features },
    page: {
      isWatch: () => page.type === 'watch',
      onChange(fn) {
        pageListeners.add(fn);
        return () => pageListeners.delete(fn);
      },
    },
    toolbar: { start() {}, list: () => defs },
    client: {
      invalidated: false,
      on(event, fn) {
        handlers.set(event, fn);
      },
      syncJobs: async () => {
        counts.syncs++;
        return [];
      },
      jobs: { isActive: (j) => !!j && !AYT.JOB_DONE_STATES.includes(j.status), active: () => clientActive },
    },
  });
  load(sandbox, 'content/boot.js');
  const change = (newValue) => storageListeners.forEach((fn) => fn({ jobs: { newValue, oldValue: [] } }, 'local'));
  const navigate = (type) => {
    page.type = type;
    for (const fn of Array.from(pageListeners)) fn({ type }, {}, 'navigate');
  };
  const setVisibility = (state) => {
    document.visibilityState = state;
    for (const fn of Array.from(docListeners.get('visibilitychange') || [])) fn({ type: 'visibilitychange' });
  };
  const visibilityListeners = () => (docListeners.get('visibilitychange') || new Set()).size;
  return { counts, change, clientActive, navigate, setVisibility, pageListeners, visibilityListeners, handlers };
}

const history = (n) => Array.from({ length: n }, (_, i) => ({ id: 'j' + i, status: i % 3 ? 'done' : 'error', kind: 'video' }));

test('boot: a command push reaches its toolbar def or feature with its options (popup link clicked: { viaKeyboard: false })', async () => {
  const calls = [];
  const b = bootSandbox({
    stored: [],
    defs: [{ id: 'video', commands: { 'open-download': (opts) => calls.push(['video', opts]) } }],
    features: [{ id: 'loop', commands: { 'toggle-loop': (opts) => calls.push(['loop', opts]) } }],
  });
  await sleep(20);
  const dispatch = b.handlers.get('command');
  assert.equal(typeof dispatch, 'function', 'boot listens for commands');
  dispatch('open-download', { viaKeyboard: false });
  dispatch('open-download');
  dispatch('toggle-loop');
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], 'video');
  assert.equal(calls[0][1].viaKeyboard, false);
  assert.equal(calls[1][1], undefined, 'a keyboard shortcut passes no options (keyboard open)');
  assert.equal(calls[2][0], 'loop');
});

test('boot: no job snapshot (no service-worker wake-up) when the stored job list has no active job', async () => {
  const b = bootSandbox({ stored: history(150) });
  await sleep(20);
  b.navigate('watch');
  b.setVisibility('visible');
  assert.equal(b.counts.syncs, 0);
});

test('boot: syncs at once when the stored job list has an active download', async () => {
  const b = bootSandbox({ stored: history(10).concat([{ id: 'x', status: 'downloading', kind: 'audio' }]), pageType: 'other', visibility: 'hidden' });
  await sleep(20);
  assert.equal(b.counts.syncs, 1);
});

test('boot: job list in IndexedDB (none in chrome.storage.local): one snapshot on the first visible watch page', async () => {
  // a watch page in a visible tab: right away (a download running across a reload gets its ring back)
  const now = bootSandbox({ stored: undefined });
  await sleep(20);
  assert.equal(now.counts.syncs, 1);
  now.navigate('watch');
  now.setVisibility('visible');
  assert.equal(now.counts.syncs, 1, 'once per tab');
  assert.equal(now.visibilityListeners(), 0, 'listeners removed');
  assert.equal(now.pageListeners.size, 1, "only boot's own feature listener is left");

  // home page first: nothing until the tab shows a watch page
  const home = bootSandbox({ stored: undefined, pageType: 'other' });
  await sleep(20);
  assert.equal(home.counts.syncs, 0, 'no toolbar, no wake-up');
  home.navigate('shorts');
  assert.equal(home.counts.syncs, 0);
  home.navigate('watch');
  assert.equal(home.counts.syncs, 1);
  home.navigate('other');
  home.navigate('watch');
  assert.equal(home.counts.syncs, 1);

  // a watch page opened in a background tab: when the tab is first shown
  const bg = bootSandbox({ stored: undefined, visibility: 'hidden' });
  await sleep(20);
  assert.equal(bg.counts.syncs, 0);
  bg.navigate('watch');
  assert.equal(bg.counts.syncs, 0, 'still hidden');
  bg.setVisibility('visible');
  assert.equal(bg.counts.syncs, 1);
  bg.setVisibility('hidden');
  bg.setVisibility('visible');
  assert.equal(bg.counts.syncs, 1);

  // storage not readable: unknown as well
  const f = bootSandbox({ storageFails: true });
  await sleep(20);
  assert.equal(f.counts.syncs, 1);
});

test('boot: a download started later syncs once (throttled); not while the tab already tracks one', async () => {
  const b = bootSandbox({ stored: history(5) });
  await sleep(20);
  b.change(history(5)); // only finished jobs
  assert.equal(b.counts.syncs, 0);
  const withActive = history(5).concat([{ id: 'n', status: 'queued' }]);
  b.change(withActive);
  await sleep(5);
  assert.equal(b.counts.syncs, 1);
  b.change(withActive); // persisted again a second later
  await sleep(5);
  assert.equal(b.counts.syncs, 1, 'throttled');
  const tracking = bootSandbox({ stored: history(5), clientActive: [{ id: 'n', status: 'queued' }] });
  await sleep(20);
  tracking.change(withActive);
  await sleep(5);
  assert.equal(tracking.counts.syncs, 0, 'the live port already delivers updates');
});
