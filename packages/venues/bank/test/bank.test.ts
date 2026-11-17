import { test } from "node:test";
import assert from "node:assert/strict";
import { viewAssetBank } from "../src/read.ts";
import { bankBestIssuer, classifyToken, isFreshTradeable, reclassify, referencePrice } from "../src/state.ts";
import { NOW, bySymbol, fixture, fixtureState } from "./helpers.ts";

const MIN = 60_000;
const F = { maxProbeAgeMs: 20 * MIN, maxPriceAgeMs: 10 * MIN, maxVenueAgeMs: 45 * MIN, maxGeminiAgeMs: 780 * MIN };
const CLS = { tradeableCostPct: 1, maxDeviationPct: 5, refMaxAgeMs: 10 * MIN };

/** Fixture state where every token has a probe built from its recorded quotes. */
function probedState(ageMs = MIN) {
  const s = fixtureState(ageMs);
  const at = new Date(NOW - ageMs).toISOString();
  for (const t of Object.values(s.tokens)) {
    const q = fixture.quotes[t.mint];
    t.probe = {
      at,
      maxAccounts: 30,
      quotes: [100, 1000].map((usd) => {
        const r = q[String(usd)];
        return r.quote
          ? { usd, routed: true, outAmountRaw: r.quote.outAmount, priceImpactPct: Number(r.quote.priceImpactPct) * 100, hops: r.quote.routePlan.length, venues: [], error: null }
          : { usd, routed: false, outAmountRaw: null, priceImpactPct: null, hops: null, venues: [], error: r.error };
      }),
    };
    if (!t.price) t.price = { usd: 1, underlyingUsd: null, at };
  }
  reclassify(s, NOW, CLS);
  return s;
}

test("reference price prefers Jupiter's stockData price, else the median of issuers", () => {
  const s = probedState();
  const nv = referencePrice(s, s.underlyings["equity:US:NVDA"], NOW, 10 * MIN)!;
  assert.equal(nv.source, "jupiter stockData.price");
  const xau = referencePrice(s, s.underlyings["commodity:XAU"], NOW, 10 * MIN)!;
  assert.match(xau.source, /median/);
  assert.ok(xau.usd > 3000 && xau.usd < 6000, String(xau.usd));
  // Stale prices are not used.
  assert.equal(referencePrice(s, s.underlyings["commodity:XAU"], NOW + 60 * MIN, 10 * MIN), null);
});

test("classification: cheap routes are tradeable, thin pools are not, wrong ratios are flagged", () => {
  const s = probedState();
  assert.equal(bySymbol(s, "NVDAx").liquidity.class, "tradeable");
  assert.equal(bySymbol(s, "NVDAon").liquidity.class, "thin"); // ~5% impact at $100
  assert.equal(bySymbol(s, "NVDAr").liquidity.class, "no-route");
  assert.equal(bySymbol(s, "VNXAU").liquidity.class, "tradeable");
  const vnx = bySymbol(s, "VNXAU");
  const wrong = { ...vnx, ratio: { ...vnx.ratio, underlyingPerUiToken: 1 } as typeof vnx.ratio };
  const l = classifyToken(wrong, s.underlyings["commodity:XAU"].refPriceUsd, { nowSec: NOW / 1000, tradeableCostPct: 1, maxDeviationPct: 5 });
  assert.equal(l.ratioSuspect, true);
  assert.equal(l.class, "thin");
  const paused = classifyToken({ ...vnx, paused: true }, 1, { nowSec: NOW / 1000, tradeableCostPct: 1, maxDeviationPct: 5 });
  assert.equal(paused.class, "paused");
});

test("stale filtering: old probes or old prices drop out of the AI's bank", () => {
  const s = probedState();
  const x = bySymbol(s, "NVDAx");
  assert.ok(isFreshTradeable(x, NOW, F));
  assert.ok(!isFreshTradeable(x, NOW + 21 * MIN, F), "probe older than 20 min");
  x.price!.at = new Date(NOW - 11 * MIN).toISOString();
  assert.ok(!isFreshTradeable(x, NOW, F), "price older than 10 min");
});

test("getAssetBank view: only fresh tradeable issuers, grouped by underlying and theme, with the best issuer", () => {
  const s = probedState();
  const v = viewAssetBank(s, NOW, F);
  const nv = v.underlyings.find((u) => u.key === "equity:US:NVDA")!;
  assert.equal(nv.best?.symbol, "NVDAx");
  assert.deepEqual(nv.issuers.map((i) => i.symbol).sort(), ["NVDA", "NVDAx"]); // NVDAon is thin, NVDAr unroutable
  assert.equal(nv.idHex.length, 64);
  assert.ok(v.byTheme["AI and compute"].includes("equity:US:NVDA"));
  assert.ok(v.byTheme.Commodities.includes("commodity:XAU"));
  assert.equal(v.underlyings.find((u) => u.key === "commodity:XAU")!.best?.symbol, "VNXAU");
  // Every listed issuer is tradeable and fresh.
  for (const u of v.underlyings) for (const i of u.issuers) assert.ok(isFreshTradeable(s.tokens[i.mint], NOW, F));

  // Make one issuer stale: it leaves the list and the best issuer moves.
  bySymbol(s, "NVDAx").probe!.at = new Date(NOW - 30 * MIN).toISOString();
  const v2 = viewAssetBank(s, NOW, F);
  assert.equal(v2.underlyings.find((u) => u.key === "equity:US:NVDA")!.best?.symbol, "NVDA");

  // Everything stale: the bank is empty rather than wrong.
  assert.equal(viewAssetBank(s, NOW + 2 * 3_600_000, F).underlyings.length, 0);
});

test("perps keep an underlying in the bank when its venue snapshot is fresh", () => {
  const s = probedState();
  s.venues.phoenix = { at: new Date(NOW - MIN).toISOString(), gated: false, markets: [{ symbol: "NVDA", name: "NVIDIA", marketPubkey: "x", underlying: "equity:US:NVDA", unitsPerContract: 1, maxLeverage: 10, takerFeeBps: 3.5, mid: 201, spreadBps: 2, depthUsdWithin1Pct: { bids: 1e5, asks: 1e5 }, buyImpact1000Pct: 0.02, tradeable: true }] };
  for (const t of Object.values(s.tokens)) t.probe!.at = new Date(NOW - 3_600_000).toISOString();
  const v = viewAssetBank(s, NOW, F);
  const nv = v.underlyings.find((u) => u.key === "equity:US:NVDA")!;
  assert.equal(nv.issuers.length, 0);
  assert.equal(nv.best, null);
  assert.equal(nv.perps[0].symbol, "NVDA");
  s.venues.phoenix.at = new Date(NOW - 60 * MIN).toISOString();
  assert.equal(viewAssetBank(s, NOW, F).underlyings.length, 0);
});

test("bank best issuer returns a non-comparable token only as the sole issuer", () => {
  const s = probedState();
  const u = s.underlyings["private:OPENAI"];
  const tradeable = u.mints.filter((m) => s.tokens[m].liquidity.class === "tradeable");
  assert.equal(tradeable.length, 1);
  assert.equal(bankBestIssuer(s, u, NOW, F)?.symbol, "tOpenAI");
  s.tokens[u.mints.find((m) => s.tokens[m].symbol === "OPENAI")!].liquidity.class = "tradeable";
  assert.equal(bankBestIssuer(s, u, NOW, F), null);
});
