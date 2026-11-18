// Where a build's or submit's time went: per-step timings, logged and sent as Server-Timing.
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Timings, clientMarks } from "../api/common.ts";
import { forkApiServer } from "../api/server.ts";
import type { ForkService } from "../api/service.ts";

test("timings add up per step, survive a throw, and read as a log line and a Server-Timing header", async () => {
  let now = 1_000;
  const t = new Timings(() => now);
  t.add("funds", 12);
  await t.time("legs", async () => (now += 800));
  await assert.rejects(t.time("compose", async () => {
    now += 30;
    throw new Error("boom");
  }));
  t.add("legs", 5.4);
  t.note("quotes", "hit");
  now += 3;
  assert.deepEqual(t.steps, { funds: 12, legs: 805, compose: 30 });
  assert.equal(t.line(), "833 ms: funds 12, legs 805, compose 30 (quotes hit)");
  assert.equal(t.header(), 'funds;dur=12, legs;dur=805, compose;dur=30, quotes;desc="hit", total;dur=833');
  // Names become header tokens; quotes and line breaks never reach a description.
  const odd = new Timings(() => 0);
  odd.add("send 2", 4);
  odd.note("why", 'a "b"\nc');
  assert.equal(odd.header(), 'send-2;dur=4, why;desc="a bc", total;dur=0');
});

test("client marks: finite numbers under plain names, at most 24, nothing else", () => {
  assert.equal(clientMarks(undefined), null);
  assert.equal(clientMarks([1, 2]), null);
  assert.equal(clientMarks({ build: 812.4, sign: 140, shown: 455.6 }), "build 812, sign 140, shown 456");
  assert.equal(clientMarks({ "bad name\n": 1, ok: "12", nan: Number.NaN, x: 1 }), "x 1");
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`m${i}`, i]));
  assert.equal(clientMarks(many)!.split(", ").length, 24);
});

test("server: builds and submits answer with Server-Timing; a submit's client marks reach the service", async (t) => {
  const calls: unknown[] = [];
  const service = {
    buildTrade: async (_take: string, _owner: string, _side: string, _usd: number, o: { timings: Timings }) => {
      o.timings.add("legs", 7);
      return { buildId: "b1", transactions: [] };
    },
    submit: async (_id: string, _txs: string[], o: { timings: Timings; clientTimings: unknown }) => {
      calls.push(o.clientTimings);
      o.timings.add("send", 3);
      return { signatures: [] };
    },
    wallet: async () => ({ usdc: 0 }),
  } as unknown as ForkService;
  const server = forkApiServer(service);
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const owner = "11111111111111111111111111111111";
  const build = await fetch(`${url}/takes/00000000-0000-4000-8000-0000000000aa/trades`, {
    method: "POST",
    body: JSON.stringify({ owner, side: "back", usd: 10 }),
  });
  assert.equal(build.status, 200);
  assert.match(build.headers.get("server-timing") ?? "", /^legs;dur=7, total;dur=\d+$/);

  // A CORS simple request: text/plain, no auth header.
  const submit = await fetch(`${url}/submit`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ buildId: "b1", transactions: [], timings: { build: 800, sign: 150 } }),
  });
  assert.equal(submit.status, 200);
  assert.match(submit.headers.get("server-timing") ?? "", /^send;dur=3, total;dur=\d+$/);
  assert.deepEqual(calls, [{ build: 800, sign: 150 }]);

  const read = await fetch(`${url}/wallets/${owner}`);
  assert.equal(read.headers.get("server-timing"), null, "reads don't time themselves");
});
