import assert from "node:assert/strict";
import { test } from "node:test";
import { GRACE_WAITS, GeminiEvents, READ_TTL_MS } from "../src/settler/gemini-source.ts";

test("reads are reused for 15 s, and an event the settler waits on is read less and less often", async () => {
  let t = 0;
  const reads: string[] = [];
  const src = new GeminiEvents(async (ticker) => (reads.push(ticker), []), () => t);
  await src.event("FED");
  await src.event("FED");
  assert.equal(reads.length, 1);
  t += READ_TTL_MS;
  await src.event("FED");
  assert.equal(reads.length, 2);
  // Waiting, as the crank does it: every 20 s tick reads (maybe from the cache) and waits again,
  // two legs of the same event included. The normal pace for GRACE_WAITS fresh reads, then 1 min,
  // doubling to at most 5 min between reads.
  const gaps: number[] = [];
  let last = t;
  let count = reads.length;
  while (gaps.length < GRACE_WAITS + 7) {
    t += 20_000;
    await src.event("FED");
    src.waiting("FED");
    src.waiting("FED");
    if (reads.length > count) {
      gaps.push(t - last);
      last = t;
      count = reads.length;
    }
  }
  // The read that first finds it waiting, then GRACE_WAITS more at the normal pace.
  assert.deepEqual(gaps, [...Array(GRACE_WAITS + 1).fill(20_000), 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  // Priced: back to the normal pace. Other events were never slowed.
  src.priced("FED");
  t += READ_TTL_MS;
  await src.event("FED");
  await src.event("CPI");
  assert.deepEqual(reads.slice(-2), ["FED", "CPI"]);
});

test("a failed read isn't reused", async () => {
  let fail = true;
  let reads = 0;
  const src = new GeminiEvents(async () => {
    reads++;
    if (fail) throw new Error("HTTP 502");
    return [];
  });
  await assert.rejects(src.event("FED"));
  fail = false;
  await src.event("FED");
  assert.equal(reads, 2);
});
