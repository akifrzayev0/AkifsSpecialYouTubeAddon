#!/usr/bin/env node
/*
 * E2E test for the BACKGROUND module (extension/background/*) in the installed Chrome (headless, harness.mjs).
 *
 *   node tools/e2e/background.e2e.mjs [--out <dir>] [--headful] [--no-mock-host] [--no-youtube] [--no-reload]
 *
 *   --out <dir>       work dir: staged extension, Chrome profile, downloads, mock host (default <os tmp>/ayt-e2e-background)
 *   --no-mock-host    skip the phase that registers a temporary mock companion under HKCU (see below)
 *   --no-youtube      skip the YouTube page (screenshot blob download + keyboard-command forwarding)
 *   --no-reload       skip the final extension reload (interrupted-job recovery)
 *   --real-host-src   also copy companion/host (the real host source) into <out>/realhost, register it under a
 *                     temporary test name and run one real tiny job (audio, jNQXAC9IVRw, mp3 128) into <out>/real
 *
 * The extension is copied to <out>/ext; files referenced by manifest.json that do not exist yet are replaced by
 * empty stubs (Chrome refuses to load an extension with missing content scripts).
 *
 * Downloads go to <out>/downloads through the profile's download.default_directory preference. NOT through CDP
 * Browser.setDownloadBehavior: verified on Chrome 157 that the DevTools download delegate ignores the file name
 * requested by chrome.downloads (a data: URL for "Sub/Name (en).srt" was saved as "download"), which would hide
 * exactly the MIME/extension problems this test must catch.
 *
 * Phases
 *  1. install: onInstalled opens options.html#companion
 *  2. real host name: HOST_STATUS ('missing' unless the companion is registered under HKCU); JOB_START -> error with a
 *     helpful message (or, when the companion IS installed, a real tiny mp3 job end to end into <out>/real)
 *  3. THUMB_PROBE (dQw4w9WgXcQ max 1280x720; jNQXAC9IVRw has no maxres), FETCH_IMAGE, DOWNLOAD_URL (png conversion,
 *     original webp, missing maxres), DOWNLOAD_DATA (.srt with Unicode, data URL MIME re-tagging), validation errors,
 *     context menu items
 *  4. YouTube page: screenshot-style blob: URL downloaded by the service worker (sender = our content script),
 *     keyboard command forwarded to the tab
 *  5. mock host: a Node fake companion registered as com.akif.youtube_addon.e2e (HKCU, removed afterwards); the
 *     service worker is pointed at it (AYT.HOST_NAME) -> real Chrome native messaging: hello/connected, job with
 *     throttled progress pushes + done + open, cancel, host crash -> host_exit, idle disconnect after 20 s (EOF)
 *  6. extension reload while a job runs -> the job comes back as 'interrupted'
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchWithExtension } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT_SRC = path.join(ROOT, 'extension');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'ayt-e2e-background')));
const PROFILE = path.join(OUT, 'profile');
const DOWNLOADS = path.join(OUT, 'downloads');
const MOCK_DIR = path.join(OUT, 'mockhost');
const REAL_OUT = path.join(OUT, 'real');
const HEADFUL = flag('--headful');
const REAL_HOST = 'com.akif.youtube_addon';
const MOCK_HOST = 'com.akif.youtube_addon.e2e';
const REAL_SRC_HOST = 'com.akif.youtube_addon.e2ereal';
const REAL_SRC_DIR = path.join(OUT, 'realhost');
const REG_BASE = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\';
const EXT_ID = 'oicpmbpfimnoolnhfgdocfjelknjlcif';

/* ------------------------------------------------------------------ tiny test framework */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail != null && detail !== '' ? '  — ' + detail : ''}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label || 'condition'}${last instanceof Error ? ': ' + last.message : ''}`);
}
/** Retry once on CDP protocol timeouts (other engineers run headless Chrome in parallel). */
async function retry(fn, label) {
  try {
    return await fn();
  } catch (e) {
    if (!/Protocol ?Error|timed out|Target closed|Session closed|Execution context was destroyed|detached/i.test(String(e && e.message))) throw e;
    console.warn(`  ! ${label || 'step'} failed (${e.message}); retrying once`);
    await sleep(1500);
    return fn();
  }
}
async function phase(name, fn) {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (e) {
    check(`${name}: no exception`, false, (e && e.stack) || e);
  }
}

/* ------------------------------------------------------------------ staging */
function stageExtension() {
  const dst = path.join(OUT, 'ext');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(EXT_SRC, dst, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'));
  const refs = new Set();
  for (const cs of manifest.content_scripts || []) [...(cs.js || []), ...(cs.css || [])].forEach((p) => refs.add(p));
  if (manifest.action && manifest.action.default_popup) refs.add(manifest.action.default_popup);
  if (manifest.options_ui) refs.add(manifest.options_ui.page);
  const stubs = [];
  for (const rel of refs) {
    const p = path.join(dst, rel);
    if (fs.existsSync(p)) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rel.endsWith('.html') ? '<!doctype html><meta charset="utf-8"><title>stub</title>' : '/* e2e stub: file not written yet */\n');
    stubs.push(rel);
  }
  for (const page of [manifest.action && manifest.action.default_popup, manifest.options_ui && manifest.options_ui.page].filter(Boolean)) {
    const html = fs.readFileSync(path.join(dst, page), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
      const p = path.resolve(path.dirname(path.join(dst, page)), m[1]);
      if (!fs.existsSync(p)) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '/* e2e stub */\n');
        stubs.push(path.relative(dst, p).replace(/\\/g, '/'));
      }
    }
  }
  return { dir: dst, stubs };
}

function writeProfilePrefs() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  fs.writeFileSync(
    path.join(PROFILE, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: DOWNLOADS, prompt_for_download: false, directory_upgrade: true }, savefile: { default_directory: DOWNLOADS }, browser: { has_seen_welcome_page: true } })
  );
}

/* ------------------------------------------------------------------ registry + mock host */
function regQuery(name) {
  const r = spawnSync('reg', ['query', REG_BASE + name, '/ve'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const m = /REG_SZ\s+(.+)$/m.exec(r.stdout || '');
  return m ? m[1].trim() : '';
}
function regSet(name, value) {
  const r = spawnSync('reg', ['add', REG_BASE + name, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('reg add failed: ' + (r.stderr || r.stdout));
}
function regDelete(name) {
  spawnSync('reg', ['delete', REG_BASE + name, '/f'], { encoding: 'utf8', windowsHide: true });
}

const MOCK_HOST_SRC = String.raw`// Fake companion host for tools/e2e/background.e2e.mjs (native messaging protocol of DEVELOPER-SPEC §8).
// videoId jNQXAC9IVRw = fast job (bursty progress, done), dQw4w9WgXcQ = slow job (for cancel), KrLj6nc516A = crash.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(DIR, 'mock-host.log');
const log = (...a) => fs.appendFileSync(LOG, new Date().toISOString() + ' [' + process.pid + '] ' + a.join(' ') + '\n');
log('start', JSON.stringify(process.argv.slice(2)));
const jobs = new Map();
let buf = Buffer.alloc(0);
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
    buf = buf.subarray(4 + len);
    handle(msg);
  }
});
process.stdin.on('end', () => {
  log('stdin EOF -> exit');
  for (const j of jobs.values()) clearInterval(j.timer);
  process.exit(0);
});
function handle(m) {
  const shown = Object.assign({}, m);
  if (m.task) shown.task = Object.assign({}, m.task, { cookies: m.task.cookies ? '<' + m.task.cookies.length + ' chars>' : null });
  log('recv', JSON.stringify(shown));
  switch (m.type) {
    case 'hello':
      return send({ re: m.id, ok: true, name: 'akif-youtube-addon-host', version: '0.0.0-e2e-mock', protocol: 1, platform: 'win32',
        tools: { ytdlp: { path: 'mock', version: 'mock' }, ffmpeg: { path: 'mock', version: 'mock' }, deno: { path: 'mock', version: 'mock' } },
        downloadsDir: DIR, defaultDir: path.join(DIR, 'out') });
    case 'start': {
      const task = m.task || {};
      if (!task.kind || !m.jobId) return send({ re: m.id, ok: false, error: 'bad task', code: 'bad_task' });
      send({ re: m.id, ok: true });
      return run(m.jobId, task, task.videoId === 'KrLj6nc516A' ? 'crash' : task.videoId === 'dQw4w9WgXcQ' ? 'slow' : 'fast');
    }
    case 'cancel': {
      const j = jobs.get(m.jobId);
      if (!j) return send({ re: m.id, ok: false, error: 'no such job', code: 'not_found' });
      clearInterval(j.timer);
      jobs.delete(m.jobId);
      send({ re: m.id, ok: true });
      return send({ event: 'canceled', jobId: m.jobId });
    }
    case 'open':
      return fs.existsSync(String(m.path)) ? send({ re: m.id, ok: true }) : send({ re: m.id, ok: false, error: 'File not found', code: 'not_found' });
    default:
      return send({ re: m.id, ok: false, error: 'unsupported', code: 'unsupported' });
  }
}
function run(jobId, task, mode) {
  send({ event: 'info', jobId, title: 'Mock title ' + task.videoId, videoId: task.videoId, duration: 19, uploader: 'mock' });
  const j = { timer: 0, pct: 0 };
  jobs.set(jobId, j);
  j.timer = setInterval(() => {
    if (mode === 'crash' && j.pct >= 30) {
      log('crash on purpose');
      process.exit(3);
    }
    const burst = mode === 'fast' ? 5 : 1;
    for (let i = 0; i < burst && j.pct < 100; i++) {
      j.pct += mode === 'slow' ? 0.5 : 2;
      send({ event: 'progress', jobId, stage: task.kind === 'audio' ? 'audio' : 'video', percent: j.pct, downloaded: j.pct * 1000, total: 100000, speed: 250000, eta: Math.round((100 - j.pct) / 10) });
    }
    if (j.pct < 100) return;
    clearInterval(j.timer);
    jobs.delete(jobId);
    send({ event: 'stage', jobId, stage: task.kind === 'audio' ? 'extract' : 'merge' });
    const out = path.join(DIR, 'out');
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, 'Mock ' + jobId.slice(0, 8) + (task.kind === 'audio' ? '.mp3' : '.mp4'));
    fs.writeFileSync(file, 'mock media');
    send({ event: 'file', jobId, path: file, size: 10 });
    send({ event: 'done', jobId, files: [{ path: file, size: 10 }], filePath: file, fileSize: 10 });
  }, 100);
}
`;

function installMockHost() {
  fs.rmSync(MOCK_DIR, { recursive: true, force: true });
  fs.mkdirSync(MOCK_DIR, { recursive: true });
  fs.writeFileSync(path.join(MOCK_DIR, 'mock-host.mjs'), MOCK_HOST_SRC);
  // ASCII + CRLF, no BOM, @echo off first (anything else on stdout corrupts the framing).
  fs.writeFileSync(path.join(MOCK_DIR, 'mock-host.bat'), `@echo off\r\n"${process.execPath}" "%~dp0mock-host.mjs" %*\r\n`);
  const manifestPath = path.join(MOCK_DIR, MOCK_HOST + '.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ name: MOCK_HOST, description: 'Akif YouTube Addon e2e mock host (temporary)', path: path.join(MOCK_DIR, 'mock-host.bat'), type: 'stdio', allowed_origins: [`chrome-extension://${EXT_ID}/`] }, null, 2)
  );
  regSet(MOCK_HOST, manifestPath);
  return manifestPath;
}
function mockLog() {
  try {
    return fs.readFileSync(path.join(MOCK_DIR, 'mock-host.log'), 'utf8');
  } catch (_) {
    return '';
  }
}

/** PID of the mock host process that received the start request of a job. */
function pidOf(jobId) {
  const line = mockLog().split('\n').find((l) => l.includes('"type":"start"') && l.includes(jobId));
  const m = line && /\[(\d+)\] recv/.exec(line);
  return m ? m[1] : null;
}
function eofOf(pid) {
  return !!pid && mockLog().includes('[' + pid + '] stdin EOF');
}

/* ------------------------------------------------------------------ file checks */
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/* ------------------------------------------------------------------ main */
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`work dir: ${OUT}`);
  const staged = stageExtension();
  if (staged.stubs.length) console.log(`stubs (files not written yet): ${staged.stubs.join(', ')}`);
  writeProfilePrefs();
  const realHostManifest = regQuery(REAL_HOST);
  const companionInstalled = realHostManifest !== null;
  console.log(`companion (${REAL_HOST}) registered: ${companionInstalled ? 'yes -> ' + realHostManifest : 'no'}`);
  let mockRegistered = false;
  if (!flag('--no-mock-host')) {
    try {
      installMockHost();
      mockRegistered = true;
      console.log(`mock host registered: ${REG_BASE}${MOCK_HOST}`);
    } catch (e) {
      console.warn('! could not register the mock host:', e.message);
    }
  }
  let realSrcRegistered = false;
  const hostSrc = path.join(ROOT, 'companion', 'host');
  if (flag('--real-host-src') && mockRegistered && fs.existsSync(path.join(hostSrc, 'host.ts'))) {
    try {
      // Copy, so logs/state/.deno-cache land in the work dir and never in the companion source folder.
      fs.rmSync(REAL_SRC_DIR, { recursive: true, force: true });
      fs.cpSync(hostSrc, path.join(REAL_SRC_DIR, 'host'), { recursive: true, filter: (src) => !/[\\/]\.deno-cache([\\/]|$)/.test(src) });
      fs.mkdirSync(path.join(REAL_SRC_DIR, 'logs'), { recursive: true });
      const manifestPath = path.join(REAL_SRC_DIR, REAL_SRC_HOST + '.json');
      fs.writeFileSync(manifestPath, JSON.stringify({ name: REAL_SRC_HOST, description: 'Akif YouTube Addon companion from source (e2e, temporary)', path: path.join(REAL_SRC_DIR, 'host', 'host.bat'), type: 'stdio', allowed_origins: [`chrome-extension://${EXT_ID}/`] }, null, 2));
      regSet(REAL_SRC_HOST, manifestPath);
      realSrcRegistered = true;
      console.log(`companion source registered for the test: ${REG_BASE}${REAL_SRC_HOST} -> ${manifestPath}`);
    } catch (e) {
      console.warn('! could not register the companion source host:', e.message);
    }
  }
  const cleanupRegistry = () => {
    if (mockRegistered) regDelete(MOCK_HOST);
    if (realSrcRegistered) regDelete(REAL_SRC_HOST);
    mockRegistered = false;
    realSrcRegistered = false;
  };
  process.on('exit', cleanupRegistry);

  const h = await launchWithExtension(staged.dir, { userDataDir: PROFILE, stealth: true, headless: HEADFUL ? false : true });
  const { browser } = h;
  let extPage = null;

  const sw = () => retry(() => h.getServiceWorker(), 'getServiceWorker');
  const swEval = async (fn, ...args) => retry(async () => (await h.getServiceWorker()).evaluate(fn, ...args), 'sw.evaluate');

  async function openExtPage() {
    extPage = await browser.newPage();
    await extPage.goto(`chrome-extension://${h.extensionId}/manifest.json`, { waitUntil: 'domcontentloaded' });
    await extPage.evaluate((portName) => {
      window.__pushes = [];
      window.__connect = () => {
        const port = chrome.runtime.connect({ name: portName });
        port.onMessage.addListener((m) => window.__pushes.push(Object.assign({ at: Date.now() }, m)));
        port.onDisconnect.addListener(() => setTimeout(window.__connect, 300));
        window.__port = port;
      };
      window.__connect();
    }, 'ayt-ui');
  }
  const send = (msg) => retry(() => extPage.evaluate((m) => chrome.runtime.sendMessage(m), msg), 'sendMessage');
  const pushes = () => retry(() => extPage.evaluate(() => window.__pushes.slice()), 'read pushes');
  const jobById = async (id) => (await send({ type: 'jobs:list' })).jobs.find((j) => j.id === id);
  const waitJob = (id, pred, ms, label) => waitFor(async () => {
    const j = await jobById(id);
    return j && pred(j) ? j : null;
  }, ms, label);
  const dlDone = (downloadId) =>
    waitFor(async () => {
      const it = await swEval((i) => chrome.downloads.search({ id: i }).then((x) => x[0] && { state: x[0].state, filename: x[0].filename, error: x[0].error || null }), downloadId);
      if (it && it.state === 'interrupted') throw new Error('download interrupted: ' + it.error);
      return it && it.state === 'complete' ? it : null;
    }, 30000, 'download ' + downloadId);

  try {
    await phase('1. install', async () => {
      check('extension id from the manifest key', h.extensionId === EXT_ID, h.extensionId);
      const target = await waitFor(() => browser.targets().find((t) => /options\/options\.html#companion$/.test(t.url())), 8000, 'options tab').catch(() => null);
      check('onInstalled opened options.html#companion', !!target, target && target.url());
      if (target) {
        try {
          const optPage = await target.page();
          await optPage.setViewport({ width: 1280, height: 860 });
          await optPage.bringToFront(); // a background tab renders no frames (animations stay at their first frame)
          await sleep(1500);
          fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
          await optPage.screenshot({ path: path.join(OUT, 'shots', 'options-companion.png') });
          console.log(`    screenshot: ${path.join(OUT, 'shots', 'options-companion.png')}`);
        } catch (e) {
          console.warn('    ! options screenshot failed:', e.message);
        }
      }
      await openExtPage();
      const initial = await waitFor(async () => (await pushes()).find((p) => p.type === 'jobs'), 5000, 'jobs snapshot');
      check('ui port receives a jobs snapshot on connect', Array.isArray(initial.jobs), JSON.stringify(initial).slice(0, 80));
      const menus = await swEval(() =>
        Promise.all(AYT.menus.ITEMS.map((i) => new Promise((r) => chrome.contextMenus.update(i.id, {}, () => r(chrome.runtime.lastError ? 'ERR ' + chrome.runtime.lastError.message : 'ok')))))
      );
      check('4 context menu items exist', menus.length === 4 && menus.every((m) => m === 'ok'), menus.join(','));
      const titles = await swEval(() => AYT.menus.titles().map((x) => x.title));
      check('menu titles are localized English', titles[0] === 'Download video (best quality)' && titles[1] === 'Download audio (MP3)', titles.join(' | '));
      const mark = await waitFor(() => swEval(() => chrome.storage.local.get('state.contextMenus').then((x) => x['state.contextMenus'])), 5000, 'menu state').catch(() => null);
      check('menu language recorded after the install build', !!mark && mark.lang === 'en', JSON.stringify(mark));
      const again = await swEval(() => AYT.menus.ensure());
      check('a later start-up check leaves the menus alone', again === 'kept', again);
    });

    await phase('2. companion status + job with the real host name', async () => {
      const st = await send({ type: 'host:status', refresh: true });
      const expected = companionInstalled ? 'connected' : 'missing';
      check(`HOST_STATUS -> ${expected}`, st.ok && st.status.state === expected, JSON.stringify(st.status));
      const hp = await waitFor(async () => (await pushes()).find((p) => p.type === 'host'), 5000, 'host push').catch(() => null);
      check('ui port received the host status push', !!hp && hp.status.state === st.status.state);
      const stored = await swEval(() => chrome.storage.local.get('state.hostStatus').then((x) => x['state.hostStatus']));
      check('host status cached in storage', stored && stored.state === st.status.state && stored.checkedAt > 0);

      if (!companionInstalled) {
        const r = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', playlist: false, audioFormat: 'mp3', bitrate: 128 }, meta: { title: 'Me at the zoo', videoId: 'jNQXAC9IVRw', label: 'MP3 · 128 kbps' } });
        check('JOB_START accepted (job created)', r.ok && r.jobId && r.job && r.job.kind === 'audio', JSON.stringify(r).slice(0, 120));
        const j = await waitJob(r.jobId, (x) => x.status === 'error', 15000, 'job error');
        check('job ends in error host_missing', j.errorCode === 'host_missing', j.errorCode);
        check('error message is helpful', /isn['’]t installed/.test(j.error) && /Companion app/.test(j.error), j.error);
        const jp = (await pushes()).filter((p) => p.type === 'job' && p.job.id === r.jobId).map((p) => p.job.status);
        check('job pushes: queued -> starting -> error', jp[0] === 'queued' && jp.includes('starting') && jp.at(-1) === 'error', jp.join(','));
        const badge = await swEval(() => chrome.action.getBadgeText({}));
        check('badge cleared after the failure', badge === '', JSON.stringify(badge));
        const failId = 'ayt-job:' + r.jobId;
        const failShown = await waitFor(async () => Object.keys(await swEval(() => chrome.notifications.getAll())).includes(failId), 5000, 'notification').catch(() => false);
        check('failure notification shown', failShown, failId);
        await send({ type: 'job:remove', jobId: r.jobId });
      } else {
        fs.rmSync(REAL_OUT, { recursive: true, force: true });
        fs.mkdirSync(REAL_OUT, { recursive: true });
        await swEval((dir) => AYT.settings.setMany({ outputDir: dir, notifyOnComplete: true }), REAL_OUT);
        const r = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', playlist: false, audioFormat: 'mp3', bitrate: 128 }, meta: { title: 'Me at the zoo', videoId: 'jNQXAC9IVRw', label: 'MP3 · 128 kbps' } });
        check('real job accepted', r.ok && r.jobId, JSON.stringify(r).slice(0, 120));
        const j = await waitJob(r.jobId, (x) => ['done', 'error', 'canceled'].includes(x.status), 240000, 'real job finished');
        const jp = (await pushes()).filter((p) => p.type === 'job' && p.job.id === r.jobId);
        check('real job: progress pushes received', jp.some((p) => p.job.status === 'running' && p.job.percent != null), jp.map((p) => p.job.status + ':' + p.job.percent).slice(-8).join(' '));
        check('real job: done', j.status === 'done', j.status + ' ' + (j.error || ''));
        check('real job: file exists', j.filePath && fs.existsSync(j.filePath) && /\.mp3$/i.test(j.filePath), j.filePath);
        await swEval(() => AYT.settings.set('outputDir', ''));
        for (const f of walk(REAL_OUT)) fs.rmSync(f, { force: true });
      }
    });

    await phase('3. thumbnails + browser-side downloads', async () => {
      const p1 = await send({ type: 'thumb:probe', videoId: 'dQw4w9WgXcQ' });
      check('THUMB_PROBE dQw4w9WgXcQ ok', p1.ok && p1.items.length >= 4, p1.ok ? p1.items.map((i) => `${i.key}.${i.format} ${i.width}x${i.height}`).join(', ') : p1.error);
      check('dQw4w9WgXcQ: maximum is 1280x720 maxresdefault.jpg', p1.ok && p1.items[0].width === 1280 && p1.items[0].height === 720 && p1.items[0].key === 'maxresdefault' && p1.items[0].format === 'jpg');
      const sizes = p1.ok ? p1.items.map((i) => i.width * i.height) : [];
      check('items sorted by pixels and unique by size', sizes.every((s, i) => i === 0 || s < sizes[i - 1]));
      const p2 = await send({ type: 'thumb:probe', videoId: 'jNQXAC9IVRw' });
      check('THUMB_PROBE jNQXAC9IVRw: maxres missing -> not listed', p2.ok && !p2.items.some((i) => i.width >= 1280) && p2.items[0].key === 'hqdefault' && p2.items[0].width === 480, p2.ok ? p2.items.map((i) => `${i.key} ${i.width}x${i.height}`).join(', ') : p2.error);
      check('placeholder 120x90 only as "default"', p2.ok && p2.items.filter((i) => i.width === 120).every((i) => i.key === 'default'));
      const t0 = Date.now();
      await send({ type: 'thumb:probe', videoId: 'dQw4w9WgXcQ' });
      check('THUMB_PROBE cached (second call fast)', Date.now() - t0 < 400, Date.now() - t0 + ' ms');

      const fi = await send({ type: 'fetch:image', url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg', convert: 'png' });
      check('FETCH_IMAGE -> png data URL 320x180', fi.ok && /^data:image\/png;base64,/.test(fi.dataUrl) && fi.width === 320 && fi.height === 180 && fi.mime === 'image/png' && fi.bytes > 1000, fi.ok ? `${fi.mime} ${fi.width}x${fi.height} ${fi.bytes} B` : fi.error);

      const d1 = await send({ type: 'download:url', url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg', filename: 'Rick Astley - Never Gonna Give You Up (1280x720).jpg', convert: 'png', kind: 'thumbnail' });
      check('DOWNLOAD_URL convert:png accepted', d1.ok && typeof d1.downloadId === 'number', JSON.stringify(d1));
      if (d1.ok) {
        const it = await dlDone(d1.downloadId);
        const ok = /Akif YouTube[\\/]Rick Astley - Never Gonna Give You Up \(1280x720\)\.png$/.test(it.filename) && fs.existsSync(it.filename);
        const size = ok ? pngSize(fs.readFileSync(it.filename)) : null;
        check('thumbnail saved as a real 1280x720 PNG in the subfolder', ok && size && size.width === 1280 && size.height === 720, it.filename + ' ' + JSON.stringify(size));
      }
      const d2 = await send({ type: 'download:url', url: 'https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/sddefault.webp', filename: 'Rick (640x480).jpg', kind: 'thumbnail' });
      if (check('DOWNLOAD_URL original webp accepted', d2.ok, JSON.stringify(d2))) {
        const it = await dlDone(d2.downloadId);
        const buf = fs.readFileSync(it.filename);
        check('original webp keeps .webp (content type wins)', /Rick \(640x480\)\.webp$/.test(it.filename) && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP', it.filename);
      }
      const d3 = await send({ type: 'download:url', url: 'https://i.ytimg.com/vi/jNQXAC9IVRw/maxresdefault.jpg', filename: 'Me at the zoo.jpg', kind: 'thumbnail' });
      check('missing maxres -> clear error instead of a broken download', !d3.ok && d3.code === 'not_found', JSON.stringify(d3));

      const srt = '1\n00:00:00,000 --> 00:00:02,000\nŞəki şəhəri — Привет, мир!\n';
      const d4 = await send({ type: 'download:data', text: srt, mime: 'text/plain', filename: 'Me at the zoo (en).srt', kind: 'subtitle' });
      if (check('DOWNLOAD_DATA .srt accepted', d4.ok, JSON.stringify(d4))) {
        const it = await dlDone(d4.downloadId);
        check('.srt keeps its extension and UTF-8 text', /Me at the zoo \(en\)\.srt$/.test(it.filename) && fs.readFileSync(it.filename, 'utf8') === srt, it.filename);
      }
      const d5 = await send({ type: 'download:data', dataUrl: 'data:text/plain;base64,' + Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n').toString('base64'), filename: 'Captions (tr).vtt', kind: 'subtitle' });
      if (check('DOWNLOAD_DATA data URL accepted', d5.ok, JSON.stringify(d5))) {
        const it = await dlDone(d5.downloadId);
        check('data URL re-tagged: .vtt stays .vtt', /Captions \(tr\)\.vtt$/.test(it.filename), it.filename);
      }

      const bad = [
        [{ type: 'download:url', url: 'https://example.com/a.png', filename: 'a.png' }, 'bad_url'],
        [{ type: 'download:data', text: 'x', filename: 'run.exe' }, 'bad_filename'],
        [{ type: 'job:start', task: { kind: 'video', videoId: 'x' }, meta: {} }, 'bad_task'],
        [{ type: 'job:start', task: { kind: 'video', url: 'https://evil.example/watch?v=dQw4w9WgXcQ' }, meta: {} }, 'bad_task'],
        [{ type: 'tab:open', url: 'https://example.com/' }, 'bad_url'],
        [{ type: 'job:cancel', jobId: 'nope' }, 'not_found'],
        [{ type: 'job:nonsense' }, 'bad_request'],
      ];
      for (const [msg, code] of bad) {
        const r = await send(msg);
        check(`rejects ${msg.type} (${code})`, r && r.ok === false && r.code === code && typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r));
      }
    });

    if (!flag('--no-youtube')) {
      await phase('4. YouTube page: blob download + command forwarding', async () => {
        const page = h.page;
        await retry(() => page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 60000 }), 'goto youtube');
        await page.evaluate(() => {
          const stop = () => document.querySelectorAll('video').forEach((v) => { v.muted = true; v.pause(); });
          stop();
          setInterval(stop, 1000);
        }).catch(() => {});
        await waitFor(() => h.evaluateInIsolatedWorld(page, () => !!(window.AYT && AYT.client)), 20000, 'content script');
        const r = await h.evaluateInIsolatedWorld(page, async () => {
          const c = new OffscreenCanvas(64, 36);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#e53935';
          ctx.fillRect(0, 0, 64, 36);
          const blob = await c.convertToBlob({ type: 'image/png' });
          const url = URL.createObjectURL(blob);
          const res = await chrome.runtime.sendMessage({ type: 'download:url', url, filename: 'Me at the zoo (00-00-01.000).png', kind: 'screenshot' });
          setTimeout(() => URL.revokeObjectURL(url), 60000);
          return res;
        });
        if (check('DOWNLOAD_URL of a blob:https://www.youtube.com URL from the content script', r && r.ok, JSON.stringify(r))) {
          const it = await dlDone(r.downloadId);
          const size = pngSize(fs.readFileSync(it.filename));
          check('screenshot blob saved as PNG', /\(00-00-01\.000\)\.png$/.test(it.filename) && size && size.width === 64, it.filename);
        }
        const srtText = '1\n00:00:00,000 --> 00:00:01,000\nŞəki\n';
        const r2 = await h.evaluateInIsolatedWorld(page, async (text) => {
          const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
          const res = await chrome.runtime.sendMessage({ type: 'download:url', url, filename: 'Blob subtitles (az).srt', kind: 'subtitle' });
          setTimeout(() => URL.revokeObjectURL(url), 60000);
          return res;
        }, srtText);
        if (check('DOWNLOAD_URL of a text/plain blob named .srt accepted', r2 && r2.ok, JSON.stringify(r2))) {
          const it = await dlDone(r2.downloadId);
          check('blob .srt not renamed to .txt, content intact', /Blob subtitles \(az\)\.srt$/.test(it.filename) && fs.readFileSync(it.filename, 'utf8') === srtText, it.filename);
        }
        await h.evaluateInIsolatedWorld(page, () => {
          window.__aytCommands = [];
          AYT.client.on('command', (c) => window.__aytCommands.push(c));
        });
        const forwarded = await swEval(async () => {
          const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
          return tabs.length ? AYT.commands.forward('speed-reset', tabs[0]) : 'no tab';
        });
        const got = await waitFor(() => h.evaluateInIsolatedWorld(page, () => window.__aytCommands.length && window.__aytCommands), 5000, 'command').catch(() => null);
        check('keyboard command forwarded to the YouTube tab', forwarded === true && got && got[0] === 'speed-reset', JSON.stringify({ forwarded, got }));
        await page.goto('about:blank').catch(() => {});
      });
    }

    if (mockRegistered) {
      await phase('5. mock companion over real native messaging', async () => {
        await swEval(async (name) => {
          await AYT.native.check(false).catch(() => {}); // let any in-flight check for the real name finish first
          AYT.HOST_NAME = name;
          AYT.native.disconnect();
          AYT.native.invalidate();
        }, MOCK_HOST);
        const st = await send({ type: 'host:status', refresh: true });
        check('HOST_STATUS via sendNativeMessage -> connected', st.ok && st.status.state === 'connected' && st.status.version === '0.0.0-e2e-mock', JSON.stringify(st.status));

        // fast job: bursty progress (50 events/s) -> throttled pushes, done, open
        const before = (await pushes()).length;
        const r = await send({ type: 'job:start', task: { kind: 'video', videoId: 'jNQXAC9IVRw', height: 240, hdr: false, fps: 30, container: 'mp4' }, meta: { title: 'Me at the zoo', label: 'MP4 · 240p' } });
        check('mock job accepted', r.ok, JSON.stringify(r).slice(0, 100));
        const j = await waitJob(r.jobId, (x) => ['done', 'error'].includes(x.status), 20000, 'mock job done');
        check('mock job done with the file from the host', j.status === 'done' && j.filePath && fs.existsSync(j.filePath) && j.percent === 100, `${j.status} ${j.filePath} ${j.error || ''}`);
        const jp = (await pushes()).slice(before).filter((p) => p.type === 'job' && p.job.id === r.jobId);
        const running = jp.filter((p) => p.job.status === 'running');
        const span = running.length > 1 ? (running.at(-1).at - running[0].at) / 1000 : 1;
        check('progress pushes throttled (≤ ~4/s per job)', running.length >= 2 && running.length <= Math.ceil(span * 4) + 3, `${running.length} running pushes over ${span.toFixed(2)} s (host sent 50 events/s)`);
        check('statuses pushed in order', jp[0].job.status === 'queued' && jp.some((p) => p.job.status === 'processing' && p.job.stage === 'merge') && jp.at(-1).job.status === 'done', jp.map((p) => p.job.status).filter((s, i, a) => s !== a[i - 1]).join(','));
        const startMsg = mockLog().split('\n').find((l) => l.includes('"type":"start"') && l.includes(r.jobId));
        check('host task got settings-derived fields and no cookies', startMsg && /"outputDir":""/.test(startMsg) && /"filenameStyle":"title"/.test(startMsg) && /"cookies":null/.test(startMsg) && /"subfolder":"Akif YouTube"/.test(startMsg), startMsg && startMsg.slice(0, 200));
        // chrome.notifications.create resolves a few hundred ms later (icon decoding), so poll.
        const noteId = 'ayt-job:' + r.jobId;
        const shown = await waitFor(async () => Object.keys(await swEval(() => chrome.notifications.getAll())).includes(noteId), 5000, 'notification').catch(() => false);
        check('completion notification shown', shown, noteId);
        const hostPid = pidOf(r.jobId);
        const o = await send({ type: 'host:open', jobId: r.jobId, target: 'folder' });
        const openLine = mockLog().split('\n').find((l) => l.includes('"type":"open"'));
        check("HOST_OPEN sends the job's own file path", o.ok && openLine && openLine.includes('"target":"folder"') && openLine.includes(JSON.stringify(j.filePath).slice(1, -1)), JSON.stringify(o) + ' ' + (openLine || '').slice(0, 160));

        // idle: no jobs, no requests -> the port is closed after 20 s and the host sees EOF
        const t0 = Date.now();
        const connected = await swEval(() => AYT.native.connected);
        const eof = await waitFor(() => eofOf(hostPid), 45000, 'idle EOF').catch(() => null);
        const dt = (Date.now() - t0) / 1000;
        check('idle port closed ~20 s after the last request (host got EOF)', connected === true && !!eof && dt >= 15 && dt < 40, `pid ${hostPid}, connected before=${connected}, EOF after ${dt.toFixed(1)} s`);
        check('service worker no longer holds the native port', (await swEval(() => AYT.native.connected)) === false);

        // slow job -> cancel
        const s = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'dQw4w9WgXcQ' }, meta: { title: 'Slow one' } });
        await waitJob(s.jobId, (x) => x.status === 'running', 15000, 'slow running');
        const badge = await swEval(() => chrome.action.getBadgeText({}));
        check('badge shows the active job count', badge === '1', JSON.stringify(badge));
        await send({ type: 'job:cancel', jobId: s.jobId });
        const sc = await waitJob(s.jobId, (x) => x.status !== 'running', 10000, 'canceled');
        check('cancel -> host cancel -> canceled', sc.status === 'canceled' && mockLog().includes('"type":"cancel"'), sc.status);
        check('badge cleared', (await swEval(() => chrome.action.getBadgeText({}))) === '');

        // crash -> host_exit, then retry
        const c = await send({ type: 'job:start', task: { kind: 'video', videoId: 'KrLj6nc516A' }, meta: { title: 'Crash test' } });
        const cj = await waitJob(c.jobId, (x) => ['error', 'done', 'canceled'].includes(x.status), 20000, 'crash -> error');
        check('host crash -> job error host_exit', cj.status === 'error' && cj.errorCode === 'host_exit' && /stopped unexpectedly/.test(cj.error), `${cj.errorCode}: ${cj.error}`);
        const rr = await send({ type: 'job:retry', jobId: c.jobId });
        check('retry creates a new job (old one removed)', rr.ok && rr.jobId !== c.jobId && !(await jobById(c.jobId)), JSON.stringify(rr).slice(0, 100));
        await waitJob(rr.jobId, (x) => ['error', 'done'].includes(x.status), 20000, 'retried crash');
        const cl = await send({ type: 'jobs:clear' });
        check('JOBS_CLEAR removes finished jobs', cl.ok && cl.removed >= 3 && (await send({ type: 'jobs:list' })).jobs.length === 0, JSON.stringify(cl));
      });

      if (realSrcRegistered) {
        await phase('5b. companion host from source (copied to the work dir) — real tiny mp3 job', async () => {
          fs.rmSync(REAL_OUT, { recursive: true, force: true });
          fs.mkdirSync(REAL_OUT, { recursive: true });
          await swEval(async (name, dir) => {
            await AYT.native.check(false).catch(() => {});
            AYT.HOST_NAME = name;
            AYT.native.disconnect();
            AYT.native.invalidate();
            await AYT.settings.setMany({ outputDir: dir });
          }, REAL_SRC_HOST, REAL_OUT);
          const st = await send({ type: 'host:status', refresh: true });
          check('real host source: HOST_STATUS connected', st.ok && st.status.state === 'connected', JSON.stringify(st.status).slice(0, 400));
          if (!st.ok || st.status.state !== 'connected') return;
          check('real host source: tool versions reported', !!(st.status.tools && st.status.tools.ytdlp && st.status.tools.ytdlp.version), JSON.stringify(st.status.tools));
          const before = (await pushes()).length;
          const r = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'jNQXAC9IVRw', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', playlist: false, audioFormat: 'mp3', bitrate: 128 }, meta: { title: 'Me at the zoo', videoId: 'jNQXAC9IVRw', label: 'MP3 · 128 kbps' } });
          check('real host source: job accepted', r.ok, JSON.stringify(r).slice(0, 120));
          const j = await waitJob(r.jobId, (x) => ['done', 'error', 'canceled'].includes(x.status), 300000, 'real job finished');
          const jp = (await pushes()).slice(before).filter((p) => p.type === 'job' && p.job.id === r.jobId);
          check('real host source: progress pushes', jp.some((p) => p.job.status === 'running' && p.job.percent != null), jp.map((p) => `${p.job.status}:${p.job.stage || ''}:${p.job.percent}`).filter((s, i, a) => s !== a[i - 1]).slice(-10).join(' '));
          check('real host source: done', j.status === 'done', `${j.status} ${j.errorCode || ''} ${j.error || ''}`);
          check('real host source: mp3 exists in the work dir', !!j.filePath && fs.existsSync(j.filePath) && /\.mp3$/i.test(j.filePath) && j.filePath.startsWith(REAL_OUT), `${j.filePath} (${j.fileSize} B)`);
          // HOST_OPEN is covered by the mock phase: against the real host it would pop up an Explorer window.
          await send({ type: 'jobs:clear' });
          for (const f of walk(REAL_OUT)) fs.rmSync(f, { force: true });
        }).finally(() =>
          swEval(async (mockName) => {
            await AYT.settings.set('outputDir', '');
            AYT.HOST_NAME = mockName; // back to the mock for the reload phase
            AYT.native.disconnect();
            AYT.native.invalidate();
          }, MOCK_HOST).catch(() => {})
        );
      }

      if (!flag('--no-reload')) {
        await phase('6. extension reload during a job -> interrupted', async () => {
          const s = await send({ type: 'job:start', task: { kind: 'audio', videoId: 'dQw4w9WgXcQ' }, meta: { title: 'Will be interrupted' } });
          await waitJob(s.jobId, (x) => x.status === 'running', 15000, 'running before reload');
          const pid = pidOf(s.jobId);
          await sleep(1300); // let the throttled persistence store the running state
          await extPage.close().catch(() => {});
          extPage = null;
          await h.reloadExtension();
          await sleep(1500);
          await openExtPage();
          const j = await waitJob(s.jobId, (x) => x.status === 'error', 15000, 'interrupted');
          check('job marked interrupted after the service worker restarted', j.errorCode === 'interrupted' && /Interrupted/.test(j.error), `${j.errorCode}: ${j.error}`);
          const eof = await waitFor(() => eofOf(pid), 10000, 'host exit on reload').catch(() => null);
          check('host saw EOF when the old service worker went away', !!eof, 'pid ' + pid);
          const menus = await swEval(() =>
            Promise.all(AYT.menus.ITEMS.map((i) => new Promise((r) => chrome.contextMenus.update(i.id, {}, () => r(chrome.runtime.lastError ? 'ERR ' + chrome.runtime.lastError.message : 'ok')))))
          );
          check('context menu items exist after the reload', menus.length === 4 && menus.every((m) => m === 'ok'), menus.join(','));
          await send({ type: 'jobs:clear' });
        });
      }
    }
  } finally {
    await h.close();
    cleanupRegistry();
    const files = walk(DOWNLOADS).map((f) => path.relative(DOWNLOADS, f));
    console.log(`\ndownloads: ${files.join(' | ')}`);
    const failed = results.filter((r) => !r.ok);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), companionInstalled, stubs: staged.stubs, downloads: files, results }, null, 2));
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? '; FAILED: ' + failed.map((f) => f.name).join('; ') : ''}`);
    process.exitCode = failed.length ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
