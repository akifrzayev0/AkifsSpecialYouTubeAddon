// lib/tempdirs.ts - where a job's temporary files live, and the sweeps that remove what a killed host left.
//
//   <outDir>\.akif-tmp\<8 hex>\        partial media (yt-dlp -P temp:) on the output folder's volume, so the
//                                       final move is a rename. Contains the marker file .akif-job; the stale
//                                       sweep only ever deletes folders with that marker.
//   <root>\state\jobs\<pid>-<8 hex>\    private (inside %LOCALAPPDATA%, never synced or shared): cookies.txt,
//                                       which exists only while yt-dlp runs, and ALL temp files when the output
//                                       folder is inside a cloud-sync folder (OneDrive, Dropbox, Google Drive...)
//                                       or its .akif-tmp is not a plain folder (a junction/symlink).
// Secrets never go into the output folder: it may be synced, on a network share or readable by other users.

import { STATE_DIR } from "./config.ts";
import { log } from "./log.ts";
import { dirname, isInside, join, trimTrailingSep } from "./paths.ts";
import { hostPids, removeWithRetry, setHidden } from "./proc.ts";

export const PRIVATE_JOBS_DIR = join(STATE_DIR, "jobs");
export const OUT_TMP = ".akif-tmp";
export const JOB_MARKER = ".akif-job";
const OUT_JOB_NAME = /^[0-9a-f]{8}$/;
const PRIVATE_JOB_NAME = /^(\d+)-[0-9a-f]{8}$/;
const STALE_TEMP_MS = 12 * 3600_000;

/** Temp dirs of jobs running in this host process (never swept). Lower-case paths. */
const ACTIVE = new Set<string>();

export function release(dir: string) {
  if (dir) ACTIVE.delete(dir.toLowerCase());
}

/** Short temp dir name (path budget): 8 random hex characters. */
export function tempName(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new private job folder path (created on demand with ensureDir). */
export function privateJobDir(): string {
  return join(PRIVATE_JOBS_DIR, `${Deno.pid}-${tempName()}`);
}

export async function ensureDir(dir: string) {
  await Deno.mkdir(dir, { recursive: true });
  ACTIVE.add(dir.toLowerCase());
}

// ---------------------------------------------------------------------------
// cloud-sync folders

/** Folder names the sync clients use (OneDrive - Company, Dropbox (Team), Google Drive streaming "My Drive"...). */
const SYNC_SEGMENT = /^(?:onedrive(?: - .+)?|dropbox(?: \(.+\))?|google ?drive|my drive|shared drives|icloud ?drive|box|box sync)$/i;

/** Windows accepts "/" as a separator too; the comparisons below work on "\" only. */
const backslashes = (p: string): string => p.replace(/\//g, "\\");

/** Sync roots the environment tells about: %OneDrive% (+ Consumer / Commercial) and Dropbox's info.json. */
export function cloudSyncRoots(get: (name: string) => string | undefined = (n) => Deno.env.get(n)): string[] {
  const roots: string[] = [];
  for (const k of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
    const v = get(k);
    if (v && /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(v)) roots.push(backslashes(v));
  }
  for (const base of [get("APPDATA"), get("LOCALAPPDATA")]) {
    if (!base) continue;
    try {
      const info = JSON.parse(Deno.readTextFileSync(join(base, "Dropbox", "info.json")));
      for (const account of Object.values(info ?? {})) {
        const p = (account as { path?: unknown } | null)?.path;
        if (typeof p === "string" && /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(p)) roots.push(backslashes(p));
      }
    } catch { /* no Dropbox */ }
  }
  return roots;
}

/** Is dir (absolute) inside a folder a cloud client uploads? Uploading partial files wastes GBs and locks them. */
export function isCloudSynced(dir: string, roots: string[]): boolean {
  const dirB = backslashes(dir);
  const d = trimTrailingSep(dirB).toLowerCase();
  for (const root of roots) {
    const r = backslashes(root);
    if (d === trimTrailingSep(r).toLowerCase() || isInside(dirB, r)) return true;
  }
  return dirB.split("\\").some((s) => SYNC_SEGMENT.test(s));
}

// ---------------------------------------------------------------------------
// <outDir>\.akif-tmp

/**
 * realPath of <outDir>\.akif-tmp when it is a plain folder exactly there. null when it is a junction or
 * symlink (someone who can write to a shared output folder could point it at the user's own folders), not
 * a folder, or cannot be verified.
 */
async function verifiedRoot(outDir: string, root: string): Promise<string | null> {
  try {
    const st = await Deno.lstat(root);
    if (st.isSymlink || !st.isDirectory) {
      log("warn", `${root} is not a plain folder (a link?); this job uses the private temp folder`);
      return null;
    }
    const [real, realOut] = await Promise.all([Deno.realPath(root), Deno.realPath(outDir)]);
    if (real.toLowerCase() !== join(realOut, OUT_TMP).toLowerCase()) {
      log("warn", `${root} resolves to ${real}; this job uses the private temp folder`);
      return null;
    }
    return real;
  } catch (e) {
    log("warn", `cannot verify ${root} (${String(e)}); this job uses the private temp folder`);
    return null;
  }
}

/**
 * Create <outDir>\.akif-tmp\<name>\ with the marker file and sweep stale siblings in the background.
 * null when .akif-tmp cannot be trusted (the job then uses its private folder for everything).
 */
export async function createOutputTemp(outDir: string): Promise<string | null> {
  const root = join(outDir, OUT_TMP);
  for (let i = 0; ; i++) {
    try {
      await Deno.mkdir(root); // not recursive: never silently accept an existing junction
    } catch (e) {
      if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
    }
    const real = await verifiedRoot(outDir, root);
    if (!real) return null;
    setHidden(root);
    const dir = join(root, tempName());
    try {
      await Deno.mkdir(dir); // not recursive: an existing dir (another job's) must not be reused
    } catch (e) {
      // AlreadyExists: name taken. NotFound: another job removed the (then empty) .akif-tmp between our two
      // mkdir calls - create it again.
      if (!(e instanceof Deno.errors.AlreadyExists || e instanceof Deno.errors.NotFound) || i > 20) throw e;
      continue;
    }
    ACTIVE.add(dir.toLowerCase());
    try {
      await Deno.writeTextFile(join(dir, JOB_MARKER), `${Deno.pid}\n`);
    } catch (e) {
      release(dir);
      await removeWithRetry(dir, 3, 100);
      throw e;
    }
    void sweepOutputTemp(root, real);
    return dir;
  }
}

/** p is still a plain folder whose real location is directly inside realRoot (re-checked right before deleting). */
async function stillInside(p: string, realRoot: string): Promise<boolean> {
  try {
    const st = await Deno.lstat(p);
    if (st.isSymlink || !st.isDirectory) return false;
    return dirname(await Deno.realPath(p)).toLowerCase() === realRoot.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Remove temp dirs left behind by a host that was killed (power loss, crash): only folders this companion
 * created (8-hex name + marker file, never a link), not used by this process, and untouched for 12 hours
 * (host instances of other browsers - or other PCs on a shared folder - may be downloading right now).
 * Exported for tests.
 */
export async function sweepOutputTemp(root: string, realRoot: string) {
  const now = Date.now();
  try {
    for await (const e of Deno.readDir(root)) {
      if (!e.isDirectory || e.isSymlink || !OUT_JOB_NAME.test(e.name)) continue;
      const p = join(root, e.name);
      if (ACTIVE.has(p.toLowerCase())) continue;
      let newest = 0;
      try {
        const st = await Deno.lstat(p);
        if (st.isSymlink || !st.isDirectory) continue;
        if (!(await Deno.lstat(join(p, JOB_MARKER))).isFile) continue;
        newest = st.mtime?.getTime() ?? 0;
        for await (const f of Deno.readDir(p)) newest = Math.max(newest, (await Deno.lstat(join(p, f.name))).mtime?.getTime() ?? 0);
      } catch {
        continue;
      }
      if (!newest || now - newest <= STALE_TEMP_MS) continue;
      if (!(await stillInside(p, realRoot))) continue;
      log("info", `removing stale temp dir ${p}`);
      await removeWithRetry(p, 3, 200);
    }
  } catch { /* gone or unreadable */ }
}

/** Remove a job's folder in <outDir>\.akif-tmp, then .akif-tmp itself when it is empty (other jobs may use it). */
export async function removeOutputTemp(outDir: string, dir: string) {
  const root = join(outDir, OUT_TMP);
  try {
    if ((await Deno.lstat(root)).isSymlink) {
      log("warn", `${root} was replaced by a link during the job; leaving it alone`);
      return;
    }
  } catch {
    return; // gone
  }
  await removeWithRetry(dir);
  try {
    await Deno.remove(root); // only succeeds when empty
  } catch { /* not empty / gone */ }
}

// ---------------------------------------------------------------------------
// <root>\state\jobs

/**
 * Remove private job folders whose host process is gone (crash, power loss, killed host): the cookies in
 * them must not outlive their job. Runs at host start. Folders of running hosts are kept; when the process
 * list is unavailable nothing is removed. (`dir`: tests only.)
 */
export async function sweepPrivateTemp(dir = PRIVATE_JOBS_DIR) {
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory && !e.isSymlink && PRIVATE_JOB_NAME.test(e.name)) names.push(e.name);
    }
  } catch {
    return; // no private folder yet
  }
  if (!names.length) return;
  const alive = hostPids();
  if (!alive) return;
  for (const n of names) {
    const pid = Number(PRIVATE_JOB_NAME.exec(n)![1]);
    const p = join(dir, n);
    if (alive.has(pid) || ACTIVE.has(p.toLowerCase())) continue;
    log("info", `removing ${p} (its host process ${pid} is gone)`);
    await removeWithRetry(p, 3, 200);
  }
}

// ---------------------------------------------------------------------------

/**
 * Move a finished file from the job's temp folder into the output folder. A rename when both are on one
 * volume; otherwise (private temp folder on C:, output on another drive: os error 17), or when another
 * program holds the source open, copy + delete.
 */
export async function moveFile(src: string, dest: string) {
  try {
    await Deno.rename(src, dest);
    return;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound || e instanceof Deno.errors.AlreadyExists) throw e;
    log("info", `rename ${src} failed (${String(e)}); copying instead`);
  }
  try {
    await Deno.copyFile(src, dest);
  } catch (e) {
    await Deno.remove(dest).catch(() => {});
    throw e;
  }
  await removeWithRetry(src, 10, 150);
}
