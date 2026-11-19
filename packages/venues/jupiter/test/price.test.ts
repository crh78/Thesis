import assert from "node:assert/strict";
import { test } from "node:test";
import { PRICE_TTL_MS, PriceCache, jupiterPrices } from "../src/index.ts";

// Prices for repricing kept routes (price.ts): Price v3 in batches of 50, and a short shared cache.

const priced = (ids: string[]) => Response.json(Object.fromEntries(ids.map((m, i) => [m, { usdPrice: 100 + i, liquidity: 1_000_000 }])));

test("jupiterPrices reads up to 50 mints a call, with the key, and skips what Jupiter doesn't price", async () => {
  const urls: URL[] = [];
  const keys: (string | null)[] = [];
  const mints = Array.from({ length: 51 }, (_, i) => `M${i}`);
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    urls.push(u);
    keys.push(new Headers(init?.headers).get("x-api-key"));
    const ids = u.searchParams.get("ids")!.split(",");
    // M1 has no price; M2's is junk.
    return Response.json(Object.fromEntries(ids.flatMap((m) => (m === "M1" ? [] : [[m, { usdPrice: m === "M2" ? "lots" : 7 }]]))));
  }) as typeof fetch;
  const prices = await jupiterPrices(mints, { apiKey: "the-key", fetchFn });
  assert.deepEqual(urls.map((u) => [u.origin, u.pathname, u.searchParams.get("ids")!.split(",").length]), [["https://api.jup.ag", "/price/v3", 50], ["https://api.jup.ag", "/price/v3", 1]]);
  assert.deepEqual(keys, ["the-key", "the-key"]);
  assert.equal(prices.size, 49);
  assert.equal(prices.get("M0"), 7);
  assert.ok(!prices.has("M1") && !prices.has("M2"));
  await assert.rejects(jupiterPrices(["A"], { fetchFn: (async () => new Response("{}", { status: 500 })) as typeof fetch }), /HTTP 500/);
});

test("the cache serves prices for PRICE_TTL_MS, reads only the missing mints, in one call", async () => {
  let now = 1_000_000;
  const cache = new PriceCache(PRICE_TTL_MS, () => now);
  const reads: string[][] = [];
  const read = async (ms: string[]) => {
    reads.push(ms);
    return new Map(ms.map((m) => [m, 5] as const));
  };
  assert.deepEqual([...(await cache.get(["A", "B", "A"], read)).keys()], ["A", "B"]);
  now += PRICE_TTL_MS;
  const second = await cache.get(["A", "C"], read);
  assert.deepEqual(second.get("A"), { usd: 5, at: 1_000_000 }, "still fresh at exactly the TTL");
  assert.deepEqual(reads, [["A", "B"], ["C"]]);
  now += 1;
  await cache.get(["A"], read);
  assert.deepEqual(reads.at(-1), ["A"], "past it: read again");
  assert.equal(cache.peek("B"), null);
  assert.deepEqual(cache.peek("B", 60_000), { usd: 5, at: 1_000_000 });
  assert.deepEqual(cache.stats, { reads: 3, failed: 0 });
});

test("builds asking at once share one read; a failed read leaves the mints missing", async () => {
  const cache = new PriceCache();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const read = async (ms: string[]) => {
    calls++;
    await gate;
    return priced(ms).json().then((j: Record<string, { usdPrice: number }>) => new Map(Object.entries(j).map(([m, p]) => [m, p.usdPrice] as const)));
  };
  const [x, y] = [cache.get(["A", "B"], read), cache.get(["B"], read)];
  release();
  assert.equal((await x).size, 2);
  assert.equal((await y).get("B")?.usd, 101);
  assert.equal(calls, 1);
  const failing = new PriceCache();
  const out = await failing.get(["A"], async () => {
    throw new Error("budget refused");
  });
  assert.equal(out.size, 0);
  assert.deepEqual(failing.stats, { reads: 1, failed: 1 });
});
