import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AgentApi, TradeAsk, TradeResult } from "@thesis/agent";
import { plan, type MentionInput } from "../src/bot.ts";
import { NOT_LINKED, tradeIntent, xLength } from "../src/compose.ts";
import type { Mention, Verdict } from "../src/vet.ts";

const TAKE = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const basket = {
  takeBuilderUrl: "https://example.test/functions/v1/take-builder",
  draftsUrl: "https://example.test/functions/v1/source/drafts",
  botSecret: "test-secret",
  webUrl: "https://web.example.test",
};
const mention: MentionInput = {
  id: "1900000000000000009",
  text: "back $20",
  author: { username: "asker", followers: 50 },
  parent: { text: "Nuclear wins the AI power race", username: "poster" },
  parentUrl: "https://x.com/poster/status/1",
  toBot: false,
  authorId: "424242",
};

/** A fake agent API: records each trade and answers with `answer`. */
function trading(answer: (ask: TradeAsk) => TradeResult) {
  const asks: { who: unknown; surface: string; ref: string | null; ask: TradeAsk }[] = [];
  const api = {
    trade: async (who: unknown, surface: string, ref: string | null, ask: TradeAsk) => { asks.push({ who, surface, ref, ask }); return answer(ask); },
  } as unknown as AgentApi;
  return { api, asks };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function draftsAnswer() {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    verdict: "basket", summary: "Utilities and uranium", reason: null, id: "Dr4ft001",
    legs: [{ id: "ceg", name: "Constellation Energy", kind: "stock", weight: 60, side: "long", why: "Nuclear fleet" },
      { id: "ccj", name: "Cameco", kind: "stock", weight: 40, side: "long", why: "Uranium" }],
  }), { status: 200 })) as typeof fetch;
}

test("tradeIntent reads the side and dollars, and nothing else", () => {
  assert.deepEqual(tradeIntent("back $20"), { side: "back", usd: 20 });
  assert.deepEqual(tradeIntent("I'm in for 50"), { side: "back", usd: 50 });
  assert.deepEqual(tradeIntent("fade $1,000 lol"), { side: "fade", usd: 1000 });
  assert.deepEqual(tradeIntent("bet against this for $25"), { side: "fade", usd: 25 });
  assert.deepEqual(tradeIntent("$30 on back"), { side: "back", usd: 30 });
  assert.equal(tradeIntent("make this a take"), null);
  assert.equal(tradeIntent("back to the drawing board"), null);
});

test("under a shared Thesis take: back that take, no basket built", async () => {
  const { api, asks } = trading(() => ({ ok: true, status: "landed", takeId: TAKE, url: `https://w/t/${TAKE}`, usd: 20, closesTake: false, existing: false }));
  let vetted = false;
  const out = await plan({ ...mention, links: [`https://yourthesis.xyz/t/${TAKE}`] }, { vet: async () => { vetted = true; return { action: "ignore", reason: "" }; }, basket, trading: api });
  assert.equal(vetted, false);
  assert.deepEqual(asks[0], { who: { x: "424242" }, surface: "x", ref: mention.id, ask: { action: "back", takeId: TAKE, usd: 20 } });
  assert.ok(out.kind === "reply" && out.what === "trade" && out.text.startsWith("You're in: $20 backing this take"));
});

test("under any post: the basket becomes the asker's take with their buy-in; a fade is vetted as the opposite view", async () => {
  draftsAnswer();
  const { api, asks } = trading(() => ({ ok: true, status: "pending", takeId: TAKE, url: `https://w/t/${TAKE}`, usd: 50, closesTake: false, existing: false }));
  let seen: Mention | null = null;
  const vet = async (m: Mention): Promise<Verdict> => { seen = m; return { action: "take", reason: "", claim: "Nuclear won't win the AI power race", risk: "medium", fromParent: true }; };
  const out = await plan({ ...mention, text: "fade $50" }, { vet, basket, trading: api });
  assert.equal(seen!.fade, true);
  assert.deepEqual(asks[0].ask, { action: "post", draftId: "Dr4ft001", usd: 50 });
  assert.ok(out.kind === "reply" && out.what === "trade");
  assert.ok(out.kind === "reply" && out.text.startsWith(`You're in: $50 on "Nuclear won't win the AI power race".`));
  assert.ok(out.kind === "reply" && !/https?:\/\//.test(out.text) && xLength(out.text) <= 280);
});

test("not connected: the draft reply, pointing at the limits instead", async () => {
  draftsAnswer();
  const { api } = trading(() => ({ ok: false, error: "not_linked" }));
  const vet = async (): Promise<Verdict> => ({ action: "take", reason: "", claim: "Nuclear wins the AI power race", risk: "medium", fromParent: true });
  const out = await plan(mention, { vet, basket, trading: api });
  assert.ok(out.kind === "reply" && out.what === "not_linked");
  assert.ok(out.kind === "reply" && out.text.includes("Constellation Energy") && out.text.endsWith(NOT_LINKED));
});

test("over the limit says so; without trading configured, a trade mention is just a draft", async () => {
  draftsAnswer();
  const vet = async (): Promise<Verdict> => ({ action: "take", reason: "", claim: "Nuclear wins the AI power race", risk: "medium", fromParent: true });
  const { api } = trading(() => ({ ok: false, error: "over_trade_limit", perTradeUsd: 10, leftUsd: 90 }));
  const refused = await plan(mention, { vet, basket, trading: api });
  assert.ok(refused.kind === "reply" && refused.what === "trade_refused" && refused.text.includes("$10 per-trade limit"));
  const draft = await plan(mention, { vet, basket });
  assert.ok(draft.kind === "reply" && draft.what === "take");
});
