// Sending back to back (until=accepted) and reading transactions' fates (api/send.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { base58 } from "../api/common.ts";
import { SendFailed, fates, sendBackToBack } from "../api/send.ts";

const payer = Keypair.generate();
const tx = (lamports: number) => {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports })],
  }).compileToV0Message();
  const t = new VersionedTransaction(message);
  t.sign([payer]);
  return t;
};
const sig = (t: VersionedTransaction) => base58(t.signatures[0]);
type Status = { err: unknown; confirmationStatus: string } | null;

/** A fork that accepts what `send` allows and reports `status` for each signature. */
function fork(o: { send?: (i: number) => Promise<void>; status: (sig: string) => Status; height?: number }) {
  const sent: string[] = [];
  const conn = {
    sendTransaction: async (t: VersionedTransaction) => {
      const i = sent.length;
      sent.push(sig(t));
      await o.send?.(i);
      return sig(t);
    },
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map((s) => o.status(s)) }),
    getBlockHeight: async () => o.height ?? 50,
  } as unknown as Connection;
  return { conn, sent };
}
const ok: Status = { err: null, confirmationStatus: "confirmed" };
const refused = () => Promise.reject(Object.assign(new Error("Transaction simulation failed"), { logs: ["Program log: Error Code: TicketMissing"] }));

test("back to back: all sent before any confirms, accepted once all were, then their signatures", async () => {
  const txs = [tx(1), tx(2), tx(3)];
  let accepted = -1;
  const { conn, sent } = fork({ status: (s) => (accepted >= 0 ? ok : null) });
  const out = await sendBackToBack(conn, txs, 100, { accept: () => (accepted = sent.length) });
  assert.equal(accepted, 3, "accepted after the third was sent");
  assert.deepEqual(out, txs.map(sig));
});

test("a split trade whose later transaction is refused: nothing after it is sent, the first is confirmed, and it reports what landed", async () => {
  const txs = [tx(1), tx(2), tx(3)];
  let accepted = false;
  const { conn, sent } = fork({ send: (i) => (i === 1 ? refused() : Promise.resolve()), status: () => ok });
  await assert.rejects(sendBackToBack(conn, txs, 100, { accept: () => (accepted = true) }), (e: unknown) =>
    e instanceof SendFailed && e.code === "send_failed" && e.landed.length === 1 && e.landed[0] === sig(txs[0]) && !e.unknown);
  assert.equal(accepted, false, "never accepted");
  assert.equal(sent.length, 2, "the third never went out");
});

test("accepted, then a later one lands with an error: the ones before it count as landed", async () => {
  const txs = [tx(1), tx(2)];
  const { conn } = fork({ status: (s) => (s === sig(txs[1]) ? { err: { Custom: 1 }, confirmationStatus: "confirmed" } : ok) });
  let accepted = false;
  await assert.rejects(sendBackToBack(conn, txs, 100, { accept: () => (accepted = true) }), (e: unknown) =>
    e instanceof SendFailed && e.code === "transaction_failed" && e.landed.length === 1 && e.landed[0] === sig(txs[0]));
  assert.equal(accepted, true);
});

test("an RPC error while sending: it waits to see whether that one went out, and carries on when it landed", async () => {
  const txs = [tx(1), tx(2)];
  const { conn, sent } = fork({ send: (i) => (i === 0 ? Promise.reject(new Error("fetch failed: socket hang up")) : Promise.resolve()), status: () => ok });
  const logs: string[] = [];
  const out = await sendBackToBack(conn, txs, 100, { accept: () => {}, log: (m) => logs.push(m) });
  assert.deepEqual(out, txs.map(sig));
  assert.equal(sent.length, 2);
  assert.match(logs[0], /waiting to see if it landed/);
});

test("fates: landed, failed with an error, failed once its blockhash passed unseen; once leaves the rest unknown", async () => {
  const [a, b, c] = [tx(1), tx(2), tx(3)].map(sig);
  const status = (s: string): Status => (s === a ? ok : s === b ? { err: { Custom: 6 }, confirmationStatus: "finalized" } : null);
  assert.deepEqual(await fates(fork({ status, height: 101 }).conn, [a, b, c], 100), ["landed", "failed", "failed"]);
  assert.deepEqual(await fates(fork({ status, height: 50 }).conn, [a, b, c], 100, { once: true }), ["landed", "failed", "unknown"]);
  // Still processing, then confirmed: polled until known.
  let reads = 0;
  const later = fork({ status: () => (++reads > 2 ? ok : { err: null, confirmationStatus: "processed" }) });
  assert.deepEqual(await fates(later.conn, [a], 100), ["landed"]);
  assert.deepEqual(await fates(fork({ status: () => null }).conn, [a], 100, { maxMs: 0 }), ["unknown"], "never seen, blockhash still live: unknown, never failed");
});
