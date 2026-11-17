// pnpm fork:smoke — a create_take and a back on the fork, built with @thesis/chain.
//
// Makes two throwaway wallets (author, backer), funds them, posts a one-leg NVDA take with a
// 10 USDC buy-in, backs it with 25 USDC, and prints the decoded events. Each buys NVDA's best
// issuer token through Jupiter first: a receipt needs a real trade behind it (proof of trade).
// Needs the asset bank. Run `pnpm fork:relay` in another terminal first to see the Stream
// payloads for both trades.
import BN from "bn.js";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  AUTHOR_POSITION_ID,
  FADE_VIA,
  LEG_KIND,
  RISK,
  THESIS_COMPUTE_UNITS,
  backIx,
  claimHash,
  createTakeIx,
  feeVaultAddress,
  legsMask,
  thesisTransactionEvents,
  positionAddress,
  thesisEventToJson,
  takeAddress,
  thesisProgram,
  usdcToBaseUnits,
} from "@thesis/chain";
import { loadBankState, underlyingId } from "@thesis/venues/bank";
import { envVar } from "../../packages/venues/registry/src/lib/env.ts";
import { addSol, addUsdc, connection, deployedElf, main, requireSurfpool, thesisLookupTable } from "./lib.ts";
import { buyBasket, sendTrade, type BasketLeg } from "./trade.ts";

const BASKET: BasketLeg[] = [{ key: "equity:US:NVDA", weightBps: 10_000, kind: "spot" }];

async function smoke(): Promise<void> {
  await requireSurfpool();
  if (!(await deployedElf())) throw new Error("Thesis isn't deployed on the fork. Run `pnpm fork:up`.");
  const conn = connection();
  const program = thesisProgram(conn);
  const lookupTable = thesisLookupTable();
  if (!lookupTable) throw new Error("No Thesis lookup table on this fork. Rerun `pnpm fork:up`.");
  const state = await loadBankState();
  const apiKey = envVar("JUPITER_API_KEY") ?? null;

  const author = Keypair.generate();
  const backer = Keypair.generate();
  for (const kp of [author, backer]) {
    await addSol(kp.publicKey, 1);
    await addUsdc(kp.publicKey, 100);
  }
  console.log(`author ${author.publicKey.toBase58()}\nbacker ${backer.publicKey.toBase58()}`);

  const id = BigInt(Date.now());
  const take = takeAddress(author.publicKey, id);
  const create = await createTakeIx(program, {
    author: author.publicKey,
    id,
    claimHash: claimHash("NVDA outperforms this week (fork smoke test)"),
    risk: RISK.medium,
    horizonEnd: new BN(Math.floor(Date.now() / 1000) + 7 * 24 * 3600),
    legs: [
      {
        kind: LEG_KIND.spot,
        asset: new PublicKey(underlyingId("equity:US:NVDA")),
        weightBps: 10_000,
        leverage: 1,
        fadeVia: FADE_VIA.none,
      },
    ],
    stake: new BN(usdcToBaseUnits("10").toString()),
    legsMask: 0b1,
  });
  const authorBuys = await buyBasket(state, BASKET, author.publicKey, author.publicKey, usdcToBaseUnits("10"), apiKey);
  await send("create_take", authorBuys, create, author, THESIS_COMPUTE_UNITS.createTake, positionAddress(take, author.publicKey, AUTHOR_POSITION_ID));

  const back = await backIx(program, {
    owner: backer.publicKey,
    take,
    id: 1n,
    stake: new BN(usdcToBaseUnits("25").toString()),
    legsMask: legsMask([0]),
  });
  const backerBuys = await buyBasket(state, BASKET, backer.publicKey, backer.publicKey, usdcToBaseUnits("25"), apiKey);
  await send("back", backerBuys, back, backer, THESIS_COMPUTE_UNITS.back, positionAddress(take, backer.publicKey, 1n));

  const vault = await conn.getTokenAccountBalance(feeVaultAddress());
  console.log(`\ntake      ${take.toBase58()}`);
  console.log(`fee vault ${vault.value.uiAmountString} USDC`);

  async function send(
    name: string,
    buys: Awaited<ReturnType<typeof buyBasket>>,
    ix: TransactionInstruction,
    signer: Keypair,
    cu: number,
    position: PublicKey,
  ): Promise<void> {
    const sigs = await sendTrade(name, signer, signer, buys, ix, cu, lookupTable!, position);
    for (const sig of sigs) {
      const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const events = thesisTransactionEvents(program, tx).map(thesisEventToJson);
      console.log(`\n${name} ${sig}`);
      for (const e of events) console.log(`  ${e.name} ${JSON.stringify(e.data)}`);
    }
  }
}

if (import.meta.main) await main(smoke);
