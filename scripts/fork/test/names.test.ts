import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLegs, nameResolver, onChainLegs, sameLegs } from "../api/legs.ts";

const bank = {
  "equity:US:AMD": { name: "AMD", code: "AMD", cls: "equity" },
  "equity:US:MSFT": { name: "Microsoft", code: "MSFT", cls: "equity" },
  "equity:US:MU": { name: "Micron Technology", code: "MU", cls: "equity" },
  "etf:US:GLD": { name: "Gold", code: "GLD", cls: "etf" },
  "equity:US:NBIS": { name: "NBIS", code: "NBIS", cls: "equity" },
  "commodity:XAU": { name: "GOLD", code: "XAU", cls: "commodity" },
};
const catalog = [
  { name: "Advanced Micro Devices - Backpack Securities", symbol: "AMD", kind: "stock", underlying: "AMD" },
  { name: "Dell Technologies xStock", symbol: "DELLx", kind: "stock", underlying: "DELL" },
  { name: "Nebius Group N.V. - Backpack Securities", symbol: "NBIS", kind: "stock", underlying: "NBIS" },
  { name: "PAX Gold", symbol: "PAXG", kind: "commodity", underlying: "XAU" },
  { name: "Polymarket: rates", symbol: "X", kind: "prediction", underlying: null },
];

test("names resolve through the fixed list, the take builder's catalog, then the asset bank", () => {
  const resolve = nameResolver(bank, catalog);
  assert.equal(resolve("Advanced Micro Devices"), "equity:US:AMD", "the catalog name the AI writes");
  assert.equal(resolve("Micron Technology, Inc."), "equity:US:MU", "the bank's name, suffixes ignored");
  assert.equal(resolve("MSFT"), "equity:US:MSFT", "a ticker");
  assert.equal(resolve("Gold"), "etf:US:GLD");
  assert.equal(resolve("Nebius Group"), "equity:US:NBIS", "company suffixes like N.V. are ignored");
  assert.equal(resolve("PAX Gold"), "commodity:XAU", "a commodity token resolves to what it tracks");
  assert.equal(resolve("Dell Technologies"), null, "in the catalog but not in the asset bank");
  assert.equal(resolve("Utilities"), null, "the fixed list says there's no token");
  assert.equal(resolve("Something else"), null);
});

const legs = (resolve = nameResolver(bank, catalog)) =>
  mapLegs(
    [
      { name: "Advanced Micro Devices", kind: "Stock", weight: 60, fade_how: null },
      { name: "Gold", kind: "Stock", weight: 40, fade_how: null },
    ],
    resolve,
  );

test("legs posted before a name resolved stay as posted, and can't be traded", () => {
  const now = legs();
  const before = legs(() => null); // the same take mapped before the resolver knew the names
  assert.equal(now[0].key, "equity:US:AMD");
  assert.equal(before[0].key, null);
  const onChain = before.map((l) => l.spec);
  assert.equal(sameLegs(onChain, now), false);
  const lined = onChainLegs(now, onChain);
  assert.ok(lined[0].spec.asset.equals(onChain[0].asset), "the receipt records the on-chain asset");
  assert.match(lined[0].blocked!, /posted before/);
  assert.equal(lined[0].how, null);
  assert.ok(sameLegs(now.map((l) => l.spec), now));
});
