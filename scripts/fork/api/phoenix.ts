// Phoenix legs in the fork API: which child subaccount each perp leg (or fade short) of each
// position trades in, registering wallets and children as needed, what those legs are worth, and
// closing and sweeping them. docs/phoenix-plan.md has the design.
//
// Registration needs no signature from the user: the app's payer pays, and the fork's onboarder
// (scripts/fork/phoenix.ts) co-signs a new parent. So the API sends those transactions itself
// before it builds the trade the user signs. On mainnet Phoenix's onboarder co-signs instead
// (`PhoenixVenue.submitRegistration`); that path waits for mainnet.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import type { ThesisProgram } from "@thesis/chain";
import type { VenueLeg } from "@thesis/venues/jupiter";
import {
  decodeTrader,
  liquidationDistance,
  liquidationOf,
  FIRST_CHILD,
  LAST_CHILD,
  PARENT_SUBACCOUNT,
  traderAddress,
  type PhoenixVenue,
  type TraderView,
} from "@thesis/venues/phoenix";
import { ApiError, type ServiceOpts } from "./common.ts";
import type { StateStore } from "./store.ts";

/** One Phoenix leg of one position: the take leg, its child subaccount and market. */
export type PhoenixLeg = { leg: number; sub: number; symbol: string };
/**
 * Position → its Phoenix legs. `draft`: recorded for a build not submitted (yet): its children
 * may go to the owner's next build instead (a rebuild as the amount changes), and `commit` checks
 * at submit that no other submitted trade took them meanwhile. `at`: when recorded, or committed.
 */
export type PhoenixPositions = Record<string, { owner: string; legs: PhoenixLeg[]; at: number; draft?: boolean }>;

/**
 * Liquidation warnings: a leg is "near" when its market is within 25% of its
 * liquidation price, "close" within 10%. Each level alerts once per leg.
 */
export const NEAR_LIQUIDATION = 0.25;
export const CLOSE_TO_LIQUIDATION = 0.1;

/** A Phoenix leg's liquidation risk now. `distance`: the move to liquidation, as a share of the mark. */
export type LegRisk = {
  leg: number;
  symbol: string;
  side: "long" | "short";
  entryUsd: number;
  markUsd: number | null;
  liquidationUsd: number | null;
  distance: number | null;
  level: "ok" | "near" | "close";
};

export const riskLevel = (distance: number | null): LegRisk["level"] =>
  distance === null ? "ok" : distance <= CLOSE_TO_LIQUIDATION ? "close" : distance <= NEAR_LIQUIDATION ? "near" : "ok";

/** How long a child chosen for a build stays reserved for it (a build lives 90 s). */
const RESERVE_MS = 3 * 60_000;

export type PhoenixOpts = {
  venue: PhoenixVenue;
  /** The fork's onboarder (scripts/fork/phoenix.ts): co-signs new parents. */
  onboarder: { onboarder: Keypair; permission: PublicKey };
};

export class PhoenixDesk {
  readonly venue: PhoenixVenue;
  #o: ServiceOpts;
  #p: PhoenixOpts;
  #store: StateStore;
  #program: ThesisProgram;
  /** owner → sub → reserved until (ms): children given to the owner's recent builds, offered to their next build first. */
  #reserved = new Map<string, Map<number, number>>();

  constructor(o: ServiceOpts, p: PhoenixOpts, store: StateStore, program: ThesisProgram) {
    this.#o = o;
    this.#p = p;
    this.venue = p.venue;
    this.#store = store;
    this.#program = program;
  }

  get #positions(): PhoenixPositions {
    return (this.#store.state.phoenix ??= {});
  }

  /** The Phoenix legs recorded for a position (by this service, when it built the trade). */
  legsOf(position: PublicKey): PhoenixLeg[] {
    return this.#positions[position.toBase58()]?.legs ?? [];
  }

  /**
   * Records which children a position's trade uses, as a draft. Called when the trade is built;
   * the owner's drafts older than RESERVE_MS (builds never submitted) are dropped.
   */
  record(position: PublicKey, owner: PublicKey, legs: PhoenixLeg[]) {
    if (!legs.length) return;
    const now = Date.now();
    for (const [k, p] of Object.entries(this.#positions)) if (p.draft && p.owner === owner.toBase58() && p.at < now - RESERVE_MS) delete this.#positions[k];
    this.#positions[position.toBase58()] = { owner: owner.toBase58(), legs, at: now, draft: true };
    this.#store.save();
  }

  /**
   * A trade with Phoenix legs is being submitted (in the owner's queue, before it's sent): its
   * children are its own now. 409 `build_stale` when another trade submitted since this one was
   * built took one of them (two builds made at once can share a draft's children). Nothing to do
   * for a position with no Phoenix legs, or one committed already (a retry).
   */
  commit(position: PublicKey) {
    const key = position.toBase58();
    const mine = this.#positions[key];
    if (!mine?.draft) return;
    const subs = new Set(mine.legs.map((l) => l.sub));
    const now = Date.now();
    const taken = Object.entries(this.#positions).some(([k, p]) =>
      k !== key && p.owner === mine.owner && !p.draft && p.at >= now - RESERVE_MS && p.legs.some((l) => subs.has(l.sub)));
    if (taken) throw new ApiError(409, "build_stale", "Another trade took this trade's Phoenix account. Build again.");
    this.#positions[key] = { ...mine, at: now, draft: undefined };
    this.#store.save();
  }

  async trader(owner: PublicKey, sub: number): Promise<TraderView | null> {
    const info = await this.#o.connection.getAccountInfo(traderAddress(owner, sub), "confirmed");
    return info ? decodeTrader(info.data) : null;
  }

  async #traders(owner: PublicKey, subs: number[]): Promise<(TraderView | null)[]> {
    if (!subs.length) return [];
    const infos = await this.#o.connection.getMultipleAccountsInfo(subs.map((s) => traderAddress(owner, s)), "confirmed");
    return infos.map((i) => (i ? decodeTrader(i.data) : null));
  }

  /**
   * Children whose recorded position is still open on-chain (or was just submitted): not free. The
   * owner's drafts don't count: a rebuild takes their children again (see `commit`).
   */
  async #busy(owner: PublicKey): Promise<Set<number>> {
    const mine = Object.entries(this.#positions).filter(([, p]) => p.owner === owner.toBase58() && !p.draft);
    const accounts = mine.length ? await this.#program.account.position.fetchMultiple(mine.map(([k]) => new PublicKey(k))) : [];
    const busy = new Set<number>();
    mine.forEach(([, p], i) => {
      const live = accounts[i] && !accounts[i]!.exited;
      if (live || Date.now() - p.at < RESERVE_MS) for (const l of p.legs) busy.add(l.sub);
    });
    return busy;
  }

  /**
   * `count` free children for `owner`, registered and synced, with the parent onboarded first if
   * needed. The API sends those transactions itself (the app's payer and the fork's onboarder
   * sign). A child is free when no open position uses it and it holds no position. The children
   * the owner's last builds reserved come first, so rebuilding a trade (a new amount, a prebuild
   * made again) reuses them instead of registering new ones.
   */
  async prepare(owner: PublicKey, count: number): Promise<number[]> {
    if (count === 0) return [];
    const payer = this.#o.appPayer;
    if (!(await this.trader(owner, PARENT_SUBACCOUNT))) {
      const reg = await this.venue.registration({ owner, payer: payer.publicKey, fork: { onboarder: this.#p.onboarder.onboarder.publicKey, permission: this.#p.onboarder.permission } });
      await this.#sendSigned("register Phoenix trader", reg.instructions, [payer, this.#p.onboarder.onboarder]);
    }
    const busy = await this.#busy(owner);
    const chosen: { sub: number; exists: boolean }[] = [];
    const reserved = this.#reserved.get(owner.toBase58()) ?? new Map<number, number>();
    const again = [...reserved].filter(([sub, until]) => until > Date.now() && !busy.has(sub)).map(([sub]) => sub).sort((a, b) => a - b);
    const look = async (subs: number[]) => {
      const traders = await this.#traders(owner, subs);
      subs.forEach((sub, i) => {
        if (chosen.length < count && !traders[i]?.positions.length) chosen.push({ sub, exists: Boolean(traders[i]) });
      });
    };
    if (again.length) await look(again.slice(0, count));
    for (let from = FIRST_CHILD; from <= LAST_CHILD && chosen.length < count; from += 10) {
      await look(Array.from({ length: Math.min(10, LAST_CHILD - from + 1) }, (_, i) => from + i).filter((s) => !busy.has(s) && !chosen.some((c) => c.sub === s)));
    }
    if (chosen.length < count) throw new ApiError(409, "too_many_perp_legs", `This wallet already holds ${LAST_CHILD} open Phoenix legs, the most it can.`);
    for (const c of chosen) reserved.set(c.sub, Date.now() + RESERVE_MS);
    this.#reserved.set(owner.toBase58(), reserved);
    for (const c of chosen.filter((x) => !x.exists)) {
      await this.#sendSigned(`register Phoenix child ${c.sub}`, await this.venue.childRegistration({ owner, payer: payer.publicKey, sub: c.sub }), [payer]);
    }
    return chosen.map((c) => c.sub);
  }

  /** Signs with `signers` (the payer first) and sends, confirming. Only for transactions the user needn't sign. */
  async #sendSigned(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
    const conn = this.#o.connection;
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...ixs] }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign(signers);
    const sig = await conn.sendTransaction(tx).catch((e: unknown) => {
      throw new ApiError(502, "phoenix_registration_failed", `${label}: ${e instanceof Error ? e.message : e}`);
    });
    const res = await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash("confirmed")) }, "confirmed");
    if (res.value.err) throw new ApiError(502, "phoenix_registration_failed", `${label}: ${JSON.stringify(res.value.err)}`);
  }

  /**
   * What a position's Phoenix legs are worth now: each child's collateral plus its position at
   * Phoenix's mid. Null if a market has no mid right now.
   */
  async value(position: PublicKey, owner: PublicKey): Promise<number | null> {
    return (await this.valueAndNotional(position, owner))?.usd ?? null;
  }

  /** `value`, and the positions' size at the mid (what a 1% slippage applies to when they close). */
  async valueAndNotional(position: PublicKey, owner: PublicKey): Promise<{ usd: number; notional: number } | null> {
    const legs = this.legsOf(position);
    if (!legs.length) return { usd: 0, notional: 0 };
    const traders = await this.#traders(owner, legs.map((l) => l.sub));
    let usd = 0;
    let notional = 0;
    for (const [i, l] of legs.entries()) {
      const t = traders[i];
      if (!t) continue;
      const worth = await this.#worth(t, l.symbol);
      if (worth === null) return null;
      usd += worth.usd;
      notional += worth.notional;
    }
    return { usd, notional };
  }

  async #worth(t: TraderView, symbol: string): Promise<{ usd: number; notional: number } | null> {
    let usd = Number(t.collateral) / 1e6;
    if (!t.positions.length) return { usd, notional: 0 };
    const m = await this.venue.market(symbol);
    const mid = (await this.venue.mid(symbol).catch(() => null)) ?? this.#bankMid(symbol);
    if (mid === null) return null;
    let notional = 0;
    for (const p of t.positions) {
      const base = Number(p.baseLots) / 10 ** m.baseLotsDecimals;
      usd += base * mid + Number(p.virtualQuoteLots) / 1e6;
      notional += Math.abs(base) * mid;
    }
    return { usd, notional };
  }

  /**
   * The asset bank's mid for a market (its Phoenix sweep runs every 10 minutes): a value to show
   * when Phoenix's API is rate-limiting this address. Never used to size or close a trade.
   */
  #bankMid(symbol: string): number | null {
    return this.#o.bank().venues.phoenix?.markets.find((m) => m.symbol === symbol)?.mid ?? null;
  }

  /** Each open Phoenix leg of a position: its entry, the mark, where it's liquidated and how far that is. */
  async risk(position: PublicKey, owner: PublicKey): Promise<LegRisk[]> {
    const legs = this.legsOf(position);
    if (!legs.length) return [];
    const traders = await this.#traders(owner, legs.map((l) => l.sub));
    const out: LegRisk[] = [];
    for (const [i, l] of legs.entries()) {
      const t = traders[i];
      if (!t?.positions.length) continue;
      const m = await this.venue.market(l.symbol);
      const liq = liquidationOf(t, m);
      if (!liq) continue;
      const markUsd = (await this.venue.mid(l.symbol).catch(() => null)) ?? this.#bankMid(l.symbol);
      const distance = markUsd === null ? null : liquidationDistance(markUsd, liq);
      out.push({ leg: l.leg, symbol: l.symbol, side: liq.side, entryUsd: liq.entryUsd, markUsd, liquidationUsd: liq.liquidationUsd, distance, level: riskLevel(distance) });
    }
    return out;
  }

  /**
   * Every open Phoenix leg, across wallets, that is near or close to liquidation: what the
   * liquidation watcher alerts on. Only positions still open on-chain (not sold or settled).
   */
  async atRisk(): Promise<{ position: PublicKey; owner: PublicKey; take: PublicKey; risk: LegRisk }[]> {
    const entries = Object.entries(this.#positions).filter(([, p]) => p.legs.length);
    if (!entries.length) return [];
    const keys = entries.map(([k]) => new PublicKey(k));
    const accounts = await this.#program.account.position.fetchMultiple(keys);
    const out: { position: PublicKey; owner: PublicKey; take: PublicKey; risk: LegRisk }[] = [];
    for (const [i, [, p]] of entries.entries()) {
      const a = accounts[i];
      if (!a || a.exited) continue;
      const owner = new PublicKey(p.owner);
      for (const r of await this.risk(keys[i], owner).catch(() => [])) if (r.level !== "ok") out.push({ position: keys[i], owner, take: a.take, risk: r });
    }
    return out;
  }

  /** Market orders closing every open Phoenix position of a position's legs (a sale). */
  async closeLegs(position: PublicKey, owner: PublicKey, names: Map<number, string>): Promise<VenueLeg[]> {
    const legs = this.legsOf(position);
    const traders = await this.#traders(owner, legs.map((l) => l.sub));
    const out: VenueLeg[] = [];
    for (const [i, l] of legs.entries()) {
      const p = traders[i]?.positions[0];
      if (!p) continue; // already closed (an earlier sale attempt, or liquidated)
      const mid = await this.venue.mid(l.symbol);
      if (!mid) throw new ApiError(422, "no_exit_route", `Phoenix has no price for ${l.symbol} right now.`);
      out.push(await this.venue.closeLeg({ owner, sub: l.sub, symbol: l.symbol, baseLots: p.baseLots, price: mid, label: names.get(l.leg) ?? l.symbol }));
    }
    return out;
  }

  /** Every child this service ever gave `owner`, with what it holds now. */
  async children(owner: PublicKey): Promise<{ sub: number; symbol: string; position: string; trader: TraderView }[]> {
    const mine = Object.entries(this.#positions).filter(([, p]) => p.owner === owner.toBase58());
    const flat = mine.flatMap(([position, p]) => p.legs.map((l) => ({ ...l, position })));
    // A child can be reused: keep its latest position.
    const latest = new Map<number, (typeof flat)[number]>();
    for (const l of flat) latest.set(l.sub, l);
    const list = [...latest.values()];
    const traders = await this.#traders(owner, list.map((l) => l.sub));
    return list.flatMap((l, i) => (traders[i] ? [{ sub: l.sub, symbol: l.symbol, position: l.position, trader: traders[i]! }] : []));
  }

  /**
   * Cash a wallet can take out of Phoenix now: children with no position left and collateral in
   * them (after a sale, a cash-out, or a liquidation's remainder). Positions still open on a
   * Thesis position aren't counted.
   */
  async sweepable(owner: PublicKey): Promise<{ sub: number; collateral: bigint }[]> {
    return (await this.children(owner)).filter((c) => !c.trader.positions.length && c.trader.collateral > 0n).map((c) => ({ sub: c.sub, collateral: c.trader.collateral }));
  }

  /**
   * Phoenix positions still open whose Thesis position is over (settled at the horizon, or sold
   * while a close failed): the app's "Cash out" closes them. Not a split trade that stopped
   * partway (api/split.ts): its position doesn't exist yet, and a retry may still need the leg.
   * Once it's swept, cash-out closes it.
   */
  async strays(owner: PublicKey): Promise<{ sub: number; symbol: string; baseLots: bigint }[]> {
    const stopped = new Set(Object.keys(this.#store.state.incomplete ?? {}));
    const kids = (await this.children(owner)).filter((c) => c.trader.positions.length && !stopped.has(c.position));
    if (!kids.length) return [];
    const accounts = await this.#program.account.position.fetchMultiple(kids.map((k) => new PublicKey(k.position)));
    return kids.filter((_, i) => !accounts[i] || accounts[i]!.exited).map((k) => ({ sub: k.sub, symbol: k.symbol, baseLots: k.trader.positions[0].baseLots }));
  }

  /** Withdraw legs for everything `sweepable`. */
  async sweepLegs(owner: PublicKey): Promise<VenueLeg[]> {
    const payer = this.#o.appPayer.publicKey;
    return Promise.all((await this.sweepable(owner)).map((s) => this.venue.sweepLeg({ owner, payer, sub: s.sub, collateral: s.collateral, label: `Phoenix child ${s.sub}` })));
  }

  /** Close legs for every stray position. */
  async strayCloseLegs(owner: PublicKey): Promise<VenueLeg[]> {
    const out: VenueLeg[] = [];
    for (const s of await this.strays(owner)) {
      const mid = await this.venue.mid(s.symbol);
      if (!mid) throw new ApiError(422, "no_exit_route", `Phoenix has no price for ${s.symbol} right now.`);
      out.push(await this.venue.closeLeg({ owner, sub: s.sub, symbol: s.symbol, baseLots: s.baseLots, price: mid, label: s.symbol }));
    }
    return out;
  }
}
