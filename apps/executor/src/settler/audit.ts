// Every set of prices the settler signs carries `source_hash`: the sha256 of a canonical JSON
// document holding the exact market data it priced from. The documents are appended to a JSON
// lines file, so anyone holding one can recompute the hash and compare it with the event.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readAuditDocs } from "./basis.ts";

/** JSON with object keys sorted at every level, so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

export function sourceHash(doc: unknown): Buffer {
  return createHash("sha256").update(canonicalJson(doc), "utf8").digest();
}

export interface AuditLog {
  append(entry: { hash: string; doc: unknown }): void;
  /** Every document logged so far (the settler reads entry bases back from it on start). */
  read?(): unknown[];
}

export class FileAuditLog implements AuditLog {
  path: string;
  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }
  append(entry: { hash: string; doc: unknown }): void {
    appendFileSync(this.path, canonicalJson({ ...entry, loggedAt: new Date().toISOString() }) + "\n");
  }
  read(): unknown[] {
    return readAuditDocs(this.path);
  }
}

export class MemoryAuditLog implements AuditLog {
  entries: { hash: string; doc: unknown }[] = [];
  append(entry: { hash: string; doc: unknown }): void {
    this.entries.push(entry);
  }
  read(): unknown[] {
    return this.entries.map((e) => e.doc);
  }
}

// --- Published audit (public.price_audit) -------------------------------------------------------
//
// The local file proves nothing to anyone else, and a lost file loses the entry bases exits are
// priced on. RemoteAuditLog also publishes every document to the `price-audit` edge function
// (which recomputes the hash and stores it in public.price_audit, publicly readable), and can
// read entry documents back from there on start. The on-chain source_hash stays the anchor:
// anyone can fetch a position's hashes (price_events()), the documents, and recompute them
// (apps/executor/scripts/verify-prices.ts).

type FetchFn = typeof fetch;
type Pending = { hash: string; canonical: string; network: string | null };

export type RemoteAuditOptions = {
  /** The price-audit function, e.g. <SUPABASE_URL>/functions/v1/price-audit. */
  url: string;
  /** PRICE_AUDIT_TOKEN, the function's secret. */
  token: string;
  /** Recorded with each document (solana-mainnet, solana-mainnet-fork). */
  network?: string | null;
  /** Written first, synchronously, and read first: normally the FileAuditLog. */
  local?: AuditLog;
  /** Public reads of price_audit: SUPABASE_URL and the publishable key. */
  read?: { supabaseUrl: string; key: string; program?: string | null };
  fetchFn?: FetchFn;
  log?: (m: string) => void;
  /** Entries per request (the function takes at most 100). */
  batch?: number;
  /** First retry delay after a failed send; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Documents kept waiting in memory at most (oldest dropped: they're still in the local file). */
  maxPending?: number;
};

const docHash = (canonical: string) => createHash("sha256").update(canonical, "utf8").digest("hex");

export class RemoteAuditLog implements AuditLog {
  #o: Required<Pick<RemoteAuditOptions, "batch" | "retryMs" | "maxRetryMs" | "maxPending">> & RemoteAuditOptions;
  #fetch: FetchFn;
  #queue: Pending[] = [];
  #inFlight: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #delay: number;
  /** Entry documents read back from price_audit, by hash. */
  #remote = new Map<string, unknown>();
  /** Every hash price_audit already holds (from load()). */
  #published = new Set<string>();
  sent = 0;
  failures = 0;

  constructor(o: RemoteAuditOptions) {
    this.#o = { batch: 50, retryMs: 2_000, maxRetryMs: 5 * 60_000, maxPending: 5_000, ...o };
    this.#fetch = o.fetchFn ?? fetch;
    this.#delay = this.#o.retryMs;
  }

  get pending(): number {
    return this.#queue.length;
  }

  /** Never throws and never waits on the network: the local file first, then a background send. */
  append(entry: { hash: string; doc: unknown }): void {
    this.#o.local?.append(entry);
    this.#enqueue(entry.hash, canonicalJson(entry.doc));
    this.#schedule(0);
  }

  #enqueue(hash: string, canonical: string) {
    if (this.#published.has(hash) || this.#queue.some((p) => p.hash === hash)) return;
    if (docHash(canonical) !== hash) {
      this.#o.log?.(`price audit: ${hash.slice(0, 12)}… isn't the hash of its document; not published`);
      return;
    }
    this.#queue.push({ hash, canonical, network: this.#o.network ?? null });
    if (this.#queue.length > this.#o.maxPending) {
      const dropped = this.#queue.shift()!;
      this.#o.log?.(`price audit: backlog full, ${dropped.hash.slice(0, 12)}… waits for backfill() (it's in the local file)`);
    }
  }

  #schedule(ms: number) {
    if (this.#timer || this.#inFlight) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, ms);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  /** Sends what's waiting, one request at a time. Resolves once this pass is done (never rejects). */
  flush(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#inFlight = (async () => {
      while (this.#queue.length) {
        const batch = this.#queue.slice(0, this.#o.batch);
        const ok = await this.#send(batch);
        if (!ok) {
          this.failures++;
          const wait = this.#delay;
          this.#delay = Math.min(this.#delay * 2, this.#o.maxRetryMs);
          this.#inFlight = null;
          this.#schedule(wait);
          return;
        }
        this.#delay = this.#o.retryMs;
        this.#queue.splice(0, batch.length);
        for (const p of batch) this.#published.add(p.hash);
        this.sent += batch.length;
      }
    })().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #send(batch: Pending[]): Promise<boolean> {
    try {
      const res = await this.#fetch(this.#o.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-audit-token": this.#o.token },
        body: JSON.stringify({ entries: batch }),
      });
      if (!res.ok) {
        this.#o.log?.(`price audit: publish failed, HTTP ${res.status}; retrying`);
        return false;
      }
      const body = (await res.json().catch(() => ({}))) as { rejected?: { hash: string; reason: string }[] };
      // Rejections are permanent (bad hash or form): log them, don't retry them forever.
      for (const r of body.rejected ?? []) this.#o.log?.(`price audit: ${String(r.hash).slice(0, 12)}… rejected: ${r.reason}`);
      return true;
    } catch (e) {
      this.#o.log?.(`price audit: publish failed (${e instanceof Error ? e.message : e}); retrying`);
      return false;
    }
  }

  /**
   * Reads price_audit's entry documents (and every published hash) so read() returns them even
   * when the local file is gone. Call once before the Settler is built. Returns how many entry
   * documents came back. Throws on a read failure, so a missing remote is visible on start.
   */
  async load(): Promise<number> {
    const r = this.#o.read;
    if (!r) return 0;
    const base = `${r.supabaseUrl.replace(/\/+$/, "")}/rest/v1/price_audit`;
    const filters = [r.program ? `program=eq.${r.program}` : "", this.#o.network ? `network=eq.${this.#o.network}` : ""].filter(Boolean);
    const page = async (query: string, from: number) => {
      const res = await this.#fetch(`${base}?${[query, ...filters].join("&")}&order=hash`, {
        headers: { apikey: r.key, authorization: `Bearer ${r.key}`, range: `${from}-${from + 999}` },
      });
      if (!res.ok) throw new Error(`price_audit: HTTP ${res.status}`);
      return (await res.json()) as { hash: string; canonical?: string }[];
    };
    for (let from = 0; ; from += 1000) {
      const rows = await page("select=hash", from);
      for (const x of rows) this.#published.add(x.hash);
      if (rows.length < 1000) break;
    }
    let n = 0;
    for (let from = 0; ; from += 1000) {
      const rows = await page("select=hash,canonical&moment=eq.entry", from);
      for (const x of rows) {
        // Only documents that still hash to their key are trusted.
        if (!x.canonical || docHash(x.canonical) !== x.hash) continue;
        try {
          this.#remote.set(x.hash, JSON.parse(x.canonical));
          n++;
        } catch {
          // skip
        }
      }
      if (rows.length < 1000) break;
    }
    this.#queue = this.#queue.filter((p) => !this.#published.has(p.hash));
    return n;
  }

  /**
   * Queues every local document price_audit doesn't hold yet (after a restart, or an outage that
   * outlasted the backlog). Call after load(). Returns how many were queued.
   */
  backfill(): number {
    const before = this.#queue.length;
    for (const doc of this.#o.local?.read?.() ?? []) {
      const canonical = canonicalJson(doc);
      this.#enqueue(docHash(canonical), canonical);
    }
    const queued = this.#queue.length - before;
    if (queued) this.#schedule(0);
    return queued;
  }

  /** The local documents, then any published entry documents the local log doesn't have. */
  read(): unknown[] {
    const local = this.#o.local?.read?.() ?? [];
    const seen = new Set(local.map((d) => docHash(canonicalJson(d))));
    return [...local, ...[...this.#remote].filter(([h]) => !seen.has(h)).map(([, d]) => d)];
  }

  /** A last send before exit: waits for what's queued, up to `ms`. */
  async close(ms = 10_000): Promise<void> {
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, ms))]);
  }
}
