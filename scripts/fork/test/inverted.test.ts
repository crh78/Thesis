// Inverted takes in the fork API: a take that bets against its basket ("crypto sucks" over coin
// perps). Its author's buy-in is an on-chain fade, and so is agreeing with it. The API's sides are
// take-relative ("back" agrees, "fade" disagrees) both ways: trades and sales turn them into the
// on-chain side, and receipts, positions and incomplete trades answer in them.
import assert from "node:assert/strict";
import { test } from "node:test";
import BN from "bn.js";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import idl from "@thesis/chain/idl/thesis.json" with { type: "json" };
import { positionAddress } from "@thesis/chain";
import type { GeminiContract } from "@thesis/venues/gemini";
import { emptyState } from "../../../packages/venues/bank/src/state.ts";
import { ApiError, FADE_OWN_TAKE, INVERTED_NOT_FADEABLE, type AppTake, type IncompleteTrade } from "../api/common.ts";
import { invertible, mapLegs, sameLegs } from "../api/legs.ts";
import { ForkService } from "../api/service.ts";
import { incompleteView } from "../api/split.ts";
import { TAKE_ID, tradeFixture, type Status } from "./trade-fixture.ts";

const confirmed: Status = { err: null, confirmationStatus: "confirmed" };
const apiError = (status: number, code: string) => (e: unknown) => e instanceof ApiError && e.status === status && e.code === code;

const CONTRACT: GeminiContract = {
  instrumentSymbol: "GEMI-BTC100K", eventTicker: "BTC100K", eventTitle: "Bitcoin above $100k", label: "Above $100k", category: "Crypto",
  status: "active", expiry: "2027-06-30T00:00:00Z", resolutionSide: null, resolvedAt: null,
  ask: { yes: 0.4, no: 0.62 }, bid: { yes: 0.38, no: 0.6 },
};
const geminiBank = () => {
  const bank = emptyState();
  bank.venues.gemini = { at: bank.createdAt, summary: {} as never, contracts: { [CONTRACT.instrumentSymbol]: CONTRACT } };
  return bank;
};
/** "Bitcoin won't hit $100k", inverted over a Yes leg on it: agreeing holds No. */
const predictionTake: Partial<AppTake> = {
  claim: "Bitcoin won't hit $100k",
  inverted: true,
  legs: [{ name: "Bitcoin above $100k", kind: "Prediction · Yes", weight: 100, fade_how: "No", asset_id: `gemini:${CONTRACT.instrumentSymbol}` }],
};

/** The Thesis instructions in a built transaction, by IDL name. */
function thesisIxs(b64: string): string[] {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions
    .filter((ix) => keys[ix.programIdIndex]?.toBase58() === idl.address)
    .map((ix) => idl.instructions.find((i) => Buffer.from(i.discriminator).equals(Buffer.from(ix.data.subarray(0, 8))))?.name ?? "?");
}

/** A card position (escrowed, no Jupiter) of `stake` dollars on `side` (on-chain). */
async function position(f: Awaited<ReturnType<typeof tradeFixture>>, id: number, side: "back" | "fade", stake = 20, owner = f.owner.publicKey) {
  const address = positionAddress(f.take, owner, BigInt(id));
  const units = (usd: number) => new BN(Math.round(usd * 1e6));
  f.accounts.set(address.toBase58(), await f.program.coder.accounts.encode("position", {
    owner, take: f.take, id: new BN(id), rentPayer: f.appPayer.publicKey, side: { [side]: {} }, stake: units(stake),
    openedAt: new BN(Math.floor(Date.now() / 1000) - 3_600), legsMask: 1, prices: [{ entry: new BN(100_000_000), exit: new BN(0) }],
    entrySet: 1, exitSet: 0, scored: true, exited: false, escrowed: units(stake), bump: 255,
    remaining: units(stake), parts: 0, partsSettled: 0, realizedPnl: units(0),
  }));
  f.scanned.push(address);
  return address;
}

test("the receipt of an inverted take is take-relative: agreeing is its on-chain fade", async (t) => {
  // A card leg can't be faded, so agreeing with an inverted take over one can't trade it, while
  // disagreeing (an on-chain back) can. (The program wouldn't post this take: it shows the flip.)
  const f = await tradeFixture(t, {
    app: { inverted: true },
    takeFields: { backers: 2, faders: 5, totalBacked: new BN(40_000_000), totalFaded: new BN(100_000_000) },
  });
  const agree = await position(f, 1, "fade");
  const disagree = await position(f, 2, "back");
  // A service started after the positions exist (the fixture's has scanned the take already).
  const service = new ForkService(f.options);
  const r = await service.receipt(TAKE_ID, f.wallet, { routes: false });
  assert.ok(r.onChain);
  assert.equal(r.inverted, true);
  assert.equal(r.backers, 5, "backers agree: the on-chain faders");
  assert.equal(r.faders, 2);
  assert.equal(r.totalBackedUsd, 100);
  assert.equal(r.totalFadedUsd, 40);
  assert.equal(r.canBack, false, "agreeing would fade a card leg");
  assert.equal(r.canFade, true, "disagreeing buys it");
  assert.equal(r.fadeBlocked, null);
  assert.equal(r.legs[0].tradable, false);
  assert.match(r.legs[0].blocked ?? "", /./);
  assert.equal(r.legs[0].fadeBlocked, null);
  const side = (a: PublicKey) => r.viewerPositions.find((p) => p.address === a.toBase58())?.side;
  assert.equal(side(agree), "back");
  assert.equal(side(disagree), "fade");

  // Its author can't disagree with it, whatever that is on-chain.
  const asAuthor = await service.receipt(TAKE_ID, f.author.publicKey.toBase58(), { routes: false });
  assert.ok(asAuthor.onChain);
  assert.equal(asAuthor.canFade, false);
  assert.equal(asAuthor.fadeBlocked, FADE_OWN_TAKE);
});

test("a take that isn't inverted reads as before", async (t) => {
  const f = await tradeFixture(t, { takeFields: { backers: 2, faders: 5 } });
  await position(f, 1, "back");
  const r = await new ForkService(f.options).receipt(TAKE_ID, f.wallet, { routes: false });
  assert.ok(r.onChain);
  assert.equal(r.inverted, false);
  assert.equal(r.backers, 2);
  assert.equal(r.faders, 5);
  assert.equal(r.canBack, true);
  assert.equal(r.canFade, false, "a card leg can't be faded");
  assert.equal(r.viewerPositions[0].side, "back");
});

test("trades on an inverted take: back (agree) is an on-chain fade, fade (disagree) an on-chain back", async (t) => {
  const f = await tradeFixture(t, { app: predictionTake, bank: geminiBank });
  const r = await f.service.receipt(TAKE_ID, f.wallet, { routes: false });
  assert.ok(r.onChain);
  assert.equal(r.legs[0].prediction?.side, "no", "agreeing holds the Yes leg's other side");

  const agree = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 10);
  assert.equal(agree.side, "back");
  assert.ok(thesisIxs(agree.transactions.at(-1)!).includes("fade"), "agreeing fades on-chain");
  assert.ok(!thesisIxs(agree.transactions.at(-1)!).includes("back"));

  const disagree = await f.service.buildTrade(TAKE_ID, f.wallet, "fade", 10);
  assert.equal(disagree.side, "fade");
  assert.ok(thesisIxs(disagree.transactions.at(-1)!).includes("back"), "disagreeing backs on-chain");

  // The author adds to their own side (an on-chain fade), and can't take the other one.
  const author = f.author.publicKey.toBase58();
  const more = await f.service.buildTrade(TAKE_ID, author, "back", 10);
  assert.ok(thesisIxs(more.transactions.at(-1)!).includes("fade"));
  await assert.rejects(f.service.buildTrade(TAKE_ID, author, "fade", 10), apiError(409, "cannot_fade_own_take"));
});

test("a take that isn't inverted trades as before", async (t) => {
  const f = await tradeFixture(t, { app: { ...predictionTake, inverted: false }, bank: geminiBank });
  const r = await f.service.receipt(TAKE_ID, f.wallet, { routes: false });
  assert.ok(r.onChain);
  assert.equal(r.legs[0].prediction?.side, "yes");
  assert.ok(thesisIxs((await f.service.buildTrade(TAKE_ID, f.wallet, "back", 10)).transactions.at(-1)!).includes("back"));
  assert.ok(thesisIxs((await f.service.buildTrade(TAKE_ID, f.wallet, "fade", 10)).transactions.at(-1)!).includes("fade"));
  await assert.rejects(f.service.buildTrade(TAKE_ID, f.author.publicKey.toBase58(), "fade", 10), apiError(409, "cannot_fade_own_take"));
});

test("publishing an inverted take: the author's buy-in is create_take with inverted, on the fade's legs", async (t) => {
  const f = await tradeFixture(t, {
    app: { ...predictionTake, status: "posting" },
    bank: geminiBank,
    onChain: false,
  });
  const author = f.author.publicKey.toBase58();
  // Before it's on-chain the app take says which side agrees.
  const before = await f.service.receipt(TAKE_ID, author, { routes: false });
  assert.equal(before.onChain, false);
  assert.equal(before.inverted, true);
  assert.equal(before.legs[0].prediction?.side, "no");

  const built = await f.service.buildPublish(TAKE_ID, author, 20);
  assert.equal(built.inverted, true);
  const last = VersionedTransaction.deserialize(Buffer.from(built.transactions.at(-1)!, "base64"));
  const keys = last.message.staticAccountKeys;
  const create = last.message.compiledInstructions.find((ix) => keys[ix.programIdIndex]?.toBase58() === idl.address &&
    Buffer.from(ix.data.subarray(0, 8)).equals(Buffer.from(idl.instructions.find((i) => i.name === "create_take")!.discriminator)));
  assert.ok(create, "create_take is the receipt");
  const coder = f.program.coder.instruction as unknown as { decode(data: Buffer): { data: { args: { inverted: boolean; legsMask?: number; legs_mask?: number } } } };
  const decoded = coder.decode(Buffer.from(create.data));
  assert.equal(decoded.data.args.inverted, true);
  assert.equal(decoded.data.args.legsMask ?? decoded.data.args.legs_mask, 1, "the fade's leg (the prediction's No) is bought");
});

test("an inverted take's buy-in routes as a fade: with no No market, nothing is left to buy", async (t) => {
  const noBook = () => {
    const bank = geminiBank();
    bank.venues.gemini!.contracts![CONTRACT.instrumentSymbol] = { ...CONTRACT, ask: { yes: 0.4, no: null }, bid: { yes: 0.38, no: null } } as unknown as GeminiContract;
    return bank;
  };
  const f = await tradeFixture(t, { app: { ...predictionTake, status: "posting" }, bank: noBook, onChain: false });
  await assert.rejects(f.service.buildPublish(TAKE_ID, f.author.publicKey.toBase58(), 20), apiError(409, "fade_unavailable"));
  // The same take, not inverted, buys the Yes it can.
  const plain = await tradeFixture(t, { app: { ...predictionTake, inverted: false, status: "posting" }, bank: noBook, onChain: false });
  assert.equal((await plain.service.buildPublish(TAKE_ID, plain.author.publicKey.toBase58(), 20)).inverted, false);
});

test("an inverted take whose legs can't all be faded isn't published", async (t) => {
  const f = await tradeFixture(t, { app: { status: "posting", inverted: true }, onChain: false });
  await assert.rejects(f.service.buildPublish(TAKE_ID, f.author.publicKey.toBase58(), 20), (e: unknown) =>
    e instanceof ApiError && e.status === 422 && e.code === "not_fadeable" && e.message === INVERTED_NOT_FADEABLE);
  assert.equal(invertible(mapLegs([{ name: "Charizard PSA 10", kind: "Card", weight: 100, fade_how: null, asset_id: "card:2026120156C116510" }])), false);
});

test("selling a holding on an inverted take: back sells the on-chain fades", async (t) => {
  const f = await tradeFixture(t, { app: { inverted: true }, status: () => confirmed });
  const agree = await position(f, 1, "fade");
  const service = new ForkService(f.options);
  await assert.rejects(service.buildHoldingSale(TAKE_ID, f.wallet, "fade"), apiError(404, "position_missing"));
  const built = await service.buildHoldingSale(TAKE_ID, f.wallet, "back");
  assert.deepEqual(built.positions, [agree.toBase58()]);
});

test("the Blink doesn't back an inverted take (that would disagree with it)", async (t) => {
  const f = await tradeFixture(t, { app: { inverted: true } });
  assert.equal((await f.service.blinkTake(TAKE_ID)).canBack, false);
  await assert.rejects(f.service.prepareBlinkBack(TAKE_ID, f.owner.publicKey, 10, 3), apiError(409, "open_in_app"));
  const plain = await tradeFixture(t);
  assert.equal((await plain.service.blinkTake(TAKE_ID)).canBack, true);
});

test("an incomplete trade's side is take-relative; a mirror that changed direction isn't the same take", () => {
  const rec = { take: "t", takeId: "i", side: "fade", usd: 10, next: "retry", signatures: [], at: 0 } as unknown as IncompleteTrade;
  assert.equal(incompleteView("p", rec).side, "fade");
  assert.equal(incompleteView("p", { ...rec, inverted: true }).side, "back");
  assert.equal(incompleteView("p", { ...rec, side: "back", inverted: true }).side, "fade");

  const legs = mapLegs([{ name: "Charizard PSA 10", kind: "Card", weight: 100, fade_how: null, asset_id: "card:2026120156C116510" }]);
  const onChain = legs.map((l) => l.spec);
  assert.ok(sameLegs(onChain, legs));
  assert.ok(sameLegs(onChain, legs, { onChain: true, app: true }));
  assert.equal(sameLegs(onChain, legs, { onChain: false, app: true }), false);
  assert.equal(sameLegs(onChain, legs, { onChain: true, app: false }), false);
});
