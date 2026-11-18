"use client";
// Posting a take on the fork, shared by the composer and the recovery on Me and at launch (as the
// iOS AppState's sendBuyIn / waitUntilLive / reconcilePosting): a take stays "posting" (its
// author's only) until its on-chain buy-in confirms. After about 2 minutes unconfirmed, the author
// sees "Didn't post" with Retry (the same buy-in, no edits) or Discard.
import { rpcNow } from "./data";
import { fork, ForkError, markTraded, type Built } from "./fork";

/** Opens Me's "My takes" tab, also when Me is already open (a link to /me?tab=takes doesn't remount it). */
export const MY_TAKES_EVENT = "thesis:my-takes";
export function showMyTakes() {
  window.dispatchEvent(new Event(MY_TAKES_EVENT));
}

/** How long to wait for the chain event that makes a take live. */
export const POSTING_TIMEOUT_MS = 120_000;
/** A posting take older than this is checked against the fork API, then offered Retry or Discard. */
export const POSTING_STALE_MS = 120_000;

/**
 * The buy-in each posting take was posted with, so Retry (even after a reload) sends the same
 * amount. The server doesn't keep it: the chain does, once the take is on-chain.
 */
const KEY = "thesis.postingBuyIns";
export const postingBuyIns = {
  get(id: string): number | null {
    try { return (JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>)[id] ?? null; } catch { return null; }
  },
  set(id: string, usd: number | null) {
    try {
      const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>;
      if (usd == null) delete all[id]; else all[id] = usd;
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch { /* private mode */ }
  },
};

/**
 * Is the author's buy-in on-chain? If so, the fork API also delivers its events again. Null when
 * it couldn't be checked (the fork API unreachable, rate-limited, failing): only a real `false`
 * may say "Didn't post", offer Discard or list the take as stuck.
 */
export const isOnChain = (id: string): Promise<boolean | null> =>
  fork<{ onChain: boolean }>("POST", `/takes/${id}/confirm`, {}).then(
    (r) => (typeof r.onChain === "boolean" ? r.onChain : null),
    () => null,
  );

/** Thrown when a send failed and whether it landed anyway couldn't be checked. */
export const UNCHECKED = "unchecked";
export const UNCHECKED_TEXT = "Couldn't check whether your buy-in landed. Try again.";

/**
 * Signs and sends the take's buy-in. An earlier send that landed is fine. Throws the send's error
 * if it didn't land, or a ForkError with code `UNCHECKED` if that couldn't be checked.
 */
export async function sendBuyIn(id: string, author: string, usd: number, signAndSubmit: (b: Built) => Promise<string[]>) {
  try {
    const built = await fork<Built>("POST", `/takes/${id}/publish`, { author, usd });
    await signAndSubmit(built);
    markTraded();
  } catch (e) {
    const landed = e instanceof ForkError && (e.code === "already_on_chain" || e.code === "already_live");
    if (landed) return;
    // The send may have landed even though the answer didn't come back.
    const onChain = await isOnChain(id);
    if (onChain === true) return;
    if (onChain === null) throw new ForkError(UNCHECKED, UNCHECKED_TEXT);
    throw e;
  }
}

const isLive = (id: string) => rpcNow<{ status: string } | null>("take", { p_id: id }).then((t) => t?.status === "live", () => false);

/**
 * Polls the public read until the take is live (the chain event made it so). Halfway, asks the
 * fork API to deliver the publish again; at the timeout, says whether it's on-chain ("unknown"
 * when that couldn't be checked). "stopped" once `wanted()` turns false (the screen closed).
 */
export async function waitUntilLive(id: string, wanted: () => boolean = () => true): Promise<"live" | "unconfirmed" | "failed" | "unknown" | "stopped"> {
  const start = Date.now();
  let nudged = false;
  while (Date.now() - start < POSTING_TIMEOUT_MS) {
    if (!wanted()) return "stopped";
    if (await isLive(id)) return "live";
    if (!nudged && Date.now() - start > POSTING_TIMEOUT_MS / 2) { nudged = true; await isOnChain(id); }
    await new Promise((res) => setTimeout(res, 2000));
  }
  if (!wanted()) return "stopped";
  if (await isLive(id)) return "live";
  const onChain = await isOnChain(id);
  return onChain === true ? "unconfirmed" : onChain === false ? "failed" : "unknown";
}
