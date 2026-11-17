// pnpm fork:fund <wallet> [--usdc N] [--sol N]
//
// Adds fake SOL and mainnet USDC to any wallet on the fork (default 10 SOL, 1,000 USDC), using
// Surfpool cheatcodes. The USDC lands in the wallet's associated token account, created if needed.
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { USDC_DECIMALS } from "@thesis/chain";
import { addSol, addUsdc, main, numberFlag, parseArgs, requireSurfpool } from "./lib.ts";

async function fund(): Promise<void> {
  const { positional, flags } = parseArgs();
  if (positional.length !== 1) {
    throw new Error("Usage: pnpm fork:fund <wallet> [--usdc N] [--sol N]");
  }
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(positional[0]);
  } catch {
    throw new Error(`Not a Solana address: ${positional[0]}`);
  }
  const sol = numberFlag(flags, "sol", 10);
  const usdc = numberFlag(flags, "usdc", 1_000);
  await requireSurfpool();

  if (sol > 0) {
    const lamports = await addSol(wallet, sol);
    console.log(`+${sol} SOL   → ${(lamports / LAMPORTS_PER_SOL).toLocaleString()} SOL`);
  }
  if (usdc > 0) {
    const amount = await addUsdc(wallet, usdc);
    console.log(`+${usdc} USDC → ${(Number(amount) / 10 ** USDC_DECIMALS).toLocaleString()} USDC`);
  }
  console.log(`Funded ${wallet.toBase58()}`);
}

if (import.meta.main) await main(fund);
