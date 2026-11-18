// Live marks on the fork API follow the settler's and the marker's rules (valueLeg): the token's
// ScaledUiAmount multiplier since the entry (a 10-for-1 split or a reinvested dividend isn't read as
// a loss), the $50k liquidity floor with the stock times the entry's premium behind it, and no
// prediction mark from a book that doesn't add up.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import type { GeminiContract } from "@thesis/venues/gemini";
import { Valuation } from "../api/valuation.ts";

const M = "MintNVDAx";
const multiplier = (m: number) => ({ multiplier: m, newMultiplier: m, newMultiplierEffectiveAt: 0 });

function setup(o: { scaledUi?: ReturnType<typeof multiplier> | null; inBank?: boolean; basis: any; tokenUsd?: number; liquidityUsd?: number; stockUsd?: number }) {
  let stockReads = 0;
  const opts = {
    bank: () => ({ tokens: o.inBank === false ? {} : { [M]: { scaledUi: o.scaledUi ?? null } }, venues: {} }),
    bases: { get: () => o.basis },
    stocks: { latestTrade: async () => (stockReads++, o.stockUsd ? { price: o.stockUsd, at: 0, raw: {} } : null) },
  } as any;
  const v = new Valuation(opts, { state: {} } as any, { pricesFile: null });
  v.tokenQuotes = (async () => new Map([[M, { usd: o.tokenUsd ?? 10, liquidityUsd: o.liquidityUsd ?? 1e6, at: Date.now() }]])) as any;
  const position = Keypair.generate().publicKey;
  const take = { legs: [{ kind: { spot: {} } }] } as any;
  const legs = [{ key: "equity:US:NVDA" }] as any;
  return {
    mark: async () => (await v.marks(take, legs, [{ publicKey: position, account: { side: { back: {} } } }])).get(position.toBase58())![0],
    stockReads: () => stockReads,
  };
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

test("a liquid token is marked on itself, without reading the stock", async () => {
  const s = setup({ tokenUsd: 101, liquidityUsd: 50_000, stockUsd: 100, basis: { source: "token", mint: M, underlyingPerUiToken: 1, premium: 1.01 } });
  assert.equal(usd(await s.mark()), 101);
  assert.equal(s.stockReads(), 0);
});

test("a token under the $50k floor: the stock times the entry's premium, as the settler and the marker do", async () => {
  const { mark } = setup({ tokenUsd: 150, liquidityUsd: 49_000, stockUsd: 100, basis: { source: "token", mint: M, underlyingPerUiToken: 1, premium: 1.01 } });
  assert.equal(usd(await mark()), 101);
});

test("a token under the floor with no premium recorded: no mark, not the thin token's price", async () => {
  const { mark } = setup({ tokenUsd: 150, liquidityUsd: 49_000, stockUsd: 100, basis: { source: "token", mint: M, underlyingPerUiToken: 1, premium: null } });
  assert.equal(await mark(), null);
});

test("a prediction leg isn't marked from a crossed book", async () => {
  const contract = (bid: { yes: number; no: number }) =>
    ({ instrumentSymbol: "FED-DEC", eventTicker: "FED", status: "active", resolutionSide: null, ask: { yes: 0.45, no: 0.58 }, bid }) as unknown as GeminiContract;
  const run = async (c: GeminiContract) => {
    const opts = { bank: () => ({ tokens: {}, venues: { gemini: { contracts: { [c.instrumentSymbol]: c } } } }), bases: { get: () => null } } as any;
    const v = new Valuation(opts, { state: {} } as any, { pricesFile: null });
    const position = Keypair.generate().publicKey;
    const take = { legs: [{ kind: { prediction: {} } }] } as any;
    const legs = [{ key: "gemini:FED-DEC:yes", prediction: { contract: c, side: "yes" } }] as any;
    return (await v.marks(take, legs, [{ publicKey: position, account: { side: { back: {} } } }])).get(position.toBase58())![0];
  };
  assert.equal(usd(await run(contract({ yes: 0.43, no: 0.55 }))), 0.43);
  assert.equal(await run(contract({ yes: 0.5, no: 0.4 })), null, "a yes bid above its ask");
});
