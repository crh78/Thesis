// Real trades on the fork for the e2e scripts: each stock leg through the asset bank's best
// issuer and Jupiter, each yield leg into Jupiter Lend, then the Thesis receipt composed with its
// proof-of-trade checks (begin_trade first, the receipt last).
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { composeTransactions, thesisProgram } from "@thesis/chain";
import { bestIssuer, type BankState } from "@thesis/venues/bank";
import { jupiterBuy, jupiterLendDeposit, splitStake, type VenueLeg } from "@thesis/venues/jupiter";
import { FORK_DEXES, connection, refreshMarkets } from "./lib.ts";

export type BasketLeg = { key: string; weightBps: number; kind: "spot" | "yield" };

/** A bought leg: its venue instructions, the token it delivers, and the take leg it fills. */
export type Bought = VenueLeg & { mint: string; minOut: bigint; output: { leg: number; account: PublicKey } };
/** Anything the composer packs as one leg; `output` is absent for legs that leave no token (fades). */
export type TradeLeg = VenueLeg & { output?: { leg: number; account?: PublicKey } };

/**
 * Buys `basket` legs (all, or the indexes in `only`) for `stake` USDC base units, split by weight.
 * `buyAs` swaps a leg into a different underlying's token (an attack the settler must catch).
 */
export async function buyBasket(
  state: BankState,
  basket: BasketLeg[],
  user: PublicKey,
  payer: PublicKey,
  stake: bigint,
  apiKey: string | null,
  o: { only?: number[]; buyAs?: Record<number, string> } = {},
): Promise<Bought[]> {
  const legs = [...basket.entries()].filter(([i]) => !o.only || o.only.includes(i));
  const parts = splitStake(stake, legs.map(([, l]) => l.weightBps));
  const out: Bought[] = [];
  for (const [j, [i, leg]] of legs.entries()) {
    const usd = Number(parts[j]) / 1e6;
    if (leg.kind === "yield") {
      if (!apiKey) throw new Error("JUPITER_API_KEY is needed (Jupiter Lend has no keyless endpoint)");
      const dep = await jupiterLendDeposit({ user, payer, amount: parts[j], label: `jlUSDC $${usd}`, apiKey });
      console.log(`  ${leg.key}: Jupiter Lend USDC, $${usd}`);
      out.push({ ...dep, mint: dep.shareMint, minOut: 1n, output: { leg: i, account: dep.outputAccount! } });
      continue;
    }
    const key = o.buyAs?.[i] ?? leg.key;
    const best = await bestIssuer(key, usd, { state, maxAccounts: 30, dexes: FORK_DEXES });
    if (!best.winner) throw new Error(`no issuer to buy for ${key}: ${best.skipped.map((s) => `${s.symbol} ${s.reason}`).join("; ")}`);
    const buy = await jupiterBuy({ quote: best.winner.quote, user, payer, label: `${best.winner.symbol} $${usd}`, apiKey });
    if (!buy.outputAccount) throw new Error(`${best.winner.symbol}: the route doesn't deliver to the user's token account`);
    console.log(`  ${leg.key}${key !== leg.key ? ` (bought as ${key})` : ""}: ${best.winner.symbol} (${best.winner.issuer}), $${usd}, min out ${buy.minOutAmount}`);
    out.push({ ...buy, minOut: buy.minOutAmount, output: { leg: i, account: buy.outputAccount } });
  }
  return out;
}

/** Composes the buys and the receipt with proof of trade, signs with `payer` and `user`, and sends in order. */
export async function sendTrade(
  name: string,
  user: Keypair,
  payer: Keypair,
  buys: TradeLeg[],
  receipt: TransactionInstruction,
  receiptCu: number,
  lookupTable: PublicKey,
  position: PublicKey,
): Promise<string[]> {
  const conn = connection();
  const refreshed = await refreshMarkets(buys.flatMap((b) => b.marketAccounts));
  console.log(`${name}: refreshed ${refreshed.reset} market accounts from mainnet (${refreshed.skipped} skipped)`);
  const txs = await composeTransactions({
    payer: payer.publicKey,
    legs: buys,
    receipt,
    receiptCu,
    lookupTables: [lookupTable],
    connection: conn,
    proof: { program: thesisProgram(conn), owner: user.publicKey, position },
  });
  console.log(`${name}: ${txs.length} transaction(s)`);
  const sigs: string[] = [];
  for (const t of txs) {
    t.tx.sign(payer.publicKey.equals(user.publicKey) ? [user] : [payer, user]);
    const sig = await conn.sendTransaction(t.tx, { skipPreflight: false });
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`${name} failed: ${JSON.stringify(res.value.err)}`);
    const meta = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    console.log(`  ${t.labels.join(" + ")}: ${t.bytes} bytes, limit ${t.computeUnits} (${t.computeFrom}), used ${meta?.meta?.computeUnitsConsumed} -> ${sig}`);
    sigs.push(sig);
  }
  return sigs;
}
