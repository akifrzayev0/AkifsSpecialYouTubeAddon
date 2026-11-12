#!/usr/bin/env node
/*
 * Unit tests for the TOOLS module (content/tools/*.js, content/shorts.js).
 * Run: node --test tools/tests/tools.test.mjs   (or: node tools/tests/tools.test.mjs)
 *
 * The classic content scripts are loaded into a vm context with small stubs for the browser /
 * foundation APIs they touch, then their pure helpers and core state machines are exercised.
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

/* ------------------------------------------------------------------ sandbox */
function makeSandbox() {
  const listeners = new Map(); // type -> Set(fn)
  const fakeEl = (tag) => ({
    tagName: String(tag || 'div').toUpperCase(),
    textContent: '',
    isConnected: false,
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    removeAttribute() {},
    appendChild(c) {
      return c;
    },
    append() {},
    remove() {
      this.isConnected = false;
    },
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const document = {
    visibilityState: 'hidden',
    documentElement: { classList: { toggle() {}, contains: () => false, add() {} }, hasAttribute: () => false, clientWidth: 1600 },
    head: {
      appendChild(el) {
        el.isConnected = true;
        return el;
      },
    },
    body: {
      appendChild(el) {
        el.isConnected = true;
        return el;
      },
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    dispatch(type, ev) {
      for (const fn of Array.from(listeners.get(type) || [])) fn(Object.assign({ type }, ev));
    },
    listenerCount: (type) => (listeners.get(type) ? listeners.get(type).size : 0),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: fakeEl,
  };
  const storage = {};
  // Timers created by the scripts must not keep the test process alive.
  const unref = (h) => {
    if (h && typeof h.unref === 'function') h.unref();
    return h;
  };
  const sandbox = {
    console,
    setTimeout: (...a) => unref(setTimeout(...a)),
    clearTimeout,
    setInterval: (...a) => unref(setInterval(...a)),
    clearInterval,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    document,
    location: { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', pathname: '/watch', search: '?v=dQw4w9WgXcQ', origin: 'https://www.youtube.com', replace() {} },
    navigator: { language: 'en-US' },
    innerWidth: 1600,
    innerHeight: 1000,
    getComputedStyle: () => ({ display: 'none' }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    chrome: {
      runtime: { id: 'test' },
      storage: {
        local: {
          get: async (k) => (typeof k === 'string' ? { [k]: storage[k] } : Object.assign({}, storage)),
          set: async (o) => Object.assign(storage, o),
          remove: async (k) => {
            delete storage[k];
          },
        },
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, document, storage, fakeEl };
}

function load(sandbox, rel) {
  const file = path.join(EXT, rel);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
}

/** Boots the TOOLS scripts with stubs; returns handles to inspect them. opts.globals: extra sandbox globals. */
function boot(opts = {}) {
  const { sandbox, document, storage, fakeEl } = makeSandbox();
  Object.assign(sandbox, opts.globals || {});
  for (const f of ['shared/constants.js', 'shared/utils.js', 'shared/i18n.js', 'shared/i18n/en.js']) load(sandbox, f);
  const AYT = sandbox.AYT;
  const settings = Object.assign({}, AYT.DEFAULT_SETTINGS, opts.settings || {});
  const defs = [];
  const features = [];
  const toasts = [];
  const classes = {};
  const bridgeCalls = [];
  const video = {
    tagName: 'VIDEO',
    playbackRate: 1,
    currentTime: 0,
    duration: 212,
    paused: false,
    ended: false,
    seeking: false,
    readyState: 4,
    classList: { contains: (c) => c === 'html5-main-video' },
  };
  const player = { loop: false, range: null, ad: false };
  const bridgeHandlers = Object.assign(
    {
      getPlayerState: () => ({ videoId: 'dQw4w9WgXcQ', duration: 212, loop: player.loop, qualities: ['hd1080', 'hd720', 'auto'], isAd: false }),
      setLoop: (p) => {
        player.loop = !!p.on;
        return { viaApi: true };
      },
      setLoopRange: (p) => {
        if (opts.nativeLoop === false) return { supported: false };
        player.range = p.start == null ? null : { startTimeMs: p.start * 1000, endTimeMs: p.end * 1000 };
        return { supported: true, range: player.range };
      },
      setPlaybackRate: (p) => {
        // like the real bridge: API for YouTube's list, the <video> directly otherwise
        video.playbackRate = p.rate;
        return { viaApi: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(p.rate) };
      },
      setQuality: () => true,
      getQualities: () => ['hd1080', 'hd720', 'auto'],
      tagShortsGuide: () => 0,
    },
    opts.bridge || {}
  );
  Object.assign(AYT, {
    settings: {
      get: (n) => settings[n],
      all: () => Object.assign({}, settings),
      set: async (n, v) => {
        settings[n] = v;
      },
      onChange() {},
    },
    dom: { h: fakeEl, icon: () => fakeEl('svg'), clear() {}, render() {}, registerIcon() {} },
    ui: {
      addStyles() {},
      mountStyles() {},
      applyTheme() {},
      toast: (text, o) => toasts.push({ text, kind: (o && o.kind) || 'info' }),
      showError: (e) => toasts.push({ text: e.message, kind: 'error' }),
    },
    toolbar: {
      register: (d) => defs.push(Object.assign({ order: 100, group: 'tools', surfaces: ['watch'] }, d)),
      refresh() {},
      flash() {},
      list: () => defs.slice(),
      get: (id) => defs.find((d) => d.id === id) || null,
      renderPanelInto() {
        return { destroy() {} };
      },
    },
    features: { register: (f) => features.push(f), list: () => features.slice() },
    page: {
      info: { type: 'watch', videoId: 'dQw4w9WgXcQ', listId: null, url: sandbox.location.href },
      type: 'watch',
      videoId: 'dQw4w9WgXcQ',
      isWatch: () => true,
      isShorts: () => false,
      onChange() {},
    },
    player: {
      root: () => null,
      video: () => video,
      isAdPlaying: () => player.ad,
      duration: () => video.duration,
      currentTime: () => video.currentTime,
      seek: async (s) => {
        video.currentTime = s;
      },
    },
    bridge: {
      request: async (method, params) => {
        bridgeCalls.push({ method, params });
        const fn = bridgeHandlers[method];
        if (!fn) throw Object.assign(new Error('Unknown method ' + method), { code: 'unknown_method' });
        return fn(params || {});
      },
      on() {},
    },
    pageClass: {
      set: (n, on) => {
        classes[n] = !!on;
      },
    },
    videoInfo: { peek: () => null, get: async () => ({ isLive: false }) },
    keys: { isolate() {}, guard() {}, trusted: () => true },
    client: { send: async () => ({ ok: true }), invalidated: false },
  });
  for (const f of ['content/tools/loop.js', 'content/tools/speed.js', 'content/tools/boost.js', 'content/tools/adjust.js', 'content/tools/pip.js', 'content/tools/cinema.js', 'content/tools/cleanup.js', 'content/tools/quality.js', 'content/shorts.js']) load(sandbox, f);
  if (opts.init) for (const f of features) if (f.init) f.init();
  return { sandbox, AYT, T: AYT.tools, defs, features, toasts, classes, settings, storage, video, player, bridgeCalls, document };
}

/* ------------------------------------------------------------------ registration */
test('toolbar buttons use the ids / groups / orders from the spec', () => {
  const { defs } = boot();
  const want = {
    loop: ['tools', 10, true],
    speed: ['tools', 20, true],
    boost: ['tools', 30, true],
    adjust: ['tools', 40, true],
    pip: ['tools', 50, false],
    cinema: ['tools', 60, false],
    comments: ['tools', 70, false],
    settings: ['end', 10, false],
  };
  assert.deepEqual(defs.map((d) => d.id).sort(), Object.keys(want).sort());
  for (const d of defs) {
    const [group, order, panel] = want[d.id];
    assert.equal(d.group, group, d.id + ' group');
    assert.equal(d.order, order, d.id + ' order');
    assert.equal(!!d.panel, panel, d.id + ' panel');
    if (!panel) assert.equal(typeof d.onClick, 'function', d.id + ' onClick');
    assert.equal(typeof d.title, 'function', d.id + ' title');
  }
  assert.equal(defs.find((d) => d.id === 'loop').panel.width, 380);
  assert.equal(defs.find((d) => d.id === 'speed').panel.width, 380);
  assert.equal(defs.find((d) => d.id === 'boost').panel.width, 380);
  assert.equal(defs.find((d) => d.id === 'adjust').panel.width, 400);
});

test('keyboard commands are wired to the right buttons', () => {
  const { defs } = boot();
  const cmd = {};
  for (const d of defs) for (const name of Object.keys(d.commands || {})) cmd[name] = d.id;
  assert.deepEqual(cmd, {
    'toggle-loop': 'loop',
    'speed-up': 'speed',
    'speed-down': 'speed',
    'speed-reset': 'speed',
    'toggle-pip': 'pip',
    'toggle-cinema': 'cinema',
    'toggle-comments': 'comments',
  });
});

test('features are registered once with unique ids', () => {
  const { features } = boot();
  const ids = features.map((f) => f.id);
  assert.deepEqual(ids, ['loop', 'speed', 'boost', 'adjust', 'pip', 'cinema', 'cleanup', 'quality', 'shorts']);
});

/* ------------------------------------------------------------------ loop */
test('loop.normalizeRange validates A-B pairs', () => {
  const { T } = boot();
  const n = T.loop.normalizeRange;
  assert.deepEqual(JSON.parse(JSON.stringify(n(10, 14.25, 212))), { ok: true, a: 10, b: 14.25 });
  assert.equal(n(14, 10, 212).reason, 'order');
  assert.equal(n(10, 10.2, 212).reason, 'short');
  assert.equal(n(null, 10, 212).reason, 'invalid');
  assert.equal(n(-1, 10, 212).reason, 'invalid');
  assert.equal(n(NaN, 10, 212).reason, 'invalid');
  const clamped = n(200, 999, 212);
  assert.equal(clamped.ok, true);
  assert.equal(clamped.b, 212);
  assert.equal(n(1, 5, 0).ok, true, 'unknown duration is not a limit');
});

test('loop.placePoint keeps a usable section', () => {
  const { T } = boot();
  const p = (...a) => JSON.parse(JSON.stringify(T.loop.placePoint(...a)));
  assert.deepEqual(p('a', 30, null, null, 212), { a: 30, b: 40 });
  assert.deepEqual(p('a', 30, 10, 50, 212), { a: 30, b: 50 });
  assert.deepEqual(p('a', 30, 10, 20, 212), { a: 30, b: 40 }, 'B before the new A moves');
  assert.deepEqual(p('b', 45, 30, 40, 212), { a: 30, b: 45 });
  assert.deepEqual(p('b', 25, 30, 40, 212), { a: 15, b: 25 }, 'A after the new B moves');
  assert.deepEqual(p('a', 211.9, null, null, 212), { a: 202, b: 212 }, 'A at the very end');
  assert.deepEqual(p('b', 0.2, null, null, 212), { a: 0, b: 10 }, 'B at the very start');
});

test('loop.shouldWrap: manual is frame-exact, native only acts as a watchdog', () => {
  const { T } = boot();
  assert.equal(T.loop.shouldWrap(13.99, 10, 14, false), true);
  assert.equal(T.loop.shouldWrap(13.9, 10, 14, false), false);
  assert.equal(T.loop.shouldWrap(14.3, 10, 14, true), false);
  assert.equal(T.loop.shouldWrap(14.7, 10, 14, true), true);
  assert.equal(T.loop.shouldWrap(5, 10, 14, false), false, 'before A: keep playing');
  assert.equal(T.loop.shouldWrap(20, 14, 10, false), false, 'invalid range never wraps');
});

test('loop: native A-B uses the bridge and clears it again', async () => {
  const env = boot();
  const { T, player, video, bridgeCalls } = env;
  video.currentTime = 50;
  const r = await T.loop.startAB(10, 14);
  assert.equal(r.mode, 'native');
  assert.deepEqual(JSON.parse(JSON.stringify(player.range)), { startTimeMs: 10000, endTimeMs: 14000 });
  assert.equal(video.currentTime, 10, 'jumped to A because playback was outside the section');
  assert.equal(T.loop.state().active, true);
  assert.equal(env.defs.find((d) => d.id === 'loop').isOn(), true);
  await T.loop.stopAB();
  assert.equal(player.range, null);
  assert.equal(T.loop.state().active, false);
  assert.ok(bridgeCalls.some((c) => c.method === 'setLoopRange' && c.params.start == null));
});

test('loop: manual fallback wraps currentTime back to A', async () => {
  const env = boot({ nativeLoop: false });
  const { T, video, document } = env;
  video.currentTime = 11;
  const r = await T.loop.startAB(10, 14);
  assert.equal(r.mode, 'manual');
  assert.equal(document.listenerCount('timeupdate'), 1, 'no rVFC in this fake video → timeupdate hook');
  video.currentTime = 14.01;
  document.dispatch('timeupdate', { target: video });
  assert.equal(video.currentTime, 10);
  video.currentTime = 12;
  document.dispatch('timeupdate', { target: video });
  assert.equal(video.currentTime, 12, 'inside the section nothing happens');
  video.currentTime = 15;
  await sleep(260); // the 200 ms timer alone also catches it
  assert.equal(video.currentTime, 10);
  await T.loop.stopAB();
  assert.equal(document.listenerCount('timeupdate'), 0, 'listener removed');
});

test('loop: switching A-B off while the player answers cancels the start (and clears the range)', async () => {
  const calls = [];
  let release = null;
  const env = boot({
    bridge: {
      setLoopRange: (p) => {
        calls.push(p.start == null ? 'clear' : 'set');
        if (p.start == null) return { supported: true, range: null };
        return new Promise((r) => {
          release = () => r({ supported: true, range: { startTimeMs: p.start * 1000, endTimeMs: p.end * 1000 } });
        });
      },
    },
  });
  const pending = env.T.loop.startAB(10, 14);
  await sleep(10);
  await env.T.loop.stopAB();
  release();
  const res = await pending;
  await sleep(10);
  assert.equal(res.cancelled, true);
  assert.equal(env.T.loop.state().active, false, 'stays off');
  assert.deepEqual(calls, ['set', 'clear'], 'the late native range is cleared again');
});

test('loop: rejects invalid sections with a friendly message', async () => {
  const { T } = boot();
  await assert.rejects(T.loop.startAB(20, 10), /after point A/);
  await assert.rejects(T.loop.startAB(10, 10.2), /at least/);
});

test('loop: the progress-bar marker is reused, rewritten only on change, without document-wide searches', async () => {
  const env = boot();
  const { T, document } = env;
  let docQueries = 0;
  document.querySelectorAll = () => {
    docQueries++;
    return [];
  };
  let styleWrites = 0;
  const bar = { children: [] };
  bar.querySelector = (sel) => (sel === ':scope > .ayt-loop-range' ? bar.children[0] || null : null);
  bar.appendChild = (el) => {
    el.parentNode = bar;
    el.style = new Proxy({}, { set: (o, k, v) => ((o[k] = v), styleWrites++, true) });
    el.remove = () => {
      bar.children = bar.children.filter((x) => x !== el);
      el.parentNode = null;
    };
    bar.children.push(el);
    return el;
  };
  const playerEl = { querySelector: (sel) => (sel === '.ytp-progress-bar' ? bar : null) };
  document.getElementById = (id) => (id === 'movie_player' ? playerEl : null);

  await T.loop.startAB(10, 14);
  assert.equal(bar.children.length, 1, 'marker drawn');
  const marker = bar.children[0];
  assert.equal(marker.style.left, (10 / 212 * 100).toFixed(3) + '%');
  const writes = styleWrites;
  await sleep(1150); // two watchdog ticks repaint the marker
  assert.equal(styleWrites, writes, 'unchanged section: no style writes');
  assert.equal(docQueries, 0, 'no document-wide querySelectorAll');
  await T.loop.startAB(20, 30);
  assert.equal(bar.children.length, 1);
  assert.equal(bar.children[0], marker, 'same element reused');
  assert.equal(marker.style.width, (10 / 212 * 100).toFixed(3) + '%');
  await T.loop.stopAB();
  assert.equal(bar.children.length, 0, 'removed when the loop stops');
});

test('loop: toggle-loop command flips the player loop and toasts', async () => {
  const env = boot();
  const r1 = await env.T.loop.toggleLoop();
  assert.equal(r1, true);
  assert.equal(env.player.loop, true);
  const r2 = await env.T.loop.toggleLoop();
  assert.equal(r2, false);
  assert.deepEqual(
    env.toasts.map((x) => x.text),
    ['Loop is on', 'Loop is off']
  );
});

/* ------------------------------------------------------------------ speed */
test('speed.nextRate steps through the grid', () => {
  const { T } = boot();
  const up = [];
  let r = 1;
  for (let i = 0; i < 40; i++) up.push((r = T.speed.nextRate(r, 1)));
  assert.deepEqual(up.slice(0, 13), [1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4, 4.5]);
  assert.equal(up.indexOf(16), 35, '12 steps of 0.25 to 4×, then 24 steps of 0.5 to 16×');
  assert.equal(up[up.length - 1], 16, 'clamped at 16×');
  const down = [];
  r = 16;
  for (let i = 0; i < 50; i++) down.push((r = T.speed.nextRate(r, -1)));
  assert.equal(down[0], 15.5);
  assert.ok(down.includes(4) && down.includes(3.75));
  assert.equal(down[down.length - 1], 0.25);
  assert.equal(T.speed.nextRate(1.1, 1), 1.25, 'off-grid snaps up');
  assert.equal(T.speed.nextRate(1.1, -1), 1, 'off-grid snaps down');
  assert.equal(T.speed.nextRate(0.1, 1), 0.25);
  assert.equal(T.speed.nextRate(0.1, -1), 0.1, 'never speeds up on speed-down');
  assert.equal(T.speed.nextRate(4.2, 1), 4.5);
  assert.equal(T.speed.nextRate(4.2, -1), 4);
});

test('speed.parseRate / clampRate / formatRate', () => {
  const { T, AYT } = boot();
  assert.equal(T.speed.parseRate('1.5'), 1.5);
  assert.equal(T.speed.parseRate(' 1,5 '), 1.5);
  assert.equal(T.speed.parseRate('2x'), 2);
  assert.equal(T.speed.parseRate('2×'), 2);
  assert.equal(T.speed.parseRate('.5'), 0.5);
  assert.equal(T.speed.parseRate('16'), 16);
  assert.ok(Number.isNaN(T.speed.parseRate('17')));
  assert.ok(Number.isNaN(T.speed.parseRate('0.05')));
  assert.ok(Number.isNaN(T.speed.parseRate('abc')));
  assert.ok(Number.isNaN(T.speed.parseRate('')));
  assert.equal(T.speed.clampRate(0.15000000000000002), 0.15);
  assert.equal(T.speed.clampRate(40), 16);
  assert.equal(T.speed.clampRate(0.01), 0.1);
  assert.equal(T.speed.formatRate(1.5), '1.5');
  assert.equal(T.speed.formatRate(2), '2');
  AYT.i18n.setLanguage('de');
  assert.equal(T.speed.formatRate(1.25), '1,25');
  AYT.i18n.setLanguage('en');
});

test('speed: rates above 2× stick on the <video>, YouTube resets are undone, user menu choices adopted', async () => {
  const env = boot({ init: true });
  const { T, video, document, defs } = env;
  const res = await T.speed.setRate(3);
  assert.equal(video.playbackRate, 3);
  assert.equal(res.rate, 3);
  const def = defs.find((d) => d.id === 'speed');
  assert.equal(def.isOn(), true);
  assert.equal(def.badge(), '3');
  await sleep(750); // past the "our own change" window
  // YouTube resets the element (e.g. after a quality switch): we put 3× back
  video.playbackRate = 1;
  document.dispatch('ratechange', { target: video });
  await sleep(120);
  assert.equal(video.playbackRate, 3, 'reapplied');
  await sleep(750);
  // the user picks 1.25 in YouTube's own settings menu → adopted
  document.dispatch('click', { composedPath: () => [{ nodeType: 1, matches: (sel) => sel.includes('.ytp-settings-menu') }] });
  video.playbackRate = 1.25;
  document.dispatch('ratechange', { target: video });
  await sleep(120);
  assert.equal(video.playbackRate, 1.25);
  assert.equal(T.speed.state().desired, 1.25);
  await T.speed.setRate(1);
  assert.equal(T.speed.state().desired, null, 'back to normal: YouTube is left alone');
  assert.equal(def.isOn(), false);
  assert.equal(def.badge(), null);
});

test('speed: ads keep their own speed; the rate is applied afterwards', async () => {
  const env = boot({ init: true });
  const { T, video, player, document } = env;
  player.ad = true;
  const res = await T.speed.setRate(2.5);
  assert.equal(res.deferred, true);
  assert.equal(video.playbackRate, 1, 'ad untouched');
  player.ad = false;
  document.dispatch('playing', { target: video });
  await sleep(120);
  assert.equal(video.playbackRate, 2.5);
});

/** Counts chrome.storage.local.set calls of a booted sandbox. */
function countStorageWrites(env) {
  const local = env.sandbox.chrome.storage.local;
  const set = local.set;
  const writes = [];
  local.set = (o) => {
    writes.push(o);
    return set(o);
  };
  return writes;
}

test('speed: remember speed stores the rate in chrome.storage.local, once, ~400 ms after the last change', async () => {
  const env = boot({ init: true, settings: { rememberSpeed: true } });
  const writes = countStorageWrites(env);
  const KEY = env.AYT.STORAGE.LAST_SPEED;
  // a slider drag: many rates in a row
  for (const r of [1.25, 1.3, 1.4, 1.5, 1.6, 1.75]) await env.T.speed.setRate(r);
  await sleep(50);
  assert.equal(env.storage[KEY], undefined, 'nothing written while the rate is still changing');
  await sleep(450);
  assert.equal(env.storage[KEY], 1.75);
  assert.equal(writes.length, 1, 'one write for the whole drag');
});

test('speed: a pending remembered speed is written when the tab is hidden, and dropped when "remember" is turned off', async () => {
  const env = boot({ init: true, settings: { rememberSpeed: true } });
  const KEY = env.AYT.STORAGE.LAST_SPEED;
  await env.T.speed.setRate(2.5);
  env.document.visibilityState = 'hidden';
  env.document.dispatch('visibilitychange', {});
  await sleep(5);
  assert.equal(env.storage[KEY], 2.5, 'flushed right away (the tab may be closing)');

  env.document.visibilityState = 'visible';
  await env.T.speed.setRate(3);
  env.settings.rememberSpeed = false;
  env.features.find((f) => f.id === 'speed').onSettings({ rememberSpeed: false });
  await sleep(500);
  assert.equal(KEY in env.storage, false, 'turned off: the stored speed is removed and the pending one never written');
});

test('speed: remembered rate is applied on start', async () => {
  const env = boot({ settings: { rememberSpeed: true } });
  env.storage[env.AYT.STORAGE.LAST_SPEED] = 1.5;
  for (const f of env.features) if (f.init) f.init();
  await sleep(150);
  assert.equal(env.video.playbackRate, 1.5);
});

/* ------------------------------------------------------------------ boost */
test('boost: percentages follow the UI language (AYT.util.formatPercent)', () => {
  const { T, AYT } = boot();
  assert.equal(T.boost.fmtPercent(150), '150%');
  assert.equal(T.boost.fmtPercent(149.6), '150%', 'rounded');
  AYT.i18n.setLanguage('fr');
  assert.equal(T.boost.fmtPercent(200).replace(/\s/g, ' '), '200 %');
  AYT.i18n.setLanguage('tr');
  assert.equal(T.boost.fmtPercent(200), '%200');
  AYT.i18n.setLanguage('en');
});

test('boost helpers', () => {
  const { T } = boot();
  const arr = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(arr(T.boost.presetsFor(400)), [100, 150, 200, 300, 400]);
  assert.deepEqual(arr(T.boost.presetsFor(250)), [100, 150, 200, 250]);
  assert.deepEqual(arr(T.boost.presetsFor(600)), [100, 150, 200, 300, 400, 600]);
  assert.deepEqual(arr(T.boost.presetsFor(100)), [100]);
  assert.equal(T.boost.clampPercent(155, 400), 160);
  assert.equal(T.boost.clampPercent(1000, 400), 400);
  assert.equal(T.boost.clampPercent(20, 400), 100);
  assert.equal(T.boost.maxPercent(50), 100);
  assert.equal(T.boost.maxPercent('x'), 400);
  assert.equal(T.boost.maxPercent(900), 600);
  assert.ok(Math.abs(T.boost.gainToDb(2) - 6.0206) < 1e-3);
  assert.equal(T.boost.gainToDb(1), 0);
});

test('boost: without Web Audio the level falls back to 100 % with a message', async () => {
  const { T } = boot();
  await assert.rejects(T.boost.setLevel(200), (e) => e.code === 'suspended' || e.code === 'webaudio');
  assert.equal(T.boost.level(), 100);
  assert.equal(await T.boost.setLevel(100), 100, '100 % never needs Web Audio');
});

/** Web Audio stand-in with the parts boost.js uses; `instances` collects the contexts created. */
function fakeAudio() {
  const instances = [];
  const node = () => ({ connect() {}, disconnect() {} });
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = node();
      this.calls = [];
      this.listeners = [];
      instances.push(this);
    }
    addEventListener(type, fn) {
      if (type === 'statechange') this.listeners.push(fn);
    }
    setState(s) {
      this.state = s;
      this.listeners.forEach((fn) => fn());
    }
    resume() {
      this.calls.push('resume');
      this.setState('running');
      return Promise.resolve();
    }
    suspend() {
      this.calls.push('suspend');
      this.setState('suspended');
      return Promise.resolve();
    }
    createMediaElementSource() {
      return node();
    }
    createGain() {
      return Object.assign(node(), { gain: { value: 1, setTargetAtTime(v) { this.value = v; } } });
    }
    createDynamicsCompressor() {
      const n = node();
      for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = { value: 0 };
      return n;
    }
  }
  return { FakeAudioContext, instances };
}

test('boost: the AudioContext sleeps while none of its videos plays and wakes up on play', async () => {
  const env = boot();
  const { T, video, document } = env;
  const { FakeAudioContext, instances } = fakeAudio();
  env.sandbox.AudioContext = FakeAudioContext;
  const vl = {};
  video.addEventListener = (type, fn) => (vl[type] = vl[type] || []).push(fn);
  const fire = (type) => (vl[type] || []).forEach((fn) => fn({ type, target: video }));
  T.boost.timing.suspendDelay = 30;

  await T.boost.setLevel(150); // video is playing (paused: false)
  const ac = instances[0];
  assert.equal(ac.state, 'running');
  await sleep(60);
  assert.equal(ac.state, 'running', 'playing: stays running');

  video.paused = true;
  fire('pause');
  assert.equal(ac.state, 'running', 'not right away (a quick pause/play keeps it)');
  await sleep(60);
  assert.equal(ac.state, 'suspended', 'paused: suspended after the delay');
  assert.equal(document.listenerCount('pointerdown'), 0, 'our own suspend is not undone by the next click');

  video.paused = false;
  fire('play');
  assert.equal(ac.state, 'running', 'play: resumed');
  fire('playing');
  await sleep(60);
  assert.equal(ac.state, 'running');

  // back to 100 % while paused: the element stays routed through the context, which may sleep again
  video.paused = true;
  fire('pause');
  assert.equal(await T.boost.setLevel(100), 100);
  assert.equal(T.boost.state().routed, 'direct');
  await sleep(60);
  assert.equal(ac.state, 'suspended');
  assert.ok(!ac.calls.includes('close'), 'never closed (a MediaElementSource cannot be detached)');

  // a pause followed by play within the delay never suspends
  video.paused = false;
  fire('play');
  const n = ac.calls.filter((c) => c === 'suspend').length;
  video.paused = true;
  fire('pause');
  await sleep(5);
  video.paused = false;
  fire('play');
  await sleep(60);
  assert.equal(ac.calls.filter((c) => c === 'suspend').length, n);
  assert.equal(ac.state, 'running');
});

/* ------------------------------------------------------------------ adjust */
test('adjust helpers', () => {
  const { T } = boot();
  const D = T.adjust.DEFAULTS;
  assert.equal(T.adjust.filterString(D), 'none');
  assert.equal(T.adjust.filterString(Object.assign({}, D, { brightness: 120 })), 'brightness(1.2)');
  assert.equal(T.adjust.filterString(Object.assign({}, D, { contrast: 80, saturation: 0 })), 'contrast(0.8) saturate(0)');
  assert.equal(T.adjust.transformString(D, 1), 'none');
  assert.equal(T.adjust.transformString(Object.assign({}, D, { rotate: 90 }), 0.5625), 'scale(1, 1) rotate(90deg) scale(0.5625)');
  assert.equal(T.adjust.transformString(Object.assign({}, D, { flipH: true }), 1), 'scale(-1, 1) rotate(0deg) scale(1)');
  assert.equal(T.adjust.transformString(Object.assign({}, D, { zoom: 150, rotate: 180 }), 0.3), 'scale(1, 1) rotate(180deg) scale(1.5)', 'fit only for 90/270');
  const f = T.adjust.fitScale(90, { pw: 1112, ph: 626, vw: 1112, vh: 626 });
  assert.ok(Math.abs(f - 626 / 1112) < 1e-9);
  assert.equal(T.adjust.fitScale(0, { pw: 1, ph: 1, vw: 1, vh: 1 }), 1);
  assert.equal(T.adjust.fitScale(270, {}), 1, 'unknown sizes → 1');
  // portrait video pillarboxed in a landscape player, rotated: fills more of the player
  assert.ok(Math.abs(T.adjust.fitScale(90, { pw: 1112, ph: 626, vw: 352, vh: 626 }) - 1112 / 626) < 1e-9);
  const n = (p) => JSON.parse(JSON.stringify(T.adjust.normalize(p)));
  assert.equal(n({ rotate: 450 }).rotate, 90);
  assert.equal(n({ rotate: -90 }).rotate, 270);
  assert.equal(n({ brightness: 500 }).brightness, 200);
  assert.equal(n({ zoom: 50 }).zoom, 100);
  assert.equal(n({ flipV: 1 }).flipV, true);
  assert.equal(n({ nope: 3 }).nope, undefined);
  assert.equal(T.adjust.isDefault(D), true);
});

test('adjust: state drives the page class, CSS variables and AYT.videoAdjust', () => {
  const { T, AYT, classes, defs } = boot();
  assert.equal(AYT.videoAdjust.active(), false);
  assert.equal(AYT.videoAdjust.canvasFilter(), 'none');
  T.adjust.set({ brightness: 150, saturation: 50, rotate: 90, flipH: true });
  assert.equal(classes['video-adjust'], true);
  assert.equal(AYT.videoAdjust.active(), true);
  assert.equal(AYT.videoAdjust.canvasFilter(), 'brightness(1.5) saturate(0.5)');
  assert.equal(AYT.videoAdjust.rotation(), 90);
  assert.equal(AYT.videoAdjust.flipH(), true);
  assert.equal(AYT.videoAdjust.flipV(), false);
  assert.equal(defs.find((d) => d.id === 'adjust').isOn(), true);
  T.adjust.reset('brightness');
  assert.equal(AYT.videoAdjust.canvasFilter(), 'saturate(0.5)');
  T.adjust.reset();
  assert.equal(classes['video-adjust'], false);
  assert.equal(AYT.videoAdjust.active(), false);
});

/** Minimal CSSStyleDeclaration for custom properties. */
function fakeStyle() {
  const props = new Map();
  return {
    props,
    setProperty(n, v) {
      props.set(n, String(v));
    },
    removeProperty(n) {
      props.delete(n);
    },
    getPropertyValue(n) {
      return props.has(n) ? props.get(n) : '';
    },
  };
}

test('adjust: variables are set inline on the active <video> (never on :root), follow it, and go away at default', () => {
  const env = boot();
  const { T, AYT, video, document } = env;
  video.style = fakeStyle();
  const appended = [];
  document.head.appendChild = (el) => appended.push(el);
  document.documentElement.appendChild = (el) => appended.push(el);
  T.adjust.set({ brightness: 150, flipH: true });
  assert.equal(video.style.getPropertyValue('--ayt-va-filter'), 'brightness(1.5)');
  assert.equal(video.style.getPropertyValue('--ayt-va-transform'), 'scale(-1, 1) rotate(0deg) scale(1)');
  assert.equal(appended.length, 0, 'no <style> with :root variables (whole-page style recalc on every step)');
  // another <video> becomes the active one (watch → Shorts): the variables move with it
  const other = Object.assign({}, video, { style: fakeStyle() });
  AYT.player.video = () => other;
  T.adjust.set({ contrast: 80 });
  assert.equal(video.style.props.size, 0, 'old element cleaned up');
  assert.equal(other.style.getPropertyValue('--ayt-va-filter'), 'brightness(1.5) contrast(0.8)');
  T.adjust.reset();
  assert.equal(other.style.props.size, 0, 'neutral: no inline variables left');
});

test('adjust: the toolbar is only repainted when the on/off state flips', () => {
  const env = boot();
  let refreshes = 0;
  env.AYT.toolbar.refresh = () => refreshes++;
  env.video.style = fakeStyle();
  for (let b = 105; b <= 200; b += 5) env.T.adjust.set({ brightness: b });
  assert.equal(refreshes, 1, 'off → on');
  env.T.adjust.set({ zoom: 150 });
  assert.equal(refreshes, 1);
  env.T.adjust.reset();
  assert.equal(refreshes, 2, 'on → off');
});

test('adjust: steps within one frame are written to the <video> once; the state is current at once', () => {
  const env = boot();
  const frames = [];
  env.sandbox.requestAnimationFrame = (fn) => frames.push(fn);
  env.sandbox.cancelAnimationFrame = () => {};
  env.document.visibilityState = 'visible';
  const style = (env.video.style = fakeStyle());
  let writes = 0;
  const setProperty = style.setProperty;
  style.setProperty = (n, v) => {
    writes++;
    setProperty(n, v);
  };
  for (let b = 105; b <= 150; b += 5) env.T.adjust.set({ brightness: b });
  assert.equal(frames.length, 1, 'one frame requested');
  assert.equal(writes, 0, 'nothing written before the frame');
  assert.equal(env.AYT.videoAdjust.canvasFilter(), 'brightness(1.5)', 'screenshots see the new values right away');
  frames.shift()();
  assert.equal(style.getPropertyValue('--ayt-va-filter'), 'brightness(1.5)');
  assert.equal(writes, 2, 'filter + transform, once');
  env.T.adjust.set({ brightness: 150 });
  frames.shift()();
  assert.equal(writes, 2, 'unchanged values are not rewritten');
});

/* ------------------------------------------------------------------ quality */
test('quality.pickQuality', () => {
  const { T } = boot();
  const all = ['hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny', 'auto'];
  assert.equal(T.quality.pickQuality(all, 'max'), 'hd2160');
  assert.equal(T.quality.pickQuality(all, '1080'), 'hd1080');
  assert.equal(T.quality.pickQuality(all, '4320'), 'hd2160');
  assert.equal(T.quality.pickQuality(all, '360'), 'medium');
  assert.equal(T.quality.pickQuality(all, '480'), 'large');
  assert.equal(T.quality.pickQuality(['hd1080', 'hd720', 'auto'], '1440'), 'hd1080');
  assert.equal(T.quality.pickQuality(['hd1080', 'hd720', 'auto'], '360'), 'hd720', 'all higher → lowest available');
  assert.equal(T.quality.pickQuality(['highres', 'hd2160', 'auto'], 'max'), 'highres');
  assert.equal(T.quality.pickQuality(['highres', 'hd2160', 'auto'], '2160'), 'hd2160');
  assert.equal(T.quality.pickQuality(all, 'off'), null);
  assert.equal(T.quality.pickQuality([], 'max'), null);
  assert.equal(T.quality.pickQuality(['auto'], 'max'), null);
  assert.equal(T.quality.pickQuality(null, 'max'), null);
});

test('quality: applies the preferred level once the player reports levels', async () => {
  const env = boot({ settings: { autoQuality: '720' } });
  const q = await env.T.quality.apply();
  assert.equal(q, 'hd720');
  const call = env.bridgeCalls.find((c) => c.method === 'setQuality');
  assert.equal(call.params.quality, 'hd720');
  assert.equal(call.params.surface, 'watch');
});

/* ------------------------------------------------------------------ cleanup */
test('cleanup helpers', () => {
  const { T } = boot();
  assert.deepEqual(JSON.parse(JSON.stringify(T.cleanup.classesFor({ hideComments: true, hideShorts: true }))), {
    'hide-comments': true,
    'hide-related': false,
    'hide-shorts': true,
    'hide-endscreen': false,
    'hide-livechat': false,
  });
  assert.equal(T.cleanup.shortsRedirect('/shorts/dQw4w9WgXcQ'), '/watch?v=dQw4w9WgXcQ');
  assert.equal(T.cleanup.shortsRedirect('/shorts/dQw4w9WgXcQ/'), '/watch?v=dQw4w9WgXcQ');
  assert.equal(T.cleanup.shortsRedirect('/shorts/'), null);
  assert.equal(T.cleanup.shortsRedirect('/shorts/abc'), null);
  assert.equal(T.cleanup.shortsRedirect('/watch'), null);
  assert.equal(T.cleanup.shortsRedirect('/shorts/dQw4w9WgXcQ<x'), null);
});

test('cleanup: init applies the page classes from the settings', () => {
  const env = boot({ init: true, settings: { hideComments: true, hideEndscreen: true } });
  assert.equal(env.classes['hide-comments'], true);
  assert.equal(env.classes['hide-endscreen'], true);
  assert.equal(env.classes['hide-related'], false);
  const def = env.defs.find((d) => d.id === 'comments');
  assert.equal(def.isOn(), true);
  assert.equal(def.icon(), 'comments-off');
  assert.equal(def.title(), 'Show comments');
});

test('cleanup: comments toggle flips the class immediately and persists', async () => {
  const env = boot({ init: true });
  const def = env.defs.find((d) => d.id === 'comments');
  assert.equal(def.title(), 'Hide comments');
  const p = def.onClick();
  assert.equal(env.classes['hide-comments'], true, 'class set before the storage write finished');
  await p;
  assert.equal(env.settings.hideComments, true);
  await def.commands['toggle-comments']();
  assert.equal(env.settings.hideComments, false);
  assert.equal(env.toasts.at(-1).text, 'Comments shown');
});

/** Records the setInterval/clearInterval calls the scripts make from now on (ms of each live interval). */
function trackIntervals(env) {
  const live = new Map();
  env.sandbox.setInterval = (fn, ms, ...a) => {
    const h = setInterval(fn, ms, ...a);
    if (h && h.unref) h.unref();
    live.set(h, ms);
    return h;
  };
  env.sandbox.clearInterval = (h) => {
    live.delete(h);
    clearInterval(h);
  };
  return { count: (ms) => [...live.values()].filter((x) => x === ms).length, clearAll: () => [...live.keys()].forEach((h) => env.sandbox.clearInterval(h)) };
}

test('cleanup: the "comments are hidden" pill timer runs only while the tab is visible', () => {
  const env = boot({ settings: { hideComments: true } });
  const iv = trackIntervals(env);
  try {
    env.document.visibilityState = 'hidden';
    env.features.find((f) => f.id === 'cleanup').init();
    assert.equal(iv.count(1500), 0, 'background tab: no timer');
    env.document.visibilityState = 'visible';
    env.document.dispatch('visibilitychange', {});
    assert.equal(iv.count(1500), 1, 'shown: the re-insert timer runs');
    env.document.dispatch('visibilitychange', {});
    assert.equal(iv.count(1500), 1, 'never two timers');
    env.document.visibilityState = 'hidden';
    env.document.dispatch('visibilitychange', {});
    assert.equal(iv.count(1500), 0, 'hidden again: stopped');
  } finally {
    iv.clearAll();
  }
});

test('shorts: the button safety timer runs only while the tab is visible', () => {
  const env = boot();
  const iv = trackIntervals(env);
  try {
    env.AYT.page.isShorts = () => true;
    env.AYT.page.isWatch = () => false;
    env.document.visibilityState = 'visible';
    env.features.find((f) => f.id === 'shorts').init();
    assert.equal(iv.count(1500), 1, 'Shorts page, tab shown: the timer runs');
    env.document.visibilityState = 'hidden';
    env.document.dispatch('visibilitychange', {});
    assert.equal(iv.count(1500), 0, 'hidden: no wake-ups');
    env.document.visibilityState = 'visible';
    env.document.dispatch('visibilitychange', {});
    assert.equal(iv.count(1500), 1, 'shown again: restarted');
  } finally {
    iv.clearAll();
  }
});

test('cleanup: the comments button changes its name instead of announcing a pressed state', () => {
  const env = boot({ init: true });
  const def = env.defs.find((d) => d.id === 'comments');
  // WAI-ARIA APG: a toggle whose label changes must not also use aria-pressed (toolbar.js honours ariaPressed:false)
  assert.equal(def.ariaPressed, false);
  assert.equal(def.title(), 'Hide comments');
  assert.equal(typeof def.isOn, 'function', 'visual highlight stays');
});

/* ------------------------------------------------------------------ cinema */
test('cinema: Escape closes our panel first and is left alone in text fields', () => {
  const env = boot();
  const { T, AYT, document } = env;
  let open = false;
  let closes = 0;
  AYT.toolbar.isOpen = () => open;
  AYT.toolbar.close = () => {
    closes++;
    open = false;
  };
  const portal = { id: 'ayt-portal-host' };
  document.getElementById = (id) => (id === 'ayt-portal-host' ? portal : null);
  const escape = (path) => document.dispatch('keydown', { key: 'Escape', target: path.length > 1 ? path[path.length - 2] : path[0], composedPath: () => path.concat(document) });
  const input = { tagName: 'INPUT' };
  const button = { tagName: 'BUTTON' };
  const body = { tagName: 'BODY' };

  assert.equal(T.cinema.set(true), true);
  // custom speed field inside a panel (shadow DOM: at document level e.target is the portal host)
  open = true;
  escape([input, portal]);
  assert.equal(T.cinema.isOn(), true, 'typing in our input: cinema stays');
  assert.equal(closes, 0, 'the panel closes itself (AYT.keys.isolate)');
  escape([button, portal]);
  assert.equal(T.cinema.isOn(), true, 'Escape inside an open panel only closes the panel');
  assert.equal(closes, 0);
  escape([body]);
  assert.equal(T.cinema.isOn(), true, 'Escape elsewhere while a panel is open closes the panel first');
  assert.equal(closes, 1);
  escape([{ tagName: 'TEXTAREA' }]);
  assert.equal(T.cinema.isOn(), true, 'page text fields keep their Escape');
  escape([body]);
  assert.equal(T.cinema.isOn(), false, 'nothing open: Escape leaves cinema mode');
});

/* ------------------------------------------------------------------ pip */
test('pip: a request that never settles ends with a translated message', async () => {
  const env = boot();
  env.document.pictureInPictureEnabled = true;
  env.video.removeAttribute = () => {};
  env.video.requestPictureInPicture = () => new Promise(() => {});
  // the 5 s safety timeout, shortened (a ref'd timer: the sandbox's own timers don't keep Node alive)
  env.sandbox.setTimeout = (fn, ms, ...a) => setTimeout(fn, ms >= 5000 ? 5 : ms, ...a);
  await assert.rejects(env.T.pip.toggle(), (e) => e.code === 'timeout' && e.message === "Picture-in-picture didn't open. Please try again.");
});

/* ------------------------------------------------------------------ number formats */
test('number formatters are created once per language (speed badge, boost dB, loop length)', () => {
  let made = 0;
  const RealNumberFormat = Intl.NumberFormat;
  const CountingIntl = Object.create(Intl);
  CountingIntl.NumberFormat = function (...a) {
    made++;
    return new RealNumberFormat(...a);
  };
  const env = boot({ globals: { Intl: CountingIntl } });
  const before = made;
  for (let i = 0; i < 40; i++) {
    env.T.speed.formatRate(1.5);
    env.T.boost.fmtDb(2);
    env.T.loop.formatSpan(4.5);
  }
  assert.ok(made - before <= 3, `formatters created: ${made - before}`);
  assert.equal(env.T.speed.formatRate(1.5), '1.5');
  assert.equal(env.T.boost.fmtDb(2), '+6.0 dB');
  assert.equal(env.T.loop.formatSpan(4.5), '4.5 s');
  const beforeDe = made;
  env.AYT.i18n.setLanguage('de');
  assert.equal(env.T.speed.formatRate(1.25), '1,25', 'follows a language change');
  assert.equal(env.T.loop.formatSpan(4.5), '4,5 s');
  assert.ok(made > beforeDe, 'the counting Intl is the one the scripts use');
  env.AYT.i18n.setLanguage('en');
  assert.equal(env.T.speed.formatRate(1.25), '1.25');
});

test('cleanup: settings button reports a friendly error when the background is unreachable', async () => {
  const env = boot();
  env.AYT.client.send = async () => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  };
  const ok = await env.defs.find((d) => d.id === 'settings').onClick();
  assert.equal(ok, false);
  assert.match(env.toasts.at(-1).text, /Couldn't open the settings/);
});

/* ------------------------------------------------------------------ shorts */
test('shorts.popoverPosition keeps the popover next to the button and on screen', () => {
  const { T } = boot();
  const vp = { width: 1600, height: 1000 };
  const size = { width: 380, height: 500 };
  // room on the right (wide window)
  let p = T.shorts.popoverPosition({ left: 1223, right: 1271, top: 890, bottom: 938 }, size, { width: 1920, height: 1000 });
  assert.deepEqual(JSON.parse(JSON.stringify(p)), { left: 1283, top: 438 });
  // no room on the right (1600 px: 1283 + 380 > 1588) → left side, bottom-aligned with the button
  p = T.shorts.popoverPosition({ left: 1223, right: 1271, top: 890, bottom: 938 }, size, vp);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), { left: 1223 - 12 - 380, top: 438 });
  // tall popover near the top is pushed below the masthead
  p = T.shorts.popoverPosition({ left: 100, right: 148, top: 100, bottom: 148 }, { width: 380, height: 900 }, vp);
  assert.equal(p.top, 64);
  // narrow viewport: clamped inside
  p = T.shorts.popoverPosition({ left: 300, right: 348, top: 500, bottom: 548 }, size, { width: 400, height: 700 });
  assert.equal(p.left, 12);
});

test('shorts: the popover closes when the extension context is invalidated', () => {
  const env = boot();
  const handlers = {};
  env.AYT.client.on = (type, fn) => (handlers[type] = fn);
  env.features.find((f) => f.id === 'shorts').init();
  assert.equal(typeof handlers.invalidated, 'function', 'listens for AYT.client "invalidated"');
  handlers.invalidated(); // closed popover: a no-op
  assert.equal(env.T.shorts.isOpen(), false);
});

test('shorts.shortsPanels lists registered panels with the shorts surface', () => {
  const { T } = boot();
  const defs = [
    { id: 'video', panel: { render() {} }, surfaces: ['watch', 'shorts'] },
    { id: 'audio', panel: { render() {} }, surfaces: ['watch', 'shorts'] },
    { id: 'loop', panel: { render() {} }, surfaces: ['watch'] },
    { id: 'screenshot', onClick() {}, surfaces: ['watch', 'shorts'] },
    { id: 'thumbnail', panel: { render() {} }, surfaces: ['watch', 'shorts'] },
  ];
  assert.deepEqual(T.shorts.shortsPanels(defs, []).map((d) => d.id), ['video', 'audio', 'thumbnail']);
  assert.deepEqual(T.shorts.shortsPanels(defs, ['audio']).map((d) => d.id), ['video', 'thumbnail']);
  assert.deepEqual(T.shorts.shortsPanels([], []), []);
});

/* ------------------------------------------------------------------ i18n */
test('every tools.* key used in the code exists in en.tools.json and vice versa', () => {
  const part = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'parts', 'en.tools.json'), 'utf8'));
  const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'parts', 'en.core.json'), 'utf8'));
  const files = ['loop', 'speed', 'boost', 'adjust', 'pip', 'cinema', 'cleanup', 'quality'].map((n) => `content/tools/${n}.js`).concat('content/shorts.js');
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(EXT, f), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)) used.add(m[1]);
  }
  for (const k of used) assert.ok(k in part || k in core, 'missing key ' + k);
  for (const k of Object.keys(part)) {
    assert.ok(k.startsWith('tools.'), 'key prefix ' + k);
    assert.ok(used.has(k), 'unused key ' + k);
  }
  const keys = Object.keys(part);
  assert.deepEqual(keys, keys.slice().sort(), 'keys sorted');
});
