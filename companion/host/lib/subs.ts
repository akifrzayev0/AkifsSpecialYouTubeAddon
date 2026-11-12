// lib/subs.ts - subtitle conversion for the companion fallback (json3 / vtt / srt -> srt / txt).
// YouTube json3 (including auto-generated "rolling" captions) is the preferred input:
// every event carries only its own words, so cues come out clean.

export interface Cue {
  /** ms */
  start: number;
  /** ms */
  end: number;
  text: string;
}

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;

function cleanText(s: string): string {
  return s
    .replace(ZERO_WIDTH, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseJson3(text: string): Cue[] {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const events = (j as { events?: unknown })?.events;
  if (!Array.isArray(events)) return [];
  const cues: Cue[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const e = ev as { segs?: unknown; tStartMs?: unknown; dDurationMs?: unknown };
    if (!Array.isArray(e.segs)) continue;
    const raw = e.segs.map((s) => (s && typeof s === "object" && typeof (s as { utf8?: unknown }).utf8 === "string") ? (s as { utf8: string }).utf8 : "").join("");
    const t = cleanText(raw);
    if (!t) continue;
    const start = num(e.tStartMs) ?? 0;
    const dur = num(e.dDurationMs) ?? 0;
    cues.push({ start, end: start + dur, text: t });
  }
  return normalizeCues(cues);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** "00:01:02.345" / "01:02.345" / "00:01:02,345" -> ms */
function parseTimestamp(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, "0"));
}

/** WebVTT or SRT. Tags (<c>, <b>, <00:00:01.000>) are stripped. */
export function parseVttOrSrt(text: string): Cue[] {
  const blocks = text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split("-->");
    const start = parseTimestamp(a);
    const end = parseTimestamp((b ?? "").trim().split(/\s+/)[0] ?? "");
    if (start == null || end == null) continue;
    const t = cleanText(decodeEntities(lines.slice(ti + 1).join("\n").replace(/<[^>]*>/g, "")));
    if (t) cues.push({ start, end, text: t });
  }
  return normalizeCues(cues);
}

/** Sort, merge cues that start together, clip overlaps, give zero-length cues a sane end. */
export function normalizeCues(input: Cue[]): Cue[] {
  const cues = input.filter((c) => c.text).map((c) => ({ ...c })).sort((x, y) => x.start - y.start || x.end - y.end);
  const out: Cue[] = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && c.start === prev.start) {
      // simultaneous events: add only the lines the cue does not have yet (same rule as the extension's converter)
      const have = new Set(prev.text.split("\n"));
      const add = c.text.split("\n").filter((l) => !have.has(l));
      if (add.length) prev.text += "\n" + add.join("\n");
      prev.end = Math.max(prev.end, c.end);
      continue;
    }
    out.push(c);
  }
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (out[i].end <= out[i].start) out[i].end = next ? Math.min(next.start, out[i].start + 3000) : out[i].start + 3000;
    if (next && out[i].end > next.start) out[i].end = next.start;
  }
  return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function srtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(t % 1000, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\r\n${srtTime(c.start)} --> ${srtTime(c.end)}\r\n${c.text.replace(/\n/g, "\r\n")}\r\n`).join("\r\n");
}

/** Formatting tags some uploaders put into caption text (<font color=..>, <b>, <i>, <u>, VTT <c>). */
const MARKUP = /<\/?(?:font|b|i|u|c|v|ruby|rt|span)(?:[.\s][^<>]*)?>/gi;

/** Dialogue / sound lines keep their own line in TXT. */
const OWN_LINE = /^(?:[-–—]|>>|\[|\()/;

/** Largest k so that the first k lines of `cur` equal the last k lines of `prev`. */
function overlapLines(prev: string[], cur: string[]): number {
  for (let k = Math.min(prev.length, cur.length); k > 0; k--) {
    let same = true;
    for (let i = 0; i < k && same; i++) same = prev[prev.length - k + i] === cur[i];
    if (same) return k;
  }
  return 0;
}

/**
 * Plain transcript with the same layout as the extension's in-browser TXT (extension/shared/subtitles.js toTxt):
 * one line per caption (the lines of a multi-line caption joined with spaces, except dialogue lines starting with
 * "-", ">>", "[" or "("), markup removed; lines a caption repeats from the text before it (rolling captions) are
 * written once, and never two identical lines in a row.
 */
export function toTxt(cues: Cue[]): string {
  const out: string[] = [];
  const push = (line: string) => {
    if (line && line !== out[out.length - 1]) out.push(line);
  };
  let recent: string[] = []; // tail of the caption lines already written
  for (const c of cues) {
    const lines = c.text.split("\n").map((raw) => decodeEntities(raw.replace(MARKUP, "")).replace(/\s+/g, " ").trim()).filter(Boolean);
    const fresh = lines.slice(overlapLines(recent.slice(-lines.length), lines));
    if (!fresh.length) continue;
    recent = recent.concat(fresh).slice(-16);
    let current = "";
    for (const line of fresh) {
      if (current && OWN_LINE.test(line)) {
        push(current);
        current = line;
      } else current = current ? current + " " + line : line;
    }
    push(current);
  }
  return out.join("\r\n") + (out.length ? "\r\n" : "");
}

/** Convert a downloaded subtitle file (by its extension) to srt or txt. Returns null when nothing usable was found. */
export function convertSubtitle(text: string, fromExt: string, to: "srt" | "txt"): string | null {
  const ext = fromExt.replace(/^\./, "").toLowerCase();
  const cues = ext === "json3" ? parseJson3(text) : parseVttOrSrt(text);
  if (!cues.length) return null;
  return to === "srt" ? toSrt(cues) : toTxt(cues);
}
