import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM, JUPITER_V6_PROGRAM, PRICE_TTL_MS, PriceCache, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, associatedTokenAddress, legDiff, routeAmounts, type JupiterBuy } from "@thesis/venues/jupiter";
import { emptyState } from "../../../packages/venues/bank/src/state.ts";
import { JupiterBudget } from "../api/guard.ts";
import type { MappedLeg } from "../api/legs.ts";
import { ROUTE_TTL_MS, Router, TEMPLATE_TTL_MS, routeTtlFromEnv } from "../api/routing.ts";

// Scaled routing (api/routing.ts, packages/venues/jupiter scale.ts): after one build of a trade,
// builds at other stakes nearby rewrite its swap instructions instead of calling Jupiter.

// A four-leg take: four stocks, one issuer token each, 25% each.
const STOCKS = ["NVDA", "AAPL", "TSLA", "MSFT"].map((code, i) => ({ code, key: `equity:US:${code}`, mint: Keypair.fromSeed(new Uint8Array(32).fill(i + 1)).publicKey.toBase58() }));

function bank() {
  const s = emptyState();
  for (const { code, key, mint } of STOCKS) {
    s.underlyings[key] = { key, idHex: "00".repeat(32), cls: "equity", code, name: code, themes: [], mints: [mint], perps: [], pythFeedId: null, refPriceUsd: 180, refPriceSource: null, refPriceAt: null } as any;
    s.tokens[mint] = {
      mint, symbol: `${code}x`, issuer: "xStocks", issuerTag: null, decimals: 8, transferFeeBps: null, paused: false, defaultFrozen: false, permanentDelegate: false,
      scaledUi: null, ratio: { comparable: true, underlyingPerUiToken: 1 }, usPersons: "no", jupiterPooledUsd: 1_000_000, probe: null, price: null,
      liquidity: { ratioSuspect: false },
    } as any;
  }
  return s;
}

const legs: MappedLeg[] = STOCKS.map(({ code, key }, index) => ({ index, name: code, key, how: "swap", spec: { weightBps: 2_500, leverage: 1, fadeVia: { none: {} } } as any, blocked: null }));

/** Jupiter v6 `route` data: discriminator, a one-step route plan (Whirlpool, 100%), then the amounts. */
function routeData(inAmount: bigint, quotedOut: bigint, slippageBps: number) {
  const tail = Buffer.alloc(19);
  tail.writeBigUInt64LE(inAmount, 0);
  tail.writeBigUInt64LE(quotedOut, 8);
  tail.writeUInt16LE(slippageBps, 16);
  return Buffer.concat([Buffer.from("e517cb977ae3ad2a", "hex"), Buffer.from([1, 0, 0, 0, 17, 1, 100, 0, 1]), tail]).toString("base64");
}

/** The quotes' price: 0.0055 NVDAx-like tokens (8 decimals) per $1, about $181.82 a token. */
const QUOTED_USD = 1 / 0.0055;

/**
 * A Jupiter that quotes any amount at a fixed price (`impact`: the quote's priceImpactPct) and
 * answers swap-instructions with a `route` instruction for whoever asks, as the real one does.
 * Price v3 answers `price(mint)` (default: the quotes' price; null: no price for it), or fails
 * with HTTP 500 when `price` throws. `calls` lists swap API calls (quotes and swap-instructions);
 * `calls.prices` the Price v3 reads.
 */
function jupiter(t: { mock: { method: Function } }, o: { impact?: string; data?: string; price?: (mint: string) => number | null } = {}) {
  const calls = Object.assign([] as string[], { prices: [] as string[] });
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url.includes("/price/v3?")) {
      calls.prices.push(url);
      const ids = new URL(url).searchParams.get("ids")!.split(",");
      try {
        return Response.json(Object.fromEntries(ids.flatMap((m) => {
          const usd = o.price ? o.price(m) : QUOTED_USD;
          return usd === null ? [] : [[m, { usdPrice: usd, liquidity: 1_000_000 }]];
        })));
      } catch {
        return new Response("{}", { status: 500 });
      }
    }
    calls.push(url);
    if (url.includes("/swap/v1/quote?")) {
      const q = new URL(url).searchParams;
      const amount = BigInt(q.get("amount")!);
      const out = (amount * 11n) / 20n;
      return new Response(JSON.stringify({
        inputMint: USDC_MINT, outputMint: q.get("outputMint"), inAmount: String(amount), outAmount: String(out), otherAmountThreshold: String(out - (out * 100n) / 10_000n),
        swapMode: "ExactIn", slippageBps: 100, platformFee: null, priceImpactPct: o.impact ?? "0", routePlan: [{ swapInfo: { label: "Whirlpool", inputMint: USDC_MINT, outputMint: q.get("outputMint"), inAmount: String(amount), outAmount: String(out) }, percent: 100 }],
      }));
    }
    const body = JSON.parse(String(init!.body));
    const user = new PublicKey(body.userPublicKey);
    const quote = body.quoteResponse;
    const out = associatedTokenAddress(user, quote.outputMint, TOKEN_2022_PROGRAM);
    const acct = (pubkey: string, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
    return new Response(JSON.stringify({
      setupInstructions: [{ programId: ASSOCIATED_TOKEN_PROGRAM, accounts: [acct(user.toBase58(), true, true), acct(out, false, true), acct(user.toBase58()), acct(quote.outputMint), acct("11111111111111111111111111111111"), acct(TOKEN_2022_PROGRAM)], data: "AQ==" }],
      swapInstruction: {
        programId: JUPITER_V6_PROGRAM,
        accounts: [acct(user.toBase58(), true), acct(associatedTokenAddress(user, USDC_MINT, TOKEN_PROGRAM), false, true), acct(out, false, true), acct(Keypair.fromSeed(new Uint8Array(32).fill(99)).publicKey.toBase58(), false, true)],
        data: o.data ?? routeData(BigInt(quote.inAmount), BigInt(quote.outAmount), quote.slippageBps),
      },
      cleanupInstruction: null,
      addressLookupTableAddresses: [],
    }));
  });
  return calls;
}

/** A budget roomy enough that these tests count calls, not wait for the bucket. */
const routerWith = (o: { routeTtlMs?: number; bank?: typeof bank } = {}) =>
  new Router({ bank: o.bank ?? bank, appPayer: Keypair.generate(), jupiterApiKey: null } as any, {
    budget: new JupiterBudget({ perMinute: 6_000, burst: 1_000, reserve: 0 }, () => Date.now()),
    readMints: null,
    routeTtlMs: o.routeTtlMs,
    prices: new PriceCache(PRICE_TTL_MS, () => Date.now()),
  });
const swaps = (r: { venue: unknown[] }) => r.venue as unknown as JupiterBuy[];
const swapIx = (leg: JupiterBuy) => leg.instructions.find((ix) => ix.programId.toBase58() === JUPITER_V6_PROGRAM)!;

test("a four-leg trade's second build at another amount makes no Jupiter call", async (t) => {
  const calls = jupiter(t);
  const router = routerWith();
  const [a, payer] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const first = await router.venueLegs(legs, a, 20, payer, undefined, { lane: 2 });
  assert.deepEqual([first.jupiter.template, first.jupiter.quotes, first.jupiter.instructions], ["miss", 4, 4]);
  assert.equal(calls.length, 8);
  const second = await router.venueLegs(legs, a, 50, payer, undefined, { lane: 2 });
  assert.deepEqual([second.jupiter.template, second.jupiter.calls, second.jupiter.templatedLegs], ["scaled", 0, 4]);
  assert.equal(calls.length, 8, "no Jupiter call");
  for (const [i, leg] of swaps(second).entries()) {
    assert.equal(leg.inUsdc, 12_500_000n, "exactly the leg's part of the new stake");
    assert.equal(leg.outAmount, 6_875_000n, "the expected output in proportion");
    assert.equal(routeAmounts({ programId: JUPITER_V6_PROGRAM, accounts: [], data: swapIx(leg).data.toString("base64") })!.inAmount, 12_500_000n);
    assert.equal(second.venue[i].output.account.toBase58(), associatedTokenAddress(a, STOCKS[i].mint, TOKEN_2022_PROGRAM), "proof of trade: the wallet's own account");
  }
  // Byte for byte what a fresh build at $50 makes (this Jupiter's price doesn't move with size).
  const fresh = await routerWith().venueLegs(legs, a, 50, payer);
  for (const [i, leg] of swaps(second).entries()) assert.equal(legDiff(leg, swaps(fresh)[i]), null);
  assert.deepEqual(router.jupiterStats().templates, { size: 1, hits: 0, waits: 0, scaled: 1, routes: 0, misses: 1, templatedLegs: 4 });
});

test("another wallet scales the trade too, to its own accounts", async (t) => {
  const calls = jupiter(t);
  const router = routerWith();
  const [a, b, payer] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  await router.venueLegs(legs, a, 20, payer);
  const other = await router.venueLegs(legs, b, 10, payer);
  assert.deepEqual([other.jupiter.template, other.jupiter.calls], ["scaled", 0]);
  assert.equal(calls.length, 8);
  const fresh = await routerWith().venueLegs(legs, b, 10, payer);
  for (const [i, leg] of swaps(other).entries()) {
    assert.equal(legDiff(leg, swaps(fresh)[i]), null);
    assert.ok(!swapIx(leg).keys.some((k) => k.pubkey.equals(a)));
  }
});

test("only within 0.1x-10x of a routing quoted in the last 20 seconds", async (t) => {
  const calls = jupiter(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  // Scaling alone: no kept routes (those reprice past 20 s: tested below).
  const router = routerWith({ routeTtlMs: 0 });
  const user = () => Keypair.generate().publicKey;
  await router.venueLegs(legs, user(), 20);
  assert.equal(calls.length, 8);
  assert.equal(calls.prices.length, 0, "no price read without kept routes");
  // The web's chips from $20 ($50 is exactly 2.5x: missed on rounding under the old 0.4x-2.5x).
  for (const usd of [50, 100, 10, 7]) assert.equal((await router.venueLegs(legs, user(), usd)).jupiter.template, "scaled", `$${usd}`);
  assert.equal(calls.length, 8, "no Jupiter call for any of them");
  assert.equal((await router.venueLegs(legs, user(), 250)).jupiter.template, "miss", "12.5x: quoted afresh");
  assert.equal((await router.venueLegs(legs, user(), 1.5)).jupiter.template, "miss", "0.075x: quoted afresh");
  assert.equal(calls.length, 24);
  t.mock.timers.tick(TEMPLATE_TTL_MS);
  assert.equal((await router.venueLegs(legs, user(), 30)).jupiter.template, "miss", "past 20 s: quoted afresh");
});

test("a quote that moved the price over 0.5% isn't scaled; a thin one scales only as far as its shortfall allows", async (t) => {
  const calls = jupiter(t, { impact: "0.006" });
  const router = routerWith();
  await router.venueLegs(legs, Keypair.generate().publicKey, 20);
  assert.equal((await router.venueLegs(legs, Keypair.generate().publicKey, 25)).jupiter.template, "miss");
  assert.equal(calls.length, 16);
});

test("a 0.16%-impact quote (a thin pool) scales to $50 and down, not to $100", async (t) => {
  jupiter(t, { impact: "0.0016" });
  const router = routerWith();
  await router.venueLegs(legs, Keypair.generate().publicKey, 20);
  assert.equal((await router.venueLegs(legs, Keypair.generate().publicKey, 50)).jupiter.template, "scaled", "2.5x: ~0.24% short");
  assert.equal((await router.venueLegs(legs, Keypair.generate().publicKey, 10)).jupiter.template, "scaled", "down");
  assert.equal((await router.venueLegs(legs, Keypair.generate().publicKey, 100)).jupiter.template, "miss", "5x: ~0.64% short");
});

test("a swap instruction scale.ts can't read isn't scaled", async (t) => {
  const calls = jupiter(t, { data: "AA==" });
  const router = routerWith();
  await router.venueLegs(legs, Keypair.generate().publicKey, 20);
  assert.equal((await router.venueLegs(legs, Keypair.generate().publicKey, 25)).jupiter.template, "miss");
  assert.equal(calls.length, 16);
});

test("a wallet asking again after a scaled answer (a retry) quotes afresh, and the scaled-from routing goes", async (t) => {
  const calls = jupiter(t);
  const router = routerWith();
  const [a, b, c] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  await router.venueLegs(legs, a, 20);
  assert.equal((await router.venueLegs(legs, b, 50)).jupiter.template, "scaled");
  const retry = await router.venueLegs(legs, b, 50);
  assert.deepEqual([retry.jupiter.template, retry.jupiter.quotes, retry.jupiter.instructions], ["miss", 4, 4]);
  assert.equal(calls.length, 16);
  // The $20 routing is gone; the fresh $50 one serves others.
  assert.equal((await router.venueLegs(legs, c, 50)).jupiter.template, "hit");
  const near = await router.venueLegs(legs, c, 22);
  assert.equal(near.jupiter.template, "scaled");
  assert.equal(swaps(near)[0].inUsdc, 5_500_000n);
  assert.equal(calls.length, 16);
});

test("a build while the first routing is in flight waits for it and scales it", async (t) => {
  const calls = jupiter(t);
  const router = routerWith();
  const [x, y] = await Promise.all([router.venueLegs(legs, Keypair.generate().publicKey, 20), router.venueLegs(legs, Keypair.generate().publicKey, 30)]);
  assert.deepEqual([x.jupiter.template, y.jupiter.template, y.jupiter.calls], ["miss", "scaled", 0]);
  assert.equal(calls.length, 8);
  assert.equal(swaps(y)[0].inUsdc, 7_500_000n);
});

test("a prebuild in flight is waited for by the tap: same stake or another, no Jupiter call of its own", async (t) => {
  const calls = jupiter(t);
  const router = routerWith();
  const a = Keypair.generate().publicKey;
  const [pre, tap] = await Promise.all([router.venueLegs(legs, a, 20, undefined, undefined, { lane: 2 }), router.venueLegs(legs, a, 20)]);
  assert.deepEqual([pre.jupiter.template, tap.jupiter.template, tap.jupiter.calls, tap.jupiter.lane], ["miss", "wait", 0, 1]);
  // $250 is too far from $20 to scale (12.5x): the prebuild routes it, and a tap at $300 scales that.
  const [pre2, tap2] = await Promise.all([router.venueLegs(legs, a, 250, undefined, undefined, { lane: 2 }), router.venueLegs(legs, Keypair.generate().publicKey, 300)]);
  assert.deepEqual([pre2.jupiter.template, tap2.jupiter.template, tap2.jupiter.calls], ["miss", "scaled", 0]);
  assert.equal(calls.length, 16, "two routings, each made once");
});

// Kept routes (api/routing.ts): past the 20-second sharing, a leg's route is kept for minutes and
// repriced at the token's Jupiter price now: one price read for the whole basket, no quote.
test("the same take a minute later at another stake: one price read, no quote or swap call", async (t) => {
  const calls = jupiter(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const router = routerWith();
  const [a, b, payer] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  await router.venueLegs(legs, a, 20, payer);
  await router.routesLearned();
  assert.equal(calls.length, 8);
  assert.equal(calls.prices.length, 1, "the templates' price, read once after the build");
  t.mock.timers.tick(60_000);
  const later = await router.venueLegs(legs, b, 50, payer);
  assert.deepEqual(
    [later.jupiter.template, later.jupiter.calls, later.jupiter.prices, later.jupiter.quotes, later.jupiter.instructions, later.jupiter.templatedLegs],
    ["route", 1, 1, 0, 0, 4],
  );
  assert.equal(calls.length, 8, "no quote, no swap-instructions");
  for (const [i, leg] of swaps(later).entries()) {
    assert.equal(leg.inUsdc, 12_500_000n, "exactly the leg's part of the stake");
    assert.equal(routeAmounts({ programId: JUPITER_V6_PROGRAM, accounts: [], data: swapIx(leg).data.toString("base64") })!.inAmount, 12_500_000n, "proof of trade: the instruction spends exactly that");
    assert.equal(later.venue[i].output.account.toBase58(), associatedTokenAddress(b, STOCKS[i].mint, TOKEN_2022_PROGRAM), "the wallet's own account");
    assert.ok(!swapIx(leg).keys.some((k) => k.pubkey.equals(a)), "nothing of the first wallet's");
  }
  // The price didn't move: byte for byte what a fresh build makes.
  const fresh = await routerWith({ routeTtlMs: 0 }).venueLegs(legs, b, 50, payer);
  for (const [i, leg] of swaps(later).entries()) assert.equal(legDiff(leg, swaps(fresh)[i]), null);
  // Builds of this trade in the next 20 s scale that routing, as any other (no call).
  assert.deepEqual([(await router.venueLegs(legs, Keypair.generate().publicKey, 30, payer)).jupiter.template, calls.prices.length], ["scaled", 2]);
  // Another take with two of these names within PRICE_TTL_MS: the prices are shared too, so no call at all.
  const pair: MappedLeg[] = [legs[0], { ...legs[3], index: 1 }];
  const next = await router.venueLegs(pair, Keypair.generate().publicKey, 30, payer);
  assert.deepEqual([next.jupiter.template, next.jupiter.calls], ["route", 0]);
  assert.deepEqual(router.jupiterStats().routes, { size: 4, repriced: 6, kept: 4, unpriced: 0, prices: { reads: 2, failed: 0 } });
});

test("a repriced leg expects the output at the price now, with the same 1% slippage", async (t) => {
  let usd = QUOTED_USD;
  jupiter(t, { price: () => usd });
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const router = routerWith();
  await router.venueLegs(legs, Keypair.generate().publicKey, 20);
  await router.routesLearned();
  t.mock.timers.tick(60_000);
  usd = QUOTED_USD * 1.02; // 2% dearer
  const later = await router.venueLegs(legs, Keypair.generate().publicKey, 50);
  assert.equal(later.jupiter.template, "route");
  for (const leg of swaps(later)) {
    assert.equal(leg.inUsdc, 12_500_000n);
    assert.ok(Math.abs(Number(leg.outAmount) - 6_875_000 / 1.02) < 1, `${leg.outAmount}: the proportional output at the new price`);
    assert.equal(leg.minOutAmount, leg.outAmount - (leg.outAmount * 100n) / 10_000n, "1% slippage");
    const r = routeAmounts({ programId: JUPITER_V6_PROGRAM, accounts: [], data: swapIx(leg).data.toString("base64") })!;
    assert.deepEqual([r.inAmount, r.quotedOutAmount, r.slippageBps], [12_500_000n, leg.outAmount, 100], "what the swap checks on-chain");
  }
});

test("a leg with no price now, or a price that moved over 3%, is quoted afresh; the others are still repriced", async (t) => {
  const prices = new Map<string, number | null>();
  const calls = jupiter(t, { price: (m) => (prices.has(m) ? prices.get(m)! : QUOTED_USD) });
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const router = routerWith();
  await router.venueLegs(legs, Keypair.generate().publicKey, 20);
  await router.routesLearned();
  t.mock.timers.tick(60_000);
  prices.set(STOCKS[1].mint, null);
  prices.set(STOCKS[2].mint, QUOTED_USD * 1.05);
  const later = await router.venueLegs(legs, Keypair.generate().publicKey, 50);
  assert.deepEqual([later.jupiter.template, later.jupiter.quotes, later.jupiter.instructions, later.jupiter.templatedLegs], ["miss", 2, 2, 2]);
  assert.equal(calls.length, 12);
  for (const leg of swaps(later)) assert.equal(leg.inUsdc, 12_500_000n);
  // The moved leg's new template is kept on the build's own price read (moments before): no extra
  // read for it. The unpriced one is tried once more, then left unkept.
  await router.routesLearned();
  assert.equal(router.jupiterStats().routes.unpriced, 1);
});

test("when the price read fails, every leg is quoted as before", async (t) => {
  let fail = false;
  const calls = jupiter(t, {
    price: () => {
      if (fail) throw new Error("down");
      return QUOTED_USD;
    },
  });
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const router = routerWith();
  await router.venueLegs(legs, Keypair.generate().publicKey, 20);
  await router.routesLearned();
  t.mock.timers.tick(60_000);
  fail = true;
  const later = await router.venueLegs(legs, Keypair.generate().publicKey, 50);
  assert.deepEqual([later.jupiter.template, later.jupiter.quotes, later.jupiter.instructions, later.jupiter.prices], ["miss", 4, 4, 1]);
  assert.equal(calls.length, 16);
  assert.equal(later.venue.length, 4);
});

test("routes last FORK_API_ROUTE_TTL_MS: past it the build quotes afresh and keeps the new routes", async (t) => {
  const calls = jupiter(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const router = routerWith();
  await router.venueLegs(legs, Keypair.generate().publicKey, 20);
  await router.routesLearned();
  t.mock.timers.tick(ROUTE_TTL_MS - 1);
  assert.equal((await router.venueLegs(legs, Keypair.generate().publicKey, 30)).jupiter.template, "route");
  // Past the routes' time, and past the 20 s that repriced routing is shared for.
  t.mock.timers.tick(TEMPLATE_TTL_MS);
  const stale = await router.venueLegs(legs, Keypair.generate().publicKey, 40);
  assert.deepEqual([stale.jupiter.template, stale.jupiter.quotes, stale.jupiter.prices], ["miss", 4, 0]);
  await router.routesLearned();
  t.mock.timers.tick(60_000);
  assert.equal((await router.venueLegs(legs, Keypair.generate().publicKey, 60)).jupiter.template, "route", "the new routes serve");
  assert.equal(calls.length, 16);
  // Off: nothing kept, nothing read.
  const off = routerWith({ routeTtlMs: 0 });
  await off.venueLegs(legs, Keypair.generate().publicKey, 20);
  await off.routesLearned();
  t.mock.timers.tick(60_000);
  assert.equal((await off.venueLegs(legs, Keypair.generate().publicKey, 30)).jupiter.template, "miss");
});

test("FORK_API_ROUTE_TTL_MS: unset keeps 10 minutes, 0 turns routes off, a bad value fails clearly", () => {
  assert.equal(routeTtlFromEnv({}), 600_000);
  assert.equal(routeTtlFromEnv({ FORK_API_ROUTE_TTL_MS: " 120000 " }), 120_000);
  assert.equal(routeTtlFromEnv({ FORK_API_ROUTE_TTL_MS: "0" }), 0);
  for (const bad of ["-1", "1.5", "ten", "3600001"]) assert.throws(() => routeTtlFromEnv({ FORK_API_ROUTE_TTL_MS: bad }), /FORK_API_ROUTE_TTL_MS/);
});

test("kept routes serve other takes that hold the same names", async (t) => {
  const calls = jupiter(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const router = routerWith();
  await router.venueLegs(legs, Keypair.generate().publicKey, 20);
  await router.routesLearned();
  t.mock.timers.tick(60_000);
  // NVDA 70% and MSFT 30% of $25: $17.50 and $7.50.
  const pair: MappedLeg[] = [{ ...legs[0], spec: { ...legs[0].spec, weightBps: 7_000 } as any }, { ...legs[3], index: 1, spec: { ...legs[3].spec, weightBps: 3_000 } as any }];
  const other = await router.venueLegs(pair, Keypair.generate().publicKey, 25);
  assert.deepEqual([other.jupiter.template, other.jupiter.quotes, other.jupiter.instructions], ["route", 0, 0]);
  assert.deepEqual(swaps(other).map((l) => l.inUsdc), [17_500_000n, 7_500_000n]);
  assert.equal(calls.length, 8);
});

test("a wallet asking again after a repriced answer (a retry) quotes afresh", async (t) => {
  const calls = jupiter(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const router = routerWith();
  const [b, c] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  await router.venueLegs(legs, Keypair.generate().publicKey, 20);
  await router.routesLearned();
  t.mock.timers.tick(60_000);
  assert.equal((await router.venueLegs(legs, b, 50)).jupiter.template, "route");
  const retry = await router.venueLegs(legs, b, 50);
  assert.deepEqual([retry.jupiter.template, retry.jupiter.quotes, retry.jupiter.instructions], ["miss", 4, 4]);
  assert.equal(calls.length, 16);
  // Others now share that fresh routing.
  assert.equal((await router.venueLegs(legs, c, 50)).jupiter.template, "hit");
  // The kept routes at every size were dropped; only the retry's ($12.50 legs) are kept.
  await router.routesLearned();
  assert.equal(router.jupiterStats().routes.size, 4);
  t.mock.timers.tick(60_000);
  const small = await router.venueLegs(legs, c, 5); // $1.25 legs: 0.1x of the retry's, 0.25x of the dropped $5 ones
  assert.deepEqual([small.jupiter.template, swaps(small)[0].inUsdc], ["route", 1_250_000n]);
  t.mock.timers.tick(TEMPLATE_TTL_MS); // past the $5 build's own 20 s of scaling
  const smaller = await router.venueLegs(legs, c, 4); // 0.08x of the retry's: the dropped $5 routes would have served
  assert.equal(smaller.jupiter.template, "miss");
});

test("a multiplier change since the quote isn't repriced", async (t) => {
  const calls = jupiter(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const state = bank();
  const router = routerWith({ bank: () => state });
  await router.venueLegs(legs, Keypair.generate().publicKey, 20);
  await router.routesLearned();
  t.mock.timers.tick(60_000);
  (state.tokens[STOCKS[0].mint] as any).scaledUi = { multiplier: 1.01, newMultiplier: 1.01, newMultiplierEffectiveAt: 0 };
  const later = await router.venueLegs(legs, Keypair.generate().publicKey, 50);
  assert.deepEqual([later.jupiter.template, later.jupiter.quotes, later.jupiter.templatedLegs], ["miss", 1, 3]);
  assert.equal(calls.length, 10);
});

test("a template scale.ts can't read is never kept, so no price is read for it", async (t) => {
  const calls = jupiter(t, { data: "AA==" });
  const router = routerWith();
  await router.venueLegs(legs, Keypair.generate().publicKey, 20);
  await router.routesLearned();
  assert.equal(calls.prices.length, 0);
  assert.equal(router.jupiterStats().routes.size, 0);
});
