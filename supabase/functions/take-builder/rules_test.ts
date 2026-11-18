import { assertEquals } from "jsr:@std/assert@1";
import { applyHouseRules, MAX_LEVERAGE, RULES_LEVERAGE, type RuleView } from "./rules.ts";

const run = (picks: RuleView[]) =>
  applyHouseRules(picks, (p) => p, (p, weight, leverage) => ({ ...p, weight, leverage }));

Deno.test("a perp on a name already held as a stock is dropped; the stock takes its weight", () => {
  const out = run([
    { kind: "stock", key: "NVDA", weight: 70, leverage: 1 },
    { kind: "perp", key: "NVDA", weight: 30, leverage: 3 },
  ]);
  assertEquals(out, [{ kind: "stock", key: "NVDA", weight: 100, leverage: 1 }]);
});

Deno.test("a perp over 30% is capped and the excess goes to the other picks, in proportion", () => {
  const out = run([
    { kind: "stock", key: "AMD", weight: 30, leverage: 1 },
    { kind: "stock", key: "AVGO", weight: 15, leverage: 1 },
    { kind: "perp", key: "NVDA", weight: 55, leverage: 3 },
  ]);
  assertEquals(out.map((p) => p.weight), [47, 23, 30]);
});

Deno.test("a perp that's the only pick stays at 100%", () => {
  assertEquals(run([{ kind: "perp", key: "SOL", weight: 100, leverage: 3 }]).map((p) => p.weight), [100]);
});

Deno.test("leverage keeps the model's choice up to 5x; no horizon lowers it", () => {
  const perp = (leverage: number) => [{ kind: "perp", key: "SOL", weight: 100, leverage }];
  assertEquals(MAX_LEVERAGE, 5);
  for (const l of [1, 2, 3, 4, 5]) assertEquals(run(perp(l))[0].leverage, l);
  assertEquals(run(perp(8))[0].leverage, 5);
  // Only perps are capped.
  assertEquals(run([{ kind: "leveraged", key: "SOXL", weight: 100, leverage: 7 }])[0].leverage, 7);
});

Deno.test("with no model call, a perp gets 2x (a take can run a year)", () => {
  assertEquals(RULES_LEVERAGE, 2);
  assertEquals(run([{ kind: "perp", key: "SOL", weight: 100, leverage: RULES_LEVERAGE }])[0].leverage, 2);
});

Deno.test("a basket of perps only keeps its weights (the cap applies when there are non-perp picks)", () => {
  const out = run([
    { kind: "perp", key: "SOL", weight: 70, leverage: 5 },
    { kind: "perp", key: "COIN", weight: 30, leverage: 3 },
  ]);
  assertEquals(out.map((p) => [p.weight, p.leverage]), [[70, 5], [30, 3]]);
});
