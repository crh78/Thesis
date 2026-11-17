// Creator fees (hardening item 3): what an author earned on each of their takes, what they've
// claimed and what's left, and the claim transactions.
//
// Unclaimed is read live from the take account (creator_fees_unclaimed), and is what a claim
// moves. Claimed is the sum of creatorFeesClaimed events in the take's claim transactions. Earned
// is claimed + unclaimed: fees only enter the take through backs and fades and leave through claims, so
// that's exact, and it needs only the take's few claims rather than every back. (It also holds
// for backs from before the program's events moved to emit_cpi!, whose events a big trade's logs
// could lose past Solana's 10 KB limit.) The program pays a creator share on every back and
// fade by someone other than the author (5 of the 10 bps fee).
import { createPublicKey, verify } from "node:crypto";
import type BN from "bn.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { THESIS_COMPUTE_UNITS, USDC_MINT_MAINNET, claimCreatorFeesIx, thesisTransactionEvents, type ThesisProgram } from "@thesis/chain";
import { ApiError, USD, parseKey, type ServiceOpts } from "./common.ts";

/** Solana's packet limit for one transaction. */
const MAX_TX_BYTES = 1_232;
/** The idempotent create of the author's USDC account in the first claim transaction: 10,436 CU
 * measured on the fork even when the account exists. */
const ATA_CU = 14_000;
/** How long a signed read stays valid. */
const AUTH_WINDOW_S = 300;
const HISTORY_CACHE_MS = 60_000;
/**
 * Per claim. Like the price records, a claim costs more on a take with more legs (it reads the
 * whole take): 10,871 CU on a 4-leg take on the fork before its event became a self-CPI (about
 * 2,700 more), against THESIS_COMPUTE_UNITS' 3-leg budget. 3,500 over that budget leaves room
 * up to 10 legs; the payer pays no priority fee.
 */
const CLAIM_CU = THESIS_COMPUTE_UNITS.claimCreatorFees + 3_500;

type CreatorFeeTake = {
  take: string;
  takeId: string | null;
  claim: string | null;
  /** USDC base units, exact. */
  earned: string;
  claimed: string;
  unclaimed: string;
  earnedUsd: number;
  claimedUsd: number;
  unclaimedUsd: number;
};

/** What the wallet signs (Privy's signMessage) to read its own creator fees. */
export const creatorFeesAuthMessage = (wallet: string, at: number) => `Thesis creator fees ${wallet} ${at}`;

/**
 * Checks `x-thesis-wallet-auth: <unix seconds>.<base64 signature>`: the wallet signed
 * `creatorFeesAuthMessage` within the last 5 minutes. Accepts a signature over the message's
 * bytes or over its base64 text, since wallets differ in which they sign.
 */
export function checkWalletAuth(wallet: string, header: string | undefined, now = Math.floor(Date.now() / 1000)) {
  const [ts, sig] = (header ?? "").split(".");
  const at = Number(ts);
  if (!header || !sig || !Number.isInteger(at) || Math.abs(now - at) > AUTH_WINDOW_S) {
    throw new ApiError(401, "wallet_auth_required", "Sign in with the wallet to see its creator fees.");
  }
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), parseKey(wallet).toBuffer()]),
    format: "der",
    type: "spki",
  });
  const message = Buffer.from(creatorFeesAuthMessage(wallet, at), "utf8");
  const signature = Buffer.from(sig, "base64");
  const ok = [message, Buffer.from(message.toString("base64"), "utf8")].some((m) => {
    try {
      return verify(null, m, key, signature);
    } catch {
      return false;
    }
  });
  if (!ok) throw new ApiError(401, "wallet_auth_invalid", "That signature isn't from this wallet.");
}

const usd = (base: bigint) => Number(base) / USD;

export class CreatorFees {
  #o: ServiceOpts;
  #program: ThesisProgram;
  /** App take id by on-chain take address (published and mirrored takes). */
  #appTakes: () => Map<string, string>;
  #claimText: (takeId: string) => Promise<string | null>;
  #history = new Map<string, { at: number; value: { claimed: bigint } }>();
  #lut: Promise<AddressLookupTableAccount | null> | null = null;

  constructor(
    o: ServiceOpts,
    program: ThesisProgram,
    appTakes: () => Map<string, string>,
    claimText: (takeId: string) => Promise<string | null>,
  ) {
    this.#o = o;
    this.#program = program;
    this.#appTakes = appTakes;
    this.#claimText = claimText;
  }

  /** The author's takes on this fork. Take accounts start with the author's key, after the discriminator. */
  async #takes(author: PublicKey) {
    return this.#program.account.take.all([{ memcmp: { offset: 8, bytes: author.toBase58() } }]);
  }

  /** Claimed on one take, from its claim transactions' events (cached a minute; a claim clears it). */
  async #feeHistory(take: PublicKey) {
    const key = take.toBase58();
    const hit = this.#history.get(key);
    if (hit && hit.at > Date.now() - HISTORY_CACHE_MS) return hit.value;
    const conn = this.#o.connection;
    const sigs = (await conn.getSignaturesForAddress(take, { limit: 1_000 }, "confirmed")).filter((s) => !s.err);
    const txs = sigs.length
      ? await conn.getTransactions(sigs.map((s) => s.signature), { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
      : [];
    let claimed = 0n;
    for (const tx of txs) {
      for (const e of thesisTransactionEvents(this.#program, tx)) {
        const d = e.data as { take?: PublicKey; amount?: BN };
        if (e.name === "creatorFeesClaimed" && d.take?.equals(take)) claimed += BigInt(d.amount?.toString() ?? "0");
      }
    }
    const value = { claimed };
    this.#history.set(key, { at: Date.now(), value });
    return value;
  }

  forget(takes: string[]) {
    for (const t of takes) this.#history.delete(t);
  }

  /** Every take of the author's that earned a creator share, most left to claim first, with totals. */
  async summary(author: string) {
    const authorKey = parseKey(author);
    const appTakes = this.#appTakes();
    const rows: CreatorFeeTake[] = [];
    for (const { publicKey, account } of await this.#takes(authorKey)) {
      const { claimed } = await this.#feeHistory(publicKey);
      const unclaimed = BigInt(account.creatorFeesUnclaimed.toString());
      const earned = claimed + unclaimed;
      if (earned === 0n && unclaimed === 0n) continue;
      const takeId = appTakes.get(publicKey.toBase58()) ?? null;
      rows.push({
        take: publicKey.toBase58(),
        takeId,
        claim: takeId ? await this.#claimText(takeId) : null,
        earned: earned.toString(),
        claimed: claimed.toString(),
        unclaimed: unclaimed.toString(),
        earnedUsd: usd(earned),
        claimedUsd: usd(claimed),
        unclaimedUsd: usd(unclaimed),
      });
    }
    rows.sort((a, b) => Number(BigInt(b.unclaimed) - BigInt(a.unclaimed)) || Number(BigInt(b.earned) - BigInt(a.earned)));
    const sum = (k: "earned" | "claimed" | "unclaimed") => rows.reduce((s, r) => s + BigInt(r[k]), 0n);
    return {
      earned: sum("earned").toString(),
      claimed: sum("claimed").toString(),
      unclaimed: sum("unclaimed").toString(),
      earnedUsd: usd(sum("earned")),
      claimedUsd: usd(sum("claimed")),
      unclaimedUsd: usd(sum("unclaimed")),
      takes: rows,
    };
  }

  /**
   * Claim transactions for the author's takes with something to claim (all of them, or `only`):
   * as many claims per transaction as fit in 1,232 bytes, the app's fee payer paying. The author
   * signs each. Returns the unsigned transactions and the takes and amounts each one claims.
   */
  async build(author: string, only?: string[]) {
    const authorKey = parseKey(author);
    const takes = (await this.#takes(authorKey)).filter(
      (t) => !t.account.creatorFeesUnclaimed.isZero() && (!only || only.includes(t.publicKey.toBase58())),
    );
    if (!takes.length) throw new ApiError(409, "nothing_to_claim", "There's nothing to claim yet.");
    const payer = this.#o.appPayer.publicKey;
    const ata = getAssociatedTokenAddressSync(USDC_MINT_MAINNET, authorKey, true);
    const lut = await this.#lookupTable();
    const { blockhash } = await this.#o.connection.getLatestBlockhash("confirmed");

    const compile = (ixs: TransactionInstruction[], cu: number) =>
      new VersionedTransaction(
        new TransactionMessage({
          payerKey: payer,
          recentBlockhash: blockhash,
          instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs],
        }).compileToV0Message(lut ? [lut] : []),
      );

    const out: { tx: VersionedTransaction; takes: string[]; amount: bigint }[] = [];
    let ixs: TransactionInstruction[] = [createAssociatedTokenAccountIdempotentInstruction(payer, ata, authorKey, USDC_MINT_MAINNET)];
    let cu = ATA_CU;
    let batch: { take: string; amount: bigint }[] = [];
    const flush = () => {
      out.push({ tx: compile(ixs, cu + 1_000), takes: batch.map((b) => b.take), amount: batch.reduce((s, b) => s + b.amount, 0n) });
      ixs = [];
      cu = 0;
      batch = [];
    };
    for (const t of takes) {
      const ix = await claimCreatorFeesIx(this.#program, { author: authorKey, take: t.publicKey });
      const nextCu = cu + CLAIM_CU;
      if (batch.length && compile([...ixs, ix], nextCu + 1_000).serialize().length > MAX_TX_BYTES) flush();
      ixs.push(ix);
      cu += CLAIM_CU;
      batch.push({ take: t.publicKey.toBase58(), amount: BigInt(t.account.creatorFeesUnclaimed.toString()) });
    }
    flush();
    return out.map((o) => ({ ...o, bytes: o.tx.serialize().length }));
  }

  #lookupTable(): Promise<AddressLookupTableAccount | null> {
    const address = this.#o.lookupTable;
    if (!address) return Promise.resolve(null);
    this.#lut ??= this.#o.connection.getAddressLookupTable(address).then((r) => r.value);
    return this.#lut;
  }
}
