// lib/proc.ts - child processes for a native messaging host on Windows.
//
// 1. spawnLines(): Deno.Command with ALL stdio explicit (the spawn() default is
//    "inherit", which would hand Chrome's message pipe to the child), streaming
//    UTF-8 lines as they arrive.
// 2. Process-tree cancellation: a Job Object (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
//    per run - it also catches orphans and dies with the host even if the host
//    itself is killed - plus a snapshot-based TerminateProcess sweep and a
//    taskkill /T /F fallback. child.kill() alone is never enough: ffmpeg started
//    by yt-dlp survives it and keeps our pipes open.
// 3. runTracked(): spawn + job + line callback + idle watchdog + kill(), with a
//    guard against grandchildren that keep the pipes open after the child exits.

import { log } from "./log.ts";
import { basename, join } from "./paths.ts";

const SYSROOT = Deno.env.get("SystemRoot") ?? "C:\\Windows";
export const SYS32 = `${SYSROOT}\\System32`;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LineEvent {
  stream: "stdout" | "stderr";
  line: string;
  /** what ended the line: "\n", "\r\n", "\r" (progress overwrite) or "" (EOF) */
  eol: string;
  /** ms since spawn */
  t: number;
}

/**
 * Text -> lines. Terminators: "\n", "\r\n", and a bare "\r" (yt-dlp/ffmpeg
 * progress without --newline). A "\r" at the end of a chunk is emitted at once;
 * a "\n" that then starts the next chunk is recognised as the second half of
 * CRLF and swallowed.
 */
export class LineSplitter extends TransformStream<string, { line: string; eol: string }> {
  constructor() {
    let carry = "";
    let pendingCR = false;
    super({
      transform(chunk, ctl) {
        let i = 0;
        if (pendingCR) {
          pendingCR = false;
          if (chunk.charCodeAt(0) === 10) i = 1;
        }
        let start = i;
        for (; i < chunk.length; i++) {
          const c = chunk.charCodeAt(i);
          if (c === 10) {
            ctl.enqueue({ line: carry + chunk.slice(start, i), eol: "\n" });
            carry = "";
            start = i + 1;
          } else if (c === 13) {
            const line = carry + chunk.slice(start, i);
            carry = "";
            if (i + 1 < chunk.length) {
              if (chunk.charCodeAt(i + 1) === 10) {
                ctl.enqueue({ line, eol: "\r\n" });
                i++;
              } else ctl.enqueue({ line, eol: "\r" });
            } else {
              ctl.enqueue({ line, eol: "\r" });
              pendingCR = true;
            }
            start = i + 1;
          }
        }
        carry += chunk.slice(start);
        // Never buffer unbounded text from a misbehaving child.
        if (carry.length > 1024 * 1024) {
          ctl.enqueue({ line: carry, eol: "" });
          carry = "";
        }
      },
      flush(ctl) {
        if (carry) ctl.enqueue({ line: carry, eol: "" });
      },
    });
  }
}

export interface SpawnLinesOptions {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** keep empty lines (default false: they are mostly CR/LF artefacts) */
  keepEmpty?: boolean;
}

export interface SpawnedLines {
  child: Deno.ChildProcess;
  pid: number;
  t0: number;
  lines: AsyncIterableIterator<LineEvent>;
  /** resolves when the child has exited AND both pipes reached EOF */
  done: Promise<{ status: Deno.CommandStatus; pipesClosedAt: number; exitedAt: number }>;
}

/** Spawn with explicit stdio and get stdout+stderr as one ordered-by-arrival line stream. */
export function spawnLines(cmd: string, opts: SpawnLinesOptions = {}): SpawnedLines {
  const t0 = performance.now();
  const child = new Deno.Command(cmd, {
    args: opts.args ?? [],
    cwd: opts.cwd,
    env: opts.env,
    stdin: "null", // NEVER inherit: the host's stdin is Chrome's message pipe
    stdout: "piped", // NEVER inherit: the host's stdout is Chrome's message pipe
    stderr: "piped",
  }).spawn();

  const queue: LineEvent[] = [];
  let wake: (() => void) | null = null;
  let open = 2;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  const pump = async (rs: ReadableStream<Uint8Array<ArrayBuffer>>, stream: "stdout" | "stderr") => {
    try {
      // TextDecoderStream keeps state between chunks (split multi-byte UTF-8 is
      // decoded correctly); invalid bytes become U+FFFD instead of throwing.
      const it = rs.pipeThrough(new TextDecoderStream("utf-8")).pipeThrough(new LineSplitter());
      for await (const { line, eol } of it) {
        if (!line && !opts.keepEmpty) continue;
        queue.push({ stream, line, eol, t: performance.now() - t0 });
        notify();
      }
    } catch (e) {
      log("debug", `pump ${stream} ended with`, String(e));
    } finally {
      open--;
      notify();
    }
  };
  const pumps = [pump(child.stdout, "stdout"), pump(child.stderr, "stderr")];

  let exitedAt = 0;
  const statusP = child.status.then((s) => {
    exitedAt = performance.now() - t0;
    return s;
  });
  const done = Promise.all(pumps).then(async () => {
    const pipesClosedAt = performance.now() - t0;
    return { status: await statusP, pipesClosedAt, exitedAt };
  });

  async function* gen(): AsyncIterableIterator<LineEvent> {
    while (true) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (open === 0) return;
      await new Promise<void>((r) => (wake = r));
    }
  }
  return { child, pid: child.pid, t0, lines: gen(), done };
}

/** taskkill /PID <pid> /T /F - kills the process and every descendant it can still see. */
export async function taskkillTree(pid: number): Promise<{ code: number; output: string }> {
  const r = await new Deno.Command(`${SYS32}\\taskkill.exe`, {
    args: ["/PID", String(pid), "/T", "/F"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  // taskkill output is localised and in the OEM code page; for logs only.
  const output = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  return { code: r.code, output: output.trim() };
}

// ---------------------------------------------------------------------------
// kernel32 via FFI (Deno 2.x: Deno.dlopen works with --allow-ffi / -A).

const K32_SYMBOLS = {
  CreateJobObjectW: { parameters: ["pointer", "pointer"], result: "pointer" },
  SetInformationJobObject: { parameters: ["pointer", "i32", "buffer", "u32"], result: "i32" },
  QueryInformationJobObject: { parameters: ["pointer", "i32", "buffer", "u32", "pointer"], result: "i32" },
  OpenProcess: { parameters: ["u32", "i32", "u32"], result: "pointer" },
  AssignProcessToJobObject: { parameters: ["pointer", "pointer"], result: "i32" },
  TerminateJobObject: { parameters: ["pointer", "u32"], result: "i32" },
  TerminateProcess: { parameters: ["pointer", "u32"], result: "i32" },
  CloseHandle: { parameters: ["pointer"], result: "i32" },
  GetLastError: { parameters: [], result: "u32" },
  CreateToolhelp32Snapshot: { parameters: ["u32", "u32"], result: "pointer" },
  Process32FirstW: { parameters: ["pointer", "buffer"], result: "i32" },
  Process32NextW: { parameters: ["pointer", "buffer"], result: "i32" },
  SetFileAttributesW: { parameters: ["buffer", "u32"], result: "i32" },
} as const;

let k32: Deno.DynamicLibrary<typeof K32_SYMBOLS> | null = null;
function kernel32(): Deno.DynamicLibrary<typeof K32_SYMBOLS>["symbols"] {
  k32 ??= Deno.dlopen("kernel32.dll", K32_SYMBOLS);
  return k32.symbols;
}

const JobObjectBasicProcessIdList = 3;
const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

/**
 * A job that kills every process in it when terminate() is called OR when the
 * last handle closes - including when the host process dies abruptly.
 * Processes created by a member after assignment become members too (nested
 * jobs, Windows 8+), even if an intermediate launcher has its own job with
 * SILENT_BREAKAWAY_OK, because *this* job does not allow breakaway.
 */
export class KillOnCloseJob {
  #h: Deno.PointerValue;
  private constructor(h: Deno.PointerValue) {
    this.#h = h;
  }

  static create(): KillOnCloseJob {
    const k = kernel32();
    const h = k.CreateJobObjectW(null, null);
    if (!h) throw new Error(`CreateJobObjectW failed (${k.GetLastError()})`);
    const info = new Uint8Array(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64)
    new DataView(info.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true); // BasicLimitInformation.LimitFlags
    if (!k.SetInformationJobObject(h, JobObjectExtendedLimitInformation, info, info.length)) {
      const err = k.GetLastError();
      k.CloseHandle(h);
      throw new Error(`SetInformationJobObject failed (${err})`);
    }
    return new KillOnCloseJob(h);
  }

  assign(pid: number) {
    const k = kernel32();
    const hp = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
    if (!hp) throw new Error(`OpenProcess(${pid}) failed (${k.GetLastError()})`);
    try {
      if (!k.AssignProcessToJobObject(this.#h, hp)) throw new Error(`AssignProcessToJobObject failed (${k.GetLastError()})`);
    } finally {
      k.CloseHandle(hp);
    }
  }

  /** PIDs currently in the job (JobObjectBasicProcessIdList). */
  pids(): number[] {
    if (!this.#h) return [];
    const k = kernel32();
    const buf = new Uint8Array(16 + 8 * 256);
    if (!k.QueryInformationJobObject(this.#h, JobObjectBasicProcessIdList, buf, buf.length, null)) return [];
    const dv = new DataView(buf.buffer);
    const n = dv.getUint32(4, true); // NumberOfProcessIdsInList
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(Number(dv.getBigUint64(8 + i * 8, true)));
    return out;
  }

  terminate(exitCode = 1): boolean {
    if (!this.#h) return false;
    return !!kernel32().TerminateJobObject(this.#h, exitCode);
  }

  close() {
    if (this.#h) kernel32().CloseHandle(this.#h);
    this.#h = null;
  }
}

/** TerminateProcess(pid). Returns false when the process is gone or cannot be opened. */
export function terminatePid(pid: number, exitCode = 1): boolean {
  try {
    const k = kernel32();
    const hp = k.OpenProcess(PROCESS_TERMINATE, 0, pid);
    if (!hp) return false;
    try {
      return !!k.TerminateProcess(hp, exitCode);
    } finally {
      k.CloseHandle(hp);
    }
  } catch {
    return false;
  }
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  exe: string;
}

/** All processes (pid, parent pid, exe name). PROCESSENTRY32W is 568 bytes on x64. */
export function processSnapshot(): ProcInfo[] {
  const s = kernel32();
  const snap = s.CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
  const out: ProcInfo[] = [];
  if (!snap || Deno.UnsafePointer.value(snap) === 0xffffffffffffffffn) return out;
  const e = new Uint8Array(568);
  const dv = new DataView(e.buffer);
  dv.setUint32(0, e.length, true);
  try {
    for (let ok = s.Process32FirstW(snap, e); ok; ok = s.Process32NextW(snap, e)) {
      let exe = "";
      for (let off = 44; off < 564; off += 2) {
        const c = dv.getUint16(off, true);
        if (!c) break;
        exe += String.fromCharCode(c);
      }
      out.push({ pid: dv.getUint32(8, true), ppid: dv.getUint32(32, true), exe });
    }
  } finally {
    s.CloseHandle(snap);
  }
  return out;
}

/**
 * PIDs of running processes with the same executable name as this host (deno.exe): the other host instances
 * (Chrome + Edge, several profiles). null when the process list is unavailable - callers must then assume
 * that other hosts may be running.
 */
export function hostPids(): Set<number> | null {
  try {
    const me = basename(Deno.execPath()).toLowerCase();
    const out = new Set<number>();
    for (const p of processSnapshot()) if (p.exe.toLowerCase() === me) out.add(p.pid);
    return out.has(Deno.pid) ? out : null; // our own process must be listed, or the snapshot is unusable
  } catch {
    return null;
  }
}

/**
 * PyInstaller onefile programs (the standalone yt-dlp.exe from WinGet, Scoop or a manual download) unpack
 * themselves into %TEMP%\_MEI<pid><n>. The bootloader deletes that folder when the program ends normally,
 * but not when its process tree is killed (~29 MB every time). Remove only the folders of the processes we
 * just killed, created after the run started (another program's _MEI folder is never touched).
 */
async function removePyInstallerTemp(pids: number[], startedAt: number) {
  const tmp = Deno.env.get("TMP") || Deno.env.get("TEMP"); // GetTempPathW order; the child inherited our env
  if (!tmp || !pids.length) return;
  const re = new RegExp(`^_MEI(?:${pids.join("|")})\\d*$`, "i");
  try {
    for await (const e of Deno.readDir(tmp)) {
      if (!e.isDirectory || e.isSymlink || !re.test(e.name)) continue;
      const p = join(tmp, e.name);
      const st = await Deno.lstat(p);
      const born = st.birthtime?.getTime() ?? 0;
      if (!born || born < startedAt - 2000) continue;
      log("info", `removing ${p} (left by a killed onefile yt-dlp)`);
      await removeWithRetry(p, 20, 150);
    }
  } catch (e) {
    log("debug", "PyInstaller temp cleanup failed:", String(e));
  }
}

/** Descendants of rootPid (by parent-pid links in one snapshot). */
export function descendantsOf(rootPid: number, snap = processSnapshot()): ProcInfo[] {
  const out: ProcInfo[] = [];
  const seen = new Set([rootPid]);
  const todo = [rootPid];
  while (todo.length) {
    const p = todo.pop()!;
    for (const q of snap) {
      if (q.ppid === p && !seen.has(q.pid)) {
        seen.add(q.pid);
        out.push(q);
        todo.push(q.pid);
      }
    }
  }
  return out;
}

/** FILE_ATTRIBUTE_HIDDEN on a file or folder (best effort). */
export function setHidden(path: string): boolean {
  try {
    const w = new Uint8Array((path.length + 1) * 2);
    const dv = new DataView(w.buffer);
    for (let i = 0; i < path.length; i++) dv.setUint16(i * 2, path.charCodeAt(i), true);
    return !!kernel32().SetFileAttributesW(w, 0x2 /* FILE_ATTRIBUTE_HIDDEN */);
  } catch {
    return false;
  }
}

/** Remove a path recursively, retrying while Windows still reports files in use (handles close asynchronously after a kill). */
export async function removeWithRetry(path: string, tries = 30, delayMs = 150): Promise<boolean> {
  for (let i = 1; i <= tries; i++) {
    try {
      await Deno.remove(path, { recursive: true });
      return true;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return true;
      if (i === tries) {
        log("warn", `could not remove ${path}:`, String(e));
        return false;
      }
      await sleep(delayMs);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// runTracked(): one child process with everything a download needs.

export interface RunOutcome {
  code: number | null;
  signal: string | null;
  /** null, or why we killed it: "cancel" | "idle" | "shutdown" | ... */
  killedBy: string | null;
  lines: number;
  ms: number;
}

export interface TrackedRun {
  pid: number;
  /** Kill the whole process tree (idempotent). */
  kill(reason: string): Promise<void>;
  result: Promise<RunOutcome>;
}

export interface RunOptions {
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  onLine: (ev: LineEvent) => void;
  /** current idle limit in ms (0 = no watchdog); asked every 2 s */
  idleLimitMs?: () => number;
}

export function runTracked(cmd: string, opts: RunOptions): TrackedRun {
  const t0 = performance.now();
  const startedAt = Date.now();
  const sp = spawnLines(cmd, { args: opts.args, env: opts.env, cwd: opts.cwd });
  let job: KillOnCloseJob | null = null;
  try {
    job = KillOnCloseJob.create();
    job.assign(sp.pid);
  } catch (e) {
    log("warn", `job object for pid ${sp.pid} unavailable:`, String(e));
    try {
      job?.close();
    } catch { /* ignore */ }
    job = null;
  }

  let lastOutput = performance.now();
  let lines = 0;
  let killedBy: string | null = null;
  let killing: Promise<void> | null = null;
  let killedPids: number[] = [];

  const consume = (async () => {
    for await (const ev of sp.lines) {
      lastOutput = performance.now();
      lines++;
      try {
        opts.onLine(ev);
      } catch (e) {
        log("warn", "line handler failed:", e);
      }
    }
  })();

  const kill = (reason: string): Promise<void> => {
    if (!killedBy) killedBy = reason;
    killing ??= (async () => {
      // 1) snapshot the tree while parent links still exist (catches anything that escaped the job)
      let tree: ProcInfo[] = [];
      try {
        tree = descendantsOf(sp.pid);
      } catch { /* ignore */ }
      killedPids = [sp.pid, ...tree.map((p) => p.pid)];
      // 2) the job object kills every member at once (yt-dlp -> python -> ffmpeg)
      let viaJob = false;
      try {
        viaJob = job?.terminate(1) ?? false;
      } catch { /* ignore */ }
      // 3) sweep: anything from the snapshot (and the root) that is still alive
      terminatePid(sp.pid);
      for (const p of tree) terminatePid(p.pid);
      if (!viaJob) {
        // no job object: fall back to taskkill /T /F as well
        try {
          await taskkillTree(sp.pid);
        } catch { /* ignore */ }
      }
      log("info", `killed pid ${sp.pid} (${reason}); tree=${JSON.stringify(tree.map((p) => `${p.exe}:${p.pid}`))} viaJob=${viaJob}`);
    })();
    return killing;
  };

  const watchdog = setInterval(() => {
    const limit = opts.idleLimitMs?.() ?? 0;
    if (limit > 0 && !killedBy && performance.now() - lastOutput > limit) {
      log("warn", `pid ${sp.pid}: no output for ${Math.round((performance.now() - lastOutput) / 1000)} s; killing`);
      void kill("idle");
    }
  }, 2000);

  const result = (async (): Promise<RunOutcome> => {
    let status: Deno.CommandStatus;
    try {
      status = await sp.child.status;
    } catch (e) {
      log("warn", "child status failed:", String(e));
      status = { success: false, code: -1, signal: null };
    }
    // A grandchild (ffmpeg) can keep the pipes open after the child exits:
    // give the readers 3 s, then kill whatever is left in the job.
    const closed = await Promise.race([consume.then(() => true), sleep(3000).then(() => false)]);
    if (!closed) {
      log("warn", `pid ${sp.pid} exited but its pipes are still open; terminating the job`);
      try {
        job?.terminate(1);
      } catch { /* ignore */ }
      await Promise.race([consume, sleep(5000)]);
    }
    clearInterval(watchdog);
    if (killing) await killing;
    try {
      job?.close(); // KILL_ON_JOB_CLOSE: anything still in the job dies here
    } catch { /* ignore */ }
    job = null;
    if (killedBy) await removePyInstallerTemp(killedPids, startedAt);
    return { code: status.code, signal: status.signal, killedBy, lines, ms: Math.round(performance.now() - t0) };
  })();

  return { pid: sp.pid, kill, result };
}

export interface CaptureResult {
  code: number | null;
  stdout: string[];
  stderr: string[];
  timedOut: boolean;
  ms: number;
}

/** Run a command to completion (job object, hard timeout) and collect its output lines (capped). */
export async function capture(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env?: Record<string, string>; cwd?: string; maxLines?: number },
): Promise<CaptureResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const maxLines = opts.maxLines ?? 2000;
  const run = runTracked(cmd, {
    args,
    env: opts.env,
    cwd: opts.cwd,
    onLine: (ev) => {
      const arr = ev.stream === "stdout" ? stdout : stderr;
      if (arr.length < maxLines) arr.push(ev.line);
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void run.kill("timeout");
  }, opts.timeoutMs);
  try {
    const r = await run.result;
    return { code: r.code, stdout, stderr, timedOut, ms: r.ms };
  } finally {
    clearTimeout(timer);
  }
}
