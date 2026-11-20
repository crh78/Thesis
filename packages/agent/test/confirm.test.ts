import assert from "node:assert/strict";
import { test } from "node:test";
import { askText, CONFIRM_TTL_MS, prepareTrade, resultText, runConfirmed, yesNo } from "../src/confirm.ts";
import type { AgentApi, TradeAsk, TradeResult, WhoIs } from "../src/trade.ts";

const TAKE = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const WEB = "https://yourthesis.xyz";
const who = { imessage: "+15555550100" };
const linked: WhoIs = { linked: true, active: true, handle: "chris", per_trade_usd: 100, daily_usd: 250, left_usd: 200 };

function api(o: { whois?: WhoIs; trade?: (ask: TradeAsk, opts: unknown) => TradeResult; take?: { claim: string; author: string | null } | null } = {}) {
  const calls: string[] = [];
  const trades: { ref: string | null; ask: TradeAsk; opts: unknown }[] = [];
  const a = {
    whois: async () => { calls.push("whois"); return o.whois ?? linked; },
    connectLink: async () => { calls.push("links"); return `${WEB}/limits?link=tok`; },
    takeInfo: async () => { calls.push("takes"); return o.take === undefined ? { claim: "Gold to 5k", author: "jake" } : o.take; },
    positions: async () => { calls.push("positions"); return []; },
    trade: async (_w: unknown, _s: unknown, ref: string | null, ask: TradeAsk, opts: unknown) => {
      calls.push("trade"); trades.push({ ref, ask, opts });
      return o.trade ? o.trade(ask, opts) : { ok: true, status: "pending", takeId: TAKE, url: `${WEB}/t/${TAKE}`, usd: null, closesTake: false, existing: false } as TradeResult;
    },
  } as unknown as AgentApi;
  return { a, calls, trades };
}

test("yes and no in their usual forms", () => {
  for (const t of ["yes", "Yes!", "y", "yep", "confirm", "do it", "👍", "ok."]) assert.equal(yesNo(t), "yes", t);
  for (const t of ["no", "Nope", "cancel", "nah", "never mind"]) assert.equal(yesNo(t), "no", t);
  for (const t of ["yes but only $20", "back jake for $50", ""]) assert.equal(yesNo(t), null, t);
});

test("a back is set up, not traded: the ask names the take, its author and the amount", async () => {
  const { a, calls } = api();
  const out = await prepareTrade(a, who, "msg-1", "back_take", { take: `${WEB}/t/${TAKE}`, usd: 50 }, new Map(), WEB, 1000);
  assert.equal(out.kind, "pending");
  assert.ok(out.kind === "pending");
  assert.equal(askText(out.pending), `On it. Like this message or reply yes to confirm: back @jake's take "Gold to 5k" with $50.`);
  assert.deepEqual(out.pending.ask, { action: "back", takeId: TAKE, usd: 50 });
  assert.equal(out.pending.ref, "msg-1:back_take");
  assert.equal(out.pending.expiresAt, 1000 + CONFIRM_TTL_MS);
  assert.equal(calls.includes("trade"), false);
});

test("a post uses the claim the chat already knows", async () => {
  const { a } = api();
  const out = await prepareTrade(a, who, "m", "post_take", { draft_id: "Ab3dEf7h", usd: 20 }, new Map([["Ab3dEf7h", "NVIDIA keeps winning"]]), WEB);
  assert.ok(out.kind === "pending");
  assert.equal(out.pending.summary, `post "NVIDIA keeps winning" as your take with $20`);
});

test("over a limit or not connected answers now, with the right link", async () => {
  const over = await prepareTrade(api().a, who, "m", "back_take", { take: TAKE, usd: 150 }, new Map(), WEB);
  assert.ok(over.kind === "done");
  assert.equal(over.output.error, "over_trade_limit");
  assert.equal(over.link, `${WEB}/t/${TAKE}`);
  const day = await prepareTrade(api({ whois: { ...linked, left_usd: 30 } }).a, who, "m", "fade_take", { take: TAKE, usd: 50 }, new Map(), WEB);
  assert.ok(day.kind === "done" && day.output.error === "over_daily_limit");
  const { a, calls } = api({ whois: { linked: false } });
  const nl = await prepareTrade(a, who, "m", "post_take", { draft_id: "Ab3dEf7h", usd: 20 }, new Map(), WEB);
  assert.ok(nl.kind === "done" && nl.output.error === "not_linked");
  assert.equal(nl.link, `${WEB}/limits?link=tok`);
  assert.ok(calls.includes("links"));
});

test("an unknown take asks for its link; sales skip the limits", async () => {
  const unknown = await prepareTrade(api({ take: null }).a, who, "m", "back_take", { take: TAKE, usd: 20 }, new Map(), WEB);
  assert.ok(unknown.kind === "done" && unknown.output.error === "unknown_take");
  const sell = await prepareTrade(api({ whois: { ...linked, left_usd: 0 } }).a, who, "m", "sell_position", { take: TAKE, side: "back", percent: 50, usd: null }, new Map(), WEB);
  assert.ok(sell.kind === "pending");
  assert.equal(sell.pending.summary, `sell 50% of your "Gold to 5k"`);
});

test("confirmed: traded without waiting for it to land, and the reply says what happened", async () => {
  const { a, trades } = api();
  const prepared = await prepareTrade(a, who, "m", "fade_take", { take: TAKE, usd: 25 }, new Map(), WEB);
  assert.ok(prepared.kind === "pending");
  const r = await runConfirmed(a, prepared.pending);
  assert.deepEqual(trades[0].opts, { wait: false });
  assert.equal(trades[0].ref, "m:fade_take");
  assert.equal(r.text, `you're fading "Gold to 5k" with $25\n${WEB}/t/${TAKE}`);
  const p = prepared.pending;
  assert.equal(resultText(p, { ok: false, error: "over_daily_limit", leftUsd: 10, confirmUrl: "u" }).text, "that's past your daily limit ($10 left today). do it yourself here:\nu");
  assert.equal(resultText(p, { ok: true, status: "failed", takeId: TAKE, url: "u", usd: null, closesTake: false, existing: false }).text, "that didn't go through. try again in a minute.");
});
