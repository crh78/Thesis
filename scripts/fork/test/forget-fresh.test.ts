import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicKey } from "@solana/web3.js";
import { TAKE_ID, tradeFixture, type Status } from "./trade-fixture.ts";

// A trade on the fork moves the pools it swaps through and nothing moves them back, so every send,
// landed or not, tells the fork to copy those accounts from mainnet again on the next build.

const confirmed: Status = { err: null, confirmationStatus: "confirmed" };

test("a send marks its market accounts stale, so the next build copies them from mainnet again", async (t) => {
  const forgotten: PublicKey[][] = [];
  const f = await tradeFixture(t, { status: () => confirmed, fork: { forgetFresh: (a: PublicKey[]) => void forgotten.push(a) } });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  await f.service.submit(built.buildId, f.sign(built));
  assert.equal(forgotten.length, 1, "once per send");
});

test("a send that fails still marks them stale", async (t) => {
  const forgotten: PublicKey[][] = [];
  const f = await tradeFixture(t, {
    status: () => confirmed,
    send: () => { throw Object.assign(new Error("Transaction simulation failed: custom program error: 0x1771"), { logs: ["Program log: slippage"] }); },
    fork: { forgetFresh: (a: PublicKey[]) => void forgotten.push(a) },
  });
  const built = await f.service.buildTrade(TAKE_ID, f.wallet, "back", 20);
  await assert.rejects(f.service.submit(built.buildId, f.sign(built)));
  assert.ok(forgotten.length >= 1);
});
