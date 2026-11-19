// Partial sales in the fork API: the sizing arithmetic (api/sales.ts), and sale builds of a card
// position (escrowed, so no Jupiter call) over the mocked fork: a part, the minimum-stake refusal,
// dollar amounts, the cap on open parts, a holding sold across two positions, and the receipt's
// new fields.
import assert from "node:assert/strict";
import { test } from "node:test";
import BN from "bn.js";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import idl from "@thesis/chain/idl/thesis.json" with { type: "json" };
import { partSaleAddress, positionAddress } from "@thesis/chain";
import { ApiError } from "../api/common.ts";
import { ForkService } from "../api/service.ts";
import {
  escrowReturned,
  holdingMaxPartialBps,
  partLots,
  planHoldingSale,
  positionSale,
  remainderError,
  saleBps,
  tokensToSell,
} from "../api/sales.ts";
import { TAKE_ID, tradeFixture, type Status } from "./trade-fixture.ts";

const USD = 1_000_000n;
const MIN = 10n * USD;
const apiError = (status: number, code: string) => (e: unknown) => e instanceof ApiError && e.status === status && e.code === code;
const confirmed: Status = { err: null, confirmationStatus: "confirmed" };

test("a sale's size: bps as given, usd from the value (all of it within 0.5%), neither = all", () => {
  assert.equal(saleBps({}, 0), 10_000);
  assert.equal(saleBps({ bps: 2_500 }, 0), 2_500);
  assert.equal(saleBps({ usd: 10 }, 40), 2_500);
  assert.equal(saleBps({ usd: 39.9 }, 40), 10_000);
  assert.equal(saleBps({ usd: 39.7 }, 40), 9_925);
  assert.equal(saleBps({ usd: 0.0001 }, 40), 1);
  assert.equal(saleBps({ usd: 100 }, 40), 10_000);
  for (const bad of [{ bps: 0 }, { bps: 10_001 }, { bps: 2.5 }, { bps: "50" }, { usd: 0 }, { usd: -1 }, { bps: 100, usd: 1 }]) {
    assert.throws(() => saleBps(bad, 40), apiError(400, "invalid_amount"), JSON.stringify(bad));
  }
});

test("each sale sells its share of the tokens bought, and the parts add up to exactly what was bought", () => {
  const bought = 1_234_567n;
  const stake = 40n * USD;
  // $40 → $30 → $24 → all.
  const steps = [stake, 30n * USD, 24n * USD, 0n];
  let sold = 0n;
  for (let i = 1; i < steps.length; i++) sold += tokensToSell(bought, stake, steps[i - 1], steps[i]);
  assert.equal(sold, bought);
  assert.equal(tokensToSell(bought, stake, stake, 0n), bought, "selling all at once sells all of it");
  assert.equal(tokensToSell(bought, stake, stake, 30n * USD), bought - (bought * 3n) / 4n);
  assert.equal(partLots(-1_000n, 2_500), -250n, "a short's lots stay negative");
  assert.equal(partLots(3n, 2_500), 0n);
  assert.equal(escrowReturned(15n * USD + 1n, 3_333), ((15n * USD + 1n) * 3_333n) / 10_000n);
  assert.equal(escrowReturned(15n * USD + 1n, 10_000), 15n * USD + 1n);
});

test("one position: what's left keeps the minimum, at most 8 parts open, all is always allowed", () => {
  const p = (usd: bigint, openParts = 0) => ({ remaining: usd * USD, openParts });
  assert.deepEqual(positionSale(p(40n), 2_500, MIN), { ok: true, full: false, sold: 10n * USD, left: 30n * USD });
  assert.deepEqual(positionSale(p(10n), 10_000, MIN), { ok: true, full: true, sold: 10n * USD, left: 0n });
  assert.deepEqual(positionSale(p(15n), 5_000, MIN), { ok: false, code: "remainder_below_minimum" });
  assert.deepEqual(positionSale(p(40n, 8), 2_500, MIN), { ok: false, code: "too_many_open_sales" });
  assert.deepEqual(positionSale({ remaining: 1n, openParts: 0 }, 1, 0n), { ok: false, code: "part_too_small" });
  const e = remainderError(3_333, 15, 10);
  assert.equal(e.status, 422);
  assert.deepEqual(e.body, { maxPartialBps: 3_333, maxPartialUsd: 4.9995, minStakeUsd: 10 });
});

test("a holding sells whole positions first, smallest first, then at most one part", () => {
  const held = [
    { address: "big", remaining: 40n * USD, openParts: 0 },
    { address: "small", remaining: 12n * USD, openParts: 0 },
  ];
  // Half of $52 is $26: the $12 position whole, then $14 of the $40 one (3,500 bps).
  assert.deepEqual(planHoldingSale(held, 5_000, MIN), { whole: ["small"], part: { address: "big", bps: 3_500 }, sold: 26n * USD });
  assert.deepEqual(planHoldingSale(held, 10_000, MIN), { whole: ["small", "big"], part: null, sold: 52n * USD });
  // A quarter is $13: the $12 whole, then $1 of the $40.
  assert.deepEqual(planHoldingSale(held, 2_500, MIN), { whole: ["small"], part: { address: "big", bps: 250 }, sold: 13n * USD });
  // 90% is $46.80: $12 whole leaves $34.80 of $40, which would leave $5.20.
  assert.deepEqual(planHoldingSale(held, 9_000, MIN), { error: "remainder_below_minimum" });
  assert.equal(holdingMaxPartialBps(held, MIN), 8_077);
  assert.equal(holdingMaxPartialBps([{ address: "x", remaining: 10n * USD, openParts: 0 }], MIN), null);
});

/** A card position of `stake` dollars (all of it escrowed) for the fixture's wallet. */
async function cardPosition(f: Awaited<ReturnType<typeof tradeFixture>>, id: number, stake: number, o: { remaining?: number; parts?: number; partsSettled?: number; realizedPnl?: number; owner?: PublicKey } = {}) {
  const owner = o.owner ?? f.owner.publicKey;
  const address = positionAddress(f.take, owner, BigInt(id));
  const units = (usd: number) => new BN(Math.round(usd * 1e6));
  f.accounts.set(address.toBase58(), await f.program.coder.accounts.encode("position", {
    owner, take: f.take, id: new BN(id), rentPayer: f.appPayer.publicKey, side: { back: {} }, stake: units(stake),
    openedAt: new BN(Math.floor(Date.now() / 1000) - 3_600), legsMask: 1, prices: [{ entry: new BN(100_000_000), exit: new BN(0) }],
    entrySet: 1, exitSet: 0, scored: true, exited: false, escrowed: units(o.remaining ?? stake), bump: 255,
    remaining: units(o.remaining ?? stake), parts: o.parts ?? 0, partsSettled: o.partsSettled ?? 0, realizedPnl: units(o.realizedPnl ?? 0),
  }));
  f.scanned.push(address);
  return address;
}

const discriminator = (name: string) => Buffer.from(idl.instructions.find((i) => i.name === name)!.discriminator);
function instructionsIn(b64: string): Buffer[] {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  return tx.message.compiledInstructions.map((ix) => Buffer.from(ix.data.subarray(0, 8)));
}

test("a partial sale of a position: sell_part for 25%, a quarter of the escrow back, nothing closes", async (t) => {
  const f = await tradeFixture(t, { status: () => confirmed });
  const position = await cardPosition(f, 1, 40);
  const built = await f.service.buildExit(TAKE_ID, position.toBase58(), f.wallet, { bps: 2_500 });
  assert.equal(built.bps, 2_500);
  assert.equal(built.full, false);
  assert.equal(built.closesTake, false);
  assert.equal(built.phoenixCashOut, false);
  assert.equal(built.escrowUsd, 10);
  assert.deepEqual({ stake: built.sale.stakeUsd, left: built.sale.remainingStakeUsd }, { stake: 10, left: 30 });
  assert.equal(built.sale.valueUsd, 10);
  assert.equal(built.sale.remainingValueUsd, 30);
  const ixs = built.transactions.flatMap(instructionsIn);
  assert.ok(ixs.some((d) => d.equals(discriminator("sell_part"))));
  assert.ok(!ixs.some((d) => d.equals(discriminator("exit_position"))));

  // A dollar amount converts from what it's worth now ($40 of escrow at cost): $10 is 25%.
  const byUsd = await f.service.buildExit(TAKE_ID, position.toBase58(), f.wallet, { usd: 10 });
  assert.equal(byUsd.bps, 2_500);

  // Neither: all of it, with exit_position.
  const all = await f.service.buildExit(TAKE_ID, position.toBase58(), f.wallet);
  assert.equal(all.bps, 10_000);
  assert.equal(all.full, true);
  assert.ok(all.transactions.flatMap(instructionsIn).some((d) => d.equals(discriminator("exit_position"))));

  // Submitting the part after another part landed: the PDA moved on, build again.
  await cardPosition(f, 1, 40, { remaining: 30, parts: 1 });
  await assert.rejects(f.service.submit(built.buildId, f.sign(built)), apiError(409, "build_stale"));
});

test("partial sales the program would refuse are refused at the build, with what can be sold", async (t) => {
  const f = await tradeFixture(t, { status: () => confirmed });
  const fifteen = await cardPosition(f, 1, 15);
  await assert.rejects(f.service.buildExit(TAKE_ID, fifteen.toBase58(), f.wallet, { bps: 5_000 }), (e: unknown) =>
    apiError(422, "remainder_below_minimum")(e) && JSON.stringify((e as ApiError).body) === JSON.stringify({ maxPartialBps: 3_333, maxPartialUsd: 4.9995, minStakeUsd: 10 }));
  const ten = await cardPosition(f, 2, 10);
  await assert.rejects(f.service.buildExit(TAKE_ID, ten.toBase58(), f.wallet, { bps: 100 }), (e: unknown) =>
    apiError(422, "remainder_below_minimum")(e) && (e as ApiError).body?.maxPartialBps === null);
  const busy = await cardPosition(f, 3, 400, { parts: 8 });
  await assert.rejects(f.service.buildExit(TAKE_ID, busy.toBase58(), f.wallet, { bps: 1_000 }), apiError(409, "too_many_open_sales"));
  // Selling all is still fine.
  assert.equal((await f.service.buildExit(TAKE_ID, busy.toBase58(), f.wallet)).full, true);
  await assert.rejects(f.service.buildExit(TAKE_ID, fifteen.toBase58(), f.wallet, { bps: 5_000, usd: 5 }), apiError(400, "invalid_amount"));
});

test("a holding's sale: the smaller position whole and part of the bigger one, in one build", async (t) => {
  const f = await tradeFixture(t, { status: () => confirmed });
  const big = await cardPosition(f, 1, 40);
  const small = await cardPosition(f, 2, 12);
  // Someone else's position on the same take isn't touched.
  await cardPosition(f, 3, 50, { owner: Keypair.generate().publicKey });
  // A service started now: its first scan of the take finds these positions.
  const service = new ForkService(f.options);
  const built = await service.buildHoldingSale(TAKE_ID, f.wallet, "back", { bps: 5_000 });
  assert.deepEqual(built.positions, [small.toBase58(), big.toBase58()]);
  assert.equal(built.bps, 5_000);
  assert.equal(built.full, false);
  assert.deepEqual({ stake: built.sale.stakeUsd, left: built.sale.remainingStakeUsd }, { stake: 26, left: 26 });
  assert.equal(built.escrowUsd, 26);
  const ixs = built.transactions.flatMap(instructionsIn);
  assert.ok(ixs.some((d) => d.equals(discriminator("exit_position"))), "the small one sold whole");
  assert.ok(ixs.some((d) => d.equals(discriminator("sell_part"))), "and part of the big one");
  await assert.rejects(service.buildHoldingSale(TAKE_ID, f.wallet, "fade", {}), apiError(404, "position_missing"));
  await assert.rejects(service.buildHoldingSale(TAKE_ID, f.wallet, "back", { bps: 9_000 }), (e: unknown) =>
    apiError(422, "remainder_below_minimum")(e) && (e as ApiError).body?.maxPartialBps === 8_077);
  const all = await service.buildHoldingSale(TAKE_ID, f.wallet, "back", { bps: 10_000 });
  assert.equal(all.full, true);
  assert.deepEqual(all.positions, [small.toBase58(), big.toBase58()]);
});

test("the receipt shows what's left, what's sold, partial sales settling and how much can be sold", async (t) => {
  const f = await tradeFixture(t, { status: () => confirmed });
  const position = await cardPosition(f, 1, 40, { remaining: 24, parts: 2, partsSettled: 1, realizedPnl: 1.5 });
  const part = partSaleAddress(position, 1);
  f.accounts.set(part.toBase58(), await f.program.coder.accounts.encode("partSale", {
    position, seq: 1, bps: 2_000, stake: new BN(6_000_000), escrowReturned: new BN(6_000_000), soldAt: new BN(1_800_000_000),
    rentPayer: f.appPayer.publicKey, priceSet: 1, prices: [new BN(110_000_000)], bump: 255,
  }));
  const r = await new ForkService(f.options).receipt(TAKE_ID, f.wallet, { routes: false });
  assert.ok(r.onChain);
  const p = (r as { viewerPositions: Record<string, unknown>[] }).viewerPositions.find((x) => x.address === position.toBase58())!;
  assert.equal(p.stakeUsd, 40, "the original stake, unscaled");
  assert.equal(p.costUsd, 40.04, "and what it first cost");
  assert.equal(p.remainingStakeUsd, 24);
  assert.equal(p.soldStakeUsd, 16);
  assert.equal(p.realizedPnlUsd, 1.5);
  assert.deepEqual(p.pendingSales, [{ seq: 1, bps: 2_000, stakeUsd: 6, soldAt: 1_800_000_000, priced: true }]);
  assert.equal(p.valueUsd, 24, "what's left: its escrow at cost");
  assert.equal(p.minStakeUsd, 10);
  assert.equal(p.maxPartialBps, 5_833);
  assert.equal(p.closesTakeIfSoldAll, false);
});
