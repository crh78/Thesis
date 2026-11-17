import { EventParser, utils } from "@anchor-lang/core";
import type { PublicKey } from "@solana/web3.js";
import type { ThesisProgram } from "./program.ts";
import type { ThesisEvents } from "./types.ts";

export type ThesisEventName = keyof ThesisEvents;
export type ThesisEvent = {
  [K in ThesisEventName]: { name: K; data: ThesisEvents[K] };
}[ThesisEventName];

/**
 * Anchor's tag for a self-CPI event (`emit_cpi!`): the first 8 bytes of the inner instruction's
 * data, little-endian 0x1d9acb512ea545e4. The event's discriminator and borsh follow.
 */
export const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

/**
 * Decodes Thesis events from a transaction's log messages: Anchor's `Program data:` lines, which
 * the program wrote before its events moved to `emit_cpi!`. Transactions from before that change
 * still need it; new ones carry no events in their logs (see `thesisTransactionEvents`).
 */
export function parseThesisEvents(program: ThesisProgram, logs: string[]): ThesisEvent[] {
  const parser = new EventParser(program.programId, program.coder);
  return [...parser.parseLogs(logs)] as ThesisEvent[];
}

/**
 * Decodes one self-CPI event: an inner Thesis instruction's data (bytes, or base58 as RPC returns
 * it). Null if it isn't an event. Only the program can sign as its event authority, so any such
 * inner instruction in a successful transaction is genuine.
 */
export function decodeThesisCpiEvent(program: ThesisProgram, data: Uint8Array | string): ThesisEvent | null {
  const bytes = typeof data === "string" ? utils.bytes.bs58.decode(data) : data;
  if (bytes.length <= EVENT_IX_TAG.length || !EVENT_IX_TAG.every((b, i) => bytes[i] === b)) return null;
  return thesisEventFromBase64(program, Buffer.from(bytes.subarray(EVENT_IX_TAG.length)).toString("base64"));
}

/** The inner instruction data (base58, as RPC returns it) for an event's discriminator and borsh: for tests. */
export function thesisCpiEventData(eventBytes: Uint8Array): string {
  return utils.bytes.bs58.encode(Buffer.concat([Buffer.from(EVENT_IX_TAG), Buffer.from(eventBytes)]));
}

/** Decodes an event's discriminator and borsh, base64 (what the Stream filter forwards). */
export function thesisEventFromBase64(program: ThesisProgram, b64: string): ThesisEvent | null {
  return (program.coder.events.decode(b64) as ThesisEvent | null) ?? null;
}

type InnerIx = { programIdIndex?: number; programId?: PublicKey | string; data?: string };

/** What `getTransaction` / `getParsedTransaction` return, as far as events need. */
export type TransactionWithEvents = {
  transaction: { message: unknown };
  meta: {
    logMessages?: string[] | null;
    innerInstructions?: { index: number; instructions: InnerIx[] }[] | null;
    loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] } | null;
  } | null;
} | null;

/**
 * Every Thesis event in a transaction, in order: the program's self-CPI events from its inner
 * instructions, or, for a transaction from before `emit_cpi!`, the events in its logs. The
 * validator cuts logs at 10 KB, so a big trade's log events could be lost; inner instructions
 * can't be.
 */
export function thesisTransactionEvents(program: ThesisProgram, tx: TransactionWithEvents | undefined): ThesisEvent[] {
  if (!tx?.meta) return [];
  const keys = accountKeys(tx);
  const id = program.programId.toBase58();
  const out: ThesisEvent[] = [];
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      const programId =
        ix.programId != null ? String(typeof ix.programId === "string" ? ix.programId : ix.programId.toBase58()) : keys[ix.programIdIndex ?? -1];
      if (programId !== id || typeof ix.data !== "string") continue;
      const event = decodeThesisCpiEvent(program, ix.data);
      if (event) out.push(event);
    }
  }
  return out.length ? out : parseThesisEvents(program, tx.meta.logMessages ?? []);
}

/**
 * Account keys as base58, in the order compiled instructions index them: static keys, then the
 * lookup table's writable and readonly ones. Takes web3.js responses and raw RPC JSON alike.
 */
function accountKeys(tx: NonNullable<TransactionWithEvents>): string[] {
  type Key = PublicKey | { pubkey: PublicKey | string; source?: string } | string;
  const message = tx.transaction.message as {
    getAccountKeys?: (o: { accountKeysFromLookups?: unknown }) => { keySegments(): PublicKey[][] };
    accountKeys?: Key[];
  };
  const loaded = tx.meta?.loadedAddresses as { writable: (PublicKey | string)[]; readonly: (PublicKey | string)[] } | null | undefined;
  if (typeof message.getAccountKeys === "function") {
    return message
      .getAccountKeys({ accountKeysFromLookups: loaded ?? undefined })
      .keySegments()
      .flat()
      .map((k) => k.toBase58());
  }
  const str = (k: Key): string => (typeof k === "string" ? k : "pubkey" in k ? str(k.pubkey) : k.toBase58());
  const keys = (message.accountKeys ?? []).map(str);
  // jsonParsed already lists the lookup table's keys (source "lookupTable").
  const listed = (message.accountKeys ?? []).some((k) => typeof k === "object" && "source" in k && k.source === "lookupTable");
  if (loaded && !listed) keys.push(...loaded.writable.map(str), ...loaded.readonly.map(str));
  return keys;
}
