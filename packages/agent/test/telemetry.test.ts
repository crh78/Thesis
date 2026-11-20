import { test } from "node:test";
import assert from "node:assert/strict";
import { botEvents } from "../src/telemetry.ts";

const cfg = { draftsUrl: "https://x.supabase.co/functions/v1/source/drafts", botSecret: "s" };

test("events go out in batches to /source/bot-events with the bot secret", async () => {
  const calls: { url: string; secret: string | null; body: { bot: string; events: { event: string; ref?: string }[] } }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, secret: new Headers(init.headers).get("x-bot-secret"), body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const r = botEvents("x", cfg, { fetch: fake });
  for (let i = 0; i < 150; i++) r.record("replied", { ref: String(i), what: "take" });
  await r.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://x.supabase.co/functions/v1/source/bot-events");
  assert.equal(calls[0].secret, "s");
  assert.equal(calls[0].body.bot, "x");
  assert.equal(calls[0].body.events.length, 100);
  assert.equal(calls[1].body.events[49].ref, "149");
  await r.flush();
  assert.equal(calls.length, 2, "nothing left to send");
});

test("a failed send keeps the events; a 4xx drops them; nothing throws", async () => {
  let status = 0;
  const sent: number[] = [];
  const fake = (async (_u: string, init: RequestInit) => {
    if (status === 0) throw new Error("down");
    sent.push(JSON.parse(String(init.body)).events.length);
    return new Response("", { status });
  }) as typeof fetch;
  const errors: string[] = [];
  const r = botEvents("x", cfg, { fetch: fake, onError: (m) => errors.push(m) });
  r.record("skip");
  r.record("replied");
  await r.flush(); // unreachable: kept
  status = 503;
  await r.flush(); // 5xx: kept
  status = 200;
  await r.flush();
  assert.deepEqual(sent, [2, 2]);
  r.record("skip");
  status = 404;
  await r.flush(); // dropped
  status = 200;
  await r.flush();
  assert.deepEqual(sent, [2, 2, 1]);
  assert.equal(errors.length, 3);
});

test("without a config it records nothing", async () => {
  const r = botEvents("x", null);
  r.record("replied");
  await r.flush();
});
