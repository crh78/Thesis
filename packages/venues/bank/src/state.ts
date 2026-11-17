// The asset bank's stored state and the pure functions over it: classification,
// per-underlying reference prices, best issuer from the latest probes, and which
// tokens are stale. No I/O here, so all of it is unit-tested with fixtures.
import type { IssuerInfo } from "../../registry/src/curated.ts";
import type { CardsSummary } from "../../registry/src/sources/cards.ts";
import type { PickedCard } from "./cards.ts";
import type { GeminiSummary } from "../../registry/src/sources/gemini.ts";
import type { GeminiContract } from "../../gemini/src/markets.ts";
import type { YieldVault } from "../../registry/src/sources/yield.ts";
import { underlyingIdHex, parseUnderlyingKey, type UnderlyingClass } from "./identity.ts";
import { underlyingUnits, type RatioInfo, type ScaledUi, type UsPersons } from "./ratios.ts";

export const BANK_VERSION = 1;

export type ProbeQuote = {
  usd: number;
  routed: boolean;
  outAmountRaw: string | null;
  /** Jupiter's priceImpactPct, as a percent. */
  priceImpactPct: number | null;
  hops: number | null;
  venues: string[];
  error: string | null;
};

type TokenClass = "tradeable" | "thin" | "no-route" | "unprobed" | "paused" | "excluded";

export type TokenEntry = {
  mint: string;
  symbol: string;
  name: string;
  issuer: string;
  issuerTag: string | null;
  category: IssuerInfo["category"];
  underlying: string;
  decimals: number;
  program: "spl-token" | "token-2022" | "unknown";
  transferFeeBps: number | null;
  paused: boolean;
  /** New token accounts start frozen: an issuer allowlist. Never routed to. */
  defaultFrozen: boolean;
  permanentDelegate: boolean;
  scaledUi: ScaledUi | null;
  ratio: RatioInfo;
  usPersons: UsPersons;
  jupiterPooledUsd: number | null;
  holders: number | null;
  pythFeedId: string | null;
  discoveredAt: string;
  /** Last discovery that listed this token. Tokens missing from discovery for a day are dropped. */
  seenAt: string;
  mintReadAt: string | null;
  /** Jupiter Price v3: usd per UI token, and stockData.price (the underlying's own price) when Jupiter has it. */
  price: { usd: number; underlyingUsd: number | null; at: string } | null;
  probe: { at: string; maxAccounts: number; quotes: ProbeQuote[] } | null;
  liquidity: {
    class: TokenClass;
    reason: string;
    cost100Pct: number | null;
    cost1000Pct: number | null;
    /** Underlying units per USD at the $100 probe, net of transfer fee. Null if not comparable or not routed. */
    unitsPerUsd100: number | null;
    /** (USD paid / underlying received) / reference price - 1, at $100, as a percent. */
    premium100Pct: number | null;
    /** True when the quote looks too good against the reference: the ratio is probably wrong. */
    ratioSuspect: boolean;
  };
};

export type PerpMarket = {
  symbol: string;
  name: string;
  marketPubkey: string;
  underlying: string;
  unitsPerContract: number;
  maxLeverage: number;
  takerFeeBps: number;
  mid: number | null;
  spreadBps: number | null;
  depthUsdWithin1Pct: { bids: number; asks: number } | null;
  buyImpact1000Pct: number | null;
  tradeable: boolean;
};

export type UnderlyingEntry = {
  key: string;
  idHex: string;
  cls: UnderlyingClass;
  code: string;
  name: string;
  themes: string[];
  mints: string[];
  perps: string[];
  pythFeedId: string | null;
  refPriceUsd: number | null;
  refPriceSource: string | null;
  refPriceAt: string | null;
};

type TierStatus = { lastStartAt: string | null; lastOkAt: string | null; lastError: string | null; lastDurationMs: number | null; runs: number; requests: number };

export type BankState = {
  version: number;
  createdAt: string;
  updatedAt: string;
  tokens: Record<string, TokenEntry>;
  underlyings: Record<string, UnderlyingEntry>;
  venues: {
    phoenix: { at: string; gated: boolean; markets: PerpMarket[] } | null;
    /** `contracts`: every contract seen, by instrument symbol; expired ones are kept a week. */
    gemini: { at: string; summary: GeminiSummary; contracts?: Record<string, GeminiContract> } | null;
    /**
     * `summary`: the listings scan (null when it failed). `picked`: cards baskets have picked, by
     * their leg id (hex), with their last insured value (cards.ts), so card legs can be priced.
     */
    cards: { at: string; summary: CardsSummary | null; picked?: Record<string, PickedCard> } | null;
    yield: { at: string; vaults: YieldVault[] } | null;
  };
  tiers: Record<string, TierStatus>;
};

export function emptyState(now = new Date()): BankState {
  const t = now.toISOString();
  return { version: BANK_VERSION, createdAt: t, updatedAt: t, tokens: {}, underlyings: {}, venues: { phoenix: null, gemini: null, cards: null, yield: null }, tiers: {} };
}

export function newUnderlying(key: string, name: string, themes: string[]): UnderlyingEntry {
  const { cls, code } = parseUnderlyingKey(key);
  return { key, idHex: underlyingIdHex(key), cls, code, name, themes, mints: [], perps: [], pythFeedId: null, refPriceUsd: null, refPriceSource: null, refPriceAt: null };
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
export const ageMs = (iso: string | null | undefined, nowMs: number) => {
  const t = ms(iso);
  return Number.isFinite(t) ? nowMs - t : Infinity;
};

function median(xs: number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Reference price of one underlying unit, used to judge each issuer's quote:
 *   1. Jupiter's stockData.price (the share price Jupiter reports alongside issuer tokens), median across tokens
 *   2. else the median of comparable tokens' implied prices (usdPrice / underlyingPerUiToken), plus Phoenix perp mids
 */
export function referencePrice(state: BankState, u: UnderlyingEntry, nowMs: number, maxAgeMs: number): { usd: number; source: string } | null {
  const tokens = u.mints.map((m) => state.tokens[m]).filter((t): t is TokenEntry => Boolean(t?.price) && ageMs(t.price!.at, nowMs) <= maxAgeMs);
  const stock = median(tokens.map((t) => t.price!.underlyingUsd ?? NaN));
  if (stock) return { usd: stock, source: "jupiter stockData.price" };
  const implied = tokens.filter((t) => t.ratio.comparable && (t.jupiterPooledUsd ?? 0) >= 1000).map((t) => t.price!.usd / (t.ratio.underlyingPerUiToken ?? NaN));
  const phx = state.venues.phoenix && ageMs(state.venues.phoenix.at, nowMs) <= maxAgeMs ? state.venues.phoenix.markets.filter((m) => m.underlying === u.key && m.mid).map((m) => m.mid! / m.unitsPerContract) : [];
  const med = median([...implied, ...phx]);
  return med ? { usd: med, source: phx.length ? "median of issuer prices and Phoenix mid" : "median of issuer prices" } : null;
}

export type ClassifyOpts = { nowSec: number; tradeableCostPct: number; maxDeviationPct: number };

/** Classifies one token from its latest probe. Cost = max(Jupiter price impact, premium over the reference) + transfer fee. */
export function classifyToken(t: TokenEntry, refUsd: number | null, o: ClassifyOpts): TokenEntry["liquidity"] {
  const out: TokenEntry["liquidity"] = { class: "unprobed", reason: "", cost100Pct: null, cost1000Pct: null, unitsPerUsd100: null, premium100Pct: null, ratioSuspect: false };
  if (t.defaultFrozen) return { ...out, class: "excluded", reason: "permissioned: default-frozen token accounts" };
  if (t.paused) return { ...out, class: "paused", reason: "mint is paused" };
  if (!t.probe) return { ...out, reason: "not probed yet" };
  const fee = (t.transferFeeBps ?? 0) / 100;
  const costOf = (q: ProbeQuote | undefined) => {
    if (!q?.routed || !q.outAmountRaw) return { cost: null, units: null, premium: null };
    let premium: number | null = null;
    let units: number | null = null;
    if (t.ratio.comparable) {
      units = underlyingUnits(q.outAmountRaw, { decimals: t.decimals, scaledUi: t.scaledUi, underlyingPerUiToken: t.ratio.underlyingPerUiToken, transferFeeBps: t.transferFeeBps }, o.nowSec);
      if (refUsd && units > 0) premium = (q.usd / units / refUsd - 1) * 100;
    } else if (t.price?.usd) {
      // No ratio: judge against the token's own Jupiter price instead.
      const ui = underlyingUnits(q.outAmountRaw, { decimals: t.decimals, scaledUi: t.scaledUi, underlyingPerUiToken: 1, transferFeeBps: t.transferFeeBps }, o.nowSec);
      if (ui > 0) premium = (q.usd / ui / t.price.usd - 1) * 100;
    }
    // premium already nets out the transfer fee (underlyingUnits subtracts it); price impact does not.
    const impact = (q.priceImpactPct ?? 0) + fee;
    const cost = premium !== null ? Math.max(impact, premium) : impact;
    return { cost, units, premium };
  };
  const q100 = t.probe.quotes.find((q) => q.usd === 100);
  const q1000 = t.probe.quotes.find((q) => q.usd === 1000);
  const c100 = costOf(q100);
  const c1000 = costOf(q1000);
  out.cost100Pct = c100.cost;
  out.cost1000Pct = c1000.cost;
  out.premium100Pct = c100.premium;
  out.unitsPerUsd100 = c100.units !== null && q100 ? c100.units / q100.usd : null;
  if (t.ratio.comparable && c100.premium !== null && c100.premium < -o.maxDeviationPct) {
    out.ratioSuspect = true;
    return { ...out, class: "thin", reason: `$100 buys ${(-c100.premium).toFixed(1)}% more than the reference price allows: units-per-token ratio is suspect` };
  }
  if (c100.cost === null) return { ...out, class: "no-route", reason: `no $100 route at maxAccounts=${t.probe.maxAccounts}${q100?.error ? ` (${q100.error})` : ""}` };
  if (c100.cost < o.tradeableCostPct) return { ...out, class: "tradeable", reason: `$100 buy costs ${c100.cost.toFixed(2)}%` };
  return { ...out, class: "thin", reason: `$100 buy costs ${c100.cost.toFixed(2)}%` };
}

/** Re-derives reference prices and token classes for every underlying. Returns the keys that changed. */
export function reclassify(state: BankState, nowMs: number, o: { tradeableCostPct: number; maxDeviationPct: number; refMaxAgeMs: number }): Set<string> {
  const changed = new Set<string>();
  for (const u of Object.values(state.underlyings)) {
    const ref = referencePrice(state, u, nowMs, o.refMaxAgeMs);
    if (ref?.usd !== u.refPriceUsd) changed.add(u.key);
    u.refPriceUsd = ref?.usd ?? null;
    u.refPriceSource = ref?.source ?? null;
    u.refPriceAt = ref ? new Date(nowMs).toISOString() : u.refPriceAt;
    for (const m of u.mints) {
      const t = state.tokens[m];
      if (!t) continue;
      const before = JSON.stringify(t.liquidity);
      t.liquidity = classifyToken(t, u.refPriceUsd, { nowSec: Math.floor(nowMs / 1000), tradeableCostPct: o.tradeableCostPct, maxDeviationPct: o.maxDeviationPct });
      if (JSON.stringify(t.liquidity) !== before) changed.add(u.key);
    }
  }
  return changed;
}

export type Freshness = { maxProbeAgeMs: number; maxPriceAgeMs: number };

/** Tradeable and recently measured: the only tokens the AI may pick from. */
export function isFreshTradeable(t: TokenEntry, nowMs: number, f: Freshness): boolean {
  return t.liquidity.class === "tradeable" && ageMs(t.probe?.at, nowMs) <= f.maxProbeAgeMs && ageMs(t.price?.at, nowMs) <= f.maxPriceAgeMs;
}

/**
 * Best issuer from the latest probes (a bank-time estimate; bestIssuer() re-quotes at trade time).
 * Comparable tokens win on underlying units per dollar at $100; a non-comparable token is
 * returned only when it is the sole fresh tradeable issuer.
 */
export function bankBestIssuer(state: BankState, u: UnderlyingEntry, nowMs: number, f: Freshness): TokenEntry | null {
  const fresh = u.mints.map((m) => state.tokens[m]).filter((t): t is TokenEntry => Boolean(t) && isFreshTradeable(t, nowMs, f) && !t.liquidity.ratioSuspect);
  const comparable = fresh.filter((t) => t.ratio.comparable && t.liquidity.unitsPerUsd100 !== null);
  if (comparable.length) return comparable.sort((a, b) => b.liquidity.unitsPerUsd100! - a.liquidity.unitsPerUsd100! || (a.liquidity.cost1000Pct ?? 99) - (b.liquidity.cost1000Pct ?? 99) || (a.mint < b.mint ? -1 : 1))[0];
  return fresh.length === 1 ? fresh[0] : null;
}

/** Tokens worth spending Jupiter requests on: routable before, or with at least `floorUsd` pooled. */
export function isProbeCandidate(t: TokenEntry, floorUsd: number): boolean {
  if (t.defaultFrozen || t.paused) return false;
  const routedBefore = Boolean(t.probe?.quotes.some((q) => q.routed));
  return routedBefore || (t.jupiterPooledUsd ?? 0) >= floorUsd;
}

/**
 * Picks up to `limit` stale tokens, never-probed first, then oldest first.
 * A token whose last $100 probe routed is stale after `ttlMs`; one that did not route
 * only after `unroutedTtlMs` (an hour by default), so dead pools cost little.
 */
export function selectStale(tokens: TokenEntry[], nowMs: number, o: { ttlMs: number; unroutedTtlMs: number; limit: number }): TokenEntry[] {
  const due = tokens.filter((t) => {
    if (!t.probe) return true;
    const routed = t.probe.quotes.some((q) => q.usd === 100 && q.routed);
    return ageMs(t.probe.at, nowMs) >= (routed ? o.ttlMs : o.unroutedTtlMs);
  });
  due.sort((a, b) => (ms(a.probe?.at) || 0) - (ms(b.probe?.at) || 0) || (b.jupiterPooledUsd ?? 0) - (a.jupiterPooledUsd ?? 0));
  return due.slice(0, Math.max(0, o.limit));
}
