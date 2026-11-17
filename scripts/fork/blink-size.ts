// pnpm fork:blink-size [take-id ...] — measures the Blink's one-signature back against the
// 1,232-byte limit, with the proof-of-trade instructions (begin_trade, the ticket, the output
// accounts), on real Jupiter routes.
//
// For each demo take (default: the seeded ones) it makes sure the take is on the fork, builds the
// Blink back the Actions endpoint would (`buildBlinkBack`), and prints the legs it bought, the
// legs it handed to the app and the transaction's size. When a 3-leg build doesn't fit, the
// service drops the lightest leg and builds again, so the size is always within the limit. The
// last build is signed with a fork-only wallet and sent, to show it lands.
//
// `--combos=N` also sizes N three-stock baskets (sliding windows over liquid names), each composed
// the way the Blink is (the buyer pays, one transaction, with proof of trade), to see how often
// three legs fit on today's routes.
import BN from "bn.js";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { MAX_TX_BYTES, THESIS_COMPUTE_UNITS, backIx, composeTransactions, positionAddress, thesisProgram } from "@thesis/chain";
import { loadBankState } from "@thesis/venues/bank";
import { envVar } from "../../packages/venues/registry/src/lib/env.ts";
import { startForkService } from "./api.ts";
import { addSol, addUsdc, connection, main, numberFlag, parseArgs, refreshMarkets, syncClock, thesisLookupTable } from "./lib.ts";
import { buyBasket, type BasketLeg } from "./trade.ts";

const NAMES = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "AMD", "COIN", "MSTR", "NFLX", "PLTR"].map((c) => `equity:US:${c}`).concat(["etf:US:SPY", "etf:US:QQQ"]);

const DEMO_TAKES = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-${String(101 + i).padStart(12, "0")}`);

async function measure(): Promise<void> {
  const lead = await syncClock();
  if (lead > 120) throw new Error(`The fork's clock is ${lead}s ahead of real time: restart the fork.`);
  const { positional: takes, flags } = parseArgs();
  const service = await startForkService(() => {});
  const conn = connection();
  const wallet = Keypair.generate();
  await addSol(wallet.publicKey, 1);
  await service.deposit(wallet.publicKey.toBase58(), 500);
  const rows: { take: string; legs: number; bytes: number; excluded: string[] }[] = [];
  let last: string | null = null;
  for (const takeId of takes.length ? takes : DEMO_TAKES) {
    try {
      // The Blink backs only takes already on-chain; an app back mirrors a demo take first.
      if (!(await service.blinkTake(takeId)).canBack) await service.buildTrade(takeId, wallet.publicKey.toBase58(), "back", 10);
      const built = await service.buildBlinkBack(takeId, wallet.publicKey.toBase58(), 15);
      const bytes = Buffer.from(built.transaction, "base64").length;
      rows.push({ take: takeId, legs: built.included.length, bytes, excluded: built.excluded.map((x: { name: string; reason: string }) => `${x.name}: ${x.reason}`) });
      last = built.transaction;
    } catch (e) {
      console.log(`${takeId}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\n${"take".padEnd(38)} legs  bytes / ${MAX_TX_BYTES}`);
  for (const r of rows) {
    console.log(`${r.take.padEnd(38)} ${String(r.legs).padStart(4)}  ${String(r.bytes).padStart(5)}`);
    for (const x of r.excluded) console.log(`${"".padEnd(44)}left out ${x}`);
  }
  if (!rows.length) throw new Error("no Blink built");
  if (rows.some((r) => r.bytes > MAX_TX_BYTES)) throw new Error("a Blink transaction is over the limit");

  if (last) {
    const tx = VersionedTransaction.deserialize(Buffer.from(last, "base64"));
    tx.message.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign([wallet]);
    const sig = await conn.sendTransaction(tx, { skipPreflight: false });
    const res = await conn.confirmTransaction(sig, "confirmed");
    if (res.value.err) throw new Error(`the last Blink failed on the fork: ${JSON.stringify(res.value.err)}`);
    console.log(`\nsent the last one: ${sig}`);
  }

  const combos = numberFlag(flags, "combos", 0);
  if (!combos) return;
  // Any open take works as the receipt's target here: only the size is measured.
  const target = rows.length ? (await service.receipt(rows[0].take, wallet.publicKey.toBase58(), { routes: false })) : null;
  if (!target?.address) throw new Error("no on-chain take to aim the receipts at");
  const state = await loadBankState();
  const program = thesisProgram(conn);
  const lookupTable = thesisLookupTable()!;
  const buyer = Keypair.generate();
  await addUsdc(buyer.publicKey, 100);
  const sizes: (number | null)[] = [];
  for (let i = 0; i < combos; i++) {
    const keys = [0, 1, 2].map((k) => NAMES[(i + k * 3) % NAMES.length]);
    const basket: BasketLeg[] = keys.map((key, k) => ({ key, weightBps: [4_000, 3_500, 2_500][k], kind: "spot" }));
    try {
      const buys = await buyBasket(state, basket, buyer.publicKey, buyer.publicKey, 15_000_000n, envVar("JUPITER_API_KEY") ?? null);
      await refreshMarkets(buys.flatMap((b) => b.marketAccounts));
      const take = new PublicKey(target.address);
      const id = BigInt(1_000 + i);
      const receipt = await backIx(program, { owner: buyer.publicKey, take, id, stake: new BN(15_000_000), legsMask: 0b111 });
      const txs = await composeTransactions({
        payer: buyer.publicKey,
        legs: buys,
        receipt,
        receiptCu: THESIS_COMPUTE_UNITS.back,
        lookupTables: [lookupTable],
        connection: conn,
        proof: { program, owner: buyer.publicKey, position: positionAddress(take, buyer.publicKey, id) },
      });
      sizes.push(txs.length === 1 ? txs[0].bytes : null);
      console.log(`${keys.join(" + ")}: ${txs.length === 1 ? `${txs[0].bytes} bytes` : `${txs.length} transactions (doesn't fit)`}`);
    } catch (e) {
      console.log(`${keys.join(" + ")}: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    }
  }
  const fit = sizes.filter((b): b is number => b !== null);
  console.log(`\n3 legs fit in one transaction in ${fit.length} of ${sizes.length} builds` + (fit.length ? ` (${Math.min(...fit)}-${Math.max(...fit)} bytes)` : ""));
}

if (import.meta.main) await main(measure);
