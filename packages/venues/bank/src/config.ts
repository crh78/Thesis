// Poller cadences and limits, each overridable by an environment variable
// (process env first, then the repo-root .env).
import { envVar } from "../../registry/src/lib/env.ts";

export type BankConfig = {
  discoveryMs: number;
  pricesMs: number;
  probeTickMs: number;
  probeTtlMs: number;
  unroutedTtlMs: number;
  phoenixMs: number;
  /** Gap between the Phoenix sweep's reads, one at a time, so it stays under Phoenix's rate limit. */
  phoenixGapMs: number;
  geminiMs: number;
  cardsMs: number;
  yieldMs: number;
  flushMs: number;
  /** Jupiter requests per minute the poller may use (shared by tokens, prices and quotes). */
  jupiterRpm: number;
  quoteFloorUsd: number;
  maxAccounts: number;
  probeSizesUsd: [number, number];
  tradeableCostPct: number;
  maxDeviationPct: number;
  cardsMaxPages: number;
  /** Picked cards (card legs) re-read per cards run, new ones first, then the stalest (cards.ts). */
  cardsMaxReads: number;
  /** Tokens missing from discovery this long are dropped. */
  dropAfterMs: number;
  freshness: { maxProbeAgeMs: number; maxPriceAgeMs: number; maxVenueAgeMs: number; maxGeminiAgeMs: number };
};

const MIN = 60_000;

/** Every knob, its env var and default. Documented in bank/README.md. */
export const CONFIG_ENV = {
  discoveryMs: ["ASSET_BANK_DISCOVERY_MIN", 60, MIN],
  pricesMs: ["ASSET_BANK_PRICES_SEC", 90, 1000],
  probeTickMs: ["ASSET_BANK_PROBE_TICK_SEC", 60, 1000],
  probeTtlMs: ["ASSET_BANK_PROBE_TTL_MIN", 7.5, MIN],
  unroutedTtlMs: ["ASSET_BANK_UNROUTED_TTL_MIN", 60, MIN],
  phoenixMs: ["ASSET_BANK_PHOENIX_MIN", 10, MIN],
  // Phoenix allows an address about one read every two seconds, and the fork API prices trades
  // from the same address. A burst of ~110 book reads got every read refused (429) for about 95
  // seconds, so fades built then failed. One read every 4 s takes about
  // 7.5 of the 10 minutes and leaves half the allowance free.
  phoenixGapMs: ["ASSET_BANK_PHOENIX_GAP_SEC", 4, 1000],
  // A full Gemini sweep is ~30 reads and ~4 MB of Supabase egress, so it runs every
  // 6 hours; trades, receipts and the settler read their one event live (docs/gemini-plan.md).
  geminiMs: ["ASSET_BANK_GEMINI_MIN", 360, MIN],
  cardsMs: ["ASSET_BANK_CARDS_MIN", 15, MIN],
  yieldMs: ["ASSET_BANK_YIELD_MIN", 15, MIN],
  flushMs: ["ASSET_BANK_FLUSH_SEC", 15, 1000],
  jupiterRpm: ["ASSET_BANK_JUPITER_RPM", 45, 1],
  quoteFloorUsd: ["ASSET_BANK_QUOTE_FLOOR_USD", 100, 1],
  maxAccounts: ["ASSET_BANK_MAX_ACCOUNTS", 30, 1],
  tradeableCostPct: ["ASSET_BANK_TRADEABLE_COST_PCT", 1, 1],
  maxDeviationPct: ["ASSET_BANK_MAX_DEVIATION_PCT", 5, 1],
  cardsMaxPages: ["ASSET_BANK_CARDS_MAX_PAGES", 20, 1],
  cardsMaxReads: ["ASSET_BANK_CARDS_MAX_READS", 60, 1],
  dropAfterMs: ["ASSET_BANK_DROP_AFTER_HOURS", 24, 60 * MIN],
} as const satisfies Partial<Record<keyof BankConfig, readonly [string, number, number]>>;

export const FRESHNESS_ENV = {
  maxProbeAgeMs: ["ASSET_BANK_MAX_PROBE_AGE_MIN", 20, MIN],
  maxPriceAgeMs: ["ASSET_BANK_MAX_PRICE_AGE_MIN", 10, MIN],
  maxVenueAgeMs: ["ASSET_BANK_MAX_VENUE_AGE_MIN", 45, MIN],
  // Gemini is swept every 6 hours: its contracts count as current for two sweeps and a margin.
  maxGeminiAgeMs: ["ASSET_BANK_MAX_GEMINI_AGE_MIN", 780, MIN],
} as const;

function num(name: string, dflt: number, get: (k: string) => string | null): number {
  const raw = get(name);
  if (raw === null) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

export function loadBankConfig(get: (k: string) => string | null = envVar): BankConfig {
  const out: Record<string, unknown> = {};
  for (const [k, [name, dflt, unit]] of Object.entries(CONFIG_ENV)) out[k] = num(name, dflt, get) * unit;
  const freshness: Record<string, number> = {};
  for (const [k, [name, dflt, unit]] of Object.entries(FRESHNESS_ENV)) freshness[k] = num(name, dflt, get) * unit;
  return { ...(out as Omit<BankConfig, "probeSizesUsd" | "freshness">), probeSizesUsd: [100, 1000], freshness: freshness as BankConfig["freshness"] };
}
