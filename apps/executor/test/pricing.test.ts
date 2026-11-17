import assert from "node:assert/strict";
import { test } from "node:test";
import { entryBases, basisFromAuditLeg, type EntryBasis } from "../src/settler/basis.ts";
import { priceLeg, toPriceUnits, type LegToPrice, type PriceRules, type Sources } from "../src/settler/pricing.ts";
import type { Observation, TokenPrice } from "../src/settler/sources.ts";

const T = 1_800_000_000;
const rules: PriceRules = { minLiquidityUsd: 100_000, liveWindowSecs: 300, maxDelaySecs: 4 * 86_400 };
const NVDA = { key: "equity:US:NVDA", cls: "equity", code: "NVDA" };
const GOLD = { key: "commodity:XAU", cls: "commodity", code: "XAU" };
const spot = (o: Partial<LegToPrice> = {}): LegToPrice => ({
  index: 0,
  kind: "spot",
  underlying: NVDA,
  token: { mint: "NVDAx", underlyingPerUiToken: 1 },
  ...o,
});

type Calls = { first: [string, number, number][]; latest: string[]; token: string[] };
function sources(o: { token?: Partial<TokenPrice> | null; latest?: number | null; first?: Observation | null }): { src: Sources; calls: Calls } {
  const calls: Calls = { first: [], latest: [], token: [] };
  const src: Sources = {
    stocks: {
      async firstTradeAtOrAfter(symbol, from, until) {
        calls.first.push([symbol, from, until]);
        return o.first === undefined ? { price: 101, at: from + 30, raw: { first: true } } : o.first;
      },
      async latestTrade(symbol) {
        calls.latest.push(symbol);
        return o.latest === null ? null : { price: o.latest ?? 100, at: T, raw: { latest: true } };
      },
    },
    tokens: {
      async price(mint) {
        calls.token.push(mint);
        if (o.token === null) return null;
        return { mint, usdPrice: 100.5, liquidityUsd: 2_000_000, at: T + 10, raw: { mint }, ...o.token };
      },
    },
  };
  return { src, calls };
}

test("a liquid token is priced on the token", async () => {
  const { src } = sources({});
  const r = await priceLeg(spot(), T, T + 10, rules, src);
  assert.ok(r.ok);
  assert.equal(r.quote.rule, "issuer-token");
  assert.equal(r.quote.price, 100.5);
  assert.equal(r.quote.publishedAt, T + 10);
});

test("the token price is converted to one underlying unit", async () => {
  const { src } = sources({ token: { usdPrice: 50.25 } });
  const r = await priceLeg(spot({ token: { mint: "half", underlyingPerUiToken: 0.5 } }), T, T + 10, rules, src);
  assert.ok(r.ok);
  assert.equal(r.quote.price, 100.5);
});

test("token first: a token 3% over the stock is still priced on the token, and records its premium", async () => {
  const { src, calls } = sources({ token: { usdPrice: 103 } }); // 3% over a $100 stock
  const r = await priceLeg(spot(), T, T + 60, rules, src);
  assert.ok(r.ok);
  assert.equal(r.quote.rule, "issuer-token");
  assert.equal(r.quote.price, 103);
  assert.deepEqual(r.quote.basis, { source: "token", mint: "NVDAx", underlyingPerUiToken: 1, premium: 1.03, at: T });
  assert.deepEqual(calls.first, []);
});

test("the stock is the fallback when there's no token price", async () => {
  const { src, calls } = sources({ token: null });
  const r = await priceLeg(spot(), T, T + 60, rules, src);
  assert.ok(r.ok);
  assert.deepEqual(r.quote, { leg: 0, price: 101, publishedAt: T + 30, rule: "stock-first-trade", basis: { source: "stock", at: T }, inputs: { trade: { first: true } } });
  assert.deepEqual(calls.first, [["NVDA", T, T + 60]]);
});

test("a thin token falls back to the stock", async () => {
  const { src } = sources({ token: { liquidityUsd: 5_000 } });
  const r = await priceLeg(spot(), T, T + 10, rules, src);
  assert.ok(r.ok && r.quote.rule === "stock-first-trade");
});

test("after the live window the token isn't asked at all", async () => {
  const { src, calls } = sources({});
  const r = await priceLeg(spot(), T, T + 3_600, rules, src);
  assert.ok(r.ok && r.quote.rule === "stock-first-trade");
  assert.equal(calls.token.length, 0);
});

test("a token with an unknown ratio is never used", async () => {
  const { src, calls } = sources({});
  const r = await priceLeg(spot({ token: { mint: "x", underlyingPerUiToken: null } }), T, T + 10, rules, src);
  assert.ok(r.ok && r.quote.rule === "stock-first-trade");
  assert.equal(calls.token.length, 0);
});

test("market closed: wait for the first trade, then give up after the delay", async () => {
  const { src } = sources({ token: null, first: null });
  const waiting = await priceLeg(spot(), T, T + 3_600, rules, src);
  assert.deepEqual([waiting.ok, !waiting.ok && waiting.retry], [false, true]);
  const late = await priceLeg(spot(), T, T + rules.maxDelaySecs + 1, rules, src);
  assert.deepEqual([late.ok, !late.ok && late.retry], [false, false]);
});

test("a trade outside the window is never used", async () => {
  const { src } = sources({ token: null, first: { price: 1, at: T - 1, raw: {} } });
  const r = await priceLeg(spot(), T, T + 60, rules, src);
  assert.equal(r.ok, false);
});

test("perp legs on a stock use the stock", async () => {
  const { src } = sources({});
  const r = await priceLeg(spot({ kind: "perp", token: null }), T, T + 10, rules, src);
  assert.ok(r.ok && r.quote.rule === "stock-first-trade");
});

test("non-stock underlyings need a live liquid token", async () => {
  const { src } = sources({});
  const live = await priceLeg(spot({ underlying: GOLD }), T, T + 10, rules, src);
  assert.ok(live.ok && live.quote.rule === "issuer-token");
  const late = await priceLeg(spot({ underlying: GOLD }), T, T + 3_600, rules, src);
  assert.deepEqual([late.ok, !late.ok && late.retry], [false, false]);
});

test("legs with no source say so and don't retry", async () => {
  const { src } = sources({});
  // Prediction legs have Gemini as their source (prediction.test.ts), card legs Collector Crypt (cards.test.ts).
  for (const leg of [spot({ underlying: null })]) {
    const r = await priceLeg(leg, T, T + 10, rules, src);
    assert.deepEqual([r.ok, !r.ok && r.retry], [false, false]);
  }
});

test("prices never come from before the moment", async () => {
  const { src } = sources({ token: { at: T - 5 } });
  const r = await priceLeg(spot(), T, T + 10, rules, src);
  assert.ok(r.ok);
  assert.equal(r.quote.publishedAt, T);
  const early = await priceLeg(spot(), T, T - 1, rules, src);
  assert.equal(early.ok, false);
});

test("price units have 8 decimals", () => {
  assert.equal(toPriceUnits(184.36), 18_436_000_000n);
  assert.equal(toPriceUnits(0), 0n);
  assert.throws(() => toPriceUnits(-1));
});

// --- Bases: an exit is priced from the same source as its entry --------------------------------

test("a token-priced entry records its basis: the token and its premium to the stock", async () => {
  const { src } = sources({ token: { usdPrice: 99 } }); // 1% under a $100 stock
  const r = await priceLeg(spot(), T, T + 10, rules, src);
  assert.ok(r.ok);
  assert.equal(r.quote.rule, "issuer-token");
  assert.deepEqual(r.quote.basis, { source: "token", mint: "NVDAx", underlyingPerUiToken: 1, premium: 0.99, at: T });
});

const tokenBasis: EntryBasis = { source: "token", mint: "NVDAx", underlyingPerUiToken: 1, premium: 0.99 };

test("exit of a token-priced entry: the token while it's live and liquid", async () => {
  const { src, calls } = sources({ token: { usdPrice: 109 }, latest: 110 });
  const r = await priceLeg(spot(), T, T + 10, rules, src, tokenBasis);
  assert.ok(r.ok);
  assert.equal(r.quote.rule, "issuer-token");
  assert.equal(r.quote.price, 109);
  assert.deepEqual(calls.first, []);
});

test("exit of a token-priced entry the settler reached late: the stock times the entry premium", async () => {
  const { src, calls } = sources({ first: { price: 110, at: T + 30, raw: { first: true } } });
  const r = await priceLeg(spot(), T, T + 3_600, rules, src, tokenBasis); // past the live window
  assert.ok(r.ok);
  assert.equal(r.quote.rule, "stock-adjusted");
  assert.ok(Math.abs(r.quote.price - 108.9) < 1e-9, `price ${r.quote.price}`);
  assert.deepEqual(r.quote.inputs, { trade: { first: true }, premium: 0.99 });
  assert.deepEqual(calls.token, []);
});

test("exit of a stock-priced entry stays on the stock even when the token is live", async () => {
  const { src, calls } = sources({});
  const r = await priceLeg(spot(), T, T + 10, rules, src, { source: "stock" });
  assert.ok(r.ok);
  assert.equal(r.quote.rule, "stock-first-trade");
  assert.equal(r.quote.price, 101);
  assert.deepEqual(calls.token, []);
});

test("entry bases are read back from audit documents, including ones logged before bases existed", () => {
  const bases = entryBases([
    { moment: "entry", position: "P1", legs: [{ leg: 0, rule: "issuer-token", price: 99, inputs: { token: { mint: "NVDAx" }, underlyingPerUiToken: 1, bandRef: { trade: { p: 100 } } } }] },
    { moment: "entry", position: "P1", legs: [{ leg: 2, rule: "stock-first-trade", price: 50 }] },
    { moment: "exit", position: "P1", legs: [{ leg: 0, rule: "stock-first-trade", price: 120 }] },
    { moment: "entry", position: "P2", legs: [{ leg: 1, basis: tokenBasis }] },
  ]);
  assert.deepEqual(bases.get("P1:0"), { source: "token", mint: "NVDAx", underlyingPerUiToken: 1, premium: 0.99 });
  assert.deepEqual(bases.get("P1:2"), { source: "stock" });
  assert.deepEqual(bases.get("P2:1"), tokenBasis);
  assert.equal(bases.size, 3, "exit documents don't set a basis");
  assert.equal(basisFromAuditLeg({ leg: 0, rule: "issuer-token", inputs: {} }), null);
});

// After hours: Alpaca's last trade is the close, and the stock moved since.
test("after hours the token is still the price; no premium is measured against a stale close", async () => {
  const src: Sources = {
    stocks: {
      async firstTradeAtOrAfter() {
        return null;
      },
      async latestTrade() {
        return { price: 100, at: T - 6 * 3_600, raw: { close: true } };
      },
    },
    tokens: {
      async price(mint) {
        return { mint, usdPrice: 103, liquidityUsd: 2_000_000, at: T + 10, raw: { mint } };
      },
    },
  };
  const r = await priceLeg(spot(), T, T + 10, rules, src);
  assert.ok(r.ok);
  assert.equal(r.quote.price, 103);
  assert.deepEqual(r.quote.basis, { source: "token", mint: "NVDAx", underlyingPerUiToken: 1, premium: null, at: T });
});

test("a yield leg is priced on one vault share's value, now, and its exit on the same vault", async () => {
  const JL = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";
  const asked: string[] = [];
  const { src } = sources({});
  src.lend = { shareValue: async (m) => (asked.push(m), { usdcPerShare: 1.06958, at: T + 30, raw: { m } }) };
  const leg: LegToPrice = { index: 1, kind: "yield", underlying: null, token: { mint: JL, underlyingPerUiToken: 1 } };
  const entry = await priceLeg(leg, T, T + 40, rules, src);
  assert.ok(entry.ok);
  assert.deepEqual([entry.quote.price, entry.quote.publishedAt, entry.quote.rule], [1.06958, T + 30, "lend-share-value"]);
  assert.deepEqual(entry.quote.basis, { source: "lend", shareMint: JL });
  // The exit uses the entry's vault even with no token passed in.
  const exit = await priceLeg({ ...leg, token: null }, T + 86_400, T + 86_500, rules, src, { source: "lend", shareMint: JL });
  assert.ok(exit.ok && exit.quote.publishedAt === T + 86_400);
  assert.deepEqual(asked, [JL, JL]);
  // Too late, or no source: no price.
  const late = await priceLeg(leg, T, T + 5 * 86_400, rules, src);
  assert.ok(!late.ok && !late.retry);
  const none = await priceLeg(leg, T, T + 10, rules, sources({}).src);
  assert.ok(!none.ok && none.retry);
});
