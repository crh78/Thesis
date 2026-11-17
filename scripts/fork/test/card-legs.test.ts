import assert from "node:assert/strict";
import { test } from "node:test";
import { cardIdHex } from "@thesis/venues/collector-crypt";
import { emptyState } from "../../../packages/venues/bank/src/state.ts";
import { escrowedKind, isPaper, mapLegs } from "../api/legs.ts";
import { Router, escrowShare } from "../api/routing.ts";

// Card legs: a picked card (`card:<cardId>`) is Card kind, filled on paper at
// its insured value, its share escrowed like a prediction leg's, never faded.
const CARD = "2026033156C116510";
const picks = [
  { name: "Charizard PSA 10", kind: "Card", weight: 20, fade_how: null, asset_id: `card:${CARD}` },
  { name: "Above 5%", kind: "Prediction · Yes", weight: 80, fade_how: null, asset_id: "gemini:NOPE" },
];

test("a picked card maps to a Card-kind paper leg on its own id, never fadeable", () => {
  const [card] = mapLegs(picks);
  assert.equal(card.how, "card");
  assert.equal(card.blocked, null);
  assert.deepEqual(card.card, { cardId: CARD });
  assert.equal(card.key, `card:${CARD}`);
  assert.deepEqual(Object.keys(card.spec.kind), ["card"]);
  assert.deepEqual(Object.keys(card.spec.fadeVia), ["none"]);
  assert.equal(card.spec.asset.toBuffer().toString("hex"), cardIdHex(CARD));
  assert.ok(isPaper("card") && isPaper("paper") && !isPaper("swap"));
  assert.ok(escrowedKind({ card: {} }) && escrowedKind({ prediction: {} }) && !escrowedKind({ spot: {} }));
});

test("card legs are escrowed with prediction legs, as the program's escrow_share does", () => {
  const leg = (weightBps: number, how: "swap" | "paper" | "card") => ({ spec: { weightBps }, how });
  // 20% card + 30% prediction of $20 → $10 escrowed; the 50% swap leg trades.
  assert.equal(escrowShare([leg(5_000, "swap"), leg(2_000, "card"), leg(3_000, "paper")], 20_000_000n), 10_000_000n);
  assert.equal(escrowShare([leg(8_000, "swap"), leg(2_000, "card")], 10_000_000n), 2_000_000n);
});

function router(picked: Record<string, { insuredValueUsd: number | null }> = {}) {
  const bank = emptyState();
  bank.venues.cards = {
    at: new Date().toISOString(),
    summary: null,
    picked: Object.fromEntries(Object.entries(picked).map(([id, v]) => [cardIdHex(id), { cardId: id, name: id, insuredValueUsd: v.insuredValueUsd, metadataUpdatedAt: null, readAt: new Date().toISOString() }])),
  };
  return new Router({ bank: () => bank, appPayer: { publicKey: null } } as any);
}

test("a back can include the card; a fade can't; a card CC no longer values is left out", () => {
  const [card] = mapLegs(picks);
  assert.equal(router().leftOut(card), null, "a card the bank hasn't read yet goes in (the settler waits for its reading)");
  assert.equal(router({ [CARD]: { insuredValueUsd: 70 } }).leftOut(card), null);
  assert.match(router({ [CARD]: { insuredValueUsd: null } }).leftOut(card)!, /no value for this card/);
  assert.match(router().leftOut(card, Date.now(), "fade")!, /can't be faded/);
});

test("a trade escrows the card's share and trades nothing for it", async () => {
  const [card] = mapLegs([picks[0]]);
  const out = await router({ [CARD]: { insuredValueUsd: 70 } }).venueLegs([card], null as any, 20);
  assert.deepEqual(out.venue, []);
  assert.deepEqual(out.included, [0]);
  assert.deepEqual(out.excluded, []);
  // The Blink (no paper legs) leaves it out.
  await assert.rejects(router().venueLegs([card], null as any, 20, undefined, undefined, { paper: false }), /None of this take's legs/);
});
