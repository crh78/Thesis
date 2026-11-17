import assert from "node:assert/strict";
import { test } from "node:test";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { THESIS_PROGRAM_ID, thesisCpiEventData, thesisProgram, type TakeAccount } from "@thesis/chain";
import idl from "../../../packages/chain/idl/thesis.json" with { type: "json" };
import { underlyingIdHex } from "@thesis/venues/bank";
import { staticBankIndex } from "../src/settler/bank.ts";
import { legStakeUsd, provedToken, receivedValueShortfall, tradeProof, type ProvedOutput, type TradeProof } from "../src/settler/proof.ts";

const NVDA = "equity:US:NVDA";
const SPY = "etf:US:SPY";
const NVDAX = Keypair.generate().publicKey.toBase58();
const SPYX = Keypair.generate().publicKey.toBase58();
const bank = staticBankIndex([NVDA, SPY], [
  { mint: NVDAX, underlyingKey: NVDA, underlyingPerUiToken: 1 },
  { mint: SPYX, underlyingKey: SPY, underlyingPerUiToken: 1 },
]);
const out = (mint: string | null, received: bigint, uiPerUnit: number | null = 1e-8): ProvedOutput => ({ account: Keypair.generate().publicKey.toBase58(), received, mint, uiPerUnit });
const proof = (outputs: [number, ProvedOutput][]): TradeProof => ({ spent: 25_000_000n, outputs: new Map(outputs) });
const spot = (key: string) => ({ kind: "spot", assetIdHex: underlyingIdHex(key) });

test("a spot leg is priced only on a delivered token of its own underlying", () => {
  const ok = provedToken(spot(NVDA), "back", proof([[0, out(NVDAX, 10n)]]), 0, bank);
  assert.ok(ok.ok && ok.token?.mint === NVDAX);
  // No token for the leg: no stock fallback.
  const none = provedToken(spot(NVDA), "back", proof([]), 0, bank);
  assert.ok(!none.ok && /no stock fallback/.test(none.reason));
  // A receipt from before proof of trade proves nothing.
  assert.ok(!provedToken(spot(NVDA), "back", null, 0, bank).ok);
  // A different asset than the leg's (a cheap token instead of NVDAx).
  const wrong = provedToken(spot(NVDA), "back", proof([[0, out(SPYX, 10n)]]), 0, bank);
  assert.ok(!wrong.ok && /not this leg's asset/.test(wrong.reason));
  // A token the bank doesn't know.
  assert.ok(!provedToken(spot(NVDA), "back", proof([[0, out(Keypair.generate().publicKey.toBase58(), 10n)]]), 0, bank).ok);
  // Nothing received.
  assert.ok(!provedToken(spot(NVDA), "back", proof([[0, out(NVDAX, 0n)]]), 0, bank).ok);
});

test("perps and fades go to the Phoenix check (phoenix-legs.ts), with no token", () => {
  assert.deepEqual(provedToken({ kind: "perp", assetIdHex: underlyingIdHex(NVDA) }, "back", proof([]), 0, bank), { ok: true, token: null });
  assert.deepEqual(provedToken(spot(NVDA), "fade", proof([[0, out(NVDAX, 10n)]]), 0, bank), { ok: true, token: null });
  // Prediction legs pass through to pricing.ts (they have their own source).
  assert.deepEqual(provedToken({ kind: "prediction", assetIdHex: "00" }, "fade", proof([]), 1, bank), { ok: true, token: null });
});

test("a leg's share of the stake is its weight over the included legs", () => {
  const take = { legs: [{ weightBps: 6_000 }, { weightBps: 3_000 }, { weightBps: 1_000 }] } as unknown as Pick<TakeAccount, "legs">;
  assert.equal(legStakeUsd(take, 0b111, 25_000_000n, 0), 15);
  // Leg 2 left out: legs 0 and 1 split the stake 2:1.
  assert.equal(legStakeUsd(take, 0b011, 30_000_000n, 1), 10);
});

test("the tokens received must be worth 90% of the leg's part of the stake", () => {
  const token = { underlyingPerUiToken: 1 };
  // 0.1 NVDA-equivalent (1e7 units at 1e-8) at $150 = $15 for a $15 leg.
  assert.equal(receivedValueShortfall(out(NVDAX, 10_000_000n), token, 150, 15), null);
  // $13.50 is exactly 90%.
  assert.equal(receivedValueShortfall(out(NVDAX, 9_000_000n), token, 150, 15), null);
  // Dust of the right token: a stake swapped through a pool at an absurd price.
  assert.match(receivedValueShortfall(out(NVDAX, 1n), token, 150, 15)!, /under 90%/);
  // The threshold is configurable.
  assert.equal(receivedValueShortfall(out(NVDAX, 5_000_000n), token, 150, 15, 0.5), null);
  // A token with units per share (e.g. 0.5 shares per token) counts at its scale.
  assert.match(receivedValueShortfall(out(NVDAX, 10_000_000n), { underlyingPerUiToken: 0.5 }, 150, 15)!, /\$7\.50/);
  assert.match(receivedValueShortfall(out(NVDAX, 10n, null), token, 150, 15)!, /unknown scale/);
});

for (const style of ["self-CPI, logs cut short", "logs, from before emit_cpi"] as const)
test(`the receipt's TradeProved event gives each leg's output, mint and scale (${style})`, async () => {
  const program = thesisProgram(new Connection("http://127.0.0.1:8899"));
  const position = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const [nvdaxAccount, earlier] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const event = idl.events.find((e) => e.name === "TradeProved")!;
  const body = program.coder.types.encode("tradeProved", {
    position,
    owner,
    spent: new BN(25_000_000),
    outputsMask: 0b101,
    outputs: [earlier, nvdaxAccount],
    received: [new BN(3), new BN(12_345_678)],
  });
  const eventBytes = Buffer.concat([Buffer.from(event.discriminator), body]);
  const cpi = style.startsWith("self-CPI");
  // The program's way: an inner Thesis instruction, which survives the validator cutting a big
  // trade's logs. The old way: a "Program data:" line.
  const logs = cpi
    ? [`Program ${THESIS_PROGRAM_ID.toBase58()} invoke [1]`, "Log truncated"]
    : [
        `Program ${THESIS_PROGRAM_ID.toBase58()} invoke [1]`,
        `Program data: ${eventBytes.toString("base64")}`,
        `Program ${THESIS_PROGRAM_ID.toBase58()} success`,
      ];
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [new TransactionInstruction({ programId: THESIS_PROGRAM_ID, keys: [{ pubkey: nvdaxAccount, isSigner: false, isWritable: true }], data: Buffer.alloc(0) })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const nvdaxIndex = message.staticAccountKeys.findIndex((k) => k.equals(nvdaxAccount));
  const thesisIndex = message.staticAccountKeys.findIndex((k) => k.equals(THESIS_PROGRAM_ID));
  const innerInstructions = cpi
    ? [{ index: 0, instructions: [{ programIdIndex: thesisIndex, accounts: [], data: thesisCpiEventData(eventBytes) }] }]
    : [];
  // The output filled in an earlier transaction of a split trade isn't in the receipt's balances:
  // its mint comes from the account, its decimals from the mint.
  const spyxMint = new PublicKey(SPYX);
  const tokenData = Buffer.alloc(165);
  spyxMint.toBuffer().copy(tokenData, 0);
  const mintData = Buffer.alloc(82);
  mintData[44] = 6;
  const conn = {
    // Newest first, as the RPC returns them: a later price record, the receipt, then the split
    // trade's first transaction (begin_trade names the position too).
    getSignaturesForAddress: async () => [{ signature: "later", err: null }, { signature: "receipt", err: null }, { signature: "begin", err: null }],
    getTransaction: async (sig: string) => {
      assert.notEqual(sig, "later", "stops at the receipt");
      if (sig === "begin") return { transaction: tx, meta: { err: null, logMessages: [], loadedAddresses: { writable: [], readonly: [] } } };
      return {
        transaction: tx,
        meta: {
          err: null,
          logMessages: logs,
          innerInstructions,
          loadedAddresses: { writable: [], readonly: [] },
          postTokenBalances: [{ accountIndex: nvdaxIndex, mint: NVDAX, uiTokenAmount: { amount: "12345678", uiAmountString: "0.12345678", decimals: 8 } }],
        },
      };
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => ({ data: k.equals(earlier) ? tokenData : mintData })),
  } as unknown as Connection;

  const p = await tradeProof(conn, program, position);
  assert.ok(p);
  assert.equal(p.spent, 25_000_000n);
  assert.deepEqual([...p.outputs.keys()], [0, 2]);
  const nv = p.outputs.get(2)!;
  assert.deepEqual([nv.mint, nv.received], [NVDAX, 12_345_678n]);
  assert.ok(Math.abs(nv.uiPerUnit! - 1e-8) < 1e-20);
  const sp = p.outputs.get(0)!;
  assert.deepEqual([sp.mint, sp.received, sp.uiPerUnit], [SPYX, 3n, 1e-6]);

  // A receipt with no TradeProved event (from before proof of trade) proves nothing.
  const bare = { ...conn, getTransaction: async () => ({ transaction: tx, meta: { err: null, logMessages: [], loadedAddresses: { writable: [], readonly: [] } } }) } as unknown as Connection;
  assert.equal(await tradeProof(bare, program, position), null);
});

test("a yield leg is priced on the vault share its trade delivered", () => {
  const JL = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";
  const leg = { kind: "yield", assetIdHex: underlyingIdHex(`token:${JL}`) };
  const ok = provedToken(leg, "back", proof([[1, out(JL, 9_349_000n, 1e-6)]]), 1, bank);
  assert.ok(ok.ok && ok.token?.mint === JL && ok.token.underlyingPerUiToken === 1);
  assert.match((provedToken(leg, "back", proof([]), 1, bank) as { reason: string }).reason, /no vault share/);
  assert.match((provedToken(leg, "back", proof([[1, out(NVDAX, 10n)]]), 1, bank) as { reason: string }).reason, /isn't this yield leg's vault/);
  // Shares worth $10 for a $10 leg pass the value check; a sliver doesn't.
  assert.equal(receivedValueShortfall(out(JL, 9_349_000n, 1e-6), { underlyingPerUiToken: 1 }, 1.06958, 10), null);
  assert.match(receivedValueShortfall(out(JL, 100n, 1e-6), { underlyingPerUiToken: 1 }, 1.06958, 10)!, /under 90%/);
});
