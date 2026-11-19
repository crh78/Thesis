// Sending what a submit carries, and finding out whether it landed (ForkService#send).
//
// By default a submit sends its transactions one at a time, each confirmed before the next.
// `sendBackToBack` is the until=accepted way: every transaction goes out at once after the one
// before it was accepted (preflight at "processed" sees the one before it, measured on Surfpool),
// the caller hears "accepted" when all were, and then they're confirmed together. A split trade
// whose later transaction is refused still answers trade_incomplete: the ones accepted first are
// confirmed before the failure is reported, with the ones that landed (SendFailed).
//
// A transaction refused by its preflight for slippage (Jupiter's SlippageToleranceExceeded) is sent
// once more, the same signed bytes, after the build's market accounts are copied from mainnet again
// (`resendOnce`): the fork copies pools lazily, account by account, so a pool can be an
// inconsistent snapshot of a mainnet that moved between reads, or one the trade's own earlier
// transaction just moved. That needs no new signature. Only the wallet can sign a rebuilt swap, so
// when the same bytes are refused again the client rebuilds: a split trade answers
// trade_incomplete (retry: true), and one that sent nothing carries `requote: true`.
import type { Connection, VersionedTransaction } from "@solana/web3.js";
import { JUPITER_V6_PROGRAM } from "@thesis/venues/jupiter";
import { ApiError, base58, errorText, refusedError, type Timings } from "./common.ts";

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
  /** The first transaction was refused by its preflight: nothing went out (`resendOnce` may send it again). */
  readonly nothingSent: boolean;
  /**
   * The transaction that failed was refused by its preflight after every one before it (`landed`)
   * landed: it and the ones after it never went out, so they can be sent again as they are.
   */
  readonly refused: boolean;
  constructor(e: ApiError, landed: string[], unknown = false, nothingSent = false, refused = nothingSent) {
    super(e.status, e.code, e.message);
    this.headers = e.headers;
    this.body = e.body;
    this.inSwap = e.inSwap;
    this.landed = landed;
    this.unknown = unknown;
    this.nothingSent = nothingSent;
    this.refused = refused;
  }
}

/**
 * A refusal for slippage: Jupiter's route filled under its minimum out (SlippageToleranceExceeded,
 * custom error 0x1771). A 0x1771 that another program names (any Anchor program's error 6001) isn't.
 */
/**
 * A refusal a fresh quote is expected to get past: slippage (`slippageRefusal`), or any other
 * failure inside a Jupiter swap (a pool whose state the kept route no longer fits).
 */
export function routeRefusal(e: unknown): boolean {
  return slippageRefusal(e) || (e instanceof ApiError && e.inSwap === true);
}

export function slippageRefusal(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  if (/SlippageToleranceExceeded|slippage tolerance exceeded/i.test(text)) return true;
  const named = /Program (\w+) failed: custom program error: 0x1771\b/.exec(text);
  if (named) return named[1] === JUPITER_V6_PROGRAM;
  return /custom program error: 0x1771\b/.test(text);
}

/**
 * Sends `txs` with `send` (which throws SendFailed), and once more when it makes sense: the same
 * signed bytes, after resetting the build's market accounts from mainnet (`reset`), when
 * - the first transaction's preflight refused it (nothing went out) while some market accounts
 *   were left as they were (`stale`: the submit skipped accounts copied from mainnet less than a
 *   minute ago): a pool that moved on mainnet since its copy is the usual cause; or
 * - a transaction's preflight refused it for slippage (`slippageRefusal`), the first one or a
 *   later one after the ones before it landed: it and the ones after it are sent again.
 * Any other failure, or a second refusal, is thrown, with every transaction that landed, in order.
 */
export async function resendOnce(
  send: (txs: VersionedTransaction[]) => Promise<string[]>,
  txs: VersionedTransaction[],
  o: { stale: boolean; reset: () => Promise<unknown>; log?: (m: string) => void },
): Promise<string[]> {
  let first: SendFailed;
  try {
    return await send(txs);
  } catch (e) {
    if (!(e instanceof SendFailed) || !e.refused || !(slippageRefusal(e) || (o.stale && e.nothingSent))) throw e;
    first = e;
  }
  const n = first.landed.length;
  o.log?.(slippageRefusal(first)
    ? `preflight refused transaction ${n + 1} of ${txs.length} for slippage (${first.message.slice(0, 160)}); resetting the markets and sending it again`
    : `preflight refused with markets copied under a minute ago (${first.message.slice(0, 160)}); resetting them and sending again`);
  await o.reset();
  try {
    return [...first.landed, ...(await send(txs.slice(n)))];
  } catch (e) {
    if (!(e instanceof SendFailed) || !n) throw e;
    // What landed before the first refusal counts too.
    throw new SendFailed(e, [...first.landed, ...e.landed], e.unknown, false, e.refused);
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
  /** The first one's preflight refused it: nothing went out. */
  let nothingSent = false;
  /** What stopped it was a preflight refusal (that one never went out). */
  let preflight = false;
  for (const [i, tx] of txs.entries()) {
    const started = Date.now();
    const refused = await conn.sendTransaction(tx, { skipPreflight: false, preflightCommitment: "processed" }).then(
      () => null,
      async (e: unknown) => {
        if (refusedByPreflight(e)) {
          nothingSent = i === 0;
          preflight = true;
          return refusedError(e);
        }
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
    preflight = false;
    // The first one that didn't land is what stopped the trade.
    stop = new ApiError(502, "transaction_failed", `${sigs[failed]}: ${known[failed] === "unknown" ? "not confirmed yet" : "not confirmed"}`);
  }
  throw new SendFailed(stop!, sigs.slice(0, failed === -1 ? sent : failed), unknown, nothingSent, preflight);
}
