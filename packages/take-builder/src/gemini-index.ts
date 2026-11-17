// Keeps the take builder's Gemini contracts current in public.securities, from contracts already
// read through the Supabase `gemini` proxy (a sweep: index-gemini.ts, or the asset-bank poller
// after its own sweep, so a sweep isn't paid for twice):
//   - sends contracts not indexed yet to the securities-index function (rows bring their own
//     description, so no model call per contract);
//   - takes contracts that expired over a day ago out of search and the builder's catalog
//     (`unindex` marks them `thin`; rows and links stay);
//   - (old event-level rows, gemini:<eventTicker>, are all thin now, and index-catalog no longer
//     upserts prediction rows, so none come back.)
// Needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (.env) and SECURITIES_INDEX_SECRET
// (supabase/functions/.env), the same values as the deployed functions.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GeminiContract } from "../../venues/gemini/src/markets.ts";
import { geminiRows } from "./gemini.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");

export type IndexEnv = { supabaseUrl: string; secret: string | null; publishableKey: string | null; batch: number; parallel: number };

function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch {}
  return out;
}

/** Settings from the environment, the repo-root .env and supabase/functions/.env. Null without SUPABASE_URL. */
export function geminiIndexEnv(env: Record<string, string | undefined> = process.env): IndexEnv | null {
  const all = { ...readEnv(join(root, ".env")), ...readEnv(join(root, "supabase/functions/.env")), ...env };
  if (!all.SUPABASE_URL) return null;
  return {
    supabaseUrl: all.SUPABASE_URL.replace(/\/+$/, ""),
    secret: all.SECURITIES_INDEX_SECRET ?? null,
    publishableKey: all.SUPABASE_PUBLISHABLE_KEY ?? null,
    // Small batches, so a slow request can't hit the function's compute budget (HTTP 546
    // WORKER_RESOURCE_LIMIT). A batch that hits it is split.
    batch: Number(all.INDEX_GEMINI_BATCH ?? 3),
    parallel: Number(all.INDEX_GEMINI_PARALLEL ?? 2),
  };
}

/** Contracts that expired more than this long ago leave search. */
export const UNINDEX_AFTER_MS = 24 * 3_600_000;
const UNINDEX_CHUNK = 500;

export type IndexOptions = { all?: boolean; dryRun?: boolean; log?: (m: string) => void; nowMs?: number; fetch?: typeof fetch };
export type IndexSummary = { contracts: number; eligible: number; fresh: number; indexed: number; unindexed: number };

export async function indexGeminiContracts(contracts: GeminiContract[], env: IndexEnv, o: IndexOptions = {}): Promise<IndexSummary> {
  const log = o.log ?? console.log;
  const fetchFn = o.fetch ?? fetch;
  const nowMs = o.nowMs ?? Date.now();
  if (!env.secret && !o.dryRun) throw new Error("Need SECURITIES_INDEX_SECRET (supabase/functions/.env) to index Gemini contracts");
  const read = (query: string, from: number) =>
    fetchFn(`${env.supabaseUrl}/rest/v1/securities?${query}`, {
      headers: { apikey: env.publishableKey ?? "", authorization: `Bearer ${env.publishableKey ?? ""}`, range: `${from}-${from + 999}` },
    });
  /** Rows matching a PostgREST filter (the table is publicly readable). */
  async function list(query: string): Promise<{ id: string; liquidity?: string }[]> {
    const out: { id: string; liquidity?: string }[] = [];
    for (let from = 0; ; from += 1000) {
      const r = await read(query, from);
      if (!r.ok) throw new Error(`reading securities: HTTP ${r.status}`);
      const page = (await r.json()) as { id: string; liquidity?: string }[];
      out.push(...page);
      if (page.length < 1000) return out;
    }
  }

  const rows = geminiRows(contracts, nowMs);
  const known = new Map((await list("select=id,liquidity&id=like.gemini:*")).map((r) => [r.id, r.liquidity]));
  const indexed = new Set(known.keys());
  const fresh = o.all ? rows : rows.filter((r) => !indexed.has(r.id));
  const cutoff = new Date(nowMs - UNINDEX_AFTER_MS).toISOString();
  const expired = (await list(`select=id&id=like.gemini:*&kind=eq.prediction&expires_at=lt.${cutoff}&liquidity=eq.tradeable`)).map((r) => r.id);
  log(`gemini index: ${contracts.length} contracts, ${rows.length} eligible, ${fresh.length} new, ${expired.length} expired to unindex`);
  const summary: IndexSummary = { contracts: contracts.length, eligible: rows.length, fresh: fresh.length, indexed: 0, unindexed: 0 };
  if (o.dryRun) {
    for (const r of fresh.slice(0, 3)) log(`  e.g. ${r.id}: ${r.name}`);
    return summary;
  }

  const post = async (body: unknown) => {
    const res = await fetchFn(`${env.supabaseUrl}/functions/v1/securities-index`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-index-secret": env.secret! },
      body: JSON.stringify(body),
    }).catch(() => null);
    return { res, text: res ? await res.text() : "" };
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function send(batch: unknown[]): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const { res, text } = await post({ rows: batch });
      if (res?.ok) {
        summary.indexed += JSON.parse(text).indexed ?? 0;
        return;
      }
      if (res?.status === 546 && batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        await send(batch.slice(0, half));
        return send(batch.slice(half));
      }
      if (attempt >= 5) throw new Error(`securities-index: ${res?.status ?? "network"} ${text.slice(0, 200)}`);
      await sleep(1_000 * attempt);
    }
  }

  const queue: unknown[][] = [];
  const toSend = fresh;
  for (let i = 0; i < toSend.length; i += env.batch) queue.push(toSend.slice(i, i + env.batch));
  const total = queue.length;
  let done = 0;
  await Promise.all(Array.from({ length: env.parallel }, async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      await send(batch);
      if (++done % 100 === 0) log(`gemini index: batch ${done}/${total}`);
    }
  }));
  for (let i = 0; i < expired.length; i += UNINDEX_CHUNK) {
    const chunk = expired.slice(i, i + UNINDEX_CHUNK);
    const { res, text } = await post({ unindex: chunk });
    if (!res?.ok) throw new Error(`securities-index unindex: ${res?.status ?? "network"} ${text.slice(0, 200)}`);
    summary.unindexed += JSON.parse(text).unindexed ?? 0;
  }
  log(`gemini index: ${toSend.length} rows sent, ${summary.indexed} indexed, ${summary.unindexed} expired unindexed`);
  return summary;
}
