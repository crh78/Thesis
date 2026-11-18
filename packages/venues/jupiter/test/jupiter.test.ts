import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, USDC_MINT, associatedTokenAddress, buyInstructions, jupiterBuy, jupiterQuote, quoteFn, splitStake, type JupSwapInstructions } from "../src/index.ts";

const user = Keypair.generate().publicKey;
const payer = Keypair.generate().publicKey;
const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const pool = Keypair.generate().publicKey.toBase58();
const oracle = Keypair.generate().publicKey.toBase58();
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const userNvdax = associatedTokenAddress(user, NVDAX, TOKEN_2022_PROGRAM);
const userUsdc = associatedTokenAddress(user, USDC_MINT, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const acct = (pubkey: string, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
const ataCreate = (mint: string, ata: string) => ({
  programId: ASSOCIATED_TOKEN_PROGRAM,
  accounts: [acct(user.toBase58(), true, true), acct(ata, false, true), acct(user.toBase58()), acct(mint), acct("11111111111111111111111111111111"), acct(TOKEN_2022_PROGRAM)],
  data: Buffer.from([1]).toString("base64"),
});
const response: JupSwapInstructions = {
  computeBudgetInstructions: [{ programId: "ComputeBudget111111111111111111111111111111", accounts: [], data: "AsBcAAA=" }],
  setupInstructions: [ataCreate(USDC_MINT, userUsdc), ataCreate(NVDAX, userNvdax)],
  swapInstruction: {
    programId: JUP,
    accounts: [acct(user.toBase58(), true, false), acct(userUsdc, false, true), acct(userNvdax, false, true), acct(pool, false, true), acct(oracle)],
    data: Buffer.from("swap").toString("base64"),
  },
  cleanupInstruction: null,
  addressLookupTableAddresses: [Keypair.generate().publicKey.toBase58()],
};
const quote = { inAmount: "15000000", outAmount: "8190000", otherAmountThreshold: "8111706", outputMint: NVDAX };

test("drops compute budget and the USDC account create, keeps the swap", () => {
  const b = buyInstructions(response, quote, user, payer, "NVDAx $15");
  assert.equal(b.instructions.length, 2);
  assert.equal(b.instructions[1].programId.toBase58(), JUP);
  assert.equal(b.instructions[0].keys[3].pubkey.toBase58(), NVDAX);
  assert.deepEqual([b.inUsdc, b.outAmount, b.minOutAmount, b.mint], [15_000_000n, 8_190_000n, 8_111_706n, NVDAX]);
  assert.equal(b.lookupTables.length, 1);
});

test("the app pays for the token account, the user still owns it", () => {
  const ix = buyInstructions(response, quote, user, payer, "x").instructions[0];
  assert.deepEqual(ix.keys[0], { pubkey: payer, isSigner: true, isWritable: true });
  assert.equal(ix.keys[1].pubkey.toBase58(), userNvdax);
  assert.equal(ix.keys[2].pubkey.toBase58(), user.toBase58());
});

test("market accounts exclude the user's own wallet and token accounts", () => {
  const b = buyInstructions(response, quote, user, payer, "x");
  assert.deepEqual(b.marketAccounts.map(String).sort(), [pool, oracle].sort());
});

test("a reverse swap preserves the owner's source account during fork refresh", () => {
  const reverse = { ...response, setupInstructions: [] };
  const sale = buyInstructions(reverse, { ...quote, inputMint: NVDAX, outputMint: USDC_MINT }, user, payer, "Sell NVDAx");
  assert.deepEqual(sale.marketAccounts.map(String).sort(), [pool, oracle].sort());
});

test("the output account is the user's account for the bought token, under its token program", () => {
  const b = buyInstructions(response, quote, user, payer, "x");
  assert.equal(b.outputAccount?.toBase58(), userNvdax);
  // A swap that doesn't name the user's account for the output (a destination elsewhere) has none.
  const elsewhere = { ...response, swapInstruction: { ...response.swapInstruction, accounts: response.swapInstruction.accounts.filter((a) => a.pubkey !== userNvdax) } };
  assert.equal(buyInstructions(elsewhere, quote, user, payer, "x").outputAccount, undefined);
});

test("an error response throws", () => {
  assert.throws(() => buyInstructions({ ...response, error: "no route" }, quote, user, payer, "x"), /no route/);
});

test("jupiterBuy posts the quote for the user and retries rate limits", async () => {
  let calls = 0;
  let sent: any;
  const fake = (async (_url: string, init: RequestInit) => {
    calls++;
    if (calls === 1) return new Response("{}", { status: 429 });
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify(response));
  }) as typeof fetch;
  const b = await jupiterBuy({ quote: quote as any, user, payer, label: "x", fetchFn: fake });
  assert.equal(calls, 2);
  assert.equal(sent.userPublicKey, user.toBase58());
  assert.equal(sent.dynamicComputeUnitLimit, false);
  assert.equal(b.instructions.length, 2);
});

test("stake splits by weight and always adds up", () => {
  assert.deepEqual(splitStake(30_000_000n, [5_000, 3_000, 2_000]), [15_000_000n, 9_000_000n, 6_000_000n]);
  const parts = splitStake(10_000_001n, [3_333, 3_333, 3_334]);
  assert.equal(parts.reduce((a, b) => a + b, 0n), 10_000_001n);
  assert.throws(() => splitStake(1n, [0]));

});

test("a caller that won't wait gets Jupiter's 429 back at once", async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    return new Response("{}", { status: 429 });
  }) as typeof fetch;
  const started = Date.now();
  await assert.rejects(jupiterBuy({ quote: quote as any, user, payer, label: "x", fetchFn: fake, max429WaitMs: 0 }), /HTTP 429/);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 500);
});

test("quotes: a route, Jupiter's no-route code, or the HTTP status of anything else", async () => {
  let url = "";
  const answer = (status: number, body: unknown) =>
    (async (u: string) => {
      url = u;
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  const routed = { inAmount: "15000000", outAmount: "8190000", otherAmountThreshold: "8111706", priceImpactPct: "0", slippageBps: 100, routePlan: [{ swapInfo: {}, percent: 100 }] };
  const q = await quoteFn({ fetchFn: answer(200, routed) })(NVDAX, 15, { maxAccounts: 30, dexes: ["Whirlpool", "Raydium CLMM"] });
  assert.equal(q.quote?.outAmount, "8190000");
  assert.match(url, /^https:\/\/lite-api\.jup\.ag\/swap\/v1\/quote\?inputMint=EPjF\w+&outputMint=Xsc9\w+&amount=15000000&slippageBps=100&maxAccounts=30&dexes=Whirlpool%2CRaydium%20CLMM$/);
  assert.deepEqual(await quoteFn({ fetchFn: answer(400, { errorCode: "COULD_NOT_FIND_ANY_ROUTE" }) })(NVDAX, 15, { maxAccounts: 30 }), { quote: null, error: "COULD_NOT_FIND_ANY_ROUTE" });
  assert.deepEqual(await quoteFn({ fetchFn: answer(429, {}), max429WaitMs: 0 })(NVDAX, 15, { maxAccounts: 30 }), { quote: null, error: "HTTP 429" });
  const sale = await jupiterQuote({ apiKey: "k", fetchFn: answer(200, routed), inputMint: NVDAX, outputMint: USDC_MINT, amount: 5n, maxAccounts: 20 });
  assert.ok(sale.quote);
  assert.match(url, /^https:\/\/api\.jup\.ag\/swap\/v1\/quote\?inputMint=Xsc9\w+&outputMint=EPjF\w+&amount=5&/);
});
