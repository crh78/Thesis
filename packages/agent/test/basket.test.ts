import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBasket, legSide, picksLines } from "../src/basket.ts";

const CFG = { takeBuilderUrl: "https://x.test/take-builder", draftsUrl: "https://x.test/source/drafts", botSecret: "s3cret", webUrl: "https://w.test/" };

/** Swaps in a fetch that answers the drafts route with `body` for one call. */
async function withDrafts<T>(body: unknown, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = real; }
}

test("leg sides: what agreeing holds", () => {
  assert.equal(legSide(undefined, false), "long");
  assert.equal(legSide("yes", false), "yes");
  assert.equal(legSide(null, true), "short");
  assert.equal(legSide("yes", true), "no");
  assert.equal(legSide("no", true), "yes");
});

test("a take that bets against its basket: every leg short, and the picks say so", async () => {
  const r = await withDrafts({
    id: "Ab3dEf7h", verdict: "basket", summary: "Crypto falls.", reason: null, inverted: true,
    legs: [{ id: "btc", name: "Bitcoin", kind: "perp", weight: 50, why: "the big one" }, { id: "eth", name: "Ether", kind: "perp", weight: 50, why: "number two" }],
  }, () => buildBasket(CFG, { claim: "crypto sucks", risk: "medium" }, { origin: "imessage" }));
  assert.equal(r.verdict, "basket");
  if (r.verdict !== "basket") return;
  assert.equal(r.inverted, true);
  assert.deepEqual(r.legs.map((l) => l.side), ["short", "short"]);
  assert.equal(r.link, "https://w.test/d/Ab3dEf7h");
  assert.deepEqual(picksLines(r), ["betting against: Bitcoin 50%, Ether 50%"]);
});

test("a plain basket: long, one pick a line, not inverted (an older builder says nothing)", async () => {
  const r = await withDrafts({
    id: "Ab3dEf7h", verdict: "basket", summary: "Power demand.", reason: null,
    legs: [{ id: "vst", name: "Vistra Corp.", kind: "stock", weight: 60, why: "power" }, { id: "p", name: "Fed cut", kind: "prediction", side: "yes", weight: 40, why: "rates" }],
  }, () => buildBasket(CFG, { claim: "ai power demand", risk: "medium" }, { origin: "imessage" }));
  assert.equal(r.verdict, "basket");
  if (r.verdict !== "basket") return;
  assert.equal(r.inverted, false);
  assert.deepEqual(r.legs.map((l) => l.side), ["long", "yes"]);
  assert.deepEqual(picksLines(r), ["Vistra 60%", "Fed cut 40%"]);
});
