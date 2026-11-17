import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { parseThesisEvents, thesisEventFromBase64, type ThesisEvent } from "./events.ts";
import type { ThesisProgram } from "./program.ts";

/**
 * One Thesis transaction as delivered by the QuickNode Stream filter
 * (infra/quicknode/thesis-filter.js).
 */
export interface ThesisStreamTransaction {
  signature: string;
  /** Null only if the Stream couldn't tell (see the filter's `blockSlot`). */
  slot: number | null;
  blockTime: number | null;
  /** IDL instruction names (`create_take`, `back`, ...), top-level and CPI, in order. */
  instructions: string[];
  /**
   * The program's events, in order, base64 (discriminator ++ borsh): its self-CPIs
   * (`emit_cpi!`). Absent from payloads made before the program emitted that way.
   */
  events?: string[];
  /**
   * Invoke/exit lines plus everything Thesis logged: enough for the Anchor event parser, for
   * transactions from before `emit_cpi!` that carry their events as "Program data:" lines.
   */
  logs: string[];
  /** Set when the validator cut the logs short. Only log events can go missing (old transactions). */
  logsTruncated?: boolean;
}

/** The body the filter returns, and so the body the webhook receives. */
export interface ThesisStreamPayload {
  programId: string;
  network: string | null;
  batchStart: number | null;
  batchEnd: number | null;
  /** Slots QuickNode re-delivered after a reorg. Upsert by signature and these are harmless. */
  blocksReorged: number[] | null;
  transactions: ThesisStreamTransaction[];
}

export interface DecodedThesisTransaction extends Omit<ThesisStreamTransaction, "logs" | "events"> {
  events: ThesisEvent[];
}

/**
 * Decodes a QuickNode Stream webhook body into Thesis transactions with typed events.
 * Accepts the filter's return value as-is, a JSON string of it, or either wrapped in
 * `{ data: ... }`. Throws if the payload was filtered for a different program.
 */
export function decodeThesisStream(program: ThesisProgram, body: unknown): DecodedThesisTransaction[] {
  const out: DecodedThesisTransaction[] = [];
  for (const payload of payloads(body)) {
    if (payload.programId !== program.programId.toBase58()) {
      throw new Error(`Stream payload is for ${payload.programId}, not ${program.programId.toBase58()}`);
    }
    for (const { logs, events, ...tx } of payload.transactions) {
      const cpi = (events ?? []).map((b64) => thesisEventFromBase64(program, b64)).filter((e) => e != null);
      out.push({ ...tx, events: cpi.length ? cpi : parseThesisEvents(program, logs) });
    }
  }
  return out;
}

function payloads(body: unknown): ThesisStreamPayload[] {
  if (body == null) return [];
  if (typeof body === "string") return payloads(JSON.parse(body));
  if (Array.isArray(body)) return body.flatMap(payloads);
  if (typeof body !== "object") throw new Error("Stream payload must be an object");
  if ("transactions" in body) return [body as ThesisStreamPayload];
  if ("data" in body) return payloads(body.data);
  throw new Error("Stream payload has no `transactions`");
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Plain-JSON form of an event's data, for database rows and push payloads: public keys as
 * base58, integers (BN) as decimal strings, enums (`{ back: {} }`) as their variant name.
 */
export function thesisEventToJson(event: ThesisEvent): { name: string; data: JsonValue } {
  return { name: event.name, data: toJson(event.data) };
}

function toJson(value: unknown): JsonValue {
  if (value instanceof PublicKey) return value.toBase58();
  if (BN.isBN(value)) return value.toString();
  if (typeof value === "bigint") return value.toString();
  if (value == null) return null;
  if (Array.isArray(value) || value instanceof Uint8Array) return Array.from(value, toJson);
  if (typeof value === "object") {
    const entries = Object.entries(value);
    // Anchor enums decode to `{ variant: {} }`.
    if (entries.length === 1 && isEmptyObject(entries[0][1])) return entries[0][0];
    return Object.fromEntries(entries.map(([k, v]) => [k, toJson(v)]));
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error(`Can't convert ${typeof value} to JSON`);
}

function isEmptyObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;
}
