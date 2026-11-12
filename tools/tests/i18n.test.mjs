#!/usr/bin/env node
/*
 * Unit tests for the shared foundation: AYT.i18n (plurals, lazy dictionaries, 'auto' language), tools/build-i18n.mjs,
 * AYT.util number/size/percent formatting, jobLabel and hidePaths, AYT.ui.jobStatusText and job rows (jobItem),
 * AYT.settings.load and AYT.client (errors, idle port).
 *   node --test tools/tests/i18n.test.mjs
 *
 * The real classic scripts run in vm contexts with small chrome.* stubs. build-i18n.mjs is run on a
 * throw-away copy of the project layout in the OS temp folder.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = path.join(ROOT, 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A vm context with the given extension scripts loaded. extra: globals to add (chrome, document, ...). */
function context(files, extra) {
  const ctx = Object.assign({ console, Intl, setTimeout, clearTimeout }, extra || {});
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f });
  return ctx;
}
const BASE = ['shared/constants.js', 'shared/utils.js', 'shared/i18n.js', 'shared/i18n/en.js'];

/* ------------------------------------------------------------------ AYT.i18n */
test('t() picks the plural form of the UI language, then the count-safe text, then English', () => {
  const { AYT } = context(BASE);
  const { i18n } = AYT;
  i18n.register('en', { 'x.items.one': '{count} item', 'x.items.other': '{count} items' });
  i18n.register('ru', { 'x.items.one': '{count} файл', 'x.items.few': '{count} файла', 'x.items.many': '{count} файлов', 'x.items.other': '{count} файла' });
  i18n.register('fr', { 'x.items': 'Fichiers : {count}' }); // count-safe single form
  i18n.register('de', { 'x.items.one': '{count} Datei' }); // incomplete German: the missing form comes from English
  const run = (lang, counts) => {
    i18n.setLanguage(lang);
    return counts.map((count) => AYT.t('x.items', { count }));
  };
  assert.deepEqual(run('en', [0, 1, 2, 1.5]), ['0 items', '1 item', '2 items', '1.5 items']);
  assert.deepEqual(run('ru', [1, 2, 5, 11, 21, 22, 25]), ['1 файл', '2 файла', '5 файлов', '11 файлов', '21 файл', '22 файла', '25 файлов']);
  assert.deepEqual(run('fr', [0, 1, 1000000]), ['Fichiers : 0', 'Fichiers : 1', 'Fichiers : 1000000']);
  assert.deepEqual(run('de', [1, 3]), ['1 Datei', '3 items'], 'a missing German form falls back to English');
  assert.deepEqual(run('tr', [1, 4]), ['1 item', '4 items'], 'no Turkish text at all: English plural forms');
  i18n.setLanguage('en');
  assert.equal(AYT.t('x.items'), '{count} items', 'without a count the .other form is used');
  assert.equal(AYT.t('x.items', { count: '1' }), '1 items', 'count must be a number to pick a form');
  assert.equal(i18n.has('x.items'), true);
  assert.equal(i18n.has('x.nope'), false);
  assert.equal(AYT.t('x.nope', { count: 2 }), 'x.nope');
  assert.equal(AYT.t('job.playlistItem', { index: 2, count: 5 }), 'Video 2 of 5', 'ordinary keys still work with a count');
  assert.equal(AYT.t('constructor'), 'constructor', 'dictionaries have no prototype keys');
  assert.equal(i18n.pluralCategory(2, 'ru'), 'few');
});

test("'auto' is the first of Chrome's preferred languages we support, then the browser UI language", () => {
  const i18nWith = (languages, uiLanguage) =>
    context(['shared/i18n.js'], {
      navigator: languages === undefined ? { language: 'en-US' } : { languages, language: languages[0] },
      chrome: uiLanguage === undefined ? undefined : { i18n: { getUILanguage: () => uiLanguage } },
    }).AYT.i18n;
  assert.equal(i18nWith(['pt-BR', 'az-AZ', 'en-US'], 'en-US').resolve('auto'), 'az', 'Chrome shows English, but Azerbaijani is preferred');
  assert.equal(i18nWith(['de_AT', 'ru'], 'ru').resolve('auto'), 'de');
  assert.equal(i18nWith(['pt-BR', 'ja'], 'tr-TR').resolve('auto'), 'tr', 'no preferred language is supported: the UI language');
  assert.equal(i18nWith(undefined, 'fr-CA').resolve('auto'), 'fr', 'no navigator.languages');
  assert.equal(i18nWith(['ja'], 'ja').resolve('auto'), 'en', 'nothing supported: English');
  assert.equal(i18nWith([], undefined).resolve('auto'), 'en', 'no chrome.i18n either');
  assert.equal(i18nWith(['ru'], 'en').resolve('es'), 'es', 'an explicit language wins');
  assert.equal(i18nWith(['ru'], 'en').resolve('xx'), 'ru', 'an unknown preference counts as auto');
  const throwing = context(['shared/i18n.js'], { chrome: { i18n: { getUILanguage: () => { throw new Error('gone'); } } } }).AYT.i18n;
  assert.equal(throwing.setLanguage('auto'), 'en');
});

test('dictionaries registered as functions are built on first use, in registration order', () => {
  const { AYT } = context(['shared/i18n.js']);
  const { i18n } = AYT;
  let built = 0;
  i18n.register('ru', () => {
    built++;
    return { a: 'lazy A', b: 'lazy B' };
  });
  i18n.register('en', { a: 'en A', b: 'en B', c: 'en C' });
  assert.equal(built, 0, 'nothing built before the language is used');
  i18n.register('ru', { b: 'object B' }); // later registration wins over the earlier lazy part
  assert.equal(built, 1);
  i18n.register('ru', () => ({ c: 'lazy C' }));
  i18n.setLanguage('ru');
  assert.deepEqual([AYT.t('a'), AYT.t('b'), AYT.t('c')], ['lazy A', 'object B', 'lazy C']);
  assert.equal(built, 1, 'each part is built once');
  assert.deepEqual([...i18n.keys('ru')].sort(), ['a', 'b', 'c']);
});

test('generated dictionaries register lazily and contain only valid keys', () => {
  for (const lang of ['en', 'az', 'tr', 'ru', 'fr', 'de', 'es']) {
    const src = fs.readFileSync(path.join(EXT, 'shared', 'i18n', lang + '.js'), 'utf8');
    assert.ok(src.includes(`g.AYT.i18n.register(${JSON.stringify(lang)}, function () {`), lang + '.js registers a function');
  }
  const { AYT } = context(['shared/i18n.js', ...['en', 'az', 'tr', 'ru', 'fr', 'de', 'es'].map((l) => `shared/i18n/${l}.js`)]);
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'en.json'), 'utf8'));
  assert.deepEqual([...AYT.i18n.keys('en')].sort(), Object.keys(en).sort());
  for (const lang of ['ru', 'tr']) {
    AYT.i18n.setLanguage(lang);
    assert.notEqual(AYT.t('common.cancel'), en['common.cancel'], lang + ' is translated');
  }
});

/* ------------------------------------------------------------------ tools/build-i18n.mjs */
/** Runs build-i18n.mjs on a scratch project. files: { 'relative/path': text|object }. */
function buildScratch(files, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayt-i18n-test-'));
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.copyFileSync(path.join(ROOT, 'tools', 'build-i18n.mjs'), path.join(dir, 'tools', 'build-i18n.mjs'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  const r = spawnSync(process.execPath, [path.join(dir, 'tools', 'build-i18n.mjs'), ...(args || [])], { encoding: 'utf8' });
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  return { dir, status: r.status, out: r.stdout + r.stderr, read, json: (rel) => JSON.parse(read(rel)), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const MANIFEST = { commands: { 'toggle-loop': { description: '__MSG_cmdLoop__' }, 'speed-up': { description: '__MSG_cmdSpeedUp__' } } };
const PARTS = {
  'i18n/parts/en.a.json': { 'a.items.one': '{count} item', 'a.items.other': '{count} items', 'pages.cmd.loop': 'Turn loop on or off', 'pages.cmd.speedUp': 'Faster $playback' },
  'i18n/parts/en.b.json': { 'b.hello': 'Hello {name}' },
  'extension/manifest.json': MANIFEST,
  'extension/code.js': "t('a.items', { count: n }); t('b.hello', { name }); t('pages.cmd.loop'); t('pages.cmd.speedUp');",
  'extension/_locales/en/messages.json': { extName: { message: 'X' }, cmdLoop: { message: 'Toggle loop' } },
  'extension/_locales/ru/messages.json': { extName: { message: 'X' }, cmdLoop: { message: 'Old', description: 'kept' } },
};

test('build-i18n: plural keys, count-safe forms and checks', (t) => {
  const ok = buildScratch(
    Object.assign({}, PARTS, {
      'i18n/en.json': { 'stale.key': 'gone after the build' },
      'i18n/ru.json': { 'a.items.one': '{count} штука', 'a.items.few': '{count} штуки', 'a.items.many': '{count} штук', 'a.items.other': '{count} штуки', 'b.hello': 'Привет, {name}', 'pages.cmd.loop': 'Повтор вкл./выкл.', 'pages.cmd.speedUp': 'Быстрее' },
      'i18n/fr.json': { 'a.items': 'Éléments : {count}', 'b.hello': 'Bonjour {name}', 'pages.cmd.loop': 'Boucle', 'pages.cmd.speedUp': 'Plus vite' },
    }),
    ['--check']
  );
  t.after(ok.cleanup);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /1 plural key\(s\).*a\.items/);
  assert.match(ok.out, /ru: one\/few\/many\/other/, 'tells translators which forms each language needs');
  assert.deepEqual(Object.keys(ok.json('i18n/en.json')), ['a.items.one', 'a.items.other', 'b.hello', 'pages.cmd.loop', 'pages.cmd.speedUp'], 'en.json is rebuilt from the parts');
  const ruJs = ok.read('extension/shared/i18n/ru.js');
  assert.ok(ruJs.includes('"a.items.few": "{count} штуки"') && ruJs.includes('register("ru", function () {'));
  assert.ok(ok.read('extension/shared/i18n/fr.js').includes('"a.items": "Éléments : {count}"'), 'count-safe form kept');
  // the generated files work with the real runtime
  const ctx = context(['shared/i18n.js']);
  for (const l of ['en', 'ru', 'fr']) vm.runInContext(ok.read(`extension/shared/i18n/${l}.js`), ctx);
  ctx.AYT.i18n.setLanguage('ru');
  assert.equal(ctx.AYT.t('a.items', { count: 5 }), '5 штук');
  ctx.AYT.i18n.setLanguage('fr');
  assert.equal(ctx.AYT.t('a.items', { count: 5 }), 'Éléments : 5');
  // Chrome's shortcut names follow pages.cmd.* ("$" escaped for chrome.i18n), other messages untouched
  assert.deepEqual(ok.json('extension/_locales/en/messages.json'), { extName: { message: 'X' }, cmdLoop: { message: 'Turn loop on or off' }, cmdSpeedUp: { message: 'Faster $$playback' } });
  assert.deepEqual(ok.json('extension/_locales/ru/messages.json').cmdLoop, { message: 'Повтор вкл./выкл.', description: 'kept' });

  const partial = buildScratch(Object.assign({}, PARTS, { 'i18n/ru.json': { 'a.items.one': '{count} штука', 'a.items.other': '{count} штуки', 'a.items.two': 'x {count}', 'b.hello': 'Привет, {name}' } }), ['--check']);
  t.after(partial.cleanup);
  assert.equal(partial.status, 0, 'incomplete/extra translations are warnings with --check: ' + partial.out);
  assert.match(partial.out, /incomplete plural forms: a\.items\.\{few,many\}/);
  assert.match(partial.out, /extra.*a\.items\.two/);
  assert.ok(!partial.read('extension/shared/i18n/ru.js').includes('a.items.two'), 'unused forms are left out');
  const strict = buildScratch(Object.assign({}, PARTS, { 'i18n/ru.json': { 'a.items.one': '{count} штука', 'b.hello': 'Привет, {name}' } }), ['--strict']);
  t.after(strict.cleanup);
  assert.equal(strict.status, 1, '--strict fails on incomplete plural forms');

  const badPh = buildScratch(Object.assign({}, PARTS, { 'i18n/ru.json': { 'a.items': 'Штук: {n}' } }), ['--check']);
  t.after(badPh.cleanup);
  assert.equal(badPh.status, 1);
  assert.match(badPh.out, /placeholders: a\.items/);

  const badEn = buildScratch(Object.assign({}, PARTS, { 'i18n/parts/en.c.json': { 'a.items': 'Items: {count}', 'a.items.few': '{count} items' } }), ['--check']);
  t.after(badEn.cleanup);
  assert.equal(badEn.status, 1);
  assert.match(badEn.out, /both a plain key and a plural key/);
  assert.match(badEn.out, /English only uses the plural forms one, other/);
});

/* ------------------------------------------------------------------ AYT.util formatting */
test('sizes, speeds and percents follow the UI language and one GB threshold', () => {
  const { AYT } = context([...BASE, 'shared/i18n/fr.js', 'shared/i18n/ru.js', 'shared/i18n/tr.js']);
  const U = AYT.util;
  const MiB = 1024 * 1024;
  AYT.i18n.setLanguage('en');
  assert.deepEqual(
    [0, 512, 12 * 1024, 5467369, 1010391451, 1011.5 * MiB, 2154156395, 25 * 1024 ** 3, 150 * 1024 ** 3].map((b) => U.formatBytes(b)),
    ['0 B', '512 B', '12 KB', '5.2 MB', '963.6 MB', '0.99 GB', '2.01 GB', '25.0 GB', '150 GB']
  );
  assert.equal(U.formatBytes(999.97 * MiB), '0.98 GB', 'never "1,000 MB"');
  assert.equal(U.formatBytes(null), '');
  assert.equal(U.formatBytes(-1), '');
  assert.equal(U.formatSpeed(2.4 * MiB), '2.4 MB/s');
  assert.equal(U.formatSpeed(120 * 1024), '120 KB/s');
  assert.equal(U.formatPercent(42), '42%');
  assert.equal(U.formatPercent(Math.floor(99.9)), '99%');
  AYT.i18n.setLanguage('fr');
  assert.match(U.formatBytes(1010391451), /^963,6\s?Mo$/u);
  assert.match(U.formatSpeed(2.4 * MiB), /^2,4\s?Mo\/s$/u);
  assert.match(U.formatPercent(42), /^42\s%$/u);
  AYT.i18n.setLanguage('ru');
  assert.match(U.formatBytes(1011.5 * MiB), /^0,99\sГБ$/u);
  AYT.i18n.setLanguage('tr');
  assert.equal(U.formatPercent(42), '%42');
  AYT.i18n.setLanguage('en');
});

/* ------------------------------------------------------------------ AYT.util.jobLabel */
test('jobLabel rebuilds a job label from its task in the current language, else keeps job.label', () => {
  const { AYT } = context([...BASE, 'shared/i18n/ru.js']);
  const label = (task, job) =>
    AYT.util.jobLabel(Object.assign({ kind: task.kind, label: 'stored label', task: Object.assign({ videoId: 'dQw4w9WgXcQ', playlist: false }, task) }, job));
  AYT.i18n.setLanguage('en');
  // video: container · resolution (+fps > 30) · HDR · audio language · playlist · clip
  assert.equal(label({ kind: 'video', height: 2160, width: 3840, fps: 60, hdr: true, container: 'mp4' }), 'MP4 · 2160p60 · HDR');
  assert.equal(
    label({ kind: 'video', height: 1080, width: 1920, fps: 30, hdr: false, container: 'webm', audioLang: 'tr', section: { start: 60, end: 150.5 } }),
    'WebM · 1080p · Turkish · ✂ 01:00–02:30'
  );
  assert.equal(label({ kind: 'video', height: 1920, width: 1080, fps: 60, container: 'mkv' }), 'MKV · 1080p60', 'vertical video');
  assert.equal(label({ kind: 'video', height: 800, width: 1920, fps: 24, container: 'mp4' }), 'MP4 · 1080p', "letterboxed 1920×800 is YouTube's 1080p");
  assert.equal(label({ kind: 'video', height: 480, width: 854, container: 'mp4' }), 'MP4 · 480p');
  assert.equal(label({ kind: 'video', height: 2160, width: 4096, container: 'mp4' }), 'MP4 · 2160p', 'DCI 4K');
  assert.equal(label({ kind: 'video', height: 720, width: 1280, container: 'mp4', section: { start: 3600, end: 3725 } }), 'MP4 · 720p · ✂ 1:00:00–1:02:05');
  assert.equal(
    label({ kind: 'video', height: null, width: null, hdr: null, fps: null, container: 'mp4', playlist: true, audioLang: 'pt-BR', section: { start: 1, end: 2 } }),
    'MP4 · Best quality · Brazilian Portuguese · Playlist',
    'best quality; a playlist has no clip'
  );
  assert.equal(label({ kind: 'video', height: 1080, width: 1920, container: 'mp4', audioLang: 'xx' }), 'stored label', "a language without a name: the panel's label");
  assert.equal(label({ kind: 'video', height: 1080, width: 1920, container: 'mp4', audioLang: 'xx' }, { label: '' }), 'MP4 · 1080p · xx', '... or its code');
  // a container left to the settings (context menu jobs): the finished file tells it, else the stored label
  assert.equal(label({ kind: 'video', height: null }, { label: 'MP4 · Best quality' }), 'MP4 · Best quality');
  assert.equal(label({ kind: 'video', height: null }, { status: 'done', filePath: 'C:\\Videos\\Zoo.mkv' }), 'MKV · Best quality');
  // audio: format · kbps (MP3 only) · language · playlist · clip
  assert.equal(label({ kind: 'audio', audioFormat: 'mp3', bitrate: 192, audioLang: 'en-US', section: { start: 0, end: 75 } }), 'MP3 · 192 kbps · American English · ✂ 00:00–01:15');
  assert.equal(label({ kind: 'audio', audioFormat: 'opus', bitrate: 192, playlist: true }), 'Opus · Playlist');
  assert.equal(label({ kind: 'audio', audioFormat: 'flac' }), 'FLAC');
  assert.equal(label({ kind: 'audio', audioFormat: 'mp3' }, { label: 'MP3 · 256 kbps' }), 'MP3 · 256 kbps', 'MP3 bitrate left to the settings');
  // subtitles: format · language (⚙︎ = auto-generated) → translation
  assert.equal(label({ kind: 'subtitle', subLang: 'en', subAuto: true, subFormat: 'vtt', subTranslateTo: 'az' }), 'WebVTT · English ⚙︎ → Azerbaijani');
  assert.equal(label({ kind: 'subtitle', subLang: 'de', subAuto: false, subFormat: 'txt', subTranslateTo: null }), 'TXT · German');
  // GIF
  assert.equal(label({ kind: 'gif', section: { start: 10, end: 20 }, gifWidth: 480, gifFps: 15 }), 'GIF · 480px · ✂ 00:10–00:20');
  // jobs without a usable task keep their label
  assert.equal(AYT.util.jobLabel({ kind: 'video', label: 'MP4 · 720p' }), 'MP4 · 720p');
  assert.equal(AYT.util.jobLabel({ kind: 'video', label: 'MP4 · 720p', task: { kind: 'video' } }), 'MP4 · 720p', 'job restored without its task');
  assert.equal(AYT.util.jobLabel({ kind: 'subtitle', label: 'SRT · English', task: { kind: 'subtitle' } }), 'SRT · English');
  assert.equal(AYT.util.jobLabel(null), '');

  // another UI language: the words and language names follow (the ru texts stand in for the translation)
  AYT.i18n.register('ru', { 'job.label.best': 'Лучшее качество', 'job.label.playlist': 'Плейлист' });
  AYT.i18n.setLanguage('ru');
  assert.equal(label({ kind: 'video', height: null, container: 'mp4', playlist: true, audioLang: 'tr' }), 'MP4 · Лучшее качество · Турецкий · Плейлист');
  assert.equal(label({ kind: 'subtitle', subLang: 'en', subAuto: false, subFormat: 'srt', subTranslateTo: 'az' }), 'SRT · Английский → Азербайджанский');
  AYT.i18n.setLanguage('az'); // Azerbaijani capitalizes i as İ
  assert.equal(label({ kind: 'subtitle', subLang: 'en', subFormat: 'srt' }), 'SRT · İngilis');
  AYT.i18n.setLanguage('en');
  assert.equal(AYT.util.formatName('webm'), 'WebM');
  assert.equal(AYT.util.formatName('opus'), 'Opus');
  assert.equal(AYT.util.languageName('a.b', 'fallback'), 'fallback', 'invalid tag');
  assert.equal(AYT.util.languageName('xx'), 'xx');
});

test("Chrome has no Azerbaijani language names: job labels keep the panel's names, else English ones, never codes", () => {
  // Chrome's ICU names only Azerbaijani itself in az: DisplayNames(['az', 'en']) resolves to az, and of() gives
  // undefined for every other language (Intl does not fall back to English for one name). Node's ICU has them all.
  class ChromeDisplayNames extends Intl.DisplayNames {
    constructor(locales, options) {
      super(locales, options);
      this.az = new Intl.Locale([].concat(locales)[0]).language === 'az';
    }
    of(code) {
      const name = super.of(code); // throws for an invalid tag, as in Chrome
      return this.az && new Intl.Locale(code).language !== 'az' ? undefined : name;
    }
  }
  const { AYT } = context(BASE, { Intl: Object.create(Intl, { DisplayNames: { value: ChromeDisplayNames } }) });
  const U = AYT.util;
  const GEAR = '\u2699\uFE0E';
  const job = (task, label) => ({ kind: task.kind, label, task: Object.assign({ videoId: 'jNQXAC9IVRw', playlist: false }, task) });
  // the labels the panels store (YouTube's own track names)
  const jobs = [
    job({ kind: 'video', height: 1080, width: 1920, container: 'mp4', audioLang: 'tr' }, 'MP4 · 1080p · Türk dili'),
    job({ kind: 'audio', audioFormat: 'mp3', bitrate: 192, audioLang: 'ru' }, 'MP3 · 192 kbps · Rus dili'),
    job({ kind: 'subtitle', subLang: 'en', subAuto: true, subFormat: 'srt', subTranslateTo: 'az' }, `SRT · İngilis dili ${GEAR} → Azərbaycan dili`),
  ];
  AYT.i18n.setLanguage('az');
  assert.deepEqual(jobs.map((j) => U.jobLabel(j)), jobs.map((j) => j.label), "the panels' labels, not 'MP4 · 1080p · tr'");
  assert.deepEqual(
    jobs.map((j) => U.jobLabel(Object.assign({}, j, { label: '' }))),
    ['MP4 · 1080p · Turkish', 'MP3 · 192 kbps · Russian', `SRT · English ${GEAR} → Azərbaycan`],
    'no stored label: English names'
  );
  assert.equal(U.jobLabel(job({ kind: 'subtitle', subLang: 'de', subFormat: 'vtt' })), 'WebVTT · German');
  assert.equal(U.jobLabel(job({ kind: 'video', height: 1080, width: 1920, container: 'webm' }, 'stale')), 'WebM · 1080p', 'a job without a language is rebuilt as before');
  assert.deepEqual([U.languageName('tr'), U.languageName('tr', 'Türk dili'), U.languageName('az'), U.languageName('xx')], ['Turkish', 'Türk dili', 'Azərbaycan', 'xx']);
  AYT.i18n.setLanguage('tr'); // Chrome names every language in the other UI languages
  assert.equal(U.jobLabel(jobs[0]), 'MP4 · 1080p · Türkçe');
  AYT.i18n.setLanguage('en');
  assert.equal(U.jobLabel(jobs[2]), `SRT · English ${GEAR} → Azerbaijani`);
});

/* ------------------------------------------------------------------ AYT.util.hidePaths */
test('hidePaths keeps only the last name of absolute paths (their folders hold the Windows user name)', () => {
  const hide = context(BASE).AYT.util.hidePaths;
  // yt-dlp prints Python's repr (doubled backslashes); the companion's own messages come from Deno (single ones)
  assert.equal(
    hide(String.raw`unable to open for writing: [Errno 13] Permission denied: 'C:\\Users\\jdoe\\Downloads\\Akif YouTube\\.akif-tmp\\1a2b3c4d\\Me at the zoo [jNQXAC9IVRw].f137.mp4.part'. Retrying (1/3)...`),
    "unable to open for writing: [Errno 13] Permission denied: 'Me at the zoo [jNQXAC9IVRw].f137.mp4.part'. Retrying (1/3)..."
  );
  assert.equal(
    hide(String.raw`Unable to rename file: [WinError 32] The process cannot access the file: 'C:\\Users\\jdoe\\Videos\\a.mp4.part' -> 'C:\\Users\\jdoe\\Videos\\a.mp4'`),
    "Unable to rename file: [WinError 32] The process cannot access the file: 'a.mp4.part' -> 'a.mp4'"
  );
  assert.equal(
    hide(String.raw`cannot create the output folder C:\Users\jdoe\Videos\Akif YouTube: Access is denied. (os error 5): mkdir 'C:\Users\O'Brien\Videos\Akif's Clips\.akif-tmp'`),
    "cannot create the output folder Akif YouTube: Access is denied. (os error 5): mkdir '.akif-tmp'",
    'an unquoted path ends at ": "; a quote inside a name is kept'
  );
  assert.equal(hide(String.raw`(Failed to spawn 'C:\Users\jdoe\AppData\Local\Programs\Python\Python313\Scripts\yt-dlp.exe': File not found)`), "(Failed to spawn 'yt-dlp.exe': File not found)");
  assert.equal(hide(String.raw`Permission denied: '\\\\nas\\jdoe\\yt\\V.mp4.part' and \\nas\share\jdoe\x.srt`), "Permission denied: 'V.mp4.part' and x.srt", 'UNC paths');
  assert.equal(hide('C:/Users/jdoe/Music/x.mp3: Permission denied'), 'x.mp3: Permission denied');
  // a last name that could be the user's own folder goes too
  assert.equal(hide(String.raw`cannot create the output folder C:\Users\jdoe: Access is denied`), 'cannot create the output folder …: Access is denied');
  assert.equal(hide(String.raw`mkdir '\\?\C:\Users\jdoe'`), "mkdir '…'");
  // the long UNC form is \\server\share\<name> too: <name> could be the user's own folder
  assert.equal(hide(String.raw`mkdir '\\?\UNC\nas\home\jdoe'`), "mkdir '…'");
  assert.equal(hide(String.raw`open '\\?\UNC\nas\home\jdoe\Videos\a.part'`), "open 'a.part'");
  assert.equal(hide(String.raw`Permission denied: 'C:\\Users\\jd`), "Permission denied: '…", 'cut in the middle of the user name');
  // anything else stays as it is
  for (const s of ['Video unavailable. See https://www.youtube.com/t/terms', 'HTTP Error 403: Forbidden (https://www.youtube.com/watch?v=jNQXAC9IVRw)', String.raw`rename 'Videos\a.part'`, 'Aspect 16:9 / 4:3', '']) {
    assert.equal(hide(s), s);
  }
  const once = hide(String.raw`'C:\\Users\\jdoe\\V\\a.part' -> 'C:\\Users\\jdoe\\V\\b.part'`);
  assert.equal(once, "'a.part' -> 'b.part'");
  assert.equal(hide(once), once, 'running it again changes nothing');
  assert.equal(hide(null), '');
});

/* ------------------------------------------------------------------ AYT.ui job status */
test('a finished playlist with failed videos gets a count-safe status', () => {
  const { AYT } = context([...BASE, 'shared/dom.js', 'shared/ui-styles.js', 'shared/ui.js']);
  AYT.i18n.setLanguage('en');
  const status = (job) => AYT.ui.jobStatusText(Object.assign({ status: 'done' }, job));
  assert.equal(status({ fileSize: 1010391451 }), 'Completed · 963.6 MB');
  assert.equal(status({ fileSize: 1010391451, fileCount: 8, failedItems: 2 }), 'Downloaded: 8 · Failed: 2 · 963.6 MB');
  assert.equal(status({ fileCount: 1, failedItems: 1 }), 'Downloaded: 1 · Failed: 1');
  assert.equal(status({ fileCount: 1200, failedItems: 0 }), 'Completed', 'failedItems 0 = complete');
  assert.equal(status({ fileCount: 1200, failedItems: 3, fileSize: 0 }), 'Downloaded: 1,200 · Failed: 3');
});

/** Just enough DOM for AYT.ui's job rows. classList.toggle(c, undefined) flips the class, as in browsers. */
function miniDom() {
  class Node {
    constructor() {
      this.childNodes = [];
      this.parentNode = null;
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get children() {
      return this.childNodes.filter((c) => c instanceof Element);
    }
    get firstElementChild() {
      return this.children[0] || null;
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this.childNodes.forEach((c) => (c.parentNode = null));
      this.childNodes = [];
      if (v != null && v !== '') this.appendChild(new Text(String(v)));
    }
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      this.childNodes.push(c);
      c.parentNode = this;
      return c;
    }
    removeChild(c) {
      this.childNodes.splice(this.childNodes.indexOf(c), 1);
      c.parentNode = null;
      return c;
    }
    contains(n) {
      for (; n; n = n.parentNode) if (n === this) return true;
      return false;
    }
    getRootNode() {
      let n = this;
      while (n.parentNode) n = n.parentNode;
      return n;
    }
    addEventListener() {}
    /** The first descendant with class `cls`. */
    find(cls) {
      for (const c of this.children) {
        const hit = c.classList.contains(cls) ? c : c.find(cls);
        if (hit) return hit;
      }
      return null;
    }
  }
  class Text extends Node {
    constructor(data) {
      super();
      this.data = data;
    }
    get textContent() {
      return this.data;
    }
  }
  class Element extends Node {
    constructor(tag) {
      super();
      this.tagName = String(tag).toUpperCase();
      this.attributes = {};
      this.style = {};
      const classes = (this.classes = new Set());
      this.classList = {
        add: (...cs) => cs.forEach((c) => classes.add(c)),
        remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c),
        toggle(c, force) {
          const on = force === undefined ? !classes.has(c) : !!force;
          if (on) classes.add(c);
          else classes.delete(c);
          return on;
        },
      };
    }
    get className() {
      return [...this.classes].join(' ');
    }
    set className(v) {
      this.classes.clear();
      for (const c of String(v).split(/\s+/)) if (c) this.classes.add(c);
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'class') this.className = v;
    }
    getAttribute(k) {
      return k in this.attributes ? this.attributes[k] : null;
    }
    removeAttribute(k) {
      delete this.attributes[k];
    }
    focus() {}
  }
  const document = { createElement: (tag) => new Element(tag), createElementNS: (ns, tag) => new Element(tag), createTextNode: (s) => new Text(String(s)) };
  return { Node, document };
}

test('job rows: a partial playlist keeps its amber bar in compact lists; error texts lose their folders', () => {
  const { AYT } = context([...BASE, 'shared/dom.js', 'shared/ui-styles.js', 'shared/ui.js'], miniDom());
  AYT.client = { jobs: { isActive: (j) => ['queued', 'starting', 'running', 'processing'].includes(j.status) } };
  AYT.i18n.setLanguage('en');
  const row = (job, opts) => AYT.ui.jobItem(Object.assign({ id: 'j1', kind: 'video', title: 'Me at the zoo', label: 'MP4 · 1080p' }, job), opts);
  const bar = (item) => item.el.find('ayt-progress');
  const shown = (el) => !el.classList.contains('ayt-hidden');

  // every real job list (popup, video/audio/subtitles panels) is compact
  const partial = row({ status: 'done', fileCount: 8, failedItems: 2 }, { compact: true });
  assert.ok(shown(bar(partial)) && bar(partial).classList.contains('is-warn'), 'the amber bar of a partial playlist');
  assert.equal(bar(partial).find('ayt-progress__bar').style.width, '100%');
  assert.equal(partial.el.find('ayt-job__meta').textContent, 'Downloaded: 8 · Failed: 2');
  assert.equal(shown(bar(row({ status: 'done', fileCount: 8, failedItems: 0 }, { compact: true }))), false, 'a complete job has no bar in a compact list');
  const loose = row({ status: 'done' }); // compact left out
  for (let i = 0; i < 3; i++) {
    assert.ok(shown(bar(loose)), 'without compact the bar stays (update ' + i + ')');
    loose.update(Object.assign({}, loose.job));
  }

  const failed = row(
    {
      status: 'error',
      errorCode: 'access_denied',
      error: String.raw`Windows blocked access. — unable to open for writing: [Errno 13] Permission denied: 'C:\\Users\\jdoe\\Videos\\Akif YouTube\\.akif-tmp\\1a2b3c4d\\Me at the zoo [jNQXAC9IVRw].f137.mp4.part'`,
    },
    { compact: true }
  );
  assert.equal(failed.el.find('ayt-job__error').textContent, "Windows blocked access. — unable to open for writing: [Errno 13] Permission denied: 'Me at the zoo [jNQXAC9IVRw].f137.mp4.part'");
  assert.ok(shown(bar(failed)) && bar(failed).classList.contains('is-error'));
});

test('host notice: an administrator policy block offers "Learn more" (nothing to install), like the popup', () => {
  const { AYT } = context([...BASE, 'shared/dom.js', 'shared/ui-styles.js', 'shared/ui.js'], miniDom());
  AYT.client = { send: async () => ({}), host: { refresh: async () => null } };
  AYT.i18n.setLanguage('en');
  const notice = (status) => {
    const el = AYT.ui.hostNotice(status);
    return { text: el.find('ayt-notice__text') ? el.find('ayt-notice__text').textContent : null, primary: el.find('ayt-notice__actions').children[0].textContent };
  };
  const policy = notice({ state: 'forbidden', reason: 'policy', error: 'Blocked by your administrator' });
  assert.equal(policy.primary, AYT.t('common.learnMore'));
  assert.notEqual(AYT.t('common.learnMore'), AYT.t('host.howToInstall'));
  assert.equal(notice({ state: 'forbidden', error: 'Registered for another ID' }).primary, AYT.t('host.howToInstall'));
  assert.equal(notice({ state: 'missing' }).primary, AYT.t('host.howToInstall'));
  assert.equal(notice(null).primary, AYT.t('host.howToInstall'));
});

/* ------------------------------------------------------------------ AYT.settings */
test('settings.load() reads only the settings keys, not the job history', async () => {
  const gets = [];
  const store = { 'settings.hideComments': true, 'settings.boostMax': '250', jobs: [{ id: 'x' }] };
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          gets.push(keys);
          const list = keys == null ? Object.keys(store) : [].concat(keys);
          return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
        },
      },
      onChanged: { addListener() {} },
    },
  };
  const { AYT } = context([...BASE, 'shared/settings.js'], { chrome });
  const all = await AYT.settings.load();
  assert.equal(gets.length, 1);
  assert.ok(Array.isArray(gets[0]), 'a key list, not get(null)');
  assert.ok(!gets[0].includes('jobs'));
  assert.deepEqual([...gets[0]].sort(), Object.keys(AYT.DEFAULT_SETTINGS).map((n) => 'settings.' + n).sort());
  assert.equal(all.hideComments, true);
  assert.equal(all.boostMax, 250);
});

/* ------------------------------------------------------------------ AYT.client */
function clientContext(opts) {
  const o = opts || {};
  const ports = [];
  const listeners = {};
  const on = (type, fn) => (listeners[type] = listeners[type] || []).push(fn);
  const runtime = {
    id: 'test',
    onMessage: { addListener: (fn) => (runtime.messageListener = fn) },
    sendMessage: o.sendMessage || (async () => ({ ok: true })),
    connect() {
      const port = { msg: [], gone: [], disconnected: false };
      port.onMessage = { addListener: (fn) => port.msg.push(fn) };
      port.onDisconnect = { addListener: (fn) => port.gone.push(fn) };
      port.disconnect = () => (port.disconnected = true);
      port.push = (m) => port.msg.forEach((fn) => fn(m));
      port.drop = () => port.gone.forEach((fn) => fn());
      ports.push(port);
      return port;
    },
  };
  const ctx = context([...BASE, 'shared/i18n/ru.js', 'shared/client.js'], {
    chrome: { runtime },
    addEventListener: on,
    document: { visibilityState: 'visible', addEventListener: (type, fn) => on('document:' + type, fn) },
  });
  return { AYT: ctx.AYT, runtime, ports, fire: (type) => (listeners[type] || []).forEach((fn) => fn({})) };
}

test('client: a command push (chrome.tabs.sendMessage) passes viaKeyboard false on, and nothing for shortcuts', () => {
  const env = clientContext({});
  const { AYT } = env;
  const got = [];
  AYT.client.on('command', (command, opts) => got.push([command, opts]));
  env.runtime.messageListener({ __aytPush: true, type: AYT.PUSH.COMMAND, command: 'open-download', viaKeyboard: false });
  env.runtime.messageListener({ __aytPush: true, type: AYT.PUSH.COMMAND, command: 'open-download' });
  env.runtime.messageListener({ __aytPush: true, type: AYT.PUSH.COMMAND, command: 'toggle-loop', viaKeyboard: true });
  env.runtime.messageListener({ type: AYT.PUSH.COMMAND, command: 'ignored: not a push' });
  assert.equal(got.length, 3);
  assert.equal(got[0][0], 'open-download');
  assert.equal(got[0][1].viaKeyboard, false);
  assert.equal(got[1][1], undefined);
  assert.equal(got[2][1], undefined);
});

test('client errors are localized; Chrome\'s own text stays in .detail', async () => {
  const env = clientContext({
    sendMessage: async (m) => {
      if (m.type === 'a') throw new Error('Could not establish connection. Receiving end does not exist.');
      if (m.type === 'b') return undefined;
      return { ok: false, error: 'Нет файла', code: 'not_found' };
    },
  });
  const { AYT } = env;
  AYT.i18n.setLanguage('ru');
  const noBg = await AYT.client.send('a').catch((e) => e);
  assert.equal(noBg.code, 'runtime');
  assert.equal(noBg.message, AYT.t('error.noBackground'));
  assert.match(noBg.detail, /Receiving end does not exist/);
  const noRes = await AYT.client.send('b').catch((e) => e);
  assert.equal(noRes.code, 'no_response');
  assert.equal(noRes.message, AYT.t('error.noBackground'));
  const bg = await AYT.client.send('c').catch((e) => e);
  assert.deepEqual([bg.code, bg.message], ['not_found', 'Нет файла']);
  let invalidatedEvents = 0;
  AYT.client.on('invalidated', () => invalidatedEvents++);
  env.runtime.id = undefined; // extension reloaded: this content script is orphaned
  const inv = await AYT.client.send('c').catch((e) => e);
  assert.equal(inv.code, 'invalidated');
  assert.equal(inv.message, AYT.t('toolbar.invalidated'));
  assert.notEqual(inv.message, 'toolbar.invalidated');
  assert.equal(invalidatedEvents, 1);
  AYT.i18n.setLanguage('en');
});

test('an idle port is not reopened in a loop; activity or an active job reopens it', async () => {
  const env = clientContext();
  const { AYT, ports } = env;
  AYT.client.retain(); // an open panel
  assert.equal(ports.length, 1);
  ports[0].push({ type: AYT.PUSH.JOBS, jobs: [{ id: 'old', status: 'done', createdAt: 1 }] });
  ports[0].drop(); // Chrome stopped the idle service worker
  await sleep(500);
  assert.equal(ports.length, 1, 'no reconnect while nothing is running');
  env.fire('pointerdown');
  assert.equal(ports.length, 2, 'the next user activity reconnects (and gets a fresh snapshot)');
  env.fire('keydown');
  assert.equal(ports.length, 2, 'only once');

  ports[1].push({ type: AYT.PUSH.JOB, job: { id: 'run', status: 'running', createdAt: 2 } });
  ports[1].drop();
  await sleep(500);
  assert.equal(ports.length, 3, 'an active job reconnects at once for its progress');

  ports[2].push({ type: AYT.PUSH.JOB, job: { id: 'run', status: 'done', createdAt: 2 } });
  AYT.client.release(); // panel closed, nothing active -> port closed
  assert.equal(ports[2].disconnected, true);
  env.fire('pointerdown');
  assert.equal(ports.length, 3, 'no port without a reason');
});
