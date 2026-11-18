// Which legs a trade can buy on the fork, and the venue instructions for them: Jupiter swaps
// through the best issuer, Jupiter Lend deposits for yield legs, and Phoenix for perp legs (long)
// and fades' shorts (api/phoenix.ts).
import type { PublicKey } from "@solana/web3.js";
import { PRICEABLE_MIN_POOLED_USD, bestIssuer, issuerPool } from "@thesis/venues/bank";
import { ineligible, otherSide, type GeminiContract } from "@thesis/venues/gemini";
import { jupiterBuy, jupiterLendDeposit, splitStake, type VenueLeg } from "@thesis/venues/jupiter";
import { ApiError, MIN_STAKE_USD, USD, type ServiceOpts } from "./common.ts";
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
/** Which side a trade takes (a fade holds the other side of a prediction leg), and whether paper legs can be in it. */
export type TradeKind = { side?: "back" | "fade"; paper?: boolean };

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

  constructor(o: ServiceOpts) {
    this.#o = o;
    this.route = { ...ROUTE, dexes: o.dexes };
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
   */
  async checkRoutes(legs: MappedLeg[]) {
    const now = Date.now();
    const unknown = legs.filter((l) => l.how === "swap" && !this.leftOut(l, now) && !((this.#winners.get(l.key!)?.at ?? 0) > now - NO_ROUTE_TTL_MS));
    if (!unknown.length) return;
    const state = this.#o.bank();
    await Promise.all(
      [...new Set(unknown.map((l) => l.key!))].map((key) => {
        const pending = this.#checking.get(key);
        if (pending) return pending;
        const check = bestIssuer(key, MIN_STAKE_USD, { state, ...this.route })
          .catch(() => null)
          .then((best) => {
            if (best?.winner) this.#winners.set(key, { mint: best.winner.mint, at: now });
            else this.#noRoute.set(key, now + NO_ROUTE_TTL_MS);
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
   */
  async venueLegs(legs: MappedLeg[], user: PublicKey, usd: number, payer = this.#o.appPayer.publicKey, maxLegs?: number, kind: TradeKind = {}) {
    const now = Date.now();
    const side = kind.side ?? "back";
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

    const state = this.#o.bank();
    const stake = BigInt(Math.round(usd * USD));
    // Prediction and card legs aren't traded: the receipt escrows their share. The rest is split by weight.
    const traded = () => usable.filter((l) => !isPaper(l.how));
    const tradedStake = () => stake - escrowShare(usable, stake);
    const includedIdx = () => usable.map((l) => l.index).sort((a, b) => a - b);
    if (!traded().length) return { venue: [] as TradeLeg[], included: includedIdx(), excluded: sorted() };
    // A back's perp legs, and every traded leg of a fade (its shorts), trade on Phoenix.
    const onPhoenix = (l: MappedLeg) => side === "fade" || l.how === "perp";
    const quoteAll = (ls: MappedLeg[], parts: bigint[], only?: (Winner | "lend" | "phoenix")[]) =>
      Promise.all(
        ls.map(async (l, j): Promise<Winner | "lend" | "phoenix" | null> => {
          if (onPhoenix(l)) return "phoenix";
          if (l.how === "lend") return "lend";
          const usdPart = Number(parts[j]) / USD;
          const quote = (onlyMints?: string[]) =>
            bestIssuer(l.key!, usdPart, { state, ...this.route, onlyMints })
              .then((r) => r.winner)
              .catch(() => null);
          const prev = only?.[j];
          if (prev && prev !== "lend" && prev !== "phoenix") return quote([prev.mint]);
          const known = this.#winners.get(l.key!);
          if (known && known.at > now - WINNER_TTL_MS) {
            const w = await quote([known.mint]);
            if (w) return w;
          }
          const w = await quote();
          if (w) this.#winners.set(l.key!, { mint: w.mint, at: Date.now() });
          return w;
        }),
      );

    let swapLegs = traded();
    let parts = splitStake(tradedStake(), swapLegs.map((l) => l.spec.weightBps));
    let winners = await quoteAll(swapLegs, parts);
    if (winners.some((w) => w === null)) {
      for (const [j, l] of swapLegs.entries()) {
        if (winners[j] !== null) continue;
        this.#noRoute.set(l.key!, now + NO_ROUTE_TTL_MS);
        excluded.push({ index: l.index, name: l.name, reason: NO_ROUTE });
      }
      const kept = swapLegs.map((l, j) => [l, winners[j]] as const).filter(([, w]) => w !== null);
      const keptIdx = new Set(kept.map(([l]) => l.index));
      usable = usable.filter((l) => isPaper(l.how) || keptIdx.has(l.index));
      if (!usable.length) throw new ApiError(422, "nothing_tradable", "None of this take's legs can be bought on the fork right now");
      swapLegs = traded();
      if (!swapLegs.length) return { venue: [] as TradeLeg[], included: includedIdx(), excluded: sorted() };
      // Dropping a leg changes the escrowed share too, so the traded part is split again.
      parts = splitStake(tradedStake(), swapLegs.map((l) => l.spec.weightBps));
      winners = await quoteAll(swapLegs, parts, kept.map(([, w]) => w!));
      if (winners.some((w) => w === null)) throw new ApiError(502, "routing_failed", "A route disappeared while sizing the trade. Try again.");
    }

    // Phoenix legs each get their own child subaccount (registered now if needed).
    const phoenixLegs = swapLegs.filter(onPhoenix);
    const subs = phoenixLegs.length ? await this.phoenix!.prepare(user, phoenixLegs.length) : [];
    const subOf = new Map(phoenixLegs.map((l, k) => [l.index, subs[k]]));
    const venue = (await Promise.all(
      swapLegs.map((l, j) => this.#legFor(l, parts[j], winners[j]!, user, payer, side, subOf.get(l.index))),
    )).flat();
    return { venue, included: includedIdx(), excluded: sorted() };
  }

  /**
   * The venue instructions for one leg, given how it's bought. Phoenix legs trade in child `sub`,
   * sized at the market's mid: collateral is the leg's part of the stake, the position that times
   * leverage.
   */
  async #legFor(l: MappedLeg, part: bigint, w: Winner | "lend" | "phoenix", user: PublicKey, payer: PublicKey, side: "back" | "fade", sub?: number): Promise<TradeLeg[]> {
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
    const apiKey = this.#o.jupiterApiKey;
    const leg = w === "lend"
      ? await jupiterLendDeposit({ user, payer, amount: part, label: `${l.name} (Jupiter Lend)`, apiKey: apiKey! })
      : await jupiterBuy({ quote: w.quote, user, payer, label: `${l.name} (${w.symbol})`, apiKey });
    // Proof of trade: the receipt checks this account grew (the take leg it buys, by index).
    if (!leg.outputAccount) throw new ApiError(502, "routing_failed", `Jupiter's route for ${l.name} doesn't deliver to your wallet's token account.`);
    return [{ ...leg, output: { leg: l.index, account: leg.outputAccount }, how: w === "lend" ? "lend" : "swap" }];
  }

  /**
   * A split trade's retry (api/split.ts): the venue legs for the take legs in `remaining` only,
   * each sized as the first build sized it (the same included legs, stake and weights), with fresh
   * quotes. Phoenix legs trade in the child the first build recorded for them. `legs` are the
   * legs the receipt opens. Throws 422 `retry_unavailable` when a leg can't be bought now.
   */
  async rebuild(legs: MappedLeg[], user: PublicKey, usd: number, side: "back" | "fade", remaining: Set<number>, recorded: PhoenixLeg[], payer = this.#o.appPayer.publicKey): Promise<TradeLeg[]> {
    const now = Date.now();
    const stake = BigInt(Math.round(usd * USD));
    const traded = legs.filter((l) => !isPaper(l.how));
    const parts = splitStake(stake - escrowShare(legs, stake), traded.map((l) => l.spec.weightBps));
    const unavailable = (l: MappedLeg, why: string) => new ApiError(422, "retry_unavailable", `${l.name} can't be bought again right now (${why}).`);
    return (await Promise.all(traded.map(async (l, j): Promise<TradeLeg[]> => {
      if (!remaining.has(l.index)) return [];
      const why = this.leftOut(l, now, side);
      if (why) throw unavailable(l, why);
      if (side === "fade" || l.how === "perp") {
        const sub = recorded.find((r) => r.leg === l.index)?.sub;
        if (sub === undefined) throw unavailable(l, "its Phoenix account isn't known");
        return this.#legFor(l, parts[j], "phoenix", user, payer, side, sub);
      }
      if (l.how === "lend") return this.#legFor(l, parts[j], "lend", user, payer, side);
      const usdPart = Number(parts[j]) / USD;
      const quote = (onlyMints?: string[]) =>
        bestIssuer(l.key!, usdPart, { state: this.#o.bank(), ...this.route, onlyMints }).then((r) => r.winner).catch(() => null);
      const known = this.#winners.get(l.key!);
      const w = (known && known.at > now - WINNER_TTL_MS ? await quote([known.mint]) : null) ?? await quote();
      if (!w) throw unavailable(l, NO_ROUTE);
      return this.#legFor(l, parts[j], w, user, payer, side);
    }))).flat();
  }
}
