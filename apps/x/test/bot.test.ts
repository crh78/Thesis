import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { plan, type MentionInput } from "../src/bot.ts";
import { readVerdict, type Verdict } from "../src/vet.ts";

const mention: MentionInput = {
  id: "1900000000000000001",
  text: "make this a take",
  author: { username: "asker", followers: 120 },
  parent: { text: "Nuclear wins the AI power race by 2027", username: "poster" },
  parentUrl: "https://x.com/poster/status/1",
  toBot: false,
};

const basket = {
  takeBuilderUrl: "https://example.test/functions/v1/take-builder",
  draftsUrl: "https://example.test/functions/v1/source/drafts",
  botSecret: "test-secret",
  webUrl: "https://web.example.test",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("readVerdict has no horizon, and drops one an old model reply still carries", () => {
  const v = readVerdict(
    JSON.stringify({ action: "take", reason: "market view", claim: "Nuclear wins the AI power race", risk: "high", horizon: "6 months", from_parent: true }),
    mention,
  );
  assert.deepEqual(v, { action: "take", reason: "market view", claim: "Nuclear wins the AI power race", risk: "high", fromParent: true });
});

test("readVerdict defaults risk to medium and ignores what it can't read", () => {
  const v = readVerdict(JSON.stringify({ action: "take", reason: "", claim: "Gold keeps rising", risk: "wild", from_parent: true }), { parent: null });
  assert.deepEqual(v, { action: "take", reason: "", claim: "Gold keeps rising", risk: "medium", fromParent: false });
  assert.equal(readVerdict("not json", mention).action, "ignore");
  assert.equal(readVerdict("null", mention).action, "ignore");
  assert.equal(readVerdict(JSON.stringify({ action: "explain", reason: "what is this" }), mention).action, "explain");
  assert.equal(readVerdict(JSON.stringify({ action: "no_view", reason: "just news" }), mention).action, "no_view");
});

test("plan says there's no clean trade, instead of going quiet, when the post has no market view", async () => {
  globalThis.fetch = (async () => {
    throw new Error("no_view must not build a basket");
  }) as typeof fetch;
  const vet = async (): Promise<Verdict> => ({ action: "no_view", reason: "a dip, no view" });
  const out = await plan({ ...mention, text: "", parent: { text: "AAPL down 4% today", username: "poster" } }, { vet, basket });
  assert.equal(out.kind, "reply");
  if (out.kind !== "reply") return;
  assert.equal(out.what, "no_view");
  assert.match(out.text, /No clean way to trade/);
});

test("plan stays quiet when vetting says ignore", async () => {
  const vet = async (): Promise<Verdict> => ({ action: "ignore", reason: "shill" });
  const out = await plan(mention, { vet, basket });
  assert.equal(out.kind, "skip");
});

test("plan never asks for a timeline: the draft is sent no horizon whatever the post says", async () => {
  let sent: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      verdict: "basket",
      summary: "Utilities and uranium",
      reason: null,
      legs: [{ id: "ceg", name: "Constellation Energy", kind: "stock", weight: 0.6, side: "long", why: "Largest US nuclear fleet" },
        { id: "ccj", name: "Cameco", kind: "stock", weight: 0.4, side: "long", why: "Uranium supply" }],
      id: "draft-1",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const vet = async (): Promise<Verdict> => ({ action: "take", reason: "market view", claim: "Nuclear wins the AI power race", risk: "medium", fromParent: true });
  const out = await plan(mention, { vet, basket });

  assert.equal(out.kind, "reply");
  assert.ok(out.kind === "reply" && out.what === "take");
  assert.ok(sent);
  assert.equal("horizon" in sent!, false);
  assert.equal(sent!.risk, "high"); // X takes always build at high risk, whatever the post says
  assert.equal(sent!.origin_ref, mention.id);
});
