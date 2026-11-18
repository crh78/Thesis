// What the app needs from the fork, as plain methods (server.ts puts HTTP in front):
//
//   receipt     a take's on-chain receipt: counters, legs, live return, the viewer's positions
//   buildTrade  the transactions for a back (Jupiter swaps + Jupiter Lend + receipt), unsigned,
//               for the user's Privy wallet to sign
//   buildPublish the same for posting an app take on-chain with the author's buy-in
//   submit      adds the app fee payer's signature to transactions this service built and sends them
//   buildPhoenixCashOut  closes Phoenix positions left after a sale or the horizon, or sweeps the
//               cash left in Phoenix back to USDC (api/phoenix.ts)
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
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  BADGE_KIND_INDEX,
  BADGE_META,
  RISK,
  THESIS_COMPUTE_UNITS,
  USDC_MINT_MAINNET,
  backIx,
  cancelTradeIx,
  fadeIx,
  badgeMintAddress,
  claimHash,
  composeTransactions,
  createTakeIx,
  exitPositionIx,
  fetchConfig,
  positionAddress,
  positionReturnBps,
  splitFee,
  takeAddress,
  thesisProgram,
  type TakeAccount,
  type ThesisProgram,
} from "@thesis/chain";
import { JupiterClient, cardLeg, underlyingIdHex, type BankState } from "@thesis/venues/bank";
import { cardIdHex } from "@thesis/venues/collector-crypt";
import { jupiterBuy, jupiterLendRedeem, type VenueLeg } from "@thesis/venues/jupiter";
import { PHOENIX_LEG_CU } from "@thesis/venues/phoenix";
import {
  ApiError,
  FADE_BLOCKED,
  FADE_NO_MARKET,
  FADE_OWN_TAKE,
  TAKE_MISSING,
  FADE_NOTHING,
  MIRROR_VERSION,
  SELLABLE,
  USD,
  checkAmount,
  errorText,
  logSlow,
  legAssets,
  parseKey,
  randomPositionId,
  staleDemo,
  type AppTake,
  type ExitReceipt,
  type ServiceOpts,
} from "./common.ts";
import { CreatorFees } from "./creator-fees.ts";
import { dailyDigests } from "./digests.ts";
import { PortfolioHistory } from "./history.ts";
import { contractResolver, escrowedKind, mapLegs, nameResolver, onChainLegs, perpResolver, sameLegs, type AppLeg, type ContractResolver, type MappedLeg, type NameResolver, type PerpResolver } from "./legs.ts";
import { PhoenixDesk } from "./phoenix.ts";
import { Router, escrowShare } from "./routing.ts";
import { StateStore } from "./store.ts";
import { Valuation } from "./valuation.ts";
import { Wallets } from "./wallets.ts";

export { ApiError, DEFAULT_STATE_PATH, MIN_STAKE_USD, type AppTake, type ServiceOpts, type TakeSource } from "./common.ts";
export { digestFor } from "./digests.ts";

type Build = {
  owner: string;
  messages: Buffer[];
  market: PublicKey[];
  kind: "back" | "publish" | "exit" | "claim" | "phoenix";
  /** A creator-fee claim: the takes it claims (no position). */
  claims?: string[];
  expires: number;
  /** The position the receipt instruction opens, so the receipt can show it right away. */
  position: { take: PublicKey; address: PublicKey; publishTakeId?: string; exit?: ExitReceipt };
  /**
   * Trailing transactions that only cancel this owner's abandoned trade tickets (security review
   * L-4). They're sent after the trade has landed, and a failure there doesn't fail the trade.
   */
  cleanup?: number;
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
  /** Positions whose transactions are being sent right now: their tickets aren't abandoned. */
  #inFlight = new Set<string>();
  #blinkCheckouts = new Map<string, BlinkCheckout>();
  #log: (m: string) => void;
  /** Blockhash → its last valid block height, from every blockhash this service fetched. */
  #blockhashes = new Map<string, number>();

  constructor(opts: ServiceOpts) {
    const o: ServiceOpts = { ...opts, connection: trackBlockhashes(opts.connection, this.#blockhashes) };
    this.#o = o;
    this.#program = thesisProgram(o.connection);
    this.#log = o.log ?? (() => {});
    this.#store = new StateStore(o.statePath, o.lookupTable);
    this.#valuation = new Valuation(o, this.#store);
    this.#router = new Router(o);
    this.#phoenix = o.phoenix ? new PhoenixDesk(o, o.phoenix, this.#store, this.#program) : null;
    this.#router.phoenix = this.#phoenix;
    // The chart doesn't show badges: its snapshots skip reading them.
    this.#history = new PortfolioHistory(this.#store, o.connection, (addr, opts) => this.portfolio(addr, { ...opts, badges: false }), (addr) => this.#holds(addr));
    this.#wallets = new Wallets(o, this.#store, this.#program, (addr) => this.#history.snapshot(addr));
    this.#fees = new CreatorFees(
      o,
      this.#program,
      () => new Map(Object.entries(this.#state.takes).filter(([, m]) => !m.demoAuthorKey).map(([id, m]) => [m.address, id])),
      (takeId) => this.#appTake(takeId).then((t) => t.claim).catch(() => null),
      // Takes the author posted through this API (on-chain addresses).
      (author) => Object.values(this.#state.takes).filter((m) => m.author === author && !m.demoAuthorKey).map((m) => m.address),
    );
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
    if (onChainTake && !sameLegs(onChainTake.legs, legs)) {
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
    const leftOut = legs.map((l) => this.#router.leftOut(l));
    const canBuy = leftOut.some((why) => why === null);
    // Fades hold the other side of prediction legs (paper) and short the rest on Phoenix.
    const fadeOut = legs.map((l) => this.#router.leftOut(l, Date.now(), "fade"));
    const fadeable = fadeOut.some((why) => why === null);
    const legView = (onChain?: TakeAccount) =>
      legs.map((l, i) => ({
        index: l.index,
        name: l.name,
        underlying: l.key,
        tradable: leftOut[i] === null,
        blocked: leftOut[i],
        /** Why a fade leaves this leg out (it holds a prediction's other side, or a Phoenix short); null if it can be faded. */
        fadeBlocked: fadeOut[i],
        /** A perp leg: the Phoenix market a back goes long on, and its leverage. */
        perp: l.phoenix ? { symbol: l.phoenix.symbol, leverage: l.spec.leverage } : null,
        /** The Phoenix market a fade shorts this leg on, if any. */
        short: l.short?.symbol ?? null,
        /** A yield leg (Jupiter Lend): it earns interest, priced as one vault share's value, which counts in the score. */
        yield: l.how === "lend",
        /** A prediction leg, filled on paper at Gemini's prices: the side the take holds, and its market now. */
        prediction: l.prediction
          ? {
              instrument: l.prediction.contract.instrumentSymbol,
              event: l.prediction.contract.eventTitle,
              label: l.prediction.contract.label,
              side: l.prediction.side,
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
    // Why a fade isn't possible right now: a prediction market's other side, or no Phoenix short.
    const fadeBlocked = fadeable ? null : legs.some((l) => l.how === "paper") ? FADE_NO_MARKET : FADE_BLOCKED;
    if (!address || !onChainTake || !positionsP) {
      // A live take a real user posted that isn't on this fork: the fork was reset since. A live take
      // can't be published again, so its author has to post a new take. A demo take is mirrored on its first trade.
      const missing = app.status !== "posting" && (!!app.author_wallet || (!!mirror && !mirror.demoAuthorKey));
      if (missing) return { takeId, onChain: false as const, legs: legView(), canBack: false, canFade: false, fadeBlocked: TAKE_MISSING, missing: TAKE_MISSING };
      return { takeId, onChain: false as const, legs: legView(), canBack: canBuy, canFade: fadeable, fadeBlocked };
    }

    const take = onChainTake;
    const positions = await positionsP;
    const author = positions.find((p) => p.account.owner.equals(take.author) && p.account.id.isZero());
    const mine = viewer ? positions.filter((p) => p.account.owner.toBase58() === viewer) : [];
    // Authors can't fade their own take (the program doesn't check it yet).
    const viewerIsAuthor = viewer === take.author.toBase58();
    const [marks, config] = await Promise.all([this.#valuation.marks(take, legs, [...(author ? [author] : []), ...mine]), this.#config()]);
    /**
     * A position's return at current prices: each leg marked on the source its entry was priced
     * on. Null while a priced leg has no entry or no mark (never a -100% from a missing price).
     */
    const live = (p: (typeof positions)[number]): number | null => {
      const m = marks.get(p.publicKey.toBase58()) ?? [];
      for (const [i, leg] of take.legs.entries()) {
        if (!(p.account.legsMask & (1 << i))) continue;
        if (!(p.account.entrySet & (1 << i)) || m[i] == null) return null;
      }
      return positionReturnBps(take.legs, {
        side: p.account.side,
        legsMask: p.account.legsMask,
        prices: p.account.prices.map((x, i) => ({ entry: BigInt(x.entry.toString()), exit: m[i] ?? 0n })),
      });
    };
    const authorMarks = author ? (marks.get(author.publicKey.toBase58()) ?? []) : [];
    const settled = "settled" in take.status;
    return {
      takeId,
      onChain: true as const,
      address: address.toBase58(),
      author: take.author.toBase58(),
      status: settled ? "settled" : "open",
      createdAt: take.createdAt.toNumber(),
      horizonEnd: take.horizonEnd.toNumber(),
      backers: take.backers,
      faders: take.faders,
      totalBackedUsd: take.totalBacked.toNumber() / USD,
      totalFadedUsd: take.totalFaded.toNumber() / USD,
      creatorFeesUnclaimedUsd: take.creatorFeesUnclaimed.toNumber() / USD,
      /** Settled: the take's result. Open: the author's position at current prices, once entry prices are in. */
      returnBps: settled ? take.resultBps.toNumber() : author ? live(author) : null,
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
          return {
            address: p.publicKey.toBase58(),
            side: "back" in p.account.side ? "back" : "fade",
            exited,
            canExit: !exited && !settled && take.horizonEnd.toNumber() > Date.now() / 1000 &&
              take.legs.every((leg, i) => !(p.account.legsMask & (1 << i)) || SELLABLE(leg.kind)),
            /** The prediction share held in escrow; it comes back in full at a sale or when the position settles. */
            escrowedUsd: Number(BigInt(p.account.escrowed.toString())) / USD,
            stakeUsd: Number(stake) / USD,
            openedAt: p.account.openedAt.toNumber(),
            legsMask: p.account.legsMask,
            /** The score's return: on-chain entry prices against live marks on the same source. */
            returnBps: live(p),
            /** What the trade cost the wallet (stake plus the Thesis fee). */
            costUsd: Number(stake + fee) / USD,
            /** What the tokens this trade bought are worth now, or null if a price is missing. */
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
        ...(viewer ? this.#settledExits(address, viewer, new Set(mine.map((p) => p.publicKey.toBase58()))) : []),
      ],
      canBack: !settled && canBuy,
      canFade: !settled && fadeable && !viewerIsAuthor,
      fadeBlocked: settled ? "This take has settled." : viewerIsAuthor ? FADE_OWN_TAKE : fadeBlocked,
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
    // A take never read here gets its first scan when it's read, which finds this position too.
    if (!isNew && !this.#positions.has(key)) return;
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

  async #config() {
    if (!this.#configCache || this.#configCache.at < Date.now() - 60_000) this.#configCache = { at: Date.now(), value: await fetchConfig(this.#program) };
    return this.#configCache.value;
  }
  #configCache: { at: number; value: Awaited<ReturnType<typeof fetchConfig>> } | null = null;

  /**
   * What a position is worth now: the tokens its trade bought, plus its escrowed prediction and card
   * share at the legs' paper marks (at cost while a leg has no entry or mark). Null if a token can't be priced.
   */
  async #positionWorth(
    take: TakeAccount,
    p: { publicKey: PublicKey; account: { owner: PublicKey; side: object; legsMask: number; escrowed: { toString(): string }; entrySet: number; prices: { entry: { toString(): string } }[] } },
    marks: (bigint | null)[],
  ): Promise<number | null> {
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
    const tokens = tokenValue + phoenixValue;
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
   * A back or a fade. A fade holds the other side of each prediction leg, filled on paper with its
   * share escrowed, and shorts the other legs on Phoenix; legs it can't short are left out with the reason.
   */
  async buildTrade(takeId: string, owner: string, side: "back" | "fade", usd: number) {
    const ownerKey = parseKey(owner);
    const started = Date.now();
    const { address, venue, included, excluded, ix, position, feeUsd, escrowUsd, mirrorMs } =
      await this.#prepareBack(takeId, ownerKey, usd, this.#o.appPayer.publicKey, undefined, side).catch((e: unknown) => {
        if (side === "fade" && e instanceof ApiError && e.code === "nothing_tradable") throw new ApiError(409, "fade_unavailable", FADE_NOTHING);
        throw e;
      });
    const prepared = Date.now();
    const built = await this.#compose(venue, ix, side === "back" ? THESIS_COMPUTE_UNITS.back : THESIS_COMPUTE_UNITS.fade, ownerKey, "back", position, true);
    // Where a slow build's time went (target: a trade lands in under 5 s).
    logSlow(this.#log, `${side} build ${takeId.slice(0, 8)}`, Date.now() - started, {
      "put on-chain": mirrorMs, "legs and quotes": prepared - started - mirrorMs, compose: Date.now() - prepared,
    });
    return { ...built, take: address.toBase58(), side, stakeUsd: usd, feeUsd, escrowUsd, included, excluded };
  }

  /**
   * Sells a whole position: the wallet swaps each spot leg's tokens back to USDC and redeems each
   * yield leg's jlUSDC, and `exit_position` records the sale in the same transaction. The program
   * lets each position exit once; it then scores on the settler's prices at the sale.
   */
  async buildExit(takeId: string, address: string, wallet: string) {
    const owner = parseKey(wallet);
    const position = parseKey(address);
    const mirror = this.#state.takes[takeId];
    if (!mirror) throw new ApiError(404, "take_missing");
    const takeKey = new PublicKey(mirror.address);
    const [take, holding] = await Promise.all([
      this.#program.account.take.fetchNullable(takeKey),
      this.#program.account.position.fetchNullable(position),
    ]);
    if (!holding?.owner.equals(owner) || !holding.take.equals(takeKey)) throw new ApiError(404, "position_missing");
    if (holding.exited) throw new ApiError(409, "already_exited", "This position has already been sold.");
    if (!take || !("open" in take.status) || take.horizonEnd.toNumber() <= Date.now() / 1000) throw new ApiError(409, "take_closed");
    const legs = take.legs.filter((_, i) => holding.legsMask & (1 << i));
    if (!legs.length || legs.some((leg) => !SELLABLE(leg.kind))) {
      throw new ApiError(422, "not_sellable", "Only spot, yield, perp, prediction and card legs can be sold on the fork.");
    }
    // Legs held on Phoenix (perp legs; a fade's shorts) close there; the rest swap back.
    const onPhoenix = this.#onPhoenix(take, holding.side, holding.legsMask);
    const phoenixAssets = new Set(onPhoenix.map((i) => take.legs[i].asset.toBuffer().toString("hex")));
    if (onPhoenix.length && !this.#phoenix) throw new ApiError(422, "not_sellable", "Phoenix isn't connected on this fork.");

    const bought = await this.#valuation.bought(position, owner);
    const tokens = this.#o.bank().tokens;
    // A spot leg's asset is its underlying; a yield leg's is the vault token itself (`token:<mint>`).
    // Prediction and card legs hold no tokens: the sale pays their escrow back.
    const inventory = legs.filter((leg) => !escrowedKind(leg.kind) && !phoenixAssets.has(leg.asset.toBuffer().toString("hex"))).map((leg) => {
      const asset = leg.asset.toBuffer().toString("hex");
      const isYield = "yield" in leg.kind;
      const matches = [...bought].filter(([mint]) =>
        isYield ? underlyingIdHex(`token:${mint}`) === asset : Boolean(tokens[mint]) && underlyingIdHex(tokens[mint].underlying) === asset);
      if (matches.length !== 1) throw new ApiError(422, "inventory_unavailable", "The receipt transaction must identify every token bought by this position.");
      return { mint: matches[0][0], amount: matches[0][1], isYield };
    });
    if (new Set(inventory.map((l) => l.mint)).size !== inventory.length) throw new ApiError(422, "inventory_unavailable");
    await Promise.all(inventory.map(async ({ mint, amount, isYield }) => {
      const program = isYield ? "spl" : tokens[mint].program;
      if (program === "unknown") throw new ApiError(422, "inventory_unavailable", "The token program for this position is unknown.");
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, program === "token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
      const balance = await this.#o.connection.getTokenAccountBalance(ata, "confirmed").then((r) => BigInt(r.value.amount)).catch(() => 0n);
      if (balance < amount) throw new ApiError(409, "insufficient_tokens", "Your wallet no longer holds all the tokens this position bought.");
    }));
    const jupiter = new JupiterClient(this.#o.jupiterApiKey, 0);
    const payer = this.#o.appPayer.publicKey;
    const usdc = USDC_MINT_MAINNET.toBase58();
    const config = await this.#config();
    const ix = await exitPositionIx(this.#program, { owner, take: takeKey, position, payer });
    const stake = BigInt(holding.stake.toString());
    const fee = splitFee(stake, config.params, { isAuthor: take.author.equals(owner) }).fee;
    const escrowUsd = Number(BigInt(holding.escrowed.toString())) / USD;
    const exit: ExitReceipt = {
      horizonEnd: take.horizonEnd.toNumber(),
      owner: wallet,
      side: "back" in holding.side ? "back" : "fade",
      stakeUsd: Number(stake) / USD,
      costUsd: Number(stake + fee) / USD,
      openedAt: holding.openedAt.toNumber(),
      legsMask: holding.legsMask,
    };
    // Redeeming jlUSDC has no slippage: it's worth its shares at the vault's rate, read exactly
    // from Jupiter Lend (totalAssets / totalSupply), with Jupiter's token price as a fallback. Each
    // read is tried twice, then the last value known stands in (it only sizes the proceeds shown).
    const redeems = inventory.filter((l) => l.isYield);
    const redeemValue = async () => {
      let usd = 0;
      for (const { mint, amount } of redeems) {
        const perShare = await this.#valuation.lendShareValue(mint, { retry: true });
        if (perShare === null) return this.#valuation.tokensUsd(redeems.map((l) => [l.mint, l.amount]));
        usd += (Number(amount) / 1e6) * perShare; // vault shares have USDC's 6 decimals
      }
      return usd;
    };
    const [shareValue, redeemLegs] = await Promise.all([
      redeems.length ? redeemValue() : Promise.resolve(0),
      Promise.all(redeems.map(({ amount }) => jupiterLendRedeem({ user: owner, payer, shares: amount, label: "Withdraw jlUSDC", apiKey: this.#o.jupiterApiKey! }))),
    ]);
    if (shareValue == null) throw new ApiError(422, "no_exit_route", "Couldn't price this position's yield shares.");
    // Phoenix legs: close each child's position. The cash stays in the child until the app sweeps
    // it (`buildPhoenixCashOut`), since Phoenix won't withdraw more than is there.
    const appLegs = onPhoenix.length ? (await this.#appTake(takeId).catch(() => null))?.legs : undefined;
    const names = new Map(take.legs.map((_, i) => [i, appLegs?.[i]?.name ?? `Leg ${i + 1}`] as const));
    const [closes, phoenixWorth] = onPhoenix.length
      ? await Promise.all([this.#phoenix!.closeLegs(position, owner, names), this.#phoenix!.valueAndNotional(position, owner)])
      : [[] as VenueLeg[], { usd: 0, notional: 0 }];
    if (phoenixWorth === null) throw new ApiError(422, "no_exit_route", "Phoenix has no price for one of this position's markets right now.");
    const quoteExit = async (maxAccounts: number) => {
      const swaps = await Promise.all(inventory.filter((l) => !l.isYield).map(async ({ mint, amount }) => {
        const { quote } = await jupiter.quoteExactIn(mint, usdc, amount, { ...this.#router.route, maxAccounts });
        if (!quote || quote.inputMint !== mint || quote.outputMint !== usdc || quote.inAmount !== amount.toString()) throw new ApiError(422, "no_exit_route", "No route to sell every token in this position.");
        return { quote, venue: await jupiterBuy({ quote, user: owner, payer, label: `Sell ${tokens[mint].symbol}`, apiKey: this.#o.jupiterApiKey }) };
      }));
      const venues: VenueLeg[] = [...closes, ...swaps.map((q) => q.venue), ...redeemLegs];
      // A sale with Phoenix closes may take several transactions (each order is ~640 bytes);
      // the exit is recorded in the last one.
      const built = await this.#compose(venues, ix, THESIS_COMPUTE_UNITS.exitPosition, owner, "exit", { take: takeKey, address: position, exit }, false, closes.length > 0);
      const swapped = (k: "outAmount" | "otherAmountThreshold") => Number(swaps.reduce((n, q) => n + BigInt(q.quote[k]), 0n)) / USD;
      // The sale pays the escrow back in full, in the same transaction. Phoenix legs close at
      // most 1% from the mid (DEFAULT_SLIPPAGE).
      const phx = { expected: phoenixWorth.usd, minimum: phoenixWorth.usd - 0.01 * phoenixWorth.notional };
      return {
        ...built,
        escrowUsd,
        expectedUsd: swapped("outAmount") + shareValue + escrowUsd + phx.expected,
        minimumUsd: swapped("otherAmountThreshold") + shareValue + escrowUsd + phx.minimum,
        /** Phoenix legs closed: once this lands, build `phoenix/cash-out` to move their cash back to USDC. */
        phoenixCashOut: closes.length > 0 || onPhoenix.length > 0,
      };
    };
    try {
      return await quoteExit(this.#router.route.maxAccounts);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "exit_too_large") throw error;
      // Try simpler Jupiter routes before giving up on an atomic exit.
      return quoteExit(20);
    }
  }

  /** Sales this service submitted whose positions have since settled and closed. */
  #settledExits(take: PublicKey, viewer: string, live: Set<string>) {
    return Object.entries(this.#state.exits?.[take.toBase58()] ?? {})
      .filter(([address, exit]) => exit.owner === viewer && !live.has(address))
      .map(([address, exit]) => ({
        address,
        side: exit.side ?? "back",
        exited: true,
        canExit: false,
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
      canBack: existing !== null && onChainLegs(legs, existing.take.legs).some((leg) => !this.#router.leftOut(leg)),
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
    if (mirror.demoAuthorKey && !sameLegs(take.legs, this.#mapLegs(app.legs))) return null;
    return { address, take };
  }

  async #prepareBack(takeId: string, owner: PublicKey, usd: number, payer: PublicKey, maxLegs?: number, side: "back" | "fade" = "back") {
    checkAmount(usd);
    await this.#checkFunds(owner, usd);
    const app = await this.#appTake(takeId);
    // Nobody but the author knows a posting take's id; still, nothing trades it before it's on-chain.
    if (app.status === "posting") throw new ApiError(409, "take_posting", "This take isn't on-chain yet.");
    const mirrorStarted = Date.now();
    const existing = maxLegs === undefined ? await this.#ensureOnChain(takeId, app) : await this.#existingBlinkTake(takeId, app);
    const mirrorMs = Date.now() - mirrorStarted;
    if (!existing || !("open" in existing.take.status) || existing.take.horizonEnd.toNumber() <= Math.floor(Date.now() / 1000)) {
      throw new ApiError(409, "take_closed", maxLegs === undefined ? undefined : "This take is not open on the fork.");
    }
    const { address, take } = existing;
    // Authors can't fade their own take. The program doesn't check it yet
    // (program changes are frozen while the fork is public), so this API does, for every client.
    if (side === "fade" && take.author.equals(owner)) throw new ApiError(409, "cannot_fade_own_take", FADE_OWN_TAKE);
    const [{ venue, included, excluded }, config] = await Promise.all([
      // The Blink (maxLegs) buys spot and yield legs only: Gemini legs are in the app.
      this.#router.venueLegs(onChainLegs(this.#mapLegs(app.legs), take.legs), owner, usd, payer, maxLegs, { side, paper: maxLegs === undefined }),
      this.#config(),
    ]);
    const mask = included.reduce((m, i) => m | (1 << i), 0);
    const id = randomPositionId();
    const stake = Math.round(usd * USD);
    const build = side === "back" ? backIx : fadeIx;
    const ix = await build(this.#program, {
      owner, payer, take: address, id, stake: new BN(stake), legsMask: mask,
    });
    const position = { take: address, address: positionAddress(address, owner, id) };
    this.#recordPhoenix(position.address, owner, venue);
    const fee = splitFee(BigInt(stake), config.params, { isAuthor: take.author.equals(owner) });
    const escrow = escrowShare(onChainLegs(this.#mapLegs(app.legs), take.legs).filter((l) => included.includes(l.index)), BigInt(stake));
    return { address, venue, included, excluded, ix, position, feeUsd: Number(fee.fee) / USD, escrowUsd: Number(escrow) / USD, mirrorMs };
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
    const closes = await this.#phoenix.strayCloseLegs(owner);
    const legs = closes.length ? closes : await this.#phoenix.sweepLegs(owner);
    if (!legs.length) return { done: true as const };
    const payer = this.#o.appPayer.publicKey;
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
    const expires = Date.now() + BUILD_TTL_MS;
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
    const built = await this.#fees.build(author, takes);
    const buildId = randomUUID();
    const expires = Date.now() + BUILD_TTL_MS;
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
  async #submitClaim(build: Build, txs: VersionedTransaction[]) {
    const signatures: string[] = [];
    try {
      await this.#store.withWallet(build.owner, async () => {
        for (const tx of txs) signatures.push(...(await this.#send([tx], [])));
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
  async buildPublish(takeId: string, author: string, usd: number) {
    const authorKey = parseKey(author);
    checkAmount(usd);
    if (this.#state.takes[takeId]) throw new ApiError(409, "already_on_chain");
    const app = await this.#appTake(takeId, { fresh: true });
    // Only the take's author can put it on-chain: with someone else's wallet, the take, its creator
    // fees and its score would be theirs (posting take ids aren't secret: a feed can show one).
    if (app.author_wallet !== author) throw new ApiError(403, "not_author", "Only the take's author can post it.");
    if (app.status === "live") throw new ApiError(409, "already_live");
    await this.#checkFunds(authorKey, usd);
    const [{ venue, included, excluded }, config] = await Promise.all([this.#router.venueLegs(this.#mapLegs(app.legs), authorKey, usd), this.#config()]);
    const { ix, address } = await this.#createIx(app, authorKey, usd, included);
    const position = { take: address, address: positionAddress(address, authorKey, 0n), publishTakeId: takeId };
    this.#recordPhoenix(position.address, authorKey, venue);
    const built = await this.#compose(venue, ix, THESIS_COMPUTE_UNITS.createTake, authorKey, "publish", position, true);
    return { ...built, take: address.toBase58(), stakeUsd: usd, feeUsd: Number(splitFee(BigInt(Math.round(usd * USD)), config.params, { isAuthor: true }).fee) / USD, included, excluded };
  }

  /**
   * Sends transactions this service built, after the user signed them. Each must match a built
   * message byte for byte, so the app fee payer only ever signs what it built.
   */
  async submit(buildId: string, signed: string[]) {
    const build = this.#builds.get(buildId);
    if (!build || build.expires < Date.now()) throw new ApiError(410, "build_expired", "Build again: transactions expire after about a minute");
    if (signed.length !== build.messages.length) throw new ApiError(400, "wrong_transaction_count");
    const txs = signed.map((b64, i) => {
      let tx: VersionedTransaction;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      } catch {
        throw new ApiError(400, "invalid_transaction", "The wallet returned an invalid transaction.");
      }
      const message = Buffer.from(tx.message.serialize());
      if (!message.equals(build.messages[i])) throw new ApiError(400, "transaction_changed");
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
    });
    this.#builds.delete(buildId);
    if (build.kind === "claim") return this.#submitClaim(build, txs);
    if (build.kind === "phoenix") {
      const signatures = await this.#store.withWallet(build.owner, () => this.#send(txs, build.market));
      this.#wallets.forgetActivity(build.owner);
      void this.#history.snapshot(build.owner).catch(() => {});
      return { signatures };
    }
    const cleanup = txs.splice(txs.length - (build.cleanup ?? 0));
    const positionKey = build.position.address.toBase58();
    this.#inFlight.add(positionKey);
    const signatures = await this.#store.withWallet(build.owner, async () => {
      if (build.expires < Date.now()) throw new ApiError(410, "build_expired", "Build again: transactions expire after about a minute");
      if (build.position.exit) {
        const held = await this.#program.account.position.fetchNullable(build.position.address, "confirmed");
        if (!held || held.exited) throw new ApiError(409, "already_exited", "This position has already been sold.");
      }
      this.#wallets.forgetActivity(build.owner);
      const confirmed = await this.#send(txs, build.market);
      this.#wallets.forgetActivity(build.owner);
      if (build.position.exit) {
        const byTake = ((this.#state.exits ??= {})[build.position.take.toBase58()] ??= {});
        byTake[build.position.address.toBase58()] = { ...build.position.exit, exitedAt: Math.floor(Date.now() / 1000) };
        this.#save();
      }
      this.#notePosition(build.position.take, build.position.address, build.owner, build.kind === "publish");
      // A sold position is no longer held (the next read of the take confirms it).
      if (build.position.exit) this.#positions.get(build.position.take.toBase58())?.owners.delete(positionKey);
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
      return confirmed;
    }).finally(() => this.#inFlight.delete(positionKey));
    for (const tx of cleanup) {
      await this.#send([tx], []).then(
        ([sig]) => this.#log(`cancelled abandoned trade tickets of ${build.owner} -> ${sig}`),
        (e) => this.#log(`cancelling abandoned trade tickets of ${build.owner} failed: ${e instanceof Error ? e.message.slice(0, 160) : e}`),
      );
    }
    void this.#history.snapshot(build.owner).catch(() => {});
    // The take goes live when the backend sees its takeCreated: deliver it now rather than
    // waiting for the relay, so the author's "posting…" clears as soon as this returns.
    if (build.position.publishTakeId) await this.#relay(signatures);
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
    const busy = new Set([...this.#inFlight, ...[...this.#builds.values()].map((b) => b.position.address.toBase58())]);
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
    return { tx, labels: [`cancel ${positions.length} abandoned trade ticket(s)`], bytes: tx.serialize().length, computeUnits, computeFrom: "estimated" as const };
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
    /** A sale that may take several transactions (Phoenix closes first, the exit last). */
    splitExit = false,
  ) {
    // The blockhash is fetched during composing: the build's lifetime counts from before that.
    const started = Date.now();
    const txs = await composeTransactions({
      payer: this.#o.appPayer.publicKey,
      legs: venue,
      receipt,
      receiptCu,
      lookupTables: this.#o.lookupTable ? [this.#o.lookupTable] : [],
      connection: this.#o.connection,
      proof: proof ? { program: this.#program, owner, position: position.address } : undefined,
    });
    if (kind === "exit" && txs.length !== 1 && !splitExit) throw new ApiError(422, "exit_too_large", "This position cannot be sold in one transaction.");
    // A trade the owner signs anyway also cancels their abandoned tickets. Not a sale: the app
    // expects exactly one transaction there.
    let cleanup = 0;
    if (kind !== "exit") {
      const stale = await this.#abandonedTickets(owner).catch(() => []);
      if (stale.length) {
        txs.push(await this.#cleanupTx(owner, stale));
        cleanup = 1;
      }
    }
    const buildId = randomUUID();
    const expires = Math.min(started + BUILD_TTL_MS, (position.exit?.horizonEnd ?? Infinity) * 1_000);
    this.#builds.set(buildId, {
      owner: owner.toBase58(),
      messages: txs.map((t) => Buffer.from(t.tx.message.serialize())),
      market: venue.flatMap((v) => v.marketAccounts),
      kind,
      expires,
      position,
      cleanup,
    });
    setTimeout(() => this.#builds.delete(buildId), Math.max(0, expires - Date.now())).unref();
    return {
      buildId,
      /** Unsigned v0 transactions, base64: sign each with the user's wallet, in order, then submit. */
      transactions: txs.map((t) => Buffer.from(t.tx.serialize()).toString("base64")),
      steps: txs.map((t) => ({ labels: t.labels, bytes: t.bytes, computeUnits: t.computeUnits })),
    };
  }

  async #send(txs: VersionedTransaction[], market: PublicKey[]): Promise<string[]> {
    const conn = this.#o.connection;
    const started = Date.now();
    await this.#o.fork.refreshMarkets(market);
    const times: Record<string, number> = { [`refresh ${market.length} accounts`]: Date.now() - started };
    const out: string[] = [];
    for (const [i, tx] of txs.entries()) {
      const sent = Date.now();
      const sig = await conn.sendTransaction(tx, { skipPreflight: false }).catch((e) => {
        throw new ApiError(502, "send_failed", errorText(e));
      });
      const confirming = Date.now();
      // Confirm against the transaction's own blockhash: once its last valid block passes, it can't
      // land any more. (A fresh blockhash would keep waiting ~60 s past that.)
      const own = tx.message.recentBlockhash;
      const lastValid = this.#blockhashes.get(own);
      const { blockhash, lastValidBlockHeight } = lastValid !== undefined ? { blockhash: own, lastValidBlockHeight: lastValid } : await conn.getLatestBlockhash("confirmed");
      const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) throw new ApiError(502, "transaction_failed", `${sig}: ${JSON.stringify(res.value.err)}`);
      times[`send ${i + 1}`] = confirming - sent;
      times[`confirm ${i + 1}`] = Date.now() - confirming;
      out.push(sig);
    }
    logSlow(this.#log, `send of ${txs.length} transaction(s)`, Date.now() - started, times);
    return out;
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

  async #createIx(app: AppTake, author: PublicKey, usd: number, included: number[]) {
    const legs = this.#mapLegs(app.legs);
    const id = this.#onChainId(app);
    const now = Math.floor(Date.now() / 1000);
    let horizon = Math.floor(Date.parse(app.settles_at) / 1000);
    // Demo takes whose date has passed (or is too close) get a fresh 30-day horizon on the fork.
    if (!(horizon > now + 2 * 3_600)) horizon = now + 30 * 86_400;
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
      if (take && (!m.demoAuthorKey || sameLegs(take.legs, this.#mapLegs(app.legs)))) return { address, take };
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
    const author = Keypair.generate();
    await this.#o.fork.addUsdc(author.publicKey, 100);
    let address: PublicKey;
    // The service signs a demo mirror itself, so a send that fails (usually a price that moved
    // past the quote's slippage) is rebuilt with fresh quotes and tried once more.
    for (let attempt = 1; ; attempt++) {
      try {
        const { venue, included } = await this.#router.venueLegs(this.#mapLegs(app.legs), author.publicKey, DEMO_AUTHOR_BUY_IN_USD);
        const created = await this.#createIx(app, author.publicKey, DEMO_AUTHOR_BUY_IN_USD, included);
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
      withBadges
        ? this.#o.connection.getMultipleAccountsInfo(BADGES.map((b) => badgeMintAddress(owner, BADGE_KIND_INDEX[b.kind], this.#program.programId)))
        : BADGES.map(() => null),
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
