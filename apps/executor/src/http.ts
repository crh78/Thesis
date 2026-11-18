// The executor's one HTTP helper: JSON reads with a timeout and bounded retries, a fetch that
// always times out (for clients that take a fetch function), and a cool-down for a source that
// answers 429, so a rate-limited key isn't hammered every tick.

export type FetchFn = typeof fetch;

/** Every outbound read gives up after this long unless the caller says otherwise. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type GetJsonOptions = {
  headers?: Record<string, string>;
  fetchFn?: FetchFn;
  /** Retries after the first try (default 3). */
  tries?: number;
  timeoutMs?: number;
  /** The first retry's delay; each later one doubles, up to `maxDelayMs`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Which HTTP statuses are retried (default 429 and 5xx). */
  retryStatus?: (status: number) => boolean;
  /** Retry when the request fails outright (unreachable, timed out). Default false. */
  retryNetwork?: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const where = (url: string) => {
  const u = new URL(url);
  return `${u.host}${u.pathname}`;
};

/** GETs JSON. Non-retryable statuses throw an HttpError with the start of the body. */
export async function getJson(url: string, o: GetJsonOptions = {}): Promise<any> {
  const fetchFn = o.fetchFn ?? fetch;
  const tries = o.tries ?? 3;
  const retryStatus = o.retryStatus ?? ((s: number) => s === 429 || s >= 500);
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    let failure: unknown = null;
    try {
      res = await fetchFn(url, { headers: o.headers ?? {}, signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
      if (res.ok) return await res.json();
    } catch (e) {
      // Unreachable, timed out, or a body that didn't arrive in time.
      failure = e;
      res = null;
    }
    if (res) {
      if (!retryStatus(res.status) || attempt >= tries) {
        const body = retryStatus(res.status) ? "" : ` ${await res.text().catch(() => "")}`;
        throw new HttpError(`${where(url)}: HTTP ${res.status}${body}`.slice(0, 300), res.status);
      }
    } else if (!o.retryNetwork || attempt >= tries) {
      throw new Error(`${where(url)}: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
    // A Retry-After in seconds is honoured, within the same cap.
    const after = Number(res?.headers.get("retry-after"));
    const delay = after > 0 ? after * 1000 : (o.baseDelayMs ?? 500) * 2 ** attempt;
    await sleep(Math.min(o.maxDelayMs ?? 20_000, delay));
  }
}

/** A fetch that always gives up after `ms` (unless the caller passes its own signal). */
export function timedFetch(ms = DEFAULT_TIMEOUT_MS, fetchFn: FetchFn = fetch): FetchFn {
  return ((input: Parameters<FetchFn>[0], init?: RequestInit) => fetchFn(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) })) as FetchFn;
}

/** Waits `ms`, or less if `signal` aborts first (a service's wait between runs, cut short by SIGTERM). */
export function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * After a 429, a source rests: calls fail at once for `minMs`, doubling with each 429 in a row up
 * to `maxMs`, and the first success resets it. Retrying a rate-limited key every 20 s only keeps
 * it limited, and spends the budget the fork API's trades share.
 */
export class CoolDown {
  label: string;
  minMs: number;
  maxMs: number;
  now: () => number;
  #until = 0;
  #streak = 0;
  constructor(label: string, o: { minMs?: number; maxMs?: number; now?: () => number } = {}) {
    this.label = label;
    this.minMs = o.minMs ?? 30_000;
    this.maxMs = o.maxMs ?? 120_000;
    this.now = o.now ?? Date.now;
  }

  /** Runs `fn` unless the source is resting; a 429 from it starts (or lengthens) the rest. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const left = this.#until - this.now();
    if (left > 0) throw new Error(`${this.label}: rate limited, resting ${Math.ceil(left / 1000)}s`);
    try {
      const out = await fn();
      this.#streak = 0;
      return out;
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) {
        this.#until = this.now() + Math.min(this.maxMs, this.minMs * 2 ** this.#streak++);
      }
      throw e;
    }
  }

  get resting(): boolean {
    return this.#until > this.now();
  }
}
