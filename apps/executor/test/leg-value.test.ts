// The shared leg rules (settler/leg-value.ts) the settler, the marker and the fork API all value
// legs with: one table per kind, plus the spot source rule and the return formula.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GeminiContract } from "@thesis/venues/gemini";
import { legReturnBps, liquidTokenPrice, spotPrice, tokenPremium, valueLeg, type LegMarket, type LegToValue } from "../src/settler/leg-value.ts";

const contract = (o: Partial<GeminiContract> = {}): GeminiContract =>
  ({
    instrumentSymbol: "FED-CUT-DEC",
    eventTicker: "FED",
    status: "active",
    resolutionSide: null,
    ask: { yes: 0.42, no: 0.6 },
    bid: { yes: 0.4, no: 0.57 },
    ...o,
  }) as GeminiContract;

const LIQUID = { usdPrice: 101, liquidityUsd: 80_000 };
const THIN = { usdPrice: 101, liquidityUsd: 24_999 };
const spot = (basis: NonNullable<LegToValue["spot"]>["basis"], o: Partial<NonNullable<LegToValue["spot"]>> = {}): LegToValue => ({
  kind: "spot",
  held: "back",
  entry: 100,
  spot: { perUi: 1, basis, ...o },
});

type Row = [name: string, leg: LegToValue, market: LegMarket, want: { price: number; rule: string; returnBps: number | null } | { reason: RegExp }];

const rows: Row[] = [
  // Spot: token first with the $25k floor, the stock as the fallback, the entry's source kept.
  ["spot, no entry yet: a liquid token prices it", spot(null), { token: LIQUID, stock: 99 }, { price: 101, rule: "issuer-token", returnBps: 100 }],
  ["spot, no entry yet: a thin token falls back to the stock", spot(null), { token: THIN, stock: 99 }, { price: 99, rule: "stock", returnBps: -100 }],
  ["spot: exactly $25k pooled is tradeable", spot(null), { token: { usdPrice: 101, liquidityUsd: 25_000 }, stock: 99 }, { price: 101, rule: "issuer-token", returnBps: 100 }],
  ["spot: a token with 2 underlying units per UI token", spot(null, { perUi: 2 }), { token: { usdPrice: 202, liquidityUsd: 80_000 } }, { price: 101, rule: "issuer-token", returnBps: 100 }],
  ["spot, token entry: the token while it's liquid", spot({ source: "token", premium: 1.01 }), { token: LIQUID, stock: 90 }, { price: 101, rule: "issuer-token", returnBps: 100 }],
  ["spot, token entry, thin now: the stock times the entry's premium", spot({ source: "token", premium: 1.01 }), { token: THIN, stock: 100 }, { price: 101, rule: "stock-adjusted", returnBps: 100 }],
  ["spot, token entry with no premium, thin now: no price", spot({ source: "token", premium: null }), { token: THIN, stock: 100 }, { reason: /no premium/ }],
  ["spot, stock entry: stays on the stock even with a liquid token", spot({ source: "stock" }), { token: LIQUID, stock: 98 }, { price: 98, rule: "stock", returnBps: -200 }],
  ["spot, stock entry, no stock price: none", spot({ source: "stock" }), { token: LIQUID, stock: null }, { reason: /no liquid token price and no stock price/ }],
  ["spot: neither source", spot(null), { token: THIN }, { reason: /no liquid token price/ }],
  ["spot: a 10-for-1 split since the entry (multiplier 1 → 10) reads as 0%", spot({ source: "token", premium: null }, { scale: 10 }), { token: { usdPrice: 10, liquidityUsd: 80_000 } }, { price: 100, rule: "issuer-token", returnBps: 0 }],
  ["spot: a stock split factor applies after the multiplier", spot({ source: "stock" }, { factor: 2 }), { stock: 50 }, { price: 100, rule: "stock", returnBps: 0 }],
  ["spot: a zero stock price isn't a price", spot(null), { stock: 0 }, { reason: /no liquid token price/ }],
  // A fade's spot leg is a Phoenix short.
  ["spot, fade: the Phoenix short's price, inverted", { kind: "spot", held: "fade", entry: 100, perp: { unitsPerContract: 1 } }, { perp: 90, token: LIQUID }, { price: 90, rule: "phoenix-mark", returnBps: 1_000 }],
  // Perp: price per contract over units, return × leverage, loss capped at −100%.
  ["perp: kPEPE is 1,000 PEPE per contract", { kind: "perp", held: "back", leverage: 1, entry: 0.00001, perp: { unitsPerContract: 1_000 } }, { perp: 0.011 }, { price: 0.000011, rule: "phoenix-mark", returnBps: 1_000 }],
  ["perp: 3x, up 10%", { kind: "perp", held: "back", leverage: 3, entry: 100, perp: { unitsPerContract: 1 } }, { perp: 110 }, { price: 110, rule: "phoenix-mark", returnBps: 3_000 }],
  ["perp: 3x, down 50% floors at −100%", { kind: "perp", held: "back", leverage: 3, entry: 100, perp: { unitsPerContract: 1 } }, { perp: 50 }, { price: 50, rule: "phoenix-mark", returnBps: -10_000 }],
  ["perp: no Phoenix price", { kind: "perp", held: "back", leverage: 2, entry: 100 }, { perp: null }, { reason: /no Phoenix price/ }],
  // Prediction: ask at entry, bid later, 1/0 once resolved, never from an incoherent book.
  ["prediction, entry: the held side's ask", { kind: "prediction", held: "back", moment: "entry", prediction: { side: "yes" } }, { contract: contract() }, { price: 0.42, rule: "gemini-ask", returnBps: null }],
  ["prediction, back: the bid now", { kind: "prediction", held: "back", entry: 0.4, prediction: { side: "yes" } }, { contract: contract({ bid: { yes: 0.5, no: 0.48 }, ask: { yes: 0.52, no: 0.5 } }) }, { price: 0.5, rule: "gemini-bid", returnBps: 2_500 }],
  ["prediction, fade: the No side's bid, in the leg's terms", { kind: "prediction", held: "fade", entry: 0.4, prediction: { side: "yes" } }, { contract: contract({ bid: { yes: 0.28, no: 0.7 }, ask: { yes: 0.3, no: 0.72 } }) }, { price: 0.30000000000000004, rule: "gemini-bid", returnBps: 1_666 }],
  ["prediction: resolved yes pays 1", { kind: "prediction", held: "back", entry: 0.4, prediction: { side: "yes" } }, { contract: contract({ resolutionSide: "yes", status: "settled" as never }) }, { price: 1, rule: "gemini-resolution", returnBps: 15_000 }],
  ["prediction: resolved no pays 0 (−100%)", { kind: "prediction", held: "back", entry: 0.4, prediction: { side: "yes" } }, { contract: contract({ resolutionSide: "no", status: "settled" as never }) }, { price: 0, rule: "gemini-resolution", returnBps: -10_000 }],
  ["prediction: a crossed book", { kind: "prediction", held: "back", entry: 0.4, prediction: { side: "yes" } }, { contract: contract({ bid: { yes: 0.5, no: 0.4 }, ask: { yes: 0.45, no: 0.6 } }) }, { reason: /don't add up/ }],
  ["prediction, entry: an ask of 1 isn't a fill", { kind: "prediction", held: "back", moment: "entry", prediction: { side: "yes" } }, { contract: contract({ ask: { yes: 1, no: 0.01 }, bid: { yes: 0.97, no: null } }) }, { reason: /no quote/ }],
  ["prediction: unlisted", { kind: "prediction", held: "back", prediction: { side: "yes" } }, { contract: null }, { reason: /doesn't list/ }],
  // Yield: the vault share's value; card: the insured value.
  ["yield: jlUSDC's share value", { kind: "yield", held: "back", entry: 1.02 }, { lendShareValue: 1.0302 }, { price: 1.0302, rule: "lend-share-value", returnBps: 100 }],
  ["yield: no share value", { kind: "yield", held: "back", entry: 1.02 }, { lendShareValue: null }, { reason: /vault share/ }],
  ["card: the insured value", { kind: "card", held: "back", entry: 200 }, { cardInsuredUsd: 250 }, { price: 250, rule: "card-insured-value", returnBps: 2_500 }],
  ["card: an insured value of 0 isn't a price", { kind: "card", held: "back", entry: 200 }, { cardInsuredUsd: 0 }, { reason: /insured value/ }],
];

for (const [name, leg, market, want] of rows) {
  test(`valueLeg: ${name}`, () => {
    const got = valueLeg(leg, market);
    if ("reason" in want) {
      assert.ok(!got.ok, got.ok ? `priced at ${got.price}` : "");
      assert.match(got.reason, want.reason);
    } else {
      assert.ok(got.ok, !got.ok ? got.reason : "");
      assert.ok(Math.abs(got.price - want.price) < 1e-12, `price ${got.price}, want ${want.price}`);
      assert.equal(got.rule, want.rule);
      assert.equal(got.returnBps, want.returnBps);
    }
  });
}

test("the floor and the premium, alone", () => {
  assert.equal(liquidTokenPrice(THIN, 1), null);
  assert.equal(liquidTokenPrice({ usdPrice: 0, liquidityUsd: 1e9 }, 1), null);
  assert.equal(liquidTokenPrice(THIN, 1, 10_000), 101, "a caller can pass its own floor (SETTLER_MIN_LIQUIDITY_USD)");
  assert.equal(tokenPremium(101, { price: 100, at: 1_000 }, 1_900, 900), 1.01);
  assert.equal(tokenPremium(101, { price: 100, at: 1_000 }, 1_901, 900), null, "a stale close isn't a reference");
  assert.equal(tokenPremium(101, null, 1_000, 900), null);
});

test("spotPrice keeps the multiplication order the settler signs with", () => {
  const r = spotPrice({ source: "token", premium: 1.0123 }, null, 187.31, 1.0007, 2);
  assert.ok(r.ok);
  assert.equal(r.price, 187.31 * 1.0123 * 1.0007 * 2);
});

test("legReturnBps: a back and a fade of the same move", () => {
  assert.equal(legReturnBps("spot", "back", 1, 100, 110), 1_000);
  assert.equal(legReturnBps("spot", "fade", 1, 100, 110), -1_000);
  assert.equal(legReturnBps("perp", "fade", 2, 100, 160), -10_000, "a 2x short up 60% floors at −100%");
  assert.equal(legReturnBps("spot", "back", 1, 0, 1), null);
});
