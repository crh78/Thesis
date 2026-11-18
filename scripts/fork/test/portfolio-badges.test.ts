import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Keypair, type Connection } from "@solana/web3.js";
import { emptyState } from "../../../packages/venues/bank/src/state.ts";
import { ForkService } from "../api/service.ts";

// The RPC sometimes answers "Internal error" under load. The portfolio shows its positions without
// badges then, instead of a 500; the history chart (strict) still sees the error.
function service(t: TestContext, failures: number) {
  const dir = mkdtempSync(join(tmpdir(), "thesis-badges-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const connection = {
    getAccountInfo: async () => null,
    getMultipleAccountsInfo: async (keys: unknown[]) => {
      calls++;
      if (calls <= failures) throw new Error("failed to get multiple accounts: Internal error");
      return keys.map(() => null);
    },
  } as unknown as Connection;
  const s = new ForkService({
    connection,
    appPayer: Keypair.generate(),
    lookupTable: Keypair.generate().publicKey,
    bank: emptyState,
    takes: async () => null,
    stocks: null,
    pricesFile: null,
    bases: null,
    jupiterApiKey: null,
    statePath: join(dir, "api-state.json"),
    fork: { addUsdc: async () => 0n, setUsdc: async () => {}, refreshMarkets: async () => {} },
  });
  return { s, calls: () => calls };
}

const wallet = Keypair.generate().publicKey.toBase58();

test("one failed badge read is tried again", async (t) => {
  const { s, calls } = service(t, 1);
  const r = await s.portfolio(wallet);
  assert.deepEqual(r.badges, []);
  assert.equal(calls(), 2);
});

test("a badge read that keeps failing leaves the badges out, not the portfolio", async (t) => {
  const { s } = service(t, 99);
  const r = await s.portfolio(wallet);
  assert.equal(r.wallet, wallet);
  assert.deepEqual(r.positions, []);
  assert.deepEqual(r.badges, []);
});

test("strict callers still get the error", async (t) => {
  const { s } = service(t, 99);
  await assert.rejects(s.portfolio(wallet, { strict: true }), /Internal error/);
});
