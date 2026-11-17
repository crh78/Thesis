// The settler's Gemini reads: one event at a time, through the Supabase `gemini` proxy. A read is
// reused for READ_TTL_MS. An event the settler is waiting on (closed but not resolved, no bid or
// ask right now, or not listed) keeps that pace for its first GRACE_WAITS waits, since a book can
// be empty for a moment and an entry should be priced close to its trade. After that it's read
// less and less often, from WAIT_MIN_MS up to WAIT_MAX_MS, until it prices: the settler ticks
// every 20 s and may wait up to the 4-day price deadline, which would otherwise be ~17,000 reads
// of one stuck event.
import type { GeminiContract } from "@thesis/venues/gemini";
import type { PredictionSource } from "./pricing.ts";

export const READ_TTL_MS = 15_000;
export const GRACE_WAITS = 10;
export const WAIT_MIN_MS = 60_000;
export const WAIT_MAX_MS = 5 * 60_000;

export class GeminiEvents implements PredictionSource {
  #read: (eventTicker: string) => Promise<GeminiContract[]>;
  #now: () => number;
  #cache = new Map<string, { at: number; value: Promise<GeminiContract[]> }>();
  /**
   * Event → how many fresh reads in a row left the settler waiting, how long reads are reused
   * now, and which read was counted last (so a tick served from the cache doesn't count again).
   */
  #wait = new Map<string, { count: number; ttl: number; readAt: number }>();

  constructor(read: (eventTicker: string) => Promise<GeminiContract[]>, now: () => number = Date.now) {
    this.#read = read;
    this.#now = now;
  }

  /**
   * `notBeforeMs`: a cached read from before this isn't used (a price has to be observed at or
   * after its moment: a book read for another position just before a trade isn't the trade's
   * price). Waiting reads still back off: the moment is in the past, so once one read after it
   * is cached, later ticks are served from it as before.
   */
  event(eventTicker: string, o: { notBeforeMs?: number } = {}): Promise<GeminiContract[]> {
    const ttl = this.#wait.get(eventTicker)?.ttl ?? READ_TTL_MS;
    const hit = this.#cache.get(eventTicker);
    if (hit && this.#now() - hit.at < ttl && hit.at >= (o.notBeforeMs ?? -Infinity)) return hit.value;
    const value = this.#read(eventTicker);
    value.catch(() => this.#cache.delete(eventTicker));
    this.#cache.set(eventTicker, { at: this.#now(), value });
    return value;
  }

  /** When the cached contracts of an event were read (ms), or null. */
  readAt(eventTicker: string): number | null {
    return this.#cache.get(eventTicker)?.at ?? null;
  }

  waiting(eventTicker: string): void {
    const readAt = this.#cache.get(eventTicker)?.at ?? this.#now();
    const prev = this.#wait.get(eventTicker);
    if (prev && readAt <= prev.readAt) return;
    const count = (prev?.count ?? 0) + 1;
    const backoff = count - GRACE_WAITS;
    const ttl = backoff <= 0 ? READ_TTL_MS : Math.min(WAIT_MAX_MS, WAIT_MIN_MS * 2 ** (backoff - 1));
    this.#wait.set(eventTicker, { count, ttl, readAt });
  }

  priced(eventTicker: string): void {
    this.#wait.delete(eventTicker);
  }
}
