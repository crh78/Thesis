import { sha256 } from "@noble/hashes/sha2";
import { BPS_DENOMINATOR, USDC_DECIMALS } from "./constants.ts";

/** Parses a decimal USDC amount ("10", "10.5") into base units without floating point. */
export function usdcToBaseUnits(amount: string): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || frac.length > USDC_DECIMALS) {
    throw new Error(`Invalid USDC amount: ${amount}`);
  }
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, "0"));
}

/** Bitmask of included legs (bit i = leg i), for back and fade. */
export function legsMask(legIndices: number[]): number {
  return legIndices.reduce((mask, i) => {
    if (!Number.isInteger(i) || i < 0 || i > 15) throw new Error(`Invalid leg index: ${i}`);
    return mask | (1 << i);
  }, 0);
}

/** sha256 of the claim text, stored on the take. The text itself lives off-chain. */
export function claimHash(text: string): number[] {
  return [...sha256(new TextEncoder().encode(text))];
}

/**
 * How a stake's fee splits, mirroring the program: fee and creator share are each rounded down
 * from the stake, and the platform keeps the rest. The creator share applies to every back and
 * fade by someone other than the author (the platform keeps the whole fee on the author's own stake).
 */
export function splitFee(
  stake: bigint,
  params: { feeBps: number; creatorFeeBps: number },
  opts: { isAuthor: boolean },
): { fee: bigint; creator: bigint; platform: bigint } {
  const fee = (stake * BigInt(params.feeBps)) / BPS_DENOMINATOR;
  const creator =
    opts.isAuthor ? 0n : (stake * BigInt(params.creatorFeeBps)) / BPS_DENOMINATOR;
  return { fee, creator, platform: fee - creator };
}

type LegForReturn = { kind: object; weightBps: number; leverage: number };

/**
 * A position's return in bps from entry and exit prices, mirroring `position_return_bps` in the
 * program: spot, perp, card and yield legs move by leverage × (exit / entry − 1) (a yield leg's
 * price is one vault share's value, so that's its interest); a prediction
 * "Yes" by exit / entry − 1; a fade takes the other side ((1 − exit) / (1 − entry) − 1 for "No");
 * no leg loses more than 100%. Prices are on-chain units (8 decimals). Pass
 * current prices as `exit` for a live return. Null if a needed price is missing.
 */
export function positionReturnBps(
  legs: LegForReturn[],
  p: { side: object; legsMask: number; prices: { entry: bigint; exit: bigint }[] },
): number | null {
  const fade = "fade" in p.side;
  const one = 100_000_000n;
  let weighted = 0n;
  let total = 0n;
  for (const [i, leg] of legs.entries()) {
    if (!(p.legsMask & (1 << i))) continue;
    const weight = BigInt(leg.weightBps);
    total += weight;
    const kind = Object.keys(leg.kind)[0];
    const { entry, exit } = p.prices[i] ?? { entry: 0n, exit: 0n };
    if (entry <= 0n || (kind === "prediction" && fade && entry >= one)) return null;
    const lev = BigInt(leg.leverage);
    let move: bigint;
    if (kind === "prediction") move = fade ? ((entry - exit) * BPS_DENOMINATOR) / (one - entry) : ((exit - entry) * BPS_DENOMINATOR) / entry;
    else move = fade ? (lev * (entry - exit) * BPS_DENOMINATOR) / entry : (lev * (exit - entry) * BPS_DENOMINATOR) / entry;
    if (move < -BPS_DENOMINATOR) move = -BPS_DENOMINATOR;
    weighted += move * weight;
  }
  return total === 0n ? 0 : Number(weighted / total);
}
