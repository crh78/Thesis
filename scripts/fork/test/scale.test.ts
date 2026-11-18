// Fork API scale (review P1) and the publish author check (S2).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Keypair, type Connection } from "@solana/web3.js";
import { emptyState } from "../../../packages/venues/bank/src/state.ts";
import { ApiError, type AppTake, type Snapshot } from "../api/common.ts";
import { downsample } from "../api/history.ts";
import { ForkService, type ServiceOpts } from "../api/service.ts";
import { SAVE_DEBOUNCE_MS, SAVE_RETRY_MS, StateStore } from "../api/store.ts";
import { TAKE_LIFETIME_SECS } from "@thesis/chain";

const TAKE_ID = "00000000-0000-4000-8000-0000000000cc";

function fixture(t: TestContext, o: { take?: AppTake | null; stateTakes?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "thesis-scale-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "api-state.json");
  let takeReads = 0;
  const connection = {
    getTokenAccountBalance: async () => ({ value: { amount: "100000000" } }),
    getAccountInfo: async () => null,
    getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null),
    getProgramAccounts: async () => [],
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    getSignaturesForAddress: async () => [],
  } as unknown as Connection;
  const options: ServiceOpts = {
    connection,
    appPayer: Keypair.generate(),
    lookupTable: Keypair.generate().publicKey,
    bank: emptyState,
    takes: async (id) => {
      takeReads++;
      return o.take && id === o.take.id ? o.take : null;
    },
    stocks: null,
    pricesFile: null,
    bases: null,
    jupiterApiKey: null,
    statePath,
    fork: { addUsdc: async () => 0n, setUsdc: async () => {}, refreshMarkets: async () => {} },
  };
  return { options, statePath, takeReads: () => takeReads };
}

const appTake = (authorWallet: string | null): AppTake => ({
  id: TAKE_ID,
  claim: "Chips keep going up",
  risk: "medium",
  settles_at: new Date(Date.now() + TAKE_LIFETIME_SECS * 1000).toISOString(),
  status: "posting",
  author: { handle: "someone" },
  author_wallet: authorWallet,
  legs: [{ name: "NVIDIA", kind: "Stock", weight: 100, fade_how: null }],
});

test("reading a chart for a wallet with no deposit or position saves nothing", async (t) => {
  const { options, statePath } = fixture(t);
  const service = new ForkService(options);
  const addr = Keypair.generate().publicKey.toBase58();
  const chart = await service.history(addr, "1W");
  assert.equal(chart.value, 100);
  assert.equal(chart.points.length, 1);
  service.flush();
  assert.equal(existsSync(statePath), false, "no history entry, so no state write");
});

test("a deposit is saved at once; the chart snapshot after it is debounced; saves are compact", async (t) => {
  const { options, statePath } = fixture(t);
  const service = new ForkService(options);
  const addr = Keypair.generate().publicKey.toBase58();
  await service.deposit(addr, 10);
  await service.history(addr, "1D");
  // The deposit's record is on disk right away (its USDC is already minted)...
  const first = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(first.cash.length, 1);
  // ...the chart snapshot that followed waits for the debounce.
  assert.equal(first.history, undefined, "written a few seconds later, not on every change");
  service.flush();
  const text = readFileSync(statePath, "utf8");
  assert.ok(!text.includes("\n"), "compact JSON");
  assert.ok(JSON.parse(text).history[addr].length >= 1);
});

test("a failed write doesn't throw from the timer: it's logged, kept pending and retried", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "thesis-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, "not-yet");
  const path = join(missing, "api-state.json");
  const logs: string[] = [];
  const store = new StateStore(path, null, (m) => logs.push(m));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  store.state.cash.push({ wallet: "w", kind: "deposit", usd: 1, at: new Date().toISOString() });
  store.save();
  // The debounced write fails (its folder doesn't exist): no throw out of the timer.
  t.mock.timers.tick(SAVE_DEBOUNCE_MS);
  assert.equal(store.pending, true, "still pending after the failure");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /STATE NOT SAVED/);
  assert.throws(() => store.flush(), /ENOENT/);
  assert.equal(store.pending, true, "an explicit flush that fails keeps it pending too");
  // Once the folder is there, the scheduled retry writes it.
  mkdirSync(missing);
  t.mock.timers.tick(SAVE_RETRY_MS);
  assert.equal(store.pending, false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).cash.length, 1);
});

test("a debounced save writes the file atomically, once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "thesis-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "api-state.json");
  const store = new StateStore(path, null);
  store.state.cash.push({ wallet: "w", kind: "deposit", usd: 1, at: new Date().toISOString() });
  store.save();
  store.save();
  assert.equal(existsSync(path), false);
  store.flush();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).cash.length, 1);
  store.flush(); // nothing pending: no write
  assert.deepEqual(readFileSync(path, "utf8"), JSON.stringify(store.state));
});

test("old snapshots are thinned to one an hour; the last week keeps full resolution", () => {
  const now = 1_800_000_000;
  const every5min = (from: number, to: number): Snapshot[] => {
    const out: Snapshot[] = [];
    for (let at = from; at < to; at += 300) out.push({ at, value: 1, netIn: 0 });
    return out;
  };
  const old = every5min(now - 10 * 86_400, now - 7 * 86_400); // 3 days before the window
  const recent = every5min(now - 7 * 86_400, now);
  const thinned = downsample([...old, ...recent], now);
  assert.equal(thinned.length, 3 * 24 + recent.length);
  assert.deepEqual(thinned.slice(-recent.length), recent);
  assert.equal(new Set(thinned.slice(0, 72).map((s) => Math.floor(s.at / 3600))).size, 72);
});

test("the portfolio reads only takes the wallet holds", async (t) => {
  const take = { ...appTake(Keypair.generate().publicKey.toBase58()), status: "live" as const };
  const { options, takeReads } = fixture(t, { take });
  // The state file knows a take: once its positions are scanned (none), a wallet that holds
  // nothing on it doesn't make the portfolio build its receipt.
  writeFileSync(options.statePath, JSON.stringify({
    forkId: options.lookupTable!.toBase58(),
    takes: { [TAKE_ID]: { address: Keypair.generate().publicKey.toBase58(), author: take.author_wallet, mirroredAt: new Date().toISOString() } },
    cash: [],
  }));
  const service = new ForkService(options);
  await new Promise((r) => setTimeout(r, 20)); // the warm-up scan
  const before = takeReads();
  const p = await service.portfolio(Keypair.generate().publicKey.toBase58(), { strict: true });
  assert.deepEqual(p.positions, []);
  assert.equal(takeReads(), before, "no receipt built for a take the wallet doesn't hold");
});

test("only the take's author can publish it", async (t) => {
  const author = Keypair.generate().publicKey.toBase58();
  const someoneElse = Keypair.generate().publicKey.toBase58();
  const isNotAuthor = (e: unknown) => e instanceof ApiError && e.status === 403 && e.code === "not_author";

  const { options } = fixture(t, { take: appTake(author) });
  await assert.rejects(new ForkService(options).buildPublish(TAKE_ID, someoneElse, 10), isNotAuthor);

  // A take whose author has no wallet yet can't be published by anyone, and says why.
  const demo = fixture(t, { take: appTake(null) });
  await assert.rejects(
    new ForkService(demo.options).buildPublish(TAKE_ID, someoneElse, 10),
    (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === "no_author_wallet",
  );
});
