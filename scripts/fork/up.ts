// pnpm fork:up [--so <path>] [--redeploy]
//
// 1. Starts Surfpool forking mainnet (unless something already answers on the configured port).
// 2. Writes thesis.so at the program's declare_id address with the surfnet_writeProgram
//    cheatcode. No program keypair is needed: the cheatcode writes the Program and ProgramData
//    accounts directly, the way a real deploy would leave them.
// 3. Makes fork-only admin, allowlist-admin and settler keypairs in .data/fork/ (gitignored), sets
//    the admin as the program's upgrade authority, and runs init_config with DEFAULT_CONFIG_PARAMS
//    and the real mainnet USDC mint.
// 4. Points badge metadata at Supabase Storage's public `badges` bucket (SUPABASE_URL), with
//    update_config, when the config's base differs.
// 5. Phoenix (docs/phoenix-plan.md): writes the fork's onboarding permission, adds Phoenix and
//    Ember to the trade allowlist if the config predates them, and puts Phoenix's fixed accounts
//    in the lookup table.
//
// Safe to rerun: every step is skipped when already done.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { AddressLookupTableProgram, type Connection, type Keypair, type PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { jupiterLendAccounts } from "@thesis/venues/jupiter";
import { PHOENIX_LOOKUP_ADDRESSES } from "@thesis/venues/phoenix";
import { ensureForkOnboarder } from "./phoenix.ts";
import { envVar } from "../../packages/venues/registry/src/lib/env.ts";
import {
  DEFAULT_CONFIG_PARAMS,
  THESIS_PROGRAM_ID,
  USDC_MINT_MAINNET,
  configAddress,
  createThesisLookupTableIxs,
  thesisLookupTableAddresses,
  fetchConfig,
  initConfigIx,
  supabaseBadgeUriBase,
  thesisProgram,
  updateAllowlistIx,
  updateConfigIx,
  EMBER_PROGRAM_ID,
  PHOENIX_PROGRAM_ID,
} from "@thesis/chain";
import {
  DATA_DIR,
  HOST,
  PATHS,
  RPC_PORT,
  RPC_URL,
  WS_PORT,
  addSol,
  connection,
  deployedElf,
  findProgramSo,
  loadOrCreateKeypair,
  main,
  parseArgs,
  rpc,
  surfpoolBin,
  thesisLookupTable,
  surfpoolVersion,
  upgradeAuthority,
} from "./lib.ts";
import { printStatus } from "./status.ts";

/** Bytes per surfnet_writeProgram call (hex doubles it; Surfpool's RPC limit is 5 MB). */
const CHUNK = 1024 * 1024;

async function up(): Promise<void> {
  const { flags } = parseArgs();
  mkdirSync(DATA_DIR, { recursive: true });

  await startSurfpool();

  const admin = loadOrCreateKeypair(PATHS.admin);
  const settler = loadOrCreateKeypair(PATHS.settler);
  const allowlistAdmin = loadOrCreateKeypair(PATHS.allowlistAdmin);
  const appPayer = loadOrCreateKeypair(PATHS.appPayer);
  if (admin.created) console.log(`• Created fork admin   ${admin.keypair.publicKey.toBase58()} (${PATHS.admin})`);
  if (allowlistAdmin.created) console.log(`• Created fork allowlist admin ${allowlistAdmin.keypair.publicKey.toBase58()} (${PATHS.allowlistAdmin})`);
  if (settler.created) console.log(`• Created fork settler ${settler.keypair.publicKey.toBase58()} (${PATHS.settler})`);

  const conn = connection();
  for (const kp of [admin.keypair, settler.keypair, appPayer.keypair]) {
    if ((await conn.getBalance(kp.publicKey)) < 1e9) await addSol(kp.publicKey, 10);
  }

  await deploy(findProgramSo(typeof flags.so === "string" ? flags.so : undefined), flags.redeploy === true, admin.keypair.publicKey);

  const program = thesisProgram(conn);
  if (await conn.getAccountInfo(configAddress())) {
    const config = await fetchConfig(program).catch(() => {
      throw new Error(
        "The fork's config was made by an older build of the program (its layout changed: the allowlist admin " +
          "was added). Restart the fork: `pnpm fork:down && pnpm fork:up`.",
      );
    });
    if (!config.admin.equals(admin.keypair.publicKey)) {
      console.log(
        `! Config already exists with admin ${config.admin.toBase58()}, not this machine's ${PATHS.admin}.` +
          " Restart the fork (`pnpm fork:down && pnpm fork:up`) to own it.",
      );
    } else {
      console.log("• Config already initialized");
    }
  } else {
    const ix = await initConfigIx(program, {
      admin: admin.keypair.publicKey,
      settler: settler.keypair.publicKey,
      allowlistAdmin: allowlistAdmin.keypair.publicKey,
      params: DEFAULT_CONFIG_PARAMS,
      usdcMint: USDC_MINT_MAINNET,
    });
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [admin.keypair]);
    console.log(`• init_config ${sig}`);
  }

  await pointBadges(conn, admin.keypair);

  // The Thesis lookup table: config, vaults, USDC and the token programs at one byte each.
  const existing = thesisLookupTable();
  if (existing && (await conn.getAccountInfo(existing))) {
    console.log(`• Lookup table ${existing.toBase58()}`);
    // A table made before an address joined the list (the Instructions sysvar, for proof of trade).
    const added = await extendTable(conn, admin.keypair, existing, thesisLookupTableAddresses());
    if (added) console.log(`• Lookup table: added ${added} Thesis account(s)`);
  } else {
    const { address, instructions } = createThesisLookupTableIxs({
      authority: admin.keypair.publicKey,
      payer: admin.keypair.publicKey,
      recentSlot: await conn.getSlot("finalized"),
    });
    await sendAndConfirmTransaction(conn, new Transaction().add(...instructions), [admin.keypair]);
    writeFileSync(PATHS.lookupTable, JSON.stringify({ address: address.toBase58() }));
    console.log(`• Created lookup table ${address.toBase58()}`);
  }
  await addLendAccounts(conn, admin.keypair);
  await setUpPhoenix(conn, admin.keypair, allowlistAdmin.keypair);

  console.log("\n✓ Fork ready\n");
  await printStatus();
}

/**
 * Phoenix on the fork (docs/phoenix-plan.md): the fork's onboarding permission, Phoenix and
 * Ember on the trade allowlist (a config made before they joined the defaults), and Phoenix's
 * fixed accounts in the lookup table. Safe to rerun.
 */
async function setUpPhoenix(conn: Connection, admin: Keypair, allowlistAdmin: Keypair): Promise<void> {
  const { onboarder, written } = await ensureForkOnboarder();
  console.log(`• Phoenix onboarder ${onboarder.publicKey.toBase58()}${written ? " (permission written)" : ""}`);
  const program = thesisProgram(conn);
  const config = await fetchConfig(program).catch(() => null);
  if (config && config.allowlistAdmin.equals(allowlistAdmin.publicKey)) {
    const have = config.tradePrograms.map(String);
    const missing = [PHOENIX_PROGRAM_ID, EMBER_PROGRAM_ID].filter((p) => !have.includes(p.toBase58()));
    if (missing.length) {
      const ix = await updateAllowlistIx(program, { allowlistAdmin: allowlistAdmin.publicKey, tradePrograms: [...config.tradePrograms, ...missing] });
      if ((await conn.getBalance(allowlistAdmin.publicKey)) < 1e8) await addSol(allowlistAdmin.publicKey, 1);
      await sendAndConfirmTransaction(conn, new Transaction().add(ix), [allowlistAdmin]);
      console.log(`• Trade allowlist: added ${missing.map((p) => p.toBase58().slice(0, 6)).join(", ")}`);
    }
  }
  const table = thesisLookupTable();
  if (table) {
    const added = await extendTable(conn, admin, table, PHOENIX_LOOKUP_ADDRESSES);
    if (added) console.log(`• Lookup table: added ${added} Phoenix account(s)`);
  }
}

/**
 * Puts Jupiter Lend's jlUSDC accounts in the Thesis lookup table, so yield legs (deposits on
 * low-risk backs, redeems when a position is sold) fit next to swaps. Safe to rerun.
 */
async function addLendAccounts(conn: Connection, admin: Keypair): Promise<void> {
  const table = thesisLookupTable();
  const apiKey = envVar("JUPITER_API_KEY");
  if (!table) return;
  if (!apiKey) {
    console.log("• Jupiter Lend accounts not added to the lookup table (no JUPITER_API_KEY): sales with a yield leg may not fit in one transaction");
    return;
  }
  const added = await extendTable(conn, admin, table, await jupiterLendAccounts({ apiKey }));
  console.log(`• Lookup table: ${added ? `added ${added}` : "has the"} Jupiter Lend accounts`);
}

/** Adds whichever of `addresses` the table lacks; returns how many. */
async function extendTable(conn: Connection, admin: Keypair, table: PublicKey, addresses: PublicKey[]): Promise<number> {
  const state = (await conn.getAddressLookupTable(table)).value;
  const have = new Set(state?.state.addresses.map(String) ?? []);
  const missing = addresses.filter((k) => !have.has(k.toBase58()));
  for (let i = 0; i < missing.length; i += 20) {
    const ix = AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: admin.publicKey, payer: admin.publicKey, addresses: missing.slice(i, i + 20) });
    await sendAndConfirmTransaction(conn, new Transaction().add(ix), [admin]);
  }
  return missing.length;
}

/** Badge metadata from the `badges` bucket (supabase/README.md), once SUPABASE_URL is known. */
async function pointBadges(conn: Connection, admin: Keypair): Promise<void> {
  const url = envVar("SUPABASE_URL");
  const program = thesisProgram(conn);
  const config = await fetchConfig(program);
  if (!url || !config.admin.equals(admin.publicKey)) return;
  const base = supabaseBadgeUriBase(url);
  if (config.badgeUriBase === base) return;
  const ix = await updateConfigIx(program, {
    admin: admin.publicKey,
    args: { params: config.params, newAdmin: null, newSettler: null, newBadgeUriBase: base },
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(ix), [admin]);
  console.log(`• Badge metadata from ${base}`);
}

async function startSurfpool(): Promise<void> {
  const running = await surfpoolVersion();
  if (running) {
    console.log(`• Surfpool ${running} already running at ${RPC_URL}`);
    return;
  }
  if (process.env.FORK_RPC_URL) throw new Error(`FORK_RPC_URL is set but nothing answers at ${RPC_URL}`);
  if (await portAnswers()) throw new Error(`Something that isn't Surfpool is listening on ${HOST}:${RPC_PORT}. Set FORK_RPC_PORT.`);

  const bin = surfpoolBin();
  // Surfpool reads mainnet through this RPC: public mainnet unless FORK_DATASOURCE_RPC_URL is set.
  // Not the repo's QUICKNODE_RPC_URL by default: its free plan caps getMultipleAccounts at 5
  // accounts, and Surfpool fetches a swap's pool accounts in bigger batches, so trades fail with
  // "Failed to fetch accounts". A Helius or Alchemy URL (free plans work) or a paid QuickNode one
  // is faster than public mainnet, which also rate-limits heavy fork use. From the environment or
  // the repo-root .env, so the key stays out of shell history.
  const datasource = envVar("FORK_DATASOURCE_RPC_URL") ?? undefined;
  const args = [
    "start",
    // The datasource URL (with its key) goes through SURFPOOL_DATASOURCE_RPC_URL, not argv, so `ps` doesn't show it.
    ...(datasource ? [] : ["--network", "mainnet"]),
    "--host", HOST,
    "--port", String(RPC_PORT),
    "--ws-port", String(WS_PORT),
    "--no-tui",
    "--no-deploy",
    "--airdrop-amount", "0",
    "--log-path", `${DATA_DIR}/logs`,
    ...(process.env.SURFPOOL_ARGS?.split(" ").filter(Boolean) ?? []),
  ];
  console.log(`• Starting ${bin} ${args.join(" ")}${datasource ? " (datasource: FORK_DATASOURCE_RPC_URL)" : ""}`);
  const log = openSync(PATHS.log, "a");
  // Run from .data/fork so Surfpool doesn't pick up a txtx.yml or Anchor.toml elsewhere.
  const env = { ...process.env };
  if (datasource) env.SURFPOOL_DATASOURCE_RPC_URL = datasource;
  else delete env.SURFPOOL_DATASOURCE_RPC_URL; // --network mainnet: an inherited URL would conflict with it
  const child = spawn(bin, args, { cwd: DATA_DIR, env, detached: true, stdio: ["ignore", log, log] });
  closeSync(log);
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code ?? -1));
  child.on("error", (err) => {
    console.error(`Couldn't run ${bin}: ${err.message}. Install Surfpool (see scripts/fork/README.md) or set SURFPOOL_BIN.`);
    exited = -1;
  });
  child.unref();

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (exited !== null) throw new Error(`Surfpool exited (${exited}). See ${PATHS.log}`);
    const version = await surfpoolVersion();
    if (version) {
      writeFileSync(PATHS.pid, String(child.pid));
      console.log(`• Surfpool ${version} up at ${RPC_URL} (pid ${child.pid}, log ${PATHS.log})`);
      return;
    }
  }
  throw new Error(`Surfpool didn't answer within 60s. See ${PATHS.log}`);
}

async function portAnswers(): Promise<boolean> {
  try {
    await fetch(`http://${HOST}:${RPC_PORT}`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function deploy(soPath: string, force: boolean, authority: PublicKey): Promise<void> {
  const so = readFileSync(soPath);
  const current = await deployedElf();
  if (current && !force && sameElf(current, so)) {
    console.log(`• Program already deployed (same build as ${soPath})`);
  } else {
    console.log(`• Writing ${soPath} (${so.length.toLocaleString()} bytes) to ${THESIS_PROGRAM_ID.toBase58()}`);
    if (current && current.length > so.length) {
      // A smaller build would leave the old build's tail behind it. Zero it out.
      await rpc("surfnet_writeProgram", [THESIS_PROGRAM_ID.toBase58(), Buffer.alloc(current.length - so.length).toString("hex"), so.length]);
    }
    for (let offset = 0; offset < so.length; offset += CHUNK) {
      const chunk = so.subarray(offset, offset + CHUNK);
      await rpc("surfnet_writeProgram", [THESIS_PROGRAM_ID.toBase58(), chunk.toString("hex"), offset]);
    }
    const written = await deployedElf();
    if (!written || !sameElf(written, so)) throw new Error("Program bytes on the fork don't match thesis.so after writing");
    console.log("• Program deployed");
  }
  const currentAuthority = await upgradeAuthority();
  if (!currentAuthority?.equals(authority)) {
    await rpc("surfnet_setProgramAuthority", [THESIS_PROGRAM_ID.toBase58(), authority.toBase58()]);
    console.log(`• Upgrade authority set to the fork admin ${authority.toBase58()}`);
  }
}

/** ProgramData may be longer than the ELF (zero padding from a larger earlier build). */
function sameElf(deployed: Buffer, so: Buffer): boolean {
  if (deployed.length < so.length) return false;
  if (!deployed.subarray(0, so.length).equals(so)) return false;
  return deployed.subarray(so.length).every((b) => b === 0);
}

if (import.meta.main) await main(up);

