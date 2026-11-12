// lib/winshell.ts - Windows shell integration for the host: folder picker,
// open-with-default-app, reveal-in-Explorer and the Downloads folder.
//
// Strings cross process boundaries only in Unicode-safe ways:
//   into PowerShell : environment variables (UTF-16), never spliced into script text
//   out of PowerShell: raw UTF-8 bytes via [Console]::OpenStandardOutput()
//   open / reveal    : ShellExecuteW / SHOpenFolderAndSelectItems via FFI - no command
//                      line is parsed at all (cmd /c start expands %VAR% even inside
//                      quotes, explorer /select splits at commas, and explorer.exe can
//                      hang behind a dialog, so none of them is used).

import { log } from "./log.ts";
import { fileUrlToPath } from "./paths.ts";
import { SYS32 } from "./proc.ts";

const POWERSHELL = `${SYS32}\\WindowsPowerShell\\v1.0\\powershell.exe`;
const PICKER_SCRIPT = fileUrlToPath(new URL("./ps/pick_folder_vista.ps1", import.meta.url));

// ---------------------------------------------------------------------------
// Folder picker

export interface PickResult {
  ok: boolean;
  path?: string;
  cancelled?: boolean;
  timedOut?: boolean;
  error?: string;
}

export interface PickOptions {
  title?: string;
  initialDir?: string;
  okLabel?: string;
  timeoutMs?: number;
  /**
   * Called when the picker's PowerShell has started, with a function that ends it. Once the process has exited, that
   * function does nothing (a kill by PID could then hit another process that was given the same PID).
   */
  onSpawn?: (kill: () => void) => void;
  /** tests only: the -ExecutionPolicy argument (default Bypass) */
  executionPolicy?: string;
}

/**
 * Show the modern folder picker (IFileOpenDialog + FOS_PICKFOLDERS) from the
 * background host: PowerShell 5.1 (always present on Windows 10/11) in STA mode
 * with a script shipped next to the host. Resolves {ok:true, cancelled:true}
 * when the user cancels, {ok:true, path} on success, and {ok:false, error} with a
 * reason the user can act on when a policy of the organization blocks the script.
 */
export async function pickFolder(o: PickOptions = {}): Promise<PickResult> {
  const policyArg = o.executionPolicy ?? "Bypass";
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, o.timeoutMs ?? 290_000);
  try {
    const child = new Deno.Command(POWERSHELL, {
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", policyArg, "-STA", "-File", PICKER_SCRIPT],
      env: {
        AKIF_PICK_TITLE: o.title ?? "",
        AKIF_PICK_INITIAL: o.initialDir ?? "",
        AKIF_PICK_OK: o.okLabel ?? "",
        AKIF_PICK_OWNER: "0",
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: ac.signal,
    }).spawn();
    o.onSpawn?.(() => {
      try {
        child.kill(); // Deno throws instead once the child has exited and its process handle is closed
      } catch { /* it has exited */ }
    });
    const out = await child.output();
    if (timedOut) return { ok: true, cancelled: true, timedOut: true };
    const stdout = new TextDecoder().decode(out.stdout).trim();
    let j: unknown = null;
    try {
      j = JSON.parse(stdout);
    } catch { /* below */ }
    if (j && typeof j === "object") {
      const r = j as PickResult & { reason?: unknown; mode?: unknown };
      if (r.ok || r.reason !== "language_mode") return r;
      log("warn", `picker: PowerShell runs in ${String(r.mode)} mode`);
      return { ok: false, error: pickerFailureText({ mode: String(r.mode ?? "") }) };
    }
    const stderr = new TextDecoder().decode(out.stderr).trim();
    log("warn", `picker produced no JSON (exit ${out.code}):`, stderr.slice(0, 500));
    return { ok: false, error: pickerFailureText({ ...(await powershellPolicy(policyArg)), stderr, code: out.code }) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The effective execution policy and language mode, asked from PowerShell itself: command text (unlike a script file)
 * is not subject to the execution policy, and these names are the same in every Windows language, unlike the error
 * messages. A Group Policy's execution policy wins over -ExecutionPolicy Bypass; AppLocker / WDAC set the mode.
 */
async function powershellPolicy(policyArg: string): Promise<{ policy: string; mode: string }> {
  try {
    const r = await new Deno.Command(POWERSHELL, {
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", policyArg, "-Command", "[string](Get-ExecutionPolicy); [string]$ExecutionContext.SessionState.LanguageMode"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(20_000),
    }).output();
    const [policy = "", mode = ""] = new TextDecoder().decode(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return { policy, mode };
  } catch (e) {
    log("debug", "PowerShell policy check failed:", String(e));
    return { policy: "", mode: "" };
  }
}

const TYPE_PATH = 'Type the folder path into the "Download folder" field instead.';

/** The picker_failed message: what blocked the folder dialog, when a policy did (exported for tests). */
export function pickerFailureText(f: { policy?: string; mode?: string; stderr?: string; code?: number | null }): string {
  const stderr = f.stderr ?? "";
  const mode = f.mode && f.mode !== "FullLanguage" ? f.mode : /ConstrainedLanguage/.test(stderr) ? "ConstrainedLanguage" : "";
  if (mode) {
    return `PowerShell runs in ${mode} mode on this computer (an AppLocker or Windows Defender Application Control policy of ` +
      `your organization), so the companion app cannot show the folder dialog. ${TYPE_PATH}`;
  }
  if (f.policy === "AllSigned" || f.policy === "Restricted") {
    return `The PowerShell execution policy on this computer is ${f.policy} (set by a Group Policy of your organization), ` +
      `which does not allow the companion app's folder dialog. ${TYPE_PATH}`;
  }
  if (/UnauthorizedAccess|about_Execution_Policies|PSSecurityException/i.test(stderr)) {
    return `The PowerShell execution policy${f.policy ? ` (${f.policy})` : ""} did not allow the companion app's folder dialog ` +
      `script to run. Run install.bat again, or type the folder path into the "Download folder" field instead.`;
  }
  return `the folder picker failed (exit ${f.code ?? "?"})`;
}

// ---------------------------------------------------------------------------
// FFI: shell32 / ole32

function wstr(s: string): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array((s.length + 1) * 2);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true);
  return b;
}

function readWstr(p: Deno.PointerObject): string {
  const v = new Deno.UnsafePointerView(p);
  const units: number[] = [];
  for (let off = 0; off < 65536; off += 2) {
    const u = v.getUint16(off);
    if (u === 0) break;
    units.push(u);
  }
  let s = "";
  for (let i = 0; i < units.length; i += 4096) s += String.fromCharCode(...units.slice(i, i + 4096));
  return s;
}

const SHELL32 = {
  ShellExecuteW: { parameters: ["pointer", "buffer", "buffer", "pointer", "pointer", "i32"], result: "pointer" },
  ILCreateFromPathW: { parameters: ["buffer"], result: "pointer" },
  ILFree: { parameters: ["pointer"], result: "void" },
  SHOpenFolderAndSelectItems: { parameters: ["pointer", "u32", "pointer", "u32"], result: "i32" },
  SHGetKnownFolderPath: { parameters: ["buffer", "u32", "pointer", "buffer"], result: "i32" },
} as const;
const OLE32 = {
  CoInitializeEx: { parameters: ["pointer", "u32"], result: "i32" },
  CoTaskMemFree: { parameters: ["pointer"], result: "void" },
} as const;

let shellLib: { shell32: Deno.DynamicLibrary<typeof SHELL32>["symbols"]; ole32: Deno.DynamicLibrary<typeof OLE32>["symbols"] } | null = null;
function shell() {
  if (!shellLib) {
    const shell32 = Deno.dlopen("shell32.dll", SHELL32);
    const ole32 = Deno.dlopen("ole32.dll", OLE32);
    // COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE, as the ShellExecute docs recommend.
    ole32.symbols.CoInitializeEx(null, 0x2 | 0x4);
    shellLib = { shell32: shell32.symbols, ole32: ole32.symbols };
  }
  return shellLib;
}

const SHELLEXECUTE_ERRORS: Record<number, string> = {
  0: "out of memory",
  2: "file not found",
  3: "path not found",
  5: "access denied",
  8: "out of memory",
  26: "sharing violation",
  27: "file association incomplete",
  31: "no app is associated with this file type",
  32: "DLL not found",
};

/** ShellExecuteW(NULL, "open", path, NULL, NULL, SW_SHOWNORMAL): default app for a file, Explorer for a folder. */
export function shellOpen(path: string): { ok: boolean; code: number; error?: string } {
  const s = shell();
  const r = s.shell32.ShellExecuteW(null, wstr("open"), wstr(path), null, null, 1);
  const code = Number(Deno.UnsafePointer.value(r));
  return code > 32 ? { ok: true, code } : { ok: false, code, error: SHELLEXECUTE_ERRORS[code] ?? `ShellExecute error ${code}` };
}

/** SHOpenFolderAndSelectItems: opens the containing folder and selects the item (what explorer /select does internally). */
export function revealInFolder(path: string): { ok: boolean; hr: number; error?: string } {
  const s = shell();
  const pidl = s.shell32.ILCreateFromPathW(wstr(path));
  if (!pidl) return { ok: false, hr: -1, error: "ILCreateFromPath failed" };
  try {
    const hr = s.shell32.SHOpenFolderAndSelectItems(pidl, 0, null, 0);
    return hr === 0 ? { ok: true, hr } : { ok: false, hr, error: `SHOpenFolderAndSelectItems 0x${(hr >>> 0).toString(16)}` };
  } finally {
    s.shell32.ILFree(pidl);
  }
}

// ---------------------------------------------------------------------------
// Registry (read-only)

/** Predefined keys: (HKEY)(LONG)0x8000000x, sign-extended. */
const HKEYS = { HKCU: 0xFFFFFFFF80000001n, HKLM: 0xFFFFFFFF80000002n } as const;
const ADVAPI32 = {
  RegGetValueW: { parameters: ["pointer", "buffer", "buffer", "u32", "buffer", "buffer", "buffer"], result: "i32" },
} as const;

/**
 * A registry value: REG_SZ as a string, REG_DWORD as a number. null when the key or value is missing, has another
 * type, or cannot be read.
 */
export function regRead(hive: keyof typeof HKEYS, subKey: string, name: string): string | number | null {
  let lib: Deno.DynamicLibrary<typeof ADVAPI32> | null = null;
  try {
    lib = Deno.dlopen("advapi32.dll", ADVAPI32);
    const key = Deno.UnsafePointer.create(HKEYS[hive]);
    const type = new Uint8Array(4);
    const size = new Uint8Array(4);
    let cap = 512;
    for (let attempt = 0; attempt < 4; attempt++) {
      const data = new Uint8Array(cap);
      new DataView(size.buffer).setUint32(0, cap, true);
      const r = lib.symbols.RegGetValueW(key, wstr(subKey), wstr(name), 0x02 | 0x10 /* RRF_RT_REG_SZ | RRF_RT_REG_DWORD */, type, data, size);
      const got = new DataView(size.buffer).getUint32(0, true);
      if (r === 234 /* ERROR_MORE_DATA: size holds the size needed */) {
        cap = Math.max(cap * 2, got + 2);
        continue;
      }
      if (r !== 0) return null;
      const t = new DataView(type.buffer).getUint32(0, true);
      if (t === 4 /* REG_DWORD */) return new DataView(data.buffer).getUint32(0, true);
      if (t !== 1 /* REG_SZ */) return null;
      let s = "";
      const dv = new DataView(data.buffer);
      for (let off = 0; off + 1 < Math.min(got, cap); off += 2) {
        const u = dv.getUint16(off, true);
        if (u === 0) break;
        s += String.fromCharCode(u);
      }
      return s;
    }
    return null;
  } catch (e) {
    log("debug", `registry ${hive}\\${subKey}\\${name} unreadable:`, String(e));
    return null;
  } finally {
    lib?.close();
  }
}

// ---------------------------------------------------------------------------
// Long path support (read-only)

let longPaths: boolean | null = null;

/**
 * HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled == 1 ?
 * When it is, python.exe / the onedir yt-dlp.exe (both longPathAware) and ffmpeg (adds \\?\ itself)
 * can work with temp paths beyond MAX_PATH, so only the final file path has to stay short.
 */
export function longPathsEnabled(): boolean {
  longPaths ??= regRead("HKLM", "SYSTEM\\CurrentControlSet\\Control\\FileSystem", "LongPathsEnabled") === 1;
  return longPaths;
}

// ---------------------------------------------------------------------------
// Downloads folder (read-only)

const FOLDERID_Downloads = "374DE290-123F-4565-9164-39C4925E467B";

function guidBytes(g: string): Uint8Array<ArrayBuffer> {
  const h = g.replace(/[{}-]/g, "");
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, parseInt(h.slice(0, 8), 16), true);
  dv.setUint16(4, parseInt(h.slice(8, 12), 16), true);
  dv.setUint16(6, parseInt(h.slice(12, 16), 16), true);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(h.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
}

/** SHGetKnownFolderPath(FOLDERID_Downloads) - follows folder redirection. */
export function downloadsDirKnownFolder(): string {
  const s = shell();
  const out = new BigUint64Array(1);
  const hr = s.shell32.SHGetKnownFolderPath(guidBytes(FOLDERID_Downloads), 0, null, new Uint8Array(out.buffer));
  if (hr !== 0) throw new Error(`SHGetKnownFolderPath failed: 0x${(hr >>> 0).toString(16)}`);
  const p = Deno.UnsafePointer.create(out[0]);
  if (!p) throw new Error("SHGetKnownFolderPath returned NULL");
  try {
    return readWstr(p);
  } finally {
    s.ole32.CoTaskMemFree(p);
  }
}

let cachedDownloads: string | null = null;

/** Best effort: FFI known folder -> %USERPROFILE%\Downloads. Verifies the directory exists. Cached. */
export function downloadsDir(): string {
  if (cachedDownloads) return cachedDownloads;
  const candidates: (() => string | null)[] = [
    () => downloadsDirKnownFolder(),
    () => (Deno.env.get("USERPROFILE") ? `${Deno.env.get("USERPROFILE")}\\Downloads` : null),
  ];
  for (const f of candidates) {
    try {
      const p = f();
      if (p && Deno.statSync(p).isDirectory) return (cachedDownloads = p);
    } catch (e) {
      log("debug", "downloads dir candidate failed:", String(e));
    }
  }
  const home = Deno.env.get("USERPROFILE") ?? "C:\\Users\\Public";
  return (cachedDownloads = `${home}\\Downloads`);
}
