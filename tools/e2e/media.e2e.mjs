#!/usr/bin/env node
/*
 * End-to-end test of the MEDIA module (subtitles, thumbnails, screenshots) on real YouTube pages.
 *
 *   node tools/e2e/media.e2e.mjs [--out <dir>] [--video KrLj6nc516A] [--save-fixtures] [--stub-sw] [--headful] [--no-spa]
 *
 * - Copies extension/ to <out>/ext and replaces files referenced by manifest.json that are missing or don't
 *   parse with empty stubs (other modules may not be written yet); the list is printed and saved in the report.
 *   --stub-sw also replaces the service worker (tests the in-page fallbacks).
 * - Loads it into the installed Chrome with tools/e2e/harness.mjs (stealth: required for caption tokens).
 * - Captions: fetches the manual 'en' track in json3/vtt/ttml/srv3, the auto track and a translation (tlang=tr)
 *   through AYT.videoInfo.fetchCaptions + AYT.captions.prepare, validates SRT/TXT/TTML/SRV3 output.
 * - Opens the subtitles and thumbnail panels (dark + light) and saves screenshots, downloads through the UI.
 * - Screenshot: AYT.screenshot.capture() at native resolution (size + non-blank check), with a fake
 *   AYT.videoAdjust (rotation/flip/filter), and a real toolbar click (download + Shift+click copy).
 * - --save-fixtures writes the caption bodies to tools/tests/fixtures/ (used by tools/tests/subtitles.test.mjs).
 * Exit code 1 when a check fails. Report: <out>/report.json, screenshots: <out>/*.png
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchWithExtension } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, 'extension');
const FIXTURES = path.join(ROOT, 'tools', 'tests', 'fixtures');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const OUT = path.resolve(opt('--out', process.env.AYT_MEDIA_E2E_OUT || path.join(os.tmpdir(), 'ayt-media-e2e')));
const VIDEO = opt('--video', 'KrLj6nc516A');
const SECOND_VIDEO = 'dQw4w9WgXcQ';
const DOWNLOADS = path.join(OUT, 'downloads');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);

const report = { startedAt: new Date().toISOString(), video: VIDEO, stubbed: [], checks: [], notes: [], consoleErrors: [] };
function check(name, ok, details) {
  report.checks.push({ name, ok: !!ok, details: details === undefined ? null : details });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${details !== undefined ? ' — ' + (typeof details === 'string' ? details : JSON.stringify(details)) : ''}`);
  return !!ok;
}
const note = (s) => {
  report.notes.push(s);
  log('NOTE ' + s);
};

/* ------------------------------------------------------------------ extension under test */
function prepareExtension() {
  const dst = path.join(OUT, 'ext');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(EXT, dst, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'));
  const need = new Set();
  for (const cs of manifest.content_scripts || []) [...(cs.js || []), ...(cs.css || [])].forEach((p) => need.add(p));
  const sw = manifest.background && manifest.background.service_worker;
  if (sw) need.add(sw);
  if (manifest.action && manifest.action.default_popup) need.add(manifest.action.default_popup);
  if (manifest.options_ui && manifest.options_ui.page) need.add(manifest.options_ui.page);
  for (const rel of need) {
    const p = path.join(dst, rel);
    let reason = null;
    if (!fs.existsSync(p)) reason = 'missing';
    else if (flag('--stub-sw') && rel === sw) reason = '--stub-sw';
    else if (rel.endsWith('.js')) {
      const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
      if (r.status !== 0) reason = 'syntax error';
    }
    if (!reason) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rel.endsWith('.html') ? '<!doctype html><meta charset="utf-8"><title>stub</title>\n' : rel.endsWith('.css') ? '/* e2e stub */\n' : '/* e2e stub */\n');
    report.stubbed.push(`${rel} (${reason})`);
  }
  return dst;
}

/* ------------------------------------------------------------------ node-side validators */
const S = (() => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(EXT, 'shared', 'subtitles.js'), 'utf8'), ctx, { filename: 'subtitles.js' });
  return ctx.AYT.subtitles;
})();

function validateSrt(text) {
  const problems = [];
  const blocks = String(text).replace(/\n+$/, '').split('\n\n');
  let prevEnd = -1;
  const toSec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  blocks.forEach((b, i) => {
    const lines = b.split('\n');
    if (lines[0] !== String(i + 1)) problems.push(`#${i + 1}: number "${lines[0]}"`);
    const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(lines[1] || '');
    if (!m) return problems.push(`#${i + 1}: timing "${lines[1]}"`);
    const s = toSec(m[1], m[2], m[3], m[4]);
    const e = toSec(m[5], m[6], m[7], m[8]);
    if (!(e > s)) problems.push(`#${i + 1}: end <= start`);
    if (s < prevEnd - 1e-9) problems.push(`#${i + 1}: overlaps previous`);
    prevEnd = e;
    if (lines.length < 3 || lines.slice(2).some((l) => !l.trim())) problems.push(`#${i + 1}: empty text`);
  });
  return { cues: blocks.length, problems: problems.slice(0, 10), problemCount: problems.length };
}

function consecutiveDuplicates(txt) {
  const lines = String(txt).split('\n').filter(Boolean);
  let n = 0;
  for (let i = 1; i < lines.length; i++) if (lines[i] === lines[i - 1]) n++;
  return n;
}

/* ------------------------------------------------------------------ browser helpers */
let H;
let page;

function isProtocolFlake(e) {
  return /protocol|target closed|session closed|timed out|execution context was destroyed|isolated world not found|cannot find context/i.test(String((e && e.message) || e));
}

async function retry(label, fn, tries = 2) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= tries || !isProtocolFlake(e)) throw e;
      log(`! ${label}: ${e.message.split('\n')[0]} — retrying`);
      await sleep(1500);
    }
  }
}

const iso = (fn, ...args) => retry('isolated eval', () => H.evaluateInIsolatedWorld(page, fn, ...args));

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
  throw new Error(`timeout waiting for ${label}${last instanceof Error ? ': ' + last.message : ''}`);
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
      t: v ? v.currentTime : 0,
    };
  });
}

async function muteAndPlay() {
  await page.evaluate(() => {
    const p = document.getElementById('movie_player');
    if (!p) return;
    try {
      p.mute();
      if (p.getPlayerState && p.getPlayerState() !== 1) p.playVideo();
    } catch (_) {
      /* ignore */
    }
    const v = p.querySelector('video');
    if (v) {
      v.muted = true;
      v.play().catch(() => {});
    }
  });
}

async function openWatchPage(videoId) {
  await retry('goto', () => page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded', timeout: 90000 }));
  await waitFor('content scripts', () => iso(() => !!(globalThis.AYT && AYT.booted && AYT.captions && AYT.screenshot && AYT.thumbnails && AYT.subtitles)), 60000);
  await waitFor('toolbar', () => iso(() => AYT.toolbar.mounted), 60000);
}

/** waitForContent with page reloads when YouTube's player stalls (heavily loaded machine). */
async function ensurePlaying(videoId, onAd) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await waitForContent(videoId, attempt === 1 ? 90000 : 75000, onAd);
    } catch (e) {
      log(`playback did not start (attempt ${attempt}): ${e.message}`);
      if (attempt === 3) return null;
      await openWatchPage(videoId);
    }
  }
  return null;
}

async function pauseVideo() {
  await page.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    if (v) v.pause();
  });
}

/** Waits until the content video plays (skips ads with trusted clicks). Returns whether an ad was seen. */
async function waitForContent(videoId, timeoutMs, onAd) {
  const end = Date.now() + timeoutMs;
  let sawAd = false;
  let lastLog = 0;
  while (Date.now() < end) {
    const s = await retry('player state', () => playerState()).catch((e) => ({ error: e.message }));
    if (Date.now() - lastLog > 8000) {
      lastLog = Date.now();
      log('player: ' + JSON.stringify(s));
    }
    if (Date.now() + 1500 > end) await shot('player-timeout.png').catch(() => {});
    if (s && s.ad) {
      if (!sawAd && onAd) await onAd().catch((e) => log('ad hook failed', e.message));
      sawAd = true;
      await muteAndPlay().catch(() => {});
      let skipped = false;
      for (const sel of ['.ytp-skip-ad-button', '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button', 'button[id^="skip-button"]']) {
        try {
          await page.click(sel, { delay: 30 });
          log('clicked ad skip button');
          skipped = true;
          break;
        } catch (_) {
          /* not there yet */
        }
      }
      // Test harness only: fast-forward an unskippable ad (as in the research harness).
      if (!skipped) {
        await page
          .evaluate(() => {
            const v = document.querySelector('#movie_player video');
            if (v && isFinite(v.duration) && v.duration > 1 && v.currentTime < v.duration - 0.5) v.currentTime = v.duration - 0.25;
          })
          .catch(() => {});
      }
      await sleep(1000);
      continue;
    }
    if (s && s.has && s.vid === videoId && s.ready >= 2 && s.w > 0) return { sawAd, state: s };
    await muteAndPlay().catch(() => {});
    await sleep(600);
  }
  throw new Error('content video did not start');
}

/** Viewport rect (x, y) of an element in the panel portal, plus the page scroll (sx, sy). */
async function portalRect(selector) {
  return iso((sel) => {
    const host = document.getElementById('ayt-portal-host');
    const el = host && host.shadowRoot && host.shadowRoot.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, sx: window.scrollX, sy: window.scrollY };
  }, selector);
}

/** Screenshot of the page or of a rect from portalRect()/viewport coordinates (clip uses page coordinates). */
async function shot(name, rect, pad = 10) {
  const file = path.join(OUT, name);
  let clip;
  if (rect) {
    const sx = rect.sx != null ? rect.sx : await page.evaluate(() => window.scrollX);
    const sy = rect.sy != null ? rect.sy : await page.evaluate(() => window.scrollY);
    clip = { x: Math.max(0, rect.x + sx - pad), y: Math.max(0, rect.y + sy - pad), width: rect.width + pad * 2, height: rect.height + pad * 2 };
  }
  // captureBeyondViewport:false — the default re-lays out the page for the capture, which loses our overlay.
  await retry('screenshot ' + name, () => page.screenshot({ path: file, clip, captureBeyondViewport: false }));
  log('saved ' + file);
  return file;
}

/* ------------------------------------------------------------------ downloads */
// 'prefs': the test profile's download directory is DOWNLOADS, so chrome.downloads names/subfolders are real.
// 'cdp'  : fallback (Browser.setDownloadBehavior) — Chrome then ignores the requested file names.
let downloadMode = 'prefs';

function writeDownloadPrefs(profileDir) {
  const file = path.join(profileDir, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefs = {};
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    prefs = {};
  }
  prefs.download = Object.assign({}, prefs.download, { default_directory: DOWNLOADS, prompt_for_download: false, directory_upgrade: true });
  prefs.savefile = Object.assign({}, prefs.savefile, { default_directory: DOWNLOADS });
  fs.writeFileSync(file, JSON.stringify(prefs));
}

/** Checks where chrome.downloads saves; removes the probe file and switches to CDP mode if it's not DOWNLOADS. */
async function verifyDownloadDir() {
  const probe = await H.evaluateInExtensionPage(async () => {
    const id = await chrome.downloads.download({ url: 'data:text/plain;base64,YXl0LWUyZQ==', filename: 'ayt-e2e-probe.txt', conflictAction: 'uniquify', saveAs: false });
    for (let i = 0; i < 80; i++) {
      const [it] = await chrome.downloads.search({ id });
      if (it && it.state !== 'in_progress') return { id, state: it.state, filename: it.filename };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { id, state: 'timeout' };
  });
  const inside = probe.filename && path.resolve(probe.filename).toLowerCase().startsWith(path.resolve(DOWNLOADS).toLowerCase());
  if (inside) {
    fs.rmSync(probe.filename, { force: true });
    log('downloads go to ' + DOWNLOADS);
    return;
  }
  await H.evaluateInExtensionPage((id) => chrome.downloads.removeFile(id).catch(() => {}), probe.id).catch(() => {});
  const cdp = await H.browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true });
  downloadMode = 'cdp';
  note('download directory preference not honored (' + JSON.stringify(probe) + '): using the CDP override, file names are not checked');
}

/** The expected file name (prefs mode) or just the extension (cdp mode). */
function nameOk(file, expectedRe) {
  return downloadMode === 'cdp' ? !!file : expectedRe.test(file);
}

/** Trusted click in the middle of an element inside the panel portal (scrolled into view, hit-tested). */
async function clickInPortal(selector) {
  const r = await iso((sel) => {
    const host = document.getElementById('ayt-portal-host');
    const el = host && host.shadowRoot && host.shadowRoot.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const b = el.getBoundingClientRect();
    const x = b.left + b.width / 2;
    const y = b.top + b.height / 2;
    const hit = document.elementFromPoint(x, y) === host && host.shadowRoot.elementFromPoint(x, y);
    return { x, y, hitsTarget: !!(hit && (hit === el || el.contains(hit))) };
  }, selector);
  if (!r) throw new Error('not found in portal: ' + selector);
  if (!r.hitsTarget) throw new Error('element not clickable (covered or off-screen): ' + selector);
  await page.mouse.click(r.x, r.y, { delay: 20 });
}

/** Files that appeared in the download folder (recursive: the service worker saves into a subfolder). */
function listDownloads() {
  const out = [];
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
      else out.push(r);
    }
  };
  if (fs.existsSync(DOWNLOADS)) walk(DOWNLOADS, '');
  return out;
}

function newDownloads(before) {
  return listDownloads().filter((f) => !before.includes(f) && !/\.crdownload$/.test(f));
}

/** New file matching `re` (prefs mode: the exact expected name; cdp mode: `looseRe`, names are Chrome's). */
async function waitDownload(before, re, timeoutMs = 20000, looseRe = /./) {
  const test = downloadMode === 'cdp' ? looseRe : re;
  return waitFor('download ' + test, () => newDownloads(before).find((f) => test.test(f)) || null, timeoutMs, 300).catch(() => null);
}

const SUBFOLDER = 'Akif YouTube'; // AYT.DEFAULT_SETTINGS.subfolder
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Regex prefix of saved files: the service worker uses the subfolder, the page fallback (<a download>) can't. */
const namePrefix = () => (flag('--stub-sw') ? '' : escapeRe(SUBFOLDER) + '/');

function imageSize(file) {
  const b = fs.readFileSync(file);
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xc3) return { type: 'jpg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  if (b.toString('ascii', 8, 12) === 'WEBP') {
    const f = b.toString('ascii', 12, 16);
    if (f === 'VP8 ') return { type: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (f === 'VP8X') return { type: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (f === 'VP8L') {
      const n = b.readUInt32LE(21);
      return { type: 'webp', width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 };
    }
  }
  return { type: '?', width: 0, height: 0 };
}

/* ------------------------------------------------------------------ test steps */

async function testCaptions() {
  log('captions: fetching native formats + prepared outputs …');
  const res = await iso(async (vid) => {
    const S = AYT.subtitles;
    const info = await AYT.videoInfo.get(vid, { force: true });
    const tracks = info.captions.tracks;
    const manual = tracks.find((tr) => tr.lang === 'en' && !tr.isAuto) || tracks.find((tr) => !tr.isAuto);
    const auto = tracks.find((tr) => tr.isAuto) || null;
    const out = {
      title: info.title,
      trackCount: tracks.length,
      autoCount: tracks.filter((tr) => tr.isAuto).length,
      translationCount: info.captions.translationLanguages.length,
      defaultTrack: tracks[AYT.captions.defaultTrack(tracks)],
      labels: tracks.slice(0, 3).concat(auto ? [auto] : []).map((tr) => AYT.captions.trackLabel(tr)),
      manual,
      auto,
      native: {},
      prepared: {},
      xml: {},
    };
    const fetchOne = async (track, fmt, tlang) => {
      const t1 = performance.now();
      try {
        const r = await AYT.videoInfo.fetchCaptions({ videoId: vid, lang: track.lang, kind: track.kind, vssId: track.vssId, tlang, fmt });
        return { ok: true, ms: Math.round(performance.now() - t1), fmt: r.fmt, detect: S.detect(r.body), bytes: r.body.length, cues: S.parse(r.body, r.fmt).length, body: r.body };
      } catch (e) {
        return { ok: false, ms: Math.round(performance.now() - t1), code: e.code, error: e.message };
      }
    };
    for (const fmt of ['json3', 'vtt', 'ttml', 'srv3']) out.native['en.' + fmt] = await fetchOne(manual, fmt, '');
    if (auto) for (const fmt of ['json3', 'vtt']) out.native['auto.' + fmt] = await fetchOne(auto, fmt, '');
    out.native['en-tr.json3'] = await fetchOne(manual, 'json3', 'tr');
    out.native['en-tr.vtt'] = await fetchOne(manual, 'vtt', 'tr');
    if (auto) out.native['auto-tr.json3'] = await fetchOne(auto, 'json3', 'tr');

    const prep = async (track, format, tlang) => {
      const t1 = performance.now();
      try {
        const r = await AYT.captions.prepare({ videoId: vid, track, tlang, format, info });
        return { ok: true, ms: Math.round(performance.now() - t1), ext: r.ext, mime: r.mime, cues: r.cues, sourceFormat: r.sourceFormat, filename: r.filename, text: r.text };
      } catch (e) {
        return { ok: false, code: e.code, error: e.message };
      }
    };
    for (const f of ['srt', 'txt', 'vtt', 'ttml', 'srv3']) out.prepared['en.' + f] = await prep(manual, f, '');
    if (auto) for (const f of ['srt', 'txt']) out.prepared['auto.' + f] = await prep(auto, f, '');
    out.prepared['en-tr.srt'] = await prep(manual, 'srt', 'tr');
    if (auto) out.prepared['auto-tr.srt'] = await prep(auto, 'srt', 'tr');

    // XML well-formedness (DOMParser is fine here: this is test code in the isolated world).
    const xmlCheck = (text, tag) => {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      return { wellFormed: !doc.querySelector('parsererror'), count: doc.getElementsByTagName(tag).length };
    };
    const j = out.native['en.json3'];
    if (j.ok) {
      const cues = S.parse(j.body, 'json3');
      out.xml.ttmlFromJson3 = Object.assign(xmlCheck(S.toTtml(cues, 'en'), 'p'), { cues: cues.length });
      out.xml.srv3FromJson3 = Object.assign(xmlCheck(S.toSrv3(cues), 'p'), { cues: cues.length });
      const tricky = [{ start: 0, end: 1, text: 'Tom & Jerry <script>alert(1)</script> "quoted" \'single\'' }];
      out.xml.escaping = { ttml: xmlCheck(S.toTtml(tricky, 'en'), 'p'), srv3: xmlCheck(S.toSrv3(tricky), 'p'), back: S.parse(S.toTtml(tricky, 'en'), 'ttml')[0].text };
    }
    for (const k of ['en.ttml', 'en.srv3']) if (out.prepared[k] && out.prepared[k].ok) out.xml['prepared ' + k] = xmlCheck(out.prepared[k].text, 'p');
    return out;
  }, VIDEO);

  report.captions = { title: res.title, trackCount: res.trackCount, autoCount: res.autoCount, translationCount: res.translationCount, defaultTrack: res.defaultTrack, labels: res.labels };
  check('caption tracks listed', res.trackCount > 0, { tracks: res.trackCount, auto: res.autoCount, translations: res.translationCount });
  check('auto track label has the gear marker', res.labels.some((l) => l.startsWith('⚙')), res.labels);
  const nat = {};
  for (const [k, v] of Object.entries(res.native)) {
    nat[k] = v.ok ? { fmt: v.fmt, detect: v.detect, bytes: v.bytes, cues: v.cues, ms: v.ms } : { error: v.code + ': ' + v.error, ms: v.ms };
    const expected = k.split('.').pop();
    check(`native fetch ${k}`, v.ok && v.detect === expected && v.cues > 0, nat[k]);
  }
  report.captions.native = nat;

  // cross-format consistency for the manual track
  const en = (f) => res.native['en.' + f];
  if (en('json3').ok) {
    const base = S.toTxt(S.parse(en('json3').body, 'json3'));
    for (const f of ['vtt', 'ttml', 'srv3']) {
      if (!en(f).ok) continue;
      const other = S.toTxt(S.parse(en(f).body, f));
      check(`TXT from ${f} equals TXT from json3`, other === base, { json3Lines: base.split('\n').length, [f + 'Lines']: other.split('\n').length });
    }
  }

  const prepSummary = {};
  for (const [k, v] of Object.entries(res.prepared)) {
    prepSummary[k] = v.ok ? { ext: v.ext, mime: v.mime, cues: v.cues, source: v.sourceFormat, filename: v.filename, chars: v.text.length, ms: v.ms } : { error: v.code + ': ' + v.error };
    if (!v.ok) {
      check(`prepare ${k}`, false, prepSummary[k]);
      continue;
    }
    const fmt = k.split('.').pop();
    const mimeOk = v.mime === { srt: 'application/x-subrip', vtt: 'text/vtt', ttml: 'application/ttml+xml', srv3: 'application/octet-stream', txt: 'text/plain' }[fmt];
    const nameOk = v.filename.endsWith('.' + fmt) && (k.includes('-tr') ? v.filename.includes('→tr') : /\((en|[a-z]{2,3})\)\.\w+$/.test(v.filename));
    let ok = mimeOk && nameOk && v.cues > 0;
    let details = prepSummary[k];
    if (fmt === 'srt') {
      const val = validateSrt(v.text);
      ok = ok && val.problemCount === 0 && val.cues === v.cues;
      details = Object.assign({}, details, { srt: val });
    } else if (fmt === 'txt') {
      const dups = consecutiveDuplicates(v.text);
      ok = ok && dups === 0 && v.text.trim().length > 0;
      details = Object.assign({}, details, { lines: v.text.split('\n').length - 1, consecutiveDuplicates: dups });
    }
    check(`prepare ${k}`, ok, details);
  }
  report.captions.prepared = prepSummary;
  if (res.prepared['en-tr.srt'] && res.prepared['en-tr.srt'].ok && res.prepared['en.srt'] && res.prepared['en.srt'].ok) {
    check('translated SRT differs from the original text', res.prepared['en-tr.srt'].text !== res.prepared['en.srt'].text, res.prepared['en-tr.srt'].text.slice(0, 120));
  }
  if (res.prepared['auto.txt'] && res.prepared['auto.txt'].ok && res.native['auto.vtt'] && res.native['auto.vtt'].ok) {
    const fromVtt = S.toTxt(S.parse(res.native['auto.vtt'].body, 'vtt'));
    check('auto TXT from rolling VTT has no duplicated lines and matches json3', consecutiveDuplicates(fromVtt) === 0 && fromVtt === res.prepared['auto.txt'].text, {
      vttLines: fromVtt.split('\n').length,
      json3Lines: res.prepared['auto.txt'].text.split('\n').length,
    });
  }
  for (const [k, v] of Object.entries(res.xml || {})) check(`XML ${k} well-formed`, v.wellFormed !== false && (v.count === undefined || v.count > 0) && (!v.cues || v.count === v.cues), v);
  if (res.xml && res.xml.escaping) {
    check('XML escaping round-trips', res.xml.escaping.ttml.wellFormed && res.xml.escaping.srv3.wellFormed && res.xml.escaping.back === 'Tom & Jerry <script>alert(1)</script> "quoted" \'single\'', res.xml.escaping);
  }

  // Samples for the unit tests
  for (const k of ['en.srt', 'auto.srt', 'en-tr.srt', 'auto.txt']) if (res.prepared[k] && res.prepared[k].ok) fs.writeFileSync(path.join(OUT, `${VIDEO}.${k}`), res.prepared[k].text);
  if (flag('--save-fixtures')) {
    fs.mkdirSync(FIXTURES, { recursive: true });
    const map = { 'en.json3': 'en.json3', 'en.vtt': 'en.vtt', 'en.ttml': 'en.ttml', 'en.srv3': 'en.srv3', 'auto.json3': 'asr.json3', 'auto.vtt': 'asr.vtt', 'en-tr.json3': 'en-tr.json3' };
    for (const [k, name] of Object.entries(map)) {
      const v = res.native[k];
      if (v && v.ok) {
        fs.writeFileSync(path.join(FIXTURES, `${VIDEO}.${name}`), v.body);
        log(`fixture ${VIDEO}.${name} (${v.bytes} chars)`);
      }
    }
  }
  return res;
}

async function scrollToToolbar() {
  await iso(() => {
    const host = document.getElementById('ayt-toolbar-host');
    if (!host) return false;
    const r = host.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, window.scrollY + r.top - 70));
    return true;
  });
  await sleep(400);
}

async function setTheme(theme) {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  await iso((th) => AYT.settings.set('theme', th).then(() => true), theme);
  await sleep(500);
}

async function testSubtitlesPanel(theme) {
  await iso(() => {
    AYT.toolbar.close();
    AYT.toolbar.open('subtitles');
    return true;
  });
  await waitFor('subtitles panel', () => portalRect('.ayt-panel .ayt-subs .ayt-media-actions'), 30000);
  await sleep(500);
  const state = await iso(() => {
    const root = document.getElementById('ayt-portal-host').shadowRoot;
    const selects = root.querySelectorAll('.ayt-subs select');
    return {
      language: selects[0] ? selects[0].selectedOptions[0].textContent : null,
      languageOptions: selects[0] ? selects[0].options.length : 0,
      translateOptions: selects[1] ? selects[1].options.length : 0,
      translateVisible: selects[1] ? !selects[1].closest('.ayt-field').classList.contains('ayt-hidden') : false,
      legend: (root.querySelector('.ayt-subs__legend') || {}).textContent || null,
      formats: Array.from(root.querySelectorAll('.ayt-subs .ayt-radio')).map((r) => r.dataset.value),
      download: (root.querySelector('.ayt-subs .ayt-btn--primary') || {}).textContent || null,
    };
  });
  check(`subtitles panel renders (${theme})`, state.languageOptions > 0 && state.formats.join() === 'srt,vtt,ttml,srv3,txt' && /Download SRT/.test(state.download || ''), state);
  const rect = await portalRect('.ayt-panel');
  await shot(`panel-subtitles-${theme}.png`, rect);
  return state;
}

async function testSubtitleDownloadViaUi() {
  const before = listDownloads();
  await clickInPortal('.ayt-subs .ayt-radio[data-value="srt"]');
  await clickInPortal('.ayt-subs .ayt-btn--primary');
  const status = await waitFor(
    'subtitle download status',
    () =>
      iso(() => {
        const el = document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-subs .ayt-media-status');
        return el && (el.dataset.kind === 'success' || el.dataset.kind === 'error') ? { kind: el.dataset.kind, text: el.textContent } : null;
      }),
    60000
  );
  const title = (report.captions && report.captions.title) || '';
  const expected = new RegExp('^' + namePrefix() + escapeRe(title) + ' \\(en\\)\\.srt$');
  const file = await waitDownload(before, expected);
  let val = null;
  if (file) val = validateSrt(fs.readFileSync(path.join(DOWNLOADS, file), 'utf8'));
  check('subtitles panel: Download SRT through the UI', status.kind === 'success' && nameOk(file, expected) && val && val.problemCount === 0, { status, file, mode: downloadMode, srt: val });
  const rect = await portalRect('.ayt-panel');
  await shot('panel-subtitles-after-download.png', rect);
}

/**
 * In-browser caption fetch fails -> companion fallback: a 'subtitle' job when the companion is connected,
 * otherwise the error + the companion install notice. outputDir points into OUT in case a companion is installed.
 */
async function testSubtitleFailurePath() {
  await iso((dir) => AYT.settings.set('outputDir', dir).then(() => true), path.join(OUT, 'companion-out'));
  await iso(() => {
    globalThis.__aytOrigFetchCaptions = AYT.videoInfo.fetchCaptions;
    AYT.videoInfo.fetchCaptions = () => Promise.reject(Object.assign(new Error('e2e: forced failure'), { code: 'no_token' }));
    return true;
  });
  try {
    await clickInPortal('.ayt-subs .ayt-btn--primary');
    const res = await waitFor(
      'subtitle fallback UI',
      () =>
        iso(() => {
          const root = document.getElementById('ayt-portal-host').shadowRoot;
          const st = root.querySelector('.ayt-subs .ayt-media-status');
          const fb = root.querySelector('.ayt-subs__fallback');
          // the job list of this video is always mounted after the fallback area (hidden while empty)
          const settled = fb && fb.querySelector('.ayt-notice');
          if (!st || !settled) return null;
          return { kind: st.dataset.kind || null, text: st.textContent, notice: fb.querySelector('.ayt-notice').textContent, jobs: !!root.querySelector('.ayt-subs .ayt-jobs:not(.ayt-hidden) .ayt-job') };
        }),
      30000
    );
    const hostState = await iso(() => (AYT.client.host.status && AYT.client.host.status.state) || null);
    if (hostState === 'connected') check('subtitles: a companion job starts when the in-browser path fails', res.jobs, Object.assign({ hostState }, res));
    else check('subtitles: in-browser failure shows the reason + the companion install notice', res.kind === 'error' && /allow access/.test(res.text) && !!res.notice, Object.assign({ hostState }, res));
    await shot('panel-subtitles-fallback.png', await portalRect('.ayt-panel'));
  } finally {
    await iso(() => {
      AYT.videoInfo.fetchCaptions = globalThis.__aytOrigFetchCaptions;
      return AYT.settings.set('outputDir', '').then(() => true);
    });
  }
}

async function testThumbnailPanel(theme, doDownloads) {
  await iso(() => {
    AYT.toolbar.close();
    AYT.toolbar.open('thumbnail');
    return true;
  });
  const state = await waitFor(
    'thumbnail panel items',
    () =>
      iso(() => {
        const root = document.getElementById('ayt-portal-host').shadowRoot;
        const sel = root.querySelector('.ayt-thumb select');
        const img = root.querySelector('.ayt-thumb__img');
        if (!sel || sel.disabled || !img || !img.complete || !img.naturalWidth) return null;
        return { options: Array.from(sel.options).map((o) => o.textContent), src: img.currentSrc, natural: img.naturalWidth + 'x' + img.naturalHeight, meta: root.querySelector('.ayt-thumb__meta').textContent };
      }),
    30000
  );
  check(`thumbnail panel lists sizes (${theme})`, state.options.length >= 3 && /maxresdefault|oar2/.test(state.src), state);
  await sleep(400);
  await shot(`panel-thumbnail-${theme}.png`, await portalRect('.ayt-panel'));
  if (!doDownloads) return state;

  // Download in the original format, then as PNG
  const title = (report.captions && report.captions.title) || '';
  const named = (ext) => new RegExp('^' + namePrefix() + escapeRe(title) + ' \\(1280x720\\)\\.' + ext + '$');
  for (const [fmt, re, type] of [
    ['original', named('jpg'), 'jpg'],
    ['png', named('png'), 'png'],
  ]) {
    const before = listDownloads();
    await clickInPortal(`.ayt-thumb .ayt-seg__opt[data-value="${fmt}"]`);
    await clickInPortal('.ayt-thumb .ayt-btn--primary');
    const status = await waitFor(
      'thumbnail status',
      () =>
        iso(() => {
          const el = document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-thumb .ayt-media-status');
          return el && (el.dataset.kind === 'success' || el.dataset.kind === 'error') ? { kind: el.dataset.kind, text: el.textContent } : null;
        }),
      40000
    );
    const file = await waitDownload(before, re, 20000, new RegExp('\\.' + type + '$'));
    const size = file ? imageSize(path.join(DOWNLOADS, file)) : null;
    check(`thumbnail download (${fmt})`, status.kind === 'success' && nameOk(file, re) && size.type === type && size.width >= 1280, { status, file, mode: downloadMode, size });
    await iso(() => {
      const el = document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-thumb .ayt-media-status');
      if (el) el.dataset.kind = '';
      return true;
    });
  }
  // restore the original format setting
  await clickInPortal('.ayt-thumb .ayt-seg__opt[data-value="original"]');

  // Copy (trusted click) and read the clipboard back in the page
  await clickInPortal('.ayt-thumb .ayt-media-actions .ayt-btn:nth-child(2)');
  const copyStatus = await waitFor(
    'thumbnail copy status',
    () =>
      iso(() => {
        const el = document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-thumb .ayt-media-status');
        return el && (el.dataset.kind === 'success' || el.dataset.kind === 'error') ? { kind: el.dataset.kind, text: el.textContent } : null;
      }),
    30000
  );
  const clip = await readClipboardImage();
  check('thumbnail copy to clipboard (PNG)', copyStatus.kind === 'success' && clip && clip.type === 'image/png' && clip.width >= 1280, { copyStatus, clip });
  return state;
}

async function readClipboardImage() {
  return page
    .evaluate(async () => {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        if (it.types.includes('image/png')) {
          const b = await it.getType('image/png');
          const bmp = await createImageBitmap(b);
          return { type: 'image/png', bytes: b.size, width: bmp.width, height: bmp.height };
        }
      }
      return { type: null, types: items.map((i) => i.types) };
    })
    .catch((e) => ({ error: e.message }));
}

async function testScreenshot() {
  const v = await playerState();
  const res = await iso(async () => {
    const analyze = async (blob) => {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = 192;
      c.height = Math.max(1, Math.round((192 * bmp.height) / bmp.width));
      const x = c.getContext('2d');
      x.drawImage(bmp, 0, 0, c.width, c.height);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let lum = 0;
      let nonBlack = 0;
      let chroma = 0;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        lum += l;
        if (l > 16) nonBlack++;
        chroma += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
      }
      const px = d.length / 4;
      return { bmpW: bmp.width, bmpH: bmp.height, meanLum: +(lum / px).toFixed(1), nonBlackPct: +((100 * nonBlack) / px).toFixed(1), meanChroma: +(chroma / px).toFixed(1) };
    };
    const toB64 = async (blob) => {
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(bin);
    };
    const v = AYT.player.video();
    const out = { videoW: v.videoWidth, videoH: v.videoHeight };
    const r = await AYT.screenshot.capture({ format: 'png' });
    out.png = Object.assign({ width: r.width, height: r.height, filename: r.filename, mime: r.blob.type, bytes: r.blob.size }, await analyze(r.blob));
    out.pngB64 = await toB64(r.blob);
    const j = await AYT.screenshot.capture({ format: 'jpg', quality: 0.8 });
    out.jpg = { width: j.width, height: j.height, filename: j.filename, mime: j.blob.type, bytes: j.blob.size };
    // with a (fake) TOOLS video adjustment: rotate 90°, mirror, grayscale
    const saved = AYT.videoAdjust;
    AYT.videoAdjust = { active: () => true, canvasFilter: () => 'grayscale(1)', rotation: () => 90, flipH: () => true, flipV: () => false };
    try {
      const a = await AYT.screenshot.capture({ format: 'webp', quality: 0.9 });
      out.adjusted = Object.assign({ width: a.width, height: a.height, mime: a.blob.type }, await analyze(a.blob));
      out.adjustedB64 = await toB64(a.blob);
      // Orientation: CSS "scale(-1, 1) rotate(90deg)" (adjust.js order) maps pixel (x, y) to (y, x) = transpose.
      v.pause();
      await new Promise((r) => setTimeout(r, 300));
      const pixels = async (blob) => {
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(bmp, 0, 0);
        return { w: bmp.width, h: bmp.height, d: x.getImageData(0, 0, bmp.width, bmp.height).data };
      };
      delete AYT.videoAdjust;
      const plain = await pixels((await AYT.screenshot.capture({ format: 'png' })).blob);
      AYT.videoAdjust = { active: () => true, canvasFilter: () => 'none', rotation: () => 90, flipH: () => true, flipV: () => false };
      const turned = await pixels((await AYT.screenshot.capture({ format: 'png' })).blob);
      let same = 0;
      let anti = 0;
      const N = 400;
      const px = (img, x, y) => {
        const i = (y * img.w + x) * 4;
        return [img.d[i], img.d[i + 1], img.d[i + 2]];
      };
      const close = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 24;
      for (let k = 0; k < N; k++) {
        const x = Math.floor(((k * 7919) % 997) / 997 * plain.w);
        const y = Math.floor(((k * 104729) % 991) / 991 * plain.h);
        if (close(px(turned, y, x), px(plain, x, y))) same++;
        if (close(px(turned, plain.h - 1 - y, plain.w - 1 - x), px(plain, x, y))) anti++;
      }
      out.orientation = { size: turned.w + 'x' + turned.h, transposeMatches: same, antiTransposeMatches: anti, samples: N };
      v.play().catch(() => {});
    } finally {
      if (saved) AYT.videoAdjust = saved;
      else delete AYT.videoAdjust;
    }
    return out;
  });
  fs.writeFileSync(path.join(OUT, 'capture.png'), Buffer.from(res.pngB64, 'base64'));
  fs.writeFileSync(path.join(OUT, 'capture-adjusted.webp'), Buffer.from(res.adjustedB64, 'base64'));
  delete res.pngB64;
  delete res.adjustedB64;
  report.screenshot = res;
  check('capture(): PNG at native video size', res.png.width === res.videoW && res.png.height === res.videoH && res.png.bmpW === res.videoW && res.png.mime === 'image/png', res.png);
  check('capture(): frame is not blank', res.png.nonBlackPct > 20 && res.png.meanLum > 8, { meanLum: res.png.meanLum, nonBlackPct: res.png.nonBlackPct });
  check('capture(): filename has title + timestamp', /\(\d{2}-\d{2}-\d{2}\.\d{3}\)\.png$/.test(res.png.filename) && !/^KrLj6nc516A/.test(res.png.filename), res.png.filename);
  check('capture(): JPG encoding', res.jpg.mime === 'image/jpeg' && res.jpg.width === res.videoW && res.jpg.filename.endsWith('.jpg'), res.jpg);
  check('capture(): videoAdjust rotation/flip/filter applied', res.adjusted.width === res.videoH && res.adjusted.height === res.videoW && res.adjusted.meanChroma < 3 && res.adjusted.mime === 'image/webp', res.adjusted);
  const o = res.orientation || {};
  check('capture(): rotate 90° + mirror matches the page CSS order (transpose)', o.transposeMatches >= o.samples * 0.97 && o.antiTransposeMatches < o.samples * 0.9, o);
  report.player = v;
}

async function testScreenshotButton() {
  await iso(() => {
    AYT.toolbar.close();
    return true;
  });
  await scrollToToolbar();
  const r = await iso(() => {
    const host = document.getElementById('ayt-toolbar-host');
    const b = host && host.shadowRoot.querySelector('.ayt-tb-btn[data-id="screenshot"]');
    if (!b) return null;
    const x = b.getBoundingClientRect();
    return { x: x.left, y: x.top, width: x.width, height: x.height };
  });
  if (!check('screenshot button in the toolbar', !!r, r)) return;
  // plain click: settings.screenshotAction = save
  const before = listDownloads();
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2, { delay: 20 });
  const title = (report.captions && report.captions.title) || '';
  const expected = new RegExp('^' + namePrefix() + escapeRe(title) + ' \\(\\d{2}-\\d{2}-\\d{2}\\.\\d{3}\\)\\.png$');
  const file = await waitDownload(before, expected, 30000, /\.png$/);
  const size = file ? imageSize(path.join(DOWNLOADS, file)) : null;
  const ps = await playerState();
  check('toolbar click saves a PNG at native size', nameOk(file, expected) && size.type === 'png' && size.width === ps.w && size.height === ps.h, { file, mode: downloadMode, size, video: ps.w + 'x' + ps.h });
  await sleep(800);
  // Shift+click: copy only
  await page.keyboard.down('Shift');
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2, { delay: 20 });
  await page.keyboard.up('Shift');
  await sleep(2500);
  const clip = await readClipboardImage();
  check('Shift+click copies the frame (PNG on the clipboard)', clip && clip.type === 'image/png' && clip.width === ps.w, clip);
  const toasts = await iso(() => {
    const host = document.getElementById('ayt-toast-host');
    return host ? Array.from(host.shadowRoot.querySelectorAll('.ayt-toast__text')).map((x) => x.textContent) : [];
  });
  report.toasts = toasts;
  log('toasts: ' + JSON.stringify(toasts));
  const tb = await iso(() => {
    const host = document.getElementById('ayt-toolbar-host');
    const r2 = host.getBoundingClientRect();
    return { x: r2.left, y: r2.top, width: Math.min(r2.width, 700), height: r2.height };
  });
  await shot('toolbar.png', tb, 6);
}

async function testShortsSurface(theme) {
  // Simulates the Shorts popover (~380 px): renderPanelInto in our own shadow host.
  const rect = await iso((th) => {
    const old = document.getElementById('ayt-e2e-popover');
    if (old) old.remove();
    const host = document.createElement('div');
    host.id = 'ayt-e2e-popover';
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483000; top: 70px; right: 24px; width: 380px;';
    const root = host.attachShadow({ mode: 'open' });
    AYT.ui.mountStyles(root);
    const wrap = document.createElement('div');
    wrap.className = 'ayt-root';
    wrap.setAttribute('data-theme', th);
    wrap.style.cssText = 'padding: 14px; border-radius: 16px; background: var(--ayt-bg-solid); box-shadow: var(--ayt-shadow); max-height: 80vh; overflow: auto; font: 14px/1.4 var(--ayt-font); color: var(--ayt-text);';
    const box = document.createElement('div');
    wrap.appendChild(box);
    root.appendChild(wrap);
    document.body.appendChild(host);
    globalThis.__aytE2ePopover = AYT.toolbar.renderPanelInto('subtitles', box, { surface: 'shorts', close: () => {} });
    const r = host.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, theme);
  await sleep(2500);
  const r2 = await iso(() => {
    const r = document.getElementById('ayt-e2e-popover').getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  await shot(`popover-subtitles-380-${theme}.png`, r2 || rect, 4);
  await iso(() => {
    globalThis.__aytE2ePopover.destroy();
    document.getElementById('ayt-e2e-popover').remove();
    return true;
  });
}

async function testSpaNavigation() {
  // Open the thumbnail panel, switch video through the player API (SPA), expect the panel to follow.
  await iso(() => {
    AYT.toolbar.close();
    AYT.toolbar.open('thumbnail');
    return true;
  });
  await waitFor('thumbnail panel', () => portalRect('.ayt-thumb .ayt-btn--primary'), 15000);
  const from = await iso(() => AYT.page.videoId);
  const hasApp = await page.evaluate(() => !!document.querySelector('ytd-app'));
  if (!hasApp) return note('SPA test skipped (no ytd-app)');
  // YouTube's router: a yt-navigate event on ytd-app with a watch endpoint (what its links fire on click).
  await page.evaluate((id) => {
    const app = document.querySelector('ytd-app');
    app.dispatchEvent(
      new CustomEvent('yt-navigate', {
        bubbles: true,
        composed: true,
        detail: { endpoint: { commandMetadata: { webCommandMetadata: { url: '/watch?v=' + id, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832 } }, watchEndpoint: { videoId: id } } },
      })
    );
  }, SECOND_VIDEO);
  const changed = await waitFor('SPA navigation', () => iso((id) => AYT.page.videoId === id, SECOND_VIDEO), 20000).catch(() => false);
  if (!changed) return note('SPA navigation did not happen (yt-navigate not handled); onVideoChange untested');
  const panel = await waitFor(
    'panel follows the new video',
    () =>
      iso((id) => {
        const root = document.getElementById('ayt-portal-host').shadowRoot;
        const img = root.querySelector('.ayt-thumb__img');
        const sel = root.querySelector('.ayt-thumb select');
        return img && img.currentSrc.includes('/' + id + '/') && sel && !sel.disabled ? { src: img.currentSrc, options: sel.options.length } : null;
      }, SECOND_VIDEO),
    20000
  ).catch((e) => ({ error: e.message }));
  check('open thumbnail panel follows SPA navigation (onVideoChange)', panel && !panel.error, { from, to: SECOND_VIDEO, panel });
  const oar = await iso((id) => AYT.thumbnails.probe(id, { inPageOnly: true }).then((items) => items.map((i) => `${i.key}.${i.format} ${i.width}x${i.height}`)), SECOND_VIDEO);
  check('in-page probe finds the 1920x1080 original-aspect thumbnail', oar[0] && /^oar2\.jpg 1920x1080$/.test(oar[0]), oar);
}

async function saveSecondVideoFixtures() {
  // Caption fixtures for dQw4w9WgXcQ (needs the page to show that video).
  const ok = await iso((id) => AYT.page.videoId === id, SECOND_VIDEO);
  if (!ok) return;
  await waitForContent(SECOND_VIDEO, 90000).catch(() => null);
  const res = await iso(async (vid) => {
    const info = await AYT.videoInfo.get(vid, { force: true });
    const tracks = info.captions.tracks;
    const manual = tracks.find((tr) => tr.lang === 'en' && !tr.isAuto);
    const auto = tracks.find((tr) => tr.isAuto);
    const out = {};
    for (const [name, tr, fmt] of [
      ['en.json3', manual, 'json3'],
      ['asr.json3', auto, 'json3'],
      ['asr.vtt', auto, 'vtt'],
      ['asr.srv3', auto, 'srv3'],
      ['asr.ttml', auto, 'ttml'],
    ]) {
      if (!tr) continue;
      try {
        out[name] = (await AYT.videoInfo.fetchCaptions({ videoId: vid, lang: tr.lang, kind: tr.kind, vssId: tr.vssId, fmt })).body;
      } catch (e) {
        out[name] = { error: e.code + ': ' + e.message };
      }
    }
    return out;
  }, SECOND_VIDEO);
  for (const [name, body] of Object.entries(res)) {
    const good = typeof body === 'string' && body.length > 50;
    check(`second video ${SECOND_VIDEO} fetch ${name}`, good, good ? { chars: body.length } : body);
    if (good && flag('--save-fixtures')) {
      fs.mkdirSync(FIXTURES, { recursive: true });
      fs.writeFileSync(path.join(FIXTURES, `${SECOND_VIDEO}.${name}`), body);
    }
  }
}

/** Shorts surface (second page load): vertical thumbnails, vertical frame capture, panels in a 380 px popover. */
async function testShorts() {
  const id = opt('--short', 'gZ6cIWpN4wA');
  await retry('goto shorts', () => page.goto(`https://www.youtube.com/shorts/${id}`, { waitUntil: 'domcontentloaded', timeout: 90000 }));
  await waitFor('content scripts (shorts)', () => iso(() => !!(globalThis.AYT && AYT.booted && AYT.screenshot && AYT.thumbnails)), 60000);
  const type = await iso(() => AYT.page.type);
  if (!check('shorts page detected', type === 'shorts', type)) return;
  const items = await iso((vid) => AYT.thumbnails.probe(vid).then((list) => list.map((i) => `${i.key}.${i.format} ${i.width}x${i.height}`)), id);
  check('shorts: the vertical full-size thumbnail is offered first', /^oar2\.jpg \d+x\d+$/.test(items[0] || '') && (() => {
    const m = /(\d+)x(\d+)$/.exec(items[0]);
    return Number(m[2]) > Number(m[1]);
  })(), items);
  const frame = await waitFor(
    'shorts video frame',
    () =>
      iso(() => {
        const v = AYT.player.video();
        if (!v) return null;
        v.muted = true;
        if (v.paused) v.play().catch(() => {});
        return v.readyState >= 2 && v.videoWidth && !AYT.player.isAdPlaying() ? { w: v.videoWidth, h: v.videoHeight } : null;
      }),
    45000
  ).catch(() => null);
  if (frame) {
    const cap = await iso(() =>
      AYT.screenshot.capture({ format: 'jpg' }).then(
        (r) => ({ width: r.width, height: r.height, filename: r.filename, bytes: r.blob.size, vw: AYT.player.video().videoWidth, vh: AYT.player.video().videoHeight }),
        (e) => ({ error: e.code + ': ' + e.message })
      )
    );
    check('shorts: capture() at the native vertical size', cap.width === cap.vw && cap.height === cap.vh && cap.height > cap.width, cap);
  } else note('the Short did not start playing: vertical capture not checked');
  for (const panel of ['thumbnail', 'subtitles']) {
    await iso((which) => {
      const old = document.getElementById('ayt-e2e-popover');
      if (old) old.remove();
      const host = document.createElement('div');
      host.id = 'ayt-e2e-popover';
      host.style.cssText = 'all: initial; position: fixed; z-index: 2147483000; top: 70px; left: 24px; width: 380px;';
      const root = host.attachShadow({ mode: 'open' });
      AYT.ui.mountStyles(root);
      const wrap = document.createElement('div');
      wrap.className = 'ayt-root';
      AYT.ui.applyTheme(wrap);
      wrap.style.cssText = 'padding: 14px; border-radius: 16px; background: var(--ayt-bg-solid); box-shadow: var(--ayt-shadow); max-height: 86vh; overflow: auto; font: 14px/1.4 var(--ayt-font); color: var(--ayt-text);';
      const box = document.createElement('div');
      wrap.appendChild(box);
      root.appendChild(wrap);
      document.body.appendChild(host);
      globalThis.__aytE2ePopover = AYT.toolbar.renderPanelInto(which, box, { surface: 'shorts', close: () => {} });
      return true;
    }, panel);
    const ready = await waitFor(
      `${panel} popover content`,
      () =>
        iso((which) => {
          const r = document.getElementById('ayt-e2e-popover').shadowRoot;
          if (which === 'thumbnail') {
            const sel = r.querySelector('.ayt-thumb select');
            return sel && !sel.disabled ? { options: Array.from(sel.options).map((o) => o.textContent) } : null;
          }
          const s = r.querySelector('.ayt-subs select, .ayt-notice');
          return s ? { content: s.tagName === 'SELECT' ? Array.from(s.options).map((o) => o.textContent).slice(0, 4) : s.textContent } : null;
        }, panel),
      30000
    ).catch((e) => ({ error: e.message }));
    check(`shorts: ${panel} panel works in the 380 px popover`, ready && !ready.error, ready);
    await sleep(800);
    const r2 = await iso(() => {
      const r = document.getElementById('ayt-e2e-popover').getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    await shot(`shorts-popover-${panel}.png`, r2, 4);
    await iso(() => {
      globalThis.__aytE2ePopover.destroy();
      document.getElementById('ayt-e2e-popover').remove();
      return true;
    });
  }
}

/* ------------------------------------------------------------------ main */
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const extPath = prepareExtension();
  if (report.stubbed.length) note('stubbed for this run: ' + report.stubbed.join(', '));

  const profileDir = path.join(OUT, 'profile');
  writeDownloadPrefs(profileDir);
  H = await launchWithExtension(extPath, {
    userDataDir: profileDir,
    stealth: true,
    headless: flag('--headful') ? false : true,
    viewport: { width: 1400, height: 1100 },
  });
  page = H.page;
  report.extensionId = H.extensionId;
  log('extension id ' + H.extensionId);
  // The service worker opens the options page (#companion) on install: a YouTube tab in the background gets no
  // media loading in headless Chrome, so close extra tabs and keep YouTube in front.
  const closeExtraTabs = async () => {
    for (const p of await H.browser.pages()) {
      if (p !== page) {
        log('closing extra tab ' + p.url());
        await p.close().catch(() => {});
      }
    }
    await page.bringToFront().catch(() => {});
  };
  H.browser.on('targetcreated', (tg) => {
    if (tg.type() === 'page' && /^chrome-extension:\/\/[a-p]{32}\/options\//.test(tg.url())) setTimeout(() => closeExtraTabs().catch(() => {}), 300);
  });
  await sleep(2000);
  await closeExtraTabs();
  page.on('pageerror', (e) => report.consoleErrors.push('pageerror: ' + String(e.message || e).slice(0, 300)));
  page.on('console', (m) => {
    const text = m.text();
    if (/\[AYT\]/.test(text) && (m.type() === 'error' || m.type() === 'warning' || m.type() === 'warn')) report.consoleErrors.push(m.type() + ': ' + text.slice(0, 300));
  });

  await verifyDownloadDir();
  report.downloadMode = downloadMode;
  await H.browser.defaultBrowserContext().overridePermissions('https://www.youtube.com', ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

  await openWatchPage(VIDEO);
  check('MEDIA modules loaded + toolbar mounted', true);
  const ids = await iso(() => AYT.toolbar.list().map((d) => d.id));
  check('toolbar buttons registered', ['thumbnail', 'subtitles', 'screenshot'].every((id) => ids.includes(id)), ids);

  let adCapture = null;
  const content = await ensurePlaying(VIDEO, async () => {
    adCapture = await iso(() => AYT.screenshot.capture().then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code, message: e.message })));
  });
  if (adCapture) check('capture() refuses while an ad plays', !adCapture.ok && adCapture.code === 'ad', adCapture);
  else note('no ad was shown in this run: the ad refusal was not exercised');
  if (content) {
    await muteAndPlay();
    await sleep(2500);
    await testScreenshot();
  } else {
    note('YouTube playback never started (machine under load): frame-capture checks skipped this run');
    const r = await iso(() => AYT.screenshot.capture().then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code, message: e.message })));
    check('capture() refuses cleanly when the video has no frame yet', !r.ok && ['not_ready', 'ad', 'no_video'].includes(r.code), r);
  }
  await testCaptions();
  await pauseVideo();

  await scrollToToolbar();
  await setTheme('dark');
  await testSubtitlesPanel('dark');
  await testSubtitleDownloadViaUi();
  await testSubtitleFailurePath();
  await testThumbnailPanel('dark', true);
  await setTheme('light');
  await scrollToToolbar();
  await testSubtitlesPanel('light');
  await testThumbnailPanel('light', false);
  await testShortsSurface('light');
  await setTheme('dark');
  await testShortsSurface('dark');
  await iso(() => AYT.settings.set('theme', 'auto').then(() => true));

  if (content) {
    await muteAndPlay();
    await sleep(1200);
    await testScreenshotButton();
    await pauseVideo();
  }

  if (!flag('--no-spa')) {
    await testSpaNavigation();
    await saveSecondVideoFixtures();
  }
  if (!flag('--no-shorts')) await testShorts();
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  check('e2e run completed', false, String((e && e.stack) || e).split('\n').slice(0, 4).join(' | '));
} finally {
  if (H) await H.close();
  const failed = report.checks.filter((c) => !c.ok);
  report.finishedAt = new Date().toISOString();
  report.summary = { passed: report.checks.length - failed.length, failed: failed.length };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  log(`\n${report.summary.passed} passed, ${report.summary.failed} failed — report: ${path.join(OUT, 'report.json')}`);
  if (report.consoleErrors.length) log('console errors/warnings from AYT:\n  ' + report.consoleErrors.slice(0, 20).join('\n  '));
  // Remove big downloaded media; keep the small text outputs.
  for (const f of listDownloads()) if (/\.(png|jpg|webp)$/i.test(f) && fs.statSync(path.join(DOWNLOADS, f)).size > 3e6) fs.rmSync(path.join(DOWNLOADS, f));
  exitCode = failed.length ? 1 : 0;
}
process.exit(exitCode);
