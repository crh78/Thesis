import { assert, assertEquals } from "jsr:@std/assert@1";
import { heldTakeSide, isRequote, normalizedWeights, normalizeHandle, parseLimitOverrides, readLimits, readWho, takeLegs, topicGuess } from "./rules.ts";

Deno.test("limits: at least $10 a trade, the day at least a trade, both at most $1,000", () => {
  assertEquals(readLimits({ per_trade_usd: 50, daily_usd: 200 }), { perTradeUsd: 50, dailyUsd: 200 });
  assertEquals(readLimits({ per_trade_usd: "25.555", daily_usd: "25.555" }), { perTradeUsd: 25.56, dailyUsd: 25.56 });
  assertEquals(readLimits({ per_trade_usd: 5, daily_usd: 100 }), null);
  assertEquals(readLimits({ per_trade_usd: 100, daily_usd: 50 }), null);
  assertEquals(readLimits({ per_trade_usd: 100, daily_usd: 5000 }), null);
  assertEquals(readLimits({}), null);
});

Deno.test("handles: phones as E.164, emails lowercased", () => {
  assertEquals(normalizeHandle("(555) 555-0100"), "+15555550100");
  assertEquals(normalizeHandle("15555550100"), "+15555550100");
  assertEquals(normalizeHandle("+44 20 7946 0958"), "+442079460958");
  assertEquals(normalizeHandle("Jake@iCloud.com"), "jake@icloud.com");
  assertEquals(normalizeHandle("hello"), null);
  assertEquals(readWho({ x: "12345" }), { x: "12345" });
  assertEquals(readWho({ imessage: "5555550100" }), { imessage: "+15555550100" });
  assertEquals(readWho({ x: "@jake" }), null);
  assertEquals(readWho(null), null);
});

Deno.test("a draft's builder legs become POST /takes legs the way the composer makes them", () => {
  const legs = takeLegs([
    { id: "ceg", name: "Constellation Energy Corp. Common Stock", kind: "stock", weight: 0.5, why: "Nuclear fleet", canShort: true },
    { id: "jl", name: "jupiter lend USDC (Jupiter Lend Earn)", kind: "yield", weight: 0.2, why: "Cash" },
    { id: "pm", name: "Will a new US reactor start by 2027?", kind: "prediction", weight: 0.2, side: "no", why: "Odds", can_short: true },
    { id: "vst", name: "Vistra", kind: "perp", weight: 0.1, leverage: 3, why: "Power" },
  ]);
  assertEquals(legs.map((l) => [l.name, l.kind, l.weight, l.slot, l.fade_how, l.asset_id]), [
    ["Constellation Energy", "Stock", 50, 0, "Bets the stock falls", "ceg"],
    ["Cash", "Earns interest", 20, 1, null, "jl"],
    ["Will a new US reactor start by 2027?", "Prediction · No", 20, 2, "Bets No", "pm"],
    ["Vistra", "Stock · 3x", 10, 3, null, "vst"],
  ]);
  assertEquals(takeLegs(Array.from({ length: 7 }, (_, i) => ({ name: `L${i}`, kind: "stock", weight: 1 }))).length, 5);
});

Deno.test("weights always total 100 with each at least 1", () => {
  for (const ws of [[1, 1, 1], [0.5, 0.3, 0.2], [99, 0.1, 0.1], [0, 0], [7]]) {
    const n = normalizedWeights(ws);
    assertEquals(n.reduce((s, w) => s + w, 0), 100, `${ws}`);
    assert(n.every((w) => w >= 1), `${ws} → ${n}`);
  }
});

Deno.test("topic guess and requote", () => {
  assertEquals(topicGuess("Nuclear wins the AI power race", []).topic, "topic-nuclear");
  assertEquals(topicGuess("Nuclear wins the AI power race", []).tags, ["Energy", "AI"]);
  assertEquals(topicGuess("Gold to 5k", []).topic, "topic-coin");
  assert(isRequote("send_failed", { requote: true }));
  assert(isRequote("quote_stale", {}));
  assert(!isRequote("take_closed", {}));
});

Deno.test("limit overrides: a bigger max for listed wallets only, capped at $10,000", () => {
  const w = "4Nd1mYw9Hn3sJkF5nX3z5Qk1yJ7mJ9dLqA3r7vN2hTxz";
  const o = parseLimitOverrides(`${w}=10000, junk=5, ${w.slice(0, 20)}=99999`);
  assertEquals([...o.entries()], [[w, 10000]]);
  assertEquals(parseLimitOverrides(`${w}=50000`).get(w), 10000);
  assertEquals(readLimits({ per_trade_usd: 2500, daily_usd: 10000 }, 10000), { perTradeUsd: 2500, dailyUsd: 10000 });
  assertEquals(readLimits({ per_trade_usd: 2500, daily_usd: 10000 }), null);
});

Deno.test("a sale with no side sells the side held, take-relative", () => {
  // An inverted take's author holds an on-chain fade: that agrees with the take, a "back".
  assertEquals(heldTakeSide(["fade"], true), "back");
  // Disagreeing with an inverted take is an on-chain back: a "fade".
  assertEquals(heldTakeSide(["back"], true), "fade");
  assertEquals(heldTakeSide(["back"], false), "back");
  assertEquals(heldTakeSide(["fade", "fade"], false), "fade");
  // Both sides, or nothing found: "back", as before.
  assertEquals(heldTakeSide(["back", "fade"], false), "back");
  assertEquals(heldTakeSide([], true), "back");
});
