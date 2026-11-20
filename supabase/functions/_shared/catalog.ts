// The securities catalog as the app shows it: display names, kind labels, who can buy what,
// live prices (Jupiter Price API) and price history (GeckoTerminal), both free and keyless.
// Used by `assets` (search + asset pages) and `take-builder` (adding a pick by name).

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type Security = {
  id: string; kind: string; symbol: string; name: string; underlying: string | null; issuer: string | null;
  venue: string; mint?: string | null; themes: string[]; description: string | null; liquidity: string;
  us_persons: string; can_short: boolean; expires_at: string | null; data: Record<string, unknown>;
  similarity?: number; score?: number;
};

export const SECURITY_COLUMNS =
  "id, kind, symbol, name, underlying, issuer, venue, mint, themes, description, liquidity, us_persons, can_short, expires_at, data";

/** Kinds a basket can hold (cards and "other" can't be bought from the app yet). */
export const BASKET_KINDS = new Set(["stock", "etf", "commodity", "pre-ipo", "leveraged", "yield", "perp", "prediction"]);

/** One company / market, whichever issuer: NVDAx, NVDAon and the NVIDIA perp share "NVDA". */
export const assetKey = (s: Pick<Security, "underlying" | "symbol" | "kind" | "id">) =>
  s.kind === "prediction" || s.kind === "yield" ? s.id : (s.underlying ?? s.symbol);

/** "NVIDIA xStock" → "NVIDIA"; same rules as BuiltLegDTO.displayName in the iOS app. */
export function displayName(raw: string): string {
  return raw
    .replace(/\s+-\s+Backpack Securities$/, "")
    .replace(/,?\s+(Inc\.|Corporation|Corp\.|N\.V\.|Limited|Ltd\.)(\s+Common Stock)?$/, "")
    .replace(/\s+(PreStocks|Common Stock)$/, "")
    .replace(/\s+(xStock|Tokenized Stock|Tokenized|rStock)\b.*$/, "")
    .replace(/\s*\((Ondo|Backpack|Tokenized)[^)]*\)$/, "")
    .trim();
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case "etf": return "ETF";
    case "commodity": return "Commodity";
    case "pre-ipo": return "Pre-IPO";
    case "leveraged": case "perp": return "Stock · 2x";
    case "yield": return "Earns interest";
    case "prediction": return "Prediction";
    case "card": return "Card";
    default: return "Stock";
  }
}

/**
 * US restrictions are off for now: everyone gets the whole catalog, whatever
 * country their account says. `US_RESTRICTIONS=on` turns them back on; then an unknown country
 * counts as the US (the stricter choice).
 */
export const US_RESTRICTIONS = Deno.env.get("US_RESTRICTIONS") === "on";

/** Whether to treat an account in this country as a US person (never, while restrictions are off). */
export const treatAsUS = (country: string | null | undefined) => US_RESTRICTIONS && (country ?? "US") === "US";

/** Whether someone where they live can buy it ('unknown' counts as yes, as in the take builder). */
export const available = (s: Pick<Security, "us_persons">, usPerson: boolean) => !(usPerson && s.us_persons === "no");

export const unavailableNote = "Not available in the US yet";

/** The card the app shows in search results and the add-a-pick picker. */
export function assetSummary(s: Security, usPerson: boolean, price?: Price | null) {
  return {
    id: s.id,
    key: assetKey(s),
    symbol: s.underlying && s.kind !== "perp" ? s.underlying : s.symbol,
    name: s.kind === "yield" ? "Cash" : displayName(s.name),
    full_name: s.name,
    kind: s.kind,
    kind_label: kindLabel(s.kind),
    venue: s.venue,
    about: firstSentence(s.description) ?? null,
    themes: s.themes ?? [],
    can_short: s.can_short,
    apy_pct: num(s.data?.apyPct),
    max_leverage: num(s.data?.maxLeverage),
    expires_at: s.expires_at,
    available: available(s, usPerson),
    price_usd: price?.usd ?? null,
    change_24h_pct: price?.change24hPct ?? null,
    // "stock" when the token's own price wasn't usable (see displayPrice); the app can ignore it.
    price_source: price?.source ?? null,
    price_note: price?.note ?? null,
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// --- Live yield (Jupiter Lend) -------------------------------------------------------------------

const LEND_TTL_MS = 15 * 60_000;
let lendCache: { at: number; rates: Map<string, number> } | null = null;

/** Jupiter Lend vaults' live APY in percent (totalRate, basis points), by share mint; cached 15 min. */
export async function lendApys(): Promise<Map<string, number>> {
  if (lendCache && Date.now() - lendCache.at < LEND_TTL_MS) return lendCache.rates;
  try {
    const res = await fetch("https://lite-api.jup.ag/lend/v1/earn/tokens", { signal: AbortSignal.timeout(2500) });
    const list = res.ok ? (await res.json() as { address?: string; totalRate?: string | number }[]) : [];
    const rates = new Map<string, number>();
    for (const t of list) {
      const bps = Number(t.totalRate);
      if (t.address && Number.isFinite(bps)) rates.set(t.address, bps / 100);
    }
    if (rates.size) lendCache = { at: Date.now(), rates };
    return rates;
  } catch (e) {
    console.error("jupiter lend rates failed:", (e as Error).message);
    return lendCache?.rates ?? new Map();
  }
}

/**
 * Yield rows traded as Jupiter Lend deposits get the vault's live APY in `data.apyPct` (in place):
 * the catalog's is a snapshot from when it was built (5.65% vs 3.80% live in one check). Every
 * yield pick is a jlUSDC deposit (scripts/fork/api/legs.ts), so this is the rate it earns.
 */
export async function withLiveApy<T extends Pick<Security, "id" | "kind" | "venue" | "mint" | "data">>(rows: T[]): Promise<T[]> {
  if (!rows.some((s) => s.kind === "yield" && s.venue === "Jupiter Lend Earn")) return rows;
  const rates = await lendApys();
  for (const s of rows) {
    if (s.kind !== "yield" || s.venue !== "Jupiter Lend Earn") continue;
    const apy = rates.get(s.mint ?? s.id.replace(/^yield:/, ""));
    if (apy !== undefined) s.data = { ...(s.data ?? {}), apyPct: apy, apySource: "jupiter-lend-live" };
  }
  return rows;
}
export const firstSentence = (d: string | null | undefined) => d?.split(/(?<=\.)\s/)[0];

// --- Live prices (Jupiter Price API v3) ---------------------------------------------------------

/**
 * `source`: "token" (the token's own price) or "stock" (the token's pool is under the tradeable
 * floor, so its last trade isn't a price and the stock's price stands in). `note` says why, for
 * the app to show or ignore.
 */
export type Price = { usd: number; change24hPct: number | null; source?: "token" | "stock"; note?: string | null };

/**
 * Below this much pooled, a token's last trade isn't a price (XLEx: $113 pooled, 40% off its
 * stock). Same as the router's and settler's floor (PRICEABLE_MIN_POOLED_USD in
 * packages/venues/bank/src/route.ts). No band against the stock: a token with
 * this much pooled trades close to it, and real after-hours moves aren't errors.
 */
export const MIN_POOLED_USD = 25_000;

type JupPrice = { usdPrice?: number; priceChange24h?: number; liquidity?: number; stockData?: { price?: number } | null; scaledUiConfig?: unknown };

/** The price to show for one Jupiter v3 entry (pure: unit-tested in catalog_test.ts). */
export function displayPrice(p: JupPrice | null | undefined): Price | null {
  if (!p || typeof p.usdPrice !== "number" || !(p.usdPrice > 0)) return null;
  const token: Price = { usd: p.usdPrice, change24hPct: num(p.priceChange24h), source: "token", note: null };
  const stock = num(p.stockData?.price);
  const liquidity = num(p.liquidity);
  const thin = liquidity !== null && liquidity < MIN_POOLED_USD;
  if (!thin) return token;
  const why = `the token's pool holds only $${Math.round(liquidity!).toLocaleString("en-US")}`;
  // The token's own 24h change is as unreliable as its price: none rather than a wrong one.
  if (stock && stock > 0) return { usd: stock, change24hPct: null, source: "stock", note: `${why}, so this is the stock's price` };
  return { ...token, note: `thin market: ${why}` };
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const priceCache = new Map<string, { at: number; price: Price | null }>();
/** Each mint's ScaledUiAmount config as Jupiter last reported it (null: none), for chart(). */
const scaledUiCache = new Map<string, ScaledUiConfig | null>();
const PRICE_TTL_MS = 60_000;

/** Prices by mint, at most 50 per call, cached for a minute per worker. Missing = no price. */
export async function prices(mints: string[]): Promise<Map<string, Price>> {
  const out = new Map<string, Price>();
  const now = Date.now();
  const need: string[] = [];
  for (const m of new Set(mints)) {
    const hit = priceCache.get(m);
    if (hit && now - hit.at < PRICE_TTL_MS) {
      if (hit.price) out.set(m, hit.price);
    } else need.push(m);
  }
  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50);
    try {
      const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${batch.join(",")}`, { signal: AbortSignal.timeout(2500) });
      const body = res.ok ? await res.json() as Record<string, JupPrice | null> : {};
      for (const m of batch) {
        const price = displayPrice(body[m]);
        if (body[m]) scaledUiCache.set(m, parseScaledUi((body[m] as { scaledUiConfig?: unknown }).scaledUiConfig));
        priceCache.set(m, { at: now, price });
        if (price) out.set(m, price);
      }
    } catch (e) {
      console.error("jupiter price failed:", (e as Error).message);
    }
  }
  return out;
}

/**
 * The token whose price stands for an asset: its own mint; for a perp, a spot token of the same
 * underlying (SOL → wrapped SOL). Null when there's no price to show (prediction markets).
 */
export async function priceMint(db: SupabaseClient, s: Security): Promise<string | null> {
  if (s.mint) return s.mint;
  if (s.kind !== "perp" || !s.underlying) return null;
  if (s.underlying === "SOL") return SOL_MINT;
  const { data } = await db.from("securities").select("mint")
    .eq("underlying", s.underlying).not("mint", "is", null).in("kind", ["stock", "etf", "commodity"])
    .eq("liquidity", "tradeable").limit(1).maybeSingle();
  return (data?.mint as string | undefined) ?? null;
}

// --- Price history (GeckoTerminal, cached in public.asset_charts) --------------------------------

export type Range = "1D" | "1W" | "1M" | "1Y";
export const RANGES: Range[] = ["1D", "1W", "1M", "1Y"];

const RANGE_QUERY: Record<Range, { timeframe: string; aggregate: number; limit: number; ttlMs: number }> = {
  "1D": { timeframe: "minute", aggregate: 15, limit: 96, ttlMs: 5 * 60_000 },
  "1W": { timeframe: "hour", aggregate: 4, limit: 42, ttlMs: 30 * 60_000 },
  "1M": { timeframe: "hour", aggregate: 12, limit: 62, ttlMs: 3 * 3600_000 },
  "1Y": { timeframe: "day", aggregate: 1, limit: 365, ttlMs: 12 * 3600_000 },
};

// GeckoTerminal's keyless API limits by IP, and edge functions share outbound IPs with other
// projects, so it's often rate limited from here. A free CoinGecko demo key
// (COINGECKO_API_KEY) gets the same on-chain data with its own limit.
const CG_KEY = Deno.env.get("COINGECKO_API_KEY") ?? "";
const GECKO = CG_KEY
  ? "https://api.coingecko.com/api/v3/onchain/networks/solana"
  : "https://api.geckoterminal.com/api/v2/networks/solana";
const POOL_TTL_MS = 7 * 86_400_000;

async function gecko(path: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (CG_KEY) headers["x-cg-demo-api-key"] = CG_KEY;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${GECKO}${path}`, { headers, signal: AbortSignal.timeout(4000) });
    if (res.ok) return await res.json();
    if (res.status !== 429 || attempt >= 1) throw new Error(`geckoterminal ${res.status}`);
    await new Promise((r) => setTimeout(r, 1200));
  }
}

/**
 * The pool a token's history is read from: the most traded one, preferring a USDC pair (reserve
 * sizes are easy to fake, volume less so). Cached a week; null = no pool with history.
 */
async function poolFor(db: SupabaseClient, mint: string): Promise<string | null> {
  const { data: cached } = await db.from("asset_pools").select("pool, checked_at").eq("mint", mint).maybeSingle();
  if (cached && Date.now() - Date.parse(cached.checked_at as string) < POOL_TTL_MS) return cached.pool as string | null;
  const body = await gecko(`/tokens/${mint}/pools?page=1`) as
    { data?: { attributes: { address: string; name: string; volume_usd?: { h24?: string } } }[] };
  const pools = (body.data ?? []).map((p) => ({
    address: p.attributes.address,
    rank: (Number(p.attributes.volume_usd?.h24) || 0) * (/\bUSDC\b/.test(p.attributes.name) ? 3 : 1),
  }));
  const pool = pools.sort((a, b) => b.rank - a.rank)[0]?.address ?? null;
  await db.from("asset_pools").upsert({ mint, pool, checked_at: new Date().toISOString() });
  return pool;
}

/** [[unix seconds, usd]] oldest first, or null when there's no history to show. */
/**
 * The chart in the shown price's terms. GeckoTerminal's candles are per RAW token, while Jupiter's
 * usdPrice (what the page shows) is per UI token: for an xStock or Ondo token the two differ by the
 * Token-2022 ScaledUiAmount multiplier (10x for a 10:1 token, ~1-3% for reinvested dividends). Each
 * point is divided by the multiplier in force at its time. Cached points stay raw (as they always
 * were), so old cache rows are scaled the same way and need no backfill. Only the current and the
 * next scheduled multiplier are known: points from before an earlier change are off by that change
 * (a dividend's ~1%), never by a split's 10x unless the split itself predates the chart.
 */
export async function chart(db: SupabaseClient, assetId: string, mint: string, range: Range): Promise<[number, number][] | null> {
  const [raw] = await Promise.all([rawChart(db, assetId, mint, range), prices([mint])]);
  return raw ? scaleChart(raw, scaledUiCache.get(mint) ?? null) : null;
}

export type ScaledUiConfig = { multiplier: number; newMultiplier: number; newMultiplierEffectiveAt: number };

/** Jupiter v3's `scaledUiConfig` (ISO time) as numbers (seconds), or null. */
export function parseScaledUi(cfg: unknown): ScaledUiConfig | null {
  const c = cfg as { multiplier?: unknown; newMultiplier?: unknown; newMultiplierEffectiveAt?: unknown } | null;
  const m = Number(c?.multiplier);
  if (!c || !(m > 0)) return null;
  const next = Number(c.newMultiplier ?? m);
  const at = typeof c.newMultiplierEffectiveAt === "string" ? Date.parse(c.newMultiplierEffectiveAt) / 1000 : Number(c.newMultiplierEffectiveAt ?? 0);
  return { multiplier: m, newMultiplier: next > 0 ? next : m, newMultiplierEffectiveAt: Number.isFinite(at) ? at : 0 };
}

/** Raw-token points → UI-token points (pure). Timestamps in seconds (or ms, told apart by size). */
export function scaleChart(points: [number, number][], cfg: ScaledUiConfig | null): [number, number][] {
  if (!cfg) return points;
  return points.map(([t, p]) => {
    const sec = t > 1e12 ? t / 1000 : t;
    const m = cfg.newMultiplierEffectiveAt > 0 && sec >= cfg.newMultiplierEffectiveAt ? cfg.newMultiplier : cfg.multiplier;
    return [t, m > 0 ? p / m : p];
  });
}

async function rawChart(db: SupabaseClient, assetId: string, mint: string, range: Range): Promise<[number, number][] | null> {
  const q = RANGE_QUERY[range];
  const { data: cached } = await db.from("asset_charts").select("points, fetched_at")
    .eq("asset_id", assetId).eq("range", range).maybeSingle();
  if (cached && Date.now() - Date.parse(cached.fetched_at as string) < q.ttlMs) return cached.points as [number, number][];
  try {
    const pool = await poolFor(db, mint);
    if (!pool) return null;
    const body = await gecko(`/pools/${pool}/ohlcv/${q.timeframe}?aggregate=${q.aggregate}&limit=${q.limit}&currency=usd&token=${mint}`) as
      { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const points = (body.data?.attributes?.ohlcv_list ?? [])
      .map((c) => [c[0], c[4]] as [number, number])
      .filter(([t, p]) => Number.isFinite(t) && Number.isFinite(p) && p > 0)
      .sort((a, b) => a[0] - b[0]);
    if (points.length < 2) return cached ? cached.points as [number, number][] : null;
    await db.from("asset_charts").upsert({ asset_id: assetId, range, points, fetched_at: new Date().toISOString() });
    return points;
  } catch (e) {
    // Rate limited or down: an old chart beats none.
    console.error("chart failed:", (e as Error).message);
    return cached ? cached.points as [number, number][] : null;
  }
}

// --- Text search ------------------------------------------------------------------------------

/** Ticker / name / theme matches (public.search_securities), best first, one per company. */
export async function textSearch(db: SupabaseClient, query: string, usPerson: boolean, limit = 20): Promise<Security[]> {
  const { data, error } = await db.rpc("search_securities", { p_query: query, p_us_person: usPerson, p_limit: limit });
  if (error) {
    console.error("search_securities failed:", error.message);
    return [];
  }
  return (data ?? []) as Security[];
}
