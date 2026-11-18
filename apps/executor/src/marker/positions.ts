// Open on-chain positions, live: the program's own return formula (positionReturnBps) on the
// entry prices the settler signed into the Position account, with live prices as exits. Each
// exit is what the settler would sign for that leg and side now: a back's spot leg on its token
// (or stock), a fade's spot and perp legs on the Phoenix short it holds (heldOnPhoenix), a
// prediction on the held side's bid (a fade holds the other side), yield on jlUSDC's share value.
import { Connection, PublicKey } from "@solana/web3.js";
import { positionReturnBps, thesisProgram } from "@thesis/chain";
import { effectiveMultiplier } from "@thesis/venues/bank";
import { toPriceUnits, valueLeg, type LegValue } from "../settler/leg-value.ts";
import type { BankLookup, PickAsset, Snapshot } from "./mark.ts";

/** USD per underlying unit the settler would sign as this leg's exit now, or null (the shared rules: valueLeg). */
export function positionExit(asset: PickAsset, side: "back" | "fade", snap: Snapshot, bank: BankLookup | null, openedAtSec: number | null): number | null {
  switch (asset.type) {
    case "void":
      return null;
    case "yield":
      return priceOf(valueLeg({ kind: "yield", held: side }, { lendShareValue: snap.lend }));
    // A card leg (never faded): its insured value as the asset bank last read it.
    case "card":
      return priceOf(valueLeg({ kind: "card", held: side }, { cardInsuredUsd: snap.cards?.get(asset.cardId) }));
    case "prediction": {
      const contract = snap.events.get(asset.eventTicker)?.find((x) => x.instrumentSymbol === asset.instrument);
      return priceOf(valueLeg({ kind: "prediction", held: side, prediction: { side: asset.side } }, { contract }));
    }
    case "perp":
      return priceOf(valueLeg({ kind: "perp", held: side, perp: { unitsPerContract: asset.units } }, { perp: snap.perps.get(asset.symbol)?.price }));
    case "spot": {
      if (side === "fade") {
        // A fade's spot leg is a Phoenix short on the same underlying.
        const perp = asset.underlyingKey ? bank?.perpFor(asset.underlyingKey) : null;
        if (!perp) return null;
        return priceOf(valueLeg({ kind: "spot", held: "fade", perp: { unitsPerContract: perp.unitsPerContract } }, { perp: snap.perps.get(perp.symbol)?.price }));
      }
      // The entry was signed in the terms of the multiplier then (the audit log has the exact one;
      // the multiplier in force when the position opened is the same unless it changed that minute).
      const live = snap.tokens.get(asset.mint)?.scaledUi;
      const cfg = live !== undefined ? live : asset.scaledUi;
      const scale = cfg === undefined || openedAtSec === null ? 1 : effectiveMultiplier(cfg, snap.nowSec) / effectiveMultiplier(cfg, openedAtSec);
      const stock = asset.stock ? snap.stocks.get(asset.stock)?.price : undefined;
      return priceOf(valueLeg({ kind: "spot", held: "back", spot: { perUi: asset.perUi, basis: null, scale } }, { token: snap.tokens.get(asset.mint), stock }));
    }
  }
}

const priceOf = (v: LegValue): number | null => (v.ok ? v.price : null);

export type ChainLeg = { kind: object; weightBps: number; leverage: number };
export type ChainPosition = { side: object; legsMask: number; entrySet: number; entries: bigint[] };

/** The position's live return in bps, or null if an included leg has no entry price or no exit now. */
export function positionLiveBps(legs: ChainLeg[], p: ChainPosition, exits: (number | null)[]): number | null {
  const prices: { entry: bigint; exit: bigint }[] = [];
  for (let i = 0; i < legs.length; i++) {
    const included = (p.legsMask & (1 << i)) !== 0;
    if (!included) {
      prices.push({ entry: 0n, exit: 0n });
      continue;
    }
    const exit = exits[i];
    if ((p.entrySet & (1 << i)) === 0 || exit === null || exit === undefined || !(exit >= 0)) return null;
    prices.push({ entry: p.entries[i] ?? 0n, exit: toPriceUnits(exit) });
  }
  return positionReturnBps(legs as any, { side: p.side, legsMask: p.legsMask, prices });
}

/** getMultipleAccounts' limit: one call reads up to 100 accounts. */
export const READ_BATCH = 100;
/** How long an address found missing is skipped before the next full check reads it again. */
export const FULL_CHECK_MS = 60 * 60_000;
/** A position opened this recently isn't recorded as missing: the RPC may not show it yet. */
export const FRESH_MS = 10 * 60_000;

/**
 * Addresses the chain didn't have, skipped until the next full check (hourly). The fork's RPC
 * (Surfpool) never caches a missing account: every read of one goes on to its mainnet source
 * (Helius) and costs a credit. After a reset, `chain_positions` still lists the old fork's
 * positions, and reading them all every run cost ~2,600 credits an hour.
 */
export class MissingAccounts {
  readonly fullCheckMs: number;
  #now: () => number;
  #missing = new Set<string>();
  #checkedAt = Number.NEGATIVE_INFINITY;

  constructor(fullCheckMs = FULL_CHECK_MS, now: () => number = Date.now) {
    this.fullCheckMs = fullCheckMs;
    this.#now = now;
  }

  /** Call once per run: when a full check is due, forgets every miss so all are read again. */
  startRun(): boolean {
    const now = this.#now();
    if (now - this.#checkedAt < this.fullCheckMs) return false;
    this.#missing.clear();
    this.#checkedAt = now;
    return true;
  }

  has(address: string): boolean {
    return this.#missing.has(address);
  }

  add(address: string): void {
    this.#missing.add(address);
  }

  get size(): number {
    return this.#missing.size;
  }
}

/**
 * Reads accounts by address, READ_BATCH per call, decoded. Addresses known to be missing are
 * skipped; ones the chain doesn't have, or that don't decode as this account, are recorded as
 * missing, except `fresh` ones (just opened: the RPC may not show them yet). Returns what was
 * found, by address.
 */
export async function readBatched<T>(
  addresses: string[],
  fetch: (keys: string[]) => Promise<(Buffer | null)[]>,
  decode: (data: Buffer) => T,
  missing: MissingAccounts,
  fresh: ReadonlySet<string> = new Set(),
): Promise<Map<string, T>> {
  const todo = [...new Set(addresses)].filter((a) => !missing.has(a));
  const out = new Map<string, T>();
  for (let i = 0; i < todo.length; i += READ_BATCH) {
    const keys = todo.slice(i, i + READ_BATCH);
    const datas = await fetch(keys);
    keys.forEach((key, j) => {
      const data = datas[j];
      const miss = () => (fresh.has(key) ? undefined : missing.add(key));
      if (!data) return miss();
      try {
        out.set(key, decode(data));
      } catch {
        miss(); // not this kind of account
      }
    });
  }
  return out;
}

export type ChainReads = { positions: Map<string, ChainPosition>; takes: Map<string, ChainLeg[]> };

/** Reads Take and Position accounts in batches; null when the RPC is down. */
export async function chainReader(rpcUrl: string, missing: MissingAccounts) {
  const conn = new Connection(rpcUrl, "confirmed");
  const up = await Promise.race([conn.getSlot().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3_000))]).catch(() => false);
  if (!up) return null;
  const program = thesisProgram(conn);
  const fetch = async (keys: string[]) =>
    (await conn.getMultipleAccountsInfo(keys.map((k) => new PublicKey(k)), "confirmed")).map((a) => (a && a.owner.equals(program.programId) ? a.data : null));
  // The coder takes the camelCase account name ("position"), not the IDL's "Position".
  const decode = (name: "position" | "take") => (data: Buffer) => program.coder.accounts.decode(name, data);
  return {
    /** These positions and takes, by address; the ones the chain doesn't have are absent. `fresh`:
     * addresses not to record as missing yet (just opened). */
    async load(positionAddresses: string[], takeAddresses: string[], fresh: ReadonlySet<string> = new Set()): Promise<ChainReads> {
      const [p, t] = await Promise.all([
        readBatched(positionAddresses, fetch, decode("position"), missing, fresh),
        readBatched(takeAddresses, fetch, decode("take"), missing, fresh),
      ]);
      const positions = new Map<string, ChainPosition>();
      for (const [k, a] of p as Map<string, any>) positions.set(k, { side: a.side, legsMask: a.legsMask, entrySet: a.entrySet, entries: a.prices.map((x: any) => BigInt(x.entry.toString())) });
      const takes = new Map<string, ChainLeg[]>();
      for (const [k, a] of t as Map<string, any>) takes.set(k, a.legs.map((l: any) => ({ kind: l.kind, weightBps: l.weightBps, leverage: l.leverage })));
      return { positions, takes };
    },
  };
}
