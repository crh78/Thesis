// A sale's price reads (review M5): a failed read is tried again, then the last value known
// stands in, so one glitch doesn't fail the sale with no_exit_route.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Keypair, type Connection } from "@solana/web3.js";
import type { BankState } from "@thesis/venues/bank";
import { emptyState } from "../../../packages/venues/bank/src/state.ts";
import type { ServiceOpts } from "../api/common.ts";
import { StateStore } from "../api/store.ts";
import { Valuation } from "../api/valuation.ts";

const SHARE_MINT = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";
const TOKEN_MINT = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";

function valuation(t: TestContext, bank: () => BankState = emptyState) {
  const dir = mkdtempSync(join(tmpdir(), "thesis-sale-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const o = {
    connection: {} as Connection,
    appPayer: Keypair.generate(),
    lookupTable: null,
    bank,
    takes: async () => null,
    stocks: null,
    bases: null,
    jupiterApiKey: null,
    statePath: join(dir, "api-state.json"),
    fork: { addUsdc: async () => 0n, setUsdc: async () => {}, refreshMarkets: async () => {} },
  } satisfies ServiceOpts;
  return new Valuation(o, new StateStore(o.statePath, null), { pricesFile: null });
}

/** Stubs fetch with `answers` in order (an Error rejects); returns how many calls were made. */
function stubFetch(t: TestContext, answers: (Response | Error)[]) {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    const a = answers[Math.min(calls++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a.clone();
  }) as typeof fetch;
  t.after(() => (globalThis.fetch = real));
  return () => calls;
}

const vault = () => new Response(JSON.stringify([{ address: SHARE_MINT, totalAssets: "1050000", totalSupply: "1000000" }]));

test("a failed share-value read is tried once more on a sale", async (t) => {
  const calls = stubFetch(t, [new Error("socket hang up"), vault()]);
  assert.equal(await valuation(t).lendShareValue(SHARE_MINT, { retry: true }), 1.05);
  assert.equal(calls(), 2);
});

test("when both reads fail, the last share value read stands in", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const v = valuation(t);
  stubFetch(t, [vault()]);
  assert.equal(await v.lendShareValue(SHARE_MINT), 1.05);
  t.mock.timers.tick(5 * 60_000); // past the 60 s cache
  const calls = stubFetch(t, [new Error("timeout")]);
  assert.equal(await v.lendShareValue(SHARE_MINT, { retry: true }), 1.05);
  assert.equal(calls(), 2, "tried twice before using the cached value");
});

test("a token with no fresh price is valued at its last known price instead of failing", async (t) => {
  // The asset bank's price is two hours old: too old for display marks, fine to size a sale.
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const bank = { ...emptyState(), tokens: { [TOKEN_MINT]: { decimals: 8, price: { usd: 200, underlyingUsd: null, at } } } } as unknown as BankState;
  stubFetch(t, [new Error("Jupiter down")]);
  const v = valuation(t, () => bank);
  assert.equal((await v.tokenPrices([TOKEN_MINT])).size, 0, "no fresh price");
  assert.equal(await v.tokensUsd([[TOKEN_MINT, 150_000_000n]]), 300);
});
