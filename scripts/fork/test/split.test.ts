// Split trades that stop partway: retry once, then sweep (api/split.ts), and when abandoned
// tickets are looked for.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import BN from "bn.js";
import { Keypair, PublicKey, TransactionInstruction, VersionedTransaction, type Connection } from "@solana/web3.js";
import { THESIS_PROGRAM_ID, thesisProgram, ticketAddress, TAKE_LIFETIME_SECS } from "@thesis/chain";
import { emptyState } from "../../../packages/venues/bank/src/state.ts";
import type { GeminiContract } from "@thesis/venues/gemini";
import { ApiError, base58, type AppTake, type IncompleteTrade } from "../api/common.ts";
import { TRANSIENT_QUOTE } from "../api/routing.ts";
import { ForkService } from "../api/service.ts";
import { INCOMPLETE_TTL_MS, SplitTrades, TICKET_SCAN_MS, afterFailure, deserializeIx, serializeIx, sweepLegs } from "../api/split.ts";
import { StateStore } from "../api/store.ts";
import { MAX_TRIES, pickLiveContract } from "../gemini-pick.ts";

test("after a failure: the legs a retry builds again, and a leg split across the failure", () => {
  // Three transactions: legs 0+1, leg 2, then leg 3 with the receipt. The second one failed.
  assert.deepEqual(afterFailure([[0, 1], [2], [3]], 1), { remaining: [2, 3], split: false });
  // Only the receipt (no legs) was left.
  assert.deepEqual(afterFailure([[0], [1], []], 2), { remaining: [], split: false });
  // A Phoenix leg's deposit landed, its order didn't: no retry.
  assert.deepEqual(afterFailure([[0, 1], [1, 2]], 1), { remaining: [2], split: true });
});

test("a receipt survives the state file", () => {
  const ix = new TransactionInstruction({
    programId: THESIS_PROGRAM_ID,
    keys: [{ pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false }, { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
    data: Buffer.from([1, 2, 3, 250]),
  });
  const back = deserializeIx(JSON.parse(JSON.stringify(serializeIx(ix))));
  assert.ok(back.programId.equals(ix.programId));
  assert.deepEqual(back.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
  assert.deepEqual([...back.data], [...ix.data]);
});

test("a sweep sells what grew in landed brackets, except Phoenix legs and legs already swept", () => {
  const outputs = Array.from({ length: 10 }, () => Keypair.generate().publicKey);
  const received = Array.from({ length: 10 }, (_, i) => new BN(i * 100));
  // Legs 1, 2, 3 and 4 grew; 3 is on Phoenix; 4 was swept already; 5 named but never grew.
  const ticket = { outputs, received, grown: 0b11110, phoenix: 0b1000, named: 0b111110 };
  const legs = sweepLegs(ticket, { lend: [2], swept: [4] });
  assert.deepEqual(legs.map((l) => [l.leg, l.amount, l.lend]), [[1, 100n, false], [2, 200n, true]]);
  assert.ok(legs[0].account.equals(outputs[1]));
});

test("incomplete trades: per owner, kept a week, and their tickets left alone", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "thesis-split-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const store = new StateStore(join(dir, "state.json"), null, () => {});
  const split = new SplitTrades(store, () => now);
  const rec = record({ owner: "alice", at: now });
  split.set("P1", rec);
  assert.equal(split.get("alice", "P1")?.next, "retry");
  assert.equal(split.get("bob", "P1"), null, "someone else's");
  assert.deepEqual([...split.positions()], ["P1"]);
  // Abandoned-ticket scans: first build, then every TICKET_SCAN_MS, or at once when one is suspected.
  assert.equal(split.scanDue("alice"), true);
  split.scanned("alice");
  assert.equal(split.scanDue("alice"), false);
  now += TICKET_SCAN_MS - 1;
  assert.equal(split.scanDue("alice"), false);
  split.suspect("alice");
  assert.equal(split.scanDue("alice"), true, "a known abandoned ticket");
  split.scanned("alice");
  // A week on, the trade is dropped and its ticket becomes an ordinary abandoned one.
  now += INCOMPLETE_TTL_MS;
  assert.equal(split.get("alice", "P1"), null);
  assert.equal(split.positions().size, 0);
  assert.equal(split.scanDue("alice"), true);
});

test("the e2e's Gemini pick skips contracts whose live read fails or isn't two-sided", async () => {
  const now = 1_800_000_000_000;
  const contract = (symbol: string, days: number, o: Partial<GeminiContract> = {}): GeminiContract => ({
    instrumentSymbol: symbol,
    eventTicker: `E-${symbol}`,
    eventTitle: symbol,
    label: symbol,
    status: "active",
    expiry: new Date(now + days * 86_400_000).toISOString(),
    ask: { yes: 0.5, no: 0.52 },
    bid: { yes: 0.48, no: 0.5 },
    ...o,
  }) as GeminiContract;
  const bank = [contract("LATE", 9), contract("SOON", 3), contract("ONESIDED", 4), contract("EDGE", 5, { ask: { yes: 0.97, no: 0.04 }, bid: { yes: 0.96, no: 0.03 } })];
  const reads: string[] = [];
  const pick = await pickLiveContract(bank, async (ticker) => {
    reads.push(ticker);
    if (ticker === "E-SOON") throw new Error("HTTP 500");
    if (ticker === "E-ONESIDED") return [contract("ONESIDED", 4, { bid: { yes: 0.48, no: null } })];
    return [contract(ticker.slice(2), 9, { ask: { yes: 0.6, no: 0.42 }, bid: { yes: 0.57, no: 0.39 } })];
  }, now);
  assert.equal(pick.instrumentSymbol, "LATE");
  assert.equal(pick.ask.yes, 0.6, "the live copy");
  assert.deepEqual(reads, ["E-SOON", "E-ONESIDED", "E-LATE"], "soonest first; the bank's edge-priced one never read");
  // Nothing works: a clear error naming what was skipped, after at most MAX_TRIES reads.
  const many = Array.from({ length: MAX_TRIES + 5 }, (_, i) => contract(`C${i}`, 3 + i));
  let tries = 0;
  await assert.rejects(pickLiveContract(many, async () => (tries++, Promise.reject(new Error("HTTP 500"))), now), (e: Error) => /C0: live read failed \(HTTP 500\)/.test(e.message));
  assert.equal(tries, MAX_TRIES);
});

// --- ForkService: retry and sweep with a mocked fork --------------------------------------

const TAKE_ID = "00000000-0000-4000-8000-0000000000dd";

function record(o: Partial<IncompleteTrade> = {}): IncompleteTrade {
  return {
    owner: "owner",
    take: Keypair.generate().publicKey.toBase58(),
    takeId: TAKE_ID,
    kind: "back",
    side: "back",
    usd: 20,
    included: [0, 1],
    remaining: [1],
    lend: [],
    receipt: serializeIx(new TransactionInstruction({ programId: THESIS_PROGRAM_ID, keys: [], data: Buffer.alloc(8) })),
    receiptCu: 50_000,
    signatures: ["landed-1"],
    next: "retry",
    at: Date.now(),
    ...o,
  };
}

type Status = { err: unknown; confirmationStatus: string } | null;

async function fixture(t: TestContext, o: {
  record: (owner: Keypair, payer: Keypair) => IncompleteTrade;
  ticket?: { grown: number; phoenix: number; named: number } | null;
  send?: () => Promise<string>;
  /** What getSignatureStatuses says about a signature (default: nothing known). */
  status?: (sig: string) => Status;
}) {
  const dir = mkdtempSync(join(tmpdir(), "thesis-split-svc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = Keypair.generate();
  const appPayer = Keypair.generate();
  const position = Keypair.generate().publicKey;
  const rec = o.record(owner, appPayer);
  const statePath = join(dir, "api-state.json");
  writeFileSync(statePath, JSON.stringify({ forkId: "none", takes: {}, cash: [], incomplete: { [position.toBase58()]: rec } }));
  const program = thesisProgram({} as Connection);
  const ticketKey = ticketAddress(owner.publicKey, position);
  const ticketData = o.ticket
    ? await program.coder.accounts.encode("tradeTicket", {
      owner: owner.publicKey,
      position,
      rentPayer: appPayer.publicKey,
      ownerUsdc: Keypair.generate().publicKey,
      outputs: Array.from({ length: 10 }, () => Keypair.generate().publicKey),
      spent: new BN(12_000_000),
      grown: o.ticket.grown,
      received: Array.from({ length: 10 }, () => new BN(5)),
      named: o.ticket.named,
      phoenix: o.ticket.phoenix,
      openIx: 65_535,
      openMask: 0,
      usdcStart: new BN(0),
      outputsStart: Array.from({ length: 10 }, () => new BN(0)),
      bump: 255,
    })
    : null;
  const sent: VersionedTransaction[] = [];
  const connection = {
    getAccountInfoAndContext: async (key: PublicKey) => ({
      context: { slot: 1 },
      value: key.equals(ticketKey) && ticketData ? { data: ticketData, owner: THESIS_PROGRAM_ID, lamports: 1, executable: false } : null,
    }),
    getAccountInfo: async () => null,
    getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null),
    getProgramAccounts: async () => [],
    getTokenAccountBalance: async () => ({ value: { amount: "100000000" } }),
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    getSignaturesForAddress: async () => [],
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 20_000 } }),
    sendTransaction: async (tx: VersionedTransaction) => (sent.push(tx), o.send ? o.send() : base58(tx.signatures[0])),
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map((s) => o.status?.(s) ?? null) }),
    // Past every blockhash's last valid height (100): an unseen transaction can't land any more.
    getBlockHeight: async () => 101,
  } as unknown as Connection;
  const app: AppTake = {
    id: TAKE_ID,
    claim: "Chips keep going up",
    risk: "medium",
    settles_at: new Date(Date.now() + TAKE_LIFETIME_SECS * 1000).toISOString(),
    status: "posting",
    author: { handle: "someone" },
    author_wallet: owner.publicKey.toBase58(),
    legs: [{ name: "NVIDIA", kind: "Stock", weight: 100, fade_how: null }],
  };
  const service = new ForkService({
    connection,
    appPayer,
    lookupTable: null,
    bank: emptyState,
    takes: async (id) => (id === TAKE_ID ? app : null),
    stocks: null,
    pricesFile: null,
    bases: null,
    jupiterApiKey: null,
    statePath,
    fork: { addUsdc: async () => 0n, setUsdc: async () => {}, refreshMarkets: async () => {} },
  });
  const wallet = owner.publicKey.toBase58();
  const sign = (built: { transactions: string[] }) =>
    built.transactions.map((b64) => {
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      tx.sign([owner]);
      return Buffer.from(tx.serialize()).toString("base64");
    });
  /** The signatures of the transactions sent so far. */
  const sentSigs = () => sent.map((tx) => base58(tx.signatures[0]));
  return { service, wallet, owner, appPayer, position, ticketKey, sent, sentSigs, sign, statePath };
}

const apiError = (status: number, code: string) => (e: unknown) => e instanceof ApiError && e.status === status && e.code === code;

test("sweep: a ticket with only a Phoenix leg is cancelled, and cash-out is pointed to", async (t) => {
  const f = await fixture(t, { record: (owner) => record({ owner: owner.publicKey.toBase58(), next: "sweep" }), ticket: { grown: 0b1, phoenix: 0b1, named: 0b1 } });
  assert.equal(f.service.incompleteTrades(f.wallet).trades.length, 1);
  const built = await f.service.buildSweep(f.wallet);
  assert.equal(built.done, false);
  if (built.done) return;
  assert.deepEqual(built.tokens, [], "nothing to swap: the Phoenix leg is cash-out's");
  assert.equal(built.phoenixCashOut, true);
  assert.equal(built.transactions.length, 1);
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transactions[0], "base64"));
  assert.ok(tx.message.staticAccountKeys.some((k) => k.equals(f.ticketKey)), "it cancels the ticket");
  const { signatures } = await f.service.submit(built.buildId, f.sign(built));
  assert.equal(signatures.length, 1);
  assert.equal(f.service.incompleteTrades(f.wallet).trades.length, 0, "swept: the trade is over");
  // Sweep, submit, sweep again: done, with or without the position.
  assert.deepEqual(await f.service.buildSweep(f.wallet, f.position.toBase58()), { done: true, phoenixCashOut: false });
  assert.deepEqual(await f.service.buildSweep(f.wallet), { done: true, phoenixCashOut: false });
});

test("sweep: a failed send keeps the trade to sweep again", async (t) => {
  const f = await fixture(t, {
    record: (owner) => record({ owner: owner.publicKey.toBase58(), next: "sweep" }),
    ticket: { grown: 0, phoenix: 0, named: 0 },
    send: async () => Promise.reject(new Error("blockhash not found")),
  });
  const built = await f.service.buildSweep(f.wallet);
  if (built.done) return assert.fail("expected a build");
  await assert.rejects(f.service.submit(built.buildId, f.sign(built)), apiError(502, "send_failed"));
  assert.equal(f.service.incompleteTrades(f.wallet).trades.length, 1);
});

test("sweep or retry: the ticket gone with no position means nothing is left", async (t) => {
  const f = await fixture(t, { record: (owner) => record({ owner: owner.publicKey.toBase58() }), ticket: null });
  await assert.rejects(f.service.buildRetry(f.wallet), apiError(410, "incomplete_gone"));
  assert.equal(f.service.incompleteTrades(f.wallet).trades.length, 0);
  assert.deepEqual(await f.service.buildSweep(f.wallet), { done: true, phoenixCashOut: false }, "nothing to sweep");
  await assert.rejects(f.service.buildRetry(f.wallet), apiError(404, "incomplete_missing"));
});

test("retry: once only, and not when a leg it would buy landed after all", async (t) => {
  const used = await fixture(t, { record: (owner) => record({ owner: owner.publicKey.toBase58(), next: "sweep" }), ticket: { grown: 0b1, phoenix: 0, named: 0b1 } });
  await assert.rejects(used.service.buildRetry(used.wallet), (e: unknown) => apiError(409, "retry_used")(e) && (e as ApiError).body?.sweep === true);

  const landed = await fixture(t, { record: (owner) => record({ owner: owner.publicKey.toBase58(), remaining: [1] }), ticket: { grown: 0b11, phoenix: 0, named: 0b11 } });
  await assert.rejects(landed.service.buildRetry(landed.wallet), (e: unknown) => {
    const body = (e as ApiError).body as { retry: boolean; sweep: boolean; incomplete: { next: string } };
    return apiError(409, "retry_unavailable")(e) && body.retry === false && body.sweep === true && body.incomplete.next === "sweep";
  });
  assert.equal(landed.service.incompleteTrades(landed.wallet).trades[0].next, "sweep");
});

test("retry: a publish whose receipt didn't land is built on the same ticket; a failure leaves a sweep, a success opens the position", async (t) => {
  const setup = (send?: () => Promise<string>) =>
    fixture(t, {
      record: (owner, payer) => record({
        owner: owner.publicKey.toBase58(),
        kind: "publish",
        included: [0],
        remaining: [],
        publishTakeId: TAKE_ID,
        receipt: serializeIx(new TransactionInstruction({
          programId: THESIS_PROGRAM_ID,
          keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: true }],
          data: Buffer.alloc(16),
        })),
      }),
      ticket: { grown: 0b1, phoenix: 0, named: 0b1 },
      send,
    });

  const failing = await setup(async () => Promise.reject(new Error("custom program error: 0x1771")));
  const built = await failing.service.buildRetry(failing.wallet);
  assert.equal(built.transactions.length, 1);
  assert.deepEqual(built.legs, []);
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transactions[0], "base64"));
  assert.ok(tx.message.staticAccountKeys.some((k) => k.equals(failing.ticketKey)), "it steps on the same ticket");
  await assert.rejects(failing.service.submit(built.buildId, failing.sign(built)), (e: unknown) => {
    const body = (e as ApiError).body as { sweep: boolean; incomplete: { next: string; landed: number } };
    return apiError(422, "trade_incomplete")(e) && body.sweep === true && body.incomplete.next === "sweep" && body.incomplete.landed === 1;
  });
  await assert.rejects(failing.service.buildRetry(failing.wallet), apiError(409, "retry_used"));

  const ok = await setup();
  const again = await ok.service.buildRetry(ok.wallet);
  const { signatures } = await ok.service.submit(again.buildId, ok.sign(again));
  const both = ["landed-1", ...ok.sentSigs()];
  assert.equal(both.length, 2);
  assert.deepEqual(signatures, both, "the position opened over both parts");
  assert.equal(ok.service.incompleteTrades(ok.wallet).trades.length, 0);
  ok.service.flush();
  const state = JSON.parse(readFileSync(ok.statePath, "utf8"));
  assert.deepEqual(state.takes[TAKE_ID].signatures, both);
  assert.deepEqual(state.openingTransactions[ok.position.toBase58()], both);
});

/** A stopped publish of the fixture's take whose receipt alone is left (a retry needs no quotes). */
const publishRecord = (owner: Keypair, payer: Keypair, o: Partial<IncompleteTrade> = {}) => record({
  owner: owner.publicKey.toBase58(),
  kind: "publish",
  included: [0],
  remaining: [],
  publishTakeId: TAKE_ID,
  receipt: serializeIx(new TransactionInstruction({
    programId: THESIS_PROGRAM_ID,
    keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: true }],
    data: Buffer.alloc(16),
  })),
  ...o,
});

test("retry: two retry builds send at most one; the other is refused before anything is sent", async (t) => {
  const f = await fixture(t, { record: publishRecord, ticket: { grown: 0b1, phoenix: 0, named: 0b1 }, send: async () => Promise.reject(new Error("custom program error: 0x1771")) });
  const a = await f.service.buildRetry(f.wallet);
  const b = await f.service.buildRetry(f.wallet);
  await assert.rejects(f.service.submit(a.buildId, f.sign(a)), apiError(422, "trade_incomplete"));
  // Sending the first dropped the second build.
  await assert.rejects(f.service.submit(b.buildId, f.sign(b)), apiError(410, "build_expired"));
  assert.equal(f.sent.length, 1);
});

test("retry: two retry builds submitted at once: one is sent, the other refused", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = await fixture(t, { record: publishRecord, ticket: { grown: 0b1, phoenix: 0, named: 0b1 }, send: async () => (await gate, Promise.reject(new Error("custom program error: 0x1771"))) });
  const a = await f.service.buildRetry(f.wallet);
  const b = await f.service.buildRetry(f.wallet);
  const pa = f.service.submit(a.buildId, f.sign(a));
  const pb = f.service.submit(b.buildId, f.sign(b));
  release();
  const [ra, rb] = await Promise.allSettled([pa, pb]);
  assert.equal(ra.status, "rejected");
  assert.ok(apiError(422, "trade_incomplete")((ra as PromiseRejectedResult).reason));
  assert.ok(apiError(409, "retry_used")((rb as PromiseRejectedResult).reason), "checked again in the wallet's queue");
  assert.equal(f.sent.length, 1);
});

test("sweep and retry race: once a sweep is built, a retry built before it is refused at submit", async (t) => {
  const f = await fixture(t, { record: publishRecord, ticket: { grown: 0b1, phoenix: 0b1, named: 0b1 } });
  const retry = await f.service.buildRetry(f.wallet);
  const sweep = await f.service.buildSweep(f.wallet);
  if (sweep.done) return assert.fail("expected a build");
  assert.equal(f.service.incompleteTrades(f.wallet).trades[0].next, "sweep", "building a sweep ends the retry");
  await assert.rejects(f.service.buildRetry(f.wallet), apiError(409, "retry_used"));
  await assert.rejects(f.service.submit(retry.buildId, f.sign(retry)), apiError(409, "retry_used"));
  assert.equal(f.sent.length, 0, "the retry never went out");
  await f.service.submit(sweep.buildId, f.sign(sweep));
  assert.equal(f.sent.length, 1);
  assert.equal(f.service.incompleteTrades(f.wallet).trades.length, 0);
});

test("swept legs: a partly swept trade can't be retried, and a failed sweep keeps them", async (t) => {
  const f = await fixture(t, {
    record: (owner) => record({ owner: owner.publicKey.toBase58(), next: "sweep", swept: [2] }),
    ticket: { grown: 0b100, phoenix: 0, named: 0b100 },
    send: async () => Promise.reject(new Error("Transaction simulation failed: insufficient funds")),
  });
  await assert.rejects(f.service.buildRetry(f.wallet), apiError(409, "retry_used"));
  const sweep = await f.service.buildSweep(f.wallet);
  if (sweep.done) return assert.fail("expected a build");
  assert.deepEqual(sweep.tokens, [], "leg 2 was sold already");
  await assert.rejects(f.service.submit(sweep.buildId, f.sign(sweep)), apiError(502, "send_failed"));
  f.service.flush();
  const state = JSON.parse(readFileSync(f.statePath, "utf8"));
  assert.deepEqual(state.incomplete[f.position.toBase58()].swept, [2]);
});

test("send: a transaction whose send errored but that landed counts as landed; one whose blockhash passed unseen doesn't", async (t) => {
  // The RPC drops the connection, but the transaction went out and confirmed.
  const landed = await fixture(t, {
    record: (owner) => record({ owner: owner.publicKey.toBase58(), next: "sweep" }),
    ticket: { grown: 0, phoenix: 0, named: 0 },
    send: async () => Promise.reject(new Error("fetch failed: socket hang up")),
    status: () => ({ err: null, confirmationStatus: "confirmed" }),
  });
  const built = await landed.service.buildSweep(landed.wallet);
  if (built.done) return assert.fail("expected a build");
  const { signatures } = await landed.service.submit(built.buildId, landed.sign(built));
  assert.deepEqual(signatures, landed.sentSigs());
  assert.equal(landed.service.incompleteTrades(landed.wallet).trades.length, 0);

  // Same error, but the transaction never showed up and its blockhash is past.
  const lost = await fixture(t, {
    record: (owner) => record({ owner: owner.publicKey.toBase58(), next: "sweep" }),
    ticket: { grown: 0, phoenix: 0, named: 0 },
    send: async () => Promise.reject(new Error("fetch failed: socket hang up")),
  });
  const again = await lost.service.buildSweep(lost.wallet);
  if (again.done) return assert.fail("expected a build");
  await assert.rejects(lost.service.submit(again.buildId, lost.sign(again)), apiError(502, "send_failed"));
  assert.equal(lost.service.incompleteTrades(lost.wallet).trades.length, 1);
});

test("publish: a take whose split publish stopped can't be published afresh over its ticket", async (t) => {
  const f = await fixture(t, { record: publishRecord, ticket: { grown: 0b1, phoenix: 0, named: 0b1 } });
  await assert.rejects(f.service.buildPublish(TAKE_ID, f.wallet, 20), (e: unknown) => {
    const body = (e as ApiError).body as { sweep: boolean; incomplete: { position: string } };
    return apiError(409, "trade_incomplete")(e) && body.sweep === true && body.incomplete.position === f.position.toBase58();
  });
});

test("base58 writes signatures as Solana does", () => {
  for (let i = 0; i < 20; i++) {
    const key = Keypair.generate().publicKey;
    assert.equal(base58(key.toBytes()), key.toBase58());
  }
  assert.equal(base58(new Uint8Array([0, 0, 1])), "112");
});

test("only a quote that failed is transient: Jupiter's no-route answers aren't", () => {
  for (const r of ["no quote: Jupiter HTTP 429", "no quote: The operation was aborted due to timeout", "no quote: fetch failed", "no quote: HTTP 502"]) assert.ok(TRANSIENT_QUOTE.test(r), r);
  for (const r of ["no quote: COULD_NOT_FIND_ANY_ROUTE", "no quote: HTTP 400", "no quote: empty route", "price impact 2.10% is over 1%"]) assert.ok(!TRANSIENT_QUOTE.test(r), r);
});
