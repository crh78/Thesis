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
  const fresh = await f.service.refreshBuild(built.buildId);
  assert.equal(fresh.buildId, built.buildId);
  assert.equal(fresh.quotedAt, built.quotedAt, "the same quotes");
  assert.ok(fresh.expiresAt >= built.expiresAt);
  assert.deepEqual((fresh as { included?: number[] }).included, built.included, "the same answer otherwise");
  assert.notEqual(blockhashOf(fresh.transactions[0]), blockhashOf(built.transactions[0]));
  // What was answered before can't be sent any more; the refreshed transactions can.
  await assert.rejects(f.service.submit(built.buildId, f.sign(built)), apiError(400, "transaction_changed"));
  const { signatures } = await f.service.submit(built.buildId, f.sign(fresh));
  assert.equal(signatures.length, 1);
  await assert.rejects(f.service.refreshBuild(built.buildId), apiError(410, "build_gone"), "submitted: gone");
  await assert.rejects(f.service.refreshBuild("00000000-0000-4000-8000-000000000001"), apiError(410, "build_gone"));
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
