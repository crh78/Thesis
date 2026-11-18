// Builds made ahead of the tap: prebuild, refresh (a fresh blockhash, no Jupiter call), and when
// market accounts are refreshed.
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { VersionedTransaction } from "@solana/web3.js";
import { ApiError } from "../api/common.ts";
import { PREBUILDS_PER_MINUTE, forkApiServer } from "../api/server.ts";
import { QUOTE_REFRESH_MS, type ForkService } from "../api/service.ts";
import { TAKE_ID, tradeFixture, type Status } from "./trade-fixture.ts";

const apiError = (status: number, code: string) => (e: unknown) => e instanceof ApiError && e.status === status && e.code === code;
const confirmed: Status = { err: null, confirmationStatus: "confirmed" };
const blockhashOf = (b64: string) => VersionedTransaction.deserialize(Buffer.from(b64, "base64")).message.recentBlockhash;

test("a build says when it expires and when it was quoted; a refresh keeps its id and quotes, with a fresh blockhash", async (t) => {
  const f = await tradeFixture(t, { status: () => confirmed });
  const before = Date.now();
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20, { prebuild: true });
  assert.ok(built.expiresAt > before && built.expiresAt <= Date.now() + 55_000);
  assert.ok(typeof built.quotedAt === "number" && built.quotedAt >= before);
  assert.ok(f.logs.some((l) => l.startsWith(`timing back build ${TAKE_ID.slice(0, 8)}`) && l.includes("jupiter lane 2, 0 calls")), "a prebuild is in Jupiter's prebuild lane, and says what it used");
  const fresh = await f.service.refreshBuild(built.buildId);
  assert.equal(fresh.buildId, built.buildId);
  assert.equal(fresh.quotedAt, built.quotedAt, "the same quotes");
  assert.ok(fresh.expiresAt >= built.expiresAt);
  assert.deepEqual((fresh as { included?: number[] }).included, built.included, "the same answer otherwise");
  assert.notEqual(blockhashOf(fresh.transactions[0]), blockhashOf(built.transactions[0]));
  assert.equal(built.prebuilt, true, "a prebuild says so");
  assert.equal((fresh as { prebuilt?: boolean }).prebuilt, true, "and its refresh too");
  const { signatures } = await f.service.submit(built.buildId, f.sign(fresh));
  assert.equal(signatures.length, 1);
  await assert.rejects(f.service.refreshBuild(built.buildId), apiError(410, "build_gone"), "submitted: gone");
  await assert.rejects(f.service.refreshBuild("00000000-0000-4000-8000-000000000001"), apiError(410, "build_gone"));
  const normal = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  assert.equal("prebuilt" in normal, false, "a tap-time build has no prebuilt");
});

test("a build reads every account its transactions touch before answering, so the send's preflight finds them held", async (t) => {
  const f = await tradeFixture(t, { status: () => confirmed });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20, { prebuild: true });
  const read = new Set(f.reads.flat());
  for (const b64 of built.transactions) {
    const keys = VersionedTransaction.deserialize(Buffer.from(b64, "base64")).message.staticAccountKeys.map(String);
    for (const k of keys) assert.ok(read.has(k), `${k} was read before the answer`);
  }
  assert.ok(f.logs.some((l) => l.startsWith(`timing back build ${TAKE_ID.slice(0, 8)}`) && l.includes("warm")), "the timing line shows the warm-up");
});

test("a refresh while the client signed: the bytes answered before it still submit, once; then the build is used", async (t) => {
  const f = await tradeFixture(t, { status: () => confirmed });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20, { prebuild: true });
  // The client signs the first build while the sheet's refresh runs.
  const signedEarly = f.sign(built);
  const fresh = await f.service.refreshBuild(built.buildId);
  const { signatures } = await f.service.submit(built.buildId, signedEarly);
  assert.equal(signatures.length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(blockhashOf(Buffer.from(f.sent[0].serialize()).toString("base64")), blockhashOf(built.transactions[0]), "the bytes it signed went out");
  assert.ok(f.sent[0].signatures.every((s) => s.some((b) => b !== 0)), "with the app payer's signature too");
  // The first submit used the build: the refreshed bytes are other bytes now.
  await assert.rejects(f.service.submit(built.buildId, f.sign(fresh)), apiError(409, "build_used"));
  assert.deepEqual(await f.service.submit(built.buildId, signedEarly), { status: "landed", buildId: built.buildId, signatures }, "the same bytes again: its status");
  assert.equal(f.sent.length, 1);
});

test("after two refreshes only the last two answers submit; something else is transaction_changed", async (t) => {
  const f = await tradeFixture(t, { status: () => confirmed });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20, { prebuild: true });
  await f.service.refreshBuild(built.buildId);
  await f.service.refreshBuild(built.buildId);
  await assert.rejects(f.service.submit(built.buildId, f.sign(built)), apiError(400, "transaction_changed"), "two refreshes ago");
  assert.equal(f.sent.length, 0);
});

test("a refresh past QUOTE_REFRESH_MS is quote_stale: the client builds again", async (t) => {
  const f = await tradeFixture(t);
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(QUOTE_REFRESH_MS + 1_000);
  await assert.rejects(f.service.refreshBuild(built.buildId), apiError(409, "quote_stale"));
});

test("a submit leaves market accounts refreshed in the last minute; a prebuilt build's admit says so before anything is sent", async (t) => {
  const f = await tradeFixture(t, { status: () => confirmed });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20, { prebuild: true });
  const seen: unknown[] = [];
  await assert.rejects(f.service.submit(built.buildId, f.sign(built), { admit: (b) => {
    seen.push(b);
    throw new ApiError(429, "rate_limited");
  } }), apiError(429, "rate_limited"));
  assert.deepEqual(seen, [{ owner: f.wallet, kind: "back", prebuilt: true }]);
  assert.equal(f.sent.length, 0, "refused before sending");
  // Still the build's to submit once the limit allows.
  await f.service.submit(built.buildId, f.sign(built), { admit: () => {} });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.refreshed.at(-1)?.freshMs, 60_000);
});

test("server: a prebuild checks who's asking without a money action, counts it at submit, and has its own window", async (t) => {
  const calls: string[] = [];
  const guard = {
    checkRead: () => {},
    build: <T>(work: () => Promise<T>) => work(),
    checkMoney: async () => void calls.push("money"),
    checkAuth: async () => void calls.push("auth"),
    countMoney: (wallet: string) => void calls.push(`count ${wallet}`),
  };
  const service = {
    buildTrade: async (_t: string, _o: string, _s: string, _u: number, o: { prebuild?: boolean }) => ({ buildId: "b", prebuild: o.prebuild }),
    submit: async (_id: string, _txs: string[], o: { admit?: (b: { owner: string; kind: string; prebuilt: boolean }) => void }) => {
      o.admit?.({ owner: "W", kind: "back", prebuilt: true });
      o.admit?.({ owner: "X", kind: "back", prebuilt: false });
      return { signatures: [] };
    },
    refreshBuild: async (id: string) => ({ buildId: id }),
  } as unknown as ForkService;
  const server = forkApiServer(service, () => {}, { guard: guard as never });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = "11111111111111111111111111111111";
  const trade = (body: Record<string, unknown>) =>
    fetch(`${url}/takes/00000000-0000-4000-8000-0000000000aa/trades`, { method: "POST", body: JSON.stringify({ owner, side: "back", usd: 10, ...body }) });

  assert.equal((await (await trade({ prebuild: true })).json() as { prebuild: boolean }).prebuild, true);
  assert.deepEqual(calls.splice(0), ["auth"]);
  await trade({});
  assert.deepEqual(calls.splice(0), ["money"], "a tap-time build is a money action, as before");
  await fetch(`${url}/submit`, { method: "POST", body: JSON.stringify({ buildId: "b", transactions: [] }) });
  assert.deepEqual(calls.splice(0), ["count W"], "only the prebuilt build counts at submit");
  for (let i = 1; i < PREBUILDS_PER_MINUTE; i++) assert.equal((await trade({ prebuild: true })).status, 200);
  const over = await trade({ prebuild: true });
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get("retry-after")) > 0);
  const refresh = await fetch(`${url}/builds/00000000-0000-4000-8000-0000000000bb/refresh`, { method: "POST" });
  assert.equal(refresh.status, 200);
  assert.match(refresh.headers.get("server-timing") ?? "", /total;dur=/);
  assert.equal((await fetch(`${url}/builds/nope/refresh`, { method: "POST" })).status, 400);
});

test("server: without a guard that can defer the money action, a prebuild is a normal build and its answer has no prebuilt", async (t) => {
  const f = await tradeFixture(t);
  const calls: string[] = [];
  // A guard with checkMoney only (an older one): it can't check a caller without counting.
  const guard = { checkRead: () => {}, build: <T>(work: () => Promise<T>) => work(), checkMoney: async () => void calls.push("money") };
  for (const g of [guard, undefined]) {
    const server = forkApiServer(f.service, () => {}, { guard: g as never });
    server.listen(0, "127.0.0.1");
    t.after(() => server.close());
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/takes/${TAKE_ID}/trades`, { method: "POST", body: JSON.stringify({ owner: f.wallet, side: "back", usd: 20, prebuild: true }) });
    assert.equal(res.status, 200);
    const body = await res.json() as { buildId: string; prebuilt?: boolean };
    assert.equal("prebuilt" in body, false, "the apps see no prebuilt, and build at the tap");
    assert.ok(f.logs.some((l) => l.startsWith(`timing back build ${TAKE_ID.slice(0, 8)}`) && l.includes("jupiter lane 1")), "built in the tap lane");
    f.logs.length = 0;
  }
  assert.deepEqual(calls, ["money"], "counted as a money action now");
});

test("server: with a guard that defers the money action, a prebuild's answer says prebuilt: true", async (t) => {
  const f = await tradeFixture(t);
  const guard = { checkRead: () => {}, build: <T>(work: () => Promise<T>) => work(), checkMoney: async () => assert.fail("not a money action"), checkAuth: async () => {}, countMoney: () => {} };
  const server = forkApiServer(f.service, () => {}, { guard: guard as never });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${url}/takes/${TAKE_ID}/trades`, { method: "POST", body: JSON.stringify({ owner: f.wallet, side: "back", usd: 20, prebuild: true }) });
  const body = await res.json() as { buildId: string; prebuilt?: boolean };
  assert.equal(body.prebuilt, true);
  const refreshed = await (await fetch(`${url}/builds/${body.buildId}/refresh`, { method: "POST" })).json() as { prebuilt?: boolean };
  assert.equal(refreshed.prebuilt, true);
});
