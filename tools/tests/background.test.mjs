#!/usr/bin/env node
/*
 * Unit tests for the BACKGROUND module (extension/background/*.js).
 *
 *   node --test tools/tests/background.test.mjs        (or simply: node tools/tests/background.test.mjs)
 *
 * The real service-worker entry is executed in a vm context with a mocked `chrome` API (importScripts loads the
 * real shared + background scripts). Native messaging is replaced by an in-process fake companion host through
 * AYT.native.setTransport(), so the whole job pipeline (queue, host events, throttled pushes, persistence,
 * badge, notifications, cancel/retry/remove/open, crash handling, idle disconnect) runs for real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BG = path.join(ROOT, 'extension', 'background');
const EXT_ID = 'oicpmbpfimnoolnhfgdocfjelknjlcif';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Values created inside the vm context have foreign prototypes: compare plain JSON copies. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Download folders for comparing the extension's folder rules with the companion's. */
const FOLDER_CASES = [
  'D:\\Videos',
  'd:\\videos\\YouTube\\',
  'D:/Videos//YouTube/',
  'C:\\',
  'C:\\Users\\Akif\\Şəkillər\\Видео',
  "E:\\Akif's Videos",
  'C:\\ lead space',
  'C:\\' + 'x'.repeat(177),
  'C:\\' + 'x'.repeat(178),
  '\\\\nas\\share',
  '\\\\nas\\share\\videos\\',
  '\\\\evil.example@SSL\\DavWWWRoot\\yt',
  '\\\\.srv\\share',
  'D:\\YT.',
  'D:\\My \\x',
  'D:\\aux',
  'D:\\Media\\con.txt',
  'D:\\lpt\u00b2',
  'D:\\a\u007fb',
  'D:\\a<b',
  'D:\\a\\..\\b',
  'relative\\path',
];

/** companion/host/lib/paths.ts loaded with Node's TypeScript type stripping, or null when this Node can't. */
async function importHostPaths() {
  const emit = process.emitWarning;
  process.emitWarning = () => {}; // "Type Stripping is an experimental feature" etc.
  try {
    const m = await import(pathToFileURL(path.join(ROOT, 'companion', 'host', 'lib', 'paths.ts')).href);
    return typeof m.normalizeAbsolutePath === 'function' ? m : null;
  } catch (_) {
    return null;
  } finally {
    process.emitWarning = emit;
  }
}

async function until(fn, ms = 2000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(5);
  }
  throw new Error('timeout waiting for ' + label);
}

/* ------------------------------------------------------------------ chrome mock */

function makeEvent() {
  const fns = new Set();
  return {
    addListener: (f) => fns.add(f),
    removeListener: (f) => fns.delete(f),
    hasListener: (f) => fns.has(f),
    emit: (...args) => Array.from(fns).map((f) => f(...args)),
    get size() {
      return fns.size;
    },
  };
}

/** Context-menu items as Chrome restores them after a restart (built earlier in English). */
const PERSISTED_MENUS = [
  { id: 'ayt-link-video', title: 'Download video (best quality)', contexts: ['link'] },
  { id: 'ayt-link-audio', title: 'Download audio (MP3)', contexts: ['link'] },
  { id: 'ayt-page-video', title: 'Download video (best quality)', contexts: ['page', 'video'] },
  { id: 'ayt-page-audio', title: 'Download audio (MP3)', contexts: ['page', 'video'] },
];

function makeChrome(initialStore = {}, initialMenus = []) {
  const store = JSON.parse(JSON.stringify(initialStore));
  // menuOps: every contextMenus call in order ('removeAll', 'create:<id>', 'update:<id>')
  const rec = { badge: { text: '' }, notifications: [], menus: new Map(initialMenus.map((m) => [m.id, Object.assign({}, m)])), menuUpdates: 0, menuOps: [], tabsCreated: [], tabsUpdated: [], sentToTabs: [], downloads: [], storageSets: 0, setKeys: [], removedKeys: [] };
  const onChanged = makeEvent();
  /** Like Chrome: the callback runs later, with chrome.runtime.lastError set only while it runs. */
  const settle = (cb, err) => {
    if (typeof cb !== 'function') return err ? Promise.reject(new Error(err)) : Promise.resolve();
    setTimeout(() => {
      chrome.runtime.lastError = err ? { message: err } : undefined;
      try {
        cb();
      } finally {
        chrome.runtime.lastError = undefined;
      }
    }, 0);
    return undefined;
  };
  const chrome = {
    runtime: {
      id: EXT_ID,
      lastError: undefined,
      getURL: (p) => `chrome-extension://${EXT_ID}/${String(p).replace(/^\//, '')}`,
      onMessage: makeEvent(),
      onConnect: makeEvent(),
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      connectNative: () => {
        throw new Error('connectNative not mocked');
      },
      sendNativeMessage: async () => {
        throw new Error('Specified native messaging host not found.');
      },
      getContexts: async () => [],
    },
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return JSON.parse(JSON.stringify(store));
          const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
          const out = {};
          for (const k of list) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
          return out;
        },
        async set(obj) {
          rec.storageSets++;
          rec.setKeys.push(...Object.keys(obj));
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: JSON.parse(JSON.stringify(v)) };
            store[k] = JSON.parse(JSON.stringify(v));
          }
          setTimeout(() => onChanged.emit(changes, 'local'), 0);
        },
        async remove(keys) {
          for (const k of [].concat(keys)) {
            rec.removedKeys.push(k);
            delete store[k];
          }
        },
      },
      onChanged,
    },
    action: {
      setBadgeText: async (o) => {
        rec.badge.text = o.text;
      },
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
      setTitle: async (o) => {
        rec.badge.title = o.title;
      },
    },
    notifications: {
      create: async (id, o) => {
        rec.notifications.push(Object.assign({ id }, o));
        return id;
      },
      clear: async () => true,
      onClicked: makeEvent(),
      onButtonClicked: makeEvent(),
    },
    contextMenus: {
      removeAll: (cb) => {
        rec.menuOps.push('removeAll');
        rec.menus.clear();
        return settle(cb, '');
      },
      create: (p, cb) => {
        rec.menuOps.push('create:' + p.id);
        const err = rec.menus.has(p.id) ? `Cannot create item with duplicate id ${p.id}` : '';
        if (!err) rec.menus.set(p.id, Object.assign({}, p));
        if (typeof cb === 'function') settle(cb, err);
        return p.id;
      },
      update: (id, p, cb) => {
        rec.menuOps.push('update:' + id);
        rec.menuUpdates++;
        const item = rec.menus.get(id);
        if (item) Object.assign(item, p);
        return settle(cb, item ? '' : `Cannot find menu item with id ${id}`);
      },
      onClicked: makeEvent(),
    },
    commands: { onCommand: makeEvent() },
    tabs: {
      query: async () => [],
      sendMessage: async (tabId, msg, opts) => {
        rec.sentToTabs.push({ tabId, msg, opts });
      },
      create: async (o) => {
        rec.tabsCreated.push(o);
        return { id: 99 };
      },
      update: async (id, o) => {
        rec.tabsUpdated.push({ id, o });
        return { id };
      },
    },
    windows: { update: async () => ({}) },
    cookies: { getAll: async () => [] },
    downloads: {
      download: async (o) => {
        rec.downloads.push(o);
        return rec.downloads.length;
      },
    },
    i18n: { getUILanguage: () => 'en-US', getMessage: (k) => (k === 'actionTitle' ? "Akif's Special YouTube Addon" : '') },
  };
  return { chrome, store, rec };
}

/* ------------------------------------------------------------------ fake companion host */

class FakeHost {
  constructor(opts = {}) {
    this.opts = Object.assign({ missing: false, autoStart: true, protocol: 1 }, opts);
    this.sent = [];
    this.connects = 0;
    this.disconnects = 0;
    this.port = null;
    this.lastErr = '';
  }

  transport() {
    return {
      connect: (name) => this.connect(name),
      sendOnce: async (name, msg) => {
        if (this.opts.missing) throw new Error('Specified native messaging host not found.');
        return this.helloAnswer(msg.id);
      },
      lastError: () => this.lastErr,
    };
  }

  helloAnswer(id) {
    return {
      re: id,
      ok: true,
      name: 'akif-youtube-addon-host',
      version: '1.0.0',
      protocol: this.opts.protocol,
      platform: 'win32',
      tools: { ytdlp: { path: 'C:\\x\\yt-dlp.exe', version: '2026.10.26' }, ffmpeg: { path: 'C:\\x\\ffmpeg.exe', version: '8.1.1' }, deno: { path: 'C:\\x\\deno.exe', version: '2.8.1' } },
      downloadsDir: 'C:\\Users\\me\\Downloads',
      defaultDir: 'C:\\Users\\me\\Downloads\\Akif YouTube',
    };
  }

  connect(name) {
    this.connects++;
    const onMessage = makeEvent();
    const onDisconnect = makeEvent();
    const port = {
      name,
      onMessage,
      onDisconnect,
      connected: true,
      postMessage: (msg) => {
        if (!port.connected) throw new Error('Attempting to use a disconnected port object');
        this.sent.push(JSON.parse(JSON.stringify(msg)));
        setTimeout(() => this.handle(port, msg), 1);
      },
      disconnect: () => {
        port.connected = false;
        this.disconnects++;
      },
    };
    this.port = port;
    if (this.opts.missing) setTimeout(() => this.drop('Specified native messaging host not found.'), 1);
    return port;
  }

  drop(message) {
    const port = this.port;
    if (!port || !port.connected) return;
    port.connected = false;
    this.lastErr = message;
    port.onDisconnect.emit(port);
    this.lastErr = '';
  }

  reply(port, msg) {
    if (port.connected) port.onMessage.emit(msg, port);
  }

  emit(event) {
    this.reply(this.port, event);
  }

  handle(port, msg) {
    switch (msg.type) {
      case 'hello':
        return this.reply(port, this.helloAnswer(msg.id));
      case 'start':
        if (this.opts.autoStart) this.reply(port, { re: msg.id, ok: true });
        return undefined;
      case 'cancel':
        this.reply(port, { re: msg.id, ok: true });
        return this.reply(port, { event: 'canceled', jobId: msg.jobId });
      case 'open':
        if (String(msg.path).includes('gone')) return this.reply(port, { re: msg.id, ok: false, error: 'File not found', code: 'not_found' });
        return this.reply(port, { re: msg.id, ok: true });
      case 'pickFolder':
        return this.reply(port, { re: msg.id, ok: true, path: 'D:\\Videos' });
      case 'updateTools':
        return this.reply(port, { re: msg.id, ok: true, before: '2026.10.26', after: '2026.11.09', output: 'Updated yt-dlp' });
      default:
        return this.reply(port, { re: msg.id, ok: false, error: 'unknown request', code: 'bad_request' });
    }
  }

  started() {
    return this.sent.filter((m) => m.type === 'start');
  }
}

/**
 * Behaves like the real host (companion/host/host.ts): requests are handled concurrently, 'start' registers the job
 * only after preparing the output folder (startDelayMs), 'cancel' of a job it does not know (yet) answers
 * {found:false}. A registered job keeps sending progress until it is canceled or `finishAfterMs` passes.
 */
class RacyHost extends FakeHost {
  /** opts.gated: a start waits for releaseStarts() (deterministic races) instead of startDelayMs. */
  constructor(opts = {}) {
    super(Object.assign({ startDelayMs: 60, startReplyDelayMs: 0, finishAfterMs: 400, gated: false }, opts));
    this.running = new Map(); // jobId -> { timer, canceled }
    this.finished = []; // [jobId, 'done'|'canceled']
    this.gate = [];
  }

  /** Lets the gated starts finish preparing their folder: they are registered and answered now. */
  releaseStarts() {
    const pending = this.gate.splice(0);
    for (const fn of pending) fn();
    return pending.length;
  }

  handle(port, msg) {
    if (msg.type === 'start') {
      const register = () => {
        const job = { canceled: false, ticks: 0, timer: 0 };
        this.running.set(msg.jobId, job);
        const step = () => {
          if (!this.running.has(msg.jobId)) return;
          job.ticks++;
          this.reply(port, { event: 'progress', jobId: msg.jobId, stage: 'audio', percent: Math.min(99, job.ticks * 10) });
          if (job.ticks * 20 >= this.opts.finishAfterMs) {
            this.running.delete(msg.jobId);
            this.finished.push([msg.jobId, 'done']);
            this.reply(port, { event: 'done', jobId: msg.jobId, files: [{ path: 'D:\\Out\\x.mp3', size: 5 }], filePath: 'D:\\Out\\x.mp3', fileSize: 5 });
          } else job.timer = setTimeout(step, 20);
        };
        job.timer = setTimeout(step, 20);
        setTimeout(() => this.reply(port, { re: msg.id, ok: true, outDir: 'D:\\Out' }), this.opts.startReplyDelayMs);
      };
      if (this.opts.gated) this.gate.push(register);
      else setTimeout(register, this.opts.startDelayMs);
      return undefined;
    }
    if (msg.type === 'cancel') {
      const job = this.running.get(msg.jobId);
      if (!job) return this.reply(port, { re: msg.id, ok: true, found: false });
      clearTimeout(job.timer);
      this.running.delete(msg.jobId);
      this.finished.push([msg.jobId, 'canceled']);
      this.reply(port, { re: msg.id, ok: true });
      return this.reply(port, { event: 'canceled', jobId: msg.jobId });
    }
    return super.handle(port, msg);
  }

  cancels(jobId) {
    return this.sent.filter((m) => m.type === 'cancel' && m.jobId === jobId);
  }
}

/** Minimal in-memory IndexedDB (open / upgrade / one-request transactions with get + put) for the job history. */
class FakeIDB {
  constructor({ failOpen = false, failWrite = false } = {}) {
    this.dbs = new Map();
    this.failOpen = failOpen;
    this.failWrite = failWrite;
    this.writes = 0;
  }

  open(name) {
    const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    setTimeout(() => {
      if (this.failOpen) {
        req.error = new Error('UnknownError: Internal error opening backing store');
        if (req.onerror) req.onerror();
        return;
      }
      let stores = this.dbs.get(name);
      const fresh = !stores;
      if (!stores) this.dbs.set(name, (stores = new Map()));
      const idb = this;
      const db = {
        onversionchange: null,
        close() {},
        objectStoreNames: { contains: (n) => stores.has(n) },
        createObjectStore: (n) => {
          stores.set(n, new Map());
          return {};
        },
        transaction(storeName) {
          const st = stores.get(storeName);
          if (!st) throw new Error('NotFoundError: no such object store');
          const ops = [];
          const tx = { oncomplete: null, onabort: null, error: null, commit() {} };
          tx.objectStore = () => ({
            get(key) {
              const r = { result: undefined, error: null };
              ops.push(() => (r.result = st.has(key) ? structuredClone(st.get(key)) : undefined));
              return r;
            },
            put(value, key) {
              const r = { result: undefined, error: null };
              const copy = structuredClone(value); // IndexedDB clones at put() time
              ops.push(() => {
                if (idb.failWrite) throw new Error('QuotaExceededError');
                idb.writes++;
                st.set(key, copy);
                r.result = key;
              });
              return r;
            },
          });
          setTimeout(() => {
            try {
              for (const op of ops) op();
            } catch (e) {
              tx.error = e;
              if (tx.onabort) tx.onabort();
              return;
            }
            if (tx.oncomplete) tx.oncomplete();
          }, 0);
          return tx;
        },
      };
      req.result = db;
      if (fresh && req.onupgradeneeded) req.onupgradeneeded();
      if (req.onsuccess) req.onsuccess();
    }, 0);
    return req;
  }

  /** The persisted job list (what the service worker stored under ayt-jobs / kv / jobs). */
  jobs() {
    const db = this.dbs.get('ayt-jobs');
    const kv = db && db.get('kv');
    return kv ? kv.get('jobs') : undefined;
  }
}

/* ------------------------------------------------------------------ boot the real service worker */

/** menus: context-menu items that already exist (Chrome keeps them across service-worker and browser restarts). */
async function boot({ store = {}, host = null, settings = {}, idb = null, menus = [] } = {}) {
  const initial = Object.assign({}, store);
  for (const [k, v] of Object.entries(settings)) initial['settings.' + k] = v;
  const { chrome, store: liveStore, rec } = makeChrome(initial, menus);
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Blob,
    AbortController,
    crypto: globalThis.crypto,
    btoa,
    atob,
    Intl,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/157.0.0.0', language: 'en-US' },
    chrome,
  };
  if (idb) ctx.indexedDB = idb; // without it the service worker keeps the history in chrome.storage.local
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  ctx.importScripts = (...files) => {
    for (const f of files) {
      const file = path.resolve(BG, f);
      vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
    }
  };
  const sw = path.join(BG, 'service-worker.js');
  vm.runInContext(fs.readFileSync(sw, 'utf8'), ctx, { filename: sw });
  const AYT = ctx.AYT;
  await AYT.bgReady;
  AYT.native.config.idleDisconnectMs = 80;
  AYT.jobs.config.pushIntervalMs = 40;
  AYT.jobs.config.persistIntervalMs = 20;
  if (host) AYT.native.setTransport(host.transport());

  // A UI port like AYT.client's.
  const pushes = [];
  const uiPort = {
    name: 'ayt-ui',
    sender: { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup/popup.html` },
    onMessage: makeEvent(),
    onDisconnect: makeEvent(),
    postMessage: (m) => pushes.push(JSON.parse(JSON.stringify(m))),
    disconnect() {},
  };
  chrome.runtime.onConnect.emit(uiPort);
  await sleep(5);

  /** Sends a message like chrome.runtime.sendMessage from a context and resolves with the response. */
  function send(msg, sender) {
    return new Promise((resolve) => {
      let async = false;
      const results = chrome.runtime.onMessage.emit(msg, sender || { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup/popup.html` }, (r) => resolve(JSON.parse(JSON.stringify(r))));
      async = results.some((r) => r === true);
      if (!async) setTimeout(() => resolve(undefined), 30);
    });
  }
  return { ctx, AYT, chrome, store: liveStore, rec, pushes, send, uiPort };
}

const ytSender = { id: EXT_ID, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', origin: 'https://www.youtube.com', tab: { id: 7 } };

/* ================================================================== task validation */

test('task.validate: canonical URLs, defaults, unknown fields dropped', async () => {
  const { AYT } = await boot();
  const v = AYT.task.validate({ kind: 'video', url: 'https://youtu.be/dQw4w9WgXcQ?t=3', height: 2160, hdr: true, fps: 60, container: 'mp4', outputDir: 'C:\\evil', cookies: 'x', foo: 1 });
  assert.equal(v.videoId, 'dQw4w9WgXcQ');
  assert.equal(v.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(v.playlist, false);
  assert.equal(v.height, 2160);
  assert.equal(v.hdr, true);
  assert.equal(v.fps, 60);
  assert.equal(v.container, 'mp4');
  assert.equal(v.section, null);
  assert.equal(v.preciseCut, false);
  assert.ok(!('outputDir' in v) && !('cookies' in v) && !('foo' in v) && !('codec' in v));

  const s = AYT.task.validate({ kind: 'video', videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ', section: { start: 60, end: 150.12345 }, preciseCut: true });
  assert.deepEqual(JSON.parse(JSON.stringify(s.section)), { start: 60, end: 150.123 });

  const pl = AYT.task.validate({ kind: 'audio', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu', playlist: true, audioFormat: 'mp3', bitrate: 320 });
  assert.equal(pl.url, 'https://www.youtube.com/playlist?list=PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu');
  assert.equal(pl.playlist, true);
  assert.equal(pl.bitrate, 320);

  const sub = AYT.task.validate({ kind: 'subtitle', videoId: 'KrLj6nc516A', subLang: 'en', subAuto: true, subFormat: 'vtt', subTranslateTo: 'az' });
  assert.equal(sub.subLang, 'en');
  assert.equal(sub.subTranslateTo, 'az');

  const gif = AYT.task.validate({ kind: 'gif', videoId: 'jNQXAC9IVRw', section: { start: 1, end: 10 } });
  assert.equal(gif.gifWidth, 480);
  assert.equal(gif.gifFps, 15);
});

test('task.validate: rejects bad input with code bad_task', async () => {
  const { AYT } = await boot();
  const bad = [
    null,
    { kind: 'exe', videoId: 'dQw4w9WgXcQ' },
    { kind: 'video' },
    { kind: 'video', videoId: 'short' },
    { kind: 'video', url: 'https://evil.example/watch?v=dQw4w9WgXcQ' },
    { kind: 'video', url: 'javascript:alert(1)' },
    { kind: 'video', videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
    { kind: 'video', videoId: 'dQw4w9WgXcQ', container: 'avi' },
    { kind: 'video', videoId: 'dQw4w9WgXcQ', height: -1 },
    { kind: 'video', videoId: 'dQw4w9WgXcQ', hdr: 'yes' },
    { kind: 'video', videoId: 'dQw4w9WgXcQ', audioLang: 'en; rm -rf' },
    { kind: 'video', videoId: 'dQw4w9WgXcQ', section: { start: 10, end: 5 } },
    { kind: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ', playlist: true },
    { kind: 'gif', videoId: 'dQw4w9WgXcQ' },
    { kind: 'gif', videoId: 'dQw4w9WgXcQ', section: { start: 0, end: 90 } },
    { kind: 'gif', videoId: 'dQw4w9WgXcQ', section: { start: 0, end: 5 }, gifWidth: 5000 },
    { kind: 'audio', videoId: 'dQw4w9WgXcQ', bitrate: 999 },
    { kind: 'audio', videoId: 'dQw4w9WgXcQ', audioFormat: 'exe' },
    { kind: 'subtitle', videoId: 'dQw4w9WgXcQ' },
    { kind: 'subtitle', videoId: 'dQw4w9WgXcQ', subLang: 'en', playlist: true, url: 'https://www.youtube.com/playlist?list=PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu' },
  ];
  for (const raw of bad) {
    assert.throws(() => AYT.task.validate(raw), (e) => e.code === 'bad_task', JSON.stringify(raw));
  }
});

test('task.buildHostTask merges settings; cookies only when given', async () => {
  const { AYT } = await boot();
  const task = AYT.task.validate({ kind: 'video', videoId: 'dQw4w9WgXcQ', height: 1080, hdr: false, fps: 30 });
  const s = Object.assign({}, AYT.DEFAULT_SETTINGS, { outputDir: 'D:\\Videos', subfolder: 'Sub', filenameStyle: 'title_id', videoContainer: 'mkv', videoCodec: 'compat', embedSubtitles: true });
  const h = AYT.task.buildHostTask(task, s, null, 'az');
  assert.equal(h.outputDir, 'D:\\Videos');
  assert.equal(h.subfolder, 'Sub');
  assert.equal(h.filenameStyle, 'title_id');
  assert.equal(h.container, 'mkv');
  assert.equal(h.codec, 'compat');
  assert.equal(h.embedSubtitles, true);
  assert.equal(h.embedThumbnail, true);
  assert.equal(h.cookies, null);
  assert.equal(h.uiLang, 'az');
  assert.equal(h.audioLang, null);

  const a = AYT.task.buildHostTask(AYT.task.validate({ kind: 'audio', videoId: 'dQw4w9WgXcQ', embedThumbnail: false }), s, '# Netscape HTTP Cookie File\n', 'en');
  assert.equal(a.audioFormat, 'mp3');
  assert.equal(a.bitrate, 192);
  assert.equal(a.embedThumbnail, false);
  assert.equal(a.cookies, '# Netscape HTTP Cookie File\n');
  assert.equal(a.embedChapters, true, 'the Chapters setting reaches audio tasks');
  const noCh = AYT.task.buildHostTask(AYT.task.validate({ kind: 'audio', videoId: 'dQw4w9WgXcQ' }), Object.assign({}, s, { embedChapters: false }), null, 'en');
  assert.equal(noCh.embedChapters, false);
});

test('task.cookiesToNetscape writes the yt-dlp cookie file format', async () => {
  const { AYT } = await boot();
  const txt = AYT.task.cookiesToNetscape([
    { domain: '.youtube.com', hostOnly: false, path: '/', secure: true, httpOnly: true, session: false, expirationDate: 1798000000.5, name: 'SID', value: 'abc' },
    { domain: 'www.youtube.com', hostOnly: true, path: '/', secure: false, httpOnly: false, session: true, name: 'PREF', value: 'f6=8' },
    { domain: '.youtube.com', path: '/', name: 'BAD', value: 'a\tb' },
  ]);
  const lines = txt.trim().split('\n');
  assert.equal(lines[0], '# Netscape HTTP Cookie File');
  assert.ok(lines.includes('#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1798000000\tSID\tabc'));
  assert.ok(lines.includes('www.youtube.com\tFALSE\t/\tFALSE\t0\tPREF\tf6=8'));
  assert.ok(!txt.includes('BAD'));
});

/* ================================================================== router */

test('router: validation, foreign senders, unknown types', async () => {
  const { send } = await boot();
  assert.equal(await send({ type: 'job:start', task: { kind: 'video' } }, { id: 'other-extension' }), undefined);
  const r1 = await send({ type: 'job:start', task: { kind: 'video', videoId: 'nope' }, meta: {} });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'bad_task');
  assert.match(r1.error, /Invalid download request/);
  const r2 = await send({ type: 'job:frobnicate' });
  assert.deepEqual([r2.ok, r2.code], [false, 'bad_request']);
  assert.equal(await send({ type: 'somebody-elses-message' }), undefined);
  const r3 = await send({ type: 'job:cancel', jobId: '../../x' });
  assert.deepEqual([r3.ok, r3.code], [false, 'bad_request']);
  const r4 = await send({ type: 'job:cancel', jobId: 'abc-123' });
  assert.deepEqual([r4.ok, r4.code], [false, 'not_found']);
  const r5 = await send({ __aytWake: 1 });
  assert.equal(r5.ok, true);
  const r6 = await send({ type: 'jobs:list' });
  assert.deepEqual(JSON.parse(JSON.stringify(r6)), { ok: true, jobs: [] });
});

test('router: OPEN_TAB / OPEN_OPTIONS allow-lists', async () => {
  const { send, rec } = await boot();
  assert.equal((await send({ type: 'tab:open', url: 'chrome://extensions/shortcuts' })).ok, true);
  assert.equal(rec.tabsCreated.at(-1).url, 'chrome://extensions/shortcuts');
  assert.equal((await send({ type: 'tab:open', url: `chrome-extension://${EXT_ID}/options/options.html#about` })).ok, true);
  for (const url of ['https://evil.example/', 'chrome://settings', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html', 'file:///C:/Windows/win.ini']) {
    const r = await send({ type: 'tab:open', url });
    assert.deepEqual([r.ok, r.code], [false, 'bad_url'], url);
  }
  assert.equal((await send({ type: 'options:open', section: 'downloads' })).ok, true);
  assert.equal(rec.tabsCreated.at(-1).url, `chrome-extension://${EXT_ID}/options/options.html#downloads`);
  const bad = await send({ type: 'options:open', section: '"><img>' });
  assert.equal(bad.code, 'bad_request');
});

/* ================================================================== host status */

test('host status: missing via sendNativeMessage, pushed to UI ports, cached 60 s', async () => {
  const { send, pushes, chrome } = await boot();
  let calls = 0;
  chrome.runtime.sendNativeMessage = async () => {
    calls++;
    throw new Error('Specified native messaging host not found.');
  };
  const r = await send({ type: 'host:status', refresh: true });
  assert.equal(r.ok, true);
  assert.equal(r.status.state, 'missing');
  assert.ok(r.status.checkedAt > 0);
  assert.ok(pushes.some((p) => p.type === 'host' && p.status.state === 'missing'));
  await send({ type: 'host:status' });
  assert.equal(calls, 1, 'second non-forced check uses the cache');
});

test('host status: connected / outdated / forbidden / error mapping', async () => {
  const { AYT, send } = await boot();
  AYT.native.setTransport(new FakeHost().transport());
  let r = await send({ type: 'host:status', refresh: true });
  assert.equal(r.status.state, 'connected');
  assert.equal(r.status.version, '1.0.0');
  assert.equal(r.status.tools.ytdlp.version, '2026.10.26');
  assert.equal(r.status.defaultDir, 'C:\\Users\\me\\Downloads\\Akif YouTube');

  AYT.native.setTransport(new FakeHost({ protocol: 0 }).transport());
  r = await send({ type: 'host:status', refresh: true });
  assert.equal(r.status.state, 'outdated');
  assert.ok(r.status.error);

  for (const [message, state] of [
    ['Access to the specified native messaging host is forbidden.', 'forbidden'],
    ['Native host has exited.', 'error'],
    ['Error when communicating with the native messaging host.', 'error'],
    ['Specified native messaging host not found.', 'missing'],
  ]) {
    AYT.native.setTransport({ sendOnce: async () => { throw new Error(message); } });
    r = await send({ type: 'host:status', refresh: true });
    assert.equal(r.status.state, state, message);
    if (state === 'error') assert.match(r.status.error, /install\.bat/);
  }
});

test('host status: hello timeout -> error state with a timeout message', async () => {
  const { AYT, send } = await boot();
  AYT.native.config.helloTimeoutMs = 50;
  AYT.native.setTransport({ sendOnce: () => new Promise(() => {}) });
  const r = await send({ type: 'host:status', refresh: true });
  assert.equal(r.status.state, 'error');
  assert.match(r.status.error, /didn't answer in time/);
});

/* ================================================================== jobs */

test('jobs: host missing -> job fails with a helpful message, badge back to empty', async () => {
  const host = new FakeHost({ missing: true });
  const { send, pushes, rec } = await boot({ host });
  const r = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw', audioFormat: 'mp3', bitrate: 128 }, meta: { title: 'Me at the zoo', label: 'MP3 · 128 kbps' } });
  assert.equal(r.ok, true);
  assert.ok(r.jobId);
  const job = await until(async () => {
    const l = await send({ type: 'jobs:list' });
    const j = l.jobs.find((x) => x.id === r.jobId);
    return j && j.status === 'error' ? j : null;
  });
  assert.equal(job.errorCode, 'host_missing');
  assert.match(job.error, /isn't installed/);
  assert.equal(rec.badge.text, '');
  const statuses = pushes.filter((p) => p.type === 'job' && p.job.id === r.jobId).map((p) => p.job.status);
  assert.deepEqual([...new Set(statuses)], ['queued', 'starting', 'error']);
  assert.ok(rec.notifications.some((n) => /Download failed: Me at the zoo/.test(n.title)));
});

test('jobs: full lifecycle with progress throttling, persistence, notification and idle disconnect', async () => {
  const host = new FakeHost();
  const { AYT, chrome, send, pushes, rec, store } = await boot({ host, settings: { useCookies: false, outputDir: 'D:\\Out' } });
  const r = await send({ type: 'job:start', task: { kind: 'video', videoId: 'dQw4w9WgXcQ', height: 1080, hdr: false, fps: 30, container: 'mp4' }, meta: { title: 'Never Gonna Give You Up', label: 'MP4 · 1080p' } }, ytSender);
  assert.equal(r.ok, true);
  assert.equal(r.job.title, 'Never Gonna Give You Up');
  const id = r.jobId;
  await until(() => host.started().length === 1, 2000, 'start sent');
  const start = host.started()[0];
  assert.equal(start.jobId, id);
  assert.equal(start.task.outputDir, 'D:\\Out');
  assert.equal(start.task.cookies, null);
  assert.equal(start.task.container, 'mp4');
  assert.equal(start.task.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await until(() => AYT.jobs.get(id).status === 'running', 2000, 'running');
  assert.equal(rec.badge.text, '1');

  const before = pushes.length;
  host.emit({ event: 'info', jobId: id, title: 'Rick Astley - Never Gonna Give You Up', videoId: 'dQw4w9WgXcQ', duration: 213 });
  for (let i = 1; i <= 40; i++) host.emit({ event: 'progress', jobId: id, stage: 'video', percent: i * 2, downloaded: i * 1000, total: 80000, speed: 5e6, eta: 40 - i });
  await sleep(120);
  const progressPushes = pushes.slice(before).filter((p) => p.type === 'job' && p.job.id === id);
  assert.ok(progressPushes.length <= 6, `throttled pushes (${progressPushes.length})`);
  assert.equal(progressPushes.at(-1).job.percent, 80, 'last progress value delivered');
  assert.equal(AYT.jobs.get(id).title, 'Never Gonna Give You Up', 'meta title kept');

  host.emit({ event: 'stage', jobId: id, stage: 'merge' });
  await sleep(5);
  assert.equal(AYT.jobs.get(id).status, 'processing');
  assert.equal(AYT.jobs.get(id).stage, 'merge');
  host.emit({ event: 'file', jobId: id, path: 'D:\\Out\\Never.mp4', size: 123456 });
  host.emit({ event: 'done', jobId: id, files: [{ path: 'D:\\Out\\Never.mp4', size: 123456 }], filePath: 'D:\\Out\\Never.mp4', fileSize: 123456 });
  await sleep(5);
  const done = AYT.jobs.get(id);
  assert.equal(done.status, 'done');
  assert.equal(done.percent, 100);
  assert.equal(done.filePath, 'D:\\Out\\Never.mp4');
  assert.equal(rec.badge.text, '');
  const note = rec.notifications.find((n) => n.id === 'ayt-job:' + id);
  assert.ok(note && /Download completed/.test(note.title) && note.message === 'Never.mp4' && note.buttons.length === 2);

  await until(() => Array.isArray(store.jobs) && store.jobs[0] && store.jobs[0].status === 'done', 2000, 'persisted');
  assert.ok(!JSON.stringify(store.jobs).includes('cookies'), 'no cookies persisted');

  // notification click -> host 'open' with the job's own path
  await AYT.jobs.open(id, 'folder');
  const open = host.sent.find((m) => m.type === 'open');
  assert.deepEqual([open.path, open.target], ['D:\\Out\\Never.mp4', 'folder']);

  // idle: port disconnected ~80 ms after the last request when nothing is active
  await until(() => host.disconnects === 1, 2000, 'idle disconnect');
  assert.equal(AYT.native.connected, false);

  // clicking the notification opens the file; the second button reveals it in its folder
  chrome.notifications.onClicked.emit('ayt-job:' + id);
  await until(() => host.sent.filter((m) => m.type === 'open').length === 2, 2000, 'open from click');
  assert.equal(host.sent.filter((m) => m.type === 'open')[1].target, 'file');
  chrome.notifications.onButtonClicked.emit('ayt-job:' + id, 1);
  await until(() => host.sent.filter((m) => m.type === 'open').length === 3, 2000, 'open from button');
  assert.equal(host.sent.filter((m) => m.type === 'open')[2].target, 'folder');
});

test('jobs: cookies are attached only when useCookies is on', async () => {
  const host = new FakeHost();
  const { AYT, chrome, send } = await boot({ host, settings: { useCookies: true } });
  chrome.cookies.getAll = async (q) => {
    assert.equal(q.domain, 'youtube.com');
    return [{ domain: '.youtube.com', path: '/', secure: true, httpOnly: true, expirationDate: 1798000000, name: 'SID', value: 'secret' }];
  };
  const r = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw' }, meta: {} });
  await until(() => host.started().length === 1);
  assert.match(host.started()[0].task.cookies, /SID\tsecret/);
  assert.ok(!JSON.stringify(AYT.jobs.get(r.jobId)).includes('secret'), 'cookies are not part of the job');
});

test('jobs: maxConcurrent queueing, cancel queued + running, retry, remove, clear', async () => {
  const host = new FakeHost();
  const { AYT, send } = await boot({ host, settings: { maxConcurrent: 1 } });
  const a = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw' }, meta: { title: 'A' } });
  const b = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'dQw4w9WgXcQ' }, meta: { title: 'B' } });
  const c = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'KrLj6nc516A' }, meta: { title: 'C' } });
  await until(() => AYT.jobs.get(a.jobId).status === 'running');
  assert.equal(AYT.jobs.get(b.jobId).status, 'queued');
  assert.equal(AYT.jobs.get(c.jobId).status, 'queued');

  // cancel a queued job: immediate
  assert.equal((await send({ type: 'job:cancel', jobId: c.jobId })).ok, true);
  assert.equal(AYT.jobs.get(c.jobId).status, 'canceled');
  assert.equal(host.started().length, 1);

  // cancel the running job: host 'cancel' -> 'canceled' event; then B starts
  await send({ type: 'job:cancel', jobId: a.jobId });
  await until(() => AYT.jobs.get(a.jobId).status === 'canceled');
  assert.ok(host.sent.some((m) => m.type === 'cancel' && m.jobId === a.jobId));
  await until(() => AYT.jobs.get(b.jobId).status === 'running');

  // host error event -> friendly message + raw reason
  host.emit({ event: 'error', jobId: b.jobId, code: 'unavailable', message: 'ERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video has been removed by the uploader' });
  await until(() => AYT.jobs.get(b.jobId).status === 'error');
  assert.equal(AYT.jobs.get(b.jobId).error, 'This video is unavailable. — Video unavailable. This video has been removed by the uploader');

  // retry -> new job with the same task, old one removed
  const rr = await send({ type: 'job:retry', jobId: b.jobId });
  assert.equal(rr.ok, true);
  assert.notEqual(rr.jobId, b.jobId);
  assert.equal(AYT.jobs.get(b.jobId), null);
  assert.equal(AYT.jobs.get(rr.jobId).task.videoId, 'dQw4w9WgXcQ');
  await until(() => AYT.jobs.get(rr.jobId).status === 'running');

  // retry of a running job is refused
  const bad = await send({ type: 'job:retry', jobId: rr.jobId });
  assert.deepEqual([bad.ok, bad.code], [false, 'bad_state']);

  // remove an active job -> canceled at the host and gone from the list
  assert.equal((await send({ type: 'job:remove', jobId: rr.jobId })).ok, true);
  assert.equal(AYT.jobs.get(rr.jobId), null);
  await until(() => host.sent.some((m) => m.type === 'cancel' && m.jobId === rr.jobId));

  // clear finished jobs
  const cl = await send({ type: 'jobs:clear' });
  assert.equal(cl.ok, true);
  assert.equal(cl.removed, 2);
  assert.equal(AYT.jobs.list().length, 0);
});

test('jobs: host crash fails running jobs with host_exit and pending requests are rejected', async () => {
  const host = new FakeHost();
  const { AYT, send } = await boot({ host });
  const r = await send({ type: 'job:start', task: { kind: 'video', videoId: 'dQw4w9WgXcQ' }, meta: { title: 'X' } });
  await until(() => AYT.jobs.get(r.jobId).status === 'running');
  host.emit({ event: 'progress', jobId: r.jobId, stage: 'video', percent: 30 });
  host.drop('Native host has exited.');
  await until(() => AYT.jobs.get(r.jobId).status === 'error');
  assert.equal(AYT.jobs.get(r.jobId).errorCode, 'host_exit');
  assert.match(AYT.jobs.get(r.jobId).error, /stopped unexpectedly/);
  assert.equal(AYT.native.connected, false);
});

test('jobs: start request timeout -> error timeout and a best-effort cancel', async () => {
  const host = new FakeHost({ autoStart: false });
  const { AYT, send } = await boot({ host });
  AYT.native.config.requestTimeoutMs = 60;
  const r = await send({ type: 'job:start', task: { kind: 'video', videoId: 'dQw4w9WgXcQ' }, meta: {} });
  await until(() => AYT.jobs.get(r.jobId).status === 'error');
  assert.equal(AYT.jobs.get(r.jobId).errorCode, 'timeout');
  await until(() => host.sent.some((m) => m.type === 'cancel'));
});

test('jobs: active jobs found at start-up are marked interrupted', async () => {
  const stored = [
    { id: 'aaaaaaaa-1111', kind: 'video', status: 'running', title: 'Old', task: { kind: 'video', videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', playlist: false }, meta: {}, files: [], createdAt: 1, percent: 40 },
    { id: 'bbbbbbbb-2222', kind: 'audio', status: 'done', title: 'Done', task: { kind: 'audio', videoId: 'jNQXAC9IVRw', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', playlist: false }, meta: {}, files: [{ path: 'C:\\a.mp3', size: 1 }], filePath: 'C:\\a.mp3', createdAt: 2 },
    { id: 'evil/../id', kind: 'video', status: 'running' },
  ];
  const { AYT, store, rec } = await boot({ store: { jobs: stored } });
  const old = AYT.jobs.get('aaaaaaaa-1111');
  assert.equal(old.status, 'error');
  assert.equal(old.errorCode, 'interrupted');
  assert.equal(old.error, AYT.t('job.interrupted'));
  assert.equal(AYT.jobs.get('bbbbbbbb-2222').status, 'done');
  assert.equal(AYT.jobs.list().length, 2);
  assert.equal(store.jobs.find((j) => j.id === 'aaaaaaaa-1111').status, 'error', 'persisted right away');
  assert.equal(rec.notifications.length, 0, 'no notifications for interrupted jobs');
});

test('jobs: error texts follow the UI language', async () => {
  const host = new FakeHost({ missing: true });
  const { AYT, send, pushes } = await boot({ host });
  const r = await send({ type: 'job:start', task: { kind: 'video', videoId: 'dQw4w9WgXcQ' }, meta: { title: 'T' } });
  await until(() => AYT.jobs.get(r.jobId).status === 'error');
  AYT.i18n.register('tr', { 'job.err.host_missing': 'Yardımcı uygulama kurulu değil.', 'background.menu.video': 'Videoyu indir (en iyi kalite)' });
  await AYT.settings.set('language', 'tr');
  await until(() => AYT.jobs.get(r.jobId).error === 'Yardımcı uygulama kurulu değil.');
  assert.ok(pushes.some((p) => p.type === 'jobs'));
});

/* ================================================================== cancel races, slim pushes, partial playlists, history store */

test('jobs: a cancel that overtakes the start (host answers found:false) is sent again once the start is confirmed', async () => {
  const host = new RacyHost({ gated: true, finishAfterMs: 300 });
  const { AYT, send } = await boot({ host });
  AYT.jobs.config.cancelGraceMs = 5000; // the job must end through the host, not through the grace timer
  const r = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw' }, meta: { title: 'Zoo' } });
  await until(() => host.started().length === 1, 2000, 'start sent');
  assert.equal(AYT.jobs.get(r.jobId).status, 'starting');
  assert.equal((await send({ type: 'job:cancel', jobId: r.jobId })).ok, true);
  await until(() => host.cancels(r.jobId).length === 1, 2000, 'first cancel at the host');
  await sleep(20); // its found:false answer is back
  assert.equal(AYT.jobs.get(r.jobId).status, 'starting', 'not finished by the unanswered cancel');
  assert.equal(host.releaseStarts(), 1); // the host has prepared the folder: registers the job, answers the start
  await until(() => AYT.jobs.get(r.jobId).status === 'canceled', 2000, 'canceled');
  assert.equal(host.cancels(r.jobId).length, 2, 'the first cancel found nothing, the second one reached the job');
  assert.deepEqual(host.finished, [[r.jobId, 'canceled']]);
  await sleep(400);
  assert.equal(AYT.jobs.get(r.jobId).status, 'canceled', 'and no "done" later');
  assert.deepEqual(host.finished, [[r.jobId, 'canceled']]);
});

test('jobs: a job removed while its start is on its way is canceled at the host once registered', async () => {
  const host = new RacyHost({ gated: true, finishAfterMs: 600 });
  const { AYT, send } = await boot({ host });
  const r = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw' }, meta: { title: 'Zoo' } });
  await until(() => host.started().length === 1, 2000, 'start sent');
  assert.equal((await send({ type: 'job:remove', jobId: r.jobId })).ok, true);
  assert.equal(AYT.jobs.get(r.jobId), null);
  await until(() => host.cancels(r.jobId).length === 1, 2000, 'first cancel at the host');
  await sleep(20);
  assert.equal(host.releaseStarts(), 1);
  await until(() => host.finished.length === 1, 2000, 'host job ended');
  assert.deepEqual(host.finished, [[r.jobId, 'canceled']]);
  assert.equal(host.cancels(r.jobId).length, 2);
});

test('jobs: host progress for a job that already failed here (start answered too late) makes the host stop it', async () => {
  const host = new RacyHost({ gated: true, finishAfterMs: 3000 });
  const { AYT, send } = await boot({ host });
  AYT.native.config.requestTimeoutMs = 60;
  AYT.native.config.idleDisconnectMs = 5000; // keep the port: this test is about the host's events
  const r = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw' }, meta: {} });
  await until(() => AYT.jobs.get(r.jobId).status === 'error', 2000, 'start timeout');
  assert.equal(AYT.jobs.get(r.jobId).errorCode, 'timeout');
  await until(() => host.cancels(r.jobId).length === 1, 2000, 'best-effort cancel after the timeout');
  await sleep(20); // answered found:false: the host is still preparing the folder
  assert.equal(host.releaseStarts(), 1); // ... and registers the job only now
  await until(() => host.finished.length === 1, 2000, 'late job stopped');
  assert.deepEqual(host.finished, [[r.jobId, 'canceled']], 'its first progress event triggered another cancel');
  assert.equal(host.cancels(r.jobId).length, 2);
  assert.equal(AYT.jobs.get(r.jobId).status, 'error', 'the job keeps its timeout error');
  AYT.native.disconnect();
});

test('jobs: pushes, port snapshots and JOBS_LIST carry the slim UI view; the history keeps a playlist short', async () => {
  const host = new FakeHost();
  const { AYT, chrome, send, pushes, store } = await boot({ host });
  const playlist = 'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu';
  const r = await send({ type: 'job:start', task: { kind: 'audio', url: playlist, playlist: true }, meta: { title: 'List', label: 'MP3 · 192 kbps' } });
  const id = r.jobId;
  assert.ok(!('files' in r.job) && !('meta' in r.job) && r.job.task.playlist === true && ['queued', 'starting'].includes(r.job.status), 'JOB_START answer');
  await until(() => AYT.jobs.get(id).status === 'running');
  for (let i = 0; i < 300; i++) host.emit({ event: 'file', jobId: id, path: `D:\\Out\\Some artist - track number ${i} (Official Video).mp3`, size: 4e6 + i });
  host.emit({ event: 'progress', jobId: id, stage: 'audio', percent: 50, downloaded: 5, total: 10, speed: 1, eta: 3, playlistIndex: 300, playlistCount: 600 });
  await sleep(80);
  assert.equal(AYT.jobs.get(id).files.length, 300, 'the service worker keeps every file');
  const mine = pushes.filter((p) => p.type === 'job' && p.job.id === id);
  for (const p of mine) for (const k of ['files', 'meta', 'errorDetail', 'titlePending']) assert.ok(!(k in p.job), `push without ${k}`);
  const last = mine.at(-1);
  const readers = ['id', 'kind', 'videoId', 'title', 'label', 'thumbnail', 'status', 'stage', 'percent', 'downloaded', 'total', 'speed', 'eta', 'playlist', 'filePath', 'fileSize', 'fileCount', 'failedItems', 'error', 'errorCode', 'task', 'createdAt', 'updatedAt', 'finishedAt'];
  for (const k of readers) assert.ok(k in last.job, `push has ${k}`);
  assert.deepEqual(plain([last.job.percent, last.job.playlist.index, last.job.playlist.count]), [50, 300, 600]);
  assert.ok(JSON.stringify(last).length < 2000, `a push stays small with 300 files (${JSON.stringify(last).length} bytes)`);
  const listed = await send({ type: 'jobs:list' });
  assert.ok(!('files' in listed.jobs[0]) && listed.jobs[0].percent === 50, 'JOBS_LIST');
  const got = [];
  const port = { name: 'ayt-ui', sender: { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup/popup.html` }, onMessage: makeEvent(), onDisconnect: makeEvent(), postMessage: (m) => got.push(JSON.parse(JSON.stringify(m))), disconnect() {} };
  chrome.runtime.onConnect.emit(port);
  await sleep(5);
  assert.ok(got[0].type === 'jobs' && !('files' in got[0].jobs[0]) && got[0].jobs[0].percent === 50, 'port snapshot');
  await until(() => Array.isArray(store.jobs) && store.jobs[0] && store.jobs[0].files.length === 50, 2000, 'persisted');
  assert.equal(store.jobs[0].files.at(-1).path, 'D:\\Out\\Some artist - track number 299 (Official Video).mp3', 'the newest files are kept');
});

test('jobs: a playlist with failed items (done.failedItems) is reported as finished with errors', async () => {
  const host = new FakeHost();
  const { AYT, send, rec, pushes } = await boot({ host });
  const task = { kind: 'audio', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu', playlist: true };
  const a = await send({ type: 'job:start', task, meta: { title: 'My playlist', label: 'MP3 · 192 kbps' } });
  await until(() => AYT.jobs.get(a.jobId).status === 'running');
  const files = Array.from({ length: 17 }, (_, i) => ({ path: `D:\\Out\\${i}.mp3`, size: 70e6 }));
  host.emit({ event: 'done', jobId: a.jobId, files, filePath: files[0].path, fileSize: 1.19e9, fileCount: 17, failedItems: 3 });
  await until(() => AYT.jobs.get(a.jobId).status === 'done');
  assert.deepEqual(plain([AYT.jobs.get(a.jobId).fileCount, AYT.jobs.get(a.jobId).failedItems]), [17, 3]);
  const note = await until(() => rec.notifications.find((n) => n.id === 'ayt-job:' + a.jobId));
  assert.equal(note.title, 'Download finished with errors: My playlist');
  assert.equal(note.message, 'Downloaded: 17 · Failed: 3');
  assert.equal(note.buttons.length, 2);
  const push = pushes.filter((p) => p.type === 'job' && p.job.id === a.jobId).at(-1).job;
  assert.deepEqual([push.status, push.fileCount, push.failedItems], ['done', 17, 3]);

  // no failed items: the usual "Download completed"
  const b = await send({ type: 'job:start', task, meta: { title: 'Other playlist' } });
  await until(() => AYT.jobs.get(b.jobId).status === 'running');
  host.emit({ event: 'done', jobId: b.jobId, files: files.slice(0, 2), filePath: files[0].path, fileSize: 2, fileCount: 2 });
  await until(() => AYT.jobs.get(b.jobId).status === 'done');
  assert.deepEqual(plain([AYT.jobs.get(b.jobId).fileCount, AYT.jobs.get(b.jobId).failedItems]), [2, 0]);
  const noteB = await until(() => rec.notifications.find((n) => n.id === 'ayt-job:' + b.jobId));
  assert.equal(noteB.title, 'Download completed: Other playlist');
});

test('jobs: the history lives in IndexedDB (no chrome.storage write reaches the tabs) and survives a restart', async () => {
  const idb = new FakeIDB();
  const host = new FakeHost();
  const { AYT, send, store, rec } = await boot({ host, idb });
  assert.equal(AYT.jobs.storageBackend, 'indexeddb');
  const r = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw' }, meta: { title: 'Zoo' } });
  await until(() => AYT.jobs.get(r.jobId).status === 'running');
  host.emit({ event: 'done', jobId: r.jobId, files: [{ path: 'D:\\Out\\Zoo.mp3', size: 5 }], filePath: 'D:\\Out\\Zoo.mp3', fileSize: 5 });
  await until(() => (idb.jobs() || []).some((j) => j.id === r.jobId && j.status === 'done'), 2000, 'stored in IndexedDB');
  await sleep(40);
  assert.ok(!('jobs' in store), 'nothing in chrome.storage.local');
  assert.ok(!rec.setKeys.includes('jobs'), 'no chrome.storage write of the history');

  const again = await boot({ idb }); // service worker restart: same IndexedDB
  const job = again.AYT.jobs.get(r.jobId);
  assert.equal(job && job.status, 'done');
  assert.equal(job.filePath, 'D:\\Out\\Zoo.mp3');
});

test('jobs: a history in chrome.storage.local (older version) is merged into IndexedDB and the old key removed', async () => {
  const idb = new FakeIDB();
  const task = (videoId) => ({ kind: 'audio', videoId, url: 'https://www.youtube.com/watch?v=' + videoId, playlist: false });
  const legacy = [
    { id: 'aaaaaaaa-1111', kind: 'audio', status: 'done', title: 'Old', task: task('jNQXAC9IVRw'), meta: {}, files: [{ path: 'C:\\a.mp3', size: 1 }], filePath: 'C:\\a.mp3', createdAt: 2, updatedAt: 2 },
    { id: 'bbbbbbbb-2222', kind: 'audio', status: 'running', title: 'Was running', task: task('dQw4w9WgXcQ'), meta: {}, files: [], createdAt: 1, updatedAt: 1 },
  ];
  const { AYT, store, rec } = await boot({ store: { jobs: legacy }, idb });
  assert.deepEqual(plain(AYT.jobs.list().map((j) => j.id)), ['aaaaaaaa-1111', 'bbbbbbbb-2222']);
  assert.equal(AYT.jobs.get('bbbbbbbb-2222').errorCode, 'interrupted');
  await until(() => !('jobs' in store), 2000, 'old key removed');
  assert.ok(rec.removedKeys.includes('jobs'));
  assert.deepEqual(idb.jobs().map((j) => [j.id, j.status]), [['aaaaaaaa-1111', 'done'], ['bbbbbbbb-2222', 'error']]);
});

test('jobs: without a working IndexedDB the history falls back to chrome.storage.local', async () => {
  for (const idb of [new FakeIDB({ failOpen: true }), new FakeIDB({ failWrite: true })]) {
    const host = new FakeHost();
    const { AYT, send, store } = await boot({ host, idb });
    const r = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw' }, meta: {} });
    await until(() => Array.isArray(store.jobs) && store.jobs.some((j) => j.id === r.jobId), 2000, 'persisted in chrome.storage.local');
    assert.equal(AYT.jobs.storageBackend, 'storage');
  }
});

test('task: download folders follow the companion rules; a stored folder it would refuse fails the job right away', async () => {
  const host = new FakeHost();
  const { AYT, send, chrome, rec } = await boot({ host, settings: { outputDir: 'D:\\' + 'x'.repeat(190) } });
  const c = (v) => plain(AYT.task.checkOutputDir(v));
  assert.equal(AYT.task.MAX_OUTPUT_DIR, 180);
  assert.deepEqual(c('C:\\' + 'x'.repeat(177)), { ok: true, value: 'C:\\' + 'x'.repeat(177) }, '180 characters');
  assert.equal(c('C:\\' + 'x'.repeat(178)).reason, 'long', '181 characters');
  assert.equal(c('C:\\' + 'x'.repeat(177) + '\\').value, 'C:\\' + 'x'.repeat(177), 'the trailing separator does not count');
  assert.equal(c('D:/Videos//YouTube/').value, 'D:\\Videos\\YouTube');
  assert.equal(c('\\\\nas\\share\\videos').value, '\\\\nas\\share\\videos');
  for (const bad of ['D:\\YT.', 'D:\\My \\x', 'D:\\aux', 'D:\\Media\\con.txt', 'D:\\com\u00b9', '\\\\.srv\\share']) assert.equal(c(bad).reason, 'name', bad);
  assert.equal(c('D:\\a\u007fb').reason, 'chars');
  assert.equal(c('D:\\a:b').reason, 'chars');
  assert.equal(c('Videos').reason, 'absolute');
  assert.deepEqual(c('  '), { ok: true, value: '' });
  const audio = AYT.task.validate({ kind: 'audio', videoId: 'jNQXAC9IVRw' });
  assert.throws(() => AYT.task.buildHostTask(audio, { outputDir: 'D:\\aux\\x' }, null, 'en'), (e) => e.code === 'bad_folder');
  assert.equal(AYT.task.buildHostTask(audio, { outputDir: ' "D:/Out/" ' }, null, 'en').outputDir, 'D:\\Out');

  const r = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw' }, meta: { title: 'Zoo' } });
  await until(() => AYT.jobs.get(r.jobId).status === 'error');
  assert.equal(AYT.jobs.get(r.jobId).errorCode, 'bad_folder');
  assert.equal(AYT.jobs.get(r.jobId).error, AYT.t('job.err.bad_folder'), 'no raw detail appended');
  assert.match(AYT.jobs.get(r.jobId).error, /Settings → Downloads/);
  assert.equal(host.started().length, 0, 'nothing was sent to the companion');
  chrome.notifications.onClicked.emit('ayt-job:' + r.jobId);
  await until(() => rec.tabsCreated.some((x) => /options\.html#downloads$/.test(x.url)), 2000, 'Settings → Downloads opened');
});

test('task.checkOutputDir accepts only folders the companion accepts (companion/host/lib/paths.ts + MAX_OUTPUT_DIR)', async (t) => {
  const { AYT } = await boot();
  const taskTs = fs.readFileSync(path.join(ROOT, 'companion', 'host', 'lib', 'task.ts'), 'utf8');
  const max = Number((/MAX_OUTPUT_DIR\s*=\s*(\d+)/.exec(taskTs) || [])[1]);
  assert.equal(AYT.task.MAX_OUTPUT_DIR, max, 'same limit as the companion');
  const hostPaths = await importHostPaths();
  if (!hostPaths) return t.skip('this Node version cannot load companion/host/lib/paths.ts');
  let accepted = 0;
  for (const raw of FOLDER_CASES) {
    const mine = AYT.task.checkOutputDir(raw);
    if (!mine.ok || !mine.value) continue;
    accepted++;
    const theirs = hostPaths.normalizeAbsolutePath(mine.value, max);
    assert.ok(theirs, `the companion accepts ${JSON.stringify(mine.value)}`);
    assert.equal(theirs.toLowerCase(), mine.value.toLowerCase(), `same normalized folder for ${JSON.stringify(raw)}`);
  }
  assert.ok(accepted >= 6, 'the table has accepted folders');
  for (const refused of ['C:\\' + 'x'.repeat(178), 'D:\\YT.', 'D:\\My \\x', 'D:\\aux', 'D:\\a\u007fb', '\\\\.srv\\share']) {
    assert.equal(hostPaths.normalizeAbsolutePath(refused, max), null, `the companion refuses ${JSON.stringify(refused)}`);
    assert.equal(AYT.task.checkOutputDir(refused).ok, false, `so does the extension: ${JSON.stringify(refused)}`);
  }
});

test('host status: stored only when it changes (each chrome.storage write reaches every YouTube tab)', async () => {
  const { AYT, send, rec } = await boot();
  AYT.native.setTransport(new FakeHost().transport());
  for (let i = 0; i < 3; i++) assert.equal((await send({ type: 'host:status', refresh: true })).status.state, 'connected');
  assert.equal(rec.setKeys.filter((k) => k === 'state.hostStatus').length, 1);
  AYT.native.setTransport(new FakeHost({ missing: true }).transport());
  assert.equal((await send({ type: 'host:status', refresh: true })).status.state, 'missing');
  assert.equal(rec.setKeys.filter((k) => k === 'state.hostStatus').length, 2);
});

test('ports: snapshot on connect (jobs + known host status)', async () => {
  const { chrome, AYT, send } = await boot();
  await send({ type: 'host:status', refresh: true });
  const got = [];
  const port = { name: 'ayt-ui', sender: { id: EXT_ID, url: 'https://www.youtube.com/watch?v=x', tab: { id: 1 } }, onMessage: makeEvent(), onDisconnect: makeEvent(), postMessage: (m) => got.push(m), disconnect() {} };
  chrome.runtime.onConnect.emit(port);
  await sleep(5);
  assert.deepEqual(got.map((m) => m.type), ['jobs', 'host']);
  assert.equal(got[1].status.state, 'missing');
  port.onDisconnect.emit(port);
  assert.equal(AYT.bg.ports.has(port), false);
  const foreign = { name: 'ayt-ui', sender: { id: 'other' }, onMessage: makeEvent(), onDisconnect: makeEvent(), postMessage: () => assert.fail('no pushes to foreign ports'), disconnect() {} };
  chrome.runtime.onConnect.emit(foreign);
  await sleep(5);
});

test('host actions: pickFolder / updateTools / open errors are friendly', async () => {
  const host = new FakeHost();
  const { AYT, send } = await boot({ host });
  const p = await send({ type: 'host:pickFolder' }, ytSender);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), { ok: true, path: 'D:\\Videos' });
  const pickMsg = host.sent.find((m) => m.type === 'pickFolder');
  assert.equal(pickMsg.title, 'Choose a download folder');
  const u = await send({ type: 'host:updateTools' });
  assert.equal(u.ok, true);
  assert.equal(u.version, '2026.11.09');
  const foreign = await send({ type: 'host:pickFolder' }, { id: EXT_ID, url: 'https://evil.example/', tab: { id: 1 } });
  assert.equal(foreign.code, 'forbidden');
  // open: the path comes from the job, a host-side failure gets our localized text
  const job = AYT.jobs.start({ kind: 'audio', videoId: 'jNQXAC9IVRw' }, { title: 'Zoo' });
  await until(() => host.started().length === 1);
  host.emit({ event: 'done', jobId: job.id, files: [{ path: 'D:\\Out\\gone.mp3', size: 5 }], filePath: 'D:\\Out\\gone.mp3', fileSize: 5 });
  await until(() => AYT.jobs.get(job.id).status === 'done');
  const o = await send({ type: 'host:open', jobId: job.id, target: 'file', path: 'C:\\Windows\\System32\\calc.exe' });
  assert.deepEqual([o.ok, o.code], [false, 'not_found']);
  assert.equal(o.error, "Couldn't open the file. It may have been moved or deleted.");
  assert.equal(host.sent.find((m) => m.type === 'open').path, 'D:\\Out\\gone.mp3', 'never a path from the message');
  const badTarget = await send({ type: 'host:open', jobId: job.id, target: 'exe' });
  assert.equal(badTarget.code, 'bad_request');

  AYT.native.setTransport(new FakeHost({ missing: true }).transport());
  const m = await send({ type: 'host:pickFolder' });
  assert.deepEqual([m.ok, m.code], [false, 'host_missing']);
  assert.match(m.error, /isn't installed/);
});

/* ================================================================== downloads */

test('downloads: DOWNLOAD_DATA uses MIME-consistent data URLs and the subfolder', async () => {
  const { send, rec } = await boot({ settings: { subfolder: 'Akif YouTube' } });
  const r = await send({ type: 'download:data', text: '1\n00:00:00,000 --> 00:00:01,000\nŞəki\n', mime: 'text/plain', filename: 'Me: at the zoo? (en).srt', kind: 'subtitle' }, ytSender);
  assert.equal(r.ok, true);
  const d = rec.downloads.at(-1);
  assert.equal(d.filename, 'Akif YouTube/Me - at the zoo (en).srt');
  assert.match(d.url, /^data:application\/x-subrip;charset=utf-8;base64,/);
  assert.equal(Buffer.from(d.url.split(',')[1], 'base64').toString('utf8').includes('Şəki'), true);
  assert.equal(d.conflictAction, 'uniquify');
  assert.equal(d.saveAs, false);

  const r2 = await send({ type: 'download:data', dataUrl: 'data:text/plain;base64,QUJD', filename: 'x.vtt' }, ytSender);
  assert.equal(r2.ok, true);
  assert.equal(rec.downloads.at(-1).url, 'data:text/vtt;base64,QUJD');

  for (const filename of ['evil.exe', 'noext', 'x.lnk']) {
    const bad = await send({ type: 'download:data', text: 'x', filename }, ytSender);
    assert.deepEqual([bad.ok, bad.code], [false, 'bad_filename'], filename);
  }
  const none = await send({ type: 'download:data', filename: 'a.srt' }, ytSender);
  assert.equal(none.code, 'bad_request');
});

test('downloads: URL allow-list and helpers', async () => {
  const { AYT, send } = await boot();
  const D = AYT.downloads;
  assert.equal(D.checkUrl('https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg').kind, 'ytimg');
  assert.equal(D.checkUrl('blob:https://www.youtube.com/0b1c2d3e-1111-4222-8333-444455556666', ytSender).kind, 'blob');
  for (const u of ['http://i.ytimg.com/x.jpg', 'https://ytimg.com.evil.example/x.jpg', 'https://evil.example/i.ytimg.com', 'blob:https://evil.example/0b1c2d3e-1111-4222-8333-444455556666', 'file:///C:/x.png', 'data:image/png;base64,AA']) {
    assert.throws(() => D.checkUrl(u, ytSender), (e) => e.code === 'bad_url', u);
  }
  assert.throws(() => D.checkUrl('blob:https://www.youtube.com/0b1c2d3e-1111-4222-8333-444455556666', { id: EXT_ID, url: 'https://evil.example/', tab: { id: 2 } }), (e) => e.code === 'bad_url');
  assert.deepEqual(JSON.parse(JSON.stringify(D.splitName('a/b\\Title (1280x720).JPEG'))), { base: 'Title (1280x720)', ext: 'jpg' });
  assert.equal(D.retagDataUrl('data:image/jpeg;base64,AAAA', 'image/webp'), 'data:image/webp;base64,AAAA');
  const r = await send({ type: 'download:url', url: 'https://evil.example/x.png', filename: 'x.png' }, ytSender);
  assert.deepEqual([r.ok, r.code], [false, 'bad_url']);
  const p = await send({ type: 'thumb:probe', videoId: '<script>' });
  assert.equal(p.code, 'bad_request');
});

test('downloads: thumbnail selection drops placeholders, sorts and de-duplicates', async () => {
  const { AYT } = await boot();
  const cands = AYT.downloads.thumbCandidates('jNQXAC9IVRw');
  assert.equal(cands.length, 9);
  const size = { maxresdefault: [120, 90], hq720: [120, 90], sddefault: [120, 90], hqdefault: [480, 360], mqdefault: [320, 180], default: [120, 90] };
  const results = cands.map((c) => {
    const missing = ['maxresdefault', 'hq720', 'sddefault'].includes(c.key);
    if (c.format === 'webp' && missing) return Object.assign({}, c, { ok: false, status: 404 });
    if (missing && c.key === 'sddefault') return Object.assign({}, c, { ok: true, width: 120, height: 90, bytes: 1097 }); // 200 placeholder
    if (missing) return Object.assign({}, c, { ok: false, status: 404 });
    const [w, h] = size[c.key];
    return Object.assign({}, c, { ok: true, width: w, height: h, bytes: w * 10 });
  });
  const items = AYT.downloads.selectThumbs(results);
  assert.deepEqual(plain(items.map((i) => `${i.key}:${i.format}:${i.width}x${i.height}`)), ['hqdefault:jpg:480x360', 'mqdefault:jpg:320x180', 'default:jpg:120x90']);

  const full = cands.map((c) => {
    const dims = { maxresdefault: [1280, 720], hq720: [1280, 720], sddefault: [640, 480], hqdefault: [480, 360], mqdefault: [320, 180], default: [120, 90] }[c.key];
    return Object.assign({}, c, { ok: true, width: dims[0], height: dims[1], bytes: 1000 });
  });
  const items2 = AYT.downloads.selectThumbs(full);
  assert.deepEqual(plain(items2.map((i) => `${i.key}:${i.format}`)), ['maxresdefault:jpg', 'sddefault:jpg', 'hqdefault:jpg', 'mqdefault:jpg', 'default:jpg']);
});

/* ================================================================== menus + commands + install */

test('menus: created in the UI language, updated on change, clicks start jobs', async () => {
  const host = new FakeHost({ missing: true });
  const { AYT, rec } = await boot({ host });
  assert.equal(rec.menus.size, 4);
  assert.equal(rec.menus.get('ayt-link-video').title, 'Download video (best quality)');
  assert.deepEqual(plain(rec.menus.get('ayt-link-video').targetUrlPatterns), ['*://*.youtube.com/watch*', '*://youtu.be/*', '*://*.youtube.com/shorts/*']);
  assert.deepEqual(plain(rec.menus.get('ayt-page-audio').contexts), ['page', 'video']);
  AYT.i18n.register('tr', { 'background.menu.video': 'Videoyu indir (en iyi kalite)' });
  await AYT.settings.set('language', 'tr');
  await until(() => rec.menus.get('ayt-link-video').title === 'Videoyu indir (en iyi kalite)');
  assert.ok(rec.menuUpdates >= 4);
  await AYT.settings.set('language', 'en');

  const job = await AYT.menus.onClicked({ menuItemId: 'ayt-link-audio', linkUrl: 'https://youtu.be/jNQXAC9IVRw' }, { id: 3, url: 'https://www.reddit.com/' });
  assert.equal(job.kind, 'audio');
  assert.equal(job.task.audioFormat, 'mp3');
  assert.equal(job.title, 'YouTube video jNQXAC9IVRw');
  assert.equal(job.label, 'MP3 · 192 kbps');
  const job2 = await AYT.menus.onClicked({ menuItemId: 'ayt-page-video', pageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, { id: 4, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: '(3) Rick Astley - Never Gonna Give You Up - YouTube' });
  assert.equal(job2.title, 'Rick Astley - Never Gonna Give You Up');
  assert.equal(job2.task.height, null);
  assert.equal(job2.label, 'MP4 · Best quality');
  await until(() => rec.tabsCreated.some((t) => /options\.html#companion$/.test(t.url)), 2000, 'install guide opened');
  const none = await AYT.menus.onClicked({ menuItemId: 'ayt-link-video', linkUrl: 'https://www.youtube.com/feed/trending' }, null);
  assert.equal(none, null);
});

test('menus: kept across service-worker restarts; a start only re-titles them after a language change', async () => {
  // same language as recorded: not a single contextMenus call
  const same = await boot({ store: { 'state.contextMenus': { lang: 'en' } }, menus: PERSISTED_MENUS });
  assert.deepEqual(same.rec.menuOps, [], 'no removeAll + create on every worker start');
  assert.equal(same.rec.menus.size, 4);

  // the language changed while the worker was asleep: titles updated in place, nothing re-created
  const other = await boot({ store: { 'state.contextMenus': { lang: 'tr' } }, menus: PERSISTED_MENUS });
  assert.deepEqual(plain(other.rec.menuOps).sort(), ['update:ayt-link-audio', 'update:ayt-link-video', 'update:ayt-page-audio', 'update:ayt-page-video']);
  await until(() => other.store['state.contextMenus'] && other.store['state.contextMenus'].lang === 'en', 2000, 'language recorded');

  // nothing recorded and no items (first start, or Chrome lost them): built from scratch
  const fresh = await boot();
  assert.equal(fresh.rec.menus.size, 4);
  assert.equal(fresh.rec.menuOps.filter((op) => op === 'removeAll').length, 1);
  assert.equal(fresh.rec.menuOps.filter((op) => op.startsWith('create:')).length, 4);
  assert.deepEqual(plain(fresh.store['state.contextMenus']), { lang: 'en' });

  // recorded, but one item is gone: re-created
  const partial = await boot({ store: { 'state.contextMenus': { lang: 'tr' } }, menus: PERSISTED_MENUS.slice(1) });
  assert.equal(partial.rec.menus.size, 4);
  assert.ok(partial.rec.menuOps.includes('removeAll'));
});

test('menus: onInstalled (install / update) builds them from scratch once start-up is done', async () => {
  const { chrome, rec, store } = await boot({ store: { 'state.contextMenus': { lang: 'en' } }, menus: PERSISTED_MENUS });
  assert.deepEqual(rec.menuOps, []);
  chrome.runtime.onInstalled.emit({ reason: 'update' });
  await until(() => rec.menuOps.filter((op) => op.startsWith('create:')).length === 4, 2000, 'menus re-created');
  assert.equal(rec.menuOps[0], 'removeAll', 'no "duplicate id" errors: the restored items are removed first');
  assert.equal(rec.menus.size, 4);
  assert.equal(rec.menus.get('ayt-page-audio').title, 'Download audio (MP3)');
  assert.deepEqual(plain(store['state.contextMenus']), { lang: 'en' });
  await sleep(20);
  assert.equal(rec.tabsCreated.length, 0, 'an update does not open the options page');
  rec.menuOps.length = 0;
  chrome.runtime.onInstalled.emit({ reason: 'chrome_update' });
  await sleep(20);
  assert.deepEqual(rec.menuOps, [], 'a browser update keeps them');
});

test('jobs: one tab can have at most maxActivePerTab downloads queued or running', async () => {
  const host = new FakeHost();
  const { AYT, send } = await boot({ host, settings: { maxConcurrent: 1 } });
  AYT.jobs.config.maxActivePerTab = 3;
  const tab = (id) => Object.assign({}, ytSender, { tab: { id } });
  const start = (sender) => send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw' }, meta: { title: 'Zoo' } }, sender);
  const mine = [];
  for (let i = 0; i < 3; i++) {
    const r = await start(tab(11));
    assert.equal(r.ok, true, `job ${i + 1}`);
    mine.push(r.jobId);
  }
  const over = await start(tab(11));
  assert.deepEqual([over.ok, over.code], [false, 'too_many_jobs']);
  assert.equal(over.error, AYT.t('background.err.tooManyJobs', { max: 3 }));
  assert.match(over.error, /already has 3 downloads/);
  assert.equal(AYT.jobs.list().length, 3, 'nothing was queued');
  assert.equal((await start(tab(12))).ok, true, 'another tab has its own limit');
  assert.equal((await start(undefined)).ok, true, 'the popup (no tab) is not limited');
  assert.equal(AYT.jobs.activeCountForTab(11), 3);

  // a finished job frees a place; a retry counts like a new download
  await send({ type: 'job:cancel', jobId: mine[2] }, tab(11));
  await until(() => AYT.jobs.get(mine[2]).status === 'canceled');
  const again = await start(tab(11));
  assert.equal(again.ok, true, 'room again after a cancel');
  const retry = await send({ type: 'job:retry', jobId: mine[2] }, tab(11));
  assert.deepEqual([retry.ok, retry.code], [false, 'too_many_jobs']);
  assert.ok(AYT.jobs.get(mine[2]), 'a refused retry keeps the old job');
  assert.equal((await send({ type: 'job:retry', jobId: mine[2] })).ok, true, 'retry from the popup');
});

test('native: an updateTools that timed out here keeps the port open until its late answer', async () => {
  class SlowUpdateHost extends FakeHost {
    handle(port, msg) {
      if (msg.type !== 'updateTools') return super.handle(port, msg);
      this.answerUpdate = () => this.reply(port, { re: msg.id, ok: true, before: '2026.10.26', after: '2026.11.09', output: '' });
      return undefined;
    }
  }
  const host = new SlowUpdateHost();
  const { AYT, send } = await boot({ host });
  AYT.native.config.timeouts.updateTools = 60;
  AYT.native.config.idleDisconnectMs = 40;
  try {
    const u = await send({ type: 'host:updateTools' });
    assert.deepEqual([u.ok, u.code], [false, 'timeout']);
    assert.equal(u.error, AYT.t('job.err.timeout'));
    assert.equal(AYT.native.lateCount, 1);
    await sleep(200);
    assert.equal(host.disconnects, 0, 'the idle timer does not close the port while the companion is still updating');
    assert.equal(AYT.native.connected, true);
    const hellos = host.sent.filter((m) => m.type === 'hello').length;
    host.answerUpdate(); // the late answer
    await until(() => host.disconnects === 1, 2000, 'idle disconnect after the late answer');
    assert.equal(AYT.native.lateCount, 0);
    assert.equal(host.sent.filter((m) => m.type === 'hello').length, hellos + 1, 'the tool versions are checked again');

    // without a late answer the port is released after config.lateAnswerMs
    AYT.native.config.lateAnswerMs = 80;
    const u2 = await send({ type: 'host:updateTools' });
    assert.equal(u2.code, 'timeout');
    assert.equal(AYT.native.lateCount, 1);
    await until(() => host.disconnects === 2, 2000, 'released after lateAnswerMs');
    assert.equal(AYT.native.lateCount, 0);
  } finally {
    AYT.native.config.timeouts.updateTools = 10 * 60 * 1000;
  }
});

test('native: updateTools errors answered by the companion have their own texts', async () => {
  class FailingUpdateHost extends FakeHost {
    constructor(code, error) {
      super();
      this.update = { code, error };
    }
    handle(port, msg) {
      if (msg.type !== 'updateTools') return super.handle(port, msg);
      return this.reply(port, { re: msg.id, ok: false, code: this.update.code, error: this.update.error, output: 'pip output', before: '2026.10.26', after: '2026.10.26' });
    }
  }
  const { AYT, send } = await boot();
  const t = (k) => AYT.t(k);
  const cases = [
    ['update_timeout', 'the yt-dlp update did not finish within 9 minutes and was stopped', t('background.err.updateTimeout')],
    ['network', 'fetch failed: connection reset', t('background.err.updateNetwork')],
    ['busy', 'wait until the running downloads have finished', t('background.err.updateBusy')],
    ['unsupported', 'yt-dlp (exe) at C:\\x cannot be updated automatically', t('background.err.updateUnsupported')],
    ['ytdlp_missing', 'yt-dlp is not installed', t('job.err.ytdlp_missing')],
    ['update_failed', 'update failed', t('background.err.updateFailed')],
    ['update_failed', 'checksum mismatch (got 0123abcd)', t('background.err.updateFailed') + ' — checksum mismatch (got 0123abcd)'],
  ];
  for (const [code, error, text] of cases) {
    AYT.native.setTransport(new FailingUpdateHost(code, error).transport());
    const r = await send({ type: 'host:updateTools' });
    assert.deepEqual([r.ok, r.code, r.error], [false, code, text], code);
  }
  assert.notEqual(t('background.err.updateTimeout'), t('job.err.timeout'), "update_timeout: the companion did answer");
  for (const k of ['background.err.updateTimeout', 'background.err.updateNetwork', 'background.err.updateBusy', 'background.err.updateFailed']) assert.ok(AYT.i18n.has(k), k);

  // the folder picker: a localized text plus the companion's reason
  class FailingPickerHost extends FakeHost {
    handle(port, msg) {
      if (msg.type !== 'pickFolder') return super.handle(port, msg);
      return this.reply(port, { re: msg.id, ok: false, code: 'picker_failed', error: 'PowerShell scripts are blocked (execution policy AllSigned)' });
    }
  }
  AYT.native.setTransport(new FailingPickerHost().transport());
  const p = await send({ type: 'host:pickFolder' });
  assert.deepEqual([p.ok, p.code, p.error], [false, 'picker_failed', t('background.err.pickFailed') + ' — PowerShell scripts are blocked (execution policy AllSigned)']);
});

test('host status: a native-messaging policy block has its own text and job error code', async () => {
  const policy = 'Access to the native messaging host was disabled by the system administrator.';
  const { AYT, send, rec } = await boot();
  AYT.native.setTransport({
    sendOnce: async () => {
      throw new Error(policy);
    },
    connect: () => {
      throw new Error(policy);
    },
  });
  const r = await send({ type: 'host:status', refresh: true });
  assert.deepEqual(plain([r.status.state, r.status.reason, r.status.error]), ['forbidden', 'policy', AYT.t('background.host.policy')]);
  assert.equal(AYT.native.statusCode(r.status), 'host_policy');
  const j = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw' }, meta: { title: 'Zoo' } });
  await until(() => AYT.jobs.get(j.jobId).status === 'error', 2000, 'job failed');
  assert.equal(AYT.jobs.get(j.jobId).errorCode, 'host_policy');
  assert.equal(AYT.jobs.get(j.jobId).error, AYT.t('job.err.host_policy'));
  assert.ok(rec.notifications.some((n) => n.message === AYT.t('job.err.host_policy')));

  // the host's allowed_origins do not list this extension: the usual "registered for a different extension"
  AYT.native.setTransport({
    sendOnce: async () => {
      throw new Error('Access to the specified native messaging host is forbidden.');
    },
  });
  const f = await send({ type: 'host:status', refresh: true });
  assert.deepEqual(plain([f.status.state, 'reason' in f.status, f.status.error]), ['forbidden', false, AYT.t('background.host.forbidden')]);
  assert.equal(AYT.native.statusCode(f.status), 'host_forbidden');

  // a policy block reported when the port drops
  const host = new FakeHost();
  AYT.native.setTransport(host.transport());
  const k = await send({ type: 'job:start', task: { kind: 'video', videoId: 'dQw4w9WgXcQ' }, meta: { title: 'X' } });
  await until(() => AYT.jobs.get(k.jobId).status === 'running', 2000, 'running');
  host.drop(policy);
  await until(() => AYT.jobs.get(k.jobId).status === 'error', 2000, 'failed on disconnect');
  assert.equal(AYT.jobs.get(k.jobId).errorCode, 'host_policy');
  assert.equal(AYT.native.status.reason, 'policy');
});

test('jobs: the companion error codes no_subtitles, locked and access_denied have friendly texts', async () => {
  const host = new FakeHost();
  const { AYT, send } = await boot({ host });
  for (const code of ['no_subtitles', 'locked', 'access_denied']) {
    const r = await send({ type: 'job:start', task: { kind: 'subtitle', videoId: 'jNQXAC9IVRw', subLang: 'en' }, meta: { title: code } });
    await until(() => AYT.jobs.get(r.jobId).status === 'running', 2000, 'running');
    host.emit({ event: 'error', jobId: r.jobId, code, message: `ERROR: [${code}] the companion's own reason` });
    await until(() => AYT.jobs.get(r.jobId).status === 'error', 2000, code);
    const job = AYT.jobs.get(r.jobId);
    assert.equal(job.errorCode, code);
    assert.ok(AYT.i18n.has('job.err.' + code), code);
    assert.ok(job.error.startsWith(AYT.t('job.err.' + code)), job.error);
    assert.notEqual(AYT.t('job.err.' + code), AYT.t('job.err.unknown'));
  }
});

test('jobs: error texts (shown on YouTube) keep only the last name of a path in the companion reason (spec §0.6)', async () => {
  // what companion/host/host.ts answers when it cannot create the output folder (Deno's error text appended)
  const folderError = "cannot create the output folder C:\\Users\\someone\\Downloads\\Akif YouTube: Access is denied. (os error 5): mkdir 'C:\\Users\\someone\\Downloads\\Akif YouTube'";
  class RefusingHost extends FakeHost {
    handle(port, msg) {
      if (msg.type === 'start' && msg.task.kind === 'video') return this.reply(port, { re: msg.id, ok: false, code: 'bad_task', error: folderError });
      return super.handle(port, msg);
    }
  }
  const host = new RefusingHost();
  const { AYT, chrome, send, pushes } = await boot({ host });
  const a = await send({ type: 'job:start', task: { kind: 'video', videoId: 'dQw4w9WgXcQ' }, meta: { title: 'A' } }, ytSender);
  await until(() => AYT.jobs.get(a.jobId).status === 'error', 2000, 'start refused');
  const b = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw' }, meta: { title: 'B' } }, ytSender);
  await until(() => AYT.jobs.get(b.jobId).status === 'running', 2000, 'running');
  // yt-dlp prints Python's repr of the path: doubled backslashes
  const writeError = "ERROR: unable to open for writing: [Errno 13] Permission denied: 'C:\\\\Users\\\\someone\\\\Videos\\\\.akif-tmp\\\\b\\\\Me at the zoo [jNQXAC9IVRw].webm.part'";
  host.emit({ event: 'error', jobId: b.jobId, code: 'access_denied', message: writeError, detail: '' });
  await until(() => AYT.jobs.get(b.jobId).status === 'error', 2000, 'failed');

  const pushed = (id) => pushes.filter((p) => p.type === 'job' && p.job.id === id).at(-1).job;
  assert.equal(pushed(a.jobId).error, AYT.t('job.err.bad_task') + " — cannot create the output folder Akif YouTube: Access is denied. (os error 5): mkdir 'Akif YouTube'");
  assert.equal(pushed(b.jobId).error, AYT.t('job.err.access_denied') + " — unable to open for writing: [Errno 13] Permission denied: 'Me at the zoo [jNQXAC9IVRw].webm.part'");
  for (const p of pushes.filter((x) => x.type === 'job')) assert.ok(!JSON.stringify(p).includes('someone'), 'no push names the user folder');
  const listed = await send({ type: 'jobs:list' }, ytSender);
  assert.ok(!JSON.stringify(listed).includes('someone'), 'JOBS_LIST');
  const got = [];
  chrome.runtime.onConnect.emit({ name: 'ayt-ui', sender: ytSender, onMessage: makeEvent(), onDisconnect: makeEvent(), postMessage: (m) => got.push(JSON.parse(JSON.stringify(m))), disconnect() {} });
  await sleep(5);
  assert.ok(got.length && !JSON.stringify(got).includes('someone'), 'port snapshot');
  assert.equal(AYT.jobs.get(a.jobId).errorDetail, folderError, 'the raw text stays in the service worker');
  assert.equal(AYT.jobs.get(b.jobId).errorDetail, writeError);

  // more shapes: spawn failures, a rename "a -> b", UNC and forward-slash paths, the user folder itself
  const cases = [
    ['access_denied', "Windows blocked yt-dlp from starting (antivirus or an app control policy): Failed to spawn 'C:\\Users\\someone\\AppData\\Local\\AkifYouTubeAddon\\bin\\yt-dlp.exe': Access is denied. (os error 5)", "Windows blocked yt-dlp from starting (antivirus or an app control policy): Failed to spawn 'yt-dlp.exe': Access is denied. (os error 5)"],
    ['locked', "ERROR: Unable to rename file: [WinError 32] The process cannot access the file because it is being used by another process: 'C:\\\\Users\\\\someone\\\\Videos\\\\a.f137.mp4.part' -> 'C:\\\\Users\\\\someone\\\\Videos\\\\a.f137.mp4'", "Unable to rename file: [WinError 32] The process cannot access the file because it is being used by another process: 'a.f137.mp4.part' -> 'a.f137.mp4'"],
    ['access_denied', 'ERROR: [Errno 13] Permission denied: "C:\\\\Users\\\\O\'Brien\\\\Videos\\\\Don\'t Stop Me Now.mp4.part"', '[Errno 13] Permission denied: "Don\'t Stop Me Now.mp4.part"'],
    ['bad_task', 'cannot create the output folder \\\\nas\\users$\\someone\\YouTube: The network path was not found. (os error 53)', 'cannot create the output folder YouTube: The network path was not found. (os error 53)'],
    ['disk', 'C:/Users/someone/Videos/x.mp4: No space left on device', 'x.mp4: No space left on device'],
    ['access_denied', "Windows denied access (Controlled Folder Access, antivirus or folder permissions): Access is denied. (os error 5): mkdir 'C:\\Users\\someone'", "Windows denied access (Controlled Folder Access, antivirus or folder permissions): Access is denied. (os error 5): mkdir '…'"],
    // a share holding home folders: \\server\share\<name> could be the user's own folder, so it is hidden as well
    ['bad_task', "cannot create the output folder \\\\nas\\home\\someone: The network path was not found. (os error 53)", 'cannot create the output folder …: The network path was not found. (os error 53)'],
    ['unavailable', 'ERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video has been removed by the uploader', 'Video unavailable. This video has been removed by the uploader'],
    ['forbidden', 'ERROR: unable to download video data: HTTP Error 403: Forbidden (https://rr3---sn-4g5e6nzz.googlevideo.com/videoplayback?expire=1)', 'unable to download video data: HTTP Error 403: Forbidden (https://rr3---sn-4g5e6nzz.googlevideo.com/videoplayback?expire=1)'],
  ];
  for (const [code, detail, reason] of cases) assert.equal(AYT.jobs.describeError(code, detail), AYT.t('job.err.' + code) + ' — ' + reason, detail);
  // paths are hidden before the reason is cut to 240 characters: the file name is still there
  const long = AYT.jobs.describeError('access_denied', 'x'.repeat(150) + " 'C:\\Users\\someone\\" + 'y'.repeat(120) + "\\clip.mp4'");
  assert.ok(long.endsWith(" 'clip.mp4'") && !long.includes('someone'), long);
});

test('jobs: failed jobs in the stored history are described again at start-up (no path from an older version)', async () => {
  const task = (videoId) => ({ kind: 'audio', videoId, url: 'https://www.youtube.com/watch?v=' + videoId, playlist: false });
  const detail = "ERROR: [Errno 13] Permission denied: 'C:\\\\Users\\\\someone\\\\Videos\\\\x.part'";
  const stored = [
    { id: 'cccccccc-3333', kind: 'audio', status: 'error', title: 'Old failure', errorCode: 'access_denied', errorDetail: detail, error: 'Access denied — ' + detail, task: task('jNQXAC9IVRw'), meta: {}, files: [], createdAt: 3, updatedAt: 3 },
    { id: 'dddddddd-4444', kind: 'audio', status: 'done', title: 'Done', task: task('dQw4w9WgXcQ'), meta: {}, files: [{ path: 'D:\\Out\\a.mp3', size: 1 }], filePath: 'D:\\Out\\a.mp3', createdAt: 2, updatedAt: 2 },
  ];
  const { AYT, store, pushes } = await boot({ store: { jobs: stored } });
  const job = AYT.jobs.get('cccccccc-3333');
  assert.equal(job.error, AYT.t('job.err.access_denied') + " — [Errno 13] Permission denied: 'x.part'");
  assert.equal(job.errorDetail, detail, 'the raw text is kept');
  assert.ok(!store.jobs.find((j) => j.id === 'cccccccc-3333').error.includes('someone'), 'stored again right away');
  const snapshot = pushes.find((p) => p.type === 'jobs');
  assert.ok(snapshot && snapshot.jobs.length === 2 && !JSON.stringify(snapshot).includes('someone'), 'port snapshot');

  // a history whose texts are up to date is not written again
  const current = [Object.assign({}, stored[0], { error: job.error }), stored[1]];
  const again = await boot({ store: { jobs: current } });
  assert.equal(again.AYT.jobs.get('cccccccc-3333').error, job.error);
  await sleep(40);
  assert.ok(!again.rec.setKeys.includes('jobs'), 'no write at start-up');
});

test('jobs: notifications show the label AYT.util.jobLabel builds in the current language (when it exists)', async () => {
  const host = new FakeHost();
  const { AYT, send, rec } = await boot({ host });
  const finishJob = async (title) => {
    const r = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw', audioFormat: 'mp3', bitrate: 128 }, meta: { title, label: 'MP3 · 128 kbps (old)' } });
    await until(() => AYT.jobs.get(r.jobId).status === 'running', 2000, 'running');
    host.emit({ event: 'done', jobId: r.jobId, files: [{ path: 'D:\\Out\\x.mp3', size: 5 }], filePath: 'D:\\Out\\x.mp3', fileSize: 5 });
    return until(() => rec.notifications.find((n) => n.id === 'ayt-job:' + r.jobId), 2000, 'notification');
  };
  const own = AYT.util.jobLabel;
  try {
    if (typeof own === 'function') {
      // the shared helper rebuilds the label from the task
      assert.match((await finishJob('Real')).contextMessage, /^MP3 · 128 kbps · /);
    }
    AYT.util.jobLabel = (job) => `${job.task.audioFormat.toUpperCase()} · ${job.task.bitrate} kbps (now)`;
    assert.match((await finishJob('A')).contextMessage, /^MP3 · 128 kbps \(now\)/);
    AYT.util.jobLabel = () => {
      throw new Error('broken');
    };
    assert.match((await finishJob('B')).contextMessage, /^MP3 · 128 kbps \(old\)/, 'falls back to the stored label');
    delete AYT.util.jobLabel;
    assert.match((await finishJob('C')).contextMessage, /^MP3 · 128 kbps \(old\)/, 'older shared code without jobLabel');
  } finally {
    if (own) AYT.util.jobLabel = own;
    else delete AYT.util.jobLabel;
  }
});

test('commands: forwarded only to YouTube tabs', async () => {
  const { AYT, chrome, rec } = await boot();
  assert.equal(await AYT.commands.forward('toggle-loop', { id: 5, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(rec.sentToTabs.at(-1))), { tabId: 5, msg: { __aytPush: true, type: 'command', command: 'toggle-loop' }, opts: { frameId: 0 } });
  assert.equal(await AYT.commands.forward('toggle-loop', { id: 6, url: 'https://example.com/' }), false);
  assert.equal(await AYT.commands.forward('rm-rf', { id: 5, url: 'https://www.youtube.com/' }), false);
  chrome.tabs.query = async () => [{ id: 8, url: 'https://www.youtube.com/shorts/abcdefghijk' }];
  assert.equal(await AYT.commands.forward('take-screenshot', undefined), true);
  chrome.tabs.sendMessage = async () => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  };
  assert.equal(await AYT.commands.forward('speed-up', { id: 9, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }), false);
  assert.ok(rec.notifications.some((n) => n.id === 'ayt-reload-hint'));
});

test('onInstalled(install) opens the options page at #companion', async () => {
  const { chrome, rec } = await boot();
  chrome.runtime.onInstalled.emit({ reason: 'update' });
  await sleep(5);
  assert.equal(rec.tabsCreated.length, 0);
  chrome.runtime.onInstalled.emit({ reason: 'install' });
  await until(() => rec.tabsCreated.length === 1);
  assert.equal(rec.tabsCreated[0].url, `chrome-extension://${EXT_ID}/options/options.html#companion`);
});
