// Legs held on Phoenix: a back's perp legs and a fade's shorts (docs/phoenix-plan.md). The
// program proved that a Phoenix trader account of the owner was the leg's output and that its
// position grew inside the trade. The settler checks the rest, as it does for spot tokens:
//   - at entry, the trade's market order on the leg's account (read from the instruction, so it
//     holds after a sale) is in a market whose underlying is the leg's, on the right side (long
//     for a back, short for a fade), and the position growth the program proved is worth at least
//     `minReceivedRatio` of the leg's share of the stake times its leverage, at the entry mark;
//   - prices are Phoenix's mark (what Phoenix values positions and liquidations on): the first
//     one-minute bar at or after the moment, per unit of the underlying;
//   - at the horizon, a position that's gone (liquidated, or closed outside Thesis) prices the leg
//     at −100%: entry × (1 − 1/leverage) for a back, entry × (1 + 1/leverage) for a fade.
// Anything that fails stays unpriced, and the position settles at 0%, unscored, after the grace
// period.
import { underlyingIdHex } from "@thesis/venues/bank";
import type { TraderView } from "@thesis/venues/phoenix";
import type { EntryBasis } from "./basis.ts";
import type { LegOutcome, PhoenixMarkSource, PriceRules } from "./pricing.ts";
import type { ProvedOutput } from "./proof.ts";
import { DEFAULT_MIN_RECEIVED_RATIO } from "./proof.ts";

/** Reads Phoenix accounts and markets (the settler wires PhoenixVenue and its RPC). */
export type PhoenixReader = {
  trader(account: string): Promise<TraderView | null>;
  /** The market whose order book is at this address. */
  marketByOrderbook(orderbook: string): Promise<{ symbol: string; baseLotsDecimals: number } | null>;
};

/** A Phoenix market as the asset bank lists it: what it tracks, and underlying units per contract. */
export type PerpInfo = { underlyingKey: string; unitsPerContract: number };

export type PhoenixLegInput = {
  index: number;
  moment: "entry" | "exit" | "sale";
  momentSec: number;
  nowSec: number;
  rules: PriceRules;
  side: "back" | "fade";
  leg: { assetIdHex: string; leverage: number };
  /** The leg's proved output (the receipt's TradeProved). */
  out: ProvedOutput | undefined;
  /** The entry's basis, for an exit or a sale. */
  basis: EntryBasis | null;
  /** The on-chain entry price (USD per underlying unit), for the −100% rule. */
  entryPrice: number | null;
  /** The leg's share of the stake, in USD. */
  legStakeUsd: number;
  reader: PhoenixReader;
  marks: PhoenixMarkSource | undefined;
  perp(symbol: string): PerpInfo | null;
};

/**
 * The exit price that reads as exactly −100% at `lev`: entry × (1 − 1/lev) for a back, entry ×
 * (1 + 1/lev) for a fade, rounded in 8-decimal units AWAY from the entry. Rounded to nearest, a 3x
 * liquidation reads −99.99% (the program truncates the bps toward zero); one unit past it, the
 * program's −100% floor applies exactly.
 */
export function liquidatedPrice(entryPrice: number, lev: number, side: "back" | "fade"): number {
  const entry = BigInt(Math.round(entryPrice * 1e8));
  const L = BigInt(Math.max(1, lev));
  const units = side === "back" ? (entry * (L - 1n)) / L : (entry * (L + 1n) + L - 1n) / L;
  return Number(units) / 1e8;
}

const no = (reason: string): LegOutcome => ({ ok: false, retry: false, reason });
const wait = (reason: string): LegOutcome => ({ ok: false, retry: true, reason });

export async function pricePhoenixLeg(o: PhoenixLegInput): Promise<LegOutcome> {
  if (!o.marks) return wait("no Phoenix price source");
  if (!o.out?.phoenix) return no("the trade proved no Phoenix position for this leg");
  if (o.nowSec < o.momentSec) return wait("moment not reached");
  const deadline = o.momentSec + o.rules.maxDelaySecs;
  if (o.nowSec > deadline) return no("past the price deadline");
  if (o.moment === "entry") {
    const orders = o.out.orders ?? [];
    if (!orders.length) return no("the trade placed no Phoenix market order on the leg's account");
    const books = new Set(orders.map((x) => x.orderbook.toBase58()));
    const sides = new Set(orders.map((x) => x.side));
    if (books.size > 1 || sides.size > 1) return no("the trade's Phoenix orders on the leg's account disagree on market or side");
    const order = orders[0];
    const market = await o.reader.marketByOrderbook(order.orderbook.toBase58());
    const perp = market ? o.perp(market.symbol) : null;
    if (!market || !perp) return no(`Phoenix order book ${order.orderbook.toBase58()} isn't a market the asset bank knows`);
    if (underlyingIdHex(perp.underlyingKey) !== o.leg.assetIdHex) return no(`the Phoenix position is in ${market.symbol} (${perp.underlyingKey}), not this leg's asset`);
    if ((o.side === "back") !== (order.side === "long")) return no(`the Phoenix order is ${order.side}; a ${o.side} needs ${o.side === "back" ? "a long" : "a short"}`);
    const mark = await o.marks.markAtOrAfter(market.symbol, o.momentSec, o.rules.maxDelaySecs);
    if (!mark) return wait(`no Phoenix ${market.symbol} mark yet at or after the trade`);
    // The position the trade opened (its growth inside the trade) against the leg's share × leverage.
    const notional = (Number(o.out.received) / 10 ** market.baseLotsDecimals) * mark.price;
    const ratio = o.rules.minReceivedRatio ?? DEFAULT_MIN_RECEIVED_RATIO;
    const wanted = o.legStakeUsd * o.leg.leverage;
    if (notional + 1e-9 < ratio * wanted) return no(`opened $${notional.toFixed(2)} of ${market.symbol} for a $${wanted.toFixed(2)} leg (under ${Math.round(ratio * 100)}%)`);
    return {
      ok: true,
      quote: {
        leg: o.index,
        price: mark.price / perp.unitsPerContract,
        publishedAt: mark.at,
        rule: "phoenix-mark",
        basis: { source: "phoenix", symbol: market.symbol, unitsPerContract: perp.unitsPerContract },
        inputs: { account: o.out.account, orderbook: order.orderbook.toBase58(), side: order.side, received: o.out.received.toString(), mark },
      },
    };
  }

  if (o.basis?.source !== "phoenix") return no("the entry has no Phoenix basis");
  const basis = o.basis;
  // At the horizon, a position that's gone was liquidated (or closed outside Thesis): −100%. That
  // includes a trader account that no longer exists at all (`trader` is null only then; a failed
  // read throws).
  const t = o.moment === "exit" ? await o.reader.trader(o.out.account) : undefined;
  if (o.moment === "exit" && (t === null || (t && !t.positions.length))) {
    if (o.entryPrice === null) return wait("no entry price recorded yet");
    const lev = Math.max(1, Math.round(o.leg.leverage));
    return {
      ok: true,
      quote: {
        leg: o.index, price: liquidatedPrice(o.entryPrice, lev, o.side), publishedAt: o.momentSec, rule: "phoenix-liquidated", basis,
        inputs: { account: o.out.account, entryPrice: o.entryPrice, leverage: lev, ...(t === null ? { accountGone: true } : {}) },
      },
    };
  }
  const mark = await o.marks.markAtOrAfter(basis.symbol, o.momentSec, o.rules.maxDelaySecs);
  if (!mark) return wait(`no Phoenix ${basis.symbol} mark yet at or after the ${o.moment}`);
  return {
    ok: true,
    quote: { leg: o.index, price: mark.price / basis.unitsPerContract, publishedAt: mark.at, rule: "phoenix-mark", basis, inputs: { account: o.out.account, mark } },
  };
}
