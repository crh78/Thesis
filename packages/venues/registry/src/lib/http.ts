// fetch with retries and a per-host limiter that obeys x-ratelimit-* headers.
// Jupiter's free lite-api allows about 5 requests per rolling window of a few
// seconds; the limiter waits for x-ratelimit-reset instead of hammering it.

type HostState = { nextAt: number; minGapMs: number };
const hosts = new Map<string, HostState>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function setMinGap(host: string, ms: number) {
  const s = hosts.get(host) ?? { nextAt: 0, minGapMs: ms };
  s.minGapMs = ms;
  hosts.set(host, s);
}

export class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, url: string) {
    super(`HTTP ${status} for ${redact(url)}${isPrivate(url) ? "" : `: ${body.slice(0, 200)}`}`);
    this.status = status;
    this.body = isPrivate(url) ? "<hidden: credentialed endpoint>" : body;
  }
}

/** Hosts whose URL carries a credential (QuickNode puts its token in the path). */
export function isPrivate(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h.includes("quiknode") || h.includes("quicknode");
  } catch {
    return true;
  }
}

/** Strips query values that might carry keys, so URLs are safe to log. */
function redact(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/key|token|secret/i.test(k)) u.searchParams.set(k, "REDACTED");
    // Never log anything identifying a credentialed endpoint.
    if (isPrivate(url)) return "<QUICKNODE_RPC_URL>";
    return u.toString();
  } catch {
    return "<url>";
  }
}

export type FetchOpts = { method?: string; headers?: Record<string, string>; body?: string; retries?: number; okStatuses?: number[] };

/** Returns { status, json, text }. Retries 429 and 5xx; other statuses are returned (not thrown) if listed in okStatuses. */
export async function fetchJson<T = any>(url: string, opts: FetchOpts = {}): Promise<{ status: number; json: T | null; text: string }> {
  const host = new URL(url).host;
  const st = hosts.get(host) ?? { nextAt: 0, minGapMs: 0 };
  hosts.set(host, st);
  const retries = opts.retries ?? 8;
  for (let attempt = 0; ; attempt++) {
    const wait = st.nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    st.nextAt = Date.now() + st.minGapMs;
    let res: Response;
    try {
      res = await fetch(url, { method: opts.method ?? "GET", headers: { accept: "application/json", ...(opts.headers ?? {}) }, body: opts.body, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(1000 * (attempt + 1));
      continue;
    }
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    if (remaining !== null && Number(remaining) <= 0 && reset) {
      const resetMs = Number(reset) * 1000 - Date.now() + 250;
      if (resetMs > 0) st.nextAt = Math.max(st.nextAt, Date.now() + Math.min(resetMs, 30_000));
    }
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw new HttpError(res.status, text, url);
      const resetMs = reset ? Number(reset) * 1000 - Date.now() + 250 : 0;
      // Wait exactly for the window to reset when the host says when; otherwise back off.
      await sleep(resetMs > 0 ? Math.min(resetMs, 30_000) : 1500 * (attempt + 1));
      continue;
    }
    let json: T | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (res.ok || (opts.okStatuses ?? []).includes(res.status)) return { status: res.status, json, text };
    throw new HttpError(res.status, text, url);
  }
}

export async function getJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const r = await fetchJson<T>(url, opts);
  if (r.json === null) throw new Error(`Non-JSON response from ${redact(url)}`);
  return r.json;
}

/** Runs fn over items with at most `n` in flight. */
export async function mapLimit<A, B>(items: A[], n: number, fn: (a: A, i: number) => Promise<B>): Promise<B[]> {
  const out: B[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
