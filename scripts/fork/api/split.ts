// Split trades that stop partway (owner decision: "retry, and if that fails, sweep").
//
// A create_take, back or fade too big for one transaction is a short sequence; each transaction is
// a proof-of-trade bracket on the position's trade ticket (anchor/programs/thesis/src/proof.rs),
// and the receipt in the last one checks the ticket and closes it. When a later transaction fails
// after an earlier one landed, the owner holds what the landed part bought, the ticket stays open,
// and no position exists. Then:
//
// 1. Retry (once): the legs that didn't land are built again with fresh quotes and a fresh
//    blockhash, opening with trade_step on the same ticket (the landed brackets still count), with
//    the same receipt last. The owner signs again.
// 2. Sweep: when the retry fails too (or can't be built), the tokens the landed brackets bought
//    (the ticket's `received` per leg) swap back to USDC through Jupiter, vault shares are
//    redeemed, and the same build cancels the ticket (its rent goes back to the app's fee payer).
//    Phoenix legs go through `phoenix/cash-out`, which treats them as strays.
//
// Incomplete trades are kept in the state file until a retry or a sweep lands, or for a week; the
// abandoned-ticket cleanup leaves their tickets alone meanwhile. This module also decides when a
// wallet's abandoned tickets are looked for (a getProgramAccounts): when one is known, or at most
// every TICKET_SCAN_MS per wallet.
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { IncompleteTrade } from "./common.ts";
import type { StateStore } from "./store.ts";

/** How long an incomplete trade can be retried or swept here. */
export const INCOMPLETE_TTL_MS = 7 * 24 * 60 * 60_000;
/** How often a wallet's builds look for its abandoned trade tickets when none is known. */
export const TICKET_SCAN_MS = 30 * 60_000;

/**
 * After the first `landed` transactions of a split trade landed: the take legs a retry builds
 * again (all their venue legs were in transactions that didn't land), and whether a take leg sat
 * on both sides of the failure (a Phoenix deposit landed but its order didn't), which rules a
 * retry out. `txLegs`: per transaction, the take leg of each venue leg in it.
 */
export function afterFailure(txLegs: number[][], landed: number): { remaining: number[]; split: boolean } {
  // -1: a venue leg that buys no take leg (none today).
  const done = new Set(txLegs.slice(0, landed).flat().filter((l) => l >= 0));
  const left = new Set(txLegs.slice(landed).flat().filter((l) => l >= 0));
  const split = [...left].some((l) => done.has(l));
  return { remaining: [...left].filter((l) => !done.has(l)).sort((a, b) => a - b), split };
}

export function serializeIx(ix: TransactionInstruction): IncompleteTrade["receipt"] {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data).toString("base64"),
  };
}

export function deserializeIx(ix: IncompleteTrade["receipt"]): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });
}

/** The fields of a trade ticket a sweep reads (anchor's camelCase decoding). */
export type TicketView = {
  outputs: PublicKey[];
  grown: number;
  phoenix: number;
  named: number;
  received: { toString(): string }[];
};

/**
 * What a sweep sells back: each leg whose output grew inside a landed bracket, by what it grew
 * (the ticket's `received`), except Phoenix legs (cash-out handles those) and legs an earlier
 * sweep already sold.
 */
export function sweepLegs(ticket: TicketView, trade: Pick<IncompleteTrade, "lend" | "swept">) {
  const out: { leg: number; account: PublicKey; amount: bigint; lend: boolean }[] = [];
  for (let i = 0; i < ticket.outputs.length; i++) {
    const bit = 1 << i;
    if (!(ticket.grown & bit) || ticket.phoenix & bit || trade.swept?.includes(i)) continue;
    const amount = BigInt(ticket.received[i].toString());
    if (amount > 0n) out.push({ leg: i, account: ticket.outputs[i], amount, lend: trade.lend.includes(i) });
  }
  return out;
}

/** What a client sees of an incomplete trade (in `trade_incomplete` errors and GET .../incomplete). */
export function incompleteView(position: string, t: IncompleteTrade) {
  return {
    position,
    take: t.take,
    takeId: t.takeId,
    side: t.side,
    usd: t.usd,
    /** "retry": POST /wallets/:address/retry { position }; "sweep": POST /wallets/:address/sweep { position }. */
    next: t.next,
    landed: t.signatures.length,
    signatures: t.signatures,
    at: new Date(t.at).toISOString(),
  };
}

export class SplitTrades {
  #store: StateStore;
  #now: () => number;
  /** Wallet → when its abandoned tickets were last looked for. */
  #scans = new Map<string, number>();
  /** Wallets known to have an abandoned ticket (look on their next build). */
  #suspects = new Set<string>();

  constructor(store: StateStore, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
  }

  get #all(): Record<string, IncompleteTrade> {
    return (this.#store.state.incomplete ??= {});
  }

  /** Drops trades past INCOMPLETE_TTL_MS; their tickets become ordinary abandoned ones. */
  #prune() {
    const now = this.#now();
    for (const [position, t] of Object.entries(this.#store.state.incomplete ?? {})) {
      if (t.at > now - INCOMPLETE_TTL_MS) continue;
      delete this.#all[position];
      this.#suspects.add(t.owner);
      this.#store.save();
    }
  }

  /** The owner's incomplete trade at `position`, or null. */
  get(owner: string, position: string): IncompleteTrade | null {
    this.#prune();
    const t = this.#store.state.incomplete?.[position];
    return t && t.owner === owner ? t : null;
  }

  /** The owner's incomplete trades, newest first. */
  list(owner: string): [string, IncompleteTrade][] {
    this.#prune();
    return Object.entries(this.#store.state.incomplete ?? {}).filter(([, t]) => t.owner === owner).sort((a, b) => b[1].at - a[1].at);
  }

  /** Every position with an incomplete trade: the cleanup must not cancel their tickets. */
  positions(): Set<string> {
    this.#prune();
    return new Set(Object.keys(this.#store.state.incomplete ?? {}));
  }

  /** Records (or updates) an incomplete trade, and writes the state file now. */
  set(position: string, t: IncompleteTrade) {
    this.#all[position] = t;
    this.#store.saveNow();
  }

  /** Forgets an incomplete trade: it finished, or its ticket is gone (a sweep cancelled it). */
  delete(position: string) {
    if (!this.#store.state.incomplete?.[position]) return;
    delete this.#all[position];
    this.#store.save();
  }

  /** Whether the owner's build should look for abandoned tickets now. */
  scanDue(owner: string): boolean {
    return this.#suspects.has(owner) || (this.#scans.get(owner) ?? -Infinity) <= this.#now() - TICKET_SCAN_MS;
  }

  /** Notes a scan of the owner's tickets. */
  scanned(owner: string) {
    const now = this.#now();
    this.#scans.set(owner, now);
    this.#suspects.delete(owner);
    // Bound memory: entries past their window say nothing a missing one doesn't.
    if (this.#scans.size > 10_000) for (const [k, at] of this.#scans) if (at <= now - TICKET_SCAN_MS) this.#scans.delete(k);
  }

  /** The owner has an abandoned ticket (a cleanup that didn't land): look again on the next build. */
  suspect(owner: string) {
    this.#suspects.add(owner);
  }
}
