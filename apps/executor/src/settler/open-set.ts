// What the settler loads each tick: the open positions, their takes and exits.
//
// Scanning every program account each tick (getProgramAccounts) is fine at dogfood scale and
// slow past it. So the open set comes from the database the Stream fills: `chain_positions`
// (one row per on-chain position, kept from chain_events) lists positions not yet settled, and
// the settler fetches just those accounts, their takes and their exits by address. A full scan
// still runs every 10 minutes and on the first tick, as a backstop for
// anything the Stream missed or hasn't delivered yet; what it finds stays in the set until its
// account closes (settle_position closes positions) or its take settles.
//
// Partial sales (`sell_part`) are read by address too: a position's unsettled ones are seqs
// `partsSettled` to `parts - 1`, each at its PDA. The full scan reads every part account as well.
import { PublicKey } from "@solana/web3.js";
import {
  exitAddress,
  partSaleAddress,
  type ExitAccount,
  type PartSaleAccount,
  type PositionAccount,
  type TakeAccount,
  type ThesisProgram,
} from "@thesis/chain";

export type Keyed<T> = { publicKey: PublicKey; account: T };
export type Loaded = {
  positions: Keyed<PositionAccount>[];
  takes: Map<string, TakeAccount>;
  exits: Map<string, ExitAccount>;
  /** Each position's unsettled partial sales (base58 position → parts in seq order). */
  parts: Map<string, Keyed<PartSaleAccount>[]>;
};

/** A position's partial sales still waiting to settle, as seqs (they settle in this order). */
export function openPartSeqs(p: PositionAccount): number[] {
  const out: number[] = [];
  for (let s = p.partsSettled ?? 0; s < (p.parts ?? 0); s++) out.push(s);
  return out;
}

function groupParts(parts: Keyed<PartSaleAccount>[]): Map<string, Keyed<PartSaleAccount>[]> {
  const out = new Map<string, Keyed<PartSaleAccount>[]>();
  for (const part of parts) {
    const key = part.account.position.toBase58();
    out.set(key, [...(out.get(key) ?? []), part]);
  }
  for (const list of out.values()) list.sort((a, b) => a.account.seq - b.account.seq);
  return out;
}

/** Positions the database says are still open (address and take, base58). */
export interface OpenPositionsSource {
  readonly name: string;
  open(): Promise<{ position: string; take: string }[]>;
}

/** `chain_positions` rows with no settlement yet, on one network, through Supabase's REST API. */
export class SupabaseOpenPositions implements OpenPositionsSource {
  readonly name: string;
  #url: string;
  #key: string;
  #network: string;
  #fetch: typeof fetch;

  constructor(o: { url: string; key: string; network: string; fetch?: typeof fetch }) {
    this.#url = o.url.replace(/\/$/, "");
    this.#key = o.key;
    this.#network = o.network;
    this.#fetch = o.fetch ?? fetch;
    this.name = `chain_positions (${o.network})`;
  }

  async open(): Promise<{ position: string; take: string }[]> {
    const out: { position: string; take: string }[] = [];
    const page = 1_000;
    for (let from = 0; ; from += page) {
      const q = new URLSearchParams({ select: "address,take", network: `eq.${this.#network}`, settled_at: "is.null", order: "address" });
      const res = await this.#fetch(`${this.#url}/rest/v1/chain_positions?${q}`, {
        headers: { apikey: this.#key, authorization: `Bearer ${this.#key}`, range: `${from}-${from + page - 1}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`chain_positions: ${res.status} ${(await res.text()).slice(0, 200)}`);
      const rows = (await res.json()) as { address: string; take: string }[];
      out.push(...rows.map((r) => ({ position: r.address, take: r.take })));
      if (rows.length < page) return out;
    }
  }
}

/** How the set reads the chain: a full scan, or accounts by address. `ThesisProgram` provides both. */
export type ChainReader = {
  allPositions(): Promise<Keyed<PositionAccount>[]>;
  allTakes(): Promise<Keyed<TakeAccount>[]>;
  allExits(): Promise<Keyed<ExitAccount>[]>;
  allPartSales(): Promise<Keyed<PartSaleAccount>[]>;
  positions(keys: PublicKey[]): Promise<(PositionAccount | null)[]>;
  takes(keys: PublicKey[]): Promise<(TakeAccount | null)[]>;
  exits(keys: PublicKey[]): Promise<(ExitAccount | null)[]>;
  partSales(keys: PublicKey[]): Promise<(PartSaleAccount | null)[]>;
};

export function programReader(program: ThesisProgram): ChainReader {
  const a = program.account;
  return {
    allPositions: () => a.position.all() as Promise<Keyed<PositionAccount>[]>,
    allTakes: () => a.take.all() as Promise<Keyed<TakeAccount>[]>,
    allExits: () => a.exit.all() as Promise<Keyed<ExitAccount>[]>,
    allPartSales: () => a.partSale.all() as Promise<Keyed<PartSaleAccount>[]>,
    positions: (k) => (k.length ? (a.position.fetchMultiple(k) as Promise<(PositionAccount | null)[]>) : Promise.resolve([])),
    takes: (k) => (k.length ? (a.take.fetchMultiple(k) as Promise<(TakeAccount | null)[]>) : Promise.resolve([])),
    exits: (k) => (k.length ? (a.exit.fetchMultiple(k) as Promise<(ExitAccount | null)[]>) : Promise.resolve([])),
    partSales: (k) => (k.length ? (a.partSale.fetchMultiple(k) as Promise<(PartSaleAccount | null)[]>) : Promise.resolve([])),
  };
}

/** Not settled yet: open, or closed by its author's sale and waiting for `settle_take`. */
const isOpen = (t: TakeAccount) => !("settled" in t.status);

export class OpenSet {
  #chain: ChainReader;
  #source: OpenPositionsSource | null;
  #fullScanMs: number;
  #now: () => number;
  #log: (line: string) => void;
  #programId: PublicKey;
  #lastFullScan = -Infinity;
  /** Open positions and unsettled takes known so far, base58. */
  #positions = new Set<string>();
  #takes = new Set<string>();
  #exitOf = new Map<string, PublicKey>();
  /** Positions the database lists that held nothing when read: settled, or rows from an earlier
   * fork. Skipped until the next full scan, so they aren't read every tick. */
  #gone = new Set<string>();
  /** Whether the last `load` was a full scan (badges check every profile then). */
  fullScan = false;
  /** Positions seen before, so a new one's owner can be reported once. */
  #seen = new Set<string>();
  /** Owners of positions first seen since the last `takeNewOwners` (a new take earns a badge at once). */
  #newOwners = new Map<string, PublicKey>();

  constructor(o: {
    chain: ChainReader;
    programId: PublicKey;
    source?: OpenPositionsSource | null;
    fullScanEverySecs?: number;
    /** false: the first tick reads the database too (tests of the database path). */
    initialScan?: boolean;
    now?: () => number;
    log?: (line: string) => void;
  }) {
    this.#chain = o.chain;
    this.#programId = o.programId;
    this.#source = o.source ?? null;
    this.#fullScanMs = (o.fullScanEverySecs ?? 600) * 1000;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? (() => {});
    if (o.initialScan === false) this.#lastFullScan = this.#now();
  }

  /**
   * The open positions, their takes and their exits. `refresh` (the tick's first load) reads the
   * database's open set, or runs the full scan when it's due; later loads in the same tick re-read
   * the same accounts after the tick's transactions.
   */
  async load(refresh: boolean): Promise<Loaded> {
    if (!this.#source || (refresh && this.#now() - this.#lastFullScan >= this.#fullScanMs)) return this.#scan();
    this.fullScan = false;
    if (refresh) {
      try {
        for (const { position, take } of await this.#source.open()) {
          if (this.#gone.has(position)) continue;
          this.#positions.add(position);
          this.#takes.add(take);
        }
      } catch (e) {
        // The set from earlier ticks still works, and the next full scan catches anything new.
        this.#log(`open positions from ${this.#source.name} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return this.#fetch();
  }

  async #scan(): Promise<Loaded> {
    const [positions, all, sold, parts] = await Promise.all([
      this.#chain.allPositions(),
      this.#chain.allTakes(),
      this.#chain.allExits(),
      this.#chain.allPartSales(),
    ]);
    this.#lastFullScan = this.#now();
    this.fullScan = true;
    this.#gone.clear();
    // Positions close when they settle, so every position account is open.
    this.#positions = new Set(positions.map((p) => p.publicKey.toBase58()));
    // The scan's badge check covers every profile: nothing new to report.
    this.#seen = new Set(this.#positions);
    this.#newOwners.clear();
    this.#takes = new Set(all.filter((t) => isOpen(t.account)).map((t) => t.publicKey.toBase58()));
    return {
      positions,
      takes: new Map(all.map((t) => [t.publicKey.toBase58(), t.account])),
      exits: new Map(sold.map((e) => [e.account.position.toBase58(), e.account])),
      parts: groupParts(parts),
    };
  }

  async #fetch(): Promise<Loaded> {
    const keys = [...this.#positions].map((k) => new PublicKey(k));
    const exitKeys = keys.map((k) => this.#exitAddress(k));
    const [accounts, exitAccounts] = await Promise.all([this.#chain.positions(keys), this.#chain.exits(exitKeys)]);
    const positions: Keyed<PositionAccount>[] = [];
    const exits = new Map<string, ExitAccount>();
    for (const [i, account] of accounts.entries()) {
      const key = keys[i].toBase58();
      // Settled (closed), or a row from an earlier fork at an address that holds nothing here.
      if (!account) {
        this.#positions.delete(key);
        this.#exitOf.delete(key);
        this.#gone.add(key);
        continue;
      }
      positions.push({ publicKey: keys[i], account });
      this.#takes.add(account.take.toBase58());
      if (!this.#seen.has(key)) {
        this.#seen.add(key);
        this.#newOwners.set(account.owner.toBase58(), account.owner);
      }
      const exit = exitAccounts[i];
      if (exit) exits.set(key, exit);
    }
    const partKeys = positions.flatMap(({ publicKey, account }) => openPartSeqs(account).map((seq) => partSaleAddress(publicKey, seq, this.#programId)));
    const takeKeys = [...this.#takes].map((k) => new PublicKey(k));
    const [takeAccounts, partAccounts] = await Promise.all([this.#chain.takes(takeKeys), this.#chain.partSales(partKeys)]);
    const parts = groupParts(partAccounts.flatMap((account, i) => (account ? [{ publicKey: partKeys[i], account }] : [])));
    const takes = new Map<string, TakeAccount>();
    const referenced = new Set(positions.map((p) => p.account.take.toBase58()));
    for (const [i, account] of takeAccounts.entries()) {
      const key = takeKeys[i].toBase58();
      if (!account) {
        this.#takes.delete(key);
        continue;
      }
      takes.set(key, account);
      // A settled take with no open position has nothing left to do.
      if (!isOpen(account) && !referenced.has(key)) this.#takes.delete(key);
    }
    return { positions, takes, exits, parts };
  }

  #exitAddress(position: PublicKey): PublicKey {
    const key = position.toBase58();
    let exit = this.#exitOf.get(key);
    if (!exit) {
      exit = exitAddress(position, this.#programId);
      this.#exitOf.set(key, exit);
    }
    return exit;
  }

  /** Owners of positions first seen since the last call. */
  takeNewOwners(): PublicKey[] {
    const out = [...this.#newOwners.values()];
    this.#newOwners.clear();
    return out;
  }

  /** How many positions and takes the set is tracking. */
  get size() {
    return { positions: this.#positions.size, takes: this.#takes.size };
  }
}
