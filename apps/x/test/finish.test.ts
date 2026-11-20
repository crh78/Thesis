// The X bot's follow-ups: selling from a reply, buying the bot's own basket, one basket per post,
// and the memory that ties them together.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AgentApi, TradeAsk, TradeResult } from "@thesis/agent";
import { plan, type BotPost, type Held, type MentionInput, type Memory, type Shared } from "../src/bot.ts";
import { plainCommand, sellIntent, SELL_WHICH } from "../src/compose.ts";
import { loadState, memoryOf, SHARED_TTL_MS } from "../src/state.ts";
import type { Verdict } from "../src/vet.ts";

const TAKE = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const basket = { takeBuilderUrl: "https://e.test/tb", draftsUrl: "https://e.test/source/drafts", botSecret: "s", webUrl: "https://web.test" };
const base: MentionInput = {
  id: "1900000000000000100", text: "", author: { username: "Asker", followers: 1 },
  parent: { text: "NVIDIA keeps winning the AI chip race", username: "poster" }, parentUrl: "https://x.com/poster/status/7",
  parentId: "7", conversationId: "7", toBot: false, authorId: "424242",
};
const ok = (takeId = TAKE, closesTake = false): TradeResult => ({ ok: true, status: "landed", takeId, url: `https://web.test/t/${takeId}`, usd: 20, closesTake, existing: false });

function api(answer: (ask: TradeAsk) => TradeResult = () => ok()) {
  const asks: TradeAsk[] = [];
  return { asks, a: { trade: async (_w: unknown, _s: unknown, _r: unknown, ask: TradeAsk) => { asks.push(ask); return answer(ask); } } as unknown as AgentApi };
}
function memory(o: { posts?: Record<string, BotPost>; held?: Record<string, Held>; shared?: Record<string, Shared> } = {}): Memory {
  return {
    botPost: (id) => o.posts?.[id],
    held: (a, c) => o.held?.[`${a}|${c}`],
    shared: (p, side) => o.shared?.[`${p}|${side}`],
  };
}
const noVet = async (): Promise<Verdict> => { throw new Error("vet must not run"); };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function drafts(record: Record<string, unknown>[] = []) {
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    record.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ verdict: "basket", summary: "", reason: null, id: "Dr4ft777", legs: [{ id: "nvda", name: "NVIDIA", kind: "stock", weight: 70, why: "" }, { id: "amd", name: "AMD", kind: "stock", weight: 30, why: "" }] }));
  }) as typeof fetch;
}

test("sell intents: all, half, a percent, dollars", () => {
  assert.deepEqual(sellIntent("sell"), {});
  assert.deepEqual(sellIntent("sell it all"), {});
  assert.deepEqual(sellIntent("sell half"), { bps: 5000 });
  assert.deepEqual(sellIntent("sell 25%"), { bps: 2500 });
  assert.deepEqual(sellIntent("sell $20"), { usd: 20 });
  assert.equal(sellIntent("back $20"), null);
});

test("plain commands share a basket; words of their own don't", () => {
  for (const t of ["", "make this a take", "back $20", "fade $50", "this", "what's the trade"]) assert.equal(plainCommand(t), true, t);
  for (const t of ["nuclear wins the AI race", "back $20 but only chips"]) assert.equal(plainCommand(t), false, t);
});

test("sell under the bot's trade reply sells that take, on the side traded", async () => {
  const { a, asks } = api(() => ok(TAKE, true));
  const out = await plan({ ...base, text: "sell half", toBot: true, parentId: "900" }, { vet: noVet, basket, trading: a, memory: memory({ posts: { "900": { takeId: TAKE, side: "fade", claim: "Gold to 5k" } } }) });
  assert.deepEqual(asks[0], { action: "sell", takeId: TAKE, side: "fade", bps: 5000 });
  assert.ok(out.kind === "reply" && out.what === "sell");
  assert.ok(out.kind === "reply" && out.text === `Sold 50% of your position in "Gold to 5k". That closed your take to new backers. See it at the link in our bio.`);
});

test("sell anywhere in the thread finds the take traded there; nothing traded asks which", async () => {
  const { a, asks } = api();
  await plan({ ...base, text: "sell" }, { vet: noVet, basket, trading: a, memory: memory({ held: { "424242|7": { takeId: TAKE, side: "back", claim: "x" } } }) });
  assert.deepEqual(asks[0], { action: "sell", takeId: TAKE, side: "back" });
  const none = await plan({ ...base, text: "sell" }, { vet: noVet, basket, trading: api().a, memory: memory() });
  assert.ok(none.kind === "reply" && none.text === SELL_WHICH);
});

test("back $20 under the bot's draft reply buys that exact draft (only for whom it was made)", async () => {
  const post: BotPost = { draftId: "Ab3dEf7h", forX: "asker", claim: "NVIDIA wins", legs: [{ name: "NVIDIA", weight: 100 }] };
  const { a, asks } = api();
  const out = await plan({ ...base, text: "back $20", toBot: true, parentId: "901" }, { vet: noVet, basket, trading: a, memory: memory({ posts: { "901": post } }) });
  assert.deepEqual(asks[0], { action: "post", draftId: "Ab3dEf7h", usd: 20 });
  assert.ok(out.kind === "reply" && out.what === "trade" && out.image === "https://web.test/d/Ab3dEf7h/basket.png");
  assert.deepEqual(out.kind === "reply" && out.remember?.held, { takeId: TAKE, side: "back", claim: "NVIDIA wins" });
});

test("back $20 under the bot's trade reply backs that take: others can join it", async () => {
  const { a, asks } = api();
  const out = await plan({ ...base, author: { username: "friend", followers: 1 }, authorId: "555", text: "back $20", toBot: true, parentId: "902" }, { vet: noVet, basket, trading: a, memory: memory({ posts: { "902": { takeId: TAKE, side: "back", claim: "NVIDIA wins" } } }) });
  assert.deepEqual(asks[0], { action: "back", takeId: TAKE, usd: 20 });
  assert.ok(out.kind === "reply" && out.what === "trade");
});

test("a second replier under the same post reuses the basket: no vetting, a copied draft", async () => {
  const sent: Record<string, unknown>[] = [];
  drafts(sent);
  const shared: Shared = { draftId: "Shar3d01", claim: "NVIDIA keeps winning", legs: [{ name: "NVIDIA", weight: 100 }], at: Date.now() };
  const out = await plan({ ...base, text: "make this a take" }, { vet: noVet, basket, memory: memory({ shared: { "7|back": shared } }) });
  assert.equal(sent[0].copy_of, "Shar3d01");
  assert.equal(sent[0].claim, "NVIDIA keeps winning");
  assert.equal(sent[0].risk, "high");
  assert.ok(out.kind === "reply" && out.what === "take" && out.remember?.shared === undefined);
});

test("the first replier's basket is offered for sharing", async () => {
  drafts();
  const vet = async (): Promise<Verdict> => ({ action: "take", reason: "", claim: "NVIDIA keeps winning", risk: "low", fromParent: true });
  const out = await plan({ ...base, text: "make this a take" }, { vet, basket, memory: memory() });
  assert.ok(out.kind === "reply");
  assert.deepEqual(out.kind === "reply" && out.remember?.shared, { parentId: "7", side: "back", value: { draftId: "Dr4ft777", claim: "NVIDIA keeps winning", legs: [{ name: "NVIDIA", weight: 70 }, { name: "AMD", weight: 30 }] } });
  assert.deepEqual(out.kind === "reply" && out.remember?.post, { draftId: "Dr4ft777", forX: "asker", claim: "NVIDIA keeps winning", legs: [{ name: "NVIDIA", weight: 70 }, { name: "AMD", weight: 30 }] });
});

test("memory over the state file: posts, held, shared with a 24-hour life", () => {
  let now = 1_000_000;
  const s = loadState("/nonexistent/state.json");
  const m = memoryOf(s, () => now);
  m.rememberPost("r1", { takeId: TAKE });
  m.rememberHeld("u", "c", { takeId: TAKE, side: "back" });
  m.rememberShared("p", "fade", { draftId: "D", claim: "c", legs: [] });
  assert.deepEqual(m.botPost("r1"), { takeId: TAKE });
  assert.deepEqual(m.held("u", "c"), { takeId: TAKE, side: "back" });
  assert.equal(m.shared("p", "fade")?.draftId, "D");
  assert.equal(m.shared("p", "back"), undefined);
  now += SHARED_TTL_MS;
  assert.equal(m.shared("p", "fade"), undefined);
});
