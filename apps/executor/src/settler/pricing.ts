// Which price the settler signs for one leg of one position, at entry or exit. Pure apart from
// the injected sources, so every rule is unit-tested.
//
// The rule (docs/onchain-plan.md, step 4), token first:
//   1. The issuer token the owner actually bought, from Jupiter, when the settler runs within
//      `liveWindowSecs` of the moment and the token has `minLiquidityUsd` pooled. The user holds
//      the token, so its price is their result, at any hour. (A token whose units-per-token ratio
//      fails the bank's price check is never routed to, so it never gets here.)
//   (Which token a leg gets is decided before this, from the receipt's proof of trade: proof.ts.
//   A spot leg the trade delivered no matching token for never reaches here, so the stock below
//   is only a fallback for a token that was bought but can't be priced right now.)
//      No band against the stock: a token with the liquidity floor pooled
//      trades close to its stock, and real after-hours moves aren't errors.
//   2. Otherwise, for US stocks and ETFs, the first Alpaca trade at or after the moment. Nobody
//      can trade on weekend news at Friday's close: the price is Monday's first trade. A
//      token-priced entry exits on it only through the premium measured at entry; with no premium
//      (entered with the market shut) it waits for a live token price within the live window, and
//      otherwise stays unpriced rather than sign the raw stock.
//   Jupiter and Alpaca are the only price sources.
//   3. Card legs: the card's insured value from Collector Crypt (card-legs.ts).
//   4. Anything else has no source yet (non-stock underlyings with no liquid token) and stays
//      unpriced; after the grace period it settles at 0%, unscored.
//
// Every price is per one unit of the underlying (one share, one ounce). The entry also fixes the
// leg's basis (basis.ts): an exit uses the same source. A token-priced entry exits on the token,
// or, when the token can't be used then, on the stock times the token's premium at entry; a
// stock-priced entry exits on the stock. Otherwise the token's premium or discount to the stock
// (often 1-2%) would show up as a gain or loss.
import { effectiveMultiplier, type ScaledUi } from "@thesis/venues/bank";
import { bookProblem, legPrice, type GeminiContract, type GeminiSide } from "@thesis/venues/gemini";
import type { EntryBasis } from "./basis.ts";
import { priceCard, type CardRef, type CardSource } from "./card-legs.ts";
import type { StockSource, TokenPrice, TokenSource } from "./sources.ts";

export type LegKindName = "spot" | "yield" | "perp" | "prediction" | "card";

export type UnderlyingRef = { key: string; cls: string; code: string };

export type TokenRef = {
  mint: string;
  /** Underlying units per UI token, or null when the bank can't compare this token. */
  underlyingPerUiToken: number | null;
  /**
   * The mint's ScaledUiAmount config from the asset bank (re-read hourly for liquid tokens, daily
   * for the rest; changes are scheduled ahead), or null when it has none. Undefined: not known.
   */
  scaledUi?: ScaledUi | null;
};

export type LegToPrice = {
  index: number;
  kind: LegKindName;
  /** From the asset bank, by the leg's on-chain underlying id. Null if the bank doesn't know it. */
  underlying: UnderlyingRef | null;
  /** The issuer token this owner received for the leg, when they bought one (spot legs). */
  token: TokenRef | null;
  /** Prediction legs: the contract and side from the asset bank (needed at entry only). */
  prediction?: { contract: GeminiContract; side: GeminiSide } | null;
  /** The position's side: a fade holds the other side of a prediction leg. */
  held?: "back" | "fade";
  /** Card legs: the card the leg's id names, from the asset bank (an exit's basis names it too). */
  card?: CardRef | null;
};

export type PriceRules = {
  minLiquidityUsd: number;
  liveWindowSecs: number;
  /** A stock trade older than this is a stale close (market shut): no premium is measured against it. */
  staleRefSecs?: number;
  /** The config's `max_price_delay_secs`: a price must be published within this after the moment. */
  maxDelaySecs: number;
  /**
   * A spot leg's tokens, at its entry price, must be worth at least this share of the leg's part
   * of the stake, or the leg stays unpriced (proof.ts). Defaults to 0.9.
   */
  minReceivedRatio?: number;
};

export type LegQuote = {
  leg: number;
  /** USD per underlying unit. */
  price: number;
  /** Unix seconds, at or after the moment and no later than now. */
  publishedAt: number;
  rule: "issuer-token" | "stock-first-trade" | "stock-adjusted" | "gemini-ask" | "gemini-bid" | "gemini-resolution" | "phoenix-mark" | "phoenix-liquidated" | "lend-share-value" | "card-insured-value";
  /** What priced it. On an entry this fixes the leg's basis for its exit and live marks. */
  basis: EntryBasis;
  inputs: Record<string, unknown>;
};

export type LegOutcome =
  | { ok: true; quote: LegQuote }
  /** `retry`: a price may still appear (market closed, crank early); otherwise give up on this leg. */
  | { ok: false; retry: boolean; reason: string };

/** Live Gemini events, through the Supabase `gemini` proxy. */
export type PredictionSource = {
  /** `notBeforeMs`: a cached read older than this isn't good enough (a price must be observed at or after its moment). */
  event(eventTicker: string, o?: { notBeforeMs?: number }): Promise<GeminiContract[]>;
  /** When the event's current contracts were read (ms), for the price's publish time. */
  readAt?(eventTicker: string): number | null;
  /** The settler read the event and has to wait on it (reads of it can slow down). */
  waiting?(eventTicker: string): void;
  /** The event priced: read it at the normal pace again. */
  priced?(eventTicker: string): void;
};

/** Phoenix's mark price: the first one-minute bar at or after a moment (`PhoenixVenue.markAtOrAfter`). */
export type PhoenixMarkSource = {
  markAtOrAfter(symbol: string, atSec: number, maxDelaySecs: number): Promise<{ price: number; at: number } | null>;
};

/** One Jupiter Lend vault share's value in USDC now (`jupiterLendShareValue`). */
export type LendSource = {
  shareValue(shareMint: string): Promise<{ usdcPerShare: number; at: number; raw: unknown } | null>;
};

export type Sources = {
  stocks: StockSource;
  tokens: TokenSource;
  predictions?: PredictionSource;
  phoenix?: PhoenixMarkSource;
  lend?: LendSource;
  /** Collector Crypt cards, read live (card legs). */
  cards?: CardSource;
};

const isStock = (u: UnderlyingRef) => u.cls === "equity" || u.cls === "etf";

/** Which price a leg is being priced for. An exit and a sale are priced alike. */
export type PriceMoment = "entry" | "exit" | "sale";

/**
 * `entry` is the leg's entry basis when pricing an exit (null or absent for an entry, or an exit
 * whose entry predates bases: then the plain rule applies). `moment` says which it is; without it,
 * no basis means an entry (older callers). The crank always passes it.
 */
export async function priceLeg(
  leg: LegToPrice,
  momentSec: number,
  nowSec: number,
  rules: PriceRules,
  src: Sources,
  entry: EntryBasis | null = null,
  moment?: PriceMoment,
): Promise<LegOutcome> {
  const at = moment ?? (entry === null ? "entry" : "exit");
  const out = await priceLegAt(leg, momentSec, nowSec, rules, src, entry, at);
  // The program refuses an entry price of 0 units, which would block every leg of the entry: a
  // price under one 8-decimal unit can't be recorded, so the leg stays unpriced instead. (An exit
  // of 0 is real: a prediction that lost, a 1x perp liquidated.)
  if (out.ok && at === "entry" && toPriceUnits(out.quote.price) <= 0n) {
    return { ok: false, retry: false, reason: `$${out.quote.price} is under the program's smallest price unit ($0.00000001)` };
  }
  return out;
}

async function priceLegAt(
  leg: LegToPrice,
  momentSec: number,
  nowSec: number,
  rules: PriceRules,
  src: Sources,
  entry: EntryBasis | null,
  moment: PriceMoment,
): Promise<LegOutcome> {
  if (leg.kind === "yield") return priceYield(leg, momentSec, nowSec, rules, src, entry);
  if (leg.kind === "prediction") return pricePrediction(leg, momentSec, nowSec, rules, src, entry, moment);
  if (leg.kind === "card") return priceCard(leg, momentSec, nowSec, rules, src.cards, entry);
  if (!leg.underlying) return { ok: false, retry: false, reason: "underlying not in the asset bank" };
  if (nowSec < momentSec) return { ok: false, retry: true, reason: "moment not reached" };

  const u = leg.underlying;
  const until = momentSec + rules.maxDelaySecs;
  const live = nowSec - momentSec <= rules.liveWindowSecs;
  const staleRef = rules.staleRefSecs ?? DEFAULT_STALE_REF_SECS;

  // Corporate actions. xStocks and Ondo tokens carry a Token-2022
  // ScaledUiAmount multiplier, raised for splits and reinvested dividends: the holder's raw balance
  // stays put and shows more UI tokens, each worth less (a 10-for-1 split: ×10 tokens at a tenth of
  // the price). Every price after the entry is scaled by (multiplier at the moment / multiplier at
  // entry), so the leg's return is what the holding returned: a split reads as 0%, a dividend as
  // its yield. Entries from before this carry no multiplier and aren't scaled. Tokens with no
  // multiplier (Backpack: 1:1 shares) are scaled by the stock's own splits since the entry, from
  // Alpaca's corporate actions.
  // Jupiter's live config when the token was read, else the bank's copy (no extra request).
  // Undefined when neither knows: then the multiplier can't be told.
  let tp: TokenPrice | null | undefined;
  const configOf = (t: TokenPrice | null | undefined): ScaledUi | null | undefined => (t?.scaledUi !== undefined ? t.scaledUi : leg.token?.scaledUi);
  const multiplierAt = (t: TokenPrice | null | undefined, atSec = momentSec) => effectiveMultiplier(configOf(t) ?? null, atSec);
  const entryMultiplier = entry && (entry.source === "token" || entry.source === "stock") && entry.multiplier && entry.multiplier > 0 ? entry.multiplier : null;
  const entryAt = entry && (entry.source === "token" || entry.source === "stock") && entry.at ? entry.at : null;
  const scale = (m: number) => (entryMultiplier ? m / entryMultiplier : 1);
  /** Stock splits since the entry, for a US-stock leg whose token has no multiplier (or no token). */
  const splitAdjust = async (): Promise<{ factor: number; inputs: Record<string, unknown> }> => {
    if (!isStock(u) || !entryAt || !src.stocks.splits) return { factor: 1, inputs: {} };
    if (leg.token && configOf(tp) !== null) return { factor: 1, inputs: {} }; // a multiplier (or unknown): not this rule
    const splits = await src.stocks.splits(u.code, entryAt, momentSec);
    if (!splits.length) return { factor: 1, inputs: {} };
    const factor = splits.reduce((f, s) => f * s.ratio, 1);
    return { factor, inputs: { splits: splits.map((s) => s.raw), splitFactor: factor } };
  };

  // 1. The issuer token, live (never for a leg whose entry was priced on the stock).
  if (entry?.source !== "stock" && leg.token?.underlyingPerUiToken && live) {
    const t = (tp = await src.tokens.price(leg.token.mint));
    if (t && t.liquidityUsd >= rules.minLiquidityUsd && t.usdPrice > 0) {
      const implied = t.usdPrice / leg.token.underlyingPerUiToken;
      const publishedAt = Math.max(momentSec, Math.min(nowSec, t.at));
      const perUi = leg.token.underlyingPerUiToken;
      const known = configOf(t) !== undefined;
      const m = multiplierAt(t);
      const quote = async (inputs: Record<string, unknown>, premium: number | null): Promise<LegOutcome> => {
        const sp = await splitAdjust();
        return {
          ok: true,
          quote: {
            leg: leg.index,
            price: implied * scale(m) * sp.factor,
            publishedAt,
            rule: "issuer-token",
            basis: entry ?? { source: "token", mint: t.mint, underlyingPerUiToken: perUi, premium, ...(known ? { multiplier: m } : {}), at: momentSec },
            inputs: { token: t.raw, underlyingPerUiToken: perUi, ...(known ? { multiplier: m } : {}), ...(entryMultiplier ? { entryMultiplier } : {}), ...sp.inputs, ...inputs },
          },
        };
      };
      if (!isStock(u)) return quote({}, null);
      // Token first: the user holds the token, so its price is their result. The stock is only
      // read to record the token's premium to it, used if the exit has to fall back to the stock.
      // A close from before the market shut isn't a fair reference (after-hours news), so then
      // no premium is recorded.
      const ref = await src.stocks.latestTrade(u.code).catch(() => null);
      const fresh = ref && ref.price > 0 && nowSec - ref.at <= staleRef;
      return quote(fresh ? { stockRef: ref.raw } : {}, fresh ? implied / ref.price : null);
    }
  }

  // 2. The stock's own first trade at or after the moment.
  if (isStock(u)) {
    const tr = await src.stocks.firstTradeAtOrAfter(u.code, momentSec, Math.min(nowSec, until));
    if (tr && tr.at >= momentSec && tr.at <= until) {
      // The multiplier of the token the owner holds, at the moment: the bank's copy, or Jupiter's
      // (which reports a thin token's config too) when the bank doesn't know it. An entry that
      // recorded a multiplier needs one now: if nothing can tell it, wait rather than guess 1.
      if (leg.token && entryMultiplier && configOf(tp) === undefined) {
        tp = await src.tokens.price(leg.token.mint).catch(() => null);
        if (configOf(tp) === undefined) {
          return { ok: false, retry: nowSec <= until, reason: `can't tell ${leg.token.mint}'s multiplier to carry the entry's terms over` };
        }
      }
      const m = leg.token ? multiplierAt(tp) : 1;
      const sp = await splitAdjust();
      const extra = { ...(leg.token && configOf(tp) !== undefined ? { multiplier: m } : {}), ...(entryMultiplier ? { entryMultiplier } : {}), ...sp.inputs };
      if (entry?.source === "token") {
        // A token-priced entry whose token can't price the exit: the stock, carried over to the
        // token's terms by the premium measured at entry.
        if (entry.premium) {
          return {
            ok: true,
            quote: { leg: leg.index, price: tr.price * entry.premium * scale(m) * sp.factor, publishedAt: tr.at, rule: "stock-adjusted", basis: entry, inputs: { trade: tr.raw, premium: entry.premium, ...extra } },
          };
        }
        // No premium (entered with the market shut): the raw stock would turn the token's premium
        // or discount into a gain or loss nobody made. Wait for a live token price while the live
        // window lasts; past it no live price can come, so the leg stays unpriced
        // (unscored rather than signed on the raw stock).
        return live
          ? { ok: false, retry: true, reason: `token-priced entry with no premium to ${u.code}: waiting for a live price for the token itself` }
          : { ok: false, retry: false, reason: `token-priced entry with no premium to ${u.code}, and no live price for the token within ${rules.liveWindowSecs}s` };
      }
      const basis: EntryBasis =
        entry ?? (leg.token && configOf(tp) !== undefined ? { source: "stock", mint: leg.token.mint, multiplier: m, at: momentSec } : { source: "stock", at: momentSec });
      return {
        ok: true,
        quote: { leg: leg.index, price: tr.price * scale(m) * sp.factor, publishedAt: tr.at, rule: "stock-first-trade", basis, inputs: { trade: tr.raw, ...extra } },
      };
    }
    return nowSec > until
      ? { ok: false, retry: false, reason: `no ${u.code} trade within ${rules.maxDelaySecs}s of the moment` }
      : { ok: false, retry: true, reason: `no ${u.code} trade yet at or after the moment (market closed?)` };
  }

  // Not a stock: only the token prices it, live.
  if (live) return { ok: false, retry: true, reason: `${u.key}: no liquid issuer token price right now` };
  return { ok: false, retry: false, reason: `${u.key}: not a stock, and the live window for its token has passed` };
}

/**
 * A yield leg (counts in the score): one share of the Jupiter Lend vault the
 * trade bought, valued in USDC, read now. The vault's rate only goes up, and any price published
 * at or after the moment (within the program's delay) is valid, so the current value is the
 * first price at or after it. USDC counts as $1, as the stake does.
 */
async function priceYield(leg: LegToPrice, momentSec: number, nowSec: number, rules: PriceRules, src: Sources, entry: EntryBasis | null): Promise<LegOutcome> {
  if (!src.lend) return { ok: false, retry: true, reason: "no Jupiter Lend source" };
  if (nowSec < momentSec) return { ok: false, retry: true, reason: "moment not reached" };
  if (nowSec > momentSec + rules.maxDelaySecs) return { ok: false, retry: false, reason: "past the price deadline" };
  const shareMint = entry?.source === "lend" ? entry.shareMint : leg.token?.mint;
  if (!shareMint) return { ok: false, retry: false, reason: "no vault share proved for this yield leg" };
  const v = await src.lend.shareValue(shareMint);
  if (!v || !(v.usdcPerShare > 0)) return { ok: false, retry: true, reason: `Jupiter Lend doesn't list ${shareMint} right now` };
  return {
    ok: true,
    quote: {
      leg: leg.index,
      price: v.usdcPerShare,
      publishedAt: Math.max(momentSec, Math.min(nowSec, v.at)),
      rule: "lend-share-value",
      basis: { source: "lend", shareMint },
      inputs: { shareMint, value: v.raw },
    },
  };
}

/** 15 minutes: Alpaca's free feed trades a liquid stock every few seconds while the market is open. */
export const DEFAULT_STALE_REF_SECS = 900;

/** USD → on-chain price units (8 decimals). */
export function toPriceUnits(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`bad price ${usd}`);
  return BigInt(Math.round(usd * 1e8));
}

/**
 * A prediction leg (paper-filled): Gemini's live prices for the contract and
 * side the leg names. Entry (no basis yet) is the held side's ask. An exit or sale (the entry's
 * `gemini` basis) is 1 or 0 once the contract resolved, else the held side's bid. A contract that
 * stopped trading but hasn't resolved is waited on, up to the price deadline. A fade holds the
 * other side; `legPrice` returns it in the leg's terms, for the program's "No" formula.
 */
async function pricePrediction(
  leg: LegToPrice,
  momentSec: number,
  nowSec: number,
  rules: PriceRules,
  src: Sources,
  entry: EntryBasis | null,
  moment: PriceMoment,
): Promise<LegOutcome> {
  if (!src.predictions) return { ok: false, retry: true, reason: "no Gemini source (set GEMINI_PROXY_TOKEN)" };
  if (nowSec < momentSec) return { ok: false, retry: true, reason: "moment not reached" };
  if (nowSec > momentSec + rules.maxDelaySecs) return { ok: false, retry: false, reason: "past the price deadline" };
  const isEntry = moment === "entry";
  // The entry's basis names the contract; an exit with none (an entry from before bases, or a lost
  // audit log) rebuilds it from the leg's on-chain id through the asset bank, and still exits at
  // the bid or the resolution.
  const ref =
    entry?.source === "gemini"
      ? entry
      : leg.prediction
        ? { source: "gemini" as const, eventTicker: leg.prediction.contract.eventTicker, instrument: leg.prediction.contract.instrumentSymbol, side: leg.prediction.side }
        : null;
  if (!ref) {
    return { ok: false, retry: isEntry, reason: isEntry ? "the leg's Gemini contract isn't in the asset bank yet" : "the entry has no Gemini basis, and the asset bank no longer lists the leg's contract" };
  }
  const held = leg.held ?? "back";
  const predictions = src.predictions;
  const wait = (reason: string): LegOutcome => {
    predictions.waiting?.(ref.eventTicker);
    return { ok: false, retry: true, reason };
  };
  // Only a read made at or after the moment counts: a cached book from before a trade isn't its price.
  const c = (await predictions.event(ref.eventTicker, { notBeforeMs: momentSec * 1000 })).find((x) => x.instrumentSymbol === ref.instrument);
  if (!c) return wait(`Gemini doesn't list ${ref.instrument} right now`);
  const closed = c.expiry !== null && Date.parse(c.expiry) <= nowSec * 1000;
  if (!isEntry && !c.resolutionSide && closed) return wait(`${ref.instrument} stopped trading; waiting for Gemini to resolve it`);
  // Paper fills at incoherent quotes would score gains nobody could make: wait for a sane book.
  const bad = c.resolutionSide ? null : bookProblem(c);
  if (bad) return wait(`${ref.instrument}: Gemini's quotes don't add up (${bad})`);
  const price = legPrice(c, ref.side, held, isEntry ? "entry" : "exit");
  if (price === null || (isEntry && !(price > 0 && price < 1))) {
    return wait(`no ${isEntry ? "ask" : "bid"} on ${held === "back" ? ref.side : ref.side === "yes" ? "no" : "yes"} for ${ref.instrument} right now`);
  }
  predictions.priced?.(ref.eventTicker);
  // Published when it was observed (the read), within [moment, now].
  const readMs = predictions.readAt?.(ref.eventTicker) ?? null;
  const publishedAt = readMs === null ? nowSec : Math.max(momentSec, Math.min(nowSec, Math.floor(readMs / 1000)));
  return {
    ok: true,
    quote: {
      leg: leg.index,
      price,
      publishedAt,
      rule: !isEntry && c.resolutionSide ? "gemini-resolution" : isEntry ? "gemini-ask" : "gemini-bid",
      basis: ref,
      inputs: {
        instrument: c.instrumentSymbol, eventTicker: c.eventTicker, side: ref.side, held, ask: c.ask, bid: c.bid, status: c.status, resolutionSide: c.resolutionSide, resolvedAt: c.resolvedAt,
        ...(readMs !== null ? { readAt: new Date(readMs).toISOString() } : {}),
        ...(!isEntry && entry?.source !== "gemini" ? { basisRebuilt: true } : {}),
      },
    },
  };
}

