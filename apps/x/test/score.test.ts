import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentApi, Score } from "@thesis/agent";
import { plan, type MentionInput } from "../src/bot.ts";
import { scoreIntent, scoreReply, xLength } from "../src/compose.ts";
import type { Verdict } from "../src/vet.ts";

const basket = { takeBuilderUrl: "https://e.test/tb", draftsUrl: "https://e.test/d", botSecret: "s", webUrl: "https://web.test" };
const base: MentionInput = {
  id: "1", text: "score", author: { username: "Asker", followers: 1 },
  parent: { text: "gold to 5k", username: "JakeTrades" }, parentUrl: "https://x.com/JakeTrades/status/7", parentId: "7", toBot: false, authorId: "42",
};
const noVet = async (): Promise<Verdict> => { throw new Error("vet must not run"); };
const found: Score = { found: true, handle: "jake", display_name: "Jake", made: 123.4, return_pct: 4.56, backers_made: -20, backers_pct: -1.2, takes: 7 };

function lookup(answer: Score) {
  const asked: string[] = [];
  return { asked, a: { score: async (u: string) => { asked.push(u); return answer; } } as unknown as AgentApi };
}

test("score intents", () => {
  assert.deepEqual(scoreIntent("score"), { handle: null });
  assert.deepEqual(scoreIntent("score @JakeTrades"), { handle: "jaketrades" });
  assert.deepEqual(scoreIntent("score me"), { handle: "me" });
  assert.deepEqual(scoreIntent("what's my score?"), { handle: null });
  assert.equal(scoreIntent("this score is wild, nvidia to 200"), null);
  assert.equal(scoreIntent("back $20"), null);
});

test("score under someone's post scores its author, with their score card", async () => {
  const { a, asked } = lookup(found);
  const out = await plan(base, { vet: noVet, basket, lookup: a });
  assert.deepEqual(asked, ["jaketrades"]);
  assert.ok(out.kind === "reply" && out.what === "score");
  assert.ok(out.kind === "reply" && out.text === "@jaketrades on Thesis: own P&L +$123 (+4.6%), made for backers -$20 (-1.2%), 7 takes. Full profile at the link in our bio.");
  assert.ok(out.kind === "reply" && out.image === "https://web.test/u/jake/score.png");
  assert.ok(out.kind === "reply" && xLength(out.text) <= 280);
});

test("score @handle, score me, and score under the bot's own post", async () => {
  const one = lookup(found);
  await plan({ ...base, text: "score @someone" }, { vet: noVet, basket, lookup: one.a });
  const two = lookup(found);
  await plan({ ...base, text: "score me" }, { vet: noVet, basket, lookup: two.a });
  const three = lookup(found);
  await plan({ ...base, toBot: true }, { vet: noVet, basket, lookup: three.a });
  const four = lookup(found);
  await plan({ ...base, parent: null, parentUrl: null, parentId: null }, { vet: noVet, basket, lookup: four.a });
  assert.deepEqual([one.asked, two.asked, three.asked, four.asked], [["someone"], ["asker"], ["asker"], ["asker"]]);
});

test("not on Thesis: says so, no picture", async () => {
  const { a } = lookup({ found: false });
  const out = await plan(base, { vet: noVet, basket, lookup: a });
  assert.ok(out.kind === "reply" && out.text === "@jaketrades isn't on Thesis yet. Anyone can join at the link in our bio." && !out.image);
  assert.equal(scoreReply("asker", true, { found: false }), "You're not on Thesis yet. Sign in with X at the link in our bio.");
});
