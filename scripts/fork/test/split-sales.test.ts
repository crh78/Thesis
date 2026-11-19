// Sales over several transactions (api/sales.ts): a sale that doesn't fit in one transaction is a
// sequence with the positions' records last, one swap per token however many positions sell it,
// and a sale that stops partway is finished by selling again.
import assert from "node:assert/strict";
import { test } from "node:test";
import BN from "bn.js";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import idl from "@thesis/chain/idl/thesis.json" with { type: "json" };
import { positionAddress } from "@thesis/chain";
import { ApiError, base58 } from "../api/common.ts";
import { ForkService } from "../api/service.ts";
import { mergeInventory, saleLeft, stepsByTx } from "../api/sales.ts";
import { TAKE_ID, tradeFixture, type Status } from "./trade-fixture.ts";

const apiError = (status: number, code: string) => (e: unknown) => e instanceof ApiError && e.status === status && e.code === code;

test("a holding sale swaps each token once, summing exactly what each position sells of it", () => {
  const merged = mergeInventory([
    [{ mint: "NVDAx", amount: 333_333n, isYield: false }, { mint: "IREN", amount: 10n, isYield: false }, { mint: "jlUSDC", amount: 5_000_001n, isYield: true }],
    [{ mint: "NVDAx", amount: 666_667n, isYield: false }, { mint: "AVGOx", amount: 7n, isYield: false }, { mint: "jlUSDC", amount: 4_999_999n, isYield: true }],
    [{ mint: "IREN", amount: 0n, isYield: false }],
  ]);
  assert.deepEqual(merged, [
    { mint: "NVDAx", amount: 1_000_000n, isYield: false },
    { mint: "IREN", amount: 10n, isYield: false },
    { mint: "jlUSDC", amount: 10_000_000n, isYield: true },
    { mint: "AVGOx", amount: 7n, isYield: false },
  ]);
  assert.throws(() => mergeInventory([[{ mint: "X", amount: 1n, isYield: false }], [{ mint: "X", amount: 1n, isYield: true }]]), apiError(422, "inventory_unavailable"));
});

test("a stopped sale has left what its transactions that didn't land carried; nothing while one may still land", () => {
  const steps = stepsByTx([[0, 1], [2, 3, 4]], [
    { kind: "phoenix", position: "A", leg: 2 },
    { kind: "sell", mint: "NVDAx", amount: "100" },
    { kind: "sell", mint: "NVDAx", amount: "5" },
    { kind: "redeem", mint: "jlUSDC", amount: "7" },
    { kind: "record", position: "A" },
  ], { kind: "record", position: "B" });
  assert.deepEqual(steps[1].at(-1), { kind: "record", position: "B" }, "the receipt rides in the last transaction");
  assert.equal(steps[0].length, 2);
  const txs = steps.map((s) => ({ steps: s }));
  assert.equal(saleLeft(txs, ["landed", "pending"]), null);
  const left = saleLeft(txs, ["landed", "failed"])!;
  assert.deepEqual([...left.sells], [["NVDAx", 5n]]);
  assert.deepEqual([...left.redeems], [["jlUSDC", 7n]]);
  assert.deepEqual(left.phoenix, []);
  assert.deepEqual([...left.records], ["A", "B"]);
  const all = saleLeft(txs, ["failed", "failed"])!;
  assert.deepEqual([...all.sells], [["NVDAx", 105n]]);
  assert.deepEqual(all.phoenix, [{ position: "A", leg: 2 }]);
});

/** A card position of `stake` dollars (all of it escrowed) for the fixture's wallet. */
async function cardPosition(f: Awaited<ReturnType<typeof tradeFixture>>, id: number, stake: number, o: { exited?: boolean } = {}) {
  const owner = f.owner.publicKey;
  const address = positionAddress(f.take, owner, BigInt(id));
  const units = (usd: number) => new BN(Math.round(usd * 1e6));
  f.accounts.set(address.toBase58(), await f.program.coder.accounts.encode("position", {
    owner, take: f.take, id: new BN(id), rentPayer: f.appPayer.publicKey, side: { back: {} }, stake: units(stake),
    openedAt: new BN(Math.floor(Date.now() / 1000) - 3_600), legsMask: 1, prices: [{ entry: new BN(100_000_000), exit: new BN(0) }],
    entrySet: 1, exitSet: 0, scored: true, exited: o.exited ?? false, escrowed: units(stake), bump: 255,
    remaining: units(stake), parts: 0, partsSettled: 0, realizedPnl: units(0),
  }));
  if (!f.scanned.some((k) => k.equals(address))) f.scanned.push(address);
  return address;
}

const discriminator = (name: string) => Buffer.from(idl.instructions.find((i) => i.name === name)!.discriminator);
const decode = (b64: string) => VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
/** The positions whose exit_position is in a transaction (the fixture has no lookup table: every key is static). */
function exitsIn(b64: string, positions: PublicKey[]): string[] {
  const tx = decode(b64);
  const keys = tx.message.staticAccountKeys;
  const exits = tx.message.compiledInstructions.filter((ix) => Buffer.from(ix.data.subarray(0, 8)).equals(discriminator("exit_position")));
  return positions.filter((p) => exits.some((ix) => ix.accountKeyIndexes.some((k) => keys[k].equals(p)))).map(String);
}

test("a sale too big for one transaction is a sequence, every record once and the last one last; one that stops is finished by selling again", async (t) => {
  let height = 50;
  const statuses = new Map<string, Status>();
  /** Which send (1-based) is refused by its preflight. */
  let refuse = 0;
  const f = await tradeFixture(t, {
    status: (sig) => statuses.get(sig) ?? null,
    height: () => height,
    send: async (tx) => {
      if (f.sent.length === refuse) throw new Error("Transaction simulation failed: custom program error");
      return base58(tx.signatures[0]);
    },
  });
  const positions: PublicKey[] = [];
  for (let i = 1; i <= 14; i++) positions.push(await cardPosition(f, i, 10 + i));
  const service = new ForkService(f.options);
  const built = await service.buildHoldingSale(TAKE_ID, f.wallet, "back", { bps: 10_000 });
  assert.ok(built.transactions.length > 1, `${built.transactions.length} transaction(s)`);
  const perTx = built.transactions.map((b64) => exitsIn(b64, positions));
  assert.deepEqual(perTx.flat().sort(), positions.map(String).sort(), "every position's record, once");
  assert.equal(built.steps.at(-1)!.labels.at(-1), "thesis receipt");
  assert.ok(perTx.at(-1)!.includes(built.positions!.at(-1)!), "the last position's record is the receipt, in the last transaction");

  // The second transaction is refused after the first landed: the sale stopped partway.
  refuse = 2;
  await assert.rejects(service.submit(built.buildId, f.sign(built)), (e: unknown) =>
    apiError(422, "sale_incomplete")(e) && JSON.stringify((e as ApiError).body?.stoppedSale).includes(positions[0].toBase58()));
  refuse = 0;
  const [first, ...rest] = f.sigs();
  statuses.set(first, { err: null, confirmationStatus: "confirmed" });
  // The first transaction's records landed: those positions are sold.
  for (const [i, p] of positions.entries()) if (perTx[0].includes(p.toBase58())) await cardPosition(f, i + 1, 11 + i, { exited: true });

  // The refused one could still land until its blockhash expires: not yet.
  await assert.rejects(service.buildHoldingSale(TAKE_ID, f.wallet, "back", { bps: 2_500 }), apiError(409, "sale_pending"));
  height = 200;
  for (const s of rest) statuses.delete(s);
  // Selling again (at any amount) finishes the sale: only the records still needed, as first built.
  const finish = await service.buildHoldingSale(TAKE_ID, f.wallet, "back", { bps: 2_500 });
  assert.equal("finishing" in finish && finish.finishing, true);
  assert.equal(finish.bps, 10_000, "it answers the sale it finishes");
  const finished = finish.transactions.flatMap((b64) => exitsIn(b64, positions)).sort();
  assert.deepEqual(finished, positions.map(String).filter((p) => !perTx[0].includes(p)).sort());
  await service.submit(finish.buildId, f.sign(finish));
  // Finished: the next sale is a new one.
  const again = await service.buildHoldingSale(TAKE_ID, f.wallet, "back", { bps: 10_000 });
  assert.ok(!("finishing" in again));
});

test("a stopped sale whose records all landed after all is over: selling again says so", async (t) => {
  const statuses = new Map<string, Status>();
  let refuse = false;
  const f = await tradeFixture(t, {
    status: (sig) => statuses.get(sig) ?? null,
    height: () => 200,
    send: async (tx) => {
      if (refuse && f.sent.length > 1) throw new Error("Transaction simulation failed");
      return base58(tx.signatures[0]);
    },
  });
  const positions: PublicKey[] = [];
  for (let i = 1; i <= 14; i++) positions.push(await cardPosition(f, i, 10 + i));
  const service = new ForkService(f.options);
  const built = await service.buildHoldingSale(TAKE_ID, f.wallet, "back", { bps: 10_000 });
  refuse = true;
  await assert.rejects(service.submit(built.buildId, f.sign(built)), apiError(422, "sale_incomplete"));
  statuses.set(f.sigs()[0], { err: null, confirmationStatus: "confirmed" });
  for (const [i] of positions.entries()) await cardPosition(f, i + 1, 10 + i + 1, { exited: true });
  // Every position is sold: the holding route has nothing left; selling one of them says it's done.
  await assert.rejects(service.buildExit(TAKE_ID, positions[0].toBase58(), f.wallet), apiError(409, "sale_complete"));
  await assert.rejects(service.buildExit(TAKE_ID, positions[0].toBase58(), f.wallet), apiError(409, "already_exited"));
});
