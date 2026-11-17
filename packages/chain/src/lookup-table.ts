// The Thesis address lookup table: accounts every Thesis transaction touches, so each costs one
// byte instead of 32. Created once per deployment (the fork creates its own in `fork:up`).
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AddressLookupTableProgram, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY, type TransactionInstruction } from "@solana/web3.js";
import { THESIS_PROGRAM_ID, USDC_MINT_MAINNET } from "./constants.ts";
import { configAddress, creatorVaultAddress, escrowVaultAddress, eventAuthorityAddress, feeVaultAddress } from "./pda.ts";

/** What goes in the table. Programs that a transaction invokes directly can't be looked up, so only ones passed as accounts are here. */
export function thesisLookupTableAddresses(programId = THESIS_PROGRAM_ID, usdcMint = USDC_MINT_MAINNET): PublicKey[] {
  return [
    configAddress(programId),
    feeVaultAddress(programId),
    creatorVaultAddress(programId),
    escrowVaultAddress(programId),
    usdcMint,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    SYSVAR_RENT_PUBKEY,
    // Proof of trade: begin_trade, trade_step and every receipt read it.
    SYSVAR_INSTRUCTIONS_PUBKEY,
    // Every instruction that emits an event (`emit_cpi!`) passes it. Last, so a table made
    // before it only needs extending.
    eventAuthorityAddress(programId),
  ];
}

/** Create + extend instructions for the table. `recentSlot` must be a recent finalized-or-confirmed slot. */
export function createThesisLookupTableIxs(o: {
  authority: PublicKey;
  payer: PublicKey;
  recentSlot: number;
  programId?: PublicKey;
  usdcMint?: PublicKey;
}): { address: PublicKey; instructions: TransactionInstruction[] } {
  const [create, address] = AddressLookupTableProgram.createLookupTable({ authority: o.authority, payer: o.payer, recentSlot: o.recentSlot });
  const extend = AddressLookupTableProgram.extendLookupTable({
    lookupTable: address,
    authority: o.authority,
    payer: o.payer,
    addresses: thesisLookupTableAddresses(o.programId, o.usdcMint),
  });
  return { address, instructions: [create, extend] };
}
