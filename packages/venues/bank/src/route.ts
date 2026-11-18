// Best issuer at trade time: quote every eligible issuer token of an underlying
// in parallel and buy the one that delivers the most underlying per dollar.
//
//   units per $ = outAmount / 10^decimals * ScaledUiAmount multiplier * underlying per UI token
//                 * (1 - Token-2022 transfer fee) / USD in
//
// outAmount already reflects price impact and pool fees (Jupiter quotes net of
// both; Thesis sets no platform fee). The multiplier is re-read from chain when an
// RPC is available (at most once a minute per mint), so a dividend or split since the last
// discovery is counted.
//
// Skipped, with a reason in `skipped`:
//   - default-frozen (permissioned) or paused mints
//   - with excludeUs: issuers that exclude US persons (usPersons "no"); "unverified" stays, with a warning
//   - a fresh probe found no $100 route at this maxAccounts
//   - not comparable (units per token unknown), unless it is the only candidate left
//   - quotes that beat the reference price by more than maxDeviationPct: the ratio is probably wrong
//
// Tie-breaks: candidates within `tieBps` (default 1 bp) of the best units per $ are
// ordered by, in turn:
//   1. lower Jupiter price impact (more depth behind the quote, so less slippage if price moves)
//   2. fewer route hops (fewer accounts: easier to fit a 3-leg Blink)
//   3. no permanent delegate on the mint (the issuer cannot move holders' tokens)
//   4. more pooled liquidity in Jupiter's token list
//   5. mint address, ascending (deterministic)
import { Rpc } from "../../registry/src/lib/solana.ts";
import { loadEnv } from "../../registry/src/lib/env.ts";
import { JupiterClient, type JupQuote, type QuoteFn } from "./jupiter.ts";
import { effectiveMultiplier, readScaledUi, underlyingUnits, type ScaledUi } from "./ratios.ts";
import { loadBankState } from "./read.ts";
import { ageMs, type BankState, type TokenEntry } from "./state.ts";

export type BestIssuerOpts = {
  maxAccounts?: number;
  /** The buyer is a US person: skip issuers that exclude US persons. */
  excludeUs?: boolean;
  slippageBps?: number;
  tieBps?: number;
  maxDeviationPct?: number;
  /** Bank state (default: loaded from the configured sink). */
  state?: BankState;
  /** Jupiter quote function (default: a client built from JUPITER_API_KEY). */
  quote?: QuoteFn;
  /**
   * Live ScaledUiAmount configs by mint (default: one getMultipleAccounts call for the mints not
   * read in the last MINT_READ_TTL_MS); null skips the re-read.
   */
  readMints?: ReadMints | null;
  now?: number;
  /** Quote only these issuers (e.g. re-sizing a leg whose winner is already known). */
  onlyMints?: string[];
  /**
   * Skip issuers whose pooled Jupiter liquidity (from the bank) is below this, or unknown. Trades
   * that the settler will price should pass PRICEABLE_MIN_POOLED_USD, so nobody buys a token too
   * thin to price (its price would fall back to the stock and wait for the market to open).
   * Tradeable means both this floor and `maxPriceImpactPct`.
   */
  minPooledUsd?: number;
  /** Skip quotes whose price impact is above this many percent (covers tokens with no pool data). */
  maxPriceImpactPct?: number;
  /** Route only through these Jupiter venue labels (the fork's allowlist; see scripts/fork/lib.ts). */
  dexes?: string[];
};

/**
 * Pooled liquidity a token needs to be tradeable and for its own price to be trusted (the
 * settler's default floor too): $50k.
 */
export const PRICEABLE_MIN_POOLED_USD = 50_000;

export type Candidate = {
  mint: string;
  symbol: string;
  issuer: string;
  issuerTag: string | null;
  comparable: boolean;
  quote: JupQuote;
  outAmountRaw: string;
  /** Underlying units received (UI tokens when not comparable). */
  units: number;
  unitsPerUsd: number;
  /** USD per underlying unit actually paid. */
  effectivePriceUsd: number;
  /** effectivePriceUsd / reference - 1, percent; null without a reference price. */
  premiumPct: number | null;
  priceImpactPct: number;
  hops: number;
  uiMultiplier: number;
  transferFeeBps: number | null;
  warnings: string[];
};

export type BestIssuerResult = {
  underlying: string;
  idHex: string;
  usdAmount: number;
  maxAccounts: number;
  referencePriceUsd: number | null;
  /** "compared": best of comparable issuers. "sole-issuer": the only eligible token, not comparable. "none": nothing to buy. */
  basis: "compared" | "sole-issuer" | "none";
  winner: Candidate | null;
  runnersUp: Candidate[];
  /** Which tie-break decided, when the top candidates were within tieBps. */
  tieBreak: string | null;
  skipped: { mint: string; symbol: string; reason: string }[];
  quotedAt: string;
};

let defaultJup: JupiterClient | null = null;
let defaultRpc: Rpc | null = null;
function defaults() {
  if (!defaultJup) {
    const env = loadEnv();
    // Routing is latency-sensitive: no pacing here, Jupiter's own 429 handling applies.
    defaultJup = new JupiterClient(env.jupiterApiKey, 0);
    defaultRpc = new Rpc(env.rpcUrl);
  }
  return { jup: defaultJup, rpc: defaultRpc! };
}

export type ReadMints = (mints: string[]) => Promise<Map<string, ScaledUi | null>>;

/** How long a mint's live ScaledUiAmount config is reused (a multiplier changes on a dividend or split, rarely). */
export const MINT_READ_TTL_MS = 60_000;

/**
 * `read` with each mint's answer reused for `ttlMs`: only mints not read within it are fetched,
 * in one call. A failed read caches nothing (and throws, as `read` does).
 */
export function cachedMintReads(read: ReadMints, ttlMs = MINT_READ_TTL_MS, now: () => number = Date.now): ReadMints {
  const cache = new Map<string, { at: number; value: ScaledUi | null }>();
  return async (mints) => {
    const t = now();
    const stale = [...new Set(mints)].filter((m) => !((cache.get(m)?.at ?? -Infinity) > t - ttlMs));
    if (stale.length) {
      const fresh = await read(stale);
      for (const m of stale) cache.set(m, { at: t, value: fresh.get(m) ?? null });
    }
    return new Map(mints.map((m) => [m, cache.get(m)!.value]));
  };
}

/** Live ScaledUiAmount configs from the configured RPC, each reused for MINT_READ_TTL_MS. */
const readMintsLive: ReadMints = cachedMintReads(async (mints) => {
  const accs = await defaults().rpc.getAccounts(mints, "jsonParsed");
  return new Map(mints.map((m) => [m, accs.get(m) ? readScaledUi(accs.get(m)) : null]));
});

const TIE_BREAKS: [string, (a: Candidate, b: Candidate, ta: TokenEntry, tb: TokenEntry) => number][] = [
  ["lower price impact", (a, b) => a.priceImpactPct - b.priceImpactPct],
  ["fewer route hops", (a, b) => a.hops - b.hops],
  ["no permanent delegate", (_a, _b, ta, tb) => Number(ta.permanentDelegate) - Number(tb.permanentDelegate)],
  ["more pooled liquidity", (_a, _b, ta, tb) => (tb.jupiterPooledUsd ?? 0) - (ta.jupiterPooledUsd ?? 0)],
  ["mint address", (a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0)],
];

/** Orders candidates within the tie band; returns the order and the first tie-break that separated #1 from #2. */
export function breakTies(tied: Candidate[], tokens: Record<string, TokenEntry>): { order: Candidate[]; decidedBy: string | null } {
  const cmp = (a: Candidate, b: Candidate) => {
    for (const [, f] of TIE_BREAKS) {
      const d = f(a, b, tokens[a.mint], tokens[b.mint]);
      if (d !== 0) return d;
    }
    return 0;
  };
  const order = [...tied].sort(cmp);
  if (order.length < 2) return { order, decidedBy: null };
  for (const [name, f] of TIE_BREAKS) if (f(order[0], order[1], tokens[order[0].mint], tokens[order[1].mint]) !== 0) return { order, decidedBy: name };
  return { order, decidedBy: null };
}

/**
 * The issuer tokens `bestIssuer` would quote for an underlying, from the bank alone (no network).
 * An empty pool means there's nothing to buy, so callers can drop that leg before quoting.
 */
export function issuerPool(
  underlying: string,
  state: BankState,
  o: Pick<BestIssuerOpts, "maxAccounts" | "excludeUs" | "now" | "onlyMints" | "minPooledUsd"> = {},
): { pool: TokenEntry[]; comparable: TokenEntry[]; skipped: BestIssuerResult["skipped"] } {
  const maxAccounts = o.maxAccounts ?? 30;
  const nowMs = o.now ?? Date.now();
  const u = state.underlyings[underlying];
  if (!u) throw new Error(`unknown underlying ${underlying}`);
  const skipped: BestIssuerResult["skipped"] = [];
  const skip = (t: TokenEntry, reason: string) => skipped.push({ mint: t.mint, symbol: t.symbol, reason });

  let pool: TokenEntry[] = [];
  for (const m of u.mints) {
    if (o.onlyMints && !o.onlyMints.includes(m)) continue;
    const t = state.tokens[m];
    if (!t) continue;
    if (t.defaultFrozen) skip(t, "permissioned (default-frozen accounts)");
    else if (t.paused) skip(t, "mint is paused");
    else if (o.excludeUs && t.usPersons === "no") skip(t, "issuer excludes US persons");
    else if (t.liquidity.ratioSuspect) skip(t, "units-per-token ratio failed the bank's price check");
    else if (o.minPooledUsd !== undefined && t.jupiterPooledUsd === null) skip(t, "pooled liquidity unknown");
    else if (o.minPooledUsd !== undefined && t.jupiterPooledUsd !== null && t.jupiterPooledUsd < o.minPooledUsd)
      skip(t, `thin pool: $${Math.round(t.jupiterPooledUsd).toLocaleString("en-US")} pooled, under $${o.minPooledUsd.toLocaleString("en-US")}`);
    // A probe that failed with at least as many accounts allowed says this one will fail too.
    else if (t.probe && t.probe.maxAccounts >= maxAccounts && ageMs(t.probe.at, nowMs) < 3_600_000 && !t.probe.quotes.some((q) => q.routed)) skip(t, `no route in the last probe at maxAccounts=${t.probe.maxAccounts}`);
    else pool.push(t);
  }
  const comparable = pool.filter((t) => t.ratio.comparable);
  // Non-comparable tokens never stand in for comparable issuers that are merely paused or skipped.
  const hasComparableIssuer = u.mints.some((m) => state.tokens[m]?.ratio.comparable);
  if (hasComparableIssuer) {
    for (const t of pool) if (!t.ratio.comparable) skip(t, `not comparable: ${t.ratio.comparable ? "" : t.ratio.reason}`);
    pool = comparable;
  } else if (pool.length > 1) {
    for (const t of pool) skip(t, `not comparable and not the sole issuer: ${t.ratio.comparable ? "" : t.ratio.reason}`);
    pool = [];
  }
  return { pool, comparable, skipped };
}

export async function bestIssuer(underlying: string, usdAmount: number, o: BestIssuerOpts = {}): Promise<BestIssuerResult> {
  if (!(usdAmount > 0)) throw new Error("usdAmount must be positive");
  const maxAccounts = o.maxAccounts ?? 30;
  const tieBps = o.tieBps ?? 1;
  const maxDeviationPct = o.maxDeviationPct ?? 5;
  const state = o.state ?? (await loadBankState());
  const nowMs = o.now ?? Date.now();
  const u = state.underlyings[underlying];
  const { pool, comparable, skipped } = issuerPool(underlying, state, { maxAccounts, excludeUs: o.excludeUs, now: nowMs, onlyMints: o.onlyMints, minPooledUsd: o.minPooledUsd });
  const skip = (t: TokenEntry, reason: string) => skipped.push({ mint: t.mint, symbol: t.symbol, reason });
  const basis: BestIssuerResult["basis"] = !pool.length ? "none" : comparable.length ? "compared" : "sole-issuer";
  const base = { underlying, idHex: u.idHex, usdAmount, maxAccounts, referencePriceUsd: u.refPriceUsd, quotedAt: new Date(nowMs).toISOString() };
  if (!pool.length) return { ...base, basis: "none", winner: null, runnersUp: [], tieBreak: null, skipped };

  const readMints = o.readMints === undefined ? readMintsLive : o.readMints;
  let live: Map<string, ScaledUi | null> | null = null;
  if (readMints) {
    try {
      live = await readMints(pool.map((t) => t.mint));
    } catch {
      live = null; // fall back to the bank's copy (scheduled multipliers still apply)
    }
  }
  const quote = o.quote ?? defaults().jup.quote;
  const nowSec = Math.floor(nowMs / 1000);
  const results = await Promise.all(pool.map(async (t) => ({ t, r: await quote(t.mint, usdAmount, { maxAccounts, slippageBps: o.slippageBps, dexes: o.dexes }).catch((e) => ({ quote: null, error: String(e?.message ?? e) })) })));

  const cands: Candidate[] = [];
  for (const { t, r } of results) {
    if (!r.quote) {
      skip(t, `no quote: ${r.error}`);
      continue;
    }
    const scaledUi = live?.has(t.mint) ? live.get(t.mint)! : t.scaledUi;
    const perUi = t.ratio.comparable ? t.ratio.underlyingPerUiToken : 1;
    const units = underlyingUnits(r.quote.outAmount, { decimals: t.decimals, scaledUi, underlyingPerUiToken: perUi, transferFeeBps: t.transferFeeBps }, nowSec);
    if (!(units > 0)) {
      skip(t, "quote returned zero output");
      continue;
    }
    const impactPct = Number(r.quote.priceImpactPct) * 100;
    if (o.maxPriceImpactPct !== undefined && impactPct > o.maxPriceImpactPct) {
      skip(t, `price impact ${impactPct.toFixed(2)}% is over ${o.maxPriceImpactPct}%`);
      continue;
    }
    const effectivePriceUsd = usdAmount / units;
    const ref = t.ratio.comparable ? u.refPriceUsd : (t.price?.usd ?? null);
    const premiumPct = ref ? (effectivePriceUsd / ref - 1) * 100 : null;
    if (t.ratio.comparable && premiumPct !== null && premiumPct < -maxDeviationPct) {
      skip(t, `quote is ${(-premiumPct).toFixed(1)}% below the reference price: units-per-token ratio is suspect`);
      continue;
    }
    const warnings: string[] = [];
    if (o.excludeUs && t.usPersons === "unverified") warnings.push("US-person eligibility for this issuer is unverified");
    if (!t.ratio.comparable) warnings.push(`sole issuer; units per token unknown (${t.ratio.reason})`);
    if (live && !live.has(t.mint)) warnings.push("multiplier not re-read from chain; using the bank's copy");
    cands.push({
      mint: t.mint,
      symbol: t.symbol,
      issuer: t.issuer,
      issuerTag: t.issuerTag,
      comparable: t.ratio.comparable,
      quote: r.quote,
      outAmountRaw: String(r.quote.outAmount),
      units,
      unitsPerUsd: units / usdAmount,
      effectivePriceUsd,
      premiumPct,
      priceImpactPct: impactPct,
      hops: r.quote.routePlan.length,
      uiMultiplier: effectiveMultiplier(scaledUi, nowSec),
      transferFeeBps: t.transferFeeBps,
      warnings,
    });
  }
  if (!cands.length) return { ...base, basis: "none", winner: null, runnersUp: [], tieBreak: null, skipped };

  const top = Math.max(...cands.map((c) => c.unitsPerUsd));
  const inBand = (c: Candidate) => c.unitsPerUsd >= top * (1 - tieBps / 1e4);
  const { order: tied, decidedBy } = breakTies(cands.filter(inBand), state.tokens);
  const rest = cands.filter((c) => !inBand(c)).sort((a, b) => b.unitsPerUsd - a.unitsPerUsd);
  const [winner, ...others] = [...tied, ...rest];
  return { ...base, basis, winner, runnersUp: others, tieBreak: tied.length > 1 ? decidedBy : null, skipped };
}
