// Types, errors and small helpers shared by the fork API's modules.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";
import type { TakeAccount } from "@thesis/chain";
import type { EntryBasis, StockSource } from "@thesis/executor/settler";
import type { BankState } from "@thesis/venues/bank";
import type { LiveContracts } from "./gemini-live.ts";
import type { PhoenixOpts, PhoenixPositions } from "./phoenix.ts";
import type { AppLeg, CatalogName } from "./legs.ts";

export class ApiError extends Error {
  status: number;
  code: string;
  /** Extra response headers (Retry-After on 429 and 503). */
  headers?: Record<string, string>;
  /** Extra fields in the error's JSON body, next to `error` and `message` (e.g. `incomplete`). */
  body?: Record<string, unknown>;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export type AppTake = {
  id: string;
  claim: string;
  risk: "low" | "medium" | "high";
  settles_at: string;
  /** "posting" until the author's on-chain buy-in confirms (supabase/migrations/*_post_after_chain.sql). */
  status?: "posting" | "live";
  topic?: string;
  author: { handle?: string; name?: string } | null;
  /** The author's wallet (take_for_chain): set for a take a real user posted, null for a seeded demo take. */
  author_wallet?: string | null;
  legs: AppLeg[];
};

export type TakeSource = (id: string) => Promise<AppTake | null>;

/** `v`: demo mirrors made before `MIRROR_VERSION` are made again on their next trade. */
export type Mirror = {
  address: string;
  author: string;
  demoAuthorKey?: number[];
  mirroredAt: string;
  v?: number;
  /** An app take its author published: the transactions that put it on-chain, to relay again. */
  signatures?: string[];
};
export type ChainActivity = { kind: string; usd: number; at: string; takeId: string | null; signature: string };
export type CashEntry = { wallet: string; kind: "deposit" | "withdrawal"; usd: number; at: string };
/** A wallet's total (USDC plus what its positions are worth) at `at` (unix s), and its net deposits by then. */
export type Snapshot = { at: number; value: number; netIn: number };
/**
 * The last daily digest per wallet: its day, what the positions were worth then, and the stake
 * still held behind that value (after partial sales; missing on older marks).
 */
export type DigestMark = { day: string; valueUsd: number; stakeUsd?: number };
/** A sale this service submitted, kept so the receipt still shows it after its position settles and closes. */
/** A sale this service submitted. `side` is missing on sales recorded before fades could be sold (all backs). */
export type ExitReceipt = { horizonEnd: number; owner: string; side?: "back" | "fade"; stakeUsd: number; costUsd: number; openedAt: number; legsMask: number; exitedAt?: number };
/** Everything the fork API keeps between restarts (`.data/fork/api-state.json`). */
export type State = {
  forkId: string;
  takes: Record<string, Mirror>;
  cash: CashEntry[];
  openingTransactions?: Record<string, string[]>;
  exits?: Record<string, Record<string, ExitReceipt>>;
  history?: Record<string, Snapshot[]>;
  digests?: Record<string, DigestMark>;
  /** Which Phoenix child subaccount each perp leg or short of each position trades in (api/phoenix.ts). */
  phoenix?: PhoenixPositions;
  /** Split trades that stopped partway, by position (api/split.ts). */
  incomplete?: Record<string, IncompleteTrade>;
  /** Sales over several transactions that stopped partway, by the position their last record sells (api/sales.ts). */
  stoppedSales?: Record<string, StoppedSale>;
  /** Recent submits by build id, so GET /submissions and repeats still answer after a restart. */
  submissions?: Record<string, SavedSubmission>;
};

/**
 * A submit as the state file keeps it (ten minutes): enough to tell its status after a restart
 * from its transactions on-chain, and, for a back or publish that landed, to record its opening
 * transactions.
 */
export type SavedSubmission = {
  owner: string;
  kind: string;
  digest: string;
  signatures: string[];
  status: "pending" | "landed" | "failed" | "incomplete";
  at: number;
  /** The last block height its transactions can land at. */
  lastValid: number;
  error?: { status: number; code: string; message: string; body?: Record<string, unknown> };
  /** A back or publish: the position it opens, its take, and the app take a publish posts. */
  position?: string;
  take?: string;
  publishTakeId?: string;
};

/**
 * A split trade (create_take, back or fade over several transactions) whose later transaction
 * failed after an earlier one landed: the owner holds what the landed part bought, the position's
 * trade ticket is still open, and no position exists yet. See api/split.ts.
 */
export type IncompleteTrade = {
  owner: string;
  /** The on-chain take, and the app take's id. */
  take: string;
  takeId: string;
  kind: "back" | "publish";
  side: "back" | "fade";
  usd: number;
  /** Take legs the receipt opens (its legs mask). */
  included: number[];
  /** Take legs whose venue legs all sat in transactions that didn't land: what a retry builds again. */
  remaining: number[];
  /** Take legs bought on Jupiter Lend (their tokens are vault shares: a sweep redeems them). */
  lend: number[];
  /** The receipt instruction as first built: a retry sends the same one. */
  receipt: { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
  receiptCu: number;
  /** Signatures of the transactions that landed, oldest first (the position's opening transactions). */
  signatures: string[];
  /** "retry" until the one retry fails (or can't be built); then "sweep". */
  next: "retry" | "sweep";
  /** Legs a partly landed sweep already sold back (not sold again). */
  swept?: number[];
  /** Publishing an app take: its id. */
  publishTakeId?: string;
  /** When it stopped (ms). */
  at: number;
};

/** One step of a sale build, as a stopped sale remembers what its transactions carried (api/sales.ts). */
export type SaleStep =
  | { kind: "phoenix"; position: string; leg: number }
  | { kind: "sell"; mint: string; amount: string }
  | { kind: "redeem"; mint: string; amount: string }
  | { kind: "record"; position: string };

/**
 * A sale over several transactions (swaps first, the positions' records last) that stopped after
 * some of them went out. Selling any of its positions again finishes it instead of starting a new
 * sale: what didn't land, at the same sizes (api/sales.ts).
 */
export type StoppedSale = {
  owner: string;
  take: string;
  takeId: string;
  /** Each position it sells: its partial sale's seq (or all of it), with the receipt of a whole sale. */
  sales: { address: string; seq: number; full: boolean; horizonEnd: number; bps?: number; exit?: ExitReceipt }[];
  /** Each position's record instruction (exit_position or sell_part) as built, and its compute. */
  records: { position: string; ix: IncompleteTrade["receipt"]; cu: number }[];
  /** Every transaction of its last attempt: its id, the last block it can land at, and what it carried. */
  txs: { signature: string; lastValid: number; steps: SaleStep[] }[];
  /** What the sale's build answered (bps, sizes, proceeds), answered again by the build that finishes it. */
  summary: Record<string, unknown>;
  at: number;
};

export type ServiceOpts = {
  connection: Connection;
  appPayer: Keypair;
  lookupTable: PublicKey | null;
  bank: () => BankState;
  takes: TakeSource;
  stocks: StockSource | null;
  /** The asset bank's prices file (api/valuation.ts): default next to its file sink; null: none (tests). */
  pricesFile?: string | null;
  /**
   * Each position leg's entry basis, from the settler's audit log: live marks use the same source
   * as the entry (the token the owner bought, or the stock), so a return compares like with like.
   */
  bases: { get(position: string, leg: number): EntryBasis | null } | null;
  /**
   * Live reads of the Gemini events a request touches (trades need one; receipts and marks fall
   * back to the bank's copy, which is swept every 6 hours). Null: the bank's copy only (tests).
   */
  gemini?: LiveContracts | null;
  /** The take builder's catalog: resolves the names the AI writes ("Advanced Micro Devices"). */
  catalog?: CatalogName[];
  jupiterApiKey: string | null;
  /** The only Jupiter venues to route through (the fork's state-based AMMs, FORK_DEXES). */
  dexes?: string[];
  statePath: string;
  /** Fork cheatcodes, injected so tests can stub them. */
  fork: {
    addUsdc(wallet: PublicKey, usd: number): Promise<bigint>;
    setUsdc(wallet: PublicKey, baseUnits: bigint): Promise<void>;
    /** `freshMs`: leave accounts refreshed less than that long ago (lib.ts refreshMarkets). */
    refreshMarkets(accounts: PublicKey[], o?: { freshMs?: number }): Promise<unknown>;
    /** After a send: these accounts moved on the fork, so the next refresh copies them again (lib.ts). */
    forgetFresh?(accounts: PublicKey[]): void;
    /** Brings the fork's clock up to wall time; given, the service runs it every CLOCK_SYNC_MS. */
    syncClock?(): Promise<unknown>;
  };
  log?: (m: string) => void;
  /** Phoenix perps (perp legs and fade shorts). Unset: those legs are left out with the reason. */
  phoenix?: PhoenixOpts | null;
  /**
   * Delivers confirmed transactions' Thesis events to the backend webhook, as the Stream relay
   * would (its takeCreated is what makes a posting app take live). Returns how many it delivered.
   * Unset: nothing is relayed here, and `pnpm fork:relay` has to deliver them.
   */
  relay?: (signatures: string[]) => Promise<number>;
};

/** USDC base units per dollar. */
export const USD = 1_000_000;
export const MIN_STAKE_USD = 10;
/** 2: the author's buy-in records only the legs it bought (create_take's legs_mask). */
export const MIRROR_VERSION = 2;
export const staleDemo = (m: Mirror | undefined) => Boolean(m?.demoAuthorKey) && m!.v !== MIRROR_VERSION;

export const FADE_NOTHING = "None of this take's legs can be faded right now: a prediction leg needs a market on its other side, and other legs need a Phoenix market to short.";
export const FADE_NO_MARKET = "Gemini has no market on the other side of this take's prediction legs right now. Try again in a moment.";
export const FADE_OWN_TAKE = "You can't fade your own take.";
export const TAKE_CLOSED = "This take has closed: its author sold. Positions already in it stay open until their owners sell.";
export const TAKE_ENDED = "This take has reached its end: positions settle at today's prices.";

/** A take's status as the receipt shows it: "closed" once its author sold, until it settles. */
export const takeStatusName = (take: TakeAccount): "open" | "closed" | "settled" =>
  "settled" in take.status ? "settled" : "closed" in take.status ? "closed" : "open";

/** Open to new backs and fades: not closed by its author's sale, and before its horizon. */
export const takeOpen = (take: TakeAccount, nowSec = Date.now() / 1000) => "open" in take.status && take.horizonEnd.toNumber() > nowSec;

/** The 409 a back or fade gets on a take that isn't open. */
export const takeClosedError = (take: TakeAccount | null | undefined) =>
  new ApiError(409, "take_closed", take && "open" in take.status ? TAKE_ENDED : TAKE_CLOSED);
export const TAKE_MISSING = "This take was posted on an earlier version of the fork, so it can't be traded here. Its author can post it as a new take.";
export const FADE_BLOCKED = "None of this take's legs can be faded: a fade holds the other side of prediction legs, or a Phoenix short of stock and crypto legs Phoenix lists";

/**
 * Legs a sale can unwind on the fork: Jupiter swaps back to USDC, Jupiter Lend redeems, Phoenix
 * closes (perp legs, and fades' shorts), and prediction legs (paper: the sale pays their escrow back).
 */
export const SELLABLE = (kind: object) => "spot" in kind || "yield" in kind || "prediction" in kind || "card" in kind || "perp" in kind;

/** Underlying ids (hex) of the legs a position holds. */
export const legAssets = (take: TakeAccount, legsMask: number) =>
  new Set(take.legs.flatMap((leg, i) => (legsMask & (1 << i) ? [leg.asset.toBuffer().toString("hex")] : [])));

export const DEFAULT_STATE_PATH = (dataDir: string) => join(dataDir, "api-state.json");

/** Runs `fn`, and once more after a short pause if it fails. */
export async function once<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return fn();
  }
}

export function parseKey(s: string): PublicKey {
  try {
    return new PublicKey(s);
  } catch {
    throw new ApiError(400, "invalid_wallet");
  }
}

export function checkAmount(usd: number, min = MIN_STAKE_USD) {
  if (!Number.isFinite(usd) || usd < min || !Number.isSafeInteger(Math.round(usd * USD)) || Number(usd.toFixed(2)) !== usd) throw new ApiError(400, "invalid_amount", `At least $${min}, in cents`);
}

/** A random nonzero u64 below 2^53 (0 is the author's buy-in). */
export const randomPositionId = () => 1n + (randomBytes(8).readBigUInt64LE() % (2n ** 53n - 1n));

/**
 * Where one request's time went: each step's milliseconds (a step that runs twice adds up) and
 * short notes ("quotes": "hit"). Every build, refresh and submit logs it (`line`) and sends it as
 * a `Server-Timing` header (`header`). Routing may fill in its own steps and set `quotedAt`
 * earlier than the build (a quote it reused).
 */
export class Timings {
  readonly started: number;
  #steps = new Map<string, number>();
  #notes = new Map<string, string>();
  #now: () => number;
  /** When the oldest quote in the build was made (unix ms), if it has quotes. */
  quotedAt?: number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.started = now();
  }

  /** Adds `ms` to step `name`. */
  add(name: string, ms: number) {
    this.#steps.set(name, (this.#steps.get(name) ?? 0) + Math.max(0, Math.round(ms)));
  }

  /** Runs `work` and adds how long it took to step `name`, whether it succeeds or throws. */
  async time<T>(name: string, work: () => Promise<T>): Promise<T> {
    const t = this.#now();
    try {
      return await work();
    } finally {
      this.add(name, this.#now() - t);
    }
  }

  note(name: string, value: string | number) {
    this.#notes.set(name, String(value));
  }

  /** Each step's milliseconds, in the order they first ran. */
  get steps(): Record<string, number> {
    return Object.fromEntries(this.#steps);
  }

  /** `Server-Timing`: each step as `name;dur=ms`, each note as `name;desc="…"`, then `total`. */
  header(): string {
    const token = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, "-");
    return [
      ...[...this.#steps].map(([k, ms]) => `${token(k)};dur=${ms}`),
      ...[...this.#notes].map(([k, v]) => `${token(k)};desc="${v.replace(/["\\\r\n]/g, "")}"`),
      `total;dur=${this.#now() - this.started}`,
    ].join(", ");
  }

  /** For the log: "1234 ms: funds 12, mirror 0, legs 800 (quotes hit)". */
  line(): string {
    const notes = [...this.#notes].map(([k, v]) => `${k} ${v}`).join(", ");
    const steps = [...this.#steps].map(([k, ms]) => `${k} ${ms}`).join(", ");
    return `${this.#now() - this.started} ms${steps ? `: ${steps}` : ""}${notes ? ` (${notes})` : ""}`;
  }
}

/** At most this many client marks are logged per submit, each name at most 40 characters. */
const CLIENT_MARKS = 24;

/**
 * A submit's `timings` (the client's marks, ms relative to the tap) as one log line, or null if
 * there are none. Only finite numbers under plain names are kept: they go to the log as they are.
 */
export function clientMarks(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const marks = Object.entries(raw as Record<string, unknown>)
    .filter(([k, v]) => /^[A-Za-z0-9_.:-]{1,40}$/.test(k) && typeof v === "number" && Number.isFinite(v))
    .slice(0, CLIENT_MARKS)
    .map(([k, v]) => `${k} ${Math.round(v as number)}`);
  return marks.length ? marks.join(", ") : null;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet), as Solana writes signatures. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function errorText(e: unknown): string {
  const logs: string[] = (e as { logs?: string[] })?.logs ?? [];
  // An Anchor error names itself; otherwise the first program that failed and what it logged last.
  const anchor = logs.find((l) => l.includes("Error Code:"));
  if (anchor) return anchor;
  const failed = logs.findIndex((l) => / failed: /.test(l));
  if (failed >= 0) return [[...logs.slice(0, failed)].reverse().find((l) => l.startsWith("Program log:")), logs[failed]].filter(Boolean).join(" / ");
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
