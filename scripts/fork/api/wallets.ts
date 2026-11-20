// Fake USDC in and out of fork wallets (Surfpool cheatcodes), what a wallet holds, and its
// activity: deposits and withdrawals kept locally, plus backs, fades and posts from chain events.
import type BN from "bn.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { PublicKey } from "@solana/web3.js";
import { USDC_MINT_MAINNET, chainSide, thesisTransactionEvents, type ThesisProgram } from "@thesis/chain";
import { ApiError, USD, checkAmount, once, parseKey, type CashEntry, type ChainActivity, type ServiceOpts } from "./common.ts";
import type { StateStore } from "./store.ts";

const ACTIVITY_CACHE_MS = 60_000;
/** How long a wallet read is reused (see `Wallets.wallet`). */
const WALLET_CACHE_MS = 8_000;
/** Cache size past which expired entries are dropped. */
const CACHE_SWEEP_AT = 1_000;

type WalletView = {
  wallet: string;
  usdc: number;
  depositCapUsd: number | null;
  depositLeftUsd: number | null;
  holdings: { mint: string; symbol: string | null; underlying: string | null; amount: number }[];
  activity: (ChainActivity | (CashEntry & { takeId: null; signature: null }))[];
};

/**
 * Play money per account on the public fork: $1,000 added in total, ever, with
 * no top-ups. `FORK_DEPOSIT_CAP_USD` changes it (0: no cap).
 */
export const DEPOSIT_CAP_USD = Number(process.env.FORK_DEPOSIT_CAP_USD ?? 1000);

/**
 * Wallets with their own cap (the team's accounts; owner's decision 2026-11-19):
 * FORK_DEPOSIT_CAP_OVERRIDES="<wallet>=10000,<wallet>=5000". Anything unreadable is ignored.
 */
export function parseCapOverrides(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (raw ?? "").split(",")) {
    const [wallet, usd] = part.split("=").map((x) => x?.trim());
    const n = Number(usd);
    if (wallet && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet) && Number.isFinite(n) && n >= 0) out.set(wallet, n);
  }
  return out;
}
const CAP_OVERRIDES = parseCapOverrides(process.env.FORK_DEPOSIT_CAP_OVERRIDES);

/** This wallet's play-money cap (0: no cap). */
export const depositCapFor = (addr: string, overrides = CAP_OVERRIDES, base = DEPOSIT_CAP_USD) => overrides.get(addr) ?? base;

export class Wallets {
  #o: ServiceOpts;
  #store: StateStore;
  #program: ThesisProgram;
  /** Called after a deposit or withdrawal, to take a fresh chart snapshot. */
  #changed: (addr: string) => Promise<unknown>;
  /** Whether a take is inverted (its on-chain fade agrees with it), so activity reads take-relative. */
  #inverted: (take: PublicKey) => Promise<boolean>;
  /**
   * A wallet's trades from chain events, cached: getSignaturesForAddress takes about a second on
   * Surfpool, and a fork wallet's trades only change through trades this API sends, which clear
   * the entry (`forgetActivity`).
   */
  #chainActivity = new Map<string, { at: number; value: ChainActivity[] }>();

  constructor(o: ServiceOpts, store: StateStore, program: ThesisProgram, changed: (addr: string) => Promise<unknown>, inverted: (take: PublicKey) => Promise<boolean> = async () => false) {
    this.#o = o;
    this.#store = store;
    this.#program = program;
    this.#changed = changed;
    this.#inverted = inverted;
  }

  /** Clears what's cached about the wallet: a trade or a cash change just moved its balances. */
  forgetActivity(owner: string) {
    this.#chainActivity.delete(owner);
    this.#wallets.delete(owner);
  }

  /**
   * USDC, holdings and activity, cached WALLET_CACHE_MS and read once at a time per wallet: each
   * read is a few RPC calls that Surfpool forwards to its mainnet datasource (Helius credits), and
   * the apps poll it. Trades and cash changes clear the entry (`forgetActivity`).
   */
  wallet(addr: string) {
    parseKey(addr);
    const now = Date.now();
    const hit = this.#wallets.get(addr);
    if (hit && hit.at > now - WALLET_CACHE_MS) return hit.value;
    if (this.#wallets.size >= CACHE_SWEEP_AT) this.#sweep(now);
    const value = this.#readWallet(addr);
    const entry = { at: now, value };
    this.#wallets.set(addr, entry);
    value.catch(() => {
      if (this.#wallets.get(addr) === entry) this.#wallets.delete(addr);
    });
    return value;
  }
  #wallets = new Map<string, { at: number; value: Promise<WalletView> }>();

  /** Drops expired cache entries, so addresses read once don't stay in memory. */
  #sweep(now: number) {
    for (const [k, v] of this.#wallets) if (v.at <= now - WALLET_CACHE_MS) this.#wallets.delete(k);
    for (const [k, v] of this.#chainActivity) if (v.at <= now - ACTIVITY_CACHE_MS) this.#chainActivity.delete(k);
  }

  /** The wallet read itself (see `wallet`). */
  async #readWallet(addr: string): Promise<WalletView> {
    const owner = parseKey(addr);
    const conn = this.#o.connection;
    const [accounts, activity] = await Promise.all([
      // Surfpool asks its mainnet datasource for these, which can fail transiently: once more.
      Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) => once(() => conn.getParsedTokenAccountsByOwner(owner, { programId })))),
      this.#activity(owner),
    ]);
    const tokens = this.#o.bank().tokens;
    const holdings = accounts
      .flatMap((r) => r.value)
      .map((a) => a.account.data.parsed.info as { mint: string; tokenAmount: { amount: string; uiAmount: number; decimals: number } })
      .filter((i) => i.tokenAmount.amount !== "0");
    const usdc = holdings.find((h) => h.mint === USDC_MINT_MAINNET.toBase58());
    const cap = depositCapFor(addr);
    return {
      wallet: addr,
      usdc: usdc ? usdc.tokenAmount.uiAmount : 0,
      // Play money left to add (null: no cap).
      depositCapUsd: cap > 0 ? cap : null,
      depositLeftUsd: cap > 0 ? Math.max(0, cap - this.depositedUsd(addr)) : null,
      holdings: holdings
        .filter((h) => h.mint !== USDC_MINT_MAINNET.toBase58())
        .map((h) => ({ mint: h.mint, symbol: tokens[h.mint]?.symbol ?? null, underlying: tokens[h.mint]?.underlying ?? null, amount: h.tokenAmount.uiAmount })),
      activity,
    };
  }

  /** Fake USDC this wallet has added, ever (withdrawals don't give room back). */
  depositedUsd(addr: string) {
    return this.#store.state.cash.filter((c) => c.wallet === addr && c.kind === "deposit").reduce((sum, c) => sum + c.usd, 0);
  }

  deposit(addr: string, usd: number) {
    return this.#updateCash(addr, usd, "deposit");
  }

  withdraw(addr: string, usd: number) {
    return this.#updateCash(addr, usd, "withdrawal");
  }

  async #updateCash(addr: string, usd: number, kind: CashEntry["kind"]) {
    const owner = parseKey(addr);
    checkAmount(usd, 1);
    await this.#store.withWallet(addr, async () => {
      if (kind === "deposit") {
        const added = this.depositedUsd(addr);
        const cap = depositCapFor(addr);
        if (cap > 0 && added + usd > cap + 1e-9) {
          const left = Math.max(0, cap - added);
          throw new ApiError(403, "deposit_cap", left > 0
            ? `Play money is capped at $${cap} per account. You can add $${left.toFixed(2)} more.`
            : `You've added the $${cap} of play money each account gets.`);
        }
        await this.#o.fork.addUsdc(owner, usd);
      } else {
        const ata = getAssociatedTokenAddressSync(USDC_MINT_MAINNET, owner, true);
        const bal = await this.#o.connection.getTokenAccountBalance(ata, "confirmed").then((r) => BigInt(r.value.amount)).catch(() => 0n);
        const out = BigInt(Math.round(usd * USD));
        if (out > bal) throw new ApiError(400, "insufficient_funds");
        await this.#o.fork.setUsdc(owner, bal - out);
      }
      this.#store.state.cash.push({ wallet: addr, kind, usd, at: new Date().toISOString() });
      // Written now, not debounced: the USDC is minted, and losing its record to a crash would
      // let the wallet past the deposit cap.
      this.#store.saveNow();
      this.#wallets.delete(addr);
    });
    // The chart snapshot runs in the background: on a wallet's first deposit it reads every take's
    // positions, which made that deposit take 4-7 s.
    void this.#changed(addr).catch(() => {});
    return this.wallet(addr);
  }

  /** Deposits and withdrawals (fork cheatcodes, kept locally) plus backs, fades and posts from chain events. */
  async #activity(owner: PublicKey) {
    const key = owner.toBase58();
    let hit = this.#chainActivity.get(key);
    if (!hit || hit.at < Date.now() - ACTIVITY_CACHE_MS) {
      hit = { at: Date.now(), value: await this.#chainActivityOf(owner) };
      this.#chainActivity.set(key, hit);
    }
    const chain = hit.value;
    const cash = this.#store.state.cash.filter((c) => c.wallet === key).map((c) => ({ ...c, takeId: null, signature: null }));
    return [...chain, ...cash].sort((a, b) => b.at.localeCompare(a.at));
  }

  /**
   * The wallet's backs, fades and posts. `kind` is take-relative, as the API's sides are: "back"
   * agrees with the take, so a fade of an inverted take (and its author's buy-in) reads "back".
   */
  async #chainActivityOf(owner: PublicKey): Promise<ChainActivity[]> {
    const conn = this.#o.connection;
    const byAddress = new Map(Object.entries(this.#store.state.takes).map(([id, m]) => [m.address, id]));
    const sigs = await conn.getSignaturesForAddress(owner, { limit: 30 }, "confirmed").catch(() => []);
    const chain: ChainActivity[] = [];
    const ok = sigs.filter((s) => !s.err);
    // One batched RPC request for every transaction instead of one round trip each.
    const txs = ok.length
      ? await conn.getTransactions(ok.map((s) => s.signature), { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => [])
      : [];
    const opened: { take: PublicKey; side: "back" | "fade"; usd: number; at: string; signature: string }[] = [];
    for (const [i, s] of ok.entries()) {
      const tx = txs[i];
      for (const e of thesisTransactionEvents(this.#program, tx)) {
        const d = e.data as { owner?: PublicKey; take?: PublicKey; stake?: BN; side?: object };
        if (e.name !== "positionOpened" || !d.owner?.equals(owner) || !d.take) continue;
        const at = new Date((s.blockTime ?? 0) * 1000).toISOString();
        opened.push({ take: d.take, side: d.side && "fade" in d.side ? "fade" : "back", usd: (d.stake?.toNumber() ?? 0) / USD, at, signature: s.signature });
      }
    }
    // Which of those takes are inverted (one read each, kept by the service); unreadable: as literal.
    const takes = [...new Map(opened.map((o) => [o.take.toBase58(), o.take])).values()];
    const inverted = new Map(await Promise.all(takes.map(async (t) => [t.toBase58(), await this.#inverted(t).catch(() => false)] as const)));
    for (const o of opened) {
      const take = o.take.toBase58();
      chain.push({ kind: chainSide(o.side, { inverted: inverted.get(take) }), usd: o.usd, at: o.at, takeId: byAddress.get(take) ?? null, signature: o.signature });
    }
    return chain;
  }
}
