import assert from "node:assert/strict";
import { test } from "node:test";
import { priceCard, type CardRef, type CardSource } from "../src/settler/card-legs.ts";
import { priceLeg, type PriceRules, type Sources } from "../src/settler/pricing.ts";

const M = 1_800_000_000; // the moment
const RULES: PriceRules = { minLiquidityUsd: 50_000, liveWindowSecs: 300, maxDelaySecs: 4 * 86_400 };
const CARD = "2026120156C116510";
const bankRef = (over: Partial<CardRef> = {}): CardRef => ({ cardId: CARD, name: "Dratini CGC 10", insuredValueUsd: 70, readAtSec: M + 600, ...over });

function source(answer: Awaited<ReturnType<CardSource["card"]>> | Error, calls: string[] = []): CardSource {
  return {
    card: async (id) => {
      calls.push(id);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test("entry: the card's insured value, read live at or after the moment, in dollars", async () => {
  const calls: string[] = [];
  const out = await priceCard({ index: 1, card: bankRef() }, M, M + 30, RULES, source({ insuredValueUsd: 70, at: M + 29, raw: { insuredValue: "70" } }, calls), null);
  assert.ok(out.ok);
  assert.equal(out.quote.price, 70);
  assert.equal(out.quote.publishedAt, M + 29);
  assert.equal(out.quote.rule, "card-insured-value");
  assert.deepEqual(out.quote.basis, { source: "card", cardId: CARD });
  assert.deepEqual(calls, [CARD]);
});

test("a read stamped before the moment is published at the moment, never earlier", async () => {
  const out = await priceCard({ index: 0, card: bankRef() }, M, M + 30, RULES, source({ insuredValueUsd: 70, at: M - 5, raw: {} }), null);
  assert.ok(out.ok);
  assert.equal(out.quote.publishedAt, M);
});

test("exit: the entry's basis names the card, even when the bank no longer holds it", async () => {
  const calls: string[] = [];
  const out = await priceCard({ index: 0, card: null }, M, M + 60, RULES, source({ insuredValueUsd: 95, at: M + 60, raw: {} }, calls), { source: "card", cardId: "OTHER" });
  assert.ok(out.ok);
  assert.equal(out.quote.price, 95);
  assert.deepEqual(calls, ["OTHER"]);
});

test("CC down: the bank's reading counts when it was made at or after the moment, inside the window", async () => {
  const down = source(new Error("timeout"));
  const ok = await priceCard({ index: 0, card: bankRef({ readAtSec: M + 600 }) }, M, M + 900, RULES, down, null);
  assert.ok(ok.ok);
  assert.equal(ok.quote.price, 70);
  assert.equal(ok.quote.publishedAt, M + 600);
  assert.equal(ok.quote.inputs.from, "asset bank");
  // A reading from before the moment isn't this moment's price.
  const early = await priceCard({ index: 0, card: bankRef({ readAtSec: M - 1 }) }, M, M + 900, RULES, down, null);
  assert.deepEqual(early, { ok: false, retry: true, reason: "Collector Crypt couldn't be read" });
});

test("no insured value: wait while the window is open, then give up (the position settles unscored)", async () => {
  const none = source({ insuredValueUsd: null, at: M + 10, raw: {} });
  const waiting = await priceCard({ index: 0, card: bankRef({ insuredValueUsd: null }) }, M, M + 10, RULES, none, null);
  assert.equal(waiting.ok, false);
  assert.equal(!waiting.ok && waiting.retry, true);
  assert.match(!waiting.ok ? waiting.reason : "", /no insured value/);
  const late = await priceCard({ index: 0, card: bankRef({ readAtSec: M - 10 }) }, M, M + RULES.maxDelaySecs + 1, RULES, none, null);
  assert.deepEqual(late, { ok: false, retry: false, reason: "past the price deadline" });
});

test("not yet: before the moment, or a card the bank hasn't learned", async () => {
  const src = source({ insuredValueUsd: 70, at: M, raw: {} });
  assert.deepEqual(await priceCard({ index: 0, card: bankRef() }, M, M - 1, RULES, src, null), { ok: false, retry: true, reason: "moment not reached" });
  assert.deepEqual(await priceCard({ index: 0, card: null }, M, M + 1, RULES, src, null), { ok: false, retry: true, reason: "the leg's card isn't in the asset bank yet" });
});

test("priceLeg sends card legs here, through the cards source", async () => {
  const sources = { stocks: {} as Sources["stocks"], tokens: {} as Sources["tokens"], cards: source({ insuredValueUsd: 1250, at: M + 5, raw: {} }) } as Sources;
  const out = await priceLeg({ index: 2, kind: "card", underlying: null, token: null, card: bankRef() }, M, M + 5, RULES, sources, null, "entry");
  assert.ok(out.ok);
  assert.equal(out.quote.price, 1250, "a card's price is dollars, not odds");
  const missing = await priceLeg({ index: 2, kind: "card", underlying: null, token: null, card: bankRef({ readAtSec: M - 1 }) }, M, M + 5, RULES, { ...sources, cards: undefined }, null, "entry");
  assert.deepEqual(missing, { ok: false, retry: true, reason: "no Collector Crypt source configured" });
});

// --- Live marks (the marker) ---
import { markPick, planTake, resolvePick, type Snapshot } from "../src/marker/mark.ts";
import { positionExit } from "../src/marker/positions.ts";

const snapWith = (cards: Map<string, number>): Snapshot => ({ nowSec: M, tokens: new Map(), stocks: new Map(), perps: new Map(), events: new Map(), lend: null, cards });

test("marker: a picked card marks at the bank's insured value; a card category stays out", () => {
  const pick = resolvePick({ name: "Dratini CGC 10", kind: "Card", asset_id: `card:${CARD}` }, undefined, null);
  assert.deepEqual(pick, { type: "card", cardId: CARD });
  const m = markPick(pick, snapWith(new Map([[CARD, 70]])), null);
  assert.ok(m.ok);
  assert.equal(m.price, 70);
  assert.deepEqual(m.source, { source: "card", rule: "card-insured-value", cardId: CARD });
  assert.equal(markPick(pick, snapWith(new Map()), null).ok, false, "not read yet: no mark");
  assert.equal(positionExit(pick, "back", snapWith(new Map([[CARD, 84]])), null, null), 84);
  assert.equal(resolvePick({ name: "Pokemon", kind: "Stock", asset_id: "cards:Pokemon" }, undefined, null).type, "void");
});

test("marker: a take with a card leg returns its weighted move (card $70 → $84 is +20%)", () => {
  const legs = [{ idx: 0, name: "Dratini", kind: "Card", weight: 100, asset_id: `card:${CARD}`, base_price: 70, base_at: new Date(M * 1000).toISOString(), base_source: { source: "card" as const, rule: "card-insured-value" as const, cardId: CARD } }];
  const plan = planTake({ id: "t", created_at: new Date(M * 1000).toISOString() }, legs, new Map([[0, { type: "card" as const, cardId: CARD }]]), snapWith(new Map([[CARD, 84]])));
  assert.equal(plan.take?.ret_pct, 20);
});
