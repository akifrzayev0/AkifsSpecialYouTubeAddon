// lib/log.ts - logging for the native messaging host.
//
// HARD RULE: stdout is the binary native-messaging channel. Nothing in this
// module (or anything that calls console.*) may ever write to stdout.
// Log lines go to an append-only UTF-8 file with size-based rotation
// (host.log -> host.log.1 -> host.log.2). If the file cannot be opened we fall
// back to stderr, which the browser connects to a hidden console.

const enc = new TextEncoder();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let file: Deno.FsFile | null = null;
let filePath: string | null = null;
let minLevel: number = LEVELS.debug;
let maxBytes = 2 * 1024 * 1024;
let keepFiles = 2;
let writesSinceCheck = 0;
let lastCheck = Date.now();

function fmt(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }).join(" ");
}

function writeAllSync(w: { writeSync(p: Uint8Array): number }, data: Uint8Array) {
  let off = 0;
  while (off < data.length) off += w.writeSync(data.subarray(off));
}

/** host.log.N is dropped, host.log.(i) -> host.log.(i+1), host.log -> host.log.1 */
function rotateFiles(path: string) {
  try {
    Deno.removeSync(`${path}.${keepFiles}`);
  } catch { /* not there */ }
  for (let i = keepFiles - 1; i >= 1; i--) {
    try {
      Deno.renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    } catch { /* not there */ }
  }
  try {
    Deno.renameSync(path, `${path}.1`);
  } catch { /* missing, or a concurrent host rotated it first */ }
}

function openFile(path: string) {
  // append:true => FILE_APPEND_DATA; Deno opens with FILE_SHARE_READ|WRITE|DELETE,
  // so several host instances (one per connectNative port) can share the file and
  // a rename by one of them does not break the others.
  file = Deno.openSync(path, { create: true, append: true });
  filePath = path;
}

/** Open (append) the log file, rotating it first when it is larger than maxBytes. */
export function initLog(path: string, opts: { maxBytes?: number; keep?: number; level?: LogLevel } = {}) {
  minLevel = LEVELS[opts.level ?? "debug"];
  maxBytes = opts.maxBytes ?? maxBytes;
  keepFiles = Math.max(1, opts.keep ?? keepFiles);
  try {
    const dir = path.replace(/[\\/][^\\/]*$/, "");
    Deno.mkdirSync(dir, { recursive: true });
    try {
      if (Deno.statSync(path).size > maxBytes) rotateFiles(path);
    } catch { /* missing file */ }
    openFile(path);
  } catch (e) {
    file = null;
    filePath = null;
    log("warn", "log file unavailable, using stderr:", String(e));
  }
}

export function logPath(): string | null {
  return filePath;
}

function maybeRotate() {
  if (!file || !filePath || (++writesSinceCheck < 200 && Date.now() - lastCheck < 10_000)) return;
  writesSinceCheck = 0;
  lastCheck = Date.now();
  try {
    const mine = file.statSync();
    let current: Deno.FileInfo | null = null;
    try {
      current = Deno.statSync(filePath);
    } catch { /* renamed away */ }
    // (ino is a 64-bit NTFS file id that a JS number may round, so the size is compared too; reopening the
    // same file after a false alarm - another host appended between the two stats - does no harm)
    if (!current || current.size !== mine.size || (mine.ino != null && current.ino != null && mine.ino !== current.ino)) {
      // Another host instance (Chrome + Edge, two profiles) rotated the log: our handle follows the renamed
      // file (host.log.1, later deleted). Continue in the current host.log instead of losing the lines.
      const p = filePath;
      file.close();
      file = null;
      openFile(p);
      return;
    }
    if (mine.size <= maxBytes) return;
    const p = filePath;
    file.close();
    file = null;
    rotateFiles(p);
    openFile(p);
  } catch { /* keep logging to whatever is open (or stderr) */ }
}

export function log(level: LogLevel, ...args: unknown[]) {
  if (LEVELS[level] < minLevel) return;
  const line = `${new Date().toISOString()} pid=${Deno.pid} ${level.toUpperCase()} ${fmt(args)}\n`;
  const bytes = enc.encode(line);
  try {
    if (file) {
      writeAllSync(file, bytes);
      maybeRotate();
      return;
    }
  } catch { /* fall through to stderr */ }
  try {
    writeAllSync(Deno.stderr, bytes);
  } catch { /* nowhere left to log */ }
}

/**
 * Re-route every console method to the log so that a stray console.log() in
 * our code or in a dependency can never corrupt the protocol stream.
 */
export function hijackConsole() {
  const c = globalThis.console as unknown as Record<string, unknown>;
  const map: Record<string, LogLevel> = {
    log: "info", info: "info", debug: "debug", trace: "debug", dir: "debug", dirxml: "debug",
    table: "info", warn: "warn", error: "error", assert: "error", count: "debug", timeLog: "debug",
    group: "info", groupCollapsed: "info",
  };
  for (const [name, level] of Object.entries(map)) {
    c[name] = (...args: unknown[]) => {
      if (name === "assert") {
        if (args[0]) return;
        args = ["Assertion failed:", ...args.slice(1)];
      }
      log(level, ...args);
    };
  }
}

export function closeLog() {
  try {
    file?.close();
  } catch { /* ignore */ }
  file = null;
}
