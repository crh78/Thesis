import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentApi, CopyResult } from "@thesis/agent";
import { plan, type MentionInput } from "../src/bot.ts";
import { COPY_LIMIT, COPY_WHO, copyIntent, NOT_LINKED, xLength } from "../src/compose.ts";
import type { Verdict } from "../src/vet.ts";

const basket = { takeBuilderUrl: "https://e.test/tb", draftsUrl: "https://e.test/d", botSecret: "s", webUrl: "https://web.test" };
const base: MentionInput = {
  id: "1", text: "copy", author: { username: "Asker", followers: 1 },
  parent: { text: "gold to 5k", username: "KobeissiLetter" }, parentUrl: "https://x.com/KobeissiLetter/status/7", parentId: "7", toBot: false, authorId: "42",
};
const noVet = async (): Promise<Verdict> => { throw new Error("vet must not run"); };

function api(answer: CopyResult) {
  const calls: { handle: string; username?: string }[] = [];
  return { calls, a: { copy: async (_w: unknown, handle: string, username?: string) => { calls.push({ handle, username }); return answer; } } as unknown as AgentApi };
}

test("copy intents", () => {
  assert.deepEqual(copyIntent("copy"), { handle: null });
  assert.deepEqual(copyIntent("copy them"), { handle: null });
  assert.deepEqual(copyIntent("copytrade"), { handle: null });
  assert.deepEqual(copyIntent("copy @Jake_T"), { handle: "jake_t" });
  assert.equal(copyIntent("copy this take for $20"), null);
  assert.equal(copyIntent("back $20"), null);
});

test("copy under a post copies its author, with their X username", async () => {
  const { a, calls } = api({ copying: true, kind: "x", handle: "kobeissiletter", usd: 20, daily: 3, already: false });
  const out = await plan(base, { vet: noVet, basket, trading: a });
  assert.deepEqual(calls, [{ handle: "kobeissiletter", username: "KobeissiLetter" }]);
  assert.ok(out.kind === "reply" && out.what === "copy");
  assert.ok(out.kind === "reply" && out.text === "Copying @kobeissiletter: Thesis will put $20 into each new call they post, up to 3 a day. Change it in Copy trading at the link in our bio.");
  assert.ok(out.kind === "reply" && xLength(out.text) <= 280);
});

test("an account on Thesis is copied as a trader", async () => {
  const { a } = api({ copying: true, kind: "trader", handle: "jake", thesis_handle: "jake", usd: 20, daily: 3, already: false });
  const out = await plan({ ...base, text: "copy @jake" }, { vet: noVet, basket, trading: a });
  assert.ok(out.kind === "reply" && out.text.includes("each new take they post on Thesis"));
});

test("not connected, the limit, nobody to copy", async () => {
  const nl = await plan(base, { vet: noVet, basket, trading: api({ copying: false, error: "not_linked" }).a });
  assert.ok(nl.kind === "reply" && nl.text === NOT_LINKED);
  const lim = await plan(base, { vet: noVet, basket, trading: api({ copying: false, error: "copy_limit" }).a });
  assert.ok(lim.kind === "reply" && lim.text === COPY_LIMIT);
  const none = await plan({ ...base, parent: null, parentUrl: null, parentId: null }, { vet: noVet, basket, trading: api({ copying: false, error: "x" }).a });
  assert.ok(none.kind === "reply" && none.text === COPY_WHO);
});
