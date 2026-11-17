import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/scheduler.ts";
import { selectStale } from "../src/state.ts";
import { AssetBankPoller } from "../src/poller.ts";
import { loadBankConfig } from "../src/config.ts";
import { FileSink } from "../src/sinks.ts";
import type { JupiterClient } from "../src/jupiter.ts";
import { NOW, bySymbol, fixture, fixtureQuote, fixtureState, manualClock } from "./helpers.ts";

const SEC = 1000;
const MIN = 60 * SEC;

test("scheduler: each tier on its own cadence, no overlap, backoff after failure", async () => {
  const clock = manualClock(0);
  const runs: string[] = [];
  let release: () => void = () => {};
  let fail = true;
  const sched = new Scheduler(
    [
      { name: "prices", intervalMs: 90 * SEC, run: async () => void runs.push("prices") },
      { name: "probes", intervalMs: 60 * SEC, run: () => (runs.push("probes"), new Promise<void>((r) => (release = r))) },
      { name: "discovery", intervalMs: 60 * MIN, run: async () => (runs.push("discovery"), fail ? Promise.reject(new Error("boom")) : undefined) },
      { name: "flush", intervalMs: 15 * SEC, initialDelayMs: 15 * SEC, run: async () => void runs.push("flush") },
    ],
    { clock },
  );
  assert.deepEqual(sched.tick().sort(), ["discovery", "prices", "probes"]);
  await new Promise((r) => setImmediate(r));
  clock.set(15 * SEC);
  assert.deepEqual(sched.tick(), ["flush"]);
  fail = false;
  clock.set(30 * SEC);
  // discovery failed at t=0: it retries after 30 s instead of an hour (and succeeds this time).
  assert.ok(sched.tick().includes("discovery"));
  await new Promise((r) => setImmediate(r));
  clock.set(61 * SEC);
  // probes is still running from t=0: it must not start again.
  assert.ok(!sched.tick().includes("probes"));
  release();
  await new Promise((r) => setImmediate(r));
  assert.ok(sched.tick().includes("probes"), "starts as soon as the overrunning run finishes");
  clock.set(91 * SEC);
  assert.ok(sched.tick().includes("prices"));
  clock.set(10 * MIN);
  release(); // the second probes run
  await sched.idle();
  const t = sched.tick();
  assert.ok(!t.includes("discovery"), "discovery succeeded at 30 s, so the next run is an hour later");
  assert.equal(runs.filter((r) => r === "discovery").length, 2);
});

test("selectStale: never-probed first, then oldest; routed tokens every ttl, unrouted hourly", () => {
  const s = fixtureState();
  const at = (minAgo: number) => new Date(NOW - minAgo * MIN).toISOString();
  const routed = (minAgo: number) => ({ at: at(minAgo), maxAccounts: 30, quotes: [{ usd: 100, routed: true, outAmountRaw: "1", priceImpactPct: 0, hops: 1, venues: [], error: null }] });
  const dead = (minAgo: number) => ({ at: at(minAgo), maxAccounts: 30, quotes: [{ usd: 100, routed: false, outAmountRaw: null, priceImpactPct: null, hops: null, venues: [], error: "NO_ROUTES_FOUND" }] });
  const [a, b, c, d, e] = ["NVDAx", "NVDA", "NVDAon", "SPYx", "SPY"].map((x) => bySymbol(s, x));
  a.probe = routed(8);
  b.probe = routed(20);
  c.probe = null;
  d.probe = dead(30); // unrouted, only 30 min old: not due
  e.probe = routed(2); // fresh
  const picked = selectStale([a, b, c, d, e], NOW, { ttlMs: 7.5 * MIN, unroutedTtlMs: 60 * MIN, limit: 10 }).map((t) => t.symbol);
  assert.deepEqual(picked, ["NVDAon", "NVDA", "NVDAx"]);
  assert.deepEqual(selectStale([a, b, c, d, e], NOW, { ttlMs: 7.5 * MIN, unroutedTtlMs: 60 * MIN, limit: 2 }).map((t) => t.symbol), ["NVDAon", "NVDA"]);
  d.probe = dead(61);
  assert.ok(selectStale([d], NOW, { ttlMs: 7.5 * MIN, unroutedTtlMs: 60 * MIN, limit: 10 }).length === 1);
});

function fakeJupiter(calls: { quotes: string[]; prices: number }) {
  return {
    label: "fake",
    pacer: { count: 0 },
    quote: async (mint: string, usd: number, o: any) => (calls.quotes.push(`${mint}:${usd}`), fixtureQuote(mint, usd, o)),
    prices: async (mints: string[]) => {
      calls.prices += Math.ceil(mints.length / 50);
      return new Map(mints.map((m) => [m, { usdPrice: fixture.tokens[m].price?.usd ?? 1, underlyingUsd: fixture.tokens[m].price?.underlyingUsd ?? null, decimals: null, liquidity: null }]));
    },
  } as unknown as JupiterClient;
}

test("poller: probe budget fits the Jupiter rate limit; probes only stale tokens; skips $1,000 when $100 fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bank-"));
  const config = loadBankConfig(() => null);
  const calls = { quotes: [] as string[], prices: 0 };
  const clock = manualClock(NOW);
  const state = fixtureState();
  for (const t of Object.values(state.tokens)) t.jupiterPooledUsd = 1e6; // all candidates
  const poller = new AssetBankPoller(state, { sink: new FileSink(join(dir, "bank.json")), config, jupiter: fakeJupiter(calls), rpc: {} as any, clock, log: () => {} });
  // 16 candidates -> 1 price call per 90 s; 45 req/min leaves ~44 quotes/min -> 22 tokens per 60 s tick.
  assert.equal(poller.probeBudget(), 22);
  // Count what's fresh before probing: the poller updates the same state in place.
  const freshBefore = Object.values(state.tokens).filter((t) => t.probe && Date.parse(t.probe.at) > NOW - config.probeTtlMs).length;
  await poller.probes();
  const probed = Object.values(poller.state.tokens).filter((t) => t.probe?.at === new Date(NOW).toISOString());
  assert.equal(probed.length, 16 - freshBefore);
  const nvdar = bySymbol(poller.state, "NVDAr");
  assert.ok(calls.quotes.includes(`${nvdar.mint}:100`));
  assert.ok(!calls.quotes.includes(`${nvdar.mint}:1000`), "no $1,000 quote after a failed $100");
  // Immediately again: nothing is stale.
  calls.quotes.length = 0;
  await poller.probes();
  assert.equal(calls.quotes.length, 0);
  // 8 minutes later the routed ones are due again, the dead ones are not.
  clock.advance(8 * MIN);
  await poller.probes();
  assert.ok(calls.quotes.length > 0);
  assert.ok(!calls.quotes.some((q) => q.startsWith(nvdar.mint)));
  // Prices: one batched call, then nothing until the cadence passes.
  await poller.prices();
  assert.equal(calls.prices, 1);
  await poller.prices();
  assert.equal(calls.prices, 1);
  // Flush writes the file; a new poller resumes from it.
  await poller.flush();
  const again = await AssetBankPoller.open({ sink: new FileSink(join(dir, "bank.json")), config, jupiter: fakeJupiter(calls), rpc: {} as any, clock, log: () => {} });
  assert.equal(Object.keys(again.state.tokens).length, 16);
  assert.equal(again.state.tokens[nvdar.mint].probe?.quotes[0].routed, false);
});

test("config: cadences come from env vars with sane defaults", () => {
  const d = loadBankConfig(() => null);
  assert.equal(d.discoveryMs, 60 * MIN);
  assert.equal(d.pricesMs, 90 * SEC);
  assert.equal(d.probeTtlMs, 7.5 * MIN);
  assert.equal(d.phoenixMs, 10 * MIN);
  assert.equal(d.phoenixGapMs, 4_000);
  assert.equal(d.maxAccounts, 30);
  const env: Record<string, string> = { ASSET_BANK_PRICES_SEC: "120", ASSET_BANK_JUPITER_RPM: "500" };
  const c = loadBankConfig((k) => env[k] ?? null);
  assert.equal(c.pricesMs, 120 * SEC);
  assert.equal(c.jupiterRpm, 500);
  assert.throws(() => loadBankConfig((k) => (k === "ASSET_BANK_PRICES_SEC" ? "fast" : null)));
});

test("poller: a restart doesn't sweep Gemini again while the last sweep is recent", () => {
  const dir = mkdtempSync(join(tmpdir(), "bank-"));
  const config = loadBankConfig(() => null);
  assert.equal(config.geminiMs, 360 * MIN, "a full sweep every 6 hours");
  const clock = manualClock(NOW);
  const at = (msAgo: number | null) => {
    const state = fixtureState();
    state.venues.gemini = msAgo === null ? undefined as any : { at: new Date(NOW - msAgo).toISOString(), summary: {} as any, contracts: {} };
    const poller = new AssetBankPoller(state, { sink: new FileSink(join(dir, "bank.json")), config, jupiter: fakeJupiter({ quotes: [], prices: 0 }), rpc: {} as any, clock, log: () => {} });
    return poller.jobs(["gemini"])[0].initialDelayMs;
  };
  assert.equal(at(null), 0, "never swept: now");
  assert.equal(at(60 * MIN), 300 * MIN, "swept an hour ago: in 5 hours");
  assert.equal(at(7 * 60 * MIN), 0, "overdue: now");
});
