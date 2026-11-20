// deno test supabase/functions/_shared/catalog_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { displayPrice, parseScaledUi, scaleChart, withLiveApy } from "./catalog.ts";

Deno.test("the Jupiter Lend yield row shows the vault's live APY (5.65% snapshot vs 3.80% live); other rows are untouched", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{ address: "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D", totalRate: "380" }]))) as typeof fetch;
  try {
    const lend = { id: "yield:9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D", kind: "yield", venue: "Jupiter Lend Earn", mint: null, data: { apyPct: 5.65 } as Record<string, unknown> };
    const kamino = { id: "yield:K", kind: "yield", venue: "Kamino Earn", mint: null, data: { apyPct: 7.5 } as Record<string, unknown> };
    await withLiveApy([lend, kamino]);
    assertEquals(lend.data.apyPct, 3.8);
    assertEquals(kamino.data.apyPct, 7.5);
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("charts: raw-token candles are divided by the multiplier in force at each point", () => {
  const cfg = parseScaledUi({ multiplier: 1.02, newMultiplier: 10, newMultiplierEffectiveAt: "2026-12-15T00:00:00Z" });
  const split = Date.parse("2026-12-15T00:00:00Z") / 1000;
  assertEquals(scaleChart([[split - 60, 102], [split, 1000], [(split + 60) * 1000, 990]], cfg), [[split - 60, 100], [split, 100], [(split + 60) * 1000, 99]]);
  assertEquals(scaleChart([[1, 5]], null), [[1, 5]]);
  assertEquals(parseScaledUi(undefined), null);
});

Deno.test("XLEx as Jupiter returned it: a $113 pool shows the stock's price, flagged", () => {
  const p = displayPrice({ usdPrice: 39.187, priceChange24h: -3, liquidity: 113.3, stockData: { price: 64.96 } });
  assertEquals(p?.usd, 64.96);
  assertEquals(p?.source, "stock");
  assertEquals(p?.change24hPct, null);
});

Deno.test("no band: a token with $25k+ pooled keeps its own price, however far from its stock", () => {
  const p = displayPrice({ usdPrice: 56.2, priceChange24h: -9, liquidity: 895_407, stockData: { price: 62.2 } });
  assertEquals(p, { usd: 56.2, change24hPct: -9, source: "token", note: null });
  assertEquals(displayPrice({ usdPrice: 90, liquidity: 25_000, stockData: { price: 100 } })?.source, "token");
  assertEquals(displayPrice({ usdPrice: 90, liquidity: 24_999, stockData: { price: 100 } })?.source, "stock");
});

Deno.test("a thin non-stock token keeps its price, with a note; no price stays no price", () => {
  const p = displayPrice({ usdPrice: 2.5, liquidity: 4_000 });
  assertEquals([p?.usd, p?.source, typeof p?.note], [2.5, "token", "string"]);
  assertEquals(displayPrice({ usdPrice: 0 }), null);
  assertEquals(displayPrice(null), null);
});
