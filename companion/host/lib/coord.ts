// lib/coord.ts - coordination between host instances.
//
// Chrome, Edge and every browser profile start their own host process, but all of them share bin\ (the
// onedir yt-dlp), Python's site-packages (a pip yt-dlp) and state\. An update must never replace yt-dlp
// while another instance runs a download with it, so each host announces what it is doing with a marker
// file state\run\<kind>-<pid>:
//   jobs-<pid>    the host has at least one job running
//   update-<pid>  the host is updating yt-dlp
// Both sides first announce, then look for the other kind: whichever comes second sees the first one.
// Markers of processes that are gone (crash, power loss) are ignored and removed.

import { STATE_DIR } from "./config.ts";
import { log } from "./log.ts";
import { join } from "./paths.ts";
import { hostPids } from "./proc.ts";

export type Activity = "jobs" | "update";

const RUN_DIR = join(STATE_DIR, "run");
const MARKER = /^(jobs|update)-(\d+)$/;

// `dir` parameters: tests only.

export function announce(kind: Activity, dir = RUN_DIR): void {
  try {
    Deno.mkdirSync(dir, { recursive: true });
    Deno.writeTextFileSync(join(dir, `${kind}-${Deno.pid}`), new Date().toISOString());
  } catch (e) {
    log("warn", `cannot write the ${kind} marker:`, String(e));
  }
}

export function withdraw(kind: Activity, dir = RUN_DIR): void {
  try {
    Deno.removeSync(join(dir, `${kind}-${Deno.pid}`));
  } catch { /* not there */ }
}

/** PIDs of OTHER running host processes that announced `kind`. */
export function othersDoing(kind: Activity, dir = RUN_DIR): number[] {
  const found: { name: string; pid: number }[] = [];
  try {
    for (const e of Deno.readDirSync(dir)) {
      const m = MARKER.exec(e.name);
      if (m && m[1] === kind && Number(m[2]) !== Deno.pid) found.push({ name: e.name, pid: Number(m[2]) });
    }
  } catch {
    return []; // no markers yet
  }
  if (!found.length) return [];
  const alive = hostPids();
  const out: number[] = [];
  for (const f of found) {
    if (!alive || alive.has(f.pid)) {
      out.push(f.pid); // process list unavailable: assume it is still running
      continue;
    }
    try {
      Deno.removeSync(join(dir, f.name));
    } catch { /* another host removed it */ }
  }
  return out;
}
