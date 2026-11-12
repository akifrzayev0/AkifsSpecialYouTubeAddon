// lib/jobs.ts - runs companion jobs: yt-dlp (+ host-side ffmpeg steps), events, cancel, retry, cleanup.
//
// Per job (lib/tempdirs.ts):
//   <outDir>\.akif-tmp\<name>\          hidden temp dir: yt-dlp -P temp:, host intermediates.
//   <root>\state\jobs\<pid>-<name>\      private dir (never synced or shared): cookies.txt, only while yt-dlp
//                                        runs; ALL temp files when the output folder is cloud-synced.
//                                        Both ALWAYS removed (success, error, cancel, host shutdown); what a
//                                        killed host left is swept later.
//   Job Object per child process         cancel/shutdown kill yt-dlp -> python -> ffmpeg at once.
//   Exactly one terminal event           done | error | canceled.
//   One automatic retry                  for transient failures (network, HTTP 403, a locked file, silent exit);
//                                        partial files are kept, so yt-dlp continues where it stopped. Also when
//                                        a section download (clip, GIF) came out without any video: that clip is
//                                        deleted and downloaded again.

import type { ResolvedTools } from "./config.ts";
import { classifyRun, type Classified } from "./errors.ts";
import { log } from "./log.ts";
import { basename, extname, fileSize, join, pathExists, sanitizeFileName, uniquePath } from "./paths.ts";
import { capture, type CaptureResult, removeWithRetry, type RunOutcome, runTracked, sleep, type TrackedRun } from "./proc.ts";
import { FfmpegProgress, type ItemInfo, OutputTracker, type ProgressSnapshot, type Stage } from "./progress.ts";
import { longPathsEnabled } from "./winshell.ts";
import { convertSubtitle } from "./subs.ts";
import type { Task } from "./task.ts";
import { cloudSyncRoots, createOutputTemp, ensureDir, isCloudSynced, moveFile, privateJobDir, release, removeOutputTemp } from "./tempdirs.ts";
import { buildYtDlpArgs, clipLabel, fileSuffix, fmtSeconds, hostCutsAudio, outputTemplate, styleOverhead, subtitleKeys } from "./ytdlp.ts";

export type Emit = (msg: Record<string, unknown>) => void;

export interface JobEnv {
  emit: Emit;
  tools: () => ResolvedTools;
}

const PY_ENV = { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" };
const IDLE_LIMIT_MS = Number(Deno.env.get("AKIF_IDLE_LIMIT_MS")) || 120_000;
// Test hook (only together with AKIF_HOST_TEST=1): the first attempt of every job goes through a
// dead proxy, so the automatic retry of transient (network) failures can be tested for real.
const TEST_FAIL_FIRST = Deno.env.get("AKIF_HOST_TEST") === "1" && Deno.env.get("AKIF_TEST_FAIL_FIRST") === "1";
const PP_IDLE_LIMIT_MS = 30 * 60_000;
// <= 2 progress events in any rolling second per job (a little margin for timer jitter)
const PROGRESS_WINDOW_MS = 1050;
const MAX_FILES_IN_DONE = 1000; // keeps `done` far below Chrome's 1 MiB message limit
const MAX_PATH_BUDGET = 250;

export class JobError extends Error {
  /** transient: worth one more attempt (run() downloads again) */
  constructor(readonly code: Classified["code"], message: string, readonly detail = "", readonly transient = false) {
    super(message);
  }
}

/**
 * FFmpeg's answer to an input without a usable stream. yt-dlp's section download (FFmpeg reading from YouTube) now
 * and then ends without a single packet and still succeeds: the clip is an mp4 without streams (seen once in five GIF
 * runs; the reruns passed). The download is retried.
 */
const EMPTY_INPUT = /does not contain any stream|matches no streams/i;

const emptyDownload = (what: "clip" | "audio file", detail: string) =>
  new JobError("network", `The downloaded ${what} is empty: YouTube sent no ${what === "clip" ? "video" : "audio"} data for it.`, detail, true);

/** Deno.Command throws when Windows refuses to start a program: a missing file, antivirus, AppLocker / WDAC. */
function spawnFailure(e: unknown, tool: "yt-dlp" | "FFmpeg"): JobError {
  const msg = String((e as Error)?.message ?? e);
  if (/File not found|cannot find|os error [23]\b/i.test(msg)) {
    return new JobError(tool === "yt-dlp" ? "ytdlp_missing" : "ffmpeg", `${tool} could not be started (${msg}). Run install.bat of the companion app again.`);
  }
  if (e instanceof Deno.errors.PermissionDenied || /Access is denied|blocked|os error (?:5|225|1260)\b/i.test(msg)) {
    return new JobError("access_denied", `Windows blocked ${tool} from starting (antivirus or an app control policy): ${msg}`);
  }
  return new JobError("unknown", `${tool} could not be started: ${msg}`);
}

function ytDate(d: string | undefined): string {
  return d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : "0000-00-00";
}

/** File name (without extension) built by the host, mirroring outputTemplate(). */
export function hostBaseName(style: Task["filenameStyle"], info: ItemInfo, suffix: string, titleBytes: number): string {
  const title = sanitizeFileName(info.title ?? info.id ?? "video", titleBytes);
  switch (style) {
    case "title_id":
      return `${title} [${sanitizeFileName(info.id ?? "", 20)}]${suffix}`;
    case "channel_title":
      return `${sanitizeFileName(info.uploader ?? info.channel ?? "Unknown", 60)} - ${title}${suffix}`;
    case "date_title":
      return `${ytDate(info.upload_date)} ${title}${suffix}`;
    default:
      return `${title}${suffix}`;
  }
}

class Job {
  readonly id: string;
  readonly task: Task;
  readonly outDir: string;
  readonly startedAt = Date.now();
  /** yt-dlp -P temp: and host intermediates: <outDir>\.akif-tmp\<name> or the private dir */
  tmpDir = "";
  /** private per-job folder (cookies; everything when the output folder is synced); created on demand */
  privDir = "";
  canceled = false;
  #tmpInOutDir = false;
  #privCreated = false;
  #shutdown = false;
  #terminal = false;
  /** the outcome is decided (done or error); only cleanup is left */
  #settled = false;
  #env: JobEnv;
  #run: TrackedRun | null = null;
  #tracker: OutputTracker | null = null;
  #files: { path: string; size: number }[] = [];
  /** lower-case paths of #files: duplicate checks stay O(1) for playlists with thousands of files */
  #filePaths = new Set<string>();
  /** send times of the last two progress events (rate limit: <= 2 per rolling second) */
  #sentTimes: number[] = [];
  #pending: Record<string, unknown> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastStage = "";
  #maxPercent = 0;
  #resolveFinished!: () => void;
  readonly finished: Promise<void>;

  constructor(id: string, task: Task, outDir: string, env: JobEnv) {
    this.id = id;
    this.task = task;
    this.outDir = outDir;
    this.#env = env;
    this.finished = new Promise((r) => (this.#resolveFinished = r));
  }

  // ---- events --------------------------------------------------------------

  #emit(event: string, data: Record<string, unknown> = {}) {
    if (this.#terminal || this.#shutdown) return;
    if (event === "done" || event === "error" || event === "canceled") {
      this.#dropPending(); // the terminal event supersedes any queued progress
      this.#terminal = true;
    }
    this.#env.emit({ event, jobId: this.id, ...data });
  }

  #stage(stage: Stage) {
    if (stage === this.#lastStage) return;
    // Let the latest download progress out first if the rate limit allows it; a progress event
    // sent AFTER the stage event would make the UI jump back to "downloading".
    this.#flushProgress();
    this.#dropPending();
    this.#lastStage = stage;
    // `percent` (extra field): the job's overall percent at this point, in case the last
    // download progress was coalesced away by the rate limit.
    this.#emit("stage", { stage, percent: this.#maxPercent });
  }

  /**
   * Progress is rate-limited to at most 2 events in any rolling second per job (spec: <= 2/s).
   * Updates in between are coalesced; the newest one goes out as soon as the budget allows.
   */
  #progress(p: Omit<Partial<ProgressSnapshot>, "stage"> & { stage: string; percent: number }) {
    const percent = Math.max(this.#maxPercent, Math.min(100, Math.round(p.percent * 10) / 10));
    this.#maxPercent = percent;
    const ev: Record<string, unknown> = {
      stage: p.stage,
      percent,
      downloaded: p.downloaded ?? null,
      total: p.total ?? null,
      speed: p.speed ?? null,
      eta: p.eta ?? null,
    };
    if (p.playlistIndex != null) {
      ev.playlistIndex = p.playlistIndex;
      ev.playlistCount = p.playlistCount;
      ev.itemPercent = p.itemPercent;
    }
    this.#lastStage = p.stage; // a progress event also changes what the UI shows
    this.#pending = ev;
    this.#flushProgress();
    if (this.#pending && !this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#flushProgress();
      }, Math.max(10, this.#nextSlot() - Date.now()));
    }
  }

  /** Earliest time the next progress event may be sent. */
  #nextSlot(): number {
    return this.#sentTimes.length < 2 ? 0 : this.#sentTimes[0] + PROGRESS_WINDOW_MS;
  }

  #flushProgress() {
    const ev = this.#pending;
    if (!ev || this.#terminal) return;
    const now = Date.now();
    if (now < this.#nextSlot()) return;
    this.#pending = null;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#sentTimes.push(now);
    if (this.#sentTimes.length > 2) this.#sentTimes.shift();
    this.#emit("progress", ev);
  }

  #dropPending() {
    this.#pending = null;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async #addFile(path: string) {
    const key = path.toLowerCase();
    if (this.#filePaths.has(key)) return;
    const size = await fileSize(path);
    if (size == null) {
      log("warn", `job ${this.id}: reported file is missing: ${path}`);
      return;
    }
    if (this.#filePaths.has(key)) return; // registered by a concurrent call while stat() ran
    this.#filePaths.add(key);
    this.#files.push({ path, size });
    this.#emit("file", { path, size });
  }

  // ---- lifecycle -------------------------------------------------------------

  async run() {
    let final: { event: "done" | "error"; data: Record<string, unknown> } | null = null;
    try {
      await this.#prepare();
      for (let attempt = 1; attempt <= 2 && !this.canceled; attempt++) {
        const res = await this.#runYtDlp(attempt);
        if (this.canceled) break;
        const failure = (await this.#evaluate(res)) ?? (await this.#finishStep());
        if (this.canceled) break;
        if (!failure) {
          this.#settled = true;
          final = this.#doneEvent();
          break;
        }
        if (failure.transient && attempt === 1 && !this.canceled) {
          log("warn", `job ${this.id}: ${failure.code} (${failure.message}); retrying once, keeping the partial files`);
          // The temp folder is kept: yt-dlp continues .part files (HTTP Range) and fragmented downloads
          // (.ytdl) and skips finished formats, so a network drop at 90% of a 4 GB file does not start over.
          this.#maxPercent = 0; // show the new attempt's real progress (resumed bytes included)
          continue;
        }
        this.#settled = true;
        final = { event: "error", data: { code: failure.code, message: failure.message, detail: failure.detail } };
        break;
      }
    } catch (e) {
      if (!this.canceled) {
        this.#settled = true;
        const je = e instanceof JobError ? e : null;
        const text = String((e as Error)?.message ?? e);
        // PermissionDenied ("Access is denied", os error 5) is NOT a full disk: Controlled Folder Access,
        // folder permissions or antivirus refused to let the companion write there.
        const code = je?.code ??
          (/ENOSPC|os error 112\b|not enough space/i.test(text) ? "disk" : e instanceof Deno.errors.PermissionDenied ? "access_denied" : "unknown");
        const message = !je && code === "access_denied"
          ? `Windows denied access (Controlled Folder Access, antivirus or folder permissions): ${text}`
          : text;
        log("error", `job ${this.id} failed:`, e);
        final = { event: "error", data: { code, message, detail: je?.detail ?? "" } };
      }
    } finally {
      // The terminal event goes out only after the temp dirs are gone: when the browser sees
      // done / error / canceled, nothing of the job is left running or lying around.
      await this.#cleanup();
      if (this.canceled) this.#emit("canceled");
      else if (final) this.#emit(final.event, final.data);
      if (!this.#terminal && !this.#shutdown) this.#emit("error", { code: "unknown", message: "the job ended unexpectedly", detail: "" });
      log("info", `job ${this.id} finished after ${Math.round((Date.now() - this.startedAt) / 1000)} s: ${this.canceled ? "canceled" : final?.event ?? "?"}`);
      this.#resolveFinished();
    }
  }

  /** Cancel: kill the process tree; run() then cleans up and emits `canceled`. */
  async cancel(shutdown = false) {
    if (shutdown) this.#shutdown = true;
    // once the outcome is settled (file complete / error decided) a late cancel changes nothing
    if (!this.canceled && !this.#terminal && !this.#settled) {
      this.canceled = true;
      log("info", `job ${this.id}: cancel${shutdown ? " (host shutdown)" : ""}`);
      await this.#run?.kill(shutdown ? "shutdown" : "cancel");
    }
    await this.finished;
  }

  async #prepare() {
    await Deno.mkdir(this.outDir, { recursive: true });
    this.privDir = privateJobDir();
    if (isCloudSynced(this.outDir, cloudSyncRoots())) {
      // a sync client would upload (and lock) GBs of partial files: keep them local, move only the result
      log("info", `job ${this.id}: ${this.outDir} is in a cloud-sync folder; temp files go to ${this.privDir}`);
    } else {
      const dir = await createOutputTemp(this.outDir);
      if (dir) {
        this.tmpDir = dir;
        this.#tmpInOutDir = true;
        return;
      }
    }
    await this.#ensurePrivate();
    this.tmpDir = this.privDir;
  }

  async #ensurePrivate() {
    if (this.#privCreated) return;
    await ensureDir(this.privDir);
    this.#privCreated = true;
  }

  /** cookies.txt lives in the private folder and exists only while yt-dlp runs. */
  #cookiesFile(): string | null {
    return this.task.cookies ? join(this.privDir, "cookies.txt") : null;
  }

  async #writeCookies() {
    const file = this.#cookiesFile();
    if (!file || !this.task.cookies) return;
    await this.#ensurePrivate();
    let text = this.task.cookies.replace(/\r\n?/g, "\n");
    if (!/^# (?:Netscape )?HTTP Cookie File/.test(text)) text = "# Netscape HTTP Cookie File\n" + text;
    await Deno.writeTextFile(file, text.endsWith("\n") ? text : text + "\n");
  }

  async #removeCookies() {
    const file = this.#cookiesFile();
    if (file && this.#privCreated) await removeWithRetry(file, 10, 100);
  }

  async #cleanup() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.tmpDir && this.#tmpInOutDir) await removeOutputTemp(this.outDir, this.tmpDir);
    if (this.#privCreated) await removeWithRetry(this.privDir);
    release(this.tmpDir);
    release(this.privDir);
  }

  /**
   * Title byte budget (UTF-8 bytes >= UTF-16 units, so the path length is bounded):
   * the final path always stays below MAX_PATH (Explorer and players need that); the deeper temp
   * path (+ ".f251-drc.webm.part-Frag1234.part") only has to when Windows long paths are disabled.
   */
  #titleBytes(): number {
    const name = (this.task.playlist ? 88 : 0) + fileSuffix(this.task).length + styleOverhead(this.task.filenameStyle);
    const finalFixed = this.outDir.length + 1 + name + 8;
    const tempFixed = this.tmpDir.length + 1 + name + 34;
    const fixed = longPathsEnabled() ? finalFixed : Math.max(finalFixed, tempFixed);
    return Math.max(40, Math.min(150, MAX_PATH_BUDGET - fixed));
  }

  /** Does yt-dlp write the final file itself (home = outDir), or does the host finish it? */
  #hostFinishes(): boolean {
    return this.task.kind === "subtitle" || this.task.kind === "gif" || hostCutsAudio(this.task);
  }

  async #runYtDlp(attempt: number): Promise<RunOutcome> {
    const tools = this.#env.tools();
    const t = this.task;
    if (!tools.ytdlp.path) throw new JobError("ytdlp_missing", "yt-dlp was not found. Run install.bat of the companion app again.");
    if (!tools.ffmpeg.path && t.kind !== "subtitle") throw new JobError("ffmpeg", "FFmpeg was not found. Run install.bat of the companion app again.");
    const sectionLength = (t.kind === "video" || t.kind === "gif") && t.section && !t.playlist ? t.section.end - t.section.start : null;

    const tracker = new OutputTracker({
      kind: t.kind,
      playlist: t.playlist,
      sectionLength,
      hooks: {
        info: (item) => {
          const ev: Record<string, unknown> = {
            title: item.title ?? null,
            videoId: item.id ?? t.videoId,
            duration: item.duration ?? null,
            uploader: item.uploader ?? item.channel ?? null,
          };
          if (t.playlist) {
            ev.playlistIndex = item.playlist_autonumber ?? item.playlist_index ?? null;
            ev.playlistCount = item.n_entries ?? item.playlist_count ?? null;
            ev.playlistTitle = item.playlist_title ?? null;
          }
          this.#emit("info", ev);
        },
        progress: (p) => this.#progress(p),
        stage: (s) => this.#stage(s),
        file: (path) => {
          if (!this.#hostFinishes()) void this.#addFile(path);
        },
      },
    });
    this.#tracker = tracker;
    const args = buildYtDlpArgs(t, {
      homeDir: this.#hostFinishes() ? this.tmpDir : this.outDir,
      tempDir: this.tmpDir,
      denoPath: tools.deno.path,
      ffmpegPath: tools.ffmpeg.path,
      cookiesFile: this.#cookiesFile(),
      template: t.kind === "gif" ? "clip.%(ext)s" : t.kind === "subtitle" ? "%(id)s.%(ext)s" : outputTemplate(t, this.#titleBytes()),
    });
    if (TEST_FAIL_FIRST && attempt === 1) args.splice(args.indexOf("--"), 0, "--proxy", "http://127.0.0.1:9", "--extractor-retries", "0");
    log("info", `job ${this.id} attempt ${attempt}: ${tools.ytdlp.path} ${JSON.stringify(args)}`);
    const skipped: RunOutcome = { code: null, signal: null, killedBy: "cancel", lines: 0, ms: 0 };
    if (this.canceled) return skipped;
    await this.#writeCookies();
    if (this.canceled) {
      await this.#removeCookies(); // canceled while the cookies were written: never start yt-dlp
      return skipped;
    }
    let run: TrackedRun;
    try {
      run = runTracked(tools.ytdlp.path, {
        args,
        env: PY_ENV,
        cwd: this.tmpDir,
        onLine: (ev) => {
          tracker.feed(ev);
          if (!ev.line.startsWith("[AKIF:DL]") && !FfmpegProgress.isProgressLine(ev.line)) log("debug", `job ${this.id} ${ev.stream}: ${ev.line.slice(0, 600)}`);
        },
        idleLimitMs: () => (tracker.ppActive > 0 ? PP_IDLE_LIMIT_MS : IDLE_LIMIT_MS),
      });
    } catch (e) {
      await this.#removeCookies();
      throw spawnFailure(e, "yt-dlp");
    }
    this.#run = run;
    let res: RunOutcome;
    try {
      res = await run.result;
    } finally {
      this.#run = null;
      // yt-dlp writes the cookie jar back when it exits: remove it right away, not at the end of the job
      await this.#removeCookies();
    }
    log("info", `job ${this.id}: yt-dlp exit ${res.code} after ${res.ms} ms, ${res.lines} lines, killedBy=${res.killedBy}, files=${tracker.files.length}`);
    // file events are emitted asynchronously (stat); let them land before evaluating
    await sleep(0);
    return res;
  }

  async #evaluate(res: RunOutcome): Promise<Classified | null> {
    const tr = this.#tracker!;
    const t = this.task;
    const facts = { exitCode: res.code, errors: tr.errors, warnings: tr.warnings, tail: tr.tail, lines: res.lines };
    if (res.killedBy === "idle") {
      return { code: "network", message: "The download stalled (no data for 2 minutes).", detail: classifyRun(facts).detail, transient: true };
    }
    if (t.kind === "subtitle") {
      if (tr.subs.some((s) => s.filepath)) return null;
      if (tr.errors.length) return classifyRun(facts);
      const all = [...tr.warnings, ...tr.tail].join("\n");
      if (/HTTP Error 429|Too Many Requests/i.test(all)) {
        return { code: "rate_limited", message: "YouTube refused the subtitle request (HTTP 429, too many requests). Try again later.", detail: all.slice(-2000), transient: false };
      }
      const label = t.subTranslateTo ? `${t.subLang} -> ${t.subTranslateTo}` : t.subLang;
      return { code: "no_subtitles", message: `No ${t.subAuto ? "auto-generated " : ""}subtitles found for "${label}".`, detail: all.slice(-2000), transient: false };
    }
    // wait for pending stat() calls of `file` events
    for (let i = 0; i < 20 && this.#files.length < tr.files.length && !this.#hostFinishes(); i++) await sleep(25);
    if (t.playlist) {
      if (tr.files.length > 0) return null; // some items may have failed (-i); report the rest as done
      if (!tr.errors.length && res.code === 0) return { code: "unavailable", message: "The playlist has no downloadable videos.", detail: "", transient: false };
      return classifyRun(facts);
    }
    if (res.code === 0 && tr.files.length > 0) return null;
    if (res.code === 0) {
      return { code: "unknown", message: "yt-dlp finished without reporting a file.", detail: classifyRun(facts).detail, transient: false };
    }
    return classifyRun(facts);
  }

  /**
   * #finish(); a transient failure there (an empty clip) comes back like a failed run, with the download deleted,
   * so run() can try once more. Every other error is thrown on.
   */
  async #finishStep(): Promise<Classified | null> {
    try {
      await this.#finish();
      return null;
    } catch (e) {
      if (!(e instanceof JobError) || !e.transient || this.canceled) throw e;
      await this.#discardDownloads();
      return { code: e.code, message: e.message, detail: e.detail, transient: true };
    }
  }

  /** Host-side steps after a successful yt-dlp run. */
  async #finish() {
    const t = this.task;
    if (t.kind === "subtitle") return await this.#finishSubtitles();
    if (t.kind === "gif") return await this.#finishGif();
    if (hostCutsAudio(t)) return await this.#finishAudioCut();
    // yt-dlp wrote the final files: make sure every reported file was registered (no stat() for known ones)
    for (const f of this.#tracker!.files) {
      if (!this.#filePaths.has(f.path.toLowerCase())) await this.#addFile(f.path);
    }
    // a clip (yt-dlp --download-sections) can come out without any video, see EMPTY_INPUT
    if (t.kind === "video" && t.section && !t.playlist) {
      for (const f of this.#tracker!.files) await this.#assertHasVideo(f.path);
    }
  }

  /**
   * Before the retry after an empty clip: delete what yt-dlp reported (it would answer "has already been downloaded"
   * and hand over the same file) and forget it, so the `done` event lists only the new download.
   */
  async #discardDownloads() {
    for (const f of this.#tracker?.files ?? []) {
      const key = f.path.toLowerCase();
      if (this.#filePaths.delete(key)) this.#files = this.#files.filter((x) => x.path.toLowerCase() !== key);
      try {
        if (!(await Deno.lstat(f.path)).isFile) continue;
      } catch {
        continue; // already gone
      }
      log("info", `job ${this.id}: deleting the empty download ${f.path}`);
      await removeWithRetry(f.path, 10, 100);
    }
  }

  #tools(): ResolvedTools {
    return this.#env.tools();
  }

  /**
   * ffmpeg run by the host (stage 'cut' | 'gif'), with Job Object and idle watchdog. Its -progress
   * output only keeps the watchdog fed: protocol progress events are for downloads (video/audio/
   * download/subtitles); during these steps the UI shows the stage ("Creating the GIF...").
   */
  async #ffmpeg(args: string[], stage: "cut" | "gif"): Promise<void> {
    if (this.canceled) return;
    const ff = this.#tools().ffmpeg.path;
    if (!ff) throw new JobError("ffmpeg", "FFmpeg was not found.");
    const errLines: string[] = [];
    const full = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", ...args.slice(0, -1), "-progress", "pipe:1", "-stats_period", "1", args[args.length - 1]];
    log("info", `job ${this.id}: ffmpeg ${JSON.stringify(full)}`);
    let run: TrackedRun;
    try {
      run = runTracked(ff, {
        args: full,
        cwd: this.tmpDir,
        onLine: (ev) => {
          if (ev.stream === "stdout" && FfmpegProgress.isProgressLine(ev.line)) {
            // activity only
          } else {
            if (errLines.length < 30) errLines.push(ev.line);
            log("debug", `job ${this.id} ffmpeg: ${ev.line.slice(0, 400)}`);
          }
        },
        idleLimitMs: () => IDLE_LIMIT_MS,
      });
    } catch (e) {
      throw spawnFailure(e, "FFmpeg");
    }
    this.#run = run;
    const res = await run.result;
    this.#run = null;
    if (this.canceled) return;
    if (res.code !== 0) {
      const text = errLines.join("\n");
      if (EMPTY_INPUT.test(text)) throw emptyDownload(stage === "gif" ? "clip" : "audio file", text.slice(-3000));
      throw new JobError(/No space left|not enough space/i.test(text) ? "disk" : "ffmpeg", `FFmpeg failed (${stage}, exit ${res.code})`, text.slice(-3000));
    }
  }

  /**
   * Does a downloaded clip contain video (not counting an embedded cover)? ffprobe reads one packet of it. Only a
   * definite "no" throws (transient: run() downloads the clip again); no ffprobe or a probe that fails changes nothing.
   */
  async #assertHasVideo(path: string) {
    const ffprobe = this.#tools().ffmpeg.ffprobe;
    if (!ffprobe || this.canceled) return;
    let r: CaptureResult;
    try {
      r = await capture(ffprobe, [
        "-v", "error", "-select_streams", "V", "-read_intervals", "%+#1", "-count_packets",
        "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path,
      ], { timeoutMs: 30_000, maxLines: 20 });
    } catch (e) {
      log("warn", `job ${this.id}: ffprobe could not be started:`, String(e));
      return;
    }
    if (r.timedOut || r.code !== 0) {
      log("warn", `job ${this.id}: ffprobe ${r.timedOut ? "timed out" : `exit ${r.code}`} on ${path}: ${r.stderr.slice(-3).join(" ")}`);
      return;
    }
    const packets = r.stdout.map((l) => Number(l.trim())).filter((n) => Number.isFinite(n));
    if (packets.some((n) => n > 0)) return;
    log("warn", `job ${this.id}: ${path} has no video (${packets.length ? `video packets: ${packets.join(",")}` : "no video stream"})`);
    throw emptyDownload("clip", `ffprobe: ${packets.length ? "the video stream has no packets" : "no video stream"} in ${basename(path)}`);
  }

  async #moveIntoOutDir(src: string, base: string, ext: string): Promise<string> {
    const dest = await uniquePath(this.outDir, base, ext);
    await moveFile(src, dest); // a rename, unless the temp folder is the private one on another volume
    return dest;
  }

  async #finishAudioCut() {
    const t = this.task;
    const src = this.#tracker!.files[0]?.path;
    if (!src || !(await pathExists(src))) throw new JobError("unknown", "the downloaded audio file is missing");
    const ext = extname(src);
    const out = join(this.tmpDir, `cut${ext}`);
    this.#stage("cut");
    // Stream copy with input seeking: exact to the AAC frame (~21 ms), no re-encode. Map the audio
    // and the cover (attached picture) only - YouTube m4a files also carry a "text" data track the
    // m4a muxer cannot write ("Tag text incompatible with output codec id").
    await this.#ffmpeg([
      "-ss", fmtSeconds(t.section!.start), "-to", fmtSeconds(t.section!.end), "-i", src,
      "-map", "0:a", "-map", "0:v?", "-map_metadata", "0", "-c", "copy", out,
    ], "cut");
    if (this.canceled) return;
    if (!((await fileSize(out)) ?? 0)) throw new JobError("ffmpeg", "cutting the audio produced an empty file");
    const name = basename(src);
    const dest = await this.#moveIntoOutDir(out, name.slice(0, name.length - ext.length), ext);
    await this.#addFile(dest);
  }

  async #finishGif() {
    const t = this.task;
    const clip = this.#tracker!.files[0]?.path;
    if (!clip || !(await pathExists(clip))) throw new JobError("unknown", "the downloaded clip is missing");
    await this.#assertHasVideo(clip);
    if (this.canceled) return;
    const out = join(this.tmpDir, "out.gif");
    this.#stage("gif");
    const vf = `fps=${t.gifFps},scale='min(${t.gifWidth},iw)':-1:flags=lanczos,split[s0][s1];` +
      "[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle";
    await this.#ffmpeg(["-i", clip, "-vf", vf, "-loop", "0", out], "gif");
    if (this.canceled) return;
    // no frames in the clip (a stream without packets): the same empty section download
    if (!((await fileSize(out)) ?? 0)) throw new JobError("ffmpeg", "creating the GIF produced an empty file", "", true);
    const info = this.#tracker!.items[0] ?? { id: t.videoId ?? undefined };
    const base = hostBaseName(t.filenameStyle, info, ` (${clipLabel(t.section!)})`, this.#titleBytesFinal());
    await this.#addFile(await this.#moveIntoOutDir(out, base, "gif"));
  }

  #titleBytesFinal(): number {
    return Math.max(40, Math.min(150, MAX_PATH_BUDGET - this.outDir.length - 1 - styleOverhead(this.task.filenameStyle) - 40));
  }

  async #finishSubtitles() {
    const t = this.task;
    const tr = this.#tracker!;
    const { keys } = subtitleKeys(t);
    const found = tr.subs.filter((s) => typeof s.filepath === "string") as { ext?: string; filepath: string }[];
    // prefer the key order (e.g. "en-orig" before "en", "tr-en" before "tr")
    const pick = keys.map((k) => found.find((s) => basename(s.filepath).toLowerCase().includes(`.${k.toLowerCase()}.`))).find(Boolean) ?? found[0];
    if (!pick || !(await pathExists(pick.filepath))) throw new JobError("no_subtitles", "the subtitle file is missing");
    this.#stage("subtitles");
    const srcExt = (pick.ext ?? extname(pick.filepath).slice(1)).toLowerCase();
    const label = t.subTranslateTo ? `${t.subLang}→${t.subTranslateTo}` : t.subLang;
    const info = tr.items[0] ?? { id: t.videoId ?? undefined };
    const base = hostBaseName(t.filenameStyle, info, ` (${label})`, this.#titleBytesFinal());
    let dest: string;
    if ((t.subFormat === "srt" || t.subFormat === "txt") && srcExt !== t.subFormat) {
      const text = await Deno.readTextFile(pick.filepath);
      const converted = convertSubtitle(text, srcExt, t.subFormat);
      if (!converted) throw new JobError("no_subtitles", "the subtitle track is empty");
      const tmp = join(this.tmpDir, `converted.${t.subFormat}`);
      await Deno.writeTextFile(tmp, converted);
      dest = await this.#moveIntoOutDir(tmp, base, t.subFormat);
    } else {
      dest = await this.#moveIntoOutDir(pick.filepath, base, srcExt);
    }
    await this.#addFile(dest);
  }

  /** The `done` event (or an error when, against all odds, no file exists). */
  #doneEvent(): { event: "done" | "error"; data: Record<string, unknown> } {
    const files = this.#files.slice(0, MAX_FILES_IN_DONE);
    const totalSize = this.#files.reduce((a, f) => a + f.size, 0);
    if (!this.#files.length) return { event: "error", data: { code: "unknown", message: "no file was produced", detail: "" } };
    const ev: Record<string, unknown> = {
      files,
      filePath: files[0].path,
      fileSize: this.task.playlist ? totalSize : files[0].size,
    };
    if (this.#files.length > files.length) ev.filesTruncated = true;
    if (this.task.playlist) {
      ev.fileCount = this.#files.length;
      const failed = this.#tracker?.errors.length ?? 0;
      if (failed) ev.failedItems = failed;
    }
    return { event: "done", data: ev };
  }
}

export class JobManager {
  #jobs = new Map<string, Job>();
  #env: JobEnv;

  constructor(env: JobEnv) {
    this.#env = env;
  }

  get size(): number {
    return this.#jobs.size;
  }

  has(id: string): boolean {
    return this.#jobs.has(id);
  }

  /** Starts the job; the promise settles after its terminal event (the job is no longer counted then). */
  start(id: string, task: Task, outDir: string): Promise<void> {
    const job = new Job(id, task, outDir, this.#env);
    this.#jobs.set(id, job);
    return job.run()
      .catch((e) => log("error", `job ${id} crashed:`, e))
      .finally(() => this.#jobs.delete(id));
  }

  /** false when the job is unknown (already finished). */
  cancel(id: string): boolean {
    const job = this.#jobs.get(id);
    if (!job) return false;
    void job.cancel().catch((e) => log("warn", `cancel ${id} failed:`, e));
    return true;
  }

  /** Host shutdown: kill everything, remove temp dirs (bounded in time). No events are sent. */
  async shutdown(maxMs = 8000) {
    const all = [...this.#jobs.values()];
    if (!all.length) return;
    log("info", `shutdown: stopping ${all.length} job(s)`);
    await Promise.race([Promise.allSettled(all.map((j) => j.cancel(true))), sleep(maxMs)]);
  }
}
