import assert from "node:assert/strict";
import { test } from "node:test";
import { depositCapFor, parseCapOverrides } from "../api/wallets.ts";

const W1 = "4Nd1mYw9Hn3sJkF5nX3z5Qk1yJ7mJ9dLqA3r7vN2hTxz";
const W2 = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

test("cap overrides: per wallet, others keep the base cap, junk ignored", () => {
  const o = parseCapOverrides(` ${W1}=10000 , ${W2}=0, not-a-wallet=5, ${W1.slice(0, 10)}=7,=3, ${W2}x=abc`);
  assert.deepEqual([...o.entries()], [[W1, 10000], [W2, 0]]);
  assert.equal(depositCapFor(W1, o, 1000), 10000);
  assert.equal(depositCapFor(W2, o, 1000), 0);
  assert.equal(depositCapFor("Other1111111111111111111111111111111111", o, 1000), 1000);
  assert.equal(parseCapOverrides(undefined).size, 0);
});
