// A ForkService over a mocked fork, holding one live take with a single card leg: a back of it
// needs no Jupiter call (the card's share is escrowed), so builds, submits and their timing can be
// tested in-process. Used by the accept/submission and prebuild tests.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import BN from "bn.js";
import { Keypair, PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { DEFAULT_CONFIG_PARAMS, TAKE_LIFETIME_SECS, configAddress, takeAddress, thesisProgram, ticketAddress } from "@thesis/chain";
import { emptyState } from "../../../packages/venues/bank/src/state.ts";
import { base58, type AppTake, type ServiceOpts } from "../api/common.ts";
import { mapLegs } from "../api/legs.ts";
import { ForkService } from "../api/service.ts";

export const TAKE_ID = "00000000-0000-4000-8000-0000000000ee";

export type Status = { err: unknown; confirmationStatus: string } | null;

export type FixtureOpts = {
  /** What sendTransaction does with each transaction (default: accept it). */
  send?: (tx: VersionedTransaction, opts: unknown) => Promise<string>;
  /** What getSignatureStatuses says about a signature (default: nothing yet). */
  status?: (sig: string) => Status;
  /** The block height (default 50: every blockhash, valid to 100, is still live). */
  height?: () => number;
  /** Abandoned trade tickets the owner has (positions), found by the cleanup's scan. */
  tickets?: PublicKey[];
  /** The state file to start from (default: a fresh one in a temp folder). */
  statePath?: string;
  fork?: Partial<ServiceOpts["fork"]>;
};

export async function tradeFixture(t: TestContext, o: FixtureOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "thesis-trade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = Keypair.generate();
  const author = Keypair.generate();
  const appPayer = Keypair.generate();
  const program = thesisProgram({} as Connection);
  const app: AppTake = {
    id: TAKE_ID,
    claim: "Cards keep going up",
    risk: "medium",
    settles_at: new Date(Date.now() + TAKE_LIFETIME_SECS * 1000).toISOString(),
    status: "live",
    author: { handle: "someone" },
    author_wallet: author.publicKey.toBase58(),
    legs: [{ name: "Charizard PSA 10", kind: "Card", weight: 100, fade_how: null, asset_id: "card:2026120156C116510" }],
  };
  const take = takeAddress(author.publicKey, 1n);
  const statePath = o.statePath ?? join(dir, "api-state.json");
  if (!o.statePath) writeFileSync(statePath, JSON.stringify({ forkId: "none", takes: { [TAKE_ID]: { address: take.toBase58(), author: author.publicKey.toBase58(), mirroredAt: new Date().toISOString() } }, cash: [] }));
  const k = () => Keypair.generate().publicKey;
  const accounts = new Map<string, Buffer>();
  accounts.set(configAddress().toBase58(), await program.coder.accounts.encode("config", {
    admin: k(), allowlistAdmin: k(), pendingAdmin: null, pendingAllowlistAdmin: null, settler: k(), usdcMint: k(),
    feeVault: k(), creatorVault: k(), escrowVault: k(), params: DEFAULT_CONFIG_PARAMS, bump: 255, feeVaultBump: 255,
    creatorVaultBump: 255, escrowVaultBump: 255, tradePrograms: [], badgeUriBase: "",
  }));
  accounts.set(take.toBase58(), await program.coder.accounts.encode("take", {
    author: author.publicKey, id: new BN(1), claimHash: Array(32).fill(0), risk: { medium: {} }, createdAt: new BN(0),
    horizonEnd: new BN(Math.floor(Date.now() / 1000) + 86_400), legs: mapLegs(app.legs).map((l) => l.spec), backers: 0, faders: 0,
    totalBacked: new BN(0), totalFaded: new BN(0), openPositions: 0, creatorFeesUnclaimed: new BN(0), platformFeesFromBacks: new BN(0),
    status: { open: {} }, resultBps: new BN(0), bump: 255, closedAt: new BN(0),
  }));
  const ticket = async (position: PublicKey) => program.coder.accounts.encode("tradeTicket", {
    owner: owner.publicKey, position, rentPayer: appPayer.publicKey, ownerUsdc: k(),
    outputs: Array.from({ length: 10 }, () => k()), spent: new BN(0), grown: 0, received: Array.from({ length: 10 }, () => new BN(0)),
    named: 0, phoenix: 0, openIx: 65_535, openMask: 0, usdcStart: new BN(0), outputsStart: Array.from({ length: 10 }, () => new BN(0)), bump: 255,
  });
  const tickets = await Promise.all((o.tickets ?? []).map(async (p) => ({ pubkey: ticketAddress(owner.publicKey, p), account: { data: await ticket(p), owner: program.programId, lamports: 1, executable: false } })));
  const info = (key: PublicKey) => {
    const data = accounts.get(key.toBase58());
    return data ? { data, owner: program.programId, lamports: 1, executable: false, rentEpoch: 0 } : null;
  };
  const sent: VersionedTransaction[] = [];
  const refreshed: PublicKey[][] = [];
  const connection = {
    getAccountInfo: async (key: PublicKey) => info(key),
    getAccountInfoAndContext: async (key: PublicKey) => ({ context: { slot: 1 }, value: info(key) }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(info),
    // Only the abandoned-ticket scan (it filters on the rent payer at offset 72) finds anything.
    getProgramAccounts: async (_: PublicKey, c?: { filters?: { memcmp?: { offset: number } }[] }) =>
      (c?.filters ?? []).some((f) => f.memcmp?.offset === 72) ? tickets : [],
    getTokenAccountBalance: async () => ({ value: { amount: "100000000" } }),
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    getSignaturesForAddress: async () => [],
    getLatestBlockhash: async () => ({ blockhash: k().toBase58(), lastValidBlockHeight: 100 }),
    simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 20_000 } }),
    sendTransaction: async (tx: VersionedTransaction, opts: unknown) => (sent.push(tx), o.send ? o.send(tx, opts) : base58(tx.signatures[0])),
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map((s) => o.status?.(s) ?? null) }),
    getBlockHeight: async () => (o.height ? o.height() : 50),
  } as unknown as Connection;
  const logs: string[] = [];
  const options: ServiceOpts = {
    connection,
    appPayer,
    lookupTable: null,
    bank: emptyState,
    takes: async (id) => (id === TAKE_ID ? app : null),
    stocks: null,
    pricesFile: null,
    bases: null,
    jupiterApiKey: null,
    statePath,
    fork: { addUsdc: async () => 0n, setUsdc: async () => {}, refreshMarkets: async (a: PublicKey[]) => void refreshed.push(a), ...o.fork },
    log: (m) => logs.push(m),
  };
  const service = new ForkService(options);
  const wallet = owner.publicKey.toBase58();
  const sign = (built: { transactions: string[] }) =>
    built.transactions.map((b64) => {
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      tx.sign([owner]);
      return Buffer.from(tx.serialize()).toString("base64");
    });
  const sigs = () => sent.map((tx) => base58(tx.signatures[0]));
  return { service, options, wallet, owner, appPayer, take, sent, sigs, sign, logs, refreshed, statePath };
}

/** Resolves on the next turns of the event loop (lets background work move on). */
export const tick = (n = 5) => new Promise<void>((r) => {
  const step = (left: number) => (left ? setImmediate(() => step(left - 1)) : r());
  step(n);
});
