// Phoenix children across rebuilds (api/phoenix.ts): a rebuild of a trade reuses the children its
// last build got, and the submit makes sure no other submitted trade took them meanwhile.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Keypair, SystemProgram, type Connection, type PublicKey } from "@solana/web3.js";
import { thesisProgram } from "@thesis/chain";
import { FIRST_CHILD, TRADER_DISCRIMINATOR, traderAddress, type PhoenixVenue } from "@thesis/venues/phoenix";
import { ApiError, base58, type ServiceOpts } from "../api/common.ts";
import { PhoenixDesk, freedMargin } from "../api/phoenix.ts";
import { StateStore } from "../api/store.ts";

function desk(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "thesis-phoenix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const appPayer = Keypair.generate();
  const onboarder = Keypair.generate();
  let registrations = 0;
  // No trader accounts on this fork: the parent and every child chosen get registered.
  const connection = {
    getAccountInfo: async () => null,
    getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null),
    getMultipleAccountsInfoAndContext: async (keys: unknown[]) => ({ context: { slot: 1 }, value: keys.map(() => null) }),
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    sendTransaction: async (tx: { signatures: Uint8Array[] }) => (registrations++, base58(tx.signatures[0])),
    confirmTransaction: async () => ({ value: { err: null } }),
  } as unknown as Connection;
  const venue = {
    // The onboarder co-signs the parent's registration.
    registration: async () => ({ instructions: [SystemProgram.transfer({ fromPubkey: onboarder.publicKey, toPubkey: appPayer.publicKey, lamports: 1 })] }),
    childRegistration: async () => [],
  } as unknown as PhoenixVenue;
  const store = new StateStore(join(dir, "state.json"), null, () => {});
  const d = new PhoenixDesk({ connection, appPayer } as unknown as ServiceOpts, { venue, onboarder: { onboarder, permission: Keypair.generate().publicKey } }, store, thesisProgram(connection));
  return { d, registrations: () => registrations };
}

test("a rebuild reuses its draft's children; a submit claims them, and a build made alongside is refused", async (t) => {
  const { d } = desk(t);
  const owner = Keypair.generate().publicKey;
  const [p1, p2, p3] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  const first = await d.prepare(owner, 2);
  assert.deepEqual(first, [FIRST_CHILD, FIRST_CHILD + 1]);
  d.record(p1, owner, first.map((sub, leg) => ({ leg, sub, symbol: "NVDA" })));
  // The amount changed: built again. Same children, not two new ones.
  const again = await d.prepare(owner, 2);
  assert.deepEqual(again, first);
  d.record(p2, owner, again.map((sub, leg) => ({ leg, sub, symbol: "NVDA" })));
  // The second build is the one submitted.
  d.commit(p2);
  assert.deepEqual(d.legsOf(p2).map((l) => l.sub), first);
  // Its children are taken now: the next build gets others, and the stale first build is refused.
  const third = await d.prepare(owner, 1);
  assert.equal(third.length, 1);
  assert.ok(!first.includes(third[0]));
  d.record(p3, owner, [{ leg: 0, sub: third[0], symbol: "NVDA" }]);
  assert.throws(() => d.commit(p1), (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === "build_stale");
  d.commit(p3);
  // A position committed already (a retry's) and one with no Phoenix legs pass.
  d.commit(p3);
  d.commit(Keypair.generate().publicKey);
});

test("another owner's children aren't shared", async (t) => {
  const { d } = desk(t);
  const [a, b] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const mine = await d.prepare(a, 1);
  d.record(Keypair.generate().publicKey, a, [{ leg: 0, sub: mine[0], symbol: "NVDA" }]);
  // Children are per wallet: b's first child has the same number, and that's fine.
  assert.deepEqual(await d.prepare(b, 1), mine);
});

/** A child's trader account holding one perp position (the bytes Phoenix writes; see packages/venues/phoenix's tests). */
function traderBytes(owner: PublicKey, sub: number, baseLots: bigint): Buffer {
  const b = Buffer.alloc(280);
  TRADER_DISCRIMINATOR.copy(b, 0);
  owner.toBuffer().copy(b, 56);
  b.writeBigInt64LE(20_000_000n, 88);
  b[155] = sub;
  b.writeBigUInt64LE(1n, 224);
  b.writeBigUInt64LE(1n, 232);
  b.writeBigUInt64LE(7n, 240);
  b.writeBigInt64LE(baseLots, 248);
  b.writeBigInt64LE(1_994_000n, 256);
  return b;
}

test("a fade prebuilt at $25 then $50 (both on child 5), the $25 one submitted: its live short is no stray", async (t) => {
  const owner = Keypair.generate().publicKey;
  const [d1, d2] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const sub = FIRST_CHILD + 4;
  // Child 5 holds D1's short once D1 is submitted; D1's position is open on-chain, D2's never existed.
  const child5 = traderAddress(owner, sub).toBase58();
  const short = traderBytes(owner, sub, -26n);
  const connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (k.toBase58() === child5 ? { data: short } : null)),
  } as unknown as Connection;
  const program = { account: { position: { fetchMultiple: async (keys: PublicKey[]) => keys.map((k) => (k.equals(d1) ? { exited: false } : null)) } } };
  const dir = mkdtempSync(join(tmpdir(), "thesis-phoenix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(join(dir, "state.json"), null, () => {});
  const onboarder = { onboarder: Keypair.generate(), permission: Keypair.generate().publicKey };
  const d = new PhoenixDesk({ connection, appPayer: Keypair.generate() } as unknown as ServiceOpts, { venue: {} as PhoenixVenue, onboarder }, store, program as never);
  // Both prebuilds reserve child 5 (the second reuses the first's reservation); the $25 one is submitted.
  d.record(d1, owner, [{ leg: 0, sub, symbol: "NVDA" }]);
  d.record(d2, owner, [{ leg: 0, sub, symbol: "NVDA" }]);
  d.commit(d1);
  assert.deepEqual(d.legsOf(d2), [], "the $50 draft on the same child is dropped");
  assert.deepEqual((await d.children(owner)).map((c) => [c.sub, c.position]), [[sub, d1.toBase58()]], "child 5 is D1's");
  assert.deepEqual(await d.strays(owner), [], "D1's open short isn't a stray: the next cash-out leaves it");
  // The $50 build is stale now: submitting it is refused, not sent on D1's child.
  assert.throws(() => d.commit(d2), (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === "build_stale");
  // Once D1 is over (sold, the close failed), its short is a stray again.
  program.account.position.fetchMultiple = async (keys: PublicKey[]) => keys.map((k) => (k.equals(d1) ? { exited: true } : null));
  assert.deepEqual((await d.strays(owner)).map((s) => s.sub), [sub]);
});

test("children: a child maps to its submitted position, not a draft recorded after it", async (t) => {
  const owner = Keypair.generate().publicKey;
  const [live, later] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const child3 = traderAddress(owner, 3).toBase58();
  const connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (k.toBase58() === child3 ? { data: traderBytes(owner, 3, 10n) } : null)),
  } as unknown as Connection;
  const dir = mkdtempSync(join(tmpdir(), "thesis-phoenix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(join(dir, "state.json"), null, () => {});
  const onboarder = { onboarder: Keypair.generate(), permission: Keypair.generate().publicKey };
  const d = new PhoenixDesk({ connection, appPayer: Keypair.generate() } as unknown as ServiceOpts, { venue: {} as PhoenixVenue, onboarder }, store, {} as never);
  d.record(live, owner, [{ leg: 0, sub: 3, symbol: "NVDA" }]);
  d.commit(live);
  // A build recorded later on the same child (it would be refused at submit).
  d.record(later, owner, [{ leg: 0, sub: 3, symbol: "NVDA" }]);
  assert.deepEqual((await d.children(owner)).map((c) => c.position), [live.toBase58()]);
});

test("freedMargin: a partial close frees its share of the equity at the child's leverage", () => {
  // $20 of equity behind $100 of notional (5x): closing 40% frees $8 and leaves $12 behind $60 (5x).
  const freed = freedMargin(20, 100, 0.4, 10)!;
  assert.equal(freed.targetLeverageBps, 50_000n);
  assert.ok(Math.abs(freed.usd - 8) < 1e-9);
  // A gain: $30 behind $100 (3.33x, rounded down to 33,333 bps): a hair under 40% of $30.
  const gain = freedMargin(30, 100, 0.4, 10)!;
  assert.equal(gain.targetLeverageBps, 33_333n);
  assert.ok(gain.usd < 12 && gain.usd > 11.99);
  // Above the market's max (12.5x on a 10x market): the target is the max, so only what the close
  // brings under it moves: $60 left needs $6 at 10x, so $2 of the $8 frees.
  assert.ok(Math.abs(freedMargin(8, 100, 0.4, 10)!.usd - 2) < 1e-9);
  // Closing 10% of it leaves $90, needing $9 > $8: nothing frees.
  assert.equal(freedMargin(8, 100, 0.1, 10), null);
  // No equity, no position, nothing closed, all of it, or dust: nothing.
  assert.equal(freedMargin(0, 100, 0.4, 10), null);
  assert.equal(freedMargin(20, 0, 0.4, 10), null);
  assert.equal(freedMargin(20, 100, 0, 10), null);
  assert.equal(freedMargin(20, 100, 1, 10), null);
  assert.equal(freedMargin(0.01, 0.05, 0.1, 10), null);
});

test("a partial sale closes its share of the lots and releases that share's margin to the parent; the cash-out sweeps the parent, not the child", async (t) => {
  const owner = Keypair.generate().publicKey;
  const position = Keypair.generate().publicKey;
  const sub = FIRST_CHILD + 2;
  // A 5x long: 1,000 lots (10 SOL at 2 lot decimals) at $10, $20 of collateral, $100 of entry cost.
  const child = traderBytes(owner, sub, 1_000n);
  child.writeBigInt64LE(-100_000_000n, 256);
  // The parent once the sale has landed: the $8 the release moved, no position.
  const parent = traderBytes(owner, 0, 0n);
  parent.writeBigInt64LE(8_000_000n, 88);
  parent.writeBigUInt64LE(0n, 224);
  const accounts = new Map([[traderAddress(owner, sub).toBase58(), child], [traderAddress(owner, 0).toBase58(), parent]]);
  const info = (k: PublicKey) => (accounts.has(k.toBase58()) ? { data: accounts.get(k.toBase58())! } : null);
  const connection = {
    getAccountInfo: async (k: PublicKey) => info(k),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(info),
  } as unknown as Connection;
  const closes: bigint[] = [];
  const releases: bigint[] = [];
  const marker = (n: number) => SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: n });
  const venue = {
    market: async () => ({ baseLotsDecimals: 2, maxLeverage: 10 }),
    mid: async () => 10,
    closeLeg: async (o: { baseLots: bigint; label: string }) => (closes.push(o.baseLots), { label: `${o.label}: close`, instructions: [marker(1)], lookupTables: [], marketAccounts: [] }),
    releaseLeg: async (o: { targetLeverageBps: bigint }) => (releases.push(o.targetLeverageBps), { label: "release", instructions: [marker(2)], lookupTables: [], marketAccounts: [] }),
    sweepLeg: async (o: { sub: number; label: string }) => ({ label: o.label, instructions: [], lookupTables: [], marketAccounts: [], sub: o.sub }),
  } as unknown as PhoenixVenue;
  const dir = mkdtempSync(join(tmpdir(), "thesis-phoenix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(join(dir, "state.json"), null, () => {});
  const onboarder = { onboarder: Keypair.generate(), permission: Keypair.generate().publicKey };
  const d = new PhoenixDesk({ connection, appPayer: Keypair.generate(), bank: () => ({ venues: {} }) } as unknown as ServiceOpts, { venue, onboarder }, store, {} as never);
  d.record(position, owner, [{ leg: 1, sub, symbol: "SOL" }]);
  d.commit(position);

  const part = (await d.reduceLegs(position, owner, new Map([[1, "Solana perp"]]), 4_000))!;
  assert.deepEqual(closes, [400n], "40% of the lots");
  assert.deepEqual(releases, [50_000n], "back to the 5x it runs at");
  assert.equal(part.legs.length, 1);
  assert.equal(part.legs[0].instructions.length, 2, "the release rides in the close's own leg, after it");
  assert.equal(part.legs[0].instructions[1].data.readBigUInt64LE(4), 2n);
  assert.ok(Math.abs(part.usd - 8) < 1e-9, "40% of the $20 equity");
  assert.ok(Math.abs(part.notional - 40) < 1e-9, "40% of the $100 notional");
  assert.equal(part.released, true);
  // A part that rounds a leg's order to nothing is refused.
  await assert.rejects(d.reduceLegs(position, owner, new Map(), 5), (e: unknown) => e instanceof ApiError && e.code === "part_too_small");

  // The cash-out takes the parent's $8, never the child (still holding what's left).
  assert.deepEqual(await d.sweepable(owner), [{ sub: 0, collateral: 8_000_000n }]);
  const legs = (await d.sweepLegs(owner)) as unknown as { sub: number; label: string }[];
  assert.deepEqual(legs.map((l) => [l.sub, l.label]), [[0, "Phoenix account"]]);
});
