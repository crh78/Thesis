import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { underlyingId } from "@thesis/venues/bank";
import { mapLegs, perpLeverage, perpResolver, type PerpRef } from "../api/legs.ts";
import { Router } from "../api/routing.ts";

const markets: PerpRef[] = [
  { symbol: "NVDA", underlying: "equity:US:NVDA", maxLeverage: 10, tradeable: true },
  { symbol: "SOL", underlying: "crypto:SOL", maxLeverage: 25, tradeable: true },
  { symbol: "THIN", underlying: "equity:US:THIN", maxLeverage: 5, tradeable: false },
];
const perps = perpResolver(markets);
const names = (n: string) => ({ NVIDIA: "equity:US:NVDA", Tesla: "equity:US:TSLA" })[n] ?? null;

test("a perp pick maps to its Phoenix market at 2x, and can be shorted there", () => {
  const [perp, sol] = mapLegs(
    [
      { name: "NVIDIA perp", kind: "Stock · 2x", weight: 50, fade_how: "Bets the stock falls", asset_id: "phoenix:NVDA" },
      { name: "Solana perp", kind: "Stock · 2x", weight: 50, fade_how: "Bets the stock falls", asset_id: "phoenix:SOL" },
    ],
    names,
    undefined,
    perps,
  );
  assert.deepEqual([Object.keys(perp.spec.kind)[0], perp.spec.leverage, perp.how, perp.blocked], ["perp", 2, "perp", null]);
  assert.equal(perp.phoenix?.symbol, "NVDA");
  assert.equal(perp.short?.symbol, "NVDA");
  assert.ok(perp.spec.asset.toBuffer().equals(Buffer.from(underlyingId("equity:US:NVDA"))));
  assert.deepEqual(Object.keys(perp.spec.fadeVia), ["phoenixShort"]);
  // A crypto underlying has no token leg, only the perp.
  assert.ok(sol.spec.asset.toBuffer().equals(Buffer.from(underlyingId("crypto:SOL"))));
});

test("leverage: what the take builder chose, at most 5x and the market's max, and no default", () => {
  assert.equal(perpLeverage("Stock · 2x", markets[0]), 2);
  assert.equal(perpLeverage("Stock · 4x", markets[0]), 4);
  assert.equal(perpLeverage("Stock · 8x", markets[0]), 5);
  assert.equal(perpLeverage("Stock · 5x", { ...markets[0], maxLeverage: 3 }), 3);
  assert.equal(perpLeverage("Stock · 2x", { ...markets[0], maxLeverage: 1 }), 1);
  assert.equal(perpLeverage("Perp", markets[0]), null);
  const [leg] = mapLegs([{ name: "NVIDIA perp", kind: "Stock · leveraged", weight: 100, fade_how: null, asset_id: "phoenix:NVDA" }], names, undefined, perps);
  assert.match(leg.blocked!, /doesn't say its leverage/);
});

test("spot legs Phoenix lists can be shorted; others can't; thin markets are left out", () => {
  const [nvda, tsla, thin] = mapLegs(
    [
      { name: "NVIDIA", kind: "Stock", weight: 40, fade_how: "Bets the stock falls" },
      { name: "Tesla", kind: "Stock", weight: 30, fade_how: "Bets the stock falls" },
      { name: "Thin perp", kind: "Stock · 2x", weight: 30, fade_how: "Bets the stock falls", asset_id: "phoenix:THIN" },
    ],
    names,
    undefined,
    perps,
  );
  assert.equal(nvda.short?.symbol, "NVDA");
  assert.equal(nvda.how, "swap");
  assert.equal(tsla.short, undefined);
  assert.match(thin.blocked!, /too thin/);
});

/** A stand-in for the Phoenix desk: hands out children and builds two venue legs per leg. */
function fakeDesk() {
  const opened: { sub: number; symbol: string; side: string; collateral: bigint; leverage: number }[] = [];
  let next = 1;
  return {
    opened,
    prepare: async (_: PublicKey, n: number) => Array.from({ length: n }, () => next++),
    venue: {
      mid: async (symbol: string) => (symbol === "NVDA" ? 160 : 76),
      openLeg: async (o: { sub: number; symbol: string; side: string; collateral: bigint; leverage: number; owner: PublicKey }) => {
        opened.push({ sub: o.sub, symbol: o.symbol, side: o.side, collateral: o.collateral, leverage: o.leverage });
        const child = Keypair.generate().publicKey;
        return [
          { label: "collateral", instructions: [], lookupTables: [], marketAccounts: [], outputAccount: child },
          { label: "order", instructions: [], lookupTables: [], marketAccounts: [], outputAccount: child },
        ];
      },
    },
  };
}

const legs = () =>
  mapLegs(
    [
      { name: "NVIDIA", kind: "Stock", weight: 40, fade_how: "Bets the stock falls" },
      { name: "Solana perp", kind: "Stock · 2x", weight: 60, fade_how: "Bets the stock falls", asset_id: "phoenix:SOL" },
    ],
    names,
    undefined,
    perps,
  );

test("a fade shorts every leg on Phoenix, at each leg's leverage, splitting the stake by weight", async () => {
  const desk = fakeDesk();
  const router = new Router({ bank: () => ({ venues: {} }), appPayer: { publicKey: PublicKey.default } } as any);
  router.phoenix = desk as any;
  const owner = Keypair.generate().publicKey;
  const out = await router.venueLegs(legs(), owner, 50, PublicKey.default, undefined, { side: "fade" });
  assert.deepEqual(out.included, [0, 1]);
  assert.equal(out.venue.length, 4);
  assert.deepEqual(desk.opened.map((o) => [o.symbol, o.side, o.leverage]), [["NVDA", "short", 1], ["SOL", "short", 2]]);
  assert.equal(desk.opened.reduce((n, o) => n + o.collateral, 0n), 50_000_000n);
  assert.deepEqual(desk.opened.map((o) => o.collateral), [20_000_000n, 30_000_000n]);
  // Both venue legs of a Phoenix leg name the same child, for proof of trade.
  assert.ok(out.venue[0].output.account.equals(out.venue[1].output.account));
  assert.deepEqual(out.venue.map((v) => v.phoenix?.sub), [1, 1, 2, 2]);
});

test("without Phoenix, perp legs and shorts are left out with the reason", async () => {
  const router = new Router({ bank: () => ({ venues: {} }), appPayer: { publicKey: PublicKey.default } } as any);
  const [nvda, sol] = legs();
  assert.match(router.leftOut(sol)!, /Phoenix isn't connected/);
  assert.match(router.leftOut(nvda, Date.now(), "fade")!, /Phoenix isn't connected/);
  router.phoenix = fakeDesk() as any;
  assert.equal(router.leftOut(sol), null);
  assert.equal(router.leftOut(nvda, Date.now(), "fade"), null);
  const cash = mapLegs([{ name: "Cash", kind: "Earns interest", weight: 100, fade_how: null }])[0];
  assert.match(router.leftOut(cash, Date.now(), "fade")!, /can't be faded/);
});

test("the Blink leaves Phoenix legs to the app", async () => {
  const router = new Router({ bank: () => ({ venues: {} }), appPayer: { publicKey: PublicKey.default } } as any);
  router.phoenix = fakeDesk() as any;
  const perpOnly = mapLegs([{ name: "Solana perp", kind: "Stock · 2x", weight: 100, fade_how: null, asset_id: "phoenix:SOL" }], names, undefined, perps);
  await assert.rejects(router.venueLegs(perpOnly, Keypair.generate().publicKey, 20, PublicKey.default, 3, { paper: false }), /None of this take's legs/);
});

test("liquidation levels: near within 25% of the liquidation price, close within 10%", async () => {
  const { riskLevel, NEAR_LIQUIDATION, CLOSE_TO_LIQUIDATION } = await import("../api/phoenix.ts");
  assert.deepEqual([NEAR_LIQUIDATION, CLOSE_TO_LIQUIDATION], [0.25, 0.1]);
  assert.equal(riskLevel(null), "ok");
  assert.equal(riskLevel(0.4), "ok");
  assert.equal(riskLevel(0.25), "near");
  assert.equal(riskLevel(0.18), "near");
  assert.equal(riskLevel(0.1), "close");
  assert.equal(riskLevel(-0.02), "close");
});
