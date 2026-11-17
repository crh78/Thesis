import assert from "node:assert/strict";
import { test } from "node:test";
import { cardIdHex } from "../../collector-crypt/src/index.ts";
import { CARD_REFRESH_MS, cardLeg, cardsToRead, mergePicked, type PickedCard } from "../src/cards.ts";
import { emptyState } from "../src/state.ts";

const NOW = Date.parse("2026-12-15T12:00:00Z");
const held = (cardId: string, agoMs: number): PickedCard => ({ cardId, name: cardId, insuredValueUsd: 50, metadataUpdatedAt: null, readAt: new Date(NOW - agoMs).toISOString() });

test("reads new picks first, then the stalest held cards past the refresh age, within the budget", () => {
  const h = mergePicked({}, [held("A", CARD_REFRESH_MS + 1), held("B", 5 * CARD_REFRESH_MS), held("C", 60_000)]);
  assert.deepEqual(cardsToRead(h, ["A", "NEW1", "NEW2"], NOW, 10), ["NEW1", "NEW2", "B", "A"]);
  assert.deepEqual(cardsToRead(h, ["NEW1", "NEW2"], NOW, 3), ["NEW1", "NEW2", "B"]);
  assert.deepEqual(cardsToRead(h, [], NOW, 0), []);
});

test("a card leg's on-chain id finds its card", () => {
  const state = emptyState(new Date(NOW));
  assert.equal(cardLeg(state, cardIdHex("A")), null);
  state.venues.cards = { at: new Date(NOW).toISOString(), summary: null, picked: mergePicked({}, [held("A", 0)]) };
  assert.equal(cardLeg(state, cardIdHex("A"))?.cardId, "A");
  assert.equal(cardLeg(state, cardIdHex("B")), null);
});

test("a fresher read replaces the card", () => {
  const a = mergePicked({}, [held("A", CARD_REFRESH_MS)]);
  const b = mergePicked(a, [{ ...held("A", 0), insuredValueUsd: 64 }]);
  assert.equal(Object.keys(b).length, 1);
  assert.equal(b[cardIdHex("A")].insuredValueUsd, 64);
});
