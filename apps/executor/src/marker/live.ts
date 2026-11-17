// Live marks, the I/O part: what's open (public reads with the publishable key), and the prices
// the marking rules in mark.ts read, fetched once per run and paced for each source.
import type { ScaledUi } from "@thesis/venues/bank";
import { fetchGeminiEvent, type GeminiContract, type GeminiProxy } from "@thesis/venues/gemini";
import { jupiterLendShareValue } from "@thesis/venues/jupiter";
import type { PhoenixVenue } from "@thesis/venues/phoenix";
import type { StockSource } from "../settler/sources.ts";
import { effectiveMultiplier } from "@thesis/venues/bank";
import type { Base, BankLookup, Leg, PickAsset, Security, Snapshot } from "./mark.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url: string, headers: Record<string, string> = {}, tries = 5): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (r?.ok) return r.json();
    if (r && r.status !== 429 && r.status < 500) throw new Error(`${new URL(url).host}${new URL(url).pathname}: HTTP ${r.status} ${await r.text().catch(() => "")}`.slice(0, 300));
    if (i >= tries) throw new Error(`${new URL(url).host}${new URL(url).pathname}: ${r ? `HTTP ${r.status}` : "unreachable"}`);
    await sleep(Math.min(20_000, 1_000 * 2 ** i));
  }
}

// --- What's open -------------------------------------------------------------------------------

export type OpenTake = { id: string; created_at: string; settles_at: string; legs: Leg[] };

export class Db {
  url: string;
  #h: Record<string, string>;
  /** False until a read shows the live-marks migration is applied (base/mark columns exist). */
  hasMarkColumns = true;
  constructor(url: string, key: string) {
    this.url = url;
    this.#h = { apikey: key, Authorization: `Bearer ${key}` };
  }
  get(path: string) {
    return getJson(`${this.url}/rest/v1/${path}`, this.#h);
  }

  /** Takes still running (before their horizon, not settled on chain), with their picks. */
  async openTakes(limit = 500): Promise<OpenTake[]> {
    const now = new Date().toISOString();
    const takes: { id: string; created_at: string; settles_at: string }[] = await this.get(`takes?select=id,created_at,settles_at&settles_at=gt.${now}&order=created_at.desc&limit=${limit}`);
    if (!takes.length) return [];
    const ids = takes.map((t) => t.id);
    const settled = new Set<string>();
    const legs: (Leg & { take_id: string })[] = [];
    const cols = "take_id,idx,name,kind,weight,asset_id,ret_pct";
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80).join(",");
      for (const c of await this.get(`chain_takes?select=take_id,settled&take_id=in.(${chunk})`)) if (c.settled) settled.add(c.take_id);
      let rows: any[];
      try {
        rows = await this.get(`take_legs?select=${cols},base_price,base_at,base_source,mark_price&take_id=in.(${chunk})&order=take_id,idx`);
      } catch (e) {
        // Before the migration: no base/mark columns. Marks are computed in memory (dry runs).
        if (!/column|42703|PGRST/.test(String(e))) throw e;
        this.hasMarkColumns = false;
        rows = await this.get(`take_legs?select=${cols}&take_id=in.(${chunk})&order=take_id,idx`);
      }
      legs.push(...rows.map((r) => ({ ...r, weight: Number(r.weight) })));
    }
    const byTake = new Map<string, Leg[]>();
    for (const l of legs) {
      const list = byTake.get(l.take_id) ?? [];
      list.push(l);
      byTake.set(l.take_id, list);
    }
    return takes.filter((t) => !settled.has(t.id)).map((t) => ({ ...t, legs: byTake.get(t.id) ?? [] }));
  }

  async securities(ids: string[]): Promise<Map<string, Security>> {
    const out = new Map<string, Security>();
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += 60) {
      const chunk = uniq.slice(i, i + 60).map((x) => `"${x.replace(/"/g, "")}"`).join(",");
      for (const s of await this.get(`securities?select=id,kind,symbol,name,underlying,mint,data&id=in.(${chunk})`)) out.set(s.id, s);
    }
    return out;
  }

  /**
   * Open on-chain positions on a network, with the Thesis take each is on, and whether it's the
   * take author's own buy-in (its entry prices set the take's result).
   */
  async openPositions(network: string): Promise<{ address: string; take: string; side: "back" | "fade"; opened_at: string | null; take_id: string | null; isAuthor: boolean }[]> {
    const rows: any[] = await this.get(`chain_positions?select=address,take,owner,side,opened_at&network=eq.${network}&settled_at=is.null&limit=2000`);
    if (!rows.length) return [];
    const takes = [...new Set(rows.map((r) => r.take))];
    const byAddress = new Map<string, { take_id: string; author: string | null }>();
    for (let i = 0; i < takes.length; i += 80) {
      const chunk = takes.slice(i, i + 80).map((x) => `"${x}"`).join(",");
      for (const c of await this.get(`chain_takes?select=address,take_id,author_wallet&network=eq.${network}&address=in.(${chunk})`)) {
        byAddress.set(c.address, { take_id: c.take_id, author: c.author_wallet ?? null });
      }
    }
    return rows.map(({ owner, ...r }) => {
      const t = byAddress.get(r.take);
      return { ...r, take_id: t?.take_id ?? null, isAuthor: !!t?.author && owner === t.author && r.side === "back" };
    });
  }
}

// --- Prices ------------------------------------------------------------------------------------

/** Jupiter Price v3's `scaledUiConfig` as a ScaledUi; null when it has none. */
export function parseScaledUi(cfg: any): ScaledUi | null {
  if (!cfg || typeof cfg !== "object") return null;
  const multiplier = Number(cfg.multiplier);
  if (!(multiplier > 0)) return null;
  const next = Number(cfg.newMultiplier ?? multiplier);
  const at = typeof cfg.newMultiplierEffectiveAt === "string" ? Math.floor(Date.parse(cfg.newMultiplierEffectiveAt) / 1000) : Number(cfg.newMultiplierEffectiveAt ?? 0);
  return { multiplier, newMultiplier: next > 0 ? next : multiplier, newMultiplierEffectiveAt: Number.isFinite(at) ? at : 0 };
}

export type LiveDeps = {
  jupiterBase?: string;
  jupiterHeaders?: Record<string, string>;
  alpacaHeaders: Record<string, string>;
  phoenix: Pick<PhoenixVenue, "mid" | "markAtOrAfter">;
  gemini: GeminiProxy | null;
  log?: (m: string) => void;
  /** Card insured values by card id, from the asset bank's picked cards (no Collector Crypt request here). */
  cards?: Map<string, number>;
};

/** Reads every price the assets need, once: Jupiter in batches of 50, Phoenix ~1 read/2 s, Gemini ≤1/s. */
export async function snapshot(assets: PickAsset[], d: LiveDeps, extraPerps: string[] = []): Promise<Snapshot> {
  const nowSec = Math.floor(Date.now() / 1000);
  const snap: Snapshot = { nowSec, tokens: new Map(), stocks: new Map(), perps: new Map(), events: new Map(), lend: null, cards: d.cards ?? new Map() };
  const mints = [...new Set(assets.flatMap((a) => (a.type === "spot" ? [a.mint] : [])))];
  const jup = d.jupiterBase ?? "https://lite-api.jup.ag";
  for (let i = 0; i < mints.length; i += 50) {
    const batch = mints.slice(i, i + 50);
    const j = await getJson(`${jup}/price/v3?ids=${batch.join(",")}`, d.jupiterHeaders ?? {}).catch((e) => (d.log?.(`jupiter: ${e}`), {}));
    for (const m of batch) {
      const p = j?.[m];
      if (p && typeof p.usdPrice === "number") snap.tokens.set(m, { usdPrice: p.usdPrice, liquidityUsd: typeof p.liquidity === "number" ? p.liquidity : 0, scaledUi: "scaledUiConfig" in p ? parseScaledUi(p.scaledUiConfig) : null });
    }
    if (i + 50 < mints.length) await sleep(1_200);
  }
  const tickers = [...new Set(assets.flatMap((a) => (a.type === "spot" && a.stock ? [a.stock] : [])))];
  for (let i = 0; i < tickers.length; i += 100) {
    const qs = encodeURIComponent(tickers.slice(i, i + 100).join(","));
    const j = await getJson(`https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${qs}&feed=iex`, d.alpacaHeaders).catch((e) => (d.log?.(`alpaca: ${e}`), {}));
    for (const [s, t] of Object.entries<any>(j?.trades ?? {})) if (typeof t?.p === "number") snap.stocks.set(s, { price: t.p, at: Math.floor(Date.parse(t.t) / 1000) });
  }
  const symbols = [...new Set([...assets.flatMap((a) => (a.type === "perp" ? [a.symbol] : [])), ...extraPerps])];
  for (const s of symbols) {
    // The mark Phoenix values positions on (the settler's source), else the book's mid.
    const mark = await d.phoenix.markAtOrAfter(s, nowSec - 180, 175).catch(() => null);
    if (mark && mark.price > 0) snap.perps.set(s, { price: mark.price, rule: "phoenix-mark" });
    else {
      const mid = await d.phoenix.mid(s).catch(() => null);
      if (mid && mid > 0) snap.perps.set(s, { price: mid, rule: "phoenix-mid" });
    }
    await sleep(2_100);
  }
  if (d.gemini) {
    const tickersG = [...new Set(assets.flatMap((a) => (a.type === "prediction" ? [a.eventTicker] : [])))];
    for (const t of tickersG) {
      const cs: GeminiContract[] | null = await fetchGeminiEvent(d.gemini, t).catch((e) => (d.log?.(`gemini ${t}: ${e}`), null));
      if (cs) snap.events.set(t, cs);
      await sleep(1_100);
    }
  }
  if (assets.some((a) => a.type === "yield")) {
    const list: any[] = await getJson("https://lite-api.jup.ag/lend/v1/earn/tokens").catch(() => []);
    const jl = list.find((x) => x.asset?.symbol === "USDC");
    const v = jl ? await jupiterLendShareValue(jl.address, {}).catch(() => null) : null;
    snap.lend = v?.usdcPerShare ?? null;
  }
  return snap;
}

/**
 * Bases for older takes, from history where a source keeps it: a stock's first trade at or after
 * the posting (Alpaca), a perp's first Phoenix bar at or after it. Everything else (tokens with no
 * stock, predictions, yield) has no history to read and takes its first mark as the base.
 */
export async function historicalBase(
  asset: PickAsset,
  createdAtSec: number,
  nowSec: number,
  d: { stocks: Pick<StockSource, "firstTradeAtOrAfter">; phoenix: Pick<PhoenixVenue, "markAtOrAfter"> },
  snap: Snapshot,
): Promise<Base | null> {
  if (asset.type === "spot" && asset.stock) {
    const tr = await d.stocks.firstTradeAtOrAfter(asset.stock, createdAtSec, Math.min(nowSec, createdAtSec + 4 * 86_400)).catch(() => null);
    if (!tr || !(tr.price > 0)) return null;
    // The multiplier then: Jupiter's live config (with its scheduled change), else the bank's.
    const live = snap.tokens.get(asset.mint)?.scaledUi;
    const cfg = live !== undefined ? live : asset.scaledUi;
    const multiplier = cfg === undefined ? null : effectiveMultiplier(cfg, createdAtSec);
    return {
      price: tr.price,
      at: new Date(tr.at * 1000).toISOString(),
      source: { source: "stock", rule: "stock-first-trade", code: asset.stock, mint: asset.mint, multiplier, inputs: { trade: tr.raw }, backfill: "the stock's first trade at or after the posting" },
    };
  }
  if (asset.type === "perp") {
    const bar = await d.phoenix.markAtOrAfter(asset.symbol, createdAtSec, 3_600).catch(() => null);
    await sleep(2_100);
    if (!bar || !(bar.price > 0)) return null;
    return {
      price: bar.price / asset.units,
      at: new Date(bar.at * 1000).toISOString(),
      source: { source: "phoenix", rule: "phoenix-mark", symbol: asset.symbol, units: asset.units, backfill: "Phoenix's first one-minute bar at or after the posting" },
    };
  }
  return null;
}

/** The asset bank as the marker needs it (null bank: units default to 1, multipliers from Jupiter only). */
export function bankLookup(state: { tokens: Record<string, any>; venues: { phoenix: { markets: any[] } | null } } | null): BankLookup | null {
  if (!state) return null;
  const perps = new Map<string, { unitsPerContract: number; underlyingKey: string; tradeable: boolean; symbol: string }>();
  for (const m of state.venues.phoenix?.markets ?? []) perps.set(m.symbol, { unitsPerContract: m.unitsPerContract, underlyingKey: m.underlying, tradeable: m.tradeable, symbol: m.symbol });
  return {
    token(mint) {
      const t = state.tokens[mint];
      return t ? { underlyingKey: t.underlying, underlyingPerUiToken: t.ratio?.comparable ? t.ratio.underlyingPerUiToken : null, scaledUi: t.scaledUi ?? null } : null;
    },
    perp: (s) => perps.get(s) ?? null,
    perpFor(key) {
      for (const p of perps.values()) if (p.underlyingKey === key && p.tradeable) return { symbol: p.symbol, unitsPerContract: p.unitsPerContract };
      return null;
    },
  };
}
