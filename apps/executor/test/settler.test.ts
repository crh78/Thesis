import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey, SystemProgram, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import { LEG_KIND, FADE_VIA, type ExitAccount, type PositionAccount, type ProfileAccount, type TakeAccount } from "@thesis/chain";
import { underlyingIdHex } from "@thesis/venues/bank";
import { canonicalJson, sourceHash } from "../src/settler/audit.ts";
import { staticBankIndex } from "../src/settler/bank.ts";
import { boughtTokens, earnedBadges, missingLegs, pricedMask, settleReady } from "../src/settler/crank.ts";
import { AlpacaStocks, JupiterPrices } from "../src/settler/sources.ts";
import { pack, type Item } from "../src/settler/tx.ts";

test("known opening transactions isolate two trades in the same mint", async () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey.toBase58();
  const requested: string[] = [];
  const connection = {
    async getSignaturesForAddress() { throw new Error("no wallet history scan for a known opening"); },
    async getTransaction(signature: string) {
      requested.push(signature);
      const amount = signature === "second-swap" ? "250" : "100";
      return { meta: {
        preTokenBalances: [{ owner: owner.toBase58(), mint, accountIndex: 0, uiTokenAmount: { amount: "100" } }],
        postTokenBalances: [{ owner: owner.toBase58(), mint, accountIndex: 0, uiTokenAmount: { amount } }],
      } };
    },
  } as unknown as Connection;
  const bought = await boughtTokens(connection, Keypair.generate().publicKey, owner, {
    signatures: ["second-swap", "second-receipt"],
  });
  assert.deepEqual(requested, ["second-swap", "second-receipt"]);
  assert.equal(bought.get(mint), 150n);
});

test("source hash ignores key order", () => {
  const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: 10n } };
  const b = { a: { c: 10n, d: [1, { x: 1, y: 2 }] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.deepEqual(sourceHash(a), sourceHash(b));
  assert.notDeepEqual(sourceHash(a), sourceHash({ ...b, b: 2 }));
});

const leg = (kind: keyof typeof LEG_KIND) => ({ kind: LEG_KIND[kind], asset: PublicKey.default, weightBps: 2_500, leverage: 1, fadeVia: FADE_VIA.none });
const take = { legs: [leg("spot"), leg("yield"), leg("perp"), leg("prediction")] } as unknown as TakeAccount;

test("priced legs are the included ones, yield too", () => {
  assert.equal(pricedMask(take, 0b1111), 0b1111);
  assert.equal(pricedMask(take, 0b0011), 0b0011);
  assert.equal(pricedMask(take, 0b1001), 0b1001);
  const p = { legsMask: 0b1111, entrySet: 0b0001, exitSet: 0 } as unknown as PositionAccount;
  assert.deepEqual(missingLegs(take, p, "entry"), [1, 2, 3]);
  assert.deepEqual(missingLegs(take, p, "exit"), [0, 1, 2, 3]);
});

test("sold positions settle on their sale prices, before the take; the author's buy-in waits", () => {
  const author = Keypair.generate().publicKey;
  const open = { ...take, author, horizonEnd: new BN(10_000), status: { open: {} } } as unknown as TakeAccount;
  const settled = { ...open, status: { settled: {} } } as unknown as TakeAccount;
  const position = (o: Partial<Record<string, unknown>>) =>
    ({ id: new BN(1), owner: Keypair.generate().publicKey, legsMask: 0b0001, entrySet: 0b0001, exitSet: 0, ...o }) as unknown as PositionAccount;
  const exit = (priceSet: number) => ({ exitedAt: new BN(5_000), priceSet }) as unknown as ExitAccount;
  const delay = 100;

  const backer = position({});
  assert.equal(settleReady(open, backer, null, 6_000, delay), "waiting_for_take");
  assert.deepEqual(missingLegs(open, backer, "sale", exit(0)), [0]);
  assert.equal(settleReady(open, backer, exit(0), 5_050, delay), "waiting_for_prices");
  assert.equal(settleReady(open, backer, exit(0b0001), 5_050, delay), "ready");
  // The grace period runs from the sale.
  assert.equal(settleReady(open, backer, exit(0), 5_101, delay), "ready");

  const buyIn = position({ id: new BN(0), owner: author });
  assert.equal(settleReady(open, buyIn, exit(0b0001), 6_000, delay), "waiting_for_take");
  assert.equal(settleReady(settled, buyIn, exit(0b0001), 10_050, delay), "ready");
});

test("badges mirror the program's catalog", () => {
  const p = (o: Partial<ProfileAccount>) => ({ takesCreated: 0, takesOver50: 0, takesOver100: 0, takesOver1000: 0, ...o }) as ProfileAccount;
  assert.deepEqual(earnedBadges(p({})), []);
  assert.deepEqual(earnedBadges(p({ takesCreated: 1 })), ["firstTake"]);
  assert.deepEqual(earnedBadges(p({ takesCreated: 12, takesOver50: 10, takesOver100: 2, takesOver1000: 1 })), [
    "firstTake",
    "firstOver50",
    "firstOver100",
    "tenOver50",
    "over1000",
  ]);
});

test("the bank index maps on-chain ids and mints to underlyings", () => {
  const bank = staticBankIndex(["equity:US:NVDA", "commodity:XAU"], [{ mint: "M", underlyingKey: "equity:US:NVDA", underlyingPerUiToken: 1 }]);
  assert.deepEqual(bank.underlyingById(underlyingIdHex("equity:US:NVDA")), { key: "equity:US:NVDA", cls: "equity", code: "NVDA" });
  assert.deepEqual(bank.underlyingById(underlyingIdHex("commodity:XAU")), { key: "commodity:XAU", cls: "commodity", code: "XAU" });
  assert.equal(bank.token("M")?.underlyingIdHex, underlyingIdHex("equity:US:NVDA"));
  assert.equal(bank.token("other"), null);
});

test("packing fills transactions up to the size limit", () => {
  const payer = Keypair.generate().publicKey;
  const item = (i: number): Item => ({
    ix: SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: i + 1 }),
    cu: 6_500,
    label: `t${i}`,
  });
  const items = Array.from({ length: 40 }, (_, i) => item(i));
  const batches = pack(items, payer);
  assert.ok(batches.length > 1 && batches.length < 40);
  assert.deepEqual(batches.flat().map((i) => i.label), items.map((i) => i.label));
  assert.ok(pack(items.slice(0, 2), payer).length === 1);
  // A compute cap also splits.
  assert.equal(pack(items.slice(0, 3), payer, 13_000).length, 2);
});

test("Alpaca asks for the first trade at or after the moment, bounded by the delay", async () => {
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    // A synthetic response in Alpaca's shape (nanosecond timestamp).
    return new Response(JSON.stringify({ trades: [{ p: 210.25, t: "2026-12-07T17:24:36.739631075Z" }] }));
  }) as typeof fetch;
  const a = new AlpacaStocks("id", "secret", fake);
  const r = await a.firstTradeAtOrAfter("NVDA", 1_796_664_000, 1_796_664_600);
  assert.equal(r?.price, 210.25);
  assert.equal(r?.at, Math.floor(Date.parse("2026-12-07T17:24:36.739Z") / 1000));
  const q = new URL(urls[0]).searchParams;
  assert.equal(q.get("start"), new Date(1_796_664_000_000).toISOString());
  assert.equal(q.get("end"), new Date(1_796_664_600_000).toISOString());
  assert.deepEqual([q.get("limit"), q.get("sort"), q.get("feed")], ["1", "asc", "iex"]);
});

test("Jupiter prices carry liquidity and the fetch time", async () => {
  const fake = (async () =>
    new Response(JSON.stringify({ M: { usdPrice: 184.29, liquidity: 1_981_373.9, decimals: 8 } }))) as unknown as typeof fetch;
  const j = new JupiterPrices(null, fake, () => 42);
  assert.deepEqual(await j.price("M"), { mint: "M", usdPrice: 184.29, liquidityUsd: 1_981_373.9, at: 42, scaledUi: null, raw: { mint: "M", response: { usdPrice: 184.29, liquidity: 1_981_373.9, decimals: 8 } } });
  assert.equal(await j.price("missing"), null);
});

test("Jupiter prices carry the mint's ScaledUiAmount config (xStocks), in the shape Jupiter returns it", async () => {
  const cfg = { multiplier: 1.005010474242, newMultiplier: 1.0091704440395326, newMultiplierEffectiveAt: "2026-12-20T23:30:00Z", usdPricePrescaled: 39.546373222096726 };
  const fake = (async () => new Response(JSON.stringify({ X: { usdPrice: 39.187, liquidity: 113.3, decimals: 8, scaledUiConfig: cfg } }))) as unknown as typeof fetch;
  const p = await new JupiterPrices(null, fake, () => 42).price("X");
  assert.deepEqual(p?.scaledUi, { multiplier: 1.005010474242, newMultiplier: 1.0091704440395326, newMultiplierEffectiveAt: Date.parse("2026-12-20T23:30:00Z") / 1000 });
});
