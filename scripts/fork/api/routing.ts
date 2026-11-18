// Which legs a trade can buy on the fork, and the venue instructions for them: Jupiter swaps
// through the best issuer, Jupiter Lend deposits for yield legs, and Phoenix for perp legs (long)
// and fades' shorts (api/phoenix.ts).
//
// Every Jupiter request goes through the fork API's budget (api/guard.ts, JupiterBudget) in the
// caller's lane: 1 for a build at tap time (the default), 2 for a prebuild, 3 for a route check.
// Lanes 2 and 3 fail fast with 503 busy rather than wait, and a quote that failed rather than
// found no route is never remembered as "no route".
import type { PublicKey } from "@solana/web3.js";
import { PRICEABLE_MIN_POOLED_USD, bestIssuer, issuerPool, type BestIssuerResult, type ReadMints } from "@thesis/venues/bank";
import { ineligible, otherSide, type GeminiContract } from "@thesis/venues/gemini";
import { jupiterBuy, jupiterLendDeposit, jupiterQuote, quoteFn, splitStake, type JupiterAccess, type VenueLeg } from "@thesis/venues/jupiter";
import { ApiError, MIN_STAKE_USD, USD, type ServiceOpts } from "./common.ts";
import { jupiterBudget, newUse, type JupiterBudget, type JupiterUse, type Lane } from "./guard.ts";
import { isPaper, type MappedLeg } from "./legs.ts";
import { cardIdHex } from "@thesis/venues/collector-crypt";
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

export type Route = typeof ROUTE & { dexes?: string[] };
/**
 * A venue leg tagged with the take leg it buys and the owner's account it fills (proof of trade),
 * and how it buys it (a split trade's sweep redeems Jupiter Lend shares instead of swapping them).
 */
export type TradeLeg = VenueLeg & { output: { leg: number; account: PublicKey }; how: "swap" | "lend" | "phoenix"; phoenix?: PhoenixLeg };
type Winner = NonNullable<Awaited<ReturnType<typeof bestIssuer>>["winner"]>;
type Excluded = { index: number; name: string; reason: string };
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

  constructor(o: ServiceOpts, deps: { budget?: JupiterBudget; readMints?: ReadMints | null } = {}) {
    this.#o = o;
    this.route = { ...ROUTE, dexes: o.dexes };
    this.budget = deps.budget ?? jupiterBudget;
    this.#readMints = deps.readMints;
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
    return { budget: this.budget.snapshot(), winners: this.#winners.size, noRoute: this.#noRoute.size };
  }

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
    const tradedStake = () => stake - escrowShare(usable, stake);
    const includedIdx = () => usable.map((l) => l.index).sort((a, b) => a - b);
    const done = (venue: TradeLeg[]) => ({ venue, included: includedIdx(), excluded: sorted(), jupiter: use });
    if (!traded().length) return done([]);
    // A back's perp legs, and every traded leg of a fade (its shorts), trade on Phoenix.
    const onPhoenix = (l: MappedLeg) => side === "fade" || l.how === "perp";
    /** Legs whose quotes failed rather than found no route (by take leg index). */
    const failed = new Set<number>();
    const quoteAll = (ls: MappedLeg[], parts: bigint[], only?: (Winner | "lend" | "phoenix")[]) =>
      Promise.all(
        ls.map(async (l, j): Promise<Winner | "lend" | "phoenix" | null> => {
          if (onPhoenix(l)) return "phoenix";
          if (l.how === "lend") return "lend";
          const usdPart = Number(parts[j]) / USD;
          const quote = (onlyMints?: string[]) =>
            bestIssuer(l.key!, usdPart, this.#best(lane, use, onlyMints))
              .catch(() => null)
              .then((r) => {
                if (transient(r)) failed.add(l.index);
                return r?.winner ?? null;
              });
          const prev = only?.[j];
          if (prev && prev !== "lend" && prev !== "phoenix") return quote([prev.mint]);
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
    const busyOut = (ls: MappedLeg[], winners: unknown[]) => {
      if (use.refused) throw use.refused;
      const lost = ls.filter((l, j) => winners[j] === null && failed.has(l.index));
      if (lane !== 1 && lost.length) throw busy(lost.map((l) => l.name).join(", "));
    };

    let swapLegs = traded();
    let parts = splitStake(tradedStake(), swapLegs.map((l) => l.spec.weightBps));
    let winners = await quoteAll(swapLegs, parts);
    busyOut(swapLegs, winners);
    if (winners.some((w) => w === null)) {
      for (const [j, l] of swapLegs.entries()) {
        if (winners[j] !== null) continue;
        if (!failed.has(l.index)) this.#noRoute.set(l.key!, now + NO_ROUTE_TTL_MS);
        excluded.push({ index: l.index, name: l.name, reason: NO_ROUTE });
      }
      const kept = swapLegs.map((l, j) => [l, winners[j]] as const).filter(([, w]) => w !== null);
      const keptIdx = new Set(kept.map(([l]) => l.index));
      usable = usable.filter((l) => isPaper(l.how) || keptIdx.has(l.index));
      if (!usable.length) throw new ApiError(422, "nothing_tradable", "None of this take's legs can be bought on the fork right now");
      swapLegs = traded();
      if (!swapLegs.length) return done([]);
      // Dropping a leg changes the escrowed share too, so the traded part is split again.
      parts = splitStake(tradedStake(), swapLegs.map((l) => l.spec.weightBps));
      winners = await quoteAll(swapLegs, parts, kept.map(([, w]) => w!));
      busyOut(swapLegs, winners);
      if (winners.some((w) => w === null)) throw new ApiError(502, "routing_failed", "A route disappeared while sizing the trade. Try again.");
    }

    // Phoenix legs each get their own child subaccount (registered now if needed).
    const phoenixLegs = swapLegs.filter(onPhoenix);
    const subs = phoenixLegs.length ? await this.phoenix!.prepare(user, phoenixLegs.length) : [];
    const subOf = new Map(phoenixLegs.map((l, k) => [l.index, subs[k]]));
    const venue = (await Promise.all(
      swapLegs.map((l, j) => this.#legFor(l, parts[j], winners[j]!, user, payer, side, subOf.get(l.index), lane, use)),
    ).catch((e: unknown) => {
      throw use.refused ?? e;
    })).flat();
    return done(venue);
  }

  /**
   * The venue instructions for one leg, given how it's bought. Phoenix legs trade in child `sub`,
   * sized at the market's mid: collateral is the leg's part of the stake, the position that times
   * leverage.
   */
  async #legFor(l: MappedLeg, part: bigint, w: Winner | "lend" | "phoenix", user: PublicKey, payer: PublicKey, side: "back" | "fade", sub: number | undefined, lane: Lane, use: JupiterUse): Promise<TradeLeg[]> {
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
      });
      return legs.map((v) => ({ ...v, output: { leg: l.index, account: v.outputAccount! }, how: "phoenix" as const, phoenix: { leg: l.index, sub: sub!, symbol: market.symbol } }));
    }
    const jupiter = this.jupiter(lane, use);
    const leg = w === "lend"
      ? await jupiterLendDeposit({ ...jupiter, user, payer, amount: part, label: `${l.name} (Jupiter Lend)`, apiKey: jupiter.apiKey! })
      : await jupiterBuy({ ...jupiter, quote: w.quote, user, payer, label: `${l.name} (${w.symbol})` });
    // Proof of trade: the receipt checks this account grew (the take leg it buys, by index).
    if (!leg.outputAccount) throw new ApiError(502, "routing_failed", `Jupiter's route for ${l.name} doesn't deliver to your wallet's token account.`);
    return [{ ...leg, output: { leg: l.index, account: leg.outputAccount }, how: w === "lend" ? "lend" : "swap" }];
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
