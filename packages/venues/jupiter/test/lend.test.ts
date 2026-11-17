import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM, USDC_MINT, associatedTokenAddress } from "../src/index.ts";
import { JL_USDC_MINT, depositInstructions, jupiterLendAccounts, jupiterLendDeposit, jupiterLendRedeem, redeemInstructions } from "../src/lend.ts";

const user = Keypair.generate().publicKey;
const payer = Keypair.generate().publicKey;
const vault = Keypair.generate().publicKey.toBase58();
const acct = (pubkey: string, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
const LEND = "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9";
const userUsdc = associatedTokenAddress(user, USDC_MINT, TOKEN_PROGRAM);
const userShares = associatedTokenAddress(user, JL_USDC_MINT, TOKEN_PROGRAM);
const response = {
  instructions: [
    {
      programId: LEND,
      accounts: [acct(user.toBase58(), true, true), acct(userUsdc, false, true), acct(userShares, false, true), acct(USDC_MINT), acct(vault, false, true)],
      data: Buffer.from("deposit").toString("base64"),
    },
  ],
};

test("creates the user's jlUSDC account first, paid by the app", () => {
  const d = depositInstructions(response, user, payer, 10_000_000n, "jlUSDC $10");
  assert.equal(d.instructions.length, 2);
  const create = d.instructions[0];
  assert.equal(create.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM);
  assert.deepEqual(create.keys[0], { pubkey: payer, isSigner: true, isWritable: true });
  assert.equal(create.keys[1].pubkey.toBase58(), userShares);
  assert.equal(create.keys[2].pubkey.toBase58(), user.toBase58());
  assert.deepEqual([...create.data], [1]);
  assert.equal(d.instructions[1].programId.toBase58(), LEND);
  // Proof of trade watches the jlUSDC account grow.
  assert.equal(d.outputAccount?.toBase58(), userShares);
});

test("market accounts leave out the user's own accounts", () => {
  const d = depositInstructions(response, user, payer, 1n, "x");
  assert.deepEqual(d.marketAccounts.map(String).sort(), [USDC_MINT, vault].sort());
});

test("an empty response throws", () => {
  assert.throws(() => depositInstructions({ instructions: [] }, user, payer, 1n, "x"), /no deposit/);
});

test("the request names USDC, the amount and the user", async () => {
  let sent: any;
  const fake = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify(response));
  }) as typeof fetch;
  await jupiterLendDeposit({ user, payer, amount: 6_000_000n, label: "x", apiKey: "k", fetchFn: fake });
  assert.deepEqual(sent, { asset: USDC_MINT, amount: "6000000", signer: user.toBase58() });
});

test("a redeem sells the user's shares with no account to create", async () => {
  const r = redeemInstructions(response, user, payer, 9_000_000n, "jlUSDC out");
  assert.equal(r.instructions.length, 1);
  assert.equal(r.instructions[0].programId.toBase58(), LEND);
  assert.deepEqual(r.marketAccounts.map(String).sort(), [USDC_MINT, vault].sort());
  assert.throws(() => redeemInstructions({ instructions: [] }, user, payer, 1n, "x"), /no redeem/);

  let sent: any;
  let url = "";
  const fake = (async (u: string, init: RequestInit) => {
    url = u;
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify(response));
  }) as typeof fetch;
  await jupiterLendRedeem({ user, payer, shares: 9_000_000n, label: "x", apiKey: "k", fetchFn: fake });
  assert.match(url, /redeem-instructions$/);
  assert.deepEqual(sent, { asset: USDC_MINT, shares: "9000000", signer: user.toBase58() });
});

test("the lookup table's Lend accounts are what deposits and redeems share, minus any user's own", async () => {
  const extra = Keypair.generate().publicKey.toBase58();
  const fake = (async (u: string, init: RequestInit) => {
    const signer = JSON.parse(String(init.body)).signer as string;
    const ata = (mint: string) => associatedTokenAddress(new PublicKey(signer), mint, TOKEN_PROGRAM);
    const accounts = [acct(signer, true, true), acct(ata(USDC_MINT), false, true), acct(ata(JL_USDC_MINT), false, true), acct(USDC_MINT), acct(vault, false, true)];
    if (u.endsWith("redeem-instructions")) accounts.push(acct(extra, false, true));
    return new Response(JSON.stringify({ instructions: [{ programId: LEND, accounts, data: "" }] }));
  }) as typeof fetch;
  const keys = (await jupiterLendAccounts({ apiKey: "k", fetchFn: fake })).map(String).sort();
  assert.deepEqual(keys, [USDC_MINT, vault, extra].sort());
});

test("one vault share's value is totalAssets / totalSupply, exactly", async () => {
  const { jupiterLendShareValue, JL_USDC_MINT } = await import("../src/lend.ts");
  let url = "";
  const fetchFn = (async (u: string) => {
    url = u;
    return new Response(JSON.stringify([{ address: "other", totalAssets: "1", totalSupply: "1" }, { address: JL_USDC_MINT, totalAssets: "492352259510134", totalSupply: "460323030840750", convertToAssets: "1069580" }]));
  }) as unknown as typeof fetch;
  const v = await jupiterLendShareValue(JL_USDC_MINT, { fetchFn });
  assert.ok(v && Math.abs(v.usdcPerShare - 492352259510134 / 460323030840750) < 1e-12);
  assert.match(url, /lite-api\.jup\.ag\/lend\/v1\/earn\/tokens/);
  assert.equal(await jupiterLendShareValue("missing", { fetchFn }), null);
});
