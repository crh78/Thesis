// Scaled swap templates: one quote's swap reused at a nearby amount, so a trade sheet's builds at
// other amounts (chips, typed amounts) need no Jupiter call. Jupiter's exact-in route instruction
// carries the amounts as its last arguments (in_amount, quoted_out_amount); the route itself is a
// percentage split over pools, the same at any size. Rewriting those two numbers gives the same
// route at another size: the new input exactly (proof of trade wants the leg's exact part of the
// stake), the expected output scaled in proportion, and Jupiter's slippage limit applied on-chain
// to that. Pure, so it's unit-tested on recorded answers.
//
// Only safe when the price barely depends on the size: the quote moved the price less than
// SCALE_LIMITS.maxPriceImpactPct, the new amount is within SCALE_LIMITS' ratio of the quoted one,
// and scaling up can't fall more than maxShortfallPct short of the estimate (see SCALE_LIMITS), inside
// the 1% slippage. A fill worse than the slippage limit, or a pool that needs accounts the quote
// didn't name, fails the transaction's preflight: nothing is mistraded.
//
// Repriced: a route template kept for minutes (the fork API's long-lived routes) is reused at the
// token's price now. `priceFactor` is the price when the template was quoted over the price now
// (USD per token, both read from Jupiter's Price v3): the expected output moves by it, on top of
// the size scaling, so the pools' fees and the gap between Jupiter's price and the pools, measured
// by the template's own quote, carry over. Prices that moved more than maxPriceMovePct since aren't
// repriced (the caller quotes afresh): a move that big may have moved the pools' ticks too.
//
// Only layouts read with certainty are rewritten: Jupiter v6 `route` and `shared_accounts_route`,
// whose Borsh arguments end in in_amount u64, quoted_out_amount u64, slippage_bps u16,
// platform_fee_bps u8, and only when those read back exactly the quote's own numbers. Anything
// else (exact-out, route_v2, token ledgers, setup that isn't an idempotent account create, a
// cleanup) isn't scaled; the caller quotes afresh.
import type { JupSwapInstructions } from "./index.ts";
import { ASSOCIATED_TOKEN_PROGRAM } from "./index.ts";
import type { SwapLeg, SwapTemplate } from "./template.ts";

type JupIx = JupSwapInstructions["swapInstruction"];

/** Jupiter's v6 aggregator program (a public mainnet address). */
export const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"; // ggignore

/** Anchor discriminators (sha256("global:<name>")[..8]) of the exact-in routes read here. */
export const EXACT_IN_ROUTES: Record<string, string> = {
  e517cb977ae3ad2a: "route",
  c1209b3341d69c81: "shared_accounts_route",
};

/** in_amount u64 + quoted_out_amount u64 + slippage_bps u16 + platform_fee_bps u8. */
const TAIL = 19;

/**
 * When a quote may be scaled: its price impact (percent, as the bank reads Jupiter's fraction) at
 * most `maxPriceImpactPct`, the new input between `minRatio` and `maxRatio` times the quoted one,
 * and, scaling up, the estimated shortfall within `maxShortfallPct`. A bigger trade moves the
 * price more, so the proportional output overstates it by about impact x (ratio - 1); a smaller
 * one moves it less and gets at least the estimate. The swap keeps its 1% slippage, so a 0.5%
 * shortfall still leaves half of it for the price to move before the send; a worse fill fails at
 * preflight, never mistrades. A 0.02%-impact quote (a $20 leg in a deep pool) scales up to 10x, a
 * 0.16% one (MSFTx's Raydium CLMM pool for $5, on the owner's take) to ~4x. (Before: a fixed
 * 0.4x-2.5x missed $20 -> $50 on rounding; then a 0.1% impact cap failed the whole build on that one
 * thin leg.) `maxPriceMovePct`: the most a repriced template's price may have moved (see the header).
 */
export const SCALE_LIMITS = { maxPriceImpactPct: 0.5, minRatio: 0.1, maxRatio: 10, maxShortfallPct: 0.5, maxPriceMovePct: 3 };
export type ScaleLimits = typeof SCALE_LIMITS;

/** The amounts an exact-in route instruction carries, or null if it isn't one read here. */
export function routeAmounts(ix: JupIx): { name: string; inAmount: bigint; quotedOutAmount: bigint; slippageBps: number; platformFeeBps: number } | null {
  if (ix.programId !== JUPITER_V6_PROGRAM) return null;
  const data = Buffer.from(ix.data, "base64");
  // Discriminator, the route plan's length (u32) and at least the tail.
  if (data.length < 8 + 4 + TAIL) return null;
  const name = EXACT_IN_ROUTES[data.subarray(0, 8).toString("hex")];
  if (!name) return null;
  const at = data.length - TAIL;
  return {
    name,
    inAmount: data.readBigUInt64LE(at),
    quotedOutAmount: data.readBigUInt64LE(at + 8),
    slippageBps: data.readUInt16LE(at + 16),
    platformFeeBps: data.readUInt8(at + 18),
  };
}

/** Jupiter's minimum output for an exact-in quote: the output less its slippage, rounded in the output's favour (as its quotes do). */
export const minOut = (out: bigint, slippageBps: number) => out - (out * BigInt(slippageBps)) / 10_000n;

/** `priceFactor` as an exact fraction over PRICE_ONE, so a factor of 1 scales exactly as before. */
const PRICE_ONE = 1_000_000_000_000n;
const priceFraction = (f: number) => BigInt(Math.round(f * Number(PRICE_ONE)));

/**
 * Why `leg` can't be scaled to `inAmount` (and repriced by `priceFactor`: the template's price over
 * the price now), or null if it can (see the header).
 */
export function unscalable(leg: SwapLeg, inAmount: bigint, limits: ScaleLimits = SCALE_LIMITS, priceFactor = 1): string | null {
  const { res, quote } = leg;
  const q = quote;
  if (res.error) return `Jupiter answered an error: ${res.error}`;
  if (q.swapMode !== undefined && q.swapMode !== "ExactIn") return `the quote is ${q.swapMode}`;
  if (res.tokenLedgerInstruction) return "it uses a token ledger";
  if (res.cleanupInstruction) return "it has a cleanup instruction";
  if (res.setupInstructions.some((ix) => ix.programId !== ASSOCIATED_TOKEN_PROGRAM || ix.data !== "AQ==")) return "its setup does more than create token accounts";
  const r = routeAmounts(res.swapInstruction);
  if (!r) return "the swap isn't a route instruction read here";
  const quotedIn = BigInt(q.inAmount);
  const out = BigInt(q.outAmount);
  // The instruction's numbers must be the quote's, so the bytes rewritten are the amounts.
  if (r.inAmount !== quotedIn || r.quotedOutAmount !== out) return "the route's amounts aren't the quote's";
  if (q.slippageBps === undefined || r.slippageBps !== q.slippageBps) return "the route's slippage isn't the quote's";
  if (r.platformFeeBps !== (q.platformFee?.feeBps ?? 0)) return "the route's platform fee isn't the quote's";
  if (BigInt(q.otherAmountThreshold) !== minOut(out, r.slippageBps)) return "the quote's minimum isn't its output less slippage";
  const impact = q.priceImpactPct === undefined || q.priceImpactPct === "" ? NaN : Number(q.priceImpactPct) * 100;
  if (!Number.isFinite(impact)) return "the quote says no price impact";
  if (Math.abs(impact) > limits.maxPriceImpactPct) return `price impact ${impact.toFixed(3)}% is over ${limits.maxPriceImpactPct}%`;
  if (quotedIn <= 0n || out <= 0n || inAmount <= 0n) return "nothing to scale";
  const ratio = Number(inAmount) / Number(quotedIn);
  if (ratio < limits.minRatio || ratio > limits.maxRatio) return `${ratio.toFixed(2)}x the quoted amount is outside ${limits.minRatio}x-${limits.maxRatio}x`;
  const shortfall = Math.abs(impact) * Math.max(0, ratio - 1);
  if (shortfall > limits.maxShortfallPct) return `scaling ${ratio.toFixed(2)}x a ${impact.toFixed(3)}%-impact quote could fall ${shortfall.toFixed(3)}% short (over ${limits.maxShortfallPct}%)`;
  if (!Number.isFinite(priceFactor) || priceFactor <= 0) return "no price to reprice it at";
  const moved = Math.abs(1 / priceFactor - 1) * 100;
  if (moved > limits.maxPriceMovePct) return `the price moved ${moved.toFixed(2)}% since the quote (over ${limits.maxPriceMovePct}%)`;
  return null;
}

/**
 * `leg` (a template or one wallet's answer) at `inAmount` instead of its quoted input: the route
 * instruction's in_amount set to `inAmount`, its quoted_out_amount and the quote's output, minimum
 * and per-hop amounts scaled in proportion, and the outputs also by `priceFactor` (the template's
 * price over the price now; 1: not repriced). Accounts, programs, the route, slippage and every
 * other instruction stay as they are. Throws when unscalable says it can't be.
 */
export function scaleSwap<T extends SwapLeg>(leg: T, inAmount: bigint, limits: ScaleLimits = SCALE_LIMITS, priceFactor = 1): T {
  const why = unscalable(leg, inAmount, limits, priceFactor);
  if (why) throw new Error(`can't scale this swap: ${why}`);
  const quotedIn = BigInt(leg.quote.inAmount);
  const f = priceFraction(priceFactor);
  const scale = (n: bigint) => (n * inAmount) / quotedIn;
  // The output: in proportion to the input, then at the price now (rounded down).
  const scaleOut = (n: bigint) => (n * inAmount * f) / (quotedIn * PRICE_ONE);
  const out = scaleOut(BigInt(leg.quote.outAmount));
  const slippageBps = leg.quote.slippageBps!;
  const data = Buffer.from(leg.res.swapInstruction.data, "base64");
  data.writeBigUInt64LE(inAmount, data.length - TAIL);
  data.writeBigUInt64LE(out, data.length - TAIL + 8);
  const routePlan = leg.quote.routePlan?.map((hop) => {
    const info = hop.swapInfo as (typeof hop.swapInfo & { inAmount?: string; outAmount?: string }) | undefined;
    if (!info) return hop;
    return {
      ...hop,
      swapInfo: {
        ...info,
        ...(info.inAmount !== undefined ? { inAmount: String(scale(BigInt(info.inAmount))) } : {}),
        // Only the hops that deliver the bought token are repriced (informational: the route instruction carries none of these).
        ...(info.outAmount !== undefined ? { outAmount: String((info.outputMint === leg.quote.outputMint ? scaleOut : scale)(BigInt(info.outAmount))) } : {}),
      },
    };
  });
  return {
    ...leg,
    res: { ...leg.res, swapInstruction: { ...leg.res.swapInstruction, data: data.toString("base64") } },
    quote: {
      ...leg.quote,
      inAmount: String(inAmount),
      outAmount: String(out),
      otherAmountThreshold: String(minOut(out, slippageBps)),
      ...(routePlan ? { routePlan } : {}),
    },
  } as T;
}

/** A template at `inAmount` (scaleSwap), repriced by `priceFactor`, or null when it can't be scaled there. */
export function scaleTemplate(t: SwapTemplate, inAmount: bigint, limits: ScaleLimits = SCALE_LIMITS, priceFactor = 1): SwapTemplate | null {
  return unscalable(t, inAmount, limits, priceFactor) ? null : scaleSwap(t, inAmount, limits, priceFactor);
}
