import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type BN from "bn.js";
import { Connection, type PublicKey } from "@solana/web3.js";
import idl from "../idl/thesis.json" with { type: "json" };
import {
  THESIS_PROGRAM_ID,
  decodeThesisStream,
  parseThesisEvents,
  thesisEventToJson,
  thesisTransactionEvents,
  thesisProgram,
  type ThesisStreamPayload,
} from "../src/index.ts";
import { EXAMPLE_PAYLOAD, FIXTURES, FIXTURES_DIR, FILTER_PATH, KEYS, loadFilter } from "./stream-fixtures.ts";

const program = thesisProgram(new Connection("http://127.0.0.1:8899"));
const filter = loadFilter();
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
const run = (name: string) => filter(fixture(name)) as ThesisStreamPayload | null;

const EXPECTED = [
  { instructions: ["create_take"], events: ["takeCreated", "positionOpened"] },
  { instructions: ["back"], events: ["positionOpened"] },
  // The author's sale closes the take.
  { instructions: ["exit_position"], events: ["positionExited", "takeClosed"] },
  // A partial sale, then its settlement.
  { instructions: ["sell_part"], events: ["positionPartSold"] },
  { instructions: ["settle_part"], events: ["partSettled"] },
  {
    instructions: ["settle_take", "settle_position", "mint_badge"],
    events: ["takeSettled", "positionSettled", "badgeMinted"],
  },
];

test("recorded fixtures match the generator", () => {
  // If this fails after an IDL change, run: node packages/chain/test/stream-fixtures.ts
  for (const [name, build] of Object.entries(FIXTURES)) {
    assert.deepEqual(fixture(name), JSON.parse(JSON.stringify(build())), name);
  }
  assert.deepEqual(fixture(EXAMPLE_PAYLOAD), JSON.parse(JSON.stringify(run("block.json"))));
});

test("filter keeps the program id and instruction table in sync with the IDL", () => {
  const source = readFileSync(FILTER_PATH, "utf8");
  assert.ok(source.includes(`const THESIS_PROGRAM_ID = "${THESIS_PROGRAM_ID.toBase58()}"`));
  for (const ix of idl.instructions) {
    assert.ok(source.includes(`"${ix.discriminator.join(",")}": "${ix.name}"`), `${ix.name} missing from the filter`);
  }
  const rows = source.match(/^\s+"[\d,]+": "\w+",$/gm) ?? [];
  assert.equal(rows.length, idl.instructions.length, "filter lists instructions the IDL doesn't have");
});

for (const name of Object.keys(FIXTURES)) {
  test(`filter + decoder on ${name}`, () => {
    const payload = run(name);
    assert.ok(payload);
    assert.equal(payload.programId, THESIS_PROGRAM_ID.toBase58());
    assert.equal(payload.batchStart, 380_000_000);

    // The transfer and the failed `back` are dropped; the six Thesis transactions stay.
    const txs = decodeThesisStream(program, payload);
    assert.deepEqual(
      txs.map((t) => ({ instructions: t.instructions, events: t.events.map((e) => e.name) })),
      EXPECTED,
    );
    assert.deepEqual(
      txs.map((t) => t.slot),
      [380_000_000, 380_000_001, 380_000_001, 380_000_001, 380_000_001, 380_000_001],
    );
    assert.ok(txs.every((t) => t.blockTime && t.signature.length > 80 && !t.logsTruncated));

    const [created, opened] = txs[0].events;
    assert.ok((created.data as { author: PublicKey }).author.equals(KEYS.author));
    assert.equal((opened.data as { stake: BN }).stake.toNumber(), 10_000_000);
    const closed = txs[2].events[1].data as { author: PublicKey; closedAt: BN };
    assert.ok(closed.author.equals(KEYS.author));
    assert.equal(closed.closedAt.toNumber(), 1_790_000_000);
    const part = txs[3].events[0].data as { seq: number; bps: number; stakeSold: BN; remainingStake: BN };
    assert.deepEqual([part.seq, part.bps, part.stakeSold.toNumber(), part.remainingStake.toNumber()], [0, 2_000, 5_000_000, 20_000_000]);
    const partSettled = txs[4].events[0].data as { seq: number; pnl: BN };
    assert.deepEqual([partSettled.seq, partSettled.pnl.toNumber()], [0, 400_000]);
    const settled = txs[5].events[1].data as { owner: PublicKey; pnl: BN; stake: BN };
    assert.ok(settled.owner.equals(KEYS.backer));
    assert.equal(settled.pnl.toNumber(), 3_125_000);
    assert.equal(settled.stake.toNumber(), 25_000_000);
  });
}

test("the payload's events are the transactions' own", () => {
  const block = fixture("block.json");
  const payload = run("block.json")!;
  const full = block.data
    .flatMap((b: { transactions: unknown[] }) => b.transactions)
    .filter((tx: { meta: { err: unknown } }) => tx.meta.err === null)
    .map((tx: any) => thesisTransactionEvents(program, tx))
    .filter((events: unknown[]) => events.length > 0);
  assert.equal(full.length, payload.transactions.length);
  assert.deepEqual(
    decodeThesisStream(program, payload).map((t) => t.events),
    full,
  );
  // Self-CPI events (create_take, the wrapped back) come in `events`; the old style in the logs.
  assert.deepEqual(payload.transactions.map((t) => t.events?.length ?? 0), [2, 1, 2, 1, 1, 0]);
  assert.equal(parseThesisEvents(program, payload.transactions[5].logs).length, 3);
  assert.ok(!payload.transactions[1].logs.some((l) => l.includes("swap noise")));
});

test("filter returns null for blocks without Thesis", () => {
  const block = fixture("block.json");
  block.data = [{ ...block.data[0], transactions: [block.data[0].transactions[0], block.data[0].transactions[2]] }];
  assert.equal(filter(block), null);
  assert.equal(filter({ data: [], metadata: {} }), null);
});

test("filter flags truncated logs, and self-CPI events survive them", () => {
  const block = fixture("block.json");
  const tx = block.data[0].transactions[1];
  tx.meta.logMessages = [...tx.meta.logMessages.slice(0, 4), "Log truncated"];
  block.data = [{ ...block.data[0], transactions: [tx] }];
  const payload = filter(block) as ThesisStreamPayload;
  assert.equal(payload.transactions[0].logsTruncated, true);
  assert.deepEqual(payload.transactions[0].instructions, ["create_take"]);
  const [decoded] = decodeThesisStream(program, payload);
  assert.deepEqual(decoded.events.map((e) => e.name), ["takeCreated", "positionOpened"]);
});

test("decoder accepts wrapped and string bodies, and rejects other programs", () => {
  const payload = run("block.json")!;
  const expected = decodeThesisStream(program, payload).length;
  assert.equal(decodeThesisStream(program, JSON.stringify(payload)).length, expected);
  assert.equal(decodeThesisStream(program, { data: [payload] }).length, expected);
  assert.equal(decodeThesisStream(program, null).length, 0);
  assert.throws(() => decodeThesisStream(program, { ...payload, programId: "11111111111111111111111111111111" }));
  assert.throws(() => decodeThesisStream(program, { hello: "world" }));
});

test("events convert to plain JSON rows", () => {
  const [tx] = decodeThesisStream(program, run("block.json"));
  const [created, opened] = tx.events.map(thesisEventToJson);
  assert.equal(created.name, "takeCreated");
  assert.deepEqual(
    { ...(created.data as object), claimHash: undefined },
    {
      take: KEYS.take.toBase58(),
      author: KEYS.author.toBase58(),
      claimHash: undefined,
      risk: "medium",
      horizonEnd: "1800000000",
      legs: 2,
      stake: "10000000",
      inverted: false,
    },
  );
  assert.equal((created.data as { claimHash: number[] }).claimHash.length, 32);
  assert.equal((opened.data as { side: string }).side, "back");
  assert.equal((opened.data as { scored: boolean }).scored, true);
});

// The Supabase webhook (supabase/functions/quicknode-stream) decodes with its own copy of the IDL
// and must produce exactly what this client does: the events it hands ingest_chain_events().
const WEBHOOK_EVENTS = join(FIXTURES_DIR, "webhook-events.expected.json");
const WEBHOOK_IDL = join(import.meta.dirname, "../../../supabase/functions/_shared/thesis-idl.json");

function webhookEvents(body: unknown) {
  return decodeThesisStream(program, body).flatMap((tx) =>
    tx.events.map((e, ordinal) => ({ signature: tx.signature, ordinal, slot: tx.slot, block_time: tx.blockTime, ...thesisEventToJson(e) })),
  );
}

test("the webhook's IDL copy matches the program's IDL", () => {
  assert.deepEqual(JSON.parse(readFileSync(WEBHOOK_IDL, "utf8")), idl, "copy packages/chain/idl/thesis.json to supabase/functions/_shared/thesis-idl.json");
});

test("the webhook's expected events match this client's decoding", () => {
  const got = webhookEvents(fixture("webhook-payload.example.json"));
  if (process.env.WRITE_FIXTURES) writeFileSync(WEBHOOK_EVENTS, JSON.stringify(got, null, 2) + "\n");
  assert.deepEqual(JSON.parse(readFileSync(WEBHOOK_EVENTS, "utf8")), got);
});
