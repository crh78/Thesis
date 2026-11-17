// Jupiter: the verified token list (with tags and pooled liquidity) and live
// USDC -> token quotes at $10 / $100 / $1,000 with maxAccounts=30, the cap a
// 3-leg Blink fits under.
import { fetchJson, getJson, setMinGap } from "../lib/http.ts";
import { USDC } from "../curated.ts";

export type JupToken = {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  tokenProgram: string;
  tags?: string[];
  liquidity?: number;
  usdPrice?: number;
  holderCount?: number;
  mcap?: number;
  isVerified?: boolean;
  stats24h?: { buyVolume?: number; sellVolume?: number };
};

export type Quote = {
  usd: number;
  routed: boolean;
  error: string | null;
  outAmountRaw: string | null;
  priceImpactPct: number | null; // Jupiter's own number, as a percent
  impactVsSmallestPct: number | null; // 1 - rate(size)/rate($10), as a percent
  costVsRefPct?: number | null; // shortfall vs Jupiter's USD price, set at classification
  costPct?: number | null; // max of the three above, plus any transfer fee: the number the class uses
  venues: string[];
  hops: number | null;
};

export class Jupiter {
  base: string;
  headers: Record<string, string>;
  label: string;
  constructor(apiKey: string | null) {
    this.base = apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag";
    this.headers = apiKey ? { "x-api-key": apiKey } : {};
    this.label = apiKey ? "api.jup.ag (JUPITER_API_KEY)" : "lite-api.jup.ag (free, no key)";
    // Free tier: ~5 requests per rolling window. The limiter in http.ts also reads x-ratelimit-reset.
    setMinGap(new URL(this.base).host, apiKey ? 120 : 1100);
  }

  async verifiedTokens(): Promise<JupToken[]> {
    return getJson<JupToken[]>(`${this.base}/tokens/v2/tag?query=verified`, { headers: this.headers });
  }

  async search(query: string): Promise<JupToken[]> {
    const r = await getJson<JupToken[]>(`${this.base}/tokens/v2/search?query=${encodeURIComponent(query)}`, { headers: this.headers });
    return Array.isArray(r) ? r : [];
  }

  async quoteBuy(mint: string, usd: number, maxAccounts = 30): Promise<Omit<Quote, "impactVsSmallestPct">> {
    const amount = Math.round(usd * 1e6);
    const url = `${this.base}/swap/v1/quote?inputMint=${USDC}&outputMint=${mint}&amount=${amount}&slippageBps=100&maxAccounts=${maxAccounts}`;
    const r = await fetchJson<any>(url, { headers: this.headers, okStatuses: [400, 404] });
    const j = r.json;
    if (r.status !== 200 || !j || !j.outAmount || !j.routePlan?.length) {
      const err = j?.errorCode ?? j?.error ?? (r.status === 200 ? "empty route" : `HTTP ${r.status}`);
      return { usd, routed: false, error: String(err), outAmountRaw: null, priceImpactPct: null, venues: [], hops: null };
    }
    const venues = [...new Set<string>(j.routePlan.map((p: any) => p.swapInfo?.label).filter(Boolean))];
    return { usd, routed: true, error: null, outAmountRaw: String(j.outAmount), priceImpactPct: Number(j.priceImpactPct) * 100, venues, hops: j.routePlan.length };
  }

  /**
   * $100 first. If it routes, also $10 and $1,000. If not, try $10 alone.
   * Saves free-tier requests on the many tokens with no pools at all.
   */
  async ladder(mint: string, sizes = [10, 100, 1000]): Promise<Quote[]> {
    const q: Record<number, Omit<Quote, "impactVsSmallestPct">> = {};
    q[100] = await this.quoteBuy(mint, 100);
    for (const s of sizes) {
      if (s === 100) continue;
      if (q[100].routed || s < 100) q[s] = await this.quoteBuy(mint, s);
      else q[s] = { usd: s, routed: false, error: "not quoted: $100 did not route", outAmountRaw: null, priceImpactPct: null, venues: [], hops: null };
    }
    const small = sizes.map((s) => q[s]).find((x) => x.routed);
    const smallRate = small ? Number(small.outAmountRaw) / small.usd : null;
    return sizes.map((s) => {
      const x = q[s];
      const rate = x.routed ? Number(x.outAmountRaw) / x.usd : null;
      const impactVsSmallestPct = rate !== null && smallRate ? Math.max(0, (1 - rate / smallRate) * 100) : null;
      return { ...x, impactVsSmallestPct };
    });
  }
}
