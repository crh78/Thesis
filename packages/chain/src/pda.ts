import { PublicKey } from "@solana/web3.js";
import { SEEDS, THESIS_PROGRAM_ID, AUTHOR_POSITION_ID } from "./constants.ts";

export type U64 = bigint | number;

function u64le(value: U64): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function pda(seeds: Buffer[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

/** Anchor's event authority: the PDA that signs the program's self-CPI events (`emit_cpi!`). */
export function eventAuthorityAddress(programId = THESIS_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], programId)[0];
}

export function configAddress(programId = THESIS_PROGRAM_ID): PublicKey {
  return pda([SEEDS.config], programId);
}

export function feeVaultAddress(programId = THESIS_PROGRAM_ID): PublicKey {
  return pda([SEEDS.feeVault], programId);
}

/** Holds creator fees until authors claim them. */
/** Holds each position's prediction and card share (paper-filled Gemini and Collector Crypt legs) until it settles. */
export function escrowVaultAddress(programId = THESIS_PROGRAM_ID): PublicKey {
  return pda([SEEDS.escrowVault], programId);
}

export function creatorVaultAddress(programId = THESIS_PROGRAM_ID): PublicKey {
  return pda([SEEDS.creatorVault], programId);
}

export function profileAddress(owner: PublicKey, programId = THESIS_PROGRAM_ID): PublicKey {
  return pda([SEEDS.profile, owner.toBuffer()], programId);
}

export function takeAddress(author: PublicKey, id: U64, programId = THESIS_PROGRAM_ID): PublicKey {
  return pda([SEEDS.take, author.toBuffer(), u64le(id)], programId);
}

export function positionAddress(
  take: PublicKey,
  owner: PublicKey,
  id: U64,
  programId = THESIS_PROGRAM_ID,
): PublicKey {
  return pda([SEEDS.position, take.toBuffer(), owner.toBuffer(), u64le(id)], programId);
}

/** The author's buy-in position, created with the take. */
export function authorPositionAddress(
  take: PublicKey,
  author: PublicKey,
  programId = THESIS_PROGRAM_ID,
): PublicKey {
  return positionAddress(take, author, AUTHOR_POSITION_ID, programId);
}

/** Where a sold position's exit lives (sale time and sale prices). Exists only once it's sold. */
export function exitAddress(position: PublicKey, programId = THESIS_PROGRAM_ID): PublicKey {
  return pda([SEEDS.exit, position.toBuffer()], programId);
}

/**
 * A trade's proof-of-trade ticket, for the position it will open (for a take, the author's buy-in
 * position). Exists only while the trade runs: `begin_trade` creates it, the receipt closes it.
 */
export function ticketAddress(owner: PublicKey, position: PublicKey, programId = THESIS_PROGRAM_ID): PublicKey {
  return pda([SEEDS.ticket, owner.toBuffer(), position.toBuffer()], programId);
}

/** The upgradeable loader, which owns each program's ProgramData account. */
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"); // ggignore

/** The program's ProgramData account: `init_config` checks its upgrade authority is the admin. */
export function programDataAddress(programId = THESIS_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_ID)[0];
}

/** The mint for one badge from the catalog, earned once per user. `kind` is the BadgeKind index. */
export function badgeMintAddress(
  owner: PublicKey,
  kind: number,
  programId = THESIS_PROGRAM_ID,
): PublicKey {
  return pda([SEEDS.badge, owner.toBuffer(), Buffer.from([kind])], programId);
}
