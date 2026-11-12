#!/usr/bin/env node
/*
 * E2E test for the TOOLS module (content/tools/*.js, content/shorts.js, content/page.css).
 *
 *   node tools/e2e/tools.e2e.mjs [--out <dir>] [--headful] [--skip-shorts] [--skip-watch]
 *
 * Loads the unpacked extension into the installed Chrome (headless, stealth) via harness.mjs and
 * checks on a real watch page (dQw4w9WgXcQ):
 *   toolbar buttons render · hide comments/related/end screen (computed styles + "hidden" pill) ·
 *   comments toolbar toggle · speed 3× sticks on the <video> · native A-B loop wraps currentTime
 *   (+ progress-bar markers) · volume boost builds the Web Audio graph without errors ·
 *   video adjustments set CSS vars / filter / transform on the <video> · cinema overlay above the
 *   page with the player and toolbar above it (+ click-to-exit) · picture-in-picture toggle ·
 *   light-theme rendering
 * and on a Shorts page: the injected button exists, survives an ArrowDown swipe, the popover opens
 * with the registered Shorts panels and closes with Escape.
 * Screenshots + tools-e2e-report.json are written to --out (default: <tmp>/ayt-tools-e2e).
 * If files referenced by manifest.json are still missing (modules written in parallel), a copy of
 * the extension with empty stubs for them is loaded instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, 'extension');
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const OUT = path.resolve(arg('--out') || path.join(os.tmpdir(), 'ayt-tools-e2e'));
const HEADLESS = !args.includes('--headful');
const WATCH_ID = 'dQw4w9WgXcQ';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const notes = [];
let failures = 0;

function check(name, ok, details) {
  results.push({ name, ok: !!ok, details: details === undefined ? null : details });
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${details !== undefined ? '  ' + JSON.stringify(details).slice(0, 400) : ''}`);
}
const note = (msg) => {
  notes.push(msg);
  console.log('  · ' + msg);
};

/** Retry once on CDP protocol hiccups (other engineers run headless Chrome at the same time). */
async function retry(fn, label) {
  try {
    return await fn();
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/protocol|timed out|Target closed|Session closed|detached/i.test(msg)) {
      note(`retrying ${label} after: ${msg.slice(0, 120)}`);
      await sleep(1500);
      return fn();
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ extension dir */
function prepareExtension() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const refs = new Set([manifest.background.service_worker]);
  for (const cs of manifest.content_scripts || []) [...(cs.js || []), ...(cs.css || [])].forEach((p) => refs.add(p));
  const missing = [...refs].filter((p) => !fs.existsSync(path.join(EXT, p)));
  if (!missing.length) return EXT;
  const copy = path.join(OUT, 'ext-copy');
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(EXT, copy, { recursive: true });
  for (const p of missing) {
    const f = path.join(copy, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `/* stub written by tools.e2e.mjs: ${p} does not exist yet */\n`);
  }
  note('manifest files missing, using a stubbed copy for: ' + missing.join(', '));
  return copy;
}

/* ------------------------------------------------------------------ tabs */
/**
 * The service worker opens the options page in a new tab on install (spec §7.5). That pushes the
 * YouTube tab into the background, where Chrome stops rendering / autoplay / rAF and
 * IntersectionObserver delivery: videos never start and puppeteer's click() (which waits for an
 * IntersectionObserver) hangs until the protocol timeout. Close extra tabs and focus ours.
 */
async function focusOurTab(h, waitMs = 1500) {
  await sleep(waitMs);
  for (const p of await h.browser.pages()) {
    if (p !== h.page) await p.close().catch(() => {});
  }
  await h.page.bringToFront();
}

/* ------------------------------------------------------------------ page helpers */
/** Waits until no ad plays (skips/fast-forwards ads like the research harness). */
async function waitNoAd(page, timeout = 90000) {
  const t0 = Date.now();
  let sawAd = false;
  while (Date.now() - t0 < timeout) {
    const st = await page.evaluate(() => {
      const mp = document.getElementById('movie_player');
      if (!mp || typeof mp.getPlayerState !== 'function') return { ready: false };
      const ad = mp.classList.contains('ad-showing') || mp.classList.contains('ad-interrupting');
      const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button, button[id^="skip-button"]');
      const skipVisible = !!(skip && skip.offsetParent !== null && getComputedStyle(skip).display !== 'none');
      return { ready: true, ad, skipVisible };
    });
    if (st.ready && !st.ad) return { sawAd, waited: Date.now() - t0 };
    if (st.ad) {
      sawAd = true;
      if (st.skipVisible) {
        await page.click('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button, button[id^="skip-button"]').catch(() => {});
      } else {
        await page.evaluate(() => {
          const v = document.querySelector('#movie_player video');
          if (v && isFinite(v.duration) && v.duration > 1 && v.currentTime < v.duration - 0.5) v.currentTime = v.duration - 0.25;
        });
      }
    }
    await sleep(500);
  }
  return { sawAd, timeout: true };
}

async function muteAndPlay(page, play = true) {
  await page.evaluate((doPlay) => {
    const mp = document.getElementById('movie_player');
    try {
      if (mp && mp.mute) mp.mute();
    } catch (_) {}
    const v = mp && mp.querySelector('video');
    if (v) {
      v.muted = true;
      if (doPlay) v.play().catch(() => {});
      else v.pause();
    }
  }, play);
}

/** clip: viewport coordinates (getBoundingClientRect); converted to document coordinates for CDP. */
async function shot(page, name, clip) {
  const file = path.join(OUT, name);
  try {
    if (clip) {
      const d = await page.evaluate(() => ({ sx: window.scrollX, sy: window.scrollY, w: document.documentElement.scrollWidth }));
      const x = Math.max(0, Math.floor(clip.x + d.sx));
      const y = Math.max(0, Math.floor(clip.y + d.sy));
      const width = Math.max(1, Math.min(Math.ceil(clip.width), d.w - x));
      const height = Math.max(1, Math.ceil(clip.height));
      await page.screenshot({ path: file, clip: { x, y, width, height }, captureBeyondViewport: true });
    } else await page.screenshot({ path: file });
    note('screenshot ' + file);
  } catch (e) {
    note(`screenshot ${name} failed: ${e.message}`);
  }
  return file;
}

const rectOf = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel);

/** Bounding rect of the open panel in our portal (shadow DOM). */
const panelRect = (page) =>
  page.evaluate(() => {
    const host = document.getElementById('ayt-portal-host');
    const p = host && host.shadowRoot && host.shadowRoot.querySelector('.ayt-panel');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

/** Element screenshot (puppeteer scrolls it into view and handles the coordinates). */
async function shotEl(page, selector, name) {
  const file = path.join(OUT, name);
  try {
    const el = await page.$(selector);
    if (!el) return null;
    await el.screenshot({ path: file });
    note('screenshot ' + file);
    return file;
  } catch (e) {
    note(`screenshot ${name} failed: ${e.message}`);
    return null;
  }
}
const shotPanel = (page, name) => shotEl(page, '#ayt-portal-host >>> .ayt-panel', name);

async function clickToolbar(page, id) {
  const h = await page.waitForSelector(`#ayt-toolbar-host >>> button[data-id="${id}"]`, { timeout: 10000 });
  await h.click();
  await sleep(350);
}

async function openPanel(page, id) {
  await clickToolbar(page, id);
  await page.waitForSelector('#ayt-portal-host >>> .ayt-panel', { timeout: 8000 });
  await sleep(400);
}

async function closePanel(page) {
  const h = await page.$('#ayt-portal-host >>> .ayt-panel__close');
  if (h) await h.click().catch(() => {});
  await sleep(250);
}

/* ------------------------------------------------------------------ watch page */
async function watchTests(ctx) {
  const { page, iso } = ctx;
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await retry(() => page.goto(`https://www.youtube.com/watch?v=${WATCH_ID}`, { waitUntil: 'domcontentloaded', timeout: 60000 }), 'goto watch');
  await page.waitForSelector('#movie_player video', { timeout: 40000 });
  await resetSettings(iso);
  await muteAndPlay(page);
  const ad = await waitNoAd(page);
  if (ad.sawAd) note('an ad was skipped/fast-forwarded before the tests');
  await muteAndPlay(page);

  /* ---- toolbar */
  await page.waitForSelector('#ayt-toolbar-host >>> button[data-id="loop"]', { timeout: 20000 });
  await sleep(800);
  const tb = await page.evaluate(() => {
    const host = document.getElementById('ayt-toolbar-host');
    const btns = [...host.shadowRoot.querySelectorAll('button.ayt-tb-btn')];
    return { ids: btns.map((b) => b.dataset.id), labels: btns.map((b) => b.getAttribute('aria-label')) };
  });
  const mine = ['loop', 'speed', 'boost', 'adjust', 'pip', 'cinema', 'comments', 'settings'];
  check('toolbar renders all TOOLS buttons in spec order', mine.every((id) => tb.ids.includes(id)) && JSON.stringify(tb.ids.filter((i) => mine.includes(i))) === JSON.stringify(mine), tb);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shotEl(page, '#ayt-toolbar-host', 'tools_toolbar_dark.png');

  /* ---- clean up: comments / related / end screen through the settings */
  const before = await page.evaluate(() => {
    const cs = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).display : null;
    };
    return { comments: cs('ytd-watch-flexy ytd-comments#comments'), related: cs('ytd-watch-flexy #secondary #related'), ce: cs('#movie_player .ytp-ce-element'), endscreen: cs('#movie_player .html5-endscreen') };
  });
  await iso(() => AYT.settings.setMany({ hideComments: true, hideRelated: true, hideEndscreen: true }));
  await sleep(700);
  const after = await page.evaluate(() => {
    const cs = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).display : null;
    };
    const pill = document.getElementById('ayt-comments-pill');
    return {
      htmlClasses: [...document.documentElement.classList].filter((c) => c.startsWith('ayt-')),
      comments: cs('ytd-watch-flexy ytd-comments#comments'),
      related: cs('ytd-watch-flexy #secondary #related'),
      ce: cs('#movie_player .ytp-ce-element'),
      endscreen: cs('#movie_player .html5-endscreen'),
      cardsTeaser: cs('#movie_player .ytp-cards-teaser'),
      secondary: cs('ytd-watch-flexy #secondary'),
      pill: pill ? { display: getComputedStyle(pill).display, text: pill.shadowRoot && pill.shadowRoot.textContent, before: pill.nextElementSibling && pill.nextElementSibling.id } : null,
    };
  });
  check('hide comments: ytd-comments#comments is display:none', after.comments === 'none', { before: before.comments, after: after.comments });
  check('hide related: #secondary #related is display:none (#secondary kept)', after.related === 'none' && after.secondary !== 'none', { before: before.related, after: after.related, secondary: after.secondary });
  check('hide end screen: .ytp-ce-element / .html5-endscreen are display:none', (after.ce === 'none' || after.ce === null) && (after.endscreen === 'none' || after.endscreen === null) && (after.ce !== null || after.endscreen !== null), { before, after: { ce: after.ce, endscreen: after.endscreen, cardsTeaser: after.cardsTeaser } });
  check('"Comments are hidden · Show" pill placed before the comments', !!after.pill && after.pill.display === 'block' && after.pill.before === 'comments' && /Comments are hidden/.test(after.pill.text || ''), after.pill);
  // the pill sits below the description: scroll it into view for a picture
  const pillY = await page.evaluate(() => {
    const p = document.getElementById('ayt-comments-pill');
    if (!p) return null;
    p.scrollIntoView({ block: 'center' });
    const r = p.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await sleep(500);
  if (pillY) await shotEl(page, '#ayt-comments-pill', 'tools_comments_pill_dark.png');
  // "Show" in the pill turns comments back on
  const showBtn = await page.$('#ayt-comments-pill >>> .ayt-comments-show');
  if (showBtn) {
    await showBtn.click();
    await sleep(600);
  }
  const shown = await page.evaluate(() => ({ cls: document.documentElement.classList.contains('ayt-hide-comments'), comments: getComputedStyle(document.querySelector('ytd-watch-flexy ytd-comments#comments')).display }));
  const shownSetting = await iso(() => AYT.settings.get('hideComments'));
  check('pill "Show" button shows the comments again (setting off)', !shown.cls && shown.comments !== 'none' && shownSetting === false, { shown, shownSetting });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  // toolbar toggle hides them again
  await clickToolbar(page, 'comments');
  await sleep(500);
  const toggled = await page.evaluate(() => ({ cls: document.documentElement.classList.contains('ayt-hide-comments'), comments: getComputedStyle(document.querySelector('ytd-watch-flexy ytd-comments#comments')).display }));
  const btnState = await page.evaluate(() => {
    const b = document.getElementById('ayt-toolbar-host').shadowRoot.querySelector('button[data-id="comments"]');
    return { on: b.classList.contains('is-on'), label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed') };
  });
  check('comments toolbar toggle hides comments (button on, label "Show comments")', toggled.cls && toggled.comments === 'none' && btnState.on && btnState.label === 'Show comments', { toggled, btnState });
  await iso(() => AYT.settings.setMany({ hideComments: false, hideRelated: false, hideEndscreen: false }));
  await sleep(300);

  /* ---- speed */
  await page.evaluate(() => window.scrollTo(0, 0));
  await waitNoAd(page, 30000);
  await openPanel(page, 'speed');
  const chip = await page.waitForSelector('#ayt-portal-host >>> .ayt-tools-chip[data-rate="3"]', { timeout: 5000 });
  await chip.click();
  await sleep(2600);
  const sp = await page.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    const b = document.getElementById('ayt-toolbar-host').shadowRoot.querySelector('button[data-id="speed"]');
    const dot = b.querySelector('.ayt-tb-btn__dot');
    return { rate: v.playbackRate, apiRate: document.getElementById('movie_player').getPlaybackRate(), badge: dot && dot.textContent, on: b.classList.contains('is-on') };
  });
  check('speed 3× (preset chip) sticks on the <video> after 2.6 s', sp.rate === 3 && sp.badge === '3' && sp.on, sp);
  await shotPanel(page, 'tools_speed_panel_dark.png');
  await closePanel(page);

  /* ---- speed commands (as dispatched by boot.js) + on-player indicator */
  await page.evaluate(() => window.scrollTo(0, 0));
  const cmdRate = await iso(() => AYT.toolbar.get('speed').commands['speed-up']());
  await sleep(300); // past the fade-in, well before the 900 ms fade-out
  const osd = await page.evaluate(() => {
    const host = document.querySelector('#movie_player > .ayt-osd-host');
    const b = host && host.shadowRoot.querySelector('.ayt-osd');
    return b ? { visible: b.classList.contains('is-visible'), text: b.textContent, rate: document.querySelector('#movie_player video').playbackRate } : null;
  });
  const mpBox = await rectOf(page, '#movie_player');
  if (mpBox) await shot(page, 'tools_speed_osd.png', { x: mpBox.x + mpBox.width / 2 - 200, y: mpBox.y + mpBox.height / 2 - 70, width: 400, height: 140 });
  check('speed-up command: 3× → 3.25× with the on-player indicator', cmdRate === 3.25 && osd && osd.visible && osd.text === '3.25×' && osd.rate === 3.25, { cmdRate, osd });
  await iso(() => AYT.toolbar.get('speed').commands['speed-down']());
  const downRate = await page.evaluate(() => document.querySelector('#movie_player video').playbackRate);
  check('speed-down command: 3.25× → 3×', downRate === 3, { downRate });

  /* ---- A-B loop (native) */
  await waitNoAd(page, 30000);
  await muteAndPlay(page);
  const ab = await iso(() => AYT.tools.loop.startAB(10, 14).then((r) => r, (e) => ({ error: e.message })));
  await page.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    v.currentTime = 12;
    v.play().catch(() => {});
  });
  const samples = [];
  for (let i = 0; i < 28; i++) {
    await sleep(250);
    samples.push(await page.evaluate(() => Math.round(document.querySelector('#movie_player video').currentTime * 100) / 100));
  }
  const wraps = samples.filter((s, i) => i > 0 && s < samples[i - 1] - 1).length;
  // frame-precise: at 3× one frame is ~0.1 s of video
  const inRange = samples.every((s) => s >= 9.5 && s <= 14.4);
  const markers = await page.evaluate(() => {
    const el = document.querySelector('#movie_player .ytp-progress-bar > .ayt-loop-range');
    return el ? { left: el.style.left, width: el.style.width, z: getComputedStyle(el).zIndex } : null;
  });
  const range = await page.evaluate(() => {
    const mp = document.getElementById('movie_player');
    return mp.getLoopRange ? mp.getLoopRange() : null;
  });
  check('A-B loop 10–14 s wraps currentTime (native setLoopRange)', !ab.error && ab.mode === 'native' && wraps >= 1 && inRange, { ab, wraps, samples, range });
  check('A-B section highlighted on the progress bar', !!markers && parseFloat(markers.left) > 4 && parseFloat(markers.left) < 5.2 && parseFloat(markers.width) > 1.5 && parseFloat(markers.width) < 2.3, markers);
  // picture of the markers: pause and pin YouTube's control bar visible (test-only style)
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => {
    document.getElementById('movie_player').pauseVideo();
    const s = document.createElement('style');
    s.id = 'ayt-e2e-show-controls';
    s.textContent = '#movie_player .ytp-chrome-bottom, #movie_player .ytp-gradient-bottom { opacity: 1 !important; display: block !important; }';
    document.head.appendChild(s);
  });
  const mpRect = await rectOf(page, '#movie_player');
  if (mpRect) {
    await page.mouse.move(mpRect.x + mpRect.width / 2, mpRect.y + mpRect.height / 2);
    await sleep(700);
    await shot(page, 'tools_loop_markers.png', { x: mpRect.x, y: mpRect.y + mpRect.height - 70, width: mpRect.width, height: 70 });
  }
  await page.evaluate(() => document.getElementById('ayt-e2e-show-controls').remove());
  await muteAndPlay(page);
  await openPanel(page, 'loop');
  const loopUi = await page.evaluate(() => {
    const root = document.getElementById('ayt-portal-host').shadowRoot;
    const inputs = [...root.querySelectorAll('.ayt-loop-point input')].map((i) => i.value);
    const sw = [...root.querySelectorAll('.ayt-loop .ayt-switch input')].map((i) => i.checked);
    const len = root.querySelector('.ayt-loop-len');
    return { inputs, switches: sw, length: len && len.textContent };
  });
  check('loop panel shows the active A-B section', loopUi.inputs[0] === '00:00:10.000' && loopUi.inputs[1] === '00:00:14.000' && loopUi.switches[1] === true, loopUi);
  await shotPanel(page, 'tools_loop_panel_dark.png');
  // switch the A-B loop off from the panel
  const abSwitch = await page.$$('#ayt-portal-host >>> .ayt-loop-ab .ayt-switch');
  if (abSwitch[0]) await abSwitch[0].click();
  await sleep(600);
  const abOff = await iso(() => AYT.tools.loop.state());
  const rangeOff = await page.evaluate(() => document.getElementById('movie_player').getLoopRange());
  check('A-B switch off clears the native loop range', abOff.active === false && rangeOff == null, { active: abOff.active, rangeOff });
  await closePanel(page);
  await iso(() => AYT.tools.speed.setRate(1));

  /* ---- volume boost */
  await openPanel(page, 'boost');
  const boostChip = await page.waitForSelector('#ayt-portal-host >>> .ayt-tools-chip[data-pct="200"]', { timeout: 5000 });
  await boostChip.click();
  await sleep(700);
  const bs = await iso(() => AYT.tools.boost.state());
  const vstate = await page.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    return { paused: v.paused, t: v.currentTime };
  });
  check('volume boost 200 % creates the Web Audio graph (running, routed through gain)', bs.graph && bs.contextState === 'running' && bs.routed === 'boost' && bs.percent === 200 && !bs.error, { bs, vstate });
  await shotPanel(page, 'tools_boost_panel_dark.png');
  const offChip = await page.$('#ayt-portal-host >>> .ayt-tools-chip[data-pct="100"]');
  if (offChip) await offChip.click();
  await sleep(300);
  const bs2 = await iso(() => AYT.tools.boost.state());
  check('boost back to 100 % routes the audio directly (bypass)', bs2.percent === 100 && bs2.routed === 'direct', bs2);
  await closePanel(page);

  /* ---- video adjustments */
  await openPanel(page, 'adjust');
  const bright = await page.waitForSelector('#ayt-portal-host >>> .ayt-adjust-row[data-key="brightness"] input[type="range"]', { timeout: 5000 });
  await bright.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  const rot = await page.$('#ayt-portal-host >>> .ayt-seg__opt[data-value="90"]');
  if (rot) await rot.click();
  await sleep(700);
  const adj = await page.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    const cs = getComputedStyle(v);
    const root = getComputedStyle(document.documentElement);
    return {
      htmlClass: document.documentElement.classList.contains('ayt-video-adjust'),
      // adjust.js writes the variables inline on the active <video> only (on :root every slider step restyled
      // YouTube's whole document)
      varFilter: cs.getPropertyValue('--ayt-va-filter').trim(),
      varTransform: cs.getPropertyValue('--ayt-va-transform').trim(),
      inlineFilter: v.style.getPropertyValue('--ayt-va-filter').trim(),
      rootVars: (root.getPropertyValue('--ayt-va-filter') + root.getPropertyValue('--ayt-va-transform')).trim(),
      filter: cs.filter,
      transform: cs.transform,
      paused: v.paused,
    };
  });
  const api = await iso(() => ({ active: AYT.videoAdjust.active(), filter: AYT.videoAdjust.canvasFilter(), rotation: AYT.videoAdjust.rotation() }));
  check(
    'adjust sets the CSS vars on the <video> (none on <html>) and filter/transform follow',
    adj.htmlClass && adj.varFilter === 'brightness(1.3)' && adj.inlineFilter === 'brightness(1.3)' && /rotate\(90deg\)/.test(adj.varTransform) && adj.rootVars === '' && adj.filter === 'brightness(1.3)' && adj.transform !== 'none',
    { adj, api }
  );
  check('AYT.videoAdjust exposes the state for screenshots', api.active && api.filter === 'brightness(1.3)' && api.rotation === 90, api);
  // focus() scrolled the page to the panel: show the rotated, brightened player and the panel together
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(1590, 990); // let the player controls hide
  await sleep(1500);
  await shot(page, 'tools_adjust_dark.png');
  await shotPanel(page, 'tools_adjust_panel_dark.png');
  const resetAll = await page.$('#ayt-portal-host >>> .ayt-adjust-foot .ayt-btn');
  if (resetAll) await resetAll.click();
  await sleep(400);
  const adjOff = await page.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    return { cls: document.documentElement.classList.contains('ayt-video-adjust'), transform: getComputedStyle(v).transform, inlineVars: (v.style.getPropertyValue('--ayt-va-filter') + v.style.getPropertyValue('--ayt-va-transform')).trim() };
  });
  check('"Reset all" restores the video (and removes the variables from it)', !adjOff.cls && adjOff.transform === 'none' && adjOff.inlineVars === '', adjOff);
  await closePanel(page);

  /* ---- auto quality (setting autoQuality) */
  await waitNoAd(page, 30000);
  await iso(() => AYT.settings.set('autoQuality', '480'));
  const picked = await iso(() => AYT.tools.quality.apply());
  let q = null;
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    q = await page.evaluate(() => ({ quality: document.getElementById('movie_player').getPlaybackQuality(), height: document.querySelector('#movie_player video').videoHeight }));
    if (q.height === 480) break;
  }
  check('auto quality 480p picks "large" and the player switches to 480 lines', picked === 'large' && (q.height === 480 || q.quality === 'large'), { picked, q });
  await iso(() => AYT.settings.set('autoQuality', 'off'));

  /* ---- cinema mode */
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await clickToolbar(page, 'cinema');
  await sleep(900);
  const cin = await page.evaluate(() => {
    const ov = document.getElementById('ayt-cinema-overlay');
    const mp = document.getElementById('movie_player').getBoundingClientRect();
    const tbh = document.getElementById('ayt-toolbar-host');
    const tb = tbh.shadowRoot.querySelector('button[data-id="cinema"]').getBoundingClientRect();
    const at = (x, y) => document.elementFromPoint(x, y);
    const playerHit = at(mp.x + mp.width / 2, mp.y + mp.height / 2);
    const mastHit = at(800, 28);
    const sideHit = at(Math.min(window.innerWidth - 20, mp.right + 150), mp.y + 150);
    const tbHit = at(tb.x + tb.width / 2, tb.y + tb.height / 2);
    return {
      cls: document.documentElement.classList.contains('ayt-cinema'),
      overlay: ov ? { z: getComputedStyle(ov).zIndex, opacity: getComputedStyle(ov).opacity, position: getComputedStyle(ov).position } : null,
      playerInPlayer: !!(playerHit && playerHit.closest('#movie_player')),
      mastIsOverlay: mastHit === ov,
      sideIsOverlay: sideHit === ov,
      toolbarHit: tbHit === tbh,
      pcoZ: getComputedStyle(document.querySelector('#player-container-outer')).zIndex,
      btnOn: tbh.shadowRoot.querySelector('button[data-id="cinema"]').classList.contains('is-on'),
    };
  });
  check('cinema: overlay z-index 2030 covers masthead + sidebar, player and toolbar stay above', cin.cls && cin.overlay && cin.overlay.z === '2030' && Math.abs(Number(cin.overlay.opacity) - 0.9) < 0.01 && cin.playerInPlayer && cin.mastIsOverlay && cin.sideIsOverlay && cin.toolbarHit && cin.pcoZ === '2031' && cin.btnOn, cin);
  await shot(page, 'tools_cinema_dark.png');
  await page.mouse.click(800, 28); // click the dimmed masthead (= the overlay)
  await sleep(700);
  const cinOff = await page.evaluate(() => ({ cls: document.documentElement.classList.contains('ayt-cinema'), vis: getComputedStyle(document.getElementById('ayt-cinema-overlay')).visibility }));
  check('cinema: clicking the overlay exits', !cinOff.cls && cinOff.vis === 'hidden', cinOff);

  /* ---- cinema in theater mode (player inside #full-bleed-container) + Escape to exit */
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await page.keyboard.press('t');
  await sleep(1000);
  const theater = await page.evaluate(() => document.querySelector('ytd-watch-flexy').hasAttribute('theater'));
  if (theater) {
    await clickToolbar(page, 'cinema');
    await sleep(900);
    const th = await page.evaluate(() => {
      const ov = document.getElementById('ayt-cinema-overlay');
      const mp = document.getElementById('movie_player').getBoundingClientRect();
      const tbh = document.getElementById('ayt-toolbar-host');
      const tb = tbh.shadowRoot.querySelector('button[data-id="cinema"]').getBoundingClientRect();
      const playerHit = document.elementFromPoint(mp.x + mp.width / 2, mp.y + mp.height / 2);
      return {
        inFullBleed: !!document.querySelector('#full-bleed-container #movie_player'),
        playerInPlayer: !!(playerHit && playerHit.closest('#movie_player')),
        toolbarHit: document.elementFromPoint(tb.x + tb.width / 2, tb.y + tb.height / 2) === tbh,
        mastIsOverlay: document.elementFromPoint(800, 28) === ov,
      };
    });
    check('cinema in theater mode: player and toolbar above the overlay', th.inFullBleed && th.playerInPlayer && th.toolbarHit && th.mastIsOverlay, th);
    await shot(page, 'tools_cinema_theater.png');
    await page.keyboard.press('Escape');
    await sleep(600);
    const escOff = await page.evaluate(() => document.documentElement.classList.contains('ayt-cinema'));
    check('cinema: Escape exits', escOff === false, { escOff });
    await page.keyboard.press('t');
    await sleep(800);
  } else note('theater mode could not be toggled with "t"; theater check skipped');

  /* ---- picture-in-picture (best effort in headless) */
  await clickToolbar(page, 'pip');
  await sleep(1200);
  const pip = await page.evaluate(() => ({ enabled: document.pictureInPictureEnabled, inPip: !!document.pictureInPictureElement }));
  const pipToast = await page.evaluate(() => {
    const h = document.getElementById('ayt-toast-host');
    return h && h.shadowRoot ? [...h.shadowRoot.querySelectorAll('.ayt-toast__text')].map((x) => x.textContent) : [];
  });
  check('picture-in-picture: toggles (or explains why not) without crashing', pip.inPip || pipToast.length > 0 || !pip.enabled, { pip, pipToast });
  if (pip.inPip) {
    await clickToolbar(page, 'pip');
    await sleep(800);
    const out = await page.evaluate(() => !!document.pictureInPictureElement);
    check('picture-in-picture: second click leaves PiP', out === false, { out });
  }

  /* ---- settings button → options page (through the service worker) */
  await clickToolbar(page, 'settings');
  let optionsUrl = null;
  for (let i = 0; i < 20 && !optionsUrl; i++) {
    await sleep(250);
    for (const p of await ctx.h.browser.pages()) if (p !== page && /options\/options\.html/.test(p.url())) optionsUrl = p.url();
  }
  const settingsToast = await page.evaluate(() => {
    const h = document.getElementById('ayt-toast-host');
    return h && h.shadowRoot ? [...h.shadowRoot.querySelectorAll('.ayt-toast__text')].map((x) => x.textContent).slice(-1)[0] || null : null;
  });
  check('settings button opens the options page', !!optionsUrl, { optionsUrl, settingsToast });
  await focusOurTab(ctx.h, 0);
  await sleep(500);

  /* ---- light theme (YouTube reads the colour scheme at load) + hide comments from document_start */
  await iso(() => AYT.settings.set('hideComments', true));
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  // Record, at the moment YouTube creates ytd-comments, whether our class was already on <html>.
  const early = await page.evaluateOnNewDocument(() => {
    window.__aytEarly = null;
    const mo = new MutationObserver(() => {
      if (window.__aytEarly) return;
      const c = document.querySelector('ytd-comments#comments');
      if (!c) return;
      window.__aytEarly = { hadClass: document.documentElement.classList.contains('ayt-hide-comments'), display: getComputedStyle(c).display, t: Math.round(performance.now()) };
      mo.disconnect();
    });
    mo.observe(document, { childList: true, subtree: true });
  });
  await retry(() => page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }), 'reload (light)');
  await page.waitForSelector('#ayt-toolbar-host >>> button[data-id="loop"]', { timeout: 30000 });
  await muteAndPlay(page);
  await waitNoAd(page, 40000);
  await muteAndPlay(page);
  await page.removeScriptToEvaluateOnNewDocument(early.identifier).catch(() => {});
  const earlyRes = await page.waitForFunction(() => window.__aytEarly, { timeout: 15000 }).then((jh) => jh.jsonValue(), () => null);
  check('hideComments is applied before YouTube creates the comments (no flash)', !!earlyRes && earlyRes.hadClass === true && earlyRes.display === 'none', earlyRes);
  const light = await page.evaluate(() => !document.documentElement.hasAttribute('dark'));
  if (!light) note('YouTube stayed dark after reloading with prefers-color-scheme: light');
  await iso(() => AYT.tools.speed.setRate(1.5));
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(800);
  await shotEl(page, '#ayt-toolbar-host', 'tools_toolbar_light.png');
  await openPanel(page, 'speed');
  await shotPanel(page, 'tools_speed_panel_light.png');
  await closePanel(page);
  await openPanel(page, 'adjust');
  await shotPanel(page, 'tools_adjust_panel_light.png');
  await closePanel(page);
  const pillTheme = await page.evaluate(() => {
    const p = document.getElementById('ayt-comments-pill');
    if (!p) return null;
    p.scrollIntoView({ block: 'center' });
    return p.shadowRoot.querySelector('.ayt-root').getAttribute('data-theme');
  });
  await sleep(400);
  await shotEl(page, '#ayt-comments-pill', 'tools_comments_pill_light.png');
  check('light theme: our UI follows YouTube (pill theme = light)', !light || pillTheme === 'light', { light, pillTheme });
  await iso(() => AYT.settings.set('hideComments', false));
  await iso(() => AYT.tools.speed.setRate(1));
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
}

/* ------------------------------------------------------------------ Shorts */
async function shortsTests(ctx) {
  const { page, iso } = ctx;
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  // a stale shortsToWatch from an aborted run would redirect us away: reset first
  if (!/^https:\/\/www\.youtube\.com\//.test(page.url())) {
    await retry(() => page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }), 'goto home');
    await sleep(1500);
  }
  await resetSettings(iso).catch(() => {});
  await retry(() => page.goto('https://www.youtube.com/shorts/', { waitUntil: 'domcontentloaded', timeout: 60000 }), 'goto shorts');
  let ok = await page.waitForSelector('ytd-shorts reel-action-bar-view-model', { timeout: 40000 }).then(() => true, () => false);
  if (!ok) {
    note('/shorts/ did not open a short, trying a known Shorts URL');
    await retry(() => page.goto('https://www.youtube.com/shorts/gZ6cIWpN4wA', { waitUntil: 'domcontentloaded', timeout: 60000 }), 'goto short');
    ok = await page.waitForSelector('ytd-shorts reel-action-bar-view-model', { timeout: 40000 }).then(() => true, () => false);
  }
  check('a Shorts page with an action bar opened', ok, { url: page.url() });
  if (!ok) return;
  await resetSettings(iso);
  await page.evaluate(() => {
    const v = document.querySelector('#shorts-player video');
    if (v) v.muted = true;
  });
  const injected = await page.waitForSelector('ytd-shorts reel-action-bar-view-model > .ayt-shorts-action', { timeout: 10000 }).then(() => true, () => false);
  const placement = await page.evaluate(() => {
    const bar = document.querySelector('ytd-shorts reel-action-bar-view-model');
    const host = bar && bar.querySelector(':scope > .ayt-shorts-action');
    const next = host && host.nextElementSibling;
    const r = host && host.getBoundingClientRect();
    window.__aytBar1 = bar;
    return { path: location.pathname, next: next ? next.tagName.toLowerCase() : null, rect: r && { w: r.width, h: r.height }, label: host && host.shadowRoot.textContent, dark: host && host.hasAttribute('data-dark') };
  });
  check('Shorts: download button injected before the pivot button', injected && (placement.next === 'pivot-button-view-model' || placement.next === null) && placement.rect && placement.rect.w === 48, placement);
  const barRect = await rectOf(page, 'ytd-shorts reel-action-bar-view-model');
  if (barRect) await shot(page, 'tools_shorts_button.png', { x: barRect.x - 380, y: Math.max(0, barRect.y - 40), width: barRect.width + 560, height: barRect.height + 80 });

  // swipe to the next short (ArrowDown on the page)
  await page.mouse.move(20, 500);
  const firstPath = placement.path;
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction((p) => location.pathname !== p, { timeout: 10000 }, firstPath).catch(() => {});
  const survived = await page
    .waitForFunction(
      () => {
        const bar = document.querySelector('ytd-shorts reel-action-bar-view-model');
        return !!(bar && bar !== window.__aytBar1 && bar.querySelector(':scope > .ayt-shorts-action'));
      },
      { timeout: 6000 }
    )
    .then(() => true, () => false);
  const afterSwipe = await page.evaluate(() => ({ path: location.pathname, buttons: document.querySelectorAll('.ayt-shorts-action').length, oldBarConnected: !!(window.__aytBar1 && window.__aytBar1.isConnected) }));
  check('Shorts: button re-injected after an ArrowDown swipe (new action bar)', survived && afterSwipe.path !== firstPath && afterSwipe.buttons === 1, { firstPath, afterSwipe });

  // open the popover
  await sleep(800);
  const btn = await page.waitForSelector('.ayt-shorts-action >>> button.ayt-sb', { timeout: 5000 });
  await btn.click();
  const opened = await page.waitForSelector('#ayt-shorts-pop-host >>> .ayt-shorts-pop', { timeout: 5000 }).then(() => true, () => false);
  await sleep(2500); // let the first panel load its data
  const pop = await page.evaluate(() => {
    const host = document.getElementById('ayt-shorts-pop-host');
    const root = host && host.shadowRoot;
    const p = root && root.querySelector('.ayt-shorts-pop');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const btnEl = document.querySelector('.ayt-shorts-action').shadowRoot.querySelector('button');
    return {
      tabs: [...root.querySelectorAll('.ayt-shorts-tab')].map((x) => ({ id: x.dataset.id, label: x.textContent, selected: x.getAttribute('aria-selected') })),
      notice: (root.querySelector('.ayt-shorts-panel .ayt-notice') || {}).textContent || null,
      panelChildren: root.querySelector('.ayt-shorts-panel') ? root.querySelector('.ayt-shorts-panel').childElementCount : 0,
      screenshotBtn: !!root.querySelector('.ayt-panel__footer .ayt-btn'),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      inViewport: r.x >= 0 && r.y >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      expanded: btnEl.getAttribute('aria-expanded'),
      registered: null,
    };
  });
  const registered = await iso(() => AYT.toolbar.list().filter((d) => d.panel && (d.surfaces || []).includes('shorts')).map((d) => d.id));
  if (pop) pop.registered = registered;
  check('Shorts: popover opens with one tab per registered Shorts panel (or a notice when none)', opened && pop && pop.inViewport && pop.expanded === 'true' && (registered.length > 1 ? pop.tabs.length === registered.length : registered.length === 1 ? pop.panelChildren > 0 : !!pop.notice), pop);
  await shot(page, 'tools_shorts_popover.png');
  // second tab, if any
  if (pop && pop.tabs.length > 1) {
    const tab2 = await page.$(`#ayt-shorts-pop-host >>> .ayt-shorts-tab[data-id="${pop.tabs[1].id}"]`);
    if (tab2) {
      await tab2.click();
      await sleep(2000);
      const sel = await page.evaluate(() => [...document.getElementById('ayt-shorts-pop-host').shadowRoot.querySelectorAll('.ayt-shorts-tab')].map((x) => x.getAttribute('aria-selected')));
      check('Shorts: switching tabs renders the other panel', sel[1] === 'true', { sel });
      await shot(page, 'tools_shorts_popover_tab2.png');
    }
  }
  // a language change relabels the open popover in place (its panel keeps its state)
  if (pop) {
    const prevLang = await iso(() => AYT.settings.get('language'));
    await iso(() => AYT.settings.set('language', 'de'));
    await sleep(700);
    const de = await page.evaluate(() => {
      const root = document.getElementById('ayt-shorts-pop-host').shadowRoot;
      const p = root.querySelector('.ayt-shorts-pop');
      if (!p) return null;
      return { title: p.querySelector('.ayt-panel__title').textContent, close: p.querySelector('.ayt-panel__close').getAttribute('aria-label'), tabs: [...p.querySelectorAll('.ayt-shorts-tab')].map((x) => x.textContent) };
    });
    const want = await iso(() => ({ title: AYT.t('tools.shorts.title'), close: AYT.t('common.close'), subs: AYT.t('tools.shorts.tabSubtitles') }));
    await iso((l) => AYT.settings.set('language', l), prevLang);
    await sleep(400);
    const subsTab = pop.tabs.some((x) => x.id === 'subtitles');
    check('Shorts: the open popover follows a language change', !!de && want.close !== 'Close' && de.title === want.title && de.close === want.close && (!subsTab || de.tabs.includes(want.subs)), { de, want });
  }
  // Escape closes, focus returns to the button
  await page.keyboard.press('Escape');
  await sleep(400);
  const closed = await page.evaluate(() => {
    const host = document.getElementById('ayt-shorts-pop-host');
    return { open: !!(host && host.shadowRoot.querySelector('.ayt-shorts-pop')), path: location.pathname };
  });
  check('Shorts: Escape closes the popover without swiping', !closed.open && closed.path === afterSwipe.path, closed);

  /* ---- hide Shorts: the full guide's Shorts entry has no href → tagged through the MAIN-world bridge */
  await iso(() => AYT.settings.set('hideShorts', true));
  let guide = null;
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    guide = await page.evaluate(() => {
      const tagged = [...document.querySelectorAll('[data-ayt-shorts]')];
      const entry = [...document.querySelectorAll('ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer')].find((e) => /^\s*Shorts\s*$/i.test(e.textContent || ''));
      return {
        cls: document.documentElement.classList.contains('ayt-hide-shorts'),
        tagged: tagged.length,
        display: tagged.map((e) => getComputedStyle(e).display),
        englishEntry: entry ? getComputedStyle(entry).display : null,
      };
    });
    if (guide.tagged > 0) break;
  }
  check('hide Shorts: the guide\'s Shorts entry is tagged and hidden', guide.cls && guide.tagged > 0 && guide.display.every((d) => d === 'none') && guide.englishEntry !== 'block', guide);
  await shot(page, 'tools_hide_shorts_guide.png', { x: 0, y: 56, width: 260, height: 300 });
  await iso(() => AYT.settings.set('hideShorts', false));

  /* ---- shortsToWatch: /shorts/<id> → /watch?v=<id> */
  const sid = await page.evaluate(() => location.pathname.split('/')[2]);
  await iso(() => AYT.settings.set('shortsToWatch', true));
  const redirected = await page
    .waitForFunction((id) => location.pathname === '/watch' && new URLSearchParams(location.search).get('v') === id, { timeout: 15000 }, sid)
    .then(() => true, () => false);
  check('shortsToWatch: the open short is reopened in the regular watch player', redirected, { sid, url: page.url() });
  await page.waitForSelector('#ayt-toolbar-host', { timeout: 20000 }).catch(() => {});
  await sleep(1000);
  await resetSettings(iso).catch(() => {});
}

/** The profile is reused between runs: start from the defaults this test relies on. */
async function resetSettings(iso) {
  await iso(() =>
    AYT.settings.setMany({ hideComments: false, hideRelated: false, hideShorts: false, hideEndscreen: false, hideLiveChat: false, shortsToWatch: false, showOnShorts: true, autoQuality: 'off', rememberSpeed: false, toolbarHidden: [], theme: 'auto' })
  );
}

/* ------------------------------------------------------------------ main */
const extDir = prepareExtension();
const userDataDir = path.join(OUT, 'profile');
let browser = null;
const pageErrors = [];
const consoleErrors = [];
try {
  const h = await launchWithExtension(extDir, { userDataDir, stealth: true, headless: HEADLESS });
  browser = h;
  const page = h.page;
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error' || /\[AYT\]/.test(m.text())) consoleErrors.push(`${m.type()}: ${m.text()}`.slice(0, 300));
  });
  const iso = (fn, ...a) => retry(() => h.evaluateInIsolatedWorld(page, fn, ...a), 'isolated eval');
  // The options page can open later than focusOurTab's wait on a busy machine: close it whenever it appears.
  h.browser.on('targetcreated', (tg) => {
    if (tg.type() === 'page' && /^chrome-extension:\/\/[a-p]{32}\/options\//.test(tg.url())) setTimeout(() => focusOurTab(h, 0).catch(() => {}), 300);
  });
  await focusOurTab(h);
  const ctx = { page, iso, h };
  if (!args.includes('--skip-watch')) {
    try {
      await watchTests(ctx);
    } catch (e) {
      check('watch-page tests ran to the end', false, String((e && e.stack) || e).slice(0, 800));
    }
  }
  if (!args.includes('--skip-shorts')) {
    try {
      await shortsTests(ctx);
    } catch (e) {
      check('Shorts tests ran to the end', false, String((e && e.stack) || e).slice(0, 800));
    }
  }
} catch (e) {
  check('browser launched with the extension', false, String((e && e.message) || e));
} finally {
  if (browser) await browser.close();
}
const ayt = consoleErrors.filter((x) => /\[AYT\]/.test(x));
const report = { when: new Date().toISOString(), extDir, out: OUT, passed: results.filter((r) => r.ok).length, failed: failures, results, notes, pageErrors, aytConsole: ayt, consoleErrors: consoleErrors.slice(0, 60) };
fs.writeFileSync(path.join(OUT, 'tools-e2e-report.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.passed} passed, ${failures} failed — report: ${path.join(OUT, 'tools-e2e-report.json')}`);
if (ayt.length) console.log('[AYT] console messages:\n  ' + ayt.slice(0, 20).join('\n  '));
process.exit(failures ? 1 : 0);
