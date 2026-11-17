import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Keypair, type Connection } from "@solana/web3.js";
import { emptyState } from "../../../packages/venues/bank/src/state.ts";
import { ForkService, type ServiceOpts } from "../api/service.ts";

function walletFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "thesis-portfolio-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "api-state.json");
  let amount = 100_000_000n;
  let balanceError = false;
  const connection = {
    getTokenAccountBalance: async () => {
      if (balanceError) throw new Error("RPC balance unavailable");
      return { value: { amount: amount.toString() } };
    },
    getAccountInfo: async () => ({ data: Buffer.alloc(0) }),
    getMultipleAccountsInfo: async () => [],
    getBalance: async () => 0,
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    getSignaturesForAddress: async () => [],
  } as unknown as Connection;
  const options: ServiceOpts = {
    connection,
    appPayer: Keypair.generate(),
    lookupTable: Keypair.generate().publicKey,
    bank: emptyState,
    takes: async () => null,
    stocks: null,
    bases: null,
    jupiterApiKey: null,
    statePath,
    fork: {
      async addUsdc(_, usd) {
        const next = amount + BigInt(usd * 1e6);
        await new Promise<void>((resolve) => setImmediate(resolve));
        amount = next;
        return next;
      },
      async setUsdc(_, next) { amount = next; },
      async refreshMarkets() {},
    },
  };
  return {
    options,
    addr: Keypair.generate().publicKey.toBase58(),
    failBalanceRead: () => { balanceError = true; },
  };
}

test("concurrent deposits and withdrawals reconcile with every chart range", async (t) => {
  const { options, addr } = walletFixture(t);
  const service = new ForkService(options);
  await Promise.all([service.deposit(addr, 10), service.deposit(addr, 20)]);
  await Promise.all([service.withdraw(addr, 5), service.withdraw(addr, 7)]);
  const ranges = await Promise.all(["1D", "1W", "1M", "ALL"].map((range) => service.history(addr, range)));
  for (const chart of ranges) {
    assert.equal(chart.value, 118);
    assert.equal(chart.points.at(-1)?.value, 118);
  }
});

test("a balance read failure leaves the last snapshot intact", async (t) => {
  const { options, addr, failBalanceRead } = walletFixture(t);
  const first = new ForkService(options);
  await first.history(addr, "ALL");
  const saved = JSON.parse(readFileSync(options.statePath, "utf8"));
  saved.history[addr][0].at -= 120;
  const previous = JSON.stringify(saved);
  writeFileSync(options.statePath, previous);
  failBalanceRead();
  const restarted = new ForkService(options);
  await assert.rejects(restarted.history(addr, "1D"), /RPC balance unavailable/);
  assert.equal(readFileSync(options.statePath, "utf8"), previous);
});

test("a take deleted from Supabase doesn't break the chart", async (t) => {
  const { options, addr } = walletFixture(t);
  // The state file knows a take this wallet traded; Supabase no longer has it (takes() → null).
  writeFileSync(options.statePath, JSON.stringify({
    forkId: options.lookupTable!.toBase58(),
    takes: { "00000000-0000-4000-8000-0000000000aa": { address: Keypair.generate().publicKey.toBase58(), author: addr, mirroredAt: new Date().toISOString() } },
    cash: [],
  }));
  const service = new ForkService(options);
  const chart = await service.history(addr, "1W");
  assert.equal(chart.value, 100);
  assert.deepEqual((await service.portfolio(addr, { strict: true })).positions, []);
});
