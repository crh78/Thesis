import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import idl from "../idl/thesis.json" with { type: "json" };
import { LOOKUP_TABLE_TTL_MS, MAX_TX_BYTES, composeTransactions, loadLookupTables, v0Size } from "../src/compose.ts";
import { thesisLookupTableAddresses } from "../src/lookup-table.ts";

const payer = Keypair.generate().publicKey;
const program = Keypair.generate().publicKey;
/** A leg of `n` instructions, each touching fresh accounts (so nothing dedups). */
const leg = (label: string, n: number, accounts = 6) => ({
  label,
  lookupTables: [] as PublicKey[],
  instructions: Array.from({ length: n }, () =>
    new TransactionInstruction({ programId: program, keys: Array.from({ length: accounts }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true })), data: Buffer.alloc(40) }),
  ),
});
const receipt = new TransactionInstruction({ programId: program, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.alloc(30) });

function fakeConnection(unitsConsumed: number | null): Connection {
  return {
    getMultipleAccountsInfo: async () => [],
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1 }),
    simulateTransaction: async () => ({ value: unitsConsumed === null ? { err: "x" } : { err: null, unitsConsumed } }),
  } as unknown as Connection;
}

test("v0Size matches web3.js serialization", () => {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 }), receipt] }).compileToV0Message();
  assert.equal(v0Size(msg), new VersionedTransaction(msg).serialize().length);
});

test("everything in one transaction when it fits, receipt last", async () => {
  const txs = await composeTransactions({ payer, legs: [leg("a", 1), leg("b", 1)], receipt, receiptCu: 45_000, connection: fakeConnection(100_000) });
  assert.equal(txs.length, 1);
  assert.deepEqual(txs[0].labels, ["a", "b", "thesis receipt"]);
  assert.equal(txs[0].computeFrom, "simulated");
  assert.equal(txs[0].computeUnits, Math.ceil(100_000 * 1.15) + 5_000);
});

test("splits by size, never splits a leg, and keeps the receipt with the last leg", async () => {
  const legs = ["a", "b", "c", "d"].map((l) => leg(l, 2, 8));
  const txs = await composeTransactions({ payer, legs, receipt, receiptCu: 45_000, connection: fakeConnection(null) });
  assert.ok(txs.length > 1);
  assert.deepEqual(txs.flatMap((t) => t.labels), ["a", "b", "c", "d", "thesis receipt"]);
  assert.ok(txs.every((t) => t.bytes <= MAX_TX_BYTES));
  assert.equal(txs.at(-1)!.labels.at(-1), "thesis receipt");
  // Simulation failed: generous estimate.
  assert.ok(txs.every((t) => t.computeFrom === "estimated"));
});

test("a receipt too big to sit beside the last leg goes last on its own", async () => {
  const big = new TransactionInstruction({ programId: program, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.alloc(700) });
  const legs = ["a", "b"].map((l) => leg(l, 2, 8));
  const txs = await composeTransactions({ payer, legs, receipt: big, receiptCu: 46_000, connection: fakeConnection(null) });
  assert.deepEqual(txs.flatMap((t) => t.labels), ["a", "b", "thesis receipt"]);
  assert.deepEqual(txs.at(-1)!.labels, ["thesis receipt"]);
  assert.ok(txs.every((t) => t.bytes <= MAX_TX_BYTES));
});

test("a receipt alone when there are no legs", async () => {
  const txs = await composeTransactions({ payer, legs: [], receipt, receiptCu: 45_000, connection: fakeConnection(30_000) });
  assert.deepEqual(txs.map((t) => t.labels), [["thesis receipt"]]);
});

test("a leg too big for any transaction is an error", async () => {
  await assert.rejects(composeTransactions({ payer, legs: [leg("huge", 6, 10)], receipt, receiptCu: 45_000, connection: fakeConnection(1) }), /doesn't fit/);
});

test("the Thesis lookup table holds accounts, not invoked programs", () => {
  const keys = thesisLookupTableAddresses().map(String);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
});

// Proof of trade.

import { thesisProgram } from "../src/program.ts";
import { THESIS_PROGRAM_ID } from "../src/constants.ts";
import { ticketAddress } from "../src/pda.ts";

const thesis = thesisProgram(new Connection("http://127.0.0.1:8899")); // never contacted
const owner = Keypair.generate().publicKey;
const position = Keypair.generate().publicKey;
const disc = (name: string) => Buffer.from(idl.instructions.find((i) => i.name === name)!.discriminator);
const thesisIxs = (tx: VersionedTransaction) =>
  tx.message.compiledInstructions
    .filter((ix) => tx.message.staticAccountKeys[ix.programIdIndex].equals(THESIS_PROGRAM_ID))
    .map((ix) => Buffer.from(ix.data));
const withOutput = (label: string, n: number, legIndex: number) => ({ ...leg(label, n), output: { leg: legIndex, account: Keypair.generate().publicKey } });
const thesisReceipt = new TransactionInstruction({ programId: THESIS_PROGRAM_ID, keys: [{ pubkey: owner, isSigner: true, isWritable: false }], data: Buffer.concat([disc("back"), Buffer.alloc(18)]) });

test("proof of trade: begin_trade right after the budget, receipt last with the outputs", async () => {
  const legs = [withOutput("a", 1, 0), withOutput("b", 1, 2)];
  const txs = await composeTransactions({ payer, legs, receipt: thesisReceipt, receiptCu: 46_000, connection: fakeConnection(100_000), proof: { program: thesis, owner, position } });
  assert.equal(txs.length, 1);
  const { message } = txs[0].tx;
  const keys = message.staticAccountKeys;
  const programs = message.compiledInstructions.map((ix) => keys[ix.programIdIndex]);
  // compute budget, begin_trade, the two legs, the receipt
  assert.ok(programs[1].equals(THESIS_PROGRAM_ID) && programs.at(-1)!.equals(THESIS_PROGRAM_ID));
  const [begin, back] = thesisIxs(txs[0].tx);
  assert.deepEqual(begin.subarray(0, 8), disc("begin_trade"));
  assert.equal(begin.readUInt16LE(8), 0b101, "outputs mask names legs 0 and 2");
  assert.deepEqual(back.subarray(0, 8), disc("back"));
  const receiptKeys = message.compiledInstructions.at(-1)!.accountKeyIndexes.map((i) => keys[i]);
  assert.ok(receiptKeys.at(-2)!.equals(legs[0].output.account) && receiptKeys.at(-1)!.equals(legs[1].output.account));
  assert.ok(keys.some((k) => k.equals(ticketAddress(owner, position))));
});

test("proof of trade: a split trade brackets every transaction", async () => {
  const legs = [withOutput("a", 2, 0), withOutput("b", 2, 1), withOutput("c", 2, 2)];
  const txs = await composeTransactions({ payer, legs, receipt: thesisReceipt, receiptCu: 46_000, connection: fakeConnection(100_000), proof: { program: thesis, owner, position } });
  assert.ok(txs.length >= 2, `split into ${txs.length}`);
  txs.forEach((t, i) => {
    assert.ok(t.bytes <= MAX_TX_BYTES);
    const [open, close] = thesisIxs(t.tx);
    assert.deepEqual(open.subarray(0, 8), disc(i === 0 ? "begin_trade" : "trade_step"));
    if (i > 0) assert.equal(open[8], 1, "later transactions open with trade_step");
    if (i === txs.length - 1) assert.deepEqual(close.subarray(0, 8), disc("back"));
    else assert.deepEqual([...close.subarray(0, 9)], [...disc("trade_step"), 0]);
    // Each bracket closes over the same outputs it opened with.
    const mask = (b: Buffer) => b.readUInt16LE(b.subarray(0, 8).equals(disc("trade_step")) ? 9 : 8);
    if (i < txs.length - 1) assert.equal(mask(open), mask(close));
  });
  // Later transactions can't be simulated before the earlier ones land.
  assert.equal(txs[0].computeFrom, "simulated");
  assert.ok(txs.slice(1).every((t) => t.computeFrom === "estimated"));
});

test("each transaction lists its legs", async () => {
  const legs = ["a", "b", "c", "d"].map((l) => leg(l, 2, 8));
  const txs = await composeTransactions({ payer, legs, receipt, receiptCu: 45_000, connection: fakeConnection(null) });
  assert.ok(txs.length > 1);
  assert.deepEqual(txs.flatMap((t) => t.legs), [0, 1, 2, 3]);
  txs.forEach((t) => assert.deepEqual(t.labels.filter((l) => l !== "thesis receipt"), t.legs.map((i) => legs[i].label)));
});

test("proof of trade: a continued trade (a retry) opens every transaction with trade_step", async () => {
  const legs = [withOutput("b", 1, 1)];
  const txs = await composeTransactions({ payer, legs, receipt: thesisReceipt, receiptCu: 46_000, connection: fakeConnection(100_000), proof: { program: thesis, owner, position, continued: true } });
  assert.equal(txs.length, 1);
  const [open, back] = thesisIxs(txs[0].tx);
  assert.deepEqual([...open.subarray(0, 9)], [...disc("trade_step"), 1]);
  assert.equal(open.readUInt16LE(9), 0b10, "names leg 1");
  assert.deepEqual(back.subarray(0, 8), disc("back"));
  assert.equal(txs[0].computeFrom, "simulated", "the ticket exists, so it simulates");
  // A retry of a receipt that sat alone: trade_step over no outputs, then the receipt.
  const [alone] = await composeTransactions({ payer, legs: [], receipt: thesisReceipt, receiptCu: 46_000, connection: fakeConnection(30_000), proof: { program: thesis, owner, position, continued: true } });
  const [step, receiptIx] = thesisIxs(alone.tx);
  assert.deepEqual([...step.subarray(0, 11)], [...disc("trade_step"), 1, 0, 0]);
  assert.deepEqual(receiptIx.subarray(0, 8), disc("back"));
});

/** A lookup table account's data holding `addresses` (the address-lookup-table program's layout). */
function tableData(addresses: PublicKey[]): Buffer {
  const meta = Buffer.alloc(56);
  meta.writeUInt32LE(1, 0); // a lookup table
  meta.writeBigUInt64LE(2n ** 64n - 1n, 4); // not deactivated
  return Buffer.concat([meta, ...addresses.map((a) => a.toBuffer())]);
}

test("lookup tables are read once and reused per connection until they're 10 minutes old", async () => {
  const table = Keypair.generate().publicKey;
  const addresses = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  let reads = 0;
  const conn = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      reads += keys.length;
      return keys.map((k) => (k.equals(table) ? { data: tableData(addresses) } : null));
    },
  } as unknown as Connection;
  const t0 = 1_000_000;
  const first = await loadLookupTables(conn, [table, table], { now: t0 });
  assert.deepEqual(first.get(table.toBase58())!.state.addresses.map(String), addresses.map(String));
  assert.equal(reads, 1, "the same table named twice is read once");
  await loadLookupTables(conn, [table], { now: t0 + LOOKUP_TABLE_TTL_MS - 1 });
  assert.equal(reads, 1, "reused while fresh");
  await loadLookupTables(conn, [table], { now: t0 + LOOKUP_TABLE_TTL_MS });
  assert.equal(reads, 2, "read again once it's 10 minutes old");
  await loadLookupTables({ ...conn } as Connection, [table], { now: t0 + LOOKUP_TABLE_TTL_MS });
  assert.equal(reads, 3, "another connection reads its own");
  await loadLookupTables(conn, [table], { now: t0 + LOOKUP_TABLE_TTL_MS, maxAgeMs: 0 });
  assert.equal(reads, 4, "maxAgeMs 0 reads afresh");

  const missing = Keypair.generate().publicKey;
  await assert.rejects(loadLookupTables(conn, [missing], { now: t0 }), /not found/);
  await assert.rejects(loadLookupTables(conn, [missing], { now: t0 }), /not found/, "a missing table isn't cached");
  assert.equal(reads, 6);
});
