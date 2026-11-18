import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TEMPLATE_OWNER,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  associatedTokenAddress,
  buyInstructions,
  fromTemplate,
  legDiff,
  retarget,
  routeMints,
  swapTemplate,
  unshareable,
  type SwapLeg,
} from "../src/index.ts";

// Recorded: one quote (USDC → NVDAx through wSOL, the fork's DEX allowlist) and Jupiter's
// swap-instructions for it from two throwaway wallets (fixtures/swap-instructions.json).
const rec = JSON.parse(readFileSync(new URL("./fixtures/swap-instructions.json", import.meta.url), "utf8"));
const quote = rec.quote;
const [a, b] = rec.wallets.map((w: { user: string; response: SwapLeg["res"] }) => ({ user: new PublicKey(w.user), res: w.response }));
const payer = Keypair.generate().publicKey;
const NVDAX = quote.outputMint;
const WSOL = "So11111111111111111111111111111111111111112";

test("the recording: the two wallets' answers differ only in the wallet and its own accounts", () => {
  assert.notEqual(JSON.stringify(a.res), JSON.stringify(b.res));
  assert.deepEqual(routeMints(quote).sort(), [USDC_MINT, WSOL, NVDAX].sort());
});

test("a template from one wallet, retargeted to another, is that wallet's own answer byte for byte", () => {
  const t = swapTemplate({ res: a.res, quote }, a.user);
  assert.ok(t, "shareable");
  assert.deepEqual(retarget(t, TEMPLATE_OWNER, b.user), { ...b.res, tokenLedgerInstruction: b.res.tokenLedgerInstruction });
  const fresh = buyInstructions(b.res, quote, b.user, payer, "NVDAx");
  const shared = fromTemplate(t, b.user, payer, "NVDAx");
  assert.equal(legDiff(shared, fresh), null);
  // Proof of trade: the leg fills the second wallet's own NVDAx account, for exactly the quote's USDC.
  assert.equal(shared.outputAccount?.toBase58(), associatedTokenAddress(b.user, NVDAX, TOKEN_2022_PROGRAM));
  assert.equal(shared.inUsdc, BigInt(quote.inAmount));
  assert.ok(!shared.marketAccounts.some((k) => k.equals(b.user) || k.equals(a.user)));
});

test("a template carries nothing of the wallet it came from", () => {
  const t = swapTemplate({ res: a.res, quote }, a.user)!;
  const text = JSON.stringify(t.res);
  const own = [a.user.toBase58(), ...routeMints(quote).flatMap((m) => [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((p) => associatedTokenAddress(a.user, m, p)))];
  for (const k of own) assert.ok(!text.includes(k), `${k} is gone`);
  assert.ok(text.includes(TEMPLATE_OWNER.toBase58()));
});

test("retargeting there and back gives the answer it started from", () => {
  const there = retarget({ res: a.res, quote }, a.user, b.user);
  assert.deepEqual(retarget({ res: there, quote }, b.user, a.user), { ...a.res, tokenLedgerInstruction: a.res.tokenLedgerInstruction });
  assert.deepEqual(a.res.swapInstruction.accounts[1].pubkey, rec.wallets[0].response.swapInstruction.accounts[1].pubkey, "the input isn't changed");
});

test("answers that might depend on the wallet aren't shared", () => {
  const leg = (res: SwapLeg["res"]): SwapLeg => ({ res, quote });
  const outAta = associatedTokenAddress(a.user, NVDAX, TOKEN_2022_PROGRAM);
  // The wallet already had its NVDAx account, so Jupiter left out the create: another wallet would need it.
  const noCreate = { ...a.res, setupInstructions: a.res.setupInstructions.filter((ix: any) => ix.accounts[1].pubkey !== outAta) };
  assert.match(unshareable(leg(noCreate), a.user)!, /isn't created in the setup/);
  assert.equal(swapTemplate(leg(noCreate), a.user), null);
  // Someone else signs.
  const other = Keypair.generate().publicKey.toBase58();
  const cosigned = { ...a.res, swapInstruction: { ...a.res.swapInstruction, accounts: [...a.res.swapInstruction.accounts, { pubkey: other, isSigner: true, isWritable: false }] } };
  assert.match(unshareable(leg(cosigned), a.user)!, /another account signs/);
  // The wallet's address inside instruction data.
  const data = Buffer.concat([Buffer.from(a.res.swapInstruction.data, "base64"), a.user.toBuffer()]).toString("base64");
  assert.match(unshareable(leg({ ...a.res, swapInstruction: { ...a.res.swapInstruction, data } }), a.user)!, /in its data/);
  // A plain (not idempotent) create would fail for a wallet that has the account on the fork.
  const plain = { ...a.res, setupInstructions: a.res.setupInstructions.map((ix: any) => ({ ...ix, data: "" })) };
  assert.match(unshareable(leg(plain), a.user)!, /isn't idempotent/);
  assert.match(unshareable(leg({ ...a.res, error: "no route" }), a.user)!, /error/);
  assert.equal(unshareable(leg(a.res), a.user), null);
});

test("legDiff names the first difference", () => {
  const fresh = buyInstructions(b.res, quote, b.user, payer, "x");
  assert.match(legDiff(buyInstructions(a.res, quote, a.user, payer, "x"), fresh)!, /account/);
  assert.match(legDiff({ ...fresh, inUsdc: fresh.inUsdc + 1n }, fresh)!, /amounts/);
});
