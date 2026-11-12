// lib/tools.ts - tool versions (cached, so `hello` stays fast) and yt-dlp updates.

import { findOnPath, isFile, type ResolvedTools, STATE_DIR } from "./config.ts";
import { log } from "./log.ts";
import { type NetRoute, routeFor } from "./netproxy.ts";
import { basename, dirname, join, pathExists } from "./paths.ts";
import { capture, removeWithRetry, sleep, SYS32 } from "./proc.ts";

export interface ToolInfo {
  path: string | null;
  version: string | null;
  error?: string;
}

export interface ToolsInfo {
  ytdlp: ToolInfo & { variant: string };
  ffmpeg: ToolInfo & { ffprobe: string | null };
  deno: ToolInfo;
}

const CACHE_FILE = join(STATE_DIR, "tool-versions.json");
const PY_ENV = { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };

type Cache = Record<string, { version: string; at: string }>;
let memCache: Cache | null = null;

function readCache(): Cache {
  if (memCache) return memCache;
  try {
    const c = JSON.parse(Deno.readTextFileSync(CACHE_FILE));
    memCache = c && typeof c === "object" ? c as Cache : {};
  } catch {
    memCache = {};
  }
  return memCache;
}

async function writeCache(c: Cache) {
  memCache = c;
  try {
    await Deno.mkdir(STATE_DIR, { recursive: true });
    const tmp = `${CACHE_FILE}.${Deno.pid}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(c, null, 1));
    await Deno.rename(tmp, CACHE_FILE); // atomic replace; concurrent hosts cannot corrupt it
  } catch (e) {
    log("debug", "version cache not written:", String(e));
  }
}

/** Identity of a file version: path + size + mtime (stat follows symlinks). */
async function statKey(p: string): Promise<string | null> {
  try {
    const st = await Deno.stat(p);
    return `${p.toLowerCase()}|${st.size}|${st.mtime?.getTime() ?? 0}`;
  } catch {
    return null;
  }
}

function sitePackagesVersionFile(python: string | null): string | null {
  if (!python) return null;
  const p = join(dirname(python), "Lib", "site-packages", "yt_dlp", "version.py");
  try {
    return Deno.statSync(p).isFile ? p : null;
  } catch {
    return null;
  }
}

async function ytdlpVersion(t: ResolvedTools["ytdlp"], cache: Cache, force: boolean, timeoutMs = 25000): Promise<ToolInfo> {
  if (!t.path) return { path: null, version: null, error: "yt-dlp not found" };
  // pip installs: reading yt_dlp/version.py takes ~1 ms instead of 2-9 s for `yt-dlp --version`.
  const vf = t.versionFile ?? (t.variant === "pip" ? sitePackagesVersionFile(t.python) : null);
  if (vf) {
    try {
      const m = /__version__\s*=\s*['"]([^'"]+)['"]/.exec(await Deno.readTextFile(vf));
      if (m) return { path: t.path, version: m[1] };
    } catch { /* fall back to running it */ }
  }
  const key = await statKey(t.path);
  if (!key) return { path: t.path, version: null, error: "yt-dlp not found" };
  if (!force && cache[`ytdlp:${key}`]) return { path: t.path, version: cache[`ytdlp:${key}`].version };
  const r = await capture(t.path, ["--version"], { timeoutMs, env: PY_ENV });
  const v = r.stdout.map((l) => l.trim()).find((l) => /^\d{4}\.\d{1,2}\.\d{1,2}/.test(l)) ?? null;
  if (!v) {
    return { path: t.path, version: null, error: r.timedOut ? "yt-dlp --version timed out" : `yt-dlp --version failed (exit ${r.code}) ${r.stderr.slice(-3).join(" ")}`.trim() };
  }
  cache[`ytdlp:${key}`] = { version: v, at: new Date().toISOString() };
  return { path: t.path, version: v };
}

async function ffmpegVersion(path: string | null, cache: Cache, force: boolean): Promise<ToolInfo> {
  if (!path) return { path: null, version: null, error: "ffmpeg not found" };
  const key = await statKey(path);
  if (!key) return { path, version: null, error: "ffmpeg not found" };
  if (!force && cache[`ffmpeg:${key}`]) return { path, version: cache[`ffmpeg:${key}`].version };
  const r = await capture(path, ["-hide_banner", "-version"], { timeoutMs: 15000, maxLines: 5 });
  const m = /^ffmpeg version (\S+)/.exec(r.stdout[0] ?? "");
  if (!m) return { path, version: null, error: r.timedOut ? "ffmpeg -version timed out" : `ffmpeg -version failed (exit ${r.code})` };
  cache[`ffmpeg:${key}`] = { version: m[1], at: new Date().toISOString() };
  return { path, version: m[1] };
}

async function denoVersion(path: string, cache: Cache, force: boolean): Promise<ToolInfo> {
  if (path.toLowerCase() === Deno.execPath().toLowerCase()) return { path, version: Deno.version.deno };
  const key = await statKey(path);
  if (!key) return { path, version: null, error: "deno not found" };
  if (!force && cache[`deno:${key}`]) return { path, version: cache[`deno:${key}`].version };
  const r = await capture(path, ["--version"], { timeoutMs: 15000, maxLines: 5 });
  const m = /^deno (\S+)/.exec(r.stdout[0] ?? "");
  if (!m) return { path, version: null, error: `deno --version failed (exit ${r.code})` };
  cache[`deno:${key}`] = { version: m[1], at: new Date().toISOString() };
  return { path, version: m[1] };
}

/** Versions of all tools. Cached by file identity, so repeated hellos cost a few stat() calls. */
export async function toolsInfo(t: ResolvedTools, force = false): Promise<ToolsInfo> {
  const cache = { ...readCache() };
  const [yt, ff, dn] = await Promise.all([
    ytdlpVersion(t.ytdlp, cache, force),
    ffmpegVersion(t.ffmpeg.path, cache, force),
    denoVersion(t.deno.path, cache, force),
  ]);
  if (JSON.stringify(cache) !== JSON.stringify(readCache())) await writeCache(cache);
  return {
    ytdlp: { ...yt, variant: t.ytdlp.variant },
    ffmpeg: { ...ff, ffprobe: t.ffmpeg.ffprobe },
    deno: dn,
  };
}

// ---------------------------------------------------------------------------
// updateTools

export interface UpdateResult {
  ok: boolean;
  code?: string;
  error?: string;
  variant: string;
  command: string[];
  before: string | null;
  after: string | null;
  output: string;
  updated: boolean;
  dryRun?: boolean;
}

const MAX_OUTPUT = 32 * 1024;
/** time kept for the version check after pip / winget / yt-dlp -U */
const AFTER_RESERVE_MS = 20_000;
/** a download is given up only when no data arrived for this long (slow links are fine) */
const STALL_MS = 30_000;
const UA = "akif-youtube-addon-host";

function clipOutput(lines: string[]): string {
  const s = lines.join("\n");
  return s.length > MAX_OUTPUT ? "...\n" + s.slice(-MAX_OUTPUT) : s;
}

function wingetPath(): string | null {
  const local = Deno.env.get("LOCALAPPDATA");
  // winget.exe is an App Execution Alias: Deno.statSync() cannot open it (os error 1920), isFile() accepts it
  const p = local ? join(local, "Microsoft", "WindowsApps", "winget.exe") : null;
  return isFile(p) ? p : findOnPath("winget");
}

function updateCommand(t: ResolvedTools["ytdlp"]): string[] | null {
  switch (t.variant) {
    case "pip":
      return t.python
        ? [t.python, "-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "--no-input", "yt-dlp[default]"]
        : null;
    case "exe":
      return t.path ? [t.path, "-U"] : null;
    case "winget": {
      const w = wingetPath();
      return w
        ? [w, "upgrade", "-e", "--id", "yt-dlp.yt-dlp", "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"]
        : null;
    }
    case "onedir":
      return t.path ? ["(download)", `${YTDLP_REPO}/releases/latest/download/yt-dlp_win.zip`] : null;
    default:
      return null;
  }
}

/** A failed update step with its protocol code (update_failed | network | update_timeout). */
export class StepError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * One deadline for the whole update (version checks, downloads, unpacking, test run), so the host always
 * answers before the browser's own request timeout. When it runs out: code update_timeout - never the
 * browser's "timeout", which means the companion did not answer at all.
 */
export class Budget {
  constructor(readonly deadline: number) {}
  left(): number {
    return this.deadline - Date.now();
  }
  /** min(cap, time left); throws update_timeout when (almost) nothing is left */
  take(cap: number, step: string): number {
    const left = this.left();
    if (left < 1000) throw new StepError("update_timeout", `the yt-dlp update ran out of time (${step})`);
    return Math.min(cap, left);
  }
}

/**
 * Update yt-dlp the way its installation allows:
 *   pip    -> <python> -m pip install -U "yt-dlp[default]"
 *   exe    -> yt-dlp.exe -U (official single-file build)
 *   winget -> winget upgrade -e --id yt-dlp.yt-dlp
 *   onedir -> download yt-dlp_win.zip + SHA2-256SUMS of the newest release, verify, swap bin\yt-dlp\
 *             (yt-dlp -U refuses "unpackaged executables": win_dir is not self-updatable), through the
 *             Windows proxy when one is set (lib/netproxy.ts)
 * opts.timeoutMs bounds everything, including the version checks before and after.
 */
export async function updateYtDlp(tools: ResolvedTools, opts: { dryRun: boolean; force?: boolean; timeoutMs: number }): Promise<UpdateResult> {
  const budget = new Budget(Date.now() + opts.timeoutMs);
  const t = tools.ytdlp;
  const before = (await ytdlpVersion(t, {}, true, Math.max(1000, Math.min(25000, budget.left() / 4)))).version;
  const command = updateCommand(t);
  const base = { variant: t.variant, command: command ?? [], before, after: before, output: "", updated: false };
  if (!t.path) return { ...base, ok: false, code: "ytdlp_missing", error: "yt-dlp is not installed" };
  if (!command) {
    return { ...base, ok: false, code: "unsupported", error: `yt-dlp (${t.variant}) at ${t.path} cannot be updated automatically; update it the way it was installed` };
  }
  if (opts.dryRun) return { ...base, ok: true, dryRun: true, output: `would run: ${command.join(" ")}` };

  let output: string;
  let fresh: string | null = null;
  if (t.variant === "onedir") {
    const r = await updateOnedir(t.path, before, !!opts.force, budget);
    if (!r.ok) return { ...base, ok: false, code: r.code ?? "unknown", error: r.error, output: r.output };
    output = r.output;
    fresh = r.version ?? null;
  } else {
    // pip / winget / yt-dlp -U are stopped only when the whole budget is used up: pip killed while it swaps
    // the package can leave yt-dlp uninstalled, and pip ends network stalls itself (--timeout, --retries).
    const r = await capture(command[0], command.slice(1), { timeoutMs: Math.max(1000, budget.left() - AFTER_RESERVE_MS), env: PY_ENV });
    output = clipOutput([...r.stdout, ...r.stderr]);
    if (r.timedOut) {
      return { ...base, ok: false, code: "update_timeout", error: `the yt-dlp update did not finish within ${Math.round(opts.timeoutMs / 60000)} minutes and was stopped`, output };
    }
    if (r.code !== 0) {
      const err = /permission|access is denied|errno 13/i.test(output) ? "access denied (try running the update as administrator)" : `update failed (exit ${r.code})`;
      return { ...base, ok: false, code: "update_failed", error: err, output };
    }
  }
  const left = budget.left();
  const after = left >= 2000 ? ((await ytdlpVersion(t, {}, true, Math.min(25000, left))).version ?? fresh) : fresh;
  return { ...base, ok: true, after, output, updated: !!after && after !== before };
}

const YTDLP_REPO = "https://github.com/yt-dlp/yt-dlp";

/** Retry transient failures: connection resets (os error 10054), timeouts, 5xx and 429 answers. */
function retryable(e: unknown): boolean {
  if (e instanceof StepError) return e.code === "network";
  return !(e instanceof Deno.errors.PermissionDenied || e instanceof Deno.errors.NotFound || /os error 112\b|not enough space/i.test(String(e)));
}

function httpError(url: string, status: number): StepError {
  // 4xx (except 429): the file is not there - retrying cannot help
  return new StepError(status >= 500 || status === 429 ? "network" : "update_failed", `GET ${url} -> HTTP ${status}`);
}

const errText = (e: unknown, max: number) => String((e as Error)?.message ?? e).slice(0, max);

/** A small request: up to 3 attempts of at most 30 s each. */
async function smallRequest<T>(what: string, budget: Budget, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await run(AbortSignal.timeout(budget.take(30000, what)));
    } catch (e) {
      if (e instanceof StepError && e.code !== "network") throw e;
      last = e;
      if (!retryable(e)) throw e;
    }
    log("warn", `${what}: attempt ${attempt} failed: ${errText(last, 200)}`);
    await sleep(Math.min(attempt * 1500, Math.max(0, budget.left() - 1000)));
  }
  throw new StepError("network", `${what} failed: ${errText(last, 300)}`);
}

/** A small text file (SHA2-256SUMS). */
function fetchText(url: string, budget: Budget, client?: Deno.HttpClient): Promise<string> {
  return smallRequest(`downloading ${url.slice(url.lastIndexOf("/") + 1)}`, budget, async (signal) => {
    const r = await fetch(url, { signal, headers: { "User-Agent": UA }, client });
    if (!r.ok) {
      await r.body?.cancel();
      throw httpError(url, r.status);
    }
    return await r.text();
  });
}

/**
 * The tag of a GitHub repository's newest release, read from the redirect of <repo>/releases/latest (nothing else is
 * downloaded), so that SHA2-256SUMS and the zip come from the same release, as in install.ps1. null when GitHub does
 * not name it; the caller then uses /releases/latest/download/ (a file and checksum list from two different releases
 * fail the checksum: the update fails closed). Exported for tests.
 */
export function latestReleaseTag(repoUrl: string, budget: Budget, client?: Deno.HttpClient): Promise<string | null> {
  const url = `${repoUrl}/releases/latest`;
  return smallRequest("looking up the newest yt-dlp release", budget, async (signal) => {
    const r = await fetch(url, { signal, redirect: "manual", headers: { "User-Agent": UA }, client });
    await r.body?.cancel();
    if (r.status >= 500 || r.status === 429) throw httpError(url, r.status);
    const m = /\/releases\/tag\/([A-Za-z0-9._-]+)$/.exec(r.headers.get("location") ?? "");
    if (!m) log("warn", `GET ${url} -> HTTP ${r.status} without a release tag; using /releases/latest/download/`);
    return m ? m[1] : null;
  });
}

async function writeAll(f: Deno.FsFile, data: Uint8Array) {
  let off = 0;
  while (off < data.length) off += await f.write(data.subarray(off));
}

/**
 * Download url to dest. A transfer is given up only when no data arrived for STALL_MS (a slow but working
 * connection may use the whole update budget); an interrupted transfer continues with a Range request.
 * client: the proxy route (lib/netproxy.ts). Exported for tests.
 */
export async function downloadFile(url: string, dest: string, budget: Budget, stallMs = STALL_MS, client?: Deno.HttpClient): Promise<number> {
  const name = basename(dest);
  let have = 0;
  let last: unknown = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const ctl = new AbortController();
    let why = null as "stall" | "deadline" | null; // set by the timers below
    const deadline = setTimeout(() => {
      why = "deadline";
      ctl.abort();
    }, budget.take(Number.MAX_SAFE_INTEGER, `downloading ${name}`));
    let stall: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        why ??= "stall";
        ctl.abort();
      }, stallMs);
    };
    kick();
    let file: Deno.FsFile | null = null;
    try {
      const headers: Record<string, string> = { "User-Agent": UA };
      if (have > 0) headers.Range = `bytes=${have}-`;
      const r = await fetch(url, { signal: ctl.signal, headers, client });
      kick();
      const resumed = have > 0 && r.status === 206 && (r.headers.get("content-range") ?? "").startsWith(`bytes ${have}-`);
      if (!r.ok || (r.status === 206 && !resumed)) {
        await r.body?.cancel();
        if (r.status === 206 || r.status === 416) {
          have = 0; // the server did not continue where we stopped: start over
          throw new StepError("network", `GET ${url} -> HTTP ${r.status} for a resumed download`);
        }
        throw httpError(url, r.status);
      }
      if (!r.body) throw new StepError("network", `GET ${url}: empty response`);
      if (!resumed) have = 0;
      file = await Deno.open(dest, { write: true, create: true, truncate: !resumed, append: resumed });
      for await (const chunk of r.body) {
        kick();
        await writeAll(file, chunk);
        have += chunk.byteLength;
      }
      return have;
    } catch (e) {
      if (why === "deadline") throw new StepError("update_timeout", `the yt-dlp update ran out of time (downloading ${name}, ${have} bytes received)`);
      last = why === "stall" ? new StepError("network", `the download of ${name} stalled (no data for ${Math.round(stallMs / 1000)} s)`) : e;
      if (!retryable(last)) throw last;
    } finally {
      clearTimeout(deadline);
      clearTimeout(stall);
      try {
        file?.close();
      } catch { /* already closed */ }
    }
    log("warn", `${name}: attempt ${attempt} failed after ${have} bytes: ${String((last as Error)?.message ?? last).slice(0, 200)}`);
    await sleep(Math.min(attempt * 1500, Math.max(0, budget.left() - 1000)));
  }
  throw new StepError("network", `downloading ${name} failed: ${String((last as Error)?.message ?? last).slice(0, 300)}`);
}

/**
 * Unpack <dir>\<zipName> into the existing folder <dir>\<destName> with Windows' tar.exe (bsdtar). tar.exe
 * converts its command line to the ANSI code page: an absolute path with characters outside it (a profile
 * folder like "Şəhla" or "Тест") arrives as "?" and the archive cannot be opened. So only short ASCII names
 * relative to the working directory are passed; the Unicode folder travels as the cwd (CreateProcessW).
 */
export async function extractZip(dir: string, zipName: string, destName: string, timeoutMs: number) {
  const plain = /^[A-Za-z0-9._-]+$/;
  if (!plain.test(zipName) || !plain.test(destName)) throw new Error("extractZip: zip and folder names must be plain ASCII");
  return await capture(`${SYS32}\\tar.exe`, ["-xf", zipName, "-C", destName], { cwd: dir, timeoutMs });
}

async function sha256Hex(path: string): Promise<string> {
  const data = await Deno.readFile(path);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function updateOnedir(
  exePath: string,
  before: string | null,
  force: boolean,
  budget: Budget,
): Promise<{ ok: boolean; code?: string; error?: string; output: string; version?: string }> {
  const out: string[] = [];
  const dir = dirname(exePath); // ...\bin\yt-dlp
  const parent = dirname(dir);
  const ZIP = "yt-dlp-update.zip";
  const NEW = "yt-dlp.new";
  const zip = join(parent, ZIP);
  const fresh = join(parent, NEW);
  const old = join(parent, "yt-dlp.old");
  const route: NetRoute = routeFor(YTDLP_REPO);
  log("info", `onedir update: connecting through ${route.via}`);
  try {
    // every file from the one newest release (install.ps1 does the same)
    const tag = await latestReleaseTag(YTDLP_REPO, budget, route.client);
    const base = tag ? `${YTDLP_REPO}/releases/download/${tag}/` : `${YTDLP_REPO}/releases/latest/download/`;
    out.push(`newest release ${tag ?? "(not named by GitHub)"}`);
    const sums = await fetchText(base + "SHA2-256SUMS", budget, route.client);
    const line = sums.split(/\r?\n/).find((l) => /\s\*?yt-dlp_win\.zip$/.test(l.trim()));
    const expected = line?.trim().split(/\s+/)[0]?.toLowerCase();
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) return { ok: false, code: "update_failed", error: "yt-dlp_win.zip is not listed in SHA2-256SUMS", output: out.join("\n") };
    out.push(`expected sha256 ${expected}`);
    // install.ps1 / the last update record the hash of the zip they installed
    const stampFile = join(STATE_DIR, "ytdlp-onedir.sha256");
    let current = "";
    try {
      current = (await Deno.readTextFile(stampFile)).trim();
    } catch { /* unknown */ }
    if (!force && (current === expected || (tag !== null && before === tag))) {
      if (current !== expected) await Deno.writeTextFile(stampFile, expected).catch(() => {}); // the installed build IS that release
      out.push(`yt-dlp is up to date (${before ?? "unknown version"})`);
      return { ok: true, output: out.join("\n") };
    }
    const bytes = await downloadFile(base + "yt-dlp_win.zip", zip, budget, STALL_MS, route.client);
    const got = await sha256Hex(zip);
    if (got !== expected) return { ok: false, code: "update_failed", error: `checksum mismatch (got ${got})`, output: out.join("\n") };
    out.push(`downloaded ${bytes} bytes, checksum OK`);
    await removeWithRetry(fresh);
    await Deno.mkdir(fresh, { recursive: true });
    const x = await extractZip(parent, ZIP, NEW, budget.take(120000, "extracting"));
    if (x.timedOut && budget.left() < 1000) throw new StepError("update_timeout", "the yt-dlp update ran out of time (extracting)");
    if (x.code !== 0) return { ok: false, code: "update_failed", error: `extracting failed (exit ${x.code})`, output: clipOutput([...out, ...x.stderr]) };
    let root = fresh;
    if (!(await pathExists(join(root, "yt-dlp.exe")))) {
      for await (const e of Deno.readDir(fresh)) {
        if (e.isDirectory && await pathExists(join(fresh, e.name, "yt-dlp.exe"))) root = join(fresh, e.name);
      }
    }
    const test = await capture(join(root, "yt-dlp.exe"), ["--version"], { timeoutMs: budget.take(60000, "testing the new version"), env: PY_ENV });
    if (test.timedOut && budget.left() < 1000) throw new StepError("update_timeout", "the yt-dlp update ran out of time (testing the new version)");
    if (test.code !== 0) return { ok: false, code: "update_failed", error: "the new yt-dlp does not start", output: clipOutput([...out, ...test.stderr]) };
    const version = test.stdout.map((l) => l.trim()).find((l) => /^\d{4}\.\d{1,2}\.\d{1,2}/.test(l));
    out.push(`new version ${version ?? test.stdout[0] ?? "?"}`);
    // Renaming a folder whose yt-dlp.exe is running succeeds on Windows, so this does NOT detect a download
    // that still uses the old build: host.ts refuses updates while any host instance runs jobs (coord.ts).
    // A yt-dlp.old that is still in use (an old download) must not block the update: move aside instead.
    let oldDir = old;
    if (!(await removeWithRetry(old, 5, 200))) oldDir = `${old}.${Date.now()}`;
    await Deno.rename(dir, oldDir);
    try {
      await Deno.rename(root, dir);
    } catch (e) {
      await Deno.rename(oldDir, dir); // roll back
      throw e;
    }
    await removeWithRetry(oldDir, 10, 200);
    await removeWithRetry(fresh, 5, 200);
    try {
      for await (const e of Deno.readDir(parent)) {
        if (e.isDirectory && !e.isSymlink && /^yt-dlp\.old\.\d+$/.test(e.name)) await removeWithRetry(join(parent, e.name), 2, 100);
      }
    } catch { /* best effort */ }
    await Deno.mkdir(STATE_DIR, { recursive: true });
    await Deno.writeTextFile(stampFile, expected);
    return { ok: true, output: out.join("\n"), version };
  } catch (e) {
    log("warn", `onedir update failed (connected through ${route.via}):`, e);
    const code = e instanceof StepError ? e.code : e instanceof TypeError || (e as Error)?.name === "TimeoutError" ? "network" : "update_failed";
    let error = String((e as Error)?.message ?? e);
    if (code === "network") error += ` (connected through ${route.via}${route.hint ? `; ${route.hint}` : ""})`;
    return { ok: false, code, error, output: out.join("\n") };
  } finally {
    route.close();
    await removeWithRetry(zip, 5, 200);
  }
}
