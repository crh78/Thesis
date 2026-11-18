// Sending what a submit carries, and finding out whether it landed (ForkService#send).
//
// By default a submit sends its transactions one at a time, each confirmed before the next.
// `sendBackToBack` is the until=accepted way: every transaction goes out at once after the one
// before it was accepted (preflight at "processed" sees the one before it, measured on Surfpool),
// the caller hears "accepted" when all were, and then they're confirmed together. A split trade
// whose later transaction is refused still answers trade_incomplete: the ones accepted first are
// confirmed before the failure is reported, with the ones that landed (SendFailed).
import type { Connection, VersionedTransaction } from "@solana/web3.js";
import { ApiError, base58, errorText, type Timings } from "./common.ts";

/**
 * How often, and at most how long, an unconfirmed transaction's status is polled; the first look
 * is sooner (Surfpool confirms in about 250 ms), doubling up to SETTLE_POLL_MS.
 */
export const SETTLE_FIRST_POLL_MS = 100;
export const SETTLE_POLL_MS = 500;
export const SETTLE_MAX_MS = 90_000;

export type Fate = "landed" | "failed" | "unknown";

/**
 * A send that failed partway: the error of the transaction that failed, with the signatures of
 * the ones before it that landed.
 */
export class SendFailed extends ApiError {
  readonly landed: string[];
  /** The failed transaction's fate is unknown (it may still land): never counted as not landed. */
  readonly unknown: boolean;
  constructor(e: ApiError, landed: string[], unknown = false) {
    super(e.status, e.code, e.message);
    this.headers = e.headers;
    this.body = e.body;
    this.landed = landed;
    this.unknown = unknown;
  }
}

/** A send refused before it reached the chain: the preflight simulation failed. */
export const refusedByPreflight = (e: unknown) =>
  Array.isArray((e as { logs?: unknown })?.logs) || /simulation failed|preflight/i.test(e instanceof Error ? e.message : String(e));

type StatusReader = Pick<Connection, "getSignatureStatuses" | "getBlockHeight">;

/**
 * Polls transactions' statuses (one read for all of them per poll) until each is known: "landed"
 * (confirmed without an error), "failed" (landed with an error, or not seen once the block height
 * passed `lastValidBlockHeight`), or "unknown" after SETTLE_MAX_MS. `once`: a single read.
 */
export async function fates(conn: StatusReader, sigs: string[], lastValidBlockHeight: number, o: { once?: boolean; maxMs?: number } = {}): Promise<Fate[]> {
  const out: Fate[] = sigs.map(() => "unknown");
  if (!sigs.length) return out;
  const until = Date.now() + (o.maxMs ?? SETTLE_MAX_MS);
  for (let wait = SETTLE_FIRST_POLL_MS; ; wait = Math.min(SETTLE_POLL_MS, wait * 2)) {
    const statuses = (await conn.getSignatureStatuses(sigs, { searchTransactionHistory: true }).catch(() => null))?.value ?? [];
    for (const [i, status] of statuses.entries()) {
      if (out[i] === "unknown" && status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) out[i] = status.err ? "failed" : "landed";
    }
    const unseen = sigs.flatMap((_, i) => (out[i] === "unknown" && !statuses[i] ? [i] : []));
    if (unseen.length) {
      const height = await conn.getBlockHeight("confirmed").catch(() => null);
      // Their blockhash is past: the ones not seen can't land any more.
      if (height !== null && height > lastValidBlockHeight) for (const i of unseen) out[i] = "failed";
    }
    if (!out.includes("unknown") || o.once || Date.now() >= until) return out;
    await new Promise((r) => setTimeout(r, wait));
  }
}

/**
 * Sends `txs` back to back, each preflighted at "processed", calls `accept` once every one was
 * accepted, then waits until all landed and returns their signatures. A preflight refusal stops
 * the sending (nothing after it goes out); an RPC error while sending waits for that
 * transaction's fate first (it may have gone out). Either way the ones sent are confirmed before
 * it throws SendFailed with those that landed, in order.
 */
export async function sendBackToBack(
  conn: Pick<Connection, "sendTransaction" | "getSignatureStatuses" | "getBlockHeight">,
  txs: VersionedTransaction[],
  lastValidBlockHeight: number,
  o: { accept: () => void; timings?: Timings; log?: (m: string) => void },
): Promise<string[]> {
  // The fee payer's signature is each transaction's id, known before it's sent.
  const sigs = txs.map((tx) => base58(tx.signatures[0]));
  const n = (i: number) => (txs.length > 1 ? ` ${i + 1}` : "");
  let sent = 0;
  let stop: ApiError | null = null;
  let unknown = false;
  for (const [i, tx] of txs.entries()) {
    const started = Date.now();
    const refused = await conn.sendTransaction(tx, { skipPreflight: false, preflightCommitment: "processed" }).then(
      () => null,
      async (e: unknown) => {
        if (refusedByPreflight(e)) return new ApiError(502, "send_failed", errorText(e));
        o.log?.(`sending ${sigs[i]} failed (${errorText(e)}); waiting to see if it landed`);
        const [fate] = await fates(conn, [sigs[i]], lastValidBlockHeight);
        if (fate === "landed") return null;
        // Unknown may still land: it's confirmed (or not) with the others, never taken as not landed.
        if (fate === "unknown") {
          unknown = true;
          sent++;
        }
        return new ApiError(502, "send_failed", errorText(e));
      },
    );
    o.timings?.add(`send${n(i)}`, Date.now() - started);
    if (refused) {
      stop = refused;
      break;
    }
    sent++;
  }
  if (!stop) o.accept();
  const confirming = Date.now();
  const known = await fates(conn, sigs.slice(0, sent), lastValidBlockHeight);
  o.timings?.add("confirm", Date.now() - confirming);
  const failed = known.findIndex((f) => f !== "landed");
  if (!stop && failed === -1) return sigs;
  if (failed !== -1) {
    unknown ||= known[failed] === "unknown";
    // The first one that didn't land is what stopped the trade.
    stop = new ApiError(502, "transaction_failed", `${sigs[failed]}: ${known[failed] === "unknown" ? "not confirmed yet" : "not confirmed"}`);
  }
  throw new SendFailed(stop!, sigs.slice(0, failed === -1 ? sent : failed), unknown);
}
