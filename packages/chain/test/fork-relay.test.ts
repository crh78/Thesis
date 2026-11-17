// The fork relay (infra/quicknode/fork-relay.ts) on logs notifications recorded from a Surfpool
// mainnet fork: a create_take and a back sent by `pnpm fork:smoke`. Checks that the relay builds
// the same payload shape as the QuickNode filter and that decodeThesisStream reads it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type BN from "bn.js";
import { Connection, type PublicKey } from "@solana/web3.js";
import {
  FORK_NETWORK,
  loadFilter,
  quicknodeHeaders,
  relayPayload,
  type LogsNotification,
  type RpcTransaction,
} from "../../../infra/quicknode/fork-relay.ts";
import { THESIS_PROGRAM_ID, decodeThesisStream, thesisEventToJson, thesisProgram, type ThesisStreamPayload } from "../src/index.ts";
import { FIXTURES_DIR } from "./stream-fixtures.ts";

const program = thesisProgram(new Connection("http://127.0.0.1:8899"));
const filter = loadFilter();
const { recordings } = JSON.parse(readFileSync(join(FIXTURES_DIR, "fork-logs-notifications.json"), "utf8")) as {
  recordings: { notification: LogsNotification; transaction: RpcTransaction }[];
};
const [createRec, backRec] = recordings;

test("relay subscribes to the program id in the QuickNode filter", () => {
  assert.equal(filter.programId, THESIS_PROGRAM_ID.toBase58());
});

test("relayed create_take and back decode like Stream payloads", () => {
  const payloads = recordings.map((r) => relayPayload(filter, r.notification, r.transaction) as ThesisStreamPayload);
  for (const [i, payload] of payloads.entries()) {
    const { notification, transaction } = recordings[i];
    assert.deepEqual(Object.keys(payload), ["programId", "network", "batchStart", "batchEnd", "blocksReorged", "transactions"]);
    assert.equal(payload.programId, THESIS_PROGRAM_ID.toBase58());
    assert.equal(payload.network, FORK_NETWORK);
    assert.equal(payload.batchStart, transaction.slot);
    assert.equal(payload.batchEnd, transaction.slot);
    assert.equal(payload.transactions.length, 1);
    const [tx] = payload.transactions;
    assert.equal(tx.signature, notification.value.signature);
    assert.equal(tx.slot, transaction.slot);
    assert.equal(tx.blockTime, transaction.blockTime);
    assert.ok(!("logsTruncated" in tx));
  }

  const [created, backed] = payloads.flatMap((p) => decodeThesisStream(program, p));
  assert.deepEqual(created.instructions, ["create_take"]);
  assert.deepEqual(created.events.map((e) => e.name), ["takeCreated", "positionOpened"]);
  assert.deepEqual(backed.instructions, ["back"]);
  assert.deepEqual(backed.events.map((e) => e.name), ["positionOpened"]);

  const take = (created.events[0].data as { take: PublicKey }).take;
  const back = backed.events[0].data as { take: PublicKey; stake: BN; fee: BN; creatorFee: BN };
  assert.ok(back.take.equals(take));
  assert.equal(back.stake.toNumber(), 25_000_000);
  assert.equal(back.fee.toNumber(), 25_000);
  assert.equal(back.creatorFee.toNumber(), 12_500);
  assert.equal((thesisEventToJson(created.events[0]).data as { risk: string }).risk, "medium");
});

test("without the transaction, the relay falls back to the logs and still decodes events", () => {
  const payload = relayPayload(filter, createRec.notification, null) as ThesisStreamPayload;
  const [tx] = decodeThesisStream(program, payload);
  assert.equal(tx.signature, createRec.notification.value.signature);
  assert.equal(tx.slot, createRec.notification.context.slot);
  assert.equal(tx.blockTime, null);
  assert.deepEqual(tx.instructions, []);
  assert.deepEqual(tx.events.map((e) => e.name), ["takeCreated", "positionOpened"]);
});

test("failed transactions are dropped, like on the Stream", () => {
  const failedNote = { ...backRec.notification, value: { ...backRec.notification.value, err: { InstructionError: [0, "Custom"] } } };
  const failedTx = { ...backRec.transaction, meta: { ...backRec.transaction.meta!, err: { InstructionError: [0, "Custom"] } } };
  assert.equal(relayPayload(filter, failedNote, failedTx), null);
  assert.equal(relayPayload(filter, failedNote, null), null);
});

test("webhook headers carry a QuickNode-style HMAC when a token is set", async () => {
  const { createHmac } = await import("node:crypto");
  const payload = relayPayload(filter, createRec.notification, createRec.transaction);
  const body = JSON.stringify(payload);
  const h = quicknodeHeaders(body, payload, "secret");
  const expected = createHmac("sha256", "secret").update(h["x-qn-nonce"] + h["x-qn-timestamp"] + body).digest("hex");
  assert.equal(h["x-qn-signature"], expected);
  assert.equal(h["stream-network"], FORK_NETWORK);
  assert.ok(!("x-qn-signature" in quicknodeHeaders(body, payload)));
});
