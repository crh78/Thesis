// Builds the take builder's securities catalog from the liquidity registry.
//
//   node packages/take-builder/src/catalog.ts
//
// Reads packages/venues/registry/assets.json, keeps what could actually go in
// a basket, and writes packages/take-builder/catalog.json (one row per
// security, the shape of public.securities minus description/embedding).
// `index.ts` then sends it to the `securities-index` function, which writes
// descriptions, embeds and upserts. No dependencies (Node 24 runs this as is).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const registryPath = join(here, "../../venues/registry/assets.json");
const outPath = join(here, "../catalog.json");

type Liquidity = "tradeable" | "thin" | "n/a";
type US = "yes" | "no" | "unknown";
export type CatalogRow = {
  id: string;
  kind: "stock" | "etf" | "commodity" | "pre-ipo" | "leveraged" | "yield" | "perp" | "prediction" | "card" | "other";
  symbol: string;
  name: string;
  underlying: string | null;
  issuer: string | null;
  venue: string;
  mint: string | null;
  themes: string[];
  liquidity: Liquidity;
  us_persons: US;
  can_short: boolean;
  expires_at: string | null;
  data: Record<string, unknown>;
};

// deno-lint-ignore no-explicit-any
const reg: any = JSON.parse(readFileSync(registryPath, "utf8"));
const rows: CatalogRow[] = [];

// Issuers whose tokens US persons can't hold (registry `issuers[].restrictions`).
const US_BLOCKED_ISSUERS = new Set(["xstocks", "ondo"]);
const ETF_HINT = /\b(ETF|Trust|Index|S&P|Nasdaq)\b/i;

// --- Spot tokens on Jupiter: one row per underlying, best issuer ------------
const spotKind = (category: string, name: string): CatalogRow["kind"] => {
  if (category === "stock") return ETF_HINT.test(name) ? "etf" : "stock";
  if (category === "yield-token") return "yield";
  if (category === "pre-ipo" || category === "leveraged" || category === "commodity") return category;
  return "other";
};
const phoenixSymbols = new Set<string>(
  // deno-lint-ignore no-explicit-any
  (reg.phoenix?.markets ?? []).filter((m: any) => m.class === "tradeable" || m.class === "thin").map((m: any) => m.symbol),
);

// deno-lint-ignore no-explicit-any
const live = (reg.spot as any[]).filter((s) => s.liquidity?.class === "tradeable" || s.liquidity?.class === "thin");
// deno-lint-ignore no-explicit-any
const best = new Map<string, any>();
for (const s of live) {
  const key = s.underlying ?? s.symbol;
  const cur = best.get(key);
  const rank = (x: typeof s) => (x.liquidity.class === "tradeable" ? 0 : 1) * 1000 + (x.liquidity.buyCost1000Pct ?? 999);
  if (!cur || rank(s) < rank(cur)) best.set(key, s);
}
for (const s of best.values()) {
  rows.push({
    id: s.id,
    kind: spotKind(s.category, s.name),
    symbol: s.symbol,
    name: s.name,
    underlying: s.underlying ?? null,
    issuer: s.issuer ?? null,
    venue: s.venue ?? "Jupiter",
    mint: s.mint ?? null,
    themes: s.themes ?? [],
    liquidity: s.liquidity.class,
    us_persons: US_BLOCKED_ISSUERS.has(s.issuerTag) ? "no" : "unknown",
    can_short: s.underlying ? phoenixSymbols.has(s.underlying) : false,
    expires_at: null,
    data: {
      issuerTag: s.issuerTag ?? null,
      buyCost100Pct: s.liquidity.buyCost100Pct ?? null,
      buyCost1000Pct: s.liquidity.buyCost1000Pct ?? null,
      volume24hUsd: s.liquidity.volume24hUsd ?? null,
      pyth: s.pyth?.token?.symbol ?? null,
    },
  });
}

// --- Phoenix perps (leverage and shorts; closed to US persons) ---------------
for (const m of reg.phoenix?.markets ?? []) {
  if (m.class !== "tradeable" && m.class !== "thin") continue;
  rows.push({
    id: `phoenix:${m.symbol}`,
    kind: "perp",
    symbol: m.symbol,
    name: `${m.name} perp`,
    underlying: m.symbol,
    issuer: null,
    venue: "Phoenix",
    mint: null,
    themes: [m.assetClass].filter(Boolean),
    liquidity: m.class,
    us_persons: "no",
    can_short: true,
    expires_at: null,
    data: { maxLeverage: m.maxLeverage, openInterestUsd: m.openInterestUsd, depthUsdWithin1Pct: m.depthUsdWithin1Pct, assetClass: m.assetClass },
  });
}

// --- Gemini prediction contracts: indexed on their own by index-gemini.ts (they change daily) --

// --- USDC yield vaults (low-risk legs, idle cash) ---------------------------
for (const v of reg.usdcYield?.vaults ?? []) {
  rows.push({
    id: `yield:${v.address}`,
    kind: "yield",
    symbol: "USDC",
    name: `${v.name} (${v.venue})`,
    underlying: "USDC",
    issuer: null,
    venue: v.venue,
    mint: v.shareMint ?? null,
    themes: ["Cash yield"],
    liquidity: "tradeable",
    us_persons: "unknown",
    can_short: false,
    expires_at: null,
    data: { apyPct: v.apyPct, tvlUsd: v.tvlUsd, program: v.program },
  });
}

// --- Tokenized trading cards, by category (Collector Crypt) -----------------
for (const c of reg.cards?.categories ?? []) {
  rows.push({
    id: `cards:${c.category}`,
    kind: "card",
    symbol: c.category,
    name: `${c.category} trading cards`,
    underlying: null,
    issuer: null,
    venue: "Collector Crypt",
    mint: null,
    themes: ["Collectibles", c.category],
    liquidity: (c.listed ?? 0) >= 100 ? "tradeable" : "thin",
    us_persons: "unknown",
    can_short: false,
    expires_at: null,
    data: { listed: c.listed, medianUsd: c.medianUsd, p90Usd: c.p90Usd },
  });
}

// No build timestamp: the rows are the data, and a date would only go stale.
writeFileSync(outPath, JSON.stringify({ rows }, null, 1) + "\n");
const byKind = rows.reduce<Record<string, number>>((a, r) => ((a[r.kind] = (a[r.kind] ?? 0) + 1), a), {});
console.log(`wrote ${rows.length} rows to ${outPath}`, byKind);
