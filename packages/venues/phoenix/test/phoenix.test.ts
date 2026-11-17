import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  decodeMarketOrder,
  decodeTrader,
  forkOnboardingPermission,
  orderSize,
  permissionAddress,
  permissionDelegate,
  PhoenixVenue,
  positionSize,
  TRADER_DISCRIMINATOR,
  traderAddress,
} from "../src/index.ts";

/** A trader account's bytes as the Thesis program reads them (proof.rs) and Phoenix writes them. */
function trader(o: { authority: PublicKey; collateral: bigint; sub: number; positions: [number, bigint, bigint][]; capacity?: number }): Buffer {
  const cap = o.capacity ?? Math.max(1, o.positions.length);
  const b = Buffer.alloc(240 + 40 * cap);
  TRADER_DISCRIMINATOR.copy(b, 0);
  o.authority.toBuffer().copy(b, 56);
  b.writeBigInt64LE(o.collateral, 88);
  b[154] = 0;
  b[155] = o.sub;
  b.writeBigUInt64LE(BigInt(o.positions.length), 224);
  b.writeBigUInt64LE(BigInt(cap), 232);
  o.positions.forEach(([asset, base, quote], i) => {
    const at = 240 + 40 * i;
    b.writeBigUInt64LE(BigInt(asset), at);
    b.writeBigInt64LE(base, at + 8);
    b.writeBigInt64LE(quote, at + 16);
  });
  return b;
}

test("decodes a child with one position, as the program counts it", () => {
  const owner = Keypair.generate().publicKey;
  const t = decodeTrader(trader({ authority: owner, collateral: 19_978_996n, sub: 3, positions: [[39, 371n, -60_009_250n]] }))!;
  assert.ok(t.authority.equals(owner));
  assert.equal(t.collateral, 19_978_996n);
  assert.equal(t.subaccountIndex, 3);
  assert.deepEqual(t.positions, [{ assetId: 39, baseLots: 371n, virtualQuoteLots: -60_009_250n }]);
  assert.equal(positionSize(t), 371n);
});

test("shorts count as size; spot collateral entries and closed positions don't", () => {
  const owner = Keypair.generate().publicKey;
  const t = decodeTrader(trader({ authority: owner, collateral: 0n, sub: 1, positions: [[0, -26n, 1_994_000n], [0xffff_0000, 5n, 0n], [7, 0n, 0n]] }))!;
  assert.equal(t.positions.length, 1);
  assert.equal(positionSize(t), 26n);
});

test("anything that isn't a trader account decodes to null", () => {
  const b = trader({ authority: PublicKey.default, collateral: 0n, sub: 1, positions: [] });
  b[0] ^= 0xff;
  assert.equal(decodeTrader(b), null);
  assert.equal(decodeTrader(Buffer.alloc(100)), null);
});

test("a stated length past the account's end reads only what fits", () => {
  const b = trader({ authority: PublicKey.default, collateral: 0n, sub: 1, positions: [[1, 10n, 0n]] });
  b.writeBigUInt64LE(1_000n, 224);
  assert.equal(positionSize(decodeTrader(b)!), 10n);
});

test("trader and permission addresses use Phoenix's seeds", () => {
  // From the fork: register built for this throwaway authority returned this PDA.
  const authority = new PublicKey("3n9sqoWzic1t4d2GQp4w5Z5DhpshVFY9AfiSPstU3DgD");
  assert.equal(traderAddress(authority, 0).toBase58(), "7WQY3fbu6wUwEeCeo794bisJQwRyPyrkWLMnUPQnQGAF");
  // Phoenix's own onboarding permission (risk authority 8wTc… → onboarder EzkM8…).
  assert.equal(
    permissionAddress(new PublicKey("8wTcJdg4Xw3wnvmBu7Sokn3c2UnnHUhuB5g9sfeCMidR"), new PublicKey("EzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z")).toBase58(),
    "6UCimUpRW2CGh3ESJm3S59c4WcCaVLYcpPPbbrfX2nzr",
  );
});

test("the fork's onboarding permission copies Phoenix's and names the fork's key", () => {
  const authority = new PublicKey("8wTcJdg4Xw3wnvmBu7Sokn3c2UnnHUhuB5g9sfeCMidR");
  const theirs = Buffer.alloc(168);
  theirs.fill(7, 0, 8);
  authority.toBuffer().copy(theirs, 8);
  new PublicKey("EzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z").toBuffer().copy(theirs, 40);
  theirs.writeBigUInt64LE(16n, 80); // TRADER_ONBOARDING_PERMISSION
  const ours = Keypair.generate().publicKey;
  const { address, data } = forkOnboardingPermission(theirs, ours);
  assert.ok(permissionDelegate(data).equals(ours));
  assert.ok(address.equals(permissionAddress(authority, ours)));
  assert.deepEqual(data.subarray(0, 40), theirs.subarray(0, 40));
  assert.deepEqual(data.subarray(72), theirs.subarray(72));
});

test("order size: collateral × leverage at the price, down to a lot", () => {
  assert.equal(orderSize(20_000_000n, 3, 161.69, 3), "0.371");
  assert.equal(orderSize(20_000_000n, 2, 76.66, 2), "0.52");
  assert.throws(() => orderSize(100n, 1, 76, 2), /less than one lot/);
  assert.throws(() => orderSize(1_000_000n, 0, 76, 2), /leverage/);
});

test("the mark at or after a moment: the first bar that starts then or later", async () => {
  const bars = [
    { time: 1_794_616_920_000, markOpen: 160.9 }, // starts before the moment
    { time: 1_794_616_980_000, markOpen: 161.17 },
    { time: 1_794_617_040_000, markOpen: 161.3 },
  ];
  const fetch = (async (url: string) => {
    assert.match(url, /\/v1\/candles_v2\/NVDA\?timeframe=1m&from=\d+&to=\d+/);
    return new Response(JSON.stringify({ bars }));
  }) as typeof globalThis.fetch;
  const v = new PhoenixVenue({ rpcUrl: "http://127.0.0.1:1", fetch });
  assert.deepEqual(await v.markAtOrAfter("NVDA", 1_794_616_950, 300), { price: 161.17, at: 1_794_616_980 });
  assert.equal(await v.markAtOrAfter("NVDA", 1_794_616_950, 20), null);
});

test("rate limits are retried with backoff, then the answer comes through", async () => {
  let calls = 0;
  const fetch = (async () => {
    calls++;
    if (calls < 3) return new Response("slow down", { status: 429 });
    return new Response(JSON.stringify({ bids: [[100, 1]], asks: [[101, 1]] }));
  }) as typeof globalThis.fetch;
  const v = new PhoenixVenue({ rpcUrl: "http://127.0.0.1:1", fetch, backoffMs: 1 });
  assert.equal(await v.mid("SOL"), 100.5);
  assert.equal(calls, 3);
  // Within 5 s the mid is reused, and reads at the same moment share one request.
  await Promise.all([v.mid("SOL"), v.mid("SOL")]);
  assert.equal(calls, 3);
});

test("calls into Phoenix's SDK are retried while the API rate-limits", async () => {
  const v = new PhoenixVenue({ rpcUrl: "http://127.0.0.1:1", backoffMs: 1 });
  let calls = 0;
  (v.client as any).exchange.ready = async () => {
    calls++;
    if (calls < 3) throw new Error("GET /v1/exchange failed with HTTP 429 Too Many Requests");
    return { markets: [{ symbol: "SOL", assetId: 0, marketPubkey: PublicKey.default.toBase58(), splinePubkey: PublicKey.default.toBase58(), baseLotsDecimals: 2, leverageTiers: [{ maxLeverage: 25 }], takerFee: 0.00035, marketStatus: "active" }] };
  };
  assert.equal((await v.market("SOL")).maxLeverage, 25);
  assert.equal(calls, 3);
  // Anything else fails at once.
  const w = new PhoenixVenue({ rpcUrl: "http://127.0.0.1:1", backoffMs: 1 });
  (w.client as any).exchange.ready = async () => {
    throw new Error("market not found");
  };
  await assert.rejects(w.markets(), /market not found/);
});

test("a market order's account, order book and side come from its instruction", async () => {
  const { getPlaceMarketOrderEncoder } = await import("@ellipsis-labs/rise");
  const { Keypair } = await import("@solana/web3.js");
  const { PHOENIX_PROGRAM_ID } = await import("../src/index.ts");
  const encode = (side: number) =>
    Uint8Array.from(getPlaceMarketOrderEncoder().encode({ side, priceInTicks: 15840n, numBaseLots: 250n, numQuoteLots: null, minBaseLotsToFill: 250n, minQuoteLotsToFill: 1n, selfTradeBehavior: 0, matchLimit: null, clientOrderId: 0n, lastValidSlot: null, orderFlags: 0, cancelExisting: false } as never));
  // The account order Phoenix's builder uses: program, log authority, global config, trader
  // wallet, trader account, PerpAssetMap, trader index, active-trader buffer, order book, spline.
  const keys = Array.from({ length: 10 }, () => Keypair.generate().publicKey);
  const long = decodeMarketOrder(PHOENIX_PROGRAM_ID, keys, encode(0))!;
  assert.deepEqual([long.side, long.baseLots], ["long", 250n]);
  assert.ok(long.trader.equals(keys[4]) && long.orderbook.equals(keys[8]));
  assert.equal(decodeMarketOrder(PHOENIX_PROGRAM_ID, keys, encode(1))!.side, "short");
  // Not Phoenix, or not a market order: nothing.
  assert.equal(decodeMarketOrder(PublicKey.default, keys, encode(0)), null);
  assert.equal(decodeMarketOrder(PHOENIX_PROGRAM_ID, keys, new Uint8Array(65)), null);
});

test("liquidation: Phoenix's equation, matching its on-chain Hawkeye view", async () => {
  const { liquidationDistance, liquidationOf } = await import("../src/index.ts");
  // A fork run: a 5x SOL long, 1.33 SOL from $75.00 on $19.965087 of collateral.
  // Hawkeye returned 6,121 ticks ($61.21) for it.
  const sol = { symbol: "SOL", assetId: 0, marketPubkey: PublicKey.default, splinePubkey: PublicKey.default, baseLotsDecimals: 2, isolatedOnly: false, maxLeverage: 25, takerFee: 0.00035, status: "active", maintenanceBps: 5_000, upnlBps: 10_000 };
  const owner = Keypair.generate().publicKey;
  const long = decodeTrader(trader({ authority: owner, collateral: 19_965_087n, sub: 1, positions: [[0, 133n, -99_750_000n]] }))!;
  const l = liquidationOf(long, sol)!;
  assert.equal(l.side, "long");
  assert.ok(Math.abs(l.entryUsd - 75) < 1e-9);
  assert.ok(Math.abs(l.liquidationUsd! - 61.2129) < 0.001, String(l.liquidationUsd));
  assert.ok(Math.abs(liquidationDistance(75, l)! - (75 - 61.2129) / 75) < 1e-4);
  // A short liquidates above the entry.
  const short = liquidationOf(decodeTrader(trader({ authority: owner, collateral: 19_965_087n, sub: 2, positions: [[0, -133n, 99_750_000n]] }))!, sol)!;
  assert.ok(short.side === "short" && short.liquidationUsd! > 75);
  assert.ok(liquidationDistance(75, short)! > 0);
  // No position, no liquidation.
  assert.equal(liquidationOf(decodeTrader(trader({ authority: owner, collateral: 1n, sub: 3, positions: [] }))!, sol), null);
});
