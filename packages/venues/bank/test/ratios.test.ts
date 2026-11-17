import { test } from "node:test";
import assert from "node:assert/strict";
import { MINT_INFO } from "../../registry/src/curated.ts";
import { effectiveMultiplier, ratioFor, readScaledUi, underlyingUnits, usPersonsFor } from "../src/ratios.ts";
import { NOW, bySymbol, fixture, fixtureState } from "./helpers.ts";

const nowSec = Math.floor(NOW / 1000);
const mintOf = (issuerLike: RegExp) => Object.entries(MINT_INFO).find(([, i]) => issuerLike.test(i.issuer))![0];

test("a scheduled ScaledUiAmount multiplier takes over at its timestamp", () => {
  const s = { multiplier: 1.0009, newMultiplier: 1.0017, newMultiplierEffectiveAt: 2_000 };
  assert.equal(effectiveMultiplier(s, 1_999), 1.0009);
  assert.equal(effectiveMultiplier(s, 2_000), 1.0017);
  assert.equal(effectiveMultiplier({ ...s, newMultiplierEffectiveAt: 0 }, 9_999), 1.0009);
  assert.equal(effectiveMultiplier(null, 1), 1);
  // NVDAx as recorded: the stored multiplier is stale, the scheduled one is already in force.
  const nvdax = bySymbol(fixtureState(), "NVDAx");
  assert.equal(effectiveMultiplier(nvdax.scaledUi, nowSec), nvdax.scaledUi!.newMultiplier);
});

test("readScaledUi reads the jsonParsed extension and ignores mints without it", () => {
  const acc = { data: { parsed: { info: { extensions: [{ extension: "scaledUiAmountConfig", state: { multiplier: "10", newMultiplier: "10", newMultiplierEffectiveTimestamp: 1796083200 } }] } } } };
  assert.deepEqual(readScaledUi(acc), { multiplier: 10, newMultiplier: 10, newMultiplierEffectiveAt: 1796083200 });
  assert.equal(readScaledUi({ data: { parsed: { info: { extensions: [] } } } }), null);
});

test("units normalize decimals, multiplier, units per token and transfer fee", () => {
  const share = { decimals: 8, scaledUi: null, underlyingPerUiToken: 1 };
  assert.equal(underlyingUnits("100000000", share, nowSec), 1);
  // After a 10:1 split the multiplier is 10: the same raw amount is ten share-equivalents.
  assert.equal(underlyingUnits("100000000", { ...share, scaledUi: { multiplier: 10, newMultiplier: 10, newMultiplierEffectiveAt: 0 } }, nowSec), 10);
  // VNXAU: one token is one gram.
  const gram = ratioFor({ mint: mintOf(/VNX/), issuerTag: null, underlyingKey: "commodity:XAU" });
  assert.ok(gram.comparable);
  assert.ok(Math.abs(underlyingUnits("31103476800", { decimals: 9, scaledUi: null, underlyingPerUiToken: gram.underlyingPerUiToken! }, nowSec) - 1) < 1e-12);
  // A 1% Token-2022 transfer fee delivers 99%.
  assert.ok(Math.abs(underlyingUnits("100000000", { ...share, transferFeeBps: 100 }, nowSec) - 0.99) < 1e-12);
});

test("recorded NVDA quotes normalize to the same share price across issuers", () => {
  const s = fixtureState();
  const ref = s.underlyings["equity:US:NVDA"].refPriceUsd!;
  for (const sym of ["NVDAx", "NVDA"]) {
    const t = bySymbol(s, sym);
    const out = fixture.quotes[t.mint]["100"].quote.outAmount;
    const units = underlyingUnits(out, { decimals: t.decimals, scaledUi: t.scaledUi, underlyingPerUiToken: 1 }, nowSec);
    const px = 100 / units;
    assert.ok(Math.abs(px / ref - 1) < 0.005, `${sym}: $${px.toFixed(2)} vs ref $${ref.toFixed(2)}`);
  }
  // Without the multiplier NVDAx would look 0.17% more expensive than it is.
  const x = bySymbol(s, "NVDAx");
  const raw = Number(fixture.quotes[x.mint]["100"].quote.outAmount) / 1e8;
  assert.ok(underlyingUnits(fixture.quotes[x.mint]["100"].quote.outAmount, { decimals: x.decimals, scaledUi: x.scaledUi, underlyingPerUiToken: 1 }, nowSec) > raw * 1.0016);
});

test("comparability: sourced ratios only", () => {
  const r = (issuerTag: string | null, mint = "1".repeat(32), key = "equity:US:NVDA") => ratioFor({ mint, issuerTag, underlyingKey: key });
  assert.equal(r("xstocks").comparable, true);
  assert.equal(r("ondo").comparable, true);
  assert.equal(r("backpack").comparable, true);
  assert.equal(r("remora").comparable, false);
  assert.equal(r("prestocks", undefined, "private:OPENAI").comparable, false);
  assert.equal(r("tessera", undefined, "private:OPENAI").comparable, false);
  assert.equal(r(null, mintOf(/Paxos/), "commodity:XAU").comparable, true);
  assert.equal(r(null, mintOf(/token named GOLD/), "commodity:XAU").comparable, false);
  assert.equal(r(null, "1".repeat(32), "commodity:XAU").comparable, false);
  assert.equal(r(null, "1".repeat(32), `token:${"1".repeat(32)}`).comparable, true);
  assert.equal(usPersonsFor({ mint: "x", issuerTag: "xstocks" }), "no");
  assert.equal(usPersonsFor({ mint: mintOf(/USDY/), issuerTag: null }), "no");
  assert.equal(usPersonsFor({ mint: "x", issuerTag: "backpack" }), "unverified");
});
