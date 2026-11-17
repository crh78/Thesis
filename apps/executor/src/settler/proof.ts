// What a position's trade really bought, from its receipt's `TradeProved` event, and the
// settler's two rules on top of the program's proof of trade:
//
//   1. Asset match. A spot leg is priced only on a token the trade delivered for it, whose
//      underlying is the leg's. No token, or a token of another underlying: the leg stays
//      unpriced (no stock fallback), so the position settles at 0%, unscored, after the grace
//      period. A leg held on Phoenix (a back's perp leg, a fade's short) is priced only on the
//      Phoenix position the trade proved, in the leg's market and on the right side
//      (phoenix-legs.ts). The stock fallback for a token that *was* bought but is too thin to
//      price right now stays (pricing.ts).
//   2. Value check. At entry, what a spot leg received (in the event: growth inside the trade's
//      brackets only) times its entry price must be at least `minReceivedRatio` of the leg's
//      share of the stake. This catches a stake swapped through a pool someone made at an
//      absurd price for dust of the right token. Under the threshold: unpriced, as above.
import { PublicKey, type Connection } from "@solana/web3.js";
import { PHOENIX_PROGRAM_ID } from "@thesis/chain";
import { decodeMarketOrder, type MarketOrder } from "@thesis/venues/phoenix";
import { underlyingIdHex } from "@thesis/venues/bank";
import { thesisTransactionEvents, type TakeAccount, type ThesisProgram } from "@thesis/chain";
import type { BankIndex, BankToken } from "./bank.ts";

/** One take leg's output, as the receipt proved it. */
export type ProvedOutput = {
  account: string;
  /** Raw growth inside the trade's brackets, in the token's base units. */
  received: bigint;
  /** The account's mint, or null if it couldn't be read. */
  mint: string | null;
  /** UI tokens per base unit (10^-decimals, times any Token-2022 scaled-UI multiplier), or null. */
  uiPerUnit: number | null;
  /** A Phoenix trader account (a perp leg or a short): `received` is base lots of its position. */
  phoenix?: boolean;
  /**
   * Phoenix only: the market orders the trade's transactions placed on this account. Read from
   * the instructions themselves, so they say which market and side even after a sale.
   */
  orders?: MarketOrder[];
};

export type TradeProof = { spent: bigint; outputs: Map<number, ProvedOutput> };

/** Default for `minReceivedRatio`: a leg's tokens must be worth 90% of its share of the stake. */
export const DEFAULT_MIN_RECEIVED_RATIO = 0.9;

type TokenBalance = { accountIndex: number; mint: string; uiTokenAmount: { amount: string; uiAmountString?: string; decimals: number } };

/**
 * The `TradeProved` event of the transaction that opened `position` (its receipt), with each
 * output's mint and UI scale from that transaction's token balances (or the account itself for
 * outputs filled in an earlier transaction of a split trade). Null when the receipt has no such
 * event (a receipt from before proof of trade): nothing is proved, so nothing is priced.
 * Throws while the receipt can't be read yet, so the caller retries next tick.
 */
export async function tradeProof(conn: Connection, program: ThesisProgram, position: PublicKey): Promise<TradeProof | null> {
  // Oldest first. A split trade names the position in every transaction (begin_trade and
  // trade_step take it), so the receipt, the one with the event, isn't always the oldest.
  let before: string | undefined;
  const sigs: string[] = [];
  for (;;) {
    const page = await conn.getSignaturesForAddress(position, { before, limit: 1000 }, "confirmed");
    for (const entry of page) if (!entry.err) sigs.push(entry.signature);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  if (!sigs.length) throw new Error(`no transaction for ${position.toBase58()} yet`);
  sigs.reverse();
  let tx: Awaited<ReturnType<Connection["getTransaction"]>> = null;
  let event: ReturnType<typeof thesisTransactionEvents>[number] | undefined;
  // Phoenix market orders in the trade's transactions, by the trader account they trade.
  const orders = new Map<string, MarketOrder[]>();
  // A trade has at most one transaction per leg (MAX_LEGS) plus the receipt.
  for (const sig of sigs.slice(0, 12)) {
    tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) throw new Error(`transaction ${sig} isn't available yet`);
    const events = thesisTransactionEvents(program, tx);
    const txKeys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).keySegments().flat();
    for (const ix of tx.transaction.message.compiledInstructions) {
      const order = decodeMarketOrder(txKeys[ix.programIdIndex], ix.accountKeyIndexes.map((k) => txKeys[k]), ix.data);
      if (order) orders.set(order.trader.toBase58(), [...(orders.get(order.trader.toBase58()) ?? []), order]);
    }
    event = events.find(
      (e) => e.name === "tradeProved" && (e.data as { position: PublicKey }).position.equals(position),
    );
    if (event) break;
    // The receipt creates the position: past it, the trade is over.
    if (events.some((e) => e.name === "positionOpened" && (e.data as { position: PublicKey }).position.equals(position))) break;
  }
  if (!event || !tx?.meta) return null;
  const data = event.data as { spent: { toString(): string }; outputsMask: number; outputs: PublicKey[]; received: { toString(): string }[] };

  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).keySegments().flat();
  const balances = new Map<string, TokenBalance>();
  for (const b of (tx.meta.postTokenBalances ?? []) as TokenBalance[]) balances.set(keys[b.accountIndex].toBase58(), b);
  const legs = [...Array(16).keys()].filter((i) => data.outputsMask & (1 << i));
  const missing = data.outputs.filter((o) => !balances.has(o.toBase58()));
  const fetched = missing.length ? await conn.getMultipleAccountsInfo(missing, "confirmed") : [];
  const mintOf = new Map<string, { mint: string; uiPerUnit: number | null }>();
  const phoenix = new Set<string>();
  for (const [j, info] of fetched.entries()) {
    if (info?.owner?.equals(PHOENIX_PROGRAM_ID)) phoenix.add(missing[j].toBase58());
    else if (info && info.data.length >= 165) mintOf.set(missing[j].toBase58(), { mint: new PublicKey(info.data.subarray(0, 32)).toBase58(), uiPerUnit: null });
  }
  if (mintOf.size) {
    const mints = [...new Set([...mintOf.values()].map((m) => m.mint))];
    const infos = await conn.getMultipleAccountsInfo(mints.map((m) => new PublicKey(m)), "confirmed");
    const decimals = new Map(mints.map((m, j) => [m, infos[j] && infos[j]!.data.length >= 45 ? infos[j]!.data[44] : null]));
    for (const v of mintOf.values()) {
      const d = decimals.get(v.mint);
      v.uiPerUnit = d === null || d === undefined ? null : 10 ** -d;
    }
  }

  const outputs = new Map<number, ProvedOutput>();
  legs.forEach((leg, j) => {
    const account = data.outputs[j].toBase58();
    const received = BigInt(data.received[j].toString());
    const b = balances.get(account);
    if (b) {
      const amount = Number(b.uiTokenAmount.amount);
      const ui = Number(b.uiTokenAmount.uiAmountString ?? NaN);
      // The account's own UI scale (includes a Token-2022 scaled-UI multiplier when there is one).
      const uiPerUnit = amount > 0 && Number.isFinite(ui) ? ui / amount : 10 ** -b.uiTokenAmount.decimals;
      outputs.set(leg, { account, received, mint: b.mint, uiPerUnit });
    } else if (phoenix.has(account)) {
      outputs.set(leg, { account, received, mint: null, uiPerUnit: null, phoenix: true, orders: orders.get(account) ?? [] });
    } else {
      const m = mintOf.get(account);
      outputs.set(leg, { account, received, mint: m?.mint ?? null, uiPerUnit: m?.uiPerUnit ?? null });
    }
  });
  return { spent: BigInt(data.spent.toString()), outputs };
}

export type LegDecision = { ok: true; token: BankToken | null } | { ok: false; reason: string };

/**
 * Rule 1 for one leg: the token to price it on (spot), the vault share (yield), nothing to check
 * (prediction, card, legs held on Phoenix: pricing.ts and phoenix-legs.ts decide those), or why
 * it stays unpriced.
 */
export function provedToken(
  leg: { kind: string; assetIdHex: string },
  side: "back" | "fade",
  proof: TradeProof | null,
  legIndex: number,
  bank: BankIndex,
): LegDecision {
  // Legs held on Phoenix are checked against their position (phoenix-legs.ts), not a token.
  if (heldOnPhoenix(leg.kind, side)) return { ok: true, token: null };
  // A yield leg (scored) is priced on the vault share the trade delivered: its
  // `token:<mint>` id must be the leg's asset. Shares are valued per UI share, so units are 1.
  if (leg.kind === "yield") {
    const out = proof?.outputs.get(legIndex);
    if (!out?.mint) return { ok: false, reason: "the trade delivered no vault share for this yield leg" };
    const key = `token:${out.mint}`;
    if (underlyingIdHex(key) !== leg.assetIdHex) return { ok: false, reason: `the share bought (${out.mint}) isn't this yield leg's vault` };
    if (out.received <= 0n) return { ok: false, reason: "the trade delivered no shares of this yield leg's vault" };
    return { ok: true, token: { mint: out.mint, underlyingKey: key, underlyingIdHex: leg.assetIdHex, underlyingPerUiToken: 1 } };
  }
  if (leg.kind !== "spot") return { ok: true, token: null };
  const out = proof?.outputs.get(legIndex);
  if (!out) return { ok: false, reason: "the trade delivered no token for this leg (no stock fallback)" };
  const token = out.mint ? bank.token(out.mint) : null;
  if (!token) return { ok: false, reason: `the token bought (${out.mint ?? "unknown"}) isn't in the asset bank` };
  if (token.underlyingIdHex !== leg.assetIdHex) return { ok: false, reason: `the token bought (${token.mint}) tracks ${token.underlyingKey}, not this leg's asset` };
  if (out.received <= 0n) return { ok: false, reason: "the trade delivered none of this leg's token" };
  return { ok: true, token };
}

/** A back's perp legs and a fade's shorts are held on Phoenix (a fade's prediction legs aren't). */
export const heldOnPhoenix = (kind: string, side: "back" | "fade") => (side === "fade" ? kind !== "prediction" : kind === "perp");

/** A leg's share of the stake, in USD: its weight over the weights of the legs the position includes. */
export function legStakeUsd(take: Pick<TakeAccount, "legs">, legsMask: number, stakeBaseUnits: bigint, legIndex: number): number {
  const total = take.legs.reduce((s, l, i) => (legsMask & (1 << i) ? s + l.weightBps : s), 0);
  return total ? (Number(stakeBaseUnits) / 1e6) * (take.legs[legIndex].weightBps / total) : 0;
}

/**
 * Rule 2: whether a spot leg's tokens are worth enough at its entry price (USD per unit of the
 * underlying). Null when it passes, otherwise why not.
 */
export function receivedValueShortfall(
  out: ProvedOutput,
  token: Pick<BankToken, "underlyingPerUiToken">,
  entryPriceUsd: number,
  legStake: number,
  minRatio = DEFAULT_MIN_RECEIVED_RATIO,
): string | null {
  if (!out.uiPerUnit || !token.underlyingPerUiToken) return "can't value the tokens received (unknown scale)";
  const value = Number(out.received) * out.uiPerUnit * token.underlyingPerUiToken * entryPriceUsd;
  if (value + 1e-9 >= minRatio * legStake) return null;
  return `received $${value.toFixed(2)} of tokens for a $${legStake.toFixed(2)} leg (under ${Math.round(minRatio * 100)}%)`;
}
