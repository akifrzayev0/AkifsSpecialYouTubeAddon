#!/usr/bin/env node
/*
 * Integration e2e: the REAL extension (extension/) together with the REAL installed companion app
 * (%LOCALAPPDATA%\AkifYouTubeAddon, native host com.akif.youtube_addon) on real YouTube pages, in the
 * installed Chrome (headless, stealth) through tools/e2e/harness.mjs. Nothing is stubbed or mocked.
 * The UI is driven with real mouse/keyboard input (CDP Input events) wherever practical; the isolated
 * world (AYT.*) and the service worker are only read to verify state.
 *
 *   node tools/e2e/integration.e2e.mjs [--out <dir>] [--only 1,2,5] [--skip 8,10] [--headful]
 *                                      [--keep-media] [--keep-profile] [--short <shortsVideoId>] [--list]
 *
 * <out> (default: %AYT_INTEGRATION_OUT% or %TEMP%\ayt-integration-e2e):
 *   profile\       Chrome profile, recreated every run (unless --keep-profile). Its Preferences set
 *                  download.default_directory = browser-dl\ BEFORE launch (CDP Browser.setDownloadBehavior
 *                  would make Chrome ignore the file names chrome.downloads asks for).
 *   browser-dl\    browser-side downloads (subtitles, thumbnails, screenshots) -> browser-dl\Akif YouTube\
 *   companion-dl\  companion downloads: the extension setting outputDir (written from the service worker)
 *   shots\         screenshots of every journey (kept)
 *   report.json    every check with its evidence, console errors of the YouTube tab / popup / options / SW
 *
 * Journeys (independent: each starts in a fresh tab and prints PASS/FAIL with evidence):
 *    1 toolbar order + companion connected     2 video row download (+ row progress, popup list)
 *    3 MP3 192 kbps 00:00:03-00:00:09          4 GIF 00:00:05-00:00:08
 *    5 subtitles SRT / TXT / en->tr            6 thumbnail "Maximum" as PNG
 *    7 screenshot button                       8 cancel a 1080p download + process / temp cleanup
 *    9 hide comments (+ pill)                 10 Shorts button -> popover -> MP3
 *   11 options: companion connected           12 error path (made-up video id)
 *   13 SPA navigation with the video panel open
 * Extra cross-module journeys (paths no single module could test with the real companion):
 *   14 subtitles companion fallback (in-browser fetch made to fail -> kind:'subtitle' job -> TXT + SRT), and the
 *      companion files must read exactly like the in-browser conversion of the same track
 *   15 action popup on a YouTube tab: quick "MP3 · 192 kbps" button -> job done, live list
 *   16 dubbed audio: the Turkish track picked in the video panel -> clip whose audio stream is Turkish
 * Popups are opened as the real action popup (chrome.action.openPopup from the service worker).
 * --j8-stage processing cancels journey 8 during the ffmpeg post-processing instead of the download.
 * Downloaded media are deleted at the end (unless --keep-media). Exit code 1 when a journey fails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchWithExtension, fixPageUserAgent } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, 'extension');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const idList = (s) => (s ? String(s).split(',').map((x) => Number(x.trim())).filter((n) => n > 0) : null);

const OUT = path.resolve(opt('--out', process.env.AYT_INTEGRATION_OUT || path.join(os.tmpdir(), 'ayt-integration-e2e')));
const PROFILE = path.join(OUT, 'profile');
const BROWSER_DL = path.join(OUT, 'browser-dl');
const COMPANION_DL = path.join(OUT, 'companion-dl');
const SHOTS = path.join(OUT, 'shots');
const ONLY = idList(opt('--only', ''));
const SKIP = idList(opt('--skip', '')) || [];
const EXT_ID = 'oicpmbpfimnoolnhfgdocfjelknjlcif'; // fixed by the manifest key
const SUBFOLDER = 'Akif YouTube'; // AYT.DEFAULT_SETTINGS.subfolder (browser-side downloads)
const V_ZOO = 'jNQXAC9IVRw'; // "Me at the zoo": 19 s, 240p max
const V_DUB = 'KrLj6nc516A'; // 26 audio tracks, 22 caption tracks, 1080p and more
const FAKE_ID = 'xxxxxxxxxxx'; // does not exist (yt-dlp: "Video unavailable")
const SHORT_ID = opt('--short', 'gZ6cIWpN4wA');
const EXPECTED_BUTTONS = ['video', 'audio', 'thumbnail', 'subtitles', 'screenshot', 'loop', 'speed', 'boost', 'adjust', 'pip', 'cinema', 'comments', 'settings'];
const PORTAL = '#ayt-portal-host';
const TOOLBAR = '#ayt-toolbar-host';
const TERMINAL = ['done', 'error', 'canceled'];
const WATCHED_EXE = /^(yt-dlp|python[0-9.]*|pythonw|ffmpeg|ffprobe)\.exe$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || '', 'AkifYouTubeAddon');
const CONFIG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
})();
const FFPROBE = (CONFIG && CONFIG.tools && CONFIG.tools.ffmpeg && CONFIG.tools.ffmpeg.ffprobe) || 'ffprobe';

/* ================================================================== report + logging */
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(7)}s]`, ...a);
const report = { startedAt: new Date().toISOString(), out: OUT, chrome: null, extensionId: null, companion: null, setup: {}, journeys: [], console: [], foreignConsoleCount: 0, notes: [] };
let current = null; // record of the running journey

function note(s) {
  report.notes.push(current ? `J${current.id}: ${s}` : s);
  log('  NOTE ' + s);
}

function check(name, ok, detail) {
  const entry = { name, ok: !!ok, detail: detail === undefined ? null : detail };
  if (current) current.checks.push(entry);
  else report.setup[name] = entry;
  let d = detail === undefined ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  if (d.length > 700) d = d.slice(0, 700) + '…';
  log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${d}`);
  return !!ok;
}

function evidence(key, value) {
  if (current) current.evidence[key] = value;
}

/* ================================================================== console capture */
function recordConsole(source, type, text, url) {
  const s = String(text || '');
  const ours = source !== 'youtube' || /\[AYT\]/.test(s) || String(url || '').includes(EXT_ID) || s.includes('chrome-extension://' + EXT_ID);
  if (!ours) {
    report.foreignConsoleCount++;
    // keep a de-duplicated sample of YouTube's own messages: some could still be side effects of our DOM changes
    const key = `${type}: ${s.split('\n')[0].replace(/\d{3,}/g, '#').slice(0, 220)}`;
    report.foreignConsole = report.foreignConsole || {};
    report.foreignConsole[key] = (report.foreignConsole[key] || 0) + 1;
    return;
  }
  const entry = { journey: current ? current.id : null, source, type, text: s.slice(0, 1200), url: url || null, at: Math.round((Date.now() - T0) / 100) / 10 };
  report.console.push(entry);
  log(`  ! console[${source}] ${type}: ${entry.text.split('\n')[0].slice(0, 300)}`);
}

function watchPage(p, source) {
  p.on('console', (m) => {
    const type = m.type();
    if (!['error', 'warn', 'warning', 'assert'].includes(type)) return;
    const loc = (m.location && m.location()) || {};
    recordConsole(source, type, m.text(), loc.url);
  });
  p.on('pageerror', (err) => recordConsole(source, 'pageerror', String((err && (err.stack || err.message)) || err), null));
}

const watchedPages = new WeakSet();
function watchOnce(p, source) {
  if (!p || watchedPages.has(p)) return;
  watchedPages.add(p);
  watchPage(p, source);
}

/** One puppeteer Page per popup target (target.page() is null for the action popup; asPage() makes a new session each call). */
const targetPages = new WeakMap();
function pageForTarget(t) {
  if (!targetPages.has(t)) targetPages.set(t, t.asPage().then((p) => (watchOnce(p, 'popup'), p)));
  return targetPages.get(t);
}

const hookedWorkers = new WeakSet();
function hookWorker(w) {
  if (!w || hookedWorkers.has(w)) return;
  hookedWorkers.add(w);
  w.on('console', (m) => {
    const type = m.type();
    if (['error', 'warn', 'warning', 'assert'].includes(type)) recordConsole('sw', type, m.text(), null);
  });
  try {
    w.client.on('Runtime.exceptionThrown', (e) => {
      const d = (e && e.exceptionDetails) || {};
      recordConsole('sw', 'exception', (d.exception && d.exception.description) || d.text || 'exception', d.url || null);
    });
  } catch (_) {
    /* no CDP client on this puppeteer version */
  }
}

/** Errors (not warnings) from our code recorded during the current journey. */
function journeyErrors(sinceIndex = 0) {
  return report.console.slice(sinceIndex).filter((c) => current && c.journey === current.id && !/^warn/.test(c.type));
}

/* ================================================================== generic helpers */
let H = null; // harness handle
let page = null; // the tab under test

function isFlake(e) {
  return /protocol|target closed|session closed|timed out|execution context was destroyed|isolated world not found|cannot find context|detached|session with given id/i.test(String((e && e.message) || e));
}

async function retry(label, fn, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= tries || !isFlake(e)) throw e;
      log(`  ~ ${label}: ${String(e.message || e).split('\n')[0]} (retrying)`);
      await sleep(1200);
    }
  }
}

async function waitFor(label, fn, timeoutMs, everyMs = 400) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`timeout (${Math.round(timeoutMs / 1000)} s) waiting for ${label}${last instanceof Error ? ': ' + last.message.split('\n')[0] : ''}`);
}

/** Isolated-world evaluation, capped at 45 s (a renderer that is stuck must not cost 120 s per call). */
function isoOnce(fn, args) {
  let timer = 0;
  return Promise.race([
    H.evaluateInIsolatedWorld(page, fn, ...args),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('isolated eval timed out after 45 s (renderer busy?)')), 45000);
    }),
  ]).finally(() => clearTimeout(timer));
}
const iso = (fn, ...args) => retry('isolated eval', () => isoOnce(fn, args));

/* ---------------------------------------------------------------- service worker */
let swCache = null;
async function sw() {
  if (swCache) {
    const alive = await Promise.race([swCache.evaluate(() => 1).then(() => true, () => false), sleep(3000).then(() => false)]);
    if (alive) return swCache;
    swCache = null;
  }
  swCache = await H.getServiceWorker({ timeout: 30000 });
  hookWorker(swCache);
  if (page) await page.bringToFront().catch(() => {}); // waking the worker may have opened (and closed) a tab
  return swCache;
}

async function swEval(fn, ...args) {
  for (let i = 0; ; i++) {
    try {
      return await (await sw()).evaluate(fn, ...args);
    } catch (e) {
      if (i >= 1 || !isFlake(e)) throw e;
      swCache = null;
      await sleep(1000);
    }
  }
}

function listJobs() {
  return swEval(() =>
    AYT.jobs.list().map((j) => ({
      id: j.id,
      kind: j.kind,
      videoId: j.videoId,
      title: j.title,
      label: j.label,
      status: j.status,
      stage: j.stage,
      percent: j.percent,
      downloaded: j.downloaded,
      total: j.total,
      filePath: j.filePath,
      fileSize: j.fileSize,
      files: j.files,
      error: j.error,
      errorCode: j.errorCode,
      errorDetail: j.errorDetail ? String(j.errorDetail).slice(0, 600) : null,
      task: j.task,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
    }))
  );
}

async function getJob(id) {
  return (await listJobs()).find((j) => j.id === id) || null;
}

async function jobIds() {
  return new Set((await listJobs()).map((j) => j.id));
}

async function waitNewJob(before, pred, timeoutMs = 30000) {
  return waitFor('a new job in the service worker', async () => (await listJobs()).find((j) => !before.has(j.id) && pred(j)) || null, timeoutMs, 300);
}

async function waitJobEnd(id, timeoutMs, onTick) {
  const end = Date.now() + timeoutMs;
  let last = null;
  let lastLog = 0;
  while (Date.now() < end) {
    last = (await getJob(id).catch(() => null)) || last;
    if (onTick) await onTick(last);
    if (last && TERMINAL.includes(last.status)) return last;
    if (last && Date.now() - lastLog > 10000) {
      lastLog = Date.now();
      log(`  job ${last.kind} ${last.status} ${last.stage || ''} ${last.percent != null ? last.percent + '%' : ''}`);
    }
    await sleep(400);
  }
  throw new Error(`job ${id} did not finish within ${Math.round(timeoutMs / 1000)} s (last: ${last && last.status} ${last && last.stage} ${last && last.percent}%)`);
}

const slimJob = (j) =>
  j && { id: j.id, kind: j.kind, status: j.status, label: j.label, title: j.title, percent: j.percent, filePath: j.filePath, fileSize: j.fileSize, error: j.error, errorCode: j.errorCode };

/** Last lines of the installed companion's log (attached to failures). */
function hostLogTail(lines = 25) {
  try {
    const text = fs.readFileSync(path.join(INSTALL_DIR, 'logs', 'host.log'), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch (e) {
    return ['(no host log: ' + e.message + ')'];
  }
}

/* ---------------------------------------------------------------- pages */
/** Opens a new tab (closing every other tab), so each journey starts clean and in front. */
async function freshPage(source = 'youtube') {
  const p = await H.browser.newPage();
  await fixPageUserAgent(p).catch(() => {});
  watchPage(p, source);
  p.on('error', (e) => note(`tab crashed: ${(e && e.message) || e}`));
  page = p;
  for (const other of await H.browser.pages()) if (other !== p) await other.close().catch(() => {});
  await p.bringToFront().catch(() => {});
  return p;
}

async function handleConsent() {
  if (!/consent\.(youtube|google)\.com/.test(page.url())) return;
  note('consent page shown: ' + page.url());
  const clicked = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, input[type=submit]')).find((x) => /reject all|accept all/i.test(x.textContent || x.value || ''));
    if (b) b.click();
    return !!b;
  });
  if (clicked) await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
}

async function waitBooted() {
  await waitFor('content scripts booted', () => iso(() => !!(globalThis.AYT && AYT.booted && AYT.toolbar && AYT.dl && AYT.captions && AYT.screenshot)), 60000, 500);
}

async function openWatch(videoId, { play = false } = {}) {
  await freshPage('youtube');
  await retry('goto ' + videoId, () => page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded', timeout: 90000 }));
  await handleConsent();
  await waitBooted();
  await waitFor('toolbar mounted', () => iso((id) => AYT.toolbar.mounted && AYT.page.videoId === id, videoId), 60000, 500);
  if (play) return ensurePlaying(videoId);
  await quietPlayer(false);
  return null;
}

async function playerState() {
  return page.evaluate(() => {
    const p = document.getElementById('movie_player');
    const v = p && p.querySelector('video');
    let vid = null;
    try {
      vid = p && p.getVideoData ? p.getVideoData().video_id : null;
    } catch (_) {
      /* ignore */
    }
    return {
      has: !!p,
      ad: !!(p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'))),
      vid,
      ready: v ? v.readyState : -1,
      w: v ? v.videoWidth : 0,
      h: v ? v.videoHeight : 0,
      paused: v ? v.paused : null,
      t: v ? Math.round(v.currentTime * 10) / 10 : 0,
    };
  });
}

async function quietPlayer(play) {
  await page
    .evaluate((doPlay) => {
      const p = document.getElementById('movie_player');
      try {
        if (p && p.mute) p.mute();
      } catch (_) {
        /* ignore */
      }
      const v = p && p.querySelector('video');
      if (v) {
        v.muted = true;
        if (doPlay) v.play().catch(() => {});
        else v.pause();
      }
    }, !!play)
    .catch(() => {});
}

/** Waits until the content video plays (ads are skipped with trusted clicks or fast-forwarded). */
async function ensurePlaying(videoId, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  let sawAd = false;
  let lastLog = 0;
  while (Date.now() < end) {
    const s = await retry('player state', () => playerState()).catch((e) => ({ error: e.message }));
    if (Date.now() - lastLog > 10000) {
      lastLog = Date.now();
      log('  player: ' + JSON.stringify(s));
    }
    if (s.ad) {
      sawAd = true;
      await quietPlayer(true);
      const skip = await page
        .evaluate(() => {
          const b = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button, button[id^="skip-button"]');
          const r = b && b.offsetParent !== null ? b.getBoundingClientRect() : null;
          if (r && r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          const v = document.querySelector('#movie_player video');
          if (v && isFinite(v.duration) && v.duration > 1 && v.currentTime < v.duration - 0.5) v.currentTime = v.duration - 0.25; // test harness only
          return null;
        })
        .catch(() => null);
      if (skip) await page.mouse.click(skip.x, skip.y).catch(() => {});
      await sleep(1000);
      continue;
    }
    if (s.has && s.vid === videoId && s.ready >= 2 && s.w > 0 && s.paused === false) return { sawAd, state: s };
    await quietPlayer(true);
    await sleep(700);
  }
  throw new Error(`the video ${videoId} did not start playing within ${timeoutMs / 1000} s`);
}

/* ---------------------------------------------------------------- real input inside shadow roots */
/**
 * Trusted mouse click in the middle of `innerSel` inside the open shadow root of `hostSel` (or on the host
 * itself when innerSel is null). Scrolls it into view and hit-tests first: a covered element is an error.
 */
async function clickDeep(hostSel, innerSel, { block = 'center', modifiers = [], waitMs = 8000 } = {}) {
  // YouTube keeps laying out the page for a while after our elements exist: wait until the target is hit-testable.
  const end = Date.now() + waitMs;
  let r = null;
  for (;;) {
    r = await probeDeep(hostSel, innerSel, block);
    if (r && !r.missing && r.hit && r.w > 0 && r.h > 0) break;
    if (Date.now() > end) break;
    await sleep(300);
  }
  if (!r || r.missing) throw new Error(`not found: ${hostSel} >>> ${innerSel}`);
  if (!r.hit || !(r.w > 0 && r.h > 0)) throw new Error(`not clickable (covered or invisible): ${hostSel} >>> ${innerSel} (topmost: ${r.top}, rect ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}, viewport ${r.vw}x${r.vh})`);
  await sleep(120); // let a smooth scroll settle
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(r.x, r.y, { delay: 40 });
  for (const m of modifiers) await page.keyboard.up(m);
  return r;
}

/** Scrolls the element into view and hit-tests its centre (see clickDeep). */
function probeDeep(hostSel, innerSel, block) {
  return iso(
    (hs, is, blk) => {
      const host = document.querySelector(hs);
      const root = host && host.shadowRoot;
      const el = is ? root && root.querySelector(is) : host;
      if (!el) return { missing: true };
      el.scrollIntoView({ block: blk, inline: 'nearest' });
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2;
      const y = b.top + b.height / 2;
      const top = document.elementFromPoint(x, y);
      let hit = false;
      if (top === host && root) {
        const inner = root.elementFromPoint(x, y);
        hit = !!(inner && (inner === el || el.contains(inner)));
      } else hit = !!(top && (top === el || el.contains(top)));
      return { x, y, w: b.width, h: b.height, hit, top: top ? top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') : null, disabled: !!el.disabled, vw: innerWidth, vh: innerHeight };
    },
    hostSel,
    innerSel,
    block
  );
}

/** Picks an <option> of a <select> inside a shadow root (fires input + change like a user choice). */
async function selectDeep(hostSel, innerSel, value, index = 0) {
  // ElementHandle.select() fires script-made input/change events; our shadow roots drop those unless the
  // isolated world opted in (see AYT.keys.guard).
  await iso(() => {
    AYT.testMode = true;
    return true;
  });
  const handles = await page.$$(`${hostSel} >>> ${innerSel}`);
  const h = handles[index];
  if (!h) throw new Error(`select not found: ${hostSel} >>> ${innerSel} [${index}]`);
  const res = await h.select(String(value));
  for (const x of handles) await x.dispose().catch(() => {});
  if (!res.includes(String(value))) throw new Error(`option ${value} not selectable in ${innerSel}`);
  await sleep(200);
}

/** Clicks a text input, replaces its text by typing (Ctrl+A, type) and commits with Enter. */
async function typeDeep(hostSel, innerSel, text) {
  await clickDeep(hostSel, innerSel);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.type(text, { delay: 25 });
  await page.keyboard.press('Enter');
  await sleep(300);
}

async function openPanelByClick(id) {
  await clickDeep(TOOLBAR, `.ayt-tb-btn[data-id="${id}"]`);
  await waitFor(`panel '${id}' open`, () => iso((pid) => AYT.toolbar.isOpen(pid), id), 10000, 200);
}

/** Viewport rect of an element: inside the shadow root of hostSel, or the host itself. */
async function deepRect(hostSel, innerSel) {
  return iso(
    (hs, is) => {
      const host = document.querySelector(hs);
      const el = host && (is ? host.shadowRoot && host.shadowRoot.querySelector(is) : host);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
    hostSel,
    innerSel || null
  );
}

/** Screenshot of the viewport or of a viewport rect (clip in page coordinates, no re-layout). */
async function shot(name, rect, pad = 8) {
  const file = path.join(SHOTS, name);
  try {
    let clip;
    if (rect) {
      const sc = await page.evaluate(() => ({ sx: window.scrollX, sy: window.scrollY }));
      clip = { x: Math.max(0, rect.x + sc.sx - pad), y: Math.max(0, rect.y + sc.sy - pad), width: Math.max(1, rect.width + pad * 2), height: Math.max(1, rect.height + pad * 2) };
    }
    await retry('screenshot ' + name, () => page.screenshot({ path: file, clip, captureBeyondViewport: false }));
    if (current) current.shots.push(file);
    log('  shot ' + file);
  } catch (e) {
    note(`screenshot ${name} failed: ${e.message}`);
  }
  return file;
}

/** Scrolls the open toolbar panel into view and saves a screenshot of it. */
async function shotPanel(name) {
  await iso(() => {
    const p = document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-panel');
    if (p) p.scrollIntoView({ block: p.getBoundingClientRect().height > window.innerHeight - 80 ? 'start' : 'center' });
    return true;
  }).catch(() => {});
  await sleep(350);
  const r = await deepRect(PORTAL, '.ayt-panel');
  return r ? shot(name, r) : shot(name);
}

/* ---------------------------------------------------------------- files */
function listFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

const newFiles = (dir, before) => listFiles(dir).filter((f) => !before.includes(f) && !/\.(crdownload|tmp|part)$/i.test(f));

async function waitNewFile(dir, before, re, timeoutMs = 30000) {
  return waitFor('a new file ' + re, () => newFiles(dir, before).find((f) => re.test(f)) || null, timeoutMs, 300).catch(() => null);
}

function insideDir(file, dir) {
  const a = path.resolve(file).toLowerCase();
  const b = path.resolve(dir).toLowerCase() + path.sep;
  return a.startsWith(b);
}

function ffprobe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_chapters', '-show_entries', 'format=format_name,duration,bit_rate:stream=index,codec_type,codec_name,width,height,bit_rate,sample_rate,channels:stream_tags=language:stream_disposition=attached_pic', '-of', 'json', file], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error('ffprobe failed: ' + (r.stderr || (r.error && r.error.message) || r.status));
  const j = JSON.parse(r.stdout);
  return {
    format: j.format && { name: j.format.format_name, duration: Number(j.format.duration), bitRate: Number(j.format.bit_rate) },
    streams: (j.streams || []).map((s) => ({ type: s.codec_type, codec: s.codec_name, width: s.width, height: s.height, bitRate: s.bit_rate ? Number(s.bit_rate) : null, sampleRate: s.sample_rate ? Number(s.sample_rate) : null, lang: (s.tags && s.tags.language) || null, cover: !!(s.disposition && s.disposition.attached_pic) })),
    chapters: (j.chapters || []).length,
  };
}

function imageSize(file) {
  const b = fs.readFileSync(file);
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xc3) return { type: 'jpg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), bytes: b.length };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  if (b.toString('ascii', 0, 4) === 'GIF8') return { type: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8), bytes: b.length };
  return { type: '?', width: 0, height: 0, bytes: b.length };
}

function validateSrt(text) {
  const problems = [];
  const blocks = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n\n');
  let prevEnd = -1;
  const sec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  blocks.forEach((b, i) => {
    const lines = b.split('\n');
    if (lines[0] !== String(i + 1)) problems.push(`#${i + 1}: number "${lines[0]}"`);
    const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(lines[1] || '');
    if (!m) return problems.push(`#${i + 1}: timing "${lines[1]}"`);
    const s = sec(m[1], m[2], m[3], m[4]);
    const e = sec(m[5], m[6], m[7], m[8]);
    if (!(e > s)) problems.push(`#${i + 1}: end <= start`);
    if (s < prevEnd - 1e-9) problems.push(`#${i + 1}: overlaps the previous cue`);
    prevEnd = e;
    if (lines.length < 3 || lines.slice(2).some((l) => !l.trim())) problems.push(`#${i + 1}: empty text`);
  });
  return { cues: blocks.length, problemCount: problems.length, problems: problems.slice(0, 8), first: blocks[0] ? blocks[0].split('\n').slice(2).join(' / ').slice(0, 80) : null };
}

/* ---------------------------------------------------------------- processes (journey 8) */
function parseTasklist(stdout) {
  const out = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (m && WATCHED_EXE.test(m[1])) out.set(Number(m[2]), m[1].toLowerCase());
  }
  return out;
}

/** pid -> image name of the watched executables (yt-dlp, python, ffmpeg, ffprobe), via tasklist. */
function tasklistPids() {
  return parseTasklist(spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 30000, windowsHide: true }).stdout);
}

/** Same as tasklistPids() without blocking the event loop (one call takes ~0.8 s on this machine). */
function tasklistPidsAsync() {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true });
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(new Map()));
    p.on('close', () => resolve(parseTasklist(out)));
  });
}

/** Instant liveness check (libuv: OpenProcess + GetExitCodeProcess == STILL_ACTIVE). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * yt-dlp / python / ffmpeg / ffprobe / deno / cmd processes with parent pid and command line. The WQL filter runs inside
 * WMI (no command line is read for the other ~350 processes): an unfiltered query took ~24 s while a 1080p download
 * loaded the machine. No double quotes in the script: they would need escaping on the command line.
 */
const CIM_PS =
  "$ErrorActionPreference='SilentlyContinue'; " +
  "$f = 'Name=''yt-dlp.exe'' OR Name LIKE ''python%.exe'' OR Name=''ffmpeg.exe'' OR Name=''ffprobe.exe'' OR Name=''deno.exe'' OR Name=''cmd.exe'''; " +
  '$a = @(Get-CimInstance Win32_Process -Filter $f | ' +
  'ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; cmd = [string]$_.CommandLine } }); ' +
  'ConvertTo-Json -InputObject $a -Compress -Depth 3';
const CIM_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CIM_PS];

function parseCim(stdout) {
  try {
    const v = JSON.parse(String(stdout || '').trim() || '[]');
    return (Array.isArray(v) ? v : [v]).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function cimProcs() {
  return parseCim(spawnSync('powershell.exe', CIM_ARGS, { encoding: 'utf8', timeout: 60000, windowsHide: true }).stdout);
}

/** cimProcs() without blocking the event loop; resolves { procs, ms } (procs = [] on failure or timeout). */
function cimProcsAsync(timeoutMs = 60000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('powershell.exe', CIM_ARGS, { windowsHide: true });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => {
      clearTimeout(timer);
      resolve({ procs: [], ms: Date.now() - t0 });
    });
    p.on('close', () => {
      clearTimeout(timer);
      resolve({ procs: parseCim(out), ms: Date.now() - t0 });
    });
  });
}

/** Our companion host (deno.exe started through host.bat by OUR Chrome) and every process below it. */
function hostTree(all) {
  const browserPid = H.browser.process() ? H.browser.process().pid : null;
  const cmds = all.filter((p) => /^cmd\.exe$/i.test(p.name) && /host\.bat/i.test(p.cmd) && (!browserPid || p.ppid === browserPid));
  const cmdPids = new Set(cmds.map((p) => p.pid));
  const hosts = all.filter((p) => /^deno\.exe$/i.test(p.name) && /AkifYouTubeAddon/i.test(p.cmd) && cmdPids.has(p.ppid));
  const set = new Set(hosts.map((p) => p.pid));
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) {
      if (!set.has(p.pid) && set.has(p.ppid)) {
        set.add(p.pid);
        grew = true;
      }
    }
  }
  return { hosts, children: all.filter((p) => set.has(p.pid) && !hosts.some((h) => h.pid === p.pid)) };
}

const procLabel = (p) => `${p.name}:${p.pid}${/yt-dlp/i.test(p.cmd) && /python/i.test(p.name) ? ' (yt-dlp)' : ''}`;

/* ================================================================== journeys */

/** Rows of the open video panel. */
function videoRows() {
  return iso(() => {
    const host = document.getElementById('ayt-portal-host');
    const root = host && host.shadowRoot;
    if (!root) return [];
    return Array.from(root.querySelectorAll('.ayt-video-list .ayt-video-row')).map((r) => ({
      key: r.dataset.key,
      res: ((r.querySelector('.ayt-row__res') || {}).textContent || '').trim(),
      badges: Array.from(r.querySelectorAll('.ayt-badge')).map((b) => b.textContent.trim()),
      size: ((r.querySelector('.ayt-row__size') || {}).textContent || '').trim(),
      hidden: r.classList.contains('ayt-hidden'),
      disabled: r.classList.contains('is-disabled'),
      busy: r.classList.contains('is-busy'),
    }));
  });
}

async function waitVideoRows() {
  return waitFor('video panel rows', async () => {
    const rows = await videoRows();
    return rows.length ? rows : null;
  }, 40000, 400);
}

/**
 * Opens the extension's real action popup (chrome.action.openPopup from the service worker; it is anchored to
 * the window of the YouTube tab, exactly like a click on the toolbar icon). Falls back to popup.html in a tab.
 */
async function openActionPopup() {
  await page.bringToFront().catch(() => {});
  const isPopup = (t) => t.type() === 'page' && t.url().startsWith(`chrome-extension://${EXT_ID}/popup/popup.html`);
  const before = new Set(H.browser.targets().filter(isPopup));
  const res = await swEval(() => chrome.action.openPopup().then(() => 'ok', (e) => 'ERR ' + e.message)).catch((e) => 'ERR ' + e.message);
  let target = null;
  if (res === 'ok') target = await waitFor('the action popup', () => H.browser.targets().find((t) => isPopup(t) && !before.has(t)) || null, 8000, 150).catch(() => null);
  if (target) {
    const p = await pageForTarget(target);
    await p.waitForSelector('.pp-header', { timeout: 15000 });
    return { page: p, mode: 'action popup (chrome.action.openPopup)' };
  }
  note(`chrome.action.openPopup() unavailable (${res}); using popup.html in a tab`);
  const p = await H.browser.newPage();
  watchOnce(p, 'popup');
  await p.setViewport({ width: 380, height: 600 });
  await p.goto(`chrome-extension://${EXT_ID}/popup/popup.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.bringToFront();
  await p.waitForSelector('.pp-header', { timeout: 15000 });
  return { page: p, mode: 'popup.html in a tab' };
}

/** Opens the popup and returns the job item matching `job` (title + label) once it is in `wantState`. */
async function popupJobItem(job, shotName, wantState) {
  const { page: p, mode } = await openActionPopup();
  evidence('popupMode', mode);
  try {
    const item = await waitFor(
      'the job in the popup list',
      () =>
        p.evaluate(
          (job, title, state) => {
            // Rows show AYT.util.jobLabel(job) (rebuilt in the UI language), which can differ from job.label.
            const labels = [job.label || ''];
            try {
              const U = globalThis.AYT && globalThis.AYT.util;
              if (U && U.jobLabel) labels.push(U.jobLabel(job) || '');
            } catch (_) {}
            const wanted = labels.filter(Boolean);
            const items = Array.from(document.querySelectorAll('.ayt-job'));
            for (const it of items) {
              const text = ((it.querySelector('.ayt-job__title') || {}).textContent || '').trim();
              if ((wanted.length && !wanted.some((l) => text.includes(l))) || (title && !text.includes(title))) continue;
              const res = {
                title: text,
                meta: ((it.querySelector('.ayt-job__meta') || {}).textContent || '').trim(),
                error: ((it.querySelector('.ayt-job__error') || {}).textContent || '').trim(),
                done: !!it.querySelector('.ayt-job__meta .is-done'),
                failed: !!it.querySelector('.ayt-job__meta .is-error'),
                actions: Array.from(it.querySelectorAll('.ayt-job__actions button')).map((b) => b.getAttribute('title')),
                listed: items.length,
              };
              if (state === 'done' && !res.done) return null;
              if (state === 'error' && !res.failed) return null;
              return res;
            }
            return null;
          },
          job,
          job.title || '',
          wantState || ''
        ),
      20000,
      300
    );
    await sleep(400);
    const file = path.join(SHOTS, shotName);
    await p.screenshot({ path: file });
    if (current) current.shots.push(file);
    log('  shot ' + file);
    return item;
  } finally {
    await p.close().catch(() => {});
    if (page) await page.bringToFront().catch(() => {});
  }
}

/* ---------------------------------------------------------------- 1 */
async function j1() {
  await openWatch(V_ZOO);
  const layout = await iso(() => {
    const host = document.getElementById('ayt-toolbar-host');
    const meta = document.querySelector('ytd-watch-flexy ytd-watch-metadata.watch-active-metadata');
    const atf = meta && meta.querySelector(':scope > #above-the-fold');
    const title = atf && atf.querySelector('#title h1');
    const hr = host.getBoundingClientRect();
    const tr = title ? title.getBoundingClientRect() : null;
    return {
      parentIsWatchMetadata: host.parentNode === meta,
      nextIsAboveTheFold: !!atf && host.nextElementSibling === atf,
      toolbar: { top: Math.round(hr.top), bottom: Math.round(hr.bottom), left: Math.round(hr.left), width: Math.round(hr.width) },
      title: tr ? { top: Math.round(tr.top), bottom: Math.round(tr.bottom), text: title.textContent.trim() } : null,
      ids: Array.from(host.shadowRoot.querySelectorAll('.ayt-tb-btn')).map((b) => b.dataset.id),
      separators: host.shadowRoot.querySelectorAll('.ayt-tb-sep').length,
    };
  });
  evidence('layout', layout);
  check('toolbar is inserted right before the title block (ytd-watch-metadata > #above-the-fold)', layout.parentIsWatchMetadata && layout.nextIsAboveTheFold, { parent: layout.parentIsWatchMetadata, next: layout.nextIsAboveTheFold });
  check('toolbar renders above the title', !!layout.title && layout.toolbar.bottom <= layout.title.top + 1, { toolbar: layout.toolbar, title: layout.title });
  check('toolbar buttons in the spec order (download | tools | end)', JSON.stringify(layout.ids) === JSON.stringify(EXPECTED_BUTTONS) && layout.separators === 2, { ids: layout.ids.join(','), separators: layout.separators });
  if (layout.title) {
    await iso(() => {
      document.getElementById('ayt-toolbar-host').scrollIntoView({ block: 'center' });
      return true;
    });
    await sleep(400);
    const tb = await deepRect(TOOLBAR, null);
    const tt = await iso(() => {
      const r = document.querySelector('ytd-watch-flexy ytd-watch-metadata.watch-active-metadata > #above-the-fold #title h1').getBoundingClientRect();
      return { bottom: r.bottom };
    });
    await shot('j01-toolbar-above-title.png', { x: tb.x, y: tb.y, width: Math.min(tb.width, 1100), height: Math.max(tb.height, tt.bottom - tb.y) }, 10);
  }
  // A forced status check = a real 'hello' round trip with the installed companion.
  const status = await iso(() => AYT.client.host.refresh(true));
  const tools = (status && status.tools) || {};
  evidence('hostStatus', { state: status && status.state, version: status && status.version, protocol: status && status.protocol, ytdlp: tools.ytdlp && tools.ytdlp.version, ffmpeg: tools.ffmpeg && tools.ffmpeg.version, deno: tools.deno && tools.deno.version, defaultDir: status && status.defaultDir });
  check("HOST status is 'connected' (real hello to the installed companion)", status && status.state === 'connected', current.evidence.hostStatus);
  await openPanelByClick('video');
  const rows = await waitVideoRows();
  await sleep(600); // the panel refreshes the host status when it opens
  const panel = await iso(() => {
    const root = document.getElementById('ayt-portal-host').shadowRoot;
    return {
      hostSlotChildren: root.querySelector('.ayt-dl-host') ? root.querySelector('.ayt-dl-host').childElementCount : -1,
      notices: Array.from(root.querySelectorAll('.ayt-panel .ayt-notice')).map((n) => n.textContent.trim().slice(0, 120)),
      footer: ((root.querySelector('.ayt-dl-folder__path') || {}).title || '').trim(),
      // everything the footer exposes to page scripts (our shadow roots are open): text, titles, aria-labels
      footerAll: (() => {
        const f = root.querySelector('.ayt-panel__footer');
        return f ? f.textContent + ' ' + Array.from(f.querySelectorAll('[title], [aria-label]')).map((x) => (x.title || '') + ' ' + (x.getAttribute('aria-label') || '')).join(' ') : '';
      })(),
    };
  });
  evidence('videoPanel', { rows: rows.map((r) => `${r.res} ${r.size}`), panel });
  check('video panel: no companion install notice, all rows enabled', panel.hostSlotChildren === 0 && panel.notices.length === 0 && rows.every((r) => !r.disabled), { rows: rows.length, disabled: rows.filter((r) => r.disabled).length, notices: panel.notices });
  // The footer names the outputDir folder by its last name only: the absolute path holds the Windows user name (spec §0.6).
  check(
    'video panel footer names the outputDir folder, without its absolute path',
    panel.footer.toLowerCase() === path.basename(COMPANION_DL).toLowerCase() && !panel.footerAll.toLowerCase().includes(COMPANION_DL.toLowerCase()) && !/[A-Za-z]:\\/.test(panel.footerAll),
    { footer: panel.footer, footerAll: panel.footerAll.slice(0, 200) }
  );
  await shotPanel('j01-video-panel-connected.png');
}

/* ---------------------------------------------------------------- 2 */
async function j2() {
  await openWatch(V_ZOO);
  await openPanelByClick('video');
  let rows = await waitVideoRows();
  const num = (r) => parseInt(r.res, 10) || 1e9;
  const lowest = rows.slice().sort((a, b) => num(a) - num(b))[0];
  evidence('rows', rows.map((r) => `${r.res}${r.badges.length ? ' [' + r.badges.join(',') + ']' : ''} ${r.size}${r.hidden ? ' (hidden)' : ''}`));
  if (lowest.hidden) {
    await clickDeep(PORTAL, '.ayt-video-more');
    await sleep(400);
    rows = await videoRows();
  }
  // Record every visual state of that row (MutationObserver in the isolated world) while the job runs.
  await iso((key) => {
    const root = document.getElementById('ayt-portal-host').shadowRoot;
    const sel = '.ayt-video-row[data-key="' + key.replace(/["\\]/g, '\\$&') + '"]';
    globalThis.__aytRowLog = [];
    globalThis.__aytRowSig = null;
    const snap = () => {
      const r = root.querySelector(sel);
      if (!r) return;
      const prog = r.querySelector('.ayt-row__progress');
      const bar = prog && prog.querySelector('.ayt-progress__bar');
      const s = {
        busy: r.classList.contains('is-busy'),
        starting: r.classList.contains('is-starting'),
        progress: !!prog && !prog.classList.contains('ayt-hidden'),
        width: bar ? bar.style.width : '',
        size: ((r.querySelector('.ayt-row__size') || {}).textContent || '').trim(),
      };
      const sig = [s.busy, s.starting, s.progress, s.width, s.size].join('|');
      if (sig !== globalThis.__aytRowSig) {
        globalThis.__aytRowSig = sig;
        globalThis.__aytRowLog.push(Object.assign({ t: Date.now() }, s));
      }
    };
    if (globalThis.__aytRowMo) globalThis.__aytRowMo.disconnect();
    globalThis.__aytRowMo = new MutationObserver(snap);
    globalThis.__aytRowMo.observe(root.querySelector('.ayt-video-list'), { subtree: true, childList: true, attributes: true, characterData: true });
    snap();
    // every job update the content script receives from the service worker (live port pushes)
    globalThis.__aytPushes = [];
    if (globalThis.__aytPushOff) globalThis.__aytPushOff();
    globalThis.__aytPushOff = AYT.client.on('job', (j) => {
      const last = globalThis.__aytPushes[globalThis.__aytPushes.length - 1];
      const s = `${j.status}/${j.stage || '-'}/${j.percent == null ? '-' : j.percent}`;
      if (!last || last.s !== s) globalThis.__aytPushes.push({ t: Date.now(), s });
    });
    return true;
  }, lowest.key);
  const before = await jobIds();
  await clickDeep(PORTAL, `.ayt-video-row[data-key="${lowest.key}"]`);
  log(`  clicked the lowest row: ${lowest.res} (${lowest.size})`);
  const job = await waitNewJob(before, (j) => j.kind === 'video' && j.videoId === V_ZOO);
  evidence('task', job.task);
  check('row click starts a video job with the row\'s height', job.task && job.task.height === parseInt(lowest.res, 10) && job.task.container === 'mp4', { label: job.label, height: job.task && job.task.height, container: job.task && job.task.container });
  let busyShot = false;
  const done = await waitJobEnd(job.id, 240000, async (j) => {
    if (busyShot || !j || TERMINAL.includes(j.status)) return;
    const busy = await iso((key) => {
      const r = document.getElementById('ayt-portal-host').shadowRoot.querySelector(`.ayt-video-row[data-key="${key}"]`);
      return !!(r && r.classList.contains('is-busy'));
    }, lowest.key).catch(() => false);
    if (busy) {
      busyShot = true;
      await shotPanel('j02-row-progress-while-running.png');
    }
  });
  await sleep(600);
  const rowLog = await iso(() => {
    if (globalThis.__aytRowMo) globalThis.__aytRowMo.disconnect();
    return globalThis.__aytRowLog || [];
  });
  const pushes = await iso(() => {
    if (globalThis.__aytPushOff) globalThis.__aytPushOff();
    const p = globalThis.__aytPushes || [];
    return p.map((x) => `+${x.t - p[0].t}ms ${x.s}`);
  });
  evidence('jobPushesSeenByThePage', pushes);
  const busyStates = rowLog.filter((s) => s.busy);
  const percents = busyStates.map((s) => s.size).filter((s) => /^\d+%$/.test(s));
  evidence('rowStates', rowLog.map((s) => `${s.busy ? 'busy' : 'idle'}${s.starting ? '+starting' : ''} progress=${s.progress ? s.width || 'indeterminate' : 'hidden'} "${s.size}"`));
  check('the row shows progress while the job runs (is-busy + progress bar + live text)', busyStates.length > 0 && busyStates.some((s) => s.progress) && (percents.length > 0 || busyStates.some((s) => s.size === '…')), { busyStates: busyStates.length, percents: [...new Set(percents)] });
  check('the row returns to normal after the job', rowLog.length > 0 && !rowLog[rowLog.length - 1].busy, rowLog[rowLog.length - 1]);
  evidence('job', slimJob(done));
  if (!check('job finished: done', done.status === 'done', slimJob(done))) {
    evidence('hostLog', hostLogTail());
    return;
  }
  const exists = done.filePath && fs.existsSync(done.filePath);
  check('file exists inside outputDir', exists && insideDir(done.filePath, COMPANION_DL), { filePath: done.filePath, size: exists ? fs.statSync(done.filePath).size : null });
  if (exists) {
    const probe = ffprobe(done.filePath);
    evidence('ffprobe', probe);
    const v = probe.streams.find((s) => s.type === 'video' && !s.cover);
    const a = probe.streams.find((s) => s.type === 'audio');
    check('ffprobe: video + audio streams', !!v && !!a, { video: v && `${v.codec} ${v.width}x${v.height}`, audio: a && a.codec, duration: probe.format && probe.format.duration });
    const cover = probe.streams.find((s) => s.cover);
    check('embedded cover art is a JPEG (embedThumbnail is on by default)', !!cover && cover.codec === 'mjpeg', { cover: cover && `${cover.codec} ${cover.width}x${cover.height}`, fileSize: fs.statSync(done.filePath).size });
  }
  const item = await popupJobItem(done, 'j02-popup-lists-finished-job.png', 'done');
  evidence('popupItem', item);
  check('popup lists the finished job (Completed)', !!item && item.done, item);
}

/* ---------------------------------------------------------------- 3 */
async function j3() {
  await openWatch(V_ZOO);
  await openPanelByClick('audio');
  await waitFor('audio panel', () => iso(() => {
    const r = document.getElementById('ayt-portal-host').shadowRoot;
    return !!(r.querySelector('.ayt-audio-go') && r.querySelector('.ayt-audio-range .ayt-input--time'));
  }), 40000);
  await clickDeep(PORTAL, '.ayt-audio-formats .ayt-seg__opt[data-value="mp3"]');
  await selectDeep(PORTAL, '.ayt-audio-bitrate select', '192');
  await typeDeep(PORTAL, '.ayt-audio-range .ayt-dl-range__time:nth-child(1) .ayt-input--time', '00:00:03');
  await typeDeep(PORTAL, '.ayt-audio-range .ayt-dl-range__time:nth-child(2) .ayt-input--time', '00:00:09');
  await sleep(300);
  const ui = await iso(() => {
    const r = document.getElementById('ayt-portal-host').shadowRoot;
    const ins = r.querySelectorAll('.ayt-audio-range .ayt-input--time');
    return {
      from: ins[0] && ins[0].value,
      to: ins[1] && ins[1].value,
      length: ((r.querySelector('.ayt-audio-range .ayt-dl-range__len') || {}).textContent || '').trim(),
      button: ((r.querySelector('.ayt-audio-go') || {}).textContent || '').trim(),
      bitrate: (r.querySelector('.ayt-audio-bitrate select') || {}).value,
      estimate: ((r.querySelector('.ayt-audio-estimate') || {}).textContent || '').trim(),
    };
  });
  evidence('panel', ui);
  check('panel shows MP3 · 192 kbps and the range 00:00:03–00:00:09 (length 6 s)', /MP3/.test(ui.button) && /192/.test(ui.button) && ui.from === '00:00:03' && ui.to === '00:00:09' && /00:06/.test(ui.length), ui);
  await shotPanel('j03-audio-panel-mp3-range.png');
  const before = await jobIds();
  await clickDeep(PORTAL, '.ayt-audio-go');
  const job = await waitNewJob(before, (j) => j.kind === 'audio' && j.videoId === V_ZOO);
  evidence('task', job.task);
  check('task: mp3, 192 kbps, section 3–9 s', job.task.audioFormat === 'mp3' && job.task.bitrate === 192 && job.task.section && job.task.section.start === 3 && job.task.section.end === 9, { audioFormat: job.task.audioFormat, bitrate: job.task.bitrate, section: job.task.section, label: job.label });
  const done = await waitJobEnd(job.id, 240000);
  evidence('job', slimJob(done));
  if (!check('job finished: done', done.status === 'done', slimJob(done))) {
    evidence('hostLog', hostLogTail());
    return;
  }
  const exists = done.filePath && fs.existsSync(done.filePath);
  check('.mp3 file exists inside outputDir', exists && /\.mp3$/i.test(done.filePath) && insideDir(done.filePath, COMPANION_DL), done.filePath);
  if (!exists) return;
  const probe = ffprobe(done.filePath);
  evidence('ffprobe', probe);
  const a = probe.streams.find((s) => s.type === 'audio');
  const dur = probe.format && probe.format.duration;
  check('ffprobe: duration 6.0 ± 0.2 s', Math.abs(dur - 6) <= 0.2, { duration: dur });
  check('ffprobe: mp3 at ~192 kbps', a && a.codec === 'mp3' && Math.abs((a.bitRate || 0) - 192000) <= 8000, { codec: a && a.codec, bitRate: a && a.bitRate, cover: probe.streams.some((s) => s.type === 'video') });
  await shotPanel('j03-audio-panel-done.png');
}

/* ---------------------------------------------------------------- 4 */
async function j4() {
  await openWatch(V_ZOO);
  await openPanelByClick('video');
  await waitVideoRows();
  await clickDeep(PORTAL, '.ayt-video-clip-toggle');
  await waitFor('clip editor', () => iso(() => !!document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-video-clip .ayt-input--time')), 8000, 200);
  await typeDeep(PORTAL, '.ayt-video-clip .ayt-dl-range__time:nth-child(1) .ayt-input--time', '00:00:05');
  await typeDeep(PORTAL, '.ayt-video-clip .ayt-dl-range__time:nth-child(2) .ayt-input--time', '00:00:08');
  await sleep(300);
  const ui = await iso(() => {
    const r = document.getElementById('ayt-portal-host').shadowRoot;
    const ins = r.querySelectorAll('.ayt-video-clip .ayt-input--time');
    const gif = r.querySelector('.ayt-video-gif');
    return { from: ins[0] && ins[0].value, to: ins[1] && ins[1].value, length: ((r.querySelector('.ayt-video-clip .ayt-dl-range__len') || {}).textContent || '').trim(), gifEnabled: !!gif && !gif.disabled, gifHint: ((r.querySelector('.ayt-video-gifrow .ayt-hint') || {}).textContent || '').trim() };
  });
  evidence('panel', ui);
  check('clip editor shows 00:00:05–00:00:08 and "Save as GIF" is enabled', ui.from === '00:00:05' && ui.to === '00:00:08' && /00:03/.test(ui.length) && ui.gifEnabled, ui);
  await shotPanel('j04-clip-editor-gif.png');
  const before = await jobIds();
  await clickDeep(PORTAL, '.ayt-video-gif');
  const job = await waitNewJob(before, (j) => j.kind === 'gif' && j.videoId === V_ZOO);
  evidence('task', job.task);
  check('task: gif, section 5–8 s, 480 px, 15 fps', job.task.section && job.task.section.start === 5 && job.task.section.end === 8 && job.task.gifWidth === 480 && job.task.gifFps === 15, { section: job.task.section, gifWidth: job.task.gifWidth, gifFps: job.task.gifFps, label: job.label });
  const done = await waitJobEnd(job.id, 240000);
  evidence('job', slimJob(done));
  if (!check('job finished: done', done.status === 'done', slimJob(done))) {
    evidence('hostLog', hostLogTail());
    return;
  }
  const exists = done.filePath && fs.existsSync(done.filePath);
  check('.gif file exists inside outputDir', exists && /\.gif$/i.test(done.filePath) && insideDir(done.filePath, COMPANION_DL), done.filePath);
  if (!exists) return;
  const img = imageSize(done.filePath);
  let probe = null;
  try {
    probe = ffprobe(done.filePath);
  } catch (e) {
    probe = { error: e.message };
  }
  evidence('gif', { img, probe });
  const dur = probe && probe.format ? probe.format.duration : NaN;
  check('a real GIF of ~3 s, at most 480 px wide', img.type === 'gif' && img.width > 0 && img.width <= 480 && Math.abs(dur - 3) <= 0.5, { type: img.type, size: `${img.width}x${img.height}`, bytes: img.bytes, duration: dur });
  await shotPanel('j04-gif-done.png');
}

/* ---------------------------------------------------------------- 5 */
async function j5() {
  const play = await openWatch(V_DUB, { play: true });
  evidence('playback', play);
  await openPanelByClick('subtitles');
  await waitFor('subtitles panel', () => iso(() => {
    const r = document.getElementById('ayt-portal-host').shadowRoot;
    const sel = r.querySelector('.ayt-subs select');
    return !!(sel && sel.options.length && r.querySelector('.ayt-subs .ayt-btn--primary'));
  }), 40000);
  const langs = await iso(() => {
    const sel = document.getElementById('ayt-portal-host').shadowRoot.querySelectorAll('.ayt-subs select')[0];
    return Array.from(sel.options).map((o) => ({ value: o.value, label: o.textContent.trim() }));
  });
  const en = langs.find((o) => /^English\b/.test(o.label) && !/auto/i.test(o.label));
  evidence('languages', { count: langs.length, first: langs.slice(0, 6).map((o) => o.label), picked: en });
  if (!check('subtitles panel lists a manual English track', !!en, langs.map((o) => o.label).slice(0, 12))) return;
  await selectDeep(PORTAL, '.ayt-subs select', en.value, 0);
  const dir = path.join(BROWSER_DL, SUBFOLDER);

  const download = async (format, tlang, shotName) => {
    if (tlang !== undefined) await selectDeep(PORTAL, '.ayt-subs select', tlang, 1);
    await clickDeep(PORTAL, `.ayt-subs .ayt-radio[data-value="${format}"]`);
    // reset the status line so the next result is detected reliably
    await iso(() => {
      const el = document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-subs .ayt-media-status');
      if (el) el.dataset.kind = '';
      return true;
    });
    const before = listFiles(BROWSER_DL);
    await clickDeep(PORTAL, '.ayt-subs .ayt-media-actions .ayt-btn--primary');
    const status = await waitFor('subtitle download status', () => iso(() => {
      const el = document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-subs .ayt-media-status');
      return el && (el.dataset.kind === 'success' || el.dataset.kind === 'error') ? { kind: el.dataset.kind, text: el.textContent.trim() } : null;
    }), 60000, 300);
    const suffix = tlang ? `en→${tlang}` : 'en';
    const re = new RegExp('^' + SUBFOLDER.replace(/ /g, ' ') + '/.+ \\(' + suffix + '\\)\\.' + format + '$');
    const rel = await waitNewFile(BROWSER_DL, before, re, 30000);
    await shotPanel(shotName);
    const all = newFiles(BROWSER_DL, before);
    return { status, rel, file: rel ? path.join(BROWSER_DL, rel) : null, newFiles: all };
  };

  // SRT (English)
  const srt = await download('srt', undefined, 'j05-subtitles-srt.png');
  const srtText = srt.file ? fs.readFileSync(srt.file, 'utf8') : '';
  const srtVal = srt.file ? validateSrt(srtText) : null;
  evidence('srt', { status: srt.status, file: srt.rel, validation: srtVal });
  check('SRT (English) saved to browser-dl\\Akif YouTube\\ with .srt and valid cues', srt.status.kind === 'success' && !!srt.file && srtVal.cues > 50 && srtVal.problemCount === 0, { status: srt.status, file: srt.rel, newFiles: srt.newFiles, cues: srtVal && srtVal.cues, problems: srtVal && srtVal.problems });
  // TXT
  const txt = await download('txt', undefined, 'j05-subtitles-txt.png');
  const txtText = txt.file ? fs.readFileSync(txt.file, 'utf8') : '';
  const lines = txtText.split(/\r?\n/).filter((l) => l.trim());
  const txtVal = { lines: lines.length, timestamps: (txtText.match(/\d{2}:\d{2}:\d{2}[,.]\d{3}/g) || []).length, tags: (txtText.match(/<[^>]+>/g) || []).length, first: lines.slice(0, 2) };
  evidence('txt', { status: txt.status, file: txt.rel, validation: txtVal });
  check('TXT saved with .txt: plain text lines, no timestamps or tags', txt.status.kind === 'success' && !!txt.file && txtVal.lines > 20 && txtVal.timestamps === 0 && txtVal.tags === 0, { status: txt.status, file: txt.rel, newFiles: txt.newFiles, ...txtVal });
  // translated en -> tr (SRT)
  const tr = await download('srt', 'tr', 'j05-subtitles-translated-tr.png');
  const trText = tr.file ? fs.readFileSync(tr.file, 'utf8') : '';
  const trVal = tr.file ? validateSrt(trText) : null;
  const turkish = (trText.match(/[çğıöşüÇĞİÖŞÜ]/g) || []).length;
  evidence('translated', { status: tr.status, file: tr.rel, validation: trVal, turkishLetters: turkish });
  check('translated SRT (en→tr) saved, valid and in Turkish', tr.status.kind === 'success' && !!tr.file && trVal.cues > 50 && trVal.problemCount === 0 && turkish > 20, { status: tr.status, file: tr.rel, newFiles: tr.newFiles, cues: trVal && trVal.cues, problems: trVal && trVal.problems, turkishLetters: turkish, sample: trVal && trVal.first });
  evidence('folder', listFiles(dir));
  await quietPlayer(false);
}

/* ---------------------------------------------------------------- 6 */
async function j6() {
  await openWatch(V_DUB);
  await openPanelByClick('thumbnail');
  const state = await waitFor('thumbnail panel with sizes', () => iso(() => {
    const r = document.getElementById('ayt-portal-host').shadowRoot;
    const sel = r.querySelector('.ayt-thumb select');
    const img = r.querySelector('.ayt-thumb__img');
    if (!sel || sel.disabled || !sel.options.length || !img || !img.complete || !img.naturalWidth) return null;
    return { options: Array.from(sel.options).map((o) => ({ value: o.value, label: o.textContent.trim() })), selected: sel.value };
  }), 40000);
  evidence('qualities', state.options.map((o) => o.label));
  const max = state.options.find((o) => /^Maximum/i.test(o.label));
  if (!check('quality list offers "Maximum · 1280×720"', !!max && /1280\s*×\s*720/.test(max.label), state.options.map((o) => o.label))) return;
  await selectDeep(PORTAL, '.ayt-thumb select', max.value);
  await clickDeep(PORTAL, '.ayt-thumb .ayt-seg__opt[data-value="png"]');
  await iso(() => {
    const el = document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-thumb .ayt-media-status');
    if (el) el.dataset.kind = '';
    return true;
  });
  const before = listFiles(BROWSER_DL);
  await clickDeep(PORTAL, '.ayt-thumb .ayt-btn--primary');
  const status = await waitFor('thumbnail download status', () => iso(() => {
    const el = document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-thumb .ayt-media-status');
    return el && (el.dataset.kind === 'success' || el.dataset.kind === 'error') ? { kind: el.dataset.kind, text: el.textContent.trim() } : null;
  }), 40000, 300);
  const rel = await waitNewFile(BROWSER_DL, before, new RegExp('^' + SUBFOLDER + '/.+\\.png$'), 30000);
  const size = rel ? imageSize(path.join(BROWSER_DL, rel)) : null;
  evidence('download', { status, file: rel, size });
  check('PNG saved to browser-dl\\Akif YouTube\\ at 1280x720', status.kind === 'success' && !!rel && size.type === 'png' && size.width === 1280 && size.height === 720, { status, file: rel, size, newFiles: newFiles(BROWSER_DL, before) });
  await shotPanel('j06-thumbnail-png.png');
}

/* ---------------------------------------------------------------- 7 */
async function j7() {
  const play = await openWatch(V_DUB, { play: true });
  evidence('playback', play);
  await sleep(1500);
  const before = listFiles(BROWSER_DL);
  const v1 = await playerState();
  await clickDeep(TOOLBAR, '.ayt-tb-btn[data-id="screenshot"]');
  const v2 = await playerState();
  const rel = await waitNewFile(BROWSER_DL, before, new RegExp('^' + SUBFOLDER + '/.+ \\(\\d{2}-\\d{2}-\\d{2}\\.\\d{3}\\)\\.png$'), 30000);
  const size = rel ? imageSize(path.join(BROWSER_DL, rel)) : null;
  const toasts = await iso(() => {
    const host = document.getElementById('ayt-toast-host');
    return host ? Array.from(host.shadowRoot.querySelectorAll('.ayt-toast__text')).map((x) => x.textContent) : [];
  });
  evidence('screenshot', { file: rel, size, videoBefore: `${v1.w}x${v1.h}`, videoAfter: `${v2.w}x${v2.h}`, toasts });
  const native = size && ((size.width === v1.w && size.height === v1.h) || (size.width === v2.w && size.height === v2.h));
  check('toolbar screenshot saves a PNG at the video\'s native resolution', !!rel && size.type === 'png' && native, { file: rel, size: size && `${size.width}x${size.height}`, video: `${v1.w}x${v1.h}`, newFiles: newFiles(BROWSER_DL, before) });
  check('feedback toast shown', toasts.some((x) => /screenshot/i.test(x)), toasts);
  await iso(() => {
    document.getElementById('ayt-toolbar-host').scrollIntoView({ block: 'center' });
    return true;
  });
  await shot('j07-after-screenshot.png');
  await quietPlayer(false);
}

/* ---------------------------------------------------------------- 8 */
async function j8() {
  await openWatch(V_DUB);
  const pidsBefore = tasklistPids();
  evidence('watchedPidsBefore', [...pidsBefore].map(([pid, name]) => `${name}:${pid}`));
  await openPanelByClick('video');
  const rows = await waitVideoRows();
  const row = rows.find((r) => /^1080p/.test(r.res) && !r.badges.includes('HDR'));
  evidence('rows', rows.map((r) => `${r.res}${r.badges.length ? ' [' + r.badges.join(',') + ']' : ''} ${r.size}`));
  if (!check('a 1080p (SDR) row is offered', !!row, rows.map((r) => r.res))) return;
  const before = await jobIds();
  await clickDeep(PORTAL, `.ayt-video-row[data-key="${row.key}"]`);
  const job = await waitNewJob(before, (j) => j.kind === 'video' && j.videoId === V_DUB);
  evidence('task', { height: job.task.height, hdr: job.task.hdr, fps: job.task.fps, container: job.task.container, label: job.label });
  // wait for real download progress (extraction first takes a few seconds); with --j8-stage processing
  // wait for the post-processing (ffmpeg merge) instead, to cancel while ffmpeg runs
  const atProcessing = opt('--j8-stage', 'download') === 'processing';
  evidence('cancelDuring', atProcessing ? 'processing (ffmpeg merge)' : 'download');
  // Processes of the job (command lines + parent links = attribution) are read in the background as soon as yt-dlp
  // runs: on a loaded machine one snapshot took ~24 s, and it must never delay the cancel (a fast connection
  // finishes the whole 1080p job in ~40 s).
  let snap = null;
  const running = await waitFor(atProcessing ? 'post-processing' : 'download progress', async () => {
    const j = await getJob(job.id);
    if (!j) return null;
    if (TERMINAL.includes(j.status)) return j;
    if (!snap && !atProcessing && j.status === 'running') snap = cimProcsAsync();
    if (atProcessing) return j.status === 'processing' ? j : null;
    return j.status === 'running' && (j.downloaded > 0 || j.percent > 0) ? j : null;
  }, 240000, atProcessing ? 150 : 500);
  if (!check(`the 1080p job is ${atProcessing ? 'post-processing' : 'downloading'}`, running.status === (atProcessing ? 'processing' : 'running'), slimJob(running))) {
    evidence('hostLog', hostLogTail());
    return;
  }
  if (!snap) snap = cimProcsAsync(); // processing mode: ffmpeg runs now
  await sleep(atProcessing ? 300 : 2000); // "after a few seconds"
  // use the snapshot when it is back within a few more seconds, otherwise cancel anyway and read it afterwards
  let during = await Promise.race([snap, sleep(atProcessing ? 4000 : 6000).then(() => null)]);
  const atClick = await getJob(job.id);
  // cancel from the panel's job list (the x button of the running job)
  await clickDeep(PORTAL, '.ayt-video-jobs .ayt-job .ayt-job__actions .ayt-btn[title="Cancel"]');
  const tCancel = Date.now();
  const snapshotLate = !during;
  if (!during) during = await snap;
  const tree = hostTree(during.procs);
  const ours = tree.children.filter((p) => WATCHED_EXE.test(p.name));
  evidence('hostTreeAtCancel', { stageAtClick: atClick && `${atClick.status}/${atClick.stage || '-'} ${atClick.percent}%`, snapshotMs: during.ms, snapshotFinishedAfterClick: snapshotLate, host: tree.hosts.map(procLabel), children: tree.children.map(procLabel) });
  check('the cancel is clicked while the job is still active', !!atClick && !TERMINAL.includes(atClick.status), { status: atClick && atClick.status, stage: atClick && atClick.stage, percent: atClick && atClick.percent });
  check('yt-dlp is running under our companion host', ours.some((p) => /yt-dlp/i.test(p.name) || /yt-dlp/i.test(p.cmd)), current.evidence.hostTreeAtCancel);
  // Track every process of the job: the snapshot above + anything new since `pidsBefore` (async tasklist,
  // catches e.g. an ffmpeg started after the snapshot). Liveness of tracked PIDs is polled every 100 ms.
  const tracked = new Map(ours.map((p) => [p.pid, { label: procLabel(p), diedAt: null, source: 'snapshot' }]));
  let tTerminal = null;
  let end = null;
  let listing = null;
  let lastListingStart = 0; // start time of the last COMPLETED tasklist run
  let lastJobPoll = 0;
  for (;;) {
    const now = Date.now();
    for (const [pid, rec] of tracked) if (rec.diedAt === null && !pidAlive(pid)) rec.diedAt = now;
    if (!listing && !(tTerminal && lastListingStart > tTerminal)) {
      const startedAt = Date.now();
      listing = tasklistPidsAsync().then((m) => {
        for (const [pid, name] of m) {
          if (!pidsBefore.has(pid) && !tracked.has(pid)) tracked.set(pid, { label: `${name}:${pid}`, diedAt: null, source: `tasklist at +${startedAt - tCancel} ms` });
        }
        lastListingStart = startedAt;
        listing = null;
      });
    }
    if (!tTerminal && now - lastJobPoll > 300) {
      lastJobPoll = now;
      const j = await getJob(job.id).catch(() => null);
      if (j && TERMINAL.includes(j.status)) {
        tTerminal = Date.now();
        end = j;
      }
    }
    const alive = [...tracked.values()].filter((r) => r.diedAt === null);
    // done: canceled, nothing tracked alive, and one full tasklist started after "canceled" found no newcomer
    if (tTerminal && !alive.length && !listing && lastListingStart > tTerminal) break;
    if (tTerminal && Date.now() - tTerminal > 15000) break;
    if (!tTerminal && Date.now() - tCancel > 30000) break;
    await sleep(100);
  }
  if (listing) await listing;
  if (!end) end = (await getJob(job.id)) || { status: 'unknown' };
  evidence('job', Object.assign(slimJob(end), { msClickToTerminal: tTerminal ? tTerminal - tCancel : null }));
  check("job ends as 'canceled'", end.status === 'canceled', { status: end.status, error: end.error, msAfterClick: tTerminal ? tTerminal - tCancel : null });
  const procs = [...tracked.entries()].map(([pid, r]) => ({
    pid,
    label: r.label,
    source: r.source,
    alive: pidAlive(pid),
    diedMsAfterClick: r.diedAt ? r.diedAt - tCancel : null,
    diedMsAfterCanceled: r.diedAt && tTerminal ? r.diedAt - tTerminal : null,
  }));
  // anything still alive: who is it? (another tool on this machine is not our leftover)
  const leftNow = procs.filter((p) => p.alive);
  let attribution = [];
  if (leftNow.length) {
    const all = cimProcs();
    const outLower = COMPANION_DL.toLowerCase();
    const treeNow = hostTree(all).children.map((p) => p.pid);
    attribution = leftNow.map((p) => {
      const c = all.find((x) => x.pid === p.pid);
      return { pid: p.pid, label: p.label, cmd: c ? String(c.cmd).slice(0, 200) : null, underOurHost: treeNow.includes(p.pid), usesOutputDir: !!(c && String(c.cmd).toLowerCase().includes(outLower)) };
    });
  }
  const pidsAfter = tasklistPids();
  const newSinceBefore = [...pidsAfter].filter(([pid]) => !pidsBefore.has(pid)).map(([pid, name]) => `${name}:${pid}`);
  evidence('processesAfterCancel', { procs, attribution, tasklistNewSinceBefore: newSinceBefore });
  const oursLeft = procs.filter((p) => p.source === 'snapshot' || (attribution.find((a) => a.pid === p.pid) || {}).underOurHost || (attribution.find((a) => a.pid === p.pid) || {}).usesOutputDir || !p.alive);
  const late = oursLeft.filter((p) => p.alive || p.diedMsAfterCanceled === null || p.diedMsAfterCanceled > 10000);
  check('no yt-dlp/python/ffmpeg process of the job remains 10 s after "canceled" (tasklist diff + PID polling)', tracked.size > 0 && late.length === 0, { procs: procs.map((p) => `${p.label} ${p.alive ? 'ALIVE' : 'died ' + p.diedMsAfterClick + ' ms after the click / ' + p.diedMsAfterCanceled + ' ms after canceled'} [${p.source}]`), newSinceBefore, attribution });
  const tmp = path.join(COMPANION_DL, '.akif-tmp');
  const tmpLeft = fs.existsSync(tmp) ? listFiles(tmp) : null;
  const partials = listFiles(COMPANION_DL).filter((f) => /\.(part|ytdl|temp)$|\.f\d+\./i.test(f));
  evidence('outputDirAfterCancel', { akifTmp: tmpLeft, partials, files: listFiles(COMPANION_DL) });
  check('no .akif-tmp leftovers (or partial files) in outputDir', tmpLeft === null && partials.length === 0, { akifTmp: tmpLeft, partials });
  await shotPanel('j08-canceled.png');
}

/* ---------------------------------------------------------------- 9 */
async function j9() {
  await openWatch(V_DUB);
  const initial = await iso(() => AYT.settings.get('hideComments'));
  // load the comments (YouTube renders them when scrolled into view)
  await page.evaluate(() => window.scrollTo(0, 1200));
  const loaded = await waitFor('comments rendered', () => page.evaluate(() => {
    const c = document.querySelector('ytd-watch-flexy ytd-comments#comments');
    return c && c.querySelector('ytd-comment-thread-renderer') ? c.querySelectorAll('ytd-comment-thread-renderer').length : null;
  }), 45000, 600).catch(() => 0);
  evidence('initial', { hideComments: initial, commentThreads: loaded });
  check('comments are visible before the toggle', initial === false && loaded > 0, { hideComments: initial, threads: loaded });
  const state = () =>
    page.evaluate(() => {
      const c = document.querySelector('ytd-watch-flexy ytd-comments#comments');
      const pill = document.getElementById('ayt-comments-pill');
      const pr = pill && pill.isConnected ? pill.getBoundingClientRect() : null;
      const tb = document.getElementById('ayt-toolbar-host');
      const btn = tb && tb.shadowRoot.querySelector('.ayt-tb-btn[data-id="comments"]');
      return {
        htmlClass: document.documentElement.classList.contains('ayt-hide-comments'),
        commentsDisplay: c ? getComputedStyle(c).display : null,
        pillConnected: !!(pill && pill.isConnected),
        pillBeforeComments: !!(pill && c && pill.nextElementSibling === c),
        pillVisible: !!(pr && pr.height > 0 && getComputedStyle(pill).display !== 'none'),
        pillText: pill && pill.shadowRoot ? pill.shadowRoot.textContent.replace(/\s+/g, ' ').trim() : null,
        buttonOn: !!(btn && btn.classList.contains('is-on')),
        buttonLabel: btn ? btn.getAttribute('aria-label') : null,
      };
    });
  // hide with the toolbar button
  await clickDeep(TOOLBAR, '.ayt-tb-btn[data-id="comments"]');
  const hidden = await waitFor('comments hidden + pill', async () => {
    const s = await state();
    return s.htmlClass && s.commentsDisplay === 'none' && s.pillVisible ? s : null;
  }, 10000, 300).catch(async () => state());
  evidence('hidden', hidden);
  check('toolbar toggle hides the comments and shows the pill where they were', hidden.htmlClass && hidden.commentsDisplay === 'none' && hidden.pillVisible && hidden.pillBeforeComments && /Comments are hidden/.test(hidden.pillText || ''), hidden);
  check('setting hideComments persisted as true', (await iso(() => AYT.settings.get('hideComments'))) === true);
  await iso(() => {
    document.getElementById('ayt-comments-pill').scrollIntoView({ block: 'center' });
    return true;
  });
  await sleep(400);
  const pr = await deepRect('#ayt-comments-pill', null);
  if (pr) await shot('j09-comments-hidden-pill.png', { x: Math.max(0, pr.x - 20), y: pr.y - 160, width: pr.width + 40, height: pr.height + 220 });
  // toggle back with the toolbar button
  await clickDeep(TOOLBAR, '.ayt-tb-btn[data-id="comments"]');
  const shown = await waitFor('comments shown again', async () => {
    const s = await state();
    return !s.htmlClass && s.commentsDisplay !== 'none' && !s.pillVisible ? s : null;
  }, 10000, 300).catch(async () => state());
  evidence('shownAgain', shown);
  check('toggling back shows the comments and hides the pill', !shown.htmlClass && shown.commentsDisplay !== 'none' && !shown.pillVisible && !shown.buttonOn, shown);
  // hide again, then use the pill's own "Show" button
  await clickDeep(TOOLBAR, '.ayt-tb-btn[data-id="comments"]');
  await waitFor('hidden again', async () => (await state()).pillVisible, 10000, 300);
  await clickDeep('#ayt-comments-pill', '.ayt-comments-show');
  const viaPill = await waitFor('comments shown via the pill', async () => {
    const s = await state();
    return !s.htmlClass && s.commentsDisplay !== 'none' && !s.pillVisible ? s : null;
  }, 10000, 300).catch(async () => state());
  evidence('shownViaPill', viaPill);
  check('the pill\'s "Show" button brings the comments back', !viaPill.htmlClass && viaPill.commentsDisplay !== 'none' && !viaPill.pillVisible, viaPill);
  check('setting hideComments is false again', (await iso(() => AYT.settings.get('hideComments'))) === false);
  await page.evaluate(() => {
    const c = document.querySelector('ytd-watch-flexy ytd-comments#comments');
    if (c) c.scrollIntoView({ block: 'start' });
  });
  await sleep(500);
  await shot('j09-comments-visible-again.png');
}

/* ---------------------------------------------------------------- 10 */
async function j10() {
  await freshPage('youtube');
  await retry('goto short', () => page.goto(`https://www.youtube.com/shorts/${SHORT_ID}`, { waitUntil: 'domcontentloaded', timeout: 90000 }));
  await handleConsent();
  let ok = await page.waitForSelector('ytd-shorts reel-action-bar-view-model', { timeout: 45000 }).then(() => true, () => false);
  if (!ok) {
    note(`/shorts/${SHORT_ID} did not open a short; trying /shorts/`);
    await retry('goto shorts', () => page.goto('https://www.youtube.com/shorts/', { waitUntil: 'domcontentloaded', timeout: 90000 }));
    ok = await page.waitForSelector('ytd-shorts reel-action-bar-view-model', { timeout: 45000 }).then(() => true, () => false);
  }
  if (!check('a Shorts page with an action bar opened', ok, page.url())) return;
  await waitBooted();
  const info = await waitFor('Shorts page detected', () => iso(() => (AYT.page.type === 'shorts' && AYT.page.videoId ? { type: AYT.page.type, videoId: AYT.page.videoId } : null)), 20000);
  const sid = info.videoId;
  evidence('short', { url: page.url(), videoId: sid });
  await page.evaluate(() => {
    const v = document.querySelector('#shorts-player video');
    if (v) v.muted = true;
  });
  const placed = await waitFor('our button in the action bar', () => page.evaluate(() => {
    const bar = document.querySelector('ytd-shorts reel-action-bar-view-model');
    const host = bar && bar.querySelector(':scope > .ayt-shorts-action');
    if (!host) return null;
    const r = host.getBoundingClientRect();
    return { next: host.nextElementSibling ? host.nextElementSibling.tagName.toLowerCase() : null, w: Math.round(r.width), h: Math.round(r.height), label: host.shadowRoot.textContent.trim() };
  }), 20000, 400).catch(() => null);
  check('the injected download button exists in the active short\'s action column', !!placed && placed.w > 0, placed);
  if (!placed) return;
  const bar = await page.evaluate(() => {
    const r = document.querySelector('ytd-shorts reel-action-bar-view-model').getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  await shot('j10-shorts-button.png', { x: bar.x - 420, y: Math.max(0, bar.y - 40), width: bar.width + 480, height: bar.height + 80 }, 0);
  await clickDeep('.ayt-shorts-action', 'button.ayt-sb');
  const pop = await waitFor('popover open', () => iso(() => {
    const host = document.getElementById('ayt-shorts-pop-host');
    const r = host && host.shadowRoot;
    const p = r && r.querySelector('.ayt-shorts-pop');
    return p ? { tabs: Array.from(r.querySelectorAll('.ayt-shorts-tab')).map((t) => t.dataset.id) } : null;
  }), 10000, 250).catch(() => null);
  check('its popover opens with the Shorts panels as tabs', !!pop && pop.tabs.includes('audio') && pop.tabs.includes('video'), pop);
  if (!pop) return;
  await clickDeep('#ayt-shorts-pop-host', '.ayt-shorts-tab[data-id="audio"]');
  await waitFor('audio panel in the popover', () => iso(() => !!document.getElementById('ayt-shorts-pop-host').shadowRoot.querySelector('.ayt-shorts-panel .ayt-audio-go')), 40000, 400);
  await clickDeep('#ayt-shorts-pop-host', '.ayt-audio-formats .ayt-seg__opt[data-value="mp3"]');
  await sleep(300);
  const label = await iso(() => (document.getElementById('ayt-shorts-pop-host').shadowRoot.querySelector('.ayt-audio-go') || {}).textContent.trim());
  const popRect = await deepRect('#ayt-shorts-pop-host', '.ayt-shorts-pop');
  if (popRect) await shot('j10-shorts-popover-audio.png', popRect);
  const before = await jobIds();
  await clickDeep('#ayt-shorts-pop-host', '.ayt-audio-go');
  const job = await waitNewJob(before, (j) => j.kind === 'audio' && j.videoId === sid);
  evidence('task', { audioFormat: job.task.audioFormat, bitrate: job.task.bitrate, section: job.task.section, label: job.label, button: label });
  check('MP3 job started for this short', job.task.audioFormat === 'mp3', { label: job.label });
  const done = await waitJobEnd(job.id, 240000);
  evidence('job', slimJob(done));
  if (!check('job finished: done', done.status === 'done', slimJob(done))) {
    evidence('hostLog', hostLogTail());
    return;
  }
  const exists = done.filePath && fs.existsSync(done.filePath);
  let probe = null;
  if (exists) probe = ffprobe(done.filePath);
  const a = probe && probe.streams.find((s) => s.type === 'audio');
  evidence('ffprobe', probe);
  check('.mp3 of the short exists in outputDir (ffprobe: mp3 audio)', exists && insideDir(done.filePath, COMPANION_DL) && a && a.codec === 'mp3', { filePath: done.filePath, codec: a && a.codec, duration: probe && probe.format && probe.format.duration });
  const r2 = await deepRect('#ayt-shorts-pop-host', '.ayt-shorts-pop');
  if (r2) await shot('j10-shorts-popover-done.png', r2);
}

/* ---------------------------------------------------------------- 11 */
async function j11() {
  await freshPage('options');
  await page.setViewport({ width: 1280, height: 1000 });
  await page.goto(`chrome-extension://${EXT_ID}/options/options.html#companion`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.bringToFront();
  const st = await waitFor('companion status card: connected', () => page.evaluate(() => {
    const el = document.querySelector('.op-status');
    if (!el || el.dataset.state !== 'connected') return null;
    const tiles = Array.from(document.querySelectorAll('.op-tool')).map((x) => ({
      name: ((x.querySelector('.op-tool__head') || {}).textContent || '').trim(),
      version: ((x.querySelector('.op-tool__ver') || {}).textContent || '').trim(),
      path: ((x.querySelector('.op-tool__path') || {}).title || (x.querySelector('.op-tool__path') || {}).textContent || '').trim(),
    }));
    return tiles.length ? { title: ((el.querySelector('.op-status__title') || {}).textContent || '').trim(), text: ((el.querySelector('.op-status__text') || {}).textContent || '').trim(), tiles, folder: ((document.querySelector('.op-folder__path') || {}).textContent || '').trim(), hash: location.hash } : null;
  }), 45000, 400);
  evidence('status', st);
  const ver = (n) => (st.tiles.find((x) => x.name.toLowerCase() === n) || {}).version || '';
  check('Companion section shows "Connected"', /connected/i.test(st.title), { title: st.title, text: st.text });
  check('versions: yt-dlp 2026.10.26, FFmpeg 8.1.1, Deno 2.8.1', ver('yt-dlp') === '2026.10.26' && /^8\.1\.1/.test(ver('ffmpeg')) && ver('deno') === '2.8.1', st.tiles.map((x) => `${x.name} ${x.version}`));
  check('save folder shows the outputDir setting', st.folder.toLowerCase() === COMPANION_DL.toLowerCase(), st.folder);
  await sleep(600);
  await shot('j11-options-companion-connected.png');
}

/* ---------------------------------------------------------------- 12 */
async function j12() {
  await openWatch(V_ZOO);
  const before = await jobIds();
  // the video panel's own task API (AYT.dl) with a video id that does not exist
  const started = await iso(async (fake) => {
    const op = AYT.dl.bestOption('mp4');
    const task = AYT.dl.videoTask(fake, op, { container: 'mp4', codec: 'auto', audioLang: null, section: null, preciseCut: false, playlistId: null });
    const meta = AYT.dl.videoMeta(fake, 'Made-up video ' + fake, AYT.dl.videoLabel(op, { container: 'mp4' }));
    const id = await AYT.dl.startJob(task, meta, {});
    return { id, task, meta };
  }, FAKE_ID);
  evidence('started', started);
  const job = await waitNewJob(before, (j) => j.videoId === FAKE_ID, 20000);
  const end = await waitJobEnd(job.id, 180000);
  evidence('job', Object.assign(slimJob(end), { errorDetail: end.errorDetail }));
  check("job ends with status 'error' and code unavailable/private", end.status === 'error' && ['unavailable', 'private'].includes(end.errorCode), { status: end.status, code: end.errorCode });
  const friendly = typeof end.error === 'string' && /^This video is (unavailable|private)\./.test(end.error) && !/Traceback|^ERROR:|\[youtube\]/.test(end.error) && end.error.length < 300;
  check('error message is friendly', friendly, end.error);
  const toasts = await iso(() => {
    const host = document.getElementById('ayt-toast-host');
    return host ? Array.from(host.shadowRoot.querySelectorAll('.ayt-toast__text')).map((x) => x.textContent) : [];
  });
  evidence('toasts', toasts);
  const item = await popupJobItem(end, 'j12-popup-error.png', 'error');
  evidence('popupItem', item);
  check('popup shows the job as Failed with the friendly message and a Retry button', !!item && item.failed && item.error === end.error && item.actions.includes('Retry'), item);
}

/* ---------------------------------------------------------------- 13 */
async function j13() {
  await openWatch(V_ZOO);
  const consoleStart = report.console.length;
  await openPanelByClick('video');
  const rows0 = await waitVideoRows();
  await page.evaluate(() => {
    window.__aytE2eSameDocument = true;
  });
  const link = await waitFor('a related video link', () => page.evaluate((cur) => {
    const all = Array.from(document.querySelectorAll('ytd-watch-flexy #secondary #related a[href*="/watch?v="]'));
    const links = all.filter((a) => !/[?&]list=/.test(a.getAttribute('href') || '')).concat(all.filter((a) => /[?&]list=/.test(a.getAttribute('href') || '')));
    for (const a of links) {
      const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(a.getAttribute('href') || '');
      const r = a.getBoundingClientRect();
      if (!m || m[1] === cur || !(r.width > 0 && r.height > 0)) continue;
      document.querySelectorAll('[data-ayt-e2e-link]').forEach((x) => x.removeAttribute('data-ayt-e2e-link'));
      a.setAttribute('data-ayt-e2e-link', '1');
      return { id: m[1], href: a.getAttribute('href'), text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90) };
    }
    return null;
  }, V_ZOO), 40000, 600);
  evidence('relatedLink', link);
  await shotPanel('j13-panel-before-navigation.png');
  // A mouse click outside the panel closes it (by design); keyboard activation keeps it open:
  // focus the related link and press Enter -> YouTube's SPA router navigates.
  await page.evaluate(() => document.querySelector('[data-ayt-e2e-link]').focus());
  await page.keyboard.press('Enter');
  let method = 'focus + Enter';
  let nav = await waitFor('SPA navigation', () => iso((id) => AYT.page.videoId === id, link.id), 20000, 300).catch(() => false);
  if (!nav) {
    method = 'element.click()';
    note('Enter on the focused link did not navigate; using element.click()');
    await page.evaluate(() => document.querySelector('[data-ayt-e2e-link]').click());
    nav = await waitFor('SPA navigation', () => iso((id) => AYT.page.videoId === id, link.id), 20000, 300).catch(() => false);
  }
  const same = await page.evaluate(() => window.__aytE2eSameDocument === true).catch(() => false);
  check('navigated to the related video without a page reload (SPA)', !!nav && same, { method, to: link.id, url: page.url(), sameDocument: same });
  if (!nav) return;
  const stillOpen = await iso(() => AYT.toolbar.isOpen('video'));
  check('the video panel stays open', stillOpen);
  const expected = await iso(async (id) => {
    const info = await AYT.videoInfo.get(id);
    const tracks = AYT.dl.trackOptions(info);
    const tr = tracks[0] || null;
    const ops = AYT.dl.buildVideoOptions(info, { container: AYT.settings.get('videoContainer') || 'mp4', codec: AYT.settings.get('videoCodec') || 'auto', trackId: tr ? tr.value : null, audioLang: tr ? tr.lang : null });
    return { title: info.title, keys: ops.map((o) => o.key), labels: ops.map((o) => o.label) };
  }, link.id);
  const rows1 = await waitFor('panel rows for the new video', async () => {
    const r = await videoRows();
    return r.length && JSON.stringify(r.map((x) => x.key)) === JSON.stringify(expected.keys) ? r : null;
  }, 40000, 500).catch(async () => videoRows());
  evidence('rows', { before: rows0.map((r) => `${r.res} ${r.size}`), after: rows1.map((r) => `${r.res} ${r.size}`), expected: expected.labels, newTitle: expected.title });
  check('panel reloaded with the new video\'s qualities', JSON.stringify(rows1.map((x) => x.key)) === JSON.stringify(expected.keys) && JSON.stringify(rows1.map((x) => x.key)) !== JSON.stringify(rows0.map((x) => x.key)), { before: rows0.map((r) => r.res), after: rows1.map((r) => r.res), expected: expected.labels });
  const jobsFilter = await iso((id) => {
    const r = document.getElementById('ayt-portal-host').shadowRoot;
    return { loading: !!r.querySelector('.ayt-dl-loading'), errors: Array.from(r.querySelectorAll('.ayt-notice--error')).map((n) => n.textContent.trim()), videoId: AYT.page.videoId === id };
  }, link.id);
  check('panel shows no loading spinner or error after the switch', !jobsFilter.loading && !jobsFilter.errors.length, jobsFilter);
  await sleep(1500);
  await shotPanel('j13-panel-after-navigation.png');

  // Phase 2: a real mouse click on a related link. An outside click closes the dropdown (by design); the toolbar
  // must follow the new video and the reopened panel must show its qualities.
  const link2 = await waitFor('another related video link', () => page.evaluate((avoid) => {
    const all = Array.from(document.querySelectorAll('ytd-watch-flexy #secondary #related a[href*="/watch?v="]')).filter((a) => !/[?&]list=/.test(a.getAttribute('href') || ''));
    for (const a of all) {
      const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(a.getAttribute('href') || '');
      if (!m || avoid.includes(m[1])) continue;
      a.scrollIntoView({ block: 'center' });
      const r = a.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!(r.width > 0 && r.height > 0) || !top || !(a === top || a.contains(top))) continue;
      return { id: m[1], x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }, [V_ZOO, link.id]), 30000, 600).catch(() => null);
  if (check('a second related link is clickable with the mouse', !!link2, link2)) {
    await sleep(300);
    await page.mouse.click(link2.x, link2.y, { delay: 40 });
    const nav2 = await waitFor('SPA navigation by mouse', () => iso((id) => AYT.page.videoId === id, link2.id), 20000, 300).catch(() => false);
    const state2 = await waitFor('toolbar for the new video', () => iso((id) => (AYT.page.videoId === id && AYT.toolbar.mounted ? { open: AYT.toolbar.isOpen('video') } : null), link2.id), 20000, 300).catch(() => null);
    check('mouse click navigates (SPA), closes the dropdown (outside click) and the toolbar follows', !!nav2 && !!state2 && !state2.open && (await page.evaluate(() => window.__aytE2eSameDocument === true)), { to: link2.id, state: state2 });
    await openPanelByClick('video');
    const exp2 = await iso(async (id) => {
      const info = await AYT.videoInfo.get(id);
      const tr = AYT.dl.trackOptions(info)[0] || null;
      return AYT.dl.buildVideoOptions(info, { container: AYT.settings.get('videoContainer') || 'mp4', codec: AYT.settings.get('videoCodec') || 'auto', trackId: tr ? tr.value : null, audioLang: tr ? tr.lang : null }).map((o) => o.key);
    }, link2.id);
    const rows2 = await waitFor('reopened panel rows', async () => {
      const r = await videoRows();
      return r.length && JSON.stringify(r.map((x) => x.key)) === JSON.stringify(exp2) ? r : null;
    }, 40000, 500).catch(async () => videoRows());
    check('the reopened video panel shows the new video\'s qualities', JSON.stringify(rows2.map((x) => x.key)) === JSON.stringify(exp2), { rows: rows2.map((r) => r.res) });
    await shotPanel('j13-panel-reopened-after-mouse-navigation.png');
  }
  const errs = report.console.slice(consoleStart).filter((c) => c.journey === 13);
  check('no console errors from the extension (tab, SW) during the navigation', errs.length === 0, errs.map((c) => `${c.source} ${c.type}: ${c.text.slice(0, 160)}`));
}

/* ---------------------------------------------------------------- 14 (extra) */
/**
 * Subtitles companion fallback (MEDIA -> BACKGROUND -> COMPANION): the in-browser caption fetch is made to fail
 * like a refused YouTube token (fault injection: AYT.videoInfo.fetchCaptions rejects with code 'no_token'), then
 * the real Download button must hand the job to the companion, which writes TXT / SRT into outputDir.
 */
async function j14() {
  await openWatch(V_DUB);
  await openPanelByClick('subtitles');
  await waitFor('subtitles panel', () => iso(() => {
    const r = document.getElementById('ayt-portal-host').shadowRoot;
    const sel = r.querySelector('.ayt-subs select');
    return !!(sel && sel.options.length && r.querySelector('.ayt-subs .ayt-btn--primary'));
  }), 40000);
  const langs = await iso(() => Array.from(document.getElementById('ayt-portal-host').shadowRoot.querySelectorAll('.ayt-subs select')[0].options).map((o) => ({ value: o.value, label: o.textContent.trim() })));
  const en = langs.find((o) => /^English\b/.test(o.label) && !/auto/i.test(o.label));
  if (!check('a manual English track is listed', !!en, langs.map((o) => o.label).slice(0, 8))) return;
  await selectDeep(PORTAL, '.ayt-subs select', en.value, 0);
  await iso(() => {
    globalThis.__aytE2eFetchCaptions = AYT.videoInfo.fetchCaptions;
    AYT.videoInfo.fetchCaptions = () => Promise.reject(Object.assign(new Error('e2e: in-browser caption fetch disabled'), { code: 'no_token' }));
    return true;
  });
  const companionText = {};
  try {
    for (const fmt of ['txt', 'srt']) {
      await clickDeep(PORTAL, `.ayt-subs .ayt-radio[data-value="${fmt}"]`);
      const before = await jobIds();
      await clickDeep(PORTAL, '.ayt-subs .ayt-media-actions .ayt-btn--primary');
      const job = await waitNewJob(before, (j) => j.kind === 'subtitle' && j.videoId === V_DUB, 30000);
      evidence('task_' + fmt, job.task);
      check(`${fmt.toUpperCase()}: the failed in-browser path starts a companion subtitle job`, job.task.subLang === 'en' && job.task.subAuto === false && job.task.subFormat === fmt && !job.task.subTranslateTo, { subLang: job.task.subLang, subAuto: job.task.subAuto, subFormat: job.task.subFormat, label: job.label });
      const ui = await waitFor('companion notice + job in the panel', () => iso(() => {
        // the notice sits in .ayt-subs__fallback; the job list is always mounted right below it (not inside it)
        const subs = document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-subs');
        const fb = subs && subs.querySelector('.ayt-subs__fallback');
        const n = fb && fb.querySelector('.ayt-notice');
        const jobs = subs ? subs.querySelectorAll('.ayt-job') : [];
        return n && jobs.length ? { notice: n.textContent.replace(/\s+/g, ' ').trim(), jobs: jobs.length } : null;
      }), 15000, 300).catch(() => null);
      check(`${fmt.toUpperCase()}: the panel says the companion took over and lists the job`, !!ui, ui);
      const done = await waitJobEnd(job.id, 180000);
      evidence('job_' + fmt, slimJob(done));
      if (!check(`${fmt.toUpperCase()}: companion job done`, done.status === 'done', slimJob(done))) {
        evidence('hostLog', hostLogTail());
        continue;
      }
      const ok = done.filePath && fs.existsSync(done.filePath) && insideDir(done.filePath, COMPANION_DL);
      const text = ok ? fs.readFileSync(done.filePath, 'utf8') : '';
      if (ok) companionText[fmt] = text;
      let val;
      if (fmt === 'srt') val = validateSrt(text);
      else {
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        val = { lines: lines.length, timestamps: (text.match(/\d{2}:\d{2}:\d{2}[,.]\d{3}/g) || []).length, tags: (text.match(/<[^>]+>/g) || []).length, first: lines.slice(0, 2) };
      }
      evidence('file_' + fmt, { path: done.filePath, validation: val });
      const good = fmt === 'srt' ? val.cues > 50 && val.problemCount === 0 : val.lines > 20 && val.timestamps === 0 && val.tags === 0;
      check(`${fmt.toUpperCase()}: "<title> (en).${fmt}" in outputDir with valid content`, ok && new RegExp(`\\(en\\)\\.${fmt}$`).test(done.filePath) && good, { file: done.filePath && path.basename(done.filePath), ...val });
    }
    await shotPanel('j14-subtitles-companion-fallback.png');
  } finally {
    await iso(() => {
      if (globalThis.__aytE2eFetchCaptions) AYT.videoInfo.fetchCaptions = globalThis.__aytE2eFetchCaptions;
      return true;
    }).catch(() => {});
  }
  // Parity: the same format must give the same text whichever path made it. The in-browser path (real fetch restored)
  // needs the player's caption token -> play the video first.
  if (!Object.keys(companionText).length) return;
  await quietPlayer(false);
  const play = await ensurePlaying(V_DUB).catch((e) => ({ error: e.message }));
  evidence('parityPlayback', play);
  const norm = (s) => String(s).replace(/^﻿/, '').replace(/\r\n/g, '\n').trimEnd();
  for (const fmt of Object.keys(companionText)) {
    const browser = await iso(async (vid, f) => {
      try {
        const info = await AYT.videoInfo.get(vid);
        const track = info.captions.tracks.find((t) => t.lang === 'en' && !t.isAuto);
        const out = await AYT.captions.prepare({ videoId: vid, track, tlang: '', format: f, info });
        return { text: out.text };
      } catch (e) {
        return { error: (e && e.message) || String(e), code: e && e.code };
      }
    }, V_DUB, fmt);
    const a = norm(browser.text || '').split('\n');
    const b = norm(companionText[fmt]).split('\n');
    let diff = null;
    for (let i = 0; i < Math.max(a.length, b.length) && !diff; i++) if (a[i] !== b[i]) diff = { line: i + 1, inBrowser: a[i], companion: b[i] };
    evidence('parity_' + fmt, { inBrowserLines: a.length, companionLines: b.length, firstDifference: diff, error: browser.error || null });
    check(`${fmt.toUpperCase()}: the companion file reads exactly like the in-browser ${fmt.toUpperCase()} of the same track`, !browser.error && !diff, { inBrowserLines: a.length, companionLines: b.length, firstDifference: diff, error: browser.error || null });
  }
  await quietPlayer(false);
}

/* ---------------------------------------------------------------- 15 (extra) */
/** Popup quick button on a YouTube tab (PAGES -> BACKGROUND -> COMPANION): "MP3 · 192 kbps" -> done, live list. */
async function j15() {
  await openWatch(V_ZOO);
  const { page: p, mode } = await openActionPopup();
  evidence('popupMode', mode);
  try {
    const card = await waitFor('the "This video" card', () => p.evaluate(() => {
      const c = document.querySelector('.pp-video');
      const b = c && c.querySelector('.pp-video__actions button[data-action="audio"]');
      return c && b ? { title: ((c.querySelector('.pp-video__title') || {}).textContent || '').trim(), id: ((c.querySelector('.pp-video__id') || {}).textContent || '').trim(), audio: b.textContent.trim(), audioDisabled: b.disabled, pill: ((document.querySelector('.pp-header') || {}).textContent || '').replace(/\s+/g, ' ').trim() } : null;
    }), 20000, 300);
    evidence('card', card);
    check('popup shows "This video" for the YouTube tab with an enabled MP3 quick button', card.id === V_ZOO && /zoo/i.test(card.title) && /MP3/.test(card.audio) && !card.audioDisabled, card);
    const before = await jobIds();
    const r = await p.evaluate(() => {
      const b = document.querySelector('.pp-video__actions button[data-action="audio"]');
      b.scrollIntoView({ block: 'center' });
      const x = b.getBoundingClientRect();
      return { x: x.left + x.width / 2, y: x.top + x.height / 2 };
    });
    await p.mouse.click(r.x, r.y, { delay: 40 });
    const job = await waitNewJob(before, (j) => j.kind === 'audio' && j.videoId === V_ZOO, 20000);
    evidence('task', job.task);
    check('quick button starts an MP3 192 kbps job of the whole video', job.task.audioFormat === 'mp3' && job.task.bitrate === 192 && !job.task.section, { audioFormat: job.task.audioFormat, bitrate: job.task.bitrate, section: job.task.section, label: job.label });
    const live = await waitFor('the popup list shows the job completed', () => p.evaluate((job) => {
      const labels = [job.label || ''];
      try {
        const U = globalThis.AYT && globalThis.AYT.util;
        if (U && U.jobLabel) labels.push(U.jobLabel(job) || '');
      } catch (_) {}
      const wanted = labels.filter(Boolean);
      const it = Array.from(document.querySelectorAll('.ayt-job')).find((x) => {
        const text = ((x.querySelector('.ayt-job__title') || {}).textContent || '');
        return !wanted.length || wanted.some((l) => text.includes(l));
      });
      return it && it.querySelector('.ayt-job__meta .is-done') ? { title: it.querySelector('.ayt-job__title').textContent.trim(), meta: it.querySelector('.ayt-job__meta').textContent.trim() } : null;
    }, job), 240000, 500).catch(() => null);
    const done = await waitJobEnd(job.id, 30000);
    evidence('job', slimJob(done));
    check('job done and the open popup updated live to "Completed"', done.status === 'done' && !!live, { status: done.status, popup: live });
    const exists = done.filePath && fs.existsSync(done.filePath) && insideDir(done.filePath, COMPANION_DL);
    const probe = exists ? ffprobe(done.filePath) : null;
    const a = probe && probe.streams.find((s) => s.type === 'audio');
    evidence('ffprobe', probe);
    check('.mp3 of the whole video (~19 s, 192 kbps) in outputDir', exists && a && a.codec === 'mp3' && Math.abs(probe.format.duration - 19) < 1.5 && Math.abs((a.bitRate || 0) - 192000) <= 8000, { file: done.filePath && path.basename(done.filePath), duration: probe && probe.format.duration, bitRate: a && a.bitRate });
    const file = path.join(SHOTS, 'j15-popup-quick-mp3.png');
    await p.screenshot({ path: file });
    current.shots.push(file);
  } finally {
    await p.close().catch(() => {});
    await page.bringToFront().catch(() => {});
  }
}

/* ---------------------------------------------------------------- 16 (extra) */
/**
 * Dubbed audio (DOWNLOADS -> BACKGROUND -> COMPANION): pick the Turkish dub in the video panel's audio-language select
 * and download a 10 s clip at the lowest resolution. The file's audio stream must be the Turkish track: yt-dlp tags
 * every stream with its format's language (--embed-metadata), so a selector that silently fell back to the original
 * English track would show 'eng'.
 */
async function j16() {
  await openWatch(V_DUB);
  await openPanelByClick('video');
  await waitVideoRows();
  const langs = await iso(() => {
    const sel = document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-dl-lang select');
    return sel ? Array.from(sel.options).map((o) => ({ value: o.value, label: o.textContent.trim() })) : [];
  });
  evidence('audioLanguages', langs.map((o) => `${o.label} [${o.value}]`));
  const tr = langs.find((o) => /^Turkish\b/.test(o.label));
  if (!check('the audio-language select lists the Turkish dub', !!tr, langs.map((o) => o.label).slice(0, 30))) return;
  await selectDeep(PORTAL, '.ayt-dl-lang select', tr.value);
  await clickDeep(PORTAL, '.ayt-video-clip-toggle');
  await waitFor('clip editor', () => iso(() => !!document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-video-clip .ayt-input--time')), 8000, 200);
  await typeDeep(PORTAL, '.ayt-video-clip .ayt-dl-range__time:nth-child(1) .ayt-input--time', '00:00:10');
  await typeDeep(PORTAL, '.ayt-video-clip .ayt-dl-range__time:nth-child(2) .ayt-input--time', '00:00:20');
  let rows = await waitVideoRows();
  const num = (r) => parseInt(r.res, 10) || 1e9;
  const lowest = rows.slice().sort((a, b) => num(a) - num(b))[0];
  if (lowest.hidden) {
    await clickDeep(PORTAL, '.ayt-video-more');
    await sleep(400);
    rows = await videoRows();
  }
  await shotPanel('j16-turkish-dub-clip.png');
  const before = await jobIds();
  await clickDeep(PORTAL, `.ayt-video-row[data-key="${lowest.key}"]`);
  const job = await waitNewJob(before, (j) => j.kind === 'video' && j.videoId === V_DUB);
  evidence('task', job.task);
  check('task: Turkish audio (audioLang tr), section 10–20 s, label names the language', job.task.audioLang === 'tr' && !!job.task.section && job.task.section.start === 10 && job.task.section.end === 20 && /Turkish/.test(job.label), { audioLang: job.task.audioLang, section: job.task.section, height: job.task.height, label: job.label });
  const done = await waitJobEnd(job.id, 240000);
  evidence('job', slimJob(done));
  if (!check('job finished: done', done.status === 'done', slimJob(done))) {
    evidence('hostLog', hostLogTail());
    return;
  }
  const exists = done.filePath && fs.existsSync(done.filePath) && insideDir(done.filePath, COMPANION_DL);
  const probe = exists ? ffprobe(done.filePath) : null;
  evidence('ffprobe', probe);
  const a = probe && probe.streams.find((s) => s.type === 'audio');
  const v = probe && probe.streams.find((s) => s.type === 'video' && !s.cover);
  const dur = probe && probe.format ? probe.format.duration : NaN;
  check('the file has video + the Turkish audio track (ffprobe stream language "tur")', !!v && !!a && a.lang === 'tur', { file: done.filePath && path.basename(done.filePath), video: v && `${v.codec} ${v.width}x${v.height}`, audio: a && `${a.codec} lang=${a.lang}` });
  check('clip length ~10 s (keyframe cut)', Math.abs(dur - 10) <= 2, { duration: dur });
  // the whole video has 11 chapters (0-937 s): none of them belong in a 10 s clip; the cover must be a JPEG
  const cover = probe && probe.streams.find((s) => s.cover);
  check('the clip carries no chapters of the whole video and a JPEG cover (not a ~1.4 MB PNG)', !!probe && probe.chapters === 0 && !!cover && cover.codec === 'mjpeg', { chapters: probe && probe.chapters, cover: cover && `${cover.codec} ${cover.width}x${cover.height}`, fileSize: exists ? fs.statSync(done.filePath).size : null });
  await shotPanel('j16-turkish-dub-done.png');

  // the same through the audio panel: MP3 of 00:00:10-00:00:20 of the Turkish dub
  await openPanelByClick('audio');
  await waitFor('audio panel with the language select', () => iso(() => {
    const r = document.getElementById('ayt-portal-host').shadowRoot;
    return !!(r.querySelector('.ayt-audio-go') && r.querySelector('.ayt-audio-range .ayt-input--time') && r.querySelector('.ayt-dl-lang select'));
  }), 40000);
  await selectDeep(PORTAL, '.ayt-dl-lang select', tr.value);
  await clickDeep(PORTAL, '.ayt-audio-formats .ayt-seg__opt[data-value="mp3"]');
  await typeDeep(PORTAL, '.ayt-audio-range .ayt-dl-range__time:nth-child(1) .ayt-input--time', '00:00:10');
  await typeDeep(PORTAL, '.ayt-audio-range .ayt-dl-range__time:nth-child(2) .ayt-input--time', '00:00:20');
  const beforeAudio = await jobIds();
  await clickDeep(PORTAL, '.ayt-audio-go');
  const aJob = await waitNewJob(beforeAudio, (j) => j.kind === 'audio' && j.videoId === V_DUB);
  evidence('audioTask', aJob.task);
  const aDone = await waitJobEnd(aJob.id, 240000);
  evidence('audioJob', slimJob(aDone));
  const aOk = aDone.status === 'done' && aDone.filePath && fs.existsSync(aDone.filePath) && insideDir(aDone.filePath, COMPANION_DL);
  const aProbe = aOk ? ffprobe(aDone.filePath) : null;
  evidence('audioFfprobe', aProbe);
  if (!aOk) evidence('hostLog', hostLogTail());
  const aDur = aProbe && aProbe.format ? aProbe.format.duration : NaN;
  check('audio panel: Turkish MP3 clip 10–20 s done, exactly 10 s, no chapters of the whole video', !!aOk && aJob.task.audioLang === 'tr' && Math.abs(aDur - 10) <= 0.2 && aProbe.chapters === 0, { status: aDone.status, audioLang: aJob.task.audioLang, label: aJob.label, duration: aDur, chapters: aProbe && aProbe.chapters, file: aDone.filePath && path.basename(aDone.filePath), error: aDone.error });
}

const JOURNEYS = [
  { id: 1, name: 'watch page: toolbar above the title in spec order; companion connected (no install notice)', run: j1 },
  { id: 2, name: 'video panel: lowest-resolution row -> done; file + ffprobe; row progress; popup lists it', run: j2, timeoutMs: 420000 },
  { id: 3, name: 'audio panel: MP3 192 kbps, 00:00:03-00:00:09 -> 6.0 s @ 192k', run: j3, timeoutMs: 420000 },
  { id: 4, name: 'clip: GIF of 00:00:05-00:00:08 -> .gif', run: j4, timeoutMs: 420000 },
  { id: 5, name: 'subtitles (KrLj6nc516A): SRT English, TXT, translated en->tr', run: j5 },
  { id: 6, name: 'thumbnail: Maximum as PNG -> 1280x720 .png', run: j6 },
  { id: 7, name: 'screenshot button -> image at the native video resolution', run: j7 },
  { id: 8, name: 'cancel a 1080p download -> canceled, processes gone within 10 s, no temp leftovers', run: j8, timeoutMs: 420000 },
  { id: 9, name: 'hide comments toggle: comments hidden + pill; toggle back', run: j9 },
  { id: 10, name: 'Shorts: injected button -> popover -> MP3 download done', run: j10, timeoutMs: 420000 },
  { id: 11, name: 'options page: Companion section connected with tool versions', run: j11 },
  { id: 12, name: 'error path: made-up video id -> job error with a friendly message', run: j12 },
  { id: 13, name: 'SPA navigation with the video panel open -> panel reloads, no console errors', run: j13 },
  { id: 14, name: '(extra) subtitles companion fallback: in-browser fetch fails -> companion TXT + SRT', run: j14, timeoutMs: 420000 },
  { id: 15, name: '(extra) popup on a YouTube tab: quick "MP3 · 192 kbps" -> done, live list', run: j15, timeoutMs: 420000 },
  { id: 16, name: '(extra) dubbed audio: Turkish track picked in the video panel -> clip with the Turkish audio stream', run: j16, timeoutMs: 420000 },
];

/* ================================================================== setup + runner */
function writeDownloadPrefs(profileDir) {
  const file = path.join(profileDir, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefs = {};
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    prefs = {};
  }
  prefs.download = Object.assign({}, prefs.download, { default_directory: BROWSER_DL, prompt_for_download: false, directory_upgrade: true });
  prefs.savefile = Object.assign({}, prefs.savefile, { default_directory: BROWSER_DL });
  fs.writeFileSync(file, JSON.stringify(prefs));
}

async function verifyDownloadDir() {
  const probe = await H.evaluateInExtensionPage(async () => {
    const id = await chrome.downloads.download({ url: 'data:text/plain;base64,YXl0LWludGVncmF0aW9u', filename: 'ayt-integration-probe.txt', conflictAction: 'uniquify', saveAs: false });
    for (let i = 0; i < 80; i++) {
      const [it] = await chrome.downloads.search({ id });
      if (it && it.state !== 'in_progress') return { id, state: it.state, filename: it.filename };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { id, state: 'timeout' };
  });
  if (page) await page.bringToFront().catch(() => {});
  const ok = !!probe.filename && insideDir(probe.filename, BROWSER_DL);
  if (ok) fs.rmSync(probe.filename, { force: true });
  return { ok, probe };
}

async function runJourney(j, attempt = 1) {
  const rec = { id: j.id, name: j.name, attempt, result: 'fail', checks: [], evidence: {}, shots: [], consoleErrors: [], durationS: 0 };
  current = rec;
  report.journeys.push(rec);
  log(`\n=== J${j.id}: ${j.name}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
  const t = Date.now();
  let timer = 0;
  let infraError = null;
  try {
    await Promise.race([
      j.run(rec),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`journey timed out after ${(j.timeoutMs || 300000) / 1000} s`)), j.timeoutMs || 300000);
      }),
    ]);
  } catch (e) {
    const msg = String((e && e.stack) || e);
    check('journey ran to the end', false, msg.split('\n').slice(0, 4).join(' | '));
    if (isFlake(e) || /journey timed out|crash/i.test(msg)) infraError = msg.split('\n')[0];
    await shot(`j${String(j.id).padStart(2, '0')}-failure.png`).catch(() => {});
  } finally {
    clearTimeout(timer);
  }
  rec.consoleErrors = report.console.filter((c) => c.journey === j.id);
  rec.durationS = Math.round((Date.now() - t) / 100) / 10;
  rec.result = rec.checks.length > 0 && rec.checks.every((c) => c.ok) ? 'pass' : 'fail';
  log(`=== J${j.id} ${rec.result.toUpperCase()} (${rec.durationS} s, ${rec.checks.filter((c) => c.ok).length}/${rec.checks.length} checks${rec.consoleErrors.length ? ', ' + rec.consoleErrors.length + ' console message(s)' : ''})`);
  current = null;
  // A browser/CDP hang (not a failed product check) gets one more attempt in a fresh tab; both attempts stay in the report.
  const onlyInfra = infraError && rec.checks.filter((c) => !c.ok).length === 1;
  if (rec.result !== 'pass' && onlyInfra && attempt === 1) {
    rec.result = 'retried';
    report.notes.push(`J${j.id}: attempt 1 hit an infrastructure error (${infraError}); retrying once`);
    log(`  J${j.id}: infrastructure error (${infraError}) -> retrying once in a fresh tab`);
    await runJourney(j, 2);
  }
}

async function main() {
  log('out: ' + OUT);
  fs.mkdirSync(OUT, { recursive: true });
  for (const d of [BROWSER_DL, COMPANION_DL]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  // replace the screenshots of the journeys that run now (others stay from earlier runs)
  const selected = JOURNEYS.filter((j) => !((ONLY && !ONLY.includes(j.id)) || SKIP.includes(j.id))).map((j) => 'j' + String(j.id).padStart(2, '0') + '-');
  for (const f of fs.readdirSync(SHOTS)) if (selected.some((p) => f.startsWith(p))) fs.rmSync(path.join(SHOTS, f), { force: true });
  if (!flag('--keep-profile')) fs.rmSync(PROFILE, { recursive: true, force: true });
  writeDownloadPrefs(PROFILE); // BEFORE launch
  report.companion = CONFIG ? { installDir: CONFIG.installDir, extensionId: CONFIG.extensionId, tools: CONFIG.tools } : null;
  if (!report.companion) note('companion config.json not found in ' + INSTALL_DIR);

  H = await launchWithExtension(EXT, { userDataDir: PROFILE, stealth: true, headless: !flag('--headful'), viewport: { width: 1500, height: 1000 } });
  page = H.page;
  report.extensionId = H.extensionId;
  report.chrome = await H.browser.version();
  log(`chrome ${report.chrome}, extension ${H.extensionId}`);
  if (!check('extension loaded with the fixed id (manifest key)', H.extensionId === EXT_ID, H.extensionId)) throw new Error('wrong extension id: the native host only allows ' + EXT_ID);
  // The service worker opens options.html#companion on install: close it, keep the test tab in front.
  const installTab = await waitFor('options tab opened on install', async () => (await H.browser.pages()).find((p) => p.url().startsWith(`chrome-extension://${EXT_ID}/options/`)) || null, 10000, 250).catch(() => null);
  report.setup.installTab = installTab ? installTab.url() : null;
  if (installTab) await installTab.close().catch(() => {});
  await page.bringToFront().catch(() => {});

  await sw();
  H.browser.on('targetcreated', (t) => {
    if (t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${EXT_ID}/`)) {
      log('  (service worker target created)');
      swCache = null;
    }
    // the action popup: capture its console from the first script on
    if (t.type() === 'page' && t.url().startsWith(`chrome-extension://${EXT_ID}/popup/`)) pageForTarget(t).catch(() => {});
  });
  // settings.outputDir from the service worker (individual storage keys: 'settings.<name>')
  await swEval((dir) => chrome.storage.local.set({ 'settings.outputDir': dir }), COMPANION_DL);
  const applied = await waitFor('outputDir in the SW settings', () => swEval(() => AYT.settings.get('outputDir')).then((v) => v || null), 10000, 300).catch(() => null);
  check('settings.outputDir set from the service worker', applied === COMPANION_DL, applied);
  const dl = await verifyDownloadDir();
  check('browser downloads go to browser-dl (profile preference)', dl.ok, dl.probe);
  if (!dl.ok) throw new Error('download.default_directory not honored');

  for (const j of JOURNEYS) {
    if ((ONLY && !ONLY.includes(j.id)) || SKIP.includes(j.id)) continue;
    await runJourney(j);
  }
  return 0;
}

/** The last attempt of every journey that ran. */
function finalRecords() {
  const byId = new Map();
  for (const r of report.journeys) byId.set(r.id, r);
  return [...byId.values()];
}

if (flag('--list')) {
  for (const j of JOURNEYS) console.log(`${String(j.id).padStart(2)}  ${j.name}`);
  process.exit(0);
}

let exitCode = 1;
try {
  exitCode = await main();
  if (finalRecords().some((j) => j.result !== 'pass')) exitCode = 1;
} catch (e) {
  log('FATAL ' + String((e && e.stack) || e));
  report.fatal = String((e && e.stack) || e);
  exitCode = 1;
} finally {
  if (H) await H.close();
  report.finishedAt = new Date().toISOString();
  if (report.journeys.length) {
    log('\n================ SUMMARY ================');
    for (const j of finalRecords()) {
      const bad = j.checks.filter((c) => !c.ok).map((c) => c.name);
      log(`${j.result === 'pass' ? 'PASS' : 'FAIL'}  J${String(j.id).padStart(2)}  ${j.name}${j.attempt > 1 ? ' (2nd attempt after an infrastructure error)' : ''}${bad.length ? '\n          failed: ' + bad.join('; ') : ''}`);
    }
    report.summary = finalRecords().map((j) => ({ id: j.id, result: j.result, attempt: j.attempt, checks: `${j.checks.filter((c) => c.ok).length}/${j.checks.length}` }));
    const ours = report.console.filter((c) => !/^warn/.test(c.type));
    log(`console: ${ours.length} error(s) and ${report.console.length - ours.length} warning(s) from the extension; ${report.foreignConsoleCount} message(s) from YouTube itself (ignored)`);
  }
  if (!flag('--keep-media')) {
    let removed = 0;
    for (const d of [BROWSER_DL, COMPANION_DL]) {
      removed += listFiles(d).length;
      fs.rmSync(d, { recursive: true, force: true });
    }
    report.mediaDeleted = removed;
    log(`deleted ${removed} downloaded file(s); screenshots kept in ${SHOTS}`);
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  log('report: ' + path.join(OUT, 'report.json'));
}
process.exit(exitCode);
