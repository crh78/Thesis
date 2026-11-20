import assert from "node:assert/strict";
import { test } from "node:test";
import { BelowOneLot } from "@thesis/venues/phoenix";
import { stakeBelowLot } from "../api/routing.ts";

test("a Phoenix leg under one lot is a 422 naming the stake the take needs", () => {
  // A $20 back of "crypto sucks": Bitcoin is 25%, $5, and one lot is $6.19.
  const below = new BelowOneLot(5, 6.19, 61_900);
  below.leg = "Bitcoin perp";
  const e = stakeBelowLot(below, 20);
  assert.equal(e.status, 422);
  assert.equal(e.code, "stake_too_small");
  assert.deepEqual(e.body, { minUsd: 26, leg: "Bitcoin perp", lotUsd: 6.19 });
  assert.match(e.message, /at least \$26: Bitcoin perp's share/);
});

test("the stake it names is never under the $10 minimum", () => {
  assert.equal(stakeBelowLot(new BelowOneLot(1, 1.5, 150), 4).body?.minUsd, 10);
});
