import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { underlyingIdHex } from "@thesis/venues/bank";
import type { TraderView } from "@thesis/venues/phoenix";
import { pricePhoenixLeg, type PhoenixLegInput } from "../src/settler/phoenix-legs.ts";
import { heldOnPhoenix, provedToken } from "../src/settler/proof.ts";

const NVDA = underlyingIdHex("equity:US:NVDA");
const BOOK = new PublicKey("AzySnZQCNjkQMtm5ZDd2FjKYTjBoNb5Bv5Dsm3WyRkbj");
const order = (side: "long" | "short", baseLots = 250n) => ({ trader: PublicKey.default, orderbook: BOOK, side, baseLots });
const rules = { minLiquidityUsd: 0, liveWindowSecs: 300, maxDelaySecs: 3_600, minReceivedRatio: 0.9 };
const trader = (baseLots: bigint): TraderView => ({ authority: PublicKey.default, collateral: 19_970_000n, pdaIndex: 0, subaccountIndex: 1, positions: baseLots ? [{ assetId: 39, baseLots, virtualQuoteLots: -baseLots * 160_000n }] : [] });

function input(over: Partial<PhoenixLegInput> & { base?: bigint } = {}): PhoenixLegInput {
  const base = over.base ?? 250n; // 0.250 NVDA ≈ $40 at $160: a $20 leg at 2x
  const side = base < 0n ? "short" : "long";
  return {
    index: 1,
    moment: "entry",
    momentSec: 1_000_000,
    nowSec: 1_000_120,
    rules,
    side: "back",
    leg: { assetIdHex: NVDA, leverage: 2 },
    out: { account: "child", received: base < 0n ? -base : base, mint: null, uiPerUnit: null, phoenix: true, orders: [order(side)] },
    basis: null,
    entryPrice: null,
    legStakeUsd: 20,
    reader: {
      trader: async () => trader(base),
      marketByOrderbook: async (book: string) => (book === BOOK.toBase58() ? { symbol: "NVDA", baseLotsDecimals: 3 } : null),
    },
    marks: { markAtOrAfter: async (_s, at) => ({ price: 160, at: at + 60 }) },
    perp: (s) => (s === "NVDA" ? { underlyingKey: "equity:US:NVDA", unitsPerContract: 1 } : null),
    ...over,
  };
}

test("a back's perp leg and a fade's shorts are held on Phoenix", () => {
  assert.equal(heldOnPhoenix("perp", "back"), true);
  assert.equal(heldOnPhoenix("spot", "back"), false);
  assert.equal(heldOnPhoenix("spot", "fade"), true);
  assert.equal(heldOnPhoenix("prediction", "fade"), false);
  // provedToken lets them through to the Phoenix check, with no token.
  assert.deepEqual(provedToken({ kind: "perp", assetIdHex: NVDA }, "back", null, 1, {} as never), { ok: true, token: null });
});

test("entry: an honest 2x long is priced on Phoenix's mark at or after the trade", async () => {
  const out = await pricePhoenixLeg(input());
  assert.ok(out.ok);
  assert.equal(out.quote.price, 160);
  assert.equal(out.quote.publishedAt, 1_000_060);
  assert.equal(out.quote.rule, "phoenix-mark");
  assert.deepEqual(out.quote.basis, { source: "phoenix", symbol: "NVDA", unitsPerContract: 1 });
});

test("entry: wrong market, wrong side, too small, or no Phoenix proof stays unpriced", async () => {
  const wrongAsset = await pricePhoenixLeg(input({ leg: { assetIdHex: underlyingIdHex("equity:US:TSLA"), leverage: 2 } }));
  assert.ok(!wrongAsset.ok && !wrongAsset.retry && /not this leg's asset/.test(wrongAsset.reason));
  const short = await pricePhoenixLeg(input({ base: -250n }));
  assert.ok(!short.ok && /a back needs a long/.test(short.reason));
  const long = await pricePhoenixLeg(input({ side: "fade" }));
  assert.ok(!long.ok && /a fade needs a short/.test(long.reason));
  const noOrder = await pricePhoenixLeg(input({ out: { account: "child", received: 250n, mint: null, uiPerUnit: null, phoenix: true, orders: [] } }));
  assert.ok(!noOrder.ok && /no Phoenix market order/.test(noOrder.reason));
  const mixed = await pricePhoenixLeg(input({ out: { account: "child", received: 250n, mint: null, uiPerUnit: null, phoenix: true, orders: [order("long"), order("short")] } }));
  assert.ok(!mixed.ok && /disagree/.test(mixed.reason));
  const small = await pricePhoenixLeg(input({ base: 100n })); // $16 for a $40 leg
  assert.ok(!small.ok && !small.retry && /under 90%/.test(small.reason));
  const token = await pricePhoenixLeg(input({ out: { account: "ata", received: 5n, mint: "M", uiPerUnit: 1e-6 } }));
  assert.ok(!token.ok && /no Phoenix position/.test(token.reason));
  const fade = await pricePhoenixLeg(input({ side: "fade", base: -250n }));
  assert.ok(fade.ok, "a 2x short of the same size is fine for a fade");
});

test("entry: a position sold before the settler ran is still priced from the trade's order", async () => {
  // The account is empty now (sold), but the receipt's trade placed a 2x long in NVDA.
  const sold = await pricePhoenixLeg(input({ reader: { trader: async () => trader(0n), marketByOrderbook: async () => ({ symbol: "NVDA", baseLotsDecimals: 3 }) } }));
  assert.ok(sold.ok, !sold.ok ? sold.reason : "");
  assert.equal(sold.quote.price, 160);
});

test("entry: waits for the first bar, then gives up past the deadline", async () => {
  const none = await pricePhoenixLeg(input({ marks: { markAtOrAfter: async () => null } }));
  assert.ok(!none.ok && none.retry);
  const late = await pricePhoenixLeg(input({ nowSec: 1_000_000 + 3_601 }));
  assert.ok(!late.ok && !late.retry && /deadline/.test(late.reason));
});

test("exit: the mark on the entry's market; a vanished position scores −100%", async () => {
  const basis = { source: "phoenix" as const, symbol: "NVDA", unitsPerContract: 1 };
  const exit = await pricePhoenixLeg(input({ moment: "exit", basis, entryPrice: 160, marks: { markAtOrAfter: async (_s, at) => ({ price: 176, at }) } }));
  assert.ok(exit.ok && exit.quote.price === 176 && exit.quote.rule === "phoenix-mark");
  const gone = await pricePhoenixLeg(input({ moment: "exit", basis, entryPrice: 160, base: 0n }));
  assert.ok(gone.ok);
  assert.equal(gone.quote.rule, "phoenix-liquidated");
  assert.equal(gone.quote.price, 80); // 2x back: −50% × 2 = −100%
  const goneFade = await pricePhoenixLeg(input({ moment: "exit", side: "fade", leg: { assetIdHex: NVDA, leverage: 1 }, basis, entryPrice: 160, base: 0n }));
  assert.ok(goneFade.ok && goneFade.quote.price === 320); // 1x short: +100% move = −100%
  // A sale closed the position itself: priced on the mark, never as a liquidation.
  const sale = await pricePhoenixLeg(input({ moment: "sale", basis, entryPrice: 160, base: 0n }));
  assert.ok(sale.ok && sale.quote.rule === "phoenix-mark");
});
