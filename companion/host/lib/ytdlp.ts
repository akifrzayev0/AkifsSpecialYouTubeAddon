// lib/ytdlp.ts - yt-dlp argument builder (spec section 8.4). Pure functions.
// Verified with yt-dlp 2026.10.26 + Deno 2.8.1 + ffmpeg 8.1.1.

import type { Container, Section, Task } from "./task.ts";

export const DL_TEMPLATE = "download:[AKIF:DL] %(.{progress.status,progress.downloaded_bytes,progress.total_bytes," +
  "progress.total_bytes_estimate,progress.speed,progress.eta,progress.fragment_index,progress.fragment_count," +
  "info.id,info.format_id,info.vcodec,info.acodec,info.playlist_index,info.n_entries})j";
export const PP_TEMPLATE = "postprocess:[AKIF:PP] %(.{progress.status,progress.postprocessor,info.id})j";
export const INFO_PRINT = "before_dl:[AKIF:INFO] %(.{id,title,uploader,channel,upload_date,duration,format_id,ext," +
  "filesize_approx,height,width,fps,dynamic_range,playlist_index,playlist_autonumber,n_entries,playlist_count," +
  "playlist_title,playlist_id})j";
export const DONE_PRINT = "after_move:[AKIF:DONE] %(.{id,filepath,playlist_index,playlist_autonumber})j";
// after_move does not fire with --skip-download; after_video does
export const SUBS_PRINT = "after_video:[AKIF:SUBS] %(requested_subtitles.:.{ext,filepath})j";

export interface ArgsContext {
  /** -P home: (final folder; the job temp dir for jobs the host finishes itself) */
  homeDir: string;
  /** -P temp: (per-job temp dir, always deleted afterwards) */
  tempDir: string;
  /** absolute deno.exe for yt-dlp's JS challenge solver */
  denoPath: string;
  /** absolute ffmpeg.exe (yt-dlp finds ffprobe next to it) */
  ffmpegPath: string | null;
  cookiesFile: string | null;
  /** -o output template */
  template: string;
}

/** Seconds -> "3", "3.5", "61.25" (yt-dlp/ffmpeg accept plain seconds). */
export function fmtSeconds(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 75.5 -> "01-15.5", 3723 -> "1-02-03" (file-name safe clock). */
export function fileClock(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const s = Math.floor(totalMs / 1000);
  const ms = totalMs % 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  let out = h > 0 ? `${h}-${pad2(m)}-${pad2(s % 60)}` : `${pad2(m)}-${pad2(s % 60)}`;
  if (ms) out += "." + String(ms).padStart(3, "0").replace(/0+$/, "");
  return out;
}

export function clipLabel(s: Section): string {
  return `clip ${fileClock(s.start)} - ${fileClock(s.end)}`;
}

const RES_STEPS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 2880, 4320];

/**
 * The step YouTube names a width × height format after: the one whose 16:9 frame (portrait: 9:16) it fills.
 * 1920×800 (letterboxed) -> 1080, 1080×1920 (vertical) -> 1080, 4096×2160 (DCI 4K) -> 2160.
 * Same rule as AYT.util.jobLabel in the extension, so the file name matches the panel row and the job title.
 */
export function resolutionStep(width: number | null | undefined, height: number): number {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!(w > 0)) return h;
  const fill = Math.max(Math.min(w, h), (Math.max(w, h) * 9) / 16);
  let step = RES_STEPS[0];
  for (const r of RES_STEPS) if (Math.abs(r - fill) <= Math.abs(step - fill)) step = r;
  return step;
}

/** "2160p60 HDR" for a video task with a height, "" for best quality. Named by YouTube's resolution step. */
export function videoLabel(task: Pick<Task, "height" | "width" | "fps" | "hdr">): string {
  if (task.height == null) return "";
  const res = resolutionStep(task.width, task.height);
  let s = `${res}p`;
  if (task.fps && task.fps > 30) s += String(task.fps);
  if (task.hdr === true) s += " HDR";
  return s;
}

/** " (1080p60)", " (clip 01-00 - 02-30)", " (1080p) (clip ...)" or "" (audio, whole video). */
export function fileSuffix(task: Task): string {
  const parts: string[] = [];
  if (task.kind === "video") {
    const v = videoLabel(task);
    if (v) parts.push(v);
  }
  if (task.section && !task.playlist && task.kind !== "subtitle") parts.push(clipLabel(task.section));
  return parts.map((p) => ` (${p})`).join("");
}

/** Characters the file name template adds besides the title, per style (UTF-16 units, upper bound). */
export function styleOverhead(style: Task["filenameStyle"]): number {
  switch (style) {
    case "title_id":
      return 14; // " [xxxxxxxxxxx]"
    case "channel_title":
      return 63; // 60 + " - "
    case "date_title":
      return 11; // "2024-01-31 "
    default:
      return 0;
  }
}

/** Output template for yt-dlp-named files (video/audio jobs). */
export function outputTemplate(task: Task, titleBytes: number): string {
  const sfx = fileSuffix(task).replaceAll("%", "%%");
  const T = `%(title).${Math.max(16, Math.floor(titleBytes))}B`;
  let base: string;
  switch (task.filenameStyle) {
    case "title_id":
      base = `${T} [%(id)s]${sfx}`;
      break;
    case "channel_title":
      base = `%(uploader,channel|Unknown).60B - ${T}${sfx}`;
      break;
    case "date_title":
      base = `%(upload_date>%Y-%m-%d|0000-00-00)s ${T}${sfx}`;
      break;
    default:
      base = `${T}${sfx}`;
  }
  const prefix = task.playlist ? "%(playlist_title,playlist_id|Playlist).80B\\%(playlist_index)03d - " : "";
  return `${prefix}${base}.%(ext)s`;
}

// ---------------------------------------------------------------------------
// Format selection

const VC: Record<string, string> = {
  av01: "[vcodec^=av01]",
  avc1: "[vcodec^=avc1]",
  vp9: "[vcodec~='^vp0?9']",
};

/** Video codec preference order (spec 8.4) - the size estimate in the video panel uses the same order. */
export function codecOrder(container: Container, codec: Task["codec"]): string[] {
  if (container === "webm") return ["vp9", "av01"];
  if (codec === "compat") return ["avc1", "av01", "vp9"];
  return container === "mkv" ? ["av01", "vp9", "avc1"] : ["av01", "avc1", "vp9"];
}

function uniq(a: string[]): string[] {
  return [...new Set(a)];
}

/** Audio part of a merged video selection (always used in parentheses: `bv...+(A)`). */
export function audioPart(container: Container, codec: Task["codec"], lang: string | null): string {
  const L = lang ? `[language^=${lang}]` : "";
  let alts: string[];
  if (container === "mp4" || (container === "mkv" && codec === "compat")) alts = [`ba[ext=m4a]${L}`, "ba[ext=m4a]", `ba${L}`, "ba"];
  else if (container === "webm") alts = [`ba[acodec=opus]${L}`, "ba[acodec=opus]", "ba"];
  else alts = [`ba${L}`, "ba"];
  return uniq(alts).join("/");
}

export interface Selection {
  format: string;
  sort: string | null;
}

const COMPAT_SORT = "vcodec:h264,res,acodec:aac";

/** -f (and -S) for a video job. */
export function videoSelection(task: Task): Selection {
  const A = `(${audioPart(task.container, task.codec, task.audioLang)})`;
  const H = task.height;
  const hdrF = task.hdr === true ? "[dynamic_range!=SDR]" : task.hdr === false ? "[dynamic_range=SDR]" : "";
  const fpsF = task.fps == null ? "" : task.fps > 30 ? "[fps>30]" : "[fps<=30]";
  const compat = task.codec === "compat" && task.container !== "webm";
  const webmOnly = task.container === "webm" ? "[vcodec~='^(vp0?9|av0?1)']" : "";

  if (H == null) {
    // best quality
    const alts = uniq([
      webmOnly && `bv*${hdrF}${fpsF}${webmOnly}+${A}`,
      `bv*${hdrF}${fpsF}+${A}`,
      `bv*+${A}`,
      "b",
    ].filter(Boolean));
    return { format: alts.join("/"), sort: compat ? COMPAT_SORT : null };
  }
  if (task.playlist) {
    // [height<=H] throughout; resolution must win over codec here, so codecs are ordered by
    // yt-dlp's default sort (res > fps > hdr > vcodec av01 > vp9 > avc1) instead of alternatives.
    const V = `[height<=${H}]${hdrF}${fpsF}`;
    const alts = uniq([
      webmOnly && `bv${V}${webmOnly}+${A}`,
      `bv${V}+${A}`,
      `bv[height<=${H}]+${A}`,
      `b[height<=${H}]`,
      `bv*+ba`,
      "b",
    ].filter(Boolean));
    return { format: alts.join("/"), sort: compat ? COMPAT_SORT : null };
  }
  const V = `[height=${H}]${hdrF}${fpsF}`;
  const alts = [
    ...codecOrder(task.container, task.codec).map((c) => `bv${V}${VC[c]}+${A}`),
    `bv${V}+${A}`,
    `bv[height=${H}]+${A}`,
    `bv[height<=${H}]+${A}`,
    `b[height<=${H}]`,
    "bv*+ba",
    "b",
  ];
  return { format: uniq(alts).join("/"), sort: null };
}

/** -f for an audio job: same-codec targets are copied by yt-dlp instead of re-encoded. */
export function audioSelection(task: Task): string {
  const L = task.audioLang ? `[language^=${task.audioLang}]` : "";
  let alts: string[];
  if (task.audioFormat === "m4a") alts = [`ba[ext=m4a]${L}`, "ba[ext=m4a]", `ba${L}`, "ba"];
  else if (task.audioFormat === "opus") alts = [`ba[acodec=opus]${L}`, "ba[acodec=opus]", `ba${L}`, "ba"];
  else alts = [`ba${L}`, "ba"];
  alts.push("b"); // last resort: extract the audio of a muxed format
  return uniq(alts).join("/");
}

/**
 * Audio jobs whose section is cut by the host after yt-dlp finished (stream copy, exact to the frame).
 * Only m4a: yt-dlp leaves an m4a source untouched ("already in target format"), so no ffmpeg step
 * exists where a --ppa cut could happen. Every other target goes through ExtractAudio's ffmpeg run
 * (a re-encode, or an opus webm->ogg stream copy) which takes the cut via --ppa - before the cover
 * is embedded, which matters for opus: ffmpeg cannot write cover art back into Ogg.
 */
export function hostCutsAudio(task: Task): boolean {
  return task.kind === "audio" && !!task.section && !task.playlist && task.audioFormat === "m4a";
}

/** yt-dlp --download-sections with the two ffmpeg fixes (request_size against the DASH hang; progress on stdout). */
export function sectionArgs(s: Section): string[] {
  return [
    "--download-sections", `*${fmtSeconds(s.start)}-${fmtSeconds(s.end)}`,
    "--downloader-args", "ffmpeg_i:-request_size 10485760",
    "--downloader-args", "ffmpeg_o:-progress pipe:1 -stats_period 1",
  ];
}

/** Subtitle keys for --sub-langs, in order of preference. */
export function subtitleKeys(task: Task): { keys: string[]; auto: boolean } {
  const lang = task.subLang ?? "en";
  if (task.subTranslateTo) return { keys: [`${task.subTranslateTo}-${lang}`, task.subTranslateTo], auto: true };
  if (task.subAuto) return { keys: [`${lang}-orig`, lang], auto: true };
  return { keys: [lang], auto: false };
}

/** GIF source height: the smallest common resolution that still covers the GIF width. */
export function gifSourceHeight(gifWidth: number): number {
  return gifWidth <= 480 ? 480 : 720;
}

/** Full yt-dlp argv (without the executable). */
export function buildYtDlpArgs(task: Task, ctx: ArgsContext): string[] {
  const a: string[] = [
    "--ignore-config", "--encoding", "utf-8",
    "--newline", "--progress", "--progress-delta", "0.5",
    "--progress-template", DL_TEMPLATE,
    "--progress-template", PP_TEMPLATE,
    "--print", INFO_PRINT,
    "--print", DONE_PRINT,
    "-P", `home:${ctx.homeDir}`,
    "-P", `temp:${ctx.tempDir}`,
    "-o", ctx.template,
    "--no-mtime",
    task.playlist ? "--yes-playlist" : "--no-playlist",
    "--js-runtimes", `deno:${ctx.denoPath}`,
    "--retries", "10", "--fragment-retries", "10", "--extractor-retries", "5",
    // Antivirus, cloud sync clients and the search indexer briefly lock files that were just written. yt-dlp's
    // default is 3 retries without a pause (WinError 32); retry for up to ~30 s with growing pauses instead.
    "--file-access-retries", "10", "--retry-sleep", "file_access:exp=0.2:5",
  ];
  if (ctx.ffmpegPath) a.push("--ffmpeg-location", ctx.ffmpegPath);
  if (ctx.cookiesFile) a.push("--cookies", ctx.cookiesFile);
  // -i: a failing playlist item (or an embedded subtitle) must not abort the rest; real
  // failures still print ERROR lines and set a non-zero exit code.
  let ignoreErrors = task.playlist;
  if (task.playlist && task.playlistItems) a.push("--playlist-items", task.playlistItems);
  // Chapters: --embed-metadata embeds them too unless --no-embed-chapters is given, so always say it explicitly.
  // Never for a clip: yt-dlp does not shift chapters for sections (verified: a 10 s clip got all 11 chapters of the
  // 937 s video, at their original times). A section on a playlist is ignored, so playlists keep them.
  const clip = !!task.section && !task.playlist;
  const chapterArg = task.embedChapters && !clip ? "--embed-chapters" : "--no-embed-chapters";

  switch (task.kind) {
    case "video": {
      const sel = videoSelection(task);
      a.push("-f", sel.format);
      if (sel.sort) a.push("-S", sel.sort);
      a.push("--merge-output-format", task.container === "webm" ? "webm/mkv" : task.container);
      if (task.embedMetadata) a.push("--embed-metadata");
      a.push(chapterArg);
      // jpg like audio jobs: otherwise yt-dlp turns the webp thumbnail into a ~1.4 MB png cover inside every file
      if (task.embedThumbnail && task.container !== "webm") a.push("--embed-thumbnail", "--convert-thumbnails", "jpg");
      if (task.embedSubtitles) {
        const langs = uniq([`${task.uiLang ?? task.subLang ?? "en"}.*`, "en.*"]);
        a.push("--embed-subs", "--sub-langs", langs.join(","));
        ignoreErrors = true; // a missing/blocked subtitle must not fail the video
      }
      if (task.section && !task.playlist) {
        a.push(...sectionArgs(task.section));
        if (task.preciseCut) a.push("--force-keyframes-at-cuts");
      }
      break;
    }
    case "audio": {
      a.push("-f", audioSelection(task), "-x", "--audio-format", task.audioFormat);
      if (task.audioFormat === "mp3") a.push("--audio-quality", `${task.bitrate}K`);
      if (task.embedMetadata) a.push("--embed-metadata");
      a.push(chapterArg);
      // wav cannot hold a thumbnail: --embed-thumbnail would be a fatal post-processing error
      if (task.embedThumbnail && task.audioFormat !== "wav") a.push("--embed-thumbnail", "--convert-thumbnails", "jpg");
      if (task.section && !task.playlist && !hostCutsAudio(task)) {
        // stream-copy sections are not exact (3-9 s came out as 9 s): cut inside the one encode instead
        a.push("--ppa", `ExtractAudio+ffmpeg_o:-ss ${fmtSeconds(task.section.start)} -to ${fmtSeconds(task.section.end)}`);
      }
      break;
    }
    case "subtitle": {
      const { keys, auto } = subtitleKeys(task);
      // srt/txt are built by the host from json3 (clean cues, no rolling duplicates, no U+200B)
      const fmt = task.subFormat === "srt" || task.subFormat === "txt" ? "json3/vtt/best" : `${task.subFormat}/best`;
      a.push("--skip-download", auto ? "--write-auto-subs" : "--write-subs", "--sub-langs", keys.join(","), "--sub-format", fmt, "--print", SUBS_PRINT);
      ignoreErrors = true;
      break;
    }
    case "gif": {
      const h = gifSourceHeight(task.gifWidth);
      // -S res:H = the largest resolution <= H by the SHORT side (works for vertical videos too)
      a.push("-f", "bv[ext=mp4]/bv/b", "-S", `res:${h}`);
      a.push(...sectionArgs(task.section!));
      break;
    }
  }
  if (ignoreErrors) a.push("--ignore-errors");
  a.push("--", task.url);
  return a;
}
