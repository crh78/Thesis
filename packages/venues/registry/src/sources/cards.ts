// Collector Crypt: pages through every live Collector Crypt marketplace listing
// (no key) and summarises categories, standards and USDC price ranges.
import { getJson, setMinGap } from "../lib/http.ts";
import { COMMON_SOURCES } from "../curated.ts";

type CardCategory = { category: string; listed: number; usdcListed: number; minUsd: number | null; medianUsd: number | null; p90Usd: number | null; maxUsd: number | null };

export type CardsSummary = {
  indexedCards: number;
  listedAllMarkets: number;
  listedOnCollectorCrypt: number;
  scanned: number;
  standards: Record<string, number>;
  currencies: Record<string, number>;
  categories: CardCategory[];
  insuredValueUsd: { median: number | null; p90: number | null };
  howToFetch: string;
};

const pctl = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);

export async function loadCollectorCrypt(maxPages = 80): Promise<CardsSummary> {
  setMinGap("api.collectorcrypt.com", 250);
  const base = COMMON_SOURCES.collectorCrypt;
  const all = await getJson<any>(`${base}?listPriceMin=0.000001&step=1`);
  const q = `listPriceMin=0.000001&marketplaceSource=CC&step=200&orderBy=listedDateDesc`;
  let cursor: string | null = null;
  const rows: any[] = [];
  let first: any = null;
  for (let page = 0; page < maxPages; page++) {
    const url: string = `${base}?${q}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r: any = await getJson<any>(url);
    if (!first) first = r;
    rows.push(...(r.filterNFtCard ?? []));
    cursor = r.nextCursor ?? null;
    if (!cursor) break;
  }
  const standards: Record<string, number> = {};
  const currencies: Record<string, number> = {};
  const byCat = new Map<string, { listed: number; usdc: number[] }>();
  const insured: number[] = [];
  for (const c of rows) {
    standards[c.nftStandard ?? "unknown"] = (standards[c.nftStandard ?? "unknown"] ?? 0) + 1;
    const cur = c.listing?.currency ?? "none";
    currencies[cur] = (currencies[cur] ?? 0) + 1;
    const cat = c.category || "(uncategorised)";
    const e = byCat.get(cat) ?? { listed: 0, usdc: [] };
    e.listed++;
    if (cur === "USDC" && typeof c.listing?.price === "number") e.usdc.push(c.listing.price);
    byCat.set(cat, e);
    const iv = Number(c.insuredValue);
    if (iv > 0) insured.push(iv);
  }
  insured.sort((a, b) => a - b);
  const categories = [...byCat.entries()]
    .map(([category, e]) => {
      const s = e.usdc.sort((a, b) => a - b);
      return { category, listed: e.listed, usdcListed: s.length, minUsd: s[0] ?? null, medianUsd: pctl(s, 0.5), p90Usd: pctl(s, 0.9), maxUsd: s[s.length - 1] ?? null };
    })
    .sort((a, b) => b.listed - a.listed);
  return {
    indexedCards: all.total,
    listedAllMarkets: all.findTotal,
    listedOnCollectorCrypt: first?.findTotal ?? rows.length,
    scanned: rows.length,
    standards,
    currencies,
    categories,
    insuredValueUsd: { median: pctl(insured, 0.5), p90: pctl(insured, 0.9) },
    howToFetch: `GET ${base}?listPriceMin=0.000001&marketplaceSource=CC&step=200, then follow nextCursor until null (no key; optional Bearer ccsk_ key raises limits). Single card: GET https://api.collectorcrypt.com/cards/publicNft/{cardId}/market`,
  };
}
