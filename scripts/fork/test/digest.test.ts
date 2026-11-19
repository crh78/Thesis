import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyDigests } from "../api/digests.ts";
import { digestFor } from "../api/service.ts";
import type { StateStore } from "../api/store.ts";

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

test("after a partial sale, what's left is compared with what that part cost", () => {
  // Half of a $20 back sold at flat prices: $10 left, worth $10. Not "down 50%".
  const half = { claim: "AI power demand is underrated.", valueUsd: 10, costUsd: 20.02, stakeUsd: 20, remainingStakeUsd: 10 };
  const d = digestFor([half], null, "W");
  assert.equal(d.title, "Your positions are down 0.1% since you got in");
  assert.match(d.body, /best: AI power demand is underrated\. -0\.1%$/);
  assert.equal(d.data.cost_usd, 10.01);
  // Since yesterday ($20 held, worth $20): today's $10 is half the stake, so flat.
  const today = digestFor([half], { day: "2026-12-04", valueUsd: 20, stakeUsd: 20 }, "W");
  assert.equal(today.title, "Your positions are up 0.0% today");
  // A mark from before marks kept the stake: compared as it was.
  assert.equal(digestFor([half], { day: "2026-12-04", valueUsd: 20 }, "W").title, "Your positions are down 50.0% today");
});

test("the daily run marks the stake still held, for the next day's change", async () => {
  const state: { digests?: Record<string, { day: string; valueUsd: number; stakeUsd?: number }> } = {};
  const store = { state, save: () => {} } as unknown as StateStore;
  const positions = [{ claim: "A", valueUsd: 15, costUsd: 30.03, stakeUsd: 30, remainingStakeUsd: 15 }];
  const { digests, markSent } = await dailyDigests("2026-12-05", ["W"], async () => ({ positions }), store);
  assert.equal(digests[0].title, "Your positions are down 0.1% since you got in");
  markSent();
  assert.deepEqual(state.digests, { W: { day: "2026-12-05", valueUsd: 15, stakeUsd: 15 } });
});
