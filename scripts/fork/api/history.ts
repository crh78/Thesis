// A wallet's portfolio value over time, for the profile chart: periodic snapshots of USDC plus
// what its positions are worth, kept in the fork API's state.
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Connection } from "@solana/web3.js";
import { USDC_MINT_MAINNET } from "@thesis/chain";
import { ApiError, USD, parseKey, type Snapshot } from "./common.ts";
import type { StateStore } from "./store.ts";

/** A snapshot of each active wallet this often (see `active`), keeping up to MAX_SNAPSHOTS. */
const SNAPSHOT_MS = 5 * 60_000;
const MAX_SNAPSHOTS = 10_000;
/** Snapshots newer than this keep full resolution; older ones are thinned to one an hour. */
const FULL_RESOLUTION_S = 7 * 86_400;
const HOUR_S = 3_600;
/** Points sent per chart, and each range in seconds (0: all time). */
const MAX_POINTS = 120;
const HISTORY_RANGES: Record<string, number> = { "1D": 86_400, "1W": 7 * 86_400, "1M": 30 * 86_400, ALL: 0 };
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Thins old snapshots: everything from the last FULL_RESOLUTION_S stays, and before that the first
 * snapshot of each hour. Charts show at most MAX_POINTS points, so older ranges lose nothing visible.
 */
export function downsample(list: Snapshot[], nowSec: number): Snapshot[] {
  const cutoff = nowSec - FULL_RESOLUTION_S;
  const out: Snapshot[] = [];
  let lastHour: number | null = null;
  for (const s of list) {
    if (s.at >= cutoff) {
      out.push(s);
      continue;
    }
    const hour = Math.floor(s.at / HOUR_S);
    if (hour !== lastHour) out.push(s);
    lastHour = hour;
  }
  return out;
}

/** At most `n` items, evenly spaced, always keeping the first and the last. */
function thin<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const step = (xs.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => xs[Math.round(i * step)]);
}

type HeldPosition = { openedAt: number; stakeUsd: number; costUsd: number | null; valueUsd: number | null };
/** The wallet's open positions, as the portfolio shows them; `strict` fails instead of guessing. */
type PortfolioOf = (addr: string, o: { strict: boolean }) => Promise<{ positions: HeldPosition[] }>;
/** Whether the wallet holds an open position on a take this API knows (no RPC). */
type HoldsOf = (addr: string) => boolean;

export class PortfolioHistory {
  #store: StateStore;
  #connection: Connection;
  #portfolio: PortfolioOf;
  #holds: HoldsOf;
  // Range taps share one wallet read. Cash changes and confirmed trades still
  // write their own fresh snapshots through the existing update paths.
  #reads = new Map<string, Promise<Snapshot>>();
  /** The last value read for wallets whose chart isn't kept (see `active`). */
  #unkept = new Map<string, Snapshot>();

  constructor(store: StateStore, connection: Connection, portfolio: PortfolioOf, holds: HoldsOf = () => false) {
    this.#store = store;
    this.#connection = connection;
    this.#portfolio = portfolio;
    this.#holds = holds;
    // Every wallet with a deposit or an open position gets a value snapshot every few minutes, for its chart.
    setInterval(() => {
      for (const w of Object.keys(store.state.history ?? {})) if (this.active(w)) void this.snapshot(w).catch(() => {});
    }, SNAPSHOT_MS).unref();
  }

  /**
   * A wallet whose chart is kept: it has added play money, or holds an open position. Anyone can
   * read any address's chart, so a read alone never starts one (each kept chart costs a snapshot
   * every few minutes).
   */
  active(addr: string): boolean {
    return this.#deposited(addr) || this.#holds(addr);
  }

  #deposited(addr: string) {
    return this.#store.state.cash.some((c) => c.wallet === addr && c.kind === "deposit");
  }

  /**
   * The wallet's portfolio value over `range` (1D, 1W, 1M, ALL), for the profile chart. Each point
   * is the value at that time plus the deposits made since (minus withdrawals), so adding or taking
   * out cash doesn't move the line: only trades' gains and losses (and fees) do. The last point is
   * the value now. `change` is the move over the range, `changePct` against where it started.
   * History starts with the wallet's first kept snapshot (its first deposit or trade, backfilled
   * from what's known exactly) and resets with the fork. A wallet with neither gets its value now.
   */
  async history(addr: string, range: string) {
    parseKey(addr);
    const key = range.toUpperCase();
    const span = HISTORY_RANGES[key];
    if (!Object.hasOwn(HISTORY_RANGES, key)) throw new ApiError(400, "invalid_range");
    const now = await this.#recentSnapshot(addr);
    const all = this.#store.state.history?.[addr] ?? [now];
    const from = span ? now.at - span : 0;
    // The last snapshot at or before the range's start is its baseline, so a quiet day still has one.
    const firstIn = all.findIndex((s) => s.at >= from);
    const inRange = all.slice(Math.max(0, firstIn - 1));
    const points = thin(inRange, MAX_POINTS).map((s) => ({ at: Math.max(s.at, from), value: round2(s.value - s.netIn + now.netIn) }));
    const start = points[0].value;
    const change = round2(now.value - start);
    return { wallet: addr, range: key, value: round2(now.value), change, changePct: start > 0 ? (change / start) * 100 : 0, points };
  }

  #recentSnapshot(addr: string): Promise<Snapshot> {
    const pending = this.#reads.get(addr);
    if (pending) return pending;
    const recent = this.#store.state.history?.[addr]?.at(-1) ?? this.#unkept.get(addr);
    if (recent && Date.now() / 1000 - recent.at <= 10) return Promise.resolve(recent);
    return this.snapshot(addr);
  }

  /** Takes a fresh snapshot, after any snapshot or wallet update already running for this wallet. */
  snapshot(addr: string): Promise<Snapshot> {
    const previous = this.#reads.get(addr);
    const next = (previous
      ? previous.catch(() => undefined).then(() => this.#store.withWallet(addr, () => this.#record(addr)))
      : this.#store.withWallet(addr, () => this.#record(addr))).finally(() => {
      if (this.#reads.get(addr) === next) this.#reads.delete(addr);
    });
    this.#reads.set(addr, next);
    return next;
  }

  /**
   * Records what the wallet holds now: USDC plus each open position's value (its cost while it has
   * no price yet, so pricing doesn't show as a jump). The newest snapshot replaces one taken less
   * than a minute before it. Only a wallet with a deposit or an open position keeps its snapshots;
   * for any other the value is returned and nothing is saved.
   */
  async #record(addr: string): Promise<Snapshot> {
    const owner = parseKey(addr);
    const ata = getAssociatedTokenAddressSync(USDC_MINT_MAINNET, owner, true);
    const connection = this.#connection;
    const state = this.#store.state;
    const [usdc, { positions }] = await Promise.all([
      connection.getTokenAccountBalance(ata, "confirmed").then((r) => Number(r.value.amount) / USD).catch(async (error: unknown) => {
        if (await connection.getAccountInfo(ata, "confirmed")) throw error;
        return 0;
      }),
      this.#portfolio(addr, { strict: true }),
    ]);
    const held = positions.reduce((sum, p) => sum + (p.valueUsd ?? p.costUsd ?? p.stakeUsd), 0);
    const netIn = state.cash.filter((c) => c.wallet === addr).reduce((sum, c) => sum + (c.kind === "deposit" ? c.usd : -c.usd), 0);
    const snap = { at: Math.floor(Date.now() / 1000), value: usdc + held, netIn };
    if (!positions.length && !this.#deposited(addr)) {
      // Not kept, but reused for a few seconds like a kept one (in memory only).
      if (this.#unkept.size >= 1_000) this.#unkept.clear();
      this.#unkept.set(addr, snap);
      return snap;
    }
    this.#unkept.delete(addr);
    const history = (state.history ??= {});
    let list = (history[addr] ??= []);
    if (!list.length) list.push(...this.#backfill(addr, positions));
    if (list.length && snap.at - list[list.length - 1].at < 60) list[list.length - 1] = snap;
    else list.push(snap);
    // Thin the old part once an hour of it has piled up past the full-resolution window.
    if (list[0].at < snap.at - FULL_RESOLUTION_S - HOUR_S) list = history[addr] = downsample(list, snap.at);
    if (list.length > MAX_SNAPSHOTS) list.splice(0, list.length - MAX_SNAPSHOTS);
    this.#store.save();
    return snap;
  }

  /**
   * A wallet's history before its first snapshot, from what is known exactly: each deposit and
   * withdrawal, and each trade's fee. Until prices move, the wallet is worth what went in less the
   * fees paid (a trade swaps USDC for tokens worth what they cost).
   */
  #backfill(addr: string, positions: HeldPosition[]): Snapshot[] {
    const events = [
      ...this.#store.state.cash.filter((c) => c.wallet === addr).map((c) => ({ at: Math.floor(Date.parse(c.at) / 1000), netIn: c.kind === "deposit" ? c.usd : -c.usd, fee: 0 })),
      ...positions.map((p) => ({ at: p.openedAt, netIn: 0, fee: (p.costUsd ?? p.stakeUsd) - p.stakeUsd })),
    ].sort((x, y) => x.at - y.at);
    const out: Snapshot[] = [];
    let netIn = 0;
    let fees = 0;
    for (const e of events) {
      netIn += e.netIn;
      fees += e.fee;
      const snap = { at: e.at, value: netIn - fees, netIn };
      if (out.length && out[out.length - 1].at === e.at) out[out.length - 1] = snap;
      else out.push(snap);
    }
    return out;
  }
}
