// lib/progress.ts - turns yt-dlp / ffmpeg output lines into protocol events.
//
// yt-dlp is started with machine-readable templates (see ytdlp.ts):
//   stdout  [AKIF:INFO] {...}   before each item's download (id, title, format_id, filesize_approx, playlist_*)
//   stdout  [AKIF:DL]   {...}   download progress ("progress.*" / "info.*" keys; missing keys are omitted)
//   stderr  [AKIF:PP]   {...}   post-processor started/finished
//   stdout  [AKIF:DONE] {...}   final file path after MoveFiles
//   stdout  [AKIF:SUBS] [...]   subtitle files (--skip-download jobs)
//   stdout  key=value          ffmpeg -progress blocks (section downloads), ended by progress=continue|end
//   stderr  ERROR: / WARNING:  diagnostics

import type { LineEvent } from "./proc.ts";
import type { Kind } from "./task.ts";

export type DownloadStage = "video" | "audio" | "download" | "subtitles";
export type Stage =
  | DownloadStage
  | "merge" | "extract" | "thumbnail" | "metadata" | "cut" | "gif" | "convert" | "processing";

export interface ItemInfo {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  upload_date?: string;
  duration?: number;
  format_id?: string;
  ext?: string;
  filesize_approx?: number;
  height?: number;
  width?: number;
  fps?: number;
  dynamic_range?: string;
  playlist_index?: number;
  playlist_autonumber?: number;
  n_entries?: number;
  playlist_count?: number;
  playlist_title?: string;
  playlist_id?: string;
}

export interface ProgressSnapshot {
  stage: DownloadStage;
  /** overall percent of the job's download phase, 0..100, monotonic */
  percent: number;
  /** percent of the current playlist item */
  itemPercent: number;
  downloaded: number | null;
  total: number | null;
  speed: number | null;
  eta: number | null;
  playlistIndex?: number;
  playlistCount?: number;
}

export interface TrackerHooks {
  info(item: ItemInfo): void;
  progress(p: ProgressSnapshot): void;
  stage(s: Stage): void;
  file(path: string, item: ItemInfo | null): void;
}

/** Post-processors that yt-dlp may run before the media download (no UI stage for them). */
const PRE_DOWNLOAD_PPS = new Set(["ThumbnailsConvertor", "MetadataParser", "MetadataFromField"]);

/** yt-dlp postprocessor key -> protocol stage (spec 8.4) */
export function ppStage(name: string): Stage {
  const n = name.replace(/^FFmpeg/, "").replace(/PP$/, "");
  switch (n) {
    case "Merger":
      return "merge";
    case "ExtractAudio":
      return "extract";
    case "EmbedThumbnail":
      return "thumbnail";
    case "Metadata":
      return "metadata";
    case "SubtitlesConvertor":
      return "subtitles";
    case "VideoConvertor":
    case "VideoRemuxer":
      return "convert";
    default:
      return "processing"; // MoveFiles, FixupM4a, EmbedSubtitle, ...
  }
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Parses ffmpeg `-progress pipe:1` blocks. */
export class FfmpegProgress {
  #kv: Record<string, string> = {};
  #lastBytes = 0;
  #lastAt = 0;
  #speedBps: number | null = null;

  /** true when the line belonged to a progress block */
  static isProgressLine(line: string): boolean {
    return /^(frame|fps|stream_\d+_\d+_q|bitrate|total_size|out_time_us|out_time_ms|out_time|dup_frames|drop_frames|speed|progress)=/.test(line);
  }

  /** Feed one line; returns a snapshot when a block ends (progress=...). */
  feed(line: string, durationSec: number): { frac: number; bytes: number | null; speed: number | null; eta: number | null; end: boolean } | null {
    const i = line.indexOf("=");
    if (i <= 0) return null;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    this.#kv[k] = v;
    if (k !== "progress") return null;
    const kv = this.#kv;
    this.#kv = {};
    const us = num(kv.out_time_us) ?? num(kv.out_time_ms); // both are microseconds in ffmpeg
    const t = us != null && us > 0 ? us / 1e6 : 0;
    const end = v === "end";
    const frac = end ? 1 : durationSec > 0 ? Math.min(0.999, Math.max(0, t / durationSec)) : 0;
    const bytes = num(kv.total_size);
    const now = performance.now();
    if (bytes != null && this.#lastAt && now > this.#lastAt) {
      const inst = ((bytes - this.#lastBytes) * 1000) / (now - this.#lastAt);
      if (inst >= 0) this.#speedBps = this.#speedBps == null ? inst : this.#speedBps * 0.6 + inst * 0.4;
    }
    if (bytes != null) {
      this.#lastBytes = bytes;
      this.#lastAt = now;
    }
    const sx = num((kv.speed ?? "").replace(/x$/, ""));
    const eta = sx && sx > 0 && durationSec > 0 ? Math.max(0, (durationSec - t) / sx) : null;
    return { frac, bytes, speed: this.#speedBps, eta, end };
  }
}

interface FormatState {
  vcodec: string | null;
  acodec: string | null;
  downloaded: number;
  total: number | null;
  frac: number;
  finished: boolean;
}

interface ItemState {
  info: ItemInfo;
  formatIds: string[];
  formats: Map<string, FormatState>;
  approx: number | null;
  frac: number;
  index: number;
  count: number;
}

export interface TrackerOptions {
  kind: Kind;
  playlist: boolean;
  /** length of a --download-sections range (progress then comes from ffmpeg) */
  sectionLength: number | null;
  hooks: TrackerHooks;
}

const TAIL_MAX = 40;

export class OutputTracker {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  readonly tail: string[] = [];
  readonly files: { path: string; item: ItemInfo | null }[] = [];
  readonly subs: { ext?: string; filepath?: string }[] = [];
  readonly items: ItemInfo[] = [];
  ppActive = 0;
  lines = 0;
  #item: ItemState | null = null;
  #maxPercent = 0;
  #ff = new FfmpegProgress();
  #ffBytes: number | null = null;
  #o: TrackerOptions;

  constructor(o: TrackerOptions) {
    this.#o = o;
  }

  get currentItem(): ItemInfo | null {
    return this.#item?.info ?? null;
  }

  feed(ev: LineEvent) {
    this.lines++;
    const line = ev.line;
    if (line.startsWith("[AKIF:")) {
      const close = line.indexOf("]");
      const tag = line.slice(6, close);
      let data: unknown;
      try {
        data = JSON.parse(line.slice(close + 1).trim());
      } catch {
        this.#pushTail(line);
        return;
      }
      switch (tag) {
        case "INFO":
          if (data && typeof data === "object") this.#onInfo(data as ItemInfo);
          return;
        case "DL":
          if (data && typeof data === "object") this.#onDl(data as Record<string, unknown>);
          return;
        case "PP":
          if (data && typeof data === "object") this.#onPP(data as Record<string, unknown>);
          return;
        case "DONE": {
          const d = data as Record<string, unknown> | string;
          const p = typeof d === "string" ? d : typeof d?.filepath === "string" ? d.filepath : null;
          if (p) {
            this.files.push({ path: p, item: this.#item?.info ?? null });
            this.#o.hooks.file(p, this.#item?.info ?? null);
          }
          return;
        }
        case "SUBS":
          if (Array.isArray(data)) {
            for (const s of data) if (s && typeof s === "object") this.subs.push(s as { ext?: string; filepath?: string });
          }
          return;
        default:
          return;
      }
    }
    if (ev.stream === "stdout" && FfmpegProgress.isProgressLine(line)) {
      this.#onFfmpeg(line);
      return;
    }
    if (line.startsWith("ERROR:")) this.errors.push(line.slice(6).trim());
    else if (line.startsWith("WARNING:")) {
      if (this.warnings.length >= TAIL_MAX) this.warnings.shift();
      this.warnings.push(line.slice(8).trim());
    }
    this.#pushTail(line);
  }

  #pushTail(line: string) {
    if (this.tail.length >= TAIL_MAX) this.tail.shift();
    this.tail.push(line.length > 500 ? line.slice(0, 500) + "..." : line);
  }

  #newItem(info: ItemInfo): ItemState {
    const index = int(info.playlist_autonumber) ?? int(info.playlist_index) ?? 1;
    const count = int(info.n_entries) ?? int(info.playlist_count) ?? 1;
    return {
      info,
      formatIds: String(info.format_id ?? "").split("+").filter(Boolean),
      formats: new Map(),
      approx: num(info.filesize_approx),
      frac: 0,
      index: Math.max(1, index),
      count: Math.max(1, count, index),
    };
  }

  #onInfo(info: ItemInfo) {
    this.items.push(info);
    this.#item = this.#newItem(info);
    this.#o.hooks.info(info);
    // playlists: the overall percent jumps to the start of the new item ("Video 2 of 4")
    if (this.#o.playlist) this.#emit(this.#defaultStage(), null, null);
  }

  #defaultStage(): DownloadStage {
    if (this.#o.kind === "subtitle") return "subtitles";
    if (this.#o.kind === "audio") return "audio";
    if (this.#o.kind === "gif") return "video";
    return "download";
  }

  #onDl(j: Record<string, unknown>) {
    const fid = typeof j["info.format_id"] === "string" ? j["info.format_id"] as string : null;
    const status = String(j["progress.status"] ?? "");
    if (!this.#item) this.#item = this.#newItem({ format_id: fid ?? undefined });
    const item = this.#item;
    const speed = num(j["progress.speed"]);
    if (this.#o.kind === "subtitle" || !fid) {
      // subtitle / thumbnail downloads: nothing to weigh, just show activity
      if (this.#o.kind === "subtitle") this.#emit("subtitles", speed, num(j["progress.eta"]));
      return;
    }
    if (this.#o.sectionLength) {
      // ffmpeg downloads the section; yt-dlp only reports the end
      if (status === "finished") {
        item.frac = 1;
        this.#emit(this.#defaultStage(), speed, 0);
      }
      return;
    }
    let f = item.formats.get(fid);
    if (!f) {
      f = { vcodec: null, acodec: null, downloaded: 0, total: null, frac: 0, finished: false };
      item.formats.set(fid, f);
    }
    if (typeof j["info.vcodec"] === "string") f.vcodec = j["info.vcodec"] as string;
    if (typeof j["info.acodec"] === "string") f.acodec = j["info.acodec"] as string;
    const dl = num(j["progress.downloaded_bytes"]) ?? 0;
    const tot = num(j["progress.total_bytes"]);
    const est = num(j["progress.total_bytes_estimate"]);
    const fi = num(j["progress.fragment_index"]);
    const fc = num(j["progress.fragment_count"]);
    let frac: number;
    if (status === "finished") frac = 1;
    else if (tot && tot > 0) frac = dl / tot;
    else if (fi != null && fc && fc > 0) frac = fi / fc; // HLS: total is NA and estimates jump
    else if (est && est > 0) frac = dl / est;
    else frac = 0;
    f.frac = Math.max(f.frac, Math.min(frac, status === "finished" ? 1 : 0.999));
    f.downloaded = dl;
    if (tot) f.total = tot;
    if (status === "finished") {
      f.finished = true;
      if (dl) f.total = dl;
    }

    const n = Math.max(item.formatIds.length, item.formats.size, 1);
    const states = [...item.formats.values()];
    const allDone = states.length >= n && states.every((s) => s.finished);
    let itemFrac: number;
    if (allDone) itemFrac = 1;
    else if (item.approx && item.approx > 0) {
      const bytes = states.reduce((acc, s) => acc + (s.finished ? (s.total ?? s.downloaded) : s.downloaded), 0);
      itemFrac = Math.min(0.999, bytes / item.approx);
    } else itemFrac = states.reduce((acc, s) => acc + s.frac, 0) / n;
    item.frac = Math.max(item.frac, Math.min(1, itemFrac));

    const v = f.vcodec;
    const a = f.acodec;
    const stage: DownloadStage = v && v !== "none" && (!a || a === "none")
      ? "video"
      : (!v || v === "none") && a && a !== "none"
      ? "audio"
      : this.#defaultStage();
    let eta = num(j["progress.eta"]);
    if (item.approx && speed && speed > 0) {
      const done = states.reduce((acc, s) => acc + (s.finished ? (s.total ?? s.downloaded) : s.downloaded), 0);
      eta = Math.max(0, (item.approx - done) / speed);
    }
    this.#emit(stage, speed, eta);
  }

  #onFfmpeg(line: string) {
    const len = this.#o.sectionLength;
    if (!len) return;
    const r = this.#ff.feed(line, len);
    if (!r) return;
    if (!this.#item) this.#item = this.#newItem({});
    this.#item.frac = Math.max(this.#item.frac, r.frac);
    this.#ffBytes = r.bytes;
    this.#emit(this.#defaultStage(), r.speed, r.eta);
  }

  #onPP(j: Record<string, unknown>) {
    const status = String(j["progress.status"] ?? "");
    const name = String(j["progress.postprocessor"] ?? "");
    if (status === "started") {
      this.ppActive++;
      // Some post-processors (thumbnail conversion, metadata parsing) run BEFORE the download starts;
      // reporting them as a stage would make the UI show "Processing…" before "Downloading…".
      if (!this.#item && PRE_DOWNLOAD_PPS.has(name.replace(/^FFmpeg/, ""))) return;
      this.#o.hooks.stage(ppStage(name));
    } else if (status === "finished") {
      this.ppActive = Math.max(0, this.ppActive - 1);
    }
  }

  #emit(stage: DownloadStage, speed: number | null, eta: number | null) {
    const item = this.#item;
    if (!item) return;
    const itemPct = item.frac * 100;
    let overall = this.#o.playlist ? ((item.index - 1) + item.frac) / item.count * 100 : itemPct;
    overall = Math.max(this.#maxPercent, Math.min(100, overall));
    this.#maxPercent = overall;
    const states = [...item.formats.values()];
    let downloaded: number | null = null;
    let total: number | null = null;
    if (this.#o.sectionLength) {
      downloaded = this.#ffBytes;
    } else if (states.length) {
      downloaded = states.reduce((acc, s) => acc + (s.finished ? (s.total ?? s.downloaded) : s.downloaded), 0);
      const n = Math.max(item.formatIds.length, states.length);
      total = item.approx ?? (states.length >= n && states.every((s) => s.total) ? states.reduce((acc, s) => acc + (s.total ?? 0), 0) : null);
    } else {
      total = item.approx;
    }
    const snap: ProgressSnapshot = {
      stage,
      percent: round1(overall),
      itemPercent: round1(itemPct),
      downloaded,
      total,
      speed: speed != null ? Math.round(speed) : null,
      eta: eta != null ? Math.round(eta) : null,
    };
    if (this.#o.playlist) {
      snap.playlistIndex = item.index;
      snap.playlistCount = item.count;
    }
    this.#o.hooks.progress(snap);
  }
}
