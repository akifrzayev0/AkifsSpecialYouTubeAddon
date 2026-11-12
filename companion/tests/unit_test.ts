// Unit tests for the companion host's logic.
// Run:  deno test --no-config -A companion/tests/unit_test.ts
// (no internet; a few tests use temp folders, a localhost HTTP server or Windows tools: tar.exe, mklink)

import { isFile } from "../host/lib/config.ts";
import { announce, othersDoing, withdraw } from "../host/lib/coord.ts";
import { classifyRun, classifyText, cleanMessage } from "../host/lib/errors.ts";
import { hostBaseName } from "../host/lib/jobs.ts";
import { closeLog, initLog, log } from "../host/lib/log.ts";
import { Starter, type StarterDeps } from "../host/lib/starts.ts";
import {
  extensionSanitize,
  fileUrlToPath,
  join,
  normalizeAbsolutePath,
  pathExists,
  sanitizeFileName,
  subfolderPath,
  truncateUtf8,
  utf8Length,
} from "../host/lib/paths.ts";
import {
  cloudSyncRoots,
  createOutputTemp,
  isCloudSynced,
  JOB_MARKER,
  moveFile,
  removeOutputTemp,
  sweepOutputTemp,
  sweepPrivateTemp,
} from "../host/lib/tempdirs.ts";
import { Budget, downloadFile, extractZip, latestReleaseTag, StepError } from "../host/lib/tools.ts";
import { bypassesProxy, inNoProxy, proxyFromServer, routeFor, type WinProxySettings } from "../host/lib/netproxy.ts";
import { FfmpegProgress, OutputTracker, ppStage, type ProgressSnapshot } from "../host/lib/progress.ts";
import { convertSubtitle, parseJson3, parseVttOrSrt, toSrt, toTxt } from "../host/lib/subs.ts";
import { BadTask, validateTask } from "../host/lib/task.ts";
import { pickerFailureText, pickFolder } from "../host/lib/winshell.ts";
import {
  audioPart,
  buildYtDlpArgs,
  clipLabel,
  codecOrder,
  fileClock,
  fileSuffix,
  hostCutsAudio,
  outputTemplate,
  videoSelection,
} from "../host/lib/ytdlp.ts";

// ---- tiny assertion helpers (no remote imports: the host runs with --no-remote) ----
function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq<T>(a: T, b: T, msg = "") {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}\n  actual:   ${sa}\n  expected: ${sb}`);
}
function throwsBad(fn: () => unknown, re?: RegExp) {
  try {
    fn();
  } catch (e) {
    assert(e instanceof BadTask, `expected BadTask, got ${e}`);
    if (re) assert(re.test((e as Error).message), `message "${(e as Error).message}" does not match ${re}`);
    return;
  }
  throw new Error("expected BadTask, nothing was thrown");
}
function argAfter(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag) out.push(args[i + 1]);
  });
  return out;
}

const W = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const PL = "https://www.youtube.com/playlist?list=PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu";
const CTX = {
  homeDir: "C:\\out",
  tempDir: "C:\\out\\.akif-tmp\\j1",
  denoPath: "C:\\x\\bin\\deno.exe",
  ffmpegPath: "C:\\ff\\ffmpeg.exe",
  cookiesFile: null,
  template: "%(title).150B.%(ext)s",
};

// ---------------------------------------------------------------------------
Deno.test("validateTask: valid video task is normalised", () => {
  const t = validateTask({ kind: "video", videoId: "jNQXAC9IVRw", url: W, playlist: false, height: 240, width: 320, hdr: false, fps: 15, container: "mp4", codec: "auto", audioLang: null, section: null });
  eq(t.kind, "video");
  eq(t.url, W);
  eq(t.videoId, "jNQXAC9IVRw");
  eq(t.height, 240);
  eq(t.embedThumbnail, true);
  eq(t.embedSubtitles, false);
  eq(t.filenameStyle, "title");
  eq(t.outputDir, "");
});

Deno.test("validateTask: defaults, playlist and subfolder sanitising", () => {
  const t = validateTask({ kind: "audio", url: PL, playlist: true, videoId: null, subfolder: "Akif YouTube/Music: best?", section: { start: 1, end: 5 }, playlistItems: "1:2" });
  eq(t.playlist, true);
  eq(t.listId, "PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu");
  eq(t.audioFormat, "mp3");
  eq(t.bitrate, 192);
  eq(t.section, null, "a section is dropped for playlists");
  eq(t.subfolder, "Akif YouTube\\Music - best");
  eq(t.playlistItems, "1:2");
});

Deno.test("validateTask: rejects bad input", () => {
  const ok = { kind: "video", url: W, videoId: "jNQXAC9IVRw" };
  throwsBad(() => validateTask(null), /object/);
  throwsBad(() => validateTask({ ...ok, kind: "exe" }), /kind/);
  throwsBad(() => validateTask({ ...ok, url: "https://evil.example/watch?v=jNQXAC9IVRw" }), /url/);
  throwsBad(() => validateTask({ ...ok, url: "http://www.youtube.com/watch?v=jNQXAC9IVRw" }), /url/);
  throwsBad(() => validateTask({ ...ok, url: W + "&list=PLx" }), /url/);
  throwsBad(() => validateTask({ ...ok, url: "https://www.youtube.com/watch?v=jNQXAC9IVR" }), /url/);
  throwsBad(() => validateTask({ ...ok, url: "https://www.youtube.com/watch?v=jNQXAC9IVRw;calc" }), /url/);
  throwsBad(() => validateTask({ ...ok, videoId: "dQw4w9WgXcQ" }), /match/);
  throwsBad(() => validateTask({ ...ok, playlist: true }), /playlist/);
  throwsBad(() => validateTask({ ...ok, outputDir: "relative\\dir" }), /outputDir/);
  throwsBad(() => validateTask({ ...ok, outputDir: "C:\\a\\..\\Windows" }), /outputDir/);
  throwsBad(() => validateTask({ ...ok, outputDir: "C:\\a|b" }), /outputDir/);
  throwsBad(() => validateTask({ ...ok, outputDir: "\\\\?\\C:\\x" }), /outputDir/);
  throwsBad(() => validateTask({ ...ok, outputDir: "C:\\x\\file.txt:stream" }), /outputDir/);
  throwsBad(() => validateTask({ ...ok, outputDir: "C:\\x\\CON" }), /outputDir/);
  throwsBad(() => validateTask({ ...ok, outputDir: "C:\\" + "a".repeat(200) }), /too long/);
  throwsBad(() => validateTask({ ...ok, height: "1080" }), /height/);
  throwsBad(() => validateTask({ ...ok, height: 1080.5 }), /height/);
  throwsBad(() => validateTask({ ...ok, hdr: "yes" }), /hdr/);
  throwsBad(() => validateTask({ ...ok, container: "avi" }), /container/);
  throwsBad(() => validateTask({ ...ok, audioLang: "en]+(b" }), /audioLang/);
  throwsBad(() => validateTask({ ...ok, audioLang: "en,../x" }), /audioLang/);
  throwsBad(() => validateTask({ ...ok, kind: "audio", bitrate: 100 }), /bitrate/);
  throwsBad(() => validateTask({ ...ok, kind: "audio", audioFormat: "exe" }), /audioFormat/);
  throwsBad(() => validateTask({ ...ok, section: { start: 9, end: 3 } }), /section/);
  throwsBad(() => validateTask({ ...ok, section: { start: "1", end: 3 } }), /section/);
  throwsBad(() => validateTask({ ...ok, section: { start: -1, end: 3 } }), /section/);
  throwsBad(() => validateTask({ ...ok, kind: "gif" }), /section/);
  throwsBad(() => validateTask({ ...ok, kind: "gif", section: { start: 0, end: 90 } }), /60/);
  throwsBad(() => validateTask({ ...ok, kind: "gif", gifWidth: 4000, section: { start: 0, end: 5 } }), /gifWidth/);
  throwsBad(() => validateTask({ ...ok, kind: "subtitle" }), /subLang/);
  throwsBad(() => validateTask({ ...ok, kind: "subtitle", subLang: "en", subFormat: "doc" }), /subFormat/);
  throwsBad(() => validateTask({ ...ok, cookies: 42 }), /cookies/);
  throwsBad(() => validateTask({ ...ok, filenameStyle: "../../x" }), /filenameStyle/);
  throwsBad(() => validateTask({ kind: "audio", url: PL, playlist: true, playlistItems: "1;calc" }), /playlistItems/);
});

// ---------------------------------------------------------------------------
Deno.test("paths: absolute path validation", () => {
  eq(normalizeAbsolutePath("C:\\Users\\akif\\Downloads\\"), "C:\\Users\\akif\\Downloads");
  eq(normalizeAbsolutePath("c:/Users/akif"), "C:\\Users\\akif");
  eq(normalizeAbsolutePath("D:\\"), "D:\\");
  eq(normalizeAbsolutePath("\\\\server\\share\\Videos"), "\\\\server\\share\\Videos");
  eq(normalizeAbsolutePath("C:\\Akif's Special YouTube Addon\\\u015E\u0259kil \u{1F600}"), "C:\\Akif's Special YouTube Addon\\\u015E\u0259kil \u{1F600}");
  for (const bad of ["Videos", "\\Videos", "C:Videos", "C:\\a\\..\\b", "C:\\a\\.\\b", "C:\\a\\\\b", "C:\\a<b", "C:\\a\u0001", " C:\\a", "C:\\a.", "C:\\nul\\x", "\\\\.\\pipe\\x", "\\\\?\\C:\\x", 42, null]) {
    eq(normalizeAbsolutePath(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

Deno.test("paths: sanitising like yt-dlp and like the extension", () => {
  eq(sanitizeFileName('a:b|c?d*e"f<g>h/i\\j'), "a\uFF1Ab\uFF5Cc\uFF1Fd\uFF0Ae\uFF02f\uFF1Cg\uFF1Eh\u29F8i\u29F9j");
  eq(sanitizeFileName("  trailing dots... "), "trailing dots");
  eq(sanitizeFileName("CON"), "_CON");
  eq(sanitizeFileName("\u015E\u0259ki \u015F\u0259h\u0259ri - Dron g\u00F6r\u00FCnt\u00FCs\u00FC | Sheki city - Drone"), "\u015E\u0259ki \u015F\u0259h\u0259ri - Dron g\u00F6r\u00FCnt\u00FCs\u00FC \uFF5C Sheki city - Drone");
  const long = "\u015E".repeat(200);
  assert(utf8Length(sanitizeFileName(long, 150)) <= 150);
  eq(truncateUtf8("a\u{1F600}b", 4), "a"); // never splits a code point
  eq(extensionSanitize("Music: best?"), "Music - best");
  eq(subfolderPath("Akif YouTube"), "Akif YouTube");
  eq(subfolderPath("../..\\x//y"), "x\\y");
  eq(subfolderPath(""), "");
});

// ---------------------------------------------------------------------------
Deno.test("ytdlp: codec order and audio part follow spec 8.4", () => {
  eq(codecOrder("mp4", "auto"), ["av01", "avc1", "vp9"]);
  eq(codecOrder("mp4", "compat"), ["avc1", "av01", "vp9"]);
  eq(codecOrder("webm", "auto"), ["vp9", "av01"]);
  eq(codecOrder("mkv", "auto"), ["av01", "vp9", "avc1"]);
  eq(codecOrder("mkv", "compat"), ["avc1", "av01", "vp9"]);
  eq(audioPart("mp4", "auto", "tr"), "ba[ext=m4a][language^=tr]/ba[ext=m4a]/ba[language^=tr]/ba");
  eq(audioPart("mp4", "auto", null), "ba[ext=m4a]/ba");
  eq(audioPart("mkv", "compat", null), "ba[ext=m4a]/ba");
  eq(audioPart("webm", "auto", "de"), "ba[acodec=opus][language^=de]/ba[acodec=opus]/ba");
  eq(audioPart("mkv", "auto", "de"), "ba[language^=de]/ba");
});

Deno.test("ytdlp: video selectors", () => {
  const base = { kind: "video", url: W, height: 1080, width: 1920, hdr: false, fps: 30, container: "mp4", codec: "auto" };
  const s1 = videoSelection(validateTask(base));
  eq(s1.format.split("/").slice(0, 3), [
    "bv[height=1080][dynamic_range=SDR][fps<=30][vcodec^=av01]+(ba[ext=m4a]",
    "ba)",
    "bv[height=1080][dynamic_range=SDR][fps<=30][vcodec^=avc1]+(ba[ext=m4a]",
  ]);
  assert(s1.format.endsWith("/bv[height<=1080]+(ba[ext=m4a]/ba)/b[height<=1080]/bv*+ba/b"), s1.format);
  eq(s1.sort, null);
  const hdr = videoSelection(validateTask({ ...base, height: 2160, hdr: true, fps: 60, container: "webm" }));
  assert(hdr.format.startsWith("bv[height=2160][dynamic_range!=SDR][fps>30][vcodec~='^vp0?9']+(ba[acodec=opus]/ba)/"), hdr.format);
  const best = videoSelection(validateTask({ ...base, height: null, hdr: null, fps: null, codec: "compat" }));
  eq(best.format, "bv*+(ba[ext=m4a]/ba)/b");
  eq(best.sort, "vcodec:h264,res,acodec:aac");
  const pl = videoSelection(validateTask({ ...base, url: PL, playlist: true, videoId: null }));
  assert(!pl.format.includes("[height=1080]"), "playlists use <= H");
  assert(pl.format.startsWith("bv[height<=1080][dynamic_range=SDR][fps<=30]+("), pl.format);
});

Deno.test("ytdlp: full argv for a video with section, cookies and embeds", () => {
  const t = validateTask({ kind: "video", url: W, height: 240, width: 320, hdr: false, fps: 15, container: "mkv", section: { start: 5, end: 12.5 }, preciseCut: true, embedSubtitles: true, uiLang: "tr" });
  const a = buildYtDlpArgs(t, { ...CTX, cookiesFile: "C:\\out\\.akif-tmp\\j1\\cookies.txt" });
  eq(a.slice(0, 3), ["--ignore-config", "--encoding", "utf-8"]);
  eq(a.slice(-2), ["--", W]);
  assert(a.includes("--newline") && a.includes("--progress") && a.includes("--no-mtime") && a.includes("--no-playlist"));
  eq(argAfter(a, "-P"), ["home:C:\\out", "temp:C:\\out\\.akif-tmp\\j1"]);
  eq(argAfter(a, "--js-runtimes"), ["deno:C:\\x\\bin\\deno.exe"]);
  eq(argAfter(a, "--ffmpeg-location"), ["C:\\ff\\ffmpeg.exe"]);
  eq(argAfter(a, "--cookies"), ["C:\\out\\.akif-tmp\\j1\\cookies.txt"]);
  eq(argAfter(a, "--merge-output-format"), ["mkv"]);
  eq(argAfter(a, "--download-sections"), ["*5-12.5"]);
  eq(argAfter(a, "--downloader-args"), ["ffmpeg_i:-request_size 10485760", "ffmpeg_o:-progress pipe:1 -stats_period 1"]);
  assert(a.includes("--force-keyframes-at-cuts"));
  assert(a.includes("--embed-thumbnail") && a.includes("--embed-metadata"));
  eq(argAfter(a, "--convert-thumbnails"), ["jpg"], "jpg cover, not a ~1.4 MB png");
  // --embed-metadata alone would embed chapters too: a clip must say --no-embed-chapters
  assert(a.includes("--no-embed-chapters") && !a.includes("--embed-chapters"), "a clip must not carry the whole video's chapters");
  const whole = buildYtDlpArgs(validateTask({ kind: "video", url: W, height: 240, container: "mp4" }), CTX);
  assert(whole.includes("--embed-chapters") && !whole.includes("--no-embed-chapters") && whole.includes("--embed-thumbnail"), "whole videos keep chapters + cover");
  eq(argAfter(whole, "--convert-thumbnails"), ["jpg"]);
  const off = buildYtDlpArgs(validateTask({ kind: "video", url: W, height: 240, container: "mp4", embedChapters: false }), CTX);
  assert(off.includes("--embed-metadata") && off.includes("--no-embed-chapters"), "the Chapters setting off must win over --embed-metadata");
  const plClip = buildYtDlpArgs(validateTask({ kind: "video", url: "https://www.youtube.com/playlist?list=PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu", playlist: true, height: 240, section: { start: 5, end: 9 } }), CTX);
  assert(plClip.includes("--embed-chapters") && !plClip.includes("--download-sections"), "a section on a playlist is ignored, so chapters stay");
  eq(argAfter(a, "--sub-langs"), ["tr.*,en.*"]);
  assert(a.includes("--ignore-errors"));
  eq(argAfter(a, "--retries"), ["10"]);
  // antivirus / sync clients lock fresh files: retry file access for ~30 s instead of 3 times without a pause
  eq(argAfter(a, "--file-access-retries"), ["10"]);
  eq(argAfter(a, "--retry-sleep"), ["file_access:exp=0.2:5"]);
  eq(argAfter(a, "--progress-template").length, 2);
  eq(argAfter(a, "--print").length, 2);
  assert(!a.some((x) => x.includes("player_client")), "never force player clients");
  assert(!a.includes("--restrict-filenames") && !a.includes("--trim-filenames"));
  const webm = buildYtDlpArgs(validateTask({ kind: "video", url: W, height: 240, container: "webm" }), CTX);
  eq(argAfter(webm, "--merge-output-format"), ["webm/mkv"]);
  assert(!webm.includes("--embed-thumbnail"), "webm cannot embed thumbnails");
});

Deno.test("ytdlp: audio argv (exact sections, wav without thumbnail)", () => {
  const mp3 = buildYtDlpArgs(validateTask({ kind: "audio", url: W, audioFormat: "mp3", bitrate: 192, section: { start: 3, end: 9 } }), CTX);
  eq(argAfter(mp3, "-f"), ["ba/b"]);
  eq(argAfter(mp3, "--audio-format"), ["mp3"]);
  eq(argAfter(mp3, "--audio-quality"), ["192K"]);
  eq(argAfter(mp3, "--ppa"), ["ExtractAudio+ffmpeg_o:-ss 3 -to 9"]);
  assert(!mp3.includes("--download-sections"), "no stream-copy sections for audio");
  eq(argAfter(mp3, "--convert-thumbnails"), ["jpg"]);
  assert(mp3.includes("--no-embed-chapters") && !mp3.includes("--embed-chapters"), "an audio clip must not carry the whole video's chapters");
  const mp3Whole = buildYtDlpArgs(validateTask({ kind: "audio", url: W, audioFormat: "mp3", bitrate: 192 }), CTX);
  assert(mp3Whole.includes("--embed-chapters"), "whole audio keeps chapters (default)");
  const mp3NoCh = buildYtDlpArgs(validateTask({ kind: "audio", url: W, audioFormat: "mp3", bitrate: 192, embedChapters: false }), CTX);
  assert(mp3NoCh.includes("--embed-metadata") && mp3NoCh.includes("--no-embed-chapters"), "the Chapters setting off applies to audio");
  const m4a = validateTask({ kind: "audio", url: W, audioFormat: "m4a", section: { start: 3, end: 9 }, audioLang: "en" });
  const a = buildYtDlpArgs(m4a, CTX);
  eq(argAfter(a, "-f"), ["ba[ext=m4a][language^=en]/ba[ext=m4a]/ba[language^=en]/ba/b"]);
  assert(!a.includes("--ppa") && !a.includes("--download-sections"), "m4a is cut by the host");
  assert(hostCutsAudio(m4a));
  const wav = buildYtDlpArgs(validateTask({ kind: "audio", url: W, audioFormat: "wav", embedThumbnail: true }), CTX);
  assert(!wav.includes("--embed-thumbnail"), "wav + --embed-thumbnail is a fatal yt-dlp error");
  const opus = buildYtDlpArgs(validateTask({ kind: "audio", url: W, audioFormat: "opus" }), CTX);
  eq(argAfter(opus, "-f"), ["ba[acodec=opus]/ba/b"]);
  // opus goes through ExtractAudio's ffmpeg (webm -> ogg copy): the cut happens there, before the cover is embedded
  const opusCut = validateTask({ kind: "audio", url: W, audioFormat: "opus", section: { start: 3, end: 9 } });
  eq(argAfter(buildYtDlpArgs(opusCut, CTX), "--ppa"), ["ExtractAudio+ffmpeg_o:-ss 3 -to 9"]);
  assert(!hostCutsAudio(opusCut));
});

Deno.test("ytdlp: subtitle and gif argv", () => {
  const s = buildYtDlpArgs(validateTask({ kind: "subtitle", url: W, subLang: "en", subFormat: "srt" }), CTX);
  assert(s.includes("--skip-download") && s.includes("--write-subs") && s.includes("--ignore-errors"));
  eq(argAfter(s, "--sub-langs"), ["en"]);
  eq(argAfter(s, "--sub-format"), ["json3/vtt/best"]);
  assert(argAfter(s, "--print").some((p) => p.startsWith("after_video:[AKIF:SUBS]")));
  const auto = buildYtDlpArgs(validateTask({ kind: "subtitle", url: W, subLang: "en", subAuto: true, subFormat: "vtt" }), CTX);
  eq(argAfter(auto, "--sub-langs"), ["en-orig,en"]);
  eq(argAfter(auto, "--sub-format"), ["vtt/best"]);
  assert(auto.includes("--write-auto-subs"));
  const tr = buildYtDlpArgs(validateTask({ kind: "subtitle", url: W, subLang: "en", subTranslateTo: "tr" }), CTX);
  eq(argAfter(tr, "--sub-langs"), ["tr-en,tr"]);
  const g = buildYtDlpArgs(validateTask({ kind: "gif", url: W, section: { start: 3, end: 8 }, gifWidth: 320 }), CTX);
  eq(argAfter(g, "-S"), ["res:480"]);
  eq(argAfter(g, "--download-sections"), ["*3-8"]);
});

Deno.test("ytdlp: output templates and suffixes", () => {
  const v = validateTask({ kind: "video", url: W, height: 1920, width: 1080, fps: 60, hdr: true });
  eq(fileSuffix(v), " (1080p60 HDR)");
  eq(outputTemplate(v, 150), "%(title).150B (1080p60 HDR).%(ext)s");
  const clip = validateTask({ kind: "video", url: W, height: 720, section: { start: 60, end: 150 } });
  eq(fileSuffix(clip), " (720p) (clip 01-00 - 02-30)");
  eq(fileSuffix(validateTask({ kind: "video", url: W, height: 800, width: 1920 })), " (1080p)");
  eq(fileSuffix(validateTask({ kind: "video", url: W, height: 2160, width: 4096 })), " (2160p)");
  eq(fileSuffix(validateTask({ kind: "video", url: W, height: 4320, width: 7680, fps: 30 })), " (4320p)");
  eq(fileSuffix(validateTask({ kind: "audio", url: W })), "");
  eq(fileClock(3723), "1-02-03");
  eq(fileClock(3.5), "00-03.5");
  eq(clipLabel({ start: 0, end: 5 }), "clip 00-00 - 00-05");
  eq(outputTemplate(validateTask({ kind: "audio", url: W, filenameStyle: "title_id" }), 100), "%(title).100B [%(id)s].%(ext)s");
  eq(outputTemplate(validateTask({ kind: "audio", url: W, filenameStyle: "channel_title" }), 100), "%(uploader,channel|Unknown).60B - %(title).100B.%(ext)s");
  eq(outputTemplate(validateTask({ kind: "audio", url: W, filenameStyle: "date_title" }), 100), "%(upload_date>%Y-%m-%d|0000-00-00)s %(title).100B.%(ext)s");
  eq(outputTemplate(validateTask({ kind: "audio", url: PL, playlist: true }), 100), "%(playlist_title,playlist_id|Playlist).80B\\%(playlist_index)03d - %(title).100B.%(ext)s");
  eq(hostBaseName("date_title", { title: "a:b", upload_date: "20050424", id: "jNQXAC9IVRw" }, " (en)", 150), "2005-04-24 a\uFF1Ab (en)");
  eq(hostBaseName("title_id", { title: "Me at the zoo", id: "jNQXAC9IVRw" }, " (clip 00-03 - 00-08)", 150), "Me at the zoo [jNQXAC9IVRw] (clip 00-03 - 00-08)");
});

// ---------------------------------------------------------------------------
function makeTracker(kind: "video" | "audio" | "subtitle" | "gif", playlist = false, sectionLength: number | null = null) {
  const ev: { infos: unknown[]; progress: ProgressSnapshot[]; stages: string[]; files: string[] } = { infos: [], progress: [], stages: [], files: [] };
  const tr = new OutputTracker({
    kind,
    playlist,
    sectionLength,
    hooks: {
      info: (i) => ev.infos.push(i),
      progress: (p) => ev.progress.push(p),
      stage: (s) => ev.stages.push(s),
      file: (p) => ev.files.push(p),
    },
  });
  const feed = (stream: "stdout" | "stderr", line: string) => tr.feed({ stream, line, eol: "\n", t: 0 });
  return { tr, ev, feed };
}

Deno.test("progress: merged DASH download (real lines from yt-dlp 2026.10.26)", () => {
  const { tr, ev, feed } = makeTracker("video");
  feed("stdout", '[AKIF:INFO] {"id": "jNQXAC9IVRw", "title": "Me at the zoo", "format_id": "395+251", "ext": "mp4", "height": 240, "filesize_approx": 475961, "duration": 19}');
  feed("stdout", '[AKIF:DL] {"progress.status": "downloading", "progress.downloaded_bytes": 1024, "progress.total_bytes": 223779, "progress.speed": 255515.9, "progress.eta": 0, "info.id": "jNQXAC9IVRw", "info.format_id": "395", "info.vcodec": "av01.0.00M.08", "info.acodec": "none"}');
  feed("stdout", '[AKIF:DL] {"progress.status": "finished", "progress.downloaded_bytes": 223779, "progress.total_bytes": 223779, "info.id": "jNQXAC9IVRw", "info.format_id": "395", "info.vcodec": "av01.0.00M.08", "info.acodec": "none"}');
  feed("stdout", '[AKIF:DL] {"progress.status": "downloading", "progress.downloaded_bytes": 1024, "progress.total_bytes": 252182, "info.id": "jNQXAC9IVRw", "info.format_id": "251", "info.vcodec": "none", "info.acodec": "opus"}');
  feed("stdout", '[AKIF:DL] {"progress.status": "finished", "progress.downloaded_bytes": 252182, "progress.total_bytes": 252182, "info.id": "jNQXAC9IVRw", "info.format_id": "251", "info.vcodec": "none", "info.acodec": "opus"}');
  feed("stderr", '[AKIF:PP] {"progress.status": "started", "progress.postprocessor": "Merger", "info.id": "jNQXAC9IVRw"}');
  assert(tr.ppActive === 1);
  feed("stderr", '[AKIF:PP] {"progress.status": "finished", "progress.postprocessor": "Merger", "info.id": "jNQXAC9IVRw"}');
  feed("stdout", '[AKIF:DONE] {"id": "jNQXAC9IVRw", "filepath": "C:\\\\out\\\\Me at the zoo (240p).mp4"}');
  eq((ev.infos[0] as { title: string }).title, "Me at the zoo");
  eq(ev.stages, ["merge"]);
  eq(ev.files, ["C:\\out\\Me at the zoo (240p).mp4"]);
  const pcts = ev.progress.map((p) => p.percent);
  for (let i = 1; i < pcts.length; i++) assert(pcts[i] >= pcts[i - 1], `not monotonic: ${pcts}`);
  eq(pcts[pcts.length - 1], 100);
  eq(ev.progress.length, 4, "single videos: no extra 0% event at INFO");
  eq(ev.progress[0].stage, "video");
  eq(ev.progress[2].stage, "audio");
  assert(ev.progress[1].percent > 40 && ev.progress[1].percent < 55, `video part ~47%: ${ev.progress[1].percent}`);
  eq(tr.ppActive, 0);
});

Deno.test("progress: HLS fragments keep the percent monotonic", () => {
  const { ev, feed } = makeTracker("video");
  feed("stdout", '[AKIF:INFO] {"id": "x", "format_id": "229+233"}');
  for (const [dl, est, fi] of [[1024, 1024, 0], [7168, 9216, 0], [135736, 814416, 1], [136760, 203604, 1], [280496, 637884, 2]]) {
    feed("stdout", `[AKIF:DL] {"progress.status": "downloading", "progress.downloaded_bytes": ${dl}, "progress.total_bytes_estimate": ${est}, "progress.fragment_index": ${fi}, "progress.fragment_count": 3, "info.format_id": "229", "info.vcodec": "avc1", "info.acodec": "none"}`);
  }
  const p = ev.progress.map((x) => x.percent);
  for (let i = 1; i < p.length; i++) assert(p[i] >= p[i - 1], `not monotonic: ${p}`);
  assert(p[p.length - 1] <= 50, `only half of a 2-format item: ${p}`);
});

Deno.test("progress: section download via ffmpeg -progress", () => {
  const { ev, feed } = makeTracker("video", false, 30);
  feed("stdout", '[AKIF:INFO] {"id": "KrLj6nc516A", "format_id": "137+140"}');
  for (const t of [4133152, 10777433, 18529524, 29996633]) {
    feed("stdout", "frame=127");
    feed("stdout", "total_size=262192");
    feed("stdout", `out_time_us=${t}`);
    feed("stdout", "speed=4.03x");
    feed("stdout", t === 29996633 ? "progress=end" : "progress=continue");
  }
  feed("stdout", '[AKIF:DL] {"progress.status": "finished", "progress.downloaded_bytes": 3102347, "info.format_id": "137+140"}');
  const p = ev.progress.map((x) => x.percent);
  eq(p[0], 13.8);
  eq(p[p.length - 1], 100);
});

Deno.test("progress: playlist overall percent and indexes", () => {
  const { ev, feed } = makeTracker("audio", true);
  feed("stdout", '[AKIF:INFO] {"playlist_index": 1, "playlist_autonumber": 1, "n_entries": 2, "id": "yN-Q-tFFElc", "title": "JOD", "format_id": "140", "filesize_approx": 1000}');
  feed("stdout", '[AKIF:DL] {"progress.status": "finished", "progress.downloaded_bytes": 1000, "progress.total_bytes": 1000, "info.format_id": "140", "info.vcodec": "none", "info.acodec": "mp4a.40.2", "info.playlist_index": 1, "info.n_entries": 2}');
  feed("stdout", '[AKIF:INFO] {"playlist_index": 2, "playlist_autonumber": 2, "n_entries": 2, "id": "aVjGozRKnS0", "title": "JOD2", "format_id": "140", "filesize_approx": 1000}');
  feed("stdout", '[AKIF:DL] {"progress.status": "downloading", "progress.downloaded_bytes": 500, "progress.total_bytes": 1000, "info.format_id": "140", "info.vcodec": "none", "info.acodec": "mp4a.40.2"}');
  const last = ev.progress[ev.progress.length - 1];
  eq([last.playlistIndex, last.playlistCount, last.percent, last.itemPercent, last.stage], [2, 2, 75, 50, "audio"]);
  eq(ev.infos.length, 2);
});

Deno.test("progress: errors, warnings and postprocessor stages", () => {
  const { tr, feed } = makeTracker("video");
  feed("stderr", "WARNING: [youtube] Retrying (1/3)...");
  feed("stderr", "ERROR: [youtube] xxxxxxxxxxx: Video unavailable");
  eq(tr.errors, ["[youtube] xxxxxxxxxxx: Video unavailable"]);
  eq(tr.warnings.length, 1);
  eq(ppStage("Merger"), "merge");
  eq(ppStage("ExtractAudio"), "extract");
  eq(ppStage("EmbedThumbnail"), "thumbnail");
  eq(ppStage("FFmpegMetadata"), "metadata");
  eq(ppStage("Metadata"), "metadata");
  eq(ppStage("SubtitlesConvertor"), "subtitles");
  eq(ppStage("VideoRemuxer"), "convert");
  eq(ppStage("MoveFiles"), "processing");
  eq(ppStage("FixupM4a"), "processing");
});

Deno.test("progress: ffmpeg parser handles N/A and end", () => {
  const f = new FfmpegProgress();
  eq(f.feed("out_time_us=N/A", 10), null);
  const r = f.feed("progress=continue", 10);
  eq(r?.frac, 0);
  f.feed("out_time_us=5000000", 10);
  eq(f.feed("progress=end", 10)?.frac, 1);
});

// ---------------------------------------------------------------------------
Deno.test("errors: classification (spec 8.4)", () => {
  const c = (s: string) => classifyText(s);
  eq(c("ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users."), "age");
  eq(c("Sign in to confirm you\u2019re not a bot. Use --cookies-from-browser"), "bot");
  eq(c("Sign in to confirm you're not a bot"), "bot");
  eq(c("[youtube] abc: Private video. Sign in if you've been granted access"), "private");
  eq(c("Join this channel to get access to members-only content"), "members");
  eq(c("This video is DRM protected"), "drm");
  eq(c("This live event will begin in 3 hours"), "live");
  eq(c("[youtube] xxxxxxxxxxx: Video unavailable. This video is no longer available"), "unavailable");
  eq(c("Requested format is not available. Use --list-formats for a list of available formats"), "format");
  eq(c("unable to download video data: HTTP Error 403: Forbidden"), "forbidden");
  eq(c("Unable to download video subtitles for 'tr': HTTP Error 429: Too Many Requests"), "rate_limited");
  eq(c("[Errno 28] No space left on device"), "disk");
  eq(c("Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path using --ffmpeg-location"), "ffmpeg");
  eq(c("Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>"), "network");
  eq(c("Read timed out."), "network");
  eq(c("something odd"), "unknown");
  eq(cleanMessage("ERROR: [youtube] KrLj6nc516A: Requested format is not available. Use --list-formats for a list of available formats"), "Requested format is not available.");
  const silent = classifyRun({ exitCode: 127, errors: [], warnings: [], tail: [], lines: 0 });
  eq([silent.code, silent.transient], ["unknown", true]);
  const net = classifyRun({ exitCode: 1, errors: ["[download] Got error: Read timed out"], warnings: [], tail: [], lines: 5 });
  eq([net.code, net.transient], ["network", true]);
  const age = classifyRun({ exitCode: 1, errors: ["[youtube] x: Sign in to confirm your age"], warnings: [], tail: [], lines: 3 });
  eq([age.code, age.transient, age.message], ["age", false, "Sign in to confirm your age"]);
  // a section download: yt-dlp's (quiet) FFmpeg failed while reading from YouTube - retried once
  const clip = classifyRun({ exitCode: 1, errors: ["ffmpeg exited with code 4294967274"], warnings: [], tail: [], lines: 14 });
  eq([clip.code, clip.transient, clip.message], ["unknown", true, "FFmpeg stopped while downloading the clip (exit code 4294967274)"]);
  const clip403 = classifyRun({ exitCode: 1, errors: ["unable to download video data: HTTP Error 403: Forbidden", "ffmpeg exited with code 1"], warnings: [], tail: [], lines: 4 });
  eq([clip403.code, clip403.transient], ["forbidden", true], "a known cause keeps its code");
});

Deno.test("errors: locked files and denied access are not 'disk' or 'unknown'", () => {
  const c = (s: string) => classifyText(s);
  eq(c("Unable to rename file: [WinError 32] The process cannot access the file because it is being used by another process: 'a.mp4.part' -> 'a.mp4'"), "locked");
  eq(c("ERROR: unable to open for writing: [Errno 13] Permission denied: 'C:\\Users\\me\\Videos\\a.mp4.part'"), "access_denied");
  eq(c("ERROR: Postprocessing: PermissionError: [WinError 5] Access is denied: 'C:\\Users\\me\\Videos\\a.temp.mp4'"), "access_denied");
  eq(c("[WinError 10054] An existing connection was forcibly closed by the remote host"), "network");
  eq(c("[WinError 50] The request is not supported"), "unknown");
  const locked = classifyRun({ exitCode: 1, errors: ["Unable to rename file: [WinError 32] The process cannot access the file because it is being used by another process"], warnings: [], tail: [], lines: 9 });
  eq([locked.code, locked.transient], ["locked", true], "a lock is retried once (the temp files are kept)");
  const denied = classifyRun({ exitCode: 1, errors: ["unable to open for writing: [Errno 13] Permission denied: 'x.part'"], warnings: [], tail: [], lines: 9 });
  eq([denied.code, denied.transient], ["access_denied", false]);
});

// ---------------------------------------------------------------------------
async function tempBase(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "akif-unit-" });
}

function mklinkJ(link: string, target: string) {
  const r = new Deno.Command("cmd.exe", { args: ["/d", "/c", "mklink", "/J", link, target], stdin: "null", stdout: "null", stderr: "null" }).outputSync();
  assert(r.code === 0, `mklink /J ${link} failed`);
}

async function age(path: string, hours: number) {
  const t = new Date(Date.now() - hours * 3600_000);
  await Deno.utime(path, t, t);
}

Deno.test("tempdirs: cloud-sync folders are recognised", async () => {
  const roots = ["C:\\Users\\me\\OneDrive", "D:\\Dropbox (Firma)"];
  assert(isCloudSynced("C:\\Users\\me\\OneDrive\\Videos\\YT", roots));
  assert(isCloudSynced("c:\\users\\ME\\onedrive", roots));
  assert(isCloudSynced("D:\\Dropbox (Firma)\\x", roots));
  assert(isCloudSynced("C:\\Users\\me\\OneDrive - Contoso\\Videos", []), "OneDrive for Business folder name");
  assert(isCloudSynced("E:\\Sync\\Google Drive\\Videos", []));
  assert(isCloudSynced("G:\\My Drive\\YouTube", []), "Google Drive streaming drive");
  assert(isCloudSynced("C:\\Users\\me\\Dropbox\\Videos", []));
  assert(!isCloudSynced("C:\\Users\\me\\Downloads\\Akif YouTube", roots));
  assert(!isCloudSynced("C:\\Users\\me\\OneDriveBackup\\x", roots), "a name prefix is not a parent folder");
  // "/" is a separator on Windows too, in the environment and in the folder path
  const slashRoots = cloudSyncRoots((n) => (n === "OneDrive" ? "C:/Users/me/Sync Here" : undefined));
  eq(slashRoots, ["C:\\Users\\me\\Sync Here"]);
  assert(isCloudSynced("C:\\Users\\me\\Sync Here\\Videos", slashRoots));
  assert(isCloudSynced("C:/Users/me/Sync Here/Videos", ["C:/Users/me/Sync Here"]));
  assert(isCloudSynced("C:/Users/me/OneDrive - Contoso/Videos", []));
  assert(!isCloudSynced("C:/Users/me/Sync HereNot/x", slashRoots));
  const base = await tempBase();
  try {
    await Deno.mkdir(join(base, "Dropbox"));
    await Deno.writeTextFile(join(base, "Dropbox", "info.json"), JSON.stringify({ personal: { path: "C:\\Users\\me\\Dropbox", host: 1 }, business: { path: "D:\\Dropbox (Firma)" } }));
    const env: Record<string, string> = { OneDrive: "C:\\Users\\me\\OneDrive", OneDriveCommercial: "C:\\Users\\me\\OneDrive - Contoso", APPDATA: base, LOCALAPPDATA: join(base, "none") };
    eq(cloudSyncRoots((k) => env[k]), ["C:\\Users\\me\\OneDrive", "C:\\Users\\me\\OneDrive - Contoso", "C:\\Users\\me\\Dropbox", "D:\\Dropbox (Firma)"]);
    eq(cloudSyncRoots(() => undefined), []);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("tempdirs: a planted .akif-tmp junction is never used or swept through", async () => {
  if (Deno.build.os !== "windows") return;
  const base = await tempBase();
  try {
    const out = join(base, "out");
    const victim = join(base, "victim");
    await Deno.mkdir(out);
    await Deno.mkdir(join(victim, "deadbeef"), { recursive: true });
    await Deno.writeTextFile(join(victim, "deadbeef", JOB_MARKER), "1\n"); // even a forged marker must not help
    await Deno.writeTextFile(join(victim, "deadbeef", "important.txt"), "keep me");
    await age(join(victim, "deadbeef", JOB_MARKER), 13);
    await age(join(victim, "deadbeef", "important.txt"), 13);
    await age(join(victim, "deadbeef"), 13);
    mklinkJ(join(out, ".akif-tmp"), victim);
    eq(await createOutputTemp(out), null, "a junction .akif-tmp must be refused (the job uses its private folder)");
    await new Promise((r) => setTimeout(r, 100));
    assert(await pathExists(join(victim, "deadbeef", "important.txt")), "the junction target was swept");
    eq([...Deno.readDirSync(victim)].map((e) => e.name), ["deadbeef"], "nothing was created in the junction target");
    // cleanup of a job never removes the junction or anything behind it
    await removeOutputTemp(out, join(out, ".akif-tmp", "deadbeef"));
    assert(await pathExists(join(victim, "deadbeef", "important.txt")));
    assert(Deno.lstatSync(join(out, ".akif-tmp")).isSymlink, "the link is left alone");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("tempdirs: the stale sweep removes only old folders that carry the job marker", async () => {
  if (Deno.build.os !== "windows") return;
  const base = await tempBase();
  try {
    const out = join(base, "out");
    const root = join(out, ".akif-tmp");
    const victim = join(base, "victim");
    await Deno.mkdir(root, { recursive: true });
    await Deno.mkdir(victim);
    const mk = async (name: string, marker: boolean, hours: number) => {
      const d = join(root, name);
      await Deno.mkdir(d);
      await Deno.writeTextFile(join(d, "x.mp4.part"), "x");
      if (marker) await Deno.writeTextFile(join(d, JOB_MARKER), "1\n");
      for (const f of Deno.readDirSync(d)) await age(join(d, f.name), hours);
      await age(d, hours);
      return d;
    };
    const stale = await mk("aaaaaaaa", true, 13);
    const unmarked = await mk("bbbbbbbb", false, 13);
    const fresh = await mk("cccccccc", true, 1);
    const oddName = await mk("old-project", true, 13);
    await Deno.writeTextFile(join(victim, JOB_MARKER), "1\n");
    await Deno.writeTextFile(join(victim, "important.txt"), "keep me");
    await age(join(victim, JOB_MARKER), 13);
    await age(join(victim, "important.txt"), 13);
    await age(victim, 13);
    mklinkJ(join(root, "dddddddd"), victim);
    await sweepOutputTemp(root, await Deno.realPath(root));
    assert(!(await pathExists(stale)), "a stale marked job folder must be removed");
    assert(await pathExists(unmarked), "a folder without the marker was not created by the companion");
    assert(await pathExists(fresh), "a recently used folder may belong to a running job");
    assert(await pathExists(oddName), "only <8 hex> names are job folders");
    assert(await pathExists(join(victim, "important.txt")), "a link inside .akif-tmp must not be followed");
    // a new job folder gets the marker; cleanup keeps the shared .akif-tmp while other folders are in it
    const dir = await createOutputTemp(out);
    assert(dir && /\\\.akif-tmp\\[0-9a-f]{8}$/.test(dir), String(dir));
    assert((await Deno.lstat(join(dir!, JOB_MARKER))).isFile);
    await removeOutputTemp(out, dir!);
    assert(!(await pathExists(dir!)) && (await pathExists(root)));
    // moveFile: a rename on one volume
    await Deno.writeTextFile(join(fresh, "done.mp4"), "data");
    await moveFile(join(fresh, "done.mp4"), join(out, "done.mp4"));
    eq(await Deno.readTextFile(join(out, "done.mp4")), "data");
    assert(!(await pathExists(join(fresh, "done.mp4"))));
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("tempdirs: private job folders (cookies) of host processes that are gone are removed", async () => {
  if (Deno.build.os !== "windows") return;
  const base = await tempBase();
  try {
    const mine = join(base, `${Deno.pid}-aaaaaaaa`); // this test process is a running deno.exe
    const dead = join(base, "4000000000-bbbbbbbb");
    const other = join(base, "notes");
    for (const d of [mine, dead, other]) {
      await Deno.mkdir(d);
      await Deno.writeTextFile(join(d, "cookies.txt"), "# Netscape HTTP Cookie File\n");
    }
    await sweepPrivateTemp(base);
    assert(await pathExists(mine), "a running host's job folder must be kept");
    assert(!(await pathExists(dead)), "a dead host's cookies must be removed");
    assert(await pathExists(other), "foreign names are not touched");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("coord: other running hosts' markers count, stale ones are dropped", async () => {
  if (Deno.build.os !== "windows") return;
  const dir = await tempBase();
  const child = new Deno.Command(Deno.execPath(), { args: ["eval", "await new Promise((r) => setTimeout(r, 30000))"], stdin: "null", stdout: "null", stderr: "null" }).spawn();
  try {
    announce("jobs", dir);
    eq(othersDoing("jobs", dir), [], "the own marker does not count");
    Deno.writeTextFileSync(join(dir, "update-4000000000"), "x");
    eq(othersDoing("update", dir), [], "a marker of a process that is gone");
    assert(!(await pathExists(join(dir, "update-4000000000"))), "stale markers are removed");
    Deno.writeTextFileSync(join(dir, `update-${child.pid}`), "x");
    eq(othersDoing("update", dir), [child.pid], "another live host instance is updating");
    eq(othersDoing("jobs", dir), []);
    withdraw("jobs", dir);
    assert(!(await pathExists(join(dir, `jobs-${Deno.pid}`))));
  } finally {
    child.kill();
    await child.status;
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// start / cancel (lib/starts.ts): the job id is reserved before the output folder is awaited

/** A Starter with fake jobs and an output folder that is "created" only when the test says so. */
function makeStarter(over: Partial<StarterDeps> = {}) {
  const out: unknown[][] = []; // everything sent, in order: ["reply", id, data] | ["fail", id, code] | ["emit", msg]
  const launched: string[] = [];
  const canceledJobs: string[] = [];
  const running = new Set<string>();
  const folders: { task: unknown; resolve: (dir: string) => void; reject: (e: unknown) => void }[] = [];
  const jobs = {
    get size() {
      return running.size;
    },
    has: (id: string) => running.has(id),
    start: (id: string) => {
      running.add(id);
      launched.push(id);
      return new Promise<void>(() => {}); // runs until the test ends
    },
    cancel: (id: string) => {
      if (!running.has(id)) return false;
      canceledJobs.push(id);
      return true;
    },
  };
  const starter = new Starter({
    jobs,
    maxJobs: 8,
    resolveOutputDir: (task) => new Promise<string>((resolve, reject) => folders.push({ task, resolve, reject })),
    blocked: () => null,
    admit: () => null,
    ended: () => {},
    reply: (id, data = {}) => out.push(["reply", id, data]),
    fail: (id, code) => out.push(["fail", id, code]),
    emit: (msg) => out.push(["emit", msg]),
    ...over,
  });
  return { starter, out, launched, canceledJobs, folders };
}

const START_TASK = { kind: "video", url: W, videoId: "jNQXAC9IVRw" };

Deno.test("starts: a cancel while the output folder is prepared stops the job before it launches", async () => {
  const { starter, out, launched, folders } = makeStarter();
  const p = starter.start("r1", "j1", START_TASK);
  eq([starter.pending, starter.count, folders.length], [1, 1, 1], "the id is reserved synchronously");
  await starter.start("r2", "j1", START_TASK);
  eq(out, [["fail", "r2", "bad_task"]], "a second start with a reserved id is refused");
  assert(starter.cancel("j1"), "a cancel finds the reserved job (the host answers {}, not {found:false})");
  folders[0].resolve("C:\\out");
  await p;
  eq(launched, [], "a canceled reservation never launches the job");
  eq(out.slice(1), [["reply", "r1", { outDir: "C:\\out" }], ["emit", { event: "canceled", jobId: "j1" }]], "answer {outDir}, then the terminal event");
  eq(starter.pending, 0);
  assert(!starter.cancel("j1"), "afterwards the id is unknown again");
  // the id is free again
  const p2 = starter.start("r3", "j1", START_TASK);
  folders[1].resolve("C:\\out");
  await p2;
  eq(launched, ["j1"]);
  eq(out[out.length - 1], ["reply", "r3", { outDir: "C:\\out" }]);
});

Deno.test("starts: a cancel in the same tick as the folder is ready still wins; after the launch it reaches the job", async () => {
  const { starter, out, launched, canceledJobs, folders } = makeStarter();
  const p = starter.start("r1", "j1", START_TASK);
  folders[0].resolve("C:\\out"); // the start continues only in a later microtask...
  assert(starter.cancel("j1"), "...so this cancel still finds the reservation");
  await p;
  eq([launched, canceledJobs], [[], []]);
  eq(out.map((x) => x[0]), ["reply", "emit"]);
  const p2 = starter.start("r2", "j2", START_TASK);
  folders[1].resolve("C:\\out");
  await p2;
  eq(launched, ["j2"]);
  assert(starter.cancel("j2"), "a launched job is canceled by the job manager");
  eq(canceledJobs, ["j2"]);
});

Deno.test("starts: limit counts reserved starts; a refused folder or an update releases the reservation", async () => {
  let updating: string | null = null;
  const { starter, out, launched, folders } = makeStarter({ maxJobs: 2, blocked: () => updating });
  const a = starter.start("r1", "a", START_TASK);
  const b = starter.start("r2", "b", START_TASK);
  await starter.start("r3", "c", START_TASK);
  eq(out, [["fail", "r3", "busy"]], "two starts waiting for their folders fill a limit of 2");
  folders[0].reject(new BadTask("cannot create the output folder"));
  await a;
  eq(out[1], ["fail", "r1", "bad_task"]);
  updating = "yt-dlp is being updated";
  folders[1].resolve("C:\\out");
  await b;
  eq(out[2], ["fail", "r2", "busy"], "an update that started during the wait refuses the start");
  eq([launched, starter.pending], [[], 0], "nothing launched, no reservation left");
  updating = null;
  const again = starter.start("r4", "a", START_TASK);
  folders[2].resolve("C:\\out");
  await again;
  eq(launched, ["a"], "the ids are free again");
  await starter.start("r5", "x y", START_TASK);
  await starter.start("r6", "z", { kind: "exe" });
  eq(out.slice(-2), [["fail", "r5", "bad_task"], ["fail", "r6", "bad_task"]]);
  eq(folders.length, 3, "invalid requests never touch the output folder");
});

Deno.test("starts: another host instance updating yt-dlp refuses the start at launch time", async () => {
  const { starter, out, launched, folders } = makeStarter({ admit: () => "another window updates yt-dlp" });
  const p = starter.start("r1", "j1", START_TASK);
  folders[0].resolve("C:\\out");
  await p;
  eq([out, launched], [[["fail", "r1", "busy"]], []]);
  starter.cancelPending(); // shutdown with nothing pending: no effect
  const q = starter.start("r2", "j2", START_TASK);
  starter.cancelPending(); // host shutdown while a start waits
  folders[1].resolve("C:\\out");
  await q;
  eq(out.slice(1), [["reply", "r2", { outDir: "C:\\out" }], ["emit", { event: "canceled", jobId: "j2" }]]);
  eq(launched, []);
});

// ---------------------------------------------------------------------------
// folder picker blocked by a policy of the organization

const POWERSHELL_EXE = `${Deno.env.get("SystemRoot") ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

async function powershell(command: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const r = await new Deno.Command(POWERSHELL_EXE, {
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout).trim() };
}

Deno.test("winshell: picker_failed explains policies (language mode, execution policy) instead of a bare exit code", () => {
  const clm = pickerFailureText({ mode: "ConstrainedLanguage" });
  assert(/ConstrainedLanguage mode/.test(clm) && /AppLocker/.test(clm) && /"Download folder"/.test(clm), clm);
  const gpo = pickerFailureText({ policy: "AllSigned", mode: "FullLanguage", stderr: "x", code: 1 });
  assert(/execution policy on this computer is AllSigned/.test(gpo) && /Group Policy/.test(gpo), gpo);
  assert(/is Restricted/.test(pickerFailureText({ policy: "Restricted", mode: "FullLanguage" })));
  const motw = pickerFailureText({ policy: "RemoteSigned", mode: "FullLanguage", stderr: "+ FullyQualifiedErrorId : UnauthorizedAccess", code: 1 });
  assert(/\(RemoteSigned\) did not allow/.test(motw) && /install\.bat/.test(motw), motw);
  eq(pickerFailureText({ policy: "Bypass", mode: "FullLanguage", stderr: "boom", code: 1 }), "the folder picker failed (exit 1)");
  assert(/ConstrainedLanguage mode/.test(pickerFailureText({ stderr: "FullyQualifiedErrorId : MethodInvocationNotSupportedInConstrainedLanguage" })));
});

Deno.test("winshell: an execution policy that blocks the picker script gives a clear picker_failed reason", async () => {
  if (Deno.build.os !== "windows") return;
  // A Group Policy execution policy would win over the AllSigned set below and let the dialog open: skip then.
  const gp = await powershell("[string](Get-ExecutionPolicy -Scope MachinePolicy) + ',' + [string](Get-ExecutionPolicy -Scope UserPolicy)");
  if (gp.out !== "Undefined,Undefined") return;
  let kill = null as (() => void) | null;
  const r = await pickFolder({ executionPolicy: "AllSigned", timeoutMs: 30_000, title: "unit test - must not open", onSpawn: (k) => (kill = k) });
  eq(r.ok, false, JSON.stringify(r));
  assert(/execution policy on this computer is AllSigned/.test(r.error ?? ""), String(r.error));
  // The picker's PowerShell has exited (before the policy check ran): what host.ts calls on shutdown must do nothing
  // now, instead of killing whatever process has been given that PID since.
  assert(kill, "onSpawn hands over a kill function");
  kill();
});

Deno.test("winshell: under Constrained Language Mode the picker script answers language_mode (no dialog)", async () => {
  if (Deno.build.os !== "windows") return;
  const base = await Deno.makeTempDir({ prefix: "akif-unit-" });
  try {
    // A session switched to ConstrainedLanguage runs the scripts it calls in that mode too: check that first, so
    // the real picker script below can never open its dialog.
    const probe = join(base, "mode.ps1");
    await Deno.writeTextFile(probe, "Write-Output ([string]$ExecutionContext.SessionState.LanguageMode)\r\n");
    const clm = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; & $env:AKIF_UNIT_PS1";
    const p = await powershell(clm, { AKIF_UNIT_PS1: probe });
    if (p.out !== "ConstrainedLanguage") return;
    const script = fileUrlToPath(new URL("../host/lib/ps/pick_folder_vista.ps1", import.meta.url));
    const r = await powershell(clm, { AKIF_UNIT_PS1: script, AKIF_PICK_TITLE: "unit test - must not open", AKIF_PICK_OWNER: "0" });
    eq(JSON.parse(r.out), { ok: false, reason: "language_mode", mode: "ConstrainedLanguage" });
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("config: App Execution Aliases (winget.exe) count as present", () => {
  const p = `${Deno.env.get("LOCALAPPDATA")}\\Microsoft\\WindowsApps\\winget.exe`;
  try {
    if (!Deno.lstatSync(p).isSymlink) return;
  } catch {
    return; // no winget on this machine
  }
  assert(isFile(p), "winget.exe (APPEXECLINK) must be found: Deno.statSync throws os error 1920 on it");
  assert(!isFile(p + ".missing"));
  assert(!isFile(Deno.env.get("LOCALAPPDATA")!), "a folder is not a file");
});

Deno.test("log: an instance whose log was rotated by another host continues in the new host.log", async () => {
  const base = await tempBase();
  try {
    const p = join(base, "host.log");
    initLog(p);
    log("info", "first line");
    Deno.renameSync(p, p + ".1"); // another host instance rotated the shared log
    for (let i = 0; i < 205; i++) log("debug", `line ${i}`);
    log("info", "after the rotation");
    closeLog();
    assert(Deno.readTextFileSync(p).includes("after the rotation"), "lines after the rotation must reach host.log");
    assert(Deno.readTextFileSync(p + ".1").includes("first line"));
  } finally {
    closeLog();
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("tools: extractZip works below a folder name outside the ANSI code page", async () => {
  if (Deno.build.os !== "windows") return;
  const base = await tempBase();
  try {
    const src = join(base, "src");
    await Deno.mkdir(join(src, "pkg", "_internal"), { recursive: true });
    await Deno.writeTextFile(join(src, "pkg", "yt-dlp.exe"), "fake exe");
    await Deno.writeTextFile(join(src, "pkg", "_internal", "x.pyd"), "fake pyd");
    const tar = `${Deno.env.get("SystemRoot") ?? "C:\\Windows"}\\System32\\tar.exe`;
    const mk = await new Deno.Command(tar, { args: ["-a", "-cf", "t.zip", "-C", "pkg", "."], cwd: src, stdin: "null", stdout: "null", stderr: "null" }).output();
    assert(mk.code === 0, "creating the test zip failed");
    // "Şəhla Тест": no ANSI code page has both (tar.exe turned absolute paths like this into "?")
    const dir = join(base, "\u015E\u0259hla \u0422\u0435\u0441\u0442", "bin");
    await Deno.mkdir(join(dir, "yt-dlp.new"), { recursive: true });
    await Deno.copyFile(join(src, "t.zip"), join(dir, "yt-dlp-update.zip"));
    const r = await extractZip(dir, "yt-dlp-update.zip", "yt-dlp.new", 60000);
    eq(r.code, 0, r.stderr.join("\n"));
    eq(await Deno.readTextFile(join(dir, "yt-dlp.new", "yt-dlp.exe")), "fake exe");
    eq(await Deno.readTextFile(join(dir, "yt-dlp.new", "_internal", "x.pyd")), "fake pyd");
    let threw = false;
    try {
      await extractZip(dir, "\u015E.zip", "yt-dlp.new", 1000);
    } catch {
      threw = true;
    }
    assert(threw, "non-ASCII names must never reach tar.exe");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("tools: downloadFile continues a stalled transfer and stops at the update deadline", async () => {
  const body = new Uint8Array(300_000).map((_, i) => (i * 7) % 251);
  const requests: string[] = [];
  const ac = new AbortController();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen() {} }, (req) => {
    const range = req.headers.get("range");
    requests.push(range ?? "full");
    if (!range) {
      // a third of the file, then silence: the connection stays open but no more data comes
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body.slice(0, 100_000)); } });
      return new Response(stream, { headers: { "content-length": String(body.length) } });
    }
    const start = Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0);
    return new Response(body.slice(start), { status: 206, headers: { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } });
  });
  const url = `http://127.0.0.1:${server.addr.port}/yt-dlp_win.zip`;
  const base = await tempBase();
  try {
    const dest = join(base, "yt-dlp-update.zip");
    const n = await downloadFile(url, dest, new Budget(Date.now() + 30_000), 400);
    eq(n, body.length);
    eq(requests, ["full", "bytes=100000-"], "the second request must continue where the stalled one stopped");
    const got = await Deno.readFile(dest);
    assert(got.length === body.length && got.every((b, i) => b === body[i]), "resumed file differs");
    requests.length = 0;
    const t0 = Date.now();
    let code = "";
    try {
      await downloadFile(url, dest, new Budget(Date.now() + 1500), 60_000);
    } catch (e) {
      code = e instanceof StepError ? e.code : String(e);
    }
    eq(code, "update_timeout", "the overall update deadline must end a stalled download with its own code");
    assert(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  } finally {
    ac.abort();
    await server.finished;
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("netproxy: Windows ProxyServer / ProxyOverride values are read like Python's urllib reads them", () => {
  eq(proxyFromServer("proxy.corp:8080", "https"), "http://proxy.corp:8080");
  eq(proxyFromServer(" proxy.corp:8080 ", "http"), "http://proxy.corp:8080");
  eq(proxyFromServer("http=a:1;https=b:2;ftp=c:3", "https"), "http://b:2");
  eq(proxyFromServer("http=a:1;https=b:2", "http"), "http://a:1");
  eq(proxyFromServer("http=a:1", "https"), "http://a:1", "no https entry: https uses the http one, as in yt-dlp");
  eq(proxyFromServer("HTTP=a:1;ftp=c:3", "https"), "http://a:1");
  eq(proxyFromServer("https=b:2", "http"), null, "no http entry: http goes direct");
  eq(proxyFromServer("https=https://secure.corp:443", "https"), "https://secure.corp:443");
  eq(proxyFromServer("socks=s:1080", "https"), null, "SOCKS (v4 in Windows) is not supported");
  eq(proxyFromServer("socks5://s:1080", "https"), null);
  eq(proxyFromServer("", "https"), null);
  assert(bypassesProxy("intranet", "<local>"));
  assert(!bypassesProxy("github.com", "<local>"));
  assert(bypassesProxy("GitHub.com", "*.corp.example; github.com"));
  assert(bypassesProxy("api.github.com", "*.github.com"));
  assert(!bypassesProxy("github.com", "*.github.com"));
  assert(!bypassesProxy("github.com.evil.example", "github.com"), "a whole-name match, not a prefix");
  assert(bypassesProxy("10.1.2.3", "10.*"));
  assert(!bypassesProxy("github.com", ""));
  assert(inNoProxy("github.com", "localhost, .GitHub.com"));
  assert(inNoProxy("api.github.com", "github.com"), "a name covers its subdomains");
  assert(!inNoProxy("notgithub.com", "github.com"));
  assert(inNoProxy("github.com", "localhost,*"));
  assert(!inNoProxy("github.com", "") && !inNoProxy("github.com", " , "));
});

Deno.test("netproxy: route = environment variable, else the enabled Windows proxy, else direct", () => {
  const S = (s: Partial<WinProxySettings>) => () => ({ enabled: false, server: "", override: "", autoConfigUrl: "", ...s });
  const noEnv = () => undefined;
  const url = "https://github.com/yt-dlp/yt-dlp";
  const env = routeFor(url, (n) => (n === "HTTPS_PROXY" ? "http://env-proxy:3128" : undefined), S({ enabled: true, server: "win:8080" }));
  assert(!env.client && /HTTPS_PROXY/.test(env.via), "Deno applies HTTPS_PROXY itself; the Windows proxy is not used then");
  const httpOnly = routeFor(url, (n) => (n === "HTTP_PROXY" ? "http://env-proxy:3128" : undefined), S({ enabled: true, server: "win:8080" }));
  try {
    assert(httpOnly.client && /HTTP_PROXY/.test(httpOnly.via), "like yt-dlp, https goes through HTTP_PROXY when HTTPS_PROXY is not set");
  } finally {
    httpOnly.close();
  }
  const envs = (vars: Record<string, string>) => (n: string) => vars[n];
  const noProxy = routeFor(url, envs({ HTTP_PROXY: "env-proxy:3128", NO_PROXY: "localhost,.github.com" }), S({ enabled: true, server: "win:8080" }));
  assert(!noProxy.client && /NO_PROXY/.test(noProxy.via), noProxy.via);
  const plainHttp = routeFor("http://example.com/x", envs({ HTTPS_PROXY: "http://env-proxy:3128" }), S({ enabled: true, server: "win:8080" }));
  assert(!plainHttp.client && /direct/.test(plainHttp.via), `only HTTPS_PROXY: http goes direct (${plainHttp.via})`);
  const off = routeFor(url, noEnv, S({ enabled: false, server: "win:8080" }));
  assert(!off.client && /direct/.test(off.via), "ProxyEnable = 0: direct");
  const pac = routeFor(url, noEnv, S({ autoConfigUrl: "http://wpad/proxy.pac" }));
  assert(!pac.client && /automatic proxy configuration/.test(pac.hint), pac.hint);
  const bypass = routeFor(url, noEnv, S({ enabled: true, server: "win:8080", override: "*.example;github.com" }));
  assert(!bypass.client && /bypass/.test(bypass.via), bypass.via);
  const win = routeFor(url, noEnv, S({ enabled: true, server: "http=a:1;https=win:8080" }));
  try {
    assert(win.client, "a client for the Windows proxy");
    eq(win.via, "the Windows proxy http://win:8080");
  } finally {
    win.close();
  }
  const winHttp = routeFor(url, noEnv, S({ enabled: true, server: "http=a:1" }));
  try {
    assert(winHttp.client, "no https= entry: https uses the http= proxy, as in yt-dlp");
    eq(winHttp.via, "the Windows proxy http://a:1");
  } finally {
    winHttp.close();
  }
  const broken = routeFor(url, noEnv, () => {
    throw new Error("registry unavailable");
  });
  assert(!broken.client && /direct/.test(broken.via));
});

Deno.test("netproxy: with only HTTP_PROXY set, an https request goes through that proxy (CONNECT), as in yt-dlp", async () => {
  if (Deno.env.get("NO_PROXY")) return; // Deno applies the real NO_PROXY to the client, too
  // A local listener plays the proxy; github.invalid does not exist, so nothing leaves this computer.
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const seen: string[] = [];
  const serving = (async () => {
    for await (const conn of listener) {
      const buf = new Uint8Array(1024);
      const n = await conn.read(buf).catch(() => null);
      if (n) seen.push(new TextDecoder().decode(buf.subarray(0, n)).split("\r\n")[0]);
      conn.close();
    }
  })();
  const proxy = `127.0.0.1:${(listener.addr as Deno.NetAddr).port}`; // no scheme: http, as in yt-dlp
  const route = routeFor("https://github.invalid/yt-dlp/yt-dlp", (n) => (n === "HTTP_PROXY" ? proxy : undefined), () => {
    throw new Error("a proxy variable is set: the Windows settings must not be read");
  });
  try {
    assert(route.client, route.via);
    await fetch("https://github.invalid/yt-dlp/yt-dlp/releases/latest", { client: route.client, signal: AbortSignal.timeout(15_000) })
      .then((r) => r.body?.cancel(), () => {}); // the listener closes the tunnel: the request fails
    eq(seen, ["CONNECT github.invalid:443 HTTP/1.1"]);
  } finally {
    route.close();
    listener.close();
    await serving;
  }
});

Deno.test("tools: downloads go through the proxy client; the newest release tag comes from the /releases/latest redirect", async () => {
  const body = new Uint8Array(50_000).map((_, i) => (i * 13) % 251);
  const seen: string[] = [];
  let latestStatus = 503;
  const ac = new AbortController();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen() {} }, (req) => {
    seen.push(req.url);
    if (req.url.endsWith("/releases/latest")) {
      if (latestStatus === 503) {
        latestStatus = 302; // one transient failure first: it is retried
        return new Response("busy", { status: 503 });
      }
      if (latestStatus === 302) return new Response(null, { status: 302, headers: { location: "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.11.01" } });
      return new Response("<html>no redirect</html>");
    }
    return new Response(body.slice());
  });
  const base = await tempBase();
  const proxy = Deno.createHttpClient({ proxy: { url: `http://127.0.0.1:${server.addr.port}` } });
  try {
    // an HTTP proxy receives the request in absolute form: the test server plays the proxy and the origin
    const dest = join(base, "yt-dlp-update.zip");
    eq(await downloadFile("http://github.invalid/yt-dlp_win.zip", dest, new Budget(Date.now() + 20_000), 5000, proxy), body.length);
    eq(seen, ["http://github.invalid/yt-dlp_win.zip"], "the request went to the proxy");
    eq((await Deno.readFile(dest)).length, body.length);
    const origin = `http://127.0.0.1:${server.addr.port}/yt-dlp/yt-dlp`;
    eq(await latestReleaseTag(origin, new Budget(Date.now() + 20_000)), "2026.11.01");
    latestStatus = 200;
    eq(await latestReleaseTag(origin, new Budget(Date.now() + 20_000)), null, "no redirect: no tag (the caller falls back)");
  } finally {
    proxy.close();
    ac.abort();
    await server.finished;
    await Deno.remove(base, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
const JSON3_MANUAL = JSON.stringify({
  wireMagic: "pb3",
  pens: [{}],
  events: [
    { tStartMs: 0, dDurationMs: 5000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
    { tStartMs: 33, dDurationMs: 3000, segs: [{ utf8: "\u200b\u200b<font color=\"#ffff00\">Hello</font> there\u200b" }] },
    { tStartMs: 2500, dDurationMs: 2000, segs: [{ utf8: "second line\n" }, { utf8: "with two rows" }] },
    { tStartMs: 6000, dDurationMs: 1500, segs: [{ utf8: "\n" }] },
    { tStartMs: 7000, dDurationMs: 1000, segs: [{ utf8: "\u015E\u0259ki & \u0420\u0443\u0441" }] },
  ],
});
const JSON3_ASR = JSON.stringify({
  wireMagic: "pb3",
  events: [
    { tStartMs: 0, dDurationMs: 4000, id: 1, wWinId: 1 },
    { tStartMs: 160, dDurationMs: 3800, wWinId: 1, segs: [{ utf8: "hi", acAsrConf: 0 }, { utf8: " everyone", tOffsetMs: 400 }] },
    { tStartMs: 1900, wWinId: 1, aAppend: 1, segs: [{ utf8: "\n" }] },
    { tStartMs: 1910, dDurationMs: 4000, wWinId: 1, segs: [{ utf8: "welcome" }, { utf8: " back", tOffsetMs: 300 }] },
  ],
});

Deno.test("subs: json3 -> srt / txt", () => {
  const cues = parseJson3(JSON3_MANUAL);
  eq(cues.length, 3);
  eq(cues[0], { start: 33, end: 2500, text: '<font color="#ffff00">Hello</font> there' }, "overlap clipped, U+200B removed");
  eq(cues[1].text, "second line\nwith two rows");
  const srt = toSrt(cues);
  assert(srt.startsWith("1\r\n00:00:00,033 --> 00:00:02,500\r\n"), srt);
  assert(!srt.includes("\u200b"));
  const txt = toTxt(cues);
  eq(txt, "Hello there\r\nsecond line with two rows\r\n\u015E\u0259ki & \u0420\u0443\u0441\r\n", "a caption's lines are joined (same layout as the in-browser TXT)");
  const asr = parseJson3(JSON3_ASR);
  eq(asr.map((c) => [c.start, c.end, c.text]), [[160, 1910, "hi everyone"], [1910, 5910, "welcome back"]]);
  eq(convertSubtitle("not json", "json3", "srt"), null);
});

Deno.test("subs: vtt with rolling captions -> txt without duplicates", () => {
  const vtt = "WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.160 --> 00:00:01.900 align:start position:0%\nhi<00:00:00.560><c> everyone</c>\n\n" +
    "00:00:01.900 --> 00:00:04.000 align:start position:0%\nhi everyone\nwelcome<00:00:02.200><c> back</c>\n\n00:00:04.000 --> 00:00:05.000\nwelcome back &amp; more\n";
  const cues = parseVttOrSrt(vtt);
  eq(cues.length, 3);
  eq(toTxt(cues), "hi everyone\r\nwelcome back\r\nwelcome back & more\r\n");
  const srt = convertSubtitle(vtt, "vtt", "srt")!;
  assert(srt.includes("00:00:01,900 --> 00:00:04,000"), srt);
});

Deno.test("subs: txt joins a caption's lines, keeps dialogue lines apart, writes rolling overlaps once", () => {
  const cues = [
    { start: 0, end: 1000, text: "-One dollar car?\n-Yes, a dollar." },
    { start: 1000, end: 2000, text: "And this one\ncosts a lot" },
    { start: 2000, end: 3000, text: "costs a lot\n[Music]" },
  ];
  eq(toTxt(cues), "-One dollar car?\r\n-Yes, a dollar.\r\nAnd this one costs a lot\r\n[Music]\r\n");
});

Deno.test("subs: simultaneous json3 events (machine translation) add only their new lines", () => {
  const j = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Arkamda\ndünya" }] },
      { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: "Arkamda\ndünya" }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: "birinin\nfiyatı" }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: "fiyatı\nyüksek" }] },
    ],
  });
  eq(parseJson3(j).map((c) => [c.start, c.end, c.text]), [[0, 1200, "Arkamda\ndünya"], [2000, 3000, "birinin\nfiyatı\nyüksek"]]);
});

Deno.test("subs: real VTT from research (if present)", async () => {
  // Optional local sample: a real VTT exported during development. Not shipped; the test is skipped when absent.
  const p = "research-sample.en.vtt";
  let text: string;
  try {
    text = await Deno.readTextFile(p);
  } catch {
    return; // sample not available on this machine
  }
  const cues = parseVttOrSrt(text);
  assert(cues.length > 50, `cues: ${cues.length}`);
  const txt = toTxt(cues);
  assert(!txt.includes("\u200b") && !/<[a-z]/i.test(txt), "no markup or zero-width chars in txt");
});
