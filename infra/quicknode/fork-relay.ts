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
//   FORK_RELAY_STATE             the last transaction handled, default .data/fork/relay-state.json:
//                                on start and on each reconnect the relay back-fills everything
//                                since it (getSignaturesForAddress), so restarts lose nothing
//
// Deliveries are retried with backoff instead of dropped (`Relay`), and every RPC call and POST
// has a timeout.
//
// No dependencies beyond Node 24 (global WebSocket and fetch), so it runs from anywhere.
import { createHmac, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

const REPO_ROOT = join(import.meta.dirname, "../..");
/** Every RPC call gives up after this long, so one hung call (Surfpool waiting on its mainnet datasource) can't stall the queue. */
const RPC_TIMEOUT_MS = 15_000;
const POST_TIMEOUT_MS = 30_000;

export type RpcCall = <T>(method: string, params: unknown[]) => Promise<T>;

/** JSON-RPC over HTTP, with a timeout on every call. */
export function httpRpc(url: string): RpcCall {
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchTransaction(rpc: RpcCall, signature: string, wait: (ms: number) => Promise<void> = sleep): Promise<RpcTransaction | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const tx = await rpc<RpcTransaction | null>("getTransaction", [
        signature,
        { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ]);
      if (tx) return tx;
    } catch (err) {
      if (attempt === 9) console.warn(`getTransaction ${signature}: ${(err as Error).message}`);
    }
    await wait(300);
  }
  return null;
}

/** One delivery attempt. `status` is null when the webhook didn't answer. */
export type PostResult = { ok: true } | { ok: false; status: number | null; detail: string };

/** POSTs one payload to `url`, signed like QuickNode (or prints it when there's no URL). */
async function postPayload(url: string | undefined, payload: unknown): Promise<PostResult> {
  const body = JSON.stringify(payload);
  if (!url) {
    console.log(JSON.stringify(payload, null, 2));
    return { ok: true };
  }
  try {
    const headers = quicknodeHeaders(body, payload, setting("THESIS_WEBHOOK_TOKEN"));
    const auth = setting("THESIS_WEBHOOK_AUTH");
    if (auth) headers.authorization = auth;
    const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
    if (res.ok) {
      console.log(`→ ${res.status} ${url}`);
      return { ok: true };
    }
    return { ok: false, status: res.status, detail: (await res.text().catch(() => "")).slice(0, 300) };
  } catch (err) {
    return { ok: false, status: null, detail: (err as Error).message };
  }
}

/**
 * Only a payload the webhook can't take (malformed, too large, unprocessable) won't change on a
 * retry. 401/403/404 can (a rotated token, a JWT setting, a function mid-redeploy): retried.
 */
export const permanent = (status: number | null) => status === 400 || status === 413 || status === 422;

/**
 * Posts one payload with a few quick retries (1 s apart). For `relayTransactions`, whose callers
 * wait on it; the relay itself retries with backoff (`Relay`). True once delivered.
 */
async function deliver(payload: unknown): Promise<boolean> {
  const url = setting("THESIS_WEBHOOK_URL");
  if (!url) {
    await postPayload(url, payload);
    return false;
  }
  for (let attempt = 0; attempt <= 3; attempt++) {
    const r = await postPayload(url, payload);
    if (r.ok) return true;
    console.warn(`→ ${r.status ?? "no answer"} ${url}: ${r.detail}`);
    if (permanent(r.status)) break;
    if (attempt < 3) await sleep(1000);
  }
  console.error("✗ Delivery failed; the relay delivers it from the program's logs.");
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
  const rpc = httpRpc(rpcUrl);
  let delivered = 0;
  for (const signature of signatures) {
    const tx = await fetchTransaction(rpc, signature);
    if (!tx || tx.meta?.err) continue;
    const note: LogsNotification = { context: { slot: tx.slot }, value: { signature, err: null, logs: tx.meta?.logMessages ?? [] } };
    const payload = relayPayload(filter, note, tx);
    if (payload && (await deliver(payload))) delivered++;
  }
  return delivered;
}

/** One `getSignaturesForAddress` entry. */
export type SignatureInfo = { signature: string; slot: number; err: unknown };

/**
 * The address's confirmed transactions after `until`, oldest first. The RPC pages newest first,
 * 1,000 at a time; at most `max` are read, and `truncated` says older ones (just after `until`)
 * were left out.
 */
export async function signaturesSince(rpc: RpcCall, address: string, until: string | null, max: number): Promise<{ signatures: SignatureInfo[]; truncated: boolean }> {
  const out: SignatureInfo[] = [];
  let before: string | undefined;
  while (out.length < max) {
    const limit = Math.min(1000, max - out.length);
    const page = await rpc<SignatureInfo[]>("getSignaturesForAddress", [
      address,
      { limit, commitment: "confirmed", ...(until ? { until } : {}), ...(before ? { before } : {}) },
    ]);
    out.push(...page);
    if (page.length < limit) return { signatures: out.reverse(), truncated: false };
    before = page[page.length - 1].signature;
  }
  return { signatures: out.reverse(), truncated: true };
}

/** Where the relay keeps the last transaction it handled, so a restart back-fills from there. */
export type RelayState = { last(): string | null; save(signature: string): void };

/**
 * The state in a JSON file, rewritten atomically after each transaction, tied to one fork by
 * `forkId` (the fork's lookup-table address, as the fork API's state file is): a file from
 * another fork (before a reset) is ignored, so the relay starts afresh.
 */
export function fileRelayState(path: string, forkId: string | null, log: (line: string) => void = (l) => console.error(l)): RelayState {
  let last: string | null = null;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as { lastSignature?: string; forkId?: string | null };
    if ((saved.forkId ?? null) === forkId) last = saved.lastSignature ?? null;
    else log(`Relay state in ${path} is from another fork (${saved.forkId ?? "unknown"}, this one is ${forkId ?? "unknown"}): ignored`);
  } catch {
    // No file yet: the first start sets a starting point.
  }
  return {
    last: () => last,
    save(signature) {
      last = signature;
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ lastSignature: signature, forkId, savedAt: new Date().toISOString() }));
      renameSync(tmp, path);
    },
  };
}

/** The fork's id: its Thesis lookup table's address, from `.data/fork/thesis-alt.json` (written by fork:up). */
export function forkIdFrom(path: string): string | null {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { address?: string }).address ?? null;
  } catch {
    return null;
  }
}

export type RelayOptions = {
  filter: StreamFilter;
  rpc: RpcCall;
  /** One delivery attempt. */
  post: (payload: unknown) => Promise<PostResult>;
  state: RelayState;
  /** Back-fill from `state` on start and reconnect (default true). Off when only printing. */
  backfill?: boolean;
  log?: (line: string) => void;
  error?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Live transactions queued at most; past it new ones are dropped and back-filled later. */
  maxQueue?: number;
  /** Transactions read per back-fill at most. */
  maxBackfill?: number;
  /**
   * How long a back-filled transaction that `getTransaction` keeps returning nothing for is
   * retried before it's given up, loudly (default 5 minutes). Webhook failures never give up.
   */
  giveUpMs?: number;
  /** The longest wait between retries. */
  maxDelayMs?: number;
  /** FORK_RELAY_RECORD: called with each live notification and its transaction. */
  record?: (note: LogsNotification, tx: RpcTransaction | null) => void;
};

type Job = { kind: "tx"; signature: string; slot: number; failed: boolean; note?: LogsNotification } | { kind: "backfill" };

/**
 * The relay's delivery queue: one transaction at a time, in order, like the Stream.
 *
 * - **Back-fill.** On start and on every reconnect it reads the program's transactions since the
 *   last one it handled (`getSignaturesForAddress(program, { until })`, kept in `state`) and
 *   delivers them first, oldest first, so restarts and dropped sockets lose nothing. With no
 *   state yet, it starts from the newest transaction and doesn't replay older history.
 * - **Retries.** A failed delivery is retried with backoff (1 s doubling to a minute) for as long
 *   as it takes, and stays at the head of the queue so order holds. Only a payload the webhook
 *   can't take (400, 413, 422), a back-filled transaction the RPC never returns (`giveUpMs`), or a
 *   relaying bug is given up, loudly, naming the signature.
 * - **Position.** The saved position never passes a transaction that wasn't delivered: after one,
 *   later transactions are still delivered but the position holds, so a restart retries it.
 * - **Cap.** Past `maxQueue` queued transactions new ones are dropped (loudly) and back-filled from
 *   the state once the queue drains.
 *
 * Delivering a transaction twice is harmless: the webhook stores each event once.
 */
export class Relay {
  #o: Required<Omit<RelayOptions, "record">> & Pick<RelayOptions, "record">;
  #queue: Job[] = [];
  #pending = new Set<string>();
  #recent = new Set<string>();
  #recentOrder: string[] = [];
  #overflow = false;
  #held: string | null = null;
  #running: Promise<void> | null = null;

  constructor(o: RelayOptions) {
    this.#o = {
      backfill: true,
      log: (l) => console.error(l),
      error: (l) => console.error(l),
      sleep,
      now: Date.now,
      maxQueue: 10_000,
      maxBackfill: 5_000,
      giveUpMs: 5 * 60_000,
      maxDelayMs: 60_000,
      ...o,
    };
  }

  /** A live `logsNotification`. */
  notify(note: LogsNotification): void {
    const signature = note.value.signature;
    if (this.#pending.has(signature) || this.#recent.has(signature)) return;
    if (this.#queue.length >= this.#o.maxQueue) {
      if (!this.#overflow) this.#o.error(`✗ relay queue full (${this.#o.maxQueue}): dropping new transactions until it drains, then back-filling them`);
      this.#overflow = true;
      return;
    }
    this.#queue.push({ kind: "tx", signature, slot: note.context.slot, failed: note.value.err != null, note });
    this.#pending.add(signature);
    this.#kick();
  }

  /** Queues a back-fill (on start and on each reconnect, before subscribing). */
  backfill(): void {
    if (!this.#o.backfill || this.#queue.some((j) => j.kind === "backfill")) return;
    this.#queue.push({ kind: "backfill" });
    this.#kick();
  }

  /** Resolves once the queue is empty. */
  async drained(): Promise<void> {
    while (this.#running) await this.#running;
  }

  #kick() {
    if (this.#running) return;
    this.#running = this.#work()
      .catch((e) => this.#o.error(`✗ relay: ${(e as Error).message}`))
      .finally(() => {
        this.#running = null;
        if (this.#queue.length) this.#kick();
      });
  }

  async #work() {
    for (;;) {
      const job = this.#queue.shift();
      if (!job) {
        if (!this.#overflow || !this.#o.backfill) return;
        this.#overflow = false;
        await this.#backfill();
        continue;
      }
      if (job.kind === "backfill") {
        await this.#backfill();
        continue;
      }
      let outcome: "done" | "undelivered";
      try {
        outcome = await this.#handle(job);
      } catch (e) {
        // A bug (a decode error, say) mustn't let later saves move past this transaction.
        this.#o.error(`✗ ${job.signature}: relaying it failed (${(e as Error).message}): not delivered`);
        outcome = "undelivered";
      }
      this.#pending.delete(job.signature);
      this.#remember(job.signature);
      if (outcome === "undelivered" && !this.#held) {
        this.#held = job.signature;
        this.#o.error(
          `✗ relay position held at ${this.#o.state.last() ?? "the start"}: ${job.signature} wasn't delivered. Later transactions are still delivered; a restart back-fills from the held position and retries it.`,
        );
      }
      // The saved position never passes a transaction that wasn't delivered.
      if (this.#held) continue;
      try {
        this.#o.state.save(job.signature);
      } catch (e) {
        this.#o.error(`✗ relay state not saved (${(e as Error).message}): a restart would back-fill from an older transaction`);
      }
    }
  }

  /** The first transaction this process couldn't deliver: the saved position stays before it. */
  get held(): string | null {
    return this.#held;
  }

  #remember(signature: string) {
    this.#recent.add(signature);
    this.#recentOrder.push(signature);
    if (this.#recentOrder.length > 20_000) this.#recent.delete(this.#recentOrder.shift()!);
  }

  #delay(attempt: number) {
    return Math.min(this.#o.maxDelayMs, 1000 * 2 ** attempt);
  }

  async #backfill() {
    const until = this.#o.state.last();
    for (let attempt = 0; ; attempt++) {
      try {
        if (!until) {
          // First start: begin at the newest transaction; older history isn't replayed.
          const [newest] = await this.#o.rpc<SignatureInfo[]>("getSignaturesForAddress", [this.#o.filter.programId, { limit: 1, commitment: "confirmed" }]);
          if (newest && !this.#o.state.last()) {
            this.#o.state.save(newest.signature);
            this.#o.log(`No relay state yet: starting after ${newest.signature}; earlier transactions aren't replayed`);
          }
          return;
        }
        const { signatures, truncated } = await signaturesSince(this.#o.rpc, this.#o.filter.programId, until, this.#o.maxBackfill);
        if (truncated) this.#o.error(`✗ more than ${this.#o.maxBackfill} transactions since ${until}: back-filling the newest ${this.#o.maxBackfill}; older ones are lost`);
        const jobs: Job[] = [];
        for (const s of signatures) {
          if (this.#pending.has(s.signature) || this.#recent.has(s.signature)) continue;
          jobs.push({ kind: "tx", signature: s.signature, slot: s.slot, failed: s.err != null });
          this.#pending.add(s.signature);
        }
        // Ahead of anything already queued: those came in live, so they're newer.
        this.#queue.unshift(...jobs);
        if (jobs.length) this.#o.log(`Back-filling ${jobs.length} transaction(s) since ${until}`);
        return;
      } catch (e) {
        if (attempt >= 9) {
          this.#o.error(`✗ back-fill failed (${(e as Error).message}); the next start or reconnect tries again`);
          return;
        }
        this.#o.log(`back-fill: ${(e as Error).message}; retrying in ${this.#delay(attempt) / 1000}s`);
        await this.#o.sleep(this.#delay(attempt));
      }
    }
  }

  /**
   * Delivers one transaction. "done": delivered, or nothing to deliver (failed on chain, no Thesis
   * events). "undelivered": the webhook can't take the payload (400/413/422), or the RPC never
   * returned a back-filled transaction within `giveUpMs`. Anything transient (5xx, 401/403/404,
   * 408/429, no answer) is retried with capped backoff for as long as it takes: the queue cap and
   * the back-fill cover what piles up meanwhile.
   */
  async #handle(job: Extract<Job, { kind: "tx" }>): Promise<"done" | "undelivered"> {
    const { signature } = job;
    if (job.failed) {
      this.#o.log(`· skipped failed tx ${signature}`);
      return "done";
    }
    let missingSince: number | null = null;
    let tx: RpcTransaction | null = null;
    let announced = false;
    for (let attempt = 0; ; attempt++) {
      let why: string;
      if (!tx) tx = await fetchTransaction(this.#o.rpc, signature, this.#o.sleep);
      if (attempt === 0 && job.note) this.#o.record?.(job.note, tx);
      if (tx?.meta?.err) {
        this.#o.log(`· skipped failed tx ${signature}`);
        return "done";
      }
      // A live notification's logs stand in for a transaction the RPC can't return; a
      // back-filled one has no logs, so it waits for the RPC.
      const note: LogsNotification | null =
        job.note ?? (tx ? { context: { slot: tx.slot }, value: { signature, err: null, logs: tx.meta?.logMessages ?? [] } } : null);
      if (note) {
        const payload = relayPayload(this.#o.filter, note, tx);
        if (!payload) return "done";
        if (!announced) {
          const ixs = (payload as { transactions: { instructions: string[] }[] }).transactions.flatMap((t) => t.instructions);
          this.#o.log(`· ${signature} slot ${tx?.slot ?? job.slot} [${ixs.join(", ")}]`);
          announced = true;
        }
        const r = await this.#o.post(payload);
        if (r.ok) return "done";
        if (permanent(r.status)) {
          this.#o.error(`✗ ${signature}: the webhook can't take it (HTTP ${r.status}): not delivered. ${r.detail}`);
          return "undelivered";
        }
        why = `${r.status ? `HTTP ${r.status}` : "no answer"}${r.detail ? `: ${r.detail}` : ""}`;
      } else {
        missingSince ??= this.#o.now();
        if (this.#o.now() - missingSince >= this.#o.giveUpMs) {
          this.#o.error(`✗ ${signature}: getTransaction returned nothing for ${Math.round(this.#o.giveUpMs / 60_000)} min: not delivered. Replay it with relayTransactions once the RPC has it.`);
          return "undelivered";
        }
        why = "getTransaction returned nothing";
      }
      const delay = this.#delay(attempt);
      const line = `✗ ${signature}: ${why}; retry ${attempt + 1} in ${delay / 1000}s (${this.#queue.length} queued behind it)`;
      // Loud on the third retry and every tenth after it; quiet otherwise.
      (attempt === 2 || (attempt > 2 && attempt % 10 === 0) ? this.#o.error : this.#o.log)(line);
      await this.#o.sleep(delay);
    }
  }
}

export function runRelay(): void {
  const wsUrl = process.env.FORK_WS_URL ?? "ws://127.0.0.1:18900";
  const rpcUrl = process.env.FORK_RPC_URL ?? "http://127.0.0.1:18899";
  const filter = loadFilter();
  const url = setting("THESIS_WEBHOOK_URL");
  const target = url ?? "stdout";
  const statePath = setting("FORK_RELAY_STATE") ?? join(REPO_ROOT, ".data/fork/relay-state.json");
  let memory: string | null = null;
  const relay = new Relay({
    filter,
    rpc: httpRpc(rpcUrl),
    post: (payload) => postPayload(url, payload),
    // Printing only: nothing to catch up on, and no state file.
    // The position belongs to this fork: a state file from before a reset is ignored.
    state: url ? fileRelayState(statePath, forkIdFrom(join(REPO_ROOT, ".data/fork/thesis-alt.json"))) : { last: () => memory, save: (s) => void (memory = s) },
    backfill: Boolean(url),
    record: process.env.FORK_RELAY_RECORD
      ? (notification, transaction) => appendFileSync(process.env.FORK_RELAY_RECORD!, JSON.stringify({ notification, transaction }) + "\n")
      : undefined,
  });
  let retryMs = 1000;

  const connect = () => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => {
      retryMs = 1000;
      // Queued before the subscription, so what landed while disconnected goes out first.
      relay.backfill();
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [{ mentions: [filter.programId] }, { commitment: "confirmed" }],
        }),
      );
      console.error(`Relaying ${filter.programId} logs from ${wsUrl} → ${target}${url ? ` (state in ${statePath})` : ""}`);
    });
    ws.addEventListener("message", (event) => {
      let msg: { error?: { message: string }; method?: string; params?: { result: LogsNotification } };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.error) console.error(`logsSubscribe: ${msg.error.message}`);
      if (msg.method !== "logsNotification" || !msg.params) return;
      relay.notify(msg.params.result);
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
