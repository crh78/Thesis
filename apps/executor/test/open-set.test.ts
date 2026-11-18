import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { THESIS_PROGRAM_ID, exitAddress, type ExitAccount, type PositionAccount, type TakeAccount } from "@thesis/chain";
import { OpenSet, SupabaseOpenPositions, type ChainReader, type OpenPositionsSource } from "../src/settler/open-set.ts";

const key = () => Keypair.generate().publicKey;
const take = (open: boolean | "closed" = true) =>
  ({ status: open === "closed" ? { closed: {} } : open ? { open: {} } : { settled: {} } }) as unknown as TakeAccount;
const position = (t: PublicKey, owner = key()) => ({ take: t, owner }) as unknown as PositionAccount;

/** A chain of accounts by address, counting full scans and reads. */
function fakeChain() {
  const positions = new Map<string, PositionAccount>();
  const takes = new Map<string, TakeAccount>();
  const exits = new Map<string, ExitAccount>();
  const calls = { scans: 0, reads: 0 };
  const byKeys = <T>(m: Map<string, T>) => async (keys: PublicKey[]) => {
    calls.reads++;
    return keys.map((k) => m.get(k.toBase58()) ?? null);
  };
  const all = <T>(m: Map<string, T>) => async () => [...m].map(([k, account]) => ({ publicKey: new PublicKey(k), account }));
  const reader: ChainReader = {
    allPositions: async () => {
      calls.scans++;
      return all(positions)();
    },
    allTakes: all(takes),
    allExits: all(exits),
    positions: byKeys(positions),
    takes: byKeys(takes),
    exits: byKeys(exits),
  };
  return { positions, takes, exits, calls, reader };
}

function fakeSource(rows: { position: string; take: string }[]): OpenPositionsSource & { fail: boolean } {
  return {
    name: "test",
    fail: false,
    async open() {
      if (this.fail) throw new Error("down");
      return rows;
    },
  };
}

test("the first tick scans; later ticks read the database's open positions by address", async () => {
  const chain = fakeChain();
  const t1 = key();
  const p1 = key();
  chain.takes.set(t1.toBase58(), take());
  chain.positions.set(p1.toBase58(), position(t1));
  const rows: { position: string; take: string }[] = [];
  let now = 0;
  const set = new OpenSet({ chain: chain.reader, programId: THESIS_PROGRAM_ID, source: fakeSource(rows), now: () => now });

  const first = await set.load(true);
  assert.equal(chain.calls.scans, 1);
  assert.ok(set.fullScan);
  assert.deepEqual(first.positions.map((p) => p.publicKey.toBase58()), [p1.toBase58()]);

  // A new back the Stream reported: found without a scan, with its exit.
  const t2 = key();
  const p2 = key();
  chain.takes.set(t2.toBase58(), take());
  chain.positions.set(p2.toBase58(), position(t2));
  chain.exits.set(exitAddress(p2).toBase58(), { position: p2 } as unknown as ExitAccount);
  rows.push({ position: p2.toBase58(), take: t2.toBase58() });
  now = 60_000;
  const second = await set.load(true);
  assert.equal(chain.calls.scans, 1);
  assert.ok(!set.fullScan);
  assert.deepEqual(new Set(second.positions.map((p) => p.publicKey.toBase58())), new Set([p1.toBase58(), p2.toBase58()]));
  assert.ok(second.exits.has(p2.toBase58()));
  assert.ok(second.takes.has(t1.toBase58()) && second.takes.has(t2.toBase58()));

  // Settled positions close: they drop out, and so does a settled take with nothing left.
  chain.positions.delete(p1.toBase58());
  chain.takes.set(t1.toBase58(), take(false));
  rows.length = 0;
  const third = await set.load(true);
  assert.deepEqual(third.positions.map((p) => p.publicKey.toBase58()), [p2.toBase58()]);
  assert.deepEqual(set.size, { positions: 1, takes: 1 });

  // Ten minutes after the last scan, the backstop scans again.
  now = 600_000;
  await set.load(true);
  assert.equal(chain.calls.scans, 2);
  assert.ok(set.fullScan);
});

test("an unsettled take stays tracked after its last position settles (the author sold early)", async () => {
  const chain = fakeChain();
  const t = key();
  const p = key();
  chain.takes.set(t.toBase58(), take());
  chain.positions.set(p.toBase58(), position(t));
  let now = 0;
  const set = new OpenSet({ chain: chain.reader, programId: THESIS_PROGRAM_ID, source: fakeSource([]), now: () => now });
  await set.load(true);
  chain.positions.delete(p.toBase58());
  now = 1_000;
  const later = await set.load(true);
  assert.equal(later.positions.length, 0);
  assert.ok(later.takes.has(t.toBase58()), "settle_take still has to run at the horizon");
});

test("a take its author's sale closed stays tracked until it settles", async () => {
  const chain = fakeChain();
  const t = key();
  const p = key();
  chain.takes.set(t.toBase58(), take("closed"));
  chain.positions.set(p.toBase58(), position(t));
  let now = 0;
  const set = new OpenSet({ chain: chain.reader, programId: THESIS_PROGRAM_ID, source: fakeSource([]), now: () => now });
  await set.load(true);
  chain.positions.delete(p.toBase58());
  now = 1_000;
  const later = await set.load(true);
  assert.ok(later.takes.has(t.toBase58()), "settle_take still has to run on the sale");
  chain.takes.set(t.toBase58(), take(false));
  now = 2_000;
  await set.load(true);
  assert.equal(set.size.takes, 0);
});

test("a database outage keeps the known set; a row from an old fork holds nothing and drops", async () => {
  const chain = fakeChain();
  const t = key();
  const p = key();
  chain.takes.set(t.toBase58(), take());
  chain.positions.set(p.toBase58(), position(t));
  const source = fakeSource([{ position: key().toBase58(), take: key().toBase58() }]);
  let now = 0;
  const logs: string[] = [];
  const set = new OpenSet({ chain: chain.reader, programId: THESIS_PROGRAM_ID, source, now: () => now, log: (l) => logs.push(l) });
  await set.load(true);
  now = 1_000;
  // The stale row costs one read and is gone (until the next full scan).
  assert.equal((await set.load(true)).positions.length, 1);
  assert.deepEqual(set.size, { positions: 1, takes: 1 });
  now = 1_500;
  await set.load(true);
  assert.deepEqual(set.size, { positions: 1, takes: 1 }, "neither the row nor its take is read again");
  source.fail = true;
  now = 2_000;
  assert.equal((await set.load(true)).positions.length, 1);
  assert.match(logs.join("\n"), /failed: down/);
});

test("new positions report their owners once, for the badge check", async () => {
  const chain = fakeChain();
  const t = key();
  const owner = key();
  chain.takes.set(t.toBase58(), take());
  let now = 0;
  const rows: { position: string; take: string }[] = [];
  const set = new OpenSet({ chain: chain.reader, programId: THESIS_PROGRAM_ID, source: fakeSource(rows), now: () => now });
  await set.load(true);
  assert.deepEqual(set.takeNewOwners(), [], "a full scan checks every profile anyway");
  const p = key();
  chain.positions.set(p.toBase58(), position(t, owner));
  rows.push({ position: p.toBase58(), take: t.toBase58() });
  now = 1_000;
  await set.load(true);
  assert.deepEqual(set.takeNewOwners().map(String), [owner.toBase58()]);
  await set.load(false);
  assert.deepEqual(set.takeNewOwners(), []);
});

test("without a database every tick scans", async () => {
  const chain = fakeChain();
  const set = new OpenSet({ chain: chain.reader, programId: THESIS_PROGRAM_ID });
  await set.load(true);
  await set.load(false);
  assert.equal(chain.calls.scans, 2);
});

test("chain_positions is read page by page, open rows on one network only", async () => {
  const urls: string[] = [];
  const pages = [Array.from({ length: 1_000 }, (_, i) => ({ address: `p${i}`, take: "t" })), [{ address: "last", take: "t" }]];
  const fetchStub = (async (url: string, init: RequestInit) => {
    urls.push(`${url} ${(init.headers as Record<string, string>).range}`);
    return new Response(JSON.stringify(pages.shift()), { status: 200 });
  }) as unknown as typeof fetch;
  const source = new SupabaseOpenPositions({ url: "https://x.supabase.co/", key: "anon", network: "solana-mainnet-fork", fetch: fetchStub });
  const rows = await source.open();
  assert.equal(rows.length, 1_001);
  assert.equal(rows.at(-1)!.position, "last");
  assert.match(urls[0], /network=eq\.solana-mainnet-fork/);
  assert.match(urls[0], /settled_at=is\.null/);
  assert.match(urls[0], / 0-999$/);
  assert.match(urls[1], / 1000-1999$/);
});
