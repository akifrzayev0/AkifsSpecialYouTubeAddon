#!/usr/bin/env node
/*
 * E2E test for the DOWNLOADS module (content/panels/video.js + audio.js) on real YouTube pages.
 *
 *   node tools/e2e/downloads.e2e.mjs [--out <dir>] [--capture] [--capture-only] [--isolate] [--headful]
 *
 *   --out <dir>      work dir for the staged extension, the Chrome profile and screenshots
 *                    (default: <os tmp>/ayt-e2e-downloads)
 *   --capture        also (re)write tools/tests/fixtures/<videoId>.json (pruned player responses, exactly what
 *                    AYT.videoInfo.normalize receives through the MAIN-world bridge; caption baseUrls removed)
 *   --capture-only   only capture the fixtures, skip the UI checks
 *   --isolate        replace files owned by OTHER modules (other panels, tools, shorts, page.css, service worker)
 *                    with stubs, so a half-finished module elsewhere cannot break this test
 *   --headful        show the browser
 *
 * The extension is copied to <out>/ext first. Files referenced by manifest.json that do not exist yet are
 * replaced by empty stubs (Chrome refuses to load an extension with missing content scripts); a missing
 * service worker is replaced by a tiny stub that answers HOST_STATUS with the real native-messaging result
 * (normally 'missing'), JOBS_LIST with [] and refuses JOB_START.
 *
 * Checks (1La4QzGeaaQ, dark theme): video panel renders, 8K HDR row with a GB estimate, rows sorted best first,
 * panel sits under the toolbar button and is not clipped (first rows visible), companion notice + disabled rows
 * (when the companion is missing) and a clear message on click, clip mode + GIF button; panels opened with the mouse
 * keep focus on their container (Space must not start a download), opened with Enter on the toolbar button they focus
 * the first video row / the selected audio format (never the audio Download button); audio panel: range via the
 * HH:MM:SS inputs, size estimate + button label; then a SIMULATED companion (AYT.client overridden in the isolated
 * world, nothing reaches the service worker or downloads anything): enabled rows, hover glow, busy row with progress,
 * job list, toolbar ring, and the exact tasks built by row / GIF / audio clicks (+ duplicate protection).
 * (KrLj6nc516A, light theme): audio-language select lists the 26 dubs with the original first; SPA navigation to
 * jNQXAC9IVRw with the panel open (panel reloads); both panels rendered on the 380 px Shorts surface.
 * If the companion IS installed, AYT.client.jobs.start is intercepted so no real download starts.
 * Screenshots go to <out>/shots, results to <out>/results.json. Exit code 1 when a check fails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { launchWithExtension } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT_SRC = path.join(ROOT, 'extension');
const FIXTURES = path.join(ROOT, 'tools', 'tests', 'fixtures');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'ayt-e2e-downloads')));
const SHOTS = path.join(OUT, 'shots');
const CAPTURE = flag('--capture') || flag('--capture-only');
const CAPTURE_ONLY = flag('--capture-only');
const ISOLATE = flag('--isolate');
const HEADFUL = flag('--headful');

const V8K = '1La4QzGeaaQ';
const VDUB = 'KrLj6nc516A';

/* ------------------------------------------------------------------ tiny test framework */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail != null && detail !== '' ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      // one hung CDP call (busy machine) must not eat the whole budget
      last = await Promise.race([fn(), sleep(Math.min(15000, Math.max(1000, end - Date.now()))).then(() => { throw new Error('attempt timed out'); })]);
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label || 'condition'}${last instanceof Error ? ': ' + last.message : ''}`);
}
/** Retry once on CDP protocol timeouts (other engineers run headless Chrome in parallel). */
async function retry(fn, label) {
  try {
    return await fn();
  } catch (e) {
    if (!/Protocol ?Error|timed out|Navigation timeout|Target closed|Session closed|Execution context was destroyed/i.test(String(e && e.message))) throw e;
    console.warn(`  ! ${label || 'step'} failed (${e.message}); retrying once`);
    await sleep(1500);
    return fn();
  }
}

/* ------------------------------------------------------------------ staging */
const OTHER_MODULE_FILES = [
  'shared/subtitles.js',
  'content/page.css',
  'content/panels/thumbnail.js',
  'content/panels/subtitles.js',
  'content/panels/screenshot.js',
  'content/tools/loop.js',
  'content/tools/speed.js',
  'content/tools/boost.js',
  'content/tools/adjust.js',
  'content/tools/pip.js',
  'content/tools/cinema.js',
  'content/tools/cleanup.js',
  'content/tools/quality.js',
  'content/shorts.js',
];

const STUB_SW = `/* e2e stub service worker (downloads.e2e.mjs) — used only when the real one is missing or with --isolate. */
importScripts('../shared/constants.js');
let hostStatus = null;
async function checkHost() {
  try {
    const r = await chrome.runtime.sendNativeMessage(AYT.HOST_NAME, { id: 'stub', type: 'hello' });
    hostStatus = { state: 'connected', version: r && r.version, protocol: r && r.protocol, defaultDir: r && r.defaultDir, checkedAt: Date.now() };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const state = /not found/i.test(msg) ? 'missing' : /forbidden/i.test(msg) ? 'forbidden' : 'error';
    hostStatus = { state, error: msg, checkedAt: Date.now() };
  }
  return hostStatus;
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case AYT.MSG.HOST_STATUS: return { ok: true, status: await checkHost() };
      case AYT.MSG.JOBS_LIST: return { ok: true, jobs: [] };
      case AYT.MSG.JOB_START: return { ok: false, error: 'e2e stub service worker: jobs are not available', code: 'stub' };
      case AYT.MSG.OPEN_OPTIONS: return { ok: true };
      default: return { ok: false, error: 'e2e stub: unsupported ' + (msg && msg.type), code: 'unsupported' };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== AYT.PORT_UI) return;
  port.postMessage({ type: AYT.PUSH.JOBS, jobs: [] });
  if (hostStatus) port.postMessage({ type: AYT.PUSH.HOST, status: hostStatus });
});
`;

function stageExtension() {
  const dst = path.join(OUT, 'ext');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(EXT_SRC, dst, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'));
  const stubs = [];
  const stub = (rel, content) => {
    const p = path.join(dst, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    stubs.push(rel);
  };
  const swRel = manifest.background && manifest.background.service_worker;
  if (swRel && (ISOLATE || !fs.existsSync(path.join(dst, swRel)))) stub(swRel, STUB_SW);
  if (ISOLATE) for (const rel of OTHER_MODULE_FILES) stub(rel, rel.endsWith('.css') ? '/* e2e stub */\n' : '/* e2e stub */\n');
  const refs = new Set();
  for (const cs of manifest.content_scripts || []) [...(cs.js || []), ...(cs.css || [])].forEach((p) => refs.add(p));
  if (manifest.action && manifest.action.default_popup) refs.add(manifest.action.default_popup);
  if (manifest.options_ui && manifest.options_ui.page) refs.add(manifest.options_ui.page);
  for (const rel of refs) {
    if (fs.existsSync(path.join(dst, rel))) continue;
    if (rel.endsWith('.html')) stub(rel, '<!doctype html><meta charset="utf-8"><title>stub</title>');
    else stub(rel, '/* e2e stub: file not written yet */\n');
  }
  return { dir: dst, stubs };
}

/* ------------------------------------------------------------------ page helpers (MAIN world) */
async function quietPlayer(page) {
  await page
    .evaluate(() => {
      const p = document.getElementById('movie_player');
      try {
        if (p && p.mute) p.mute();
        if (p && p.pauseVideo) p.pauseVideo();
      } catch (_) {
        /* ignore */
      }
      document.querySelectorAll('video').forEach((v) => {
        v.muted = true;
        try {
          v.pause();
        } catch (_) {
          /* ignore */
        }
      });
    })
    .catch(() => {});
}

async function waitForToolbar(page) {
  // In --capture-only mode the panels may not exist yet: the mounted toolbar (bridge + core loaded) is enough.
  const sel = CAPTURE_ONLY ? '.ayt-toolbar' : '.ayt-tb-btn[data-id="video"]';
  return waitFor(
    () => page.evaluate((s) => !!(document.querySelector('#ayt-toolbar-host') && document.querySelector('#ayt-toolbar-host').shadowRoot && document.querySelector('#ayt-toolbar-host').shadowRoot.querySelector(s)), sel),
    45000,
    'toolbar ' + sel
  );
}

/** Snapshot of the open panel (portal shadow root), read from the MAIN world (open shadow roots are reachable). */
function panelSnapshot(page) {
  return page.evaluate(() => {
    const host = document.getElementById('ayt-portal-host');
    const root = host && host.shadowRoot;
    const panel = root && root.querySelector('.ayt-panel');
    if (!panel) return null;
    const tb = document.querySelector('#ayt-toolbar-host').shadowRoot;
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const rows = Array.from(panel.querySelectorAll('.ayt-video-row')).map((r) => ({
      ext: (r.querySelector('.ayt-row__ext') || {}).textContent || '',
      res: (r.querySelector('.ayt-row__res') || {}).textContent || '',
      badges: Array.from(r.querySelectorAll('.ayt-badge')).map((b) => b.textContent),
      size: (r.querySelector('.ayt-row__size') || {}).textContent || '',
      disabled: r.classList.contains('is-disabled') || r.getAttribute('aria-disabled') === 'true',
      hidden: r.offsetParent === null,
      label: r.getAttribute('aria-label') || '',
    }));
    const sel = panel.querySelector('.ayt-dl-lang select');
    return {
      theme: (root.querySelector('.ayt-root') || {}).getAttribute ? root.querySelector('.ayt-root').getAttribute('data-theme') : null,
      title: (panel.querySelector('.ayt-panel__title') || {}).textContent || '',
      panel: rect(panel),
      body: panel.querySelector('.ayt-panel__body') ? { scrollH: panel.querySelector('.ayt-panel__body').scrollHeight, clientH: panel.querySelector('.ayt-panel__body').clientHeight } : null,
      button: rect(tb.querySelector('.ayt-tb-btn.is-open')),
      viewport: { w: document.documentElement.clientWidth, h: window.innerHeight },
      notices: Array.from(panel.querySelectorAll('.ayt-notice')).map((n) => n.textContent.trim().slice(0, 160)),
      spinner: !!panel.querySelector('.ayt-spinner'),
      rows,
      langOptions: sel ? Array.from(sel.options).map((o) => ({ value: o.value, label: o.textContent })) : null,
      langValue: sel ? sel.value : null,
      footer: (panel.querySelector('.ayt-panel__footer') || {}).textContent || '',
      text: panel.textContent.replace(/\s+/g, ' ').slice(0, 2000),
    };
  });
}

/**
 * Snapshot once the panel stopped moving: the panel scrolls the page into view (smoothly, and retries once if
 * YouTube interrupts it while loading), so wait until two snapshots 400 ms apart agree (max ~6 s).
 */
async function settledPanel(page) {
  let prev = null;
  let stable = 0;
  const end = Date.now() + 8000;
  await sleep(600);
  while (Date.now() < end) {
    const cur = await panelSnapshot(page).catch(() => null);
    const same = cur && prev && Math.abs(cur.panel.top - prev.panel.top) < 1 && Math.abs(cur.panel.h - prev.panel.h) < 1;
    stable = same ? stable + 1 : 0;
    prev = cur;
    if (stable >= 4) return cur; // unchanged for ~1.6 s (longer than the 1.3 s re-fit/retry delay)
    await sleep(400);
  }
  return prev;
}

/** How many video rows are fully visible inside the panel body's scroll viewport. */
function firstRowsVisible(page) {
  return page.evaluate(() => {
    const root = document.getElementById('ayt-portal-host').shadowRoot;
    const body = root.querySelector('.ayt-panel__body');
    const b = body.getBoundingClientRect();
    let visible = 0;
    for (const r of root.querySelectorAll('.ayt-video-row')) {
      if (r.offsetParent === null) continue;
      const x = r.getBoundingClientRect();
      if (x.top >= b.top - 1 && x.bottom <= b.bottom + 1 && x.bottom <= window.innerHeight) visible++;
    }
    return { visible, bodyH: Math.round(b.height) };
  });
}

function toastTexts(page) {
  return page.evaluate(() => {
    const host = document.getElementById('ayt-toast-host');
    if (!host || !host.shadowRoot) return [];
    return Array.from(host.shadowRoot.querySelectorAll('.ayt-toast')).map((x) => x.textContent.trim());
  });
}

async function shot(page, name, clipToPanel) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, name + '.png');
  let clip;
  if (clipToPanel) {
    clip = await page.evaluate(() => {
      const root = document.getElementById('ayt-portal-host').shadowRoot;
      const panel = root.querySelector('.ayt-panel');
      const tb = document.querySelector('#ayt-toolbar-host');
      const r = panel.getBoundingClientRect();
      const b = tb.getBoundingClientRect();
      const top = Math.max(0, Math.min(r.top, b.top) - 16);
      const left = Math.max(0, Math.min(r.left, b.left) - 16);
      // puppeteer's clip is in document coordinates
      return { x: left + window.scrollX, y: top + window.scrollY, width: Math.min(document.documentElement.clientWidth - left, Math.max(r.right, b.left + 520) - left + 16), height: Math.min(window.innerHeight - top, r.bottom - top + 16) };
    });
  }
  // captureBeyondViewport:false — otherwise puppeteer resizes the viewport for the capture and the page re-lays out
  await retry(() => page.screenshot({ path: file, clip: clip || undefined, captureBeyondViewport: false }), 'screenshot');
  console.log('    screenshot ' + file);
  return file;
}

/** Clicks the center of an element inside the portal shadow root (trusted mouse event). */
async function clickInPanel(page, selector, index) {
  const pt = await page.evaluate(
    (sel, i) => {
      const root = document.getElementById('ayt-portal-host').shadowRoot;
      const el = root.querySelectorAll(sel)[i || 0];
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    selector,
    index || 0
  );
  if (!pt) throw new Error('element not found in panel: ' + selector);
  await sleep(150);
  await page.mouse.click(pt.x, pt.y);
  return pt;
}

/** Focuses an input inside the panel and types text (trusted keyboard events), then presses Enter. */
async function typeInPanel(page, selector, index, text) {
  const ok = await page.evaluate(
    (sel, i) => {
      const root = document.getElementById('ayt-portal-host').shadowRoot;
      const el = root.querySelectorAll(sel)[i || 0];
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      el.select();
      return true;
    },
    selector,
    index || 0
  );
  if (!ok) throw new Error('input not found: ' + selector);
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press('Enter');
}

/* ------------------------------------------------------------------ fixtures */
async function captureFixture(evaluateInIsolatedWorld, page, videoId) {
  const raw = await retry(
    () =>
      evaluateInIsolatedWorld(
        page,
        (id) => AYT.bridge.request('getPlayerResponse', { videoId: id, surface: 'watch', timeoutMs: 10000 }, 15000),
        videoId
      ),
    'capture ' + videoId
  );
  if (!raw || !raw.videoDetails || raw.videoDetails.videoId !== videoId) throw new Error('no player response for ' + videoId);
  // Signed caption URLs are not needed by the tests (and expire); drop them.
  for (const tr of (raw.captions && raw.captions.tracks) || []) delete tr.baseUrl;
  raw.__capturedAt = new Date().toISOString();
  raw.__source = 'tools/e2e/downloads.e2e.mjs --capture (AYT.bridge getPlayerResponse = main-world pruneResponse(movie_player.getPlayerResponse()))';
  fs.mkdirSync(FIXTURES, { recursive: true });
  const file = path.join(FIXTURES, videoId + '.json');
  fs.writeFileSync(file, JSON.stringify(raw, null, 1) + '\n');
  const sd = raw.streamingData || {};
  console.log(`    fixture ${file} (${(sd.adaptiveFormats || []).length} adaptive formats, ${fs.statSync(file).size} bytes)`);
  return raw;
}

/* ------------------------------------------------------------------ launch */
/** Kills Chrome processes that use OUR profile dir (left behind when a launch failed half-way). */
function killOwnChrome(profileDir) {
  if (process.platform !== 'win32') return;
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profileDir.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 30000 });
}

/** The machine may be busy with other headless Chromes: retry the launch once on CDP timeouts. */
async function launchWithRetry(extDir) {
  const profile = path.join(OUT, 'profile');
  for (let attempt = 1; ; attempt++) {
    try {
      return await launchWithExtension(extDir, { userDataDir: profile, stealth: true, headless: HEADFUL ? false : true, viewport: { width: 1600, height: 1000 } });
    } catch (e) {
      if (attempt >= 2 || !/timed out|Protocol ?Error|Target closed|ECONNRESET/i.test(String(e && e.message))) throw e;
      console.warn(`  ! launch failed (${e.message.split('\n')[0]}); retrying once`);
      killOwnChrome(profile);
      await sleep(3000);
    }
  }
}

/* ------------------------------------------------------------------ main */
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const staged = stageExtension();
  console.log(`staged extension -> ${staged.dir}`);
  if (staged.stubs.length) console.log(`  stubs (missing or --isolate): ${staged.stubs.join(', ')}`);

  const h = await launchWithRetry(staged.dir);
  const { page, evaluateInIsolatedWorld } = h;
  // The service worker opens the options page (#companion) on install. A YouTube tab in the background gets no
  // rAF, throttled timers and no rendering in headless Chrome (panels never fit, range changes never reach the
  // panel, screenshots time out): close extra tabs and keep YouTube in front, also when the tab opens late.
  const focusOurTab = async () => {
    for (const p of await h.browser.pages()) {
      if (p !== page) await p.close().catch(() => {});
    }
    await page.bringToFront().catch(() => {});
  };
  h.browser.on('targetcreated', (tg) => {
    if (tg.type() === 'page' && /^chrome-extension:\/\/[a-p]{32}\/options\//.test(tg.url())) setTimeout(() => focusOurTab().catch(() => {}), 300);
  });
  await sleep(1500);
  await focusOurTab();
  const isolated = (fn, ...a) => retry(() => evaluateInIsolatedWorld(page, fn, ...a), 'isolated eval');
  page.on('pageerror', (e) => {
    if (/AYT|ayt-/.test(String(e && e.stack))) console.warn('  ! page error (ours?): ' + e.message);
  });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /\[AYT\]/.test(m.text())) consoleErrors.push(m.text());
  });

  try {
    /* ================================================================ 1) 8K HDR video, dark theme */
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    console.log(`\n[1] https://www.youtube.com/watch?v=${V8K} (dark)`);
    await retry(() => page.goto(`https://www.youtube.com/watch?v=${V8K}`, { waitUntil: 'domcontentloaded', timeout: 60000 }), 'goto');
    await waitForToolbar(page);
    await quietPlayer(page);
    check('toolbar injected with the video button', true);
    if (CAPTURE) await captureFixture(evaluateInIsolatedWorld, page, V8K);

    if (!CAPTURE_ONLY) await videoPanelChecks(page, isolated);
    if (!CAPTURE_ONLY) await mouseOpenFocusChecks(page);
    if (!CAPTURE_ONLY) await keyboardOpenFocusChecks(page);
    if (!CAPTURE_ONLY) await audioPanelChecks(page, isolated);
    if (!CAPTURE_ONLY) await simulatedCompanionChecks(page, isolated);

    /* ================================================================ 2) dubbed video, light theme */
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    console.log(`\n[2] https://www.youtube.com/watch?v=${VDUB} (light)`);
    await retry(() => page.goto(`https://www.youtube.com/watch?v=${VDUB}`, { waitUntil: 'domcontentloaded', timeout: 60000 }), 'goto');
    await waitForToolbar(page);
    await quietPlayer(page);
    if (CAPTURE) await captureFixture(evaluateInIsolatedWorld, page, VDUB);
    if (!CAPTURE_ONLY) await dubChecks(page, isolated);
    if (!CAPTURE_ONLY) await spaNavigationChecks(page, isolated);
    if (!CAPTURE_ONLY) await shortsSurfaceChecks(page, isolated);

    if (!CAPTURE_ONLY) check('no [AYT] console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), stubs: staged.stubs, results }, null, 2));
  if (failed.length) process.exitCode = 1;
}

/* ------------------------------------------------------------------ video panel checks */
async function videoPanelChecks(page, isolated) {
  // Remember the host status (decides which behaviour to expect on click).
  const host = await isolated(() =>
    AYT.client.host
      .refresh(false)
      .then((s) => s || { state: 'unknown' })
      .catch((e) => ({ state: 'error', error: e.message }))
  );
  console.log(`    companion status: ${host.state}${host.error ? ' (' + host.error + ')' : ''}`);
  const hostReady = host.state === 'connected';
  if (hostReady) {
    // Never start a real 2 GB download from a test: capture the task instead.
    await isolated(() => {
      window.__aytE2eTasks = [];
      AYT.client.jobs.start = async (task, meta) => {
        window.__aytE2eTasks.push({ task, meta });
        return 'e2e-' + window.__aytE2eTasks.length;
      };
      return true;
    });
  }

  await isolated(() => {
    AYT.toolbar.open('video');
    return true;
  });
  const snap = await waitFor(async () => {
    const s = await panelSnapshot(page);
    return s && s.rows.length ? s : null;
  }, 30000, 'video rows');
  const s = await settledPanel(page);
  check('video panel title', /download video/i.test(s.title), s.title);
  const first = s.rows[0];
  check('first row is 4320p60', first && first.res === '4320p60', first && first.res);
  check('8K + HDR + 60FPS badges on the first row', first && ['8K', 'HDR', '60FPS'].every((b) => first.badges.includes(b)), first && first.badges.join(','));
  check('8K row has a GB size estimate', first && /\d.*GB$/.test(first.size.trim()), first && first.size);
  check('container label MP4', first && first.ext === 'MP4', first && first.ext);
  const resNums = s.rows.map((r) => parseInt(r.res, 10));
  check('rows sorted best first', resNums.every((v, i) => i === 0 || v <= resNums[i - 1]), s.rows.map((r) => r.res + (r.badges.includes('HDR') ? 'H' : '')).join(' '));
  check('there are SDR and HDR rows', s.rows.some((r) => r.badges.includes('HDR')) && s.rows.some((r) => !r.badges.includes('HDR')));
  // position: directly under the toolbar button, inside the viewport horizontally, not clipped vertically
  const p = s.panel;
  const b = s.button;
  check('panel opens under the toolbar button', b && Math.abs(p.top - (b.bottom + 8)) <= 2 && p.left <= b.left + 1 && p.right >= b.right, `panel top ${Math.round(p.top)} / button bottom ${b && Math.round(b.bottom)}`);
  check('panel inside the viewport horizontally', p.left >= 0 && p.right <= s.viewport.w, `${Math.round(p.left)}..${Math.round(p.right)} of ${s.viewport.w}`);
  check('panel not clipped at the bottom of the viewport', p.bottom <= s.viewport.h + 1, `bottom ${Math.round(p.bottom)} / ${s.viewport.h}`);
  check('panel theme follows YouTube (dark)', s.theme === 'dark', s.theme);
  const vis = await firstRowsVisible(page);
  check('first quality rows are visible inside the panel (not scrolled away)', vis.visible >= 4, `${vis.visible} rows fully visible, body ${vis.bodyH}px`);
  check('footer shows the save folder', /sav/i.test(s.footer), s.footer);

  if (!hostReady) {
    check('companion notice shown', s.notices.some((n) => /companion/i.test(n)), s.notices.join(' | '));
    check('rows visible but disabled without the companion', s.rows.length > 3 && s.rows.every((r) => r.disabled));
  }
  await shot(page, '1-video-panel-dark', false);
  await shot(page, '1-video-panel-dark-crop', true);

  // Click the 8K row.
  await clickInPanel(page, '.ayt-video-row', 0);
  if (!hostReady) {
    const toasts = await waitFor(async () => {
      const t = await toastTexts(page);
      return t.length ? t : null;
    }, 5000, 'toast after clicking a disabled row').catch(() => []);
    check('clicking a row without the companion explains what to do', toasts.some((t) => /companion/i.test(t)), toasts.join(' | '));
    await shot(page, '2-video-click-no-companion', false);
  } else {
    await sleep(800);
    const tasks = await isolated(() => window.__aytE2eTasks);
    const task = tasks && tasks[0] && tasks[0].task;
    check('row click builds the 8K HDR task', task && task.kind === 'video' && task.height === 4320 && task.hdr === true && task.fps === 60 && task.container === 'mp4', JSON.stringify(task));
  }

  // Clip mode: open the editor, set a 15 s range with the inputs, GIF button appears enabled.
  await clickInPanel(page, '.ayt-video-clip-toggle', 0);
  await waitFor(() => page.evaluate(() => !!document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-video-clip .ayt-dl-range')), 4000, 'clip editor');
  await typeInPanel(page, '.ayt-dl-range input.ayt-input--time', 0, '0:01:00');
  await typeInPanel(page, '.ayt-dl-range input.ayt-input--time', 1, '0:01:15');
  await sleep(400);
  const clip = await page.evaluate(() => {
    const root = document.getElementById('ayt-portal-host').shadowRoot;
    const gif = root.querySelector('.ayt-video-gif');
    return {
      len: (root.querySelector('.ayt-dl-range__len') || {}).textContent || '',
      gifDisabled: gif ? gif.disabled || gif.classList.contains('is-disabled') : null,
      firstSize: (root.querySelector('.ayt-video-row .ayt-row__size') || {}).textContent || '',
    };
  });
  check('clip length shows 00:15', /0?0:15/.test(clip.len), clip.len);
  check('GIF button available for a 15 s clip', clip.gifDisabled === false, `disabled=${clip.gifDisabled}`);
  check('row size follows the clip (MB, not GB)', /MB$/.test(clip.firstSize.trim()), clip.firstSize);
  await shot(page, '3-video-clip-dark', false);

  await isolated(() => {
    AYT.toolbar.close();
    return true;
  });
}

/* ------------------------------------------------------------------ mouse open: focus stays on the panel */
/**
 * A mouse click on the toolbar button opens the panel with focus on its container (toolbar.js): the panels must not
 * move focus onto a control afterwards, or Space (play/pause) would start the top download / switch the format.
 */
async function mouseOpenFocusChecks(page) {
  for (const id of ['video', 'audio']) {
    const pt = await page.evaluate((bid) => {
      const b = document.querySelector('#ayt-toolbar-host').shadowRoot.querySelector(`.ayt-tb-btn[data-id="${bid}"]`);
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, id);
    if (!pt) {
      check(`mouse open (${id}): toolbar button found`, false);
      continue;
    }
    await sleep(300);
    await page.mouse.click(pt.x, pt.y);
    const sel = id === 'video' ? '.ayt-video-row' : '.ayt-audio-go';
    await waitFor(() => page.evaluate((s) => !!document.getElementById('ayt-portal-host').shadowRoot.querySelector(s), sel), 20000, `${id} panel after a mouse click`);
    await sleep(700); // the panels focused their first control 60 ms after rendering
    const focus = await page.evaluate(() => {
      const a = document.getElementById('ayt-portal-host').shadowRoot.activeElement;
      return a ? (a.className && String(a.className)) || a.tagName : null;
    });
    check(`mouse open (${id}): focus stays on the panel container, not on a download control`, !focus || /ayt-panel\b/.test(focus), focus);
    await page.keyboard.press('Escape');
    await sleep(300);
  }
}

/* ------------------------------------------------------------------ keyboard open: focus moves to a safe control */
/**
 * Enter on a focused toolbar button (a trusted key press; the click it makes has detail 0) opens the panel with
 * ctx.viaKeyboard (DEVELOPER-SPEC §9.1): the video panel focuses its first row, the audio panel its selected format
 * option and never the Download button, so a second Enter/Space right after opening cannot start an audio download.
 * Only Escape is pressed while a panel is open.
 */
async function keyboardOpenFocusChecks(page) {
  for (const id of ['video', 'audio']) {
    const focused = await page.evaluate((bid) => {
      const root = document.querySelector('#ayt-toolbar-host').shadowRoot;
      const b = root.querySelector(`.ayt-tb-btn[data-id="${bid}"]`);
      if (!b) return false;
      b.scrollIntoView({ block: 'center' });
      b.focus();
      return root.activeElement === b;
    }, id);
    if (!focused) {
      check(`keyboard open (${id}): toolbar button focused`, false);
      continue;
    }
    await sleep(300);
    await page.keyboard.press('Enter');
    const sel = id === 'video' ? '.ayt-video-row' : '.ayt-audio-go';
    await waitFor(() => page.evaluate((s) => !!document.getElementById('ayt-portal-host').shadowRoot.querySelector(s), sel), 20000, `${id} panel after Enter`);
    await sleep(700); // the panels move focus 60 ms after rendering
    const focus = await page.evaluate(() => {
      const root = document.getElementById('ayt-portal-host').shadowRoot;
      const a = root.activeElement;
      return {
        name: a ? (a.className && String(a.className)) || a.tagName : null,
        firstRow: !!a && a === root.querySelector('.ayt-video-row'),
        selectedFormat: !!a && a === root.querySelector('.ayt-audio-formats .ayt-seg__opt.is-selected'),
      };
    });
    if (id === 'video') check('keyboard open (video): the first row gets focus', focus.firstRow, focus.name);
    else check('keyboard open (audio): the selected format gets focus, not the Download button', focus.selectedFormat, focus.name);
    await page.keyboard.press('Escape');
    await sleep(300);
  }
}

/* ------------------------------------------------------------------ audio panel checks */
async function audioPanelChecks(page, isolated) {
  await isolated(() => {
    AYT.toolbar.open('audio');
    return true;
  });
  await waitFor(() => page.evaluate(() => {
    const root = document.getElementById('ayt-portal-host').shadowRoot;
    return !!root.querySelector('.ayt-audio-go');
  }), 30000, 'audio panel');
  await sleep(500);
  const before = await audioState(page);
  check('audio panel title', /download audio/i.test(before.title), before.title);
  check('format segmented MP3/M4A/Opus/FLAC/WAV', before.formats.join(',') === 'MP3,M4A,Opus,FLAC,WAV', before.formats.join(','));
  check('bitrate select with Recommended 192 and Best 320', before.bitrates.some((x) => /192.*recommended/i.test(x)) && before.bitrates.some((x) => /320.*best/i.test(x)), before.bitrates.join(' | '));
  check('primary button label "Download MP3 · 192 kbps"', /download mp3 · 192 kbps/i.test(before.button), before.button);
  check('size estimate shown (whole video)', /\d/.test(before.estimate), before.estimate);

  await typeInPanel(page, '.ayt-dl-range input.ayt-input--time', 0, '0:00:30');
  await typeInPanel(page, '.ayt-dl-range input.ayt-input--time', 1, '0:01:45');
  await sleep(400);
  const after = await audioState(page);
  check('range inputs accepted (00:00:30 → 00:01:45)', after.inputs[0] === '00:00:30' && after.inputs[1] === '00:01:45', after.inputs.join(' → '));
  check('length display 01:15', /0?1:15/.test(after.len), after.len);
  check('estimate follows the range (MP3 192 kbps × 75 s ≈ 1.9 MB)', /^~?\s*1[.,]\d\s*MB/.test(after.estimate.replace(/^.*?(~?\s*\d)/, '$1')) || /1[.,]\d MB/.test(after.estimate), after.estimate);
  await shot(page, '4-audio-range-dark', false);
  await shot(page, '4-audio-range-dark-crop', true);

  // switch to FLAC: hint + label follow
  await clickInPanel(page, '.ayt-audio-formats .ayt-seg__opt', 3);
  await sleep(300);
  const flac = await audioState(page);
  check('FLAC: button label follows the choice', /download flac/i.test(flac.button), flac.button);
  check('FLAC: lossless hint shown', /lossless/i.test(flac.text), '');
  // restore MP3 so the persisted setting is not changed by the test profile run
  await clickInPanel(page, '.ayt-audio-formats .ayt-seg__opt', 0);
  await isolated(() => {
    AYT.toolbar.close();
    return true;
  });
}

function audioState(page) {
  return page.evaluate(() => {
    const root = document.getElementById('ayt-portal-host').shadowRoot;
    const panel = root.querySelector('.ayt-panel');
    const sel = panel.querySelector('.ayt-audio-bitrate select');
    return {
      title: (panel.querySelector('.ayt-panel__title') || {}).textContent || '',
      formats: Array.from(panel.querySelectorAll('.ayt-audio-formats .ayt-seg__opt')).map((b) => b.textContent.trim()),
      bitrates: sel ? Array.from(sel.options).map((o) => o.textContent) : [],
      button: (panel.querySelector('.ayt-audio-go') || {}).textContent || '',
      estimate: (panel.querySelector('.ayt-audio-estimate') || {}).textContent || '',
      len: (panel.querySelector('.ayt-dl-range__len') || {}).textContent || '',
      inputs: Array.from(panel.querySelectorAll('.ayt-dl-range input.ayt-input--time')).map((i) => i.value),
      text: panel.textContent.replace(/\s+/g, ' '),
    };
  });
}

/* ------------------------------------------------------------------ simulated companion (UI states + task path) */
/**
 * Pretends the companion is connected and a 2160p60 HDR download of this video is running, by overriding
 * AYT.client in the isolated world (no message reaches the service worker, nothing is downloaded). Verifies the
 * enabled / hover / busy row states, the job list, and that clicking rows / the audio button builds the right task.
 */
async function simulatedCompanionChecks(page, isolated) {
  console.log('    (simulated companion: connected + one running job)');
  await isolated(() => {
    const status = { state: 'connected', version: '1.0.0', protocol: 1, downloadsDir: 'C:\\Users\\you\\Downloads', defaultDir: 'C:\\Users\\you\\Downloads\\Akif YouTube', checkedAt: Date.now() };
    Object.defineProperty(AYT.client.host, 'status', { configurable: true, get: () => status });
    AYT.client.host.refresh = async () => status;
    // the real service worker would push host:missing + an empty job list over the live port: mute those
    const origOn = AYT.client.on.bind(AYT.client);
    AYT.client.on = (ev, fn) => (ev === 'host' || ev === 'jobs' || ev === 'job' ? () => {} : origOn(ev, fn));
    AYT.client.retain = () => () => {};
    AYT.client.release = () => {};
    const vid = AYT.page.videoId;
    const now = Date.now();
    window.__aytE2eJobs = [
      {
        id: 'e2e-run', kind: 'video', videoId: vid, title: 'Peru 8K HDR 60FPS (FUHD)', label: 'MP4 · 2160p60 · HDR', thumbnail: null,
        status: 'running', stage: 'video', percent: 42.4, downloaded: 450 * 1048576, total: 1011 * 1048576, speed: 12.5 * 1048576, eta: 49,
        task: { kind: 'video', videoId: vid, playlist: false, height: 2160, width: 3840, hdr: true, fps: 60, container: 'mp4', codec: 'auto', audioLang: null, section: null, preciseCut: false },
        createdAt: now, updatedAt: now,
      },
      {
        id: 'e2e-done', kind: 'audio', videoId: vid, title: 'Peru 8K HDR 60FPS (FUHD)', label: 'MP3 · 192 kbps', thumbnail: null,
        status: 'done', percent: 100, fileSize: 8265600, filePath: 'C:\\Users\\you\\Downloads\\Akif YouTube\\Peru.mp3',
        task: { kind: 'audio', videoId: vid, playlist: false, audioFormat: 'mp3', bitrate: 192, section: null }, createdAt: now - 60000, updatedAt: now,
      },
    ];
    AYT.client.jobs.list = () => window.__aytE2eJobs.slice();
    window.__aytE2eTasks = [];
    AYT.client.jobs.start = async (task, meta) => {
      window.__aytE2eTasks.push({ task, meta });
      return 'e2e-' + window.__aytE2eTasks.length;
    };
    AYT.toolbar.open('video');
    return true;
  });
  await waitFor(async () => {
    const s = await panelSnapshot(page);
    return s && s.rows.length ? s : null;
  }, 20000, 'video rows (simulated companion)');
  await sleep(1600);
  const s = await panelSnapshot(page);
  check('simulated: rows enabled, no companion notice', s.rows.every((r) => !r.disabled) && !s.notices.some((n) => /companion/i.test(n)), s.notices.join(' | '));
  const busy = await page.evaluate(() => {
    const root = document.getElementById('ayt-portal-host').shadowRoot;
    return Array.from(root.querySelectorAll('.ayt-video-row.is-busy')).map((r) => ({
      res: r.querySelector('.ayt-row__res').textContent,
      size: r.querySelector('.ayt-row__size').textContent,
      bar: !r.querySelector('.ayt-row__progress').classList.contains('ayt-hidden'),
      hdr: !!Array.from(r.querySelectorAll('.ayt-badge')).find((b) => b.textContent === 'HDR'),
    }));
  });
  check('simulated: the running 2160p60 HDR row is busy with 42% + progress bar', busy.length === 1 && busy[0].res === '2160p60' && busy[0].hdr && busy[0].size === '42%' && busy[0].bar, JSON.stringify(busy));
  const jobs = await page.evaluate(() => document.getElementById('ayt-portal-host').shadowRoot.querySelectorAll('.ayt-video-jobs .ayt-job').length);
  check('simulated: job list shows the running video job (not the audio one)', jobs === 1, `${jobs} job item(s)`);
  // only the folder's own name: our shadow roots are open, and the absolute path contains the Windows user name
  const footerDom = await page.evaluate(() => {
    const footer = document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-panel__footer');
    return footer ? footer.textContent + ' ' + Array.from(footer.querySelectorAll('[title], [aria-label]')).map((x) => (x.title || '') + ' ' + (x.getAttribute('aria-label') || '')).join(' ') : '';
  });
  check('simulated: footer names the companion folder without its absolute path', /Downloads › Akif YouTube/.test(s.footer) && !/[A-Z]:\\|\\Users\\|you\\/.test(footerDom), footerDom);
  const ring = await page.evaluate(() => !!document.querySelector('#ayt-toolbar-host').shadowRoot.querySelector('.ayt-tb-btn[data-id="video"] .ayt-tb-btn__ring'));
  check('simulated: toolbar video button shows a progress ring', ring);
  // hover glow on the 8K row
  const pt = await page.evaluate(() => {
    const r = document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-video-row').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(pt.x, pt.y);
  await sleep(350);
  await shot(page, '6-video-enabled-hover-busy-dark', false);
  await shot(page, '6-video-enabled-hover-busy-dark-crop', true);

  // click the 8K row -> task
  await page.mouse.click(pt.x, pt.y);
  await sleep(700);
  let tasks = await isolated(() => window.__aytE2eTasks);
  const t1 = tasks[0] && tasks[0].task;
  check(
    'simulated: 8K row click -> video task (4320, HDR, 60 fps, mp4, best quality)',
    t1 && t1.kind === 'video' && t1.videoId === V8K && t1.height === 4320 && t1.width === 7680 && t1.hdr === true && t1.fps === 60 && t1.container === 'mp4' && t1.section === null && t1.playlist === false && t1.url === 'https://www.youtube.com/watch?v=' + t1.videoId,
    JSON.stringify(t1)
  );
  check('simulated: job meta label + thumbnail', tasks[0] && tasks[0].meta.label === 'MP4 · 4320p60 · HDR' && /^https:\/\/i\.ytimg\.com\/vi\/[\w-]{11}\/mqdefault\.jpg$/.test(tasks[0].meta.thumbnail), JSON.stringify(tasks[0] && tasks[0].meta));
  const toasts = await toastTexts(page);
  check('simulated: "Download started" toast', toasts.some((x) => /download started/i.test(x)), toasts.join(' | '));
  // clicking the busy row again is refused as a duplicate
  await clickInPanel(page, '.ayt-video-row.is-busy', 0);
  await sleep(500);
  tasks = await isolated(() => window.__aytE2eTasks);
  const toasts2 = await toastTexts(page);
  check('simulated: busy row is not started twice', tasks.length === 1 && toasts2.some((x) => /already in progress/i.test(x)), toasts2.join(' | '));
  // clip + GIF task
  await clickInPanel(page, '.ayt-video-clip-toggle', 0);
  await waitFor(() => page.evaluate(() => !!document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-video-clip .ayt-dl-range')), 4000, 'clip editor');
  await typeInPanel(page, '.ayt-dl-range input.ayt-input--time', 0, '0:02:00');
  await typeInPanel(page, '.ayt-dl-range input.ayt-input--time', 1, '0:02:12');
  await sleep(300);
  await clickInPanel(page, '.ayt-video-gif', 0);
  await sleep(600);
  tasks = await isolated(() => window.__aytE2eTasks);
  const gif = tasks[1] && tasks[1].task;
  check('simulated: GIF task for 02:00–02:12', gif && gif.kind === 'gif' && gif.section && gif.section.start === 120 && gif.section.end === 132 && gif.gifWidth === 480 && gif.gifFps === 15, JSON.stringify(gif));
  await shot(page, '7-video-clip-enabled-dark', false);
  await isolated(() => {
    AYT.toolbar.close();
    return true;
  });

  // audio panel: download button -> task
  await isolated(() => {
    AYT.toolbar.open('audio');
    return true;
  });
  await waitFor(() => page.evaluate(() => !!document.getElementById('ayt-portal-host').shadowRoot.querySelector('.ayt-audio-go')), 20000, 'audio panel');
  await sleep(1400);
  const au = await audioState(page);
  check('simulated: audio panel without notice, job list shows the finished MP3', !/companion app not installed/i.test(au.text) && /completed/i.test(au.text), au.text.slice(0, 160));
  await clickInPanel(page, '.ayt-audio-go', 0);
  await sleep(600);
  tasks = await isolated(() => window.__aytE2eTasks);
  const at = tasks[2] && tasks[2].task;
  check('simulated: audio button -> MP3 192 kbps task', at && at.kind === 'audio' && at.audioFormat === 'mp3' && at.bitrate === 192 && at.section === null && at.playlist === false, JSON.stringify(at));
  await shot(page, '8-audio-enabled-dark', false);
  await isolated(() => {
    AYT.toolbar.close();
    return true;
  });
}

/* ------------------------------------------------------------------ SPA navigation with the panel open */
const VSPA = 'jNQXAC9IVRw'; // "Me at the zoo": 19 s, ≤ 240p, one audio track

/**
 * Opens the video panel, then navigates inside YouTube's app (the 'yt-navigate' event its own links fire, no page
 * load) to another video. The panel must stay open and reload itself for the new video (onVideoChange).
 */
async function spaNavigationChecks(page, isolated) {
  await isolated(() => {
    AYT.toolbar.open('video');
    return true;
  });
  await waitFor(async () => {
    const s = await panelSnapshot(page);
    return s && s.rows.length && s.langOptions ? s : null;
  }, 20000, 'video panel before SPA navigation');
  const navigated = await page.evaluate((id) => {
    const app = document.querySelector('ytd-app');
    if (!app) return false;
    app.dispatchEvent(
      new CustomEvent('yt-navigate', {
        bubbles: true,
        composed: true,
        detail: { endpoint: { commandMetadata: { webCommandMetadata: { url: '/watch?v=' + id, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832 } }, watchEndpoint: { videoId: id } } },
      })
    );
    return true;
  }, VSPA);
  const arrived = navigated && (await waitFor(() => page.evaluate((id) => location.search.includes('v=' + id), VSPA), 20000, 'SPA navigation').then(() => true, () => false));
  if (!arrived) {
    console.log('  - SKIPPED: SPA navigation could not be triggered in this YouTube build (yt-navigate ignored)');
    results.push({ name: 'SPA navigation keeps the panel and reloads it (skipped: navigation not triggered)', ok: true, detail: 'skipped' });
    await isolated(() => {
      AYT.toolbar.close();
      return true;
    });
    return;
  }
  await quietPlayer(page);
  const after = await waitFor(async () => {
    const s = await panelSnapshot(page);
    // the new video has one audio track (no language select) and at most 240p
    return s && s.rows.length && !s.langOptions && parseInt(s.rows[0].res, 10) <= 240 ? s : null;
  }, 25000, 'panel reloaded for the new video').catch(() => null);
  const state = await isolated(
    (id) => ({ open: AYT.toolbar.isOpen('video'), pageVideo: AYT.page.videoId, cached: !!AYT.videoInfo.peek(id) }),
    VSPA
  );
  check('SPA navigation: panel stays open and reloads for the new video', !!after && state.open && state.pageVideo === VSPA && state.cached, after ? `rows ${after.rows.map((r) => r.res).join(' ')}, lang select: ${!!after.langOptions}` : 'panel did not refresh');
  // YouTube scrolls to the top on navigation; the panel must fit the viewport again
  const settled = await settledPanel(page);
  check('SPA navigation: panel re-fits the viewport after YouTube scrolled to the top', settled && settled.panel.bottom <= settled.viewport.h + 1 && (await firstRowsVisible(page)).visible >= 1, settled ? `bottom ${Math.round(settled.panel.bottom)} / ${settled.viewport.h}` : '');
  await shot(page, '10-video-after-spa-light', false);
  await isolated(() => {
    AYT.toolbar.close();
    return true;
  });
}

/* ------------------------------------------------------------------ Shorts surface (380 px popover) */
/**
 * Renders both panels the way the Shorts popover does (AYT.toolbar.renderPanelInto(id, box, {surface:'shorts'}))
 * into a 380 px themed box on the current page, and checks the compact layout does not overflow horizontally.
 */
async function shortsSurfaceChecks(page, isolated) {
  for (const id of ['video', 'audio']) {
    await isolated((panelId) => {
      const old = document.getElementById('ayt-e2e-shorts-host');
      if (old) {
        if (window.__aytE2eShorts) window.__aytE2eShorts.destroy();
        old.remove();
      }
      const { h } = AYT.dom;
      const host = h('div', { id: 'ayt-e2e-shorts-host', style: 'all: initial; position: fixed; top: 64px; right: 24px; width: 380px; z-index: 2147482000;' });
      const sr = host.attachShadow({ mode: 'open' });
      AYT.ui.mountStyles(sr);
      const wrap = h('div', { class: 'ayt-root' });
      AYT.ui.applyTheme(wrap);
      const body = h('div', { class: 'ayt-panel__body' });
      wrap.appendChild(h('div', { class: 'ayt-panel', style: { position: 'relative', '--ayt-panel-w': '380px', '--ayt-panel-h': '900px' } }, body));
      sr.appendChild(wrap);
      document.body.appendChild(host);
      window.__aytE2eShorts = AYT.toolbar.renderPanelInto(panelId, body, { surface: 'shorts', close() {} });
      return true;
    }, id);
    const sel = id === 'video' ? '.ayt-video-row' : '.ayt-audio-go';
    await waitFor(() => page.evaluate((s) => !!document.getElementById('ayt-e2e-shorts-host').shadowRoot.querySelector(s), sel), 20000, `${id} panel in the shorts surface`);
    await sleep(700);
    const m = await page.evaluate(() => {
      const sr = document.getElementById('ayt-e2e-shorts-host').shadowRoot;
      const body = sr.querySelector('.ayt-panel__body');
      const over = [];
      for (const el of sr.querySelectorAll('.ayt-video-row, .ayt-seg, .ayt-dl-range__times, .ayt-audio-go, .ayt-dl-folder, .ayt-dl-bar')) {
        if (el.offsetParent === null) continue;
        if (el.scrollWidth > el.clientWidth + 1) over.push(el.className.split(' ').slice(-1)[0] + ':' + el.scrollWidth + '>' + el.clientWidth);
      }
      const rows = Array.from(sr.querySelectorAll('.ayt-video-row')).filter((r) => r.offsetParent !== null);
      return {
        compact: !!sr.querySelector('.ayt-dl--compact'),
        bodyOverflow: body.scrollWidth > body.clientWidth + 1,
        over,
        maxRowH: rows.length ? Math.max(...rows.map((r) => r.getBoundingClientRect().height)) : 0,
        surfaceSurfaceText: body.textContent.replace(/\s+/g, ' ').slice(0, 120),
      };
    });
    check(`shorts surface (380 px): ${id} panel uses the compact layout without horizontal overflow`, m.compact && !m.bodyOverflow && m.over.length === 0 && (id !== 'video' || m.maxRowH <= 56), JSON.stringify({ over: m.over, maxRowH: m.maxRowH }));
    await shot(page, `9-shorts-surface-${id}-light`, false);
  }
  await isolated(() => {
    if (window.__aytE2eShorts) window.__aytE2eShorts.destroy();
    const old = document.getElementById('ayt-e2e-shorts-host');
    if (old) old.remove();
    return true;
  });
}

/* ------------------------------------------------------------------ dubbed video checks */
async function dubChecks(page, isolated) {
  await isolated(() => {
    AYT.toolbar.open('video');
    return true;
  });
  const s = await waitFor(async () => {
    const x = await panelSnapshot(page);
    return x && x.rows.length && x.langOptions ? x : null;
  }, 30000, 'video panel with the audio-language select');
  await sleep(600);
  const s2 = (await settledPanel(page)) || s;
  const vis = await firstRowsVisible(page);
  check('rows visible inside the panel (light)', vis.visible >= 3, `${vis.visible} rows fully visible`);
  const opts = s2.langOptions || [];
  check('audio-language select lists the dubs (26 tracks)', opts.length === 26, `${opts.length} options`);
  check('original track first and selected', opts[0] && /original/i.test(opts[0].label) && s2.langValue === opts[0].value, opts[0] && opts[0].label);
  check('dubs include Turkish and Japanese', opts.some((o) => /turkish/i.test(o.label)) && opts.some((o) => /japanese/i.test(o.label)), opts.slice(0, 6).map((o) => o.label).join(', ') + ' …');
  check('panel theme follows YouTube (light)', s2.theme === 'light', s2.theme);
  check('panel not clipped (light)', s2.panel.bottom <= s2.viewport.h + 1 && s2.panel.right <= s2.viewport.w, `bottom ${Math.round(s2.panel.bottom)}`);
  await shot(page, '5-video-dubs-light', false);
  await shot(page, '5-video-dubs-light-crop', true);

  // choose the Turkish dub: sizes must still render, label in tasks follows (checked in unit tests)
  const tr = opts.find((o) => /turkish/i.test(o.label));
  if (tr) {
    // Our shadow roots drop script-made events unless the isolated world opted in (see AYT.keys.guard).
    await isolated(() => {
      AYT.testMode = true;
      return true;
    });
    await page.evaluate((v) => {
      const root = document.getElementById('ayt-portal-host').shadowRoot;
      const sel = root.querySelector('.ayt-dl-lang select');
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, tr.value);
    await sleep(300);
    const s3 = await panelSnapshot(page);
    check('rows still rendered after choosing a dub', s3.rows.length > 0 && s3.langValue === tr.value, s3.langValue);
  }
  await isolated(() => {
    AYT.toolbar.close();
    return true;
  });
}

main().catch((e) => {
  console.error('E2E FAILED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
