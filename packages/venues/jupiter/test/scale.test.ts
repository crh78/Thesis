import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  EXACT_IN_ROUTES,
  SCALE_LIMITS,
  TEMPLATE_OWNER,
  TOKEN_2022_PROGRAM,
  associatedTokenAddress,
  fromTemplate,
  minOut,
  routeAmounts,
  scaleSwap,
  scaleTemplate,
  swapTemplate,
  unscalable,
  type SwapLeg,
} from "../src/index.ts";

// Recorded: one $15 quote (USDC → NVDAx through wSOL, Jupiter v6 `route`) and Jupiter's
// swap-instructions for it from two throwaway wallets (fixtures/swap-instructions.json).
const rec = JSON.parse(readFileSync(new URL("./fixtures/swap-instructions.json", import.meta.url), "utf8"));
const quote = rec.quote;
const [a, b] = rec.wallets.map((w: { user: string; response: SwapLeg["res"] }) => ({ user: new PublicKey(w.user), res: w.response }));
const payer = Keypair.generate().publicKey;
const NVDAX = quote.outputMint;
const leg = (res: SwapLeg["res"] = a.res, q = quote): SwapLeg => ({ res, quote: q });

test("the route discriminators are Anchor's for route and shared_accounts_route", () => {
  for (const [hex, name] of Object.entries(EXACT_IN_ROUTES)) assert.equal(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex"), hex);
});

test("the recorded route instruction carries the quote's amounts at its end", () => {
  assert.deepEqual(routeAmounts(a.res.swapInstruction), { name: "route", inAmount: 15_000_000n, quotedOutAmount: 9_849_790n, slippageBps: 100, platformFeeBps: 0 });
  assert.equal(minOut(9_849_790n, 100), BigInt(quote.otherAmountThreshold), "Jupiter's minimum is the output less slippage");
});

test("scaling rewrites only the input (exactly) and the expected output (in proportion)", () => {
  const scaled = scaleSwap(leg(), 20_000_000n);
  const before = Buffer.from(a.res.swapInstruction.data, "base64");
  const after = Buffer.from(scaled.res.swapInstruction.data, "base64");
  assert.equal(after.length, before.length);
  assert.ok(after.subarray(0, after.length - 19).equals(before.subarray(0, before.length - 19)), "the route plan is untouched");
  assert.ok(after.subarray(after.length - 3).equals(before.subarray(before.length - 3)), "slippage and fee are untouched");
  const expectOut = (9_849_790n * 20_000_000n) / 15_000_000n;
  assert.deepEqual(routeAmounts(scaled.res.swapInstruction), { name: "route", inAmount: 20_000_000n, quotedOutAmount: expectOut, slippageBps: 100, platformFeeBps: 0 });
  assert.equal(scaled.quote.inAmount, "20000000");
  assert.equal(scaled.quote.outAmount, String(expectOut));
  assert.equal(scaled.quote.otherAmountThreshold, String(minOut(expectOut, 100)));
  assert.equal(scaled.quote.routePlan![0].swapInfo!.inputMint, quote.routePlan[0].swapInfo.inputMint);
  assert.equal((scaled.quote.routePlan![0].swapInfo as { inAmount: string }).inAmount, "20000000");
  // Every account, program and other instruction is the same object's copy.
  assert.deepEqual(scaled.res.swapInstruction.accounts, a.res.swapInstruction.accounts);
  assert.equal(scaled.res.swapInstruction.programId, a.res.swapInstruction.programId);
  assert.deepEqual(scaled.res.setupInstructions, a.res.setupInstructions);
  assert.deepEqual(scaled.res.addressLookupTableAddresses, a.res.addressLookupTableAddresses);
  // The original is left as it was.
  assert.equal(routeAmounts(a.res.swapInstruction)!.inAmount, 15_000_000n);
  assert.equal(quote.inAmount, "15000000");
});

test("scaled back to the quoted amount it's the recorded answer", () => {
  const there = scaleSwap(leg(), 30_000_000n);
  const back = scaleSwap(there, 15_000_000n);
  assert.equal(back.res.swapInstruction.data, a.res.swapInstruction.data);
  assert.equal(back.quote.outAmount, quote.outAmount);
  assert.equal(back.quote.otherAmountThreshold, quote.otherAmountThreshold);
});

test("a scaled template builds a second wallet's leg: its own accounts, the exact new input", () => {
  const t = swapTemplate(leg(), a.user)!;
  const scaled = scaleTemplate(t, 12_345_678n)!;
  assert.ok(scaled.template);
  const built = fromTemplate(scaled, b.user, payer, "NVDAx");
  assert.equal(built.inUsdc, 12_345_678n);
  assert.equal(built.outAmount, (9_849_790n * 12_345_678n) / 15_000_000n);
  assert.equal(built.minOutAmount, minOut(built.outAmount, 100));
  assert.equal(built.outputAccount?.toBase58(), associatedTokenAddress(b.user, NVDAX, TOKEN_2022_PROGRAM));
  const swap = built.instructions.find((ix) => ix.programId.toBase58() === a.res.swapInstruction.programId)!;
  assert.equal(swap.data.readBigUInt64LE(swap.data.length - 19), 12_345_678n);
  assert.ok(!swap.keys.some((k) => k.pubkey.equals(a.user) || k.pubkey.equals(TEMPLATE_OWNER)));
});

test("the safety bounds: ratio, price impact, shortfall when scaling up", () => {
  assert.equal(unscalable(leg(), 15_000_000n), null);
  assert.equal(unscalable(leg(), 1_500_000n), null, "0.1x");
  assert.equal(unscalable(leg(), 150_000_000n), null, "10x (no price impact: no shortfall)");
  assert.match(unscalable(leg(), 1_499_999n)!, /outside/);
  assert.match(unscalable(leg(), 150_000_001n)!, /outside/);
  // 0.16% impact (MSFTx for $5 on the owner's take): 4x up falls ~0.48% short (fine), 5x ~0.65%
  // (over 0.5%); scaling down is always fine.
  const thin = leg(a.res, { ...quote, priceImpactPct: "0.0016" });
  assert.equal(unscalable(thin, 60_000_000n), null, "4x");
  assert.match(unscalable(thin, 75_000_000n)!, /short/);
  assert.equal(unscalable(thin, 1_500_000n), null, "0.1x down");
  assert.match(unscalable(leg(), 0n)!, /nothing to scale/);
  assert.match(unscalable(leg(a.res, { ...quote, priceImpactPct: "0.0051" }), 15_000_001n)!, /price impact 0.510% is over 0.5%/);
  assert.equal(unscalable(leg(a.res, { ...quote, priceImpactPct: "0.0049" }), 15_000_001n), null);
  assert.match(unscalable(leg(a.res, { ...quote, priceImpactPct: undefined }), 20_000_000n)!, /no price impact/);
  assert.match(unscalable(leg(a.res, { ...quote, priceImpactPct: "lots" }), 20_000_000n)!, /no price impact/);
  assert.equal(unscalable(leg(), 50_000_000n, { ...SCALE_LIMITS, maxRatio: 4 }), null, "limits are a parameter");
  assert.equal(scaleTemplate(swapTemplate(leg(), a.user)!, 160_000_000n), null);
  assert.throws(() => scaleSwap(leg(), 160_000_000n), /outside/);
});

test("anything not read with certainty isn't scaled", () => {
  const data = (hex: string) => {
    const d = Buffer.from(a.res.swapInstruction.data, "base64");
    Buffer.from(hex, "hex").copy(d);
    return d.toString("base64");
  };
  const withSwap = (patch: object) => leg({ ...a.res, swapInstruction: { ...a.res.swapInstruction, ...patch } });
  assert.match(unscalable(withSwap({ data: data("d033ef977b2bed5c") }), 20_000_000n)!, /isn't a route instruction/, "exact_out_route");
  assert.match(unscalable(withSwap({ data: data("bb64facc31c4af14") }), 20_000_000n)!, /isn't a route instruction/, "route_v2");
  assert.match(unscalable(withSwap({ programId: TOKEN_2022_PROGRAM }), 20_000_000n)!, /isn't a route instruction/);
  assert.match(unscalable(withSwap({ data: "AA==" }), 20_000_000n)!, /isn't a route instruction/);
  // Amounts or slippage that don't read back as the quote's: the layout isn't what it seems.
  assert.match(unscalable(leg(a.res, { ...quote, inAmount: "15000001" }), 20_000_000n)!, /amounts aren't the quote's/);
  assert.match(unscalable(leg(a.res, { ...quote, outAmount: "9849791" }), 20_000_000n)!, /amounts aren't the quote's/);
  assert.match(unscalable(leg(a.res, { ...quote, slippageBps: 50 }), 20_000_000n)!, /slippage/);
  assert.match(unscalable(leg(a.res, { ...quote, platformFee: { amount: "1", feeBps: 20 } }), 20_000_000n)!, /platform fee/);
  assert.match(unscalable(leg(a.res, { ...quote, otherAmountThreshold: "9000000" }), 20_000_000n)!, /minimum/);
  assert.match(unscalable(leg(a.res, { ...quote, swapMode: "ExactOut" }), 20_000_000n)!, /ExactOut/);
  // Instructions besides the swap that might carry an amount.
  const ix = a.res.swapInstruction;
  assert.match(unscalable(leg({ ...a.res, cleanupInstruction: ix }), 20_000_000n)!, /cleanup/);
  assert.match(unscalable(leg({ ...a.res, tokenLedgerInstruction: ix }), 20_000_000n)!, /token ledger/);
  assert.match(unscalable(leg({ ...a.res, setupInstructions: [...a.res.setupInstructions, ix] }), 20_000_000n)!, /setup/);
  assert.match(unscalable(leg({ ...a.res, error: "no route" }), 20_000_000n)!, /error/);
});
