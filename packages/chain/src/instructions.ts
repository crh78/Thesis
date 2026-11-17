import BN from "bn.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  type AccountMeta,
  type TransactionInstruction,
} from "@solana/web3.js";
import { DEFAULT_TRADE_PROGRAMS, USDC_MINT_MAINNET } from "./constants.ts";
import {
  authorPositionAddress,
  badgeMintAddress,
  configAddress,
  creatorVaultAddress,
  escrowVaultAddress,
  exitAddress,
  feeVaultAddress,
  positionAddress,
  profileAddress,
  programDataAddress,
  takeAddress,
  ticketAddress,
  type U64,
} from "./pda.ts";
import type { ThesisProgram } from "./program.ts";
import { BADGE_KIND, BADGE_KIND_INDEX, type BadgeKindName } from "./types.ts";
import type {
  ConfigParams,
  LegPrice,
  LegSpec,
  Risk,
  UpdateConfigArgs,
} from "./types.ts";

// Every builder returns a single instruction to drop into a transaction next to the user's own
// venue instructions (Jupiter, Phoenix, ...). `payer` pays rent; it defaults to the signer, and
// the app passes its own fee payer for Privy users.
//
// Proof of trade: a trade is `begin_trade`, the owner's venue instructions, then the receipt
// (`create_take`, `back`, `fade`). A trade split over several transactions closes each one but
// the last with `trade_step` (open: false) and opens each one but the first with `trade_step`
// (open: true). Each of those instructions names the output token accounts of the legs bought
// in its own transaction (`outputs`, in leg order, with `outputsMask` saying which legs); the
// closing one names the same accounts as the opening one.

const usdc = (mint?: PublicKey) => mint ?? USDC_MINT_MAINNET;
const ata = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
const readonly = (keys: PublicKey[] = []): AccountMeta[] => keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));

/** Output accounts for a set of legs: `outputs` keyed by leg index → the mask and the accounts in leg order. */
export function tradeOutputs(outputs: Map<number, PublicKey> | Record<number, PublicKey>): { outputsMask: number; outputs: PublicKey[] } {
  const entries = (outputs instanceof Map ? [...outputs] : Object.entries(outputs).map(([k, v]) => [Number(k), v] as const))
    .sort(([a], [b]) => a - b);
  return {
    outputsMask: entries.reduce((m, [i]) => m | (1 << i), 0),
    outputs: entries.map(([, k]) => k),
  };
}

/**
 * Must be signed by the program's upgrade authority as `admin` (security review H-1).
 * `allowlistAdmin` is the only key that can change the trade allowlist (review M-2): keep it
 * apart from the admin.
 */
export async function initConfigIx(
  program: ThesisProgram,
  p: { admin: PublicKey; settler: PublicKey; allowlistAdmin: PublicKey; params: ConfigParams; usdcMint?: PublicKey; tradePrograms?: PublicKey[] },
): Promise<TransactionInstruction> {
  return program.methods
    .initConfig(p.settler, p.allowlistAdmin, p.params, p.tradePrograms ?? DEFAULT_TRADE_PROGRAMS)
    .accountsPartial({
      admin: p.admin,
      config: configAddress(program.programId),
      usdcMint: usdc(p.usdcMint),
      feeVault: feeVaultAddress(program.programId),
      creatorVault: creatorVaultAddress(program.programId),
      escrowVault: escrowVaultAddress(program.programId),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      programData: programDataAddress(program.programId),
    })
    .instruction();
}

/** Params and settler. `args.newAdmin` only proposes: the new admin signs `acceptAdminIx`. */
export async function updateConfigIx(
  program: ThesisProgram,
  p: { admin: PublicKey; args: UpdateConfigArgs },
): Promise<TransactionInstruction> {
  return program.methods
    .updateConfig(p.args)
    .accountsPartial({ admin: p.admin, config: configAddress(program.programId) })
    .instruction();
}

/** The proposed admin takes over (second step of the hand-over, security review L-2). */
export async function acceptAdminIx(program: ThesisProgram, p: { newAdmin: PublicKey }): Promise<TransactionInstruction> {
  return program.methods.acceptAdmin().accountsPartial({ newAdmin: p.newAdmin, config: configAddress(program.programId) }).instruction();
}

/**
 * The allowlist admin's instruction (security review M-2): replaces the programs a trade may
 * call, and/or proposes its own successor, who signs `acceptAllowlistAdminIx`.
 */
export async function updateAllowlistIx(
  program: ThesisProgram,
  p: { allowlistAdmin: PublicKey; tradePrograms?: PublicKey[]; newAllowlistAdmin?: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .updateAllowlist({ newTradePrograms: p.tradePrograms ?? null, newAllowlistAdmin: p.newAllowlistAdmin ?? null })
    .accountsPartial({ allowlistAdmin: p.allowlistAdmin, config: configAddress(program.programId) })
    .instruction();
}

export async function acceptAllowlistAdminIx(program: ThesisProgram, p: { newAllowlistAdmin: PublicKey }): Promise<TransactionInstruction> {
  return program.methods
    .acceptAllowlistAdmin()
    .accountsPartial({ newAllowlistAdmin: p.newAllowlistAdmin, config: configAddress(program.programId) })
    .instruction();
}

export async function withdrawFeesIx(
  program: ThesisProgram,
  p: { admin: PublicKey; destination: PublicKey; amount: BN; usdcMint?: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .withdrawFees(p.amount)
    .accountsPartial({
      admin: p.admin,
      config: configAddress(program.programId),
      feeVault: feeVaultAddress(program.programId),
      destination: p.destination,
      usdcMint: usdc(p.usdcMint),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export async function createTakeIx(
  program: ThesisProgram,
  p: {
    author: PublicKey;
    payer?: PublicKey;
    id: U64;
    claimHash: number[];
    risk: Risk;
    horizonEnd: BN;
    legs: LegSpec[];
    stake: BN;
    /** Legs the author's buy-in bought (bit i = leg i), as on a back. */
    legsMask: number;
    usdcMint?: PublicKey;
    /** Output accounts of the legs bought in this (the trade's last) transaction, in leg order. */
    outputs?: PublicKey[];
  },
): Promise<TransactionInstruction> {
  const mint = usdc(p.usdcMint);
  const take = takeAddress(p.author, p.id, program.programId);
  const position = authorPositionAddress(take, p.author, program.programId);
  return program.methods
    .createTake({
      id: new BN(p.id.toString()),
      claimHash: p.claimHash,
      risk: p.risk,
      horizonEnd: p.horizonEnd,
      legs: p.legs,
      stake: p.stake,
      legsMask: p.legsMask,
    })
    .accountsPartial({
      author: p.author,
      payer: p.payer ?? p.author,
      config: configAddress(program.programId),
      authorProfile: profileAddress(p.author, program.programId),
      take,
      authorPosition: position,
      authorUsdc: ata(mint, p.author),
      feeVault: feeVaultAddress(program.programId),
      usdcMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      ticket: ticketAddress(p.author, position, program.programId),
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      escrowVault: escrowVaultAddress(program.programId),
    })
    .remainingAccounts(readonly(p.outputs))
    .instruction();
}

type OpenPositionParams = {
  owner: PublicKey;
  payer?: PublicKey;
  take: PublicKey;
  /** Any value except 0, which is the author's buy-in. */
  id: U64;
  stake: BN;
  legsMask: number;
  usdcMint?: PublicKey;
  /** Output accounts of the legs bought in this (the trade's last) transaction, in leg order. */
  outputs?: PublicKey[];
};

function openPositionAccounts(program: ThesisProgram, p: OpenPositionParams) {
  const mint = usdc(p.usdcMint);
  const position = positionAddress(p.take, p.owner, p.id, program.programId);
  return {
    owner: p.owner,
    payer: p.payer ?? p.owner,
    config: configAddress(program.programId),
    take: p.take,
    ownerProfile: profileAddress(p.owner, program.programId),
    position,
    ownerUsdc: ata(mint, p.owner),
    feeVault: feeVaultAddress(program.programId),
    creatorVault: creatorVaultAddress(program.programId),
    usdcMint: mint,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    ticket: ticketAddress(p.owner, position, program.programId),
    instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    escrowVault: escrowVaultAddress(program.programId),
  };
}

const openPositionArgs = (p: OpenPositionParams) => ({
  id: new BN(p.id.toString()),
  stake: p.stake,
  legsMask: p.legsMask,
});

export async function backIx(
  program: ThesisProgram,
  p: OpenPositionParams,
): Promise<TransactionInstruction> {
  return program.methods
    .back(openPositionArgs(p))
    .accountsPartial(openPositionAccounts(program, p))
    .remainingAccounts(readonly(p.outputs))
    .instruction();
}

export async function fadeIx(
  program: ThesisProgram,
  p: OpenPositionParams,
): Promise<TransactionInstruction> {
  return program.methods
    .fade(openPositionArgs(p))
    .accountsPartial(openPositionAccounts(program, p))
    .remainingAccounts(readonly(p.outputs))
    .instruction();
}

type TradeParams = {
  owner: PublicKey;
  /** The position the receipt will open: `positionAddress(...)`, or for a take `authorPositionAddress(...)`. */
  position: PublicKey;
  /** Legs whose output accounts this transaction's swaps fill (bit i = leg i). */
  outputsMask: number;
  /** Those accounts, in leg order. An associated token account the swaps create may not exist yet. */
  outputs: PublicKey[];
  usdcMint?: PublicKey;
};

/**
 * First in a trade: creates the position's ticket and opens the first transaction's checks.
 * `payer` pays the ticket's rent and must also be the receipt's payer, who gets it back.
 */
export async function beginTradeIx(
  program: ThesisProgram,
  p: TradeParams & { payer?: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .beginTrade({ outputsMask: p.outputsMask })
    .accountsPartial({
      owner: p.owner,
      payer: p.payer ?? p.owner,
      config: configAddress(program.programId),
      position: p.position,
      ticket: ticketAddress(p.owner, p.position, program.programId),
      ownerUsdc: ata(usdc(p.usdcMint), p.owner),
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(readonly(p.outputs))
    .instruction();
}

/**
 * A trade split over several transactions: `open: true` first in each transaction but the first,
 * `open: false` last in each but the last. A closing step names the same outputs as its opening.
 */
export async function tradeStepIx(
  program: ThesisProgram,
  p: TradeParams & { open: boolean },
): Promise<TransactionInstruction> {
  return program.methods
    .tradeStep({ open: p.open, outputsMask: p.outputsMask })
    .accountsPartial({
      owner: p.owner,
      config: configAddress(program.programId),
      ticket: ticketAddress(p.owner, p.position, program.programId),
      ownerUsdc: ata(usdc(p.usdcMint), p.owner),
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .remainingAccounts(readonly(p.outputs))
    .instruction();
}

/** Closes the ticket of a trade that was abandoned partway, refunding its rent to `rentPayer`. */
export async function cancelTradeIx(
  program: ThesisProgram,
  p: { owner: PublicKey; position: PublicKey; rentPayer: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .cancelTrade()
    .accountsPartial({
      owner: p.owner,
      ticket: ticketAddress(p.owner, p.position, program.programId),
      rentPayer: p.rentPayer,
    })
    .instruction();
}

export async function claimCreatorFeesIx(
  program: ThesisProgram,
  p: { author: PublicKey; take: PublicKey; usdcMint?: PublicKey },
): Promise<TransactionInstruction> {
  const mint = usdc(p.usdcMint);
  return program.methods
    .claimCreatorFees()
    .accountsPartial({
      author: p.author,
      config: configAddress(program.programId),
      take: p.take,
      creatorVault: creatorVaultAddress(program.programId),
      authorUsdc: ata(mint, p.author),
      usdcMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

type RecordPricesParams = {
  /** Must be the config's settler; it signs the transaction. */
  settler: PublicKey;
  take: PublicKey;
  position: PublicKey;
  prices: LegPrice[];
  /** sha256 of the market data the prices came from, kept in the event for audits. */
  sourceHash: number[];
};

function recordPricesAccounts(program: ThesisProgram, p: RecordPricesParams) {
  return {
    settler: p.settler,
    config: configAddress(program.programId),
    take: p.take,
    position: p.position,
  };
}

/** Entry prices for the token this position's owner bought, at or after the trade. */
export async function recordEntryPricesIx(
  program: ThesisProgram,
  p: RecordPricesParams,
): Promise<TransactionInstruction> {
  return program.methods
    .recordEntryPrices({ prices: p.prices, sourceHash: p.sourceHash })
    .accountsPartial(recordPricesAccounts(program, p))
    .instruction();
}

/** Exit prices for this position, at or after the take's horizon end. */
export async function recordExitPricesIx(
  program: ThesisProgram,
  p: RecordPricesParams,
): Promise<TransactionInstruction> {
  return program.methods
    .recordExitPrices({ prices: p.prices, sourceHash: p.sourceHash })
    .accountsPartial(recordPricesAccounts(program, p))
    .instruction();
}

/** Sale prices for a position its owner sold, at or after the sale. */
export async function recordSalePricesIx(
  program: ThesisProgram,
  p: RecordPricesParams,
): Promise<TransactionInstruction> {
  return program.methods
    .recordSalePrices({ prices: p.prices, sourceHash: p.sourceHash })
    .accountsPartial({ ...recordPricesAccounts(program, p), exit: exitAddress(p.position, program.programId) })
    .instruction();
}

/**
 * Records that the owner sold the whole position, before the horizon, and pays its escrowed
 * prediction and card share back to the owner's USDC account. Goes in the same transaction as the owner's
 * swaps back to USDC. `payer` pays the exit account's rent and gets it back at settlement.
 */
export async function exitPositionIx(
  program: ThesisProgram,
  p: { owner: PublicKey; take: PublicKey; position: PublicKey; payer?: PublicKey; usdcMint?: PublicKey },
): Promise<TransactionInstruction> {
  const mint = usdc(p.usdcMint);
  return program.methods
    .exitPosition()
    .accountsPartial({
      owner: p.owner,
      payer: p.payer ?? p.owner,
      take: p.take,
      position: p.position,
      exit: exitAddress(p.position, program.programId),
      systemProgram: SystemProgram.programId,
      config: configAddress(program.programId),
      escrowVault: escrowVaultAddress(program.programId),
      ownerUsdc: ata(mint, p.owner),
      usdcMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export async function settleTakeIx(
  program: ThesisProgram,
  p: { take: PublicKey; author: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .settleTake()
    .accountsPartial({
      config: configAddress(program.programId),
      take: p.take,
      authorPosition: authorPositionAddress(p.take, p.author, program.programId),
      authorProfile: profileAddress(p.author, program.programId),
    })
    .instruction();
}

/**
 * Closes the position; its rent goes back to `rentPayer` (read it from the position account).
 * For a sold position, pass `exitRentPayer` from its exit account: the exit closes with it.
 * Any escrowed prediction or card share goes back to the owner's USDC account (its associated account).
 */
export async function settlePositionIx(
  program: ThesisProgram,
  p: { take: PublicKey; position: PublicKey; owner: PublicKey; rentPayer: PublicKey; exitRentPayer?: PublicKey; usdcMint?: PublicKey },
): Promise<TransactionInstruction> {
  const mint = usdc(p.usdcMint);
  return program.methods
    .settlePosition()
    .accountsPartial({
      config: configAddress(program.programId),
      take: p.take,
      position: p.position,
      ownerProfile: profileAddress(p.owner, program.programId),
      rentPayer: p.rentPayer,
      exit: p.exitRentPayer ? exitAddress(p.position, program.programId) : p.rentPayer,
      exitRentPayer: p.exitRentPayer ?? p.rentPayer,
      escrowVault: escrowVaultAddress(program.programId),
      ownerUsdc: ata(mint, p.owner),
      usdcMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/** Mints one catalog badge to `owner`, if their profile has earned it. */
export async function mintBadgeIx(
  program: ThesisProgram,
  p: { payer: PublicKey; owner: PublicKey; kind: BadgeKindName },
): Promise<TransactionInstruction> {
  const badgeMint = badgeMintAddress(p.owner, BADGE_KIND_INDEX[p.kind], program.programId);
  return program.methods
    .mintBadge(BADGE_KIND[p.kind])
    .accountsPartial({
      payer: p.payer,
      config: configAddress(program.programId),
      owner: p.owner,
      ownerProfile: profileAddress(p.owner, program.programId),
      badgeMint,
      ownerBadgeAccount: getAssociatedTokenAddressSync(
        badgeMint,
        p.owner,
        true,
        TOKEN_2022_PROGRAM_ID,
      ),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}
