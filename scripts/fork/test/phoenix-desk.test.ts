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
import { PhoenixDesk } from "../api/phoenix.ts";
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
