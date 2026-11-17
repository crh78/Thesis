// Live prices for the Gemini contracts a request actually touches. The asset bank sweeps every
// contract only every 6 hours (a sweep is ~4 MB of Supabase egress), so trades, receipts and
// marks read just their events, through the Supabase `gemini` proxy, cached for LIVE_TTL_MS. A trade
// needs a live read; a receipt or a mark falls back to the bank's copy when Gemini can't be read.
import type { GeminiContract } from "@thesis/venues/gemini";

/** How long one event's live read is reused (the proxy caches events for 30 s as well). */
export const LIVE_TTL_MS = 30_000;
/**
 * Gemini's book can lose a side, or all its prices, for a few seconds on a live contract
 * (empty for ~8 s, then back at the same levels). A price seen this recently
 * fills such a gap, so one read doesn't block a trade or blank a mark. The settler doesn't do
 * this: it signs only prices it read, and waits out a gap.
 */
export const GAP_MS = 60_000;

type Side = "yes" | "no";
type Seen = { ask: Record<Side, { v: number; at: number } | null>; bid: Record<Side, { v: number; at: number } | null> };

type Entry = { at: number; contracts: Map<string, GeminiContract> };

export class LiveContracts {
  #read: (eventTicker: string) => Promise<GeminiContract[]>;
  #now: () => number;
  #events = new Map<string, Entry>();
  /** Instrument → the last price seen on each side of the book, and when. */
  #seen = new Map<string, Seen>();
  #inFlight = new Map<string, Promise<void>>();
  #log: (m: string) => void;

  constructor(read: (eventTicker: string) => Promise<GeminiContract[]>, o: { now?: () => number; log?: (m: string) => void } = {}) {
    this.#read = read;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? (() => {});
  }

  /** Reads the events of `contracts` that weren't read within LIVE_TTL_MS (one read per event). */
  async refresh(contracts: GeminiContract[]): Promise<void> {
    const due = [...new Set(contracts.map((c) => c.eventTicker))].filter((t) => !this.#fresh(t));
    await Promise.all(due.map((t) => this.#load(t)));
  }

  /** The contract as last read live, if that read is current; else null. */
  live(c: GeminiContract): GeminiContract | null {
    const e = this.#events.get(c.eventTicker);
    return e && this.#now() - e.at < LIVE_TTL_MS ? (e.contracts.get(c.instrumentSymbol) ?? null) : null;
  }

  /** The newest copy known: the live read (even past its TTL), else `fallback`. */
  latest(c: GeminiContract, fallback: GeminiContract): GeminiContract {
    return this.#events.get(c.eventTicker)?.contracts.get(c.instrumentSymbol) ?? fallback;
  }

  #fresh(ticker: string) {
    const e = this.#events.get(ticker);
    return Boolean(e && this.#now() - e.at < LIVE_TTL_MS);
  }

  /** The contract with each missing ask or bid taken from a read within GAP_MS, if there was one. */
  #fillGaps(c: GeminiContract, now: number): GeminiContract {
    const seen = this.#seen.get(c.instrumentSymbol) ?? { ask: { yes: null, no: null }, bid: { yes: null, no: null } };
    const fill = (book: "ask" | "bid") => {
      const out = { ...c[book] };
      for (const s of ["yes", "no"] as const) {
        const v = c[book][s];
        if (v !== null) seen[book][s] = { v, at: now };
        else if (c.status === "active" && seen[book][s] && now - seen[book][s]!.at <= GAP_MS) out[s] = seen[book][s]!.v;
      }
      return out;
    };
    const filled = { ...c, ask: fill("ask"), bid: fill("bid") };
    this.#seen.set(c.instrumentSymbol, seen);
    return filled;
  }

  #load(ticker: string): Promise<void> {
    const pending = this.#inFlight.get(ticker);
    if (pending) return pending;
    const p = this.#read(ticker)
      .then((list) => {
        const now = this.#now();
        const filled = list.map((c) => this.#fillGaps(c, now));
        this.#events.set(ticker, { at: now, contracts: new Map(filled.map((c) => [c.instrumentSymbol, c])) });
      })
      .catch((e) => this.#log(`gemini: reading ${ticker} failed (${e instanceof Error ? e.message.slice(0, 120) : e})`))
      .finally(() => this.#inFlight.delete(ticker));
    this.#inFlight.set(ticker, p);
    return p;
  }
}
