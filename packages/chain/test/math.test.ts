import assert from "node:assert/strict";
import { test } from "node:test";
import { LEG_KIND, SIDE } from "../src/types.ts";
import { positionReturnBps } from "../src/math.ts";

const usd = (n: number) => BigInt(Math.round(n * 1e8));
const leg = (kind: keyof typeof LEG_KIND, weightBps: number, leverage = 1) => ({ kind: LEG_KIND[kind], weightBps, leverage });

// The same cases as anchor/programs/thesis/tests/test_settlement.rs.
test("weighted spot and yield: the vault share's interest counts", () => {
  const legs = [leg("spot", 6_000), leg("yield", 4_000)];
  // Spot +50%; one vault share went from $1.00 to $1.025 (+2.5%).
  const prices = [{ entry: usd(100), exit: usd(150) }, { entry: usd(1), exit: usd(1.025) }];
  assert.equal(positionReturnBps(legs, { side: SIDE.back, legsMask: 0b11, prices }), 3_100);
  assert.equal(positionReturnBps(legs, { side: SIDE.back, legsMask: 0b01, prices }), 5_000);
  assert.equal(positionReturnBps(legs, { side: SIDE.back, legsMask: 0b10, prices }), 250);
  // A yield leg with no price yet leaves the return unknown, like any leg.
  assert.equal(positionReturnBps(legs, { side: SIDE.back, legsMask: 0b11, prices: [prices[0], { entry: 0n, exit: 0n }] }), null);
});

test("leverage multiplies, losses stop at 100%", () => {
  const legs = [leg("perp", 10_000, 3)];
  assert.equal(positionReturnBps(legs, { side: SIDE.back, legsMask: 1, prices: [{ entry: usd(100), exit: usd(110) }] }), 3_000);
  assert.equal(positionReturnBps(legs, { side: SIDE.back, legsMask: 1, prices: [{ entry: usd(100), exit: usd(50) }] }), -10_000);
  assert.equal(positionReturnBps(legs, { side: SIDE.fade, legsMask: 1, prices: [{ entry: usd(100), exit: usd(90) }] }), 3_000);
});

test("predictions both ways", () => {
  const legs = [leg("prediction", 10_000)];
  const prices = [{ entry: usd(0.4), exit: usd(1) }];
  assert.equal(positionReturnBps(legs, { side: SIDE.back, legsMask: 1, prices }), 15_000);
  assert.equal(positionReturnBps(legs, { side: SIDE.fade, legsMask: 1, prices }), -10_000);
});

test("missing entry is null", () => {
  assert.equal(positionReturnBps([leg("spot", 10_000)], { side: SIDE.back, legsMask: 1, prices: [{ entry: 0n, exit: usd(1) }] }), null);
});
