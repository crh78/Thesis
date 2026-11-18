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

/** Is the author's buy-in on-chain? If so, the fork API also delivers its events again. */
export const isOnChain = (id: string) =>
  fork<{ onChain: boolean }>("POST", `/takes/${id}/confirm`, {}).then((r) => r.onChain === true, () => false);

/** Signs and sends the take's buy-in. An earlier send that landed is fine; throws if it can't have landed. */
export async function sendBuyIn(id: string, author: string, usd: number, signAndSubmit: (b: Built) => Promise<string[]>) {
  try {
    const built = await fork<Built>("POST", `/takes/${id}/publish`, { author, usd });
    await signAndSubmit(built);
    markTraded();
  } catch (e) {
    const landed = e instanceof ForkError && (e.code === "already_on_chain" || e.code === "already_live");
    // The send may have landed even though the answer didn't come back.
    if (!landed && !(await isOnChain(id))) throw e;
  }
}

const isLive = (id: string) => rpcNow<{ status: string } | null>("take", { p_id: id }).then((t) => t?.status === "live", () => false);

/**
 * Polls the public read until the take is live (the chain event made it so). Halfway, asks the
 * fork API to deliver the publish again; at the timeout, says whether it's on-chain. "stopped"
 * once `wanted()` turns false (the screen closed).
 */
export async function waitUntilLive(id: string, wanted: () => boolean = () => true): Promise<"live" | "unconfirmed" | "failed" | "stopped"> {
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
  return (await isOnChain(id)) ? "unconfirmed" : "failed";
}
