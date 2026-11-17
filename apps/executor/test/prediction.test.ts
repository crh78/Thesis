// Prediction legs (Gemini paper fills): the prices the settler signs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEvent, type GeminiContract } from "@thesis/venues/gemini";
import { priceLeg, type LegToPrice, type PriceRules, type Sources } from "../src/settler/pricing.ts";
import type { EntryBasis } from "../src/settler/basis.ts";

const T = 1_800_000_000;
const rules: PriceRules = { minLiquidityUsd: 100_000, liveWindowSecs: 300, maxDelaySecs: 4 * 86_400 };
const iso = (s: number) => new Date(s * 1000).toISOString();

// Gemini quotes one book (Yes): bestBid / bestAsk. No is its complement (ask 1 − bid, bid 1 − ask).
function event(o: { status?: string; resolutionSide?: "yes" | "no"; expiry?: number; bestBid?: string | null; bestAsk?: string | null } = {}) {
  return parseEvent({
    ticker: "UNEMP2026",
    title: "Unemployment rate",
    status: o.status ?? "active",
    contracts: [{
      instrumentSymbol: "GEMI-UNEMP2026-GT5",
      label: "Above 5%",
      status: o.status ?? "active",
      resolutionSide: o.resolutionSide,
      expiryDate: iso(o.expiry ?? T + 30 * 86_400),
      prices: {
        ...(o.bestBid === null ? {} : { bestBid: o.bestBid ?? "0.38" }),
        ...(o.bestAsk === null ? {} : { bestAsk: o.bestAsk ?? "0.4" }),
      },
    }],
  });
}

const sources = (contracts: GeminiContract[] | null): Sources => ({
  stocks: { firstTradeAtOrAfter: async () => null, latestTrade: async () => null },
  tokens: { price: async () => null },
  predictions: contracts ? { event: async () => contracts } : undefined,
} as unknown as Sources);

const leg = (held: "back" | "fade", side: "yes" | "no" = "yes"): LegToPrice => {
  const [contract] = event();
  return { index: 1, kind: "prediction", underlying: null, token: null, prediction: { contract, side }, held };
};
const basis: EntryBasis = { source: "gemini", eventTicker: "UNEMP2026", instrument: "GEMI-UNEMP2026-GT5", side: "yes" };

test("entry: a back pays the side's ask, and records the contract as its basis", async () => {
  const r = await priceLeg(leg("back"), T, T + 30, rules, sources(event()));
  assert.ok(r.ok);
  assert.equal(r.quote.price, 0.4);
  assert.equal(r.quote.rule, "gemini-ask");
  assert.equal(r.quote.publishedAt, T + 30);
  assert.deepEqual(r.quote.basis, basis);
});

test("entry: a fade holds No, recorded as 1 − No's ask for the program", async () => {
  const r = await priceLeg(leg("fade"), T, T + 30, rules, sources(event()));
  assert.ok(r.ok);
  assert.ok(Math.abs(r.quote.price - 0.38) < 1e-12);
});

test("exit: the bid while it trades, 1 or 0 once resolved", async () => {
  const bid = await priceLeg(leg("back"), T, T + 30, rules, sources(event()), basis);
  assert.ok(bid.ok && bid.quote.price === 0.38 && bid.quote.rule === "gemini-bid");
  const yes = await priceLeg(leg("back"), T, T + 30, rules, sources(event({ status: "settled", resolutionSide: "yes", bestBid: null, bestAsk: null })), basis);
  assert.ok(yes.ok && yes.quote.price === 1 && yes.quote.rule === "gemini-resolution");
  const no = await priceLeg(leg("fade"), T, T + 30, rules, sources(event({ status: "settled", resolutionSide: "no", bestBid: null, bestAsk: null })), basis);
  assert.ok(no.ok && no.quote.price === 0, "a fade's exit is the leg's own result; the program's No formula pays the fade");
});

test("exit: a contract that stopped trading waits for its resolution", async () => {
  const r = await priceLeg(leg("back"), T, T + 30, rules, sources(event({ expiry: T - 60, bestBid: null })), basis);
  assert.ok(!r.ok && r.retry && /waiting for Gemini to resolve/.test(r.reason));
  const late = await priceLeg(leg("back"), T, T + rules.maxDelaySecs + 1, rules, sources(event()), basis);
  assert.ok(!late.ok && !late.retry, "past the deadline it's left unpriced (0%, unscored after the grace period)");
});

test("no source, no contract, or no ask: waits rather than guessing", async () => {
  const none = await priceLeg(leg("back"), T, T + 30, rules, sources(null));
  assert.ok(!none.ok && none.retry && /GEMINI_PROXY_TOKEN/.test(none.reason));
  const missing = await priceLeg({ ...leg("back"), prediction: null }, T, T + 30, rules, sources(event()));
  assert.ok(!missing.ok && /isn't in the asset bank/.test(missing.reason));
  const oneSided = await priceLeg(leg("back"), T, T + 30, rules, sources(event({ bestAsk: null })));
  assert.ok(!oneSided.ok && oneSided.retry && /no ask on yes/.test(oneSided.reason));
});
