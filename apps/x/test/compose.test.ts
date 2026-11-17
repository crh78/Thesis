import assert from "node:assert/strict";
import { test } from "node:test";
import { safeClaim, takeReply, xLength } from "../src/compose.ts";

test("safeClaim strips handles, links, tags and emoji, keeps cashtag names", () => {
  assert.equal(safeClaim("@elonmusk $TSLA beats deliveries https://t.co/abc #stocks 🚀."), "TSLA beats deliveries");
});

test("safeClaim refuses short, long, linked and blocked claims", () => {
  assert.equal(safeClaim("up"), null);
  assert.equal(safeClaim("x".repeat(121)), null);
  assert.equal(safeClaim("buy everything at scamcoin.xyz now"), null);
  assert.equal(safeClaim("defense stocks rise because of the massacre"), null);
});

test("takeReply fits 280 with the link counted as 23", () => {
  const link = "https://thesis-www.vercel.app/d/AbCdEfGh";
  const picks = [
    { name: "Constellation Energy", weight: 30 },
    { name: "Vistra", weight: 25 },
    { name: "Cameco", weight: 20 },
    { name: "Global X Uranium ETF", weight: 15 },
    { name: "Oklo", weight: 10 },
  ];
  const claim = "Nuclear power wins the AI data center build out over the next decade and utilities rerate on it";
  const r = takeReply(claim, picks, link)!;
  assert.ok(r);
  assert.ok(xLength(r) <= 280, `${xLength(r)} chars`);
  assert.ok(r.endsWith(link));
  assert.ok(r.startsWith(`${claim}.`));
  assert.ok(!/[—–]/.test(r));
});

test("takeReply refuses a blocked pick name", () => {
  assert.equal(takeReply("Gold goes up", [{ name: "Hitler Fund", weight: 100 }], "https://x.co/d/AbCdEfGh"), null);
});
