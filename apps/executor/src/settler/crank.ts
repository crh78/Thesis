// The settler crank. Each tick:
//   1. signs entry prices for positions that lack them, sale prices for positions their owners
//      sold, and exit prices once a take's horizon has passed (pricing.ts decides which price);
//   2. settles takes whose author prices are in (or whose grace period has passed);
//   3. settles each position that's ready, which closes it and refunds its rent: a sold one as
//      soon as its sale prices are in, the rest (and the author's buy-in) once their take settles;
//   4. mints any badge an author has earned but doesn't hold yet.
// Steps 2-4 need no settler signature; the settler key just pays for them. What each tick loads
// comes from open-set.ts: the open positions the database lists, with a full scan every 10 minutes.
import BN from "bn.js";
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Connection, type Keypair } from "@solana/web3.js";
import {
  BADGE_KIND_INDEX,
  THESIS_COMPUTE_UNITS,
  badgeMintAddress,
  fetchConfig,
  mintBadgeIx,
  profileAddress,
  recordEntryPricesIx,
  recordExitPricesIx,
  recordSalePricesIx,
  settlePositionIx,
  settleTakeIx,
  type BadgeKindName,
  type ExitAccount,
  type PositionAccount,
  type ProfileAccount,
  type TakeAccount,
  type ThesisProgram,
} from "@thesis/chain";
import type { AuditLog } from "./audit.ts";
import { basisKey, entryBases, type EntryBasis } from "./basis.ts";
import { sourceHash } from "./audit.ts";
import type { BankIndex } from "./bank.ts";
import { priceLeg, toPriceUnits, type LegKindName, type LegQuote, type PriceRules, type Sources } from "./pricing.ts";
import { OpenSet, programReader, type OpenPositionsSource } from "./open-set.ts";
import { heldOnPhoenix, legStakeUsd, provedToken, receivedValueShortfall, tradeProof, type TradeProof } from "./proof.ts";
import { pricePhoenixLeg, type PhoenixReader } from "./phoenix-legs.ts";
import { sendAll, type Item, type SendResult } from "./tx.ts";

export type SettlerOpts = {
  program: ThesisProgram;
  connection: Connection;
  settler: Keypair;
  bank: BankIndex;
  sources: Sources;
  rules: Omit<PriceRules, "maxDelaySecs">;
  audit: AuditLog;
  log?: (line: string) => void;
  /** Where the open positions come from between full scans (chain_positions); none: a full scan every tick. */
  openPositions?: OpenPositionsSource | null;
  /** How often the full program scan runs anyway: 600 (10 minutes). */
  fullScanEverySecs?: number;
  /** false: no full scan on the first tick either (tests of the database path). */
  initialScan?: boolean;
  /** Reads Phoenix trader accounts and markets, for legs held on Phoenix. Unset: those legs wait. */
  phoenix?: PhoenixReader | null;
};

export type TickSummary = {
  now: number;
  prices: SendResult;
  takes: SendResult;
  positions: SendResult;
  badges: SendResult;
  waiting: string[];
  /** Whether this tick scanned every program account (otherwise it read the database's open set). */
  fullScan: boolean;
};

type Keyed<T> = { publicKey: PublicKey; account: T };

const kindName = (k: object) => Object.keys(k)[0] as LegKindName;

/** Legs that need a price: every included leg (yield too). Mirrors the program. */
export function pricedMask(take: TakeAccount, legsMask: number): number {
  return take.legs.reduce((m, _leg, i) => (legsMask & (1 << i) ? m | (1 << i) : m), 0);
}

/** Entry, the horizon's exit, or the owner's sale (`exit_position`). */
export type Moment = "entry" | "exit" | "sale";

export function missingLegs(take: TakeAccount, p: PositionAccount, moment: Moment, exit?: ExitAccount | null): number[] {
  const set = moment === "entry" ? p.entrySet : moment === "exit" ? p.exitSet : (exit?.priceSet ?? 0);
  const need = pricedMask(take, p.legsMask) & ~set;
  return take.legs.map((_, i) => i).filter((i) => need & (1 << i));
}

/** The author's buy-in: it sets the take's headline, so it always takes horizon prices. */
const isAuthorBuyIn = (take: TakeAccount, p: PositionAccount) => p.id.isZero() && p.owner.equals(take.author);

/** Whether `settle_position` will accept this position now. Mirrors the program. */
export function settleReady(
  take: TakeAccount,
  p: PositionAccount,
  exit: ExitAccount | null,
  now: number,
  maxDelay: number,
): "ready" | "waiting_for_take" | "waiting_for_prices" {
  if ((!exit || isAuthorBuyIn(take, p)) && !("settled" in take.status)) return "waiting_for_take";
  const scoreAt = exit ? "sale" : "exit";
  const from = exit ? exit.exitedAt.toNumber() : take.horizonEnd.toNumber();
  const priced = !missingLegs(take, p, "entry").length && !missingLegs(take, p, scoreAt, exit).length;
  return priced || now > from + maxDelay ? "ready" : "waiting_for_prices";
}

/** The moments this position still needs prices for, and when each is. */
function priceMoments(take: TakeAccount, p: PositionAccount, exit: ExitAccount | null, now: number): [Moment, number][] {
  const out: [Moment, number][] = [["entry", p.openedAt.toNumber()]];
  if (exit) out.push(["sale", exit.exitedAt.toNumber()]);
  // A sold position scores on its sale, so only the author's buy-in still needs horizon prices.
  if (now >= take.horizonEnd.toNumber() && (!exit || isAuthorBuyIn(take, p))) out.push(["exit", take.horizonEnd.toNumber()]);
  return out;
}

/** Badges a profile has earned. Mirrors `BadgeKind::earned` in the program. */
export function earnedBadges(p: ProfileAccount): BadgeKindName[] {
  const out: BadgeKindName[] = [];
  if (p.takesCreated >= 1) out.push("firstTake");
  if (p.takesOver50 >= 1) out.push("firstOver50");
  if (p.takesOver100 >= 1) out.push("firstOver100");
  if (p.takesOver50 >= 10) out.push("tenOver50");
  if (p.takesOver1000 >= 1) out.push("over1000");
  return out;
}

export async function chainTime(conn: Connection): Promise<number> {
  const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  if (!info) throw new Error("no Clock sysvar");
  return Number(info.data.readBigInt64LE(32));
}

/** How far back, before the transaction that opened a position, the same trade's other transactions can be. */
export const TRADE_WINDOW_SECS = 120;

/**
 * Mints the owner received for a position, with raw amounts. A trade that didn't fit in one
 * transaction goes out as a short sequence with the Thesis receipt last, so this reads the
 * transaction that opened the position plus the owner's transactions just before it when
 * exact signatures are unavailable and the caller allows that heuristic.
 */
export async function boughtTokens(conn: Connection, position: PublicKey, owner: PublicKey, options: { openingOnly?: boolean; signatures?: readonly string[] } = {}): Promise<Map<string, bigint>> {
  let before: string | undefined;
  let opening: { signature: string; blockTime?: number | null } | undefined;
  while (!options.signatures) {
    const page = await conn.getSignaturesForAddress(position, { before, limit: 1000 }, "confirmed");
    if (!page.length) break;
    for (const entry of page) if (!entry.err) opening = entry;
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  const out = new Map<string, bigint>();
  const sigs = options.signatures ? [...options.signatures] : opening ? [opening.signature] : [];
  if (opening?.blockTime && !options.openingOnly) {
    const earlier = await conn.getSignaturesForAddress(owner, { before: opening.signature, limit: 10 }, "confirmed");
    for (const s of earlier) {
      if (!s.err && s.blockTime && s.blockTime >= opening.blockTime - TRADE_WINDOW_SECS) sigs.push(s.signature);
    }
  }
  const owned = (b: { owner?: string }) => b.owner === owner.toBase58();
  for (const sig of sigs) {
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    // Right after a trade the RPC may not serve every transaction yet. Don't guess: the caller
    // retries next tick rather than pricing on the stock when the token is knowable.
    if (!tx?.meta) throw new Error(`transaction ${sig} isn't available yet`);
    if (tx.meta.err) continue;
    const pre = new Map((tx.meta.preTokenBalances ?? []).filter(owned).map((b) => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
    for (const b of (tx.meta.postTokenBalances ?? []).filter(owned)) {
      const delta = BigInt(b.uiTokenAmount.amount) - (pre.get(b.accountIndex) ?? 0n);
      if (delta > 0n) out.set(b.mint, (out.get(b.mint) ?? 0n) + delta);
    }
  }
  return out;
}

/** RPC reads can fail transiently (rate limits, a node catching up); try a few times. */
async function retry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 750 * i));
    }
  }
}

export class Settler {
  #o: SettlerOpts;
  #log: (line: string) => void;
  /** Legs given up on, keyed `position:moment:leg`, so hopeless legs aren't re-fetched every tick. */
  #gaveUp = new Set<string>();
  /** Each position's proof of trade (its receipt's TradeProved event), once read. */
  #proofs = new Map<string, TradeProof | null>();
  /** Each leg's entry basis (`position:leg`), from the audit log: exits are priced the same way. */
  #bases: Map<string, EntryBasis>;
  #set: OpenSet;

  constructor(o: SettlerOpts) {
    this.#o = o;
    this.#log = o.log ?? (() => {});
    this.#bases = entryBases(o.audit.read?.() ?? []);
    this.#set = new OpenSet({
      chain: programReader(o.program),
      programId: o.program.programId,
      source: o.openPositions,
      fullScanEverySecs: o.fullScanEverySecs,
      initialScan: o.initialScan,
      log: this.#log,
    });
  }

  async tick(): Promise<TickSummary> {
    const { program, connection } = this.#o;
    const config = await fetchConfig(program);
    if (!config.settler.equals(this.#o.settler.publicKey)) {
      throw new Error(`this key (${this.#o.settler.publicKey.toBase58()}) is not the config's settler (${config.settler.toBase58()})`);
    }
    const maxDelay = config.params.maxPriceDelaySecs.toNumber();
    const rules: PriceRules = { ...this.#o.rules, maxDelaySecs: maxDelay };
    const now = await chainTime(connection);
    const waiting: string[] = [];

    // 1. Prices.
    let { positions, takes, exits } = await this.#load(true);
    const scanned = this.#set.fullScan;
    const priceItems: Item[] = [];
    for (const { publicKey, account: p } of positions) {
      const take = takes.get(p.take.toBase58());
      if (!take) continue;
      const exit = exits.get(publicKey.toBase58()) ?? null;
      for (const [moment, at] of priceMoments(take, p, exit, now)) {
        const legs = missingLegs(take, p, moment, exit).filter((i) => !this.#gaveUp.has(`${publicKey}:${moment}:${i}`));
        if (!legs.length) continue;
        const item = await this.#priceItem(publicKey, p, take, moment, at, legs, now, rules, waiting);
        if (item) priceItems.push(item);
      }
    }
    const prices = await sendAll(connection, this.#o.settler, priceItems);

    // 2. Takes.
    ({ positions, takes } = await this.#load(false));
    const byKey = new Map(positions.map((p) => [p.publicKey.toBase58(), p.account]));
    const horizonPriced = (take: TakeAccount, p: PositionAccount) =>
      !missingLegs(take, p, "entry").length && !missingLegs(take, p, "exit").length;
    const takeItems: Item[] = [];
    const takeAuthors = new Map<string, PublicKey>();
    for (const [key, take] of takes) {
      if (!("open" in take.status) || now < take.horizonEnd.toNumber()) continue;
      const authorPos = [...byKey.values()].find((p) => p.take.toBase58() === key && p.owner.equals(take.author) && p.id.isZero());
      const graceOver = now > take.horizonEnd.toNumber() + maxDelay;
      if (authorPos && !horizonPriced(take, authorPos) && !graceOver) {
        waiting.push(`take ${key}: waiting for the author's prices`);
        continue;
      }
      takeItems.push({
        ix: await settleTakeIx(program, { take: new PublicKey(key), author: take.author }),
        cu: THESIS_COMPUTE_UNITS.settleTake,
        label: `settle_take ${key}`,
      });
      takeAuthors.set(`settle_take ${key}`, take.author);
    }
    const settledTakes = await sendAll(connection, this.#o.settler, takeItems);

    // 3. Positions: sold ones as soon as they're priced, the rest once their take settles.
    ({ positions, takes, exits } = await this.#load(false));
    const positionItems: Item[] = [];
    // Whose profile a settlement this tick changes: the badges to check outside a full scan.
    const ownerOf = new Map<string, PublicKey>();
    for (const { publicKey, account: p } of positions) {
      const take = takes.get(p.take.toBase58());
      if (!take) continue;
      const exit = exits.get(publicKey.toBase58()) ?? null;
      const ready = settleReady(take, p, exit, now, maxDelay);
      if (ready === "waiting_for_take") continue;
      if (ready === "waiting_for_prices") {
        waiting.push(`position ${publicKey}: waiting for ${exit ? "sale prices" : "prices"}`);
        continue;
      }
      positionItems.push({
        ix: await settlePositionIx(program, {
          take: p.take,
          position: publicKey,
          owner: p.owner,
          rentPayer: p.rentPayer,
          exitRentPayer: exit?.rentPayer,
        }),
        cu: THESIS_COMPUTE_UNITS.settlePosition,
        label: `settle_position ${publicKey}`,
      });
      ownerOf.set(`settle_position ${publicKey}`, p.owner);
    }
    const settledPositions = await sendAll(connection, this.#o.settler, positionItems);

    // 4. Badges: every profile on a full scan. Otherwise the profiles that can have changed: the
    // owners of new positions (a first take earns its badge at once) and of what settled now.
    const fresh = this.#set.takeNewOwners();
    const settled = [...settledTakes.sent, ...settledPositions.sent]
      .flatMap((s) => s.labels)
      .flatMap((l) => [ownerOf.get(l), takeAuthors.get(l)].filter((k): k is PublicKey => k != null));
    const changed = scanned ? null : [...new Map([...fresh, ...settled].map((k) => [k.toBase58(), k])).values()];
    const badges = await sendAll(connection, this.#o.settler, await this.#badgeItems(changed));

    const summary = { now, prices, takes: settledTakes, positions: settledPositions, badges, waiting, fullScan: scanned };
    for (const [name, r] of Object.entries({ prices, takes: settledTakes, positions: settledPositions, badges })) {
      for (const s of r.sent) this.#log(`${name}: ${s.labels.join(", ")} -> ${s.signature}`);
      for (const f of r.failed) this.#log(`${name}: FAILED ${f.label}: ${f.error}`);
    }
    return summary;
  }

  /** The open positions, their takes and exits (open-set.ts). `refresh`: the tick's first load. */
  #load(refresh: boolean) {
    return retry(() => this.#set.load(refresh));
  }

  async #priceItem(
    position: PublicKey,
    p: PositionAccount,
    take: TakeAccount,
    moment: Moment,
    at: number,
    legs: number[],
    now: number,
    rules: PriceRules,
    waiting: string[],
  ): Promise<Item | null> {
    const proof = await this.#proofFor(position);
    if (proof === undefined) {
      waiting.push(`position ${position} leg ${legs.join(",")} ${moment}: its receipt isn't readable yet`);
      return null;
    }
    const side = "back" in p.side ? "back" : "fade";
    const quotes: LegQuote[] = [];
    const giveUp = (i: number, reason: string) => {
      this.#gaveUp.add(`${position}:${moment}:${i}`);
      waiting.push(`position ${position} leg ${i} ${moment}: ${reason} (gave up)`);
    };
    for (const i of legs) {
      const leg = take.legs[i];
      const kind = kindName(leg.kind);
      const idHex = leg.asset.toBuffer().toString("hex");
      const underlying = this.#o.bank.underlyingById(idHex);
      // Exits and sales are priced the way the entry was.
      const basis = moment === "entry" ? null : (this.#bases.get(basisKey(position.toBase58(), i)) ?? null);
      // Only what the trade proved it bought is priced: no stock fallback for a leg with no token.
      const decision = provedToken({ kind, assetIdHex: idHex }, side, proof, i, this.#o.bank);
      if (!decision.ok) {
        giveUp(i, decision.reason);
        continue;
      }
      const token = decision.token;
      if (heldOnPhoenix(kind, side)) {
        const entry = p.entrySet & (1 << i) ? Number(p.prices[i].entry.toString()) / 1e8 : null;
        const stake = BigInt(p.stake.toString());
        const phx = this.#o.phoenix
          ? await pricePhoenixLeg({
            index: i, moment, momentSec: at, nowSec: now, rules, side,
            leg: { assetIdHex: idHex, leverage: leg.leverage },
            out: proof?.outputs.get(i), basis, entryPrice: entry,
            legStakeUsd: legStakeUsd(take, p.legsMask, stake, i),
            reader: this.#o.phoenix, marks: this.#o.sources.phoenix, perp: (s) => this.#o.bank.perp(s),
          }).catch((e): Awaited<ReturnType<typeof pricePhoenixLeg>> => ({ ok: false, retry: true, reason: `source error: ${e instanceof Error ? e.message : e}` }))
          : ({ ok: false, retry: true, reason: "no Phoenix reader configured" } as const);
        if (!phx.ok) {
          if (!phx.retry) this.#gaveUp.add(`${position}:${moment}:${i}`);
          waiting.push(`position ${position} leg ${i} ${moment}: ${phx.reason}${phx.retry ? "" : " (gave up)"}`);
          continue;
        }
        quotes.push(phx.quote);
        continue;
      }
      const prediction = kind === "prediction" ? this.#o.bank.prediction(idHex) : null;
      // `moment` too: an exit whose basis is missing (an older entry, a lost audit log) is still an exit.
      const card = kind === "card" ? this.#o.bank.card(idHex) : null;
      const out = await priceLeg({ index: i, kind, underlying, token, prediction, held: side, card }, at, now, rules, this.#o.sources, basis, moment).catch(
        (e): Awaited<ReturnType<typeof priceLeg>> => ({ ok: false, retry: true, reason: `source error: ${e instanceof Error ? e.message : e}` }),
      );
      if (!out.ok) {
        if (!out.retry) this.#gaveUp.add(`${position}:${moment}:${i}`);
        waiting.push(`position ${position} leg ${i} ${moment}: ${out.reason}${out.retry ? "" : " (gave up)"}`);
        continue;
      }
      // At entry, the tokens received must be worth (most of) the leg's part of the stake.
      const proved = proof?.outputs.get(i);
      if (moment === "entry" && token && proved) {
        const stake = BigInt(p.stake.toString());
        const shortfall = receivedValueShortfall(proved, token, out.quote.price, legStakeUsd(take, p.legsMask, stake, i), rules.minReceivedRatio);
        if (shortfall) {
          giveUp(i, shortfall);
          continue;
        }
      }
      quotes.push(out.quote);
    }
    if (!quotes.length) return null;

    const doc = {
      v: 1,
      program: this.#o.program.programId.toBase58(),
      take: p.take.toBase58(),
      position: position.toBase58(),
      moment,
      momentAt: at,
      legs: quotes.map((q) => ({ ...q, priceUnits: toPriceUnits(q.price).toString() })),
    };
    const hash = sourceHash(doc);
    if (moment === "entry") for (const q of quotes) this.#bases.set(basisKey(position.toBase58(), q.leg), q.basis);
    this.#o.audit.append({ hash: hash.toString("hex"), doc });
    const build = { entry: recordEntryPricesIx, exit: recordExitPricesIx, sale: recordSalePricesIx }[moment];
    const ix = await build(this.#o.program, {
      settler: this.#o.settler.publicKey,
      take: p.take,
      position,
      prices: quotes.map((q) => ({ leg: q.leg, price: new BN(toPriceUnits(q.price).toString()), publishedAt: new BN(q.publishedAt) })),
      sourceHash: [...hash],
    });
    return {
      ix,
      cu: { entry: THESIS_COMPUTE_UNITS.recordEntryPrices, exit: THESIS_COMPUTE_UNITS.recordExitPrices, sale: THESIS_COMPUTE_UNITS.recordSalePrices }[moment],
      label: `record_${moment}_prices ${position} legs ${quotes.map((q) => q.leg).join(",")}`,
    };
  }

  /**
   * The position's proof of trade, cached once read; null for a receipt with no TradeProved
   * event; undefined (try again next tick) while the receipt can't be read.
   */
  async #proofFor(position: PublicKey): Promise<TradeProof | null | undefined> {
    const key = position.toBase58();
    if (!this.#proofs.has(key)) {
      try {
        this.#proofs.set(key, await tradeProof(this.#o.connection, this.#o.program, position));
      } catch {
        return undefined;
      }
    }
    return this.#proofs.get(key)!;
  }

  /** Badges earned but not minted: for these owners' profiles, or every profile (null). */
  async #badgeItems(owners: PublicKey[] | null): Promise<Item[]> {
    const { program, connection } = this.#o;
    let profiles: Keyed<ProfileAccount>[];
    if (owners) {
      if (!owners.length) return [];
      const keys = owners.map((o) => profileAddress(o, program.programId));
      const fetched = (await retry(() => program.account.profile.fetchMultiple(keys))) as (ProfileAccount | null)[];
      profiles = fetched.flatMap((account, i) => (account ? [{ publicKey: keys[i], account }] : []));
    } else {
      profiles = (await retry(() => program.account.profile.all())) as Keyed<ProfileAccount>[];
    }
    const wanted = profiles.flatMap((p) =>
      earnedBadges(p.account).map((kind) => ({ owner: p.account.owner, kind, mint: badgeMintAddress(p.account.owner, BADGE_KIND_INDEX[kind], program.programId) })),
    );
    const items: Item[] = [];
    for (let i = 0; i < wanted.length; i += 100) {
      const chunk = wanted.slice(i, i + 100);
      const infos = await connection.getMultipleAccountsInfo(chunk.map((w) => w.mint), "confirmed");
      for (const [j, w] of chunk.entries()) {
        if (infos[j]) continue;
        items.push({
          ix: await mintBadgeIx(program, { payer: this.#o.settler.publicKey, owner: w.owner, kind: w.kind }),
          cu: THESIS_COMPUTE_UNITS.mintBadge,
          label: `mint_badge ${w.kind} ${w.owner.toBase58()}`,
        });
      }
    }
    return items;
  }
}
