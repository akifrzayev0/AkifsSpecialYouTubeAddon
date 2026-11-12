// harness.mjs — load an unpacked MV3 extension into the INSTALLED branded Chrome (137+, verified on 157)
// in new-headless mode with puppeteer-core, and give tests access to the page, the extension
// service worker and the content-script isolated world.
//
// Why this approach: branded Chrome >= 137 ignores --load-extension (verified: also ignored with
// --disable-features=DisableLoadExtensionCommandLineSwitch on 157). The CDP command
// Extensions.loadUnpacked (puppeteer: browser.installExtension) works when the browser is launched
// with enableExtensions:true (which removes puppeteer's default --disable-extensions). pipe:true is
// the documented transport; on 157 it also worked over a WebSocket.
//
// Usage:
//   import { launchWithExtension } from './harness.mjs';
//   const { browser, page, extensionId, getServiceWorker, evaluateInIsolatedWorld, close } =
//     await launchWithExtension('C:/path/to/extension', { userDataDir: 'C:/scratch/profile' });
//   await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
//   const sw = await getServiceWorker();            // puppeteer WebWorker
//   console.log(await sw.evaluate(() => chrome.runtime.id));
//   console.log(await evaluateInIsolatedWorld(page, () => document.getElementById('ayt-test-marker')?.dataset));
//   await close();
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/**
 * @param {string} extPath  folder containing manifest.json (unpacked extension)
 * @param {object} [opts]
 * @param {string} [opts.executablePath]   Chrome binary (default: installed stable Chrome)
 * @param {string} [opts.userDataDir]      profile dir (default: new temp dir). NEVER point this at a real profile.
 * @param {boolean} [opts.freshProfile]    delete userDataDir before launch
 * @param {boolean|'shell'} [opts.headless] true = new headless (default), false = headful
 * @param {boolean} [opts.stealth]         default true: navigator.webdriver=false. REQUIRED for YouTube
 *                                         caption PO tokens to be accepted (tokens minted while
 *                                         navigator.webdriver===true make /api/timedtext return empty 200s).
 * @param {boolean} [opts.fixUserAgent]    default true: strip "HeadlessChrome" from UA + UA-CH brands
 * @param {{width:number,height:number}} [opts.viewport]
 * @param {string} [opts.lang]             default 'en-US'
 * @param {string[]} [opts.args]           extra Chrome args
 * @param {boolean} [opts.pipe]            default true
 * @param {string} [opts.url]              optional URL to open after installing the extension
 */
export async function launchWithExtension(extPath, opts = {}) {
  const {
    executablePath = DEFAULT_CHROME,
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayt-harness-profile-')),
    freshProfile = false,
    headless = true,
    stealth = true,
    fixUserAgent = true,
    viewport = { width: 1600, height: 1000 },
    lang = 'en-US',
    args = [],
    pipe = true,
    url = null,
  } = opts;
  const absExt = path.resolve(extPath);
  if (!fs.existsSync(path.join(absExt, 'manifest.json'))) throw new Error(`No manifest.json in ${absExt}`);
  if (freshProfile) fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath,
    headless,
    userDataDir,
    pipe,
    enableExtensions: true, // removes --disable-extensions; do NOT pass the array form (its promises are not awaited in puppeteer 25.x)
    defaultViewport: viewport,
    ignoreDefaultArgs: stealth ? ['--enable-automation'] : [],
    args: [
      `--lang=${lang}`,
      `--window-size=${viewport.width},${viewport.height}`,
      '--autoplay-policy=no-user-gesture-required',
      ...(stealth ? ['--disable-blink-features=AutomationControlled'] : []),
      ...args,
    ],
    protocolTimeout: 120000,
  });

  let extensionId;
  try {
    extensionId = await browser.installExtension(absExt); // CDP Extensions.loadUnpacked
  } catch (e) {
    await browser.close().catch(() => {});
    throw new Error(`Extensions.loadUnpacked failed: ${e.message}. Try args:['--enable-unsafe-extension-debugging'] and pipe:true.`);
  }

  const page = (await browser.pages())[0] || (await browser.newPage());
  if (fixUserAgent) await fixPageUserAgent(page);
  browser.on('targetcreated', async (t) => { if (fixUserAgent && t.type() === 'page') { try { await fixPageUserAgent(await t.page()); } catch (e) { /* ignore */ } } });

  const isOurSw = (t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extensionId}/`);

  /**
   * Returns a live puppeteer WebWorker for the extension service worker. Handles two cases seen on 157:
   *  - no SW target (worker idle-terminated / not started yet) -> wake it, wait for the target;
   *  - stale SW target still listed after the worker was stopped (evaluate would hang until
   *    protocolTimeout) -> liveness probe with a 2 s race, then wake and retry.
   */
  async function getServiceWorker({ timeout = 20000 } = {}) {
    const deadline = Date.now() + timeout;
    let woke = false;
    while (Date.now() < deadline) {
      const targets = browser.targets().filter(isOurSw).reverse(); // newest first
      for (const t of targets) {
        // t.worker() itself can hang on a stale target, so race the whole probe
        const w = await Promise.race([
          (async () => { const wk = await t.worker(); if (!wk) return null; await wk.evaluate(() => chrome.runtime.id); return wk; })().catch(() => null),
          new Promise((r) => setTimeout(() => r(null), 2500)),
        ]);
        if (w) return w;
      }
      if (!woke) { woke = true; await wakeServiceWorker().catch(() => {}); }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`extension service worker for ${extensionId} not reachable within ${timeout} ms`);
  }

  /**
   * Wake an idle MV3 service worker. Verified on Chrome 157: a tab showing chrome-extension://<id>/manifest.json
   * is an extension-origin context where chrome.runtime.sendMessage works, and sending any message starts the
   * worker (no extra files needed in the extension). Returns the reply/err string for diagnostics.
   */
  async function wakeServiceWorker({ timeout = 5000 } = {}) {
    // NOTE: after a CDP ServiceWorker.stopAllWorkers the worker could not be restarted while puppeteer stayed
    // attached (sendMessage never resolved) - hence the timeout. Normal idle termination does not happen while
    // the harness is attached (verified: same SW instance after 40 s idle).
    const p = await browser.newPage();
    try {
      await p.goto(`chrome-extension://${extensionId}/manifest.json`, { waitUntil: 'domcontentloaded' });
      return await Promise.race([
        p.evaluate(() => chrome.runtime.sendMessage({ __aytWake: 1 }).then((r) => JSON.stringify(r ?? null), (e) => 'ERR ' + e.message)),
        new Promise((r) => setTimeout(() => r('wake timeout'), timeout)),
      ]);
    } finally { p.close().catch(() => {}); }
  }

  /** Run code in an extension-origin page (chrome.* APIs available like in a popup/options page). */
  async function evaluateInExtensionPage(fn, ...fnArgs) {
    const p = await browser.newPage();
    try {
      await p.goto(`chrome-extension://${extensionId}/manifest.json`, { waitUntil: 'domcontentloaded' });
      return await p.evaluate(fn, ...fnArgs);
    } finally { await p.close().catch(() => {}); }
  }

  /**
   * Evaluate code inside the extension's content-script isolated world of `pg` (main frame).
   * fnOrExpr: function (serialized, no closures) or expression string. Returns JSON value.
   */
  async function evaluateInIsolatedWorld(pg, fnOrExpr, ...fnArgs) {
    const s = await pg.createCDPSession();
    try {
      const contexts = [];
      s.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
      await s.send('Runtime.enable'); // replays existing contexts synchronously before resolving
      const { frameTree } = await s.send('Page.getFrameTree');
      const mainFrameId = frameTree.frame.id;
      const ctx = contexts.find((c) => c.auxData && c.auxData.frameId === mainFrameId && c.auxData.type === 'isolated' && (c.origin || '').includes(extensionId))
        || contexts.find((c) => c.auxData && c.auxData.frameId === mainFrameId && c.auxData.type === 'isolated' && !/puppeteer/i.test(c.name));
      if (!ctx) throw new Error('content-script isolated world not found (did the content script run on this page?)');
      const expression = typeof fnOrExpr === 'function' ? `(${fnOrExpr.toString()})(...${JSON.stringify(fnArgs)})` : String(fnOrExpr);
      const r = await s.send('Runtime.evaluate', { expression, contextId: ctx.id, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('isolated-world evaluation threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      return r.result.value;
    } finally { await s.detach().catch(() => {}); }
  }

  /** Re-load the unpacked extension from disk (same path => same id). Re-navigate pages afterwards. */
  async function reloadExtension() { extensionId = await browser.installExtension(absExt); return extensionId; }

  async function close() { await browser.close().catch(() => {}); }

  if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { browser, page, get extensionId() { return extensionId; }, userDataDir, getServiceWorker, wakeServiceWorker, evaluateInIsolatedWorld, evaluateInExtensionPage, reloadExtension, close };
}

/** Strip "HeadlessChrome" from navigator.userAgent and UA-CH brands for one page. */
export async function fixPageUserAgent(page) {
  const raw = await page.browser().userAgent();
  const ua = raw.replace('HeadlessChrome', 'Chrome');
  const full = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || '157.0.0.0';
  const major = full.split('.')[0];
  await page.setUserAgent({
    userAgent: ua,
    userAgentMetadata: {
      brands: [{ brand: 'Google Chrome', version: major }, { brand: 'Chromium', version: major }, { brand: 'Not_A Brand', version: '24' }],
      fullVersionList: [{ brand: 'Google Chrome', version: full }, { brand: 'Chromium', version: full }, { brand: 'Not_A Brand', version: '24.0.0.0' }],
      fullVersion: full, platform: 'Windows', platformVersion: '19.0.0', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false,
    },
  });
}
