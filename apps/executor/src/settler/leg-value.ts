// One way to value a leg: the rules every Thesis price follows, pure. Three callers use them,
// each with its own reads and freshness rules:
//   - the settler (pricing.ts) signs a price at or after a moment, inside its window;
//   - the marker (marker/) writes live marks for the feed, every few minutes;
//   - the fork API (scripts/fork/api/valuation.ts) shows live values on the Me page and receipts.
// What a set of inputs is worth is decided here, so the three can't drift apart.
//
//   spot        Token first: the issuer token's own price when its pool holds the tradeable floor
//               ($50k pooled), at any hour, with no band against the stock. Otherwise the US
//               stock's price (Alpaca). A leg keeps the source its entry was priced on: a
//               token-priced entry exits on the token, or on the stock times the token's premium
//               at entry (no premium: no price, rather than turn the premium into a gain or loss);
//               a stock-priced entry stays on the stock. Prices after the entry are scaled by the
//               token's multiplier now over the one at entry (and stock splits), by the caller.
//   perp        Phoenix's price per contract, over the underlying units one contract tracks.
//   prediction  The held side's ask at entry (strictly between 0 and 1); later its bid, or 1/0
//               once resolved. Never from a book that doesn't add up (bookProblem).
//   yield       One vault share's value in USDC (Jupiter Lend's jlUSDC exchange rate).
//   card        The card's insured value (Collector Crypt).
// A leg's return is the program's own formula (positionReturnBps): a perp's move times its
// leverage, a fade's prediction in "No" terms, and each leg's loss capped at −100%.
import { positionReturnBps } from "@thesis/chain";
import { PRICEABLE_MIN_POOLED_USD } from "@thesis/venues/bank";
import { bookProblem, legPrice, type GeminiContract, type GeminiSide } from "@thesis/venues/gemini";

export type LegKind = "spot" | "yield" | "perp" | "prediction" | "card";

/** USD → on-chain price units (8 decimals). */
export function toPriceUnits(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`bad price ${usd}`);
  return BigInt(Math.round(usd * 1e8));
}

// --- Spot ----------------------------------------------------------------------------------------

/** A token's price read (Jupiter Price v3, or the asset bank's copy of it). */
export type TokenQuote = { usdPrice: number; liquidityUsd: number };

/**
 * The token's own price per underlying unit, when it can be trusted: a positive price and at
 * least `minLiquidityUsd` pooled (the tradeable floor). Null otherwise.
 */
export function liquidTokenPrice(t: TokenQuote | null | undefined, perUi: number, minLiquidityUsd: number = PRICEABLE_MIN_POOLED_USD): number | null {
  return t && t.liquidityUsd >= minLiquidityUsd && t.usdPrice > 0 ? t.usdPrice / perUi : null;
}

/**
 * The token's premium (or discount) to its stock, recorded when a leg is priced on the token, so
 * an exit that has to fall back to the stock stays in the token's terms. Only against a stock
 * trade at most `staleRefSecs` old: a close from before the market shut isn't a fair reference.
 */
export function tokenPremium(implied: number, ref: { price: number; at: number } | null | undefined, nowSec: number, staleRefSecs: number): number | null {
  return ref && ref.price > 0 && nowSec - ref.at <= staleRefSecs ? implied / ref.price : null;
}

/** What priced a spot leg's entry (null: no entry yet, price it as one). */
export type SpotBasisRef = { source: "token"; premium?: number | null } | { source: "stock" } | null;

export type SpotPrice =
  | { ok: true; price: number; via: "token" | "stock" | "stock-adjusted" }
  /** `no-premium`: a token-priced entry whose token can't be used, with no premium to carry the stock over. */
  | { ok: false; why: "no-premium" | "no-price" };

/**
 * A spot leg's price per underlying unit. `token` is liquidTokenPrice's answer (null when the
 * token can't be used now); `stock` is a stock price the caller trusts for its purpose (null: none).
 * `scale` (multiplier now / at entry) and `factor` (stock splits since the entry) are applied in
 * that order.
 */
export function spotPrice(basis: SpotBasisRef, token: number | null, stock: number | null, scale = 1, factor = 1): SpotPrice {
  if (basis?.source !== "stock" && token !== null) return { ok: true, price: token * scale * factor, via: "token" };
  if (stock !== null) {
    if (basis?.source === "token") {
      return basis.premium ? { ok: true, price: stock * basis.premium * scale * factor, via: "stock-adjusted" } : { ok: false, why: "no-premium" };
    }
    return { ok: true, price: stock * scale * factor, via: "stock" };
  }
  return { ok: false, why: "no-price" };
}

// --- Prediction, perp, yield, card -----------------------------------------------------------------

export type PredictionPrice =
  | { ok: true; price: number; rule: "gemini-ask" | "gemini-bid" | "gemini-resolution" }
  | { ok: false; why: "unlisted" | "bad-book" | "no-quote"; detail?: string };

/**
 * A prediction leg's price in the leg's terms (a fade's in "No" terms, for the program's formula):
 * at entry the held side's ask, which must be strictly between 0 and 1; later 1 or 0 once the
 * contract resolved, else the held side's bid. Never from a book that doesn't add up.
 */
export function predictionPrice(c: GeminiContract | null | undefined, side: GeminiSide, held: "back" | "fade", moment: "entry" | "exit"): PredictionPrice {
  if (!c) return { ok: false, why: "unlisted" };
  const bad = c.resolutionSide ? null : bookProblem(c);
  if (bad) return { ok: false, why: "bad-book", detail: bad };
  const price = legPrice(c, side, held, moment);
  if (price === null || (moment === "entry" && !(price > 0 && price < 1))) return { ok: false, why: "no-quote" };
  return { ok: true, price, rule: moment === "entry" ? "gemini-ask" : c.resolutionSide ? "gemini-resolution" : "gemini-bid" };
}

/** A perp leg's price per underlying unit: Phoenix's price per contract over the units it tracks. */
export function perpPrice(perContractUsd: number | null | undefined, unitsPerContract: number): number | null {
  return perContractUsd != null && perContractUsd > 0 ? perContractUsd / (unitsPerContract > 0 ? unitsPerContract : 1) : null;
}

/** A positive price, or null (a vault share's value, a card's insured value). */
export const positive = (usd: number | null | undefined): number | null => (usd != null && usd > 0 ? usd : null);

// --- One leg, every kind ---------------------------------------------------------------------------

export type LegToValue = {
  kind: LegKind;
  /** The position's side. A fade's spot and perp legs are short positions: their market is a Phoenix perp. */
  held: "back" | "fade";
  /** A perp's leverage (1 for every other kind). */
  leverage?: number;
  /** USD per underlying unit at entry, for the return; null or absent: no return. */
  entry?: number | null;
  /** "entry": the price a new entry takes (a prediction's ask); "exit" (default): what it's worth now. */
  moment?: "entry" | "exit";
  spot?: { perUi: number; basis: SpotBasisRef; scale?: number; factor?: number; minLiquidityUsd?: number };
  perp?: { unitsPerContract: number };
  prediction?: { side: GeminiSide };
};

/** The market as the caller read it, each under its own freshness rules. */
export type LegMarket = {
  token?: TokenQuote | null;
  /** A stock price the caller trusts (for a spot leg). */
  stock?: number | null;
  /** Phoenix, USD per contract (a perp leg, or a fade's short). */
  perp?: number | null;
  contract?: GeminiContract | null;
  lendShareValue?: number | null;
  cardInsuredUsd?: number | null;
};

export type LegValue =
  | { ok: true; price: number; rule: string; returnBps: number | null }
  | { ok: false; reason: string };

/** A leg's return in bps by the program's formula, or null when it can't be computed (no entry). */
export function legReturnBps(kind: LegKind, held: "back" | "fade", leverage: number, entry: number, price: number): number | null {
  if (!(entry > 0) || !(price >= 0)) return null;
  return positionReturnBps([{ kind: { [kind]: {} }, weightBps: 10_000, leverage: Math.max(1, leverage) } as never], {
    side: { [held]: {} },
    legsMask: 1,
    prices: [{ entry: toPriceUnits(entry), exit: toPriceUnits(price) }],
  });
}

/** What one leg is worth under the rules above, and its return since `entry`. */
export function valueLeg(leg: LegToValue, m: LegMarket): LegValue {
  const done = (price: number, rule: string): LegValue => ({
    ok: true,
    price,
    rule,
    returnBps: leg.entry != null ? legReturnBps(leg.kind, leg.held, leg.leverage ?? 1, leg.entry, price) : null,
  });
  const fail = (reason: string): LegValue => ({ ok: false, reason });
  switch (leg.kind) {
    case "yield": {
      const v = positive(m.lendShareValue);
      return v === null ? fail("no vault share value") : done(v, "lend-share-value");
    }
    case "card": {
      const v = positive(m.cardInsuredUsd);
      return v === null ? fail("no insured value for the card") : done(v, "card-insured-value");
    }
    case "prediction": {
      if (!leg.prediction) return fail("no Gemini contract for this leg");
      const p = predictionPrice(m.contract, leg.prediction.side, leg.held, leg.moment ?? "exit");
      if (p.ok) return done(p.price, p.rule);
      return fail(p.why === "unlisted" ? "Gemini doesn't list the contract" : p.why === "bad-book" ? `Gemini's quotes don't add up (${p.detail})` : "no quote on the held side");
    }
    case "perp":
    case "spot": {
      // A perp leg, and a fade's short of a spot leg, are held on Phoenix.
      if (leg.kind === "perp" || leg.held === "fade") {
        const p = perpPrice(m.perp, leg.perp?.unitsPerContract ?? 1);
        return p === null ? fail("no Phoenix price") : done(p, "phoenix-mark");
      }
      const s = leg.spot;
      if (!s) return fail("no token or stock for this leg");
      const token = liquidTokenPrice(m.token, s.perUi, s.minLiquidityUsd);
      const r = spotPrice(s.basis, token, m.stock != null && m.stock > 0 ? m.stock : null, s.scale, s.factor);
      if (r.ok) return done(r.price, r.via === "token" ? "issuer-token" : r.via === "stock" ? "stock" : "stock-adjusted");
      return fail(r.why === "no-premium" ? "the token can't be used now and its entry has no premium to the stock" : "no liquid token price and no stock price");
    }
  }
}
