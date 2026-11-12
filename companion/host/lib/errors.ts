// lib/errors.ts - classify yt-dlp / ffmpeg failures into protocol error codes (spec 8.2 / 8.4).

// no_subtitles: the requested subtitle track does not exist (or came back empty).
// locked: another program (antivirus, cloud sync, indexer) held a file yt-dlp had to open or rename.
// access_denied: Windows refused access (Controlled Folder Access, folder permissions, an app-control
// policy or antivirus blocking yt-dlp/FFmpeg) - not a full disk.
export type ErrorCode =
  | "unavailable" | "private" | "age" | "members" | "bot" | "drm" | "live" | "format" | "no_subtitles" | "forbidden"
  | "rate_limited" | "network" | "disk" | "locked" | "access_denied" | "ffmpeg" | "ytdlp_missing" | "bad_task" | "host_exit"
  | "unknown";

export interface Classified {
  code: ErrorCode;
  message: string;
  detail: string;
  /** worth one automatic retry */
  transient: boolean;
}

// Order matters: the first matching rule wins.
const RULES: [RegExp, ErrorCode][] = [
  [/Sign in to confirm your age|age[- ]restricted|inappropriate for some users/i, "age"],
  [/Sign in to confirm you(?:'|\u2019)?re not a bot|confirm you are not a bot/i, "bot"],
  [/Private video|This video is private|video has been made private/i, "private"],
  [/members[- ]only|Join this channel|available to this channel's members/i, "members"],
  [/\bDRM\b/, "drm"],
  [/live event will begin|Premieres in|This live event|\bis live\b|is a live stream|currently live/i, "live"],
  [/Video unavailable|This video is unavailable|video has been removed|no longer available|account associated with this video has been terminated|not available in your country|playlist does not exist|This playlist is private/i, "unavailable"],
  [/Requested format is not available|No video formats found|format is not available/i, "format"],
  [/HTTP Error 429|Too Many Requests/i, "rate_limited"],
  [/HTTP Error 403|\b403 Forbidden\b/i, "forbidden"],
  [/No space left|Errno 28|not enough space|disk (?:is )?full/i, "disk"],
  // Python maps a sharing violation to errno 13 too, but prints the Windows code: "[WinError 32] The process
  // cannot access the file because it is being used by another process" (usually antivirus or a sync client).
  [/WinError 32\b|being used by another process/i, "locked"],
  [/WinError 5\b|\[Errno 13\]|Permission denied|Access is denied/i, "access_denied"],
  [/ffmpeg not found|ffprobe not found|ffmpeg is not installed|ffprobe and ffmpeg not found|ffprobe\/avprobe and ffmpeg\/avconv not found|You have requested merging .* but ffmpeg is not installed/i, "ffmpeg"],
  [/timed out|timeout|getaddrinfo|\bConnection|Network is unreachable|Temporary failure in name resolution|Unable to download (?:webpage|API page)|IncompleteRead|ConnectionReset|RemoteDisconnected|EOF occurred in violation|SSL:|WinError 1005[0-9]|ECONNRESET/i, "network"],
];

const TRANSIENT = new Set<ErrorCode>(["network", "forbidden", "locked"]);

/**
 * yt-dlp downloads a section (--download-sections: clips, GIFs) with FFmpeg reading from YouTube. --print makes yt-dlp
 * quiet, which silences that FFmpeg too, so a broken connection shows only as "ffmpeg exited with code N" - and
 * yt-dlp's own --retries do not cover it. Worth one more attempt.
 */
const SECTION_FFMPEG = /^ffmpeg exited with code (-?\d+)/i;

/** "ERROR: [youtube] abc: Video unavailable" -> "Video unavailable" */
export function cleanMessage(line: string): string {
  return line
    .replace(/^ERROR:\s*/, "")
    .replace(/^\[[^\]]+\]\s*(?:[^\s:\]]+:\s+)?/, "")
    .replace(/\s*Use --list-formats for a list of available formats\.?/, "")
    .trim()
    .slice(0, 400);
}

export function classifyText(text: string): ErrorCode {
  for (const [re, code] of RULES) if (re.test(text)) return code;
  return "unknown";
}

export interface RunFacts {
  exitCode: number | null;
  /** "ERROR:" lines (without the prefix) */
  errors: string[];
  warnings: string[];
  /** last stderr/stdout lines that were not protocol lines */
  tail: string[];
  /** number of output lines the process produced */
  lines: number;
}

/** Classify a failed run. Falls back to warnings and the output tail when there is no ERROR line. */
export function classifyRun(f: RunFacts): Classified {
  const detail = [...f.errors, ...f.tail.slice(-12)].join("\n").slice(-4000);
  // "exit 127 with empty output" happened once and succeeded on retry
  if (f.lines === 0 && f.errors.length === 0) {
    return { code: "unknown", message: `yt-dlp exited with code ${f.exitCode} without any output`, detail, transient: true };
  }
  const primary = f.errors.length ? f.errors.join("\n") : [...f.warnings, ...f.tail].join("\n");
  const code = classifyText(primary);
  const first = f.errors[0] ?? f.warnings[f.warnings.length - 1] ?? f.tail[f.tail.length - 1] ?? `exit code ${f.exitCode}`;
  const section = code === "unknown" ? SECTION_FFMPEG.exec(cleanMessage(first)) : null;
  if (section) {
    return { code, message: `FFmpeg stopped while downloading the clip (exit code ${section[1]})`, detail, transient: true };
  }
  return { code, message: cleanMessage(first) || `yt-dlp failed (exit code ${f.exitCode})`, detail, transient: TRANSIENT.has(code) };
}
