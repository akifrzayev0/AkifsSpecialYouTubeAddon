#!/usr/bin/env node
/*
 * Unit tests for the PAGES module helpers (extension/options/pages-common.js, AYT.pages).
 * Loads the real classic scripts into a vm context with a small fake `chrome` API.
 *
 *   node --test tools/tests/pages.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = path.join(ROOT, 'extension');

/** Builds a fresh context with the shared scripts + pages-common.js loaded (+ `extra` scripts, e.g. background/task.js). */
function load({ onMessage, uiLanguage = 'en-US', extra = [] } = {}) {
  const store = {};
  const created = [];
  const sent = [];
  const storageListeners = [];
  const chrome = {
    runtime: {
      id: 'oicpmbpfimnoolnhfgdocfjelknjlcif',
      lastError: null,
      getManifest: () => ({ version: '1.0.0' }),
      getURL: (p) => 'chrome-extension://oicpmbpfimnoolnhfgdocfjelknjlcif/' + p,
      async sendMessage(msg) {
        sent.push(msg);
        if (!onMessage) throw new Error('Could not establish connection. Receiving end does not exist.');
        return onMessage(msg);
      },
      connect() {
        throw new Error('no ports in unit tests');
      },
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return { ...store };
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) {
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
        },
        async remove(keys) {
          for (const k of [].concat(keys)) delete store[k];
        },
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
    tabs: {
      async create(o) {
        created.push(o);
        return { id: 99 };
      },
    },
    i18n: { getUILanguage: () => uiLanguage },
  };
  const ctx = vm.createContext({ chrome, console, setTimeout, clearTimeout, Intl, URL, TextEncoder, navigator: { language: uiLanguage } });
  ctx.globalThis = ctx;
  const files = [
    'shared/constants.js',
    'shared/utils.js',
    'shared/i18n.js',
    'shared/i18n/en.js',
    'shared/settings.js',
    'shared/client.js',
    'options/pages-common.js',
  ].concat(extra);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f });
  return { AYT: ctx.AYT, chrome, store, created, sent };
}

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

/** Minimal stand-ins for DOM elements: tag, data-* attributes, parent, closest('[data-setting]'), focus(). */
function fakeEl(doc, tag, dataset, parent) {
  const el = {
    tagName: tag.toUpperCase(),
    dataset: dataset || {},
    parentElement: parent || null,
    closest(q) {
      if (q !== '[data-setting]') throw new Error('unexpected selector ' + q);
      for (let n = el; n; n = n.parentElement) if (n.dataset && n.dataset.setting) return n;
      return null;
    },
    focus() {
      doc.activeElement = el;
    },
  };
  return el;
}

test('cleanTabTitle strips the notification count and the " - YouTube" suffix', () => {
  const { AYT } = load();
  const c = AYT.pages.cleanTabTitle;
  assert.equal(c('(3) Rick Astley - Never Gonna Give You Up (Official Video) - YouTube'), 'Rick Astley - Never Gonna Give You Up (Official Video)');
  assert.equal(c('Şəkil Ğüç İı — Тест - YouTube'), 'Şəkil Ğüç İı — Тест');
  assert.equal(c('Song title - YouTube Music'), 'Song title');
  assert.equal(c('(12+) Video – YouTube'), 'Video');
  assert.equal(c('YouTube'), '');
  assert.equal(c(''), '');
  assert.equal(c(undefined), '');
  assert.equal(c('  Spaced    out   title  - YouTube '), 'Spaced out title');
});

test('videoFromTab recognizes watch, live, shorts and youtu.be URLs only', () => {
  const { AYT } = load();
  const v = (url, title, id) => AYT.pages.videoFromTab({ url, title, id: id == null ? 7 : id });
  const watch = v('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu&t=10', 'Never Gonna Give You Up - YouTube');
  assert.equal(watch.videoId, 'dQw4w9WgXcQ');
  assert.equal(watch.surface, 'watch');
  assert.equal(watch.title, 'Never Gonna Give You Up');
  assert.equal(watch.listId, 'PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu');
  assert.equal(watch.tabId, 7);
  assert.equal(watch.hasToolbar, true);

  const shorts = v('https://www.youtube.com/shorts/jNQXAC9IVRw', 'Me at the zoo #shorts - YouTube');
  assert.equal(shorts.surface, 'shorts');
  assert.equal(shorts.videoId, 'jNQXAC9IVRw');
  assert.equal(shorts.hasToolbar, false);

  assert.equal(v('https://youtu.be/jNQXAC9IVRw?si=abc').videoId, 'jNQXAC9IVRw');
  assert.equal(v('https://youtu.be/jNQXAC9IVRw').hasToolbar, false);
  assert.equal(v('https://m.youtube.com/watch?v=jNQXAC9IVRw').hasToolbar, false);
  assert.equal(v('https://www.youtube.com/live/jNQXAC9IVRw').surface, 'watch');
  assert.equal(v('https://music.youtube.com/watch?v=jNQXAC9IVRw').videoId, 'jNQXAC9IVRw');

  assert.equal(v('https://www.youtube.com/'), null);
  assert.equal(v('https://www.youtube.com/feed/subscriptions'), null);
  assert.equal(v('https://www.youtube.com/watch?v=short'), null);
  assert.equal(v('https://www.youtube.com/watch'), null);
  assert.equal(v('https://evil.example/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(v('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(v('chrome://extensions/'), null);
  assert.equal(v('not a url'), null);
  assert.equal(AYT.pages.videoFromTab({ title: 'no url (no host permission)' }), null);
  assert.equal(AYT.pages.videoFromTab(null), null);
  assert.equal(v('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'x', 'nope').tabId, null);
});

test('shortcutKeys splits chrome.commands shortcuts', () => {
  const { AYT } = load();
  const k = AYT.pages.shortcutKeys;
  assert.deepEqual(Array.from(k('Alt+Shift+S')), ['Alt', 'Shift', 'S']);
  assert.deepEqual(Array.from(k('Ctrl++')), ['Ctrl', '+']);
  assert.deepEqual(Array.from(k('F5')), ['F5']);
  assert.deepEqual(Array.from(k('Ctrl+Shift+Comma')), ['Ctrl', 'Shift', 'Comma']);
  assert.deepEqual(Array.from(k('')), []);
  assert.deepEqual(Array.from(k(undefined)), []);
});

test('checkOutputDir accepts absolute Windows folders and normalizes them', () => {
  const { AYT } = load();
  const c = AYT.pages.checkOutputDir;
  assert.deepEqual({ ...c('D:\\Videos') }, { ok: true, value: 'D:\\Videos' });
  assert.equal(c('D:/Videos/YouTube/').value, 'D:\\Videos\\YouTube');
  assert.equal(c('C:\\').value, 'C:\\');
  assert.equal(c('C:\\\\double\\\\slashes\\').value, 'C:\\double\\slashes');
  assert.equal(c('  "E:\\Akif\'s Videos"  ').value, "E:\\Akif's Videos");
  assert.equal(c('C:\\Users\\Akif\\Şəkillər\\Видео').ok, true);
  assert.equal(c('\\\\nas\\share\\videos').value, '\\\\nas\\share\\videos');
  assert.deepEqual({ ...c('') }, { ok: true, value: '' });
  assert.deepEqual({ ...c('   ') }, { ok: true, value: '' });
  assert.equal(c('Videos').reason, 'absolute');
  assert.equal(c('\\Videos').reason, 'absolute');
  assert.equal(c('C:Videos').reason, 'absolute');
  assert.equal(c('C:\\a<b').reason, 'chars');
  assert.equal(c('C:\\a:b').reason, 'chars');
  assert.equal(c('C:\\a\\..\\b').reason, 'chars');
  assert.equal(c('C:\\' + 'x'.repeat(260)).reason, 'long');
  assert.equal(c(42).ok, false);
});

test('checkOutputDir uses the companion rules (180 characters, Windows names), exactly like the service worker', async (t) => {
  const { AYT } = load({ extra: ['background/task.js'] });
  const c = (v) => ({ ...AYT.pages.checkOutputDir(v) });
  assert.equal(AYT.pages.MAX_OUTPUT_DIR, 180);
  assert.deepEqual(c('C:\\' + 'x'.repeat(177)), { ok: true, value: 'C:\\' + 'x'.repeat(177) }, '180 characters');
  assert.equal(c('C:\\' + 'x'.repeat(178)).reason, 'long', '181 characters');
  for (const bad of ['D:\\YT.', 'D:\\My \\x', 'D:\\aux', 'D:\\Media\\con.txt', 'D:\\COM1', 'D:\\lpt\u00b9', '\\\\.srv\\share']) assert.equal(c(bad).reason, 'name', bad);
  assert.equal(c('D:\\a\u007fb').reason, 'chars');
  assert.equal(c('\\\\nas\\share.').ok, true, 'the share part is checked by Windows itself (the companion does not refuse it either)');
  assert.equal(c('\\\\evil.example@SSL\\DavWWWRoot\\yt').ok, true, 'network folders stay possible (NAS users)');
  // a folder picked with "Choose..." goes through the same check before it is saved
  assert.equal(AYT.pages.validateSetting('outputDir', 'C:\\' + 'x'.repeat(190)).ok, false);
  assert.equal(AYT.pages.parseBackup(JSON.stringify({ outputDir: 'D:\\aux', theme: 'dark' })).skipped[0], 'outputDir');

  const cases = [
    'D:\\Videos', 'd:/videos//YouTube/', 'C:\\', "E:\\Akif's Videos", 'C:\\ lead', 'C:\\' + 'x'.repeat(177), 'C:\\' + 'x'.repeat(178),
    '\\\\nas\\share\\videos\\', '\\\\.srv\\share', 'D:\\YT.', 'D:\\My \\x', 'D:\\aux', 'D:\\a\u007fb', 'D:\\a<b', 'D:\\a\\..\\b', 'Videos', '',
  ];
  for (const v of cases) assert.deepEqual(c(v), { ...AYT.task.checkOutputDir(v) }, `service worker agrees on ${JSON.stringify(v)}`);

  const hostPaths = await importHostPaths();
  if (!hostPaths) return t.skip('this Node version cannot load companion/host/lib/paths.ts');
  for (const v of cases) {
    const r = AYT.pages.checkOutputDir(v);
    if (r.ok && r.value) assert.ok(hostPaths.normalizeAbsolutePath(r.value, 180), `the companion accepts the saved ${JSON.stringify(r.value)}`);
  }
});

test('checkSubfolder accepts relative (nested) folder names only', () => {
  const { AYT } = load();
  const c = AYT.pages.checkSubfolder;
  assert.equal(c('Akif YouTube').value, 'Akif YouTube');
  assert.equal(c('Media/YouTube').value, 'Media\\YouTube');
  assert.equal(c(' Media \\\\ YouTube ').value, 'Media\\YouTube');
  assert.equal(c('Видео Şəkil').ok, true);
  assert.deepEqual({ ...c('') }, { ok: true, value: '' });
  assert.equal(c('..').ok, false);
  assert.equal(c('a/../b').ok, false);
  assert.equal(c('C:\\x').reason, 'relative');
  assert.equal(c('/abs').reason, 'relative');
  assert.equal(c('con').ok, false);
  assert.equal(c('nul.txt').ok, false);
  assert.equal(c('what?').reason, 'chars');
  assert.equal(c('name.').ok, false);
  assert.equal(c('.hidden').ok, false);
  assert.equal(c('x'.repeat(121)).reason, 'long');
});

test('validateSetting enforces types, enums and ranges for every default setting', () => {
  const { AYT } = load();
  const v = (n, x) => ({ ...AYT.pages.validateSetting(n, x) });
  // every default value is valid as-is
  for (const [name, def] of Object.entries(AYT.DEFAULT_SETTINGS)) {
    const r = AYT.pages.validateSetting(name, def);
    assert.equal(r.ok, true, `default of ${name} must validate`);
  }
  assert.equal(v('theme', 'dark').ok, true);
  assert.equal(v('theme', 'blue').ok, false);
  assert.equal(v('language', 'az').ok, true);
  assert.equal(v('language', 'auto').ok, true);
  assert.equal(v('language', 'xx').ok, false);
  assert.deepEqual(v('audioBitrate', '192'), { ok: true, value: 192 });
  assert.equal(v('audioBitrate', 999).ok, false);
  assert.equal(v('audioBitrate', true).ok, false);
  assert.equal(v('videoContainer', 'avi').ok, false);
  assert.equal(v('autoQuality', '1080').ok, true);
  assert.equal(v('autoQuality', 1080).ok, false);
  assert.deepEqual(v('maxConcurrent', 9), { ok: true, value: 4 });
  assert.deepEqual(v('maxConcurrent', 2.6), { ok: true, value: 3 });
  assert.deepEqual(v('maxConcurrent', '0'), { ok: true, value: 1 });
  assert.equal(v('maxConcurrent', 'x').ok, false);
  assert.equal(v('maxConcurrent', '').ok, false);
  assert.equal(v('maxConcurrent', null).ok, false);
  assert.deepEqual(v('screenshotQuality', 0.3), { ok: true, value: 0.5 });
  assert.deepEqual(v('cinemaOpacity', 0.85), { ok: true, value: 0.85 });
  assert.deepEqual(v('boostMax', 650), { ok: true, value: 600 });
  assert.equal(v('hideComments', true).ok, true);
  assert.equal(v('hideComments', 'true').ok, false);
  assert.deepEqual(Array.from(v('toolbarHidden', ['pip', 'pip', 'cinema', 5, '<x>']).value), ['pip', 'cinema']);
  assert.equal(v('toolbarHidden', 'pip').ok, false);
  assert.equal(v('outputDir', 'relative\\path').ok, false);
  assert.equal(v('outputDir', 'D:/x').value, 'D:\\x');
  assert.equal(v('subfolder', '../up').ok, false);
  assert.equal(v('subtitleLang', 'pt-BR').ok, true);
  assert.equal(v('subtitleLang', 'zh-Hans').ok, true);
  assert.equal(v('subtitleLang', '').ok, true);
  assert.equal(v('subtitleLang', 'english').ok, false);
  assert.equal(v('notASetting', 1).ok, false);
});

test('saveSetting stores valid values (one storage key per setting) and rejects invalid ones', async () => {
  const { AYT, store } = load();
  await AYT.settings.load();
  assert.equal(await AYT.pages.saveSetting('audioBitrate', '320'), 320);
  assert.equal(store['settings.audioBitrate'], 320);
  assert.equal(AYT.settings.get('audioBitrate'), 320);
  await AYT.pages.saveSetting('outputDir', 'D:/Videos/');
  assert.equal(store['settings.outputDir'], 'D:\\Videos');
  await assert.rejects(AYT.pages.saveSetting('videoContainer', 'avi'), (e) => e.code === 'invalid');
  assert.equal(store['settings.videoContainer'], undefined);
});

test('backup: export -> parse round-trip, bare objects, invalid files', () => {
  const { AYT } = load();
  const P = AYT.pages;
  const data = P.makeBackup(Object.assign({}, AYT.DEFAULT_SETTINGS, { hideComments: true, audioBitrate: 320 }), new Date('2026-11-10T12:00:00Z'));
  assert.equal(data.type, P.BACKUP_TYPE);
  assert.equal(data.extensionVersion, '1.0.0');
  assert.equal(data.exportedAt, '2026-11-10T12:00:00.000Z');
  const parsed = P.parseBackup(JSON.stringify(data));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.count, Object.keys(AYT.DEFAULT_SETTINGS).length);
  assert.equal(parsed.settings.hideComments, true);
  assert.equal(parsed.settings.audioBitrate, 320);
  assert.equal(parsed.skipped.length, 0);

  const bom = P.parseBackup('\uFEFF' + JSON.stringify({ theme: 'light', bogus: 1, maxConcurrent: 'x' }));
  assert.equal(bom.ok, true);
  assert.deepEqual({ ...bom.settings }, { theme: 'light' });
  assert.deepEqual(Array.from(bom.skipped).sort(), ['bogus', 'maxConcurrent']);

  assert.equal(P.parseBackup('{not json').error, 'json');
  assert.equal(P.parseBackup('[1,2]').error, 'format');
  assert.equal(P.parseBackup('null').error, 'format');
  assert.equal(P.parseBackup(JSON.stringify({ type: 'something-else', settings: { theme: 'dark' } })).error, 'format');
  assert.equal(P.parseBackup(JSON.stringify({ settings: [1] })).error, 'format');
  assert.equal(P.parseBackup(JSON.stringify({ settings: { nope: 1 } })).error, 'empty');
  assert.equal(P.parseBackup('').error, 'json');
  assert.equal(P.backupFilename(new Date(2026, 10, 10, 9, 5)), 'akif-youtube-addon-settings-2026-11-10.json');
});

test('hostView maps every HostStatus state to a tone, label and text', () => {
  const { AYT } = load();
  const hv = (s) => AYT.pages.hostView(s);
  assert.equal(hv({ state: 'connected' }).tone, 'ok');
  assert.equal(hv({ state: 'connected' }).pill, 'Ready');
  assert.equal(hv({ state: 'checking' }).tone, 'busy');
  assert.equal(hv({ state: 'missing' }).tone, 'warn');
  assert.equal(hv({ state: 'missing' }).pill, 'Install companion');
  assert.equal(hv({ state: 'outdated' }).tone, 'warn');
  assert.equal(hv({ state: 'forbidden' }).tone, 'error');
  assert.equal(hv({ state: 'error', error: 'Native host has exited.' }).text, 'Native host has exited.');
  assert.equal(hv({ state: 'error' }).text, AYT.t('host.error.text'));
  assert.equal(hv({ state: 'weird' }).state, 'unknown');
  assert.equal(hv(null).tone, 'neutral');
  for (const s of AYT.pages.HOST_STATES) {
    const view = hv({ state: s });
    for (const k of ['pill', 'title', 'icon']) assert.ok(view[k] && !view[k].startsWith('pages.'), `${s}.${k} is translated`);
  }
});

test('effectiveFolder prefers outputDir, then downloadsDir + subfolder, then defaultDir', () => {
  const { AYT } = load();
  const f = AYT.pages.effectiveFolder;
  assert.equal(f({ outputDir: 'D:\\Videos', subfolder: 'x' }, { downloadsDir: 'C:\\Users\\a\\Downloads' }), 'D:\\Videos');
  assert.equal(f({ outputDir: '', subfolder: 'Akif YouTube' }, { downloadsDir: 'C:\\Users\\a\\Downloads\\' }), 'C:\\Users\\a\\Downloads\\Akif YouTube');
  assert.equal(f({ outputDir: '', subfolder: 'Media/YT' }, { downloadsDir: 'C:\\D' }), 'C:\\D\\Media\\YT');
  assert.equal(f({ outputDir: '', subfolder: '' }, { downloadsDir: 'C:\\D' }), 'C:\\D');
  assert.equal(f({ outputDir: '', subfolder: 'x' }, { defaultDir: 'C:\\Default' }), 'C:\\Default');
  assert.equal(f({ outputDir: '' }, null), null);
});

test('languageOptions: Auto with the resolved language + every UI language in its own name', () => {
  const { AYT } = load({ uiLanguage: 'tr-TR' });
  const opts = AYT.pages.languageOptions();
  assert.equal(opts.length, 8);
  assert.equal(opts[0].value, 'auto');
  assert.equal(opts[0].label, 'Auto (Türkçe)');
  assert.deepEqual(Array.from(opts.slice(1), (o) => o.value), ['en', 'az', 'tr', 'ru', 'fr', 'de', 'es']);
  assert.equal(opts[2].label, 'Azərbaycanca');
  // each language name is marked with its own language (screen readers); "Auto (…)" is in the UI language
  assert.equal(opts[0].lang, undefined);
  assert.deepEqual(Array.from(opts.slice(1), (o) => o.lang), ['en', 'az', 'tr', 'ru', 'fr', 'de', 'es']);
  const select = { options: Array.from(opts, (o) => ({ value: String(o.value), lang: '' })) };
  AYT.pages.applyOptionLangs(select, opts);
  assert.deepEqual(select.options.map((o) => o.lang), ['', 'en', 'az', 'tr', 'ru', 'fr', 'de', 'es']);
});

test('importRisks: a backup that turns on the YouTube login or a network folder needs an explicit OK', () => {
  const { AYT } = load();
  const P = AYT.pages;
  const r = (cur, inc) => JSON.parse(JSON.stringify(P.importRisks(cur, inc)));
  const webdav = '\\\\evil.example@SSL\\DavWWWRoot\\yt';
  // the "preset" file from the finding: parseBackup accepts both values, importRisks flags both
  const res = P.parseBackup(JSON.stringify({ type: P.BACKUP_TYPE, settings: { useCookies: true, outputDir: webdav, theme: 'dark' } }));
  assert.equal(res.ok, true);
  assert.deepEqual(r(AYT.DEFAULT_SETTINGS, res.settings), [{ name: 'useCookies', value: true }, { name: 'outputDir', value: webdav }]);
  assert.deepEqual(r({ useCookies: true }, { useCookies: true }), [], 'already on');
  assert.deepEqual(r({ useCookies: false }, { useCookies: false, outputDir: 'D:\\Videos' }), [], 'turning it off / a local folder');
  assert.deepEqual(r({ outputDir: '\\\\nas\\share' }, { outputDir: '\\\\nas\\share' }), [], 'unchanged network folder');
  assert.equal(P.isNetworkFolder('//nas/share'), true);
  assert.equal(P.isNetworkFolder('D:\\x'), false);
});

test('keepFocus puts the focus back on the same control after a re-render (language changed with the arrow keys)', () => {
  const { AYT } = load();
  const P = AYT.pages;
  const doc = { body: { tagName: 'BODY' }, activeElement: null, scrollingElement: { scrollTop: 120 } };
  // focusSelector: own data-* attribute first, then data-value inside a [data-setting] group (segmented buttons)
  const row = fakeEl(doc, 'div', { setting: 'language' });
  const select = fakeEl(doc, 'select', { setting: 'language' }, row);
  assert.equal(P.focusSelector(select), 'select[data-setting="language"]');
  assert.equal(P.focusSelector(fakeEl(doc, 'button', { action: 'recheck' })), 'button[data-action="recheck"]');
  const seg = fakeEl(doc, 'div', { setting: 'theme' });
  assert.equal(P.focusSelector(fakeEl(doc, 'button', { value: 'dark' }, seg)), 'div[data-setting="theme"] button[data-value="dark"]');
  assert.equal(P.focusSelector(fakeEl(doc, 'button', {})), null);
  assert.equal(P.focusSelector(fakeEl(doc, 'button', { action: 'x"]' })), null, 'odd values are not put into a selector');

  let current = [];
  const root = {
    ownerDocument: doc,
    contains: (e) => current.includes(e),
    querySelector: (sel) => current.find((e) => P.focusSelector(e) === sel) || null,
  };
  const build = () => {
    const r = fakeEl(doc, 'div', { setting: 'language' });
    const s = fakeEl(doc, 'select', { setting: 'language' }, r);
    current = [r, s]; // the row comes first: a bare [data-setting] selector would find it instead of the select
    return s;
  };
  const before = build();
  doc.activeElement = before;
  let renders = 0;
  P.keepFocus(root, () => {
    renders++;
    doc.activeElement = doc.body; // what clearing the page does to the focus
    doc.scrollingElement.scrollTop = 0;
    build();
  });
  assert.equal(renders, 1);
  assert.notEqual(doc.activeElement, before);
  assert.equal(doc.activeElement, current[1], 'the new language select has the focus');
  assert.equal(doc.scrollingElement.scrollTop, 120, 'scroll position kept');
  doc.activeElement = doc.body;
  P.keepFocus(root, build);
  assert.equal(doc.activeElement, doc.body, 'nothing focused before: nothing focused after');
});

test('audio format labels and unreachable-worker detection', () => {
  const { AYT } = load();
  const P = AYT.pages;
  assert.deepEqual(['mp3', 'm4a', 'opus', 'flac', 'wav'].map(P.audioFormatLabel), ['MP3', 'M4A', 'Opus', 'FLAC', 'WAV']);
  assert.equal(P.audioFormatLabel('aac'), 'AAC');
  // AYT.client may keep Chrome's own message in .detail and show a friendly .message
  const e = Object.assign(new Error('The background service is not responding.'), { code: 'runtime', detail: 'Could not establish connection. Receiving end does not exist.' });
  assert.equal(P.isUnreachable(e), true);
  assert.equal(P.errorText(e), AYT.t('pages.err.noBackground'));
  assert.equal(P.isUnreachable(Object.assign(new Error('nope'), { code: 'bad_request' })), false);
});

test('formatPercent follows the UI language', () => {
  const { AYT } = load();
  assert.equal(AYT.pages.formatPercent(0.95), '95%');
  assert.equal(AYT.pages.formatPercent(4), '400%');
  AYT.i18n.setLanguage('tr');
  assert.equal(AYT.pages.formatPercent(0.95), '%95');
  AYT.i18n.setLanguage('fr');
  assert.match(AYT.pages.formatPercent(0.95), /^95\s%$/u);
});

test('withTimeout / request: timeouts, {ok:false} errors and unreachable service worker', async () => {
  const { AYT } = load({
    onMessage: async (msg) => {
      if (msg.type === 'jobs:clear') return { ok: false, error: 'nope', code: 'bad_request' };
      if (msg.type === 'jobs:list') return new Promise(() => {}); // never answers
      return { ok: true, echo: msg.type };
    },
  });
  assert.equal(AYT.MSG.JOBS_CLEAR, 'jobs:clear');
  assert.equal(AYT.MSG.JOBS_LIST, 'jobs:list');
  const P = AYT.pages;
  assert.equal(await P.withTimeout(Promise.resolve(5), 50), 5);
  await assert.rejects(P.withTimeout(new Promise(() => {}), 30), (e) => e.code === 'timeout' && e.message === AYT.t('pages.err.timeout'));
  assert.equal((await P.request(AYT.MSG.OPEN_TAB, { url: 'chrome://extensions/shortcuts' })).echo, AYT.MSG.OPEN_TAB);
  await assert.rejects(P.request(AYT.MSG.JOBS_CLEAR, {}), (e) => e.code === 'bad_request' && e.message === 'nope');
  await assert.rejects(P.request(AYT.MSG.JOBS_LIST, {}, 40), (e) => e.code === 'timeout');

  const down = load(); // no service worker at all
  await assert.rejects(down.AYT.pages.request(down.AYT.MSG.OPEN_TAB, {}), (e) => down.AYT.pages.isUnreachable(e));
  const err = await down.AYT.pages.request(down.AYT.MSG.OPEN_TAB, {}).catch((e) => e);
  assert.equal(down.AYT.pages.errorText(err), down.AYT.t('pages.err.noBackground'));
  const own = await down.AYT.pages.withTimeout(new Promise(() => {}), 10).catch((e) => e);
  assert.equal(down.AYT.pages.errorText(own), down.AYT.t('pages.err.timeout'), 'our own time limit');
  assert.equal(down.AYT.pages.errorText(Object.assign(new Error(''), { code: 'timeout' })), down.AYT.t('pages.err.timeout'));
  // answered by the service worker: the companion did not answer in time (its localized text is kept)
  assert.equal(down.AYT.pages.errorText(Object.assign(new Error("The companion app didn't answer in time. Try again."), { code: 'timeout' })), "The companion app didn't answer in time. Try again.");
  assert.equal(down.AYT.pages.errorText(Object.assign(new Error('Disk full'), { code: 'disk' })), 'Disk full');
});

test('fetchHostStatus never throws: unreachable worker -> unknown; answers are normalized', async () => {
  const down = load();
  const st = await down.AYT.pages.fetchHostStatus(true);
  assert.equal(st.state, 'unknown');
  assert.equal(st.error, down.AYT.t('pages.err.noBackground'));
  assert.deepEqual(down.sent.map((m) => [m.type, m.refresh]), [[down.AYT.MSG.HOST_STATUS, true]]);

  const up = load({ onMessage: async () => ({ ok: true, status: { state: 'connected', version: '1.0.0', tools: { ytdlp: { version: '2026.10.26' } } } }) });
  let pushed = null;
  up.AYT.client.on('host', (s) => (pushed = s));
  const ok = await up.AYT.pages.fetchHostStatus(false);
  assert.equal(ok.state, 'connected');
  assert.equal(ok.tools.ytdlp.version, '2026.10.26');
  assert.equal(pushed.state, 'connected', "AYT.client 'host' listeners are notified");

  const odd = load({ onMessage: async () => ({ ok: true, status: { state: 'banana' } }) });
  assert.equal((await odd.AYT.pages.fetchHostStatus(false)).state, 'unknown');
});

test('cachedHostStatus reads the status stored by the service worker', async () => {
  const { AYT, store } = load();
  assert.equal(await AYT.pages.cachedHostStatus(), null);
  store[AYT.STORAGE.HOST_STATUS] = { state: 'checking' };
  assert.equal(await AYT.pages.cachedHostStatus(), null);
  store[AYT.STORAGE.HOST_STATUS] = { state: 'missing', checkedAt: 1 };
  assert.equal((await AYT.pages.cachedHostStatus()).state, 'missing');
});

test('openOptions / openShortcuts fall back to chrome.tabs.create when the worker is unreachable', async () => {
  const down = load();
  await down.AYT.pages.openOptions('companion');
  await down.AYT.pages.openShortcuts();
  assert.deepEqual(down.created.map((c) => c.url), [
    'chrome-extension://oicpmbpfimnoolnhfgdocfjelknjlcif/options/options.html#companion',
    'chrome://extensions/shortcuts',
  ]);

  const up = load({ onMessage: async () => ({ ok: true }) });
  await up.AYT.pages.openOptions('downloads');
  await up.AYT.pages.openShortcuts();
  assert.equal(up.created.length, 0, 'the service worker handles it');
  assert.deepEqual(up.sent.map((m) => m.type), [up.AYT.MSG.OPEN_OPTIONS, up.AYT.MSG.OPEN_TAB]);
  assert.equal(up.sent[0].section, 'downloads');
  assert.equal(up.sent[1].url, 'chrome://extensions/shortcuts');
});

test('toolbar table matches the spec ids/order and every label is translated', () => {
  const { AYT } = load();
  assert.deepEqual(
    Array.from(AYT.pages.TOOLBAR_BUTTONS, (b) => b.id),
    ['video', 'audio', 'thumbnail', 'subtitles', 'screenshot', 'loop', 'speed', 'boost', 'adjust', 'pip', 'cinema', 'comments', 'settings']
  );
  for (const b of AYT.pages.TOOLBAR_BUTTONS) {
    const label = AYT.pages.toolbarLabel(b.id);
    assert.ok(label && label !== b.id && !/^(pages|toolbar)\./.test(label), `label of ${b.id}`);
  }
  // icons exist in the shared icon set (checked against dom.js source; no DOM needed)
  const domSrc = fs.readFileSync(path.join(EXT, 'shared', 'dom.js'), 'utf8');
  for (const b of AYT.pages.TOOLBAR_BUTTONS) assert.ok(new RegExp(`\\n\\s+'?${b.icon}'?: \\[`).test(domSrc), `icon ${b.icon} exists`);
});

test('i18n: every pages.* key used by the popup/options exists in en.pages.json with matching placeholders, and none is unused', () => {
  const part = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'parts', 'en.pages.json'), 'utf8'));
  const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'parts', 'en.core.json'), 'utf8'));
  const keys = Object.keys(part);
  assert.deepEqual(keys, [...keys].sort(), 'keys are sorted');
  // plural keys: t('<key>', { count }) with "<key>.one" + "<key>.other" in English (and no plain "<key>")
  const plural = new Set(keys.filter((k) => k.endsWith('.one') && k.replace(/\.one$/, '.other') in part).map((k) => k.replace(/\.one$/, '')));
  const familyOf = (k) => {
    const m = /^(.+)\.(one|other)$/.exec(k);
    return m && plural.has(m[1]) ? m[1] : null;
  };
  for (const base of plural) assert.ok(!(base in part), `${base} is either a plain or a plural key`);
  const src = ['popup/popup.js', 'options/options.js', 'options/pages-common.js'].map((f) => fs.readFileSync(path.join(EXT, f), 'utf8')).join('\n');
  const used = new Set();
  const re = /\bt\(\s*'([a-zA-Z0-9_.-]+)'(?:\s*,\s*\{([^}]*)\})?/g;
  let m;
  const params = new Map();
  while ((m = re.exec(src))) {
    used.add(m[1]);
    if (m[2]) params.set(m[1], new Set([...(params.get(m[1]) || []), ...m[2].split(',').map((s) => s.split(':')[0].trim()).filter(Boolean)]));
  }
  for (const k of used) {
    if (k.startsWith('pages.')) assert.ok(k in part || plural.has(k), `missing English text for ${k}`);
    else assert.ok(k in core || k.startsWith('error.'), `core key ${k} exists`);
    if (plural.has(k)) assert.ok(params.get(k) && params.get(k).has('count'), `plural key ${k} is called with { count }`);
  }
  for (const k of keys) assert.ok(used.has(k) || used.has(familyOf(k)), `unused key ${k}`);
  for (const [k, ps] of params) {
    const texts = plural.has(k) ? [part[k + '.one'], part[k + '.other']] : [part[k] || core[k]];
    for (const text of texts) for (const p of ps) assert.ok(text.includes('{' + p + '}'), `${k} has placeholder {${p}}`);
  }
  for (const [k, v] of Object.entries(part)) assert.ok(typeof v === 'string' && v.trim() && v === v.trim(), `${k} is a clean string`);
});

test('i18n: the import messages pick the singular or plural form by count', () => {
  const { AYT } = load();
  assert.equal(AYT.t('pages.backup.imported', { count: 1 }), 'Imported 1 setting');
  assert.equal(AYT.t('pages.backup.imported', { count: 12 }), 'Imported 12 settings');
  assert.equal(AYT.t('pages.backup.importedSkipped', { count: 1, skipped: 2 }), 'Imported 1 setting, skipped 2 unknown or invalid');
  // the text tools/e2e/pages.e2e.mjs expects after importing its test file
  assert.equal(AYT.t('pages.backup.importedSkipped', { count: 3, skipped: 2 }), 'Imported 3 settings, skipped 2 unknown or invalid');
});

test('hostView: a blocked companion shows the reason the service worker found (another extension ID or a policy)', () => {
  const { AYT } = load();
  const policy = 'Your administrator has blocked companion apps in this browser.';
  assert.equal(AYT.pages.hostView({ state: 'forbidden', error: policy }).text, policy);
  assert.equal(AYT.pages.hostView({ state: 'forbidden' }).text, AYT.t('pages.host.forbiddenText'));
  assert.equal(AYT.pages.hostView({ state: 'forbidden', error: policy }).title, AYT.t('pages.host.forbiddenTitle'));
});

test('hostLine: the popup shows the reason of a blocked or failing companion (status.error), otherwise the title', () => {
  const { AYT } = load();
  const line = AYT.pages.hostLine;
  const policy = 'Your administrator has blocked companion apps in this browser.';
  const timeout = "The companion app didn't answer in time.";
  const startFailed = "The companion app couldn't be started.";
  assert.equal(line({ state: 'forbidden', reason: 'policy', error: policy }), policy);
  assert.equal(line({ state: 'error', error: timeout }), timeout);
  assert.equal(line({ state: 'error', error: startFailed }), startFailed, 'a timeout and a failed start read differently');
  assert.equal(line({ state: 'forbidden' }), AYT.t('pages.host.forbiddenText'), 'no reason: the generic explanation');
  assert.equal(line({ state: 'error' }), AYT.t('host.error.text'));
  for (const state of ['connected', 'checking', 'missing', 'outdated', 'unknown']) {
    assert.equal(line({ state, error: 'raw' }), AYT.pages.hostView({ state }).title, state);
  }
  assert.equal(line(null), AYT.t('pages.host.unknownTitle'));
});

test('update timeouts: the companion answers before the service worker gives up, and the worker before the page', () => {
  const { AYT } = load({ extra: ['background/native.js'] });
  const hostTs = fs.readFileSync(path.join(ROOT, 'companion', 'host', 'host.ts'), 'utf8');
  const expr = (/const UPDATE_BUDGET_MS\s*=\s*([\d_\s*]+);/.exec(hostTs) || [])[1];
  assert.ok(expr, 'UPDATE_BUDGET_MS found in companion/host/host.ts');
  const budget = expr.split('*').reduce((acc, n) => acc * Number(n.replace(/[_\s]/g, '')), 1);
  const worker = AYT.native.config.timeouts.updateTools;
  const page = AYT.pages.TIMEOUTS.updateTools;
  assert.equal(worker, 10 * 60 * 1000);
  assert.equal(page, 10 * 60 * 1000 + 20000);
  assert.ok(budget + 30000 <= worker, `host budget ${budget} ms leaves the worker time to receive the answer (${worker} ms)`);
  assert.ok(worker + 10000 <= page, `the worker (${worker} ms) answers the page (${page} ms) first`);
});
