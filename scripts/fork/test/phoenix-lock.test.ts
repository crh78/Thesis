import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { withPhoenixLock } from "../api/phoenix-lock.ts";

// Phoenix sends run one after another (api/phoenix-lock.ts): the maker sync rewrites Phoenix's
// active trader buffer, so no other Phoenix transaction may land between its read and its write.

test("Phoenix sends run one at a time, in the order they asked, and a failed one doesn't hold up the next", async () => {
  const log: string[] = [];
  const job = (name: string, ms: number, fail = false) => withPhoenixLock(async () => {
    log.push(`${name} start`);
    await sleep(ms);
    log.push(`${name} end`);
    if (fail) throw new Error(name);
    return name;
  });
  const results = await Promise.allSettled([job("a", 30), job("b", 5, true), job("c", 1)]);
  assert.deepEqual(log, ["a start", "a end", "b start", "b end", "c start", "c end"]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
});
