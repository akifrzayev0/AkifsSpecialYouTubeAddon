// lib/task.ts - validation of the `task` object of a `start` request (spec section 8.3).
// The service worker validates too; the host never trusts it. Every field is
// type-checked, enums are whitelisted and numbers range-checked. Nothing from
// the task reaches yt-dlp without passing these checks, and nothing is ever
// passed through a shell.

import { normalizeAbsolutePath, subfolderPath } from "./paths.ts";

export class BadTask extends Error {
  override name = "BadTask";
  readonly code = "bad_task";
}

export const KINDS = ["video", "audio", "subtitle", "gif"] as const;
export const CONTAINERS = ["mp4", "mkv", "webm"] as const;
export const CODECS = ["auto", "compat"] as const;
export const AUDIO_FORMATS = ["mp3", "m4a", "opus", "flac", "wav"] as const;
export const SUB_FORMATS = ["srt", "vtt", "ttml", "srv3", "json3", "txt"] as const;
export const FILENAME_STYLES = ["title", "title_id", "channel_title", "date_title"] as const;
export const BITRATES = [64, 96, 128, 160, 192, 256, 320] as const;

export type Kind = typeof KINDS[number];
export type Container = typeof CONTAINERS[number];
export type Codec = typeof CODECS[number];
export type AudioFormat = typeof AUDIO_FORMATS[number];
export type SubFormat = typeof SUB_FORMATS[number];
export type FilenameStyle = typeof FILENAME_STYLES[number];

export interface Section {
  start: number;
  end: number;
}

export interface Task {
  kind: Kind;
  videoId: string | null;
  /** canonical URL handed to yt-dlp */
  url: string;
  playlist: boolean;
  listId: string | null;
  /** yt-dlp --playlist-items value (e.g. "1:2"), playlists only */
  playlistItems: string | null;
  /** '' = <Downloads>\<subfolder> */
  outputDir: string;
  /** sanitised relative path ('' = none) */
  subfolder: string;
  filenameStyle: FilenameStyle;
  cookies: string | null;
  // video
  height: number | null;
  width: number | null;
  hdr: boolean | null;
  fps: number | null;
  container: Container;
  codec: Codec;
  audioLang: string | null;
  embedThumbnail: boolean;
  embedMetadata: boolean;
  embedChapters: boolean;
  embedSubtitles: boolean;
  section: Section | null;
  preciseCut: boolean;
  // audio
  audioFormat: AudioFormat;
  bitrate: number;
  // subtitle
  subLang: string | null;
  subAuto: boolean;
  subFormat: SubFormat;
  subTranslateTo: string | null;
  // gif
  gifWidth: number;
  gifFps: number;
  /** UI language, used to pick embedded subtitles */
  uiLang: string | null;
}

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const LIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
export const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WATCH_RE = /^https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/;
const PLAYLIST_RE = /^https:\/\/www\.youtube\.com\/playlist\?list=([A-Za-z0-9_-]{10,64})$/;
/** BCP-47-ish: en, pt-BR, zh-Hans, es-419, fil */
export const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/;
const PLAYLIST_ITEMS_RE = /^\d{1,5}(?:[:-]\d{1,5})?(?:,\d{1,5}(?:[:-]\d{1,5})?){0,49}$/;

export const MAX_SECTION_END = 100 * 3600;
/** keeps <outputDir>\<title (clip ...)>.<ext> below MAX_PATH with a readable title */
export const MAX_OUTPUT_DIR = 180;
export const GIF_MAX_SECONDS = 60;
export const MAX_COOKIES_BYTES = 2 * 1024 * 1024;

function fail(msg: string): never {
  throw new BadTask(msg);
}

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function oneOf<T extends string | number>(v: unknown, allowed: readonly T[], name: string, def?: T): T {
  if (!isSet(v)) {
    if (def !== undefined) return def;
    fail(`${name} is required`);
  }
  if (!(allowed as readonly unknown[]).includes(v)) fail(`${name} must be one of ${allowed.join(", ")}`);
  return v as T;
}

function bool(v: unknown, name: string, def: boolean): boolean {
  if (!isSet(v)) return def;
  if (typeof v !== "boolean") fail(`${name} must be a boolean`);
  return v;
}

function boolOrNull(v: unknown, name: string): boolean | null {
  if (!isSet(v)) return null;
  if (typeof v !== "boolean") fail(`${name} must be a boolean or null`);
  return v;
}

function intOrNull(v: unknown, name: string, min: number, max: number): number | null {
  if (!isSet(v)) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail(`${name} must be an integer between ${min} and ${max}`);
  return v;
}

function intDef(v: unknown, name: string, min: number, max: number, def: number): number {
  return intOrNull(v, name, min, max) ?? def;
}

function langOrNull(v: unknown, name: string): string | null {
  if (!isSet(v) || v === "") return null;
  if (typeof v !== "string" || !LANG_RE.test(v)) fail(`${name} must be a language code like "en" or "pt-BR"`);
  return v;
}

function finiteNumber(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${name} must be a number`);
  return v;
}

function section(v: unknown): Section | null {
  if (!isSet(v)) return null;
  if (typeof v !== "object" || Array.isArray(v)) fail("section must be {start, end} or null");
  const s = v as Record<string, unknown>;
  const start = Math.round(finiteNumber(s.start, "section.start") * 1000) / 1000;
  const end = Math.round(finiteNumber(s.end, "section.end") * 1000) / 1000;
  if (start < 0 || end > MAX_SECTION_END) fail("section is out of range");
  if (end - start < 0.25) fail("section.end must be after section.start");
  return { start, end };
}

/** Validate and normalise a task. Throws BadTask with a human-readable reason. */
export function validateTask(raw: unknown): Task {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("task must be an object");
  const t = raw as Record<string, unknown>;

  const kind = oneOf(t.kind, KINDS, "kind");
  const playlist = bool(t.playlist, "playlist", false);

  if (typeof t.url !== "string") fail("url is required");
  let videoId: string | null = null;
  let listId: string | null = null;
  let url: string;
  if (playlist) {
    const m = PLAYLIST_RE.exec(t.url);
    if (!m) fail("url must be https://www.youtube.com/playlist?list=<id> for a playlist");
    listId = m[1];
    url = `https://www.youtube.com/playlist?list=${listId}`;
    if (isSet(t.videoId)) {
      if (typeof t.videoId !== "string" || !VIDEO_ID_RE.test(t.videoId)) fail("videoId must be an 11-character video id or null");
      videoId = t.videoId;
    }
  } else {
    const m = WATCH_RE.exec(t.url);
    if (!m) fail("url must be https://www.youtube.com/watch?v=<11-character id>");
    videoId = m[1];
    url = `https://www.youtube.com/watch?v=${videoId}`;
    if (isSet(t.videoId) && t.videoId !== videoId) fail("videoId does not match the url");
  }
  if ((kind === "subtitle" || kind === "gif") && playlist) fail(`${kind} jobs cannot be playlists`);

  let playlistItems: string | null = null;
  if (isSet(t.playlistItems)) {
    if (typeof t.playlistItems !== "string" || !PLAYLIST_ITEMS_RE.test(t.playlistItems)) fail('playlistItems must look like "1:5" or "1,3,7-9"');
    if (playlist) playlistItems = t.playlistItems;
  }

  let outputDir = "";
  if (isSet(t.outputDir) && t.outputDir !== "") {
    if (typeof t.outputDir === "string" && t.outputDir.length > MAX_OUTPUT_DIR) {
      fail(`outputDir is too long (at most ${MAX_OUTPUT_DIR} characters, so that file names still fit into Windows' 260-character path limit)`);
    }
    const p = normalizeAbsolutePath(t.outputDir, MAX_OUTPUT_DIR);
    if (!p) fail("outputDir must be an absolute folder path (like C:\\Users\\me\\Videos) without special characters");
    outputDir = p;
  }
  let subfolder = "";
  if (isSet(t.subfolder)) {
    if (typeof t.subfolder !== "string" || t.subfolder.length > 200) fail("subfolder must be a string");
    subfolder = subfolderPath(t.subfolder);
  }
  const filenameStyle = oneOf(t.filenameStyle, FILENAME_STYLES, "filenameStyle", "title");

  let cookies: string | null = null;
  if (isSet(t.cookies) && t.cookies !== "") {
    if (typeof t.cookies !== "string") fail("cookies must be a string or null");
    if (t.cookies.length > MAX_COOKIES_BYTES || t.cookies.includes("\u0000")) fail("cookies text is invalid");
    cookies = t.cookies;
  }

  const height = intOrNull(t.height, "height", 1, 16384);
  const width = intOrNull(t.width, "width", 1, 16384);
  let fps: number | null = null;
  if (isSet(t.fps)) {
    const f = finiteNumber(t.fps, "fps");
    if (f < 1 || f > 480) fail("fps must be between 1 and 480");
    fps = Math.round(f);
  }
  const hdr = boolOrNull(t.hdr, "hdr");
  const container = oneOf(t.container, CONTAINERS, "container", "mp4");
  const codec = oneOf(t.codec, CODECS, "codec", "auto");
  const audioLang = langOrNull(t.audioLang, "audioLang");

  let sec = section(t.section);
  if (sec && playlist) sec = null; // one time range cannot apply to every playlist item
  const preciseCut = bool(t.preciseCut, "preciseCut", false);

  const audioFormat = oneOf(t.audioFormat, AUDIO_FORMATS, "audioFormat", "mp3");
  const bitrate = oneOf(t.bitrate, BITRATES, "bitrate", 192);

  const subLang = langOrNull(t.subLang, "subLang");
  const subAuto = bool(t.subAuto, "subAuto", false);
  const subFormat = oneOf(t.subFormat, SUB_FORMATS, "subFormat", "srt");
  const subTranslateTo = langOrNull(t.subTranslateTo, "subTranslateTo");
  if (kind === "subtitle" && !subLang) fail("subLang is required for subtitle jobs");

  const gifWidth = intDef(t.gifWidth, "gifWidth", 240, 1280, 480);
  const gifFps = intDef(t.gifFps, "gifFps", 5, 30, 15);
  if (kind === "gif") {
    if (!sec) fail("gif jobs need a section");
    if (sec.end - sec.start > GIF_MAX_SECONDS + 0.5) fail(`a GIF can be at most ${GIF_MAX_SECONDS} seconds long`);
  }

  return {
    kind,
    videoId,
    url,
    playlist,
    listId,
    playlistItems,
    outputDir,
    subfolder,
    filenameStyle,
    cookies,
    height,
    width,
    hdr,
    fps,
    container,
    codec,
    audioLang,
    embedThumbnail: bool(t.embedThumbnail, "embedThumbnail", true),
    embedMetadata: bool(t.embedMetadata, "embedMetadata", true),
    embedChapters: bool(t.embedChapters, "embedChapters", true),
    embedSubtitles: bool(t.embedSubtitles, "embedSubtitles", false),
    section: sec,
    preciseCut,
    audioFormat,
    bitrate,
    subLang,
    subAuto,
    subFormat,
    subTranslateTo,
    gifWidth,
    gifFps,
    uiLang: langOrNull(t.uiLang, "uiLang"),
  };
}
