// Shared test helpers: the recorded fixture as a bank state, and a quote function
// that replays recorded Jupiter quotes. No network.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { QuoteFn } from "../src/jupiter.ts";
import { emptyState, type BankState, type TokenEntry, type UnderlyingEntry } from "../src/state.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = JSON.parse(readFileSync(join(here, "fixtures", "live.json"), "utf8")) as {
  recordedAt: string;
  underlyings: Record<string, UnderlyingEntry>;
  tokens: Record<string, TokenEntry>;
  quotes: Record<string, Record<string, { quote: any; error: string | null }>>;
};

/** When the fixture was recorded; tests use it as "now". */
export const NOW = Date.parse(fixture.recordedAt);

/** A fresh deep copy of the fixture as a bank state, with every price and probe stamped `ageMs` before NOW. */
export function fixtureState(ageMs = 60_000): BankState {
  const s = emptyState(new Date(NOW));
  const at = new Date(NOW - ageMs).toISOString();
  s.tokens = structuredClone(fixture.tokens);
  s.underlyings = structuredClone(fixture.underlyings);
  for (const t of Object.values(s.tokens)) {
    if (t.price) t.price.at = at;
    if (t.probe) t.probe.at = at;
  }
  return s;
}

export const bySymbol = (s: BankState, symbol: string) => {
  const t = Object.values(s.tokens).find((x) => x.symbol === symbol);
  if (!t) throw new Error(`no ${symbol} in fixture`);
  return t;
};

/** Replays recorded quotes; sizes that were not recorded fail like a missing route. */
export const fixtureQuote: QuoteFn = async (mint, usd) => {
  const r = fixture.quotes[mint]?.[String(usd)];
  return r ? structuredClone(r) : { quote: null, error: "not recorded" };
};

export function manualClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}
