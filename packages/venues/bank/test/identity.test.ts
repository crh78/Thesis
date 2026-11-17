import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { categoryOf, issuerTagOf, underlyingOf } from "../../registry/src/tokens.ts";
import type { JupToken } from "../../registry/src/sources/jupiter.ts";
import { MINT_INFO } from "../../registry/src/curated.ts";
import { UNDERLYING_ID_PREFIX, isUnderlyingKey, phoenixUnderlyingKey, spotUnderlyingKey, underlyingId, underlyingIdBase58, underlyingIdHex } from "../src/identity.ts";
import { fixture } from "./helpers.ts";

test("underlyingId is sha256 of the fixed prefix plus the key, 32 bytes", () => {
  const id = underlyingId("equity:US:NVDA");
  assert.equal(id.length, 32);
  assert.equal(UNDERLYING_ID_PREFIX, "thesis:underlying:v1:");
  assert.equal(Buffer.from(id).toString("hex"), createHash("sha256").update("thesis:underlying:v1:equity:US:NVDA").digest("hex"));
  // Test vector, also in bank/README.md: changing it breaks every take recorded on-chain.
  assert.equal(underlyingIdHex("equity:US:NVDA"), "4ca6f3b31f7d24ced494f8f274344834a73d2c57974862ef4c4837d7dcd1bc53");
  assert.equal(underlyingIdHex("commodity:XAU"), "6d16065c78baf0240070148c131ba57bcf8cd0c1d72b49fda56635d15fdd9a63");
  assert.notEqual(underlyingIdHex("equity:US:NVDA"), underlyingIdHex("etf:US:NVDA"));
  assert.match(underlyingIdBase58("commodity:XAU"), /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
});

test("malformed keys are rejected", () => {
  for (const bad of ["equity:us:NVDA", "NVDA", "equity:US:", "equity:US:NV DA", "commodity:xau", "token:0OIl", "stock:US:NVDA"]) {
    assert.equal(isUnderlyingKey(bad), false, bad);
    assert.throws(() => underlyingId(bad));
  }
  for (const ok of ["equity:US:NVDA", "etf:US:SPY", "commodity:XAU", "private:OPENAI", "crypto:BTC"]) assert.ok(isUnderlyingKey(ok), ok);
});

/** Runs the same chain the poller's discovery uses: registry tag/category/underlying, then the key. */
function keyOf(t: Partial<JupToken> & { id: string; symbol: string; name: string }) {
  const tok = { decimals: 8, tokenProgram: "", ...t } as JupToken;
  const tag = issuerTagOf(tok);
  const category = categoryOf(tok, tag);
  return category ? spotUnderlyingKey({ mint: tok.id, name: tok.name, category, underlying: underlyingOf(tok, tag) }) : null;
}

test("every issuer of the same stock groups under one underlying", () => {
  const mint = (n: number) => "1".repeat(31) + String.fromCharCode(65 + n); // placeholder base58 ids
  assert.equal(keyOf({ id: mint(0), symbol: "NVDAx", name: "NVIDIA xStock", tags: ["xstocks"] }), "equity:US:NVDA");
  assert.equal(keyOf({ id: mint(1), symbol: "NVDAon", name: "NVIDIA (Ondo Tokenized)", tags: ["ondo"] }), "equity:US:NVDA");
  assert.equal(keyOf({ id: mint(2), symbol: "NVDA", name: "NVIDIA - Backpack Securities", tags: ["backpack"] }), "equity:US:NVDA");
  assert.equal(keyOf({ id: mint(3), symbol: "NVDAr", name: "NVIDIA rStock" }), "equity:US:NVDA");
  assert.equal(keyOf({ id: mint(4), symbol: "SPYx", name: "SP500 xStock", tags: ["xstocks"] }), "etf:US:SPY");
  assert.equal(keyOf({ id: mint(5), symbol: "SPYon", name: "SPDR S&P 500 ETF (Ondo Tokenized)", tags: ["ondo"] }), "etf:US:SPY");
  assert.equal(keyOf({ id: mint(6), symbol: "BRK.Bx", name: "Berkshire Hathaway xStock", tags: ["xstocks"] }), "equity:US:BRKB");
  // A ticker not in the frozen ETF list is an ETF only if its name says so.
  assert.equal(keyOf({ id: mint(7), symbol: "NEWETFx", name: "Some New ETF xStock", tags: ["xstocks"] }), "etf:US:NEWETF");
  assert.equal(keyOf({ id: mint(8), symbol: "NTRSx", name: "Northern Trust xStock", tags: ["xstocks"] }), "equity:US:NTRS");
  assert.equal(keyOf({ id: mint(9), symbol: "OPENAI", name: "OpenAI PreStocks", tags: ["prestocks"] }), "private:OPENAI");
  assert.equal(keyOf({ id: mint(10), symbol: "tOpenAI", name: "T-OpenAI", tags: ["tessera"] }), "private:OPENAI");
});

test("gold tokens group under commodity:XAU; own-underlying products key by mint", () => {
  for (const [mint, info] of Object.entries(MINT_INFO)) {
    const name = info.issuer;
    const t = { id: mint, symbol: "X", name, tags: info.category === "commodity" ? ["commodities"] : ["yb"] };
    if (info.underlying === "XAU") assert.equal(keyOf(t), "commodity:XAU", name);
    if (info.underlying === "XAG") assert.equal(keyOf(t), "commodity:XAG", name);
    if (info.category === "yield-token") assert.equal(keyOf(t), `token:${mint}`, name);
  }
});

test("the recorded fixture's tokens carry the keys discovery gave them", () => {
  const groups: Record<string, string[]> = {};
  for (const t of Object.values(fixture.tokens)) (groups[t.underlying] ??= []).push(t.symbol);
  assert.deepEqual(groups["equity:US:NVDA"].sort(), ["NVDA", "NVDAon", "NVDAr", "NVDAx"]);
  assert.deepEqual(groups["commodity:XAU"].sort(), ["DGLD", "GOLD", "PAXG", "VNXAU", "XAUM", "XAUt0"]);
  for (const [k, u] of Object.entries(fixture.underlyings)) assert.equal(u.idHex, underlyingIdHex(k));
});

test("Phoenix perps map onto the same underlyings", () => {
  assert.deepEqual(phoenixUnderlyingKey({ symbol: "NVDA", assetClass: "equities" }), { key: "equity:US:NVDA", unitsPerContract: 1 });
  assert.deepEqual(phoenixUnderlyingKey({ symbol: "SPY", assetClass: "equities" }), { key: "etf:US:SPY", unitsPerContract: 1 });
  assert.deepEqual(phoenixUnderlyingKey({ symbol: "GOLD", assetClass: "commodities" }), { key: "commodity:XAU", unitsPerContract: 1 });
  assert.deepEqual(phoenixUnderlyingKey({ symbol: "WTIOIL", assetClass: "commodities" }), { key: "commodity:WTI", unitsPerContract: 1 });
  assert.deepEqual(phoenixUnderlyingKey({ symbol: "ANTHROPIC", assetClass: "equities" }), { key: "private:ANTHROPIC", unitsPerContract: 1 });
  assert.deepEqual(phoenixUnderlyingKey({ symbol: "SPCX", assetClass: "equities" }), { key: "equity:US:SPCX", unitsPerContract: 1 });
  assert.deepEqual(phoenixUnderlyingKey({ symbol: "kPEPE", assetClass: "crypto" }), { key: "crypto:PEPE", unitsPerContract: 1000 });
  assert.deepEqual(phoenixUnderlyingKey({ symbol: "BTC", assetClass: "crypto" }), { key: "crypto:BTC", unitsPerContract: 1 });
});
