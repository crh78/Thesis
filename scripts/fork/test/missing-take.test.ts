import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import BN from "bn.js";
import { Keypair, type Connection, type PublicKey } from "@solana/web3.js";
import { DEFAULT_CONFIG_PARAMS, configAddress, thesisProgram, TAKE_LIFETIME_SECS } from "@thesis/chain";
import { emptyState } from "../../../packages/venues/bank/src/state.ts";
import { TAKE_CLOSED, TAKE_ENDED, TAKE_MISSING, takeClosedError, takeOpen, takeStatusName, type AppTake } from "../api/common.ts";
import { ForkService } from "../api/service.ts";

function service(t: TestContext, take: AppTake, connection: Connection = {
  getAccountInfo: async () => null,
  getMultipleAccountsInfo: async () => [],
} as unknown as Connection) {
  const dir = mkdtempSync(join(tmpdir(), "thesis-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new ForkService({
    connection,
    appPayer: Keypair.generate(),
    lookupTable: Keypair.generate().publicKey,
    bank: emptyState,
    takes: async (id) => (id === take.id ? take : null),
    stocks: null,
    pricesFile: null,
    bases: null,
    jupiterApiKey: null,
    statePath: join(dir, "api-state.json"),
    fork: { addUsdc: async () => 0n, setUsdc: async () => {}, refreshMarkets: async () => {} },
  });
}

const take = (author_wallet: string | null): AppTake => ({
  id: "00000000-0000-4000-8000-0000000000bb",
  claim: "Chips keep going up",
  risk: "medium",
  settles_at: new Date(Date.now() + TAKE_LIFETIME_SECS * 1000).toISOString(),
  status: "live",
  author: { handle: "someone" },
  author_wallet,
  legs: [{ name: "NVIDIA", kind: "Stock", weight: 100, fade_how: null }],
});

test("a posted take missing from this fork can't be traded, and says why", async (t) => {
  const r = await service(t, take(Keypair.generate().publicKey.toBase58())).receipt("00000000-0000-4000-8000-0000000000bb", undefined, { routes: false });
  assert.equal(r.onChain, false);
  assert.equal(r.canBack, false);
  assert.equal(r.canFade, false);
  assert.equal((r as { missing?: string }).missing, TAKE_MISSING);
});

test("a seeded demo take (no author wallet) still offers its first trade, which mirrors it", async (t) => {
  const r = await service(t, take(null)).receipt("00000000-0000-4000-8000-0000000000bb", undefined, { routes: false });
  assert.equal(r.onChain, false);
  assert.equal((r as { missing?: string }).missing, undefined);
  assert.notEqual(r.fadeBlocked, TAKE_MISSING);
});

/** A fake chain holding the config and, once `at` and `data` are set, one take account. */
async function fakeChain() {
  const program = thesisProgram({} as Connection);
  const reads: string[] = [];
  let at: string | null = null;
  let data: Buffer | null = null;
  const k = () => Keypair.generate().publicKey;
  const config = await program.coder.accounts.encode("config", {
    admin: k(), allowlistAdmin: k(), pendingAdmin: null, pendingAllowlistAdmin: null, settler: k(), usdcMint: k(),
    feeVault: k(), creatorVault: k(), escrowVault: k(), params: DEFAULT_CONFIG_PARAMS, bump: 255, feeVaultBump: 255,
    creatorVaultBump: 255, escrowVaultBump: 255, tradePrograms: [], badgeUriBase: "",
  });
  const account = (key: PublicKey) => {
    if (key.equals(configAddress())) return { data: config, owner: program.programId, lamports: 1, executable: false, rentEpoch: 0 };
    reads.push(key.toBase58());
    return key.toBase58() === at && data ? { data, owner: program.programId, lamports: 1, executable: false, rentEpoch: 0 } : null;
  };
  const chain = {
    reads,
    set: (address: string, account: Buffer) => ((at = address), (data = account)),
    connection: {
      getAccountInfo: async (key: PublicKey) => account(key),
      getAccountInfoAndContext: async (key: PublicKey) => ({ context: { slot: 1 }, value: account(key) }),
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => null),
      // Positions the service noted (the take's own buy-in) are read back with Anchor's fetchMultiple.
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({ context: { slot: 1 }, value: keys.map(() => null) }),
      getProgramAccounts: async () => [],
    } as unknown as Connection,
    takeData: (author: PublicKey, o: { status?: object; closedAt?: number; horizonEnd?: number } = {}) =>
      program.coder.accounts.encode("take", {
        author, id: new BN(1), claimHash: Array(32).fill(0), risk: { medium: {} }, createdAt: new BN(0),
        horizonEnd: new BN(o.horizonEnd ?? Math.floor(Date.now() / 1000) + 86_400), legs: [], backers: 0, faders: 0, totalBacked: new BN(0),
        totalFaded: new BN(0), openPositions: 0, creatorFeesUnclaimed: new BN(0), platformFeesFromBacks: new BN(0),
        status: o.status ?? { open: {} }, resultBps: new BN(0), bump: 255, closedAt: new BN(o.closedAt ?? 0),
      }),
  };
  return chain;
}

test("a posted take with no record here is found at its own address and used", async (t) => {
  const wallet = Keypair.generate().publicKey;
  const app = take(wallet.toBase58());
  const { connection, reads, set, takeData } = await fakeChain();

  // Nothing on-chain: missing, and the miss is remembered (no second chain read right away).
  const first = service(t, app, connection);
  assert.equal(((await first.receipt(app.id, undefined, { routes: false })) as { missing?: string }).missing, TAKE_MISSING);
  const afterMiss = reads.length;
  assert.ok(afterMiss >= 1);
  await first.receipt(app.id, undefined, { routes: false });
  assert.equal(reads.length, afterMiss, "a recent miss isn't read again");

  // The address it derived (from the author's wallet and the take's id) gets the take.
  set(reads[0], await takeData(wallet));
  const fresh = service(t, app, connection);
  const found = await fresh.receipt(app.id, undefined, { routes: false });
  assert.equal(found.onChain, true, "recorded and read as on-chain");
  assert.equal((found as { missing?: string }).missing, undefined);
  assert.equal(found.onChain && found.status, "open");
  assert.equal(found.onChain && found.closedAt, null);
});

test("a take its author sold out of reads closed: no new backs or fades, and when it closed", async (t) => {
  const wallet = Keypair.generate().publicKey;
  const app = take(wallet.toBase58());
  const closedAt = Math.floor(Date.now() / 1000) - 60;
  for (const [status, name] of [[{ closed: {} }, "closed"], [{ settled: {} }, "settled"]] as const) {
    const { connection, reads, set, takeData } = await fakeChain();
    await service(t, app, connection).receipt(app.id, undefined, { routes: false });
    set(reads[0], await takeData(wallet, { status, closedAt }));
    const r = await service(t, app, connection).receipt(app.id, wallet.toBase58(), { routes: false });
    assert.ok(r.onChain);
    assert.equal(r.status, name);
    assert.equal(r.closedAt, closedAt, "the author's sale, still shown once settled");
    assert.equal(r.canBack, false);
    assert.equal(r.canFade, false);
    assert.equal(r.fadeBlocked, TAKE_CLOSED);
  }
});

test("open means not closed by the author and before the horizon; builds on any other take get 409 take_closed", () => {
  const at = (status: object, horizonEnd: number) => ({ status, horizonEnd: new BN(horizonEnd) }) as never;
  assert.equal(takeStatusName(at({ open: {} }, 2_000)), "open");
  assert.equal(takeStatusName(at({ closed: {} }, 2_000)), "closed");
  assert.equal(takeStatusName(at({ settled: {} }, 2_000)), "settled");
  assert.equal(takeOpen(at({ open: {} }, 2_000), 1_999), true);
  assert.equal(takeOpen(at({ open: {} }, 2_000), 2_000), false);
  assert.equal(takeOpen(at({ closed: {} }, 2_000), 1_000), false);
  for (const [t, message] of [[at({ closed: {} }, 2_000), TAKE_CLOSED], [at({ settled: {} }, 2_000), TAKE_CLOSED], [at({ open: {} }, 0), TAKE_ENDED], [null, TAKE_CLOSED]] as const) {
    const e = takeClosedError(t);
    assert.deepEqual([e.status, e.code, e.message], [409, "take_closed", message]);
  }
});
