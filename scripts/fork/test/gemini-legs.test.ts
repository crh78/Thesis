import assert from "node:assert/strict";
import { test } from "node:test";
import { predictionIdHex, type GeminiContract } from "@thesis/venues/gemini";
import { contractResolver, mapLegs, predictionSide } from "../api/legs.ts";
import { GAP_MS, LIVE_TTL_MS, LiveContracts } from "../api/gemini-live.ts";
import { Router, escrowShare } from "../api/routing.ts";

const contract = (sym: string, event: string): GeminiContract => ({
  instrumentSymbol: sym, eventTicker: event, eventTitle: "Unemployment", label: sym, category: "Economics", status: "active",
  expiry: "2027-01-08T13:30:00Z", resolutionSide: null, resolvedAt: null, ask: { yes: 0.1, no: 0.97 }, bid: { yes: 0.03, no: 0.9 },
});
const contracts = {
  "GEMI-UNEMP2026-GT5": contract("GEMI-UNEMP2026-GT5", "UNEMP2026"),
  "GEMI-UNEMP2026-GT6": contract("GEMI-UNEMP2026-GT6", "UNEMP2026"),
  "GEMI-FED-CUT": contract("GEMI-FED-CUT", "FEDDEC"),
};

test("a pick maps to one contract: by instrument, or an event with only one", () => {
  const resolve = contractResolver(contracts);
  assert.deepEqual(resolve("gemini:GEMI-UNEMP2026-GT5"), { contract: contracts["GEMI-UNEMP2026-GT5"] });
  assert.deepEqual(resolve("gemini:FEDDEC"), { contract: contracts["GEMI-FED-CUT"] });
  assert.match((resolve("gemini:UNEMP2026") as { blocked: string }).blocked, /several contracts/);
  assert.match((resolve("gemini:NOPE") as { blocked: string }).blocked, /doesn't list/);
  assert.match((resolve(null) as { blocked: string }).blocked, /no Gemini market/);
});

test("the side comes from the kind (or the name), Yes by default", () => {
  assert.equal(predictionSide({ name: "Fed cuts", kind: "Prediction · No" }), "no");
  assert.equal(predictionSide({ name: "Rate cut: No", kind: "Prediction" }), "no");
  assert.equal(predictionSide({ name: "Fed cuts", kind: "Prediction · Yes" }), "yes");
});

test("prediction legs become paper legs on their contract's side, always fadeable", () => {
  const legs = mapLegs(
    [
      { name: "NVIDIA", kind: "Stock", weight: 60, fade_how: null },
      { name: "Above 5%", kind: "Prediction · No", weight: 40, fade_how: null, asset_id: "gemini:GEMI-UNEMP2026-GT5" },
      { name: "Rate cut: Yes", kind: "Prediction", weight: 0.01, fade_how: "No" },
    ],
    undefined,
    contractResolver(contracts),
  );
  const [, gt5, demo] = legs;
  assert.equal(gt5.how, "paper");
  assert.equal(gt5.blocked, null);
  assert.equal(gt5.spec.asset.toBuffer().toString("hex"), predictionIdHex("GEMI-UNEMP2026-GT5", "no"));
  assert.deepEqual(Object.keys(gt5.spec.fadeVia), ["predictionNo"]);
  assert.equal(gt5.prediction?.side, "no");
  assert.match(demo.blocked!, /no Gemini market/);
});

test("the escrowed share matches the program: floor(stake × prediction weight ÷ included weight)", () => {
  const leg = (weightBps: number, how: "swap" | "paper") => ({ spec: { weightBps }, how });
  assert.equal(escrowShare([leg(6_000, "swap"), leg(4_000, "paper")], 20_000_000n), 8_000_000n);
  assert.equal(escrowShare([leg(3_334, "swap"), leg(3_333, "paper")], 10_000_001n), (10_000_001n * 3_333n) / 6_667n);
  assert.equal(escrowShare([leg(5_000, "swap")], 10_000_000n), 0n);
  assert.equal(escrowShare([leg(5_000, "paper")], 10_000_000n), 10_000_000n);
});

test("live reads: one per event within the TTL, shared by its contracts; failures keep the last copy", async () => {
  let t = 0;
  const reads: string[] = [];
  let fail = false;
  const live = new LiveContracts(async (ticker) => {
    reads.push(ticker);
    if (fail) throw new Error("HTTP 502");
    return Object.values(contracts).filter((c) => c.eventTicker === ticker).map((c) => ({ ...c, ask: { yes: 0.2, no: 0.85 } }));
  }, { now: () => t });
  const gt5 = contracts["GEMI-UNEMP2026-GT5"], gt6 = contracts["GEMI-UNEMP2026-GT6"];
  await Promise.all([live.refresh([gt5, gt6]), live.refresh([gt5])]);
  assert.deepEqual(reads, ["UNEMP2026"]);
  assert.equal(live.live(gt6)?.ask.yes, 0.2);
  t = LIVE_TTL_MS - 1;
  await live.refresh([gt5]);
  assert.equal(reads.length, 1);
  t = LIVE_TTL_MS;
  fail = true;
  await live.refresh([gt5]);
  assert.equal(reads.length, 2);
  assert.equal(live.live(gt5), null, "a stale read isn't live");
  assert.equal(live.latest(gt5, gt5).ask.yes, 0.2, "but it's still the newest copy");
  assert.equal(live.latest(contracts["GEMI-FED-CUT"], contracts["GEMI-FED-CUT"]).ask.yes, 0.1, "never read: the fallback");
});

test("a trade needs a live read of its prediction legs, and goes by the live market", async () => {
  const legs = mapLegs(
    [
      { name: "Above 5%", kind: "Prediction · Yes", weight: 50, fade_how: null, asset_id: "gemini:GEMI-UNEMP2026-GT5" },
      { name: "Fed cut", kind: "Prediction · Yes", weight: 50, fade_how: null, asset_id: "gemini:GEMI-FED-CUT" },
    ],
    undefined,
    contractResolver(contracts),
  );
  const bank = { venues: { gemini: { contracts } } };
  // UNEMP2026 reads live with no bid on Yes now; FEDDEC can't be read.
  const live = new LiveContracts(async (ticker) => {
    if (ticker === "FEDDEC") throw new Error("HTTP 502");
    return [{ ...contracts["GEMI-UNEMP2026-GT5"], bid: { yes: null, no: 0.9 } }];
  });
  const router = new Router({ bank: () => bank, gemini: live, appPayer: { publicKey: null } } as any);
  await assert.rejects(router.venueLegs(legs, null as any, 20), /None of this take's legs/);
  await router.refreshMarkets(legs);
  assert.match(router.leftOut(legs[0])!, /no market on Yes/);
  assert.equal(router.leftOut(legs[1]), null, "the receipt falls back to the swept copy");
  // With both readable and two-sided, the trade escrows both and trades nothing.
  const ok = new Router({ bank: () => bank, gemini: new LiveContracts(async (t) => Object.values(contracts).filter((c) => c.eventTicker === t)), appPayer: { publicKey: null } } as any);
  const out = await ok.venueLegs(legs, null as any, 20);
  assert.deepEqual(out.included, [0, 1]);
  assert.deepEqual(out.excluded, []);
});

test("a gap in Gemini's book is bridged by a price seen within GAP_MS, never longer", async () => {
  let t = 0;
  const gt5 = contracts["GEMI-UNEMP2026-GT5"];
  let next: GeminiContract = gt5;
  const live = new LiveContracts(async () => [next], { now: () => t });
  await live.refresh([gt5]);
  // The book empties for a moment: the last prices stand in.
  next = { ...gt5, ask: { yes: null, no: null }, bid: { yes: 0.04, no: null } };
  t = LIVE_TTL_MS;
  await live.refresh([gt5]);
  assert.deepEqual(live.live(gt5)?.ask, gt5.ask);
  assert.deepEqual(live.live(gt5)?.bid, { yes: 0.04, no: 0.9 }, "a fresh price wins; only missing ones are filled");
  // Still empty past GAP_MS since a price was last seen: the gap shows.
  next = { ...gt5, ask: { yes: null, no: null }, bid: { yes: null, no: null } };
  t = GAP_MS + 1;
  await live.refresh([gt5]);
  assert.deepEqual(live.live(gt5)?.ask, { yes: null, no: null });
  assert.equal(live.live(gt5)?.bid.yes, 0.04, "the Yes bid was seen at LIVE_TTL_MS, within GAP_MS");
  // A contract that's no longer open isn't filled in.
  next = { ...gt5, status: "settled", ask: { yes: null, no: null }, bid: { yes: null, no: null } };
  t += LIVE_TTL_MS;
  await live.refresh([gt5]);
  assert.deepEqual(live.live(gt5)?.bid, { yes: null, no: null });
});
