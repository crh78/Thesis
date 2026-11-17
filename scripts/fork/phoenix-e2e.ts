// pnpm fork:phoenix-e2e — Phoenix perps on the fork through @thesis/venues/phoenix, with no
// Thesis program involved (the receipts come in the fork API's e2e).
//
// A throwaway wallet with fake USDC and no SOL (a payer pays everything, like the app's):
//   1. registers its parent trader account, co-signed by the fork's onboarder (phoenix.ts);
//   2. registers two children and, in each, deposits collateral and opens a 2x position: a long
//      (a back's perp leg) and a short (a fade's), checking the size the program counts for proof;
//   3. closes both, sweeps each child's exact collateral back to USDC, and checks what came back.
// Prices: the fork re-copies each market's book, makers and marks from mainnet before an order.
//
// Flags: --symbols SOL,NVDA (long, short), --usd 20 (per leg).
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { setTimeout as sleep } from "node:timers/promises";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { USDC_MINT_MAINNET } from "@thesis/chain";
import { decodeTrader, PhoenixVenue, positionSize, traderAddress } from "@thesis/venues/phoenix";
import { addSol, addUsdc, connection, main, parseArgs, refreshMarkets, requireSurfpool, RPC_URL } from "./lib.ts";
import { ensureForkOnboarder } from "./phoenix.ts";

async function send(label: string, ixs: TransactionInstruction[], payer: Keypair, signers: Keypair[]): Promise<string> {
  const conn = connection();
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  // Only the keys this transaction needs (a child's registration needs no owner signature).
  const needed = new Set(msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).map(String));
  tx.sign([payer, ...signers.filter((k) => needed.has(k.publicKey.toBase58()))]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
  if (sim.value.err) throw new Error(`${label}: ${JSON.stringify(sim.value.err)}\n  ${(sim.value.logs ?? []).slice(-8).join("\n  ")}`);
  const sig = await conn.sendTransaction(tx, { skipPreflight: true });
  for (let i = 0; ; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
    if (i > 120) throw new Error(`${label}: not confirmed after a minute`);
    await sleep(500);
  }
  console.log(`  ✓ ${label}  ${tx.serialize().length} B, ${sim.value.unitsConsumed} CU`);
  return sig;
}

async function usdc(owner: PublicKey): Promise<number> {
  const ata = getAssociatedTokenAddressSync(USDC_MINT_MAINNET, owner);
  return Number((await connection().getTokenAccountBalance(ata, "confirmed")).value.amount) / 1e6;
}

async function child(owner: PublicKey, sub: number) {
  const info = await connection().getAccountInfo(traderAddress(owner, sub), "confirmed");
  return info ? decodeTrader(info.data) : null;
}

async function run(): Promise<void> {
  await requireSurfpool();
  const { flags } = parseArgs();
  const [longSym, shortSym] = String(flags.symbols ?? "SOL,NVDA").split(",");
  const usd = Number(flags.usd ?? 20);
  const venue = new PhoenixVenue({ rpcUrl: RPC_URL });
  const { onboarder, permission, written } = await ensureForkOnboarder();
  console.log(`Fork onboarder ${onboarder.publicKey.toBase58()}${written ? " (permission written)" : ""}`);

  const payer = Keypair.generate();
  const owner = Keypair.generate();
  await addSol(payer.publicKey, 2);
  await addUsdc(owner.publicKey, 100);
  const start = await usdc(owner.publicKey);
  const payerStart = await connection().getBalance(payer.publicKey);

  console.log("\n1. Register");
  const reg = await venue.registration({ owner: owner.publicKey, payer: payer.publicKey, fork: { onboarder: onboarder.publicKey, permission } });
  await send("register + onboard parent", reg.instructions, payer, [onboarder]);

  const legs = [
    { sub: 1, symbol: longSym, side: "long" as const },
    { sub: 2, symbol: shortSym, side: "short" as const },
  ];
  const checks: [string, boolean][] = [];
  console.log("\n2. Open (2x)");
  for (const l of legs) {
    await send(`register child ${l.sub}`, await venue.childRegistration({ owner: owner.publicKey, payer: payer.publicKey, sub: l.sub }), payer, [owner]);
    const m = await venue.market(l.symbol);
    await refreshMarkets(venue.marketAccounts(m));
    const price = await venue.mid(l.symbol);
    if (!price) throw new Error(`${l.symbol} has no mid on Phoenix right now`);
    const venueLegs = await venue.openLeg({ owner: owner.publicKey, payer: payer.publicKey, sub: l.sub, symbol: l.symbol, side: l.side, collateral: BigInt(usd * 1e6), leverage: 2, price, label: l.symbol });
    for (const v of venueLegs) await send(v.label, v.instructions, payer, [owner]);
    const t = (await child(owner.publicKey, l.sub))!;
    const p = t.positions[0];
    const entry = p ? -Number(p.virtualQuoteLots) / 1e6 / (Number(p.baseLots) / 10 ** m.baseLotsDecimals) : NaN;
    console.log(`    ${l.symbol} ${l.side}: ${p?.baseLots} lots at $${entry.toFixed(3)} (mainnet mid $${price}), collateral $${(Number(t.collateral) / 1e6).toFixed(4)}`);
    checks.push([`${l.symbol} ${l.side} opened in child ${l.sub}`, Boolean(p) && (l.side === "long" ? p.baseLots > 0n : p.baseLots < 0n)]);
    checks.push([`${l.symbol} size the program counts for proof of trade > 0`, positionSize(t) > 0n]);
    checks.push([`${l.symbol} fill within 1% of mainnet's mid`, Math.abs(entry / price - 1) < 0.01]);
    checks.push([`${l.symbol} notional about 2x the collateral`, Math.abs((Math.abs(Number(p.baseLots)) / 10 ** m.baseLotsDecimals) * price / (2 * usd) - 1) < 0.02]);
  }

  console.log("\n3. Close and sweep");
  for (const l of legs) {
    const m = await venue.market(l.symbol);
    await refreshMarkets(venue.marketAccounts(m));
    const t = (await child(owner.publicKey, l.sub))!;
    const close = await venue.closeLeg({ owner: owner.publicKey, sub: l.sub, symbol: l.symbol, baseLots: t.positions[0].baseLots, price: (await venue.mid(l.symbol))!, label: l.symbol });
    await send(close.label, close.instructions, payer, [owner]);
    const after = (await child(owner.publicKey, l.sub))!;
    checks.push([`${l.symbol} position closed`, after.positions.length === 0]);
    const sweep = await venue.sweepLeg({ owner: owner.publicKey, payer: payer.publicKey, sub: l.sub, collateral: after.collateral, label: l.symbol });
    await send(sweep.label, sweep.instructions, payer, [owner]);
    checks.push([`${l.symbol} child empty after the sweep`, (await child(owner.publicKey, l.sub))!.collateral === 0n]);
  }
  const end = await usdc(owner.publicKey);
  const lost = start - end;
  console.log(`\nUSDC ${start} → ${end} (round trip cost $${lost.toFixed(4)} on $${4 * usd} of notional)`);
  console.log(`payer spent ${((payerStart - (await connection().getBalance(payer.publicKey))) / 1e9).toFixed(4)} SOL (rent and fees); the wallet holds ${await connection().getBalance(owner.publicKey)} lamports`);
  checks.push(["the round trip cost under 0.5% of notional", lost >= 0 && lost < 0.005 * 4 * usd]);
  checks.push(["the wallet never needed SOL", (await connection().getBalance(owner.publicKey)) === 0]);

  console.log("");
  for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("fork:phoenix-e2e failed");
}

if (import.meta.main) await main(run);
