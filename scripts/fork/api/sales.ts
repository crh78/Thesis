// Partial sales in the fork API: the plain arithmetic behind a sale's size, kept apart from the
// service so it can be tested without a fork. The program's own rules (packages/chain math.ts
// `partSale` / `maxPartialBps` mirror them):
//   - a sale sells `bps` of what's left of a position (1 to 10,000; 10,000 is "sell all",
//     `exit_position`; anything less is `sell_part`), the cost basis sold rounding down;
//   - after a partial sale what's left must stay at least the config's minimum stake ($10);
//   - at most MAX_OPEN_PARTS partial sales of a position wait to settle at once.
// Each leg is reduced by the same fraction: spot and yield legs sell a share of the tokens the
// trade bought (`tokensToSell`), Phoenix legs close that fraction of their lots (`partLots`), paper
// legs get that fraction of the escrow back (the program pays it).
import { BPS_DENOMINATOR, MAX_OPEN_PARTS, maxPartialBps, partSale } from "@thesis/chain";
import { ApiError } from "./common.ts";

const FULL = Number(BPS_DENOMINATOR);

/** A `usd` within this share of the position's whole value sells all of it. */
export const SELL_ALL_WITHIN = 0.005;

/**
 * The fraction a sale request asks for, in bps: `bps` as given, or `usd` converted from what the
 * holding is worth now (`valueUsd`): round(usd / value × 10⁴), at least 1, and all of it from
 * within 0.5% of the whole value. Neither: everything. 400 `invalid_amount` otherwise.
 */
export function saleBps(req: { bps?: unknown; usd?: unknown }, valueUsd: number): number {
  const hasBps = req.bps !== undefined && req.bps !== null;
  const hasUsd = req.usd !== undefined && req.usd !== null;
  if (hasBps && hasUsd) throw new ApiError(400, "invalid_amount", "Give bps or usd, not both.");
  if (hasBps) {
    const bps = req.bps;
    if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 1 || bps > FULL) {
      throw new ApiError(400, "invalid_amount", "bps is a whole number from 1 to 10000.");
    }
    return bps;
  }
  if (hasUsd) {
    const usd = req.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) throw new ApiError(400, "invalid_amount", "usd must be more than 0.");
    if (!(valueUsd > 0)) throw new ApiError(400, "invalid_amount", "This holding has no value to sell a dollar amount of.");
    if (usd >= valueUsd * (1 - SELL_ALL_WITHIN)) return FULL;
    return Math.min(FULL, Math.max(1, Math.round((usd / valueUsd) * FULL)));
  }
  return FULL;
}

/**
 * How many of a token a sale sells: what the position still holds before it minus what it holds
 * after, where it holds floor(bought × remaining / stake). Selling all (`after` 0) sells what's left,
 * so a position sold in parts sells exactly what it bought, no more.
 */
export function tokensToSell(bought: bigint, stake: bigint, before: bigint, after: bigint): bigint {
  if (stake <= 0n) return 0n;
  const held = (r: bigint) => (r >= stake ? bought : (bought * r) / stake);
  return held(before) - held(after);
}

/** The lots a partial sale closes of a Phoenix position (signed like it), rounded toward zero. */
export function partLots(baseLots: bigint, bps: number): bigint {
  return (baseLots * BigInt(bps)) / BPS_DENOMINATOR;
}

/** The program's escrow return for a sale: the fraction of the escrow, rounded down (all of it when selling all). */
export function escrowReturned(escrowed: bigint, bps: number): bigint {
  return bps >= FULL ? escrowed : (escrowed * BigInt(bps)) / BPS_DENOMINATOR;
}

/** One position's sale: its cost basis sold and what's left, or why the program would refuse it. */
export type PositionSale =
  | { ok: true; full: boolean; sold: bigint; left: bigint }
  | { ok: false; code: "remainder_below_minimum" | "part_too_small" | "too_many_open_sales" };

export function positionSale(p: { remaining: bigint; openParts: number }, bps: number, minStake: bigint): PositionSale {
  if (bps >= FULL) return { ok: true, full: true, sold: p.remaining, left: 0n };
  const split = partSale(p.remaining, bps, minStake);
  if (!split) return { ok: false, code: "part_too_small" };
  if (!split.allowed) return { ok: false, code: "remainder_below_minimum" };
  if (p.openParts >= MAX_OPEN_PARTS) return { ok: false, code: "too_many_open_sales" };
  return { ok: true, full: false, sold: split.sold, left: split.left };
}

/** The largest partial sale of one position allowed now, or null when only selling all is. */
export function positionMaxPartialBps(p: { remaining: bigint; openParts: number }, minStake: bigint): number | null {
  if (p.openParts >= MAX_OPEN_PARTS) return null;
  return maxPartialBps(p.remaining, minStake);
}

/**
 * A position in a holding: its address, what's left of it, its unsettled partial sales, and
 * whether it's the take author's buy-in (selling all of that closes the take).
 */
export type Held = { address: string; remaining: bigint; openParts: number; buyIn?: boolean };

/** What a holding's sale sells: whole positions, and at most one partial sale. */
export type HoldingPlan = { whole: string[]; part: { address: string; bps: number } | null; sold: bigint };

/**
 * Sells `bps` of a holding (one wallet's positions in one take, on one side): whole positions
 * first, smallest first, while they fit in the target (bps of what's left across them, rounded
 * down), then at most one partial sale of the next position that can take it. The author's
 * buy-in comes last and is never sold whole below 10,000 (at most a part of it): only selling all
 * of it closes the take. An error when no position can take the rest within the program's rules.
 */
export function planHoldingSale(held: Held[], bps: number, minStake: bigint): HoldingPlan | { error: "remainder_below_minimum" | "too_many_open_sales" | "part_too_small" } {
  const total = held.reduce((n, p) => n + p.remaining, 0n);
  const ordered = [...held].sort((a, b) =>
    Number(Boolean(a.buyIn)) - Number(Boolean(b.buyIn)) || (a.remaining < b.remaining ? -1 : a.remaining > b.remaining ? 1 : a.address.localeCompare(b.address)));
  if (bps >= FULL) return { whole: ordered.map((p) => p.address), part: null, sold: total };
  const target = (total * BigInt(bps)) / BPS_DENOMINATOR;
  if (target <= 0n) return { error: "part_too_small" };
  const whole: string[] = [];
  let sold = 0n;
  let i = 0;
  for (; i < ordered.length && !ordered[i].buyIn && sold + ordered[i].remaining <= target; i++) {
    whole.push(ordered[i].address);
    sold += ordered[i].remaining;
  }
  const left = target - sold;
  if (left === 0n) return { whole, part: null, sold };
  let error: "remainder_below_minimum" | "too_many_open_sales" | "part_too_small" = "remainder_below_minimum";
  for (const p of ordered.slice(i)) {
    const partBps = Math.min(FULL - 1, Math.max(1, Number((left * BPS_DENOMINATOR + p.remaining / 2n) / p.remaining)));
    const sale = positionSale(p, partBps, minStake);
    if (sale.ok) return { whole, part: { address: p.address, bps: partBps }, sold: sold + sale.sold };
    if (sale.code === "too_many_open_sales") error = "too_many_open_sales";
  }
  return { error };
}

/** The largest bps below 10,000 a holding's sale can take now, or null when only selling all is. */
export function holdingMaxPartialBps(held: Held[], minStake: bigint): number | null {
  for (let bps = FULL - 1; bps >= 1; bps--) if (!("error" in planHoldingSale(held, bps, minStake))) return bps;
  return null;
}

/** 422 `remainder_below_minimum`, with how much can be sold instead and the minimum. */
export function remainderError(maxBps: number | null, valueUsd: number, minStakeUsd: number): ApiError {
  const e = new ApiError(422, "remainder_below_minimum", `What's left must stay at least $${minStakeUsd}. Sell less, or sell all.`);
  e.body = {
    maxPartialBps: maxBps,
    maxPartialUsd: maxBps === null ? null : Math.floor(valueUsd * maxBps) / FULL,
    minStakeUsd,
  };
  return e;
}

/** The API error for a sale the program would refuse. */
export function saleError(code: "remainder_below_minimum" | "too_many_open_sales" | "part_too_small", maxBps: number | null, valueUsd: number, minStakeUsd: number): ApiError {
  if (code === "remainder_below_minimum") return remainderError(maxBps, valueUsd, minStakeUsd);
  if (code === "too_many_open_sales") return new ApiError(409, "too_many_open_sales", `${MAX_OPEN_PARTS} partial sales are still settling. Try again in a little while, or sell all.`);
  return new ApiError(422, "part_too_small", "That's too small a part to sell. Sell more.");
}
