// Builds the QuickNode Stream fixtures in infra/quicknode/fixtures/.
//
// The program isn't deployed, so these are Thesis-like transactions made from fake logs: the
// shapes follow Solana `getBlock` output and QuickNode's "Programs with Logs" sample, and the
// events are real Anchor events encoded with the IDL. The program emits them as self-CPIs
// (`emit_cpi!`: inner Thesis instructions); the settle transaction keeps the older style, events
// as "Program data:" log lines, like transactions from before that change. Regenerate after the
// IDL changes events or instructions:
//
//   node packages/chain/test/stream-fixtures.ts
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { utils } from "@anchor-lang/core";
import BN from "bn.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../idl/thesis.json" with { type: "json" };
import { BADGE_KIND, EVENT_IX_TAG, RISK, SIDE, THESIS_PROGRAM_ID, thesisProgram } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(here, "../../../infra/quicknode/fixtures");
export const FILTER_PATH = join(here, "../../../infra/quicknode/thesis-filter.js");

/**
 * Loads the filter the way QuickNode runs it: a bare script, no imports, whose `main` we call.
 * The result goes through JSON like a webhook delivery (null stays null).
 */
export function loadFilter(): (stream: unknown) => unknown {
  const source = readFileSync(FILTER_PATH, "utf8");
  const main = runInNewContext(`${source}\n;main`, {}, { filename: FILTER_PATH });
  return (stream) => JSON.parse(JSON.stringify(main(stream)) ?? "null");
}

const program = thesisProgram(new Connection("http://127.0.0.1:8899"));
const THESIS = THESIS_PROGRAM_ID.toBase58();
const SYSTEM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const TOKEN = TOKEN_PROGRAM_ID.toBase58();
const SWAP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WRAPPER = "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu";

function seeded(label: string, length = 32): Uint8Array {
  const out = Buffer.alloc(length);
  for (let i = 0; i * 32 < length; i++) {
    createHash("sha256").update(`${label}:${i}`).digest().copy(out, i * 32);
  }
  return out;
}
const key = (label: string) => Keypair.fromSeed(seeded(label)).publicKey;
const sig = (label: string) => utils.bytes.bs58.encode(seeded(`sig:${label}`, 64));

export const KEYS = {
  author: key("author"),
  backer: key("backer"),
  crank: key("crank"),
  take: key("take"),
  authorPosition: key("author-position"),
  backerPosition: key("backer-position"),
  badgeMint: key("badge-mint"),
};

function eventBytes(name: string, data: Record<string, unknown>): Buffer {
  const event = idl.events.find((e) => e.name === name);
  if (!event) throw new Error(`no event ${name} in the IDL`);
  const typeName = name[0].toLowerCase() + name.slice(1);
  return Buffer.concat([Buffer.from(event.discriminator), program.coder.types.encode(typeName, data)]);
}

/** An event the old way: a "Program data:" log line. */
function eventLine(name: string, data: Record<string, unknown>): string {
  return `Program data: ${eventBytes(name, data).toString("base64")}`;
}

/** An event the program's way (`emit_cpi!`): a self-CPI whose data is Anchor's event tag, then the event. */
function eventIx(name: string, data: Record<string, unknown>, stackHeight: number) {
  return { program: THESIS, data: utils.bytes.bs58.encode(Buffer.concat([Buffer.from(EVENT_IX_TAG), eventBytes(name, data)])), stackHeight };
}

/** What a self-CPI event logs: the invoke and its exit, nothing else. */
const eventLogs = (depth: number) => [invoke(THESIS, depth), consumed(THESIS, 2_700), success(THESIS)];

function ixData(name: string, argBytes = 16): string {
  const ix = idl.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`no instruction ${name} in the IDL`);
  return utils.bytes.bs58.encode(Buffer.concat([Buffer.from(ix.discriminator), seeded(`args:${name}`, argBytes)]));
}

const invoke = (p: string, depth: number) => `Program ${p} invoke [${depth}]`;
const success = (p: string) => `Program ${p} success`;
const consumed = (p: string, n: number) => `Program ${p} consumed ${n} of 200000 compute units`;

/** A `getBlock` transaction ("json" encoding: string account keys, programIdIndex). */
function blockTx(opts: {
  label: string;
  accountKeys: string[];
  instructions: { program: string; data: string; accounts?: number[] }[];
  inner?: { index: number; instructions: { program: string; data: string; stackHeight: number }[] }[];
  loaded?: { writable: string[]; readonly: string[] };
  logs: string[];
  err?: unknown;
}) {
  const all = [...opts.accountKeys, ...(opts.loaded?.writable ?? []), ...(opts.loaded?.readonly ?? [])];
  const idx = (p: string) => {
    const i = all.indexOf(p);
    if (i < 0) throw new Error(`${p} not in account keys of ${opts.label}`);
    return i;
  };
  const err = opts.err ?? null;
  return {
    meta: {
      computeUnitsConsumed: 48_211,
      err,
      fee: 5_000,
      innerInstructions: (opts.inner ?? []).map((g) => ({
        index: g.index,
        instructions: g.instructions.map((ix) => ({
          accounts: [0],
          data: ix.data,
          programIdIndex: idx(ix.program),
          stackHeight: ix.stackHeight,
        })),
      })),
      loadedAddresses: opts.loaded ?? { readonly: [], writable: [] },
      logMessages: opts.logs,
      postBalances: opts.accountKeys.map(() => 1_000_000),
      postTokenBalances: [],
      preBalances: opts.accountKeys.map(() => 1_005_000),
      preTokenBalances: [],
      rewards: [],
      status: err ? { Err: err } : { Ok: null },
    },
    transaction: {
      message: {
        accountKeys: opts.accountKeys,
        header: { numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2, numRequiredSignatures: 1 },
        instructions: opts.instructions.map((ix) => ({
          accounts: ix.accounts ?? [0],
          data: ix.data,
          programIdIndex: idx(ix.program),
          stackHeight: null,
        })),
        recentBlockhash: utils.bytes.bs58.encode(seeded(`blockhash:${opts.label}`)),
        ...(opts.loaded ? { addressTableLookups: [] } : {}),
      },
      signatures: [sig(opts.label)],
    },
    version: opts.loaded ? 0 : "legacy",
  };
}

const { author, backer, crank, take, authorPosition, backerPosition, badgeMint } = KEYS;
const STAKE = new BN(10_000_000);

// Author creates a take and buys in. Compute budget first, then Thesis with a token CPI and its
// two events.
const createTakeEvents = [
  eventIx("TakeCreated", {
    take,
    author,
    claimHash: Array.from(seeded("claim")),
    risk: RISK.medium,
    horizonEnd: new BN(1_800_000_000),
    legs: 2,
    stake: STAKE,
  }, 2),
  eventIx("PositionOpened", {
    take,
    position: authorPosition,
    owner: author,
    side: SIDE.back,
    stake: STAKE,
    legsMask: 0b11,
    fee: new BN(0),
    creatorFee: new BN(0),
    scored: true,
    escrowed: new BN(0),
  }, 2),
];
const createTakeLogs = [
  invoke(COMPUTE_BUDGET, 1),
  success(COMPUTE_BUDGET),
  invoke(THESIS, 1),
  "Program log: Instruction: CreateTake",
  invoke(TOKEN, 2),
  "Program log: Instruction: TransferChecked",
  consumed(TOKEN, 6_200),
  success(TOKEN),
  ...eventLogs(2),
  ...eventLogs(2),
  consumed(THESIS, 41_000),
  success(THESIS),
];

// A backer's `back` that fails (custom program error): must be dropped.
const failedBackLogs = [
  invoke(THESIS, 1),
  "Program log: Instruction: Back",
  "Program log: AnchorError occurred. Error Code: TakeClosed. Error Number: 6001.",
  consumed(THESIS, 9_000),
  `Program ${THESIS} failed: custom program error: 0x1771`,
];

// A wallet wrapper calls `back` through CPI from a v0 transaction; Thesis's id comes from an
// address lookup table and Thesis itself CPIs into a swap that logs a lot, then emits its event.
const wrappedBackEvent = eventIx("PositionOpened", {
  take,
  position: backerPosition,
  owner: backer,
  side: SIDE.back,
  stake: new BN(25_000_000),
  legsMask: 0b01,
  fee: new BN(25_000),
  creatorFee: new BN(12_500),
  scored: true,
  escrowed: new BN(0),
}, 3);
const wrappedBackLogs = [
  invoke(WRAPPER, 1),
  "Program log: Instruction: ExecuteTransaction",
  invoke(THESIS, 2),
  "Program log: Instruction: Back",
  invoke(SWAP, 3),
  "Program log: Instruction: Route",
  invoke(TOKEN, 4),
  "Program log: Instruction: Transfer",
  consumed(TOKEN, 4_645),
  success(TOKEN),
  "Program log: swap noise that the filter should drop",
  `Program return: ${SWAP} AAAAAAAAAAA=`,
  consumed(SWAP, 60_000),
  success(SWAP),
  ...eventLogs(3),
  consumed(THESIS, 90_000),
  success(THESIS),
  consumed(WRAPPER, 120_000),
  success(WRAPPER),
];

// The author sells their buy-in, which closes the take: two events from one instruction.
const authorExitEvents = [
  eventIx("PositionExited", {
    take,
    position: authorPosition,
    owner: author,
    side: SIDE.back,
    exitedAt: new BN(1_790_000_000),
    escrowReturned: new BN(0),
    stake: STAKE,
  }, 2),
  eventIx("TakeClosed", { take, author, closedAt: new BN(1_790_000_000) }, 2),
];
const authorExitLogs = [
  invoke(THESIS, 1),
  "Program log: Instruction: ExitPosition",
  invoke(SYSTEM, 2),
  success(SYSTEM),
  ...eventLogs(2),
  ...eventLogs(2),
  consumed(THESIS, 30_000),
  success(THESIS),
];

// The backer sells a fifth of their position, and a crank later settles that part.
const partSoldEvent = eventIx("PositionPartSold", {
  take,
  position: backerPosition,
  owner: backer,
  side: SIDE.back,
  seq: 0,
  bps: 2_000,
  stakeSold: new BN(5_000_000),
  remainingStake: new BN(20_000_000),
  escrowReturned: new BN(0),
  soldAt: new BN(1_790_000_100),
}, 2);
const partSoldLogs = [
  invoke(THESIS, 1),
  "Program log: Instruction: SellPart",
  invoke(SYSTEM, 2),
  success(SYSTEM),
  ...eventLogs(2),
  consumed(THESIS, 25_000),
  success(THESIS),
];
const partSettledEvent = eventIx("PartSettled", {
  take,
  position: backerPosition,
  owner: backer,
  side: SIDE.back,
  seq: 0,
  stake: new BN(5_000_000),
  returnBps: new BN(800),
  pnl: new BN(400_000),
  scored: true,
}, 2);
const partSettledLogs = [
  invoke(THESIS, 1),
  "Program log: Instruction: SettlePart",
  ...eventLogs(2),
  consumed(THESIS, 18_000),
  success(THESIS),
];

// The crank settles the take and a position, then mints the author's badge: three top-level
// Thesis instructions in one transaction. The old style: events in the logs.
const settleLogs = [
  invoke(THESIS, 1),
  "Program log: Instruction: SettleTake",
  eventLine("TakeSettled", { take, author, resultBps: new BN(1_250) }),
  consumed(THESIS, 20_000),
  success(THESIS),
  invoke(THESIS, 1),
  "Program log: Instruction: SettlePosition",
  invoke(SYSTEM, 2),
  success(SYSTEM),
  eventLine("PositionSettled", {
    take,
    position: backerPosition,
    owner: backer,
    side: SIDE.back,
    returnBps: new BN(1_250),
    pnl: new BN(3_125_000),
    scored: true,
    exited: false,
    escrowReturned: new BN(0),
    stake: new BN(25_000_000),
  }),
  consumed(THESIS, 30_000),
  success(THESIS),
  invoke(THESIS, 1),
  "Program log: Instruction: MintBadge",
  eventLine("BadgeMinted", { owner: author, kind: BADGE_KIND.firstOver50, mint: badgeMint }),
  consumed(THESIS, 50_000),
  success(THESIS),
];

const transferLogs = [invoke(SYSTEM, 1), success(SYSTEM)];

// Synthetic, round slot, block height and block time (not from any real block).
const SLOT = 380_000_000;
const BLOCK_TIME = 1_800_000_000;

function blockDataset() {
  const b58 = (s: PublicKey) => s.toBase58();
  return {
    data: [
      {
        blockHeight: 358_000_000,
        blockTime: BLOCK_TIME,
        blockhash: utils.bytes.bs58.encode(seeded("blockhash:0")),
        parentSlot: SLOT - 1,
        previousBlockhash: utils.bytes.bs58.encode(seeded("blockhash:-1")),
        rewards: [],
        transactions: [
          blockTx({
            label: "transfer",
            accountKeys: [b58(key("someone")), b58(key("someone-else")), SYSTEM],
            instructions: [{ program: SYSTEM, data: "3Bxs4h24hBtQy9rw", accounts: [0, 1] }],
            logs: transferLogs,
          }),
          blockTx({
            label: "create-take",
            accountKeys: [b58(author), b58(take), b58(authorPosition), COMPUTE_BUDGET, TOKEN, THESIS],
            instructions: [
              { program: COMPUTE_BUDGET, data: "3gJqkocMWaMm" },
              { program: THESIS, data: ixData("create_take", 64), accounts: [0, 1, 2, 4] },
            ],
            inner: [{ index: 1, instructions: [{ program: TOKEN, data: "g7Yr5DnhKqDcX", stackHeight: 2 }, ...createTakeEvents] }],
            logs: createTakeLogs,
          }),
          blockTx({
            label: "failed-back",
            accountKeys: [b58(backer), b58(take), THESIS],
            instructions: [{ program: THESIS, data: ixData("back", 24), accounts: [0, 1] }],
            logs: failedBackLogs,
            err: { InstructionError: [0, { Custom: 6001 }] },
          }),
        ],
      },
      {
        blockHeight: 358_000_001,
        blockTime: BLOCK_TIME + 1,
        blockhash: utils.bytes.bs58.encode(seeded("blockhash:1")),
        parentSlot: SLOT,
        previousBlockhash: utils.bytes.bs58.encode(seeded("blockhash:0")),
        rewards: [],
        transactions: [
          blockTx({
            label: "wrapped-back",
            accountKeys: [b58(backer), b58(backerPosition), WRAPPER],
            loaded: { writable: [b58(take)], readonly: [SWAP, TOKEN, THESIS] },
            instructions: [{ program: WRAPPER, data: "5Kxq9bLv2tYb", accounts: [0, 1, 3] }],
            inner: [
              {
                index: 0,
                instructions: [
                  { program: THESIS, data: ixData("back", 24), stackHeight: 2 },
                  { program: SWAP, data: "2Rh7LqY3pN", stackHeight: 3 },
                  { program: TOKEN, data: "3Dc8EpW7Kc", stackHeight: 4 },
                  wrappedBackEvent,
                ],
              },
            ],
            logs: wrappedBackLogs,
          }),
          blockTx({
            label: "author-exit",
            accountKeys: [b58(author), b58(take), b58(authorPosition), SYSTEM, THESIS],
            instructions: [{ program: THESIS, data: ixData("exit_position", 0), accounts: [0, 1, 2] }],
            inner: [{ index: 0, instructions: [{ program: SYSTEM, data: "3Bxs4h24hBtQy9rw", stackHeight: 2 }, ...authorExitEvents] }],
            logs: authorExitLogs,
          }),
          blockTx({
            label: "backer-part-sale",
            accountKeys: [b58(backer), b58(take), b58(backerPosition), SYSTEM, THESIS],
            instructions: [{ program: THESIS, data: ixData("sell_part", 2), accounts: [0, 1, 2] }],
            inner: [{ index: 0, instructions: [{ program: SYSTEM, data: "3Bxs4h24hBtQy9rw", stackHeight: 2 }, partSoldEvent] }],
            logs: partSoldLogs,
          }),
          blockTx({
            label: "part-settle",
            accountKeys: [b58(crank), b58(take), b58(backerPosition), THESIS],
            instructions: [{ program: THESIS, data: ixData("settle_part", 0), accounts: [0, 1, 2] }],
            inner: [{ index: 0, instructions: [partSettledEvent] }],
            logs: partSettledLogs,
          }),
          blockTx({
            label: "settle",
            accountKeys: [b58(crank), b58(take), b58(backerPosition), b58(badgeMint), SYSTEM, THESIS],
            instructions: [
              { program: THESIS, data: ixData("settle_take", 0), accounts: [0, 1] },
              { program: THESIS, data: ixData("settle_position", 0), accounts: [0, 1, 2] },
              { program: THESIS, data: ixData("mint_badge", 0), accounts: [0, 1, 3] },
            ],
            inner: [{ index: 1, instructions: [{ program: SYSTEM, data: "3Bxs4h24hBtQy9rw", stackHeight: 2 }] }],
            logs: settleLogs,
          }),
        ],
      },
    ],
    metadata: {
      batch_start_range: SLOT,
      batch_end_range: SLOT + 1,
      blocks_reorged: null,
      data_size_bytes: 0,
      dataset: "block",
      end_range: -1,
      keep_distance_from_tip: 0,
      network: "solana-mainnet",
      reorgs: null,
      start_range: SLOT,
      stream_id: "00000000-0000-4000-8000-000000000000",
      stream_name: "thesis-mainnet",
      stream_region: "usa_east",
    },
  };
}

/** The same block in "jsonParsed" encoding: key objects and resolved `programId`s. */
function jsonParsedDataset() {
  const block = blockDataset();
  for (const b of block.data) {
    for (const tx of b.transactions as any[]) {
      const loaded = tx.meta.loadedAddresses;
      const keys: string[] = [...tx.transaction.message.accountKeys, ...loaded.writable, ...loaded.readonly];
      tx.transaction.message.accountKeys = keys.map((pubkey, i) => ({
        pubkey,
        signer: i === 0,
        source: i < tx.transaction.message.accountKeys.length ? "transaction" : "lookupTable",
        writable: i < 2,
      }));
      const resolve = (ix: any) => ({ accounts: ix.accounts.map((a: number) => keys[a]), data: ix.data, programId: keys[ix.programIdIndex], stackHeight: ix.stackHeight });
      tx.transaction.message.instructions = tx.transaction.message.instructions.map(resolve);
      for (const g of tx.meta.innerInstructions) g.instructions = g.instructions.map(resolve);
    }
  }
  return block;
}

/** QuickNode's "Programs with Logs" dataset: one array of transactions per block. */
function programsWithLogsDataset() {
  const block = jsonParsedDataset();
  return {
    data: block.data.map((b) =>
      (b.transactions as any[]).map((tx) => ({
        signature: tx.transaction.signatures[0],
        slot: SLOT + block.data.indexOf(b),
        blockTime: b.blockTime,
        programInvocations: [
          ...tx.transaction.message.instructions.map((ix: any, index: number) => ({ programId: ix.programId, instruction: { index, accounts: [], data: ix.data, tokenBalances: [] } })),
          ...tx.meta.innerInstructions.flatMap((g: any) =>
            g.instructions.map((ix: any) => ({ programId: ix.programId, instruction: { index: g.index, accounts: [], data: ix.data, tokenBalances: [] } })),
          ),
        ],
        logs: tx.meta.logMessages,
        success: tx.meta.err === null,
      })),
    ),
    metadata: { ...block.metadata, dataset: "programs_with_logs" },
  };
}

export const FIXTURES = {
  "block.json": blockDataset,
  "block-jsonparsed.json": jsonParsedDataset,
  "programs-with-logs.json": programsWithLogsDataset,
} as const;

/** What the Stream delivers to the webhook for `block.json`. */
export const EXAMPLE_PAYLOAD = "webhook-payload.example.json";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFileSync(join(FIXTURES_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
  for (const [name, build] of Object.entries(FIXTURES)) write(name, build());
  write(EXAMPLE_PAYLOAD, loadFilter()(blockDataset()));
  console.log(`wrote ${Object.keys(FIXTURES).length + 1} files to ${FIXTURES_DIR}`);
}
