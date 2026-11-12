#!/usr/bin/env node
/*
 * Unit tests for extension/shared/subtitles.js (AYT.subtitles), run with:  node --test tools/tests/subtitles.test.mjs
 * (plus the language-name helpers of the subtitles panel, AYT.captions in extension/content/panels/subtitles.js).
 *
 * Fixtures in tools/tests/fixtures/ are REAL caption responses from YouTube's /api/timedtext (Nov 2026):
 *   captured through the extension's own code path (AYT.videoInfo.fetchCaptions, tools/e2e/media.e2e.mjs --save-fixtures):
 *     KrLj6nc516A.en.{json3,vtt,ttml,srv3}   manual English track ("$1 vs $100,000,000 Car!", 15 min)
 *     KrLj6nc516A.asr.{json3,vtt}            auto-generated English (rolling captions with word segments)
 *     KrLj6nc516A.en-tr.json3                manual English translated by YouTube to Turkish (tlang=tr)
 *   captured with yt-dlp 2026.10.26 (--skip-download --write-subs --write-auto-subs --sub-format <fmt>):
 *     dQw4w9WgXcQ.en.json3, dQw4w9WgXcQ.asr.{json3,vtt,srv3,ttml}   (asr = yt-dlp's "en-orig" track)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIX = path.join(HERE, 'fixtures');

/** Loads the classic script into a fresh vm context, like a content script would see it. */
function loadModule(extraGlobals) {
  const ctx = vm.createContext(Object.assign({}, extraGlobals || {}));
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension', 'shared', 'subtitles.js'), 'utf8'), ctx, { filename: 'subtitles.js' });
  return ctx.AYT.subtitles;
}
const S = loadModule();
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const has = (name) => fs.existsSync(path.join(FIX, name));
// vm objects come from another realm: compare as plain JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ------------------------------------------------------------------ validators */

function srtBlocks(text) {
  return String(text).replace(/\n+$/, '').split('\n\n');
}

/** Strict SRT check: numbering 1..N, HH:MM:SS,mmm timings, end > start, no overlaps, non-empty text. */
function assertValidSrt(text, label) {
  const blocks = srtBlocks(text);
  let prevEnd = -1;
  const sec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  blocks.forEach((b, i) => {
    const lines = b.split('\n');
    assert.equal(lines[0], String(i + 1), `${label}: cue ${i + 1} number`);
    const m = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2,}):(\d{2}):(\d{2}),(\d{3})$/.exec(lines[1] || '');
    assert.ok(m, `${label}: cue ${i + 1} timing line "${lines[1]}"`);
    const s = sec(m[1], m[2], m[3], m[4]);
    const e = sec(m[5], m[6], m[7], m[8]);
    assert.ok(e > s, `${label}: cue ${i + 1} end > start`);
    assert.ok(s >= prevEnd - 1e-9, `${label}: cue ${i + 1} overlaps the previous cue`);
    prevEnd = e;
    assert.ok(lines.length >= 3, `${label}: cue ${i + 1} has text`);
    for (const l of lines.slice(2)) assert.ok(l.trim().length > 0, `${label}: cue ${i + 1} has an empty line`);
    assert.ok(!lines.slice(2).join('\n').includes('-->'), `${label}: cue ${i + 1} text contains -->`);
  });
  return blocks.length;
}

/** Minimal XML well-formedness check for our generated TTML/SRV3 (balanced tags, escaped text). */
function assertWellFormedXml(xml, label) {
  const src = String(xml).replace(/^<\?xml[^>]*\?>/, '');
  const stack = [];
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g;
  let last = 0;
  let m;
  const checkText = (txt) => {
    assert.ok(!/</.test(txt), `${label}: raw "<" in text: ${txt.slice(0, 60)}`);
    assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(txt), `${label}: bare "&" in text: ${txt.slice(0, 60)}`);
  };
  while ((m = tagRe.exec(src))) {
    checkText(src.slice(last, m.index));
    last = tagRe.lastIndex;
    if (m[4]) continue; // self-closing
    if (m[1]) assert.equal(stack.pop(), m[2], `${label}: closing </${m[2]}>`);
    else stack.push(m[2]);
  }
  checkText(src.slice(last));
  assert.equal(stack.length, 0, `${label}: unclosed ${stack.join(',')}`);
}

function consecutiveDuplicates(txt) {
  const lines = String(txt).split('\n').filter(Boolean);
  let n = 0;
  for (let i = 1; i < lines.length; i++) if (lines[i] === lines[i - 1]) n++;
  return n;
}

const words = (s) => String(s).split(/\s+/).filter(Boolean);
/** Independent reference cleanup (YouTube's manual tracks pad segments with U+200B zero-width spaces). */
const clean = (s) =>
  String(s)
    .replace(/​/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
const eventText = (e) => clean(e.segs.map((s) => s.utf8 || '').join(''));

/* ------------------------------------------------------------------ basics */

test('module exposes the documented API', () => {
  for (const fn of ['parse', 'toSrt', 'toVtt', 'toTtml', 'toSrv3', 'toTxt', 'convert', 'detect', 'normalize', 'sourceFormat', 'mimeFor']) {
    assert.equal(typeof S[fn], 'function', fn);
  }
  assert.deepEqual(plain(S.FORMATS), ['srt', 'vtt', 'ttml', 'srv3', 'txt']);
});

test('formatTime / parseClock', () => {
  assert.equal(S.formatTime(3723.456, ','), '01:02:03,456');
  assert.equal(S.formatTime(0, '.'), '00:00:00.000');
  assert.equal(S.formatTime(1.0005, ','), '00:00:01,001');
  assert.equal(S.formatTime(360000, ','), '100:00:00,000');
  assert.equal(S.parseClock('01:02:03.456'), 3723.456);
  assert.equal(S.parseClock('02:03,5'), 123.5);
  assert.ok(Number.isNaN(S.parseClock('abc')));
});

test('sourceFormat: native formats are requested directly, SRT and TXT come from json3', () => {
  assert.equal(S.sourceFormat('vtt'), 'vtt');
  assert.equal(S.sourceFormat('ttml'), 'ttml');
  assert.equal(S.sourceFormat('srv3'), 'srv3');
  assert.equal(S.sourceFormat('srt'), 'json3');
  assert.equal(S.sourceFormat('txt'), 'json3');
});

test('mimeFor uses the chrome.downloads-safe types (and AYT.DOWNLOAD_MIME when present)', () => {
  assert.equal(S.mimeFor('srt'), 'application/x-subrip');
  assert.equal(S.mimeFor('vtt'), 'text/vtt');
  assert.equal(S.mimeFor('ttml'), 'application/ttml+xml');
  assert.equal(S.mimeFor('srv3'), 'application/octet-stream');
  assert.equal(S.mimeFor('txt'), 'text/plain');
  const S2 = loadModule({ AYT: { DOWNLOAD_MIME: { srt: 'x/test' } } });
  assert.equal(S2.mimeFor('srt'), 'x/test');
  assert.equal(S2.mimeFor('vtt'), 'text/vtt');
});

test('detect() recognizes every real fixture', () => {
  const expect = {
    'KrLj6nc516A.en.json3': 'json3',
    'KrLj6nc516A.en.vtt': 'vtt',
    'KrLj6nc516A.en.ttml': 'ttml',
    'KrLj6nc516A.en.srv3': 'srv3',
    'KrLj6nc516A.asr.json3': 'json3',
    'KrLj6nc516A.asr.vtt': 'vtt',
  };
  for (const [name, fmt] of Object.entries(expect)) assert.equal(S.detect(fixture(name)), fmt, name);
  assert.equal(S.detect(''), null);
  assert.equal(S.detect('<html><body>nope</body></html>'), null);
  assert.equal(S.detect('1\n00:00:01,000 --> 00:00:02,000\nHi\n'), 'srt');
  assert.equal(S.detect('<?xml version="1.0"?><transcript><text start="1" dur="1">a</text></transcript>'), 'srv1');
});

/* ------------------------------------------------------------------ json3 (manual) */

test('json3 manual track: every non-empty event becomes one cue, valid SRT', () => {
  const body = fixture('KrLj6nc516A.en.json3');
  const raw = JSON.parse(body).events.filter((e) => Array.isArray(e.segs) && eventText(e));
  const starts = new Set(raw.map((e) => e.tStartMs));
  const cues = S.parse(body, 'json3');
  assert.equal(cues.length, starts.size, 'one cue per distinct start time');
  assert.equal(cues[0].start, raw[0].tStartMs / 1000);
  assert.equal(cues[0].text, eventText(raw[0]), 'text without the zero-width padding');
  assert.ok(cues.every((c) => !c.text.includes('​')), 'no zero-width spaces left');
  const srt = S.toSrt(cues);
  assert.equal(assertValidSrt(srt, 'KrLj6nc516A.en'), cues.length);
  assert.ok(srt.startsWith('1\n'), 'starts with cue number 1');
  assert.ok(!srt.includes('\r'), 'LF line endings');
});

test('json3 manual track: other native formats of the same track give the same cues', () => {
  const ms = (cues) => cues.map((c) => [Math.round(c.start * 1000), c.text]);
  const base = S.parse(fixture('KrLj6nc516A.en.json3'), 'json3');
  for (const f of ['srv3', 'ttml', 'vtt']) {
    const other = S.parse(fixture('KrLj6nc516A.en.' + f), f);
    assert.equal(other.length, base.length, f + ' cue count');
    assert.deepEqual(plain(ms(other)), plain(ms(base)), f + ' starts + text');
    assert.equal(S.toTxt(other), S.toTxt(base), f + ' TXT');
  }
});

/* ------------------------------------------------------------------ json3 (auto-generated, rolling) */

test('json3 auto-generated track: "\\n" append events are dropped, words are kept, overlaps are clipped', () => {
  for (const name of ['KrLj6nc516A.asr.json3', 'dQw4w9WgXcQ.asr.json3'].filter(has)) {
    const body = fixture(name);
    const events = JSON.parse(body).events;
    const appends = events.filter((e) => e.aAppend && Array.isArray(e.segs));
    assert.ok(appends.length > 0, name + ': fixture has rolling append events');
    const textEvents = events.filter((e) => Array.isArray(e.segs) && eventText(e));
    // Expected transcript: every event's words in order; a line repeated right after itself is written once.
    const lines = textEvents.map(eventText).filter((l, i, all) => i === 0 || l !== all[i - 1]);
    const cues = S.parse(body, 'json3');
    assert.equal(cues.length, new Set(textEvents.map((e) => e.tStartMs)).size, name + ': cue count');
    for (const c of cues) assert.ok(c.text.trim() && c.text !== '\n', name + ': no empty cue');
    for (let i = 1; i < cues.length; i++) assert.ok(cues[i - 1].end <= cues[i].start, name + `: cue ${i} overlaps`);
    const txt = S.toTxt(cues);
    assert.deepEqual(words(txt), words(lines.join(' ')), name + ': TXT keeps every recognized word, in order');
    assert.equal(consecutiveDuplicates(txt), 0, name + ': no duplicated lines in TXT');
    assertValidSrt(S.toSrt(cues), name);
  }
});

test('rolling auto-generated VTT is de-duplicated and matches the json3 transcript', () => {
  for (const id of ['KrLj6nc516A', 'dQw4w9WgXcQ']) {
    if (!has(id + '.asr.vtt') || !has(id + '.asr.json3')) continue;
    const vtt = fixture(id + '.asr.vtt');
    assert.ok(/<\d{2}:\d{2}:\d{2}\.\d{3}><c>/.test(vtt), id + ': VTT has word timing tags');
    const fromVtt = S.parse(vtt, 'vtt');
    const fromJson = S.parse(fixture(id + '.asr.json3'), 'json3');
    const txt = S.toTxt(fromVtt);
    assert.equal(consecutiveDuplicates(txt), 0, id + ': no duplicated rolling lines');
    assert.equal(txt, S.toTxt(fromJson), id + ': same transcript as json3');
    assert.equal(fromVtt.length, fromJson.length, id + ': same number of cues');
    for (const c of fromVtt) assert.ok(!/<|&lt;|​/.test(c.text), id + ': tags/zero-width spaces removed');
    assertValidSrt(S.toSrt(fromVtt), id + ' asr.vtt');
  }
});

test('rolling VTT: a blank cue clears the window, so a repeated caption after it is kept', () => {
  // Shape of the end of KrLj6nc516A's auto-generated VTT.
  const vtt = [
    'WEBVTT', 'Kind: captions', 'Language: en', '',
    '00:15:23.960 --> 00:15:25.830 align:start position:0%', ' ', 'I HOPE YOU<00:15:24.200><c> ENJOYED</c>', '',
    '00:15:25.830 --> 00:15:25.840 align:start position:0%', 'I HOPE YOU ENJOYED', ' ', '',
    '00:15:25.840 --> 00:15:28.135 align:start position:0%', 'I HOPE YOU ENJOYED', 'DROP<00:15:26.160><c> A</c>', '',
    '00:15:28.135 --> 00:15:28.145 align:start position:0%', 'DROP A', ' ', '',
    '00:15:28.145 --> 00:15:34.685 align:start position:0%', 'DROP A', '[music]', '',
    '00:15:34.685 --> 00:15:34.695 align:start position:0%', ' ', ' ', '',
    '00:15:34.695 --> 00:15:36.715 align:start position:0%', ' ', '[music]', '',
  ].join('\n');
  assert.deepEqual(plain(S.parse(vtt, 'vtt')).map((c) => c.text), ['I HOPE YOU ENJOYED', 'DROP A', '[music]', '[music]']);
});

test('a song repeating a one-line caption is not mistaken for rolling captions', () => {
  const cues = [0, 2, 4, 6, 8, 10].map((s) => ({ start: s, end: s + 1.5, text: 'Na na na' }));
  assert.equal(S.normalize(cues).length, 6, 'all cues kept for SRT');
  assert.equal(S.toTxt(cues), 'Na na na\n', 'TXT merges the consecutive duplicates');
});

test('other auto-generated formats (srv3, ttml) give the same transcript as json3', () => {
  const id = 'dQw4w9WgXcQ';
  if (!has(id + '.asr.json3')) return;
  const base = S.toTxt(S.parse(fixture(id + '.asr.json3'), 'json3'));
  for (const f of ['srv3', 'ttml'].filter((x) => has(`${id}.asr.${x}`))) assert.equal(S.toTxt(S.parse(fixture(`${id}.asr.${f}`), f)), base, f);
});

/* ------------------------------------------------------------------ translation */

test('translated track (tlang=tr) keeps UTF-8 text and timings', () => {
  const tr = S.parse(fixture('KrLj6nc516A.en-tr.json3'), 'json3');
  const en = S.parse(fixture('KrLj6nc516A.en.json3'), 'json3');
  assert.ok(tr.length > 0);
  assert.ok(/[şığçöüŞİĞÇÖÜ]/.test(S.toTxt(tr)), 'Turkish characters present');
  assert.notEqual(S.toTxt(tr), S.toTxt(en));
  assertValidSrt(S.toSrt(tr), 'en-tr');
  const vtt = S.toVtt(tr, 'tr');
  assert.ok(vtt.startsWith('WEBVTT\nKind: captions\nLanguage: tr\n\n'));
});

/* ------------------------------------------------------------------ writers */

const SAMPLE = [
  { start: 1.36, end: 3.04, text: '[♪♪♪]' },
  { start: 18.64, end: 21.88, text: "♪ We're no strangers to love ♪" },
  { start: 22.64, end: 26.96, text: '♪ You know the rules\nand so do I ♪' },
  { start: 30, end: 32.5, text: 'Tom & Jerry <b>"quoted"</b> \'single\' a-->b' },
];

test('round trips: parse(toX(cues)) gives the cues back', () => {
  const cues = S.parse(fixture('KrLj6nc516A.en.json3'), 'json3');
  for (const [name, text, fmt] of [
    ['srt', S.toSrt(cues), 'srt'],
    ['vtt', S.toVtt(cues, 'en'), 'vtt'],
    ['ttml', S.toTtml(cues, 'en'), 'ttml'],
    ['srv3', S.toSrv3(cues), 'srv3'],
    ['json3', S.toJson3(cues), 'json3'],
  ]) {
    assert.equal(S.detect(text), fmt, name + ' detect');
    assert.deepEqual(plain(S.parse(text, fmt)), plain(cues), name + ' round trip');
  }
  const tricky = S.normalize(SAMPLE);
  for (const [name, text] of [
    ['ttml', S.toTtml(tricky, 'en')],
    ['srv3', S.toSrv3(tricky)],
    ['vtt', S.toVtt(tricky, 'en')],
    ['json3', S.toJson3(tricky)],
  ]) {
    const back = plain(S.parse(text));
    assert.deepEqual(back, plain(tricky), name + ' text survives escaping');
  }
});

test('XML outputs are well-formed and escaped', () => {
  const cues = S.normalize(SAMPLE);
  const ttml = S.toTtml(cues, 'en');
  const srv3 = S.toSrv3(cues);
  assertWellFormedXml(ttml, 'ttml');
  assertWellFormedXml(srv3, 'srv3');
  assert.ok(ttml.includes('Tom &amp; Jerry &lt;b&gt;&quot;quoted&quot;&lt;/b&gt; &apos;single&apos;'));
  assert.ok(ttml.includes('♪ You know the rules<br/>and so do I ♪'), 'TTML line break');
  assert.ok(srv3.includes('<p t="22640" d="4320">♪ You know the rules\nand so do I ♪</p>'), 'srv3 times in ms + literal newline');
  assert.ok(/xml:lang="en"/.test(ttml));
  assert.ok(/xml:lang="und"/.test(S.toTtml(cues, 'bad"lang')), 'invalid language codes are not injected');
  // the real track too
  const real = S.parse(fixture('KrLj6nc516A.en.json3'), 'json3');
  assertWellFormedXml(S.toTtml(real, 'en'), 'ttml real');
  assertWellFormedXml(S.toSrv3(real), 'srv3 real');
});

test('SRT/VTT escaping rules', () => {
  const cues = S.normalize(SAMPLE);
  const srt = S.toSrt(cues);
  assertValidSrt(srt, 'sample');
  assert.ok(srt.includes('Tom & Jerry <b>"quoted"</b> \'single\' a->b'), 'SRT keeps text, never "-->"');
  const vtt = S.toVtt(cues, 'en');
  assert.ok(vtt.includes('Tom &amp; Jerry &lt;b&gt;"quoted"&lt;/b&gt; \'single\' a--&gt;b'), 'VTT escapes & < >');
  assert.ok(/^00:00:01\.360 --> 00:00:03\.040$/m.test(vtt));
});

test('toTxt: one line per caption, dialogue lines kept apart, consecutive duplicates merged', () => {
  const txt = S.toTxt([
    { start: 0, end: 1, text: 'first line\nsecond line' },
    { start: 1, end: 2, text: '- Hello\n- Hi there' },
    { start: 2, end: 3, text: '[Music]' },
    { start: 3, end: 4, text: '[Music]' },
    { start: 4, end: 5, text: 'a\nb' },
    { start: 5, end: 6, text: 'b\nc' },
  ]);
  assert.equal(txt, 'first line second line\n- Hello\n- Hi there\n[Music]\na b\nc\n');
});

/* ------------------------------------------------------------------ normalization */

test('normalize merges simultaneous cues, clips overlaps, fills unknown ends', () => {
  const cues = plain(
    S.normalize([
      { start: 5, end: 7, text: 'B' },
      { start: 1, end: 9, text: 'A' },
      { start: 1, end: 3, text: 'A2' },
      { start: 9, end: NaN, text: 'C' },
      { start: 12, end: 12, text: '  ' },
      { start: 12, end: 11, text: 'D' },
    ])
  );
  assert.deepEqual(cues, [
    { start: 1, end: 5, text: 'A\nA2' },
    { start: 5, end: 7, text: 'B' },
    { start: 9, end: 12, text: 'C' },
    { start: 12, end: 15, text: 'D' },
  ]);
});

test('json3 events without dDurationMs end at the next cue', () => {
  const body = JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'a' }] }, { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'b' }] }] });
  assert.deepEqual(plain(S.parse(body, 'json3')), [
    { start: 0, end: 2, text: 'a' },
    { start: 2, end: 3, text: 'b' },
  ]);
});

test('text cleanup: entities, zero-width spaces, control characters, whitespace', () => {
  const body = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body><p t="0" d="1000">A&#39;s​  \t b&amp;c&#x1F600;\u0007</p><p t="1000" d="10">\n</p></body></timedtext>';
  assert.deepEqual(plain(S.parse(body, 'srv3')), [{ start: 0, end: 1, text: "A's b&c😀" }]);
});

test('srv1 (double-escaped HTML) and srv2', () => {
  const srv1 = '<?xml version="1.0" encoding="utf-8" ?><transcript><text start="1.5" dur="2.25">Tom &amp;amp; Jerry&amp;#39;s</text><text start="4" dur="1">x</text></transcript>';
  assert.deepEqual(plain(S.parse(srv1, 'srv1')), [
    { start: 1.5, end: 3.75, text: "Tom & Jerry's" },
    { start: 4, end: 5, text: 'x' },
  ]);
  const srv2 = '<?xml version="1.0" encoding="utf-8" ?><timedtext><window t="0" id="1"/><text t="1500" d="2000" w="1">hello</text></timedtext>';
  assert.deepEqual(plain(S.parse(srv2, 'srv2')), [{ start: 1.5, end: 3.5, text: 'hello' }]);
});

test('TTML time expressions (clock, frames, offsets, ticks) and pretty-printed whitespace', () => {
  const ttml = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000" ttp:frameRate="25"><body><div>
    <p begin="00:00:01.500" end="00:00:02.000">one</p>
    <p begin="00:00:03:05" dur="1s">two</p>
    <p begin="5.5s" end="6000ms">three
       <span>more</span><br />next</p>
    <p begin="70000000t" end="80000000t">four</p>
  </div></body></tt>`;
  assert.deepEqual(plain(S.parse(ttml, 'ttml')), [
    { start: 1.5, end: 2, text: 'one' },
    { start: 3.2, end: 4.2, text: 'two' },
    { start: 5.5, end: 6, text: 'three more\nnext' },
    { start: 7, end: 8, text: 'four' },
  ]);
});

test('SRT input (YouTube-style) is parsed, ids and tags removed', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i>​\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nworld\r\n';
  assert.deepEqual(plain(S.parse(srt, 'srt')), [
    { start: 1, end: 2.5, text: 'Hello' },
    { start: 3, end: 4, text: 'world' },
  ]);
});

/* ------------------------------------------------------------------ convert */

test('convert(): targets, passthrough and errors', () => {
  const json3 = fixture('KrLj6nc516A.en.json3');
  const vtt = fixture('KrLj6nc516A.en.vtt');
  for (const fmt of ['srt', 'vtt', 'ttml', 'srv3', 'txt', 'json3']) {
    const r = S.convert(json3, 'json3', fmt, { lang: 'en' });
    assert.equal(r.ext, fmt);
    assert.equal(r.mime, S.mimeFor(fmt));
    assert.ok(r.text.length > 100, fmt);
    assert.ok(r.cues > 0);
  }
  assert.equal(S.convert(vtt, 'vtt', 'vtt').text, vtt, 'native VTT is passed through unchanged');
  assert.notEqual(S.convert(vtt, 'vtt', 'vtt', { normalize: true }).text, vtt, 'normalize rebuilds');
  assert.equal(S.convert(json3, 'json3', 'webvtt').ext, 'vtt', 'format aliases');
  assert.equal(S.convert(vtt, 'json3', 'srt').ext, 'srt', 'body is sniffed when the declared format is wrong');
  assert.throws(() => S.convert(JSON.stringify({ events: [{ tStartMs: 0 }] }), 'json3', 'srt'), (e) => e.code === 'empty');
  assert.throws(() => S.convert('{"events": [', 'json3', 'srt'), (e) => e.code === 'parse');
  assert.throws(() => S.convert(json3, 'json3', 'docx'), (e) => e.code === 'format');
  assert.throws(() => S.convert('just some words', 'mystery', 'srt'), (e) => e.code === 'format');
  assert.deepEqual(plain(S.parse('', 'json3')), []);
});

/* ------------------------------------------------------------------ subtitles panel: language names */

/**
 * Loads the content-script stack the subtitles panel needs (AYT.dl from video.js, AYT.media from thumbnail.js)
 * into a vm context. `pageLang` is YouTube's UI language (<html lang>), which YouTube's own names follow.
 */
function loadCaptionsPanel(pageLang) {
  const EXT = path.join(ROOT, 'extension');
  const ctx = { console, Intl, URL, URLSearchParams, TextEncoder, TextDecoder, setTimeout, clearTimeout, atob, btoa };
  ctx.globalThis = ctx;
  ctx.document = { documentElement: { lang: pageLang } };
  ctx.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
    runtime: { id: 'test', onMessage: { addListener() {} } },
  };
  vm.createContext(ctx);
  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(EXT, rel), 'utf8'), ctx, { filename: rel });
  for (const f of ['shared/constants.js', 'shared/utils.js', 'shared/i18n.js', 'shared/i18n/en.js', 'shared/i18n/tr.js', 'shared/settings.js', 'shared/dom.js', 'shared/ui-styles.js', 'shared/ui.js', 'shared/client.js', 'shared/subtitles.js', 'content/video-info.js']) load(f);
  vm.runInContext(
    `AYT.page = { videoId: 'KrLj6nc516A', listId: null, type: 'watch', info: { type: 'watch', videoId: 'KrLj6nc516A' }, isWatch: () => true, isShorts: () => false, onChange: () => () => {} };
     AYT.player = { currentTime: () => 0, duration: () => 0, isAdPlaying: () => false, video: () => null };
     AYT.bridge = { request: async () => null, on: () => () => {} };
     AYT.toolbar = { defs: [], register(d) { this.defs.push(d); }, open() {}, isOpen: () => false, refresh() {}, host: null };`,
    ctx
  );
  for (const f of ['content/panels/video.js', 'content/panels/thumbnail.js', 'content/panels/subtitles.js']) load(f);
  const AYT = ctx.AYT;
  const info = AYT.videoInfo.normalize(JSON.parse(fixture('KrLj6nc516A.json')));
  return { AYT, info };
}

test('subtitles panel: language names follow the extension language, not YouTube\'s', () => {
  const { AYT, info } = loadCaptionsPanel('en'); // YouTube in English…
  AYT.i18n.setLanguage('tr'); // …extension in Turkish
  const C = AYT.captions;
  const tracks = info.captions.tracks;
  const en = tracks.find((tr) => tr.lang === 'en' && !tr.isAuto);
  const auto = tracks.find((tr) => tr.isAuto);
  assert.equal(C.trackLabel(en), 'İngilizce');
  assert.equal(C.trackLabel(tracks.find((tr) => tr.lang === 'ar')), 'Arapça');
  assert.equal(C.trackLabel(tracks.find((tr) => tr.lang === 'zh-Hans')), 'Basitleştirilmiş Çince', 'YouTube writes "Chinese (Simplified)"');
  assert.ok(C.trackLabel(auto).startsWith(C.GEAR + ' İngilizce'), C.trackLabel(auto));
  assert.equal(C.baseName({ lang: 'en', name: 'English - CC', isAuto: false }), 'English - CC', "an uploader's own track title is kept");
  assert.equal(C.baseName({ lang: 'en', name: '', isAuto: false }), 'İngilizce');

  const opts = plain(C.translationOptions(info, en));
  assert.equal(opts.length, info.captions.translationLanguages.length - 1, "the track's own language is left out");
  assert.deepEqual(opts[0], { lang: 'tr', name: 'Türkçe' }, 'UI language first, in its own name');
  assert.ok(!opts.some((o) => o.lang === 'en'));
  const byLang = Object.fromEntries(opts.map((o) => [o.lang, o.name]));
  assert.equal(byLang.de, 'Almanca');
  assert.equal(byLang.ar, 'Arapça');
  const rest = opts.slice(1).map((o) => o.name);
  const coll = new Intl.Collator('tr');
  assert.deepEqual(rest, [...rest].sort(coll.compare), 'alphabetical in Turkish');
  assert.equal(C.translationName(info, 'de'), 'Almanca');
  assert.equal(C.translationName(info, 'xx-Unknown'), 'xx-Unknown', 'unknown codes fall back to the code');
});

test("subtitles panel: YouTube's own names are kept when YouTube and the extension use the same language", () => {
  const { AYT, info } = loadCaptionsPanel('en');
  AYT.i18n.setLanguage('en');
  const C = AYT.captions;
  const tracks = info.captions.tracks;
  assert.equal(C.trackLabel(tracks.find((tr) => tr.lang === 'zh-Hans')), 'Chinese (Simplified)');
  assert.equal(C.trackLabel(tracks.find((tr) => tr.lang === 'bn')), 'Bangla');
  const opts = plain(C.translationOptions(info, tracks.find((tr) => tr.lang === 'tr')));
  const yt = Object.fromEntries(info.captions.translationLanguages.map((l) => [l.lang, l.name]));
  for (const o of opts) assert.equal(o.name, yt[o.lang], o.lang);
  assert.equal(opts[0].lang, 'en', 'UI language first');
});

test('subtitles panel: caption errors get friendly texts, an ad gets its own', () => {
  const { AYT } = loadCaptionsPanel('en');
  AYT.i18n.setLanguage('en');
  const C = AYT.captions;
  // main-world.js rejects with code 'ad' while an ad plays (its caption request would be the ad's)
  const ad = Object.assign(new Error('An ad is playing. Try again when the video continues.'), { code: 'ad' });
  assert.equal(C.errorText(ad), "Subtitles can't be loaded while an ad is playing. Try again when the video continues.");
  assert.match(C.errorText({ code: 'no_token' }), /allow access/);
  assert.equal(C.errorText(Object.assign(new Error('x'), { code: 'invalidated' })), AYT.t('toolbar.invalidated'));
  assert.equal(C.errorText(new Error('Something odd')), 'Something odd', 'unknown errors keep their message');
});

/* ------------------------------------------------------------------ subtitles panel: download again after an ad */

/**
 * Renders the REAL subtitles panel against tiny stubs and a virtual clock, clicks Download while an ad plays and
 * replays an ad timeline (`ads`: [start, end) in seconds after the click). fetchCaptions follows main-world.js:
 * code 'ad' at once while an ad shows; 'ad' at the next token attempt (4.25 s later) when an ad starts before the
 * token arrives (`potMs` after the call); otherwise the captions.
 * Returns { fetches, downloadAt, status, pendingTimers } (times in seconds after the click).
 */
async function adRetryRun(ads, potMs = 800) {
  const T0 = 1.8e12;
  let now = T0;
  const timers = new Map();
  let nextId = 1;
  const addTimer = (fn, ms, every) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + Math.max(every ? 1 : 0, ms | 0), every: every ? Math.max(1, ms | 0) : 0 });
    return id;
  };
  const sec = () => (now - T0) / 1000;
  const adAt = (s) => ads.some(([a, b]) => s >= a && s < b);
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  async function runUntil(s) {
    const end = T0 + s * 1000;
    for (;;) {
      let next = null;
      for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      if (timer.every) timer.at += timer.every;
      else timers.delete(id);
      timer.fn();
      await settle();
    }
    now = end;
  }

  const fetches = [];
  let downloadAt = null;
  let status = '';
  const defs = [];
  const buttons = [];
  const node = () => {
    const n = { children: [], disabled: false, classList: { toggle() {}, add() {}, remove() {} } };
    n.append = (...c) => n.children.push(...c);
    n.appendChild = (c) => (n.children.push(c), c);
    n.querySelector = () => null;
    return n;
  };
  const adError = () => Object.assign(new Error('An ad is playing.'), { code: 'ad' });
  const info = { title: 'Video', captions: { tracks: [{ lang: 'en', name: 'English', isAuto: false, kind: '', vssId: '.en', isTranslatable: false }], translationLanguages: [] } };
  const AYT = {
    t: (k) => k,
    util: { watchUrl: (id) => 'https://www.youtube.com/watch?v=' + id },
    dom: { h: () => node(), icon: () => node(), clear: (x) => (x.children.length = 0) },
    ui: {
      addStyles() {},
      spinner: node,
      notice: node,
      hostNotice: node,
      field: node,
      select: (o) => ({ el: node(), value: o.value != null ? o.value : '', disabled: false, setOptions(_, v) { this.value = v; } }),
      radioList: (o) => ({ el: node(), value: o.value }),
      button: (o) => {
        const b = Object.assign(node(), { opts: o });
        buttons.push(b);
        return b;
      },
      jobList: () => ({ el: node(), destroy() {} }),
    },
    media: {
      withTimeout: (p) => p,
      errorText: (e) => String(e && e.message),
      codedError: (m, code) => Object.assign(new Error(m), { code }),
      statusLine: () => ({ el: node(), clear: () => (status = ''), busy: (x) => (status = x), success: (x) => (status = x), error: (x) => (status = x) }),
      fileInfo: async () => ({ title: 'Video' }),
      filename: (_, ext, suffix) => `Video (${suffix}).${ext}`,
      saveText: async () => {
        downloadAt = sec();
        return { via: 'test' };
      },
      copyText: async () => {},
    },
    subtitles: { FORMATS: ['srt', 'vtt', 'ttml', 'srv3', 'txt'], sourceFormat: () => 'json3', convert: (_, __, format) => ({ text: 'x', mime: 'text/plain', ext: format, cues: 1 }) },
    settings: { get: (k) => (k === 'subtitleFormat' ? 'srt' : null), set: async () => {}, onChange: () => () => {} },
    i18n: { language: 'en', onChange: () => () => {} },
    videoInfo: {
      blockReason: () => null,
      fetchCaptions() {
        const at = sec();
        fetches.push(at);
        if (adAt(at)) return Promise.reject(adError());
        const adFirst = ads.some(([a]) => a > at && a <= at + potMs / 1000);
        return new Promise((resolve, reject) => {
          if (adFirst) addTimer(() => reject(adError()), 4250);
          else addTimer(() => resolve({ body: '{"events":[]}', fmt: 'json3' }), potMs);
        });
      },
    },
    client: { host: { status: { state: 'connected' }, refresh: async () => ({ state: 'connected' }) }, jobs: { start: async () => 'job', active: () => [] } },
    player: { isAdPlaying: () => adAt(sec()) },
    toolbar: { register: (d) => defs.push(d) },
    page: { videoId: 'KrLj6nc516A' },
  };
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const ctx = vm.createContext({
    AYT,
    console,
    document: { documentElement: { lang: 'en' } },
    Date: FakeDate,
    setTimeout: (fn, ms) => addTimer(fn, ms, false),
    setInterval: (fn, ms) => addTimer(fn, ms, true),
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension', 'content', 'panels', 'subtitles.js'), 'utf8'), ctx, { filename: 'subtitles.js' });
  const panel = defs.find((d) => d.id === 'subtitles').panel.render({ videoId: 'KrLj6nc516A', getInfo: async () => info, close() {} });
  await settle();
  buttons.find((b) => b.opts.variant === 'primary').opts.onClick(); // Download, during the ad
  await settle();
  await runUntil(700);
  const pendingTimers = timers.size;
  panel.destroy();
  return { fetches, downloadAt, status, pendingTimers };
}

test('subtitles panel: after an ad it downloads again by itself, at most 3 times and only within 3 minutes of the click', async () => {
  // A normal pre-roll: one retry 1.5 s after it ends, which downloads.
  const preroll = await adRetryRun([[-5, 25]]);
  assert.deepEqual(preroll.fetches, [0, 26.5]);
  assert.equal(preroll.downloadAt, 27.3);
  assert.equal(preroll.status, 'media.downloadStarted');

  // Every retry runs into the next long ad. The 3 minutes count from the click, not from each wait: no retry
  // starts near the 6- and 9-minute marks.
  const longAds = await adRetryRun([[-20, 178], [180, 357], [359, 536]]);
  assert.deepEqual(longAds.fetches, [0, 179.5], 'the only retry starts within 3 minutes of the click');
  assert.equal(longAds.downloadAt, null);
  assert.equal(longAds.status, 'subtitles.err.ad', 'the ad notice stays');
  assert.equal(longAds.pendingTimers, 0, 'the wait stopped');

  // Short ads with 2 s gaps, each retry runs into the next one: three retries, then the panel gives up.
  const shortAds = await adRetryRun([[-5, 20], [22, 40], [42, 60], [62, 80]]);
  assert.deepEqual(shortAds.fetches, [0, 21.5, 41.75, 61.5]);
  assert.equal(shortAds.downloadAt, null);
  assert.equal(shortAds.status, 'subtitles.err.ad');
  assert.equal(shortAds.pendingTimers, 0);

  // One ad longer than 3 minutes: no retry at all.
  const longOne = await adRetryRun([[-20, 200]]);
  assert.deepEqual(longOne.fetches, [0]);
  assert.equal(longOne.downloadAt, null);
});

test('every t() key used by the MEDIA panels exists in English; en.media.json is sorted and fully used', () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'en.json'), 'utf8'));
  const part = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'parts', 'en.media.json'), 'utf8'));
  const keys = Object.keys(part);
  assert.deepEqual(keys, [...keys].sort(), 'en.media.json keys are sorted');
  const used = new Set();
  for (const f of ['thumbnail', 'subtitles', 'screenshot']) {
    const src = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'panels', f + '.js'), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)) used.add(m[1]);
  }
  for (const k of used) assert.ok(k in en, 'missing i18n key ' + k);
  for (const k of keys) {
    assert.ok(used.has(k), 'unused key ' + k);
    assert.equal(en[k], part[k], 'merged into i18n/en.json: ' + k);
  }
});
