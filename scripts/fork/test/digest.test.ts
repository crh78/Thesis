import assert from "node:assert/strict";
import { test } from "node:test";
import { digestFor } from "../api/service.ts";

const positions = [
  { claim: "AI power demand is underrated.", valueUsd: 21, costUsd: 20.02 },
  { claim: "The Fed cuts in December.", valueUsd: 19.5, costUsd: 20.02 },
];

test("the first digest compares with what the positions cost", () => {
  const d = digestFor(positions, null, "W");
  assert.equal(d.title, "Your positions are up 1.1% since you got in");
  assert.equal(d.body, "2 open positions worth $40.50 · best: AI power demand is underrated. +4.9%");
  assert.deepEqual(d.data, { value_usd: 40.5, cost_usd: 40.04, change_pct: 1.15, positions: 2 });
});

test("later digests compare with yesterday's value", () => {
  const d = digestFor(positions, { day: "2026-12-04", valueUsd: 41 }, "W");
  assert.equal(d.title, "Your positions are down 1.2% today");
});

test("one position reads in the singular", () => {
  const d = digestFor([positions[1]], null, "W");
  assert.match(d.body, /^1 open position worth \$19\.50 · best: The Fed cuts in December\. -2\.6%$/);
});
