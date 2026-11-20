// What the app needs from the fork, as plain methods (server.ts puts HTTP in front):
//
//   receipt     a take's on-chain receipt: counters, legs, live return, the viewer's positions
//   buildTrade  the transactions for a back (Jupiter swaps + Jupiter Lend + receipt), unsigned,
//               for the user's Privy wallet to sign
//   buildPublish the same for posting an app take on-chain with the author's buy-in
//   submit      adds the app fee payer's signature to transactions this service built and sends them
//   buildPhoenixCashOut  closes Phoenix positions left after a sale or the horizon, or sweeps the
//               cash left in Phoenix back to USDC (api/phoenix.ts)
//   buildRetry / buildSweep  a split trade that stopped partway: build the rest once more, or sell
//               what the landed part bought back to USDC (api/split.ts)
//   wallet / deposit / withdraw   fake USDC on the fork, and on-chain holdings
//
// Takes live in Supabase (ids are UUIDs); their on-chain twins and the fork-only keys of demo
// authors are kept in .data/fork/api-state.json. Demo takes are mirrored on first trade.
//
// The parts with their own state live next door: store.ts (the state file), valuation.ts
// (prices and position values), routing.ts (which legs can be bought), history.ts (portfolio
// charts), wallets.ts (cash and activity) and digests.ts (daily notifications).
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import BN from "bn.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import {
  BADGE_KIND_INDEX,
  BADGE_META,
  RISK,
  TAKE_LIFETIME_SECS,
  THESIS_COMPUTE_UNITS,
  USDC_MINT_MAINNET,
  agreeSide,
  backIx,
  chainSide,
  cancelTradeIx,
  fadeIx,
  badgeMintAddress,
  claimHash,
  composeTransactions,
  createTakeIx,
  exitAddress,
  exitPositionIx,
  partSaleAddress,
  sellPartIx,
  fetchConfig,
  positionAddress,
  positionReturnBps,
  splitFee,
  takeAddress,
  thesisProgram,
  ticketAddress,
  type PartSaleAccount,
  type PositionAccount,
  type TakeAccount,
  type ThesisProgram,
} from "@thesis/chain";
import { cardLeg, underlyingIdHex, type BankState } from "@thesis/venues/bank";
import { cardIdHex } from "@thesis/venues/collector-crypt";
import { otherSide } from "@thesis/venues/gemini";
import { jupiterBuy, jupiterLendRedeem, type JupiterBuy, type VenueLeg } from "@thesis/venues/jupiter";
import { PERP_ASSET_MAP, PHOENIX_LEG_CU, PHOENIX_PROGRAM_ID } from "@thesis/venues/phoenix";
import {
  ApiError,
  base58,
  FADE_BLOCKED,
  FADE_NO_MARKET,
  FADE_OWN_TAKE,
  TAKE_CLOSED,
  TAKE_ENDED,
  TAKE_MISSING,
  FADE_NOTHING,
  AGAINST_INVERTED_NOTHING,
  INVERTED_NOTHING,
  INVERTED_NOT_FADEABLE,
  MIRROR_VERSION,
  SELLABLE,
  USD,
  checkAmount,
  errorText,
  legAssets,
  parseKey,
  randomPositionId,
  refusedError,
  staleDemo,
  takeClosedError,
  takeOpen,
  takeStatusName,
  Timings,
  clientMarks,
  type AppTake,
  type ExitReceipt,
  type IncompleteTrade,
  type SaleStep,
  type SavedSubmission,
  type ServiceOpts,
  type StoppedSale,
} from "./common.ts";
import { CreatorFees } from "./creator-fees.ts";
import { dailyDigests } from "./digests.ts";
import { PortfolioHistory } from "./history.ts";
import { contractResolver, escrowedKind, invertible, mapLegs, nameResolver, onChainLegs, perpResolver, sameLegs, type AppLeg, type ContractResolver, type MappedLeg, type NameResolver, type PerpResolver } from "./legs.ts";
import { PhoenixDesk, type PhoenixClose } from "./phoenix.ts";
import { withPhoenixLock } from "./phoenix-lock.ts";
import { LANE, newUse, type JupiterUse, type Lane } from "./guard.ts";
import { Router, TEMPLATE_TTL_MS, escrowShare, type TradeLeg } from "./routing.ts";
import { SendFailed, fates, refusedByPreflight, resendOnce, routeRefusal, sendBackToBack, slippageRefusal, type Fate } from "./send.ts";
import { SplitTrades, afterFailure, deserializeIx, incompleteView, serializeIx, sweepLegs } from "./split.ts";
import { StateStore } from "./store.ts";
import {
  STOPPED_SALE_TTL_MS,
  escrowReturned,
  holdingMaxPartialBps,
  mergeInventory,
  planHoldingSale,
  positionMaxPartialBps,
  positionSale,
  saleBps,
  saleError,
  saleIncompleteError,
  saleLeft,
  stepsByTx,
  tokensToSell,
  type PositionSale,
  type TxFate,
} from "./sales.ts";
import { Valuation } from "./valuation.ts";
import { Wallets } from "./wallets.ts";

export { ApiError, DEFAULT_STATE_PATH, MIN_STAKE_USD, type AppTake, type ServiceOpts, type TakeSource } from "./common.ts";
export { digestFor } from "./digests.ts";

/** A create_take, back or fade as built: what a split trade that stops partway needs (api/split.ts). */
type TradeContext = {
  takeId: string;
  /** The on-chain side. */
  side: "back" | "fade";
  /** The take is inverted (its on-chain fade agrees with it): turns `side` take-relative for clients. */
  inverted?: boolean;
  usd: number;
  included: number[];
  /** The receipt as built, before the composer appends the last bracket's outputs. */
  receipt: TransactionInstruction;
  receiptCu: number;
};

/** How long a submit's status is kept (memory and state file) for repeats and GET /submissions. */
const SUBMISSION_KEEP_MS = 10 * 60_000;
/** GET /submissions/:id?wait= waits at most this long. */
export const SUBMISSION_WAIT_MAX_MS = 10_000;
/** A sale or cash-out build waits at most this long for the owner's submits still confirming. */
const AFTER_PENDING_MS = 10_000;
/** A refresh keeps a build's quotes while they're at most this old; older: 409 quote_stale. */
export const QUOTE_REFRESH_MS = 45_000;
/** Builds refresh their market accounts from mainnet unless this process did in the last MARKET_FRESH_MS. */
const MARKET_FRESH_MS = 30_000;
/**
 * A submit refreshes them again only past SUBMIT_MARKET_FRESH_MS, except a Phoenix leg's own
 * accounts (market, spline, PerpAssetMap: `phoenixMarket`), which it always refreshes: Phoenix
 * refuses a stale mark. (It used to refresh every account of a build with a Phoenix leg, its swap
 * pools too, which the first send then fetched from mainnet again: 200–340 ms against ~40.)
 */
const SUBMIT_MARKET_FRESH_MS = 60_000;
/** How often the fork's clock is brought up to wall time, when the service is given `fork.syncClock`. */
const CLOCK_SYNC_MS = 5_000;

type SubmissionStatus = SavedSubmission["status"];

/** A submit in this process (see ForkService#submit). */
type Submission = {
  owner: string;
  kind: string;
  /** Of the signed transactions as submitted: a repeat with the same bytes is the same submit. */
  digest: string;
  /** The trade's transactions (a retry's earlier ones first), without the trailing cleanup. */
  signatures: string[];
  status: SubmissionStatus;
  error?: ApiError;
  at: number;
  /** Settles once every transaction was accepted, or the submit ended before that. */
  accepted: Promise<void>;
  /** Settles once the status is final. */
  done: Promise<void>;
  accept: () => void;
  finish: (status: Exclude<SubmissionStatus, "pending">, signatures?: string[], error?: unknown) => void;
};
/** A submit from before a restart, read back from the state file. */
type SavedSubmissionView = Pick<Submission, "owner" | "kind" | "digest" | "signatures" | "status" | "error" | "at" | "done">;

/** What a submit answers: by default `{ signatures }`; with until=accepted (or a repeat), its status too. */
type SubmitAnswer = { signatures: string[]; status?: SubmissionStatus; buildId?: string };

/** GET /submissions/:buildId. */
export type SubmissionView = {
  buildId: string;
  status: SubmissionStatus;
  signatures: string[];
  error?: { code: string; message: string };
  /** A split trade that stopped partway: what `trade_incomplete` carries (retry or sweep it). */
  incomplete?: unknown;
};

function submissionView(buildId: string, s: Pick<Submission, "status" | "signatures" | "error">): SubmissionView {
  const incomplete = s.status === "incomplete" ? s.error?.body?.incomplete : undefined;
  return {
    buildId,
    status: s.status,
    signatures: s.signatures,
    ...(s.error && s.status !== "pending" && s.status !== "landed" ? { error: { code: s.error.code, message: s.error.message } } : {}),
    ...(incomplete ? { incomplete } : {}),
  };
}

/** The Jupiter lane of a build (api/guard.ts): a prebuild's may fail fast (503 busy); a tap's waits its turn. */
const laneOf = (prebuild?: boolean): Lane => (prebuild ? LANE.prebuild : LANE.tap);

/**
 * What a build's Jupiter use goes in its timings as: the wait for the budget as a step, the rest
 * as notes. A shared routing ("hit", "wait", "scaled") was quoted up to TEMPLATE_TTL_MS before this build:
 * its quotedAt says so, so a refresh doesn't keep those quotes past their age.
 */
function noteUse(t: Timings, use: JupiterUse) {
  if (use.waitedMs) t.add("jupiter wait", use.waitedMs);
  t.note("jupiter", `lane ${use.lane}, ${use.calls} calls (${use.quotes} quotes, ${use.instructions} instructions)`);
  if (use.winnerHits || use.winnerMisses) t.note("winners", `${use.winnerHits} hit, ${use.winnerMisses} miss`);
  if (use.template) t.note("template", `${use.template}${use.templatedLegs ? `, ${use.templatedLegs} legs` : ""}`);
  if (use.rateLimited) t.note("429s", use.rateLimited);
  if (use.refused) t.note("refused", use.refused.code);
  if (use.template === "hit" || use.template === "wait" || use.template === "scaled") t.quotedAt = Math.min(t.quotedAt ?? Date.now(), Date.now() - TEMPLATE_TTL_MS);
}

/** The signed transactions' bytes, hashed: what tells a repeat of a submit from a different one. */
function signedDigest(signed: string[]): string {
  const h = createHash("sha256");
  for (const b64 of signed) h.update(Buffer.from(b64, "base64")).update("|");
  return h.digest("hex");
}

const savedError = (e: ApiError): NonNullable<SavedSubmission["error"]> => ({ status: e.status, code: e.code, message: e.message, ...(e.body ? { body: e.body } : {}) });
function apiErrorOf(e: NonNullable<SavedSubmission["error"]>): ApiError {
  const out = new ApiError(e.status, e.code, e.message);
  if (e.body) out.body = e.body;
  return out;
}

/** The answer to a split trade that stopped partway: 422 `trade_incomplete` (see the README). */
function incompleteError(position: string, t: IncompleteTrade, status = 422, code = "trade_incomplete", message?: string): ApiError {
  const e = new ApiError(status, code, message ?? (t.next === "retry"
    ? "Part of this trade went through. Sign once more to finish it."
    : "This trade couldn't finish. Sell what it bought back to cash."));
  e.body = { retry: t.next === "retry", sweep: true, incomplete: incompleteView(position, t) };
  return e;
}

type Build = {
  owner: string;
  messages: Buffer[];
  /**
   * The messages answered before the last refresh, and when they expire: a client that signed
   * them while the refresh ran may still submit them, until the build's first submit uses it.
   */
  previous?: { messages: Buffer[]; expires: number };
  market: PublicKey[];
  kind: "back" | "publish" | "exit" | "claim" | "phoenix" | "sweep";
  /** Per transaction (cleanup left out), the take leg of each venue leg in it. */
  txLegs?: number[][];
  /** Per transaction (cleanup left out), the underlyings its Jupiter swaps buy (routing's `dropBuys`). */
  txKeys?: string[][];
  /** A create_take, back or fade. */
  trade?: TradeContext;
  /** The retry of this incomplete trade (as it stood when the retry was built). */
  retry?: IncompleteTrade;
  /** Take legs bought on Jupiter Lend (a sweep redeems their shares). */
  lend?: number[];
  /** A creator-fee claim: the takes it claims (no position). */
  claims?: string[];
  expires: number;
  /** The position the receipt instruction opens, so the receipt can show it right away. */
  position: { take: PublicKey; address: PublicKey; publishTakeId?: string; exit?: ExitReceipt; sales?: SaleRecord[] };
  /**
   * Trailing transactions that only cancel this owner's abandoned trade tickets (security review
   * L-4). They're sent after the trade has landed, and a failure there doesn't fail the trade.
   */
  cleanup?: number;
  /** When its quotes were made (unix ms): a refresh keeps them only while they're QUOTE_REFRESH_MS old at most. */
  quotedAt?: number;
  /** Built ahead of the tap (`prebuild`): the money action counts at its submit instead. */
  prebuilt?: boolean;
  /**
   * The submit leaves `market` accounts refreshed less than this long ago (0: all of them, as
   * before). Builds refresh them at quote time; Phoenix legs are always refreshed before the send.
   */
  marketFreshMs?: number;
  /** A Phoenix leg's own accounts (market, spline, PerpAssetMap): refreshed at every submit, however fresh. */
  phoenixMarket?: PublicKey[];
  /** What the build answered (the build route's whole response), for a refresh to answer the same. */
  response?: Record<string, unknown>;
  /** A sale: what each transaction carries, so one that stops partway can be finished. */
  sale?: SaleBuild;
  /** A back or publish: the tokens its swaps buy (about how many), to seed their sell routes once it lands. */
  seeds?: { mint: string; amount: bigint }[];
};

/**
 * What every build route takes besides its own fields. `timings`: the request's (server.ts sends
 * them as Server-Timing). `prebuild`: built ahead of the tap (the sheet opened, the amount
 * changed): its Jupiter calls go in routing's prebuild lane, and its money action counts at submit.
 */
export type BuildOpts = { timings?: Timings; prebuild?: boolean };

/** How much a sale sells: `bps` of what's left, or `usd` of what it's worth now; neither sells all. */
export type SaleAmount = { bps?: unknown; usd?: unknown };

/**
 * One position a sale build sells: its partial sale's seq (the PDA it creates) and whether it sells
 * all of it; `exit` for a whole sale (what the receipt shows once it's settled).
 */
type SaleRecord = { address: PublicKey; seq: number; full: boolean; horizonEnd: number; bps?: number; exit?: ExitReceipt };

/**
 * A sale build's steps (api/sales.ts): per transaction, what it carries; each position's record
 * as built; and, for a build that finishes a stopped sale, that sale's key.
 */
type SaleBuild = { takeId: string; txSteps: SaleStep[][]; records: StoppedSale["records"]; finish?: string };
/** What a sale build gives #compose: each venue leg's step (by index), the receipt's, and the records. */
type SaleSteps = { takeId: string; steps: (SaleStep | null)[]; receipt: SaleStep; records: StoppedSale["records"]; finish?: string };
/** The parts of a sale build's answer a stopped sale answers again when it's finished. */
const SALE_SUMMARY = ["bps", "full", "sale", "positions", "escrowUsd", "closesTake", "expectedUsd", "minimumUsd", "phoenixCashOut"] as const;
type SaleSummary = {
  bps: number;
  full: boolean;
  sale: { stakeUsd: number; remainingStakeUsd: number; valueUsd: number; remainingValueUsd: number };
  positions?: string[];
  escrowUsd: number;
  closesTake: boolean;
  expectedUsd: number;
  minimumUsd: number;
  phoenixCashOut: boolean;
};

/** A position a sale reads: its account, and what's left of it with its unsettled partial sales. */
type SaleHolding = { address: PublicKey; account: PositionAccount; view: { remaining: bigint; openParts: number } };
/** What a sale build reads first (`#saleContext`). */
type SaleContext = {
  takeId: string;
  owner: PublicKey;
  takeKey: PublicKey;
  take: TakeAccount;
  config: Awaited<ReturnType<typeof fetchConfig>>;
  holdings: SaleHolding[];
  minStake: bigint;
  minStakeUsd: number;
};
/** One position of a sale build and the share of it sold. */
type SaleTarget = { holding: SaleHolding; bps: number; sale: Extract<PositionSale, { ok: true }> };

const FULL_BPS = 10_000;
/** A sale record's compute: exit_position for all of a position, sell_part for part. */
const recordCu = (full: boolean) => (full ? THESIS_COMPUTE_UNITS.exitPosition : THESIS_COMPUTE_UNITS.sellPart);
/** A position's sale record riding as a leg before the receipt (a sale of several positions). */
const recordLeg = (ix: TransactionInstruction, full: boolean): VenueLeg => ({ label: full ? "Record sale" : "Record partial sale", instructions: [ix], lookupTables: [], marketAccounts: [] });
/** composeTransactions' refusal of a leg (or receipt) too big for a transaction on its own. */
const tooBig = (e: unknown) => e instanceof Error && !(e instanceof ApiError) && /doesn't fit in a transaction/.test(e.message);
const hasUsd = (o: SaleAmount) => o.usd !== undefined && o.usd !== null;
/** Runs `f` once, the first time it's asked for. */
function lazy<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= f());
}
/**
 * `clientTimings`: the submit body's `timings` (the client's marks), logged with the build id.
 * `until: "accepted"`: answer once the fork accepted every transaction (see ForkService#submit).
 */
export type SubmitOpts = {
  timings?: Timings;
  clientTimings?: unknown;
  until?: "accepted";
  /**
   * Runs once the signed transactions checked out, before anything is sent or the build used: a
   * prebuilt build's money action counts here (server.ts). A throw refuses the submit, and the
   * build can be submitted again.
   */
  admit?: (build: { owner: string; kind: string; prebuilt: boolean }) => void;
};

/** What's known about one take's positions (see ForkService#positionsOf). */
type PositionEntry = {
  keys: Set<string>;
  /** Position → owner, for positions open and not sold, as last read: the owner index. */
  owners: Map<string, string>;
  /** When the last program-account scan finished (0: never). */
  scannedAt: number;
  /** When this service last noted a trade on the take. */
  tradedAt: number;
  scan: Promise<void> | null;
};

/** Abandoned tickets cancelled in one cleanup transaction, at most. */
const CLEANUP_TICKETS = 6;

type BlinkCheckout = {
  message: Buffer;
  blockhash: string;
  lastValidBlockHeight: number;
  position: Build["position"];
  submission?: Promise<string>;
};

const BLINK_MAX_LEGS = 3;
const DEMO_AUTHOR_BUY_IN_USD = 10;
/**
 * How long a build can be submitted. A blockhash lives ~150 blocks (~60 s), counted from when
 * the build fetched it, so a build must expire before its blockhash does.
 */
export const BUILD_TTL_MS = 55_000;
/** How long a receipt waits for a cold route check before answering with what it knows. */
const ROUTE_CHECK_WAIT_MS = 1_500;
const TAKE_CACHE_MS = 15_000;
/**
 * How often a take's positions are rescanned from program accounts (see #positionsOf): every few
 * minutes, or every 30 s for a while after a trade on that take. Each scan is a getProgramAccounts
 * that Surfpool forwards to its mainnet datasource (Helius credits).
 */
const POSITION_SCAN_MS = 5 * 60_000;
const POSITION_SCAN_BUSY_MS = 30_000;
const BUSY_AFTER_TRADE_MS = 5 * 60_000;
/** Blockhashes remembered with their last valid block height, so a send confirms against its own. */
const BLOCKHASHES_KEPT = 500;

/**
 * `connection`, remembering each blockhash it hands out with its last valid block height, so a
 * transaction built on one confirms against that height instead of a fresher blockhash's.
 */
function trackBlockhashes<C extends ServiceOpts["connection"]>(connection: C, seen: Map<string, number>): C {
  return new Proxy(connection, {
    get(target, prop) {
      if (prop === "getLatestBlockhash") {
        return async (...args: Parameters<C["getLatestBlockhash"]>) => {
          const r = await target.getLatestBlockhash(...args);
          seen.set(r.blockhash, r.lastValidBlockHeight);
          if (seen.size > BLOCKHASHES_KEPT) seen.delete(seen.keys().next().value!);
          return r;
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export class ForkService {
  #o: ServiceOpts;
  #program: ThesisProgram;
  #store: StateStore;
  #valuation: Valuation;
  #router: Router;
  #history: PortfolioHistory;
  #wallets: Wallets;
  #fees: CreatorFees;
  /** Phoenix legs, when Phoenix is configured. */
  #phoenix: PhoenixDesk | null;
  #builds = new Map<string, Build>();
  /** Positions whose transactions are being sent or confirmed right now: their tickets aren't abandoned. */
  #inFlight = new Set<string>();
  /** Submits by build id (kept SUBMISSION_KEEP_MS after they end): repeats and GET /submissions. */
  #submissions = new Map<string, Submission>();
  /** Positions with a sale submitted and not yet ended → its build id: a second sale is refused. */
  #pendingExits = new Map<string, string>();
  #blinkCheckouts = new Map<string, BlinkCheckout>();
  #log: (m: string) => void;
  /** Blockhash → its last valid block height, from every blockhash this service fetched. */
  #blockhashes = new Map<string, number>();
  /** Split trades that stopped partway, and when to look for abandoned tickets (api/split.ts). */
  #split: SplitTrades;

  constructor(opts: ServiceOpts) {
    const o: ServiceOpts = { ...opts, connection: trackBlockhashes(opts.connection, this.#blockhashes) };
    this.#o = o;
    this.#program = thesisProgram(o.connection);
    this.#log = o.log ?? (() => {});
    this.#store = new StateStore(o.statePath, o.lookupTable, (m) => (o.log ?? console.error)(m));
    this.#split = new SplitTrades(this.#store);
    this.#valuation = new Valuation(o, this.#store, { pricesFile: o.pricesFile });
    this.#router = new Router(o);
    this.#phoenix = o.phoenix ? new PhoenixDesk(o, o.phoenix, this.#store, this.#program) : null;
    this.#router.phoenix = this.#phoenix;
    // The chart doesn't show badges: its snapshots skip reading them.
    this.#history = new PortfolioHistory(this.#store, o.connection, (addr, opts) => this.portfolio(addr, { ...opts, badges: false }), (addr) => this.#holds(addr));
    this.#wallets = new Wallets(o, this.#store, this.#program, (addr) => this.#history.snapshot(addr), (take) => this.#isInverted(take));
    this.#fees = new CreatorFees(
      o,
      this.#program,
      () => new Map(Object.entries(this.#state.takes).filter(([, m]) => !m.demoAuthorKey).map(([id, m]) => [m.address, id])),
      (takeId) => this.#appTake(takeId).then((t) => t.claim).catch(() => null),
      // Takes the author posted through this API (on-chain addresses).
      (author) => Object.values(this.#state.takes).filter((m) => m.author === author && !m.demoAuthorKey).map((m) => m.address),
    );
    // The fork's clock, kept at wall time here rather than before every send (lib.ts syncClock).
    const sync = o.fork.syncClock;
    if (sync) setInterval(() => void sync().catch(() => {}), CLOCK_SYNC_MS).unref();
    // Warm each mirrored take's position scan (it can take ~10 s on Surfpool), so the first
    // receipt someone opens doesn't wait for it. It also fills the owner index (see #holds).
    for (const m of Object.values(this.#store.state.takes)) void this.#positionsOf(new PublicKey(m.address)).catch(() => {});
  }

  get #state() {
    return this.#store.state;
  }

  #save() {
    this.#store.save();
  }

  /** Writes the state file now (it's otherwise written a few seconds after a change; see StateStore). */
  flush() {
    this.#store.flush();
  }

  /** The app's take from Supabase, cached briefly: a receipt and the build after it read it once. */
  async #appTake(id: string, o: { fresh?: boolean } = {}): Promise<AppTake> {
    const hit = this.#takeCache.get(id);
    // A posting take goes live within seconds: don't keep its posting status around.
    if (hit && hit.at > Date.now() - TAKE_CACHE_MS && !o.fresh && hit.take.status !== "posting") return hit.take;
    const pending = this.#takeReads.get(id);
    if (pending) return pending;
    const request = this.#o.takes(id).then((take) => {
      if (!take) throw new ApiError(404, "no_such_take");
      this.#takeCache.set(id, { at: Date.now(), take });
      return take;
    }).finally(() => this.#takeReads.delete(id));
    this.#takeReads.set(id, request);
    return request;
  }
  #takeCache = new Map<string, { at: number; take: AppTake }>();
  #takeReads = new Map<string, Promise<AppTake>>();

  // --- Receipts ---------------------------------------------------------------------------

  /** `routes: false` skips the Jupiter route check (the portfolio, which shows no trade sheet). */
  /**
   * The program's rules the app shows: the fee (and the creator's share of it), the minimum
   * stake and the limits, read from the config account (cached a minute), so the app never
   * hard-codes them.
   */
  async publicConfig() {
    const p = (await this.#config()).params;
    return {
      feeBps: p.feeBps,
      creatorFeeBps: p.creatorFeeBps,
      feeRate: p.feeBps / 10_000,
      minStakeUsd: Number(BigInt(p.minStake.toString())) / USD,
      maxLegs: p.maxLegs,
      minHorizonSecs: p.minHorizonSecs.toNumber(),
      maxHorizonSecs: p.maxHorizonSecs.toNumber(),
      /** A take auto-settles this long after posting unless its author sells first. */
      takeLifetimeSecs: TAKE_LIFETIME_SECS,
      paused: p.paused,
    };
  }

  async receipt(takeId: string, viewer?: string, o: { routes?: boolean; strict?: boolean } = {}) {
    const r = await this.#receipt(takeId, viewer, o);
    // A posted take this API has no record of may be on-chain at its own address: if #recover
    // finds and records it, read it again as on-chain.
    if (r.onChain || !("missing" in r) || this.#state.takes[takeId]) return r;
    const app = await this.#appTake(takeId);
    return (await this.#recover(takeId, app)) ? this.#receipt(takeId, viewer, o) : r;
  }

  async #receipt(takeId: string, viewer?: string, o: { routes?: boolean; strict?: boolean } = {}) {
    const mirror = this.#state.takes[takeId];
    // A stale demo mirror reads as not on-chain: its next trade mirrors it again.
    const address = mirror && !staleDemo(mirror) ? new PublicKey(mirror.address) : null;
    // The app's take, the on-chain take and its positions are independent reads: do them at once.
    const appP = this.#appTake(takeId);
    // Null if the account is gone (the fork was reset under a kept state file): shown as not on-chain.
    const takeP = address ? this.#program.account.take.fetchNullable(address) : null;
    const positionsP = address ? this.#positionsOf(address, o.strict) : null;
    // Settle the chain reads even if the app read fails first, so none is left unhandled.
    void takeP?.catch(() => {});
    void positionsP?.catch(() => {});
    const app = await appP;
    let legs = this.#mapLegs(app.legs);
    let onChainTake = takeP ? await takeP : null;
    if (onChainTake && !sameLegs(onChainTake.legs, legs, { onChain: onChainTake.inverted, app: app.inverted })) {
      // A demo take whose legs changed in the app is mirrored again on its next trade; a take
      // its author posted keeps what's on-chain, and legs that no longer match can't be traded.
      if (mirror?.demoAuthorKey) onChainTake = null;
      else legs = onChainLegs(legs, onChainTake.legs);
    }
    // Wait briefly for legs whose route isn't known yet (cold start); after that the receipt goes
    // out with what's known, the check finishes in the background, and a build reports the rest.
    if (o.routes !== false) {
      const checked = Promise.all([this.#router.checkRoutes(legs).catch(() => {}), this.#router.refreshMarkets(legs)]);
      await Promise.race([checked, new Promise((r) => setTimeout(r, ROUTE_CHECK_WAIT_MS).unref())]);
    }
    // Sides here are take-relative: "back" agrees with the take, "fade" disagrees. An inverted take
    // (on-chain, its TakeAccount says; before that, the app take) agrees with an on-chain fade.
    const inverted = Boolean((onChainTake ?? app).inverted);
    const dir = { inverted };
    // An on-chain back buys the legs; an on-chain fade holds the other side of prediction legs
    // (paper) and shorts the rest on Phoenix.
    const now = Date.now();
    const leftOut = legs.map((l) => this.#router.leftOut(l, now, chainSide("back", dir)));
    const canBuy = leftOut.some((why) => why === null);
    const fadeOut = legs.map((l) => this.#router.leftOut(l, now, chainSide("fade", dir)));
    const fadeable = fadeOut.some((why) => why === null);
    const legView = (onChain?: TakeAccount) =>
      legs.map((l, i) => ({
        index: l.index,
        name: l.name,
        underlying: l.key,
        /** Agreeing with the take (a back; an inverted take's on-chain fade) can hold this leg; else why not. */
        tradable: leftOut[i] === null,
        blocked: leftOut[i],
        /**
         * Why disagreeing (a fade, which holds a prediction's other side or a Phoenix short; an
         * inverted take's on-chain back, which buys the leg) leaves this leg out; null if it can't.
         */
        fadeBlocked: fadeOut[i],
        /** A perp leg: the Phoenix market an on-chain back goes long on, and its leverage. */
        perp: l.phoenix ? { symbol: l.phoenix.symbol, leverage: l.spec.leverage } : null,
        /** The Phoenix market an on-chain fade shorts this leg on, if any. */
        short: l.short?.symbol ?? null,
        /** A yield leg (Jupiter Lend): it earns interest, priced as one vault share's value, which counts in the score. */
        yield: l.how === "lend",
        /**
         * A prediction leg, filled on paper at Gemini's prices: the side agreeing with the take holds
         * (an inverted take's agreers hold the leg's other side), and its market now.
         */
        prediction: l.prediction
          ? {
              instrument: l.prediction.contract.instrumentSymbol,
              event: l.prediction.contract.eventTitle,
              label: l.prediction.contract.label,
              side: inverted ? otherSide(l.prediction.side) : l.prediction.side,
              ask: this.#router.contract(l.prediction.contract).ask,
              bid: this.#router.contract(l.prediction.contract).bid,
              expiry: l.prediction.contract.expiry,
            }
          : null,
        /** A card leg, filled on paper at the card's insured value (Collector Crypt), escrowed; never faded. */
        card: l.card
          ? { cardId: l.card.cardId, insuredValueUsd: cardLeg(this.#o.bank(), cardIdHex(l.card.cardId))?.insuredValueUsd ?? null }
          : null,
        weightBps: onChain?.legs[l.index]?.weightBps ?? l.spec.weightBps,
      }));
    // Why disagreeing isn't possible right now: a fade needs a prediction market's other side, or a
    // Phoenix short; against an inverted take it's a back, which needs a leg it can buy.
    const fadeBlocked = fadeable ? null : inverted ? AGAINST_INVERTED_NOTHING : legs.some((l) => l.how === "paper") ? FADE_NO_MARKET : FADE_BLOCKED;
    if (!address || !onChainTake || !positionsP) {
      // A live take a real user posted that isn't on this fork: the fork was reset since. A live take
      // can't be published again, so its author has to post a new take. A demo take is mirrored on its first trade.
      const missing = app.status !== "posting" && (!!app.author_wallet || (!!mirror && !mirror.demoAuthorKey));
      if (missing) return { takeId, onChain: false as const, inverted, legs: legView(), canBack: false, canFade: false, fadeBlocked: TAKE_MISSING, missing: TAKE_MISSING };
      return { takeId, onChain: false as const, inverted, legs: legView(), canBack: canBuy, canFade: fadeable, fadeBlocked };
    }

    const take = onChainTake;
    const positions = await positionsP;
    const author = positions.find((p) => p.account.owner.equals(take.author) && p.account.id.isZero());
    const mine = viewer ? positions.filter((p) => p.account.owner.toBase58() === viewer) : [];
    // Authors can't fade (disagree with) their own take (the program refuses it too).
    const viewerIsAuthor = viewer === take.author.toBase58();
    const status = takeStatusName(take);
    const open = takeOpen(take);
    // Closed: the headline is the author's sale, read from their exit account once it's priced.
    // The viewer's partial sales still settling, by position.
    const partKeys = mine.flatMap((p) =>
      Array.from({ length: Math.max(0, p.account.parts - p.account.partsSettled) }, (_, i) => partSaleAddress(p.publicKey, p.account.partsSettled + i, this.#program.programId)));
    const [marks, config, authorExit, partAccounts] = await Promise.all([
      this.#valuation.marks(take, legs, [...(author ? [author] : []), ...mine]),
      this.#config(),
      status === "closed" && author ? this.#program.account.exit.fetchNullable(exitAddress(author.publicKey, this.#program.programId)).catch(() => null) : null,
      partKeys.length ? (this.#program.account.partSale.fetchMultiple(partKeys) as Promise<(PartSaleAccount | null)[]>).catch(() => []) : [],
    ]);
    const partsOf = new Map<string, PartSaleAccount[]>();
    for (const part of partAccounts) if (part) partsOf.set(part.position.toBase58(), [...(partsOf.get(part.position.toBase58()) ?? []), part]);
    const minStake = BigInt(config.params.minStake.toString());
    const minStakeUsd = Number(minStake) / USD;
    /**
     * A position's return at current prices: each leg marked on the source its entry was priced
     * on. Null while a priced leg has no entry or no mark (never a -100% from a missing price).
     */
    const live = (p: (typeof positions)[number]): number | null => {
      const m = marks.get(p.publicKey.toBase58()) ?? [];
      for (let i = 0; i < take.legs.length; i++) {
        if (!(p.account.legsMask & (1 << i))) continue;
        if (!(p.account.entrySet & (1 << i)) || m[i] == null) return null;
      }
      return positionReturnBps(take.legs, {
        side: p.account.side,
        legsMask: p.account.legsMask,
        prices: p.account.prices.map((x, i) => ({ entry: BigInt(x.entry.toString()), exit: m[i] ?? 0n })),
      });
    };
    /** The author's sale's return, null until every leg's sale price is in. */
    const sold = (): number | null => {
      if (!author || !authorExit) return null;
      const a = author.account;
      const priced = take.legs.every((_, i) => !(a.legsMask & (1 << i)) || (a.entrySet & (1 << i) && authorExit.priceSet & (1 << i)));
      if (!priced) return null;
      return positionReturnBps(take.legs, {
        side: a.side,
        legsMask: a.legsMask,
        prices: a.prices.map((x, i) => ({ entry: BigInt(x.entry.toString()), exit: BigInt(authorExit.prices[i].toString()) })),
      });
    };
    const authorMarks = author ? (marks.get(author.publicKey.toBase58()) ?? []) : [];
    const settled = status === "settled";
    const closedAt = take.closedAt.isZero() ? null : take.closedAt.toNumber();
    return {
      takeId,
      onChain: true as const,
      address: address.toBase58(),
      author: take.author.toBase58(),
      /** "closed": the author sold, so no new backs or fades; it settles on that sale. */
      status,
      createdAt: take.createdAt.toNumber(),
      /** When it auto-settles if the author never sells. */
      horizonEnd: take.horizonEnd.toNumber(),
      /** When the author sold their buy-in (closing the take), or null. Stays set once settled. */
      closedAt,
      /**
       * Every side below is take-relative: backers agree with the take, faders disagree. On an
       * inverted take (it bets against its basket) agreeing is an on-chain fade, so these are the
       * on-chain counters swapped. Phoenix directions (long, short) stay literal.
       */
      inverted,
      backers: inverted ? take.faders : take.backers,
      faders: inverted ? take.backers : take.faders,
      totalBackedUsd: (inverted ? take.totalFaded : take.totalBacked).toNumber() / USD,
      totalFadedUsd: (inverted ? take.totalBacked : take.totalFaded).toNumber() / USD,
      creatorFeesUnclaimedUsd: take.creatorFeesUnclaimed.toNumber() / USD,
      /**
       * Settled: the take's result. Closed: the author's sale, once its prices are in. Open: the
       * author's position at current prices, once entry prices are in. The author's position is on
       * the agreeing side, so this is agreeing's return either way.
       */
      returnBps: settled ? take.resultBps.toNumber() : status === "closed" ? sold() : author ? live(author) : null,
      legs: legView(take).map((l, i) => ({
        ...l,
        authorEntryUsd: author && author.account.entrySet & (1 << i) ? author.account.prices[i].entry.toNumber() / 1e8 : null,
        currentUsd: authorMarks[i] != null ? Number(authorMarks[i]) / 1e8 : null,
      })),
      viewerPositions: [
        ...await Promise.all(mine.map(async (p) => {
          const exited = p.account.exited;
          const stake = BigInt(p.account.stake.toString());
          const fee = splitFee(stake, config.params, { isAuthor: p.account.owner.equals(take.author) }).fee;
          const pending = legs.filter((_, i) => p.account.legsMask & (1 << i) && !(p.account.entrySet & (1 << i)));
          // In any take status: holders can sell after the author has, until the horizon.
          const canExit = !exited && take.horizonEnd.toNumber() > Date.now() / 1000 &&
            take.legs.every((leg, i) => !(p.account.legsMask & (1 << i)) || SELLABLE(leg.kind));
          // Sold whole: nothing left (the account keeps what that sale sold until it settles).
          const remaining = exited ? 0n : BigInt(p.account.remaining.toString());
          const priced = p.account.legsMask & ((1 << take.legs.length) - 1);
          return {
            address: p.publicKey.toBase58(),
            /** Take-relative: "back" agrees with the take (an inverted take's on-chain fade). */
            side: chainSide("back" in p.account.side ? "back" : "fade", take),
            exited,
            canExit,
            /** The cost basis still held, after partial sales. `stakeUsd` and `costUsd` stay what was first paid. */
            remainingStakeUsd: Number(remaining) / USD,
            soldStakeUsd: Number(stake - remaining) / USD,
            /** P&L from partial sales that have settled; null before the first one has. */
            realizedPnlUsd: p.account.partsSettled > 0 ? Number(p.account.realizedPnl.toString()) / USD : null,
            /** Partial sales still settling: `priced` once their sale prices are all in. */
            pendingSales: (partsOf.get(p.publicKey.toBase58()) ?? []).sort((a, b) => a.seq - b.seq).map((part) => ({
              seq: part.seq,
              bps: part.bps,
              stakeUsd: Number(BigInt(part.stake.toString())) / USD,
              soldAt: part.soldAt.toNumber(),
              priced: (part.priceSet & priced) === priced,
            })),
            minStakeUsd,
            /** The largest partial sale allowed now (keeps at least the minimum stake); null: only selling all. */
            maxPartialBps: canExit ? positionMaxPartialBps({ remaining, openParts: p.account.parts - p.account.partsSettled }, minStake) : null,
            /** Selling all of it closes the take (the author's buy-in on an open take). */
            closesTakeIfSoldAll: !exited && p.account.id.isZero() && p.account.owner.equals(take.author) && "open" in take.status,
            /** The prediction share held in escrow; it comes back in full at a sale or when the position settles. */
            escrowedUsd: Number(BigInt(p.account.escrowed.toString())) / USD,
            stakeUsd: Number(stake) / USD,
            openedAt: p.account.openedAt.toNumber(),
            legsMask: p.account.legsMask,
            /** The score's return: on-chain entry prices against live marks on the same source. */
            returnBps: live(p),
            /** What the trade cost the wallet (stake plus the Thesis fee). */
            costUsd: Number(stake + fee) / USD,
            /** What's left of it is worth now (after partial sales), or null if a price is missing. */
            valueUsd: exited ? null : await this.#positionWorth(take, p, marks.get(p.publicKey.toBase58()) ?? []).catch(() => null),
            /**
             * Legs held on Phoenix: entry, the market now, the liquidation price and how far it is
             * ("near" within 25%, "close" within 10%). Empty when the position holds none.
             */
            phoenix: exited || !this.#phoenix ? [] : await this.#phoenix.risk(p.publicKey, p.account.owner).catch(() => []),
            /** Legs still waiting for an entry price, and why, for the app to say instead of "pricing...". */
            pendingLegs: pending.map((l) => l.name),
            pendingNote: pending.length ? pendingNote(pending, p.account.openedAt.toNumber()) : null,
          };
        })),
        ...(viewer ? this.#settledExits(address, viewer, new Set(mine.map((p) => p.publicKey.toBase58())), minStakeUsd, inverted) : []),
      ],
      canBack: open && canBuy,
      canFade: open && fadeable && !viewerIsAuthor,
      fadeBlocked: closedAt !== null ? TAKE_CLOSED : !open ? TAKE_ENDED : viewerIsAuthor ? FADE_OWN_TAKE : fadeBlocked,
    };
  }

  /**
   * A take's open positions. Scanning program accounts can take ~10 s on Surfpool (it consults
   * mainnet), so the scan runs once per take and then in the background every few minutes (every
   * 30 s for a while after a trade on it); reads in between fetch the known addresses in one
   * getMultipleAccounts call. Positions this service submits are added as soon as they land.
   * Each read also updates the owner index (see #holds).
   */
  async #positionsOf(take: PublicKey, strict = false) {
    const key = take.toBase58();
    const e = this.#positionEntry(key);
    const scan = () =>
      (e.scan ??= this.#program.account.position
        .all([{ memcmp: { offset: 8 + 32, bytes: key } }])
        .then((all) => {
          for (const p of all) e.keys.add(p.publicKey.toBase58());
          e.scannedAt = Date.now();
        })
        .finally(() => (e.scan = null)));
    if (!e.scannedAt) {
      // Surfpool forwards this scan to its mainnet datasource, which can fail under load. Answer
      // with the positions already known (this service notes every one it opens) and rescan later.
      await scan().catch((err) => {
        if (strict) throw err;
        this.#log(`position scan for ${key} failed (${err instanceof Error ? err.message.slice(0, 80) : err}); using known positions`);
      });
    } else {
      const now = Date.now();
      const every = now - e.tradedAt < BUSY_AFTER_TRADE_MS ? POSITION_SCAN_BUSY_MS : POSITION_SCAN_MS;
      if (now - e.scannedAt > every) void scan().catch(() => {});
    }
    const keys = [...e.keys].map((k) => new PublicKey(k));
    const accounts = keys.length ? await this.#program.account.position.fetchMultiple(keys) : [];
    const out: { publicKey: PublicKey; account: NonNullable<(typeof accounts)[number]> }[] = [];
    accounts.forEach((account, i) => {
      const k = keys[i].toBase58();
      if (account) out.push({ publicKey: keys[i], account });
      else e.keys.delete(k); // settled and closed
      if (account && !account.exited) e.owners.set(k, account.owner.toBase58());
      else e.owners.delete(k);
    });
    return out;
  }
  #positions = new Map<string, PositionEntry>();

  #positionEntry(take: string): PositionEntry {
    let e = this.#positions.get(take);
    if (!e) {
      e = { keys: new Set(), owners: new Map(), scannedAt: 0, tradedAt: 0, scan: null };
      this.#positions.set(take, e);
    }
    return e;
  }

  /**
   * A position this service just opened. On a take it just created (`isNew`), that's every
   * position there is, so the take needs no cold scan.
   */
  #notePosition(take: PublicKey, position: PublicKey, owner: string, isNew = false) {
    const key = take.toBase58();
    // A take never read here still gets its first scan when it's read (scannedAt stays 0), but the
    // position is known now: that scan can fail, or run before the position shows (it used to be
    // skipped here, and a sale right after the back found nothing: 404 position_missing).
    const fresh = !this.#positions.has(key);
    const e = this.#positionEntry(key);
    if (isNew && fresh) e.scannedAt = Date.now();
    e.keys.add(position.toBase58());
    e.owners.set(position.toBase58(), owner);
    e.tradedAt = Date.now();
  }

  /** Whether `owner` holds an open position on any take this API knows, as last read (no RPC). */
  #holds(owner: string): boolean {
    for (const e of this.#positions.values()) for (const o of e.owners.values()) if (o === owner) return true;
    return false;
  }

  /**
   * Takes whose positions `owner` may hold: those the owner index says it holds, and those whose
   * positions haven't been scanned yet (nothing is known about them).
   */
  #takesHeldBy(owner: string): string[] {
    return Object.entries(this.#state.takes).filter(([, m]) => {
      const e = this.#positions.get(m.address);
      return !e?.scannedAt || [...e.owners.values()].includes(owner);
    }).map(([id]) => id);
  }

  /**
   * Whether the take at `address` is inverted (its on-chain fade agrees with it). That never changes
   * for an account, so each is read once; a take that isn't there reads as not inverted, unkept.
   */
  async #isInverted(address: PublicKey): Promise<boolean> {
    const key = address.toBase58();
    const known = this.#invertedTakes.get(key);
    if (known !== undefined) return known;
    const take = await this.#program.account.take.fetchNullable(address);
    if (!take) return false;
    this.#invertedTakes.set(key, Boolean(take.inverted));
    return Boolean(take.inverted);
  }
  #invertedTakes = new Map<string, boolean>();

  async #config() {
    if (!this.#configCache || this.#configCache.at < Date.now() - 60_000) this.#configCache = { at: Date.now(), value: await fetchConfig(this.#program) };
    return this.#configCache.value;
  }
  #configCache: { at: number; value: Awaited<ReturnType<typeof fetchConfig>> } | null = null;

  /**
   * What a position is worth now: the tokens its trade bought, plus its escrowed prediction and card
   * share at the legs' paper marks (at cost while a leg has no entry or mark). Null if a token can't be priced.
   * After partial sales it's what's left: the tokens scale by remaining / stake (each sale sold that
   * share of them); the escrow and Phoenix children are read as they stand now.
   */
  async #positionWorth(
    take: TakeAccount,
    p: {
      publicKey: PublicKey;
      account: {
        owner: PublicKey; side: object; legsMask: number; escrowed: { toString(): string }; entrySet: number; prices: { entry: { toString(): string } }[];
        stake: { toString(): string }; remaining: { toString(): string };
      };
    },
    marks: (bigint | null)[],
  ): Promise<number | null> {
    const stake = Number(p.account.stake.toString());
    const left = stake > 0 ? Number(p.account.remaining.toString()) / stake : 1;
    const held = (i: number) => p.account.legsMask & (1 << i);
    const paper = take.legs.map((leg, i) => (held(i) && escrowedKind(leg.kind) ? i : -1)).filter((i) => i >= 0);
    // Legs held on Phoenix are valued from their child subaccounts, not tokens.
    const phoenix = this.#onPhoenix(take, p.account.side, p.account.legsMask);
    const notTokens = [...paper, ...phoenix].map((i) => take.legs[i].asset.toBuffer().toString("hex"));
    const tokenAssets = new Set([...legAssets(take, p.account.legsMask)].filter((hex) => !notTokens.includes(hex)));
    const [tokenValue, phoenixValue] = await Promise.all([
      tokenAssets.size ? this.#valuation.positionValue(p.publicKey, p.account.owner, tokenAssets) : 0,
      phoenix.length && this.#phoenix ? this.#phoenix.value(p.publicKey, p.account.owner) : 0,
    ]);
    if (tokenValue === null || phoenixValue === null) return null;
    const tokens = tokenValue * left + phoenixValue;
    const escrowed = Number(BigInt(p.account.escrowed.toString())) / USD;
    if (!paper.length || escrowed === 0) return tokens;
    const fade = "fade" in p.account.side;
    let weighted = 0;
    let total = 0;
    for (const i of paper) {
      const w = take.legs[i].weightBps;
      total += w;
      const entry = p.account.entrySet & (1 << i) ? Number(BigInt(p.account.prices[i].entry.toString())) / 1e8 : null;
      const mark = marks[i] != null ? Number(marks[i]) / 1e8 : null;
      // Value per dollar in, on the side held (a fade's prices are in the leg's terms).
      const ratio = entry === null || mark === null ? 1 : fade ? (1 - mark) / (1 - entry) : mark / entry;
      weighted += w * Math.max(0, ratio);
    }
    return tokens + escrowed * (weighted / total);
  }

  // --- Trades -----------------------------------------------------------------------------

  /**
   * A back or a fade, take-relative: "back" agrees with the take, "fade" disagrees. On an inverted
   * take those are an on-chain fade and back. An on-chain fade holds the other side of each
   * prediction leg, filled on paper with its share escrowed, and shorts the other legs on Phoenix;
   * legs it can't short are left out with the reason.
   */
  async buildTrade(takeId: string, owner: string, side: "back" | "fade", usd: number, o: BuildOpts = {}) {
    const ownerKey = parseKey(owner);
    const t = o.timings ?? new Timings();
    return this.#timed(`${side} build ${takeId.slice(0, 8)}`, t, async () => {
      const { address, venue, included, excluded, ix, position, feeUsd, escrowUsd, chain, inverted } =
        await this.#prepareBack(takeId, ownerKey, usd, this.#o.appPayer.publicKey, undefined, side, t, o.prebuild);
      const receiptCu = chain === "back" ? THESIS_COMPUTE_UNITS.back : THESIS_COMPUTE_UNITS.fade;
      const composed = await this.#compose(venue, ix, receiptCu, ownerKey, "back", position, true, false, {
        trade: { takeId, side: chain, ...(inverted ? { inverted } : {}), usd, included, receipt: ix, receiptCu }, quotedAt: t.quotedAt, prebuilt: o.prebuild, timings: t,
      });
      return this.#keep({ ...composed, take: address.toBase58(), side, stakeUsd: usd, feeUsd, escrowUsd, included, excluded });
    });
  }

  /**
   * Runs one build, refresh or submit, then logs where its time went (`what`, the build id when
   * there is one, and each step), whether it worked or failed.
   */
  async #timed<T>(what: string, t: Timings, work: () => Promise<T>, id?: (r: T) => string | undefined): Promise<T> {
    try {
      const r = await work();
      const buildId = id ? id(r) : (r as { buildId?: string })?.buildId;
      this.#log(`timing ${what}${buildId ? ` ${buildId.slice(0, 8)}` : ""} ${t.line()}`);
      return r;
    } catch (e) {
      this.#log(`timing ${what} failed (${e instanceof ApiError ? e.code : "error"}) ${t.line()}`);
      throw e;
    }
  }

  /**
   * Sells a position, or part of it: `bps` of what's left (1 to 10,000; or `usd`, converted from
   * what it's worth now; neither sells all). The wallet swaps that share of each spot leg's tokens
   * back to USDC, redeems that share of each yield leg's jlUSDC and closes that share of each
   * Phoenix leg's lots, and the program records the sale in the same transaction: `exit_position`
   * for all of it, `sell_part` for part (which keeps at least the minimum stake). Either way it
   * scores on the settler's prices at the sale.
   */
  async buildExit(takeId: string, address: string, wallet: string, o: BuildOpts & SaleAmount = {}) {
    const t = o.timings ?? new Timings();
    return this.#timed(`sale build ${takeId.slice(0, 8)}`, t, async () => {
      const owner = parseKey(wallet);
      const position = parseKey(address);
      // A sale of this position that stopped partway: selling it again finishes that sale.
      await t.time("pending", () => this.#afterPending(owner.toBase58()));
      const stopped = this.#stoppedSale(owner.toBase58(), [position.toBase58()]);
      if (stopped) return this.#keep(await this.#finishSale(...stopped, t, o));
      const ctx = await this.#saleContext(takeId, owner, [position], t);
      const holding = ctx.holdings[0];
      // What it's worth is read only to size a dollar amount, or to say how much can be sold.
      const worth = lazy(async () => (await this.#saleValues(ctx, [holding]))[0]);
      const bps = saleBps(o, hasUsd(o) ? await worth() : 0);
      const sale = positionSale(holding.view, bps, ctx.minStake);
      if (!sale.ok) throw saleError(sale.code, positionMaxPartialBps(holding.view, ctx.minStake), await worth(), ctx.minStakeUsd);
      const built = await this.#buildSale(ctx, [{ holding, bps, sale }], t, o);
      // The part sold is worth what selling it brings in; what's left, in proportion.
      const soldValue = built.expectedUsd;
      return this.#keep({
        ...built,
        bps,
        full: sale.full,
        sale: {
          stakeUsd: Number(sale.sold) / USD,
          remainingStakeUsd: Number(sale.left) / USD,
          valueUsd: soldValue,
          remainingValueUsd: sale.full ? 0 : (soldValue * (FULL_BPS - bps)) / bps,
        },
      });
    });
  }

  /**
   * Sells `bps` (or `usd`) of the wallet's whole holding in a take on one side: whole positions
   * first, smallest first, then at most one partial sale, in one build and one approval
   * (`planHoldingSale`; the author's buy-in last, and whole only when all of it sells, since that
   * closes the take). The apps group positions by take and side, so their Sell tab uses this.
   */
  async buildHoldingSale(takeId: string, wallet: string, side: "back" | "fade", o: BuildOpts & SaleAmount = {}) {
    const t = o.timings ?? new Timings();
    return this.#timed(`holding sale build ${takeId.slice(0, 8)}`, t, async () => {
      const owner = parseKey(wallet);
      const mirror = this.#state.takes[takeId];
      if (!mirror) throw new ApiError(404, "take_missing");
      const takeKey = new PublicKey(mirror.address);
      // `side` is take-relative ("back" agrees): on an inverted take that's its on-chain fades.
      const [positions, inverted] = await Promise.all([this.#positionsOf(takeKey), this.#isInverted(takeKey)]);
      const chain = chainSide(side, { inverted });
      const held = positions.filter((p) =>
        p.account.owner.equals(owner) && !p.account.exited && ("back" in p.account.side ? "back" : "fade") === chain);
      if (!held.length) throw new ApiError(404, "position_missing", "You hold nothing on that side of this take.");
      // A sale of these positions that stopped partway: selling again finishes that sale.
      await t.time("pending", () => this.#afterPending(owner.toBase58()));
      const stopped = this.#stoppedSale(owner.toBase58(), held.map((p) => p.publicKey.toBase58()));
      if (stopped) return this.#keep(await this.#finishSale(...stopped, t, o));
      const ctx = await this.#saleContext(takeId, owner, held.map((p) => p.publicKey), t);
      const total = lazy(async () => (await this.#saleValues(ctx, ctx.holdings)).reduce((n, v) => n + v, 0));
      const bps = saleBps(o, hasUsd(o) ? await total() : 0);
      // The author's buy-in sells last, and whole only when all of the holding sells.
      const views = ctx.holdings.map((h) => ({ address: h.address.toBase58(), ...h.view, buyIn: h.account.id.isZero() && h.account.owner.equals(ctx.take.author) }));
      const plan = planHoldingSale(views, bps, ctx.minStake);
      if ("error" in plan) throw saleError(plan.error, holdingMaxPartialBps(views, ctx.minStake), await total(), ctx.minStakeUsd);
      const byAddress = new Map(ctx.holdings.map((h) => [h.address.toBase58(), h]));
      const targets = [
        ...plan.whole.map((a) => ({ holding: byAddress.get(a)!, bps: FULL_BPS })),
        ...(plan.part ? [{ holding: byAddress.get(plan.part.address)!, bps: plan.part.bps }] : []),
      ].map((x) => ({ ...x, sale: positionSale(x.holding.view, x.bps, ctx.minStake) as Extract<PositionSale, { ok: true }> }));
      const built = await this.#buildSale(ctx, targets, t, o);
      const remaining = ctx.holdings.reduce((n, h) => n + h.view.remaining, 0n);
      const soldValue = built.expectedUsd;
      const left = remaining - plan.sold;
      return this.#keep({
        ...built,
        bps,
        full: left === 0n,
        sale: {
          stakeUsd: Number(plan.sold) / USD,
          remainingStakeUsd: Number(left) / USD,
          valueUsd: soldValue,
          remainingValueUsd: plan.sold > 0n ? (soldValue * Number(left)) / Number(plan.sold) : 0,
        },
        positions: targets.map((x) => x.holding.address.toBase58()),
      });
    });
  }

  /** The take and the positions a sale reads, checked: the wallet's, open, before the horizon. */
  async #saleContext(takeId: string, owner: PublicKey, positions: PublicKey[], t: Timings): Promise<SaleContext> {
    const mirror = this.#state.takes[takeId];
    if (!mirror) throw new ApiError(404, "take_missing");
    for (const p of positions) if (this.#pendingExits.has(p.toBase58())) throw new ApiError(409, "already_exited", "This position is being sold.");
    // A sale right after the back: the back may still be confirming (until=accepted).
    await t.time("pending", () => this.#afterPending(owner.toBase58()));
    const takeKey = new PublicKey(mirror.address);
    const [take, accounts, config] = await t.time("position", () => Promise.all([
      this.#program.account.take.fetchNullable(takeKey),
      this.#program.account.position.fetchMultiple(positions),
      this.#config(),
    ]));
    const holdings = positions.map((address, i) => {
      const account = accounts[i];
      if (!account?.owner.equals(owner) || !account.take.equals(takeKey)) throw new ApiError(404, "position_missing");
      if (account.exited) throw new ApiError(409, "already_exited", "This position has already been sold.");
      return { address, account, view: { remaining: BigInt(account.remaining.toString()), openParts: account.parts - account.partsSettled } };
    });
    // Any status before the horizon: holders can sell after the author has (the take closed or settled).
    if (!take || take.horizonEnd.toNumber() <= Date.now() / 1000) throw new ApiError(409, "take_closed", TAKE_ENDED);
    for (const h of holdings) {
      const legs = take.legs.filter((_, i) => h.account.legsMask & (1 << i));
      if (!legs.length || legs.some((leg) => !SELLABLE(leg.kind))) {
        throw new ApiError(422, "not_sellable", "Only spot, yield, perp, prediction and card legs can be sold on the fork.");
      }
      if (this.#onPhoenix(take, h.account.side, h.account.legsMask).length && !this.#phoenix) throw new ApiError(422, "not_sellable", "Phoenix isn't connected on this fork.");
    }
    const minStake = BigInt(config.params.minStake.toString());
    return { takeId, owner, takeKey, take, config, holdings, minStake, minStakeUsd: Number(minStake) / USD };
  }

  /** What each position is worth now (what's left of it), for sizing a `usd` sale; its cost basis when a price is missing. */
  async #saleValues(ctx: SaleContext, holdings: SaleHolding[]): Promise<number[]> {
    const marks = await this.#valuation.marks(ctx.take, this.#mapLegs((await this.#appTake(ctx.takeId)).legs), holdings.map((h) => ({ publicKey: h.address, account: h.account }))).catch(() => new Map<string, (bigint | null)[]>());
    return Promise.all(holdings.map(async (h) => {
      const worth = await this.#positionWorth(ctx.take, { publicKey: h.address, account: h.account }, marks.get(h.address.toBase58()) ?? []).catch(() => null);
      return worth ?? Number(h.view.remaining) / USD;
    }));
  }

  /**
   * One build selling each target's share: its Phoenix closes, swaps and redeems, then its
   * `exit_position` or `sell_part`, the swaps of a token several targets sell merged into one
   * (api/sales.ts). The last target's instruction is the build's receipt; the others ride as legs
   * before it, after every swap. It may take several transactions (records last).
   */
  async #buildSale(ctx: SaleContext, targets: SaleTarget[], t: Timings, o: BuildOpts) {
    const { owner, take, takeKey, config } = ctx;
    const inventoryStarted = Date.now();
    const tokens = this.#o.bank().tokens;
    const payer = this.#o.appPayer.publicKey;
    const appLegs = targets.some((x) => this.#onPhoenix(take, x.holding.account.side, x.holding.account.legsMask).length)
      ? (await this.#appTake(ctx.takeId).catch(() => null))?.legs
      : undefined;
    const names = new Map(take.legs.map((_, i) => [i, appLegs?.[i]?.name ?? `Leg ${i + 1}`] as const));
    // What each target sells of each token it bought (a share of the trade's tokens).
    const pieces = await Promise.all(targets.map(async ({ holding, bps, sale }) => {
      const { address: position, account } = holding;
      const legs = take.legs.filter((_, i) => account.legsMask & (1 << i));
      const onPhoenix = this.#onPhoenix(take, account.side, account.legsMask);
      const phoenixAssets = new Set(onPhoenix.map((i) => take.legs[i].asset.toBuffer().toString("hex")));
      const bought = await this.#valuation.bought(position, owner);
      const stake = BigInt(account.stake.toString());
      // A spot leg's asset is its underlying; a yield leg's is the vault token itself (`token:<mint>`).
      // Prediction and card legs hold no tokens: the sale pays their escrow back.
      const inventory = legs.filter((leg) => !escrowedKind(leg.kind) && !phoenixAssets.has(leg.asset.toBuffer().toString("hex"))).map((leg) => {
        const asset = leg.asset.toBuffer().toString("hex");
        const isYield = "yield" in leg.kind;
        const matches = [...bought].filter(([mint]) =>
          isYield ? underlyingIdHex(`token:${mint}`) === asset : Boolean(tokens[mint]) && underlyingIdHex(tokens[mint].underlying) === asset);
        if (matches.length !== 1) throw new ApiError(422, "inventory_unavailable", "The receipt transaction must identify every token bought by this position.");
        const amount = tokensToSell(matches[0][1], stake, holding.view.remaining, sale.left);
        return { mint: matches[0][0], amount, isYield };
      });
      if (new Set(inventory.map((l) => l.mint)).size !== inventory.length) throw new ApiError(422, "inventory_unavailable");
      const seq = account.parts;
      const ix = sale.full
        ? await exitPositionIx(this.#program, { owner, take: takeKey, position, payer })
        : await sellPartIx(this.#program, { owner, take: takeKey, position, seq, bps, payer });
      const fee = splitFee(stake, config.params, { isAuthor: take.author.equals(owner) }).fee;
      // The original stake and cost, unscaled: what the receipt shows for a sold position.
      const exit: ExitReceipt | undefined = sale.full
        ? {
          horizonEnd: take.horizonEnd.toNumber(),
          owner: owner.toBase58(),
          side: "back" in account.side ? "back" : "fade",
          stakeUsd: Number(stake) / USD,
          costUsd: Number(stake + fee) / USD,
          openedAt: account.openedAt.toNumber(),
          legsMask: account.legsMask,
        }
        : undefined;
      return {
        position, bps, sale, seq, ix, exit,
        inventory: inventory.filter((l) => l.amount > 0n),
        onPhoenix,
        escrowUsd: Number(escrowReturned(BigInt(account.escrowed.toString()), bps)) / USD,
        closesTake: sale.full && account.id.isZero() && account.owner.equals(take.author) && "open" in take.status,
      };
    }));
    // One swap (or redeem) per token, however many of the positions sell it, checked against the
    // wallet's balance.
    const merged = mergeInventory(pieces.map((p) => p.inventory));
    await Promise.all(merged.map(async ({ mint, amount, isYield }) => {
      if ((await this.#tokenBalance(owner, mint, isYield)) < amount) throw new ApiError(409, "insufficient_tokens", "Your wallet no longer holds all the tokens this position bought.");
    }));
    t.add("inventory", Date.now() - inventoryStarted);
    // Every Jupiter call of the sale goes through the budget, in the build's lane.
    const use = newUse(laneOf(o.prebuild));
    const jupiter = this.#router.jupiter(use.lane, use);
    const access = { apiKey: jupiter.apiKey, fetchFn: jupiter.fetchFn, max429WaitMs: jupiter.max429WaitMs };
    // Redeeming jlUSDC has no slippage: it's worth its shares at the vault's rate, read exactly
    // from Jupiter Lend (totalAssets / totalSupply), with Jupiter's token price as a fallback. Each
    // read is tried twice, then the last value known stands in (it only sizes the proceeds shown).
    const redeems = merged.filter((l) => l.isYield);
    const [shareValue, redeemLegs] = await t.time("redeems", () => Promise.all([
      this.#redeemValue(redeems),
      Promise.all(redeems.map(({ amount }) => jupiterLendRedeem({ ...access, user: owner, payer, shares: amount, label: "Withdraw jlUSDC", apiKey: this.#o.jupiterApiKey! }))),
    ]));
    if (shareValue == null) throw new ApiError(422, "no_exit_route", "Couldn't price this position's yield shares.");
    // Phoenix legs: close each child's position, or the sale's share of its lots. After a whole
    // sale the cash stays in the child and the app sweeps it (`buildPhoenixCashOut`), since Phoenix
    // won't withdraw more than is there. A partial sale also moves the closed share's margin to the
    // parent at the child's current leverage (`reduceLegs`), so what's left keeps its leverage, and
    // the cash-out withdraws it from there.
    const noPrice = () => new ApiError(422, "no_exit_route", "Phoenix has no price for one of this position's markets right now.");
    const phoenix = await t.time("phoenix", () => Promise.all(pieces.map(async (p) => {
      if (!p.onPhoenix.length) return { closes: [] as PhoenixClose[], usd: 0, notional: 0, cashOut: false };
      if (!p.sale.full) {
        const part = await this.#phoenix!.reduceLegs(p.position, owner, names, p.bps);
        if (part === null) throw noPrice();
        return { closes: part.legs, usd: part.usd, notional: part.notional, cashOut: part.released };
      }
      const [closes, worth] = await Promise.all([this.#phoenix!.closeLegs(p.position, owner, names), this.#phoenix!.valueAndNotional(p.position, owner)]);
      if (worth === null) throw noPrice();
      return { closes, usd: worth.usd, notional: worth.notional, cashOut: true };
    })));
    const closes = phoenix.reduce((n, x) => n + x.closes.length, 0);
    const escrowUsd = pieces.reduce((n, p) => n + p.escrowUsd, 0);
    const last = pieces[pieces.length - 1];
    const records = pieces.map((p) => ({ position: p.position.toBase58(), ix: serializeIx(p.ix), cu: recordCu(p.sale.full) }));
    const quoteExit = async (maxAccounts: number, fresh: boolean) => {
      // Each token's swap back to USDC: repriced from a kept sell route, or quoted afresh (api/routing.ts).
      const swaps = await t.time("quotes", () => this.#router.sellSwaps(
        merged.filter((l) => !l.isYield).map(({ mint, amount }) => ({ mint, amount, label: `Sell ${tokens[mint].symbol}` })),
        owner, payer, { lane: use.lane, use, maxAccounts, fresh },
      ));
      t.quotedAt ??= Date.now();
      // Phoenix closes, swaps and redeems first, then each position's record; the last record is
      // the receipt. When it takes several transactions the records ride in the last one(s).
      const legs: { venue: VenueLeg; step: SaleStep | null }[] = [
        ...pieces.flatMap((p, i) => phoenix[i].closes.map((c) => ({ venue: c as VenueLeg, step: { kind: "phoenix" as const, position: p.position.toBase58(), leg: c.leg } }))),
        ...swaps.map((s) => ({ venue: s.venue as VenueLeg, step: { kind: "sell" as const, mint: s.mint, amount: s.amount.toString() } })),
        ...redeems.map((r, i) => ({ venue: redeemLegs[i] as VenueLeg, step: { kind: "redeem" as const, mint: r.mint, amount: r.amount.toString() } })),
        ...pieces.filter((p) => p !== last).map((p) => ({ venue: recordLeg(p.ix, p.sale.full), step: { kind: "record" as const, position: p.position.toBase58() } })),
      ];
      const sales = pieces.map((p) => ({ address: p.position, seq: p.seq, full: p.sale.full, bps: p.bps, horizonEnd: take.horizonEnd.toNumber(), ...(p.exit ? { exit: p.exit } : {}) }));
      const built = await this.#compose(
        legs.map((l) => l.venue), last.ix, recordCu(last.sale.full), owner, "exit",
        { take: takeKey, address: last.position, ...(last.exit ? { exit: last.exit } : {}), sales },
        false, closes > 0,
        {
          timings: t, quotedAt: t.quotedAt, prebuilt: o.prebuild,
          sale: { takeId: ctx.takeId, steps: legs.map((l) => l.step), receipt: { kind: "record", position: last.position.toBase58() }, records },
        },
      );
      const swapped = (k: "outAmount" | "otherAmountThreshold") => Number(swaps.reduce((n, s) => n + BigInt(s.quote[k]), 0n)) / USD;
      // The sale pays its share of the escrow back, in the same transaction. Phoenix legs close at
      // most 1% from the mid (DEFAULT_SLIPPAGE).
      const phx = phoenix.reduce((n, x) => ({ expected: n.expected + x.usd, minimum: n.minimum + x.usd - 0.01 * x.notional }), { expected: 0, minimum: 0 });
      return {
        ...built,
        escrowUsd,
        /** This sale sells all of the author's buy-in on an open take: it closes the take, and its result is final at the sale. */
        closesTake: pieces.some((p) => p.closesTake),
        expectedUsd: swapped("outAmount") + shareValue + escrowUsd + phx.expected,
        minimumUsd: swapped("otherAmountThreshold") + shareValue + escrowUsd + phx.minimum,
        /**
         * Phoenix legs sold, whole or in part (the margin a part freed): once this lands, build
         * `phoenix/cash-out` to move that cash back to USDC.
         */
        phoenixCashOut: phoenix.some((x) => x.cashOut),
      };
    };
    try {
      return await quoteExit(this.#router.route.maxAccounts, false);
    } catch (error) {
      if (!tooBig(error)) throw error;
      // A swap too big for a transaction on its own: simpler Jupiter routes, quoted afresh.
      return await quoteExit(20, true).catch((e: unknown) => {
        throw tooBig(e) ? new ApiError(422, "exit_too_large", "A swap in this sale doesn't fit in a transaction.") : e;
      });
    } finally {
      noteUse(t, use);
    }
  }

  /** What `owner` holds of `mint` (vault shares when `isYield`), 0 without an account. */
  async #tokenBalance(owner: PublicKey, mint: string, isYield: boolean): Promise<bigint> {
    const program = isYield ? "spl" : this.#o.bank().tokens[mint]?.program;
    if (!program || program === "unknown") throw new ApiError(422, "inventory_unavailable", "The token program for this position is unknown.");
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, program === "token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
    return this.#o.connection.getTokenAccountBalance(ata, "confirmed").then((r) => BigInt(r.value.amount)).catch(() => 0n);
  }

  /** What redeeming these vault shares brings in (USD), null when it can't be priced. */
  async #redeemValue(redeems: { mint: string; amount: bigint }[]): Promise<number | null> {
    let usd = 0;
    for (const { mint, amount } of redeems) {
      const perShare = await this.#valuation.lendShareValue(mint, { retry: true });
      if (perShare === null) return this.#valuation.tokensUsd(redeems.map((l) => [l.mint, l.amount]));
      usd += (Number(amount) / 1e6) * perShare; // vault shares have USDC's 6 decimals
    }
    return usd;
  }

  /** The owner's stopped sale (api/sales.ts) that sells any of `positions`, with its key; drops ones past their time. */
  #stoppedSale(owner: string, positions: string[]): [string, StoppedSale] | null {
    const all = this.#state.stoppedSales ?? {};
    const now = Date.now();
    for (const [key, s] of Object.entries(all)) {
      if (s.at <= now - STOPPED_SALE_TTL_MS) {
        delete all[key];
        this.#save();
        continue;
      }
      if (s.owner === owner && s.sales.some((x) => positions.includes(x.address))) return [key, s];
    }
    return null;
  }

  /**
   * Finishes a sale that stopped partway (api/sales.ts): what its transactions that didn't land
   * carried (Phoenix closes, swaps and redeems at the same sizes, at most what the wallet still
   * holds), then the records still needed (the positions on-chain say which), in one build. It
   * answers what the sale first answered, with `finishing: true`. 409 `sale_pending` while one of
   * its transactions may still land; 409 `sale_complete` when every record landed after all.
   */
  async #finishSale(key: string, rec: StoppedSale, t: Timings, o: BuildOpts) {
    const owner = new PublicKey(rec.owner);
    const take = new PublicKey(rec.take);
    for (const x of rec.sales) if (this.#pendingExits.has(x.address)) throw new ApiError(409, "already_exited", "This position is being sold.");
    const conn = this.#o.connection;
    const [height, statuses, accounts, takeAccount] = await t.time("position", () => Promise.all([
      conn.getBlockHeight("confirmed"),
      conn.getSignatureStatuses(rec.txs.map((x) => x.signature), { searchTransactionHistory: true }).then((r) => r.value),
      this.#program.account.position.fetchMultiple(rec.sales.map((x) => new PublicKey(x.address)), "confirmed"),
      this.#program.account.take.fetchNullable(take, "confirmed"),
    ]));
    const fates: TxFate[] = rec.txs.map((x, i) => {
      const s = statuses[i];
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return s.err ? "failed" : "landed";
      return s || height <= x.lastValid ? "pending" : "failed";
    });
    const left = saleLeft(rec.txs, fates);
    if (!left) throw new ApiError(409, "sale_pending", "This sale is still going through. Try again in a moment.");
    // A record is still needed while its position is open and, for a part, still at its seq.
    const needed = rec.sales.filter((x, i) => {
      const a = accounts[i];
      return a && !a.exited && (x.full || a.parts === x.seq);
    });
    const done = rec.sales.filter((x) => !needed.includes(x));
    // Whole sales whose record landed: noted now (their positions are exited, or settled and closed).
    this.#noteSold(take, done.filter((x) => x.exit && accounts[rec.sales.indexOf(x)]?.exited !== false).map((x) => ({ address: x.address, exit: x.exit! })));
    if (!needed.length) {
      delete this.#state.stoppedSales?.[key];
      this.#save();
      const leftover = left.sells.size + left.redeems.size + left.phoenix.length > 0;
      throw new ApiError(409, "sale_complete", leftover
        ? "This sale went through after all. Some of the tokens it sold didn't swap back to cash and are still in your wallet."
        : "This sale went through after all.");
    }
    if (!takeAccount || takeAccount.horizonEnd.toNumber() <= Date.now() / 1000) throw new ApiError(409, "take_closed", TAKE_ENDED);
    const payer = this.#o.appPayer.publicKey;
    const tokens = this.#o.bank().tokens;
    const atMost = async (mint: string, amount: bigint, isYield: boolean) => {
      const held = await this.#tokenBalance(owner, mint, isYield).catch(() => 0n);
      return held < amount ? held : amount;
    };
    const [sells, redeems] = await Promise.all([
      Promise.all([...left.sells].map(async ([mint, amount]) => ({ mint, amount: await atMost(mint, amount, false) }))),
      Promise.all([...left.redeems].map(async ([mint, amount]) => ({ mint, amount: await atMost(mint, amount, true) }))),
    ]);
    const use = newUse(laneOf(o.prebuild));
    try {
      const jupiter = this.#router.jupiter(use.lane, use);
      const redeemLegs = await Promise.all(redeems.filter((r) => r.amount > 0n).map(async (r) => ({
        r,
        venue: await jupiterLendRedeem({ fetchFn: jupiter.fetchFn, max429WaitMs: jupiter.max429WaitMs, user: owner, payer, shares: r.amount, label: "Withdraw jlUSDC", apiKey: this.#o.jupiterApiKey! }),
      })));
      // Phoenix legs whose close didn't land, rebuilt for positions whose record is still needed.
      const names = new Map(((await this.#appTake(rec.takeId).catch(() => null))?.legs ?? []).map((l, i) => [i, l.name] as const));
      const closes = (await Promise.all(needed.map(async (x) => {
        const legs = new Set(left.phoenix.filter((p) => p.position === x.address).map((p) => p.leg));
        if (!legs.size || !this.#phoenix) return [];
        const position = new PublicKey(x.address);
        const built = x.full ? await this.#phoenix.closeLegs(position, owner, names) : (await this.#phoenix.reduceLegs(position, owner, names, x.bps ?? FULL_BPS))?.legs;
        if (!built) throw new ApiError(422, "no_exit_route", "Phoenix has no price for one of this position's markets right now.");
        return built.filter((c) => legs.has(c.leg)).map((c) => ({ venue: c as VenueLeg, step: { kind: "phoenix" as const, position: x.address, leg: c.leg } }));
      }))).flat();
      const swaps = await t.time("quotes", () => this.#router.sellSwaps(
        sells.filter((s) => s.amount > 0n).map((s) => ({ ...s, label: `Sell ${tokens[s.mint]?.symbol ?? s.mint.slice(0, 4)}` })),
        owner, payer, { lane: use.lane, use },
      ));
      t.quotedAt ??= Date.now();
      const recordOf = new Map(rec.records.map((r) => [r.position, r]));
      const last = needed[needed.length - 1];
      const legs: { venue: VenueLeg; step: SaleStep | null }[] = [
        ...closes,
        ...swaps.map((s) => ({ venue: s.venue as VenueLeg, step: { kind: "sell" as const, mint: s.mint, amount: s.amount.toString() } })),
        ...redeemLegs.map(({ r, venue }) => ({ venue: venue as VenueLeg, step: { kind: "redeem" as const, mint: r.mint, amount: r.amount.toString() } })),
        ...needed.slice(0, -1).map((x) => ({ venue: recordLeg(deserializeIx(recordOf.get(x.address)!.ix), x.full), step: { kind: "record" as const, position: x.address } })),
      ];
      const sales = needed.map((x) => ({ ...x, address: new PublicKey(x.address) }));
      const built = await this.#compose(
        legs.map((l) => l.venue), deserializeIx(recordOf.get(last.address)!.ix), recordOf.get(last.address)!.cu, owner, "exit",
        { take, address: new PublicKey(last.address), ...(last.exit ? { exit: last.exit } : {}), sales },
        false, closes.length > 0,
        {
          timings: t, quotedAt: t.quotedAt, prebuilt: o.prebuild,
          sale: { takeId: rec.takeId, steps: legs.map((l) => l.step), receipt: { kind: "record", position: last.address }, records: rec.records, finish: key },
        },
      );
      this.#log(`finishing a stopped sale of ${rec.owner.slice(0, 6)}… (${needed.length} record(s), ${swaps.length} swap(s), ${redeemLegs.length} redeem(s), ${closes.length} Phoenix close(s))`);
      return { ...(rec.summary as SaleSummary), ...built, finishing: true as const };
    } finally {
      noteUse(t, use);
    }
  }

  /** Notes sales that landed whole, so the receipt still shows them after their positions settle and close. */
  #noteSold(take: PublicKey, sold: { address: PublicKey | string; exit: ExitReceipt }[]) {
    if (!sold.length) return;
    const byTake = ((this.#state.exits ??= {})[take.toBase58()] ??= {});
    for (const x of sold) {
      const address = x.address.toString();
      byTake[address] = { ...x.exit, exitedAt: Math.floor(Date.now() / 1000) };
      // A position sold whole is no longer held (the next read of the take confirms it).
      this.#positions.get(take.toBase58())?.owners.delete(address);
    }
    this.#save();
  }

  /** Sales this service submitted whose positions have since settled and closed. */
  #settledExits(take: PublicKey, viewer: string, live: Set<string>, minStakeUsd: number, inverted: boolean) {
    return Object.entries(this.#state.exits?.[take.toBase58()] ?? {})
      .filter(([address, exit]) => exit.owner === viewer && !live.has(address))
      .map(([address, exit]) => ({
        address,
        // Kept on-chain; shown take-relative, as the receipt's open positions are.
        side: chainSide(exit.side ?? "back", { inverted }),
        exited: true,
        canExit: false,
        remainingStakeUsd: 0,
        soldStakeUsd: exit.stakeUsd,
        realizedPnlUsd: null,
        pendingSales: [] as { seq: number; bps: number; stakeUsd: number; soldAt: number; priced: boolean }[],
        minStakeUsd,
        maxPartialBps: null,
        closesTakeIfSoldAll: false,
        stakeUsd: exit.stakeUsd,
        costUsd: exit.costUsd,
        openedAt: exit.openedAt,
        legsMask: exit.legsMask,
        valueUsd: null,
        returnBps: null,
        pendingLegs: [],
        pendingNote: "Sold. It scored on the prices at the sale.",
      }));
  }

  /** Read-only metadata. A Blink can only back a take that's already on the fork. */
  async blinkTake(takeId: string) {
    const app = await this.#appTake(takeId);
    if (app.status === "posting") throw new ApiError(409, "take_posting", "This take isn't on-chain yet.");
    const existing = await this.#existingBlinkTake(takeId, app);
    const legs = this.#mapLegs(app.legs);
    return {
      claim: app.claim,
      handle: app.author?.handle,
      legs: app.legs,
      // The Blink only backs on-chain: on an inverted take that would disagree with it, so it can't.
      canBack: existing !== null && !existing.take.inverted && onChainLegs(legs, existing.take.legs).some((leg) => !this.#router.leftOut(leg)),
    };
  }

  async buildBlinkBack(takeId: string, account: string, usd: number, checkout = false) {
    const owner = parseKey(account);
    // One signature means one transaction. Up to BLINK_MAX_LEGS legs usually fit with the
    // proof-of-trade checks; when a build's routes are too big, its lightest leg moves to the app
    // ("Open Thesis for the full basket") and the rest is built again.
    let maxLegs = BLINK_MAX_LEGS;
    let built: { prepared: Awaited<ReturnType<ForkService["prepareBlinkBack"]>>; tx: VersionedTransaction } | null = null;
    while (!built) {
      const prepared = await this.prepareBlinkBack(takeId, owner, usd, maxLegs);
      // Fresh pools before the composer simulates the transaction.
      await this.#o.fork.refreshMarkets(prepared.venue.flatMap((leg) => leg.marketAccounts));
      const txs = await composeTransactions({
        payer: owner,
        legs: prepared.venue,
        receipt: prepared.ix,
        receiptCu: THESIS_COMPUTE_UNITS.back,
        lookupTables: this.#o.lookupTable ? [this.#o.lookupTable] : [],
        connection: this.#o.connection,
        proof: { program: this.#program, owner, position: prepared.position.address },
      });
      if (txs.length === 1) built = { prepared, tx: txs[0].tx };
      else if (prepared.included.length <= 1) throw new ApiError(422, "blink_too_large", "This basket doesn't fit in one signature. Open the full take in Thesis.");
      else maxLegs = prepared.included.length - 1;
    }
    const { tx } = built;
    const { feeUsd, included, excluded, position } = built.prepared;
    let checkoutId: string | undefined;
    if (checkout) {
      if (this.#blinkCheckouts.size >= 200) throw new ApiError(503, "checkout_busy", "Checkout is busy. Try again in a minute.");
      // The browser signs only. Use the latest hash from the same fork that will
      // relay the transaction, as required for an unsigned Action.
      const latest = await this.#o.connection.getLatestBlockhash("confirmed");
      tx.message.recentBlockhash = latest.blockhash;
      checkoutId = randomUUID();
      const id = checkoutId;
      this.#blinkCheckouts.set(id, { ...latest, message: Buffer.from(tx.message.serialize()), position });
      setTimeout(() => this.#blinkCheckouts.delete(id), 2 * BUILD_TTL_MS).unref();
    }
    return { transaction: Buffer.from(tx.serialize()).toString("base64"), feeUsd, included, excluded, checkoutId };
  }

  /** The Blink's back with at most `maxLegs` legs (public so the size fallback can be tested). */
  prepareBlinkBack(takeId: string, owner: PublicKey, usd: number, maxLegs: number) {
    return this.#prepareBack(takeId, owner, usd, owner, maxLegs);
  }

  /** Relay only the exact transaction prepared for this checkout. The server never signs it. */
  async submitBlinkBack(id: string, transaction: string) {
    const checkout = this.#blinkCheckouts.get(id);
    if (!checkout) throw new ApiError(410, "checkout_expired", "Checkout expired. Check the take receipt before trying again.");
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
    } catch {
      throw new ApiError(400, "invalid_transaction", "The wallet returned an invalid transaction.");
    }
    if (!checkout.message.equals(tx.message.serialize()) || tx.signatures.length !== 1 || !tx.signatures[0].some(Boolean)) {
      throw new ApiError(400, "transaction_changed", "The wallet changed the transaction or did not sign it.");
    }

    const owner = tx.message.staticAccountKeys[0].toBase58();
    checkout.submission ??= this.#store.withWallet(owner, async () => {
      const conn = this.#o.connection;
      const signature = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
      const result = await conn.confirmTransaction({
        signature, blockhash: checkout.blockhash, lastValidBlockHeight: checkout.lastValidBlockHeight,
      }, "confirmed");
      if (result.value.err) throw new ApiError(409, "transaction_failed", "The fork rejected this transaction.");
      this.#valuation.recordOpening(checkout.position.address, [signature]);
      this.#save();
      this.#notePosition(checkout.position.take, checkout.position.address, owner);
      this.#wallets.forgetActivity(owner);
      void this.#history.snapshot(owner).catch(() => {});
      return signature;
    }).catch((error) => {
      checkout.submission = undefined;
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, "confirmation_unavailable", "Could not confirm the back. Retry the same signed transaction or check the take receipt.");
    });
    return { signature: await checkout.submission };
  }

  async #existingBlinkTake(takeId: string, app: AppTake) {
    const mirror = this.#state.takes[takeId];
    if (!mirror || staleDemo(mirror)) return null;
    const address = new PublicKey(mirror.address);
    const take = await this.#program.account.take.fetchNullable(address);
    if (!take || !("open" in take.status) || take.horizonEnd.toNumber() <= Math.floor(Date.now() / 1000)) return null;
    if (mirror.demoAuthorKey && !sameLegs(take.legs, this.#mapLegs(app.legs), { onChain: take.inverted, app: app.inverted })) return null;
    return { address, take };
  }

  /**
   * A back or fade's receipt and venue legs. `side` is take-relative ("fade" disagrees); `chain`, in
   * the answer, is the on-chain side it trades (flipped on an inverted take).
   */
  async #prepareBack(takeId: string, owner: PublicKey, usd: number, payer: PublicKey, maxLegs?: number, side: "back" | "fade" = "back", t = new Timings(), prebuild = false) {
    checkAmount(usd);
    await t.time("funds", () => this.#checkFunds(owner, usd));
    const app = await t.time("take", () => this.#appTake(takeId));
    // Nobody but the author knows a posting take's id; still, nothing trades it before it's on-chain.
    if (app.status === "posting") throw new ApiError(409, "take_posting", "This take isn't on-chain yet.");
    const existing = await t.time("mirror", () => (maxLegs === undefined ? this.#ensureOnChain(takeId, app) : this.#existingBlinkTake(takeId, app)));
    if (!existing || !takeOpen(existing.take)) {
      if (maxLegs !== undefined) throw new ApiError(409, "take_closed", "This take is not open on the fork.");
      throw takeClosedError(existing?.take);
    }
    const { address, take } = existing;
    // Authors can't fade (disagree with) their own take. The program refuses it too; this says why
    // before a build. Checked take-relative, before the side is turned into the on-chain one.
    if (side === "fade" && take.author.equals(owner)) throw new ApiError(409, "cannot_fade_own_take", FADE_OWN_TAKE);
    const inverted = Boolean(take.inverted);
    // The Blink only backs on-chain, and agreeing with an inverted take is a fade (blinkTake says it can't).
    if (maxLegs !== undefined && inverted) throw new ApiError(409, "open_in_app", "This take bets against its basket. Open it in Thesis to trade it.");
    const chain = chainSide(side, take);
    const use = newUse(laneOf(prebuild));
    const [{ venue, included, excluded }, config] = await t.time("legs", () => Promise.all([
      // The Blink (maxLegs) buys spot and yield legs only: Gemini legs are in the app.
      this.#router.venueLegs(onChainLegs(this.#mapLegs(app.legs), take.legs), owner, usd, payer, maxLegs, { side: chain, paper: maxLegs === undefined, lane: use.lane, use }).catch((e: unknown) => {
        // Nothing to disagree with right now: a fade (or, on an inverted take, a back) finds no leg.
        if (side === "fade" && e instanceof ApiError && e.code === "nothing_tradable") throw new ApiError(409, "fade_unavailable", inverted ? AGAINST_INVERTED_NOTHING : FADE_NOTHING);
        if (chain === "fade" && e instanceof ApiError && e.code === "nothing_tradable") throw new ApiError(422, "nothing_tradable", INVERTED_NOTHING);
        throw e;
      }),
      this.#config(),
    ])).finally(() => noteUse(t, use));
    t.quotedAt ??= Date.now();
    const mask = included.reduce((m, i) => m | (1 << i), 0);
    const id = randomPositionId();
    const stake = Math.round(usd * USD);
    const build = chain === "back" ? backIx : fadeIx;
    const ix = await build(this.#program, {
      owner, payer, take: address, id, stake: new BN(stake), legsMask: mask,
    });
    const position = { take: address, address: positionAddress(address, owner, id) };
    this.#recordPhoenix(position.address, owner, venue);
    const fee = splitFee(BigInt(stake), config.params, { isAuthor: take.author.equals(owner) });
    const escrow = escrowShare(onChainLegs(this.#mapLegs(app.legs), take.legs).filter((l) => included.includes(l.index)), BigInt(stake));
    return { address, venue, included, excluded, ix, position, feeUsd: Number(fee.fee) / USD, escrowUsd: Number(escrow) / USD, chain, inverted };
  }

  /** Notes which Phoenix child each Phoenix leg of `position` trades in (deposit and order share one). */
  #recordPhoenix(position: PublicKey, owner: PublicKey, venue: { phoenix?: { leg: number; sub: number; symbol: string } }[]) {
    const legs = [...new Map(venue.flatMap((v) => (v.phoenix ? [[v.phoenix.leg, v.phoenix] as const] : []))).values()];
    this.#phoenix?.record(position, owner, legs);
  }

  /** Legs of a position held on Phoenix: a back's perp legs, a fade's shorts (not its paper legs). */
  #onPhoenix(take: TakeAccount, side: object, legsMask: number): number[] {
    return take.legs.flatMap((leg, i) => {
      if (!(legsMask & (1 << i)) || escrowedKind(leg.kind)) return [];
      return "fade" in side || "perp" in leg.kind ? [i] : [];
    });
  }

  /**
   * Refuses a trade the wallet can't pay for (stake plus the most the fee can be) before quoting
   * anything, instead of letting the swap fail inside Jupiter.
   */
  async #checkFunds(owner: PublicKey, usd: number) {
    const ata = getAssociatedTokenAddressSync(USDC_MINT_MAINNET, owner, true);
    const bal = await this.#o.connection.getTokenAccountBalance(ata).then((r) => BigInt(r.value.amount)).catch(() => 0n);
    const { params } = await this.#config();
    const stake = BigInt(Math.round(usd * USD));
    if (bal < stake + (stake * BigInt(params.feeBps)) / 10_000n) throw new ApiError(400, "insufficient_funds", "Not enough cash in your wallet");
  }

  // --- Liquidation warnings ----------------------------------------------------------------

  /**
   * Inbox alerts for Phoenix legs near or close to liquidation, one per leg
   * per level: the watcher sends them to `notify`, which stores each key once.
   */
  async liquidationAlerts(): Promise<{ wallet: string; key: string; take_id: string | null; title: string; body: string; data: Record<string, unknown> }[]> {
    if (!this.#phoenix) return [];
    const byAddress = new Map(Object.entries(this.#state.takes).map(([id, m]) => [m.address, id]));
    const out = [];
    for (const a of await this.#phoenix.atRisk()) {
      const takeId = byAddress.get(a.take.toBase58()) ?? null;
      const app = takeId ? await this.#appTake(takeId).catch(() => null) : null;
      const onChain = await this.#program.account.take.fetchNullable(a.take).catch(() => null);
      const r = a.risk;
      const name = app?.legs[r.leg]?.name ?? r.symbol;
      const lev = onChain?.legs[r.leg]?.leverage ?? 1;
      const away = r.distance === null ? "" : ` (${Math.max(0, Math.round(r.distance * 100))}% away)`;
      out.push({
        wallet: a.owner.toBase58(),
        key: `${a.position.toBase58()}:${r.leg}:${r.level}`,
        take_id: takeId,
        title: r.level === "close" ? `${name} is close to liquidation` : `${name} is getting near liquidation`,
        body: `${r.symbol} is ${money(r.markUsd)}. Your ${lev}x ${r.side} is liquidated at ${money(r.liquidationUsd)}${away}. Sell to keep what's left.`,
        data: { position: a.position.toBase58(), take: a.take.toBase58(), leg: r.leg, symbol: r.symbol, level: r.level, side: r.side, leverage: lev, markUsd: r.markUsd, liquidationUsd: r.liquidationUsd, distance: r.distance },
      });
    }
    return out;
  }

  // --- Phoenix cash ------------------------------------------------------------------------

  /**
   * What a wallet has left on Phoenix outside its open positions: cash in children with no
   * position (after a sale, or what a liquidation left), and positions still open whose Thesis
   * position is over (past the horizon, or a sale whose close didn't land).
   */
  async phoenixCash(wallet: string) {
    const owner = parseKey(wallet);
    if (!this.#phoenix) return { cashUsd: 0, openPositions: 0, markets: [] as string[] };
    const [sweep, strays] = await Promise.all([this.#phoenix.sweepable(owner), this.#phoenix.strays(owner)]);
    return {
      /** Cash in Phoenix the wallet can move back to USDC now. */
      cashUsd: Number(sweep.reduce((n, s) => n + s.collateral, 0n)) / USD,
      /** Phoenix positions to close first (they keep paying or earning funding until then). */
      openPositions: strays.length,
      markets: strays.map((s) => s.symbol),
    };
  }

  /**
   * "Cash out" of Phoenix: closes any positions left open (one transaction each), or, once
   * there are none, withdraws every child's cash back to USDC (one transaction each). The app
   * signs, submits, and calls again until `done`. The wallet only signs; the app pays.
   */
  async buildPhoenixCashOut(wallet: string) {
    const owner = parseKey(wallet);
    if (!this.#phoenix) throw new ApiError(409, "no_phoenix", "Phoenix isn't connected on this fork.");
    // Right after a sale (until=accepted): its Phoenix closes must have landed to be seen.
    await this.#afterPending(owner.toBase58());
    const closes = await this.#phoenix.strayCloseLegs(owner);
    const legs = closes.length ? closes : await this.#phoenix.sweepLegs(owner);
    if (!legs.length) return { done: true as const };
    const payer = this.#o.appPayer.publicKey;
    // The build's lifetime counts from before its blockhash is fetched.
    const started = Date.now();
    const { blockhash } = await this.#o.connection.getLatestBlockhash("confirmed");
    const txs = legs.map((l) => {
      const message = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: PHOENIX_LEG_CU }), ...l.instructions],
      }).compileToV0Message();
      return new VersionedTransaction(message);
    });
    const buildId = randomUUID();
    const expires = started + BUILD_TTL_MS;
    this.#builds.set(buildId, {
      owner: owner.toBase58(),
      messages: txs.map((t) => Buffer.from(t.message.serialize())),
      market: legs.flatMap((l) => l.marketAccounts),
      kind: "phoenix",
      expires,
      // Unused for a cash-out; the type wants one.
      position: { take: owner, address: owner },
    });
    setTimeout(() => this.#builds.delete(buildId), Math.max(0, expires - Date.now())).unref();
    return {
      done: false as const,
      /** Closing positions first: call again after this lands to sweep the cash. */
      closing: closes.length > 0,
      buildId,
      transactions: txs.map((t) => Buffer.from(t.serialize()).toString("base64")),
      steps: legs.map((l, i) => ({ labels: [l.label], bytes: txs[i].serialize().length, computeUnits: PHOENIX_LEG_CU })),
    };
  }

  // --- Split trades that stopped partway (api/split.ts) ------------------------------------

  /**
   * A trade's send failed. When part of a split trade had landed (or this was its retry), records
   * it as incomplete and answers 422 `trade_incomplete`, so the client retries or sweeps.
   * Otherwise the error stands. One that sent nothing because its swaps were refused for slippage
   * (the same bytes twice, the markets reset in between), or failed inside a pool its kept route
   * no longer fits, says `requote: true`: nothing left the wallet, its routes were dropped, and a
   * build with fresh quotes, signed again, is expected to go through.
   */
  #stopped(build: Build, e: unknown, txs: VersionedTransaction[] = []): unknown {
    if (e instanceof SendFailed && e.nothingSent && routeRefusal(e)) e.body = { ...e.body, requote: true };
    if (build.kind === "exit") return this.#saleStopped(build, e, txs);
    const trade = build.trade;
    if (!trade || (build.kind !== "back" && build.kind !== "publish")) return e;
    const landed = e instanceof SendFailed ? e.landed : [];
    const position = build.position.address.toBase58();
    let record: IncompleteTrade;
    if (build.retry) {
      // The one retry failed: what's left is a sweep. Merged into the record as it is now (a
      // sweep may have noted what it sold); gone: it finished or was swept meanwhile.
      const current = this.#split.get(build.owner, position);
      if (!current) return e;
      record = { ...current, signatures: [...current.signatures, ...landed], next: "sweep" };
    } else {
      if (!landed.length) return e;
      const { remaining, split } = afterFailure(build.txLegs ?? [], landed.length);
      record = {
        owner: build.owner,
        take: build.position.take.toBase58(),
        takeId: trade.takeId,
        kind: build.kind,
        side: trade.side,
        ...(trade.inverted ? { inverted: true } : {}),
        usd: trade.usd,
        included: trade.included,
        remaining,
        lend: build.lend ?? [],
        receipt: serializeIx(trade.receipt),
        receiptCu: trade.receiptCu,
        signatures: landed,
        // A transaction whose fate is unknown may still land: no retry, the sweep reads the ticket.
        next: split || (e instanceof SendFailed && e.unknown) ? "sweep" : "retry",
        publishTakeId: build.position.publishTakeId,
        at: Date.now(),
      };
    }
    this.#split.set(position, record);
    this.#wallets.forgetActivity(build.owner);
    this.#log(`split trade of ${build.owner.slice(0, 6)}… stopped after ${record.signatures.length} landed transaction(s) (position ${position}, next: ${record.next}): ${errorText(e)}`);
    return incompleteError(position, record);
  }

  /**
   * A sale's send failed. When it went out over several transactions (or it was finishing a stopped
   * sale) and something was sent, keeps it as a stopped sale (api/sales.ts): what each transaction
   * carried, so selling again finishes it, and answers 422 `sale_incomplete`. Otherwise the error
   * stands: nothing landed, and selling again builds afresh.
   */
  #saleStopped(build: Build, e: unknown, txs: VersionedTransaction[]): unknown {
    const sale = build.sale;
    if (!sale || !(e instanceof SendFailed) || e.nothingSent || (txs.length < 2 && !sale.finish)) return e;
    const key = sale.finish ?? build.position.address.toBase58();
    const prev = this.#state.stoppedSales?.[key];
    const rec: StoppedSale = {
      owner: build.owner,
      take: build.position.take.toBase58(),
      takeId: sale.takeId,
      // A finish keeps the sale as first built: its positions, records and answer.
      sales: prev?.sales ?? salesOf(build).map((x) => ({ address: x.address.toBase58(), seq: x.seq, full: x.full, horizonEnd: x.horizonEnd, ...(x.bps ? { bps: x.bps } : {}), ...(x.exit ? { exit: x.exit } : {}) })),
      records: prev?.records ?? sale.records,
      txs: txs.map((tx, i) => ({ signature: base58(tx.signatures[0]), lastValid: this.#blockhashes.get(tx.message.recentBlockhash) ?? 0, steps: sale.txSteps[i] ?? [] })),
      summary: prev?.summary ?? Object.fromEntries(SALE_SUMMARY.flatMap((k) => (build.response && k in build.response ? [[k, build.response[k]]] : []))),
      at: Date.now(),
    };
    (this.#state.stoppedSales ??= {})[key] = rec;
    this.#store.saveNow();
    this.#wallets.forgetActivity(build.owner);
    this.#log(`sale of ${build.owner.slice(0, 6)}… stopped after ${e.landed.length} of ${txs.length} transaction(s) landed (${key}): ${errorText(e)}`);
    return saleIncompleteError(key, rec);
  }

  /** The wallet's incomplete trades (newest first), for the app to offer a retry or a sweep. */
  incompleteTrades(wallet: string) {
    const owner = parseKey(wallet).toBase58();
    return { trades: this.#split.list(owner).map(([position, t]) => incompleteView(position, t)) };
  }

  /** The wallet's incomplete trade at `position`, or its newest one. */
  #incomplete(owner: PublicKey, position: string | undefined, want?: IncompleteTrade["next"]): [PublicKey, IncompleteTrade] {
    const list = this.#split.list(owner.toBase58());
    const hit = position ? list.find(([p]) => p === parseKey(position).toBase58()) : list.find(([, t]) => !want || t.next === want) ?? list[0];
    if (!hit) throw new ApiError(404, "incomplete_missing", "There's no unfinished trade to pick up.");
    return [new PublicKey(hit[0]), hit[1]];
  }

  #ticket(owner: PublicKey, position: PublicKey) {
    return this.#program.account.tradeTicket.fetchNullable(ticketAddress(owner, position, this.#program.programId), "confirmed");
  }

  /** The ticket is gone: the trade finished after all (409 `trade_complete`), or it was cancelled. Either way the record goes. */
  async #ticketGone(position: PublicKey): Promise<"complete" | "gone"> {
    const held = await this.#program.account.position.fetchNullable(position, "confirmed");
    this.#split.delete(position.toBase58());
    return held ? "complete" : "gone";
  }

  /**
   * Retry (once) a split trade that stopped partway: the legs that didn't land, quoted again with
   * a fresh blockhash, stepping on the same ticket, with the same receipt last. The owner signs
   * the transactions and submits them as usual. `position`: the trade (default: the newest one
   * that can be retried).
   */
  async buildRetry(wallet: string, address?: string) {
    const owner = parseKey(wallet);
    // A trade that stopped is recorded once its accepted transactions settle.
    await this.#afterPending(owner.toBase58());
    const [position, rec] = this.#incomplete(owner, address, "retry");
    const key = position.toBase58();
    if (rec.next !== "retry" || rec.swept?.length) throw incompleteError(key, rec, 409, "retry_used", "This trade was retried or swept already. Sell what it bought back to cash.");
    const toSweep = (status: number, code: string, message: string) => {
      const next = { ...rec, next: "sweep" as const };
      this.#split.set(key, next);
      return incompleteError(key, next, status, code, message);
    };
    const ticket = await this.#ticket(owner, position);
    if (!ticket) {
      if ((await this.#ticketGone(position)) === "complete") throw new ApiError(409, "trade_complete", "This trade went through after all.");
      throw new ApiError(410, "incomplete_gone", "Nothing is left to finish or sell for this trade.");
    }
    // A leg the retry would buy is on the ticket already: its transaction landed after all.
    if (rec.remaining.some((leg) => ticket.named & (1 << leg))) throw toSweep(409, "retry_unavailable", "Part of this trade landed after all. Sell what it bought back to cash.");
    const app = await this.#appTake(rec.takeId);
    const take = new PublicKey(rec.take);
    let mapped = this.#mapLegs(app.legs);
    if (rec.kind === "back") {
      const onChain = await this.#program.account.take.fetchNullable(take);
      if (!onChain || !("open" in onChain.status) || onChain.horizonEnd.toNumber() <= Date.now() / 1000) throw toSweep(409, "take_closed", "This take has closed. Sell what the trade bought back to cash.");
      mapped = onChainLegs(mapped, onChain.legs);
    }
    const legs = mapped.filter((l) => rec.included.includes(l.index));
    // Only a definite "can't be bought now" ends the retry; Jupiter being busy or slow (503, 502)
    // leaves it for another try. Building doesn't use the retry up: sending it does.
    const venue = await this.#router.rebuild(legs, owner, rec.usd, rec.side, new Set(rec.remaining), this.#phoenix?.legsOf(position) ?? [], undefined, { lane: LANE.tap }).catch((e: unknown) => {
      if (e instanceof ApiError && e.code === "retry_unavailable") throw toSweep(422, e.code, e.message);
      throw e;
    });
    const quotedAt = Date.now();
    const receipt = deserializeIx(rec.receipt);
    const trade: TradeContext = { takeId: rec.takeId, side: rec.side, ...(rec.inverted ? { inverted: true } : {}), usd: rec.usd, included: rec.included, receipt, receiptCu: rec.receiptCu };
    const built = await this.#compose(venue, receipt, rec.receiptCu, owner, rec.kind, { take, address: position, publishTakeId: rec.publishTakeId }, true, false, { trade, retry: rec, quotedAt });
    // Take-relative, as the trade's own build answered (rec.side is on-chain).
    return this.#keep({ ...built, position: key, take: rec.take, side: chainSide(rec.side, rec), stakeUsd: rec.usd, legs: rec.remaining });
  }

  /**
   * Sweep a split trade that stopped partway: swaps the tokens its landed transactions bought (the
   * ticket's `received`) back to USDC through Jupiter, redeems vault shares, and cancels the ticket
   * in the same build. `{ done: true }` when the wallet has nothing left to sweep. Phoenix legs
   * go through `phoenix/cash-out` (`phoenixCashOut`). `position`: the trade (default: the newest).
   */
  async buildSweep(wallet: string, address?: string) {
    const owner = parseKey(wallet);
    await this.#afterPending(owner.toBase58());
    // Nothing left: no stopped trade at all, or none at `address` (already swept, retried or finished).
    const list = this.#split.list(owner.toBase58());
    if (!address ? !list.length : !list.some(([p]) => p === parseKey(address).toBase58())) return { done: true as const, phoenixCashOut: false };
    const [position, rec] = this.#incomplete(owner, address);
    const ticket = await this.#ticket(owner, position);
    if (!ticket) {
      if ((await this.#ticketGone(position)) === "complete") throw new ApiError(409, "trade_complete", "This trade went through after all.");
      return { done: true as const, phoenixCashOut: false };
    }
    // Once a sweep is built, the trade isn't retried any more.
    if (rec.next === "retry") this.#split.set(position.toBase58(), { ...rec, next: "sweep" });
    const conn = this.#o.connection;
    const payer = this.#o.appPayer.publicKey;
    const usdc = USDC_MINT_MAINNET.toBase58();
    const tokens = this.#o.bank().tokens;
    const jupiter = this.#router.jupiter(LANE.tap);
    const access = { apiKey: jupiter.apiKey, fetchFn: jupiter.fetchFn, max429WaitMs: jupiter.max429WaitMs };
    const sells = (await Promise.all(sweepLegs(ticket, rec).map(async (l) => {
      const info = await conn.getAccountInfo(l.account, "confirmed");
      if (!info) return null; // closed since: nothing left to sell
      const account = unpackAccount(l.account, info, info.owner);
      // What the trade bought, at most what's still there.
      const amount = account.amount < l.amount ? account.amount : l.amount;
      if (amount <= 0n) return null;
      const mint = account.mint.toBase58();
      const symbol = tokens[mint]?.symbol ?? (l.lend ? "jlUSDC" : mint.slice(0, 4));
      if (l.lend) {
        if (!this.#o.jupiterApiKey) throw new ApiError(422, "no_exit_route", "Jupiter Lend needs JUPITER_API_KEY.");
        const venue = await jupiterLendRedeem({ ...access, user: owner, payer, shares: amount, label: "Withdraw jlUSDC", apiKey: this.#o.jupiterApiKey });
        const perShare = await this.#valuation.lendShareValue(mint).catch(() => null);
        const usd = perShare === null ? null : (Number(amount) / 1e6) * perShare; // vault shares have USDC's 6 decimals
        return { leg: l.leg, mint, symbol, amount, venue, usd, minimum: usd };
      }
      const { quote } = await jupiter.quoteExactIn(mint, usdc, amount, this.#router.route);
      if (!quote || quote.inputMint !== mint || quote.outputMint !== usdc || quote.inAmount !== amount.toString()) {
        throw new ApiError(422, "no_exit_route", `No route to sell ${symbol} back to USDC right now. Try again in a moment.`);
      }
      const venue = await jupiterBuy({ ...access, quote, user: owner, payer, label: `Sell ${symbol}` });
      return { leg: l.leg, mint, symbol, amount, venue, usd: Number(BigInt(quote.outAmount)) / USD, minimum: Number(BigInt(quote.otherAmountThreshold)) / USD };
    }))).filter((s) => s !== null);
    const quotedAt = Date.now();
    const cancel = await cancelTradeIx(this.#program, { owner, position, rentPayer: payer });
    // Each sale tagged with its take leg, so a partly landed sweep knows what it sold.
    const venue = sells.map((s) => ({ ...s.venue, output: { leg: s.leg } }));
    const built = await this.#compose(venue, cancel, THESIS_COMPUTE_UNITS.cancelTrade, owner, "sweep", { take: new PublicKey(rec.take), address: position }, false, false, { quotedAt });
    const sum = (k: "usd" | "minimum") => (sells.some((s) => s[k] === null) ? null : sells.reduce((n, s) => n + s[k]!, 0));
    return this.#keep({
      done: false as const,
      ...built,
      position: position.toBase58(),
      tokens: sells.map((s) => ({ leg: s.leg, mint: s.mint, symbol: s.symbol, amount: s.amount.toString() })),
      expectedUsd: sum("usd"),
      minimumUsd: sum("minimum"),
      /** Phoenix legs landed: once this lands, build `phoenix/cash-out` to close them and move their cash back. */
      phoenixCashOut: ticket.phoenix !== 0,
    });
  }

  /** Drops every open build for `position` (a retry or sweep of it is being sent: the others are stale). */
  #dropBuildsFor(position: PublicKey) {
    for (const [id, b] of this.#builds) if (b.position.address.equals(position)) this.#builds.delete(id);
  }

  /**
   * A retry's submit, inside the wallet's queue before anything is sent: the trade must still be
   * waiting for this retry (no other retry or sweep sent since, nothing more landed), and no leg it
   * buys may be on the ticket. Then the retry is used up, and other builds for the trade dropped.
   */
  async #admitRetry(build: Build & { retry: IncompleteTrade }) {
    const position = build.position.address.toBase58();
    const current = this.#split.get(build.owner, position);
    const stale = () => new ApiError(409, "trade_changed", "This trade changed since the build. Build again.");
    if (!current) throw stale();
    if (current.next !== "retry" || current.swept?.length || current.signatures.length !== build.retry.signatures.length) {
      throw incompleteError(position, current, 409, "retry_used", "This trade was retried or swept already. Sell what it bought back to cash.");
    }
    const ticket = await this.#ticket(new PublicKey(build.owner), build.position.address);
    if (!ticket) throw stale();
    if (current.remaining.some((leg) => ticket.named & (1 << leg))) {
      const next = { ...current, next: "sweep" as const };
      this.#split.set(position, next);
      throw incompleteError(position, next, 409, "retry_unavailable", "Part of this trade landed after all. Sell what it bought back to cash.");
    }
    this.#split.set(position, { ...current, next: "sweep" });
    this.#dropBuildsFor(build.position.address);
  }

  /** Sends a sweep. When it lands the trade is over; a partly landed one notes what it sold. */
  async #submitSweep(build: Build, txs: VersionedTransaction[], t?: Timings, accept?: () => void) {
    const position = build.position.address.toBase58();
    const signatures = await this.#store.withWallet(build.owner, async () => {
      // Re-checked here, after any earlier submit for this wallet: the trade must still be stopped.
      if (!this.#split.get(build.owner, position) || !(await this.#ticket(new PublicKey(build.owner), build.position.address))) {
        throw new ApiError(409, "trade_changed", "This trade changed since the build. Build again.");
      }
      this.#dropBuildsFor(build.position.address);
      try {
        return await this.#send(txs, build.market, t, accept, build.marketFreshMs, build.phoenixMarket);
      } catch (e) {
        const landed = e instanceof SendFailed ? e.landed.length : 0;
        const rec = this.#split.get(build.owner, position);
        if (rec && landed) this.#split.set(position, { ...rec, swept: [...(rec.swept ?? []), ...(build.txLegs ?? []).slice(0, landed).flat()] });
        throw e;
      } finally {
        this.#wallets.forgetActivity(build.owner);
      }
    });
    // The last transaction cancelled the ticket.
    this.#split.delete(position);
    void this.#history.snapshot(build.owner).catch(() => {});
    return { signatures };
  }

  // --- Creator fees ------------------------------------------------------------------------

  /** What the author earned per take, claimed and left to claim (exact base units and dollars). */
  creatorFees(author: string) {
    return this.#fees.summary(author);
  }

  /**
   * Claims the author's creator fees: every take with something to claim, or just `takes`. As
   * many claims per transaction as fit; the author signs each, the app's fee payer pays.
   */
  async buildClaimCreatorFees(author: string, takes?: string[]) {
    // The build's lifetime counts from before its blockhash is fetched (inside fees.build).
    const started = Date.now();
    const built = await this.#fees.build(author, takes);
    const buildId = randomUUID();
    const expires = started + BUILD_TTL_MS;
    const claims = built.flatMap((b) => b.takes);
    this.#builds.set(buildId, {
      owner: parseKey(author).toBase58(),
      messages: built.map((b) => Buffer.from(b.tx.message.serialize())),
      market: [],
      kind: "claim",
      claims,
      expires,
      // Unused for a claim; the type wants one.
      position: { take: new PublicKey(claims[0]), address: new PublicKey(claims[0]) },
    });
    setTimeout(() => this.#builds.delete(buildId), Math.max(0, expires - Date.now())).unref();
    return {
      buildId,
      transactions: built.map((b) => Buffer.from(b.tx.serialize()).toString("base64")),
      steps: built.map((b) => ({ takes: b.takes, amountUsd: Number(b.amount) / USD, bytes: b.bytes })),
      amountUsd: Number(built.reduce((s, b) => s + b.amount, 0n)) / USD,
    };
  }

  /** Sends a claim's transactions one by one; reports any that failed after one landed. */
  async #submitClaim(build: Build, txs: VersionedTransaction[], t?: Timings) {
    const signatures: string[] = [];
    try {
      await this.#store.withWallet(build.owner, async () => {
        for (const tx of txs) signatures.push(...(await this.#send([tx], [], t)));
      });
    } finally {
      this.#fees.forget(build.owner, build.claims ?? []);
      this.#wallets.forgetActivity(build.owner);
    }
    // The claimed USDC is in the wallet now: a fresh chart point, as after a trade.
    if (signatures.length) void this.#history.snapshot(build.owner).catch(() => {});
    return { signatures };
  }

  /** Posts an app take on-chain with the author's own buy-in, signed by their wallet. */
  async buildPublish(takeId: string, author: string, usd: number, o: BuildOpts = {}) {
    const t = o.timings ?? new Timings();
    return this.#timed(`publish build ${takeId.slice(0, 8)}`, t, () => this.#buildPublish(takeId, author, usd, t, o));
  }

  async #buildPublish(takeId: string, author: string, usd: number, t: Timings, o: BuildOpts) {
    const authorKey = parseKey(author);
    checkAmount(usd);
    if (this.#state.takes[takeId]) throw new ApiError(409, "already_on_chain");
    const app = await t.time("take", () => this.#appTake(takeId, { fresh: true }));
    // Only the take's author can put it on-chain: with someone else's wallet, the take, its creator
    // fees and its score would be theirs (posting take ids aren't secret: a feed can show one).
    if (!app.author_wallet) throw new ApiError(409, "no_author_wallet", "This take's author has no wallet yet.");
    if (app.author_wallet !== author) throw new ApiError(403, "not_author", "Only the take's author can post it.");
    if (app.status === "live") throw new ApiError(409, "already_live");
    // A publish of this take that stopped partway: a fresh one would start its ticket over
    // (begin_trade) and lose what the landed part recorded. Retry or sweep it first.
    const stopped = this.#split.list(authorKey.toBase58()).find(([, t]) => t.publishTakeId === takeId);
    if (stopped) throw incompleteError(stopped[0], stopped[1], 409);
    // An inverted take's author buys in on its agreeing side: an on-chain fade (Phoenix shorts,
    // prediction legs' other side). Every leg must be one a fade can hold, or the program refuses it.
    const legs = this.#mapLegs(app.legs);
    if (app.inverted && !invertible(legs)) throw new ApiError(422, "not_fadeable", INVERTED_NOT_FADEABLE);
    const side = agreeSide(app);
    await t.time("funds", () => this.#checkFunds(authorKey, usd));
    const use = newUse(laneOf(o.prebuild));
    const [{ venue, included, excluded }, config] = await t.time("legs", () => Promise.all([
      this.#router.venueLegs(legs, authorKey, usd, undefined, undefined, { side, lane: use.lane, use }).catch((e: unknown) => {
        if (side === "fade" && e instanceof ApiError && e.code === "nothing_tradable") throw new ApiError(409, "fade_unavailable", INVERTED_NOTHING);
        throw e;
      }),
      this.#config(),
    ])).finally(() => noteUse(t, use));
    t.quotedAt ??= Date.now();
    const { ix, address } = await this.#createIx(app, authorKey, usd, included);
    const position = { take: address, address: positionAddress(address, authorKey, 0n), publishTakeId: takeId };
    this.#recordPhoenix(position.address, authorKey, venue);
    const built = await this.#compose(venue, ix, THESIS_COMPUTE_UNITS.createTake, authorKey, "publish", position, true, false, {
      trade: { takeId, side, ...(app.inverted ? { inverted: true } : {}), usd, included, receipt: ix, receiptCu: THESIS_COMPUTE_UNITS.createTake }, quotedAt: t.quotedAt, prebuilt: o.prebuild, timings: t,
    });
    return this.#keep({ ...built, take: address.toBase58(), inverted: Boolean(app.inverted), stakeUsd: usd, feeUsd: Number(splitFee(BigInt(Math.round(usd * USD)), config.params, { isAuthor: true }).fee) / USD, included, excluded });
  }

  /**
   * Sends transactions this service built, after the user signed them. Each must match a built
   * message byte for byte, so the app fee payer only ever signs what it built.
   *
   * By default it answers once every transaction confirmed and the bookkeeping is done:
   * `{ signatures }`. With `until: "accepted"` it answers as soon as the fork accepted every
   * transaction (each preflighted at "processed", sent back to back): `{ status: "pending",
   * buildId, signatures }`; confirmation and bookkeeping finish in the background, and
   * `submission(buildId)` tells how it ended. The same build with the same signed bytes again is
   * the same submit: it gets its status (by default, once it ended), and other bytes 409 `build_used`.
   */
  async submit(buildId: string, signed: string[], o: SubmitOpts = {}) {
    const t = o.timings ?? new Timings();
    const kind = this.#builds.get(buildId)?.kind ?? this.#submissions.get(buildId)?.kind ?? "unknown";
    const marks = clientMarks(o.clientTimings);
    if (marks) this.#log(`client timings ${buildId.slice(0, 8)} (${kind}): ${marks}`);
    return this.#timed(`${kind} submit`, t, () => this.#submit(buildId, signed, t, o), () => buildId);
  }

  async #submit(buildId: string, signed: string[], t: Timings, o: SubmitOpts): Promise<SubmitAnswer> {
    const digest = signedDigest(signed);
    const known = this.#submissions.get(buildId) ?? (await this.#resolveSaved(buildId));
    if (known) {
      if (known.digest !== digest) throw new ApiError(409, "build_used", "This build was already submitted with other transactions. Build again.");
      if (o.until !== "accepted") await known.done;
      return this.#answer(buildId, known);
    }
    const build = this.#builds.get(buildId);
    if (!build || build.expires < Date.now()) throw new ApiError(410, "build_expired", "Build again: transactions expire after about a minute");
    if (signed.length !== build.messages.length) throw new ApiError(400, "wrong_transaction_count");
    const decoded = signed.map((b64) => {
      try {
        return VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      } catch {
        throw new ApiError(400, "invalid_transaction", "The wallet returned an invalid transaction.");
      }
    });
    // The build's messages, or the ones answered before its last refresh (signed while it ran),
    // while their blockhash lasts. Either way every transaction must be one this service built.
    const first = Buffer.from(decoded[0]?.message.serialize() ?? []);
    const prior = build.previous && build.previous.expires >= Date.now() && first.equals(build.previous.messages[0]) ? build.previous.messages : null;
    const expected = prior ?? build.messages;
    const txs = await t.time("verify", async () => decoded.map((tx, i) => {
      const message = Buffer.from(tx.message.serialize());
      if (!message.equals(expected[i])) throw new ApiError(400, "transaction_changed");
      const signer = tx.message.staticAccountKeys
        .slice(0, tx.message.header.numRequiredSignatures)
        .findIndex((key) => key.toBase58() === build.owner);
      if (signer !== -1) {
        // DER SubjectPublicKeyInfo header for a raw Ed25519 public key.
        const header = Buffer.from("302a300506032b6570032100", "hex");
        const key = createPublicKey({ key: Buffer.concat([header, tx.message.staticAccountKeys[signer].toBuffer()]), format: "der", type: "spki" });
        if (!tx.signatures[signer] || !verify(null, message, key, tx.signatures[signer])) {
          throw new ApiError(400, "invalid_signature", "The wallet did not sign this transaction.");
        }
      }
      tx.sign([this.#o.appPayer]);
      return tx;
    }));
    // A sale of this position already on its way: the second one would fail on-chain anyway.
    if (build.kind === "exit" && saleAddresses(build).some((a) => this.#pendingExits.has(a))) throw new ApiError(409, "already_exited", "This position is being sold.");
    o.admit?.({ owner: build.owner, kind: build.kind, prebuilt: Boolean(build.prebuilt) });
    // From here on the build is used: a repeat of it finds this submission instead.
    this.#builds.delete(buildId);
    const early = o.until === "accepted";
    const sub = this.#register(buildId, build, txs, digest);
    // Claims send one transaction at a time, each confirmed first: they answer when they're done.
    const accept = early && build.kind !== "claim" ? sub.accept : undefined;
    let work: Promise<{ signatures: string[] }>;
    if (build.kind === "claim") work = this.#submitClaim(build, txs, t);
    else if (build.kind === "phoenix") {
      work = this.#store.withWallet(build.owner, () => this.#send(txs, build.market, t, accept)).then((signatures) => {
        this.#wallets.forgetActivity(build.owner);
        void this.#history.snapshot(build.owner).catch(() => {});
        return { signatures };
      });
    } else if (build.kind === "sweep") work = this.#submitSweep(build, txs, t, accept);
    else work = this.#submitTrade(build, txs, t, accept);
    void work.then(
      ({ signatures }) => sub.finish("landed", signatures),
      (e: unknown) => sub.finish(e instanceof ApiError && e.code === "trade_incomplete" ? "incomplete" : "failed", undefined, e),
    ).finally(() => {
      if (early) this.#log(`timing ${build.kind} ${sub.status} ${buildId.slice(0, 8)} ${t.line()}`);
    });
    if (!early) return { signatures: (await work).signatures };
    // Answer once every transaction is accepted, or with the error that stopped it before that.
    await Promise.race([sub.accepted, work]).catch(() => {});
    return this.#answer(buildId, sub);
  }

  /** A submit's answer: by default `{ signatures }` once landed; with `until: "accepted"`, its status. */
  #answer(buildId: string, sub: Submission | SavedSubmissionView): SubmitAnswer {
    if (sub.status === "failed" || sub.status === "incomplete") throw sub.error ?? new ApiError(502, "transaction_failed", "That trade didn't go through.");
    return { status: sub.status, buildId, signatures: sub.signatures };
  }

  /**
   * A submit's status (GET /submissions/:buildId): waits up to `waitMs` (at most 10 s) while it's
   * pending. A submission from before a restart is answered from its transactions' statuses on-chain.
   */
  async submission(buildId: string, waitMs = 0): Promise<SubmissionView> {
    const sub = this.#submissions.get(buildId) ?? (await this.#resolveSaved(buildId));
    if (!sub) throw new ApiError(404, "no_such_submission", "No submit with that build id here.");
    if (sub.status === "pending" && waitMs > 0 && "done" in sub) {
      await Promise.race([sub.done, new Promise((r) => setTimeout(r, Math.min(waitMs, SUBMISSION_WAIT_MAX_MS)).unref())]);
    }
    return submissionView(buildId, sub);
  }

  /** Waits (up to `ms`) for the owner's submits still confirming: a sale right after a back sees the back. */
  async #afterPending(owner: string, ms = AFTER_PENDING_MS) {
    const pending = [...this.#submissions.values()].filter((s) => s.owner === owner && s.status === "pending").map((s) => s.done);
    if (pending.length) await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, ms).unref())]);
  }

  /** Waits (up to `ms`) for every submit still confirming (a graceful shutdown), then writes the state file. */
  async drain(ms = 10_000) {
    const pending = [...this.#submissions.values()].filter((s) => s.status === "pending").map((s) => s.done);
    if (pending.length) {
      this.#log(`waiting for ${pending.length} submit(s) to confirm before stopping`);
      await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, ms).unref())]);
    }
    this.flush();
  }

  /** Records a submit under its build id, in memory and in the state file (kept SUBMISSION_KEEP_MS). */
  #register(buildId: string, build: Build, txs: VersionedTransaction[], digest: string): Submission {
    const now = Date.now();
    for (const [id, s] of this.#submissions) if (s.status !== "pending" && s.at < now - SUBMISSION_KEEP_MS) this.#submissions.delete(id);
    const saved = (this.#state.submissions ??= {});
    for (const [id, s] of Object.entries(saved)) if (s.at < now - SUBMISSION_KEEP_MS) delete saved[id];
    const trade = txs.slice(0, txs.length - (build.kind === "back" || build.kind === "publish" ? build.cleanup ?? 0 : 0));
    const signatures = [...(build.retry?.signatures ?? []), ...trade.map((tx) => base58(tx.signatures[0]))];
    const lastValid = Math.max(0, ...trade.map((tx) => this.#blockhashes.get(tx.message.recentBlockhash) ?? 0));
    const position = build.position.address.toBase58();
    let accept!: () => void;
    let settle!: () => void;
    const sub: Submission = {
      owner: build.owner,
      kind: build.kind,
      digest,
      signatures,
      status: "pending",
      at: now,
      accepted: new Promise<void>((r) => (accept = r)),
      done: new Promise<void>((r) => (settle = r)),
      accept: () => accept(),
      finish: (status, sigs, error) => {
        sub.status = status;
        if (sigs) sub.signatures = sigs;
        if (error) sub.error = error instanceof ApiError ? error : new ApiError(502, "send_failed", errorText(error));
        if (build.kind === "exit") for (const a of saleAddresses(build)) this.#pendingExits.delete(a);
        const s = this.#state.submissions?.[buildId];
        if (s) Object.assign(s, { status, signatures: sub.signatures, error: sub.error ? savedError(sub.error) : undefined });
        this.#save();
        accept();
        settle();
      },
    };
    this.#submissions.set(buildId, sub);
    if (build.kind === "exit") for (const a of saleAddresses(build)) this.#pendingExits.set(a, buildId);
    saved[buildId] = {
      owner: build.owner, kind: build.kind, digest, signatures, status: "pending", at: now, lastValid,
      ...(build.kind === "back" || build.kind === "publish" ? { position, take: build.position.take.toBase58(), publishTakeId: build.position.publishTakeId } : {}),
    };
    this.#save();
    return sub;
  }

  /**
   * A submit from before a restart: still pending when the API stopped, its status now comes from
   * its transactions on-chain. All landed: "landed" (its opening transactions are recorded, so the
   * position can be sold); one failed or expired: "failed", or "incomplete" when earlier ones
   * landed (the trade's record went with the restart: the app's incomplete list won't show it,
   * and the abandoned-ticket cleanup cancels its ticket later). Otherwise still "pending".
   */
  async #resolveSaved(buildId: string): Promise<SavedSubmissionView | null> {
    const saved = this.#state.submissions?.[buildId];
    if (!saved) return null;
    if (saved.status === "pending" && saved.signatures.length) {
      const fates = await this.#fates(saved.signatures, saved.lastValid, { once: true });
      const landed = fates.findIndex((f) => f !== "landed");
      if (landed === -1) {
        saved.status = "landed";
        if (saved.position && !this.#state.openingTransactions?.[saved.position]) this.#valuation.recordOpening(new PublicKey(saved.position), saved.signatures);
        if (saved.publishTakeId && saved.take) this.#state.takes[saved.publishTakeId] ??= { address: saved.take, author: saved.owner, mirroredAt: new Date().toISOString(), signatures: saved.signatures };
      } else if (fates[landed] === "failed") {
        saved.status = landed > 0 && saved.position ? "incomplete" : "failed";
        saved.error = saved.status === "incomplete"
          ? { status: 422, code: "trade_incomplete", message: "Part of this trade went through, then it stopped. Check your wallet." }
          : { status: 502, code: "transaction_failed", message: "That trade didn't go through." };
      }
      this.#save();
    }
    return { ...saved, error: saved.error ? apiErrorOf(saved.error) : undefined, done: Promise.resolve() };
  }

  /**
   * A back, fade, publish, retry or sale: sent in the wallet's queue, then the bookkeeping and the
   * abandoned-ticket cleanup. With `accept` (until=accepted) all of it runs after the answer.
   */
  async #submitTrade(build: Build, txs: VersionedTransaction[], t: Timings, accept?: () => void): Promise<{ signatures: string[] }> {
    const cleanup = txs.splice(txs.length - (build.cleanup ?? 0));
    const positionKey = build.position.address.toBase58();
    // Its ticket isn't abandoned until the send is over, confirmation included.
    this.#inFlight.add(positionKey);
    const queued = Date.now();
    const signatures = await this.#store.withWallet(build.owner, async () => {
      t.add("lock", Date.now() - queued);
      if (build.expires < Date.now()) throw new ApiError(410, "build_expired", "Build again: transactions expire after about a minute");
      if (build.kind === "exit") {
        // Each position it sells: still held, and for a partial sale still at the seq it was built for.
        const sales = salesOf(build);
        const held = await this.#program.account.position.fetchMultiple(sales.map((x) => x.address), "confirmed");
        sales.forEach((x, i) => {
          if (!held[i] || held[i]!.exited) throw new ApiError(409, "already_exited", "This position has already been sold.");
          if (!x.full && held[i]!.parts !== x.seq) throw new ApiError(409, "build_stale", "This position changed since the sale was built. Build again.");
        });
      }
      if (build.retry) await this.#admitRetry(build as Build & { retry: IncompleteTrade });
      // Its Phoenix children are its own from here (a rebuild may have given them to another build).
      if (build.kind === "back" || build.kind === "publish") this.#phoenix?.commit(build.position.address);
      this.#wallets.forgetActivity(build.owner);
      let sent: string[];
      try {
        sent = await this.#send(txs, build.market, t, accept, build.marketFreshMs, build.phoenixMarket);
      } catch (e) {
        // The cleanup rides after the trade, so it wasn't sent: look again on the next build.
        if (cleanup.length) this.#split.suspect(build.owner);
        // A sale that failed to send: its swaps' kept sell routes go (a repriced estimate may be
        // what failed), so selling again quotes those tokens afresh (api/routing.ts "Sales").
        if (build.sale) {
          const mints = build.sale.txSteps.flat().flatMap((step) => (step.kind === "sell" ? [step.mint] : []));
          this.#router.dropSells(mints, `a sale of ${build.owner.slice(0, 6)}… failed to send (${e instanceof ApiError ? e.code : "error"})`);
        }
        // A swap refused for slippage (even after the markets were reset), or failing inside its
        // pool: the routes its unsent transactions reused go, so the client's rebuild (or the
        // retry) quotes those afresh.
        if (build.txKeys && e instanceof SendFailed && e.refused && routeRefusal(e)) {
          const why = slippageRefusal(e) ? "was refused for slippage" : `failed in a swap (${e.message.slice(0, 120)})`;
          this.#router.dropBuys(build.txKeys.slice(e.landed.length).flat(), `a trade of ${build.owner.slice(0, 6)}… ${why}`);
        }
        throw this.#stopped(build, e, txs);
      }
      this.#wallets.forgetActivity(build.owner);
      const bookkeeping = Date.now();
      // A retry's position opened over the transactions that landed first, too.
      const confirmed = [...(build.retry?.signatures ?? []), ...sent];
      this.#split.delete(positionKey);
      // A stopped sale this finished is over.
      if (build.sale?.finish && this.#state.stoppedSales?.[build.sale.finish]) {
        delete this.#state.stoppedSales[build.sale.finish];
        this.#save();
      }
      this.#notePosition(build.position.take, build.position.address, build.owner, build.kind === "publish");
      if (build.kind === "exit") this.#noteSold(build.position.take, salesOf(build).flatMap((x) => (x.exit ? [{ address: x.address, exit: x.exit }] : [])));
      // A back or fade paid the take's author a creator share: their fee summary is out of date.
      if (build.kind === "back") {
        const takeAddress = build.position.take.toBase58();
        const author = Object.values(this.#state.takes).find((m) => m.address === takeAddress)?.author;
        if (author) this.#fees.forget(author);
      }
      if (build.kind !== "exit") this.#valuation.recordOpening(build.position.address, confirmed);
      const { publishTakeId, take } = build.position;
      if (publishTakeId) {
        this.#state.takes[publishTakeId] = { address: take.toBase58(), author: build.owner, mirroredAt: new Date().toISOString(), signatures: confirmed };
        this.#takeCache.delete(publishTakeId);
      }
      if (build.kind !== "exit") this.#save();
      t.add("bookkeeping", Date.now() - bookkeeping);
      return confirmed;
    }).finally(() => this.#inFlight.delete(positionKey));
    const cleanupStarted = Date.now();
    for (const tx of cleanup) {
      await this.#send([tx], []).then(
        ([sig]) => this.#log(`cancelled abandoned trade tickets of ${build.owner} -> ${sig}`),
        (e) => {
          this.#split.suspect(build.owner);
          this.#log(`cancelling abandoned trade tickets of ${build.owner} failed: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
        },
      );
    }
    if (cleanup.length) t.add("cleanup", Date.now() - cleanupStarted);
    void this.#history.snapshot(build.owner).catch(() => {});
    // The tokens it bought get sell routes now, when the budget has room, so their first sale is quick.
    if (build.seeds?.length) void this.#router.seedSells(build.seeds, new PublicKey(build.owner));
    // The take goes live when the backend sees its takeCreated: deliver it now rather than
    // waiting for the relay, so the author's "posting…" clears as soon as this returns.
    if (build.position.publishTakeId) await t.time("relay", () => this.#relay(signatures));
    return { signatures };
  }

  /**
   * The author's app asks this when a posting take hasn't gone live: whether it's on-chain here,
   * and if so delivers its publish again (an earlier delivery may have failed). Idempotent: the
   * backend stores each event once.
   */
  async confirmPublish(takeId: string) {
    const mirror = this.#state.takes[takeId];
    if (!mirror || mirror.demoAuthorKey) return { onChain: false, relayed: 0 };
    const account = await this.#program.account.take.fetchNullable(new PublicKey(mirror.address), "confirmed");
    if (!account) return { onChain: false, relayed: 0 };
    this.#takeCache.delete(takeId);
    return { onChain: true, take: mirror.address, relayed: await this.#relay(mirror.signatures ?? []) };
  }

  async #relay(signatures: string[]): Promise<number> {
    if (!this.#o.relay || !signatures.length) return 0;
    try {
      return await this.#o.relay(signatures);
    } catch (e) {
      this.#log(`relaying ${signatures.join(", ")} failed: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
      return 0;
    }
  }

  /**
   * This owner's trade tickets the app's fee payer paid for that no trade is using: a split trade
   * whose later transaction never landed leaves its ticket, and its rent, behind (security review
   * L-4). Tickets of builds still pending or being sent here don't count.
   */
  async #abandonedTickets(owner: PublicKey): Promise<PublicKey[]> {
    const tickets = await this.#program.account.tradeTicket.all([
      { memcmp: { offset: 8, bytes: owner.toBase58() } },
      // owner (32) + position (32), then rent_payer.
      { memcmp: { offset: 8 + 64, bytes: this.#o.appPayer.publicKey.toBase58() } },
    ]);
    // Incomplete trades' tickets wait for their retry or sweep (api/split.ts).
    const busy = new Set([...this.#inFlight, ...this.#split.positions(), ...[...this.#builds.values()].map((b) => b.position.address.toBase58())]);
    return tickets.map((t) => t.account.position).filter((p) => !busy.has(p.toBase58())).slice(0, CLEANUP_TICKETS);
  }

  /** One transaction cancelling `positions`' tickets: the owner signs, the app's fee payer pays and gets the rent back. */
  async #cleanupTx(owner: PublicKey, positions: PublicKey[]) {
    const payer = this.#o.appPayer.publicKey;
    const ixs = await Promise.all(positions.map((position) => cancelTradeIx(this.#program, { owner, position, rentPayer: payer })));
    const computeUnits = THESIS_COMPUTE_UNITS.cancelTrade * positions.length + 1_000;
    const { blockhash } = await this.#o.connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }), ...ixs],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    return { tx, labels: [`cancel ${positions.length} abandoned trade ticket(s)`], legs: [] as number[], bytes: tx.serialize().length, computeUnits, computeFrom: "estimated" as const };
  }

  async #compose(
    venue: VenueLeg[],
    receipt: Parameters<typeof composeTransactions>[0]["receipt"],
    receiptCu: number,
    owner: PublicKey,
    kind: Build["kind"],
    position: Build["position"],
    /** A create_take or back: wrap it in proof-of-trade checks (sales need none). */
    proof = false,
    /** Phoenix legs ride in it (closes of a sale): its market accounts are all refreshed before the send. */
    phoenixLegs = false,
    /**
     * A create_take, back or fade (`trade`); the retry of an incomplete one (`retry`: its ticket is
     * open). `quotedAt`: when its quotes were made; `prebuilt`: built ahead of the tap.
     */
    extra: { trade?: TradeContext; retry?: IncompleteTrade; quotedAt?: number; prebuilt?: boolean; timings?: Timings; sale?: SaleSteps } = {},
  ) {
    const t = extra.timings ?? new Timings();
    const market = venue.flatMap((v) => v.marketAccounts);
    const phoenix = kind === "phoenix" || phoenixLegs || venue.some((v) => (v as Partial<TradeLeg>).how === "phoenix");
    // Fresh pools and books now, at quote time (the simulation below reads them too), so the
    // submit needn't wait for them; only accounts not refreshed in the last MARKET_FRESH_MS.
    if (market.length) await t.time("markets", () => this.#o.fork.refreshMarkets(market, { freshMs: MARKET_FRESH_MS }));
    // The blockhash is fetched during composing: the build's lifetime counts from before that.
    const started = Date.now();
    const composeStarted = started;
    const txs = await composeTransactions({
      payer: this.#o.appPayer.publicKey,
      legs: venue,
      receipt,
      receiptCu,
      lookupTables: this.#o.lookupTable ? [this.#o.lookupTable] : [],
      connection: this.#o.connection,
      proof: proof ? { program: this.#program, owner, position: position.address, continued: Boolean(extra.retry) } : undefined,
    });
    t.add("compose", Date.now() - composeStarted);
    const txLegs = txs.map((c) => c.legs.map((j) => (venue[j] as Partial<TradeLeg>).output?.leg ?? -1));
    const txKeys = txs.map((c) => c.legs.flatMap((j) => (venue[j] as Partial<TradeLeg>).key ?? []));
    // A sale too big for one transaction is a sequence too (api/sales.ts): its records ride last.
    // A trade the owner signs anyway also cancels their abandoned tickets. Not a sale: the app
    // expects exactly one transaction there. Each look is a getProgramAccounts, so it runs only
    // when the wallet is known to have one, or every TICKET_SCAN_MS (api/split.ts).
    let cleanup = 0;
    if (kind !== "exit" && kind !== "sweep" && this.#split.scanDue(owner.toBase58())) {
      const stale = await this.#abandonedTickets(owner).then((found) => {
        this.#split.scanned(owner.toBase58());
        return found;
      }).catch(() => []);
      if (stale.length) {
        txs.push(await this.#cleanupTx(owner, stale));
        cleanup = 1;
      }
    }
    const buildId = randomUUID();
    const expires = Math.min(started + BUILD_TTL_MS, (position.exit?.horizonEnd ?? position.sales?.[0]?.horizonEnd ?? Infinity) * 1_000);
    this.#builds.set(buildId, {
      owner: owner.toBase58(),
      messages: txs.map((c) => Buffer.from(c.tx.message.serialize())),
      market,
      kind,
      expires,
      position,
      cleanup,
      txLegs,
      txKeys,
      lend: venue.flatMap((v) => ((v as Partial<TradeLeg>).how === "lend" ? [(v as TradeLeg).output.leg] : [])),
      trade: extra.trade,
      retry: extra.retry,
      quotedAt: extra.quotedAt,
      prebuilt: Boolean(extra.prebuilt),
      marketFreshMs: SUBMIT_MARKET_FRESH_MS,
      phoenixMarket: phoenix ? venue.flatMap((v) => (v.marketAccounts.some((k) => k.equals(PERP_ASSET_MAP)) ? v.marketAccounts : [])) : undefined,
      seeds: venue.flatMap((v) => ((v as Partial<TradeLeg>).how === "swap" ? [{ mint: (v as JupiterBuy).mint, amount: (v as JupiterBuy).minOutAmount }] : [])),
      sale: extra.sale && {
        takeId: extra.sale.takeId,
        txSteps: stepsByTx(txs.map((c) => c.legs), extra.sale.steps, extra.sale.receipt),
        records: extra.sale.records,
        finish: extra.sale.finish,
      },
    });
    this.#expireLater(buildId);
    return {
      buildId,
      /** Unsigned v0 transactions, base64: sign each with the user's wallet, in order, then submit. */
      transactions: txs.map((c) => Buffer.from(c.tx.serialize()).toString("base64")),
      steps: txs.map((c) => ({ labels: c.labels, bytes: c.bytes, computeUnits: c.computeUnits })),
      /** Unix ms: submit before this (or refresh it). */
      expiresAt: expires,
      /** Unix ms: when its quotes were made (none: it has none). */
      quotedAt: extra.quotedAt ?? null,
      /** Built ahead of the tap: its money action counts at submit. Left out of a normal build. */
      ...(extra.prebuilt ? { prebuilt: true as const } : {}),
    };
  }

  /** Remembers a build route's whole answer on its build, so a refresh answers the same. */
  #keep<T extends { buildId: string }>(r: T): T {
    const b = this.#builds.get(r.buildId);
    if (b) b.response = r;
    return r;
  }

  /** Drops a build once it expires (a refresh moves its expiry: it's checked again then). */
  #expireLater(buildId: string) {
    const b = this.#builds.get(buildId);
    if (!b) return;
    setTimeout(() => {
      const now = this.#builds.get(buildId);
      if (!now) return;
      if (now.expires <= Date.now()) this.#builds.delete(buildId);
      else this.#expireLater(buildId);
    }, Math.max(0, b.expires - Date.now()) + 10).unref();
  }

  /**
   * A fresh blockhash for a build not yet submitted (POST /builds/:id/refresh): the same
   * instructions (quotes, sizes, compute limits) recompiled, with no Jupiter call, while its quotes
   * are at most QUOTE_REFRESH_MS old (409 `quote_stale` after: build again). Its market accounts
   * are refreshed if they're older than MARKET_FRESH_MS. The build keeps its id. Until its first
   * submit, the transactions it answered just before (a client may have signed them while the
   * refresh ran) can still be submitted, while their blockhash lasts; the first submit uses the
   * build, and other bytes after it are 409 `build_used`. 410 `build_gone`: expired, submitted or unknown.
   */
  async refreshBuild(buildId: string, o: BuildOpts = {}) {
    const t = o.timings ?? new Timings();
    const kind = this.#builds.get(buildId)?.kind ?? "unknown";
    return this.#timed(`${kind} refresh`, t, async () => {
      const build = this.#builds.get(buildId);
      if (!build || build.expires < Date.now()) throw new ApiError(410, "build_gone", "This build expired or was submitted. Build again.");
      if (build.quotedAt !== undefined && Date.now() - build.quotedAt > QUOTE_REFRESH_MS) throw new ApiError(409, "quote_stale", "This build's prices are too old. Build again.");
      if (build.market.length) await t.time("markets", () => this.#o.fork.refreshMarkets(build.market, { freshMs: MARKET_FRESH_MS }));
      const started = Date.now();
      const { blockhash } = await t.time("blockhash", () => this.#o.connection.getLatestBlockhash("confirmed"));
      // Submitted while this ran: it's used.
      if (this.#builds.get(buildId) !== build) throw new ApiError(410, "build_gone", "This build was submitted. Build again.");
      const messages = build.messages.map((m) => {
        const message = VersionedMessage.deserialize(m);
        message.recentBlockhash = blockhash;
        return message;
      });
      build.previous = { messages: build.messages, expires: build.expires };
      build.messages = messages.map((m) => Buffer.from(m.serialize()));
      build.expires = Math.min(started + BUILD_TTL_MS, (build.position.exit?.horizonEnd ?? build.position.sales?.[0]?.horizonEnd ?? Infinity) * 1_000);
      return {
        ...(build.response ?? {}),
        buildId,
        transactions: messages.map((m) => Buffer.from(new VersionedTransaction(m).serialize()).toString("base64")),
        expiresAt: build.expires,
        quotedAt: build.quotedAt ?? null,
      };
    }, () => buildId);
  }

  /**
   * Sends `txs` in order, after refreshing `market` from mainnet. By default each is preflighted
   * at "confirmed" and confirmed before the next goes out. With `accept` (until=accepted) they go
   * out back to back, each preflighted at "processed" (it sees the one before it), `accept` is
   * called once all were accepted, and then they're confirmed together. Either way it returns
   * once every one landed, or throws SendFailed with the ones that landed before the failure.
   *
   * `freshMs` leaves market accounts copied from mainnet that recently. If that left some and the
   * first transaction's preflight is refused (nothing went out), they're all reset and the same
   * signed transactions are sent once more; so is a transaction refused for slippage, the first or
   * a later one, with the ones after it (api/send.ts `resendOnce`).
   */
  async #send(txs: VersionedTransaction[], market: PublicKey[], t = new Timings(), accept?: () => void, freshMs = 0, always: PublicKey[] = []): Promise<string[]> {
    // A transaction that names Phoenix's program (program ids are always static keys) waits for the
    // Phoenix lock, and its refresh puts Phoenix's mainnet traders back first (lib.ts syncPhoenixMakers).
    const phoenix = txs.some((tx) => tx.message.staticAccountKeys.some((k) => k.equals(PHOENIX_PROGRAM_ID)));
    if (!phoenix) return this.#sendNow(txs, market, t, accept, freshMs, false, always);
    const queued = Date.now();
    return withPhoenixLock(() => {
      const waited = Date.now() - queued;
      if (waited > 5) t.add("phoenix lock", waited);
      return this.#sendNow(txs, market, t, accept, freshMs, true, always);
    });
  }

  async #sendNow(txs: VersionedTransaction[], market: PublicKey[], t: Timings, accept: (() => void) | undefined, freshMs: number, phoenixMakers: boolean, always: PublicKey[]): Promise<string[]> {
    const refreshed = await t.time("refresh", () => this.#o.fork.refreshMarkets(market, { freshMs, phoenixMakers, always }));
    // lib.ts says how many it left (`fresh`); a fork that doesn't say may have left any of them.
    const left = (refreshed as { fresh?: unknown } | undefined)?.fresh;
    try {
      return await resendOnce((rest) => (accept ? this.#sendAccepted(rest, t, accept) : this.#sendConfirmed(rest, t)), txs, {
        stale: freshMs > 0 && market.length > 0 && (typeof left === "number" ? left > 0 : true),
        reset: () => {
          t.note("resent", "markets reset");
          return t.time("refresh", () => this.#o.fork.refreshMarkets(market, { phoenixMakers }));
        },
        log: this.#log,
      });
    } finally {
      // This trade moved those pools on the fork (no arbitrage brings them back): the next build
      // copies them from mainnet again instead of pricing against the fork's own last trade.
      this.#o.fork.forgetFresh?.(market);
    }
  }

  /** #send's default way: one at a time, each preflighted at "confirmed" and confirmed before the next. */
  async #sendConfirmed(txs: VersionedTransaction[], t: Timings): Promise<string[]> {
    const conn = this.#o.connection;
    const out: string[] = [];
    let unknown = false;
    let nothingSent = false;
    let refused = false;
    try {
      for (const [i, tx] of txs.entries()) {
        const sent = Date.now();
        // Confirm against the transaction's own blockhash: once its last valid block passes, it can't
        // land any more. (A fresh blockhash would keep waiting ~60 s past that.)
        const { blockhash, lastValidBlockHeight } = await this.#lifetime(tx);
        // The fee payer's signature is the transaction's id, known before it's sent.
        const sig = base58(tx.signatures[0]);
        let fate: "landed" | "failed" | "unknown" | null = null;
        await conn.sendTransaction(tx, { skipPreflight: false }).catch(async (e) => {
          if (refusedByPreflight(e)) {
            nothingSent = i === 0;
            // Each one before it was confirmed first: it alone stopped the trade, unsent.
            refused = true;
            throw refusedError(e);
          }
          // The RPC failed: the transaction may have gone out all the same.
          this.#log(`sending ${sig} failed (${errorText(e)}); waiting to see if it landed`);
          fate = await this.#settle(sig, lastValidBlockHeight);
          if (fate !== "landed") {
            unknown = fate === "unknown";
            throw new ApiError(502, "send_failed", errorText(e));
          }
        });
        const confirming = Date.now();
        if (fate !== "landed") {
          const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed").catch(async (e) => {
            // Expired, or the RPC failed: whether it landed decides what comes next (a split
            // trade's retry must not buy a leg twice). Unknown is never "didn't land".
            this.#log(`confirming ${sig} failed (${errorText(e)}); waiting to see if it landed`);
            const settled = await this.#settle(sig, lastValidBlockHeight);
            if (settled === "landed") return { value: { err: null } };
            unknown = settled === "unknown";
            throw new ApiError(502, "transaction_failed", `${sig}: ${settled === "unknown" ? "not confirmed yet" : "not confirmed"}`);
          });
          if (res.value.err) throw new ApiError(502, "transaction_failed", `${sig}: ${JSON.stringify(res.value.err)}`);
        }
        t.add(`send${txs.length > 1 ? ` ${i + 1}` : ""}`, confirming - sent);
        t.add(`confirm${txs.length > 1 ? ` ${i + 1}` : ""}`, Date.now() - confirming);
        out.push(sig);
      }
    } catch (e) {
      throw new SendFailed(e instanceof ApiError ? e : new ApiError(502, "send_failed", errorText(e)), out, unknown, nothingSent, refused);
    }
    return out;
  }

  /** A transaction's blockhash and its last valid block height (a fresh one's, if this service didn't hand it out). */
  async #lifetime(tx: VersionedTransaction): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const own = tx.message.recentBlockhash;
    const lastValid = this.#blockhashes.get(own);
    return lastValid !== undefined ? { blockhash: own, lastValidBlockHeight: lastValid } : this.#o.connection.getLatestBlockhash("confirmed");
  }

  /** #send for until=accepted (api/send.ts): back to back, `accept` once all were accepted, then confirmed. */
  async #sendAccepted(txs: VersionedTransaction[], t: Timings, accept: () => void): Promise<string[]> {
    const lifetimes = await Promise.all(txs.map((tx) => this.#lifetime(tx)));
    return sendBackToBack(this.#o.connection, txs, Math.max(0, ...lifetimes.map((l) => l.lastValidBlockHeight)), { accept, timings: t, log: this.#log });
  }

  /**
   * Polls a transaction's status until it's known: "landed" (confirmed without an error), "failed"
   * (landed with an error, or its blockhash expired unseen), or "unknown" after SETTLE_MAX_MS
   * without an answer.
   */
  async #settle(sig: string, lastValidBlockHeight: number): Promise<"landed" | "failed" | "unknown"> {
    return (await this.#fates([sig], lastValidBlockHeight))[0];
  }

  /** api/send.ts `fates`, on this service's connection. */
  #fates(sigs: string[], lastValidBlockHeight: number, o: { once?: boolean } = {}): Promise<Fate[]> {
    return fates(this.#o.connection, sigs, lastValidBlockHeight, o);
  }

  // --- Demo mirrors -----------------------------------------------------------------------

  /** create_take with the author's buy-in, recording only the legs it bought (`included`). */
  /** The on-chain take id for an app take: its id and mapped legs (a demo take whose legs changed mirrors to a new address). */
  #onChainId(app: AppTake): bigint {
    const legsId = this.#mapLegs(app.legs).map((l) => `${l.spec.asset.toBase58()}:${l.spec.weightBps}:${l.spec.leverage}`).join(",");
    return BigInt("0x" + createHash("sha256").update(`thesis:take:v2:${app.id}:${legsId}`).digest("hex").slice(0, 15));
  }

  /** Takes a recovery check found missing, so polling receipts don't read the chain every time. */
  #notFound = new Map<string, number>();

  /**
   * A take its author posted that this API has no record of (its state file was lost, or the take
   * was published through another API) may still be on-chain: its address follows from the
   * author's wallet and the take's id. If it's there, it's recorded and used. Null otherwise.
   */
  async #recover(takeId: string, app: AppTake): Promise<{ address: PublicKey; take: TakeAccount } | null> {
    if (!app.author_wallet || app.status === "posting") return null;
    if ((this.#notFound.get(takeId) ?? 0) > Date.now() - 60_000) return null;
    let author: PublicKey;
    try {
      author = new PublicKey(app.author_wallet);
    } catch {
      return null;
    }
    const address = takeAddress(author, this.#onChainId(app));
    const take = await this.#program.account.take.fetchNullable(address).catch(() => null);
    if (!take || !take.author.equals(author)) {
      this.#notFound.set(takeId, Date.now());
      return null;
    }
    this.#state.takes[takeId] = { address: address.toBase58(), author: author.toBase58(), mirroredAt: new Date().toISOString() };
    this.#save();
    this.#notePosition(address, positionAddress(address, author, 0n), author.toBase58());
    this.#log(`found take ${takeId} on-chain at ${address.toBase58()} (its author's); recorded it`);
    return { address, take };
  }

  /**
   * `create_take` for a take. Its horizon is the app's settles_at (posting + 365 days, which the
   * go-live trigger matches against takeCreated); a demo mirror runs a year from now.
   */
  async #createIx(app: AppTake, author: PublicKey, usd: number, included: number[], o: { demo?: boolean } = {}) {
    const legs = this.#mapLegs(app.legs);
    const id = this.#onChainId(app);
    const now = Math.floor(Date.now() / 1000);
    const horizon = o.demo ? now + TAKE_LIFETIME_SECS : Math.floor(Date.parse(app.settles_at) / 1000);
    const ix = await createTakeIx(this.#program, {
      author,
      payer: this.#o.appPayer.publicKey,
      id,
      claimHash: claimHash(app.claim),
      risk: RISK[app.risk] ?? RISK.medium,
      horizonEnd: new BN(horizon),
      legs: legs.map((l) => l.spec),
      stake: new BN(Math.round(usd * USD)),
      legsMask: included.reduce((m, i) => m | (1 << i), 0),
      inverted: Boolean(app.inverted),
    });
    return { ix, address: takeAddress(author, id) };
  }

  /**
   * The take on-chain, mirroring a demo take with a fork-only author key if needed. A demo take
   * whose legs changed in the app since it was mirrored is mirrored again (its old positions stay
   * on the old address).
   */
  async #ensureOnChain(takeId: string, app: AppTake): Promise<{ address: PublicKey; take: TakeAccount }> {
    const m = this.#state.takes[takeId];
    if (m && !staleDemo(m)) {
      const address = new PublicKey(m.address);
      const take = await this.#program.account.take.fetchNullable(address);
      if (take && (!m.demoAuthorKey || sameLegs(take.legs, this.#mapLegs(app.legs), { onChain: take.inverted, app: app.inverted }))) return { address, take };
      if (!take && !m.demoAuthorKey) throw new ApiError(409, "take_missing", TAKE_MISSING);
      this.#log(`demo take ${takeId} ${take ? "changed in the app" : "is missing on the fork"}; mirroring it again`);
    }
    // Only a seeded demo take (its author has no wallet) is mirrored under a stand-in key. A take
    // its author posted can only be put on-chain by them. Unless it's at its own address (#recover), the fork
    // was reset since it was posted, so refuse rather than give its creator fees and score to a stand-in.
    if (app.author_wallet) {
      const found = await this.#recover(takeId, app);
      if (found) return found;
      throw new ApiError(409, "take_missing", TAKE_MISSING);
    }
    if (app.inverted && !invertible(this.#mapLegs(app.legs))) throw new ApiError(422, "not_fadeable", INVERTED_NOT_FADEABLE);
    const author = Keypair.generate();
    await this.#o.fork.addUsdc(author.publicKey, 100);
    let address: PublicKey;
    // The service signs a demo mirror itself, so a send that fails (usually a price that moved
    // past the quote's slippage) is rebuilt with fresh quotes and tried once more.
    for (let attempt = 1; ; attempt++) {
      try {
        // An inverted demo take's stand-in author buys in on its agreeing side (an on-chain fade).
        const { venue, included } = await this.#router.venueLegs(this.#mapLegs(app.legs), author.publicKey, DEMO_AUTHOR_BUY_IN_USD, undefined, undefined, { side: agreeSide(app) });
        const created = await this.#createIx(app, author.publicKey, DEMO_AUTHOR_BUY_IN_USD, included, { demo: true });
        address = created.address;
        this.#recordPhoenix(positionAddress(address, author.publicKey, 0n), author.publicKey, venue);
        const ix = created.ix;
        const txs = await composeTransactions({
          payer: this.#o.appPayer.publicKey,
          legs: venue,
          receipt: ix,
          receiptCu: THESIS_COMPUTE_UNITS.createTake,
          lookupTables: this.#o.lookupTable ? [this.#o.lookupTable] : [],
          connection: this.#o.connection,
          proof: { program: this.#program, owner: author.publicKey, position: positionAddress(address, author.publicKey, 0n) },
        });
        for (const t of txs) t.tx.sign([this.#o.appPayer, author]);
        const signatures = await this.#send(txs.map((t) => t.tx), venue.flatMap((v) => v.marketAccounts));
        this.#valuation.recordOpening(positionAddress(address, author.publicKey, 0n), signatures);
        break;
      } catch (e) {
        if (attempt >= 2) throw e;
        this.#log(`mirroring ${takeId} failed (${e instanceof Error ? e.message.slice(0, 120) : e}); trying again`);
      }
    }
    this.#notePosition(address, positionAddress(address, author.publicKey, 0n), author.publicKey.toBase58(), true);
    this.#state.takes[takeId] = { address: address.toBase58(), author: author.publicKey.toBase58(), demoAuthorKey: [...author.secretKey], mirroredAt: new Date().toISOString(), v: MIRROR_VERSION };
    this.#save();
    this.#log(`mirrored take ${takeId} as ${address.toBase58()} (${app.author?.handle ?? "demo author"})`);
    return { address, take: await this.#program.account.take.fetch(address) };
  }

  /** App legs mapped with the asset bank and catalog names (rebuilt when the bank reloads). */
  #mapLegs(legs: AppLeg[]): MappedLeg[] {
    const bank = this.#o.bank();
    if (this.#resolver?.bank !== bank) {
      this.#resolver = {
        bank,
        resolve: nameResolver(bank.underlyings, this.#o.catalog ?? []),
        contracts: contractResolver(bank.venues.gemini?.contracts),
        perps: perpResolver(bank.venues.phoenix?.markets),
      };
    }
    return mapLegs(legs, this.#resolver.resolve, this.#resolver.contracts, this.#resolver.perps);
  }
  #resolver: { bank: BankState; resolve: NameResolver; contracts: ContractResolver; perps: PerpResolver } | null = null;

  // --- Portfolio ----------------------------------------------------------------------------

  /**
   * A wallet's open positions across the takes this service knows (posted or mirrored here), each
   * as its take's receipt shows it, plus the "called it" badges the wallet holds on-chain (unless
   * `badges: false`). Only takes the wallet holds are read (see #takesHeldBy): building a receipt
   * for every take, for every wallet, every few minutes, didn't scale.
   */
  async portfolio(addr: string, { strict = false, badges: withBadges = true } = {}) {
    const owner = parseKey(addr);
    const takeIds = this.#takesHeldBy(addr);
    const [perTake, badgeInfos] = await Promise.all([
      Promise.all(
        takeIds.map(async (takeId) => {
          const [r, app] = await Promise.all([this.receipt(takeId, addr, { routes: false, strict }), this.#appTake(takeId)]).catch((error: unknown) => {
            // A take deleted from Supabase is gone for good, not a failed read: leave it out even
            // when strict, as the portfolio list does, or the wallet's chart fails from then on.
            if (strict && !(error instanceof ApiError && error.code === "no_such_take")) throw error;
            return [null, null] as const;
          });
          if (!r?.onChain || !app) return [];
          return r.viewerPositions.filter((p) => !p.exited).map((p) => ({
            ...p,
            takeId,
            claim: app.claim,
            topic: app.topic ?? null,
            authorHandle: app.author?.handle ?? null,
            takeStatus: r.status,
            settlesAt: r.horizonEnd,
          }));
        }),
      ),
      withBadges ? this.#badgeAccounts(owner, strict) : BADGES.map(() => null),
    ]);
    const positions = perTake.flat().sort((a, b) => b.openedAt - a.openedAt);
    const held = BADGES.filter((_, i) => badgeInfos[i]);
    // Each badge's art, from where the config says badge metadata lives (Supabase Storage); none
    // if the config can't be read right now.
    const base = held.length ? await this.#config().then((c) => c.badgeUriBase, () => null) : null;
    const badges = held.map((b) => ({
      ...b,
      mint: badgeMintAddress(owner, BADGE_KIND_INDEX[b.kind], this.#program.programId).toBase58(),
      image: base ? `${base}${BADGE_META[b.kind].slug}.png` : null,
    }));
    return { wallet: addr, positions, badges };
  }

  /**
   * The wallet's badge mints, one read. The RPC sometimes answers "Internal error" under load: try
   * once more, then show the positions without badges for now rather than failing the whole
   * portfolio with a 500. Strict callers (the history chart) still get the error.
   */
  async #badgeAccounts(owner: PublicKey, strict: boolean) {
    const mints = BADGES.map((b) => badgeMintAddress(owner, BADGE_KIND_INDEX[b.kind], this.#program.programId));
    const read = () => this.#o.connection.getMultipleAccountsInfo(mints);
    try {
      return await read().catch(read);
    } catch (error) {
      if (strict) throw error;
      this.#log(`portfolio: badge read failed (${error instanceof Error ? error.message.slice(0, 80) : error}); shown without badges`);
      return BADGES.map(() => null);
    }
  }

  // --- Portfolio history, digests and cash ------------------------------------------------

  history(addr: string, range: string) {
    return this.#history.history(addr, range);
  }

  /**
   * One "how your positions are doing" notification per wallet with priced open positions: the
   * change since the last digest (or since getting in, the first time), the total value, and the
   * best position. Marks each wallet's value for the next day's change. `day` is YYYY-MM-DD.
   */
  async dailyDigests(day: string) {
    const owners = new Set<string>();
    for (const m of Object.values(this.#state.takes)) {
      for (const p of await this.#positionsOf(new PublicKey(m.address)).catch(() => [])) owners.add(p.account.owner.toBase58());
    }
    return dailyDigests(day, owners, (wallet) => this.portfolio(wallet), this.#store);
  }

  wallet(addr: string) {
    return this.#wallets.wallet(addr);
  }

  deposit(addr: string, usd: number) {
    return this.#wallets.deposit(addr, usd);
  }

  withdraw(addr: string, usd: number) {
    return this.#wallets.withdraw(addr, usd);
  }

}

/** Regular US stock-market hours (Mon-Fri, 9:30-16:00 New York; holidays not counted). */
export function usMarketOpen(at: Date): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return !["Sat", "Sun"].includes(parts.weekday) && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** A price for an alert: "$61.21", or "$0.0123" below $10, "?" when unknown. */
function money(n: number | null): string {
  if (n === null) return "?";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 })}`;
}

/** Why a position's legs have no entry price yet, in words the app can show. */
export function pendingNote(pending: { name: string }[], openedAt: number, now = new Date()): string {
  const names = pending.map((l) => l.name).join(", ");
  if (now.getTime() / 1000 - openedAt < 120) return `Recording the entry price for ${names}`;
  return usMarketOpen(now) ? `${names}: waiting for the stock's next trade` : `${names} gets its entry price when the stock market opens`;
}

/** The badge catalog (CLAUDE.md), in program order, with what the app shows for each. */
const BADGES = [
  { kind: "firstTake", title: "First take posted" },
  { kind: "firstOver50", title: "First take at +50%" },
  { kind: "firstOver100", title: "First take at +100%" },
  { kind: "tenOver50", title: "Ten takes at +50%" },
  { kind: "over1000", title: "A take at +1,000%" },
] as const;

/** The positions a sale build sells (a build from before partial sales names only its one exit). */
function salesOf(build: Build): SaleRecord[] {
  if (build.position.sales?.length) return build.position.sales;
  return [{ address: build.position.address, seq: 0, full: true, horizonEnd: build.position.exit?.horizonEnd ?? 0, exit: build.position.exit }];
}

function saleAddresses(build: Build): string[] {
  return salesOf(build).map((x) => x.address.toBase58());
}
