// Price sources for the settler: Alpaca (US stock trades, free IEX feed) and Jupiter Price v3
// (issuer tokens). Each call returns the raw response next to the parsed price, so the settler
// can hash exactly what it priced from. Every read times out (http.ts), and Jupiter is read in
// batches of up to 50 mints with a per-tick cache, resting after a 429.

import type { ScaledUi } from "@thesis/venues/bank";
import { CoolDown, getJson, type FetchFn } from "../http.ts";

export type { FetchFn };

/** Jupiter Price v3's `scaledUiConfig` (ISO effective time) as a ScaledUi, or null. */
export function parseScaledUiConfig(cfg: any): ScaledUi | null {
  if (!cfg || typeof cfg !== "object") return null;
  const multiplier = Number(cfg.multiplier);
  if (!(multiplier > 0)) return null;
  const next = Number(cfg.newMultiplier ?? multiplier);
  const at = typeof cfg.newMultiplierEffectiveAt === "string" ? Math.floor(Date.parse(cfg.newMultiplierEffectiveAt) / 1000) : Number(cfg.newMultiplierEffectiveAt ?? 0);
  return { multiplier, newMultiplier: next > 0 ? next : multiplier, newMultiplierEffectiveAt: Number.isFinite(at) ? at : 0 };
}

/** One trade or quote, in USD, with when it happened (unix seconds). */
export type Observation = { price: number; at: number; raw: unknown };

export type TokenPrice = {
  mint: string;
  /** USD per UI token (after any Token-2022 scaled-UI multiplier), as Jupiter reports it. */
  usdPrice: number;
  /** Pooled liquidity in USD, as Jupiter reports it. */
  liquidityUsd: number;
  /** When the settler fetched it (unix seconds). Jupiter gives no publish time. */
  at: number;
  /**
   * The mint's Token-2022 ScaledUiAmount config, as Jupiter reports it (xStocks, Ondo), or null
   * when the token has none. Issuers raise the multiplier for splits and reinvested dividends:
   * the holder's raw balance stays put and shows more UI tokens, each worth less.
   */
  scaledUi?: ScaledUi | null;
  raw: unknown;
};

/** A stock split: one share before `exAt` becomes `ratio` shares from it (reverse splits < 1). */
export type Split = { exAt: number; ratio: number; raw: unknown };

export interface StockSource {
  /** The first trade at or after `fromSec` and no later than `untilSec`, or null if none yet. */
  firstTradeAtOrAfter(symbol: string, fromSec: number, untilSec: number): Promise<Observation | null>;
  latestTrade(symbol: string): Promise<Observation | null>;
  /** Splits whose ex-date falls in (fromSec, untilSec], oldest first. Optional: no source, no adjustment. */
  splits?(symbol: string, fromSec: number, untilSec: number): Promise<Split[]>;
}

export interface TokenSource {
  price(mint: string): Promise<TokenPrice | null>;
  /**
   * Reads these mints now, in as few calls as it can, so this tick's `price` calls answer from
   * memory. Optional: a source without it is read one mint at a time.
   */
  prefetch?(mints: string[]): Promise<void>;
}

const toSec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();

type AlpacaTrade = { p: number; t: string; s?: number; x?: string; c?: string[]; i?: number };

/** Alpaca market data, free "Basic" plan (IEX feed). Keys from ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY. */
export class AlpacaStocks implements StockSource {
  #headers: Record<string, string>;
  fetchFn: FetchFn;
  feed: string;
  base: string;
  constructor(keyId: string, secret: string, fetchFn: FetchFn = fetch, feed = "iex", base = "https://data.alpaca.markets") {
    this.fetchFn = fetchFn;
    this.feed = feed;
    this.base = base;
    this.#headers = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret };
  }
  #opts() {
    return { headers: this.#headers, fetchFn: this.fetchFn };
  }

  async firstTradeAtOrAfter(symbol: string, fromSec: number, untilSec: number): Promise<Observation | null> {
    if (untilSec < fromSec) return null;
    const qs = new URLSearchParams({ start: iso(fromSec), end: iso(untilSec), limit: "1", sort: "asc", feed: this.feed });
    const j = await getJson(`${this.base}/v2/stocks/${encodeURIComponent(symbol)}/trades?${qs}`, this.#opts());
    const t: AlpacaTrade | undefined = j?.trades?.[0];
    return t && typeof t.p === "number" ? { price: t.p, at: toSec(t.t), raw: { symbol, feed: this.feed, trade: t } } : null;
  }

  async latestTrade(symbol: string): Promise<Observation | null> {
    const qs = new URLSearchParams({ symbols: symbol, feed: this.feed });
    const j = await getJson(`${this.base}/v2/stocks/trades/latest?${qs}`, this.#opts());
    const t: AlpacaTrade | undefined = j?.trades?.[symbol];
    return t && typeof t.p === "number" ? { price: t.p, at: toSec(t.t), raw: { symbol, feed: this.feed, trade: t } } : null;
  }

  /**
   * Alpaca corporate actions (forward and reverse splits). An ex-date counts from 06:00 UTC that
   * day: after the previous evening's last after-hours print, before 04:00 ET pre-market opens.
   * Cached an hour per symbol and range.
   */
  async splits(symbol: string, fromSec: number, untilSec: number): Promise<Split[]> {
    if (untilSec <= fromSec) return [];
    const day = (s: number) => iso(s).slice(0, 10);
    const key = `${symbol}:${day(fromSec)}:${day(untilSec)}`;
    const hit = this.#splits.get(key);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.value.filter((x) => x.exAt > fromSec && x.exAt <= untilSec);
    const qs = new URLSearchParams({ symbols: symbol, types: "forward_split,reverse_split", start: day(fromSec), end: day(untilSec) });
    const j = await getJson(`${this.base}/v1/corporate-actions?${qs}`, this.#opts());
    const ca = j?.corporate_actions ?? {};
    const all: Split[] = [...(ca.forward_splits ?? []), ...(ca.reverse_splits ?? [])]
      .filter((x: any) => x.symbol === symbol && Number(x.new_rate) > 0 && Number(x.old_rate) > 0 && typeof x.ex_date === "string")
      .map((x: any) => ({ exAt: toSec(`${x.ex_date}T06:00:00Z`), ratio: Number(x.new_rate) / Number(x.old_rate), raw: x }))
      .sort((a, b) => a.exAt - b.exAt);
    this.#splits.set(key, { at: Date.now(), value: all });
    return all.filter((x) => x.exAt > fromSec && x.exAt <= untilSec);
  }
  #splits = new Map<string, { at: number; value: Split[] }>();
}

/** Price v3 takes up to 50 ids per call. */
export const JUPITER_PRICE_BATCH = 50;

/**
 * Jupiter Price v3, on api.jup.ag with JUPITER_API_KEY (the keyless lite-api is being retired).
 *
 * The settler calls `prefetch` once a tick, after it reads the chain's clock, with every mint it
 * may price live: a burst of positions costs one call per 50 mints instead of one per leg. An
 * answer is reused for `cacheSecs` (less than a tick), so no price is older than the tick that
 * signs it, and every leg is still priced at or after its own moment. A 429 rests the source
 * (CoolDown) instead of being retried.
 */
export class JupiterPrices implements TokenSource {
  #headers: Record<string, string>;
  #cache = new Map<string, { at: number; price: TokenPrice | null }>();
  #cool: CoolDown;
  fetchFn: FetchFn;
  now: () => number;
  base: string;
  cacheSecs: number;
  constructor(apiKey: string, fetchFn: FetchFn = fetch, now = () => Math.floor(Date.now() / 1000), o: { base?: string; cacheSecs?: number } = {}) {
    if (!apiKey) throw new Error("JUPITER_API_KEY is not set: token prices come from the keyed api.jup.ag");
    this.fetchFn = fetchFn;
    this.now = now;
    this.base = o.base ?? "https://api.jup.ag";
    this.cacheSecs = o.cacheSecs ?? 15;
    this.#headers = { "x-api-key": apiKey };
    this.#cool = new CoolDown(`${new URL(this.base).host}/price/v3`, { now: () => this.now() * 1000 });
  }

  async prefetch(mints: string[]): Promise<void> {
    this.#cache.clear();
    const uniq = [...new Set(mints)];
    for (let i = 0; i < uniq.length; i += JUPITER_PRICE_BATCH) await this.#read(uniq.slice(i, i + JUPITER_PRICE_BATCH));
  }

  async price(mint: string): Promise<TokenPrice | null> {
    const hit = this.#cache.get(mint);
    if (hit && this.now() - hit.at <= this.cacheSecs) return hit.price;
    await this.#read([mint]);
    return this.#cache.get(mint)?.price ?? null;
  }

  async #read(mints: string[]): Promise<void> {
    // A 5xx is retried once; a 429 isn't: it rests the source.
    const j = await this.#cool.run(() =>
      getJson(`${this.base}/price/v3?ids=${mints.join(",")}`, { headers: this.#headers, fetchFn: this.fetchFn, tries: 1, retryStatus: (s) => s >= 500 }),
    );
    const at = this.now();
    for (const mint of mints) {
      const p = j?.[mint];
      const price: TokenPrice | null =
        p && typeof p.usdPrice === "number"
          ? { mint, usdPrice: p.usdPrice, liquidityUsd: typeof p.liquidity === "number" ? p.liquidity : 0, at, scaledUi: parseScaledUiConfig(p.scaledUiConfig), raw: { mint, response: p } }
          : null;
      this.#cache.set(mint, { at, price });
    }
  }
}
