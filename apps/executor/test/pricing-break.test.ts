// Adversarial tests for the settler's pricing: try to make a leg's signed price, or the return
// computed from it, wrong. No network: every source is a fake.
//
//   BUG: ...   fails today; asserts what a correct price/return would be.
//   GAP: ...   passes; pins down behaviour that's documented as intended but costs accuracy.
//   (other)    passes; an edge case that holds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { positionReturnBps } from "@thesis/chain";
import { effectiveMultiplier, underlyingIdHex, underlyingUnits } from "@thesis/venues/bank";
import { ineligible, ineligibleAsPick, legPrice, type GeminiContract } from "@thesis/venues/gemini";
import type { TraderView } from "@thesis/venues/phoenix";
import type { EntryBasis } from "../src/settler/basis.ts";
import { GeminiEvents } from "../src/settler/gemini-source.ts";
import { pricePhoenixLeg, type PhoenixLegInput } from "../src/settler/phoenix-legs.ts";
import { priceLeg, toPriceUnits, type LegOutcome, type LegToPrice, type PriceRules, type Sources } from "../src/settler/pricing.ts";
import { receivedValueShortfall } from "../src/settler/proof.ts";
import type { Observation, Split } from "../src/settler/sources.ts";

const T = 1_800_000_000; // a fixed clock; only relative times matter
const DAY = 86_400;
const rules: PriceRules = { minLiquidityUsd: 100_000, liveWindowSecs: 300, staleRefSecs: 900, maxDelaySecs: 4 * DAY };
const NVDA = { key: "equity:US:NVDA", cls: "equity", code: "NVDA" };
const GOLD = { key: "commodity:XAU", cls: "commodity", code: "XAU" };

const spot = (o: Partial<LegToPrice> = {}): LegToPrice => ({ index: 0, kind: "spot", underlying: NVDA, token: { mint: "NVDAx", underlyingPerUiToken: 1 }, ...o });

/** `multiplier`: the mint's ScaledUiAmount multiplier (xStocks/Ondo); absent = no extension. */
type FakeToken = { usdPrice: number; liquidityUsd?: number; at?: number; multiplier?: number };

/** Fake sources. Each piece can be a value or a function of the call. */
function src(o: {
  token?: FakeToken | null | ((mint: string) => FakeToken | null);
  latest?: Observation | null;
  first?: Observation | null | ((from: number, until: number) => Observation | null);
  contracts?: GeminiContract[];
  lend?: number | null;
  /** Stock splits (Alpaca corporate actions): absent = no split source. */
  splits?: Split[];
}): Sources {
  return {
    stocks: {
      async firstTradeAtOrAfter(_s, from, until) {
        return typeof o.first === "function" ? o.first(from, until) : (o.first ?? null);
      },
      async latestTrade() {
        return o.latest ?? null;
      },
      ...(o.splits ? { splits: async (_s: string, from: number, until: number) => o.splits!.filter((x) => x.exAt > from && x.exAt <= until) } : {}),
    },
    tokens: {
      async price(mint) {
        const t = typeof o.token === "function" ? o.token(mint) : o.token;
        const scaledUi = t?.multiplier ? { multiplier: t.multiplier, newMultiplier: t.multiplier, newMultiplierEffectiveAt: 0 } : null;
        return t ? { mint, usdPrice: t.usdPrice, liquidityUsd: t.liquidityUsd ?? 5_000_000, at: t.at ?? 0, scaledUi, raw: {} } : null;
      },
    },
    predictions: o.contracts ? { event: async () => o.contracts! } : undefined,
    lend: o.lend === undefined ? undefined : { shareValue: async (m) => (o.lend == null ? null : { usdcPerShare: o.lend, at: 0, raw: { m } }) },
  };
}

const ok = (r: LegOutcome) => {
  assert.ok(r.ok, `expected a price, got: ${!r.ok ? r.reason : ""}`);
  return r.quote;
};

/** Return in bps of one leg, through the program's mirror (prices in USD). */
function legReturnBps(kind: "spot" | "perp" | "prediction" | "yield", side: "back" | "fade", entry: number, exit: number, leverage = 1) {
  return positionReturnBps([{ kind: { [kind]: {} }, weightBps: 10_000, leverage }], {
    side: { [side]: {} },
    legsMask: 1,
    prices: [{ entry: toPriceUnits(entry), exit: toPriceUnits(exit) }],
  });
}

// ---------------------------------------------------------------------------------------------
// Spot: tokens, stocks, premiums, windows
// ---------------------------------------------------------------------------------------------

test("a bad token price (0, negative, NaN) never signs: falls back to the stock", async () => {
  for (const usdPrice of [0, -5, Number.NaN]) {
    const q = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice }, first: { price: 100, at: T + 5, raw: {} } })));
    assert.equal(q.rule, "stock-first-trade", `usdPrice ${usdPrice}`);
    assert.equal(q.price, 100);
  }
});

test("NaN liquidity counts as thin, not liquid", async () => {
  const q = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice: 100, liquidityUsd: Number.NaN }, first: { price: 99, at: T + 1, raw: {} } })));
  assert.equal(q.rule, "stock-first-trade");
});

test("liquidity exactly at the threshold is liquid; a cent under is thin", async () => {
  const at = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice: 100, liquidityUsd: 100_000 }, first: { price: 99, at: T + 1, raw: {} } })));
  assert.equal(at.rule, "issuer-token");
  const under = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice: 100, liquidityUsd: 99_999.99 }, first: { price: 99, at: T + 1, raw: {} } })));
  assert.equal(under.rule, "stock-first-trade");
});

test("a token quote stamped in the future or before the moment is clamped into [moment, now]", async () => {
  const future = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice: 100, at: T + 9_999 } })));
  assert.equal(future.publishedAt, T + 10);
  const past = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice: 100, at: T - 9_999 } })));
  assert.equal(past.publishedAt, T);
});

test("a moment in the future waits, for every kind", async () => {
  const s = src({ token: { usdPrice: 100 }, lend: 1.01, contracts: [] });
  for (const kind of ["spot", "yield", "prediction"] as const) {
    const r = await priceLeg({ ...spot({ kind }), prediction: null }, T + 60, T, rules, s);
    assert.ok(!r.ok && r.retry, kind);
  }
});

test("live window boundary: exactly liveWindowSecs after is live, one second more is not", async () => {
  const s = src({ token: { usdPrice: 100 }, first: { price: 90, at: T + 5, raw: {} } });
  assert.equal(ok(await priceLeg(spot(), T, T + 300, rules, s)).rule, "issuer-token");
  assert.equal(ok(await priceLeg(spot(), T, T + 301, rules, s)).rule, "stock-first-trade");
});

test("stock deadline boundary: a trade at exactly moment+maxDelay counts; a source that returns one a second late is refused", async () => {
  const until = T + rules.maxDelaySecs;
  const atEdge = ok(await priceLeg(spot({ token: null }), T, until + 50, rules, src({ first: { price: 100, at: until, raw: {} } })));
  assert.equal(atEdge.publishedAt, until);
  const late = await priceLeg(spot({ token: null }), T, until + 50, rules, src({ first: { price: 100, at: until + 1, raw: {} } }));
  assert.ok(!late.ok && !late.retry);
  // A misbehaving source handing back a trade from before the moment is refused too.
  const early = await priceLeg(spot({ token: null }), T, T + 60, rules, src({ first: { price: 100, at: T - 1, raw: {} } }));
  assert.ok(!early.ok && early.retry);
});

test("exactly at the deadline it still retries; one second past it gives up", async () => {
  const until = T + rules.maxDelaySecs;
  const r1 = await priceLeg(spot({ token: null }), T, until, rules, src({ first: null }));
  assert.ok(!r1.ok && r1.retry);
  const r2 = await priceLeg(spot({ token: null }), T, until + 1, rules, src({ first: null }));
  assert.ok(!r2.ok && !r2.retry);
});

test("stock-adjusted exit applies the entry premium in the right direction: the return equals the stock's move", async () => {
  // Entry: token at a 3% premium to a fresh $100 stock trade.
  const entry = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice: 103 }, latest: { price: 100, at: T, raw: {} } })));
  assert.equal(entry.price, 103);
  // The fake token reports no ScaledUiAmount extension: multiplier 1, recorded.
  assert.deepEqual(entry.basis, { source: "token", mint: "NVDAx", underlyingPerUiToken: 1, premium: 1.03, multiplier: 1, at: T });
  // Exit: token gone thin; the stock is up 10%.
  const H = T + 30 * DAY;
  const exit = ok(await priceLeg(spot(), H, H + 10, rules, src({ token: { usdPrice: 0.01, liquidityUsd: 10 }, first: { price: 110, at: H + 2, raw: {} } }), entry.basis));
  assert.equal(exit.rule, "stock-adjusted");
  assert.ok(Math.abs(exit.price - 113.3) < 1e-9);
  assert.equal(legReturnBps("spot", "back", entry.price, exit.price), 1000);
});

test("a stock-priced entry never exits on the token, even when the token is liquid and live", async () => {
  const H = T + 30 * DAY;
  const exit = ok(await priceLeg(spot(), H, H + 10, rules, src({ token: { usdPrice: 150 }, first: { price: 110, at: H + 2, raw: {} } }), { source: "stock" }));
  assert.equal(exit.rule, "stock-first-trade");
  assert.equal(exit.price, 110);
});

/** An off-hours entry: Saturday, Friday's close 30 hours old, so the token's 2% premium isn't recorded. */
async function saturdayEntry() {
  const sat = T + 3 * DAY;
  const entry = ok(await priceLeg(spot(), sat, sat + 10, rules, src({ token: { usdPrice: 102 }, latest: { price: 100, at: sat - 30 * 3600, raw: {} } })));
  assert.equal(entry.rule, "issuer-token");
  assert.equal((entry.basis as Extract<EntryBasis, { source: "token" }>).premium, null);
  return { entry, H: sat + 30 * DAY };
}
// The bank knows this token has no ScaledUiAmount extension (raw = UI).
const bankNvdax = spot({ token: { mint: "NVDAx", underlyingPerUiToken: 1, scaledUi: null } });

test("FIXED: off-hours entry (no premium) + a late settler at exit stays unpriced rather than sign the raw stock", async () => {
  // The token trades at a steady 2% premium to the stock. Nothing moves for a month.
  const { entry, H } = await saturdayEntry();
  // Exit: the settler ran 10 minutes late (past the live window). The raw stock would read the
  // token's 2% premium as a −196 bps loss nobody made, so the leg is left unpriced (unscored).
  const r = await priceLeg(bankNvdax, H, H + 600, rules, src({ token: { usdPrice: 102 }, first: { price: 100, at: H + 2, raw: {} } }), entry.basis, "exit");
  assert.ok(!r.ok && !r.retry, r.ok ? `signed ${r.quote.rule} at ${r.quote.price}` : r.reason);
});

test("FIXED: off-hours entry + a thin token at exit: waits for a live token price within the live window, then gives up", async () => {
  const { entry, H } = await saturdayEntry();
  const s = src({ token: { usdPrice: 102, liquidityUsd: 1_000 }, first: { price: 100, at: H + 2, raw: {} } });
  const r = await priceLeg(bankNvdax, H, H + 10, rules, s, entry.basis, "exit");
  assert.ok(!r.ok && r.retry, r.ok ? `signed ${r.quote.rule} at ${r.quote.price}` : r.reason);
  const late = await priceLeg(bankNvdax, H, H + rules.liveWindowSecs + 1, rules, s, entry.basis, "exit");
  assert.ok(!late.ok && !late.retry);
});

// ---------------------------------------------------------------------------------------------
// Splits on tokens with no multiplier (Backpack: 1:1 shares), from Alpaca corporate actions
// ---------------------------------------------------------------------------------------------

const backpack = spot({ token: { mint: "NVDAbp", underlyingPerUiToken: 1, scaledUi: null } });
const split10: Split = { exAt: T + 10 * DAY, ratio: 10, raw: { symbol: "NVDA", new_rate: 10, old_rate: 1 } };

test("FIXED: a 10-for-1 split on a Backpack token (no multiplier) reads as 0%, on the token and through the stock", async () => {
  const entry = ok(await priceLeg(backpack, T, T + 10, rules, src({ token: { usdPrice: 1_000 }, latest: { price: 1_000, at: T, raw: {} } })));
  assert.equal((entry.basis as Extract<EntryBasis, { source: "token" }>).at, T);
  const H = T + 30 * DAY;
  const onToken = ok(await priceLeg(backpack, H, H + 10, rules, src({ token: { usdPrice: 100 }, latest: { price: 100, at: H, raw: {} }, splits: [split10] }), entry.basis, "exit"));
  assert.ok(Math.abs(legReturnBps("spot", "back", entry.price, onToken.price)!) < 50, `token: ${onToken.price}`);
  assert.equal(onToken.inputs.splitFactor, 10);
  const onStock = ok(await priceLeg(backpack, H, H + 10, rules, src({ token: { usdPrice: 100, liquidityUsd: 1_000 }, first: { price: 100, at: H + 2, raw: {} }, splits: [split10] }), entry.basis, "exit"));
  assert.equal(onStock.rule, "stock-adjusted");
  assert.ok(Math.abs(legReturnBps("spot", "back", entry.price, onStock.price)!) < 50, `stock: ${onStock.price}`);
});

test("a split is never applied twice: an xStock's multiplier already carries it", async () => {
  const entry = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice: 1_000, multiplier: 1 }, latest: { price: 1_000, at: T, raw: {} } })));
  const H = T + 30 * DAY;
  const exit = ok(await priceLeg(spot(), H, H + 10, rules, src({ token: { usdPrice: 100, multiplier: 10 }, latest: { price: 100, at: H, raw: {} }, splits: [split10] }), entry.basis, "exit"));
  assert.ok(Math.abs(legReturnBps("spot", "back", entry.price, exit.price)!) < 50);
  assert.equal(exit.inputs.splitFactor, undefined);
});

test("splits before the entry, and entries without a recorded moment, aren't adjusted", async () => {
  const H = T + 30 * DAY;
  const before: Split = { exAt: T - DAY, ratio: 10, raw: {} };
  const entry = ok(await priceLeg(backpack, T, T + 10, rules, src({ token: { usdPrice: 100 }, latest: { price: 100, at: T, raw: {} } })));
  const exit = ok(await priceLeg(backpack, H, H + 10, rules, src({ token: { usdPrice: 100 }, latest: { price: 100, at: H, raw: {} }, splits: [before] }), entry.basis, "exit"));
  assert.equal(exit.price, 100);
  const old: EntryBasis = { source: "token", mint: "NVDAbp", underlyingPerUiToken: 1, premium: 1 };
  const exitOld = ok(await priceLeg(backpack, H, H + 10, rules, src({ token: { usdPrice: 100 }, latest: { price: 100, at: H, raw: {} }, splits: [split10] }), old, "exit"));
  assert.equal(exitOld.price, 100);
});

test("a stock-priced entry with no token (nothing proved) still gets the split adjustment on the stock", async () => {
  const noToken = spot({ token: null });
  const entry = ok(await priceLeg(noToken, T, T + 10, rules, src({ first: { price: 1_000, at: T + 2, raw: {} } })));
  assert.deepEqual(entry.basis, { source: "stock", at: T });
  const H = T + 30 * DAY;
  const exit = ok(await priceLeg(noToken, H, H + 10, rules, src({ first: { price: 100, at: H + 2, raw: {} }, splits: [split10] }), entry.basis, "exit"));
  assert.equal(exit.price, 1_000);
});

test("FIXED: a 10-for-1 split during a position (xStocks ScaledUiAmount multiplier 1 → 10) reads as 0%, not −90%", async () => {
  // Entry: 1 UI token = 1 share at $1,000. The user holds 1 raw token's worth.
  const entry = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice: 1_000, multiplier: 1 }, latest: { price: 1_000, at: T, raw: {} } })));
  assert.equal((entry.basis as Extract<EntryBasis, { source: "token" }>).multiplier, 1);
  // Split: the issuer raises the multiplier to 10, so the user's raw balance now shows 10 UI
  // tokens; Jupiter's usdPrice per UI token (= per share) is $100. Holdings value is unchanged.
  const H = T + 30 * DAY;
  const exit = ok(await priceLeg(spot(), H, H + 10, rules, src({ token: { usdPrice: 100, multiplier: 10 }, latest: { price: 100, at: H, raw: {} } }), entry.basis));
  const r = legReturnBps("spot", "back", entry.price, exit.price)!;
  assert.ok(Math.abs(r) < 50, `the leg is priced per share with no corporate-action adjustment: ${r} bps for a flat position`);
});

test("FIXED: a split also carries through the stock fallback (thin token at exit, stock-adjusted)", async () => {
  const entry = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice: 1_000, multiplier: 1 }, latest: { price: 1_000, at: T, raw: {} } })));
  const H = T + 30 * DAY;
  // Pool too thin to price from at exit; Jupiter still reports the mint's multiplier.
  const exit = ok(await priceLeg(spot(), H, H + 10, rules, src({ token: { usdPrice: 100, multiplier: 10, liquidityUsd: 1_000 }, first: { price: 100, at: H + 2, raw: {} } }), entry.basis));
  assert.equal(exit.rule, "stock-adjusted");
  assert.ok(Math.abs(legReturnBps("spot", "back", entry.price, exit.price)!) < 50);
});

test("FIXED: a stock-priced entry (token too thin) scales its exit by the token's multiplier too", async () => {
  const entry = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice: 1_000, multiplier: 1, liquidityUsd: 1_000 }, first: { price: 1_000, at: T + 2, raw: {} } })));
  assert.equal(entry.rule, "stock-first-trade");
  assert.deepEqual(entry.basis, { source: "stock", mint: "NVDAx", multiplier: 1, at: T });
  const H = T + 30 * DAY;
  const exit = ok(await priceLeg(spot(), H, H + 10, rules, src({ token: { usdPrice: 100, multiplier: 10, liquidityUsd: 1_000 }, first: { price: 100, at: H + 2, raw: {} } }), entry.basis));
  assert.ok(Math.abs(legReturnBps("spot", "back", entry.price, exit.price)!) < 50);
});

test("FIXED: a reinvested dividend (multiplier 1 → 1.01, share drops 1% ex-div) reads as ~0%, not a 1% loss", async () => {
  const entry = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice: 100, multiplier: 1 }, latest: { price: 100, at: T, raw: {} } })));
  const H = T + 30 * DAY;
  const exit = ok(await priceLeg(spot(), H, H + 10, rules, src({ token: { usdPrice: 99, multiplier: 1.01 }, latest: { price: 99, at: H, raw: {} } }), entry.basis));
  const r = legReturnBps("spot", "back", entry.price, exit.price)!;
  // Holdings: 1.01 UI tokens × $99 = $99.99 for $100 paid → about 0 bps (total return).
  assert.ok(Math.abs(r) < 10, `price return, not total return: ${r} bps`);
});

test("a scheduled multiplier change counts from its effective time, not when Jupiter reports it", async () => {
  const H = T + 30 * DAY;
  const entry = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice: 100, multiplier: 1 }, latest: { price: 100, at: T, raw: {} } })));
  const tokens = { price: async (mint: string) => ({ mint, usdPrice: 100, liquidityUsd: 5_000_000, at: H, scaledUi: { multiplier: 1, newMultiplier: 2, newMultiplierEffectiveAt: H + 3_600 }, raw: {} }) };
  const before = ok(await priceLeg(spot(), H, H + 10, rules, { ...src({ latest: { price: 100, at: H, raw: {} } }), tokens }, entry.basis));
  assert.equal(before.price, 100, "the split hasn't taken effect at the moment");
});

test("an entry from before multipliers were recorded isn't scaled (unchanged behaviour)", async () => {
  const H = T + 30 * DAY;
  const old: EntryBasis = { source: "token", mint: "NVDAx", underlyingPerUiToken: 1, premium: 1 };
  const exit = ok(await priceLeg(spot(), H, H + 10, rules, src({ token: { usdPrice: 100, multiplier: 1.5 }, latest: { price: 100, at: H, raw: {} } }), old));
  assert.equal(exit.price, 100);
});

// ---------------------------------------------------------------------------------------------
// No band: a token with the liquidity floor pooled is its own price
// ---------------------------------------------------------------------------------------------

test("no band during market hours: a liquid token 40% off a fresh stock trade is still signed on the token, with its premium", async () => {
  const q = ok(await priceLeg(spot(), T, T + 10, rules, src({ token: { usdPrice: 60 }, latest: { price: 100, at: T, raw: {} }, first: { price: 100, at: T + 2, raw: {} } })));
  assert.equal(q.rule, "issuer-token");
  assert.equal(q.price, 60);
  assert.ok(q.basis.source === "token" && Math.abs((q.basis.premium ?? 0) - 0.6) < 1e-12);
});

test("no band with the market shut: a real 10% weekend move on the token is signed", async () => {
  const sat = T + 3 * DAY;
  const q = ok(await priceLeg(spot(), sat, sat + 10, rules, src({ token: { usdPrice: 90 }, latest: { price: 100, at: sat - 30 * 3600, raw: {} } })));
  assert.equal(q.rule, "issuer-token");
  assert.equal(q.price, 90);
});

test("a late non-stock exit can't be priced: only a live token price prices it", async () => {
  const H = T + 30 * DAY;
  const r = await priceLeg(spot({ underlying: GOLD, token: { mint: "PAXG", underlyingPerUiToken: 1 } }), H, H + 360, rules, src({ token: { usdPrice: 4_000 } }), { source: "token", mint: "PAXG", underlyingPerUiToken: 1, premium: null });
  assert.ok(!r.ok && !r.retry);
});

test("FIXED: an entry price under one 8-decimal unit ($4e-9) is refused, not signed as 0 units the program rejects", async () => {
  const dust = spot({ underlying: { key: "token:DUST", cls: "token", code: "DUST" }, token: { mint: "DUST", underlyingPerUiToken: 1 } });
  const r = await priceLeg(dust, T, T + 10, rules, src({ token: { usdPrice: 4e-9 } }));
  assert.ok(!r.ok && !r.retry, r.ok ? `signed ${toPriceUnits(r.quote.price)} units` : "");
  assert.match(r.reason, /smallest price unit/);
  // An EXIT that small is real (the token collapsed): signed, and reads as −100%.
  const exit = ok(await priceLeg(dust, T + DAY, T + DAY + 10, rules, src({ token: { usdPrice: 4e-9 } }), { source: "token", mint: "DUST", underlyingPerUiToken: 1, premium: null }, "exit"));
  assert.equal(toPriceUnits(exit.price), 0n);
});

test("GAP: 8-decimal price units quantise sub-cent prices (3e-7 → 30 units, ~3.3% steps)", () => {
  assert.equal(toPriceUnits(3e-7), 30n);
  // A real +1% move is recorded as 0%.
  assert.equal(legReturnBps("spot", "back", 3e-7, 3.03e-7), 0);
});

test("toPriceUnits refuses non-finite and negative prices, and rounds half up at 8 decimals", () => {
  assert.throws(() => toPriceUnits(Number.POSITIVE_INFINITY));
  assert.throws(() => toPriceUnits(Number.NaN));
  assert.throws(() => toPriceUnits(-1));
  assert.equal(toPriceUnits(0.1 + 0.2), 30_000_000n);
  assert.equal(toPriceUnits(1 - 0.07), 93_000_000n);
  assert.equal(toPriceUnits(123.456789125), 12_345_678_913n);
});

test("legs whose underlying isn't in the bank give up immediately; a card leg waits for its card (cards.test.ts)", async () => {
  const card = await priceLeg(spot({ kind: "card" }), T, T + 10, rules, src({}));
  assert.ok(!card.ok && card.retry);
  const unknown = await priceLeg(spot({ underlying: null }), T, T + 10, rules, src({ token: { usdPrice: 100 } }));
  assert.ok(!unknown.ok && !unknown.retry);
});

test("GAP: one unpriceable leg (a card) voids the whole basket's return", () => {
  const legs = [
    { kind: { spot: {} }, weightBps: 4_000, leverage: 1 },
    { kind: { spot: {} }, weightBps: 4_000, leverage: 1 },
    { kind: { card: {} }, weightBps: 2_000, leverage: 1 },
  ];
  const prices = [
    { entry: toPriceUnits(100), exit: toPriceUnits(150) },
    { entry: toPriceUnits(100), exit: toPriceUnits(150) },
    { entry: 0n, exit: 0n },
  ];
  assert.equal(positionReturnBps(legs, { side: { back: {} }, legsMask: 0b111, prices }), null);
});

test("the value check catches dust of the right token, and uses the scaled UI amount", () => {
  const out = { account: "a", received: 5_000_000n, mint: "NVDAx", uiPerUnit: 1e-8 * 1.05 } as const; // 0.0525 UI (multiplier 1.05)
  assert.equal(receivedValueShortfall(out, { underlyingPerUiToken: 1 }, 200, 10), null); // $10.50 for a $10 leg
  assert.match(receivedValueShortfall(out, { underlyingPerUiToken: 1 }, 200, 20) ?? "", /under 90%/); // $10.50 for a $20 leg
  assert.match(receivedValueShortfall({ ...out, uiPerUnit: null }, { underlyingPerUiToken: 1 }, 200, 10) ?? "", /unknown scale/);
});

// ---------------------------------------------------------------------------------------------
// Basket math (mirror of the program's position_return_bps)
// ---------------------------------------------------------------------------------------------

test("weights that don't add to 10,000 still give the weighted average of the included legs", () => {
  const legs = [3_300, 3_300, 3_300].map((weightBps) => ({ kind: { spot: {} }, weightBps, leverage: 1 }));
  const prices = [
    { entry: toPriceUnits(100), exit: toPriceUnits(110) }, // +10%
    { entry: toPriceUnits(100), exit: toPriceUnits(100) }, // 0
    { entry: toPriceUnits(100), exit: toPriceUnits(70) }, // −30%
  ];
  assert.equal(positionReturnBps(legs, { side: { back: {} }, legsMask: 0b111, prices }), Math.trunc((1000 + 0 - 3000) / 3));
  // Only legs in the mask count, re-weighted among themselves.
  assert.equal(positionReturnBps(legs, { side: { back: {} }, legsMask: 0b101, prices }), -1000);
});

test("no leg loses more than 100%: a 3x fade of a stock that rises 50% is −100%, not −150%; gains aren't capped", () => {
  assert.equal(legReturnBps("perp", "fade", 100, 150, 3), -10_000);
  assert.equal(legReturnBps("perp", "back", 100, 150, 3), 15_000);
});

// ---------------------------------------------------------------------------------------------
// Perps (Phoenix)
// ---------------------------------------------------------------------------------------------

const BOOK = new PublicKey("AzySnZQCNjkQMtm5ZDd2FjKYTjBoNb5Bv5Dsm3WyRkbj");
const PEPE = "crypto:PEPE";
const pTrader = (baseLots: bigint): TraderView => ({ authority: PublicKey.default, collateral: 1n, pdaIndex: 0, subaccountIndex: 1, positions: baseLots ? [{ assetId: 1, baseLots, virtualQuoteLots: 0n }] : [] });
function px(over: Partial<PhoenixLegInput> = {}): PhoenixLegInput {
  return {
    index: 0,
    moment: "entry",
    momentSec: T,
    nowSec: T + 120,
    rules: { ...rules, maxDelaySecs: 3_600, minReceivedRatio: 0.9 },
    side: "back",
    leg: { assetIdHex: underlyingIdHex(PEPE), leverage: 2 },
    // 4,800 kPEPE lots at 3 decimals = 4.8 contracts × $8.5 (per 1,000 PEPE)... sized below
    out: { account: "child", received: 4_800n, mint: null, uiPerUnit: null, phoenix: true, orders: [{ trader: PublicKey.default, orderbook: BOOK, side: "long", baseLots: 4_800n }] },
    basis: null,
    entryPrice: null,
    legStakeUsd: 20,
    reader: { trader: async () => pTrader(4_800n), marketByOrderbook: async () => ({ symbol: "kPEPE", baseLotsDecimals: 3 }) },
    // kPEPE mark: $0.0085 per 1,000 PEPE... use $8.5 per contract so the notional check passes.
    marks: { markAtOrAfter: async (_s, at) => ({ price: 8.5, at: at + 30 }) },
    perp: () => ({ underlyingKey: PEPE, unitsPerContract: 1_000 }),
    ...over,
  };
}

test("kPEPE: the signed price is per one PEPE (mark ÷ 1,000), entry and exit alike", async () => {
  const entry = ok(await pricePhoenixLeg(px()));
  assert.equal(entry.price, 0.0085);
  const exit = ok(await pricePhoenixLeg(px({ moment: "exit", basis: entry.basis, entryPrice: entry.price, marks: { markAtOrAfter: async (_s, at) => ({ price: 9.35, at }) } })));
  assert.ok(Math.abs(exit.price - 0.00935) < 1e-15);
  assert.equal(legReturnBps("perp", "back", entry.price, exit.price, 2), 2000); // +10% × 2
});

const gone = (side: "back" | "fade", lev: number) =>
  pricePhoenixLeg(px({ moment: "exit", side, leg: { assetIdHex: underlyingIdHex(PEPE), leverage: lev }, basis: { source: "phoenix", symbol: "kPEPE", unitsPerContract: 1_000 }, entryPrice: 100, reader: { trader: async () => pTrader(0n), marketByOrderbook: async () => null } }));

test("liquidated (position gone) at 1x: exactly −100% for a back or a fade; leverage 0 is treated as 1", async () => {
  for (const [side, lev] of [["back", 1], ["fade", 1], ["back", 0]] as const) {
    const q = ok(await gone(side, lev));
    assert.equal(q.rule, "phoenix-liquidated");
    assert.equal(legReturnBps("perp", side, 100, q.price, Math.max(1, lev)), -10_000, `${side} ${lev}x`);
  }
});

test("FIXED: liquidated at 3x (and 2x-7x) records exactly −100%, not −99.99%: rounded one unit past entry × (1 ∓ 1/lev)", async () => {
  const got: string[] = [];
  for (const lev of [2, 3, 6, 7]) {
    for (const side of ["back", "fade"] as const) {
      const q = ok(await gone(side, lev));
      const r = legReturnBps("perp", side, 100, q.price, lev);
      if (r !== -10_000) got.push(`${side} ${lev}x: ${r}`);
    }
  }
  assert.deepEqual(got, []);
});

test("FIXED: a Phoenix trader account that no longer exists at the horizon is liquidated (−100%), not priced at the mark", async () => {
  // reader.trader returns null only when the account isn't on chain (errors throw). The leg was
  // liquidated and the child account closed: the comment says a position that's gone is −100%.
  const q = ok(await pricePhoenixLeg(px({ moment: "exit", basis: { source: "phoenix", symbol: "kPEPE", unitsPerContract: 1_000 }, entryPrice: 0.0085, reader: { trader: async () => null, marketByOrderbook: async () => null }, marks: { markAtOrAfter: async (_s, at) => ({ price: 12, at }) } })));
  assert.equal(q.rule, "phoenix-liquidated", `priced ${q.rule} at ${q.price}: +${legReturnBps("perp", "back", 0.0085, q.price, 2)} bps for a position that isn't there`);
  assert.equal(legReturnBps("perp", "back", 0.0085, q.price, 2), -10_000);
  assert.equal(q.inputs.accountGone, true);
});

test("a failed trader read (RPC error) isn't taken as a closed account: it throws, so the crank retries", async () => {
  const r = pricePhoenixLeg(px({ moment: "exit", basis: { source: "phoenix", symbol: "kPEPE", unitsPerContract: 1_000 }, entryPrice: 0.0085, reader: { trader: async () => { throw new Error("rpc down"); }, marketByOrderbook: async () => null } }));
  await assert.rejects(r, /rpc down/);
});

test("GAP: a partially liquidated position still settles at full leverage on the mark", async () => {
  const q = ok(await pricePhoenixLeg(px({ moment: "exit", basis: { source: "phoenix", symbol: "kPEPE", unitsPerContract: 1_000 }, entryPrice: 0.0085, reader: { trader: async () => pTrader(100n), marketByOrderbook: async () => null } })));
  assert.equal(q.rule, "phoenix-mark");
});

test("perp entry: wrong side or a past deadline is refused; a moment in the future waits", async () => {
  const wrongSide = await pricePhoenixLeg(px({ side: "fade" }));
  assert.ok(!wrongSide.ok && !wrongSide.retry);
  const late = await pricePhoenixLeg(px({ nowSec: T + 3_601 }));
  assert.ok(!late.ok && !late.retry);
  const early = await pricePhoenixLeg(px({ nowSec: T - 1 }));
  assert.ok(!early.ok && early.retry);
});

// ---------------------------------------------------------------------------------------------
// Predictions (Gemini)
// ---------------------------------------------------------------------------------------------

const contract = (o: Partial<GeminiContract> = {}): GeminiContract => ({
  instrumentSymbol: "GEMI-X-Y",
  eventTicker: "X",
  eventTitle: "X",
  label: "Y",
  category: "Sports",
  status: "active",
  expiry: new Date((T + 10 * DAY) * 1000).toISOString(),
  resolutionSide: null,
  resolvedAt: null,
  ask: { yes: 0.42, no: 0.6 },
  bid: { yes: 0.4, no: 0.56 },
  ...o,
});
const pred = (held: "back" | "fade", c = contract()): LegToPrice => ({ index: 0, kind: "prediction", underlying: null, token: null, prediction: { contract: c, side: "yes" }, held });
const gBasis: EntryBasis = { source: "gemini", eventTicker: "X", instrument: "GEMI-X-Y", side: "yes" };

test("fade entry is 1 − the No ask; the program's No formula then gives exactly the No contract's P&L", async () => {
  const entry = ok(await priceLeg(pred("fade"), T, T + 5, rules, src({ contracts: [contract()] })));
  assert.ok(Math.abs(entry.price - 0.4) < 1e-12); // 1 − 0.60
  // The book moved toward No: Yes 0.20/0.23, No 0.75/0.78 (coherent: no bid above its ask).
  const exit = ok(await priceLeg(pred("fade"), T + DAY, T + DAY + 5, rules, src({ contracts: [contract({ ask: { yes: 0.23, no: 0.78 }, bid: { yes: 0.2, no: 0.75 } })] }), gBasis));
  assert.ok(Math.abs(exit.price - 0.25) < 1e-12); // 1 − 0.75
  // Bought No at 0.60, sold at 0.75: +25%.
  assert.equal(legReturnBps("prediction", "fade", entry.price, exit.price), 2500);
});

test("resolution: a fade wins 1/askNo − 1 when No wins and loses exactly 100% when Yes wins", async () => {
  const entry = ok(await priceLeg(pred("fade"), T, T + 5, rules, src({ contracts: [contract()] })));
  const noWins = ok(await priceLeg(pred("fade"), T + 20 * DAY, T + 20 * DAY, rules, src({ contracts: [contract({ status: "settled", resolutionSide: "no" })] }), gBasis));
  assert.equal(noWins.price, 0);
  assert.equal(legReturnBps("prediction", "fade", entry.price, noWins.price), 6666); // 1/0.6 − 1, truncated
  const yesWins = ok(await priceLeg(pred("fade"), T + 20 * DAY, T + 20 * DAY, rules, src({ contracts: [contract({ status: "settled", resolutionSide: "yes" })] }), gBasis));
  assert.equal(legReturnBps("prediction", "fade", entry.price, yesWins.price), -10_000);
});

test("entry at 0 or 1 (either side) waits instead of signing a price the program would refuse", async () => {
  for (const ask of [{ yes: 1, no: 0.5 }, { yes: 0, no: 0.5 }]) {
    const r = await priceLeg(pred("back", contract({ ask })), T, T + 5, rules, src({ contracts: [contract({ ask })] }));
    assert.ok(!r.ok && r.retry, JSON.stringify(ask));
  }
  for (const ask of [{ yes: 0.5, no: 0 }, { yes: 0.5, no: 1 }]) {
    const r = await priceLeg(pred("fade", contract({ ask })), T, T + 5, rules, src({ contracts: [contract({ ask })] }));
    assert.ok(!r.ok && r.retry, JSON.stringify(ask));
  }
});

test("an immediate round trip loses the spread, never gains", async () => {
  const entry = ok(await priceLeg(pred("back"), T, T + 5, rules, src({ contracts: [contract()] })));
  const exit = ok(await priceLeg(pred("back"), T + 10, T + 15, rules, src({ contracts: [contract()] }), gBasis));
  assert.ok(legReturnBps("prediction", "back", entry.price, exit.price)! < 0);
});

test("FIXED: a crossed book (bid above ask) isn't signed, at entry or exit: the leg waits", async () => {
  const crossed = contract({ ask: { yes: 0.4, no: 0.6 }, bid: { yes: 0.45, no: 0.5 } });
  const entry = await priceLeg(pred("back", crossed), T, T + 5, rules, src({ contracts: [crossed] }));
  assert.ok(!entry.ok && entry.retry, "entry waits");
  const exit = await priceLeg(pred("back", crossed), T + 10, T + 15, rules, src({ contracts: [crossed] }), gBasis);
  assert.ok(!exit.ok && exit.retry, "exit waits");
});

test("FIXED: a crossed live weather book (buy Yes 0.01, sell Yes 0.81) can't be entered or offered", async () => {
  // A daily-high weather contract as Gemini returned it: buy yes .01 / no .19, sell yes .81 / no .99.
  const live = contract({ ask: { yes: 0.01, no: 0.19 }, bid: { yes: 0.81, no: 0.99 } });
  const r = await priceLeg(pred("back", live), T, T + 5, rules, src({ contracts: [live] }));
  assert.ok(!r.ok && r.retry);
  assert.match(ineligible(live, "yes", T * 1000) ?? "", /don't add up/);
});

test("a resolved contract still settles at 1/0 even if its last quotes were crossed", async () => {
  const resolved = contract({ ask: { yes: 0.01, no: 0.19 }, bid: { yes: 0.81, no: 0.99 }, resolutionSide: "yes", status: "settled" });
  const exit = ok(await priceLeg(pred("back", resolved), T + 10, T + 15, rules, src({ contracts: [resolved] }), gBasis));
  assert.equal(exit.price, 1);
});

test("a normal book still prices: entry at the ask, an instant round trip loses the spread", async () => {
  const sane = contract({ ask: { yes: 0.42, no: 0.6 }, bid: { yes: 0.4, no: 0.58 } });
  const entry = ok(await priceLeg(pred("back", sane), T, T + 5, rules, src({ contracts: [sane] })));
  const exit = ok(await priceLeg(pred("back", sane), T + 10, T + 15, rules, src({ contracts: [sane] }), gBasis));
  assert.ok(legReturnBps("prediction", "back", entry.price, exit.price)! < 0);
});

test("expired but unresolved waits for the resolution; past the deadline it gives up; no bid waits", async () => {
  const stopped = contract({ expiry: new Date((T + DAY) * 1000).toISOString(), status: "closed" });
  const waitR = await priceLeg(pred("back"), T + 2 * DAY, T + 2 * DAY, rules, src({ contracts: [stopped] }), gBasis);
  assert.ok(!waitR.ok && waitR.retry);
  const late = await priceLeg(pred("back"), T + 2 * DAY, T + 2 * DAY + rules.maxDelaySecs + 1, rules, src({ contracts: [stopped] }), gBasis);
  assert.ok(!late.ok && !late.retry);
  const noBid = await priceLeg(pred("back"), T + DAY, T + DAY, rules, src({ contracts: [contract({ bid: { yes: null, no: 0.5 } })] }), gBasis);
  assert.ok(!noBid.ok && noBid.retry);
});

test("FIXED: an exit whose entry basis is missing (pre-basis entry, lost audit file) is priced at the BID, not the ask", async () => {
  // The crank says it's an exit (`moment`); the contract comes from the leg's id through the bank.
  const exit = ok(await priceLeg(pred("back"), T + DAY, T + DAY + 5, rules, src({ contracts: [contract()] }), null, "exit"));
  assert.equal(exit.rule, "gemini-bid", `exit signed ${exit.rule} at ${exit.price} instead of the bid (0.40)`);
  assert.equal(exit.price, 0.4);
  assert.equal(exit.inputs.basisRebuilt, true);
  // Without `moment`, no basis still means an entry (older callers): unchanged.
  const legacy = ok(await priceLeg(pred("back"), T + DAY, T + DAY + 5, rules, src({ contracts: [contract()] }), null));
  assert.equal(legacy.rule, "gemini-ask");
});

test("FIXED: …and once the contract resolves, an exit with no basis settles at 1/0", async () => {
  const resolved = contract({ status: "settled", resolutionSide: "yes" });
  const r = ok(await priceLeg(pred("back", resolved), T + 20 * DAY, T + 20 * DAY, rules, src({ contracts: [resolved] }), null, "exit"));
  assert.equal(r.rule, "gemini-resolution");
  assert.equal(r.price, 1);
});

test("an exit with no basis and no contract in the bank gives up (nothing names the contract)", async () => {
  const r = await priceLeg({ ...pred("back"), prediction: null }, T + DAY, T + DAY + 5, rules, src({ contracts: [contract()] }), null, "exit");
  assert.ok(!r.ok && !r.retry);
});

test("FIXED: the Gemini read cache can't price an entry from a book read before the trade; publishedAt is the read", async () => {
  // Another position's exit read the event 10 s before this trade; the price then jumped.
  let clock = (T - 10) * 1000;
  let book = contract({ ask: { yes: 0.4, no: 0.62 } });
  const events = new GeminiEvents(async () => [book], () => clock);
  await events.event("X");
  book = contract({ ask: { yes: 0.7, no: 0.32 }, bid: { yes: 0.66, no: 0.28 } });
  clock = (T + 3) * 1000;
  const s: Sources = { ...src({}), predictions: events };
  const q = ok(await priceLeg(pred("back", book), T, T + 3, rules, s));
  assert.equal(q.price, 0.7, `entry at ${q.price} from a read 10 s before the moment (the book at the trade was 0.70)`);
  assert.equal(q.publishedAt, T + 3);
});

test("a read made after the moment is still reused from the cache (waiting exits don't re-read every tick)", async () => {
  let reads = 0;
  let clock = (T + 5) * 1000;
  const events = new GeminiEvents(async () => (reads++, [contract()]), () => clock);
  await events.event("X", { notBeforeMs: T * 1000 });
  clock = (T + 10) * 1000;
  await events.event("X", { notBeforeMs: T * 1000 });
  assert.equal(reads, 1);
  assert.equal(events.readAt("X"), (T + 5) * 1000);
});

test("FIXED: a contract with no No book can't be a pick: a fade of it would buy a side with no market", () => {
  const c = contract({ ask: { yes: 0.4, no: null }, bid: { yes: 0.38, no: null } });
  assert.equal(ineligible(c, "yes", T * 1000), null, "the Yes side alone is fine for a back");
  assert.equal(legPrice(c, "yes", "fade", "entry"), null);
  assert.match(ineligibleAsPick(c, T * 1000) ?? "", /No/);
  assert.equal(ineligibleAsPick(contract(), T * 1000), null);
});

// ---------------------------------------------------------------------------------------------
// Yield (Jupiter Lend)
// ---------------------------------------------------------------------------------------------

test("yield: a share value that falls (bad debt) is signed and shows a loss; past the deadline gives up", async () => {
  const leg: LegToPrice = { index: 0, kind: "yield", underlying: null, token: { mint: "jlUSDC", underlyingPerUiToken: 1 } };
  const entry = ok(await priceLeg(leg, T, T + 5, rules, src({ lend: 1.05 })));
  const exit = ok(await priceLeg(leg, T + DAY, T + DAY + 5, rules, src({ lend: 1.0 }), entry.basis));
  assert.ok(legReturnBps("yield", "back", entry.price, exit.price)! < 0);
  const late = await priceLeg(leg, T, T + rules.maxDelaySecs + 1, rules, src({ lend: 1.05 }));
  assert.ok(!late.ok && !late.retry);
});

test("yield: the exit uses the entry's vault, not whatever token the leg names now", async () => {
  const seen: string[] = [];
  const s: Sources = { ...src({}), lend: { shareValue: async (m) => (seen.push(m), { usdcPerShare: 1.01, at: 0, raw: {} }) } };
  ok(await priceLeg({ index: 0, kind: "yield", underlying: null, token: { mint: "other", underlyingPerUiToken: 1 } }, T, T + 5, rules, s, { source: "lend", shareMint: "jlUSDC" }));
  assert.deepEqual(seen, ["jlUSDC"]);
});

// ---------------------------------------------------------------------------------------------
// Ratios (bank)
// ---------------------------------------------------------------------------------------------

test("a scheduled multiplier takes over at exactly its timestamp", () => {
  const s = { multiplier: 1, newMultiplier: 10, newMultiplierEffectiveAt: T };
  assert.equal(effectiveMultiplier(s, T - 1), 1);
  assert.equal(effectiveMultiplier(s, T), 10);
});

test("GAP: a mint reporting multiplier 0 or NaN is silently treated as 1, not refused", () => {
  assert.equal(effectiveMultiplier({ multiplier: 0, newMultiplier: 0, newMultiplierEffectiveAt: 0 }, T), 1);
  assert.equal(effectiveMultiplier({ multiplier: Number.NaN, newMultiplier: Number.NaN, newMultiplierEffectiveAt: 0 }, T), 1);
});

test("underlying units: raw × 10^-decimals × multiplier × units per token, net of transfer fee", () => {
  const u = underlyingUnits(2_000_000_000n, { decimals: 8, scaledUi: { multiplier: 1.02, newMultiplier: 1.02, newMultiplierEffectiveAt: 0 }, underlyingPerUiToken: 1, transferFeeBps: 50 }, T);
  assert.ok(Math.abs(u - 20 * 1.02 * 0.995) < 1e-9, String(u));
});
