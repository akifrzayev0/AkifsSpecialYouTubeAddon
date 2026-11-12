// lib/paths.ts - Windows path helpers, validation and file-name sanitising.
// Pure functions (plus a few async fs helpers); no side effects at import time.

/** file:///C:/a%20b/x -> C:\a b\x (fromFileUrl without importing @std/path). */
export function fileUrlToPath(u: URL | string): string {
  const url = typeof u === "string" ? new URL(u) : u;
  let p = decodeURIComponent(url.pathname);
  if (url.host) p = `//${url.host}${p}`; // UNC
  return p.replace(/^\/([A-Za-z]:)/, "$1").replaceAll("/", "\\");
}

export function trimTrailingSep(p: string): string {
  if (/^[A-Za-z]:\\$/.test(p)) return p;
  return p.replace(/\\+$/, "");
}

/** Folder of the host (the folder that contains host.ts and host.bat). */
export const HOST_DIR = trimTrailingSep(fileUrlToPath(new URL("../", import.meta.url)));
/** Install root: %LOCALAPPDATA%\AkifYouTubeAddon (parent of host\). Holds bin\, logs\, state\, config.json. */
export const ROOT_DIR = dirname(HOST_DIR);

export function join(...parts: string[]): string {
  let out = "";
  for (const raw of parts) {
    if (!raw) continue;
    const part = raw.replaceAll("/", "\\");
    if (!out) out = part;
    else out = out.replace(/\\+$/, "") + "\\" + part.replace(/^\\+/, "");
  }
  return out;
}

export function dirname(p: string): string {
  const s = trimTrailingSep(p);
  const i = s.lastIndexOf("\\");
  if (i < 0) return ".";
  const d = s.slice(0, i);
  return /^[A-Za-z]:$/.test(d) ? d + "\\" : d;
}

export function basename(p: string): string {
  const s = trimTrailingSep(p);
  return s.slice(s.lastIndexOf("\\") + 1);
}

/** ".mp4" (lower case) or "" */
export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i).toLowerCase() : "";
}

// deno-lint-ignore no-control-regex
const BAD_PATH_CHARS = /[<>"|?*\u0000-\u001f\u007f]/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;

/**
 * Validate an absolute Windows path (drive or UNC). Returns the normalised path
 * (backslashes, no trailing separator except for a drive root) or null.
 * Rejects relative paths, device paths (\\?\, \\.\), "." / ".." segments,
 * alternate data streams, reserved device names, characters Windows forbids and
 * segments ending in a dot or space (Windows silently strips those).
 */
export function normalizeAbsolutePath(input: unknown, maxLen = 240): string | null {
  if (typeof input !== "string") return null;
  let p = input.replaceAll("/", "\\");
  if (p !== p.trim() || p.length < 3 || p.length > maxLen) return null;
  if (BAD_PATH_CHARS.test(p)) return null;
  let root: string;
  let rest: string;
  const drive = /^([A-Za-z]):\\/.exec(p);
  if (drive) {
    root = drive[1].toUpperCase() + ":\\";
    rest = p.slice(3);
  } else if (p.startsWith("\\\\")) {
    const m = /^\\\\([^\\.?][^\\]*)\\([^\\]+)(?:\\|$)/.exec(p);
    if (!m) return null;
    root = `\\\\${m[1]}\\${m[2]}\\`;
    rest = p.slice(m[0].length);
  } else return null;
  if (rest.includes(":")) return null;
  p = rest.replace(/\\+$/, "");
  const segs = p ? p.split("\\") : [];
  for (const s of segs) {
    if (!s || s === "." || s === "..") return null;
    if (/[ .]$/.test(s)) return null;
    if (RESERVED_NAME.test(s)) return null;
  }
  const out = root + segs.join("\\");
  return segs.length ? out : root.replace(/\\$/, drive ? "\\" : "");
}

/** Cut a string to at most maxBytes of UTF-8 without splitting a code point. */
export function truncateUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch;
  }
  return out;
}

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * File name (without extension) the way yt-dlp sanitises it on Windows when
 * --restrict-filenames is NOT used: "*:<>?| become their full-width forms,
 * / and \ become U+29F8 / U+29F9, control characters are dropped.
 * Used for names the host builds itself (subtitles, GIFs) so that they match
 * the names yt-dlp gives to videos.
 */
export function sanitizeFileName(name: unknown, maxBytes = 150): string {
  let s = String(name ?? "").normalize("NFC").replace(/\r?\n/g, " ");
  s = Array.from(s).map((ch) => {
    const code = ch.codePointAt(0)!;
    if (code < 32 || code === 127) return "";
    if ('"*:<>?|'.includes(ch)) return String.fromCharCode(code + 0xfee0);
    if (ch === "/") return "\u29F8";
    if (ch === "\\") return "\u29F9";
    return ch;
  }).join("");
  s = s.replace(/\s+/g, " ").trim();
  s = truncateUtf8(s, maxBytes).replace(/[. ]+$/, "").trim();
  if (!s) s = "_";
  if (RESERVED_NAME.test(s)) s = "_" + s;
  return s;
}

/** Port of AYT.util.sanitizeFilename (extension/shared/utils.js) - keep in sync. */
export function extensionSanitize(name: unknown, maxLength = 150): string {
  const max = maxLength || 150;
  const map: Record<string, string> = { "\\": "-", "/": "-", ":": " -", "*": "", "?": "", '"': "'", "<": "(", ">": ")", "|": "-" };
  let s = String(name == null ? "" : name)
    .normalize("NFC")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|]/g, (c) => map[c])
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .replace(/^\.+/, "");
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(s)) s = "_" + s;
  if (s.length > max) s = Array.from(s).slice(0, max).join("").trim().replace(/[. ]+$/g, "");
  return s || "video";
}

/**
 * Sub-folder setting -> relative Windows path, exactly like AYT.util.downloadsPath()
 * does for browser-side downloads (so both kinds of files land in the same folder).
 */
export function subfolderPath(sub: unknown): string {
  return String(sub || "")
    .split(/[\\/]+/)
    .map((p) => extensionSanitize(p, 80))
    .filter((p) => p && p !== "video" && p !== "." && p !== "..")
    .join("\\");
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await Deno.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isDirectory;
  } catch {
    return false;
  }
}

export async function fileSize(p: string): Promise<number | null> {
  try {
    const st = await Deno.stat(p);
    return st.isFile ? st.size : null;
  } catch {
    return null;
  }
}

/** dir\base.ext, or dir\base (2).ext, dir\base (3).ext ... - whichever does not exist yet. */
export async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  const dot = ext ? (ext.startsWith(".") ? ext : "." + ext) : "";
  for (let i = 1; i < 1000; i++) {
    const p = join(dir, `${base}${i === 1 ? "" : ` (${i})`}${dot}`);
    if (!(await pathExists(p))) return p;
  }
  return join(dir, `${base} (${Date.now()})${dot}`);
}

/** Is `child` inside `parent` (case-insensitive, both absolute)? */
export function isInside(child: string, parent: string): boolean {
  const c = trimTrailingSep(child).toLowerCase();
  const p = trimTrailingSep(parent).toLowerCase();
  return c.startsWith(p.endsWith("\\") ? p : p + "\\");
}
