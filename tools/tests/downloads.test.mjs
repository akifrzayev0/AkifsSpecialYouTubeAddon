#!/usr/bin/env node
/*
 * Unit tests for the DOWNLOADS module's pure logic (AYT.dl in extension/content/panels/video.js + audio.js).
 *   node --test tools/tests/downloads.test.mjs        (or: node tools/tests/downloads.test.mjs)
 *
 * The real classic scripts are loaded into a vm context (shared/* + content/video-info.js + the two panels);
 * page-bound foundation modules (toolbar, page, player, bridge) are replaced by tiny stubs. Formats come from
 * REAL player responses captured with tools/e2e/downloads.e2e.mjs --capture (tools/tests/fixtures/*.json) and are
 * run through the real AYT.videoInfo.normalize.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = path.join(ROOT, 'extension');
const FIX = path.join(ROOT, 'tools', 'tests', 'fixtures');

function createContext() {
  const ctx = {
    console,
    atob,
    btoa,
    Intl,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  ctx.globalThis = ctx;
  ctx.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
    runtime: { id: 'test', onMessage: { addListener() {} } },
  };
  vm.createContext(ctx);
  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(EXT, rel), 'utf8'), ctx, { filename: rel });
  for (const f of ['shared/constants.js', 'shared/utils.js', 'shared/i18n.js', 'shared/i18n/en.js', 'shared/settings.js', 'shared/dom.js', 'shared/ui-styles.js', 'shared/ui.js', 'shared/client.js', 'content/video-info.js']) load(f);
  vm.runInContext(
    `AYT.page = { videoId: '1La4QzGeaaQ', listId: null, type: 'watch', info: { type: 'watch', videoId: '1La4QzGeaaQ' }, isWatch: () => true, isShorts: () => false, onChange: () => () => {} };
     AYT.player = { currentTime: () => 61.4, duration: () => 338, isAdPlaying: () => false, video: () => null };
     AYT.bridge = { request: async () => null, on: () => () => {} };
     AYT.toolbar = { defs: [], register(d) { this.defs.push(d); }, open() {}, isOpen: () => false, refresh() {}, host: null };`,
    ctx
  );
  load('content/panels/video.js');
  load('content/panels/audio.js');
  return ctx;
}

const ctx = createContext();
const AYT = ctx.AYT;
const DL = AYT.dl;
const fixture = (id) => JSON.parse(fs.readFileSync(path.join(FIX, id + '.json'), 'utf8'));
const info8k = AYT.videoInfo.normalize(fixture('1La4QzGeaaQ'));
const infoDub = AYT.videoInfo.normalize(fixture('KrLj6nc516A'));
// plain copies (objects created inside the vm have another Object.prototype, which deepStrictEqual rejects)
const plain = (x) => JSON.parse(JSON.stringify(x));
const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.key, r]));

/* ------------------------------------------------------------------ module wiring */
test('both panels register with the toolbar as specified', () => {
  const defs = Object.fromEntries(AYT.toolbar.defs.map((d) => [d.id, d]));
  assert.ok(defs.video && defs.audio, 'video + audio registered');
  assert.equal(defs.video.group, 'download');
  assert.equal(defs.video.order, 10);
  assert.equal(defs.video.panel.width, 480);
  assert.deepEqual(plain(defs.video.surfaces), ['watch', 'shorts']);
  assert.equal(typeof defs.video.commands['open-download'], 'function');
  assert.equal(typeof defs.video.progress, 'function');
  assert.equal(typeof defs.video.badge, 'function');
  assert.equal(defs.audio.group, 'download');
  assert.equal(defs.audio.order, 20);
  assert.equal(defs.audio.panel.width, 460);
  assert.deepEqual(plain(defs.audio.surfaces), ['watch', 'shorts']);
  assert.equal(defs.video.panelTitle(), 'Download video');
  assert.equal(defs.audio.panelTitle(), 'Download audio');
});

/* ------------------------------------------------------------------ codec preference (§8.4) */
test('codec preference follows the host (DEVELOPER-SPEC §8.4)', () => {
  assert.deepEqual(plain(DL.codecOrder('mp4', 'auto')), ['av1', 'h264', 'vp9']);
  assert.deepEqual(plain(DL.codecOrder('mp4', 'compat')), ['h264', 'av1', 'vp9']);
  assert.deepEqual(plain(DL.codecOrder('webm', 'auto')), ['vp9', 'av1']);
  assert.deepEqual(plain(DL.codecOrder('webm', 'compat')), ['vp9', 'av1']);
  assert.deepEqual(plain(DL.codecOrder('mkv', 'auto')), ['av1', 'vp9', 'h264']);
  assert.deepEqual(plain(DL.codecOrder('mkv', 'compat')), ['h264', 'av1', 'vp9']);
  assert.deepEqual(plain(DL.codecOrder('bogus', 'x')), ['av1', 'h264', 'vp9'], 'unknown values fall back to mp4 + auto');
  assert.equal(DL.containerAccepts('webm', 'h264'), false);
  assert.equal(DL.containerAccepts('webm', 'av1'), true);
  assert.equal(DL.containerAccepts('mp4', 'vp9'), true);
  assert.equal(DL.containerAccepts('mkv', 'whatever'), true);
  assert.equal(DL.audioCodecFor('mp4', 'auto'), 'aac');
  assert.equal(DL.audioCodecFor('mp4', 'compat'), 'aac');
  assert.equal(DL.audioCodecFor('mkv', 'compat'), 'aac');
  assert.equal(DL.audioCodecFor('mkv', 'auto'), 'opus');
  assert.equal(DL.audioCodecFor('webm', 'auto'), 'opus');
});

/* ------------------------------------------------------------------ 8K HDR video (1La4QzGeaaQ) */
test('fixture 1La4QzGeaaQ normalizes as expected', () => {
  assert.equal(info8k.videoId, '1La4QzGeaaQ');
  assert.ok(info8k.duration > 300);
  assert.equal(info8k.drm, false);
  assert.equal(AYT.videoInfo.blockReason(info8k), null);
  assert.ok(info8k.videoFormats.some((f) => f.itag === 702 && f.res === 4320 && f.hdr && f.codec === 'av1'));
});

test('8K video: one row per (res, fps>30, hdr) group, best first (MP4 + best quality)', () => {
  const rows = DL.buildVideoOptions(info8k, { container: 'mp4', codec: 'auto' });
  assert.deepEqual(
    plain(rows.map((r) => r.key)),
    ['4320|1|1', '2160|1|1', '2160|1|0', '1440|1|1', '1440|1|0', '1080|1|1', '1080|1|0', '720|1|1', '720|1|0', '720|0|0', '480|1|1', '480|0|0', '360|1|1', '360|0|0', '240|1|1', '240|0|0', '144|1|1', '144|0|0']
  );
  const top = rows[0];
  assert.equal(top.label, '4320p60');
  assert.equal(top.itag, 702);
  assert.equal(top.codec, 'av1');
  assert.equal(top.height, 4320);
  assert.equal(top.width, 7680);
  assert.equal(top.fps, 60);
  assert.equal(top.hdr, true);
  assert.deepEqual(plain(top.badges), [
    { text: '8K', variant: 'accent' },
    { text: 'HDR', variant: 'hdr' },
    { text: '60FPS', variant: null },
  ]);
  // video (contentLength of itag 702) + best non-DRC AAC (itag 140) = exact, not approximate
  assert.equal(top.videoSize, 2148689026);
  assert.equal(top.audio.codec, 'aac');
  assert.equal(top.audioSize, top.audio.size);
  assert.equal(top.size, top.videoSize + top.audioSize);
  assert.equal(top.sizeApprox, false);
  assert.equal(DL.formatSize(top.size, top.sizeApprox), '2.01 GB');

  const k = byKey(rows);
  assert.equal(k['2160|1|1'].codec, 'av1', '2160p60 HDR: AV1 (701) preferred in MP4');
  assert.equal(k['2160|1|1'].itag, 701);
  assert.equal(k['2160|1|0'].codec, 'vp9', '2160p60 SDR only exists as VP9 (315)');
  assert.equal(k['2160|1|0'].itag, 315);
  assert.equal(k['1080|1|0'].codec, 'h264', '1080p60 SDR: no SDR AV1 -> H.264 (299)');
  assert.equal(k['1080|1|0'].itag, 299);
  assert.equal(k['360|0|0'].muxed, false, 'adaptive formats win over the muxed itag 18');
  assert.equal(k['720|1|1'].label, '720p60');
  assert.equal(k['720|0|0'].label, '720p');
  assert.deepEqual(plain(k['720|0|0'].badges), [{ text: 'HD', variant: null }]);
  assert.deepEqual(plain(k['1440|1|0'].badges.map((b) => b.text)), ['2K', '60FPS']);
  assert.deepEqual(plain(k['480|0|0'].badges), []);
  for (const r of rows) assert.equal(r.size, r.videoSize + r.audioSize, 'size = video + audio for ' + r.key);
});

test('8K video: "most compatible" prefers H.264, then AV1, then VP9', () => {
  const k = byKey(DL.buildVideoOptions(info8k, { container: 'mp4', codec: 'compat' }));
  assert.equal(k['1080|1|0'].codec, 'h264');
  assert.equal(k['2160|1|1'].codec, 'av1', 'no H.264 at 2160p -> AV1');
  assert.equal(k['2160|1|0'].codec, 'vp9');
  assert.equal(k['4320|1|1'].codec, 'av1');
});

test('8K video: WebM uses VP9 first, keeps AV1-only 8K, Opus audio', () => {
  const rows = DL.buildVideoOptions(info8k, { container: 'webm', codec: 'auto' });
  const k = byKey(rows);
  assert.equal(rows.length, 18);
  assert.equal(k['4320|1|1'].codec, 'av1', '8K exists only as AV1, which WebM can hold');
  assert.equal(k['2160|1|1'].codec, 'vp9');
  assert.equal(k['2160|1|1'].itag, 337);
  assert.equal(k['1080|1|0'].codec, 'vp9');
  assert.equal(k['1080|1|0'].itag, 303);
  assert.ok(rows.every((r) => r.codec !== 'h264'), 'never H.264 in WebM');
  assert.ok(rows.every((r) => r.audio.codec === 'opus'));
  assert.ok(k['1080|1|0'].size < byKey(DL.buildVideoOptions(info8k, { container: 'mp4', codec: 'auto' }))['1080|1|0'].size, 'VP9 1080p60 is smaller than H.264');
});

test('8K video: MKV follows av1, vp9, h264 (auto) and h264 first (compat) with the right audio', () => {
  const auto = byKey(DL.buildVideoOptions(info8k, { container: 'mkv', codec: 'auto' }));
  assert.equal(auto['2160|1|1'].codec, 'av1');
  assert.equal(auto['1080|1|0'].codec, 'vp9', 'mkv + auto: no SDR AV1 -> VP9 before H.264');
  assert.equal(auto['1080|1|0'].audio.codec, 'opus');
  const compat = byKey(DL.buildVideoOptions(info8k, { container: 'mkv', codec: 'compat' }));
  assert.equal(compat['1080|1|0'].codec, 'h264');
  assert.equal(compat['1080|1|0'].audio.codec, 'aac');
});

test('pickAudio prefers non-DRC streams with the highest bitrate', () => {
  const aac = DL.pickAudio(info8k, { codec: 'aac' });
  assert.equal(aac.itag, 140);
  assert.equal(aac.isDrc, false);
  const opus = DL.pickAudio(info8k, { codec: 'opus' });
  assert.equal(opus.itag, 251);
  assert.equal(opus.isDrc, false);
  const best = Math.max(...info8k.audioFormats.filter((a) => a.codec === 'opus' && !a.isDrc).map((a) => a.bitrate));
  assert.equal(opus.bitrate, best);
  assert.equal(DL.pickAudio({ audioFormats: [] }, { codec: 'aac' }), null);
});

/* ------------------------------------------------------------------ dubbed video (KrLj6nc516A) */
test('dubbed video: 26 audio tracks, original first and labelled', () => {
  const tracks = DL.trackOptions(infoDub);
  assert.equal(tracks.length, 26);
  assert.equal(tracks[0].value, 'en.4');
  assert.equal(tracks[0].isOriginal, true);
  assert.equal(tracks[0].label, 'English (original)');
  const tr = tracks.find((x) => x.value === 'tr.3');
  assert.equal(tr.label, 'Turkish');
  assert.equal(tr.lang, 'tr');
  assert.ok(tracks.some((x) => x.lang === 'zh-Hans'));
  const rest = plain(tracks.slice(1).map((x) => x.name));
  assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b, 'en')), 'dubs sorted by name');
  assert.equal(new Set(tracks.map((x) => x.value)).size, 26, 'no duplicate tracks');
  assert.deepEqual(plain(DL.trackOptions(info8k)), [], 'single-track videos show no select');
});

test('dubbed video: audio follows the chosen language (size estimate + task)', () => {
  const trAac = DL.pickAudio(infoDub, { codec: 'aac', trackId: 'tr.3', lang: 'tr' });
  assert.equal(trAac.itag, 140);
  assert.equal(trAac.lang, 'tr');
  const enOpus = DL.pickAudio(infoDub, { codec: 'opus' });
  assert.equal(enOpus.trackId, 'en.4', 'no language = original track');
  assert.equal(enOpus.isDrc, false);
  const zh = DL.pickAudio(infoDub, { codec: 'aac', lang: 'zh-Hans' });
  assert.equal(zh.lang, 'zh-Hans');

  const rows = DL.buildVideoOptions(infoDub, { container: 'mp4', codec: 'auto', trackId: 'tr.3', audioLang: 'tr' });
  assert.equal(rows[0].label, '1080p');
  assert.equal(rows[0].codec, 'av1');
  assert.equal(rows[0].itag, 399);
  assert.equal(rows[0].audio.size, trAac.size);
  assert.deepEqual(plain(rows.map((r) => r.res)), [1080, 720, 480, 360, 240, 144]);

  const task = DL.videoTask('KrLj6nc516A', rows[0], { container: 'mp4', codec: 'auto', audioLang: 'tr' });
  assert.equal(task.audioLang, 'tr');
  assert.equal(DL.videoLabel(rows[0], { container: 'mp4', langName: 'Turkish' }), 'MP4 · 1080p · Turkish');
});

/* ------------------------------------------------------------------ sections */
test('sections: whole video = null, ranges rounded, labels like ✂ 01:00–02:30', () => {
  assert.equal(DL.normalizeSection(338, 0, 338), null);
  assert.equal(DL.normalizeSection(338, 0.2, 337.8), null);
  assert.equal(DL.normalizeSection(338, -5, 400), null, 'clamped to the whole video');
  assert.equal(DL.normalizeSection(338, 10, 10.5), null, 'shorter than 1 s');
  assert.equal(DL.normalizeSection(0, 1, 2), null);
  assert.equal(DL.normalizeSection(338, NaN, 20), null);
  assert.deepEqual(plain(DL.normalizeSection(338, 60, 150)), { start: 60, end: 150 });
  assert.deepEqual(plain(DL.normalizeSection(338, 1.23456, 9.87654)), { start: 1.235, end: 9.877 });
  assert.equal(DL.sectionLabel({ start: 60, end: 150 }, 338), '✂ 01:00–02:30');
  assert.equal(DL.sectionLabel({ start: 60, end: 150 }, 4000), '✂ 0:01:00–0:02:30');
  assert.equal(DL.sectionLabel(null, 338), '');
  assert.equal(DL.shortClock(3725), '1:02:05');
  assert.equal(DL.scaleSize(1000, { start: 0, end: 50 }, 100), 500);
  assert.equal(DL.scaleSize(1000, null, 100), 1000);
});

/* ------------------------------------------------------------------ tasks + meta */
test('video task + meta for the 8K HDR row match DEVELOPER-SPEC §8.3/§9.1', () => {
  const top = DL.buildVideoOptions(info8k, { container: 'mp4', codec: 'auto' })[0];
  assert.deepEqual(plain(DL.videoTask('1La4QzGeaaQ', top, { container: 'mp4', codec: 'auto' })), {
    kind: 'video',
    videoId: '1La4QzGeaaQ',
    url: 'https://www.youtube.com/watch?v=1La4QzGeaaQ',
    playlist: false,
    height: 4320,
    width: 7680,
    hdr: true,
    fps: 60,
    container: 'mp4',
    codec: 'auto',
    audioLang: null,
    section: null,
    preciseCut: false,
  });
  const clip = DL.videoTask('1La4QzGeaaQ', top, { container: 'mkv', codec: 'compat', section: { start: 60, end: 150 }, preciseCut: true });
  assert.deepEqual(plain(clip.section), { start: 60, end: 150 });
  assert.equal(clip.preciseCut, true);
  assert.equal(clip.container, 'mkv');
  assert.equal(clip.codec, 'compat');
  assert.equal(DL.videoLabel(top, { container: 'mp4' }), 'MP4 · 4320p60 · HDR');
  assert.equal(DL.videoLabel(top, { container: 'mp4', section: { start: 60, end: 150 }, duration: 338 }), 'MP4 · 4320p60 · HDR · ✂ 01:00–02:30');
  const sdr = byKey(DL.buildVideoOptions(info8k, { container: 'mp4', codec: 'auto' }))['2160|1|0'];
  const sdrTask = DL.videoTask('1La4QzGeaaQ', sdr, { container: 'mp4' });
  assert.equal(sdrTask.hdr, false, 'SDR rows ask explicitly for SDR');
  assert.equal(sdrTask.height, 2160);
  assert.deepEqual(plain(DL.videoMeta('1La4QzGeaaQ', 'Peru 8K', 'MP4 · 4320p60 · HDR')), {
    title: 'Peru 8K',
    videoId: '1La4QzGeaaQ',
    thumbnail: 'https://i.ytimg.com/vi/1La4QzGeaaQ/mqdefault.jpg',
    label: 'MP4 · 4320p60 · HDR',
  });
});

test('playlist tasks use the playlist URL, never a section; mixes are not playlists', () => {
  const top = DL.buildVideoOptions(info8k, { container: 'mp4' })[0];
  const pl = DL.videoTask('1La4QzGeaaQ', top, { playlistId: 'PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu', section: { start: 1, end: 5 }, preciseCut: true });
  assert.equal(pl.playlist, true);
  assert.equal(pl.url, 'https://www.youtube.com/playlist?list=PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu');
  assert.equal(pl.section, null);
  assert.equal(pl.preciseCut, false);
  assert.equal(DL.videoLabel(top, { container: 'mp4', playlistId: 'PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu' }), 'MP4 · 4320p60 · HDR · Playlist');
  const mix = DL.videoTask('1La4QzGeaaQ', top, { playlistId: 'RD1La4QzGeaaQ' });
  assert.equal(mix.playlist, false);
  assert.equal(mix.url, 'https://www.youtube.com/watch?v=1La4QzGeaaQ');
  assert.equal(DL.playlistOk('PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu'), true);
  assert.equal(DL.playlistOk('RDabc1234567'), false);
  assert.equal(DL.playlistOk('bad id!'), false);
});

test('"best available" fallback row (page listed no formats) asks the host for the best quality', () => {
  const best = DL.bestOption('mkv');
  const task = DL.videoTask('1La4QzGeaaQ', best, { container: 'mkv', codec: 'auto' });
  assert.equal(task.height, null);
  assert.equal(task.width, null);
  assert.equal(task.hdr, null, 'no SDR/HDR filter');
  assert.equal(task.fps, null);
  assert.equal(task.container, 'mkv');
  assert.equal(DL.videoLabel(best, { container: 'mkv' }), 'MKV · Best available');
  assert.deepEqual(plain(DL.buildVideoOptions({ videoFormats: [], audioFormats: [] }, {})), []);
});

test('every task the panels build passes the service worker validator (background/task.js)', (t) => {
  const taskJs = path.join(EXT, 'background', 'task.js');
  if (!fs.existsSync(taskJs)) return t.skip('background/task.js not written yet');
  vm.runInContext(fs.readFileSync(taskJs, 'utf8'), ctx, { filename: 'background/task.js' });
  const V = AYT.task.validate;
  const rows = DL.buildVideoOptions(info8k, { container: 'mp4', codec: 'auto' });
  const dubRows = DL.buildVideoOptions(infoDub, { container: 'webm', codec: 'auto', trackId: 'zh-Hans.3', audioLang: 'zh-Hans' });
  const tasks = [
    ...rows.map((r) => DL.videoTask('1La4QzGeaaQ', r, { container: 'mp4', codec: 'auto' })),
    DL.videoTask('KrLj6nc516A', dubRows[0], { container: 'webm', codec: 'compat', audioLang: 'zh-Hans', section: { start: 12.345, end: 99.5 }, preciseCut: true }),
    DL.videoTask('1La4QzGeaaQ', rows[0], { container: 'mkv', playlistId: 'PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu' }),
    DL.videoTask('1La4QzGeaaQ', DL.bestOption('mp4'), { container: 'mp4' }),
    DL.gifTask('1La4QzGeaaQ', { start: 0, end: 60 }),
    DL.gifTask('1La4QzGeaaQ', { start: 120, end: 132.5 }),
    ...DL.AUDIO_FORMATS.map((f) => DL.audioTask('KrLj6nc516A', { format: f, bitrate: 320, audioLang: 'tr', section: { start: 30, end: 105 }, embedThumbnail: true, embedMetadata: false })),
    DL.audioTask('1La4QzGeaaQ', { format: 'mp3', bitrate: 64, playlistId: 'PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu' }),
  ];
  for (const task of tasks) {
    const clean = V(task);
    for (const k of ['kind', 'videoId', 'url', 'playlist', 'height', 'width', 'hdr', 'fps', 'container', 'codec', 'audioLang', 'section', 'preciseCut', 'audioFormat', 'bitrate', 'gifWidth', 'gifFps', 'embedThumbnail', 'embedMetadata']) {
      if (k in task) assert.deepEqual(plain(clean[k]), plain(task[k]), `${task.kind} field ${k} survives validation unchanged`);
    }
    assert.ok(AYT.task.validateMeta(DL.videoMeta(task.videoId, 'Title', 'Label'), clean).thumbnail.startsWith('https://i.ytimg.com/'));
  }
});

test('invalid video ids are rejected before a task is built', () => {
  const top = DL.buildVideoOptions(info8k, {})[0];
  assert.throws(() => DL.videoTask('x', top, {}), /No video/);
  assert.throws(() => DL.videoTask('1La4QzGeaaQ"', top, {}));
  assert.throws(() => DL.audioTask('', {}));
  assert.throws(() => DL.gifTask('../../etc', { start: 0, end: 5 }));
});

test('GIF tasks need a section of at most 60 s', () => {
  assert.deepEqual(plain(DL.gifTask('1La4QzGeaaQ', { start: 60, end: 75 })), {
    kind: 'gif',
    videoId: '1La4QzGeaaQ',
    url: 'https://www.youtube.com/watch?v=1La4QzGeaaQ',
    playlist: false,
    section: { start: 60, end: 75 },
    gifWidth: 480,
    gifFps: 15,
  });
  assert.throws(() => DL.gifTask('1La4QzGeaaQ', { start: 0, end: 61 }), /60 seconds/);
  assert.throws(() => DL.gifTask('1La4QzGeaaQ', null));
  assert.equal(DL.gifLabel({ start: 60, end: 75 }, 338), 'GIF · 480px · ✂ 01:00–01:15');
});

test('audio tasks + labels', () => {
  assert.deepEqual(plain(DL.audioTask('1La4QzGeaaQ', { format: 'mp3', bitrate: 192, embedThumbnail: true, embedMetadata: true })), {
    kind: 'audio',
    videoId: '1La4QzGeaaQ',
    url: 'https://www.youtube.com/watch?v=1La4QzGeaaQ',
    playlist: false,
    audioFormat: 'mp3',
    bitrate: 192,
    audioLang: null,
    section: null,
    embedThumbnail: true,
    embedMetadata: true,
  });
  const wav = DL.audioTask('1La4QzGeaaQ', { format: 'wav', bitrate: 320, embedThumbnail: true, section: { start: 30, end: 105 }, audioLang: 'tr' });
  assert.equal(wav.embedThumbnail, false, 'WAV can never embed cover art (yt-dlp fails)');
  assert.deepEqual(plain(wav.section), { start: 30, end: 105 });
  assert.equal(wav.audioLang, 'tr');
  assert.equal(DL.audioTask('1La4QzGeaaQ', { format: 'ogg', bitrate: 999 }).audioFormat, 'mp3');
  assert.equal(DL.audioTask('1La4QzGeaaQ', { format: 'mp3', bitrate: 999 }).bitrate, 192, 'unknown bitrates fall back to the recommended one');
  assert.equal(DL.audioTask('1La4QzGeaaQ', { format: 'mp3', bitrate: '320' }).bitrate, 320);
  assert.equal(DL.audioLabel({ format: 'mp3', bitrate: 192 }), 'MP3 · 192 kbps');
  assert.equal(DL.audioLabel({ format: 'flac', bitrate: 192 }), 'FLAC');
  assert.equal(DL.audioLabel({ format: 'mp3', bitrate: 320, section: { start: 30, end: 105 }, duration: 338 }), 'MP3 · 320 kbps · ✂ 00:30–01:45');
  assert.equal(DL.audioLabel({ format: 'opus', langName: 'Turkish' }), 'Opus · Turkish');
});

test('audio size estimates (MP3 bitrate × length, copied M4A/OPUS, PCM for WAV/FLAC, + cover)', () => {
  const COVER = 150 * 1024;
  const d = info8k.duration;
  const mp3 = DL.estimateAudio(info8k, { format: 'mp3', bitrate: 192, embedThumbnail: true });
  assert.equal(mp3.size, Math.round(24000 * d + COVER));
  assert.equal(mp3.approx, true);
  const mp3Range = DL.estimateAudio(info8k, { format: 'mp3', bitrate: 192, section: { start: 30, end: 105 }, embedThumbnail: false });
  assert.equal(mp3Range.size, 24000 * 75);
  assert.equal(DL.formatSize(mp3Range.size, true), '~1.7 MB');
  const m4a = DL.estimateAudio(info8k, { format: 'm4a', embedThumbnail: false });
  assert.equal(m4a.size, DL.pickAudio(info8k, { codec: 'aac' }).size, 'M4A copies the AAC stream');
  const opusHalf = DL.estimateAudio(info8k, { format: 'opus', section: { start: 0, end: d / 2 } });
  assert.equal(opusHalf.size, Math.round(DL.pickAudio(info8k, { codec: 'opus' }).size / 2));
  const wav = DL.estimateAudio(info8k, { format: 'wav', embedThumbnail: true });
  assert.equal(wav.size, 48000 * 2 * 2 * d + 44, 'WAV: 16-bit PCM at the Opus source rate (48 kHz), no cover');
  const flac = DL.estimateAudio(info8k, { format: 'flac', embedThumbnail: false });
  assert.equal(flac.size, Math.round(48000 * 2 * 2 * d * 0.6));
  const dubM4a = DL.estimateAudio(infoDub, { format: 'm4a', trackId: 'tr.3', lang: 'tr' });
  assert.equal(dubM4a.size, DL.pickAudio(infoDub, { codec: 'aac', trackId: 'tr.3' }).size);
  assert.equal(DL.estimateAudio({ duration: 0, audioFormats: [] }, { format: 'mp3' }).size, null);
  // the estimate grows with the bitrate
  const sizes = plain(AYT.MP3_BITRATES.map((b) => DL.estimateAudio(info8k, { format: 'mp3', bitrate: b }).size));
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
});

/* ------------------------------------------------------------------ jobs */
test('job matching for busy rows and duplicate protection', () => {
  const rows = DL.buildVideoOptions(info8k, { container: 'mp4' });
  const top = rows[0];
  const task = DL.videoTask('1La4QzGeaaQ', top, { container: 'mp4' });
  const job = { id: 'j1', kind: 'video', videoId: '1La4QzGeaaQ', status: 'running', percent: 42, task: Object.assign({ outputDir: '' }, task) };
  assert.equal(DL.jobMatchesOption(job, '1La4QzGeaaQ', top, 'mp4', false), true);
  assert.equal(DL.jobMatchesOption(job, '1La4QzGeaaQ', top, 'mkv', false), false, 'other container');
  assert.equal(DL.jobMatchesOption(job, '1La4QzGeaaQ', rows[1], 'mp4', false), false, 'other row');
  assert.equal(DL.jobMatchesOption(job, '1La4QzGeaaQ', top, 'mp4', true), false, 'playlist mode');
  assert.equal(DL.jobMatchesOption(job, 'KrLj6nc516A', top, 'mp4', false), false, 'other video');
  assert.equal(DL.findDuplicate(task, [job]).id, 'j1');
  assert.equal(DL.findDuplicate(task, [Object.assign({}, job, { status: 'done' })]), null, 'finished jobs do not block');
  const clipTask = DL.videoTask('1La4QzGeaaQ', top, { container: 'mp4', section: { start: 60, end: 90 } });
  assert.equal(DL.findDuplicate(clipTask, [job]), null, 'a clip is different work');
  const a1 = DL.audioTask('1La4QzGeaaQ', { format: 'mp3', bitrate: 192 });
  const a2 = DL.audioTask('1La4QzGeaaQ', { format: 'mp3', bitrate: 320 });
  const ajob = { id: 'a', kind: 'audio', videoId: '1La4QzGeaaQ', status: 'queued', task: a1 };
  assert.equal(DL.findDuplicate(a1, [ajob]).id, 'a');
  assert.equal(DL.findDuplicate(a2, [ajob]), null);
});

test('toolbar progress = newest active job of the current video', () => {
  const jobs = [
    { id: 'new', kind: 'video', videoId: '1La4QzGeaaQ', status: 'running', percent: 37.5, createdAt: 3 },
    { id: 'old', kind: 'video', videoId: '1La4QzGeaaQ', status: 'running', percent: 90, createdAt: 1 },
    { id: 'aud', kind: 'audio', videoId: '1La4QzGeaaQ', status: 'queued', percent: null, createdAt: 2 },
  ];
  const orig = AYT.client.jobs.list;
  AYT.client.jobs.list = () => jobs;
  try {
    assert.equal(DL.toolbarProgress(['video', 'gif']), 37.5);
    assert.equal(DL.toolbarProgress(['audio']), 0, 'queued job shows a started ring');
    assert.equal(DL.toolbarProgress(['subtitle']), null);
    const badge = AYT.toolbar.defs.find((d) => d.id === 'video').badge();
    assert.equal(badge, 3, 'badge = active jobs of this video when > 1');
  } finally {
    AYT.client.jobs.list = orig;
  }
});

/* ------------------------------------------------------------------ misc helpers */
test('formatSize + language names + folder path', () => {
  assert.equal(DL.formatSize(2154156395, false), '2.01 GB');
  assert.equal(DL.formatSize(1060633358, false), '0.99 GB', 'GB from 1000 MB on (not 1,011.5 MB)');
  assert.equal(DL.formatSize(1010391451, true), '~963.6 MB');
  assert.equal(DL.formatSize(25 * 1024 ** 3, false), '25.0 GB');
  assert.equal(DL.formatSize(5467369, true), '~5.2 MB');
  assert.equal(DL.formatSize(null, true), '');
  assert.equal(DL.languageName('tr', 'x'), 'Turkish');
  assert.equal(DL.languageName('zz-Fake-Tag-123', 'Fallback'), 'Fallback');
  assert.equal(DL.languageName(null, 'YouTube name'), 'YouTube name');
  assert.equal(DL.folderPath({ state: 'connected', defaultDir: 'C:\\Users\\a\\Downloads\\Akif YouTube' }), 'C:\\Users\\a\\Downloads\\Akif YouTube');
  assert.equal(DL.folderPath({ state: 'connected', downloadsDir: 'D:\\Downloads\\' }), 'D:\\Downloads\\Akif YouTube');
  assert.equal(DL.folderPath(null), 'Downloads › Akif YouTube');
});

test('the save-folder footer shows a folder name, never the absolute path (page scripts can read our UI)', async () => {
  const status = { state: 'connected', downloadsDir: 'C:\\Users\\jdoe\\Downloads', defaultDir: 'C:\\Users\\jdoe\\Downloads\\Akif YouTube' };
  assert.equal(DL.folderLabel(status), 'Downloads › Akif YouTube', 'inside the Windows Downloads folder');
  assert.equal(DL.folderLabel(null), 'Downloads › Akif YouTube', 'same text before the companion answered');
  assert.equal(DL.folderLabel({ state: 'connected', defaultDir: 'C:\\Users\\jdoe\\Downloads\\Akif YouTube' }), 'Akif YouTube');
  assert.equal(DL.folderLabel({ state: 'connected', defaultDir: 'D:\\' }), 'D:', 'a drive root');
  assert.equal(DL.folderLabel({ state: 'connected', defaultDir: '\\\\nas\\media\\yt\\' }), 'yt', 'a network share');
  try {
    await AYT.settings.set('outputDir', 'C:\\Users\\jdoe\\Videos\\YouTube saves');
    assert.equal(DL.folderLabel(status), 'YouTube saves', 'a chosen folder: its own name');
    assert.equal(DL.folderPath(status), 'C:\\Users\\jdoe\\Videos\\YouTube saves', 'the full path stays available to the code');
    await AYT.settings.setMany({ outputDir: '', subfolder: '' });
    assert.equal(DL.folderLabel(status), 'Downloads folder');
  } finally {
    await AYT.settings.setMany({ outputDir: '', subfolder: AYT.DEFAULT_SETTINGS.subfolder });
  }
  for (const s of [status, null, { state: 'connected', defaultDir: 'C:\\Users\\jdoe\\Downloads\\Akif YouTube' }]) {
    assert.ok(!/[\\/]|jdoe/i.test(DL.folderLabel(s)), 'no path separators or user name: ' + DL.folderLabel(s));
  }
});

test('our own page scrolls follow prefers-reduced-motion', () => {
  const queries = [];
  try {
    ctx.matchMedia = (q) => (queries.push(q), { matches: true });
    assert.equal(DL.scrollBehavior(), 'instant', 'reduced motion: jump, no animation');
    assert.deepEqual(queries, ['(prefers-reduced-motion: reduce)']);
    ctx.matchMedia = () => ({ matches: false });
    assert.equal(DL.scrollBehavior(), 'smooth');
    ctx.matchMedia = () => {
      throw new Error('no media queries here');
    };
    assert.equal(DL.scrollBehavior(), 'smooth');
  } finally {
    delete ctx.matchMedia;
  }
  assert.equal(DL.scrollBehavior(), 'smooth', 'no matchMedia at all');
});

/* ------------------------------------------------------------------ keyboard opens */
test('a keyboard open moves focus into the panel only while it is still on the panel container (or lost to <body>)', () => {
  const body = { tag: 'body' };
  const portalHost = { tag: 'div#ayt-portal-host' };
  const panelEl = { tag: 'div.ayt-panel' };
  const portal = { host: portalHost, activeElement: panelEl }; // toolbar.js renders panels in this shadow root
  const root = { closest: (sel) => (sel === '.ayt-panel' ? panelEl : null), getRootNode: () => portal };
  const had = 'document' in ctx;
  const prev = ctx.document;
  ctx.document = { body, documentElement: { tag: 'html' }, activeElement: portalHost };
  try {
    assert.equal(DL.focusUntouched(root), true, 'focus still on the panel container (toolbar.js focusPanel)');
    portal.activeElement = { tag: 'button.ayt-panel__close' };
    assert.equal(DL.focusUntouched(root), false, 'the user tabbed to Close (or the footer) while the formats loaded');
    ctx.document.activeElement = { tag: 'div#ayt-toolbar-host' };
    assert.equal(DL.focusUntouched(root), false, 'the user went back to the toolbar button (Shift+Tab)');
    ctx.document.activeElement = { tag: 'div#movie_player' };
    assert.equal(DL.focusUntouched(root), false, 'YouTube focused its player (video change)');
    ctx.document.activeElement = body;
    assert.equal(DL.focusUntouched(root), true, 'focus lost to <body>: the control that had it was re-rendered');
    ctx.document.activeElement = portalHost;
    portal.activeElement = panelEl;
    const notInPanel = { closest: () => null, getRootNode: () => portal };
    assert.equal(DL.focusUntouched(notInPanel), false, 'not inside a toolbar panel');
  } finally {
    if (had) ctx.document = prev;
    else delete ctx.document;
  }
});

test("'open-download' is a keyboard open, except when the popup link was clicked (viaKeyboard: false)", () => {
  const tb = AYT.toolbar;
  const saved = { open: tb.open, isOpen: tb.isOpen };
  const calls = [];
  tb.open = (id, opts) => calls.push({ id, viaKeyboard: opts && opts.viaKeyboard });
  tb.isOpen = () => true;
  try {
    const command = tb.defs.find((d) => d.id === 'video').commands['open-download'];
    command(); // keyboard shortcut (background/commands.js sends no flag)
    command({ viaKeyboard: false }); // popup link clicked with the mouse
    command({ viaKeyboard: true }); // popup link activated from the keyboard
    assert.deepEqual(plain(calls), [
      { id: 'video', viaKeyboard: true },
      { id: 'video', viaKeyboard: false },
      { id: 'video', viaKeyboard: true },
    ]);
  } finally {
    Object.assign(tb, saved);
  }
});

/* ------------------------------------------------------------------ i18n */
test('every t() key used by the panels exists in the English dictionary; part file is sorted', () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'en.json'), 'utf8'));
  const part = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'parts', 'en.downloads.json'), 'utf8'));
  const keys = Object.keys(part);
  assert.deepEqual(keys, [...keys].sort(), 'en.downloads.json keys are sorted');
  for (const k of keys) assert.ok(/^(video|audio|dl)\.[a-zA-Z0-9]+$/.test(k), 'key naming: ' + k);
  for (const file of ['content/panels/video.js', 'content/panels/audio.js']) {
    const src = fs.readFileSync(path.join(EXT, file), 'utf8');
    const used = [...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)].map((m) => m[1]);
    assert.ok(used.length > 20, 'found t() calls in ' + file);
    for (const k of used) assert.ok(k in en, `${file}: missing i18n key ${k}`);
  }
  for (const k of keys) assert.equal(en[k], part[k], 'merged into i18n/en.json: ' + k);
});
