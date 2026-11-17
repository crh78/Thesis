// Decodes a QuickNode Stream body (the output of infra/quicknode/thesis-filter.js, or the fork
// relay's identical payload) into plain-JSON Thesis events for ingest_chain_events().
//
// Same decoding as decodeThesisStream + thesisEventToJson in packages/chain/src/stream.ts:
// the program's self-CPI events (`events`, base64), or for transactions from before `emit_cpi!`
// Anchor's event parser over their logs, then public keys as base58, integers as
// decimal strings and enums as their variant name. decode_test.ts checks both agree on the
// shared fixture. The IDL is a copy of packages/chain/idl/thesis.json (a chain test checks it).
import { BorshCoder, EventParser, convertIdlToCamelCase } from "npm:@anchor-lang/core@1.2.2";
import { PublicKey } from "npm:@solana/web3.js@1.98.4";
import BN from "npm:bn.js@5.2.1";
import idl from "../_shared/thesis-idl.json" with { type: "json" };

export const PROGRAM_ID = idl.address as string;

export type StreamEvent = {
  signature: string;
  /** The event's index among the transaction's Thesis events. */
  ordinal: number;
  slot: number | null;
  block_time: number | null;
  name: string;
  data: Json;
};

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

type StreamTx = { signature: string; slot: number | null; blockTime: number | null; events?: string[]; logs: string[] };
type Payload = { programId: string; network: string | null; transactions: StreamTx[] };

// deno-lint-ignore no-explicit-any
// Anchor's Program does this conversion too, which is what gives @thesis/chain camelCase names.
// deno-lint-ignore no-explicit-any
const coder = new BorshCoder(convertIdlToCamelCase(idl as any));
const parser = new EventParser(new PublicKey(PROGRAM_ID), coder);

/** A transaction's events: its self-CPI events, or (before `emit_cpi!`) the ones in its logs. */
function txEvents(tx: StreamTx): { name: string; data: unknown }[] {
  const cpi = (tx.events ?? []).map((b64) => coder.events.decode(b64)).filter((e) => e != null);
  return cpi.length ? cpi : [...parser.parseLogs(tx.logs ?? [])];
}

/** The payloads in a webhook body: the filter's object, a JSON string of it, an array, or `{ data }`. */
export function payloads(body: unknown): Payload[] {
  if (body == null) return [];
  if (typeof body === "string") return payloads(JSON.parse(body));
  if (Array.isArray(body)) return body.flatMap(payloads);
  if (typeof body !== "object") throw new Error("Stream payload must be an object");
  if ("transactions" in body) return [body as Payload];
  if ("data" in body) return payloads((body as { data: unknown }).data);
  throw new Error("Stream payload has no `transactions`");
}

/** Every Thesis event in the body, grouped by network. Throws on another program's payload. */
export function decodeStream(body: unknown): Map<string, StreamEvent[]> {
  const out = new Map<string, StreamEvent[]>();
  for (const p of payloads(body)) {
    if (p.programId !== PROGRAM_ID) throw new Error(`payload is for ${p.programId}, not ${PROGRAM_ID}`);
    const network = p.network ?? "solana-mainnet";
    const list = out.get(network) ?? [];
    for (const tx of p.transactions) {
      let ordinal = 0;
      for (const ev of txEvents(tx)) {
        list.push({ signature: tx.signature, ordinal: ordinal++, slot: tx.slot ?? null, block_time: tx.blockTime ?? null, name: ev.name, data: toJson(ev.data) });
      }
    }
    out.set(network, list);
  }
  return out;
}

export function toJson(value: unknown): Json {
  if (value instanceof PublicKey) return value.toBase58();
  if (BN.isBN(value)) return (value as BN).toString();
  if (typeof value === "bigint") return value.toString();
  if (value == null) return null;
  if (Array.isArray(value) || value instanceof Uint8Array) return Array.from(value as ArrayLike<unknown>, toJson);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    // Anchor enums decode to `{ variant: {} }`.
    if (entries.length === 1 && isEmptyObject(entries[0][1])) return entries[0][0];
    return Object.fromEntries(entries.map(([k, v]) => [k, toJson(v)]));
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error(`can't convert ${typeof value} to JSON`);
}

const isEmptyObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;

export { verifySignature } from "../_shared/hmac.ts";
