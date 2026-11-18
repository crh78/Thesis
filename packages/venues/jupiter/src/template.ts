// Shared swap templates: one `/swap-instructions` answer reused for every wallet that makes the
// same swap (the same quote). On the fork nobody's wallet exists on mainnet, where Jupiter builds
// the instructions, so two wallets' answers for one quote differ only in the wallet and its own
// token accounts. A template is the answer with those replaced by a placeholder owner; `retarget`
// puts another wallet back in. Pure, so it's unit-tested on recorded answers.
//
// An answer is shared only when it provably doesn't depend on the wallet beyond that (see
// `unshareable`): the wallet is its only signer, every token account the swap fills is created
// (idempotently) in its own setup, so the answer doesn't hinge on which accounts the wallet has,
// and no instruction carries the wallet's addresses in its data. The amounts are the quote's, so a
// template serves only the same quote: the same leg of the same stake.
import { PublicKey } from "@solana/web3.js";
import type { JupQuote } from "../../bank/src/jupiter.ts";
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, associatedTokenAddress, buyInstructions, type JupSwapInstructions, type JupiterBuy } from "./index.ts";

type JupIx = JupSwapInstructions["swapInstruction"];
type RouteQuote = Pick<JupQuote, "inAmount" | "outAmount" | "otherAmountThreshold"> & {
  outputMint: string;
  inputMint?: string;
  routePlan?: { swapInfo?: { inputMint?: string; outputMint?: string } }[];
};

/** One wallet's swap: Jupiter's answer and the quote it was built from. */
export type SwapLeg = { res: JupSwapInstructions & { tokenLedgerInstruction?: JupIx | null }; quote: RouteQuote };
/** A swap with the wallet replaced by TEMPLATE_OWNER (swapTemplate), ready for fromTemplate. */
export type SwapTemplate = SwapLeg & { template: true };

/** The placeholder wallet in a template: not a key anyone holds, and no program's address. */
export const TEMPLATE_OWNER = new PublicKey(Buffer.from("thesis swap template owner......"));

/** Every mint the quote's route passes through: the wallet may hold an account for each. */
export function routeMints(quote: RouteQuote): string[] {
  const mints = new Set([USDC_MINT, quote.inputMint ?? USDC_MINT, quote.outputMint]);
  for (const hop of quote.routePlan ?? []) {
    if (hop.swapInfo?.inputMint) mints.add(hop.swapInfo.inputMint);
    if (hop.swapInfo?.outputMint) mints.add(hop.swapInfo.outputMint);
  }
  return [...mints];
}

/** `owner` and its associated token accounts for the route's mints (both token programs), mapped to `to`'s. */
function ownAccounts(owner: PublicKey, to: PublicKey, quote: RouteQuote): Map<string, string> {
  const map = new Map([[owner.toBase58(), to.toBase58()]]);
  for (const mint of routeMints(quote)) {
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) map.set(associatedTokenAddress(owner, mint, program), associatedTokenAddress(to, mint, program));
  }
  return map;
}

const instructionsOf = (res: SwapLeg["res"]): JupIx[] =>
  [...(res.computeBudgetInstructions ?? []), ...res.setupInstructions, res.swapInstruction, res.cleanupInstruction, ...(res.otherInstructions ?? []), res.tokenLedgerInstruction].filter((ix): ix is JupIx => Boolean(ix));

/**
 * The same swap for `to` instead of `from`: `from` and its associated token accounts for every
 * mint on the route become `to`'s, everywhere they're named. Data, programs and every other
 * account stay as they are. Pure.
 */
export function retarget(leg: SwapLeg, from: PublicKey, to: PublicKey): SwapLeg["res"] {
  const map = ownAccounts(from, to, leg.quote);
  const ix = (i: JupIx | null | undefined) => (i ? { ...i, accounts: i.accounts.map((a) => ({ ...a, pubkey: map.get(a.pubkey) ?? a.pubkey })) } : i);
  const res = leg.res;
  return {
    ...res,
    computeBudgetInstructions: res.computeBudgetInstructions?.map((i) => ix(i)!),
    setupInstructions: res.setupInstructions.map((i) => ix(i)!),
    swapInstruction: ix(res.swapInstruction)!,
    cleanupInstruction: ix(res.cleanupInstruction) ?? res.cleanupInstruction,
    otherInstructions: res.otherInstructions?.map((i) => ix(i)!),
    tokenLedgerInstruction: ix(res.tokenLedgerInstruction) ?? res.tokenLedgerInstruction,
    addressLookupTableAddresses: [...res.addressLookupTableAddresses],
  };
}

/** An ATA-program create: accounts are [payer, ata, owner, mint, system program, token program]. */
const isAtaCreate = (ix: JupIx) => ix.programId === ASSOCIATED_TOKEN_PROGRAM;

/** Why `owner`'s answer can't serve other wallets, or null if it can (see the header). */
export function unshareable(leg: SwapLeg, owner: PublicKey): string | null {
  const res = leg.res;
  if (res.error) return `Jupiter answered an error: ${res.error}`;
  if (res.tokenLedgerInstruction) return "it uses a token ledger";
  const me = owner.toBase58();
  const all = instructionsOf(res);
  if (all.some((ix) => ix.accounts.some((a) => a.isSigner && a.pubkey !== me))) return "another account signs";
  const own = ownAccounts(owner, owner, leg.quote);
  const ownBytes = [...own.keys()].map((k) => new PublicKey(k).toBuffer());
  if (all.some((ix) => ownBytes.some((b) => Buffer.from(ix.data, "base64").includes(b)))) return "an instruction carries the wallet's address in its data";
  // Every account of the wallet's that the swap fills must be created in the setup (idempotently),
  // whether or not the wallet has it: then the answer doesn't depend on what the wallet holds.
  const source = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((p) => associatedTokenAddress(owner, leg.quote.inputMint ?? USDC_MINT, p)));
  const created = new Set(res.setupInstructions.filter(isAtaCreate).map((ix) => ix.accounts[1]?.pubkey));
  const filled = res.swapInstruction.accounts.filter((a) => a.isWritable && own.has(a.pubkey) && a.pubkey !== me && !source.has(a.pubkey));
  const missing = filled.find((a) => !created.has(a.pubkey));
  if (missing) return `the wallet's account ${missing.pubkey} isn't created in the setup`;
  if (res.setupInstructions.some((ix) => isAtaCreate(ix) && !Buffer.from(ix.data, "base64").equals(Buffer.from([1])))) return "a token account create isn't idempotent";
  return null;
}

/** A template of `owner`'s swap, or null when it can't serve other wallets (unshareable). */
export function swapTemplate(leg: SwapLeg, owner: PublicKey): SwapTemplate | null {
  if (unshareable(leg, owner)) return null;
  return { res: retarget(leg, owner, TEMPLATE_OWNER), quote: leg.quote, template: true };
}

/** The leg's instructions for `user` from a template: buyInstructions on the retargeted answer. */
export function fromTemplate(t: SwapTemplate, user: PublicKey, payer: PublicKey, label: string): JupiterBuy {
  return buyInstructions(retarget(t, TEMPLATE_OWNER, user), t.quote, user, payer, label);
}

/**
 * Where two legs' instructions differ, byte for byte (programs, accounts with their signer and
 * writable flags, data), and their lookup tables, market and output accounts; null when they're
 * the same. For tests and the template check.
 */
export function legDiff(a: JupiterBuy, b: JupiterBuy): string | null {
  if (a.instructions.length !== b.instructions.length) return `${a.instructions.length} instructions vs ${b.instructions.length}`;
  for (const [i, x] of a.instructions.entries()) {
    const y = b.instructions[i];
    if (!x.programId.equals(y.programId)) return `instruction ${i}: program ${x.programId} vs ${y.programId}`;
    if (!x.data.equals(y.data)) return `instruction ${i}: data differs`;
    if (x.keys.length !== y.keys.length) return `instruction ${i}: ${x.keys.length} accounts vs ${y.keys.length}`;
    for (const [k, ka] of x.keys.entries()) {
      const kb = y.keys[k];
      if (!ka.pubkey.equals(kb.pubkey) || ka.isSigner !== kb.isSigner || ka.isWritable !== kb.isWritable) return `instruction ${i}, account ${k}: ${ka.pubkey} vs ${kb.pubkey}`;
    }
  }
  const keys = (l: PublicKey[]) => l.map(String).join(",");
  if (keys(a.lookupTables) !== keys(b.lookupTables)) return "lookup tables differ";
  if (keys(a.marketAccounts) !== keys(b.marketAccounts)) return "market accounts differ";
  if (String(a.outputAccount) !== String(b.outputAccount)) return `output account ${a.outputAccount} vs ${b.outputAccount}`;
  if (a.mint !== b.mint || a.inUsdc !== b.inUsdc || a.outAmount !== b.outAmount || a.minOutAmount !== b.minOutAmount) return "amounts differ";
  return null;
}
