// A small tier scheduler: each job has its own cadence, never overlaps itself,
// and backs off after a failure. Time is injected so tests can drive it.

export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export type Job = {
  name: string;
  intervalMs: number;
  /** Delay before the first run (default 0: run on the first tick). */
  initialDelayMs?: number;
  run(): Promise<void>;
};

type JobState = { job: Job; nextAt: number; running: Promise<void> | null; failures: number };

export type SchedulerEvent = { type: "start" | "ok" | "error"; job: string; at: number; durationMs?: number; error?: string };

export class Scheduler {
  #jobs: JobState[];
  #clock: Clock;
  #onEvent: (e: SchedulerEvent) => void;
  constructor(jobs: Job[], o: { clock?: Clock; onEvent?: (e: SchedulerEvent) => void } = {}) {
    this.#clock = o.clock ?? realClock;
    this.#onEvent = o.onEvent ?? (() => {});
    const t = this.#clock.now();
    this.#jobs = jobs.map((job) => ({ job, nextAt: t + (job.initialDelayMs ?? 0), running: null, failures: 0 }));
  }

  /**
   * Starts every job that is due and not already running; returns their names.
   * The next run is scheduled from the start time (fixed cadence). A run that
   * overruns its interval is followed by the next one as soon as it finishes.
   * After a failure the job retries after min(interval, 30 s x 2^failures).
   */
  tick(): string[] {
    const now = this.#clock.now();
    const started: string[] = [];
    for (const s of this.#jobs) {
      if (s.running || now < s.nextAt) continue;
      started.push(s.job.name);
      this.#onEvent({ type: "start", job: s.job.name, at: now });
      s.nextAt = now + s.job.intervalMs;
      s.running = s.job
        .run()
        .then(() => {
          s.failures = 0;
          this.#onEvent({ type: "ok", job: s.job.name, at: this.#clock.now(), durationMs: this.#clock.now() - now });
        })
        .catch((e) => {
          s.failures++;
          s.nextAt = Math.min(s.nextAt, now + Math.min(s.job.intervalMs, 30_000 * 2 ** (s.failures - 1)));
          this.#onEvent({ type: "error", job: s.job.name, at: this.#clock.now(), durationMs: this.#clock.now() - now, error: String((e as Error)?.message ?? e).slice(0, 300) });
        })
        .finally(() => {
          s.running = null;
        });
    }
    return started;
  }

  /** Milliseconds until the next job is due (0 if one is due now). Running jobs are ignored. */
  msUntilNext(): number {
    const now = this.#clock.now();
    const idle = this.#jobs.filter((s) => !s.running);
    if (!idle.length) return 1000;
    return Math.max(0, Math.min(...idle.map((s) => s.nextAt - now)));
  }

  /** Resolves when no job is running. */
  async idle(): Promise<void> {
    while (this.#jobs.some((s) => s.running)) await Promise.all(this.#jobs.map((s) => s.running).filter(Boolean));
  }

  nextRuns(): Record<string, number> {
    return Object.fromEntries(this.#jobs.map((s) => [s.job.name, s.nextAt]));
  }

  /** Loops until `signal` aborts, waking at most every `maxSleepMs`. */
  async loop(signal: AbortSignal, maxSleepMs = 5_000): Promise<void> {
    while (!signal.aborted) {
      this.tick();
      await this.#clock.sleep(Math.max(50, Math.min(maxSleepMs, this.msUntilNext())));
    }
    await this.idle();
  }
}
