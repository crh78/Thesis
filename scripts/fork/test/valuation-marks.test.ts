// Live marks on the fork API follow the token's ScaledUiAmount multiplier since the entry, as the
// settler does: a 10-for-1 split (multiplier 1 → 10) or a reinvested dividend isn't read as a loss.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { Valuation } from "../api/valuation.ts";

const M = "MintNVDAx";
const multiplier = (m: number) => ({ multiplier: m, newMultiplier: m, newMultiplierEffectiveAt: 0 });

function setup(o: { scaledUi?: ReturnType<typeof multiplier> | null; inBank?: boolean; basis: any; tokenUsd?: number; stockUsd?: number }) {
  const opts = {
    bank: () => ({ tokens: o.inBank === false ? {} : { [M]: { scaledUi: o.scaledUi ?? null } }, venues: {} }),
    bases: { get: () => o.basis },
    stocks: { latestTrade: async () => (o.stockUsd ? { price: o.stockUsd, at: 0, raw: {} } : null) },
  } as any;
  const v = new Valuation(opts, { state: {} } as any);
  v.tokenPrices = (async () => new Map([[M, o.tokenUsd ?? 10]])) as any;
  const position = Keypair.generate().publicKey;
  const take = { legs: [{ kind: { spot: {} } }] } as any;
  const legs = [{ key: "equity:US:NVDA" }] as any;
  return { mark: async () => (await v.marks(take, legs, [{ publicKey: position, account: { side: { back: {} } } }])).get(position.toBase58())![0] };
}

const usd = (units: bigint | null) => (units === null ? null : Number(units) / 1e8);

test("a token entry at multiplier 1, after a 10-for-1 split (multiplier 10): the mark is scaled back to the entry's terms", async () => {
  const { mark } = setup({ scaledUi: multiplier(10), tokenUsd: 10, basis: { source: "token", mint: M, underlyingPerUiToken: 1, premium: null, multiplier: 1 } });
  assert.equal(usd(await mark()), 100);
});

test("a reinvested dividend (1 → 1.01) adds its yield to the mark", async () => {
  const { mark } = setup({ scaledUi: multiplier(1.01), tokenUsd: 99, basis: { source: "token", mint: M, underlyingPerUiToken: 1, premium: null, multiplier: 1 } });
  assert.ok(Math.abs(usd(await mark())! - 99.99) < 1e-6);
});

test("an entry from before multipliers were recorded isn't scaled", async () => {
  const { mark } = setup({ scaledUi: multiplier(10), tokenUsd: 10, basis: { source: "token", mint: M, underlyingPerUiToken: 1, premium: null } });
  assert.equal(usd(await mark()), 10);
});

test("a recorded multiplier the bank can't tell now gives no mark rather than a wrong one", async () => {
  const { mark } = setup({ inBank: false, tokenUsd: 10, basis: { source: "token", mint: M, underlyingPerUiToken: 1, premium: null, multiplier: 1 } });
  assert.equal(await mark(), null);
});

test("a stock-priced entry holding a token is scaled the same way", async () => {
  const { mark } = setup({ scaledUi: multiplier(10), stockUsd: 20, basis: { source: "stock", mint: M, multiplier: 1 } });
  assert.equal(usd(await mark()), 200);
});
