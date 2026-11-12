// host.ts - native messaging host of "Akif's Special YouTube Addon" (Deno 2.x, Windows).
//
// Launched by Chrome/Edge as
//   cmd.exe /d /s /c ""<dir>\host.bat" chrome-extension://<id>/ --parent-window=0" < \\.\pipe\...in > \\.\pipe\...out
// stdin/stdout carry length-prefixed UTF-8 JSON (spec section 8). stdout is reserved for
// protocol frames: all logging goes to <root>\logs\host.log, console.* is re-routed there
// (lib/guard.ts) and every child process gets explicit stdio (lib/proc.ts).
//
// Requests  {id, type, ...}          -> responses {re:id, ok:true, ...} | {re:id, ok:false, error, code}
// Events    {event, jobId, ...}      info | progress | stage | file | done | error | canceled
//
// Environment (tests/diagnostics only):
//   AKIF_HOST_TEST=1   open / pickFolder / updateTools validate but never open windows or change anything
//   AKIF_HOST_LOG      log file path
//   AKIF_HOST_CONFIG   config.json path
//   AKIF_TEST_START_DELAY_MS  (with AKIF_HOST_TEST=1) a slow output folder: each start waits this long for it

import "./lib/guard.ts"; // MUST stay the first import: re-routes console.* before other modules run
import { loadConfig, type ResolvedTools, resolveTools } from "./lib/config.ts";
import { announce, othersDoing, withdraw } from "./lib/coord.ts";
import { JobManager } from "./lib/jobs.ts";
import { closeLog, initLog, log } from "./lib/log.ts";
import { FrameReader, FrameWriter, ProtocolError } from "./lib/nm_io.ts";
import { dirname, extname, HOST_DIR, isDirectory, join, normalizeAbsolutePath, ROOT_DIR, subfolderPath } from "./lib/paths.ts";
import { sleep } from "./lib/proc.ts";
import { Starter } from "./lib/starts.ts";
import { BadTask, type Task } from "./lib/task.ts";
import { sweepPrivateTemp } from "./lib/tempdirs.ts";
import { toolsInfo, updateYtDlp } from "./lib/tools.ts";
import { downloadsDir, pickFolder, revealInFolder, shellOpen } from "./lib/winshell.ts";

const HOST_NAME = "akif-youtube-addon-host";
const HOST_VERSION = "1.0.0";
const PROTOCOL = 1;
const TEST_MODE = Deno.env.get("AKIF_HOST_TEST") === "1";
const DEFAULT_SUBFOLDER = "Akif YouTube";
const MAX_JOBS = 8;
/**
 * Whole updateTools budget (version checks, ~24 MB download on a slow link, unpacking, test run). The
 * service worker's request timeout must be longer, so the host always answers first; an update still
 * running when the port closes is finished before the host exits (see shutdown()).
 */
const UPDATE_BUDGET_MS = 9 * 60_000;

/** Files `open` may launch with their default app (never executables, scripts or shortcuts). */
const OPENABLE_EXT = new Set([
  ".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi",
  ".m4a", ".mp3", ".opus", ".ogg", ".oga", ".flac", ".wav", ".aac", ".mka",
  ".gif", ".jpg", ".jpeg", ".png", ".webp",
  ".srt", ".vtt", ".ttml", ".srv3", ".json3", ".txt", ".ass", ".lrc",
]);

const ORIGIN = Deno.args[0] ?? "";

initLog(Deno.env.get("AKIF_HOST_LOG") || join(ROOT_DIR, "logs", "host.log"));
log("info", `start v${HOST_VERSION} deno=${Deno.version.deno} origin=${ORIGIN} hostDir=${HOST_DIR}${TEST_MODE ? " TEST MODE" : ""}`);

globalThis.addEventListener("unhandledrejection", (e) => {
  e.preventDefault(); // keep the host alive; the browser would only see "Native host has exited"
  log("error", "unhandled rejection:", e.reason);
});
globalThis.addEventListener("error", (e) => {
  e.preventDefault();
  log("error", "uncaught error:", e.error ?? e.message);
});

if (Deno.stdin.isTerminal()) {
  // Someone double-clicked host.bat.
  Deno.stderr.writeSync(new TextEncoder().encode(
    "This is the native messaging host of Akif's Special YouTube Addon. It is started by Chrome/Edge;\n" +
      "there is nothing to do here. To install or repair the companion app, run install.bat.\n",
  ));
  Deno.exit(2);
}

// Private job folders (cookies!) of a host that was killed or crashed: remove them now, not after hours.
void sweepPrivateTemp().catch((e) => log("warn", "private temp sweep failed:", e));

const reader = new FrameReader(Deno.stdin);
const writer = new FrameWriter(Deno.stdout);
const decoder = new TextDecoder("utf-8", { fatal: true });

type Msg = { id?: unknown; type?: unknown; [k: string]: unknown };

let shuttingDown = false;

function send(msg: Record<string, unknown>): Promise<void> {
  return writer.send(msg).catch(async (e) => {
    if (e instanceof ProtocolError && /accepts at most/.test(e.message)) {
      // Never let one oversized message close the port: drop it (stream stays in sync).
      log("error", `dropped an oversized message (${msg.event ?? msg.re ?? "?"}):`, e.message);
      if (msg.re !== undefined) await writer.send({ re: msg.re, ok: false, code: "too_large", error: "the reply was too large" }).catch(() => {});
      return;
    }
    log("warn", "send failed:", String(e));
    void shutdown("stdout broken");
  });
}

const reply = (id: unknown, data: Record<string, unknown> = {}) => send({ re: id, ok: true, ...data });
const fail = (id: unknown, code: string, error: string, extra: Record<string, unknown> = {}) => send({ re: id, ok: false, code, error, ...extra });

// ---- tools (re-resolved every minute and on hello, so a reinstall is picked up) ----
let tools: ResolvedTools = resolveTools(loadConfig());
let toolsAt = Date.now();
function currentTools(force = false): ResolvedTools {
  if (force || Date.now() - toolsAt > 60_000) {
    tools = resolveTools(loadConfig());
    toolsAt = Date.now();
  }
  return tools;
}

const jobs = new JobManager({ emit: (m) => void send(m), tools: () => currentTools() });

// ---- requests ----

async function hello(m: Msg) {
  const t = currentTools(true);
  const info = await toolsInfo(t, m.refresh === true);
  const dl = downloadsDir();
  const sub = typeof m.subfolder === "string" ? m.subfolder : DEFAULT_SUBFOLDER;
  return {
    name: HOST_NAME,
    version: HOST_VERSION,
    protocol: PROTOCOL,
    platform: Deno.build.os,
    arch: Deno.build.arch,
    tools: {
      ytdlp: { path: info.ytdlp.path, version: info.ytdlp.version, variant: info.ytdlp.variant, ...(info.ytdlp.error ? { error: info.ytdlp.error } : {}) },
      ffmpeg: { path: info.ffmpeg.path, version: info.ffmpeg.version, ...(info.ffmpeg.error ? { error: info.ffmpeg.error } : {}) },
      deno: { path: info.deno.path, version: info.deno.version },
    },
    downloadsDir: dl,
    defaultDir: join(dl, subfolderPath(sub)),
    pid: Deno.pid,
    ...(TEST_MODE ? { testMode: true } : {}),
  };
}

const TEST_START_DELAY_MS = TEST_MODE ? Math.min(10_000, Number(Deno.env.get("AKIF_TEST_START_DELAY_MS")) || 0) : 0;

async function resolveOutputDir(task: Task): Promise<string> {
  if (TEST_START_DELAY_MS > 0) await sleep(TEST_START_DELAY_MS);
  const dir = task.outputDir || join(downloadsDir(), task.subfolder);
  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch (e) {
    throw new BadTask(`cannot create the output folder ${dir}: ${(e as Error).message}`);
  }
  if (!(await isDirectory(dir))) throw new BadTask(`${dir} is not a folder`);
  return dir;
}

let updating = false;
/** the running updateTools (shutdown lets it finish: a half-done pip install or folder swap breaks yt-dlp) */
let updateRun: Promise<unknown> | null = null;

// start / cancel: the job id is reserved before the output folder is awaited (lib/starts.ts)
const starter = new Starter({
  jobs,
  maxJobs: MAX_JOBS,
  resolveOutputDir,
  blocked: () => (updating ? "yt-dlp is being updated; try again in a moment" : null),
  admit: () => {
    announce("jobs");
    if (!othersDoing("update").length) return null;
    if (jobs.size === 0) withdraw("jobs");
    return "yt-dlp is being updated (from another browser window); try again in a moment";
  },
  ended: () => {
    if (jobs.size === 0) withdraw("jobs");
  },
  reply,
  fail,
  emit: (msg) => void send(msg),
});

async function open(id: unknown, m: Msg) {
  const target = m.target === "folder" ? "folder" : m.target === "file" ? "file" : null;
  if (!target) return fail(id, "bad_request", "target must be 'file' or 'folder'");
  const p = normalizeAbsolutePath(m.path, 1024);
  if (!p) return fail(id, "bad_path", "path must be an absolute path");
  let st: Deno.FileInfo;
  try {
    st = await Deno.stat(p);
  } catch {
    return fail(id, "not_found", "the file does not exist (it may have been moved or deleted)");
  }
  if (target === "file") {
    if (!st.isFile) return fail(id, "bad_path", "not a file");
    if (!OPENABLE_EXT.has(extname(p))) return fail(id, "bad_path", "only media, subtitle and image files can be opened");
    if (TEST_MODE) return reply(id, { dryRun: true, action: "open" });
    const r = shellOpen(p);
    return r.ok ? reply(id) : fail(id, "open_failed", r.error ?? "could not open the file");
  }
  if (st.isFile) {
    if (TEST_MODE) return reply(id, { dryRun: true, action: "reveal" });
    const r = revealInFolder(p);
    if (r.ok) return reply(id);
    log("warn", `reveal failed (${r.error}); opening the folder instead`);
    const r2 = shellOpen(dirname(p));
    return r2.ok ? reply(id) : fail(id, "open_failed", r2.error ?? "could not open the folder");
  }
  if (!st.isDirectory) return fail(id, "bad_path", "not a file or folder");
  if (TEST_MODE) return reply(id, { dryRun: true, action: "openFolder" });
  const r = shellOpen(p);
  return r.ok ? reply(id) : fail(id, "open_failed", r.error ?? "could not open the folder");
}

/** the open folder picker, also while it starts: kill() ends its PowerShell (and does nothing once that has exited) */
let picker: { kill: () => void } | null = null;

async function pick(id: unknown, m: Msg) {
  if (TEST_MODE) return reply(id, { path: Deno.env.get("AKIF_TEST_PICK") || null, dryRun: true });
  if (picker) return fail(id, "busy", "a folder picker is already open");
  const current = { kill: () => {} };
  picker = current;
  try {
    const initial = normalizeAbsolutePath(m.initial, 400);
    const initialDir = initial && (await isDirectory(initial)) ? initial : downloadsDir();
    const r = await pickFolder({
      title: typeof m.title === "string" && m.title.trim() && m.title.length <= 200 ? m.title : "Choose a download folder",
      okLabel: typeof m.okLabel === "string" && m.okLabel.length <= 40 ? m.okLabel : undefined,
      initialDir,
      onSpawn: (kill) => (current.kill = kill),
    });
    if (!r.ok) return fail(id, "picker_failed", r.error ?? "the folder picker failed");
    return reply(id, { path: r.cancelled ? null : (r.path ?? null), ...(r.timedOut ? { timedOut: true } : {}) });
  } finally {
    picker = null;
  }
}

async function update(id: unknown, m: Msg) {
  if (updating) return fail(id, "busy", "an update is already running");
  if (starter.count > 0) return fail(id, "busy", "wait until the running downloads have finished");
  updating = true;
  // bin\ and site-packages are shared by every host instance (Chrome, Edge, each profile)
  announce("update");
  try {
    if (othersDoing("jobs").length) return await fail(id, "busy", "wait until the downloads in the other browser window have finished");
    if (othersDoing("update").length) return await fail(id, "busy", "an update is already running");
    const run = updateYtDlp(currentTools(true), { dryRun: TEST_MODE, force: m.force === true, timeoutMs: UPDATE_BUDGET_MS });
    updateRun = run;
    const r = await run;
    currentTools(true);
    const data = { before: r.before, after: r.after, output: r.output, variant: r.variant, updated: r.updated, ...(r.dryRun ? { dryRun: true, command: r.command } : {}) };
    log("info", `updateTools: ok=${r.ok} ${r.before} -> ${r.after} (${r.variant})${r.ok ? "" : ` ${r.code}: ${r.error}`}`);
    return r.ok ? reply(id, data) : fail(id, r.code ?? "update_failed", r.error ?? "update failed", data);
  } finally {
    updateRun = null;
    withdraw("update");
    updating = false;
  }
}

async function handle(m: Msg) {
  const id = m.id;
  if (typeof id !== "string" && typeof id !== "number") return fail(null, "bad_request", "request id must be a string");
  if (m.type !== "ping") log("debug", `<- ${String(m.type)} id=${String(id)}${m.jobId ? ` job=${String(m.jobId)}` : ""}`);
  switch (m.type) {
    case "ping":
      return reply(id);
    case "hello":
      return reply(id, await hello(m));
    case "start":
      return starter.start(id, m.jobId, m.task);
    case "cancel": {
      if (typeof m.jobId !== "string") return fail(id, "bad_request", "jobId is required");
      return reply(id, starter.cancel(m.jobId) ? {} : { found: false });
    }
    case "open":
      return open(id, m);
    case "pickFolder":
      return pick(id, m);
    case "updateTools":
      return update(id, m);
    default:
      return fail(id, "unknown_type", `unknown request type ${JSON.stringify(m.type)}`);
  }
}

async function shutdown(reason: string): Promise<never> {
  if (!shuttingDown) {
    shuttingDown = true;
    log("info", `shutdown: ${reason}`);
    picker?.kill();
    starter.cancelPending(); // a start still waiting for its folder never launches
    await jobs.shutdown(); // kills every job tree and removes temp dirs
    withdraw("jobs");
    if (updateRun) {
      // The port closed (browser closed, or the service worker gave up waiting) while yt-dlp is being
      // updated. Killing pip / tar / the folder swap half-way can break the installation: finish the update
      // (it has its own deadline) and exit afterwards. Nobody waits for this process any more.
      log("info", "shutdown: letting the running yt-dlp update finish first");
      await Promise.race([updateRun.catch(() => {}), sleep(UPDATE_BUDGET_MS + 30_000)]);
    }
    withdraw("update");
    await Promise.race([writer.flush(), sleep(1000)]);
    log("info", "bye");
    closeLog();
    Deno.exit(0);
  }
  return await new Promise<never>(() => {});
}

// ---- main loop ----
while (true) {
  let body: Uint8Array | null;
  try {
    body = await reader.next();
  } catch (e) {
    log("error", "read failed:", String(e));
    break;
  }
  if (body === null || shuttingDown) break; // stdin EOF: the browser closed the port
  let msg: Msg;
  try {
    msg = JSON.parse(decoder.decode(body));
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw new Error("not an object");
  } catch (e) {
    void fail(null, "bad_request", `bad message: ${(e as Error).message}`);
    continue;
  }
  handle(msg).catch((e) => {
    log("warn", `handler ${String(msg.type)} failed:`, e);
    void fail(msg.id ?? null, "internal", String((e as Error)?.message ?? e));
  });
}
await shutdown("stdin EOF");
