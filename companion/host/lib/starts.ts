// lib/starts.ts - the `start` and `cancel` requests (spec 8.1).
//
// A start has to wait for its output folder (mkdir on a slow, sleeping or network drive can take seconds), and
// the host handles requests concurrently. So the job id is RESERVED synchronously, before that first await:
//   - a second start with the same id is refused (bad_task), also while the first one still waits;
//   - a cancel that arrives during the wait finds the job: the reservation is marked canceled and the cancel is
//     answered {} (not {found:false}). When the folder is ready the start is answered {outDir} as usual, the job is
//     never launched, and `canceled` is emitted as its only (terminal) event;
//   - the job limit counts reserved starts too.
// Between the end of the wait and the launch nothing awaits, so a cancel finds either the reservation or the job.

import { log } from "./log.ts";
import { BadTask, JOB_ID_RE, type Task, validateTask } from "./task.ts";

/** What the starter needs from the job manager (lib/jobs.ts JobManager). */
export interface JobRunner {
  readonly size: number;
  has(id: string): boolean;
  /** Launches the job (registered synchronously); settles after its terminal event. */
  start(id: string, task: Task, outDir: string): Promise<void>;
  /** false when the job is unknown. */
  cancel(id: string): boolean;
}

export interface StarterDeps {
  jobs: JobRunner;
  maxJobs: number;
  /** Creates the output folder; throws BadTask when it cannot be used. */
  resolveOutputDir(task: Task): Promise<string>;
  /** Why no job may start right now (yt-dlp is being updated by this host), or null. Asked before and after the wait. */
  blocked(): string | null;
  /**
   * Called synchronously right before a job is launched: tell the other host instances. A string refuses the start
   * (code busy), e.g. another instance is updating yt-dlp.
   */
  admit(): string | null;
  /** A launched job has ended (after its terminal event). */
  ended(): void;
  reply(id: unknown, data?: Record<string, unknown>): unknown;
  fail(id: unknown, code: string, error: string): unknown;
  emit(msg: Record<string, unknown>): unknown;
}

interface Reservation {
  canceled: boolean;
}

export class Starter {
  readonly #deps: StarterDeps;
  readonly #pending = new Map<string, Reservation>();

  constructor(deps: StarterDeps) {
    this.#deps = deps;
  }

  /** Jobs running or waiting for their output folder. */
  get count(): number {
    return this.#deps.jobs.size + this.#pending.size;
  }

  /** Starts still waiting for their output folder. */
  get pending(): number {
    return this.#pending.size;
  }

  async start(id: unknown, jobId: unknown, rawTask: unknown): Promise<unknown> {
    const d = this.#deps;
    if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) return d.fail(id, "bad_task", "jobId must be 1-64 characters (A-Z a-z 0-9 _ -)");
    if (d.jobs.has(jobId) || this.#pending.has(jobId)) return d.fail(id, "bad_task", `job ${jobId} is already running`);
    if (this.count >= d.maxJobs) return d.fail(id, "busy", `too many simultaneous jobs (max ${d.maxJobs})`);
    const blocked = d.blocked();
    if (blocked) return d.fail(id, "busy", blocked);
    let task: Task;
    try {
      task = validateTask(rawTask);
    } catch (e) {
      if (!(e instanceof BadTask)) throw e;
      log("warn", `job ${jobId} rejected: ${e.message}`);
      return d.fail(id, "bad_task", e.message);
    }
    // Reserved before the first await (see the header).
    const r: Reservation = { canceled: false };
    this.#pending.set(jobId, r);
    let outDir: string;
    try {
      outDir = await d.resolveOutputDir(task);
    } catch (e) {
      this.#pending.delete(jobId);
      if (!(e instanceof BadTask)) throw e;
      // A start that fails gets no events; the extension ends a job it wanted canceled on this answer itself.
      log("warn", `job ${jobId} rejected: ${e.message}`);
      return d.fail(id, "bad_task", e.message);
    }
    // ---- no await from here to the launch ----
    this.#pending.delete(jobId);
    if (r.canceled) {
      log("info", `job ${jobId} was canceled while its output folder was prepared; not started`);
      const answered = d.reply(id, { outDir });
      d.emit({ event: "canceled", jobId }); // after the answer: the extension learns of the job first
      return answered;
    }
    const late = d.blocked() ?? d.admit();
    if (late) return d.fail(id, "busy", late);
    void d.jobs.start(jobId, task, outDir).finally(() => d.ended());
    log("info", `job ${jobId} accepted: ${task.kind} ${task.url} -> ${outDir}`);
    return d.reply(id, { outDir });
  }

  /**
   * The `cancel` request: true when the job was found (running, or reserved and now marked canceled), false when it
   * is unknown (already finished, or never started).
   */
  cancel(jobId: string): boolean {
    const r = this.#pending.get(jobId);
    if (r) {
      r.canceled = true;
      log("info", `job ${jobId}: cancel while its output folder is prepared`);
      return true;
    }
    return this.#deps.jobs.cancel(jobId);
  }

  /** Host shutdown: no reserved start may launch any more. */
  cancelPending() {
    for (const r of this.#pending.values()) r.canceled = true;
  }
}
