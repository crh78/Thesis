import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { blinkServer } from "../../../apps/web/blink.ts";

test("Blink links a take to one wallet transaction and exposes only preview routes", async (t) => {
  const id = "00000000-0000-4000-8000-000000000101";
  const calls: unknown[][] = [];
  const server = blinkServer({
    blinkTake: async () => ({ claim: "<script>", handle: "thesis", canBack: true, legs: [] }),
    buildBlinkBack: async (...args) => {
      calls.push(args);
      return { transaction: "transaction", feeUsd: 0.01, included: [0], excluded: [], checkoutId: args[3] ? id : undefined };
    },
    submitBlinkBack: async () => ({ signature: "signature" }),
    receipt: async () => ({ takeId: id, onChain: false, inverted: false, legs: [], canBack: false, canFade: false, fadeBlocked: "" }),
  }, "https://example.com", "solana:fork", () => {});
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const action = `/api/actions/back/${id}`;
  const preflight = await fetch(url + action, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  const mapping = await (await fetch(url + "/actions.json")).json();
  assert.deepEqual(mapping.rules[0], { pathPattern: "/take/*", apiPath: "/api/actions/back/*" });

  const metadata = await (await fetch(url + action)).json();
  assert.equal(metadata.links.actions[0].href, action + "?amount=10");
  const post = (href: string) => fetch(url + href, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "wallet" }),
  });
  assert.equal((await post(action + "?amount=10.001")).status, 400);
  const response = await (await post(metadata.links.actions[0].href)).json();
  assert.equal(response.transaction, "transaction");
  assert.equal(response.links.next.action.type, "completed");
  assert.equal(response.checkoutId, undefined);
  const hosted = await (await post(action + "?amount=12.50&checkout=1")).json();
  assert.equal(hosted.checkoutId, id);
  assert.deepEqual(calls, [[id, "wallet", 10, false], [id, "wallet", 12.5, true]]);
  assert.equal((await post("/digests")).status, 404);
  assert.equal((await post("/api/blink/submit")).status, 400);
  const signed = await fetch(url + "/api/blink/submit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ checkoutId: id, transaction: "signed" }),
  });
  assert.deepEqual(await signed.json(), { signature: "signature" });
  assert.deepEqual(await (await fetch(url + `/api/blink/receipt/${id}`)).json(), { onChain: false });

  const page = await (await fetch(url + `/take/${id}`)).text();
  assert.match(page, /&lt;script&gt;/);
  assert.match(page, new RegExp(`yourthesis-dev://take/${id}`));
});
