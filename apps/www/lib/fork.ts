"use client";
// The fork API from the browser, as the iOS app's ForkAPI.swift: everything goes through
// /api/fork/* (rewritten to the fork API, which sends no CORS headers). The user's Privy Solana
// wallet signs; the API adds the app's fee payer and sends.
import { useCallback, useMemo, useRef } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSignMessage, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";

/** `phoenixCashOut`: a sale that closed Phoenix legs; their cash comes back with `cashOutPhoenix`. */
export type Built = { buildId: string; transactions: string[]; feeUsd?: number; phoenixCashOut?: boolean };

export type PortfolioPosition = {
  address: string;
  takeId: string;
  claim: string;
  topic: string | null;
  authorHandle: string | null;
  side: "back" | "fade";
  stakeUsd: number;
  costUsd: number | null;
  valueUsd: number | null;
  returnBps: number | null;
  pendingNote: string | null;
  canExit: boolean | null;
  exited: boolean | null;
  /** Legs held on Phoenix (perp legs, a fade's shorts): where each is liquidated and how close it is. */
  phoenix?: PhoenixRisk[];
};
/**
 * One Phoenix leg of a position (the fork API's `phoenix.risk`): `liquidationUsd` is null when
 * price alone can't liquidate it; `distance` is the move to liquidation as a share of the market
 * (0.18 = 18% away); `level` is "near" within 25%, "close" within 10%.
 */
export type PhoenixRisk = {
  leg: number;
  symbol: string;
  side: "long" | "short";
  entryUsd: number;
  markUsd: number | null;
  liquidationUsd: number | null;
  distance: number | null;
  level: "ok" | "near" | "close";
};
/** Receipt legs held on Phoenix: a back's perp (market and leverage), and the market a fade shorts. */
export type PhoenixLeg = { perp?: { symbol: string; leverage: number } | null; short?: string | null };
/** Cash left on Phoenix after a sale (or what a liquidation left), and positions left open past a take's end. */
export type PhoenixCash = { cashUsd: number; openPositions: number; markets: string[] };
export type Badge = { kind: string; title: string; mint: string; image: string | null };
export type Portfolio = { positions: PortfolioPosition[]; badges: Badge[] };
export type History = { value: number; change: number; changePct: number; points: { at: number; value: number }[] };
export type Activity = { kind: string; usd: number; at: string; takeId: string | null; signature: string | null };
/**
 * `depositCapUsd` / `depositLeftUsd`: the cap on cash added per wallet (ever) and what's left of
 * it, from the fork API. It sends null for both when it has no cap.
 */
export type WalletSummary = { usdc: number; activity: Activity[]; depositCapUsd?: number | null; depositLeftUsd?: number | null };

/** For display only, when the fork API sends no cap figures at all (an older API). */
const FALLBACK_CAP_USD = 1000;

/**
 * How much more cash this wallet can add, from the fork API's figures. `cap` is null when the API
 * says there is none (`left` is then Infinity). Without figures, $1,000 minus deposits so far.
 */
export function depositLeft(s: WalletSummary | null): { cap: number | null; left: number } {
  if (s && s.depositCapUsd === null) return { cap: null, left: Infinity };
  const cap = s?.depositCapUsd ?? FALLBACK_CAP_USD;
  if (s?.depositLeftUsd != null) return { cap, left: Math.max(0, s.depositLeftUsd) };
  const added = (s?.activity ?? []).filter((a) => a.kind === "deposit").reduce((t, a) => t + a.usd, 0);
  return { cap, left: Math.max(0, cap - added) };
}

/** An amount field's text: digits and one point, at most 2 decimals (the fork API takes cents). */
export function centsInput(raw: string): string {
  const clean = raw.replace(/[^0-9.]/g, "");
  const dot = clean.indexOf(".");
  if (dot < 0) return clean;
  return clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, "").slice(0, 2);
}

/** Set after a trade or sale: the portfolio can take a little while to show it, so Me checks again. */
export const TRADED_AT_KEY = "thesis.tradedAt";
/** Fired with every markTraded, so a screen already open (Me, under the composer) reloads too. */
export const TRADED_EVENT = "thesis:traded";
export function markTraded() {
  try { sessionStorage.setItem(TRADED_AT_KEY, String(Date.now())); } catch { /* private mode */ }
  window.dispatchEvent(new Event(TRADED_EVENT));
}
export type CreatorFeeTake = { take: string; takeId: string | null; claim: string | null; earnedUsd: number; claimedUsd: number; unclaimedUsd: number };
export type CreatorFees = { earnedUsd: number; claimedUsd: number; unclaimedUsd: number; takes: CreatorFeeTake[] };

const KNOWN: Record<string, string> = {
  insufficient_funds: "Not enough cash for that. Add some first.",
  take_not_found: "This take isn't live yet.",
  wallet_auth_required: "Couldn't confirm it's your wallet. Try again.",
  withdrawals_off: "Withdrawals are off for now.",
  // The API's text carries the signature and the raw program error: never shown.
  transaction_failed: "That didn't go through. Check your balance, then try again.",
  // Sent without a message (a sale after the take ended, a trade on a closed take).
  take_closed: "This take has ended, so it can't be traded or sold now. It settles at its end date.",
  // A crash on the API's side: its message is a stack line, not for people.
  internal: "Something went wrong on our side. Try again.",
};

/** The text for a fork API refusal: ours for known codes, else the API's own where it sends one. */
export function errorText(code: string, message: string | undefined): string {
  // "Lots of trades right now. Try again in 4 s.": the API's wait is the useful part.
  if (code === "busy") return message || "Thesis is busy right now. Try again in a few seconds.";
  // "At least $10, in cents": the minimum differs ($10 for trades, $1 for cash).
  if (code === "invalid_amount") {
    const min = message?.match(/\$\d+(\.\d+)?/)?.[0];
    return min ? `Enter at least ${min}, with no more than 2 decimals.` : "Enter an amount in dollars and cents.";
  }
  return KNOWN[code] ?? message ?? code.replace(/_/g, " ");
}

/** A fork API refusal: `code` is the API's error code ("insufficient_funds", "already_on_chain"…). */
export class ForkError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// Money calls carry the signed-in person's Privy access token: the fork API checks that its
// user owns the wallet acted for. Set by the session once someone signs in.
let forkToken: (() => Promise<string | null>) | null = null;
export function setForkAuth(get: (() => Promise<string | null>) | null) {
  forkToken = get;
}

/** Fired when the fork API says the session isn't good for this wallet; SessionScreens asks to sign in again. */
export const REAUTH_EVENT = "thesis:reauth";

export async function fork<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const token = method !== "GET" && forkToken ? await forkToken().catch(() => null) : null;
  const r = await fetch(`/api/fork${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const json = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!r.ok) {
    const code = json.error ?? json.message ?? "Something went wrong";
    if ((r.status === 401 && code === "unauthorized") || code === "wrong_wallet") {
      if (typeof window !== "undefined") window.dispatchEvent(new Event(REAUTH_EVENT));
      throw new ForkError(code, "Sign in again.");
    }
    if (r.status === 429) {
      const wait = Number(r.headers.get("retry-after"));
      throw new ForkError("rate_limited", wait > 0 ? `Too many tries. Wait ${wait < 90 ? `${Math.ceil(wait)} s` : `${Math.ceil(wait / 60)} min`} and try again.` : "Too many tries. Wait a moment and try again.");
    }
    throw new ForkError(code, errorText(code, json.message));
  }
  return json as T;
}

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};

/**
 * Moves cash left on Phoenix back to the wallet as USDC, closing positions left open first, as the
 * iOS ForkAPI.cashOutPhoenix: each round is a build the wallet signs; it repeats until the API says
 * `done` (at most a few rounds).
 */
export async function cashOutPhoenix(address: string, signAndSubmit: (b: Built) => Promise<string[]>) {
  for (let round = 0; round < 4; round++) {
    const r = await fork<{ done: boolean; buildId?: string; transactions?: string[] }>("POST", `/wallets/${address}/phoenix/cash-out`, {});
    if (r.done || !r.buildId || !r.transactions?.length) return;
    await signAndSubmit({ buildId: r.buildId, transactions: r.transactions });
  }
}

/** "NVDA 3x long liquidates at $61.21 · 18% away", as the iOS receipt's liquidation line. */
export function liquidationText(r: PhoenixRisk, leverage?: number | null): string {
  const what = [r.symbol, leverage ? `${leverage}x` : null, r.side].filter(Boolean).join(" ");
  const at = r.liquidationUsd != null
    ? `liquidates at $${r.liquidationUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "can't be liquidated by price alone";
  const away = r.distance != null ? ` · ${Math.max(0, Math.round(r.distance * 100))}% away` : "";
  return `${what} ${at}${away}`;
}

/** Across several buys of the same take, each Phoenix leg's riskiest position (closest to liquidation). */
function closest(risks: PhoenixRisk[]): PhoenixRisk[] {
  const byLeg = new Map<number, PhoenixRisk>();
  for (const r of risks) {
    const had = byLeg.get(r.leg);
    if (!had || (r.distance ?? Infinity) < (had.distance ?? Infinity)) byLeg.set(r.leg, r);
  }
  return [...byLeg.values()].sort((a, b) => a.leg - b.leg);
}

/** Every buy is its own position on-chain, but the same take and side is one holding to you (as iOS). */
export function holdings(positions: PortfolioPosition[]): PortfolioPosition[] {
  const order: string[] = [];
  const groups = new Map<string, PortfolioPosition[]>();
  for (const p of positions) {
    const key = `${p.takeId}|${p.side}`;
    if (!groups.has(key)) { order.push(key); groups.set(key, []); }
    groups.get(key)!.push(p);
  }
  return order.map((key) => {
    const g = groups.get(key)!;
    if (g.length === 1) return g[0];
    const total = (f: (p: PortfolioPosition) => number | null) => (g.every((p) => f(p) != null) ? g.reduce((s, p) => s + (f(p) ?? 0), 0) : null);
    const stake = g.reduce((s, p) => s + p.stakeUsd, 0);
    const scored = g.every((p) => p.returnBps != null) && stake > 0;
    return {
      ...g[0],
      stakeUsd: stake,
      costUsd: total((p) => p.costUsd),
      valueUsd: total((p) => p.valueUsd),
      returnBps: scored ? Math.round(g.reduce((s, p) => s + (p.returnBps ?? 0) * p.stakeUsd, 0) / stake) : null,
      pendingNote: g.find((p) => p.pendingNote)?.pendingNote ?? null,
      canExit: g.some((p) => p.canExit),
      exited: g.every((p) => p.exited),
      phoenix: closest(g.flatMap((p) => (p.exited ? [] : p.phoenix ?? []))),
    };
  });
}

/** The signed-in user's Privy Solana wallet (the one the app uses), and fork calls made with it. */
export function useForkWallet() {
  const { user } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { signMessage } = useSignMessage();

  const address = useMemo(() => {
    const linked = (user?.linkedAccounts ?? []) as Array<{ type: string; chainType?: string; walletClientType?: string; address?: string }>;
    return linked.find((a) => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy")?.address ?? null;
  }, [user]);
  const wallet = useMemo(() => wallets.find((w) => w.address === address) ?? null, [wallets, address]);

  const signAndSubmit = useCallback(async (built: Built) => {
    if (!wallet) throw new Error("Your wallet isn't ready yet. Try again in a moment.");
    const signed: string[] = [];
    for (const tx of built.transactions) {
      const { signedTransaction } = await signTransaction({ transaction: b64ToBytes(tx), wallet, options: { uiOptions: { showWalletUIs: false } } });
      signed.push(bytesToB64(signedTransaction));
    }
    return (await fork<{ signatures: string[] }>("POST", "/submit", { buildId: built.buildId, transactions: signed })).signatures;
  }, [wallet, signTransaction]);

  // Privy hands back a new wallet object and signMessage on most renders; creatorFees reads the latest
  // through a ref so it keeps one identity per address (a screen loading fees in an effect would
  // otherwise sign and fetch again on every render).
  const latest = useRef({ wallet, signMessage });
  latest.current = { wallet, signMessage };

  /** Your creator fees: only your own, so the wallet signs a short-lived message the API checks. */
  const creatorFees = useCallback(async () => {
    const { wallet, signMessage } = latest.current;
    if (!wallet || !address) throw new Error("Your wallet isn't ready yet.");
    const at = Math.floor(Date.now() / 1000);
    const { signature } = await signMessage({
      message: new TextEncoder().encode(`Thesis creator fees ${address} ${at}`),
      wallet,
      options: { uiOptions: { showWalletUIs: false } },
    });
    return fork<CreatorFees>("GET", `/wallets/${address}/creator-fees`, undefined, { "x-thesis-wallet-auth": `${at}.${bytesToB64(signature)}` });
  }, [address]);

  return { address, wallet, signAndSubmit, creatorFees };
}
