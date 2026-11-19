// Token prices for trade builds: Jupiter Price v3 (USD per UI token), many mints in one call, and
// a short cache shared by every build. A build that reuses a known route (the fork API's long-lived
// route templates, scripts/fork/api/routing.ts) reprices it from these instead of quoting again,
// so a whole basket costs at most one Jupiter call.
//
// Unlike the display prices (scripts/fork/api/valuation.ts), nothing older stands in: no asset bank
// price, no stale copy. A mint Jupiter didn't price, or a read that failed, is simply missing, and
// the caller quotes that leg afresh.
import { jupiterBase, jupiterRequest, type JupiterAccess } from "./index.ts";

/** Price v3 takes at most this many ids per call. */
const PRICE_IDS_PER_CALL = 50;
/** How long a build reuses a price read for another build (ms). */
export const PRICE_TTL_MS = 10_000;

/**
 * USD per UI token for each mint Jupiter prices (Price v3), up to 50 per call. Throws when a call
 * fails (not 200, a timeout, a budget that refuses it); mints Jupiter has no price for are absent.
 */
export async function jupiterPrices(mints: string[], o: JupiterAccess = {}): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < mints.length; i += PRICE_IDS_PER_CALL) {
    const ids = mints.slice(i, i + PRICE_IDS_PER_CALL);
    const r = await jupiterRequest(`${jupiterBase(o.apiKey)}/price/v3?ids=${ids.join(",")}`, { method: "GET" }, o.apiKey, o.fetchFn, o.max429WaitMs);
    if (!r.ok) throw new Error(`Jupiter price v3 HTTP ${r.status}`);
    for (const [mint, p] of Object.entries((r.json ?? {}) as Record<string, { usdPrice?: unknown } | null>)) {
      const usd = p?.usdPrice;
      if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) out.set(mint, usd);
    }
  }
  return out;
}

/** A price as the cache holds it: USD per UI token, and when it was read (ms). */
export type CachedPrice = { usd: number; at: number };

/**
 * Prices read in the last `ttlMs`, shared: a build asks for its mints, gets the fresh ones from the
 * cache and the rest in one read, and a mint already being read waits for that read instead of
 * reading again. A failed read leaves its mints missing (never throws), so callers fall back.
 */
export class PriceCache {
  readonly ttlMs: number;
  #now: () => number;
  #prices = new Map<string, CachedPrice>();
  #reads = new Map<string, Promise<void>>();
  /** Reads made, and how many of them failed (for logs and tests). */
  readonly stats = { reads: 0, failed: 0 };

  constructor(ttlMs = PRICE_TTL_MS, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.#now = now;
  }

  /** The cached price of `mint` if it was read at most `maxAgeMs` ago. */
  peek(mint: string, maxAgeMs = this.ttlMs): CachedPrice | null {
    const p = this.#prices.get(mint);
    return p && p.at >= this.#now() - maxAgeMs ? p : null;
  }

  /** Each mint's price, read at most `ttlMs` ago: from the cache, a read in flight, or one read (`read`) for the rest. */
  async get(mints: string[], read: (mints: string[]) => Promise<Map<string, number>>): Promise<Map<string, CachedPrice>> {
    const uniq = [...new Set(mints)];
    const waits: Promise<void>[] = [];
    const todo: string[] = [];
    for (const m of uniq) {
      if (this.peek(m)) continue;
      const pending = this.#reads.get(m);
      if (pending) waits.push(pending);
      else todo.push(m);
    }
    if (todo.length) {
      this.stats.reads++;
      const r = read(todo)
        .then((prices) => {
          const at = this.#now();
          for (const [m, usd] of prices) this.#prices.set(m, { usd, at });
        })
        .catch(() => {
          this.stats.failed++;
        })
        .finally(() => {
          for (const m of todo) if (this.#reads.get(m) === r) this.#reads.delete(m);
        });
      for (const m of todo) this.#reads.set(m, r);
      waits.push(r);
    }
    await Promise.all(waits);
    this.#sweep();
    const out = new Map<string, CachedPrice>();
    for (const m of uniq) {
      const p = this.peek(m);
      if (p) out.set(m, p);
    }
    return out;
  }

  /** Drops old prices now and then, so the cache holds only mints being traded. */
  #sweep() {
    if (this.#prices.size < 500) return;
    const old = this.#now() - this.ttlMs;
    for (const [m, p] of this.#prices) if (p.at < old) this.#prices.delete(m);
  }
}
