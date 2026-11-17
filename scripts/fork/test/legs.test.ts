import assert from "node:assert/strict";
import { test } from "node:test";
import { underlyingId } from "@thesis/venues/bank";
import { mapLegs, weightsToBps } from "../api/legs.ts";

test("weights become bps that add up to 10,000", () => {
  assert.deepEqual(weightsToBps([30, 25, 25, 20]), [3_000, 2_500, 2_500, 2_000]);
  const odd = weightsToBps([33.33, 33.33, 33.34]);
  assert.equal(odd.reduce((a, b) => a + b, 0), 10_000);
  assert.deepEqual(weightsToBps([1, 1, 1]).reduce((a, b) => a + b, 0), 10_000);
  assert.throws(() => weightsToBps([0]));
});

test("app legs map to on-chain legs, with what can't be traded and why", () => {
  const legs = mapLegs([
    { name: "NVIDIA", kind: "Stock", weight: 30, fade_how: "Bets the stock falls" },
    { name: "Cash", kind: "Earns interest", weight: 20, fade_how: null },
    { name: "Rate cut: Yes", kind: "Prediction · Yes", weight: 20, fade_how: "Buys No" },
    { name: "NVIDIA 2x", kind: "Stock · 2x", weight: 20, fade_how: "Bets the stock falls" },
    { name: "Utilities", kind: "Stock basket", weight: 10, fade_how: null },
  ]);
  const [nvda, cash, rate, lev, utils] = legs;
  assert.deepEqual([nvda.key, nvda.how, nvda.blocked], ["equity:US:NVDA", "swap", null]);
  assert.ok(nvda.spec.asset.toBuffer().equals(Buffer.from(underlyingId("equity:US:NVDA"))));
  assert.deepEqual(Object.keys(nvda.spec.fadeVia), ["phoenixShort"]);
  assert.deepEqual([Object.keys(cash.spec.kind)[0], cash.how, cash.blocked], ["yield", "lend", null]);
  assert.deepEqual([Object.keys(rate.spec.kind)[0], Object.keys(rate.spec.fadeVia)[0]], ["prediction", "predictionNo"]);
  assert.match(rate.blocked!, /Gemini/);
  assert.deepEqual([Object.keys(lev.spec.kind)[0], lev.spec.leverage], ["perp", 2]);
  assert.match(lev.blocked!, /Phoenix/);
  assert.match(utils.blocked!, /no tokenized/);
  assert.deepEqual(legs.filter((l) => !l.blocked).map((l) => l.index), [0, 1]);
  // Two legs on the same underlying would be rejected on-chain: the second gets its own id.
  assert.equal(new Set(legs.map((l) => l.spec.asset.toBase58())).size, legs.length);
  assert.equal(legs.reduce((n, l) => n + l.spec.weightBps, 0), 10_000);
});

test("a card category pick (cards:<category>) isn't one card, so it isn't traded, even when its kind reads Stock", () => {
  const [card, byKind, nvda] = mapLegs([
    { name: "Pokemon", kind: "Stock", weight: 30, fade_how: null, asset_id: "cards:Pokemon" },
    { name: "One Piece", kind: "Card", weight: 20, fade_how: null },
    { name: "NVIDIA", kind: "Stock", weight: 50, fade_how: "Bets the stock falls" },
  ]);
  for (const c of [card, byKind]) {
    assert.equal(c.how, null);
    assert.match(c.blocked!, /card category/);
    assert.deepEqual(Object.keys(c.spec.kind), ["card"]);
  }
  assert.equal(nvda.blocked, null, "the rest of the basket still trades");
});
