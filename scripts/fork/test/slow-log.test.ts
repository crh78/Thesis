import assert from "node:assert/strict";
import { test } from "node:test";
import { logSlow } from "../api/common.ts";

test("a slow build or send logs where its time went; a fast one logs nothing", () => {
  const logs: string[] = [];
  logSlow((m) => logs.push(m), "back build 1a2b3c4d", 1_900, { compose: 1_900 });
  logSlow((m) => logs.push(m), "back build 1a2b3c4d", 6_300, { "put on-chain": 0, "legs and quotes": 3_100, compose: 3_200 });
  assert.deepEqual(logs, ["slow back build 1a2b3c4d 6.3 s: put on-chain 0.0 s, legs and quotes 3.1 s, compose 3.2 s"]);
});
