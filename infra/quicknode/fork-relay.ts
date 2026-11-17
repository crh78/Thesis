// Fork relay: stands in for the QuickNode Stream on a Surfpool mainnet fork.
//
//   pnpm fork:relay                                   # print payloads
//   THESIS_WEBHOOK_URL=http://localhost:54321/functions/v1/quicknode-stream pnpm fork:relay
//
// It subscribes to Thesis program logs on the fork's websocket (`logsSubscribe`), fetches each
// transaction with `getTransaction`, and runs it through the real QuickNode filter
// (thesis-filter.js, in a sandbox like QuickNode's) as a one-block "Block" dataset batch. The
// webhook therefore gets exactly the payload shape the Stream sends; decode it with
// `decodeThesisStream` from @thesis/chain.
//
// Environment:
//   FORK_WS_URL / FORK_RPC_URL   default ws://127.0.0.1:18900 and http://127.0.0.1:18899
//   THESIS_WEBHOOK_URL           POST target; without it payloads are printed (environment or .env)
//   THESIS_WEBHOOK_TOKEN         signs requests like QuickNode (X-QN-Nonce, X-QN-Timestamp,
//                                X-QN-Signature = hex HMAC-SHA256(nonce + timestamp + body))
//   THESIS_WEBHOOK_AUTH          sent as the Authorization header (e.g. "Bearer <anon key>")
//   FORK_RELAY_RECORD            appends each raw { notification, transaction } as a JSON line
//                                to this file (for test fixtures)
//
// No dependencies beyond Node 24 (global WebSocket and fetch), so it runs from anywhere.
import { createHmac, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { envVar } from "../../packages/venues/registry/src/lib/env.ts";

/** A relay setting from the environment or the repo-root .env (so the webhook token stays out of shell history). */
const setting = (k: string): string | undefined => process.env[k] ?? envVar(k) ?? undefined;

export const FILTER_PATH = join(import.meta.dirname, "thesis-filter.js");
/** `metadata.network` in relayed payloads, so the backend can tell fork events from mainnet ones. */
export const FORK_NETWORK = "solana-mainnet-fork";

export interface StreamFilter {
  programId: string;
  run(stream: unknown): unknown;
}

/** Loads thesis-filter.js the way QuickNode runs it: no imports, entry point `main(stream)`. */
export function loadFilter(path = FILTER_PATH): StreamFilter {
  const source = readFileSync(path, "utf8");
  const ctx = runInNewContext(`${source}\n;({ main, THESIS_PROGRAM_ID })`, {}, { filename: path }) as {
    main: (stream: unknown) => unknown;
    THESIS_PROGRAM_ID: string;
  };
  return {
    programId: ctx.THESIS_PROGRAM_ID,
    // Round-trip through JSON so the result is a plain object from this realm.
    run: (stream) => JSON.parse(JSON.stringify(ctx.main(stream)) ?? "null"),
  };
}

/** `params.result` of a `logsNotification`. */
export interface LogsNotification {
  context: { slot: number };
  value: { signature: string; err: unknown; logs: string[] };
}

/** A `getTransaction` result ("json" encoding, maxSupportedTransactionVersion 0). */
export interface RpcTransaction {
  slot: number;
  blockTime: number | null;
  transaction: { signatures: string[]; message: unknown };
  meta: { err: unknown; logMessages?: string[] | null; [key: string]: unknown } | null;
  [key: string]: unknown;
}

/**
 * Builds the QuickNode filter input for one notification and runs the filter on it.
 *
 * With the transaction, the input is a one-block "Block" dataset batch (`getBlock` shape), so
 * instruction names come from the instruction data exactly as on mainnet. Without it (the RPC
 * couldn't return it), it falls back to a "Programs with Logs" batch built from the notification's
 * logs: events decode the same, but `instructions` is empty and `blockTime` null.
 */
export function relayPayload(
  filter: StreamFilter,
  notification: LogsNotification,
  tx: RpcTransaction | null,
  network = FORK_NETWORK,
): unknown {
  const slot = tx?.slot ?? notification.context.slot;
  const metadata = { network, batch_start_range: slot, batch_end_range: slot, blocks_reorged: null };
  if (tx) {
    const { slot: _slot, blockTime, ...rest } = tx;
    return filter.run({ data: [{ slot, blockTime, transactions: [rest] }], metadata });
  }
  const { signature, err, logs } = notification.value;
  return filter.run({
    data: [[{ signature, slot, blockTime: null, programInvocations: [], logs, success: err == null, err }]],
    metadata,
  });
}

/** Headers QuickNode adds to webhook deliveries, signed with the Stream's security token. */
export function quicknodeHeaders(body: string, payload: unknown, token?: string): Record<string, string> {
  const p = (payload ?? {}) as { network?: string; batchStart?: number; batchEnd?: number };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "stream-id": "thesis-fork-relay",
    "stream-network": p.network ?? FORK_NETWORK,
    "batch-start-range": String(p.batchStart ?? ""),
    "batch-end-range": String(p.batchEnd ?? ""),
  };
  if (token) {
    const nonce = randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers["x-qn-nonce"] = nonce;
    headers["x-qn-timestamp"] = timestamp;
    headers["x-qn-signature"] = createHmac("sha256", token).update(nonce + timestamp + body).digest("hex");
  }
  return headers;
}

// --- Runner ------------------------------------------------------------------------------

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

async function fetchTransaction(rpcUrl: string, signature: string): Promise<RpcTransaction | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const tx = await rpc<RpcTransaction | null>(rpcUrl, "getTransaction", [
        signature,
        { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ]);
      if (tx) return tx;
    } catch (err) {
      if (attempt === 9) console.warn(`getTransaction ${signature}: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** Posts one payload to THESIS_WEBHOOK_URL (or prints it without one). True once delivered. */
async function deliver(payload: unknown): Promise<boolean> {
  const url = setting("THESIS_WEBHOOK_URL");
  const body = JSON.stringify(payload);
  if (!url) {
    console.log(JSON.stringify(payload, null, 2));
    return false;
  }
  // Like the Stream: retry every second, give up after 3 retries.
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const headers = quicknodeHeaders(body, payload, setting("THESIS_WEBHOOK_TOKEN"));
      const auth = setting("THESIS_WEBHOOK_AUTH");
      if (auth) headers.authorization = auth;
      const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        console.log(`→ ${res.status} ${url}`);
        return true;
      }
      console.warn(`→ ${res.status} ${url}: ${(await res.text()).slice(0, 300)}`);
    } catch (err) {
      console.warn(`→ ${url}: ${(err as Error).message}`);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1000));
  }
  console.error("✗ Delivery failed after 3 retries; continuing with the next transaction.");
  return false;
}

/** Whether `relayTransactions` has somewhere to deliver to (THESIS_WEBHOOK_URL is set). */
export const webhookConfigured = (): boolean => Boolean(setting("THESIS_WEBHOOK_URL"));

/**
 * Delivers these confirmed transactions to the webhook now, the way the relay would when it sees
 * them: the fork API calls it after an app take's publish lands, so the take goes live without
 * waiting for (or needing) `pnpm fork:relay`. Delivering a transaction twice is harmless: the
 * backend stores each event once. Returns how many were delivered.
 */
export async function relayTransactions(rpcUrl: string, signatures: string[], filter: StreamFilter = loadFilter()): Promise<number> {
  let delivered = 0;
  for (const signature of signatures) {
    const tx = await fetchTransaction(rpcUrl, signature);
    if (!tx || tx.meta?.err) continue;
    const note: LogsNotification = { context: { slot: tx.slot }, value: { signature, err: null, logs: tx.meta?.logMessages ?? [] } };
    const payload = relayPayload(filter, note, tx);
    if (payload && (await deliver(payload))) delivered++;
  }
  return delivered;
}

export function runRelay(): void {
  const wsUrl = process.env.FORK_WS_URL ?? "ws://127.0.0.1:18900";
  const rpcUrl = process.env.FORK_RPC_URL ?? "http://127.0.0.1:18899";
  const filter = loadFilter();
  const target = setting("THESIS_WEBHOOK_URL") ?? "stdout";
  // Deliveries go out one at a time, in order, like the Stream's.
  let queue = Promise.resolve();
  let retryMs = 1000;

  const connect = () => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => {
      retryMs = 1000;
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [{ mentions: [filter.programId] }, { commitment: "confirmed" }],
        }),
      );
      console.error(`Relaying ${filter.programId} logs from ${wsUrl} → ${target}`);
    });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.error) console.error(`logsSubscribe: ${msg.error.message}`);
      if (msg.method !== "logsNotification") return;
      const note = msg.params.result as LogsNotification;
      queue = queue.then(async () => {
        if (note.value.err) {
          console.error(`· skipped failed tx ${note.value.signature}`);
          return;
        }
        const tx = await fetchTransaction(rpcUrl, note.value.signature);
        if (process.env.FORK_RELAY_RECORD) {
          appendFileSync(process.env.FORK_RELAY_RECORD, JSON.stringify({ notification: note, transaction: tx }) + "\n");
        }
        const payload = relayPayload(filter, note, tx);
        if (!payload) return;
        const ixs = (payload as { transactions: { instructions: string[] }[] }).transactions.flatMap((t) => t.instructions);
        console.error(`· ${note.value.signature} slot ${note.context.slot} [${ixs.join(", ")}]`);
        await deliver(payload);
      }).catch((err) => console.error(`✗ ${(err as Error).message}`));
    });
    ws.addEventListener("close", () => {
      console.error(`Websocket closed; reconnecting in ${retryMs / 1000}s`);
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    });
    ws.addEventListener("error", () => {
      // "close" follows and reconnects.
    });
  };
  connect();
}

if (import.meta.main) runRelay();
