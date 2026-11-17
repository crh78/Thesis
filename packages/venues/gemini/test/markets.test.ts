import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchGeminiEvent, ineligible, legPrice, parseEvent, predictionIdHex } from "../src/index.ts";

// Shapes recorded from api.gemini.com/v1/prediction-markets/events (through the proxy), trimmed.
const active = {
  ticker: "UNEMP2026",
  title: "Unemployment rate in 2026",
  category: "Economics",
  status: "active",
  contracts: [
    { instrumentSymbol: "GEMI-UNEMP2026-GT5", label: "Above 5%", status: "active", expiryDate: "2027-01-08T13:30:00.000Z", prices: { buy: { yes: "0.1", no: "0.97" }, sell: { yes: "0.03", no: "0.9" }, bestBid: "0.03", bestAsk: "0.1" } },
    { instrumentSymbol: "GEMI-UNEMP2026-GT9", label: "Above 9%", status: "active", expiryDate: "2027-01-08T13:30:00.000Z", prices: { buy: { yes: "0.02" }, sell: {}, bestAsk: "0.02" } },
  ],
};
const settled = {
  data: {
    ticker: "CPI261210",
    title: "CPI",
    status: "settled",
    contracts: [{ instrumentSymbol: "GEMI-CPI261210-CPI26NOV24", label: "2.40%", status: "settled", resolutionSide: "yes", resolvedAt: "2026-12-10T14:10:22.362Z", expiryDate: "2026-12-10T12:35:00.000Z", prices: { buy: {}, sell: {} } }],
  },
};
const NOW = Date.parse("2026-12-15T12:00:00Z");

test("parses contracts with each side's ask and bid", () => {
  const [gt5, gt9] = parseEvent(active);
  assert.equal(gt5.eventTicker, "UNEMP2026");
  assert.deepEqual([gt5.ask, gt5.bid], [{ yes: 0.1, no: 0.97 }, { yes: 0.03, no: 0.9 }]);
  assert.deepEqual([gt9.ask.no, gt9.bid.yes], [null, null]);
  const [cpi] = parseEvent(settled);
  assert.deepEqual([cpi.status, cpi.resolutionSide], ["settled", "yes"]);
});

test("an empty side of the book is no quote, even though Gemini fills prices.buy/sell with the last trade", () => {
  // Recorded live ("XRP price today at 2:55pm EST: Up"): a best bid of 0.40, nobody selling,
  // and buy.yes = 0.25, the last trade. Taking 0.25 as the ask would paper-fill a back below the bid.
  const [c] = parseEvent({
    ticker: "XRP05M", title: "XRP price today at 2:55pm EST", status: "active",
    contracts: [{ instrumentSymbol: "GEMI-XRP05M-UP", label: "Up", status: "active", expiryDate: "2027-01-08T13:30:00.000Z",
      prices: { buy: { yes: "0.25", no: "0.6" }, sell: { yes: "0.4", no: "0.75" }, bestBid: "0.4", lastTradePrice: "0.25" } }],
  });
  assert.deepEqual(c.ask, { yes: null, no: 0.6 });
  assert.deepEqual(c.bid, { yes: 0.4, no: null });
  assert.equal(legPrice(c, "yes", "back", "entry"), null, "no ask on Yes: a back can't be filled");
  assert.match(ineligible(c, "yes", NOW)!, /no market on Yes/);
});

test("eligibility: open, at least an hour out, two-sided on the chosen side", () => {
  const [gt5, gt9] = parseEvent(active);
  assert.equal(ineligible(gt5, "yes", NOW), null);
  assert.equal(ineligible(gt5, "no", NOW), null);
  assert.match(ineligible(gt9, "yes", NOW)!, /no market on Yes/);
  assert.match(ineligible(gt5, "yes", Date.parse("2027-01-08T13:00:00Z"))!, /within the hour/);
  assert.match(ineligible(parseEvent(settled)[0], "yes", NOW)!, /settled/);
});

test("prices: entry at the held side's ask, exit at its bid, a fade through 1 − the other side", () => {
  const [gt5] = parseEvent(active);
  assert.equal(legPrice(gt5, "yes", "back", "entry"), 0.1);
  assert.equal(legPrice(gt5, "yes", "back", "exit"), 0.03);
  // A fade of a Yes leg holds No: entry 1 − 0.97, exit 1 − 0.9 (in Yes terms, for the program).
  assert.ok(Math.abs(legPrice(gt5, "yes", "fade", "entry")! - 0.03) < 1e-12);
  assert.ok(Math.abs(legPrice(gt5, "yes", "fade", "exit")! - 0.1) < 1e-12);
  // A back of No holds No.
  assert.equal(legPrice(gt5, "no", "back", "entry"), 0.97);
  const [cpi] = parseEvent(settled);
  assert.equal(legPrice(cpi, "yes", "back", "exit"), 1);
  assert.equal(legPrice(cpi, "no", "back", "exit"), 0);
  assert.equal(legPrice(cpi, "yes", "fade", "exit"), 1, "a fade's exit is the Yes-side result; the program's No formula does the rest");
  assert.equal(legPrice(cpi, "yes", "back", "entry"), null, "no entry on a closed contract");
});

test("leg ids differ by contract and side", () => {
  const a = predictionIdHex("GEMI-UNEMP2026-GT5", "yes");
  assert.equal(a.length, 64);
  assert.notEqual(a, predictionIdHex("GEMI-UNEMP2026-GT5", "no"));
  assert.notEqual(a, predictionIdHex("GEMI-UNEMP2026-GT6", "yes"));
});

test("fetches one event through the proxy", async () => {
  let asked = "";
  const fake = (async (u: string, init: RequestInit) => {
    asked = u;
    assert.equal((init.headers as Record<string, string>)["x-gemini-proxy-token"], "t");
    return new Response(JSON.stringify(settled));
  }) as typeof fetch;
  const out = await fetchGeminiEvent({ base: "https://p.example/functions/v1/gemini", token: "t" }, "CPI261210", fake);
  assert.equal(asked, "https://p.example/functions/v1/gemini/events/CPI261210");
  assert.equal(out[0].resolutionSide, "yes");
});
