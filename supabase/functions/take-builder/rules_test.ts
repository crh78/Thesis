import { assertEquals } from "jsr:@std/assert@1";
import { applyHouseRules, type RuleView } from "./rules.ts";

const run = (picks: RuleView[], horizon = "2 weeks") =>
  applyHouseRules(picks, horizon, (p) => p, (p, weight, leverage) => ({ ...p, weight, leverage }));

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

Deno.test("leverage keeps the model's choice under the horizon's ceiling", () => {
  const perp = (leverage: number) => [{ kind: "perp", key: "SOL", weight: 100, leverage }];
  assertEquals(run(perp(3), "2 weeks")[0].leverage, 3);
  assertEquals(run(perp(5), "1 month")[0].leverage, 4);
  assertEquals(run(perp(5), "3 months")[0].leverage, 3);
  assertEquals(run(perp(3), "6 months")[0].leverage, 2);
});

Deno.test("a basket of perps only keeps its weights (the cap applies when there are non-perp picks)", () => {
  const out = run([
    { kind: "perp", key: "SOL", weight: 70, leverage: 5 },
    { kind: "perp", key: "COIN", weight: 30, leverage: 3 },
  ]);
  assertEquals(out.map((p) => [p.weight, p.leverage]), [[70, 5], [30, 3]]);
});
