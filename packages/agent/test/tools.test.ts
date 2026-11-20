import assert from "node:assert/strict";
import { test } from "node:test";
import { runTradeTool } from "../src/tools.ts";
import { agentApi, draftIdFrom, takeIdFrom } from "../src/trade.ts";

const TAKE = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

/** An agent API over a fake fetch that records the calls and answers from `reply`. */
function fake(reply: (path: string, body: Record<string, unknown>) => { status: number; body: unknown }) {
  const calls: { path: string; body: Record<string, unknown>; secret: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const path = url.split("/agent/")[1];
    const body = JSON.parse(String(init.body));
    calls.push({ path, body, secret: (init.headers as Record<string, string>)["x-bot-secret"] });
    const r = reply(path, body);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { api: agentApi({ agentUrl: "https://x.test/functions/v1/agent", botSecret: "s3cret" }, f), calls };
}

test("ids from links", () => {
  assert.equal(takeIdFrom(`https://yourthesis.xyz/t/${TAKE.toUpperCase()}`), TAKE);
  assert.equal(takeIdFrom("jake's take"), null);
  assert.equal(draftIdFrom("https://yourthesis.xyz/d/Ab3dEf7h"), "Ab3dEf7h");
  assert.equal(draftIdFrom("Ab3dEf7h"), "Ab3dEf7h");
  assert.equal(draftIdFrom("nope"), null);
});

test("back: keyed on the message, the take from its link, the take's link for the reply", async () => {
  const { api, calls } = fake(() => ({ status: 200, body: { status: "landed", take_id: TAKE, url: `https://w/t/${TAKE}`, usd: 50, signatures: ["sig"] } }));
  const out = await runTradeTool(api, { imessage: "+15555550100" }, "msg-1", "back_take", { take: `https://yourthesis.xyz/t/${TAKE}`, usd: 50 });
  assert.deepEqual(calls[0].body, { who: { imessage: "+15555550100" }, surface: "imessage", ref: `msg-1:back_take:${TAKE}`, action: "back", take_id: TAKE, usd: 50 });
  assert.equal(calls[0].secret, "s3cret");
  assert.equal(out.output.status, "landed");
  assert.equal(out.link, `https://w/t/${TAKE}`);
  assert.deepEqual(out.take, { id: TAKE });
});

test("an unlinked sender gets a one-time connect link instead of a trade", async () => {
  const { api, calls } = fake((path) => path === "trades"
    ? { status: 403, body: { error: "not_linked" } }
    : { status: 200, body: { url: "https://w/limits?link=tok" } });
  const out = await runTradeTool(api, { imessage: "+15555550100" }, "msg-2", "fade_take", { take: TAKE, usd: 25 });
  assert.deepEqual(calls.map((c) => c.path), ["trades", "links"]);
  assert.deepEqual(calls[1].body, { imessage: "+15555550100" });
  assert.equal(out.output.error, "not_linked");
  assert.equal(out.link, "https://w/limits?link=tok");
});

test("over the limit: the limit, what's left, and the link to do it by hand", async () => {
  const { api } = fake(() => ({ status: 403, body: { error: "over_trade_limit", per_trade_usd: 50, left_usd: 200, confirm_url: `https://w/t/${TAKE}` } }));
  const out = await runTradeTool(api, { imessage: "+15555550100" }, "m", "back_take", { take: TAKE, usd: 500 });
  assert.deepEqual(out.output, { error: "over_trade_limit", per_trade_limit_usd: 50, left_today_usd: 200 });
  assert.equal(out.link, `https://w/t/${TAKE}`);
});

test("sell: a percent becomes bps, all of it sends neither, and no take means no call", async () => {
  const { api, calls } = fake(() => ({ status: 200, body: { status: "pending", take_id: TAKE, url: "u", usd: null, closes_take: true } }));
  await runTradeTool(api, { imessage: "+1" }, "m", "sell_position", { take: TAKE, side: "fade", percent: 50, usd: null });
  await runTradeTool(api, { imessage: "+1" }, "m2", "sell_position", { take: TAKE, side: "back", percent: null, usd: null });
  await runTradeTool(api, { imessage: "+1" }, "m3", "sell_position", { take: TAKE, side: "back", percent: null, usd: 30 });
  assert.equal(calls[0].body.bps, 5000);
  assert.equal(calls[0].body.side, "fade");
  assert.equal("bps" in calls[1].body || "usd" in calls[1].body, false);
  assert.equal(calls[2].body.usd, 30);
  const none = await runTradeTool(api, { imessage: "+1" }, "m4", "sell_position", { take: "the nuclear one", side: "back", percent: null, usd: null });
  assert.equal(none.output.error, "unknown_take");
  assert.equal(calls.length, 3);
});

test("post: a draft and at least $10", async () => {
  const { api, calls } = fake(() => ({ status: 200, body: { status: "landed", take_id: TAKE, url: "u", usd: 20 } }));
  assert.equal((await runTradeTool(api, { imessage: "+1" }, "m", "post_take", { draft_id: "Ab3dEf7h", usd: 5 })).output.error, "minimum_is_10_usd");
  await runTradeTool(api, { imessage: "+1" }, "m", "post_take", { draft_id: "https://w/d/Ab3dEf7h", usd: 20 });
  assert.deepEqual(calls[0].body, { who: { imessage: "+1" }, surface: "imessage", ref: "m:post_take:Ab3dEf7h", action: "post", draft_id: "Ab3dEf7h", usd: 20 });
});
