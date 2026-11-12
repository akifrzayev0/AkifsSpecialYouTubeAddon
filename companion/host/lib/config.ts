// lib/config.ts - install configuration (config.json written by install.ps1) and
// resolution of the external tools (yt-dlp, ffmpeg/ffprobe, deno).
//
// The browser starts the host with the environment it had when IT started, so
// PATH may be stale: the installer records absolute tool paths in config.json.
// PATH is only a fallback (development runs, or a tool that was moved).

import { log } from "./log.ts";
import { join, ROOT_DIR } from "./paths.ts";

export type YtDlpVariant = "pip" | "exe" | "onedir" | "winget" | "unknown";

export interface HostConfig {
  schema?: number;
  hostVersion?: string;
  installedAt?: string;
  installDir?: string;
  extensionId?: string;
  tools?: {
    ytdlp?: { path?: string | null; variant?: string | null; version?: string | null; python?: string | null; versionFile?: string | null };
    ffmpeg?: { path?: string | null; ffprobe?: string | null; version?: string | null };
    deno?: { path?: string | null; version?: string | null };
  };
}

export interface ResolvedTools {
  ytdlp: { path: string | null; variant: YtDlpVariant; python: string | null; versionFile: string | null; source: string };
  ffmpeg: { path: string | null; ffprobe: string | null; source: string };
  deno: { path: string; source: string };
}

export const CONFIG_PATH = Deno.env.get("AKIF_HOST_CONFIG") || join(ROOT_DIR, "config.json");
export const STATE_DIR = join(ROOT_DIR, "state");
export const BIN_DIR = join(ROOT_DIR, "bin");

export function loadConfig(path = CONFIG_PATH): HostConfig {
  try {
    let text = Deno.readTextFileSync(path);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // tolerate a BOM
    const cfg = JSON.parse(text);
    return cfg && typeof cfg === "object" ? cfg as HostConfig : {};
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) log("warn", `config ${path} unreadable:`, String(e));
    return {};
  }
}

/**
 * Does an executable/file exist at p? stat() follows symlinks (WinGet Links\*.exe). App Execution Aliases
 * (%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe, Store python.exe) are APPEXECLINK reparse points that
 * stat() cannot open ("The file cannot be accessed by the system", os error 1920) although CreateProcess runs
 * them fine: accept those when lstat() sees a non-directory reparse point.
 */
export function isFile(p: string | null | undefined): p is string {
  if (!p || typeof p !== "string") return false;
  try {
    return Deno.statSync(p).isFile;
  } catch (e) {
    if (!/os error 1920\b/.test(String(e))) return false;
    try {
      const l = Deno.lstatSync(p);
      return l.isSymlink && !l.isDirectory;
    } catch {
      return false;
    }
  }
}

/** First <dir>\<name>.exe on PATH (like where.exe, .exe only). */
export function findOnPath(name: string): string | null {
  const path = Deno.env.get("PATH") ?? "";
  for (let dir of path.split(";")) {
    dir = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const p = join(dir, name.toLowerCase().endsWith(".exe") ? name : `${name}.exe`);
    if (isFile(p)) return p;
  }
  return null;
}

const VARIANTS = new Set<YtDlpVariant>(["pip", "exe", "onedir", "winget", "unknown"]);

export function resolveTools(cfg: HostConfig = loadConfig()): ResolvedTools {
  const t = cfg.tools ?? {};
  // yt-dlp
  let ytPath: string | null = null;
  let ytSource = "config";
  let variant: YtDlpVariant = "unknown";
  let python: string | null = null;
  let versionFile: string | null = null;
  if (isFile(t.ytdlp?.path)) {
    ytPath = t.ytdlp!.path!;
    variant = VARIANTS.has(t.ytdlp?.variant as YtDlpVariant) ? t.ytdlp!.variant as YtDlpVariant : "unknown";
    python = isFile(t.ytdlp?.python) ? t.ytdlp!.python! : null;
    versionFile = isFile(t.ytdlp?.versionFile) ? t.ytdlp!.versionFile! : null;
  } else {
    for (const p of [join(BIN_DIR, "yt-dlp", "yt-dlp.exe"), join(BIN_DIR, "yt-dlp.exe")]) {
      if (isFile(p)) {
        ytPath = p;
        variant = p.toLowerCase().endsWith("\\yt-dlp\\yt-dlp.exe") ? "onedir" : "exe";
        ytSource = "bin";
        break;
      }
    }
    if (!ytPath) {
      ytPath = findOnPath("yt-dlp");
      ytSource = ytPath ? "PATH" : "missing";
      if (ytPath) variant = /\\winget\\/i.test(ytPath) ? "winget" : "unknown";
    }
  }
  // ffmpeg / ffprobe
  let ffPath: string | null = null;
  let ffprobe: string | null = null;
  let ffSource = "config";
  if (isFile(t.ffmpeg?.path)) {
    ffPath = t.ffmpeg!.path!;
    ffprobe = isFile(t.ffmpeg?.ffprobe) ? t.ffmpeg!.ffprobe! : null;
  } else if (isFile(join(BIN_DIR, "ffmpeg.exe"))) {
    ffPath = join(BIN_DIR, "ffmpeg.exe");
    ffSource = "bin";
  } else {
    ffPath = findOnPath("ffmpeg");
    ffSource = ffPath ? "PATH" : "missing";
  }
  if (ffPath && !ffprobe) {
    const sibling = join(ffPath.replace(/\\[^\\]+$/, ""), "ffprobe.exe");
    ffprobe = isFile(sibling) ? sibling : findOnPath("ffprobe");
  }
  // deno: the runtime executing this host is always usable as yt-dlp's JS runtime
  let denoPath = Deno.execPath();
  let denoSource = "self";
  if (isFile(t.deno?.path)) {
    denoPath = t.deno!.path!;
    denoSource = "config";
  }
  return {
    ytdlp: { path: ytPath, variant, python, versionFile, source: ytSource },
    ffmpeg: { path: ffPath, ffprobe, source: ffSource },
    deno: { path: denoPath, source: denoSource },
  };
}
