import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM, JUPITER_V6_PROGRAM, PRICE_TTL_MS, PriceCache, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, associatedTokenAddress, routeAmounts } from "@thesis/venues/jupiter";
import { emptyState } from "../../../packages/venues/bank/src/state.ts";
import { ApiError } from "../api/common.ts";
import { JupiterBudget, newUse } from "../api/guard.ts";
import { Router, type SellSwap } from "../api/routing.ts";

// Sell routes (api/routing.ts "Sales"): a sale's swap of a token back to USDC reuses the route kept
// from the last sale of that token, repriced at the token's price now, so a sale of tokens sold in
// the last FORK_API_ROUTE_TTL_MS costs at most the one batched price read.

const TOKENS = ["NVDAx", "AVGOx"].map((symbol, i) => ({ symbol, mint: Keypair.fromSeed(new Uint8Array(32).fill(i + 40)).publicKey.toBase58() }));

function bank() {
  const s = emptyState();
  for (const { symbol, mint } of TOKENS) {
    s.tokens[mint] = {
      mint, symbol, issuer: "xStocks", issuerTag: null, decimals: 8, transferFeeBps: null, paused: false, defaultFrozen: false, permanentDelegate: false,
      scaledUi: null, ratio: { comparable: true, underlyingPerUiToken: 1 }, usPersons: "no", jupiterPooledUsd: 1_000_000, probe: null, price: null, program: "token-2022",
      liquidity: { ratioSuspect: false },
    } as any;
  }
  return s;
}

/** Jupiter v6 `route` data: discriminator, a one-step route plan, then the amounts. */
function routeData(inAmount: bigint, quotedOut: bigint, slippageBps: number) {
  const tail = Buffer.alloc(19);
  tail.writeBigUInt64LE(inAmount, 0);
  tail.writeBigUInt64LE(quotedOut, 8);
  tail.writeUInt16LE(slippageBps, 16);
  return Buffer.concat([Buffer.from("e517cb977ae3ad2a", "hex"), Buffer.from([1, 0, 0, 0, 17, 1, 100, 0, 1]), tail]).toString("base64");
}

/**
 * A Jupiter that sells any amount of a token for 2 USDC base units per token base unit, answers
 * swap-instructions with a `route` instruction for whoever asks (creating the wallet's USDC
 * account), and Price v3 with `price(mint)` (null: no price). `calls`: quotes and swap-instructions;
 * `calls.prices`: price reads.
 */
function jupiter(t: { mock: { method: Function } }, o: { price?: (mint: string) => number | null; noRoute?: string } = {}) {
  const calls = Object.assign([] as string[], { prices: [] as string[] });
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url.includes("/price/v3?")) {
      calls.prices.push(url);
      const ids = new URL(url).searchParams.get("ids")!.split(",");
      return Response.json(Object.fromEntries(ids.flatMap((m) => {
        const usd = o.price ? o.price(m) : 200;
        return usd === null ? [] : [[m, { usdPrice: usd, liquidity: 1_000_000 }]];
      })));
    }
    calls.push(url);
    if (url.includes("/swap/v1/quote?")) {
      const q = new URL(url).searchParams;
      if (q.get("inputMint") === o.noRoute) return new Response(JSON.stringify({ errorCode: "COULD_NOT_FIND_ANY_ROUTE" }), { status: 400 });
      const amount = BigInt(q.get("amount")!);
      const out = amount * 2n;
      return Response.json({
        inputMint: q.get("inputMint"), outputMint: q.get("outputMint"), inAmount: String(amount), outAmount: String(out), otherAmountThreshold: String(out - (out * 100n) / 10_000n),
        swapMode: "ExactIn", slippageBps: 100, platformFee: null, priceImpactPct: "0.0001",
        routePlan: [{ swapInfo: { label: "Whirlpool", inputMint: q.get("inputMint"), outputMint: q.get("outputMint"), inAmount: String(amount), outAmount: String(out) }, percent: 100 }],
      });
    }
    const body = JSON.parse(String(init!.body));
    const user = new PublicKey(body.userPublicKey);
    const quote = body.quoteResponse;
    const usdc = associatedTokenAddress(user, USDC_MINT, TOKEN_PROGRAM);
    const acct = (pubkey: string, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
    return Response.json({
      setupInstructions: [{ programId: ASSOCIATED_TOKEN_PROGRAM, accounts: [acct(user.toBase58(), true, true), acct(usdc, false, true), acct(user.toBase58()), acct(USDC_MINT), acct("11111111111111111111111111111111"), acct(TOKEN_PROGRAM)], data: "AQ==" }],
      swapInstruction: {
        programId: JUPITER_V6_PROGRAM,
        accounts: [acct(user.toBase58(), true), acct(associatedTokenAddress(user, quote.inputMint, TOKEN_2022_PROGRAM), false, true), acct(usdc, false, true), acct(Keypair.fromSeed(new Uint8Array(32).fill(98)).publicKey.toBase58(), false, true)],
        data: routeData(BigInt(quote.inAmount), BigInt(quote.outAmount), quote.slippageBps),
      },
      cleanupInstruction: null,
      addressLookupTableAddresses: [],
    });
  });
  return calls;
}

let clock = Date.now();
const routerWith = (o: { routeTtlMs?: number } = {}) =>
  new Router({ bank, appPayer: Keypair.generate(), jupiterApiKey: null } as any, {
    budget: new JupiterBudget({ perMinute: 6_000, burst: 1_000, reserve: 0 }, () => Date.now()),
    readMints: null,
    routeTtlMs: o.routeTtlMs,
    prices: new PriceCache(PRICE_TTL_MS, () => clock),
  });
const amounts = (s: SellSwap[]) => s.map((x) => routeAmounts({ programId: JUPITER_V6_PROGRAM, accounts: [], data: Buffer.from(x.venue.instructions.find((ix) => ix.programId.toBase58() === JUPITER_V6_PROGRAM)!.data).toString("base64") })!);
const sells = (a: bigint, b: bigint) => [{ mint: TOKENS[0].mint, amount: a, label: "Sell NVDAx" }, { mint: TOKENS[1].mint, amount: b, label: "Sell AVGOx" }];

test("a sale of tokens sold minutes ago makes no quote: the kept routes, repriced, sell exactly the tokens", async (t) => {
  clock = Date.now();
  const calls = jupiter(t);
  const router = routerWith();
  const [a, b, payer] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  const first = await router.sellSwaps(sells(1_000_000n, 3_000_000n), a, payer, { use: newUse(1) });
  assert.equal(calls.length, 4, "a quote and swap instructions per token");
  assert.deepEqual(first.map((s) => s.repriced), [false, false]);
  await router.routesLearned();
  assert.equal(calls.prices.length, 1, "the kept routes' prices: one read");

  // Another wallet, other amounts: the routes kept, repriced at the same price (from the cache).
  const use = newUse(1);
  const second = await router.sellSwaps(sells(2_500_000n, 1_200_000n), b, payer, { use });
  assert.equal(calls.length, 4, "no quote, no swap instructions");
  assert.equal(use.calls, 0, "the price is in the shared cache");
  assert.deepEqual(second.map((s) => s.repriced), [true, true]);
  assert.deepEqual(amounts(second).map((r) => r.inAmount), [2_500_000n, 1_200_000n], "exactly the tokens to sell");
  assert.deepEqual(second.map((s) => s.quote.outAmount), ["5000000", "2400000"], "out in proportion");
  assert.deepEqual(amounts(second).map((r) => r.quotedOutAmount), [5_000_000n, 2_400_000n]);
  for (const s of second) {
    assert.equal(s.venue.outputAccount?.toBase58(), associatedTokenAddress(b, USDC_MINT, TOKEN_PROGRAM), "into the wallet's own USDC account");
    assert.ok(!s.venue.instructions.some((ix) => ix.keys.some((k) => k.pubkey.equals(a))), "nothing of the first wallet's");
  }

  // Later, the price is read again (one call for both) and the USDC out moves with it.
  clock += PRICE_TTL_MS + 1;
  const later = newUse(1);
  const priced = { [TOKENS[0].mint]: 202, [TOKENS[1].mint]: 199 };
  t.mock.restoreAll();
  const calls2 = jupiter(t, { price: (m) => priced[m] ?? null });
  const third = await router.sellSwaps(sells(1_000_000n, 1_000_000n), payer, payer, { use: later });
  assert.equal(calls2.length, 0);
  assert.equal(calls2.prices.length, 1, "≤1 Jupiter call: the batched price read");
  assert.equal(later.calls, 1);
  assert.deepEqual(third.map((s) => s.quote.outAmount), ["2020000", "1990000"], "out at the price now");
  assert.deepEqual(router.jupiterStats().sells, { size: 2, repriced: 4, quoted: 2, kept: 2, unkept: 0, seeded: 0 });
});

test("a sell route isn't reused past a 3% move, for a repeat moments after, without a price, or with routes off", async (t) => {
  clock = Date.now();
  const priced: Record<string, number | null> = { [TOKENS[0].mint]: 200, [TOKENS[1].mint]: 200 };
  const calls = jupiter(t, { price: (m) => priced[m] ?? null });
  const router = routerWith();
  const [a, payer] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  await router.sellSwaps(sells(1_000_000n, 1_000_000n), a, payer);
  await router.routesLearned();
  // NVDAx moved 4%, AVGOx has no price now: both quoted afresh.
  clock += PRICE_TTL_MS + 1;
  priced[TOKENS[0].mint] = 208;
  priced[TOKENS[1].mint] = null;
  const before = calls.length;
  const moved = await router.sellSwaps(sells(2_000_000n, 2_000_000n), a, payer);
  assert.deepEqual(moved.map((s) => s.repriced), [false, false]);
  assert.equal(calls.length - before, 4);
  await router.routesLearned();

  // Repriced, then the same wallet asks for the same sale again at once (a refused submit): afresh.
  clock += PRICE_TTL_MS + 1;
  priced[TOKENS[1].mint] = 200;
  const repriced = await router.sellSwaps(sells(1_500_000n, 1_500_000n), a, payer);
  assert.deepEqual(repriced.map((s) => s.repriced), [true, true]);
  const again = await router.sellSwaps(sells(1_500_000n, 1_500_000n), a, payer);
  assert.deepEqual(again.map((s) => s.repriced), [false, false]);
  // `fresh` (simpler routes after one didn't fit) always quotes.
  await router.routesLearned();
  assert.deepEqual((await router.sellSwaps(sells(1_000_000n, 1_000_000n), payer, payer, { fresh: true })).map((s) => s.repriced), [false, false]);

  // Routes off: every sale quotes.
  const off = routerWith({ routeTtlMs: 0 });
  await off.sellSwaps(sells(1_000_000n, 1_000_000n), a, payer);
  await off.routesLearned();
  assert.deepEqual((await off.sellSwaps(sells(1_000_000n, 1_000_000n), payer, payer)).map((s) => s.repriced), [false, false]);
});

test("a token with no route back to USDC: 422 no_exit_route", async (t) => {
  jupiter(t, { noRoute: TOKENS[1].mint });
  const router = routerWith();
  await assert.rejects(router.sellSwaps(sells(1_000n, 1_000n), Keypair.generate().publicKey, Keypair.generate().publicKey),
    (e: unknown) => e instanceof ApiError && e.code === "no_exit_route");
});

/**
 * A router whose budget refuses every prebuild and route-check call (lanes 2 and 3) after the first
 * request, as on the fork when taps queue: only tap-time calls (lane 1) go through.
 */
const busyRouter = () =>
  new Router({ bank, appPayer: Keypair.generate(), jupiterApiKey: null } as any, {
    budget: new JupiterBudget({ perMinute: 6_000, burst: 1_000, reserve: 999 }, () => Date.now()),
    readMints: null,
    prices: new PriceCache(PRICE_TTL_MS, () => clock),
  });

test("as on the fork: the same wallet's second sale seconds later, at other amounts, with prebuild calls refused, reprices", async (t) => {
  clock = Date.now();
  const calls = jupiter(t);
  const router = busyRouter();
  const [wallet, payer] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  // The half: four tokens' worth of two positions, quoted afresh in the tap's lane.
  const half = newUse(1);
  await router.sellSwaps(sells(1_250_000n, 3_100_000n), wallet, payer, { use: half });
  assert.deepEqual([half.quotes, half.instructions, half.prices], [2, 2, 1], "the routes are kept with a price read in the build's own turn");
  // The rest, seconds later (the price cache has moved on): one price read, no quote.
  clock += PRICE_TTL_MS + 1;
  const rest = newUse(1);
  const out = await router.sellSwaps(sells(1_000_000n, 2_500_000n), wallet, payer, { use: rest });
  assert.deepEqual(out.map((s) => s.repriced), [true, true]);
  assert.equal(rest.calls, 1, "at most one Jupiter call");
  assert.equal(calls.length, 4);
  assert.deepEqual(amounts(out).map((r) => r.inAmount), [1_000_000n, 2_500_000n]);
});

test("a back seeds its tokens' sell routes when the budget has room, so the first sale makes no quote; never when it's short", async (t) => {
  clock = Date.now();
  const calls = jupiter(t);
  const router = routerWith();
  const [wallet, payer] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  await router.seedSells([{ mint: TOKENS[0].mint, amount: 1_000_000n }, { mint: TOKENS[1].mint, amount: 2_000_000n }], wallet);
  assert.equal(calls.length, 4, "a quote and swap instructions per token, once");
  assert.equal(calls.prices.length, 1);
  // Seeded already: another back of the same tokens doesn't quote them again.
  await router.seedSells([{ mint: TOKENS[0].mint, amount: 3_000_000n }], wallet);
  assert.equal(calls.length, 4);
  const use = newUse(1);
  const sale = await router.sellSwaps(sells(1_000_000n, 1_500_000n), wallet, payer, { use });
  assert.deepEqual(sale.map((s) => s.repriced), [true, true]);
  assert.equal(use.quotes + use.instructions, 0);
  assert.equal(router.jupiterStats().sells.seeded, 2);

  // A budget kept for trades: seeding is refused, quietly.
  const busy = busyRouter();
  await busy.sellSwaps(sells(1_000n, 1_000n), wallet, payer); // spends the spare request
  const before = calls.length;
  await busy.seedSells([{ mint: Keypair.generate().publicKey.toBase58(), amount: 1_000n }], wallet);
  assert.equal(calls.length, before, "no call made");
});
