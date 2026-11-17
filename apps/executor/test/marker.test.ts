// Live marks: which asset a pick is, what it's worth now, and the take's return as an index.
// No network: every price is in the snapshot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { positionReturnBps } from "@thesis/chain";
import type { GeminiContract } from "@thesis/venues/gemini";
import {
  leverageOf, legReturnPct, markPick, planTake, predictionSide, resolvePick, takeReturnPct,
  type Base, type BankLookup, type Leg, type PickAsset, type Security, type Snapshot,
} from "../src/marker/mark.ts";
import { MissingAccounts, positionExit, positionLiveBps, readBatched } from "../src/marker/positions.ts";
import { toPriceUnits } from "../src/settler/pricing.ts";

const NOW = 1_800_000_000;
const iso = (s: number) => new Date(s * 1000).toISOString();

const bank: BankLookup = {
  token: (mint) =>
    mint === "NVDAx" ? { underlyingKey: "equity:US:NVDA", underlyingPerUiToken: 1, scaledUi: { multiplier: 1, newMultiplier: 1, newMultiplierEffectiveAt: 0 } }
    : mint === "WEIRD" ? { underlyingKey: "equity:US:W", underlyingPerUiToken: null, scaledUi: null }
    : mint === "PAXG" ? { underlyingKey: "commodity:XAU", underlyingPerUiToken: 1, scaledUi: null }
    : null,
  perp: (s) => (s === "kPEPE" ? { unitsPerContract: 1_000, underlyingKey: "crypto:PEPE" } : s === "NVDA" ? { unitsPerContract: 1, underlyingKey: "equity:US:NVDA" } : null),
  perpFor: (k) => (k === "equity:US:NVDA" ? { symbol: "NVDA", unitsPerContract: 1 } : null),
};

const sec = (o: Partial<Security> & { id: string; kind: string }): Security => ({ symbol: "X", name: "X", underlying: null, mint: null, data: {}, ...o });
const NVDA_SEC = sec({ id: "jup:NVDAx", kind: "stock", symbol: "NVDAx", underlying: "NVDA", mint: "NVDAx" });
const nvda = resolvePick({ name: "NVIDIA", kind: "Stock", asset_id: "jup:NVDAx" }, NVDA_SEC, bank) as Extract<PickAsset, { type: "spot" }>;

const contract = (o: Partial<GeminiContract> = {}): GeminiContract => ({
  instrumentSymbol: "GEMI-CUT", eventTicker: "FED", eventTitle: "Fed", label: "Cut", category: "Econ", status: "active",
  expiry: iso(NOW + 30 * 86_400), resolutionSide: null, resolvedAt: null,
  ask: { yes: 0.42, no: 0.6 }, bid: { yes: 0.4, no: 0.56 }, ...o,
});

function snap(o: Partial<Snapshot> = {}): Snapshot {
  return {
    nowSec: NOW,
    tokens: new Map([["NVDAx", { usdPrice: 103, liquidityUsd: 5_000_000, scaledUi: { multiplier: 1, newMultiplier: 1, newMultiplierEffectiveAt: 0 } }]]),
    stocks: new Map([["NVDA", { price: 100, at: NOW - 60 }]]),
    perps: new Map(),
    events: new Map(),
    lend: 1.05,
    ...o,
  };
}

// --- The formula is the program's --------------------------------------------------------------

test("a pick's return is the program's formula as a back: leverage × move, prediction mark/base − 1, −100% floor", () => {
  assert.equal(legReturnPct("spot", 1, 100, 110), 10);
  assert.equal(legReturnPct("perp", 2, 100, 110), 20);
  assert.equal(legReturnPct("prediction", 1, 0.4, 0.5), 25);
  assert.equal(legReturnPct("perp", 3, 100, 50), -100, "a 3x leg down 50% floors at −100%");
  assert.equal(legReturnPct("spot", 1, 0, 1), null);
});

test("the take's return is the program's weighted average (parity with positionReturnBps)", () => {
  const legs = [
    { kind: "spot" as const, leverage: 1, weight: 60, base: 100, mark: 110 },
    { kind: "prediction" as const, leverage: 1, weight: 40, base: 0.4, mark: 0.3 },
  ];
  const direct = positionReturnBps(
    [{ kind: { spot: {} }, weightBps: 6_000, leverage: 1 }, { kind: { prediction: {} }, weightBps: 4_000, leverage: 1 }] as any,
    { side: { back: {} }, legsMask: 3, prices: legs.map((l) => ({ entry: toPriceUnits(l.base), exit: toPriceUnits(l.mark) })) },
  )!;
  assert.equal(takeReturnPct(legs), direct / 100);
  assert.equal(takeReturnPct(legs), 0.6 * 10 + 0.4 * -25);
});

// --- Which asset a pick is -----------------------------------------------------------------------

test("picks resolve to what the trade would hold; cards and catalog-less picks are void", () => {
  assert.deepEqual(resolvePick({ name: "Pokemon", kind: "Stock", asset_id: "cards:Pokemon" }, sec({ id: "cards:Pokemon", kind: "card" }), bank).type, "void");
  assert.deepEqual(resolvePick({ name: "Cash", kind: "Earns interest", asset_id: null }, undefined, bank), { type: "yield" });
  assert.equal(resolvePick({ name: "Micron", kind: "Stock", asset_id: null }, undefined, bank).type, "void");
  assert.equal(resolvePick({ name: "W", kind: "Stock", asset_id: "jup:WEIRD" }, sec({ id: "jup:WEIRD", kind: "stock", mint: "WEIRD" }), bank).type, "void", "unknown units per token");
  const pepe = resolvePick({ name: "PEPE 3x", kind: "Stock · 3x", asset_id: "phoenix:kPEPE" }, sec({ id: "phoenix:kPEPE", kind: "perp" }), bank);
  assert.deepEqual(pepe, { type: "perp", symbol: "kPEPE", units: 1_000, leverage: 3 });
  const no = resolvePick({ name: "Rate cut: No", kind: "Prediction · No", asset_id: "gemini:GEMI-CUT" }, sec({ id: "gemini:GEMI-CUT", kind: "prediction", data: { eventTicker: "FED" } }), bank);
  assert.deepEqual(no, { type: "prediction", eventTicker: "FED", instrument: "GEMI-CUT", side: "no" });
  assert.equal(nvda.stock, "NVDA");
  assert.equal(leverageOf("Stock"), 1);
  assert.equal(predictionSide({ name: "Rates under 6%: Yes", kind: "Prediction · Yes" }), "yes");
});

// --- Marks: the settler's rules ----------------------------------------------------------------

test("spot with no base: the liquid token, recording its premium to a fresh trade and its multiplier", () => {
  const m = markPick(nvda, snap(), null);
  assert.ok(m.ok);
  assert.equal(m.price, 103);
  assert.deepEqual(m.source, { source: "token", rule: "token", mint: "NVDAx", perUi: 1, multiplier: 1, premium: 1.03 });
});

test("no band: a liquid token 40% off a fresh trade is still the base; a pool under the floor isn't", () => {
  const m = markPick(nvda, snap({ tokens: new Map([["NVDAx", { usdPrice: 60, liquidityUsd: 5_000_000, scaledUi: null }]]) }), null);
  assert.ok(m.ok && m.source.source === "token");
  assert.equal(m.price, 60);
  const dust = markPick(nvda, snap({ tokens: new Map([["NVDAx", { usdPrice: 60, liquidityUsd: 113, scaledUi: null }]]) }), null);
  assert.ok(dust.ok && dust.source.source === "stock");
  assert.equal(dust.price, 100);
});

test("with the market shut there's no band: a real 10% weekend move on the token is the mark", () => {
  const m = markPick(nvda, snap({ tokens: new Map([["NVDAx", { usdPrice: 90, liquidityUsd: 5_000_000, scaledUi: null }]]), stocks: new Map([["NVDA", { price: 100, at: NOW - 30 * 3600 }]]) }), null);
  assert.ok(m.ok && m.source.source === "token");
  assert.equal(m.price, 90);
});

test("a 10-for-1 split (multiplier 1 → 10) marks flat, not −90%; a dividend (→ 1.01) counts as return", () => {
  const base: Base["source"] = { source: "token", rule: "token", mint: "NVDAx", perUi: 1, multiplier: 1, premium: 1 };
  const split = markPick(nvda, snap({ tokens: new Map([["NVDAx", { usdPrice: 100, liquidityUsd: 5e6, scaledUi: { multiplier: 10, newMultiplier: 10, newMultiplierEffectiveAt: 0 } }]]) }), base);
  assert.ok(split.ok);
  assert.equal(legReturnPct("spot", 1, 1_000, split.price), 0);
  const div = markPick(nvda, snap({ tokens: new Map([["NVDAx", { usdPrice: 99, liquidityUsd: 5e6, scaledUi: { multiplier: 1.01, newMultiplier: 1.01, newMultiplierEffectiveAt: 0 } }]]) }), base);
  assert.ok(div.ok);
  assert.ok(Math.abs(legReturnPct("spot", 1, 100, div.price)!) < 0.02);
});

test("a token-priced base whose token is thin now: the stock times the base's premium (no basis mixing)", () => {
  const base: Base["source"] = { source: "token", rule: "token", mint: "NVDAx", perUi: 1, multiplier: 1, premium: 1.02 };
  const m = markPick(nvda, snap({ tokens: new Map([["NVDAx", { usdPrice: 50, liquidityUsd: 1_000, scaledUi: null }]]), stocks: new Map([["NVDA", { price: 110, at: NOW }]]) }), base);
  assert.ok(m.ok);
  assert.ok(Math.abs(m.price - 112.2) < 1e-9);
  const noPremium = markPick(nvda, snap({ tokens: new Map() }), { ...base, premium: null });
  assert.ok(!noPremium.ok, "no premium: no mark rather than the raw stock");
});

test("a stock-priced base stays on the stock even when the token is liquid", () => {
  const base: Base["source"] = { source: "stock", rule: "stock-first-trade", code: "NVDA", mint: "NVDAx", multiplier: 1 };
  const m = markPick(nvda, snap(), base);
  assert.ok(m.ok);
  assert.equal(m.price, 100);
});

test("perps mark per underlying unit (kPEPE = 1,000 PEPE); yield marks jlUSDC's share", () => {
  const pepe: PickAsset = { type: "perp", symbol: "kPEPE", units: 1_000, leverage: 3 };
  const m = markPick(pepe, snap({ perps: new Map([["kPEPE", { price: 0.00385, rule: "phoenix-mark" }]]) }), null);
  assert.ok(m.ok);
  assert.ok(Math.abs(m.price - 0.00000385) < 1e-15);
  const y = markPick({ type: "yield" }, snap(), null);
  assert.ok(y.ok && y.price === 1.05);
});

test("an incoherent Gemini book (a crossed live weather contract) gives no mark; a resolved one marks 1/0", () => {
  const pick: PickAsset = { type: "prediction", eventTicker: "FED", instrument: "GEMI-CUT", side: "yes" };
  const crossed = contract({ ask: { yes: 0.01, no: 0.19 }, bid: { yes: 0.81, no: 0.99 } });
  assert.ok(!markPick(pick, snap({ events: new Map([["FED", [crossed]]]) }), null).ok);
  const resolved = contract({ ...crossed, resolutionSide: "yes", status: "settled" });
  const m = markPick(pick, snap({ events: new Map([["FED", [resolved]]]) }), null);
  assert.ok(m.ok && m.price === 1);
  const sane = markPick(pick, snap({ events: new Map([["FED", [contract()]]]) }), null);
  assert.ok(sane.ok && sane.price === 0.4, "the side's bid");
});

// --- A take's run --------------------------------------------------------------------------------

const leg = (o: Partial<Leg> & { idx: number }): Leg => ({ name: "NVIDIA", kind: "Stock", weight: 50, asset_id: "jup:NVDAx", ...o });

test("a new take: bases are its first marks, so it starts at 0%; cards are left out", () => {
  const legs = [leg({ idx: 0, weight: 70 }), leg({ idx: 1, name: "Pokemon", asset_id: "cards:Pokemon", weight: 30 })];
  const assets = new Map<number, PickAsset>([[0, nvda], [1, { type: "void", reason: "cards aren't priced yet" }]]);
  const plan = planTake({ id: "T", created_at: iso(NOW - 60) }, legs, assets, snap());
  assert.deepEqual(plan.take, { take_id: "T", ret_pct: 0 });
  assert.equal(plan.legs.length, 1);
  assert.equal(plan.legs[0].base_price, 103);
  assert.equal(plan.legs[0].base_source?.rule, "token");
  assert.equal(plan.legs[0].base_source && "backfill" in plan.legs[0].base_source, false, "a live base isn't a backfill");
  assert.ok(plan.notes.some((n) => n.includes("void")));
});

test("an older take backfills from history (the stock's first trade after posting) and moves from there", () => {
  const legs = [leg({ idx: 0, weight: 100 })];
  const historical = new Map<number, Base>([[0, { price: 95, at: iso(NOW - 86_400), source: { source: "stock", rule: "stock-first-trade", code: "NVDA", mint: "NVDAx", multiplier: 1, backfill: "the stock's first trade at or after the posting" } }]]);
  const plan = planTake({ id: "T", created_at: iso(NOW - 86_400) }, legs, new Map([[0, nvda]]), snap(), historical);
  assert.equal(plan.legs[0].base_price, 95);
  assert.equal(plan.legs[0].mark_price, 100, "a stock base marks on the stock");
  assert.equal(plan.take!.ret_pct, 5.26, "5/95, in whole bps like the program");
});

test("an older take with no history: the first mark is the base, flagged as a backfill", () => {
  const paxg = resolvePick({ name: "Gold", kind: "Commodity", asset_id: "jup:PAXG" }, sec({ id: "jup:PAXG", kind: "commodity", mint: "PAXG" }), bank);
  const s = snap({ tokens: new Map([["PAXG", { usdPrice: 3_800, liquidityUsd: 150_000, scaledUi: null }]]) });
  const plan = planTake({ id: "T", created_at: iso(NOW - 10 * 86_400) }, [leg({ idx: 0, name: "Gold", kind: "Commodity", asset_id: "jup:PAXG", weight: 100 })], new Map([[0, paxg]]), s);
  assert.equal(plan.legs[0].base_price, 3_800);
  assert.match(String((plan.legs[0].base_source as any).backfill), /first mark/);
});

test("a pick with no price this run keeps its last mark (not rewritten); one never marked holds the take back", () => {
  const pick: PickAsset = { type: "prediction", eventTicker: "FED", instrument: "GEMI-CUT", side: "yes" };
  const crossed = snap({ events: new Map([["FED", [contract({ ask: { yes: 0.01, no: 0.19 }, bid: { yes: 0.81, no: 0.99 } })]]]) });
  const marked: Leg = { idx: 0, name: "Cut: Yes", kind: "Prediction · Yes", weight: 50, asset_id: "gemini:GEMI-CUT", base_price: 0.4, base_at: iso(NOW - 3600), base_source: { source: "gemini", rule: "gemini-bid", instrument: "GEMI-CUT", side: "yes" }, mark_price: 0.5 };
  const stock: Leg = { ...leg({ idx: 1, weight: 50 }), base_price: 100, base_at: iso(NOW - 3600), base_source: { source: "token", rule: "token", mint: "NVDAx", perUi: 1, multiplier: 1, premium: 1 }, mark_price: 100 };
  const plan = planTake({ id: "T", created_at: iso(NOW - 3600) }, [marked, stock], new Map<number, PickAsset>([[0, pick], [1, nvda]]), crossed);
  assert.deepEqual(plan.legs.map((l) => l.idx), [1], "the prediction isn't rewritten");
  assert.equal(plan.take!.ret_pct, 0.5 * 25 + 0.5 * 3, "uses the prediction's last mark");

  const never = planTake({ id: "T", created_at: iso(NOW - 3600) }, [{ ...marked, base_price: null, base_source: null, mark_price: null }, stock], new Map<number, PickAsset>([[0, pick], [1, nvda]]), crossed);
  assert.equal(never.take, null, "no return written rather than a wrong one");
});

test("a prediction with no bid yet (one-sided book) bases on the ask and marks flat, instead of holding its take back", () => {
  const pick: PickAsset = { type: "prediction", eventTicker: "FED", instrument: "GEMI-CUT", side: "yes" };
  const oneSided = snap({ events: new Map([["FED", [contract({ ask: { yes: 0.3, no: 0.75 }, bid: { yes: null, no: 0.68 } })]]]) });
  const plan = planTake({ id: "T", created_at: iso(NOW - 60) }, [{ idx: 0, name: "Gold: Yes", kind: "Prediction · Yes", weight: 15, asset_id: "gemini:GEMI-CUT" }, leg({ idx: 1, weight: 85 })], new Map<number, PickAsset>([[0, pick], [1, nvda]]), oneSided);
  assert.ok(plan.take, "the take gets a return");
  const p = plan.legs.find((l) => l.idx === 0)!;
  assert.equal(p.base_price, 0.3);
  assert.equal(p.mark_price, 0.3);
  assert.equal(p.ret_pct, 0);
  assert.equal((p.base_source as { rule: string }).rule, "gemini-ask");
  // Once a bid appears, it marks off that ask base like any prediction.
  const later = snap({ events: new Map([["FED", [contract({ ask: { yes: 0.42, no: 0.6 }, bid: { yes: 0.39, no: 0.56 } })]]]) });
  const next = planTake({ id: "T", created_at: iso(NOW - 60) }, [{ idx: 0, name: "Gold: Yes", kind: "Prediction · Yes", weight: 15, asset_id: "gemini:GEMI-CUT", base_price: 0.3, base_at: iso(NOW), base_source: p.base_source!, mark_price: 0.3 }], new Map<number, PickAsset>([[0, pick]]), later);
  assert.equal(next.legs[0].ret_pct, 30);
});

test("a prediction that resolved before its first mark is void (no history to base it on), not a take held back for good", () => {
  const pick: PickAsset = { type: "prediction", eventTicker: "FED", instrument: "GEMI-CUT", side: "yes" };
  const s = snap({ events: new Map([["FED", [contract({ resolutionSide: "no", status: "settled" })]]]) });
  const plan = planTake({ id: "T", created_at: iso(NOW - 5 * 86_400) }, [{ idx: 0, name: "Cut: Yes", kind: "Prediction · Yes", weight: 30, asset_id: "gemini:GEMI-CUT" }, leg({ idx: 1, weight: 70 })], new Map<number, PickAsset>([[0, pick], [1, nvda]]), s);
  assert.deepEqual(plan.take, { take_id: "T", ret_pct: 0 });
  assert.ok(plan.notes.some((n) => /void \(resolved no/.test(n)));
});

// --- On-chain positions --------------------------------------------------------------------------

test("an on-chain position's live return is the program's formula on its signed entries", () => {
  const legs = [{ kind: { spot: {} }, weightBps: 6_000, leverage: 1 }, { kind: { prediction: {} }, weightBps: 4_000, leverage: 1 }];
  const entries = [toPriceUnits(100), toPriceUnits(0.4)];
  const back = positionLiveBps(legs, { side: { back: {} }, legsMask: 3, entrySet: 3, entries }, [110, 0.5]);
  assert.equal(back, 6_000 * 0.1 + 4_000 * 0.25);
  // A fade's prediction leg is priced in the leg's terms (1 − the other side), the program's No formula.
  const fade = positionLiveBps(legs, { side: { fade: {} }, legsMask: 2, entrySet: 2, entries }, [null, 0.3]);
  assert.equal(fade, Math.trunc(((0.4 - 0.3) / (1 - 0.4)) * 10_000));
  assert.equal(positionLiveBps(legs, { side: { back: {} }, legsMask: 3, entrySet: 1, entries }, [110, 0.5]), null, "an included leg with no entry yet");
  assert.equal(positionLiveBps(legs, { side: { back: {} }, legsMask: 3, entrySet: 3, entries }, [110, null]), null, "no exit price now");
});

test("a fade's spot leg exits on the Phoenix short it holds; a back's on its token", () => {
  const s = snap({ perps: new Map([["NVDA", { price: 99, rule: "phoenix-mark" }]]) });
  assert.equal(positionExit(nvda, "fade", s, bank, NOW - 3600), 99);
  assert.equal(positionExit(nvda, "back", s, bank, NOW - 3600), 103);
  const fadeNo = positionExit({ type: "prediction", eventTicker: "FED", instrument: "GEMI-CUT", side: "yes" }, "fade", snap({ events: new Map([["FED", [contract()]]]) }), bank, null);
  assert.ok(Math.abs(fadeNo! - (1 - 0.56)) < 1e-12, "a fade holds No: 1 − the No bid");
});

// --- Batched chain reads ---------------------------------------------------------------------------

test("positions are read 100 per call, and a missing one is skipped until the hourly full check", async () => {
  let now = 0;
  const missing = new MissingAccounts(60 * 60_000, () => now);
  const calls: string[][] = [];
  const onChain = new Set(Array.from({ length: 150 }, (_, i) => `p${i}`).filter((_, i) => i % 3 === 0));
  const fetch = async (keys: string[]) => (calls.push(keys), keys.map((k) => (onChain.has(k) ? Buffer.from(k) : null)));
  const addresses = Array.from({ length: 250 }, (_, i) => `p${i}`);

  assert.equal(missing.startRun(), true, "the first run is a full check");
  const first = await readBatched(addresses, fetch, (d) => d.toString(), missing);
  assert.deepEqual(calls.map((c) => c.length), [100, 100, 50]);
  assert.equal(first.size, 50);
  assert.equal(missing.size, 200);

  // Next run: only the 50 found are read again, in one call.
  now += 5 * 60_000;
  calls.length = 0;
  assert.equal(missing.startRun(), false);
  const second = await readBatched([...addresses, "p0"], fetch, (d) => d.toString(), missing);
  assert.deepEqual(calls.map((c) => c.length), [50]);
  assert.equal(second.size, 50);

  // An hour on: every address is read again.
  now += 60 * 60_000;
  calls.length = 0;
  assert.equal(missing.startRun(), true);
  await readBatched(addresses, fetch, (d) => d.toString(), missing);
  assert.deepEqual(calls.map((c) => c.length), [100, 100, 50]);
});

test("an account that doesn't decode counts as missing; a fresh one is never recorded", async () => {
  const missing = new MissingAccounts();
  missing.startRun();
  const fetch = async (keys: string[]) => keys.map(() => null as Buffer | null);
  await readBatched(["new", "old"], fetch, (d) => d, missing, new Set(["new"]));
  assert.equal(missing.has("old"), true);
  assert.equal(missing.has("new"), false, "just opened: the RPC may not show it yet");

  const wrong = await readBatched(["other"], async () => [Buffer.from("x")], () => { throw new Error("bad discriminator"); }, missing);
  assert.equal(wrong.size, 0);
  assert.equal(missing.has("other"), true);
});
