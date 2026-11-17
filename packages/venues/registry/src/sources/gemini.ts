// Gemini prediction markets: public market data (no key), read through the Thesis `gemini` edge
// function so Gemini never sees this machine's address (packages/venues/gemini).
import { geminiProxy, geminiRequest, parseEvent, type GeminiContract, type GeminiPath } from "../../../gemini/src/index.ts";
import { COMMON_SOURCES } from "../curated.ts";
import { envVar } from "../lib/env.ts";
import { getJson, setMinGap } from "../lib/http.ts";

type GeminiEvent = { ticker: string; title: string; category: string; subcategory: string | null; contracts: number; volumeUsd: number; volume24hUsd: number; expiry: string | null };
type GeminiCategory = { category: string; activeEvents: number; activeContracts: number; volumeUsd: number; volume24hUsd: number; top: GeminiEvent[] };
export type GeminiSummary = { categories: GeminiCategory[]; listedCategories: string[]; totalActiveEvents: number; howToList: string };

export async function loadGemini(): Promise<GeminiSummary> {
  return (await loadGeminiMarkets()).summary;
}

/** The summary (for docs/liquidity.md) and every active contract (for the asset bank), in one pass. */
export async function loadGeminiMarkets(): Promise<{ summary: GeminiSummary; contracts: GeminiContract[] }> {
  const proxy = geminiProxy(envVar);
  // Gemini asks public callers to stay under 1 request a second (120 a minute at most). A sweep is
  // about 30 reads, so it takes about 30 s.
  setMinGap(new URL(proxy.base).host, 1_000);
  const read = <T>(path: GeminiPath, query: Record<string, string | number> = {}) => {
    const { url, headers } = geminiRequest(proxy, path, query);
    return getJson<T>(url, { headers });
  };
  const { categories: listed } = await read<{ categories: string[] }>("categories");
  // The unfiltered list skips some categories (Politics, Tech, ...), so page each listed category.
  const events = new Map<string, GeminiEvent>();
  const contracts = new Map<string, GeminiContract>();
  for (const cat of listed) {
    for (let offset = 0; offset < 5000; offset += 100) {
      const r = await read<any>("events", { status: "active", category: cat, limit: 100, offset });
      for (const e of r.data ?? []) {
        if (events.has(e.ticker)) continue;
        for (const c of parseEvent({ ...e, category: e.category ?? cat })) contracts.set(c.instrumentSymbol, c);
        events.set(e.ticker, {
          ticker: e.ticker,
          title: e.title,
          category: e.category ?? cat,
          subcategory: e.subcategory?.name ?? (typeof e.subcategory === "string" ? e.subcategory : null),
          contracts: (e.contracts ?? []).length,
          volumeUsd: Number(e.volume ?? 0),
          volume24hUsd: Number(e.volume24h ?? 0),
          expiry: e.expiryDate ?? null,
        });
      }
      const total = r.pagination?.total ?? 0;
      if (!r.data?.length || offset + 100 >= total) break;
    }
  }
  const byCat = new Map<string, GeminiEvent[]>();
  for (const e of events.values()) byCat.set(e.category, [...(byCat.get(e.category) ?? []), e]);
  const categories = [...byCat.entries()]
    .map(([category, list]) => ({
      category,
      activeEvents: list.length,
      activeContracts: list.reduce((a, e) => a + e.contracts, 0),
      volumeUsd: list.reduce((a, e) => a + e.volumeUsd, 0),
      volume24hUsd: list.reduce((a, e) => a + e.volume24hUsd, 0),
      top: [...list].sort((a, b) => b.volume24hUsd - a.volume24hUsd || b.volumeUsd - a.volumeUsd).slice(0, 3),
    }))
    .sort((a, b) => b.activeEvents - a.activeEvents);
  const summary = {
    categories,
    listedCategories: listed,
    totalActiveEvents: events.size,
    howToList: `GET ${COMMON_SOURCES.geminiCategories}, then GET ${COMMON_SOURCES.gemini}?status=active&category=<name>&limit=100&offset=<n> (pagination.total gives the count). Contracts carry instrumentSymbol, prices.buy/sell.yes/no, expiryDate and termsAndConditionsUrl.`,
  };
  return { summary, contracts: [...contracts.values()] };
}
