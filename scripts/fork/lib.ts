// Shared helpers for the mainnet-fork dogfood environment (scripts/fork/*.ts).
//
// Everything here talks to a local Surfpool fork of mainnet. Nothing in this folder may ever
// point at real mainnet: the cheatcodes it uses (surfnet_*) only exist on Surfpool, so a
// mainnet RPC would reject them anyway.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { THESIS_PROGRAM_ID, USDC_DECIMALS, USDC_MINT_MAINNET } from "@thesis/chain";
import { ACTIVE_TRADER_BUFFER, GLOBAL_TRADER_INDEX, PERP_ASSET_MAP, syncMakers } from "@thesis/venues/phoenix";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const DATA_DIR = join(REPO_ROOT, ".data/fork");

/** Interface Surfpool binds to. 0.0.0.0 lets a phone on the same Wi-Fi reach the fork. */
export const HOST = process.env.FORK_HOST ?? "127.0.0.1";
export const RPC_PORT = Number(process.env.FORK_RPC_PORT ?? 18899);
export const WS_PORT = Number(process.env.FORK_WS_PORT ?? RPC_PORT + 1);
const CLIENT_HOST = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
/** Set FORK_RPC_URL / FORK_WS_URL to use a fork someone else started. */
export const RPC_URL = process.env.FORK_RPC_URL ?? `http://${CLIENT_HOST}:${RPC_PORT}`;
export const WS_URL = process.env.FORK_WS_URL ?? `ws://${CLIENT_HOST}:${WS_PORT}`;

/**
 * The only Jupiter venues fork routes use: AMMs and order books whose price lives in their own
 * accounts, which `refreshMarkets` copies from mainnet right before a send. Proprietary AMMs
 * (HumidiFi, SolFi, TesseraV, Kipseli, Archer, Scorch, ... and new ones every month) price from
 * quotes their market maker pushes every slot, so on a fork they reject the swap (TesseraV:
 * 0xffff) or fill below the slippage limit (Jupiter 0x1771). An allowlist keeps new ones out
 * without chasing them. Mainnet routing uses every venue. The asset bank's probes use the same
 * list (ASSET_BANK_DEXES in infra/executor/executor.env.example; test/bank-dexes.test.ts).
 */
export const FORK_DEXES = [
  "Whirlpool",
  "Raydium",
  "Raydium CLMM",
  "Raydium CP",
  "Meteora",
  "Meteora DLMM",
  "Meteora DAMM v2",
  "PancakeSwap",
  "Orca V2",
  "OpenBook V2",
  "Phoenix",
  "Stabble Stable Swap",
  "Saber",
];

export const PATHS = {
  admin: join(DATA_DIR, "admin.json"),
  /** The trade allowlist's own key (security review M-2): kept apart from the admin. */
  allowlistAdmin: join(DATA_DIR, "allowlist-admin.json"),
  settler: join(DATA_DIR, "settler.json"),
  /** Pays fees and rent for test users, like the app's fee payer for Privy users. */
  appPayer: join(DATA_DIR, "app-payer.json"),
  /** Co-signs Phoenix trader onboarding on the fork, through a fork-only permission (`phoenix.ts`). */
  phoenixOnboarder: join(DATA_DIR, "phoenix-onboarder.json"),
  /** Address of the fork's Thesis lookup table, written by `fork:up`. */
  lookupTable: join(DATA_DIR, "thesis-alt.json"),
  pid: join(DATA_DIR, "surfpool.pid"),
  log: join(DATA_DIR, "surfpool.log"),
};

// Not exported by @solana/web3.js v1.
const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"); // ggignore
/** UpgradeableLoaderState::ProgramData header: 4-byte tag, u64 slot, Option<Pubkey> authority. */
const PROGRAMDATA_HEADER = 45;

export const connection = () => new Connection(RPC_URL, { commitment: "confirmed", wsEndpoint: WS_URL });

// --- JSON-RPC (cheatcodes aren't in web3.js) ----------------------------------------------

export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** Surfpool's version, or null if nothing (or not Surfpool) answers at RPC_URL. */
export async function surfpoolVersion(): Promise<string | null> {
  try {
    const v = await rpc<Record<string, string>>("getVersion");
    return v["surfnet-version"] ?? null;
  } catch {
    return null;
  }
}

export async function requireSurfpool(): Promise<string> {
  const version = await surfpoolVersion();
  if (!version) {
    throw new Error(`No Surfpool fork at ${RPC_URL}. Start one with \`pnpm fork:up\`.`);
  }
  return version;
}

// --- Keypairs (fork-only, under .data/fork/, gitignored) ----------------------------------

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

/** Loads a keypair in Solana CLI format (JSON array of 64 numbers), creating it if missing. */
export function loadOrCreateKeypair(path: string): { keypair: Keypair; created: boolean } {
  if (existsSync(path)) return { keypair: loadKeypair(path), created: false };
  mkdirSync(dirname(path), { recursive: true });
  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return { keypair, created: true };
}

/** The fork's Thesis lookup table, if `fork:up` made one. */
export function thesisLookupTable(): PublicKey | null {
  if (!existsSync(PATHS.lookupTable)) return null;
  return new PublicKey(JSON.parse(readFileSync(PATHS.lookupTable, "utf8")).address);
}

// --- Venues on the fork -------------------------------------------------------------------

/**
 * Surfpool copies each mainnet account once and then keeps its own version, so pools and
 * oracles go stale within minutes and swaps start failing. Re-fetch the accounts a trade reads
 * from mainnet, and bring the fork's clock up to wall time (never backwards), or fresh pools look
 * "from the future". Never pass the user's own accounts: they only exist on the fork.
 *
 * `freshMs`: accounts this process reset less than that long ago are left as they are (`fresh`),
 * and when none needed a reset the clock isn't touched either. 0 (the default): every account.
 *
 * `phoenixMakers`: when the accounts include Phoenix's PerpAssetMap (a Phoenix order or close is
 * about to go out), also put mainnet's traders back to their mainnet state in Phoenix's active
 * trader buffer (`syncPhoenixMakers`). Only a caller that holds the Phoenix lock asks for it
 * (api/phoenix-lock.ts): the sync rewrites that whole account.
 */
export async function refreshMarkets(accounts: PublicKey[], o: { freshMs?: number; phoenixMakers?: boolean } = {}): Promise<{ reset: number; skipped: number; fresh: number }> {
  const now = Date.now();
  const all = [...new Set(accounts.map(String))];
  const unique = all.filter((k) => !o.freshMs || (resetAt.get(k) ?? -Infinity) <= now - o.freshMs);
  const makers = o.phoenixMakers && all.includes(PERP_ASSET_MAP.toBase58()) ? syncPhoenixMakers() : null;
  if (o.freshMs && !unique.length) {
    await makers;
    return { reset: 0, skipped: 0, fresh: all.length };
  }
  // Some accounts can't be reset (programs, sysvars); those don't go stale anyway.
  const results = await Promise.allSettled(unique.map((k) => rpc("surfnet_resetAccount", [k])));
  // Ones that can't be reset count as fresh too: they're not market state.
  for (const k of unique) resetAt.set(k, now);
  if (resetAt.size > RESETS_KEPT) for (const [k, at] of resetAt) if (at <= now - 60_000) resetAt.delete(k);
  const failed = results.filter((r) => r.status === "rejected").length;
  await makers;
  await syncClock();
  return { reset: unique.length - failed, skipped: failed, fresh: all.length - unique.length };
}

/** Mainnet, for reading what Surfpool would copy: the fork's datasource, else the public RPC. */
const mainnet = () => new Connection(process.env.FORK_DATASOURCE_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

/**
 * Puts every trader that exists on mainnet back to its mainnet state in Phoenix's active trader
 * buffer (packages/venues/phoenix makers.ts): fork fills never pile up against the makers, so a thin
 * market like CoreWeave doesn't panic after a few fork trades. Our users' accounts (fork-only
 * traders) keep their positions. One mainnet read (the buffer and the trader index, ~110 KB) and
 * one write, only when something differs. Never throws: a sync that can't run (mainnet
 * unreachable, a layout that doesn't check out) is logged and the trade goes out as before.
 */
export async function syncPhoenixMakers(log: (m: string) => void = console.log): Promise<void> {
  const keys = [new PublicKey(ACTIVE_TRADER_BUFFER), new PublicKey(GLOBAL_TRADER_INDEX)];
  try {
    const [[mAtb, mGti], [fAtb, fGti]] = await Promise.all([
      mainnet().getMultipleAccountsInfo(keys),
      connection().getMultipleAccountsInfo(keys, "processed"),
    ]);
    if (!mAtb || !mGti || !fAtb || !fGti) return log("Phoenix makers: not synced (a trader account is missing)");
    const out = syncMakers({ atb: fAtb.data, gti: fGti.data }, { atb: mAtb.data, gti: mGti.data });
    if (!out) return;
    await rpc("surfnet_setAccount", [ACTIVE_TRADER_BUFFER, { lamports: fAtb.lamports, owner: fAtb.owner.toBase58(), data: out.data.toString("hex") }]);
    log(`Phoenix makers synced to mainnet: ${out.synced} entries${out.cleared ? `, ${out.cleared} set flat` : ""}${out.missing ? `, ${out.missing} not on the fork` : ""} (${out.forkOnly} fork-only kept)`);
  } catch (e) {
    log(`Phoenix makers: not synced (${e instanceof Error ? e.message : e})`);
  }
}

/** Account → when this process last reset it from mainnet (refreshMarkets' `freshMs`). */
const resetAt = new Map<string, number>();

/**
 * Forgets that `accounts` are fresh. A trade on the fork really moves the pools it swaps through,
 * and nobody arbitrages them back as on mainnet, so after a send the next build must copy them from
 * mainnet again, not price against the fork's own last trade (a scaled or repriced quote from before
 * it then fails its slippage check, Jupiter's 0x1771).
 */
export function forgetFresh(accounts: PublicKey[]): void {
  for (const k of accounts) resetAt.delete(String(k));
}
/** Past this many, entries over a minute old are dropped. */
const RESETS_KEPT = 5_000;

async function forkTime(): Promise<number> {
  const info = await connection().getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111"), "processed");
  return Number(info!.data.readBigInt64LE(32));
}

/** Moves the fork clock up to wall time if it lags. Returns the fork's lead over wall time (s), if any. */
export async function syncClock(): Promise<number> {
  const lead = (await forkTime()) - Math.floor(Date.now() / 1000);
  if (lead < -1) await rpc("surfnet_timeTravel", [{ absoluteTimestamp: Date.now() }]);
  return Math.max(0, lead);
}

// --- Funding ------------------------------------------------------------------------------

/** Adds `sol` SOL to the wallet's balance. Keeps the account's owner and data. */
export async function addSol(wallet: PublicKey, sol: number): Promise<number> {
  const conn = connection();
  const current = await conn.getBalance(wallet);
  const lamports = current + Math.round(sol * LAMPORTS_PER_SOL);
  await rpc("surfnet_setAccount", [wallet.toBase58(), { lamports }]);
  return lamports;
}

/** A fork key with less than this much fake SOL is topped up to TOPUP_TO_SOL (see `topUpSol`). */
export const TOPUP_BELOW_SOL = 5;
export const TOPUP_TO_SOL = 10;

/**
 * Tops up fork keys that pay fees and rent (the app fee payer, the settler) with fake SOL when
 * they drop below TOPUP_BELOW_SOL, so trades and price records don't start failing once the
 * fork's rent adds up. Runs only against Surfpool (it answers getVersion with a surfnet version):
 * never against mainnet, where the cheatcode doesn't exist anyway. Returns the names topped up.
 */
export async function topUpSol(keys: { name: string; key: PublicKey }[], log: (m: string) => void): Promise<string[]> {
  if (!(await surfpoolVersion())) {
    log(`SOL top-up skipped: ${RPC_URL} isn't a Surfpool fork`);
    return [];
  }
  const conn = connection();
  const done: string[] = [];
  for (const { name, key } of keys) {
    const lamports = await conn.getBalance(key);
    if (lamports >= TOPUP_BELOW_SOL * LAMPORTS_PER_SOL) continue;
    await rpc("surfnet_setAccount", [key.toBase58(), { lamports: TOPUP_TO_SOL * LAMPORTS_PER_SOL }]);
    log(`topped up the ${name} ${key.toBase58()} from ${(lamports / LAMPORTS_PER_SOL).toFixed(3)} to ${TOPUP_TO_SOL} fake SOL`);
    done.push(name);
  }
  return done;
}

/** Sets the wallet's USDC balance to exactly `baseUnits` (6 decimals). */
export async function setUsdc(wallet: PublicKey, baseUnits: bigint): Promise<void> {
  await rpc("surfnet_setTokenAccount", [wallet.toBase58(), USDC_MINT_MAINNET.toBase58(), { amount: Number(baseUnits), state: "initialized" }]);
}

/** Adds `usdc` USDC to the wallet's USDC associated token account, creating it if needed. */
export async function addUsdc(wallet: PublicKey, usdc: number): Promise<bigint> {
  const conn = connection();
  const ata = getAssociatedTokenAddressSync(USDC_MINT_MAINNET, wallet, true);
  let current = 0n;
  try {
    current = BigInt((await conn.getTokenAccountBalance(ata)).value.amount);
  } catch {
    // No token account yet: the cheatcode creates it.
  }
  const amount = current + BigInt(Math.round(usdc * 10 ** USDC_DECIMALS));
  await rpc("surfnet_setTokenAccount", [
    wallet.toBase58(),
    USDC_MINT_MAINNET.toBase58(),
    { amount: Number(amount), state: "initialized" },
  ]);
  return amount;
}

// --- Program artifact ---------------------------------------------------------------------

/**
 * Finds thesis.so: --so / THESIS_SO, then anchor/target/deploy in this checkout, then in the
 * main checkout when this is a git worktree (worktrees don't share the gitignored target/).
 */
export function findProgramSo(explicit?: string): string {
  const candidates = [explicit, process.env.THESIS_SO, join(REPO_ROOT, "anchor/target/deploy/thesis.so")];
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    candidates.push(join(dirname(common), "anchor/target/deploy/thesis.so"));
  } catch {
    // Not a git checkout.
  }
  for (const path of candidates) if (path && existsSync(path)) return resolve(path);
  throw new Error(
    "No thesis.so found. Build it (`anchor build` in anchor/), ask a teammate for theirs, or pass --so <path>.",
  );
}

export function programDataAddress(programId = THESIS_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_UPGRADEABLE_LOADER)[0];
}

/** The deployed ELF (ProgramData minus its header), or null if the program isn't deployed. */
export async function deployedElf(programId = THESIS_PROGRAM_ID): Promise<Buffer | null> {
  const conn = connection();
  const program = await conn.getAccountInfo(programId);
  if (!program?.executable) return null;
  const data = await conn.getAccountInfo(programDataAddress(programId));
  if (!data) return null;
  return data.data.subarray(PROGRAMDATA_HEADER);
}

/** Upgrade authority stored in ProgramData, or null if none. */
export async function upgradeAuthority(programId = THESIS_PROGRAM_ID): Promise<PublicKey | null> {
  const data = await connection().getAccountInfo(programDataAddress(programId));
  if (!data || data.data[12] !== 1) return null;
  return new PublicKey(data.data.subarray(13, 45));
}

// --- Surfpool binary ----------------------------------------------------------------------

export function surfpoolBin(): string {
  if (process.env.SURFPOOL_BIN) return process.env.SURFPOOL_BIN;
  const local = join(homedir(), ".local/bin/surfpool");
  if (existsSync(local)) return local;
  return "surfpool";
}

// --- CLI ----------------------------------------------------------------------------------

/** Tiny argv parser: positionals plus `--flag value` / `--flag` pairs. */
export function parseArgs(argv = process.argv.slice(2)) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

export function numberFlag(flags: Record<string, string | true>, name: string, fallback: number): number {
  const v = flags[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (v === true || !Number.isFinite(n) || n < 0) throw new Error(`--${name} needs a non-negative number`);
  return n;
}

/** The flag a suite that moves the fork's clock must be given (see the README's "Resets"). */
export const MOVE_CLOCK_FLAG = "--move-clock";

/**
 * Refuses to start a suite that moves the fork's clock (`surfnet_timeTravel`) unless it was run with
 * `--move-clock`. There's one shared fork and it's public: after a jump swaps fail until the fork
 * is restarted fresh, which wipes everyone's takes and play money. Only the fork's maintainer decides that.
 */
export function requireClockMoveFlag(suite: string, argv: string[] = process.argv): void {
  if (argv.includes(MOVE_CLOCK_FLAG)) return;
  throw new Error(
    `${suite} moves the fork's clock days ahead, which breaks the shared fork until it's reset ` +
      `(every take and fake balance is lost). Run it only with the fork maintainer's OK, then restart the fork: ` +
      `pnpm ${suite} -- ${MOVE_CLOCK_FLAG}`,
  );
}

export async function main(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
