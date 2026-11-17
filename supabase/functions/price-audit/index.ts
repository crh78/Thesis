// price-audit: publishes the market data behind the settler's signed prices (public.price_audit).
//
//   POST { entries: [{ hash, canonical, network? }] }   header x-audit-token: <PRICE_AUDIT_TOKEN>
//     hash       sha256 hex of `canonical`, the same 32 bytes the settler put on chain as source_hash
//     canonical  the document exactly as hashed (canonicalJson in apps/executor/src/settler/audit.ts)
//   → { stored, duplicate, rejected: [{ hash, reason }] }
//
// Each entry is checked here, not trusted: the hash is recomputed from `canonical`, and
// `canonical` must already be in canonical form (keys sorted at every level), so the stored jsonb
// and the hashed text are the same document. Idempotent on hash. Reading is public (price_audit
// and price_events() through PostgREST); nothing else writes the table.
// Secrets: PRICE_AUDIT_TOKEN (+ platform SUPABASE_*).

import { createClient } from "jsr:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("PRICE_AUDIT_TOKEN") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const MAX_ENTRIES = 100;
const MAX_CANONICAL_BYTES = 512 * 1024;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sameSecret(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Same as canonicalJson in apps/executor/src/settler/audit.ts: keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    }
    return v;
  });
}

async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Entry = { hash?: unknown; canonical?: unknown; network?: unknown };
type Row = {
  hash: string; network: string | null; program: string | null; take: string | null; position: string | null;
  moment: string | null; moment_at: number | null; canonical: string; doc: unknown;
};

/** The row to store for one entry, or why it's refused. */
export async function checkEntry(e: Entry): Promise<{ ok: true; row: Row } | { ok: false; reason: string }> {
  if (typeof e.hash !== "string" || !/^[0-9a-f]{64}$/.test(e.hash)) return { ok: false, reason: "hash must be 64 lowercase hex characters" };
  if (typeof e.canonical !== "string" || !e.canonical) return { ok: false, reason: "canonical must be the hashed document text" };
  if (new TextEncoder().encode(e.canonical).length > MAX_CANONICAL_BYTES) return { ok: false, reason: "document too large" };
  if ((await sha256Hex(e.canonical)) !== e.hash) return { ok: false, reason: "sha256(canonical) is not the hash" };
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(e.canonical);
  } catch {
    return { ok: false, reason: "canonical is not JSON" };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, reason: "the document must be an object" };
  if (canonicalJson(doc) !== e.canonical) return { ok: false, reason: "canonical isn't in canonical form (sorted keys, no spaces)" };
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const moment = str(doc.moment);
  return {
    ok: true,
    row: {
      hash: e.hash,
      network: str(e.network),
      program: str(doc.program),
      take: str(doc.take),
      position: str(doc.position),
      moment: moment && ["entry", "exit", "sale"].includes(moment) ? moment : null,
      moment_at: typeof doc.momentAt === "number" ? doc.momentAt : null,
      canonical: e.canonical,
      doc,
    },
  };
}

if (import.meta.main) {
  Deno.serve(async (req) => {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (!sameSecret(req.headers.get("x-audit-token") ?? "", TOKEN)) return json(401, { error: "unauthorized" });
    let body: { entries?: Entry[] };
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid_json" });
    }
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (!entries.length || entries.length > MAX_ENTRIES) return json(400, { error: `send 1-${MAX_ENTRIES} entries` });

    const rows: Row[] = [];
    const rejected: { hash: unknown; reason: string }[] = [];
    for (const e of entries) {
      const r = await checkEntry(e);
      if (r.ok) rows.push(r.row);
      else rejected.push({ hash: e.hash, reason: r.reason });
    }
    let stored = 0;
    if (rows.length) {
      const { data, error } = await db.from("price_audit").upsert(rows, { onConflict: "hash", ignoreDuplicates: true }).select("hash");
      if (error) return json(500, { error: error.message });
      stored = data?.length ?? 0;
    }
    return json(200, { stored, duplicate: rows.length - stored, rejected });
  });
}
