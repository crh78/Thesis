// The asset bank's Gemini contracts: kept between polls so a leg can still be priced right after its
// contract stops trading, and looked up by the 32-byte leg id a take records on-chain.
import { predictionIdHex, type GeminiContract, type GeminiSide } from "../../gemini/src/markets.ts";
import type { BankState } from "./state.ts";

/** Contracts that stopped trading are kept this long after their expiry (entries still get priced). */
export const KEEP_EXPIRED_MS = 7 * 24 * 60 * 60_000;

/** This poll's contracts, plus earlier ones it no longer lists until a week after they expire. */
export function mergeGeminiContracts(
  previous: Record<string, GeminiContract>,
  fresh: GeminiContract[],
  nowMs: number,
): Record<string, GeminiContract> {
  const out: Record<string, GeminiContract> = {};
  for (const [sym, c] of Object.entries(previous)) {
    const expiry = c.expiry ? Date.parse(c.expiry) : NaN;
    if (Number.isFinite(expiry) && expiry + KEEP_EXPIRED_MS > nowMs) out[sym] = c;
  }
  for (const c of fresh) out[c.instrumentSymbol] = c;
  return out;
}

export type PredictionLeg = { contract: GeminiContract; side: GeminiSide };

const indexes = new WeakMap<object, Map<string, PredictionLeg>>();

/** The contract and side a leg id (hex) names, from the bank's contracts. Built once per poll. */
export function predictionLeg(state: Pick<BankState, "venues">, idHex: string): PredictionLeg | null {
  const g = state.venues.gemini;
  if (!g?.contracts) return null;
  let index = indexes.get(g.contracts);
  if (!index) {
    index = new Map();
    for (const c of Object.values(g.contracts)) {
      for (const side of ["yes", "no"] as const) index.set(predictionIdHex(c.instrumentSymbol, side), { contract: c, side });
    }
    indexes.set(g.contracts, index);
  }
  return index.get(idHex) ?? null;
}
