import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import idl from "../idl/thesis.json" with { type: "json" };
import type { ConfigParams } from "./types.ts";

export const THESIS_PROGRAM_ID = new PublicKey(idl.address);

export const USDC_MINT_MAINNET = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDC_DECIMALS = 6;

/** Prices on-chain are u64 with 8 decimals (1 USD = 100_000_000). */
export const PRICE_DECIMALS = 8;

export const MAX_LEGS = 10;
export const BPS_DENOMINATOR = 10_000n;

/** Id of the author's own buy-in position, created with the take. Don't use it for other positions. */
export const AUTHOR_POSITION_ID = 0n;

export const SEEDS = {
  config: Buffer.from("config"),
  feeVault: Buffer.from("fee_vault"),
  creatorVault: Buffer.from("creator_vault"),
  escrowVault: Buffer.from("escrow_vault"),
  profile: Buffer.from("profile"),
  take: Buffer.from("take"),
  position: Buffer.from("position"),
  badge: Buffer.from("badge"),
  exit: Buffer.from("exit"),
  ticket: Buffer.from("ticket"),
} as const;

/** Jupiter's swap aggregator (v6), whose route instructions buy spot legs. */
export const JUPITER_AGGREGATOR_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
/** Jupiter Lend Earn, whose deposits fill yield legs. */
export const JUPITER_LEND_EARN_PROGRAM_ID = new PublicKey("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");

/** Most programs the config's trade allowlist can hold. */
export const MAX_TRADE_PROGRAMS = 8;

/** Phoenix perps (perp legs, fade shorts) and Ember (USDC ↔ Phoenix's PhUSD). docs/phoenix-plan.md. */
export const PHOENIX_PROGRAM_ID = new PublicKey("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih");
export const EMBER_PROGRAM_ID = new PublicKey("EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy");

/**
 * Programs a trade may call between `begin_trade` and the receipt (stored in the config, changed
 * by the allowlist admin with `update_allowlist`): Jupiter, Jupiter Lend, Compute Budget,
 * Associated Token (account creates), Phoenix and Ember. Never the Token programs or System, so
 * the stake can't leave in a plain transfer; the program refuses them. Inside a trade the program
 * lets Phoenix run only its deposit, order and registration instructions, and Ember only deposit.
 */
export const DEFAULT_TRADE_PROGRAMS: PublicKey[] = [
  JUPITER_AGGREGATOR_PROGRAM_ID,
  JUPITER_LEND_EARN_PROGRAM_ID,
  ComputeBudgetProgram.programId,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PHOENIX_PROGRAM_ID,
  EMBER_PROGRAM_ID,
];

const HOUR = 3_600;
const DAY = 24 * HOUR;

/**
 * How long a take runs if its author never sells: it auto-settles this long after posting, as if
 * sold at that day's prices. The author's own sale closes and settles it sooner. Clients pass
 * `horizonEnd = posting + TAKE_LIFETIME_SECS` to `create_take` (the config's horizon window
 * allows a day either side).
 */
export const TAKE_LIFETIME_SECS = 365 * DAY;

/**
 * Launch values for `init_config`, as decided in docs/onchain-plan.md. Price delay is a
 * proposed default.
 */
export const DEFAULT_CONFIG_PARAMS: ConfigParams = {
  feeBps: 10,
  creatorFeeBps: 5,
  minStake: new BN(10 * 10 ** USDC_DECIMALS),
  maxLegs: MAX_LEGS,
  // Every take runs a year (TAKE_LIFETIME_SECS); a day either side covers clock skew and the
  // time between building a take and its receipt landing.
  minHorizonSecs: new BN(TAKE_LIFETIME_SECS - DAY),
  maxHorizonSecs: new BN(TAKE_LIFETIME_SECS + DAY),
  // Long enough to cover a weekend plus a holiday for stock feeds.
  maxPriceDelaySecs: new BN(4 * DAY),
  creatorBoostBps: 0,
  paused: false,
};

/**
 * Compute units to budget for each Thesis instruction, about 10% above the worst case measured by
 * `anchor/programs/thesis/tests/test_compute.rs` (which fails CI if an instruction outgrows it).
 * Add these to the venue instructions' own units when setting a transaction's compute limit:
 * a tight limit costs less in priority fees and lands sooner than the 200k-per-instruction default.
 */
export const THESIS_COMPUTE_UNITS = {
  beginTrade: 19_500,
  tradeStep: 9_800,
  cancelTrade: 6_000,
  createTake: 65_600,
  back: 57_500,
  fade: 55_800,
  claimCreatorFees: 14_600,
  // Price records cost more with more legs: these are the 10-leg ceilings (test_compute.rs), so
  // any take fits. A 3-leg budget ran out on a 4-leg take on the fork.
  recordEntryPrices: 13_400,
  recordExitPrices: 18_000,
  recordSalePrices: 18_000,
  // The author's sale (it closes the take: one more event), and a closed 10-leg take settling on
  // its sale prices: the worst cases.
  exitPosition: 37_300,
  settleTake: 19_700,
  settlePosition: 22_900,
  mintBadge: 90_000,
} as const;
