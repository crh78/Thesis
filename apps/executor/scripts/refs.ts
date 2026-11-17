// Independent reference prices for the sweep and dogfood scripts: keyless, and never the venue
// being checked. Crypto: Coinbase spot. Gold: Kraken XAUT (Tether Gold, a different issuer from
// PAXG). US stocks and stock perps: Alpaca's last trade (the settler's own fallback source).
// (Pyth Hermes needs an API key, and PYTH_API_KEY is empty.)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function get(url: string, headers: Record<string, string> = {}): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (r?.ok) return r.json();
    if (r && r.status !== 429 && r.status < 500) return null;
    if (i >= 4) return null;
    await sleep(1000 * 2 ** i);
  }
}

const cache = new Map<string, Promise<number | null>>();
const once = (k: string, fn: () => Promise<number | null>) => {
  if (!cache.has(k)) cache.set(k, fn().catch(() => null));
  return cache.get(k)!;
};

/** Coinbase spot for a crypto base (SOL, PEPE, ...). */
export const cryptoSpot = (base: string) =>
  once(`cb:${base}`, async () => {
    const j = await get(`https://api.exchange.coinbase.com/products/${encodeURIComponent(base.toUpperCase())}-USD/ticker`);
    const p = Number(j?.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  });

/** Gold per troy ounce from Kraken's XAUT/USD (silver: no keyless reference, null). */
export const metalSpot = (metal: "XAU" | "XAG") =>
  once(`kr:${metal}`, async () => {
    if (metal !== "XAU") return null;
    const j = await get("https://api.kraken.com/0/public/Ticker?pair=XAUTUSD");
    const r = j?.result && (Object.values(j.result)[0] as any);
    const p = Number(r?.c?.[0]);
    return Number.isFinite(p) && p > 0 ? p : null;
  });

/** Alpaca's latest trade for US tickers (IEX feed). */
export async function alpacaLatest(symbols: string[], h: Record<string, string>): Promise<Map<string, { p: number; t: number }>> {
  const out = new Map<string, { p: number; t: number }>();
  const uniq = [...new Set(symbols)];
  for (let i = 0; i < uniq.length; i += 100) {
    const j = await get(`https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${encodeURIComponent(uniq.slice(i, i + 100).join(","))}&feed=iex`, h);
    for (const [s, t] of Object.entries<any>(j?.trades ?? {})) out.set(s, { p: t.p, t: Math.floor(Date.parse(t.t) / 1000) });
  }
  return out;
}
