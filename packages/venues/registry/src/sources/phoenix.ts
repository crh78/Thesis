// Phoenix perps: every active market from the public exchange endpoint, plus
// the live order book for depth and simulated taker-buy impact.
import { getJson, mapLimit, setMinGap } from "../lib/http.ts";
import { COMMON_SOURCES } from "../curated.ts";

type PhoenixMarket = {
  symbol: string;
  name: string;
  assetClass: string;
  classifications: string[];
  marketStatus: string;
  marketPubkey: string;
  maxLeverage: number;
  isolatedOnly: boolean;
  takerFeeBps: number;
  makerFeeBps: number;
  baseLotsDecimals: number;
  openInterestBase: number;
  openInterestUsd: number | null;
  openInterestCapBase: number;
  mid: number | null;
  spreadBps: number | null;
  depthUsdWithin1Pct: { bids: number; asks: number } | null;
  buyImpactPct: Record<"10" | "100" | "1000", number | null>;
  earningsDates: string[];
  error: string | null;
};

export type PhoenixSnapshot = { gated: boolean; features: string[]; collateralMint: string; markets: PhoenixMarket[] };

const BASE = "https://perp-api.phoenix.trade";

/** Walks the asks to fill `usd` of notional; returns % above mid of the average fill. */
function buyImpact(asks: [number, number][], mid: number, usd: number): number | null {
  let remaining = usd;
  let qty = 0;
  for (const [px, sz] of asks) {
    const notional = px * sz;
    if (notional >= remaining) {
      qty += remaining / px;
      remaining = 0;
      break;
    }
    qty += sz;
    remaining -= notional;
  }
  if (remaining > 0) return null; // book too thin
  const avg = usd / qty;
  return (avg / mid - 1) * 100;
}

/**
 * Every active market with its order-book depth: one book read per market.
 *
 * Phoenix's public API allows an address about one read every two seconds. The defaults (three
 * reads at a time, 150 ms apart) finish in seconds but trip that limit for the whole burst and a
 * while after, which is fine for a one-off registry build. A long-running reader that shares its
 * address with live trades (the asset bank on the executor VM) passes a slower pace instead.
 */
export async function loadPhoenix(pace: { minGapMs?: number; concurrency?: number } = {}): Promise<PhoenixSnapshot> {
  setMinGap("perp-api.phoenix.trade", pace.minGapMs ?? 150);
  const [ex, snap] = await Promise.all([getJson<any>(COMMON_SOURCES.phoenixExchange), getJson<any>(`${BASE}/v1/exchange/snapshot`)]);
  const features: string[] = snap?.exchange?.exchangeStatusFeatures ?? [];
  const active = (ex.markets as any[]).filter((m) => m.marketStatus === "active");
  const markets = await mapLimit(active, pace.concurrency ?? 3, async (m): Promise<PhoenixMarket> => {
    const dec = Number(m.baseLotsDecimals ?? 0);
    const oiBase = Number(m.statsSnapshot?.openInterestBaseLots ?? 0) / 10 ** dec;
    const base: PhoenixMarket = {
      symbol: m.symbol,
      name: m.metadata?.name ?? m.symbol,
      assetClass: m.metadata?.assetClass ?? "unknown",
      classifications: m.metadata?.classifications ?? [],
      marketStatus: m.marketStatus,
      marketPubkey: m.marketPubkey,
      maxLeverage: Math.max(...(m.leverageTiers ?? []).map((t: any) => Number(t.maxLeverage))),
      isolatedOnly: Boolean(m.isolatedOnly),
      takerFeeBps: Number(m.takerFee) * 1e4,
      makerFeeBps: Number(m.makerFee) * 1e4,
      baseLotsDecimals: dec,
      openInterestBase: oiBase,
      openInterestUsd: null,
      openInterestCapBase: Number(m.openInterestCapBaseLots ?? 0) / 10 ** dec,
      mid: null,
      spreadBps: null,
      depthUsdWithin1Pct: null,
      buyImpactPct: { "10": null, "100": null, "1000": null },
      earningsDates: (m.metadata?.earningsDates ?? []).map((d: string) => d.slice(0, 10)),
      error: null,
    };
    try {
      const ob = await getJson<any>(`${BASE}/v1/view/orderbook/${encodeURIComponent(m.symbol)}`);
      const bids: [number, number][] = ob.bids ?? [];
      const asks: [number, number][] = ob.asks ?? [];
      if (!bids.length || !asks.length) throw new Error("empty book");
      const mid = (bids[0][0] + asks[0][0]) / 2;
      base.mid = mid;
      base.spreadBps = ((asks[0][0] - bids[0][0]) / mid) * 1e4;
      base.openInterestUsd = oiBase * mid;
      const within = (side: [number, number][], ok: (px: number) => boolean) => side.filter(([px]) => ok(px)).reduce((a, [px, sz]) => a + px * sz, 0);
      base.depthUsdWithin1Pct = { bids: within(bids, (px) => px >= mid * 0.99), asks: within(asks, (px) => px <= mid * 1.01) };
      for (const s of [10, 100, 1000] as const) base.buyImpactPct[String(s) as "10"] = buyImpact(asks, mid, s);
    } catch (e) {
      base.error = String((e as Error).message ?? e).slice(0, 160);
    }
    return base;
  });
  return { gated: features.includes("gated"), features, collateralMint: ex.keys?.canonicalMint ?? snap?.exchange?.canonicalMint, markets };
}
