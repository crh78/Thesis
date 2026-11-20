import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPLAIN, OPTED_IN, OPTED_OUT, optCommand, safeClaim, TAKE_TAIL, takeReply, xLength } from "../src/compose.ts";

test("safeClaim strips handles, links, tags and emoji, keeps cashtag names", () => {
  assert.equal(safeClaim("@elonmusk $TSLA beats deliveries https://t.co/abc #stocks 🚀."), "TSLA beats deliveries");
});

test("safeClaim refuses short, long, linked and blocked claims", () => {
  assert.equal(safeClaim("up"), null);
  assert.equal(safeClaim("x".repeat(121)), null);
  assert.equal(safeClaim("buy everything at scamcoin.xyz now"), null);
  assert.equal(safeClaim("defense stocks rise because of the massacre"), null);
});

test("takeReply fits 280 and carries no link", () => {
  const picks = [
    { name: "Constellation Energy", weight: 30 },
    { name: "Vistra", weight: 25 },
    { name: "Cameco", weight: 20 },
    { name: "Global X Uranium ETF", weight: 15 },
    { name: "Oklo", weight: 10 },
  ];
  const claim = "Nuclear power wins the AI data center build out over the next decade and utilities rerate on it";
  const r = takeReply(claim, picks)!;
  assert.ok(r);
  assert.ok(xLength(r) <= 280, `${xLength(r)} chars`);
  assert.ok(r.endsWith(TAKE_TAIL));
  assert.ok(!/https?:\/\//.test(r));
  assert.ok(r.startsWith(`${claim}.`));
  assert.ok(!/[—–]/.test(r));
});

test("takeReply on a basket it bets against says so, and still fits", () => {
  const picks = [{ name: "Bitcoin", weight: 40 }, { name: "Ether", weight: 35 }, { name: "Solana", weight: 25 }];
  const r = takeReply("Crypto keeps falling", picks, true)!;
  assert.ok(r.includes("Betting against: Bitcoin 40%, Ether 35%, Solana 25%"), r);
  assert.ok(xLength(r) <= 280);
  assert.ok(!takeReply("Crypto keeps rising", picks)!.includes("against"));
});

test("takeReply refuses a blocked pick name", () => {
  assert.equal(takeReply("Gold goes up", [{ name: "Hitler Fund", weight: 100 }]), null);
});

test("stop and start are whole-mention commands", () => {
  for (const t of ["stop", "STOP", "Stop.", "unsubscribe", "opt out", "optout!"]) assert.equal(optCommand(t), "stop", t);
  for (const t of ["start", "Start!", "opt in"]) assert.equal(optCommand(t), "start", t);
  for (const t of ["stop the war on crypto", "make this a take", "", "starting to think gold wins"]) assert.equal(optCommand(t), null, t);
});

test("fixed replies fit and carry no link", () => {
  for (const r of [EXPLAIN, OPTED_OUT, OPTED_IN]) {
    assert.ok(r.length <= 280);
    assert.ok(!/https?:\/\//.test(r));
  }
});
