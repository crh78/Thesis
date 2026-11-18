// Accept-then-confirm submits (until: "accepted"), GET /submissions, and repeats of a submit.
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { forkApiServer } from "../api/server.ts";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { ApiError } from "../api/common.ts";
import { ForkService } from "../api/service.ts";
import { TAKE_ID, tick, tradeFixture, type Status } from "./trade-fixture.ts";

const apiError = (status: number, code: string) => (e: unknown) => e instanceof ApiError && e.status === status && e.code === code;
const confirmed: Status = { err: null, confirmationStatus: "confirmed" };

test("a back's build needs no Jupiter call for a card leg, and its submit by default answers once landed", async (t) => {
  const f = await tradeFixture(t, { status: () => confirmed });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  assert.equal(built.transactions.length, 1);
  assert.deepEqual(built.included, [0]);
  assert.equal(built.escrowUsd, 20);
  const { signatures } = await f.service.submit(built.buildId, f.sign(built));
  assert.deepEqual(signatures, f.sigs());
  assert.ok(f.logs.some((l) => l.startsWith(`timing back build ${TAKE_ID.slice(0, 8)} ${built.buildId.slice(0, 8)} `)), "the build logged its steps");
  assert.ok(f.logs.some((l) => l.startsWith(`timing back submit ${built.buildId.slice(0, 8)} `)));
});

test("a repeat of a submit is the same submit: same answer, nothing sent twice; other bytes are build_used", async (t) => {
  const f = await tradeFixture(t, { status: () => confirmed });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  const signed = f.sign(built);
  const first = await f.service.submit(built.buildId, signed);
  const again = await f.service.submit(built.buildId, signed, { clientTimings: { shown: 420 } });
  assert.deepEqual(again.signatures, first.signatures);
  assert.equal(again.status, "landed");
  assert.equal(f.sent.length, 1, "sent once");
  assert.ok(f.logs.some((l) => l === `client timings ${built.buildId.slice(0, 8)} (back): shown 420`), "a repeat's marks are logged too");
  // Unsigned (other bytes) for the same build.
  await assert.rejects(f.service.submit(built.buildId, built.transactions), apiError(409, "build_used"));
});

test("until accepted: answers pending once the fork accepted it, then lands in the background", async (t) => {
  let landed = false;
  const f = await tradeFixture(t, { status: () => (landed ? confirmed : null) });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  const signed = f.sign(built);
  const r = await f.service.submit(built.buildId, signed, { until: "accepted" });
  assert.deepEqual(r, { status: "pending", buildId: built.buildId, signatures: f.sigs() });
  assert.equal((f.sent[0] as unknown as VersionedTransaction) !== undefined, true);
  assert.equal((await f.service.submission(built.buildId)).status, "pending");
  // A repeat while it's pending answers pending too, without sending again.
  assert.equal((await f.service.submit(built.buildId, signed, { until: "accepted" })).status, "pending");
  assert.equal(f.sent.length, 1);
  landed = true;
  const done = await f.service.submission(built.buildId, 5_000);
  assert.deepEqual(done, { buildId: built.buildId, status: "landed", signatures: f.sigs() });
  // The bookkeeping ran after the answer: the position's opening transaction is recorded.
  f.service.flush();
  await assert.rejects(f.service.submission("00000000-0000-4000-8000-000000000000"), apiError(404, "no_such_submission"));
});

test("until accepted: preflight at processed; a refusal answers as today, before anything is accepted", async (t) => {
  const seen: unknown[] = [];
  const f = await tradeFixture(t, {
    send: async (_tx, opts) => {
      seen.push(opts);
      throw Object.assign(new Error("Transaction simulation failed: custom program error: 0x1"), { logs: ["Program log: Error Code: StakeTooSmall"] });
    },
  });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  await assert.rejects(f.service.submit(built.buildId, f.sign(built), { until: "accepted" }), apiError(502, "send_failed"));
  assert.deepEqual(seen, [{ skipPreflight: false, preflightCommitment: "processed" }]);
  const view = await f.service.submission(built.buildId);
  assert.equal(view.status, "failed");
  assert.equal(view.error?.code, "send_failed");
  // A repeat gets the same refusal.
  await assert.rejects(f.service.submit(built.buildId, f.sign(built), { until: "accepted" }), apiError(502, "send_failed"));
});

test("until accepted: a transaction that lands with an error reads failed, with its error", async (t) => {
  let seen = false;
  const f = await tradeFixture(t, { status: () => (seen ? { err: { InstructionError: [2, { Custom: 1 }] }, confirmationStatus: "confirmed" } : null) });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  assert.equal((await f.service.submit(built.buildId, f.sign(built), { until: "accepted" })).status, "pending");
  seen = true;
  const view = await f.service.submission(built.buildId, 5_000);
  assert.equal(view.status, "failed");
  assert.equal(view.error?.code, "transaction_failed");
});

test("a submit pending at a restart is answered from its transactions on-chain", async (t) => {
  let landed = false;
  const f = await tradeFixture(t, { status: () => (landed ? confirmed : null) });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  const signed = f.sign(built);
  await f.service.submit(built.buildId, signed, { until: "accepted" });
  f.service.flush();
  // A new process on the same state file: the submit isn't in memory any more.
  const restarted = new ForkService(f.options);
  assert.equal((await restarted.submission(built.buildId)).status, "pending", "nothing on-chain yet");
  landed = true;
  assert.equal((await restarted.submission(built.buildId)).status, "landed");
  assert.equal((await restarted.submit(built.buildId, signed)).status, "landed", "a repeat after the restart");
  await assert.rejects(restarted.submit(built.buildId, built.transactions), apiError(409, "build_used"));
});

test("until accepted: the abandoned-ticket cleanup goes out only after the trade confirmed", async (t) => {
  let landed = false;
  const other = Keypair.generate().publicKey;
  const f = await tradeFixture(t, { status: () => (landed ? confirmed : null), tickets: [other] });
  const first = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  assert.equal(first.transactions.length, 2, "the trade, then the cleanup of the other ticket");
  await f.service.submit(first.buildId, f.sign(first), { until: "accepted" });
  await tick();
  assert.equal(f.sent.length, 1, "the cleanup waits for the trade to confirm");
  landed = true;
  await f.service.submission(first.buildId, 5_000);
  await tick(20);
  assert.equal(f.sent.length, 2, "then it's sent");
});

test("drain waits for submits still confirming, then writes the state file", async (t) => {
  let landed = false;
  const f = await tradeFixture(t, { status: () => (landed ? confirmed : null) });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  await f.service.submit(built.buildId, f.sign(built), { until: "accepted" });
  let drained = false;
  const d = f.service.drain(5_000).then(() => (drained = true));
  await tick();
  assert.equal(drained, false);
  landed = true;
  await d;
  assert.equal((await f.service.submission(built.buildId)).status, "landed");
});

test("over HTTP: 202 pending from a text/plain submit, then GET /submissions waits until it landed", async (t) => {
  let landed = false;
  const f = await tradeFixture(t, { status: () => (landed ? confirmed : null) });
  const server = forkApiServer(f.service);
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  const r = await fetch(`${url}/submit`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ buildId: built.buildId, transactions: f.sign(built), until: "accepted" }),
  });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { status: "pending", buildId: built.buildId, signatures: f.sigs() });
  setTimeout(() => (landed = true), 50);
  const watched = await fetch(`${url}/submissions/${built.buildId}?wait=5000`);
  assert.equal(watched.status, 200);
  assert.equal(((await watched.json()) as { status: string }).status, "landed");
  assert.equal((await fetch(`${url}/submissions/not-a-uuid`)).status, 400);
  const bad = await fetch(`${url}/submit`, { method: "POST", body: JSON.stringify({ buildId: built.buildId, transactions: [], until: "later" }) });
  assert.equal(bad.status, 400);
});

test("builds that read what a trade left (a sale, a retry or sweep, a cash-out) wait for the owner's submits still confirming", async (t) => {
  let landed = false;
  const f = await tradeFixture(t, { status: () => (landed ? confirmed : null) });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  await f.service.submit(built.buildId, f.sign(built), { until: "accepted" });
  let settled = false;
  const retry = f.service.buildRetry(f.wallet).finally(() => (settled = true));
  await tick();
  assert.equal(settled, false, "waiting for the back to confirm");
  landed = true;
  await assert.rejects(retry, apiError(404, "incomplete_missing"));
});
