import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { decodeActiveTraderBuffer, decodeGlobalTraderIndex } from "@ellipsis-labs/rise";
import { MakerSyncError, syncMakers } from "../src/makers.ts";

// Mainnet's active trader buffer and global trader index (2026-11-19), the accounts syncMakers
// patches on the fork. The "fork" in each test is that copy with what a fork does to it: fills
// that moved a maker, a trader only the fork has, an entry mainnet has since closed.
const fixture = (name: string) => gunzipSync(readFileSync(new URL(`./fixtures/${name}.bin.gz`, import.meta.url)));
const mainnet = { atb: fixture("active-trader-buffer"), gti: fixture("global-trader-index") };
const atb = decodeActiveTraderBuffer([mainnet.atb]);
const gti = decodeGlobalTraderIndex([mainnet.gti]);
const node = (pointer: number) => 96 + (pointer - 1) * 88;
const gtiNode = (pointer: number) => 96 + (pointer - 1) * 64;
const positions = atb.entries.filter((e) => e.value.kind === "position");
const copy = () => ({ atb: Buffer.from(mainnet.atb), gti: Buffer.from(mainnet.gti) });

test("a fork that matches mainnet needs nothing written", () => {
  assert.equal(syncMakers(copy(), mainnet), null);
});

test("fork fills that moved a maker's position and order links are undone: its entry is mainnet's again", () => {
  const fork = copy();
  const maker = positions.find((e) => e.value.kind === "position" && e.value.value.position.baseLotPosition !== 0n)!;
  const at = node(maker.nodeIndex);
  // As our buys did to CoreWeave's maker: a shorter position, and other order totals.
  fork.atb.writeBigInt64LE(fork.atb.readBigInt64LE(at + 24) - 995n, at + 24);
  fork.atb.writeUInt32LE(7, at + 24 + 48);
  const out = syncMakers(fork, mainnet)!;
  assert.equal(out.synced, 1);
  assert.equal(out.cleared + out.missing, 0);
  assert.ok(out.data.equals(mainnet.atb), "byte for byte mainnet's buffer");
});

test("a trader only the fork has (our users) keeps its entries; mainnet's traders are synced around it", () => {
  const fork = copy();
  // Give one trader in the fork's index another address, one that sorts in the same place (the
  // index is ordered by address): to the sync it's a fork-only trader.
  const bumped = (pointer: number) => {
    const b = Buffer.from(gtiBytes(pointer));
    b[31] += 1;
    return b;
  };
  const i = gti.entries.findIndex((e, k) => k + 1 < gti.entries.length && gtiBytes(e.nodeIndex)[31] < 255
    && Buffer.compare(bumped(e.nodeIndex), gtiBytes(gti.entries[k + 1].nodeIndex)) < 0
    && atb.entries.some((x) => x.id.traderId === e.nodeIndex && x.value.kind === "position"));
  const user = gti.entries[i];
  const at = gtiNode(user.nodeIndex) + 16;
  bumped(user.nodeIndex).copy(fork.gti, at);
  assert.notEqual(String(decodeGlobalTraderIndex([fork.gti]).entries[i].trader), String(user.trader), "the address changed");
  const mine = atb.entries.find((x) => x.id.traderId === user.nodeIndex && x.value.kind === "position")!;
  fork.atb.writeBigInt64LE(123_456n, node(mine.nodeIndex) + 24);
  // And a maker that fork fills moved.
  const maker = positions.find((x) => x.id.traderId !== user.nodeIndex && x.value.kind === "position" && x.value.value.position.baseLotPosition !== 0n)!;
  fork.atb.writeBigInt64LE(fork.atb.readBigInt64LE(node(maker.nodeIndex) + 24) + 1n, node(maker.nodeIndex) + 24);
  const out = syncMakers(fork, mainnet)!;
  assert.equal(out.synced, 1, "only the maker");
  assert.ok(out.forkOnly >= 1);
  assert.equal(out.data.readBigInt64LE(node(mine.nodeIndex) + 24), 123_456n, "the user's position is the fork's");
  assert.equal(out.data.readBigInt64LE(node(maker.nodeIndex) + 24), mainnet.atb.readBigInt64LE(node(maker.nodeIndex) + 24));
});

test("an entry mainnet no longer has is set flat; one the fork has no node for is counted, not added", () => {
  const fork = copy();
  // The fork's node for a key mainnet doesn't have: an entry whose next key (same trader) leaves
  // room for its asset id + 1, so the tree stays ordered.
  const k = atb.entries.findIndex((e, j) => e.value.kind === "position" && e.value.value.position.baseLotPosition !== 0n
    && (j + 1 === atb.entries.length || atb.entries[j + 1].id.traderId !== e.id.traderId || Number(atb.entries[j + 1].id.assetId) > Number(e.id.assetId) + 1));
  const e = atb.entries[k];
  fork.atb.writeUInt32LE(Number(e.id.assetId) + 1, node(e.nodeIndex) + 20);
  const out = syncMakers(fork, mainnet)!;
  assert.equal(out.cleared, 1, "the fork's entry, absent on mainnet, is flat now");
  assert.ok(out.data.subarray(node(e.nodeIndex) + 24, node(e.nodeIndex) + 88).equals(Buffer.alloc(64)));
  assert.equal(out.missing, 1, "mainnet's entry with the old key has no node on the fork");
});

test("bytes that don't match the layout: nothing is synced", () => {
  const fork = copy();
  // Two arenas declared: the sync reads only one.
  fork.atb.writeUInt16LE(2, 52);
  assert.throws(() => syncMakers(fork, mainnet), (e: unknown) => e instanceof Error);
  const other = copy();
  other.gti.writeUInt16LE(2, 52);
  assert.throws(() => syncMakers(other, mainnet), (e: unknown) => e instanceof Error);
  assert.ok(new MakerSyncError("x") instanceof Error);
});

function gtiBytes(pointer: number): Buffer {
  const at = gtiNode(pointer) + 16;
  return mainnet.gti.subarray(at, at + 32);
}
