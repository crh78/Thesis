import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, USDC_MINT, associatedTokenAddress, legDiff, type JupiterBuy } from "@thesis/venues/jupiter";
import { emptyState } from "../../../packages/venues/bank/src/state.ts";
import { ApiError } from "../api/common.ts";
import { Guard, JupiterBudget, newUse } from "../api/guard.ts";
import type { MappedLeg } from "../api/legs.ts";
import { Router, TEMPLATE_TTL_MS } from "../api/routing.ts";

// The fork API's Jupiter budget (api/guard.ts) and how routing uses its lanes (api/routing.ts):
// taps wait their turn, prebuilds and route checks fail fast and never wait out a 429, and a
// quote that failed is never remembered as "no route".

const isBusy = (e: unknown) => e instanceof ApiError && e.status === 503 && e.code === "busy" && Number(e.headers?.["retry-after"]) >= 1;
const ok = () => Promise.resolve("ok");

test("prebuilds and route checks leave the last 6 requests to taps; taps may use them all", async () => {
  const t = 1_000_000;
  const budget = new JupiterBudget({ prebuildWaitMs: 0 }, () => t);
  for (let i = 0; i < 4; i++) await budget.run(i % 2 ? 2 : 3, ok);
  await assert.rejects(budget.run(2, ok), isBusy);
  await assert.rejects(budget.run(3, ok), isBusy);
  for (let i = 0; i < 6; i++) await budget.run(1, ok);
  assert.equal(budget.tokens, 0);
  assert.deepEqual(budget.stats.calls, [0, 6, 2, 2]);
  assert.deepEqual(budget.stats.refused, [0, 0, 1, 1]);
});

test("a prebuild short only of spare requests waits for the bucket; a route check doesn't", async () => {
  // 10 a second: the 7th request back is 100 ms away.
  const budget = new JupiterBudget({ perMinute: 600, burst: 7, reserve: 6 });
  await budget.run(2, ok);
  await assert.rejects(budget.run(3, ok), isBusy, "a route check is still refused at once");
  const started = Date.now();
  assert.equal(await budget.run(2, ok), "ok", "the prebuild waited for the bucket instead");
  assert.ok(Date.now() - started >= 90, "it waited for the refill");
});

test("a prebuild doesn't wait longer than prebuildWaitMs, nor after a 429", async () => {
  const slow = new JupiterBudget({ perMinute: 6, burst: 7, reserve: 6, prebuildWaitMs: 1_000 });
  await slow.run(2, ok);
  await assert.rejects(slow.run(2, ok), isBusy, "10 s to the next request: refused at once");
  const paused = new JupiterBudget({ perMinute: 600, burst: 10, reserve: 6 });
  paused.rateLimited();
  await assert.rejects(paused.run(2, ok), isBusy, "after a 429: refused at once");
});

test("the bucket refills at 30 a minute, up to a burst of 10", async () => {
  let t = 1_000_000;
  const budget = new JupiterBudget({}, () => t);
  for (let i = 0; i < 10; i++) await budget.run(1, ok);
  t += 2_000;
  assert.equal(budget.tokens, 1);
  t += 10 * 60_000;
  assert.equal(budget.tokens, 10);
});

test("taps wait in line for a request, and are turned away when the wait would be too long", async () => {
  // One request every 100 ms.
  const budget = new JupiterBudget({ perMinute: 600, burst: 1, reserve: 0, maxWaitMs: 150 });
  const use = newUse(1);
  const order: number[] = [];
  const a = budget.run(1, async () => order.push(1), use);
  const b = budget.run(1, async () => order.push(2), use);
  await assert.rejects(budget.run(1, ok), isBusy, "a third would wait ~200 ms, over the 150 ms allowed");
  await assert.rejects(budget.run(2, ok), isBusy, "a prebuild never jumps a waiting tap");
  await Promise.all([a, b]);
  assert.deepEqual(order, [1, 2]);
  assert.equal(use.calls, 2);
  assert.ok(use.waitedMs >= 50, `the second waited for the refill (${use.waitedMs} ms)`);
});

test("a 429 stops every lane until Jupiter's window resets; counted per build", async () => {
  let t = 1_000_000;
  const budget = new JupiterBudget({}, () => t);
  const use = newUse(2);
  const reset = String(Math.ceil((t + 5_000) / 1000));
  const jupiter = (async () => new Response("{}", { status: 429, headers: { "x-ratelimit-reset": reset } })) as unknown as typeof fetch;
  const r = await budget.fetchFn(2, use, jupiter)("https://api.jup.ag/swap/v1/quote?inputMint=x");
  assert.equal(r.status, 429);
  assert.deepEqual([use.calls, use.quotes, use.instructions, use.rateLimited], [1, 1, 0, 1]);
  await assert.rejects(budget.run(3, ok), (e: unknown) => isBusy(e) && /429/.test((e as Error).message));
  assert.equal(budget.tokens, 0);
  t += 6_000;
  assert.ok(budget.tokens > 0, "refills once the window has reset");
  assert.equal(budget.snapshot().rateLimited, 1);
});

test("a window Jupiter says is used up stops the lanes too, without a 429", async () => {
  const t = 1_000_000;
  const budget = new JupiterBudget({}, () => t);
  const jupiter = (async () => new Response("{}", { status: 200, headers: { "x-ratelimit-remaining": "0" } })) as unknown as typeof fetch;
  const use = newUse(1);
  await budget.fetchFn(1, use, jupiter)("https://api.jup.ag/swap/v1/swap-instructions", { method: "POST" });
  assert.deepEqual([use.quotes, use.instructions], [0, 1]);
  await assert.rejects(budget.run(2, ok), isBusy);
});

test("whole builds no longer queue behind the guard: only their Jupiter calls do", async () => {
  const g = new Guard({ auth: "off", readLimit: "report", serviceKeys: new Map(), proxyKey: null, privy: null, budget: new JupiterBudget() });
  const release: (() => void)[] = [];
  const builds = Array.from({ length: 12 }, () => g.build(() => new Promise<void>((r) => release.push(r))));
  await new Promise((r) => setImmediate(r));
  assert.equal(release.length, 12, "all twelve run at once");
  for (const r of release) r();
  await Promise.all(builds);
});

// Routing: one stock leg with one issuer token, quoted through a stubbed Jupiter.
const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const KEY = "equity:US:NVDA";

function bank() {
  const s = emptyState();
  s.underlyings[KEY] = { key: KEY, idHex: "00".repeat(32), cls: "equity", code: "NVDA", name: "NVIDIA", themes: [], mints: [NVDAX], perps: [], pythFeedId: null, refPriceUsd: 180, refPriceSource: null, refPriceAt: null } as any;
  s.tokens[NVDAX] = {
    mint: NVDAX, symbol: "NVDAx", issuer: "xStocks", issuerTag: null, decimals: 8, transferFeeBps: null, paused: false, defaultFrozen: false, permanentDelegate: false,
    scaledUi: null, ratio: { comparable: true, underlyingPerUiToken: 1 }, usPersons: "no", jupiterPooledUsd: 1_000_000, probe: null, price: null,
    liquidity: { ratioSuspect: false },
  } as any;
  return s;
}

const leg: MappedLeg = { index: 0, name: "NVIDIA", key: KEY, how: "swap", spec: { weightBps: 10_000, leverage: 1, fadeVia: { none: {} } } as any, blocked: null };

/** A Jupiter that answers quotes with `quote` (status, body) and swap instructions for whoever asks. */
function jupiter(t: { mock: { method: Function } }, quote: (url: string) => [number, unknown]) {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes("/swap/v1/quote?")) {
      const [status, body] = quote(url);
      return new Response(JSON.stringify(body), { status });
    }
    const user = new PublicKey(JSON.parse(String(init!.body)).userPublicKey);
    const out = associatedTokenAddress(user, NVDAX, TOKEN_2022_PROGRAM);
    const acct = (pubkey: string, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
    return new Response(JSON.stringify({
      setupInstructions: [{ programId: ASSOCIATED_TOKEN_PROGRAM, accounts: [acct(user.toBase58(), true, true), acct(out, false, true), acct(user.toBase58()), acct(NVDAX), acct("11111111111111111111111111111111"), acct(TOKEN_2022_PROGRAM)], data: "AQ==" }],
      swapInstruction: { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", accounts: [acct(user.toBase58(), true), acct(associatedTokenAddress(user, USDC_MINT, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), false, true), acct(out, false, true)], data: "AA==" },
      addressLookupTableAddresses: [],
    }));
  });
  return calls;
}
const routed = { inAmount: "20000000", outAmount: "11000000", otherAmountThreshold: "10890000", priceImpactPct: "0", slippageBps: 100, outputMint: NVDAX, routePlan: [{ swapInfo: { label: "Whirlpool" }, percent: 100 }] };
/** Quotes for whatever amount is asked, at ~$182 a share (NVDAx has 8 decimals). */
const routes = (url: string): [number, unknown] => {
  const amount = BigInt(new URL(url).searchParams.get("amount")!);
  return [200, { ...routed, inAmount: String(amount), outAmount: String((amount * 11n) / 20n), otherAmountThreshold: String((amount * 11n * 99n) / 2000n) }];
};

const routerWith = (budget = new JupiterBudget()) =>
  new Router({ bank, appPayer: Keypair.generate(), jupiterApiKey: null } as any, { budget, readMints: null });

test("a build counts its Jupiter calls, and the next one quotes just the issuer that won", async (t) => {
  jupiter(t, routes);
  const router = routerWith();
  const user = Keypair.generate().publicKey;
  const first = await router.venueLegs([leg], user, 20);
  assert.equal(first.venue.length, 1);
  assert.equal(first.venue[0].output.account.toBase58(), associatedTokenAddress(user, NVDAX, TOKEN_2022_PROGRAM));
  assert.deepEqual([first.jupiter.lane, first.jupiter.calls, first.jupiter.quotes, first.jupiter.instructions, first.jupiter.winnerMisses], [1, 2, 1, 1, 1]);
  const second = await router.venueLegs([leg], user, 25, undefined, undefined, { lane: 2 });
  assert.deepEqual([second.jupiter.lane, second.jupiter.winnerHits, second.jupiter.winnerMisses], [2, 1, 0]);
});

test("a prebuild whose quote fails answers busy, and the leg isn't remembered as unroutable", async (t) => {
  const calls = jupiter(t, () => [500, { error: "upstream" }]);
  const router = routerWith();
  const use = newUse(2);
  await assert.rejects(router.venueLegs([leg], Keypair.generate().publicKey, 20, undefined, undefined, { lane: 2, use }), isBusy);
  assert.equal(calls.length, 1);
  assert.equal(use.calls, 1);
  assert.equal(router.leftOut(leg), null, "quoted again next time");
});

test("at tap time a failed quote leaves the leg out of this build only; a real no-route is remembered", async (t) => {
  let answer: [number, unknown] = [500, {}];
  jupiter(t, () => answer);
  const router = routerWith();
  await assert.rejects(router.venueLegs([leg], Keypair.generate().publicKey, 20), (e: unknown) => e instanceof ApiError && e.code === "nothing_tradable");
  assert.equal(router.leftOut(leg), null);
  answer = [400, { errorCode: "COULD_NOT_FIND_ANY_ROUTE" }];
  await assert.rejects(router.venueLegs([leg], Keypair.generate().publicKey, 20), (e: unknown) => e instanceof ApiError && e.code === "nothing_tradable");
  assert.match(router.leftOut(leg)!, /no liquid tokenized version/);
});

test("a prebuild the budget refuses makes no Jupiter call and answers busy", async (t) => {
  const calls = jupiter(t, routes);
  const budget = new JupiterBudget({ reserve: 10 });
  const router = routerWith(budget);
  const use = newUse(2);
  await assert.rejects(router.venueLegs([leg], Keypair.generate().publicKey, 20, undefined, undefined, { lane: 2, use }), isBusy);
  assert.equal(calls.length, 0);
  assert.ok(use.refused);
  assert.equal(router.leftOut(leg), null);
  // A tap still gets through on the reserve.
  const tap = await router.venueLegs([leg], Keypair.generate().publicKey, 20);
  assert.equal(tap.venue.length, 1);
});

test("route checks are lane 3: refused or failed checks remember nothing", async (t) => {
  const calls = jupiter(t, routes);
  const router = routerWith(new JupiterBudget({ reserve: 10 }));
  await router.checkRoutes([leg]);
  assert.equal(calls.length, 0, "refused: below the reserve");
  assert.equal(router.leftOut(leg), null);
});

// Shared routing: the same trade by another wallet reuses the winners, the split and a template
// of the swap instructions, retargeted to it.
test("the same trade by a second wallet makes no Jupiter call, and its legs are its own", async (t) => {
  const calls = jupiter(t, routes);
  const router = routerWith();
  const [a, b, payer] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  const first = await router.venueLegs([leg], a, 20, payer, undefined, { lane: 2 });
  assert.equal(first.jupiter.template, "miss");
  assert.equal(calls.length, 2);
  const second = await router.venueLegs([leg], b, 20, payer);
  assert.deepEqual([second.jupiter.template, second.jupiter.calls, second.jupiter.templatedLegs], ["hit", 0, 1]);
  assert.equal(calls.length, 2, "no Jupiter call");
  // Byte for byte what a fresh build for the second wallet makes.
  const fresh = await routerWith().venueLegs([leg], b, 20, payer);
  assert.equal(legDiff(second.venue[0] as unknown as JupiterBuy, fresh.venue[0] as unknown as JupiterBuy), null);
  assert.equal(second.venue[0].output.account.toBase58(), associatedTokenAddress(b, NVDAX, TOKEN_2022_PROGRAM));
  assert.equal((second.venue[0] as unknown as JupiterBuy).inUsdc, 20_000_000n);
  assert.deepEqual(router.jupiterStats().templates, { size: 1, hits: 1, waits: 0, misses: 1, templatedLegs: 1 });
});

test("a different stake routes on its own; the same wallet again reuses its own answer", async (t) => {
  const calls = jupiter(t, routes);
  const router = routerWith();
  const a = Keypair.generate().publicKey;
  await router.venueLegs([leg], a, 20);
  const other = await router.venueLegs([leg], Keypair.generate().publicKey, 20.01);
  assert.equal(other.jupiter.template, "miss");
  assert.equal((other.venue[0] as unknown as JupiterBuy).inUsdc, 20_010_000n);
  const before = calls.length;
  const again = await router.venueLegs([leg], a, 20);
  assert.deepEqual([again.jupiter.template, again.jupiter.calls, again.jupiter.templatedLegs], ["hit", 0, 0]);
  assert.equal(calls.length, before);
});

test("builds of the same trade at once wait for one routing", async (t) => {
  const calls = jupiter(t, routes);
  const router = routerWith();
  const [x, y] = await Promise.all([router.venueLegs([leg], Keypair.generate().publicKey, 20), router.venueLegs([leg], Keypair.generate().publicKey, 20)]);
  assert.deepEqual([x.jupiter.template, y.jupiter.template], ["miss", "wait"]);
  assert.equal(calls.length, 2, "one quote, one swap-instructions");
});

test("routing that left a leg out on a failed quote isn't shared", async (t) => {
  // $12 and $8 of $20; the $8 quote fails at first.
  const two: MappedLeg[] = [{ ...leg, spec: { ...leg.spec, weightBps: 6_000 } as any }, { ...leg, index: 1, name: "NVIDIA again", spec: { ...leg.spec, weightBps: 4_000 } as any }];
  let fail = true;
  jupiter(t, (url) => (fail && new URL(url).searchParams.get("amount") === "8000000" ? [500, {}] : routes(url)));
  const router = routerWith();
  const first = await router.venueLegs(two, Keypair.generate().publicKey, 20);
  assert.deepEqual(first.included, [0], "at tap time the failed leg is left out of this build");
  fail = false;
  const next = await router.venueLegs(two, Keypair.generate().publicKey, 20);
  assert.equal(next.jupiter.template, "miss");
  assert.deepEqual(next.included, [0, 1]);
});

test("after 20 seconds a trade routes afresh", async (t) => {
  jupiter(t, routes);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const router = routerWith(new JupiterBudget({}, () => Date.now()));
  await router.venueLegs([leg], Keypair.generate().publicKey, 20);
  t.mock.timers.tick(TEMPLATE_TTL_MS - 1);
  assert.equal((await router.venueLegs([leg], Keypair.generate().publicKey, 20)).jupiter.template, "hit");
  t.mock.timers.tick(1);
  assert.equal((await router.venueLegs([leg], Keypair.generate().publicKey, 20)).jupiter.template, "miss");
});

test("a prebuild refused after routing still leaves the routing to the tap, which makes its own swap call", async (t) => {
  const calls = jupiter(t, routes);
  // Lane 2 may take one request (the quote), not a second (the swap instructions).
  const router = routerWith(new JupiterBudget({ reserve: 9, prebuildWaitMs: 0 }));
  const a = Keypair.generate().publicKey;
  await assert.rejects(router.venueLegs([leg], a, 20, undefined, undefined, { lane: 2 }), isBusy);
  assert.equal(calls.length, 1);
  const tap = await router.venueLegs([leg], a, 20);
  assert.deepEqual([tap.jupiter.template, tap.jupiter.quotes, tap.jupiter.instructions], ["hit", 0, 1]);
  assert.equal(tap.venue.length, 1);
});
