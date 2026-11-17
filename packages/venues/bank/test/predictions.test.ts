import assert from "node:assert/strict";
import { test } from "node:test";
import { predictionIdHex, type GeminiContract } from "../../gemini/src/index.ts";
import { KEEP_EXPIRED_MS, mergeGeminiContracts, predictionLeg } from "../src/index.ts";

const NOW = Date.parse("2026-12-15T12:00:00Z");
const contract = (sym: string, expiry: string): GeminiContract => ({
  instrumentSymbol: sym, eventTicker: "EV", eventTitle: "t", label: sym, category: "Economics", status: "active",
  expiry, resolutionSide: null, resolvedAt: null, ask: { yes: 0.4, no: 0.62 }, bid: { yes: 0.38, no: 0.6 },
});

test("keeps contracts a poll no longer lists until a week after they expire", () => {
  const previous = {
    OLD: contract("OLD", new Date(NOW - KEEP_EXPIRED_MS - 1).toISOString()),
    RECENT: contract("RECENT", new Date(NOW - 60_000).toISOString()),
    LIVE: contract("LIVE", "2027-01-01T00:00:00Z"),
  };
  const fresh = [{ ...contract("LIVE", "2027-01-01T00:00:00Z"), ask: { yes: 0.5, no: 0.52 } }, contract("NEW", "2027-02-01T00:00:00Z")];
  const kept = mergeGeminiContracts(previous, fresh, NOW);
  assert.deepEqual(Object.keys(kept).sort(), ["LIVE", "NEW", "RECENT"]);
  assert.equal(kept.LIVE.ask.yes, 0.5, "a fresh poll replaces the stored contract");
});

test("finds the contract and side a leg id names", () => {
  const c = contract("GEMI-UNEMP2026-GT5", "2027-01-08T13:30:00Z");
  const state = { venues: { gemini: { at: "", summary: null as never, contracts: { [c.instrumentSymbol]: c } } } } as never;
  assert.deepEqual(predictionLeg(state, predictionIdHex(c.instrumentSymbol, "no")), { contract: c, side: "no" });
  assert.equal(predictionLeg(state, "00".repeat(32)), null);
});
