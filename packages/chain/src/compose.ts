// Packs a trade into as few v0 transactions as fit: each venue leg's instructions (Jupiter
// swaps, Phoenix orders, ...) in order, with the Thesis receipt last. Legs are never split
// across transactions, and the receipt always rides with the last leg, so when everything fits
// in one transaction (the Blink case, up to 3 swaps) it is atomic. Larger baskets become a
// short sequence the user approves at once; on mainnet those can go out as a Jito bundle.
//
// With `proof` (every create_take, back and fade), each transaction is a proof-of-trade bracket:
// `begin_trade` (the first) or `trade_step` opening (later ones) right after the compute budget,
// then the legs, then `trade_step` closing or, in the last, the receipt. Each bracket names the
// output accounts of the legs in its own transaction.
//
// With `proof.continued` (a split trade's retry: an earlier transaction landed and left its
// ticket open), every transaction opens with `trade_step`, the first included, so the brackets
// that already landed still count towards the receipt.
import {
  AddressLookupTableAccount,
  type AccountMeta,
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type MessageV0,
  TransactionInstruction,
} from "@solana/web3.js";

import { THESIS_COMPUTE_UNITS } from "./constants.ts";
import { beginTradeIx, tradeOutputs, tradeStepIx } from "./instructions.ts";
import type { ThesisProgram } from "./program.ts";

export const MAX_TX_BYTES = 1_232;
export const MAX_TX_CU = 1_400_000;

export type ComposeLeg = {
  label: string;
  instructions: TransactionInstruction[];
  lookupTables: PublicKey[];
  /**
   * For proof of trade: the take leg this buys, and the owner's token account it fills (a spot
   * token, jlUSDC). Legs that leave no token with the owner (perps, fades) have no `account`.
   */
  output?: { leg: number; account?: PublicKey };
};

/** Proof of trade for a create_take, back or fade (see the header). */
export type ProofOfTrade = {
  program: ThesisProgram;
  owner: PublicKey;
  /** The position the receipt opens (for a take, the author's buy-in position). */
  position: PublicKey;
  /** Pays the ticket's rent and gets it back: must be the receipt's payer. Defaults to `payer`. */
  ticketPayer?: PublicKey;
  usdcMint?: PublicKey;
  /** The ticket exists already (an earlier part of this trade landed): no `begin_trade`. */
  continued?: boolean;
};

export type ComposedTx = {
  tx: VersionedTransaction;
  labels: string[];
  /** The legs in this transaction, as indices into `legs`. */
  legs: number[];
  bytes: number;
  computeUnits: number;
  /** "simulated" when the limit came from a simulation, "estimated" otherwise. */
  computeFrom: "simulated" | "estimated";
};

export type ComposeOpts = {
  payer: PublicKey;
  legs: ComposeLeg[];
  /** The Thesis instruction (create_take, back or fade). */
  receipt: TransactionInstruction;
  /** Extra lookup tables, e.g. the Thesis table with config, vaults, USDC and token programs. */
  lookupTables?: PublicKey[];
  /** Used to load lookup tables, fetch a blockhash and simulate for compute limits. */
  connection: Connection;
  /** Compute per leg when simulation fails. Generous: some AMM routes use 250k+ per swap. */
  estimateLegCu?: number;
  receiptCu: number;
  /** Priority fee in micro-lamports per compute unit; 0 leaves it out. */
  microLamports?: number;
  /** Wraps each transaction in proof-of-trade checks. Leave out for exits, which need none. */
  proof?: ProofOfTrade;
};

function compactLen(n: number): number {
  return n < 0x80 ? 1 : n < 0x4000 ? 2 : 3;
}

/** Exact wire size of a v0 transaction, without web3.js's 1,232-byte cap (it throws instead). */
export function v0Size(msg: MessageV0): number {
  const sigs = msg.header.numRequiredSignatures;
  let n = compactLen(sigs) + 64 * sigs + 1 + 3;
  n += compactLen(msg.staticAccountKeys.length) + 32 * msg.staticAccountKeys.length + 32;
  n += compactLen(msg.compiledInstructions.length);
  for (const ix of msg.compiledInstructions) {
    n += 1 + compactLen(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length + compactLen(ix.data.length) + ix.data.length;
  }
  n += compactLen(msg.addressTableLookups.length);
  for (const l of msg.addressTableLookups) {
    n += 32 + compactLen(l.writableIndexes.length) + l.writableIndexes.length + compactLen(l.readonlyIndexes.length) + l.readonlyIndexes.length;
  }
  return n;
}

const budget = (units: number, microLamports: number) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ...(microLamports > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports })] : []),
];

export async function loadLookupTables(conn: Connection, keys: PublicKey[]): Promise<Map<string, AddressLookupTableAccount>> {
  const out = new Map<string, AddressLookupTableAccount>();
  const unique = [...new Map(keys.map((k) => [k.toBase58(), k])).values()];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk, "confirmed");
    infos.forEach((info, j) => {
      if (!info) throw new Error(`lookup table ${chunk[j].toBase58()} not found`);
      out.set(chunk[j].toBase58(), new AddressLookupTableAccount({ key: chunk[j], state: AddressLookupTableAccount.deserialize(info.data) }));
    });
  }
  return out;
}

/** The output accounts of a group of legs, as a bracket names them. */
function outputsOf(legs: ComposeLeg[]) {
  const map = new Map<number, PublicKey>();
  for (const l of legs) if (l.output?.account) map.set(l.output.leg, l.output.account);
  return tradeOutputs(map);
}

export async function composeTransactions(o: ComposeOpts): Promise<ComposedTx[]> {
  const micro = o.microLamports ?? 0;
  const legCu = o.estimateLegCu ?? 400_000;
  const alts = await loadLookupTables(o.connection, [...(o.lookupTables ?? []), ...o.legs.flatMap((l) => l.lookupTables)]);
  const tablesFor = (legs: ComposeLeg[]) =>
    [...new Set([...(o.lookupTables ?? []), ...legs.flatMap((l) => l.lookupTables)].map(String))].map((k) => alts.get(k)!);

  // Proof-of-trade brackets around a group of legs: what goes before and after them.
  const proof = o.proof;
  const bracketCache = new Map<string, Promise<{ open: TransactionInstruction[]; close: TransactionInstruction[] }>>();
  const bracket = (legs: ComposeLeg[], first: boolean, withReceipt: boolean) => {
    const outs = outputsOf(legs);
    const key = `${first}:${withReceipt}:${outs.outputsMask}:${outs.outputs.map(String).join(",")}`;
    if (!bracketCache.has(key)) {
      bracketCache.set(key, (async () => {
        const receipt = withReceipt ? [withOutputs(o.receipt, outs.outputs)] : [];
        if (!proof) return { open: [], close: receipt };
        const p = { owner: proof.owner, position: proof.position, usdcMint: proof.usdcMint, ...outs };
        const open = first && !proof.continued
          ? await beginTradeIx(proof.program, { ...p, payer: proof.ticketPayer ?? o.payer })
          : await tradeStepIx(proof.program, { ...p, open: true });
        const close = withReceipt ? receipt : [await tradeStepIx(proof.program, { ...p, open: false })];
        return { open: [open], close };
      })());
    }
    return bracketCache.get(key)!;
  };
  const bracketCu = (first: boolean, withReceipt: boolean) =>
    proof ? (first && !proof.continued ? THESIS_COMPUTE_UNITS.beginTrade : THESIS_COMPUTE_UNITS.tradeStep) + (withReceipt ? 0 : THESIS_COMPUTE_UNITS.tradeStep) : 0;
  const estimateCu = (legs: ComposeLeg[], first: boolean, withReceipt: boolean) =>
    Math.min(MAX_TX_CU, legs.length * legCu + (withReceipt ? o.receiptCu : 0) + bracketCu(first, withReceipt));

  const compile = async (legs: ComposeLeg[], first: boolean, withReceipt: boolean, units: number, blockhash: string) => {
    const { open, close } = await bracket(legs, first, withReceipt);
    const ixs = [...budget(units, micro), ...open, ...legs.flatMap((l) => l.instructions), ...close];
    return new TransactionMessage({ payerKey: o.payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tablesFor(legs));
  };
  const placeholder = PublicKey.default.toBase58();
  const fits = async (legs: ComposeLeg[], first: boolean, withReceipt: boolean) =>
    v0Size(await compile(legs, first, withReceipt, estimateCu(legs, first, withReceipt), placeholder)) <= MAX_TX_BYTES;

  // Greedy, in order. The receipt shares a transaction with the last leg when they fit together;
  // otherwise (a big receipt such as create_take with several legs, next to a big swap) it goes
  // last on its own. A sequence of transactions isn't atomic either way.
  const groups: ComposeLeg[][] = [];
  let cur: ComposeLeg[] = [];
  const isFirst = () => groups.length === 0;
  for (const leg of o.legs) {
    if (!(await fits([leg], false, false)) && !(await fits([leg], true, false))) {
      throw new Error(`leg ${leg.label} doesn't fit in a transaction on its own`);
    }
    if (cur.length && !(await fits([...cur, leg], isFirst(), false))) {
      groups.push(cur);
      cur = [];
    }
    cur.push(leg);
  }
  if (cur.length && !(await fits(cur, isFirst(), true))) {
    // Move legs off the end until the receipt fits with what's left.
    const moved: ComposeLeg[] = [];
    while (cur.length && !(await fits(cur, isFirst(), true))) moved.unshift(cur.pop()!);
    if (cur.length) groups.push(cur);
    cur = moved;
    if (!(await fits(cur, isFirst(), true)) && cur.length > 1) {
      groups.push(cur.slice(0, -1));
      cur = cur.slice(-1);
    }
    if (!(await fits(cur, isFirst(), true))) {
      if (!(await fits([], false, true))) throw new Error("the receipt doesn't fit in a transaction on its own");
      groups.push(cur);
      cur = [];
    }
  }
  groups.push(cur);

  const { blockhash } = await o.connection.getLatestBlockhash("confirmed");
  // Simulations run all at once against current state. Without proof of trade every transaction
  // stands alone (legs spend separate USDC and the receipt only moves the fee). With it, a later
  // transaction needs the ticket an earlier one creates, so its simulation fails and its limit
  // falls back to the estimate. A continued trade's first transaction simulates fine: the
  // ticket it steps on is there.
  const indexOf = new Map(o.legs.map((l, i) => [l, i]));
  return Promise.all(groups.map(async (legs, i): Promise<ComposedTx> => {
    const first = i === 0;
    const withReceipt = i === groups.length - 1;
    let units = estimateCu(legs, first, withReceipt);
    let computeFrom: ComposedTx["computeFrom"] = "estimated";
    const sim = first || !proof
      ? await o.connection
        .simulateTransaction(new VersionedTransaction(await compile(legs, first, withReceipt, MAX_TX_CU, blockhash)), {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed",
        })
        .catch(() => null) // an RPC hiccup: fall back to the estimate
      : null;
    if (sim && !sim.value.err && sim.value.unitsConsumed) {
      units = Math.min(MAX_TX_CU, Math.ceil(sim.value.unitsConsumed * 1.15) + 5_000);
      computeFrom = "simulated";
    }
    const msg = await compile(legs, first, withReceipt, units, blockhash);
    return {
      tx: new VersionedTransaction(msg),
      labels: [...legs.map((l) => l.label), ...(withReceipt ? ["thesis receipt"] : [])],
      legs: legs.map((l) => indexOf.get(l)!),
      bytes: v0Size(msg),
      computeUnits: units,
      computeFrom,
    };
  }));
}

/** The receipt with the last bracket's output accounts appended (its remaining accounts). */
function withOutputs(receipt: TransactionInstruction, outputs: PublicKey[]): TransactionInstruction {
  if (!outputs.length) return receipt;
  const extra: AccountMeta[] = outputs.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
  return new TransactionInstruction({ programId: receipt.programId, keys: [...receipt.keys, ...extra], data: receipt.data });
}
