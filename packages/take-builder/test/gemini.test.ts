import assert from "node:assert/strict";
import { test } from "node:test";
import type { GeminiContract } from "../../venues/gemini/src/markets.ts";
import { geminiRows } from "../src/gemini.ts";

const NOW = Date.parse("2026-12-11T12:00:00Z");
const contract = (o: Partial<GeminiContract>): GeminiContract => ({
  instrumentSymbol: "GEMI-UNEMP2026-GT5", eventTicker: "UNEMP2026", eventTitle: "Unemployment rate in 2026", label: "Above 5%",
  category: "Economics", status: "active", expiry: "2027-01-08T13:30:00Z", resolutionSide: null, resolvedAt: null,
  ask: { yes: 0.1, no: 0.97 }, bid: { yes: 0.03, no: 0.9 }, ...o,
});

test("one row per eligible contract, named by event and contract", () => {
  const [row] = geminiRows([contract({})], NOW);
  assert.equal(row.id, "gemini:GEMI-UNEMP2026-GT5");
  assert.equal(row.name, "Unemployment rate in 2026: Above 5%");
  assert.deepEqual([row.kind, row.liquidity, row.us_persons, row.can_short], ["prediction", "tradeable", "yes", true]);
  assert.equal(row.data.description, "Prediction market on Gemini: Unemployment rate in 2026: Above 5%.");
  assert.ok(!("ask" in row.data), "no prices in the row: they're read live");
});

test("a question title drops its '?' before the contract's label", () => {
  const [row] = geminiRows([contract({ eventTitle: "Gold price on December 20?", label: "$3,975 or above" })], NOW);
  assert.equal(row.name, "Gold price on December 20: $3,975 or above");
  assert.equal(row.data.description, "Prediction market on Gemini: Gold price on December 20: $3,975 or above.");
  // A contract named like its event keeps the question.
  assert.equal(geminiRows([contract({ eventTitle: "Fed cuts in December?", label: "Fed cuts in December?" })], NOW)[0].name, "Fed cuts in December?");
});

test("leaves out contracts that resolve within the hour, settled ones, and any not two-sided on BOTH sides", () => {
  // Every pick can be faded and a fade buys the other side: one-sided contracts used
  // to qualify, so a fade could be offered on a side with no market.
  const rows = geminiRows([
    contract({ instrumentSymbol: "SOON", expiry: "2026-12-11T12:30:00Z" }),
    contract({ instrumentSymbol: "DEAD", ask: { yes: null, no: null }, bid: { yes: null, no: null } }),
    contract({ instrumentSymbol: "ONE-SIDED", ask: { yes: null, no: 0.6 }, bid: { yes: null, no: 0.58 } }),
    contract({ instrumentSymbol: "SETTLED", status: "settled" }),
    contract({ instrumentSymbol: "CROSSED", ask: { yes: 0.01, no: 0.19 }, bid: { yes: 0.81, no: 0.99 } }),
    contract({ instrumentSymbol: "TWO-SIDED" }),
  ], NOW);
  assert.deepEqual(rows.map((r) => r.symbol), ["TWO-SIDED"]);
});
