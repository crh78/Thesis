import { test } from "node:test";
import assert from "node:assert/strict";
import { PRICEABLE_MIN_POOLED_USD, bestIssuer, breakTies, issuerPool, type Candidate } from "../src/route.ts";
import type { JupQuote } from "../src/jupiter.ts";
import { NOW, bySymbol, fixtureQuote, fixtureState } from "./helpers.ts";

const opts = (extra = {}) => ({ state: fixtureState(), quote: fixtureQuote, readMints: null, now: NOW, ...extra });

test("NVDA: the issuer with the most shares per dollar wins; non-comparable issuers are skipped", async () => {
  const r = await bestIssuer("equity:US:NVDA", 100, opts());
  assert.equal(r.basis, "compared");
  assert.equal(r.winner?.symbol, "NVDAx");
  assert.deepEqual(r.runnersUp.map((c) => c.symbol), ["NVDA", "NVDAon"]);
  assert.ok(r.winner!.unitsPerUsd > r.runnersUp[0].unitsPerUsd);
  assert.match(r.skipped.find((s) => s.symbol === "NVDAr")!.reason, /not comparable/);
  // Units include the scheduled multiplier now in force.
  assert.ok(Math.abs(r.winner!.uiMultiplier - 1.001701196801074) < 1e-12);
  assert.equal(r.idHex.length, 64);
});

test("NVDA $1,000: Ondo's thin pool loses on price impact", async () => {
  const r = await bestIssuer("equity:US:NVDA", 1000, opts());
  const ondo = r.runnersUp.find((c) => c.symbol === "NVDAon")!;
  assert.ok(ondo.priceImpactPct > 10, `impact ${ondo.priceImpactPct}`);
  assert.equal(r.runnersUp.at(-1)!.symbol, "NVDAon");
});

test("excludeUs skips issuers that exclude US persons and warns on unverified ones", async () => {
  const r = await bestIssuer("equity:US:NVDA", 1000, opts({ excludeUs: true }));
  assert.equal(r.winner?.symbol, "NVDA");
  assert.equal(r.winner?.issuerTag, "backpack");
  assert.ok(r.winner!.warnings.some((w) => /unverified/.test(w)));
  for (const s of ["NVDAx", "NVDAon"]) assert.match(r.skipped.find((x) => x.symbol === s)!.reason, /US persons/);
});

test("gold: units per token matter (VNXAU is one gram); unverified issuers are skipped", async () => {
  const r = await bestIssuer("commodity:XAU", 1000, opts());
  assert.equal(r.winner?.symbol, "VNXAU");
  assert.ok(Math.abs(r.winner!.effectivePriceUsd / r.referencePriceUsd! - 1) < 0.01);
  assert.deepEqual(r.skipped.map((s) => s.symbol).sort(), ["DGLD", "GOLD"]);
});

test("a wrong ratio is caught: a quote far below the reference price is skipped as suspect", async () => {
  const state = fixtureState();
  const vnx = bySymbol(state, "VNXAU");
  if (vnx.ratio.comparable) vnx.ratio = { ...vnx.ratio, underlyingPerUiToken: 1 }; // pretend a gram were an ounce
  const r = await bestIssuer("commodity:XAU", 1000, { ...opts(), state });
  assert.notEqual(r.winner?.symbol, "VNXAU");
  assert.match(r.skipped.find((s) => s.symbol === "VNXAU")!.reason, /ratio is suspect/);
});

test("non-comparable tokens: none when several, sole issuer when only one", async () => {
  const both = await bestIssuer("private:OPENAI", 100, opts());
  assert.equal(both.basis, "none");
  assert.equal(both.winner, null);
  const state = fixtureState();
  const u = state.underlyings["private:OPENAI"];
  u.mints = u.mints.filter((m) => state.tokens[m].symbol === "tOpenAI");
  const one = await bestIssuer("private:OPENAI", 100, { ...opts(), state });
  assert.equal(one.basis, "sole-issuer");
  assert.equal(one.winner?.symbol, "tOpenAI");
  assert.equal(one.winner?.comparable, false);
});

test("paused, permissioned and recently unroutable tokens are not quoted", async () => {
  const state = fixtureState();
  bySymbol(state, "NVDAx").paused = true;
  bySymbol(state, "NVDAon").defaultFrozen = true;
  const b = bySymbol(state, "NVDA");
  b.probe = { at: new Date(NOW - 60_000).toISOString(), maxAccounts: 30, quotes: [{ usd: 100, routed: false, outAmountRaw: null, priceImpactPct: null, hops: null, venues: [], error: "NO_ROUTES_FOUND" }] };
  const quoted: string[] = [];
  const r = await bestIssuer("equity:US:NVDA", 100, { ...opts(), state, quote: async (m, usd, o) => (quoted.push(m), fixtureQuote(m, usd, o)) });
  assert.equal(r.winner, null);
  assert.deepEqual(quoted, []);
  assert.deepEqual(Object.fromEntries(r.skipped.map((s) => [s.symbol, s.reason.split(" ")[0]])), { NVDAx: "mint", NVDAon: "permissioned", NVDA: "no", NVDAr: "not" });
  // A probe at fewer accounts than requested does not rule a token out.
  const wider = await bestIssuer("equity:US:NVDA", 100, { ...opts(), state, maxAccounts: 64 });
  assert.equal(wider.winner?.symbol, "NVDA");
});

test("live multipliers override the bank's copy", async () => {
  const state = fixtureState();
  const x = bySymbol(state, "NVDAx");
  const r = await bestIssuer("equity:US:NVDA", 100, { ...opts(), state, readMints: async (mints) => new Map(mints.map((m) => [m, m === x.mint ? { multiplier: 1.05, newMultiplier: 1.05, newMultiplierEffectiveAt: 0 } : state.tokens[m].scaledUi])) });
  assert.equal(r.winner?.symbol, "NVDAx");
  assert.equal(r.winner?.uiMultiplier, 1.05);
});

function cand(mint: string, unitsPerUsd: number, priceImpactPct: number, hops: number): Candidate {
  return { mint, symbol: mint, issuer: "", issuerTag: null, comparable: true, quote: {} as JupQuote, outAmountRaw: "0", units: unitsPerUsd * 100, unitsPerUsd, effectivePriceUsd: 1 / unitsPerUsd, premiumPct: 0, priceImpactPct, hops, uiMultiplier: 1, transferFeeBps: null, warnings: [] };
}

test("tie-breaks: price impact, then hops, then no permanent delegate, then pooled liquidity, then mint", () => {
  const tok = (permanentDelegate: boolean, jupiterPooledUsd: number) => ({ permanentDelegate, jupiterPooledUsd }) as any;
  let r = breakTies([cand("B", 1, 0.2, 1), cand("A", 1, 0.1, 2)], { A: tok(true, 1), B: tok(false, 9) });
  assert.equal(r.order[0].mint, "A");
  assert.equal(r.decidedBy, "lower price impact");
  r = breakTies([cand("B", 1, 0.1, 1), cand("A", 1, 0.1, 2)], { A: tok(false, 9), B: tok(true, 1) });
  assert.equal(r.order[0].mint, "B");
  assert.equal(r.decidedBy, "fewer route hops");
  r = breakTies([cand("B", 1, 0.1, 1), cand("A", 1, 0.1, 1)], { A: tok(true, 9), B: tok(false, 1) });
  assert.equal(r.decidedBy, "no permanent delegate");
  assert.equal(r.order[0].mint, "B");
  r = breakTies([cand("B", 1, 0.1, 1), cand("A", 1, 0.1, 1)], { A: tok(false, 1), B: tok(false, 9) });
  assert.equal(r.decidedBy, "more pooled liquidity");
  r = breakTies([cand("B", 1, 0.1, 1), cand("A", 1, 0.1, 1)], { A: tok(false, 1), B: tok(false, 1) });
  assert.equal(r.decidedBy, "mint address");
  assert.equal(r.order[0].mint, "A");
});

test("candidates within tieBps of the best go to the tie-breaks; others rank by units per dollar", async () => {
  const state = fixtureState();
  const [x, b] = [bySymbol(state, "NVDAx"), bySymbol(state, "NVDA")];
  // Same units per dollar for both (to the bp), Backpack with lower impact.
  const q = (out: string, impact: string): JupQuote => ({ inAmount: "100000000", outAmount: out, otherAmountThreshold: out, priceImpactPct: impact, slippageBps: 100, routePlan: [{ swapInfo: { label: "X" }, percent: 100 }] });
  const unitsX = 0.4965;
  const rawX = String(Math.round((unitsX / 1.001701196801074) * 1e8));
  const rawB = String(Math.round(unitsX * 0.99995 * 1e6));
  const quote = async (m: string) => ({ quote: m === x.mint ? q(rawX, "0.001") : m === b.mint ? q(rawB, "0.0001") : null, error: "skip" });
  const r = await bestIssuer("equity:US:NVDA", 100, { ...opts(), state, quote, tieBps: 1 });
  assert.equal(r.winner?.symbol, "NVDA");
  assert.equal(r.tieBreak, "lower price impact");
  const strict = await bestIssuer("equity:US:NVDA", 100, { ...opts(), state, quote, tieBps: 0 });
  assert.equal(strict.winner?.symbol, "NVDAx");
  assert.equal(strict.tieBreak, null);
});

test("issuerPool: what bestIssuer would quote, from the bank alone", async () => {
  const state = fixtureState();
  const quoted: string[] = [];
  await bestIssuer("equity:US:NVDA", 100, { ...opts(), state, quote: async (m, usd, o) => (quoted.push(m), fixtureQuote(m, usd, o)) });
  const pool = issuerPool("equity:US:NVDA", state, { now: NOW });
  assert.deepEqual(pool.pool.map((t) => t.mint).sort(), [...quoted].sort());
  assert.ok(pool.pool.length > 0);
  for (const t of pool.pool) bySymbol(state, t.symbol).paused = true;
  assert.equal(issuerPool("equity:US:NVDA", state, { now: NOW }).pool.length, 0);
  assert.throws(() => issuerPool("equity:US:NOPE", state), /unknown underlying/);
});

test("minPooledUsd skips issuers whose pool is too thin to price, or unknown", async () => {
  const state = fixtureState();
  bySymbol(state, "NVDAx").jupiterPooledUsd = 63;
  bySymbol(state, "NVDA").jupiterPooledUsd = null;
  const quoted: string[] = [];
  const r = await bestIssuer("equity:US:NVDA", 100, {
    ...opts(),
    state,
    minPooledUsd: PRICEABLE_MIN_POOLED_USD,
    quote: async (m, usd, o) => (quoted.push(m), fixtureQuote(m, usd, o)),
  });
  assert.notEqual(r.winner?.symbol, "NVDAx");
  assert.ok(!quoted.includes(bySymbol(state, "NVDAx").mint), "the thin issuer is never quoted");
  assert.ok(!quoted.includes(bySymbol(state, "NVDA").mint), "an issuer with no pool data isn't quoted");
  assert.equal(r.skipped.find((s) => s.symbol === "NVDA")!.reason, "pooled liquidity unknown");
  assert.match(r.skipped.find((s) => s.symbol === "NVDAx")!.reason, /^thin pool: \$63 pooled, under \$50,000$/);
  // Without the option nothing changes.
  const plain = await bestIssuer("equity:US:NVDA", 100, { ...opts(), state });
  assert.equal(plain.winner?.symbol, "NVDAx");
});

test("maxPriceImpactPct drops fills that move the price too much", async () => {
  const r = await bestIssuer("equity:US:NVDA", 1000, opts({ maxPriceImpactPct: 1 }));
  assert.ok(!r.runnersUp.some((c) => c.symbol === "NVDAon"));
  assert.match(r.skipped.find((s) => s.symbol === "NVDAon")!.reason, /^price impact \d+\.\d\d% is over 1%$/);
  assert.ok([r.winner!, ...r.runnersUp].every((c) => c.priceImpactPct <= 1));
});
