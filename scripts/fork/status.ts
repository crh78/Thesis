// pnpm fork:status — what's running on the fork: RPC, program, config, fee vaults.
import { existsSync, readFileSync } from "node:fs";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  THESIS_PROGRAM_ID,
  USDC_DECIMALS,
  configAddress,
  creatorVaultAddress,
  feeVaultAddress,
  fetchConfig,
  thesisProgram,
} from "@thesis/chain";
import {
  PATHS,
  RPC_URL,
  WS_URL,
  connection,
  deployedElf,
  loadKeypair,
  main,
  programDataAddress,
  surfpoolVersion,
  upgradeAuthority,
} from "./lib.ts";

const usdc = (base: bigint | string | number) => (Number(base) / 10 ** USDC_DECIMALS).toLocaleString("en-US", { maximumFractionDigits: 6 });

export async function printStatus(): Promise<void> {
  const version = await surfpoolVersion();
  console.log(`RPC        ${RPC_URL}`);
  console.log(`WebSocket  ${WS_URL}`);
  if (!version) {
    console.log("Surfpool   not running (start it with `pnpm fork:up`)");
    return;
  }
  const conn = connection();
  const slot = await conn.getSlot();
  const pid = existsSync(PATHS.pid) ? readFileSync(PATHS.pid, "utf8").trim() : null;
  console.log(`Surfpool   ${version}, slot ${slot}${pid ? `, started by fork:up (pid ${pid})` : ", started elsewhere"}`);

  const elf = await deployedElf();
  console.log(`\nProgram    ${THESIS_PROGRAM_ID.toBase58()}`);
  if (!elf) {
    console.log("Deployed   no (run `pnpm fork:up`)");
    return;
  }
  const authority = await upgradeAuthority();
  console.log(`Deployed   yes (${elf.length.toLocaleString()} bytes in ${programDataAddress().toBase58()})`);
  console.log(`Authority  ${authority?.toBase58() ?? "none"}`);

  const program = thesisProgram(conn);
  const configInfo = await conn.getAccountInfo(configAddress());
  if (!configInfo) {
    console.log("\nConfig     not initialized (run `pnpm fork:up`)");
    return;
  }
  const config = await fetchConfig(program);
  const p = config.params;
  console.log(`\nConfig     ${configAddress().toBase58()}`);
  console.log(`  admin              ${config.admin.toBase58()}${tag(config.admin.toBase58(), PATHS.admin)}`);
  console.log(`  settler            ${config.settler.toBase58()}${tag(config.settler.toBase58(), PATHS.settler)}`);
  console.log(`  usdcMint           ${config.usdcMint.toBase58()}`);
  console.log(`  feeBps             ${p.feeBps}`);
  console.log(`  creatorFeeBps      ${p.creatorFeeBps}`);
  console.log(`  minStake           ${usdc(p.minStake.toString())} USDC`);
  console.log(`  maxLegs            ${p.maxLegs}`);
  console.log(`  minHorizonSecs     ${p.minHorizonSecs.toString()}`);
  console.log(`  maxHorizonSecs     ${p.maxHorizonSecs.toString()}`);
  console.log(`  maxPriceDelaySecs  ${p.maxPriceDelaySecs.toString()}`);
  console.log(`  creatorBoostBps    ${p.creatorBoostBps}`);
  console.log(`  paused             ${p.paused}`);
  console.log(`  badgeUriBase       ${config.badgeUriBase}`);

  console.log("\nFee vaults");
  for (const [name, address] of [
    ["fee vault", feeVaultAddress()],
    ["creator vault", creatorVaultAddress()],
  ] as const) {
    const bal = await conn.getTokenAccountBalance(address).catch(() => null);
    console.log(`  ${name.padEnd(14)} ${address.toBase58()}  ${bal ? `${usdc(bal.value.amount)} USDC` : "missing"}`);
  }

  if (existsSync(PATHS.admin)) {
    const admin = loadKeypair(PATHS.admin).publicKey;
    console.log(`\nAdmin SOL  ${((await conn.getBalance(admin)) / LAMPORTS_PER_SOL).toFixed(3)}`);
  }
}

function tag(address: string, path: string): string {
  if (!existsSync(path)) return "";
  return loadKeypair(path).publicKey.toBase58() === address ? `  (${path.replace(/^.*\/\.data\//, ".data/")})` : "  (not this machine's key)";
}

if (import.meta.main) await main(printStatus);
