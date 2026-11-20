// Which legs a trade can buy on the fork, and the venue instructions for them: Jupiter swaps
// through the best issuer, Jupiter Lend deposits for yield legs, and Phoenix for perp legs (long)
// and fades' shorts (api/phoenix.ts).
//
// Every Jupiter request goes through the fork API's budget (api/guard.ts, JupiterBudget) in the
// caller's lane: 1 for a build at tap time (the default), 2 for a prebuild, 3 for a route check.
// Lanes 2 and 3 fail fast with 503 busy rather than wait, and a quote that failed rather than
// found no route is never remembered as "no route".
//
// Wallets making the same trade share its routing for TEMPLATE_TTL_MS: the same legs, side and
// stake (to the base unit) get the same winners, the same stake split and so the same quotes, and
// each swap leg's swap-instructions answer is kept as a template (packages/venues/jupiter
// template.ts) that is retargeted to the next wallet. A second wallet's build of it makes no
// Jupiter call for its swap legs. Every leg still spends exactly its part of the stake, fills the
// wallet's own token account, and proof of trade checks it as before.
//
// The same trade at another stake scales a fresh routing instead of quoting again (template
// "scaled"): within TEMPLATE_TTL_MS of the quotes, when each swap leg's quote moved the price
// under 0.5% and its new part is within 0.1x-10x of the quoted one, with the shortfall bound
// scaling up (packages/venues/jupiter scale.ts, SCALE_LIMITS), each swap instruction is
// rewritten to spend exactly the new part and expect a proportional output, with the same
// slippage limit. So a trade sheet's builds at every
// chip or typed amount after the first cost no Jupiter call. A scaled leg that would fill worse
// than its slippage limit fails at preflight, not silently: the client builds again (Try again),
// and a wallet's repeat build of the same trade and stake after a scaled answer always quotes
// afresh, dropping the routings it scaled from, so it never gets the same failing answer twice.
//
// Routes outlive the quotes (template "route"): which pools a token's best route goes through
// rarely changes in minutes; its price does. So each swap leg's template is also kept per
// underlying (USDC in, the token out) for FORK_API_ROUTE_TTL_MS (default 10 minutes), with the
// token's Jupiter price when it was quoted. A later build of any take holding that underlying, at
// any stake within SCALE_LIMITS of a kept template, reads the tokens' prices now (Price v3, one
// call for the whole basket, shared by builds for PRICE_TTL_MS) and rewrites the template as
// scaling does: in_amount exactly the leg's part of the stake (proof of trade), quoted_out_amount
// in proportion and at the price now (scale.ts, priceFactor), the same 1% slippage and the same
// shortfall and impact limits. A build whose swap legs all come from kept routes makes no quote
// and no swap-instructions call: one price read, or none. A leg with no kept route, a route past
// its time, a price Jupiter didn't give, a price that moved over 3%, an issuer now paused or a
// multiplier that changed is quoted afresh, as before, and its new template replaces the old.
// Routes are refreshed only by builds that need them: nothing polls Jupiter for takes nobody
// views. The price a template is kept with is read after its build, in a prebuild's turn (it never
// holds up the build), and only when the template could be rewritten at all.
// A repriced estimate that's wrong fails at preflight (the fill is below the slippage limit or a
// pool needs other accounts), never mistrades; the retry rule above applies, so the wallet's next
// build of that trade and stake quotes afresh and replaces the kept routes. A swap the submit
// still finds refused for slippage after resetting the markets (api/send.ts) has its underlying's
// kept routes, and the shared and scalable routings holding it, dropped (`dropBuys`): the next
// build of it by any wallet, the client's rebuild or a split trade's retry, quotes it afresh.
//
// Sales: routes back to USDC are kept the same way, per token (the token in, USDC out), for
// FORK_API_ROUTE_TTL_MS (`sellSwaps`). A sale's swap of a token sold in that time by any wallet
// rewrites the kept template: in_amount exactly the tokens to sell, quoted_out_amount in
// proportion and at the token's price now (the price now over the price then: the USDC out moves
// with the price), the same 1% slippage, shortfall and 3% move limits, scaling down to 0.01x and
// from quotes up to 2% impact (SELL_SCALE_LIMITS: a partial sale is often a small share of the
// kept size, and a smaller sale only does better than the quote). So a sale whose tokens all have
// kept sell routes costs one price read, or none. Any other token is quoted afresh (a quote and a
// swap-instructions call) and its template kept, with a price read in the sale build's own turn: a
// read left for later, in a prebuild's turn, is refused while trades queue (that's how the first
// version of this kept nothing on the fork). A sale whose send fails drops its tokens' kept sell
// routes (`dropSells`, from the service), so selling again quotes afresh. (Sales used to drop them
// when the same wallet asked for the same sale within 20 s of a repriced answer, as trades do; on
// the fork that fired on a Sell-tab prebuild refused by the budget, whose other tokens had already
// repriced, followed by the tap's own build, and every token was quoted afresh at the tap.) Every
// token a sale quotes afresh although it was sold lately says why in the log, at most once a
// minute per token. After a back lands, the tokens it bought with no sell route kept are quoted
// back to USDC once (`seedSells`, in the route checks' lane, waiting its turn behind taps and
// prebuilds until all are seeded), so the first sale is repriced too.
import type { PublicKey } from "@solana/web3.js";
import { PRICEABLE_MIN_POOLED_USD, bestIssuer, effectiveMultiplier, issuerPool, type BestIssuerResult, type ReadMints } from "@thesis/venues/bank";
import { ineligible, otherSide, type GeminiContract } from "@thesis/venues/gemini";
import {
  buyInstructions,
  fromTemplate,
  jupiterBuy,
  jupiterLendDeposit,
  jupiterPrices,
  jupiterQuote,
  jupiterSwapInstructions,
  quoteFn,
  scaleSwap,
  scaleTemplate,
  splitStake,
  swapTemplate,
  unscalable,
  PriceCache,
  PRICE_TTL_MS,
  SCALE_LIMITS,
  SELL_SCALE_LIMITS,
  TEMPLATE_OWNER,
  USDC_MINT,
  type CachedPrice,
  type JupSwapInstructions,
  type JupiterAccess,
  type JupiterBuy,
  type SwapTemplate,
  type VenueLeg,
} from "@thesis/venues/jupiter";
import { ApiError, MIN_STAKE_USD, USD, type ServiceOpts } from "./common.ts";
import { LANE, jupiterBudget, newUse, type JupiterBudget, type JupiterUse, type Lane } from "./guard.ts";
import { isPaper, type MappedLeg } from "./legs.ts";
import { cardIdHex } from "@thesis/venues/collector-crypt";
import { BelowOneLot } from "@thesis/venues/phoenix";
import type { PhoenixDesk, PhoenixLeg } from "./phoenix.ts";

const MAX_ACCOUNTS = 30;
/**
 * Routing limits: only issuers the settler can price from their own token (enough pooled
 * liquidity), and no fill that moves the price more than 1%. A thinner token would be a bad fill
 * the user can't sell, and its entry price would wait for the stock market to open.
 */
const ROUTE = { maxAccounts: MAX_ACCOUNTS, minPooledUsd: PRICEABLE_MIN_POOLED_USD, maxPriceImpactPct: 1 };
/** How long a build reuses the last best issuer of an underlying instead of quoting every issuer. */
const WINNER_TTL_MS = 2 * 60_000;
const NO_ROUTE = "no liquid tokenized version to buy right now";
/**
 * A quote that failed rather than found no route (bestIssuer notes it as `no quote: <error>`): a
 * rate limit, a timeout, a server error or no connection. Jupiter's own "no route" answers
 * (COULD_NOT_FIND_ANY_ROUTE, HTTP 400/404, empty route) don't match.
 */
export const TRANSIENT_QUOTE = /429|rate.?limit|timeout|timed out|abort|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket|network|HTTP 5\d\d/i;
/** How long a leg with no Jupiter route is skipped before it's quoted again. */
const NO_ROUTE_TTL_MS = 10 * 60_000;
/** How long a trade's routing (winners, stake split, swap templates) is shared with other wallets. */
export const TEMPLATE_TTL_MS = 20_000;
/** How many fresh routings of one trade (at different stakes) are kept to scale from. */
const MAX_ROOTS = 4;
/** How long a swap leg's route (its template) is kept to reprice, unless FORK_API_ROUTE_TTL_MS says otherwise. */
export const ROUTE_TTL_MS = 10 * 60_000;
/** How many templates (at different sizes) are kept per underlying. */
const MAX_ROUTES = 4;
/** A template is kept with a price read at most PRICE_TTL_MS before its quote or this long after. */
const ROUTE_PRICE_AFTER_MS = 20_000;
/**
 * How long a back's sell seeds (Router.seedSells) keep waiting for room in the budget. They wait
 * in the lowest lane, so taps and prebuilds go first; on the fork's budget (50 a minute, bursts of
 * 3) a 4-leg back's eight calls are done within about 10–15 s when nothing else is trading.
 */
export const SEED_DEADLINE_MS = 120_000;
/** A seed's quote whose swap-instructions call the budget turned away is reused this long. */
const SEED_QUOTE_REUSE_MS = 10_000;
/** When the price for a template couldn't be read at once (the budget kept it for trades), it's tried once more this much later. */
const ROUTE_PRICE_RETRY_MS = 5_000;

/**
 * How long routes are kept (ms): FORK_API_ROUTE_TTL_MS, else ROUTE_TTL_MS. 0 keeps none (every
 * build past TEMPLATE_TTL_MS quotes afresh, as before). A bad value fails clearly.
 */
export function routeTtlFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.FORK_API_ROUTE_TTL_MS?.trim();
  if (!raw) return ROUTE_TTL_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 3_600_000) throw new Error(`FORK_API_ROUTE_TTL_MS must be a whole number of milliseconds (0–3600000), not "${raw}"`);
  return n;
}

export type Route = typeof ROUTE & { dexes?: string[] };
/**
 * A venue leg tagged with the take leg it buys and the owner's account it fills (proof of trade),
 * and how it buys it (a split trade's sweep redeems Jupiter Lend shares instead of swapping them).
 * `key`: a swap leg's underlying, whose reused routing `dropBuys` drops when its swap was refused.
 */
export type TradeLeg = VenueLeg & { output: { leg: number; account: PublicKey }; how: "swap" | "lend" | "phoenix"; phoenix?: PhoenixLeg; key?: string };
type Winner = NonNullable<Awaited<ReturnType<typeof bestIssuer>>["winner"]>;
type Excluded = { index: number; name: string; reason: string };
/** How a traded leg is bought: the winning issuer's quote, a Lend deposit, or Phoenix. */
type Way = Winner | "lend" | "phoenix";
/**
 * A swap leg's route kept to reprice (see the header): the winner and its template as quoted at
 * `at`, the token's Jupiter price then, and its scaled-UI multiplier then.
 */
type KeptRoute = { at: number; winner: Winner; template: SwapTemplate; price: number; multiplier: number };
/** A token's sell route kept to reprice (see "Sales" in the header): its template (the token in, USDC out) as quoted at `at`, the token's price then, and its multiplier then. */
type KeptSell = { at: number; template: SwapTemplate; price: number; multiplier: number };
/** One token a sale swaps back to USDC: exactly `amount` in, its quote (repriced or fresh) and the wallet's instructions. */
export type SellSwap = { mint: string; amount: bigint; quote: { inAmount: string; outAmount: string; otherAmountThreshold: string }; venue: JupiterBuy; repriced: boolean };
const isQuote = (w: Way | null | undefined): w is Winner => typeof w === "object" && w !== null;
/** A USDC-in quote as Jupiter returned it (with its mints and route), as buyInstructions reads it. */
const routeQuote = (q: Winner["quote"]) => q as Winner["quote"] & { outputMint: string; inputMint?: string };

/**
 * A trade's routing, shared by every wallet making the same trade for TEMPLATE_TTL_MS: which
 * traded legs routed and how, and each swap leg's swap-instructions answer for the wallet that
 * routed it (`owner`), with its template for everyone else.
 */
type Plan = {
  kept: Set<number>;
  excluded: Excluded[];
  ways: Map<number, Way>;
  owner: string;
  /** Each swap leg's answer for `owner` (null: none, every wallet builds from the template) and its template. */
  swaps: Map<number, { res: Promise<JupSwapInstructions> | null; template: Promise<SwapTemplate | null> }>;
  /** False when a leg was left out because its quote failed: that's this build's bad luck, not to share. */
  shareable: boolean;
  /** Swap legs rewritten rather than quoted: scaled from another stake, or repriced from a kept route. */
  rewritten: number;
  /** Swap legs repriced from kept routes (#plan). */
  routed: number;
};
/** A trade's routing as #plans holds it: in flight or done, and when it was quoted. */
type PlanEntry = { at: number; done: boolean; plan: Promise<Plan> };
/** A fresh routing that builds at other stakes may scale from: its stake and when it was quoted. */
type Root = { at: number; stake: bigint; entry: PlanEntry };
/**
 * Which side a trade takes (a fade holds the other side of a prediction leg), and whether paper
 * legs can be in it. `lane`: the Jupiter lane its calls use (default 1, a build at tap time; 2 for
 * a prebuild). `use`: counts the build's Jupiter calls into this (default: a fresh one, returned
 * as `jupiter`); pass one to read the counts when the build fails too.
 */
export type TradeKind = { side?: "back" | "fade"; paper?: boolean; lane?: Lane; use?: JupiterUse };

/** Whether a best-issuer answer with no winner came from failed quotes rather than "no route". */
const transient = (r: BestIssuerResult | null) => !r || (!r.winner && r.skipped.some((s) => TRANSIENT_QUOTE.test(s.reason)));

const busy = (what: string) => {
  const e = new ApiError(503, "busy", `Couldn't quote ${what} right now. Try again in a moment.`);
  e.headers = { "retry-after": "5" };
  return e;
};

const NO_PHOENIX = "Phoenix isn't connected on this fork";
const APP_ONLY = "Gemini legs are in the Thesis app only";
const PHOENIX_APP_ONLY = "Phoenix legs are in the Thesis app only";
const NO_LIVE_PRICE = "Gemini's prices can't be read right now; try again in a moment";
const CARD_APP_ONLY = "Card legs are in the Thesis app only";

/**
 * The part of a stake escrowed for paper legs (prediction and card legs): their weight over the
 * included legs' weight, rounded down. Must match the program's `escrow_share`: the receipt
 * escrows exactly this, and proof of trade wants the rest traded.
 */
/**
 * 422 `stake_too_small`: a Phoenix leg's share of `usd` is under one lot of its market (a $20
 * back of "crypto sucks" puts $5 on Bitcoin, whose smallest order is about $6). Says the stake
 * that clears it, with 3% for the price moving, and sends it as `minUsd`.
 */
export function stakeBelowLot(e: BelowOneLot, usd: number): ApiError {
  const minUsd = Math.max(MIN_STAKE_USD, Math.ceil((usd * e.lotUsd * 1.03) / e.notionalUsd));
  const what = e.leg ? `${e.leg}'s` : "one pick's";
  const err = new ApiError(422, "stake_too_small", `This take needs at least $${minUsd}: ${what} share is under the smallest order Phoenix takes (about $${e.lotUsd.toFixed(2)}).`);
  err.body = { minUsd, leg: e.leg ?? null, lotUsd: Number(e.lotUsd.toFixed(2)) };
  return err;
}

export function escrowShare(legs: { spec: { weightBps: number }; how: MappedLeg["how"] }[], stake: bigint): bigint {
  const total = legs.reduce((n, l) => n + BigInt(l.spec.weightBps), 0n);
  const paper = legs.filter((l) => isPaper(l.how)).reduce((n, l) => n + BigInt(l.spec.weightBps), 0n);
  return total === 0n ? 0n : (stake * paper) / total;
}

export class Router {
  #o: ServiceOpts;
  /** Phoenix legs (set by the service when Phoenix is configured). */
  phoenix: PhoenixDesk | null = null;
  /** Routing limits for every quote (ROUTE plus the venues to route around). */
  readonly route: Route;
  /** Underlying key → until when (ms) it's known to have no route, so it isn't quoted every build. */
  #noRoute = new Map<string, number>();
  /**
   * Underlying key → the issuer that last won best-issuer routing, and when. Within WINNER_TTL_MS a
   * build quotes just that issuer instead of all of them (Jupiter's free plan allows 10 requests
   * per 10 s, and every request saved is time the user doesn't wait); within NO_ROUTE_TTL_MS the
   * underlying counts as routable without a fresh quote.
   */
  #winners = new Map<string, { mint: string; at: number }>();

  /** Every Jupiter request's turn (the process's budget unless a test passes its own). */
  readonly budget: JupiterBudget;
  /** Live mint reads for best-issuer routing (default: bestIssuer's, cached a minute; null: none, in tests). */
  #readMints: ReadMints | null | undefined;

  /** How long routes are kept to reprice (ms; 0: none). */
  readonly routeTtlMs: number;
  /** Underlying key → its kept routes (templates at different sizes, newest first; see the header). */
  #routes = new Map<string, KeptRoute[]>();
  /** Token prices for repricing, shared by builds for PRICE_TTL_MS. */
  readonly prices: PriceCache;
  /** Price reads for templates still running (routesLearned waits for them). */
  #learning = new Set<Promise<void>>();

  /** How long a back's sell seeds keep waiting for the budget (SEED_DEADLINE_MS unless a test passes its own). */
  readonly #seedDeadlineMs: number;
  /** Tests: how long a refused seed waits, instead of the refusal's retry-after. */
  readonly #seedPaceMs: number | undefined;

  /** `routeTtlMs`: how long routes are kept (default: routeTtlFromEnv). `now`: the price cache's clock. */
  constructor(o: ServiceOpts, deps: { budget?: JupiterBudget; readMints?: ReadMints | null; routeTtlMs?: number; prices?: PriceCache; seedDeadlineMs?: number; seedPaceMs?: number } = {}) {
    this.#seedDeadlineMs = deps.seedDeadlineMs ?? SEED_DEADLINE_MS;
    this.#seedPaceMs = deps.seedPaceMs;
    this.#o = o;
    this.route = { ...ROUTE, dexes: o.dexes };
    this.budget = deps.budget ?? jupiterBudget;
    this.#readMints = deps.readMints;
    this.routeTtlMs = deps.routeTtlMs ?? routeTtlFromEnv();
    this.prices = deps.prices ?? new PriceCache(PRICE_TTL_MS);
  }

  /**
   * Jupiter for `lane`, counted in `use`: the key, the budget's fetch and how long a 429 may be
   * waited out. For Jupiter calls outside the router too (sales, sweeps): pass it to jupiterBuy,
   * jupiterLendRedeem, or use `quoteExactIn`.
   */
  jupiter(lane: Lane = 1, use?: JupiterUse): Required<JupiterAccess> & {
    quoteExactIn(inputMint: string, outputMint: string, amount: bigint, o: { maxAccounts: number; slippageBps?: number; dexes?: string[] }): ReturnType<typeof jupiterQuote>;
  } {
    const access = { apiKey: this.#o.jupiterApiKey, fetchFn: this.budget.fetchFn(lane, use), max429WaitMs: this.budget.max429WaitMs(lane) };
    return { ...access, quoteExactIn: (inputMint, outputMint, amount, o) => jupiterQuote({ ...access, inputMint, outputMint, amount, ...o }) };
  }

  /** Best-issuer options for a quote in `lane`: the bank, the routing limits and the budgeted quote. */
  #best(lane: Lane, use: JupiterUse, onlyMints?: string[]) {
    return { state: this.#o.bank(), ...this.route, onlyMints, quote: quoteFn(this.jupiter(lane, use)), readMints: this.#readMints };
  }

  /** The budget and how much the router's caches saved, for the timings log. */
  jupiterStats() {
    return {
      budget: this.budget.snapshot(),
      winners: this.#winners.size,
      noRoute: this.#noRoute.size,
      templates: { size: this.#plans.size, ...this.#templateStats },
      routes: { size: this.#routes.size, ...this.#routeStats, prices: this.prices.stats },
      sells: { size: this.#sells.size, ...this.#sellStats },
    };
  }

  /** Trade key → its routing (in flight or done) and when it started (see Plan). */
  #plans = new Map<string, PlanEntry>();
  /**
   * Trade key without the stake → the fresh routings of that trade (newest first, at most
   * MAX_ROOTS, each at its own stake) that builds at other stakes scale from (#scaled).
   */
  #roots = new Map<string, Root[]>();
  /** Wallet and trade key → when that wallet was last answered from a rewritten routing (a repeat quotes afresh). */
  #scaledFor = new Map<string, number>();
  /**
   * Builds that reused a plan (`hits`), waited for one in flight (`waits`), scaled one made at
   * another stake (`scaled`), repriced every swap leg from kept routes (`routes`), routed their
   * own (`misses`, some legs may be repriced); swap legs built from templates.
   */
  #templateStats = { hits: 0, waits: 0, scaled: 0, routes: 0, misses: 0, templatedLegs: 0 };
  /** Swap legs repriced from kept routes, templates kept, and templates not kept for want of a price. */
  #routeStats = { repriced: 0, kept: 0, unpriced: 0 };

  /** A contract as currently known: the latest live read, else the asset bank's sweep, else the mapping's copy. */
  contract(c: GeminiContract): GeminiContract {
    const swept = this.#o.bank().venues.gemini?.contracts?.[c.instrumentSymbol] ?? c;
    return this.#o.gemini?.latest(c, swept) ?? swept;
  }

  /** Reads the prediction legs' events live (no-op without a live source). */
  async refreshMarkets(legs: MappedLeg[]): Promise<void> {
    const contracts = legs.flatMap((l) => (l.prediction ? [l.prediction.contract] : []));
    if (contracts.length) await this.#o.gemini?.refresh(contracts);
  }

  /**
   * Why a leg can't be bought on the fork right now, or null if it can. Checks only local state:
   * the leg's mapping, the asset bank, and legs that recently had no Jupiter route.
   */
  leftOut(l: MappedLeg, now = Date.now(), side: "back" | "fade" = "back"): string | null {
    // A fade shorts stock and crypto legs on Phoenix: no token needed, just a market.
    // (A card leg can't be faded: #shortOut says so.)
    if (side === "fade" && l.how !== "paper") return this.#shortOut(l);
    if (l.blocked) return l.blocked;
    if (l.how === "perp") return this.phoenix ? null : NO_PHOENIX;
    if (l.how === "paper") {
      // Paper-filled at Gemini's prices: the side held needs a two-sided market, an hour out.
      const p = l.prediction!;
      return ineligible(this.contract(p.contract), side === "back" ? p.side : otherSide(p.side), now);
    }
    if (l.how === "card") return this.#cardOut(l);
    if (l.how === "lend") return this.#o.jupiterApiKey ? null : "Jupiter Lend needs JUPITER_API_KEY";
    if ((this.#noRoute.get(l.key!) ?? 0) > now) return NO_ROUTE;
    try {
      // No issuer worth quoting (none tokenized, or all paused or recently unroutable).
      return issuerPool(l.key!, this.#o.bank(), this.route).pool.length ? null : NO_ROUTE;
    } catch {
      return NO_ROUTE; // not in the bank at all
    }
  }

  /**
   * Why a card leg can't go in, or null if it can: only when the asset bank has read the card and
   * Collector Crypt gives it no insured value (redeemed, burned, unpriced). A card the bank hasn't
   * read yet goes in; the settler waits for the bank's reading to sign its entry.
   */
  #cardOut(l: MappedLeg): string | null {
    const held = this.#o.bank().venues.cards?.picked?.[cardIdHex(l.card!.cardId)];
    return held && !(held.insuredValueUsd && held.insuredValueUsd > 0) ? "Collector Crypt has no value for this card right now" : null;
  }

  /** Why a fade can't short this leg, or null if it can. */
  #shortOut(l: MappedLeg): string | null {
    if ("none" in l.spec.fadeVia) return "this leg can't be faded";
    if (!l.short) return l.blocked ?? `Phoenix lists no market to short ${l.name}`;
    if (!this.phoenix) return NO_PHOENIX;
    if (!l.short.tradeable) return `Phoenix's ${l.short.symbol} market is too thin right now`;
    return null;
  }

  /**
   * Quotes swap legs whose routability isn't known yet (once per TTL), so the receipt, and the
   * trade sheet built from it, leaves out the same legs a build will. One check per underlying
   * at a time: receipts opened together wait for the same quotes instead of each quoting.
   * Route checks are Jupiter's lane 3: refused when the budget runs low, and then (as when a
   * quote fails) nothing is remembered, so the next receipt checks again.
   */
  async checkRoutes(legs: MappedLeg[], use: JupiterUse = newUse(3)) {
    const now = Date.now();
    const unknown = legs.filter((l) => l.how === "swap" && !this.leftOut(l, now) && !((this.#winners.get(l.key!)?.at ?? 0) > now - NO_ROUTE_TTL_MS));
    if (!unknown.length) return;
    await Promise.all(
      [...new Set(unknown.map((l) => l.key!))].map((key) => {
        const pending = this.#checking.get(key);
        if (pending) return pending;
        const check = bestIssuer(key, MIN_STAKE_USD, this.#best(3, use))
          .catch(() => null)
          .then((best) => {
            if (best?.winner) this.#winners.set(key, { mint: best.winner.mint, at: now });
            else if (!transient(best)) this.#noRoute.set(key, now + NO_ROUTE_TTL_MS);
          })
          .finally(() => this.#checking.delete(key));
        this.#checking.set(key, check);
        return check;
      }),
    );
  }
  /** Underlying key → its route check in flight. */
  #checking = new Map<string, Promise<void>>();

  /**
   * The venue legs for a trade of `usd`, split by weight across the legs that can be bought.
   * Jupiter's free plan allows about one request per second, so this keeps requests down:
   * legs known to be unbuyable are dropped before quoting; every leg is quoted at once; swap
   * instructions are fetched only once the sizes are final; and if a leg has no route, the
   * others are re-sized by quoting just the issuer that already won.
   *
   * Quotes that fail (Jupiter busy, slow, down, or the budget refusing) are never remembered as
   * "no route". At tap time (lane 1) such a leg is left out of this build, as before; a prebuild
   * (lane 2) answers 503 busy instead, so a prebuilt trade never quietly lacks a leg.
   */
  async venueLegs(legs: MappedLeg[], user: PublicKey, usd: number, payer = this.#o.appPayer.publicKey, maxLegs?: number, kind: TradeKind = {}) {
    const now = Date.now();
    const side = kind.side ?? "back";
    const use = kind.use ?? newUse(kind.lane ?? 1);
    const lane = (use.lane = kind.lane ?? use.lane);
    const excluded: Excluded[] = [];
    let usable: MappedLeg[] = [];
    // A prediction leg goes in on its live market (the settler signs the entry from a live read too).
    const live = this.#o.gemini;
    if (live && kind.paper !== false) await this.refreshMarkets(legs);
    for (const l of legs) {
      let why = this.leftOut(l, now, side);
      if (!why && l.how === "paper" && live && kind.paper !== false && !live.live(l.prediction!.contract)) why = NO_LIVE_PRICE;
      if (!why && l.how === "paper" && kind.paper === false) why = APP_ONLY;
      if (!why && l.how === "card" && kind.paper === false) why = CARD_APP_ONLY;
      // The Blink buys spot and yield legs only (and its buyers' wallets aren't Phoenix traders).
      if (!why && kind.paper === false && (l.how === "perp" || side === "fade")) why = PHOENIX_APP_ONLY;
      if (why) excluded.push({ index: l.index, name: l.name, reason: why });
      else usable.push(l);
    }
    if (maxLegs !== undefined && usable.length > maxLegs) {
      usable.sort((a, b) => b.spec.weightBps - a.spec.weightBps || a.index - b.index);
      for (const l of usable.splice(maxLegs)) excluded.push({ index: l.index, name: l.name, reason: "Open Thesis for the full basket" });
    }
    const sorted = () => excluded.sort((a, b) => a.index - b.index);
    if (!usable.length) throw new ApiError(422, "nothing_tradable", "None of this take's legs can be bought on the fork right now");

    const stake = BigInt(Math.round(usd * USD));
    // Prediction and card legs aren't traded: the receipt escrows their share. The rest is split by weight.
    const traded = () => usable.filter((l) => !isPaper(l.how));
    const includedIdx = () => usable.map((l) => l.index).sort((a, b) => a - b);
    const done = (venue: TradeLeg[]) => ({ venue, included: includedIdx(), excluded: sorted(), jupiter: use });
    if (!traded().length) return done([]);
    // A back's perp legs, and every traded leg of a fade (its shorts), trade on Phoenix.
    const onPhoenix = (l: MappedLeg) => side === "fade" || l.how === "perp";

    // The same legs, side and stake route the same way: reuse another wallet's routing while
    // it's fresh (or wait for it if it's in flight), as long as every quote spends exactly its
    // part of the stake; otherwise route now.
    const shape = JSON.stringify([side, usable.map((l) => [l.index, l.how, l.key, l.spec.weightBps, l.spec.leverage, onPhoenix(l)])]);
    const key = JSON.stringify([String(stake), shape]);
    const apply = (plan: Plan) => {
      const legsNow = usable.filter((l) => isPaper(l.how) || plan.kept.has(l.index));
      const swapLegs = legsNow.filter((l) => !isPaper(l.how));
      const parts = swapLegs.length ? splitStake(stake - escrowShare(legsNow, stake), swapLegs.map((l) => l.spec.weightBps)) : [];
      const exact = swapLegs.every((l, j) => {
        const w = plan.ways.get(l.index);
        return w !== undefined && (!isQuote(w) || BigInt(w.quote.inAmount) === parts[j]);
      });
      return exact ? { legsNow, swapLegs, parts } : null;
    };
    let plan: Plan | null = null;
    let sized: ReturnType<typeof apply> = null;
    /** This trade's routing at this stake, if another build made it moments ago (or is making it). */
    const cachedPlan = () => {
      const cached = this.#plans.get(key);
      return cached && cached.at > now - TEMPLATE_TTL_MS ? cached : null;
    };
    // A wallet asking again for a trade and stake it was just answered from a rewritten routing
    // (scaled or repriced: a retry after a refused submit) quotes afresh instead: no rewritten
    // routing, no kept route, and the routings it scaled from go.
    const mine = `${user.toBase58()} ${key}`;
    const repeat = (this.#scaledFor.get(mine) ?? 0) > now - TEMPLATE_TTL_MS;
    if (repeat) {
      this.#scaledFor.delete(mine);
      this.#roots.delete(shape);
    }
    const reuse = async (cached: PlanEntry) => {
      use.template = cached.done ? "hit" : "wait";
      plan = await cached.plan.catch(() => null);
      sized = plan?.shareable && !(repeat && plan.rewritten) ? apply(plan) : null;
      if (!sized) plan = null;
    };
    // Checked without awaiting first, so builds started together find each other's routing.
    const cached = cachedPlan();
    if (cached) await reuse(cached);
    // Another stake of the same trade, quoted moments ago: scale its routing (see the header).
    const roots = plan || repeat ? [] : this.#nearRoots(shape, stake, now);
    if (roots.length) {
      plan = await this.#scaled(roots, usable, stake);
      sized = plan ? apply(plan) : null;
      if (sized) {
        use.template = "scaled";
        this.#sweep(now);
      } else {
        plan = null;
        // While this build waited, another may have started routing this stake: wait for that one.
        const meanwhile = cachedPlan();
        if (meanwhile) await reuse(meanwhile);
      }
    }
    if (!plan) {
      use.template = "miss";
      const routing = this.#plan(usable, stake, side, lane, use, now, user, repeat);
      const entry: PlanEntry = { at: now, done: false, plan: routing };
      this.#sweep(now);
      this.#plans.set(key, entry);
      const root: Root = { at: now, stake, entry };
      this.#roots.set(shape, [root, ...(this.#roots.get(shape) ?? []).filter((r) => r.at > now - TEMPLATE_TTL_MS)].slice(0, MAX_ROOTS));
      const forget = () => {
        if (this.#plans.get(key) === entry) this.#plans.delete(key);
        const roots = this.#roots.get(shape)?.filter((r) => r !== root);
        if (roots?.length) this.#roots.set(shape, roots);
        else if (roots) this.#roots.delete(shape);
      };
      routing.then(
        (p) => {
          entry.done = true;
          if (!p.shareable) forget();
        },
        forget,
      );
      plan = await routing;
      // Every swap leg repriced from a kept route: no quote at all.
      if (plan.routed && plan.routed === plan.ways.size - [...plan.ways.values()].filter((w) => !isQuote(w)).length) use.template = "route";
      sized = apply(plan);
    }
    if (!sized) throw new ApiError(502, "routing_failed", "A route disappeared while sizing the trade. Try again.");
    // Answered (even in part) from a rewritten routing: this wallet's repeat quotes afresh.
    if (plan.rewritten) this.#scaledFor.set(mine, now);
    this.#templateStats[({ hit: "hits", wait: "waits", scaled: "scaled", route: "routes", miss: "misses" } as const)[use.template ?? "miss"]]++;
    usable = sized.legsNow;
    excluded.push(...plan.excluded);
    const { swapLegs, parts } = sized;
    if (!swapLegs.length) return done([]);

    // Phoenix legs each get their own child subaccount (registered now if needed).
    const phoenixLegs = swapLegs.filter(onPhoenix);
    const subs = phoenixLegs.length ? await this.phoenix!.prepare(user, phoenixLegs.length) : [];
    const subOf = new Map(phoenixLegs.map((l, k) => [l.index, subs[k]]));
    const shared = { plan, mine: use.template === "miss" || use.template === "route" };
    const venue = (await Promise.all(
      swapLegs.map((l, j) => this.#legFor(l, parts[j], shared.plan.ways.get(l.index)!, user, payer, side, subOf.get(l.index), lane, use, shared)),
    ).catch((e: unknown) => {
      if (e instanceof BelowOneLot) throw stakeBelowLot(e, usd);
      throw use.refused ?? e;
    })).flat();
    return done(venue);
  }

  /** Drops plans (and routings to scale from) past their time now and then, so the maps hold only trades in progress. */
  #sweep(now: number) {
    const old = now - TEMPLATE_TTL_MS;
    if (this.#plans.size >= 100) for (const [k, v] of this.#plans) if (v.done && v.at <= old) this.#plans.delete(k);
    if (this.#roots.size >= 100) {
      for (const [k, v] of this.#roots) {
        const fresh = v.filter((r) => !r.entry.done || r.at > old);
        if (fresh.length) this.#roots.set(k, fresh);
        else this.#roots.delete(k);
      }
    }
    if (this.#scaledFor.size >= 1_000) for (const [k, at] of this.#scaledFor) if (at <= old) this.#scaledFor.delete(k);
  }

  /**
   * The fresh routings of a trade (`shape`) that a build at `stake` might scale from: quoted
   * within TEMPLATE_TTL_MS at a stake within SCALE_LIMITS' ratio, done ones first, newest first.
   */
  #nearRoots(shape: string, stake: bigint, now: number): Root[] {
    const near = (r: { stake: bigint }) => {
      const ratio = Number(stake) / Number(r.stake);
      return ratio >= SCALE_LIMITS.minRatio && ratio <= SCALE_LIMITS.maxRatio;
    };
    const roots = (this.#roots.get(shape) ?? []).filter((r) => r.at > now - TEMPLATE_TTL_MS && near(r));
    return roots.sort((x, y) => Number(y.entry.done) - Number(x.entry.done) || y.at - x.at);
  }

  /**
   * A routing for `stake` scaled from one of `roots` (#nearRoots; see the header), or null when
   * none can be: a swap leg's quote or answer that can't be scaled (too much price impact, too
   * far from the quoted amount, a layout scale.ts doesn't read, an answer that's no template).
   * Waits for a routing in flight. The scaled routing is no wallet's own, so every wallet builds
   * its swap legs from the templates: no Jupiter call.
   */
  async #scaled(roots: Root[], usable: MappedLeg[], stake: bigint): Promise<Plan | null> {
    for (const r of roots) {
      const p = await r.entry.plan.catch(() => null);
      if (!p?.shareable) continue;
      const legsNow = usable.filter((l) => isPaper(l.how) || p.kept.has(l.index));
      const swapLegs = legsNow.filter((l) => !isPaper(l.how));
      if (!swapLegs.length) continue;
      const parts = splitStake(stake - escrowShare(legsNow, stake), swapLegs.map((l) => l.spec.weightBps));
      const ways = new Map<number, Way>();
      const swaps: Plan["swaps"] = new Map();
      for (const [j, l] of swapLegs.entries()) {
        const w = p.ways.get(l.index);
        if (w === undefined) break;
        if (!isQuote(w)) {
          ways.set(l.index, w);
          continue;
        }
        const template = await p.swaps.get(l.index)?.template;
        const scaled = template ? scaleTemplate(template, parts[j]) : null;
        if (!scaled) break;
        // The template's quote is the winner's own (a JupQuote), scaled.
        const quote = scaled.quote as unknown as Winner["quote"];
        ways.set(l.index, { ...w, quote, outAmountRaw: quote.outAmount, units: (w.units * Number(parts[j])) / Number(w.quote.inAmount) });
        swaps.set(l.index, { res: null, template: Promise.resolve(scaled) });
      }
      if (ways.size !== swapLegs.length) continue;
      return { kept: p.kept, excluded: p.excluded, ways, owner: TEMPLATE_OWNER.toBase58(), swaps, shareable: true, rewritten: swaps.size, routed: 0 };
    }
    return null;
  }

  /**
   * Routes a trade's traded legs (see venueLegs): reprices swap legs whose route is kept (one
   * price read for all of them; none when `fresh`), quotes the other swap legs at once (just the
   * issuer that last won, when known), drops legs with no route and re-sizes the rest, then starts
   * each quoted swap leg's swap-instructions call for `user`, whose answers become the plan's
   * templates (and kept routes).
   */
  async #plan(usable: MappedLeg[], stake: bigint, side: "back" | "fade", lane: Lane, use: JupiterUse, now: number, user: PublicKey, fresh = false): Promise<Plan> {
    const traded = () => usable.filter((l) => !isPaper(l.how));
    const tradedStake = () => stake - escrowShare(usable, stake);
    const onPhoenix = (l: MappedLeg) => side === "fade" || l.how === "perp";
    const excluded: Excluded[] = [];
    /** Legs whose quotes failed rather than found no route (by take leg index). */
    const failed = new Set<number>();
    // Kept routes: the tokens' prices now, in one read (with the other legs' last winners, so their
    // templates can be kept without another read), when any swap leg has a route kept.
    const swapKeys = traded().filter((l) => !onPhoenix(l) && l.how === "swap").map((l) => l.key!);
    // A retry after a rewritten answer: its legs' kept routes (at every size) go, and this build's
    // quotes replace them.
    if (fresh) for (const k of swapKeys) this.#routes.delete(k);
    const keptMints = swapKeys.flatMap((k) => this.#keptRoutes(k, now).map((r) => r.winner.mint));
    const prices = keptMints.length
      ? await this.#readPrices([...new Set([...keptMints, ...swapKeys.flatMap((k) => this.#winners.get(k)?.mint ?? [])])], lane, use)
      : new Map<string, CachedPrice>();
    /** Swap legs repriced from kept routes (by take leg index): the winner and the rewritten template. */
    const routed = new Map<number, { way: Winner; template: SwapTemplate }>();
    const quoteAll = (ls: MappedLeg[], parts: bigint[], only?: Way[]) =>
      Promise.all(
        ls.map(async (l, j): Promise<Way | null> => {
          if (onPhoenix(l)) return "phoenix";
          if (l.how === "lend") return "lend";
          const repriced = this.#keptRoutes(l.key!, now).length ? this.#reprice(l.key!, parts[j], prices, now) : null;
          if (repriced && "way" in repriced) {
            routed.set(l.index, repriced);
            return repriced.way;
          }
          if (repriced) this.#notRepriced("buy", l.key!, repriced.why);
          routed.delete(l.index);
          const usdPart = Number(parts[j]) / USD;
          const quote = (onlyMints?: string[]) =>
            bestIssuer(l.key!, usdPart, this.#best(lane, use, onlyMints))
              .catch(() => null)
              .then((r) => {
                if (transient(r)) failed.add(l.index);
                return r?.winner ?? null;
              });
          const prev = only?.[j];
          if (isQuote(prev)) return quote([prev.mint]);
          const known = this.#winners.get(l.key!);
          if (known && known.at > now - WINNER_TTL_MS) {
            const w = await quote([known.mint]);
            if (w) {
              use.winnerHits++;
              return w;
            }
          }
          use.winnerMisses++;
          failed.delete(l.index);
          const w = await quote();
          if (w) this.#winners.set(l.key!, { mint: w.mint, at: Date.now() });
          return w;
        }),
      );
    /** The budget refused a call, or (before the tap) a quote failed: the build answers busy. */
    const busyOut = (ls: MappedLeg[], ways: unknown[]) => {
      if (use.refused) throw use.refused;
      const lost = ls.filter((l, j) => ways[j] === null && failed.has(l.index));
      if (lane !== 1 && lost.length) throw busy(lost.map((l) => l.name).join(", "));
    };

    let swapLegs = traded();
    let parts = splitStake(tradedStake(), swapLegs.map((l) => l.spec.weightBps));
    let ways = await quoteAll(swapLegs, parts);
    busyOut(swapLegs, ways);
    if (ways.some((w) => w === null)) {
      for (const [j, l] of swapLegs.entries()) {
        if (ways[j] !== null) continue;
        if (!failed.has(l.index)) this.#noRoute.set(l.key!, now + NO_ROUTE_TTL_MS);
        excluded.push({ index: l.index, name: l.name, reason: NO_ROUTE });
      }
      const kept = swapLegs.map((l, j) => [l, ways[j]] as const).filter(([, w]) => w !== null);
      const keptIdx = new Set(kept.map(([l]) => l.index));
      usable = usable.filter((l) => isPaper(l.how) || keptIdx.has(l.index));
      if (!usable.length) throw new ApiError(422, "nothing_tradable", "None of this take's legs can be bought on the fork right now");
      swapLegs = traded();
      if (swapLegs.length) {
        // Dropping a leg changes the escrowed share too, so the traded part is split again.
        parts = splitStake(tradedStake(), swapLegs.map((l) => l.spec.weightBps));
        ways = await quoteAll(swapLegs, parts, kept.map(([, w]) => w!));
        busyOut(swapLegs, ways);
        if (ways.some((w) => w === null)) throw new ApiError(502, "routing_failed", "A route disappeared while sizing the trade. Try again.");
      } else {
        ways = [];
      }
    }

    // Swap instructions for the routing wallet start now, alongside the rest of its build; legs
    // repriced from kept routes need none.
    const swaps: Plan["swaps"] = new Map();
    const quoted: { key: string; way: Winner; template: Promise<SwapTemplate | null> }[] = [];
    let repriced = 0;
    for (const [j, l] of swapLegs.entries()) {
      const w = ways[j];
      if (!isQuote(w)) continue;
      const r = routed.get(l.index);
      if (r && r.way === w) {
        repriced++;
        swaps.set(l.index, { res: null, template: Promise.resolve(r.template) });
        continue;
      }
      const res = jupiterSwapInstructions({ ...this.jupiter(lane, use), quote: w.quote, user });
      res.catch(() => {}); // awaited by the leg; a build that fails earlier leaves it unawaited
      const template = res.then((r) => swapTemplate({ res: r, quote: routeQuote(w.quote) }, user)).catch(() => null);
      swaps.set(l.index, { res, template });
      quoted.push({ key: l.key!, way: w, template });
    }
    this.#routeStats.repriced += repriced;
    if (quoted.length) this.#keep(quoted, Date.now());
    return {
      kept: new Set(swapLegs.map((l) => l.index)),
      excluded,
      ways: new Map(swapLegs.map((l, j) => [l.index, ways[j]!])),
      owner: user.toBase58(),
      swaps,
      shareable: !excluded.some((e) => failed.has(e.index)),
      rewritten: repriced,
      routed: repriced,
    };
  }

  /** Prices for repricing (the shared cache, else one read in `lane`, counted in `use`); missing when the read fails or is refused. */
  async #readPrices(mints: string[], lane: Lane, use: JupiterUse): Promise<Map<string, CachedPrice>> {
    // Its own count, so a refused read leaves the build free to quote instead of answering busy.
    const mine = newUse(lane);
    const prices = await this.prices.get(mints, (ms) => jupiterPrices(ms, this.jupiter(lane, mine)));
    use.calls += mine.calls;
    use.prices += mine.prices;
    use.waitedMs += mine.waitedMs;
    use.rateLimited += mine.rateLimited;
    return prices;
  }

  /** The routes kept for underlying `key` and still in time, newest first. */
  #keptRoutes(key: string, now: number): KeptRoute[] {
    if (this.routeTtlMs <= 0) return [];
    return (this.#routes.get(key) ?? []).filter((r) => r.at > now - this.routeTtlMs);
  }

  /** The token's scaled-UI multiplier as the asset bank knows it (1 without one). */
  #multiplier(mint: string, atMs: number): number {
    return effectiveMultiplier(this.#o.bank().tokens[mint]?.scaledUi ?? null, Math.floor(atMs / 1000));
  }

  /**
   * Underlying `key` bought with exactly `part` from a kept route, at the token's price now (see
   * the header), or why no kept route can be: none in time, no price now, the issuer no longer
   * eligible, its multiplier changed, or scale.ts refuses (size, impact, shortfall, a price that
   * moved too far). The kept template nearest in size is tried first; the reason given is its.
   */
  #reprice(key: string, part: bigint, prices: Map<string, CachedPrice>, now: number): { way: Winner; template: SwapTemplate } | { why: string } {
    const size = (r: KeptRoute) => Math.abs(Math.log(Number(part) / Number(r.template.quote.inAmount)));
    const kept = this.#keptRoutes(key, now);
    let why: string | null = null;
    for (const r of kept.sort((x, y) => size(x) - size(y))) {
      const price = prices.get(r.winner.mint);
      if (!price) {
        why ??= "no price now (Jupiter gave none, or the read was refused or failed)";
        continue;
      }
      try {
        if (!issuerPool(key, this.#o.bank(), { ...this.route, onlyMints: [r.winner.mint] }).pool.length) {
          why ??= `${r.winner.symbol} isn't eligible to route now`;
          continue;
        }
      } catch {
        why ??= "it isn't in the asset bank any more";
        continue;
      }
      if (this.#multiplier(r.winner.mint, now) !== r.multiplier) {
        why ??= "its multiplier changed since the quote";
        continue;
      }
      const factor = r.price / price.usd;
      const refused = unscalable(r.template, part, SCALE_LIMITS, factor);
      if (refused) {
        why ??= refused;
        continue;
      }
      const template = scaleSwap(r.template, part, SCALE_LIMITS, factor);
      // The template's quote is the winner's own (a JupQuote), rewritten.
      const quote = template.quote as unknown as Winner["quote"];
      const units = (r.winner.units * Number(quote.outAmount)) / Number(r.winner.quote.outAmount);
      return { way: { ...r.winner, quote, outAmountRaw: quote.outAmount, units }, template };
    }
    return { why: `${why ?? "no kept route in time"} (${kept.length} kept)` };
  }

  /**
   * Keeps freshly quoted swap legs' templates as routes (see the header), each with the token's
   * price when it was quoted: from the cache when it was read moments before, else read once the
   * build's own calls are done, in a prebuild's turn (and once more ROUTE_PRICE_RETRY_MS later if
   * the budget kept it for trades). A template scale.ts couldn't rewrite isn't kept (no read).
   */
  #keep(quoted: { key: string; way: Winner; template: Promise<SwapTemplate | null> }[], quotedAt: number) {
    if (this.routeTtlMs <= 0) return;
    const job = (async () => {
      const ready = (await Promise.all(quoted.map(async (q) => ({ ...q, template: await q.template }))))
        .filter((q): q is typeof q & { template: SwapTemplate } => q.template !== null && !unscalable(q.template, BigInt(q.template.quote.inAmount)));
      if (!ready.length) return;
      const prices = await this.#pricesAt([...new Set(ready.map((q) => q.way.mint))], quotedAt);
      for (const q of ready) {
        const p = prices.get(q.way.mint);
        if (!p) {
          this.#routeStats.unpriced++;
          continue;
        }
        const route: KeptRoute = { at: quotedAt, winner: q.way, template: q.template, price: p.usd, multiplier: this.#multiplier(q.way.mint, quotedAt) };
        // Replaces a kept template of about the same size; keeps MAX_ROUTES sizes, in time, newest first.
        const near = (r: KeptRoute) => Math.abs(Math.log(Number(q.template.quote.inAmount) / Number(r.template.quote.inAmount))) < Math.log(1.5);
        const others = this.#keptRoutes(q.key, Date.now()).filter((r) => r.winner.mint === q.way.mint && !near(r));
        this.#routes.set(q.key, [route, ...others].slice(0, MAX_ROUTES));
        this.#routeStats.kept++;
      }
      if (this.#routes.size >= 500) for (const k of [...this.#routes.keys()]) if (!this.#keptRoutes(k, Date.now()).length) this.#routes.delete(k);
    })().catch(() => {});
    this.#learning.add(job);
    void job.finally(() => this.#learning.delete(job));
  }

  /**
   * The tokens' Jupiter prices when something was quoted at `quotedAt`: from the cache when read
   * at most PRICE_TTL_MS before or ROUTE_PRICE_AFTER_MS after, else read now in a prebuild's turn
   * (and once more ROUTE_PRICE_RETRY_MS later if the budget kept it for trades). Mints with no
   * price in time are missing.
   */
  async #pricesAt(mints: string[], quotedAt: number): Promise<Map<string, CachedPrice>> {
    const inTime = (p: CachedPrice | null | undefined): p is CachedPrice => !!p && p.at >= quotedAt - PRICE_TTL_MS && p.at <= quotedAt + ROUTE_PRICE_AFTER_MS;
    const read = () => this.prices.get(mints, (ms) => jupiterPrices(ms, this.jupiter(2)));
    let prices = await read();
    if (!mints.every((m) => inTime(prices.get(m)))) {
      await new Promise((resolve) => setTimeout(resolve, ROUTE_PRICE_RETRY_MS));
      prices = await read();
    }
    return new Map(mints.flatMap((m) => {
      const p = prices.get(m);
      return inTime(p) ? [[m, p] as const] : [];
    }));
  }

  /** Token → its kept sell routes (templates at different sizes, newest first; see "Sales" in the header). */
  #sells = new Map<string, KeptSell[]>();
  /**
   * Sell swaps repriced from kept routes and quoted afresh; sell templates kept and not kept (any
   * reason); routes seeded after backs, and seeds the budget refused; tokens whose kept routes were
   * dropped after a failed sale.
   */
  #sellStats = { repriced: 0, quoted: 0, kept: 0, unkept: 0, seeded: 0, seedsRefused: 0, dropped: 0 };

  /** The sell routes kept for `mint` and still in time, newest first. */
  #keptSells(mint: string, now: number): KeptSell[] {
    if (this.routeTtlMs <= 0) return [];
    return (this.#sells.get(mint) ?? []).filter((r) => r.at > now - this.routeTtlMs);
  }

  /**
   * A sale's swaps back to USDC (see "Sales" in the header): each token's exact `amount` in, from
   * a kept sell route repriced at the token's price now (one batched price read for all of them,
   * none when the shared cache has it), else a fresh quote and swap-instructions call whose
   * template is kept. `fresh`: quote every one afresh (and drop their kept routes). A token quoted
   * afresh says why it wasn't repriced (logged, once a minute per token). Throws 422
   * `no_exit_route` when a token has no route, 503 `busy` when its quote failed or the budget
   * refused a call.
   */
  async sellSwaps(
    sells: { mint: string; amount: bigint; label: string }[],
    user: PublicKey,
    payer: PublicKey,
    o: { lane?: Lane; use?: JupiterUse; maxAccounts?: number; fresh?: boolean } = {},
  ): Promise<SellSwap[]> {
    const use = o.use ?? newUse(o.lane ?? 1);
    const lane = (use.lane = o.lane ?? use.lane);
    const now = Date.now();
    const maxAccounts = o.maxAccounts ?? this.route.maxAccounts;
    // Simpler routes asked for (a swap didn't fit): every token afresh, its kept routes replaced.
    if (o.fresh) for (const s of sells) this.#sells.delete(s.mint);
    // With any kept route: every token's price now, in one read in the build's own turn. It
    // reprices the kept routes, and the fresh quotes' routes are kept with it (cached).
    const mints = [...new Set(sells.map((s) => s.mint))];
    const anyKept = mints.some((m) => this.#keptSells(m, now).length);
    const pricesNow = anyKept ? this.#readPrices(mints, lane, use) : null;
    const jupiter = this.jupiter(lane, use);
    const quoted: { mint: string; template: SwapTemplate | null; at: number }[] = [];
    const out = await Promise.all(sells.map(async (s): Promise<SellSwap> => {
      const repriced = o.fresh
        ? { why: "simpler routes were asked for (a swap didn't fit)" }
        : pricesNow && this.#keptSells(s.mint, now).length
        ? this.#repriceSell(s.mint, s.amount, await pricesNow, now)
        : { why: `no sell route kept from the last ${Math.round(this.routeTtlMs / 60_000)} min (none quoted or seeded, or dropped after a failed sale)` };
      if ("template" in repriced) {
        this.#sellStats.repriced++;
        use.templatedLegs++;
        return { mint: s.mint, amount: s.amount, quote: repriced.template.quote, venue: fromTemplate(repriced.template, user, payer, s.label), repriced: true };
      }
      if (this.routeTtlMs > 0) this.#notRepriced("sell", s.mint, repriced.why);
      const { quote, error } = await jupiter.quoteExactIn(s.mint, USDC_MINT, s.amount, { ...this.route, maxAccounts });
      if (use.refused) throw use.refused;
      if (!quote && error && TRANSIENT_QUOTE.test(error)) throw busy(s.label);
      if (!quote || quote.inputMint !== s.mint || quote.outputMint !== USDC_MINT || quote.inAmount !== s.amount.toString()) {
        throw new ApiError(422, "no_exit_route", "No route to sell every token in this position.");
      }
      const at = Date.now();
      const res = await jupiterSwapInstructions({ ...jupiter, quote, user }).catch((e: unknown) => {
        throw use.refused ?? e;
      });
      const q = quote as typeof quote & { outputMint: string; inputMint: string };
      this.#sellStats.quoted++;
      quoted.push({ mint: s.mint, template: swapTemplate({ res, quote: q }, user), at });
      return { mint: s.mint, amount: s.amount, quote: q, venue: buyInstructions(res, q, user, payer, s.label), repriced: false };
    }));
    // The fresh routes are kept now, with prices read in this build's turn (from the read above
    // when it's recent, else one more read): a read left for later, in a prebuild's turn, is
    // refused while trades queue, and the route wouldn't be kept.
    await this.#keepSells(quoted, lane, use);
    return out;
  }

  /**
   * Drops the kept sell routes of `mints` (a sale of them failed to send: its repriced estimate may
   * be what failed), so the next sale of each quotes afresh and keeps that route instead.
   */
  dropSells(mints: string[], why: string) {
    const gone = [...new Set(mints)].filter((m) => this.#sells.delete(m));
    if (!gone.length) return;
    this.#sellStats.dropped += gone.length;
    this.#o.log?.(`sell routes dropped for ${gone.map((m) => this.#o.bank().tokens[m]?.symbol ?? m).join(", ")}: ${why}`);
  }

  /**
   * Drops what a buy of underlyings `keys` would reuse (a trade's swap of them was refused for
   * slippage: the reused estimate may be what failed): their kept routes, and the shared and
   * scalable routings of every trade holding one of them. So the next build of each, the client's
   * rebuild or a split trade's retry, quotes it afresh and keeps that route instead.
   */
  dropBuys(keys: string[], why: string) {
    const drop = new Set(keys);
    if (!drop.size) return;
    const holds = (shape: string) => {
      try {
        return (JSON.parse(shape)[1] as unknown[][]).some((l) => drop.has(l[2] as string));
      } catch {
        return false;
      }
    };
    let gone = 0;
    for (const k of drop) if (this.#routes.delete(k)) gone++;
    // A plan's key is [stake, shape]; a root's is the shape (see venueLegs).
    for (const k of this.#plans.keys()) {
      if (holds(JSON.parse(k)[1]) && this.#plans.delete(k)) gone++;
    }
    for (const k of this.#roots.keys()) {
      if (holds(k) && this.#roots.delete(k)) gone++;
    }
    if (gone) this.#o.log?.(`buy routes dropped for ${[...drop].join(", ")}: ${why}`);
  }

  /** Tokens whose sell route was seeded lately, or found to have none (see seedSells): when, so each is quoted at most once per route lifetime. */
  #seeded = new Map<string, number>();
  /** Tokens being seeded now, or waiting for a seed's retry. */
  #seeding = new Set<string>();

  /**
   * Seeds sell routes after a back lands (see "Sales" in the header): for each token it bought
   * (`amount`: about what it bought) with no sell route kept, one quote back to USDC and its swap
   * instructions, kept like a sale's, so the first sale of it is repriced too. In the route
   * checks' lane (3), so taps and prebuilds always go first: a call the budget turns away waits as
   * long as the budget says (its retry-after) and goes again, token after token, until every one is
   * seeded or SEED_DEADLINE_MS has passed. (It used to retry three times, 15, 30 and 60 s later:
   * with the fork's small burst (FORK_API_JUPITER_BURST=3) each try seeded one token, so a 4-leg
   * back's first sale still quoted some afresh, 8–14 s at the tap.) Each token is kept as soon as a
   * price for it is read, in batches before each wait; a quote whose swap-instructions call was
   * turned away is reused while SEED_QUOTE_REUSE_MS young. At most once per token per
   * FORK_API_ROUTE_TTL_MS once it's done (kept, or no route). Never throws.
   */
  async seedSells(items: { mint: string; amount: bigint }[], user: PublicKey): Promise<void> {
    if (this.routeTtlMs <= 0) return;
    const now = Date.now();
    const todo = [...new Map(items.filter((i) => i.amount > 0n).map((i) => [i.mint, i])).values()]
      .filter((i) => !this.#keptSells(i.mint, now).length && !((this.#seeded.get(i.mint) ?? 0) > now - this.routeTtlMs) && !this.#seeding.has(i.mint));
    if (!todo.length) return;
    for (const i of todo) this.#seeding.add(i.mint);
    if (this.#seeded.size >= 1_000) for (const [k, at] of this.#seeded) if (at <= now - this.routeTtlMs) this.#seeded.delete(k);
    const deadline = now + this.#seedDeadlineMs;
    const job = (async () => {
      let pending: { mint: string; template: SwapTemplate | null; at: number }[] = [];
      let left = todo.length;
      // Keeps what's quoted so far, with one price read (waited for like the quotes).
      const keep = async () => {
        if (!pending.length) return;
        const batch = pending;
        pending = [];
        const mints = [...new Set(batch.map((q) => q.mint))];
        let prices = new Map<string, CachedPrice>();
        for (;;) {
          const use = newUse(LANE.routeCheck);
          prices = await this.prices.get(mints, (ms) => jupiterPrices(ms, this.jupiter(LANE.routeCheck, use))).catch(() => new Map<string, CachedPrice>());
          if (!use.refused || Date.now() >= deadline || Date.now() - batch[0].at > ROUTE_PRICE_AFTER_MS / 2) break;
          await this.#seedPause(use.refused);
        }
        await this.#keepSells(batch, LANE.routeCheck, newUse(LANE.routeCheck), prices);
      };
      for (const i of todo) {
        let quote: Awaited<ReturnType<typeof jupiterQuote>>["quote"] = null;
        let quotedAt = 0;
        for (;;) {
          // A sale of it may have quoted and kept it meanwhile.
          if (this.#keptSells(i.mint, Date.now()).length) break;
          const use = newUse(LANE.routeCheck);
          const jupiter = this.jupiter(LANE.routeCheck, use);
          if (!quote || Date.now() - quotedAt > SEED_QUOTE_REUSE_MS) {
            quote = (await jupiter.quoteExactIn(i.mint, USDC_MINT, i.amount, this.route).catch(() => ({ quote: null }))).quote;
            quotedAt = Date.now();
          }
          const res = quote && quote.inputMint === i.mint && quote.outputMint === USDC_MINT && !use.refused
            ? await jupiterSwapInstructions({ ...jupiter, quote, user }).catch(() => null)
            : null;
          if (use.refused) {
            // The budget turned it away: keep what's done, wait as long as it says, go again.
            if (Date.now() >= deadline) {
              this.#sellStats.seedsRefused += left;
              await keep();
              return;
            }
            await keep();
            await this.#seedPause(use.refused);
            continue;
          }
          this.#seeded.set(i.mint, Date.now());
          if (quote && res) {
            pending.push({ mint: i.mint, template: swapTemplate({ res, quote: quote as typeof quote & { outputMint: string; inputMint: string } }, user), at: quotedAt });
            this.#sellStats.seeded++;
          }
          break;
        }
        left--;
      }
      await keep();
    })().catch(() => {}).finally(() => {
      for (const i of todo) this.#seeding.delete(i.mint);
    });
    this.#learning.add(job);
    void job.finally(() => this.#learning.delete(job));
    await job;
  }

  /** Waits as long as a refusal's retry-after says (or the test's pace), within 0.5–15 s. */
  #seedPause(refused: ApiError): Promise<void> {
    const ms = this.#seedPaceMs ?? Math.min(15_000, Math.max(500, Number(refused.headers?.["retry-after"] ?? 1) * 1000));
    return new Promise((resolve) => setTimeout(resolve, ms).unref());
  }

  /**
   * `mint` sold for exactly `amount` from a kept sell route at the token's price now, or why none
   * can be: none in time, no price now, the token paused, its multiplier changed, or scale.ts
   * refuses (size, impact, shortfall, a price that moved over 3%; SELL_SCALE_LIMITS). The nearest
   * size is tried first; the reason given is the nearest one's.
   */
  #repriceSell(mint: string, amount: bigint, prices: Map<string, CachedPrice>, now: number): { template: SwapTemplate } | { why: string } {
    const kept = this.#keptSells(mint, now);
    if (!kept.length) return { why: "its kept sell route expired" };
    const price = prices.get(mint);
    if (!price) return { why: "no price now (Jupiter gave none, or the read was refused or failed)" };
    if (this.#o.bank().tokens[mint]?.paused) return { why: "the token is paused" };
    const size = (r: KeptSell) => Math.abs(Math.log(Number(amount) / Number(r.template.quote.inAmount)));
    let why: string | null = null;
    for (const r of kept.sort((x, y) => size(x) - size(y))) {
      if (this.#multiplier(mint, now) !== r.multiplier) {
        why ??= "its multiplier changed since the quote";
        continue;
      }
      // Selling, the USDC out moves with the token's price: the price now over the price then.
      const factor = price.usd / r.price;
      const refused = unscalable(r.template, amount, SELL_SCALE_LIMITS, factor);
      if (!refused) return { template: scaleSwap(r.template, amount, SELL_SCALE_LIMITS, factor) };
      why ??= refused;
    }
    return { why: `${why} (${kept.length} kept)` };
  }

  /**
   * Keeps freshly quoted sells' templates (as #keep does a buy's), each with the token's price when
   * it was quoted: one read for all of them in `lane` (counted in `use`), from the shared cache when
   * it was read moments before. A template that couldn't serve another wallet or be rewritten, or
   * whose price isn't from its moment, isn't kept (each reason is logged once a minute).
   */
  async #keepSells(quoted: { mint: string; template: SwapTemplate | null; at: number }[], lane: Lane, use: JupiterUse, read?: Map<string, CachedPrice>) {
    if (this.routeTtlMs <= 0 || !quoted.length) return;
    const ready: { mint: string; template: SwapTemplate; at: number }[] = [];
    for (const q of quoted) {
      const why = q.template ? unscalable(q.template, BigInt(q.template.quote.inAmount), SELL_SCALE_LIMITS) : "Jupiter's answer can't serve other wallets";
      if (why) this.#unkept(q.mint, why);
      else ready.push(q as { mint: string; template: SwapTemplate; at: number });
    }
    if (!ready.length) return;
    const prices = read ?? await this.#readPrices([...new Set(ready.map((q) => q.mint))], lane, use).catch(() => new Map<string, CachedPrice>());
    for (const { mint, template, at } of ready) {
      const p = prices.get(mint);
      if (!p || p.at < at - PRICE_TTL_MS || p.at > at + ROUTE_PRICE_AFTER_MS) {
        this.#unkept(mint, "no price from when it was quoted");
        continue;
      }
      const route: KeptSell = { at, template, price: p.usd, multiplier: this.#multiplier(mint, at) };
      const near = (r: KeptSell) => Math.abs(Math.log(Number(template.quote.inAmount) / Number(r.template.quote.inAmount))) < Math.log(1.5);
      this.#sells.set(mint, [route, ...this.#keptSells(mint, Date.now()).filter((r) => !near(r))].slice(0, MAX_ROUTES));
      this.#sellStats.kept++;
    }
    if (this.#sells.size >= 500) for (const k of [...this.#sells.keys()]) if (!this.#keptSells(k, Date.now()).length) this.#sells.delete(k);
  }

  /** Token → when a sell route of it last went unkept (the log says why at most once a minute per token). */
  #unkeptLogged = new Map<string, number>();
  #unkept(mint: string, why: string) {
    this.#sellStats.unkept++;
    const now = Date.now();
    if ((this.#unkeptLogged.get(mint) ?? 0) > now - 60_000) return;
    this.#unkeptLogged.set(mint, now);
    if (this.#unkeptLogged.size >= 1_000) for (const [k, at] of this.#unkeptLogged) if (at <= now - 60_000) this.#unkeptLogged.delete(k);
    this.#o.log?.(`sell route for ${this.#o.bank().tokens[mint]?.symbol ?? mint} not kept: ${why}`);
  }

  /** Side, token and kind of reason → when a reprice miss of it was last logged (at most once a minute each). */
  #missLogged = new Map<string, number>();
  /**
   * Logs why a token sold (or bought) lately was quoted afresh rather than repriced from its kept
   * route, at most once a minute per token, side and kind of reason (its words without the
   * numbers), so the next slow build says why directly.
   */
  #notRepriced(side: "buy" | "sell", mint: string, why: string) {
    const now = Date.now();
    const key = `${side} ${mint} ${why.replace(/[\d.]+/g, "#")}`;
    if ((this.#missLogged.get(key) ?? 0) > now - 60_000) return;
    this.#missLogged.set(key, now);
    if (this.#missLogged.size >= 1_000) for (const [k, at] of this.#missLogged) if (at <= now - 60_000) this.#missLogged.delete(k);
    this.#o.log?.(`${side} route for ${this.#o.bank().tokens[mint]?.symbol ?? mint} not repriced: ${why}`);
  }

  /** Resolves once the routes being kept have their prices (or gave up): for tests and benches. */
  async routesLearned(): Promise<void> {
    while (this.#learning.size) await Promise.all([...this.#learning]);
  }

  /**
   * The venue instructions for one leg, given how it's bought. Phoenix legs trade in child `sub`,
   * sized at the market's mid: collateral is the leg's part of the stake, the position that times
   * leverage.
   */
  async #legFor(l: MappedLeg, part: bigint, w: Way, user: PublicKey, payer: PublicKey, side: "back" | "fade", sub: number | undefined, lane: Lane, use: JupiterUse, shared?: { plan: Plan; mine: boolean }): Promise<TradeLeg[]> {
    if (w === "phoenix") {
      const market = side === "fade" ? l.short! : l.phoenix!;
      const price = await this.phoenix!.venue.mid(market.symbol).catch(() => null);
      if (!price) throw new ApiError(502, "routing_failed", `Phoenix has no price for ${market.symbol} right now. Try again in a moment.`);
      const legs = await this.phoenix!.venue.openLeg({
        owner: user,
        payer,
        sub: sub!,
        symbol: market.symbol,
        side: side === "fade" ? "short" : "long",
        collateral: part,
        // A fade shorts at the leg's own leverage: the program scores it that way.
        leverage: l.spec.leverage,
        price,
        label: `${l.name} (Phoenix ${market.symbol}${l.spec.leverage > 1 ? ` ${l.spec.leverage}x` : ""})`,
      }).catch((e: unknown) => {
        if (e instanceof BelowOneLot) e.leg = l.name;
        throw e;
      });
      return legs.map((v) => ({ ...v, output: { leg: l.index, account: v.outputAccount! }, how: "phoenix" as const, phoenix: { leg: l.index, sub: sub!, symbol: market.symbol } }));
    }
    const jupiter = this.jupiter(lane, use);
    const leg = w === "lend"
      ? await jupiterLendDeposit({ ...jupiter, user, payer, amount: part, label: `${l.name} (Jupiter Lend)`, apiKey: jupiter.apiKey! })
      : await this.#swap(l, w, user, payer, jupiter, use, shared);
    // Proof of trade: the receipt checks this account grew (the take leg it buys, by index).
    if (!leg.outputAccount) throw new ApiError(502, "routing_failed", `Jupiter's route for ${l.name} doesn't deliver to your wallet's token account.`);
    if (w === "lend") return [{ ...leg, output: { leg: l.index, account: leg.outputAccount }, how: "lend" }];
    return [{ ...leg, output: { leg: l.index, account: leg.outputAccount }, how: "swap", key: l.key ?? undefined }];
  }

  /**
   * A swap leg's instructions for `user`: from the plan's answer when the plan routed for this
   * wallet, from its template for any other wallet or a leg rewritten from a template (no Jupiter
   * call), else a fresh call. The build that made the plan (`mine`) gets its own call's errors; a
   * later build whose shared answer failed makes its own call instead.
   */
  async #swap(l: MappedLeg, w: Winner, user: PublicKey, payer: PublicKey, jupiter: JupiterAccess, use: JupiterUse, shared?: { plan: Plan; mine: boolean }) {
    const label = `${l.name} (${w.symbol})`;
    const swap = shared?.plan.swaps.get(l.index);
    const own = shared?.plan.owner === user.toBase58() && swap?.res != null;
    if (swap?.res && own) {
      const res = shared!.mine ? await swap.res : await swap.res.catch(() => null);
      if (res) return buyInstructions(res, routeQuote(w.quote), user, payer, label);
    }
    const template = swap && !own ? await swap.template : null;
    if (template) {
      use.templatedLegs++;
      this.#templateStats.templatedLegs++;
      return fromTemplate(template, user, payer, label);
    }
    return jupiterBuy({ ...jupiter, quote: w.quote, user, payer, label });
  }

  /**
   * A split trade's retry (api/split.ts): the venue legs for the take legs in `remaining` only,
   * each sized as the first build sized it (the same included legs, stake and weights), with fresh
   * quotes. Phoenix legs trade in the child the first build recorded for them. `legs` are the
   * legs the receipt opens. Throws 422 `retry_unavailable` when a leg can't be bought now. Its
   * Jupiter calls are lane 1 unless `o.lane` says otherwise.
   */
  async rebuild(
    legs: MappedLeg[],
    user: PublicKey,
    usd: number,
    side: "back" | "fade",
    remaining: Set<number>,
    recorded: PhoenixLeg[],
    payer = this.#o.appPayer.publicKey,
    o: { lane?: Lane; use?: JupiterUse } = {},
  ): Promise<TradeLeg[]> {
    const use = o.use ?? newUse(o.lane ?? 1);
    const lane = (use.lane = o.lane ?? use.lane);
    const now = Date.now();
    const stake = BigInt(Math.round(usd * USD));
    const traded = legs.filter((l) => !isPaper(l.how));
    const parts = splitStake(stake - escrowShare(legs, stake), traded.map((l) => l.spec.weightBps));
    const unavailable = (l: MappedLeg, why: string) => new ApiError(422, "retry_unavailable", `${l.name} can't be bought again right now (${why}).`);
    return (await Promise.all(traded.map(async (l, j): Promise<TradeLeg[]> => {
      if (!remaining.has(l.index)) return [];
      const why = this.leftOut(l, now, side);
      // A remembered "no route" may come from a failed quote: a swap leg is quoted afresh below.
      if (why && !(why === NO_ROUTE && l.how === "swap" && side === "back")) throw unavailable(l, why);
      if (side === "fade" || l.how === "perp") {
        const sub = recorded.find((r) => r.leg === l.index)?.sub;
        if (sub === undefined) throw unavailable(l, "its Phoenix account isn't known");
        return this.#legFor(l, parts[j], "phoenix", user, payer, side, sub, lane, use);
      }
      if (l.how === "lend") return this.#legFor(l, parts[j], "lend", user, payer, side, undefined, lane, use);
      const usdPart = Number(parts[j]) / USD;
      // Only a definite "no route" ends the retry: a quote that failed (Jupiter busy, slow, down)
      // answers 503 busy and leaves the retry for another try.
      let pooled = false;
      try {
        pooled = issuerPool(l.key!, this.#o.bank(), this.route).pool.length > 0;
      } catch {
        // not in the bank at all
      }
      if (!pooled) throw unavailable(l, NO_ROUTE);
      let failed = false;
      const quote = async (onlyMints?: string[]) => {
        const r = await bestIssuer(l.key!, usdPart, this.#best(lane, use, onlyMints)).catch(() => null);
        if (transient(r)) failed = true;
        return r?.winner ?? null;
      };
      const known = this.#winners.get(l.key!);
      const w = (known && known.at > now - WINNER_TTL_MS ? await quote([known.mint]) : null) ?? await quote();
      if (use.refused) throw use.refused;
      if (!w && failed) throw busy(l.name);
      if (!w) throw unavailable(l, NO_ROUTE);
      return this.#legFor(l, parts[j], w, user, payer, side, undefined, lane, use);
    }))).flat();
  }
}
