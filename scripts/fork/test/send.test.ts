// Sending back to back (until=accepted) and reading transactions' fates (api/send.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { base58 } from "../api/common.ts";
import { SendFailed, fates, resendOnce, sendBackToBack, slippageRefusal } from "../api/send.ts";

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
function fork(o: { send?: (i: number, sig: string) => Promise<void>; status: (sig: string) => Status; height?: number }) {
  const sent: string[] = [];
  const conn = {
    sendTransaction: async (t: VersionedTransaction) => {
      const i = sent.length;
      sent.push(sig(t));
      await o.send?.(i, sig(t));
      return sig(t);
    },
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map((s) => o.status(s)) }),
    getBlockHeight: async () => o.height ?? 50,
  } as unknown as Connection;
  return { conn, sent };
}
const ok: Status = { err: null, confirmationStatus: "confirmed" };
const refused = () => Promise.reject(Object.assign(new Error("Transaction simulation failed"), { logs: ["Program log: Error Code: TicketMissing"] }));
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
/** Jupiter's route filled under its minimum out, as Surfpool's preflight reports it (exit-e2e on the VM). */
const slipped = () => Promise.reject(Object.assign(new Error("Transaction simulation failed: Error processing Instruction 4: custom program error: 0x1771"), {
  logs: [`Program ${JUPITER} invoke [1]`, "Program log: Instruction: Route", `Program ${JUPITER} consumed 81234 of 200000 compute units`, `Program ${JUPITER} failed: custom program error: 0x1771`],
}));

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

test("stale markets: a first transaction refused by preflight gets the markets reset and the same bytes sent once more", async () => {
  const txs = [tx(1), tx(2)];
  let resets = 0;
  // The pool moved on mainnet: the first preflight is refused until the markets are reset.
  const { conn, sent } = fork({ send: (i) => (i === 0 && resets === 0 ? refused() : Promise.resolve()), status: () => ok });
  let accepted = 0;
  const logs: string[] = [];
  const out = await resendOnce((rest) => sendBackToBack(conn, rest, 100, { accept: () => accepted++ }), txs, {
    stale: true,
    reset: async () => void resets++,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(out, txs.map(sig));
  assert.equal(resets, 1);
  assert.deepEqual(sent, [sig(txs[0]), sig(txs[0]), sig(txs[1])], "the same signed bytes again");
  assert.equal(accepted, 1);
  assert.match(logs[0], /resetting them and sending again/);
});

test("stale markets: no resend when the markets were all reset, after something went out, or a second time", async () => {
  const txs = [tx(1), tx(2)];
  const run = async (o: { stale: boolean; refuse: (i: number) => boolean }) => {
    let resets = 0;
    const { conn, sent } = fork({ send: (i) => (o.refuse(i) ? refused() : Promise.resolve()), status: () => ok });
    const e = await resendOnce((rest) => sendBackToBack(conn, rest, 100, { accept: () => {} }), txs, { stale: o.stale, reset: async () => void resets++ }).then(
      () => assert.fail("expected a refusal"),
      (err: unknown) => err,
    );
    assert.ok(e instanceof SendFailed && e.code === "send_failed");
    return { resets, sent: sent.length, nothingSent: (e as SendFailed).nothingSent };
  };
  assert.deepEqual(await run({ stale: false, refuse: (i) => i === 0 }), { resets: 0, sent: 1, nothingSent: true }, "markets reset at submit: the refusal stands");
  assert.deepEqual(await run({ stale: true, refuse: (i) => i === 1 }), { resets: 0, sent: 2, nothingSent: false }, "the first went out: never sent again");
  assert.deepEqual(await run({ stale: true, refuse: () => true }), { resets: 1, sent: 2, nothingSent: true }, "refused again after the reset: once only");
});

test("slippage: Jupiter's 0x1771 (by name or number) is a slippage refusal; another program's 0x1771 isn't", async () => {
  const text = await slipped().catch((e: Error & { logs: string[] }) => new Error(`${e.logs.at(-2)} / ${e.logs.at(-1)}`));
  assert.equal(slippageRefusal(text), true);
  assert.equal(slippageRefusal(new Error("Program log: AnchorError occurred. Error Code: SlippageToleranceExceeded. Error Number: 6001.")), true);
  assert.equal(slippageRefusal(new Error("Transaction simulation failed: Error processing Instruction 4: custom program error: 0x1771")), true, "no program named");
  assert.equal(slippageRefusal(new Error("Program Thes1s111111111111111111111111111111111111 failed: custom program error: 0x1771")), false, "another program's error 6001");
  assert.equal(slippageRefusal(new Error("Program log: Error Code: TicketMissing")), false);
  assert.equal(slippageRefusal(new Error("custom program error: 0x17710")), false);
});

test("slippage: a later transaction refused for slippage is sent again, the same bytes, after the markets are reset; the ones before it aren't", async () => {
  const txs = [tx(1), tx(2), tx(3)];
  let resets = 0;
  // As in exit-e2e: the second transaction's Jupiter route is refused until the pools are copied again.
  const { conn, sent } = fork({ send: (_, s) => (s === sig(txs[1]) && resets === 0 ? slipped() : Promise.resolve()), status: () => ok });
  let accepted = 0;
  const logs: string[] = [];
  const out = await resendOnce((rest) => sendBackToBack(conn, rest, 100, { accept: () => accepted++ }), txs, {
    stale: false,
    reset: async () => void resets++,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(out, txs.map(sig), "every transaction, in order");
  assert.equal(resets, 1);
  assert.deepEqual(sent, [sig(txs[0]), sig(txs[1]), sig(txs[1]), sig(txs[2])], "the first once; the refused one and the one after it, as signed");
  assert.equal(accepted, 1, "accepted once all were");
  assert.match(logs[0], /refused transaction 2 of 3 for slippage/);
});

test("slippage: refused again after the reset, it stops there with what landed (a split trade's trade_incomplete)", async () => {
  const txs = [tx(1), tx(2), tx(3)];
  let resets = 0;
  const { conn, sent } = fork({ send: (_, s) => (s === sig(txs[1]) ? slipped() : Promise.resolve()), status: () => ok });
  let accepted = false;
  await assert.rejects(resendOnce((rest) => sendBackToBack(conn, rest, 100, { accept: () => (accepted = true) }), txs, { stale: false, reset: async () => void resets++ }), (e: unknown) =>
    e instanceof SendFailed && e.code === "send_failed" && e.refused && !e.nothingSent && e.landed.length === 1 && e.landed[0] === sig(txs[0]) && slippageRefusal(e));
  assert.equal(resets, 1, "once only");
  assert.deepEqual(sent, [sig(txs[0]), sig(txs[1]), sig(txs[1])]);
  assert.equal(accepted, false);
});

test("slippage: a first transaction refused for slippage is sent again with every market reset at submit; a later one refused otherwise, or failed on-chain, isn't", async () => {
  const one = [tx(1)];
  let resets = 0;
  const first = fork({ send: () => (resets === 0 ? slipped() : Promise.resolve()), status: () => ok });
  assert.deepEqual(await resendOnce((rest) => sendBackToBack(first.conn, rest, 100, { accept: () => {} }), one, { stale: false, reset: async () => void resets++ }), one.map(sig));
  assert.deepEqual([resets, first.sent.length], [1, 2]);

  // Refused for something else after the first landed: no reset, nothing sent again.
  const txs = [tx(1), tx(2)];
  resets = 0;
  const other = fork({ send: (_, s) => (s === sig(txs[1]) && resets === 0 ? refused() : Promise.resolve()), status: () => ok });
  await assert.rejects(resendOnce((rest) => sendBackToBack(other.conn, rest, 100, { accept: () => {} }), txs, { stale: true, reset: async () => void resets++ }), (e: unknown) =>
    e instanceof SendFailed && e.refused && e.landed.length === 1);
  assert.deepEqual([resets, other.sent.length], [0, 2]);

  // A later one that was accepted, then landed with an error: never sent again.
  resets = 0;
  const failedOnChain = fork({ status: (s) => (s === sig(txs[1]) ? { err: { Custom: 6001 }, confirmationStatus: "confirmed" } : ok) });
  await assert.rejects(resendOnce((rest) => sendBackToBack(failedOnChain.conn, rest, 100, { accept: () => {} }), txs, { stale: true, reset: async () => void resets++ }), (e: unknown) =>
    e instanceof SendFailed && !e.refused && e.code === "transaction_failed");
  assert.equal(resets, 0);
});
