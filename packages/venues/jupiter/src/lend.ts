// Jupiter Lend Earn: the yield leg of a low-risk take. The user's USDC goes into the jlUSDC
// vault from their own wallet; they hold jlUSDC, which grows as the vault earns.
//
// Selling a position redeems its jlUSDC shares back to USDC (`redeem-instructions`).
//
// Earn's `deposit-instructions` expects the user's jlUSDC account to exist, so this adds an
// idempotent create for it, paid by `payer` (the app for Privy users) like the swap legs.
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM, JUPITER_TIMEOUT_MS, TOKEN_PROGRAM, USDC_MINT, associatedTokenAddress, jupiterPost, toInstruction, type FetchFn, type VenueLeg } from "./index.ts";

/** jlUSDC, Jupiter Lend's USDC vault share (SPL Token). */
export const JL_USDC_MINT = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";

export type LendDeposit = VenueLeg & { asset: string; shareMint: string; amount: bigint };

type JupIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };

export function createAtaIdempotent(payer: PublicKey, owner: PublicKey, mint: string, tokenProgram = TOKEN_PROGRAM): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(associatedTokenAddress(owner, mint, tokenProgram)), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(tokenProgram), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

/** Everything a Lend response touches except the user's own wallet and token accounts. */
function lendMarketAccounts(res: { instructions: JupIx[] }, user: PublicKey, payer: PublicKey, shareMint: string): PublicKey[] {
  const own = new Set([
    user.toBase58(),
    payer.toBase58(),
    associatedTokenAddress(user, USDC_MINT, TOKEN_PROGRAM),
    associatedTokenAddress(user, shareMint, TOKEN_PROGRAM),
  ]);
  return res.instructions.flatMap((ix) => ix.accounts).filter((a) => !a.isSigner && !own.has(a.pubkey)).map((a) => new PublicKey(a.pubkey));
}

/** The leg's instructions from a `deposit-instructions` response. Pure, for tests. */
export function depositInstructions(res: { instructions: JupIx[] }, user: PublicKey, payer: PublicKey, amount: bigint, label: string, shareMint = JL_USDC_MINT): LendDeposit {
  if (!res?.instructions?.length) throw new Error("Jupiter Lend returned no deposit instructions");
  const deposit = res.instructions.map(toInstruction);
  return {
    label,
    instructions: [createAtaIdempotent(payer, user, shareMint), ...deposit],
    lookupTables: [],
    marketAccounts: lendMarketAccounts(res, user, payer, shareMint),
    outputAccount: new PublicKey(associatedTokenAddress(user, shareMint, TOKEN_PROGRAM)),
    asset: USDC_MINT,
    shareMint,
    amount,
  };
}

/** Calls `/lend/v1/earn/deposit-instructions` for a USDC deposit from `user`. Needs an API key. */
export async function jupiterLendDeposit(o: { user: PublicKey; payer: PublicKey; amount: bigint; label: string; apiKey: string; fetchFn?: FetchFn }): Promise<LendDeposit> {
  const body = { asset: USDC_MINT, amount: o.amount.toString(), signer: o.user.toBase58() };
  const r = await jupiterPost("https://api.jup.ag/lend/v1/earn/deposit-instructions", body, o.apiKey, o.fetchFn);
  if (!r.ok) throw new Error(`Jupiter Lend deposit-instructions HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
  return depositInstructions(r.json as { instructions: JupIx[] }, o.user, o.payer, o.amount, o.label);
}

/** Redeems `shares` jlUSDC back to USDC, from a `redeem-instructions` response. Pure, for tests. */
export function redeemInstructions(res: { instructions: JupIx[] }, user: PublicKey, payer: PublicKey, shares: bigint, label: string, shareMint = JL_USDC_MINT): LendDeposit {
  if (!res?.instructions?.length) throw new Error("Jupiter Lend returned no redeem instructions");
  return {
    label,
    instructions: res.instructions.map(toInstruction),
    lookupTables: [],
    marketAccounts: lendMarketAccounts(res, user, payer, shareMint),
    asset: USDC_MINT,
    shareMint,
    amount: shares,
  };
}

/** Calls `/lend/v1/earn/redeem-instructions` to turn `user`'s jlUSDC shares back into USDC. Needs an API key. */
export async function jupiterLendRedeem(o: { user: PublicKey; payer: PublicKey; shares: bigint; label: string; apiKey: string; fetchFn?: FetchFn }): Promise<LendDeposit> {
  const body = { asset: USDC_MINT, shares: o.shares.toString(), signer: o.user.toBase58() };
  const r = await jupiterPost("https://api.jup.ag/lend/v1/earn/redeem-instructions", body, o.apiKey, o.fetchFn);
  if (!r.ok) throw new Error(`Jupiter Lend redeem-instructions HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
  return redeemInstructions(r.json as { instructions: JupIx[] }, o.user, o.payer, o.shares, o.label);
}

/**
 * The accounts every jlUSDC deposit and redeem touches apart from the user's own (the vault, its
 * liquidity and rate accounts, ...), read from both endpoints with a throwaway signer. They go in
 * the Thesis lookup table so a Lend leg costs one byte per account instead of 32: without that, a
 * redeem plus a receipt is ~940 bytes and a sale with a swap leg doesn't fit in one transaction.
 */
export async function jupiterLendAccounts(o: { apiKey: string; fetchFn?: FetchFn }): Promise<PublicKey[]> {
  const user = Keypair.generate().publicKey;
  const [deposit, redeem] = await Promise.all([
    jupiterLendDeposit({ user, payer: user, amount: 1_000_000n, label: "probe", apiKey: o.apiKey, fetchFn: o.fetchFn }),
    jupiterLendRedeem({ user, payer: user, shares: 1_000_000n, label: "probe", apiKey: o.apiKey, fetchFn: o.fetchFn }),
  ]);
  const seen = new Map<string, PublicKey>();
  for (const key of [...deposit.marketAccounts, ...redeem.marketAccounts]) seen.set(key.toBase58(), key);
  return [...seen.values()];
}

/** One vault share's value, read from Jupiter Lend Earn's token list. */
export type ShareValue = { shareMint: string; usdcPerShare: number; raw: { totalAssets: string; totalSupply: string; convertToAssets?: string } };

/**
 * What one share of a Jupiter Lend Earn vault (jlUSDC) is worth in its asset now:
 * `totalAssets / totalSupply`, both in base units with the same decimals, so it's exact, unlike
 * the rounded `convertToAssets`. A yield leg is priced on this (yield counts
 * in the score): its return is the interest the share earned. Null if the vault isn't listed.
 */
export async function jupiterLendShareValue(shareMint: string, o: { apiKey?: string | null; fetchFn?: FetchFn } = {}): Promise<ShareValue | null> {
  const base = o.apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag";
  const r = await (o.fetchFn ?? fetch)(`${base}/lend/v1/earn/tokens`, { headers: o.apiKey ? { "x-api-key": o.apiKey } : {}, signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Jupiter Lend tokens: HTTP ${r.status}`);
  const list = (await r.json()) as { address?: string; totalAssets?: string; totalSupply?: string; convertToAssets?: string }[];
  const t = list.find((x) => x.address === shareMint);
  if (!t?.totalAssets || !t.totalSupply || BigInt(t.totalSupply) === 0n) return null;
  // Exact to 12 places: shares rarely move more than a few millionths a day.
  const scaled = (BigInt(t.totalAssets) * 10n ** 12n) / BigInt(t.totalSupply);
  return { shareMint, usdcPerShare: Number(scaled) / 1e12, raw: { totalAssets: t.totalAssets, totalSupply: t.totalSupply, convertToAssets: t.convertToAssets } };
}
