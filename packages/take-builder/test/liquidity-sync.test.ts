import assert from "node:assert/strict";
import { test } from "node:test";
import type { BankState, TokenEntry } from "../../venues/bank/src/state.ts";
import { liquidityChanges, syncBlocked, syncLiquidity, tokenLiquidity, type CatalogFlag } from "../src/liquidity-sync.ts";

const NOW = Date.parse("2026-12-15T01:00:00Z");
const tok = (o: { underlying: string; cls: TokenEntry["liquidity"]["class"]; pooled: number; comparable?: boolean; suspect?: boolean }): TokenEntry =>
  ({
    underlying: o.underlying,
    jupiterPooledUsd: o.pooled,
    ratio: o.comparable === false ? { comparable: false, underlyingPerUiToken: null, reason: "?", sources: [] } : { comparable: true, underlyingPerUiToken: 1, unit: "share", basis: "", sources: [] },
    liquidity: { class: o.cls, reason: o.cls === "no-route" ? "no route for $100" : "", cost100Pct: null, cost1000Pct: null, unitsPerUsd100: null, premium100Pct: null, ratioSuspect: o.suspect ?? false },
  }) as unknown as TokenEntry;

const state = (tokens: Record<string, TokenEntry>, probesOkAt: string | null = "2026-12-15T00:30:00Z"): BankState =>
  ({
    tokens,
    underlyings: {},
    venues: { phoenix: { at: "", gated: false, markets: [{ symbol: "NVDA", tradeable: true }, { symbol: "DRV", tradeable: false }] }, gemini: null, cards: null, yield: null },
    tiers: { probes: { lastOkAt: probesOkAt, lastStartAt: null, lastError: null, lastDurationMs: null, runs: 1, requests: 0 } },
  }) as unknown as BankState;

test("XLEx (no route at $100), and a pre-IPO token and a stock under the $25k floor, go thin; a routed, deep token stays tradeable", () => {
  const s = state({
    XLEX: tok({ underlying: "etf:US:XLE", cls: "no-route", pooled: 113 }),
    SPCX: tok({ underlying: "private:SPACEX", cls: "tradeable", pooled: 20_000 }),
    NVDA: tok({ underlying: "equity:US:NVDA", cls: "tradeable", pooled: 15_000 }),
    MSFT: tok({ underlying: "equity:US:MSFT", cls: "tradeable", pooled: 60_000 }),
    PAXG: tok({ underlying: "commodity:XAU", cls: "tradeable", pooled: 104_000 }),
  });
  const catalog: CatalogFlag[] = [
    { id: "jup:XLEX", kind: "etf", liquidity: "tradeable" },
    { id: "jup:SPCX", kind: "pre-ipo", liquidity: "tradeable" },
    { id: "jup:NVDA", kind: "stock", liquidity: "tradeable" },
    { id: "jup:MSFT", kind: "stock", liquidity: "tradeable" },
    { id: "jup:PAXG", kind: "commodity", liquidity: "tradeable" },
  ];
  const changes = liquidityChanges(s, catalog);
  assert.deepEqual(changes.map((c) => [c.id, c.liquidity]), [["jup:XLEX", "thin"], ["jup:SPCX", "thin"], ["jup:NVDA", "thin"]]);
  assert.match(changes[1].why, /floor/);
});

test("tradeable needs both the price-impact probe and $25k pooled, stocks included; unknown or unprobed tokens are left alone", () => {
  assert.equal(tokenLiquidity(tok({ underlying: "equity:US:FWDI", cls: "tradeable", pooled: 24_711 }))?.liquidity, "thin");
  assert.equal(tokenLiquidity(tok({ underlying: "equity:US:FWDI", cls: "tradeable", pooled: 25_000 }))?.liquidity, "tradeable");
  assert.equal(tokenLiquidity(tok({ underlying: "equity:US:FWDI", cls: "thin", pooled: 1e6 }))?.liquidity, "thin");
  assert.equal(tokenLiquidity(tok({ underlying: "equity:US:AAPL", cls: "unprobed", pooled: 1e6 })), null);
  assert.equal(tokenLiquidity(undefined), null);
  assert.equal(tokenLiquidity(tok({ underlying: "equity:US:VT", cls: "tradeable", pooled: 1e6, suspect: true }))?.liquidity, "thin");
  assert.equal(tokenLiquidity(tok({ underlying: "commodity:XAU", cls: "tradeable", pooled: 1e6, comparable: false }))?.liquidity, "thin");
});

test("thin rows that route again come back; perps follow Phoenix; yield, cards and predictions are never touched", () => {
  const s = state({ MU: tok({ underlying: "equity:US:MU", cls: "tradeable", pooled: 300_000 }) });
  const changes = liquidityChanges(s, [
    { id: "jup:MU", kind: "stock", liquidity: "thin" },
    { id: "phoenix:NVDA", kind: "perp", liquidity: "thin" },
    { id: "phoenix:DRV", kind: "perp", liquidity: "tradeable" },
    { id: "phoenix:GONE", kind: "perp", liquidity: "tradeable" },
    { id: "jup:MU", kind: "yield", liquidity: "thin" },
    { id: "cards:Pokemon", kind: "card", liquidity: "tradeable" },
  ]);
  assert.deepEqual(changes.map((c) => [c.id, c.liquidity]), [["jup:MU", "tradeable"], ["phoenix:NVDA", "tradeable"], ["phoenix:DRV", "thin"]]);
});

test("refuses on stale probes, or when it would take most tradeable rows out", () => {
  const catalog: CatalogFlag[] = [1, 2, 3, 4].map((i) => ({ id: `jup:T${i}`, kind: "stock", liquidity: "tradeable" }));
  const tokens = Object.fromEntries([1, 2, 3, 4].map((i) => [`T${i}`, tok({ underlying: `equity:US:T${i}`, cls: "no-route", pooled: 0 })]));
  const s = state(tokens);
  assert.match(syncBlocked(s, catalog, liquidityChanges(s, catalog), NOW) ?? "", /probe outage/);
  const stale = state({}, "2026-12-14T12:00:00Z");
  assert.match(syncBlocked(stale, catalog, [], NOW) ?? "", /3 hours/);
  assert.equal(syncBlocked(state({}), catalog, [], NOW), null);
});

test("syncLiquidity reads the catalog publicly and posts only the changes behind the index secret", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/rest/v1/securities") && String(url).includes("id=like.jup:")) {
      return new Response(JSON.stringify([{ id: "jup:XLEX", kind: "etf", liquidity: "tradeable" }, { id: "jup:NVDA", kind: "stock", liquidity: "tradeable" }]));
    }
    if (String(url).includes("/rest/v1/securities")) return new Response("[]");
    return new Response(JSON.stringify({ updated: 1 }));
  }) as unknown as typeof fetch;
  const s = state({ XLEX: tok({ underlying: "etf:US:XLE", cls: "no-route", pooled: 113 }), NVDA: tok({ underlying: "equity:US:NVDA", cls: "tradeable", pooled: 2e6 }) });
  const changes = await syncLiquidity(s, { supabaseUrl: "https://db", secret: "s3", publishableKey: "pk", batch: 3, parallel: 1 }, { fetch: fetchFn, log: () => {}, nowMs: NOW });
  assert.deepEqual(changes.map((c) => c.id), ["jup:XLEX"]);
  const post = calls.find((c) => c.init?.method === "POST")!;
  assert.equal(post.url, "https://db/functions/v1/securities-index");
  assert.equal((post.init!.headers as Record<string, string>)["x-index-secret"], "s3");
  assert.deepEqual(JSON.parse(String(post.init!.body)), { liquidity: [{ id: "jup:XLEX", liquidity: "thin" }] });
});
