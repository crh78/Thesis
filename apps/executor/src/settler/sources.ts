// Price sources for the settler: Alpaca (US stock trades, free IEX feed) and Jupiter Price v3
// (issuer tokens). Each call returns the raw response next to the parsed price, so the settler
// can hash exactly what it priced from.

import type { ScaledUi } from "@thesis/venues/bank";

export type FetchFn = typeof fetch;

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
}

const toSec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();

async function getJson(fetchFn: FetchFn, url: string, headers: Record<string, string>): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url, { headers });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    throw new Error(`${new URL(url).host}${new URL(url).pathname}: HTTP ${res.status}`);
  }
}

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

  async firstTradeAtOrAfter(symbol: string, fromSec: number, untilSec: number): Promise<Observation | null> {
    if (untilSec < fromSec) return null;
    const qs = new URLSearchParams({ start: iso(fromSec), end: iso(untilSec), limit: "1", sort: "asc", feed: this.feed });
    const j = await getJson(this.fetchFn, `${this.base}/v2/stocks/${encodeURIComponent(symbol)}/trades?${qs}`, this.#headers);
    const t: AlpacaTrade | undefined = j?.trades?.[0];
    return t && typeof t.p === "number" ? { price: t.p, at: toSec(t.t), raw: { symbol, feed: this.feed, trade: t } } : null;
  }

  async latestTrade(symbol: string): Promise<Observation | null> {
    const qs = new URLSearchParams({ symbols: symbol, feed: this.feed });
    const j = await getJson(this.fetchFn, `${this.base}/v2/stocks/trades/latest?${qs}`, this.#headers);
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
    const j = await getJson(this.fetchFn, `${this.base}/v1/corporate-actions?${qs}`, this.#headers);
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

/** Jupiter Price v3. With JUPITER_API_KEY it uses api.jup.ag, otherwise the keyless lite-api. */
export class JupiterPrices implements TokenSource {
  #base: string;
  #headers: Record<string, string>;
  fetchFn: FetchFn;
  now: () => number;
  constructor(apiKey: string | null, fetchFn: FetchFn = fetch, now = () => Math.floor(Date.now() / 1000)) {
    this.fetchFn = fetchFn;
    this.now = now;
    this.#base = apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag";
    this.#headers = apiKey ? { "x-api-key": apiKey } : {};
  }

  async price(mint: string): Promise<TokenPrice | null> {
    const j = await getJson(this.fetchFn, `${this.#base}/price/v3?ids=${mint}`, this.#headers);
    const p = j?.[mint];
    if (!p || typeof p.usdPrice !== "number") return null;
    return { mint, usdPrice: p.usdPrice, liquidityUsd: typeof p.liquidity === "number" ? p.liquidity : 0, at: this.now(), scaledUi: parseScaledUiConfig(p.scaledUiConfig), raw: { mint, response: p } };
  }
}
