// Jupiter client for the asset bank: batched Price v3, swap quotes, and the token
// list, all through one pacer so the poller stays inside the plan's rate limit.
//
// Jupiter limits per organisation over a 60 s sliding window, and Swap, Price and
// Token calls share one bucket (developers.jup.ag/docs/portal/rate-limits). The
// Free plan key reports 10 requests per ~10 s (1 RPS).
import { fetchJson } from "../../registry/src/lib/http.ts";
import type { JupToken } from "../../registry/src/sources/jupiter.ts";
import { USDC } from "../../registry/src/curated.ts";
import type { ProbeQuote } from "./state.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialises calls and spaces them `60000 / perMinute` ms apart. */
export class Pacer {
  gapMs: number;
  #next = 0;
  #chain: Promise<unknown> = Promise.resolve();
  count = 0;
  constructor(perMinute: number) {
    this.gapMs = perMinute > 0 ? 60_000 / perMinute : 0;
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    // No spacing: run at once (callers that want a budget pass one; 429s are retried per request).
    if (this.gapMs === 0) {
      this.count++;
      return fn();
    }
    const p = this.#chain.then(async () => {
      const wait = this.#next - Date.now();
      if (wait > 0) await sleep(wait);
      this.#next = Date.now() + this.gapMs;
      this.count++;
      return fn();
    });
    this.#chain = p.catch(() => undefined);
    return p;
  }
}

export type JupPrice = { usdPrice: number; underlyingUsd: number | null; decimals: number | null; liquidity: number | null };

/** The raw quote response, trimmed to what routing needs (kept whole in `raw` for the swap call). */
export type JupQuote = {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: { swapInfo: { label?: string; ammKey?: string; inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string; feeAmount?: string; feeMint?: string }; percent: number }[];
  platformFee?: { amount: string; feeBps: number } | null;
  contextSlot?: number;
  [k: string]: unknown;
};

export type QuoteFn = (
  outputMint: string,
  usd: number,
  /** `dexes`: route only through these Jupiter venue labels (the fork's state-based AMMs). */
  o: { maxAccounts: number; slippageBps?: number; dexes?: string[] },
) => Promise<{ quote: JupQuote | null; error: string | null }>;

export class JupiterClient {
  base: string;
  headers: Record<string, string>;
  pacer: Pacer;
  label: string;
  constructor(apiKey: string | null, perMinute: number) {
    this.base = apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag";
    this.headers = apiKey ? { "x-api-key": apiKey } : {};
    this.label = apiKey ? "api.jup.ag (JUPITER_API_KEY)" : "lite-api.jup.ag (keyless)";
    this.pacer = new Pacer(perMinute);
  }

  #get<T>(path: string, okStatuses: number[] = []) {
    return this.pacer.run(() => fetchJson<T>(`${this.base}${path}`, { headers: this.headers, okStatuses, retries: 4 }));
  }

  async verifiedTokens(): Promise<JupToken[]> {
    return (await this.#get<JupToken[]>(`/tokens/v2/tag?query=verified`)).json ?? [];
  }

  async search(query: string): Promise<JupToken[]> {
    const r = (await this.#get<JupToken[]>(`/tokens/v2/search?query=${encodeURIComponent(query)}`)).json;
    return Array.isArray(r) ? r : [];
  }

  /** Price v3, 50 ids per call (the documented maximum). Missing ids have no price. */
  async prices(mints: string[]): Promise<Map<string, JupPrice>> {
    const out = new Map<string, JupPrice>();
    for (let i = 0; i < mints.length; i += 50) {
      const chunk = mints.slice(i, i + 50);
      const j = (await this.#get<Record<string, any>>(`/price/v3?ids=${chunk.join(",")}`)).json ?? {};
      for (const [mint, p] of Object.entries(j)) {
        if (!p || typeof p.usdPrice !== "number") continue;
        out.set(mint, { usdPrice: p.usdPrice, underlyingUsd: typeof p.stockData?.price === "number" ? p.stockData.price : null, decimals: p.decimals ?? null, liquidity: p.liquidity ?? null });
      }
    }
    return out;
  }

  quote: QuoteFn = (outputMint, usd, o) => this.quoteExactIn(USDC, outputMint, BigInt(Math.round(usd * 1e6)), o);

  async quoteExactIn(inputMint: string, outputMint: string, amount: bigint, o: Parameters<QuoteFn>[2]) {
    let qs = `inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${o.slippageBps ?? 100}&maxAccounts=${o.maxAccounts}`;
    if (o.dexes?.length) qs += `&dexes=${encodeURIComponent(o.dexes.join(","))}`;
    const r = await this.#get<any>(`/swap/v1/quote?${qs}`, [400, 404]);
    const j = r.json;
    if (r.status !== 200 || !j?.outAmount || !j.routePlan?.length) return { quote: null, error: String(j?.errorCode ?? j?.error ?? (r.status === 200 ? "empty route" : `HTTP ${r.status}`)) };
    return { quote: j as JupQuote, error: null };
  }
}

export function toProbeQuote(usd: number, r: { quote: JupQuote | null; error: string | null }): ProbeQuote {
  if (!r.quote) return { usd, routed: false, outAmountRaw: null, priceImpactPct: null, hops: null, venues: [], error: r.error };
  const q = r.quote;
  return {
    usd,
    routed: true,
    outAmountRaw: String(q.outAmount),
    priceImpactPct: Number(q.priceImpactPct) * 100,
    hops: q.routePlan.length,
    venues: [...new Set(q.routePlan.map((p) => p.swapInfo?.label).filter((x): x is string => Boolean(x)))],
    error: null,
  };
}
