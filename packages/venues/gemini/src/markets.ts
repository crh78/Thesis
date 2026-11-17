// Gemini prediction contracts as Thesis uses them: parsed from Gemini's public events, each
// side's ask and bid, which contracts can go in a basket, the prices the settler signs, and the
// 32-byte leg id a contract and side get on-chain (docs/gemini-plan.md).
import { createHash } from "node:crypto";
import { geminiRequest, type GeminiProxy } from "./index.ts";

export type GeminiSide = "yes" | "no";
export const otherSide = (s: GeminiSide): GeminiSide => (s === "yes" ? "no" : "yes");

/** One contract of a Gemini event (an event can have several: "Above 5%", "Above 6%", ...). */
export type GeminiContract = {
  instrumentSymbol: string;
  eventTicker: string;
  eventTitle: string;
  label: string;
  category: string;
  /** "active", "settled", ... as Gemini reports it. */
  status: string;
  /** When trading stops, ISO. */
  expiry: string | null;
  resolutionSide: GeminiSide | null;
  resolvedAt: string | null;
  /** What buying a side costs now, 0–1, or null when nobody's selling it (see `parseEvent`). */
  ask: Record<GeminiSide, number | null>;
  /** What selling a side pays now, 0–1, or null when nobody's buying it (see `parseEvent`). */
  bid: Record<GeminiSide, number | null>;
};

const PREDICTION_ID_PREFIX = "thesis:prediction:v1:";

/** The leg's key: one contract, one side. */
export const predictionKey = (instrumentSymbol: string, side: GeminiSide) => `gemini:${instrumentSymbol}:${side}`;

/** 32-byte LegSpec.asset for a contract and side, as hex. */
export function predictionIdHex(instrumentSymbol: string, side: GeminiSide): string {
  return createHash("sha256").update(PREDICTION_ID_PREFIX + predictionKey(instrumentSymbol, side), "utf8").digest("hex");
}

const price = (v: unknown): number | null => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
};
const side = (v: unknown): GeminiSide | null => (v === "yes" || v === "no" ? v : null);
/** 1 − p, rounded to a millionth so 1 − 0.4 is 0.6, not 0.6000000000000001. */
const complement = (p: number | null): number | null => (p === null ? null : Math.round((1 - p) * 1e6) / 1e6);

/**
 * Each side's ask and bid, from the contract's one order book (Yes): `bestBid` and `bestAsk`.
 * Buying No is selling Yes, so No's ask is 1 − Yes's best bid and No's bid is 1 − Yes's best ask.
 *
 * Never Gemini's `prices.buy` / `prices.sell`: when a side of the book is empty Gemini fills them
 * with the last trade, a price nobody is offering now. In one live check, of 1,586
 * contracts showing all four, 365 had no best bid or no best ask, and a paper fill there could buy
 * at an old trade and sell straight back at the live bid (a weather contract: buy 0.01, sell
 * 0.81). Where both exist, `prices.buy/sell` equal these exactly (1,221 of 1,221).
 */
export function quotes(prices: any): { ask: Record<GeminiSide, number | null>; bid: Record<GeminiSide, number | null> } {
  const bestBid = price(prices?.bestBid);
  const bestAsk = price(prices?.bestAsk);
  return { ask: { yes: bestAsk, no: complement(bestBid) }, bid: { yes: bestBid, no: complement(bestAsk) } };
}

/** The contracts of one event from Gemini's events API (a list item, or `events/<ticker>`). */
export function parseEvent(raw: any): GeminiContract[] {
  const e = raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
  if (!e || typeof e.ticker !== "string" || !Array.isArray(e.contracts)) return [];
  return e.contracts
    .filter((c: any) => typeof c?.instrumentSymbol === "string")
    .map((c: any): GeminiContract => ({
      instrumentSymbol: c.instrumentSymbol,
      eventTicker: e.ticker,
      eventTitle: String(e.title ?? ""),
      label: String(c.label ?? ""),
      category: String(e.category ?? ""),
      status: String(c.status ?? e.status ?? ""),
      expiry: c.expiryDate ?? e.expiryDate ?? null,
      resolutionSide: side(c.resolutionSide),
      resolvedAt: c.resolvedAt ?? null,
      ...quotes(c.prices),
    }));
}

/** Contracts must resolve at least this long after the trade (no five-minute markets). */
export const MIN_LEAD_MS = 60 * 60_000;

/**
 * Why a contract and side can't go in a basket right now, or null if it can: it must be open,
 * expire at least `MIN_LEAD_MS` out, and have both an ask and a bid on that side. Contracts that
 * resolve after the take's horizon are allowed (they exit at the bid).
 */
export function ineligible(c: GeminiContract, s: GeminiSide, nowMs = Date.now()): string | null {
  if (c.status !== "active") return `the contract is ${c.status || "not open"}`;
  const expiry = c.expiry ? Date.parse(c.expiry) : NaN;
  if (!Number.isFinite(expiry) || expiry < nowMs + MIN_LEAD_MS) return "it resolves within the hour";
  if (c.ask[s] === null || c.bid[s] === null) return `Gemini has no market on ${s === "yes" ? "Yes" : "No"} right now`;
  const bad = bookProblem(c);
  if (bad) return `Gemini's prices for it don't add up right now (${bad})`;
  return null;
}

/**
 * Why a contract can't be a basket pick, or null if it can. Every prediction leg can be faded and
 * a fade buys the other side, so both sides must pass `ineligible`: a pick on
 * a contract with no No book could be backed but its fades never filled.
 */
export function ineligibleAsPick(c: GeminiContract, nowMs = Date.now()): string | null {
  return ineligible(c, "yes", nowMs) ?? ineligible(c, "no", nowMs);
}

/**
 * Why a contract's quotes can't be priced from, or null if they're coherent. Prediction legs are
 * paper-filled at these quotes, so a book that's crossed (a side's bid above its ask) or whose two
 * asks add up to under $1 would let a buy-then-sell score a gain nobody could make (seen live: a weather
 * contract quoting Yes at 0.01 to buy and 0.81 to sell). The cause was reading Gemini's
 * last-trade-filled `prices.buy/sell` (fixed in `quotes`); with best bid and ask only a crossed book trips this, so it stays as a backstop.
 */
export function bookProblem(c: GeminiContract): string | null {
  const EPS = 1e-9;
  for (const s of ["yes", "no"] as const) {
    const a = c.ask[s];
    const b = c.bid[s];
    if (a !== null && b !== null && b > a + EPS) return `${s} bid ${b} is above its ask ${a}`;
  }
  if (c.ask.yes !== null && c.ask.no !== null && c.ask.yes + c.ask.no < 1 - 0.01) return `yes and no asks add up to ${(c.ask.yes + c.ask.no).toFixed(2)}, under $1`;
  if (c.bid.yes !== null && c.bid.no !== null && c.bid.yes + c.bid.no > 1 + 0.01) return `yes and no bids add up to ${(c.bid.yes + c.bid.no).toFixed(2)}, over $1`;
  return null;
}

/**
 * The leg-side price (0–1) the settler signs. A back holds `legSide`. A fade holds the other side,
 * priced through the program's "No" formula, so it records `1 − (other side's price)`.
 *   - entry: the held side's ask;
 *   - exit or sale: 1 or 0 once the contract has resolved, else the held side's bid.
 * Null when there's no such price right now.
 */
export function legPrice(c: GeminiContract, legSide: GeminiSide, held: "back" | "fade", moment: "entry" | "exit"): number | null {
  if (moment === "exit" && c.resolutionSide) return c.resolutionSide === legSide ? 1 : 0;
  if (moment === "entry" && c.status !== "active") return null;
  const heldSide = held === "back" ? legSide : otherSide(legSide);
  const p = moment === "entry" ? c.ask[heldSide] : c.bid[heldSide];
  if (p === null) return null;
  return held === "back" ? p : 1 - p;
}

/** One event's contracts, live, through the proxy. */
export async function fetchGeminiEvent(proxy: GeminiProxy, eventTicker: string, fetchFn: typeof fetch = fetch): Promise<GeminiContract[]> {
  const { url, headers } = geminiRequest(proxy, `events/${eventTicker}`);
  const r = await fetchFn(url, { headers: { accept: "application/json", ...headers } });
  if (!r.ok) throw new Error(`Gemini event ${eventTicker}: HTTP ${r.status}`);
  return parseEvent(await r.json());
}
