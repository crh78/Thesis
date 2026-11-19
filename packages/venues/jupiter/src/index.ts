// Jupiter adapter: turns a bank-chosen quote (bestIssuer in ../../bank) into the instructions
// that buy one spot leg from the user's own wallet, ready to sit next to the Thesis receipt.
//
// - Jupiter's compute-budget instructions are dropped: the transaction composer sets one limit
//   for everything it packs together.
// - Token-account creation is re-pointed at `payer` (the app's fee payer for Privy users), so
//   users never need SOL. The account and its owner don't change; only who pays the rent.
// - The user's USDC account is never created here: they already hold USDC to spend.
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { JupQuote, QuoteFn } from "../../bank/src/jupiter.ts";

// Public mainnet addresses, not secrets.
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // ggignore
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"; // ggignore
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // ggignore
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"; // ggignore

export function associatedTokenAddress(owner: PublicKey, mint: string, tokenProgram: string): string {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  )[0].toBase58();
}

type JupIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };

export type JupSwapInstructions = {
  computeBudgetInstructions?: JupIx[];
  setupInstructions: JupIx[];
  swapInstruction: JupIx;
  cleanupInstruction?: JupIx | null;
  otherInstructions?: JupIx[];
  addressLookupTableAddresses: string[];
  error?: string;
};

/** One venue leg: what the composer packs into a transaction. */
export type VenueLeg = {
  label: string;
  instructions: TransactionInstruction[];
  lookupTables: PublicKey[];
  /** Accounts the swap reads from the market (pools, oracles): the fork refreshes these before sending. */
  marketAccounts: PublicKey[];
  /**
   * The user's token account this leg fills (the bought token's or jlUSDC's), for the Thesis
   * receipt's proof of trade. Absent for legs that leave no token with the user (sales).
   */
  outputAccount?: PublicKey;
};

export type JupiterBuy = VenueLeg & {
  mint: string;
  inUsdc: bigint;
  /** Jupiter's expected output in the token's base units, and the minimum after slippage. */
  outAmount: bigint;
  minOutAmount: bigint;
};

export function toInstruction(ix: JupIx): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });
}

/** An ATA-program create: accounts are [payer, ata, owner, mint, system program, token program]. */
const isAtaCreate = (ix: JupIx) => ix.programId === ASSOCIATED_TOKEN_PROGRAM;

/**
 * The instructions for one leg, from a `/swap-instructions` response. Pure, so it's unit-tested
 * on recorded responses.
 */
export function buyInstructions(
  res: JupSwapInstructions,
  quote: Pick<JupQuote, "inAmount" | "outAmount" | "otherAmountThreshold"> & { outputMint: string; inputMint?: string },
  user: PublicKey,
  payer: PublicKey,
  label: string,
): JupiterBuy {
  if (res.error) throw new Error(`Jupiter swap-instructions: ${res.error}`);
  const out: TransactionInstruction[] = [];
  for (const raw of res.setupInstructions) {
    if (isAtaCreate(raw)) {
      if (raw.accounts[3]?.pubkey === USDC_MINT) continue;
      const ix = toInstruction(raw);
      ix.keys[0] = { pubkey: payer, isSigner: true, isWritable: true };
      out.push(ix);
    } else {
      out.push(toInstruction(raw));
    }
  }
  out.push(toInstruction(res.swapInstruction));
  if (res.cleanupInstruction) out.push(toInstruction(res.cleanupInstruction));

  // Everything the swap touches except the user's own accounts: on the fork these are re-fetched
  // from mainnet before sending, while the user's wallet and token accounts only exist on the fork.
  const own = new Set([user.toBase58(), payer.toBase58()]);
  for (const mint of [USDC_MINT, String(quote.inputMint ?? USDC_MINT), String(quote.outputMint)]) {
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) own.add(associatedTokenAddress(user, mint, program));
  }
  for (const raw of res.setupInstructions) if (isAtaCreate(raw)) own.add(raw.accounts[1].pubkey);
  const market = res.swapInstruction.accounts.filter((a) => !a.isSigner && !own.has(a.pubkey)).map((a) => new PublicKey(a.pubkey));
  // The swap's destination: the user's associated account for the output mint, under whichever
  // token program the swap names it (xStocks are Token-2022).
  const swapKeys = new Set(res.swapInstruction.accounts.map((a) => a.pubkey));
  const outputAccount = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]
    .map((program) => associatedTokenAddress(user, String(quote.outputMint), program))
    .find((ata) => swapKeys.has(ata));
  return {
    label,
    instructions: out,
    lookupTables: res.addressLookupTableAddresses.map((k) => new PublicKey(k)),
    marketAccounts: market,
    outputAccount: outputAccount ? new PublicKey(outputAccount) : undefined,
    mint: String(quote.outputMint),
    inUsdc: BigInt(quote.inAmount),
    outAmount: BigInt(quote.outAmount),
    minOutAmount: BigInt(quote.otherAmountThreshold),
  };
}

export type FetchFn = typeof fetch;

/**
 * Calls a Jupiter endpoint and returns its JSON. On a 429 it waits until the window resets
 * (`x-ratelimit-reset`, unix seconds) rather than backing off blindly, so parallel legs that hit
 * the limit together all go again as soon as they can.
 *
 * Each request gives up after JUPITER_TIMEOUT_MS, and the waits on 429s add up to at most
 * `max429WaitMs` (default JUPITER_MAX_429_WAIT_MS): past that the 429 is returned, so a build
 * fails instead of hanging. 0 returns the first 429 at once (callers that would rather fail fast).
 */
export async function jupiterRequest(
  url: string,
  init: { method: "GET" } | { method: "POST"; body: unknown },
  apiKey: string | null | undefined,
  fetchFn: FetchFn = fetch,
  max429WaitMs = JUPITER_MAX_429_WAIT_MS,
): Promise<{ status: number; ok: boolean; json: any }> {
  const headers: Record<string, string> = init.method === "POST" ? { "content-type": "application/json" } : {};
  if (apiKey) headers["x-api-key"] = apiKey;
  const body = init.method === "POST" ? JSON.stringify(init.body) : undefined;
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const r = await fetchFn(url, { method: init.method, headers, body, signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS) });
    if (r.status === 429 && attempt < 5) {
      const reset = Number(r.headers?.get?.("x-ratelimit-reset"));
      const untilReset = Number.isFinite(reset) && reset > 0 ? reset * 1000 - Date.now() + 250 : 0;
      const wait = untilReset > 0 ? Math.min(untilReset, 15_000) : 1_000 * 2 ** attempt;
      if (waited + wait <= max429WaitMs) {
        waited += wait;
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
    }
    return { status: r.status, ok: r.ok, json: await r.json().catch(() => null) };
  }
}

/** POSTs JSON to a Jupiter endpoint (jupiterRequest). */
export function jupiterPost(url: string, body: unknown, apiKey: string | null | undefined, fetchFn: FetchFn = fetch, max429WaitMs = JUPITER_MAX_429_WAIT_MS) {
  return jupiterRequest(url, { method: "POST", body }, apiKey, fetchFn, max429WaitMs);
}

/** How long one Jupiter request may take before it's abandoned. */
export const JUPITER_TIMEOUT_MS = 15_000;
/** The most one Jupiter call waits out 429s in total before giving up (by default). */
export const JUPITER_MAX_429_WAIT_MS = 20_000;

const jupiterBase = (apiKey: string | null | undefined) => (apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag");

/** How a caller reaches Jupiter: its key, the fetch to use (a rate budget's) and how long it may wait out 429s. */
export type JupiterAccess = { apiKey?: string | null; fetchFn?: FetchFn; max429WaitMs?: number };

/**
 * An exact-in `/swap/v1/quote`, answered like the bank's JupiterClient.quoteExactIn: a quote, or
 * null with Jupiter's reason (no route: its error code; Jupiter failing, a 429 or a 5xx:
 * `HTTP <status>`). Throws only when the request itself fails (timeout, no connection, a budget
 * that refuses it).
 */
export async function jupiterQuote(
  o: JupiterAccess & { inputMint?: string; outputMint: string; amount: bigint; maxAccounts: number; slippageBps?: number; dexes?: string[] },
): Promise<{ quote: JupQuote | null; error: string | null }> {
  let qs = `inputMint=${o.inputMint ?? USDC_MINT}&outputMint=${o.outputMint}&amount=${o.amount}&slippageBps=${o.slippageBps ?? 100}&maxAccounts=${o.maxAccounts}`;
  if (o.dexes?.length) qs += `&dexes=${encodeURIComponent(o.dexes.join(","))}`;
  const r = await jupiterRequest(`${jupiterBase(o.apiKey)}/swap/v1/quote?${qs}`, { method: "GET" }, o.apiKey, o.fetchFn, o.max429WaitMs);
  const j = r.json;
  if (r.status === 200 && j?.outAmount && j.routePlan?.length) return { quote: j as JupQuote, error: null };
  // Jupiter says "no route" with a 400 or 404 (or an empty 200); anything else is it failing.
  const noRoute = r.status === 200 || r.status === 400 || r.status === 404;
  return { quote: null, error: noRoute ? String(j?.errorCode ?? j?.error ?? (r.status === 200 ? "empty route" : `HTTP ${r.status}`)) : `HTTP ${r.status}` };
}

/** A USDC-in quote function for bestIssuer (its `quote` option), through `access`. */
export function quoteFn(access: JupiterAccess): QuoteFn {
  return (outputMint, usd, o) => jupiterQuote({ ...access, outputMint, amount: BigInt(Math.round(usd * 1e6)), ...o });
}

/** Calls `/swap/v1/swap-instructions` for a quote: Jupiter's raw answer, for buyInstructions or a swap template. */
export async function jupiterSwapInstructions(o: JupiterAccess & { quote: JupQuote; user: PublicKey }): Promise<JupSwapInstructions> {
  const body = {
    quoteResponse: o.quote,
    userPublicKey: o.user.toBase58(),
    wrapAndUnwrapSol: false, // the input is USDC
    dynamicComputeUnitLimit: false, // the composer sets one limit per transaction
  };
  const r = await jupiterPost(`${jupiterBase(o.apiKey)}/swap/v1/swap-instructions`, body, o.apiKey, o.fetchFn, o.max429WaitMs);
  if (!r.ok) throw new Error(`Jupiter swap-instructions HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json as JupSwapInstructions;
}

/** Calls `/swap/v1/swap-instructions` for a quote and returns the leg's instructions. */
export async function jupiterBuy(o: JupiterAccess & { quote: JupQuote; user: PublicKey; payer: PublicKey; label: string }): Promise<JupiterBuy> {
  const res = await jupiterSwapInstructions(o);
  return buyInstructions(res, o.quote as JupQuote & { outputMint: string; inputMint?: string }, o.user, o.payer, o.label);
}

/**
 * USDC per leg for a stake split by weight. Rounds down per leg and gives the remainder to the
 * largest leg, so the parts always add up to the stake.
 */
export function splitStake(stake: bigint, weightsBps: number[]): bigint[] {
  const total = BigInt(weightsBps.reduce((a, b) => a + b, 0));
  if (total === 0n) throw new Error("no weight to split across");
  const parts = weightsBps.map((w) => (stake * BigInt(w)) / total);
  const rest = stake - parts.reduce((a, b) => a + b, 0n);
  const biggest = weightsBps.indexOf(Math.max(...weightsBps));
  parts[biggest] += rest;
  return parts;
}

export * from "./lend.ts";
export * from "./template.ts";
export * from "./scale.ts";
