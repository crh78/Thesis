// pnpm fork:jupiter-e2e — real Jupiter swaps + Thesis receipts on the fork, then real prices.
//
// 1. An author posts a low-risk take (NVDA 40%, SPY 25%, TSLA 15%, USDC yield 20%) with a $30
//    buy-in: for each stock leg the asset bank picks the issuer that gives the most shares per
//    dollar and Jupiter builds the swap; the yield leg deposits into Jupiter Lend (jlUSDC). The
//    legs plus create_take go out in as few transactions as fit.
// 2. A backer backs it with $50 the same way.
// 3. The settler (real Alpaca and Jupiter prices) records entry prices for the tokens each of
//    them actually bought.
// Users hold no SOL: the fork's app fee payer pays fees and rent, as the app does for Privy users.
//
// Needs the asset bank (`pnpm --filter @thesis/executor asset-bank -- --once --tiers=discovery,prices`)
// and JUPITER_API_KEY. Swaps use real mainnet pools copied into the fork; nothing touches mainnet.
import { join } from "node:path";
import BN from "bn.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  AUTHOR_POSITION_ID,
  FADE_VIA,
  LEG_KIND,
  RISK,
  THESIS_COMPUTE_UNITS,
  USDC_MINT_MAINNET,
  backIx,
  claimHash,
  createTakeIx,
  positionAddress,
  takeAddress,
  thesisProgram,
} from "@thesis/chain";
import { AlpacaStocks, FileAuditLog, JupiterPrices, Settler, bankIndex } from "@thesis/executor/settler";
import { loadBankState, underlyingId } from "@thesis/venues/bank";
import { JL_USDC_MINT } from "@thesis/venues/jupiter";
import { envVar } from "../../packages/venues/registry/src/lib/env.ts";
import { DATA_DIR, PATHS, addUsdc, connection, deployedElf, loadKeypair, main, requireSurfpool, syncClock, thesisLookupTable } from "./lib.ts";
import { buyBasket, sendTrade, type BasketLeg, type Bought } from "./trade.ts";

const BASKET: BasketLeg[] = [
  { key: "equity:US:NVDA", weightBps: 4_000, kind: "spot" },
  { key: "etf:US:SPY", weightBps: 2_500, kind: "spot" },
  { key: "equity:US:TSLA", weightBps: 1_500, kind: "spot" },
  { key: `token:${JL_USDC_MINT}`, weightBps: 2_000, kind: "yield" },
];
const ALL_LEGS = (1 << BASKET.length) - 1;
// Every leg takes an entry price: yield too (one vault share's value).
const PRICED_LEGS = BASKET.reduce((m, _l, i) => m | (1 << i), 0);
const START_USDC = 500;
const conn = connection();
const program = thesisProgram(conn);

async function e2e(): Promise<void> {
  await requireSurfpool();
  if (!(await deployedElf())) throw new Error("Thesis isn't deployed on the fork. Run `pnpm fork:up`.");
  const lead = await syncClock();
  if (lead > 120) throw new Error(`The fork's clock is ${lead}s ahead of real time (time travel?). Oracles would look stale: restart the fork.`);
  const lookupTable = thesisLookupTable();
  if (!lookupTable) throw new Error("No Thesis lookup table on this fork. Rerun `pnpm fork:up`.");
  const appPayer = loadKeypair(PATHS.appPayer);
  const state = await loadBankState();
  const apiKey = envVar("JUPITER_API_KEY");

  const author = Keypair.generate();
  const backer = Keypair.generate();
  for (const kp of [author, backer]) await addUsdc(kp.publicKey, START_USDC);
  console.log(`author ${author.publicKey.toBase58()}\nbacker ${backer.publicKey.toBase58()}  (no SOL: the app pays)\n`);

  const id = BigInt(Date.now());
  const take = takeAddress(author.publicKey, id);
  const legs = BASKET.map((l) => ({
    kind: LEG_KIND[l.kind],
    asset: new PublicKey(underlyingId(l.key)),
    weightBps: l.weightBps,
    leverage: 1,
    fadeVia: l.kind === "spot" ? FADE_VIA.phoenixShort : FADE_VIA.none,
  }));
  const horizonEnd = new BN(Math.floor(Date.now() / 1000) + 7 * 86_400);

  // 1. The author's buy-in.
  const authorStake = 30_000_000n;
  const authorBuys = await buyBasket(state, BASKET, author.publicKey, appPayer.publicKey, authorStake, apiKey);
  const create = await createTakeIx(program, {
    author: author.publicKey,
    payer: appPayer.publicKey,
    id,
    claimHash: claimHash("AI compute keeps eating the market (fork Jupiter e2e)"),
    risk: RISK.low,
    horizonEnd,
    legs,
    stake: new BN(authorStake.toString()),
    legsMask: ALL_LEGS,
  });
  await sendTrade("create_take", author, appPayer, authorBuys, create, THESIS_COMPUTE_UNITS.createTake, lookupTable, positionAddress(take, author.publicKey, AUTHOR_POSITION_ID));

  // 2. A back.
  const backStake = 50_000_000n;
  const backerBuys = await buyBasket(state, BASKET, backer.publicKey, appPayer.publicKey, backStake, apiKey);
  const back = await backIx(program, {
    owner: backer.publicKey,
    payer: appPayer.publicKey,
    take,
    id: 1n,
    stake: new BN(backStake.toString()),
    legsMask: ALL_LEGS,
  });
  await sendTrade("back", backer, appPayer, backerBuys, back, THESIS_COMPUTE_UNITS.back, lookupTable, positionAddress(take, backer.publicKey, 1n));

  // Checks: each leg's tokens arrived, and USDC went down by the stake plus the 0.10% fee.
  const checks: [string, boolean][] = [];
  const runs: [string, Keypair, Bought[], bigint][] = [
    ["author", author, authorBuys, authorStake],
    ["backer", backer, backerBuys, backStake],
  ];
  for (const [who, kp, buys, stake] of runs) {
    for (const b of buys) {
      const got = await tokenBalance(kp.publicKey, new PublicKey(b.mint));
      checks.push([`${who} got ${b.label}: ${got} >= min ${b.minOut}`, got >= b.minOut && got > 0n]);
    }
    const spent = BigInt(START_USDC * 1e6) - (await tokenBalance(kp.publicKey, USDC_MINT_MAINNET));
    checks.push([`${who} spent ${spent} USDC base units = stake ${stake} + fee ${stake / 1000n}`, spent === stake + stake / 1000n]);
    checks.push([`${who} holds no SOL`, (await conn.getBalance(kp.publicKey)) === 0]);
  }
  const pos = await program.account.position.fetch(positionAddress(take, backer.publicKey, 1n));
  checks.push(["backer position recorded with a 50 USDC stake", pos.stake.toString() === backStake.toString()]);

  // 3. Real entry prices from the settler.
  console.log("\nsettler (real Alpaca + Jupiter prices)");
  const settler = new Settler({
    program,
    connection: conn,
    settler: loadKeypair(PATHS.settler),
    bank: bankIndex(state),
    sources: {
      stocks: new AlpacaStocks(required("ALPACA_API_KEY_ID"), required("ALPACA_API_SECRET_KEY")),
      tokens: new JupiterPrices(apiKey),
    },
    rules: { minLiquidityUsd: 100_000, liveWindowSecs: 300 },
    audit: new FileAuditLog(join(DATA_DIR, "../settler/audit.jsonl")),
    log: (m) => console.log(`  ${m}`),
  });
  // A stock leg priced off Alpaca can need a moment: the IEX feed has gaps of a few seconds.
  for (let i = 0; i < 4; i++) {
    const tick = await settler.tick();
    const legsWaiting = tick.waiting.filter((w) => w.includes(" leg "));
    for (const w of legsWaiting) console.log(`  waiting: ${w}`);
    if (!legsWaiting.length) break;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  const positions: [string, Keypair, bigint][] = [
    ["author", author, AUTHOR_POSITION_ID],
    ["backer", backer, 1n],
  ];
  for (const [who, kp, posId] of positions) {
    const p = await program.account.position.fetch(positionAddress(take, kp.publicKey, posId));
    const prices = p.prices.map((x: { entry: BN }) => (x.entry.toNumber() / 1e8).toFixed(2));
    checks.push([`${who} entry prices recorded for every leg, the yield leg's vault share too (${prices.join(", ")})`, p.entrySet === PRICED_LEGS]);
  }

  console.log("");
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("Jupiter e2e failed");
}

async function tokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  for (const tokenProgram of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      return BigInt((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, owner, true, tokenProgram))).value.amount);
    } catch {
      // not under this token program
    }
  }
  return 0n;
}

function required(k: string): string {
  const v = envVar(k);
  if (!v) throw new Error(`${k} is not set`);
  return v;
}

if (import.meta.main) await main(e2e);
