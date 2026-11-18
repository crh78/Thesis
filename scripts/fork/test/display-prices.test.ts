// Display prices (Jupiter usage): the asset bank's batched prices first while fresh, one shared
// Jupiter read for concurrent views, and a stand-in no older than five minutes when Jupiter is down.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Keypair, type Connection } from "@solana/web3.js";
import type { BankState } from "@thesis/venues/bank";
import { emptyState } from "../../../packages/venues/bank/src/state.ts";
import type { ServiceOpts } from "../api/common.ts";
import { StateStore } from "../api/store.ts";
import { Valuation } from "../api/valuation.ts";

const A = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const B = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function bankWith(prices: Record<string, { usd: number; at: string; pooled?: number }>): BankState {
  const tokens = Object.fromEntries(Object.entries(prices).map(([m, p]) => [m, { decimals: 8, jupiterPooledUsd: p.pooled ?? 1e6, price: { usd: p.usd, underlyingUsd: null, at: p.at } }]));
  return { ...emptyState(), tokens } as unknown as BankState;
}

function valuation(t: TestContext, bank: BankState, pricesFile: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "thesis-prices-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const o = {
    connection: {} as Connection,
    appPayer: Keypair.generate(),
    lookupTable: null,
    bank: () => bank,
    takes: async () => null,
    stocks: null,
    bases: null,
    jupiterApiKey: "test-key",
    statePath: join(dir, "api-state.json"),
    fork: { addUsdc: async () => 0n, setUsdc: async () => {}, refreshMarkets: async () => {} },
  } satisfies ServiceOpts;
  return new Valuation(o, new StateStore(o.statePath, null), { pricesFile });
}

/** Stubs fetch; `answer` gets the ids asked for. Returns the ids of every call. */
function stubJupiter(t: TestContext, answer: (ids: string[]) => Response | Error, delayMs = 0) {
  const real = globalThis.fetch;
  const calls: string[][] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const ids = (new URL(String(url)).searchParams.get("ids") ?? "").split(",");
    calls.push(ids);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const a = answer(ids);
    if (a instanceof Error) throw a;
    return a;
  }) as typeof fetch;
  t.after(() => (globalThis.fetch = real));
  return calls;
}

const priced = (ids: string[], usd = 7) => Response.json(Object.fromEntries(ids.map((m) => [m, { usdPrice: usd, liquidity: 60_000 }])));

test("a bank price under two minutes old is used without calling Jupiter", async (t) => {
  const calls = stubJupiter(t, (ids) => priced(ids));
  const v = valuation(t, bankWith({ [A]: { usd: 101, at: ago(90_000), pooled: 70_000 } }));
  const q = await v.tokenQuotes([A]);
  assert.equal(q.get(A)?.usd, 101);
  assert.equal(q.get(A)?.liquidityUsd, 70_000, "the bank's pooled liquidity, for the floor");
  assert.equal(calls.length, 0);
});

test("an older bank price: Jupiter is asked, with its liquidity", async (t) => {
  const calls = stubJupiter(t, (ids) => priced(ids, 102));
  const v = valuation(t, bankWith({ [A]: { usd: 101, at: ago(3 * 60_000) } }));
  const q = await v.tokenQuotes([A]);
  assert.deepEqual(calls, [[A]]);
  assert.equal(q.get(A)?.usd, 102);
  assert.equal(q.get(A)?.liquidityUsd, 60_000);
  // Cached for 10 s: asked again at once, no new call.
  await v.tokenQuotes([A]);
  assert.equal(calls.length, 1);
});

test("concurrent views share one Jupiter read", async (t) => {
  const calls = stubJupiter(t, (ids) => priced(ids), 20);
  const v = valuation(t, bankWith({}));
  const [x, y, z] = await Promise.all([v.tokenQuotes([A]), v.tokenQuotes([A, B]), v.tokenPrices([B])]);
  assert.equal(x.get(A)?.usd, 7);
  assert.equal(y.get(B)?.usd, 7);
  assert.equal(z.get(B), 7);
  assert.deepEqual(calls, [[A], [B]], "A read once, B read once");
});

test("Jupiter down: a bank price up to five minutes old stands in, an older one doesn't", async (t) => {
  stubJupiter(t, () => new Error("429"));
  const v = valuation(t, bankWith({ [A]: { usd: 101, at: ago(4 * 60_000) }, [B]: { usd: 50, at: ago(6 * 60_000) } }));
  const q = await v.tokenQuotes([A, B]);
  assert.equal(q.get(A)?.usd, 101);
  assert.equal(q.has(B), false, "six minutes old: no price rather than a stale one");
});

test("the bank's prices file is used when it's newer than the bank copy in memory", async (t) => {
  const calls = stubJupiter(t, (ids) => priced(ids));
  const dir = mkdtempSync(join(tmpdir(), "thesis-bankfile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "asset-bank.prices.json");
  writeFileSync(file, JSON.stringify({ at: ago(0), tokens: { [A]: { usd: 103, at: ago(30_000), pooledUsd: 80_000 } } }));
  const v = valuation(t, bankWith({ [A]: { usd: 101, at: ago(9 * 60_000) } }), file);
  const q = await v.tokenQuotes([A]);
  assert.equal(q.get(A)?.usd, 103);
  assert.equal(q.get(A)?.liquidityUsd, 80_000);
  assert.equal(calls.length, 0);
});
