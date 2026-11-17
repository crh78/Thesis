// securities-index: loads the take builder's catalog into public.securities.
//
//   POST { rows: CatalogRow[], force?: boolean }   header x-index-secret: <SECURITIES_INDEX_SECRET>
//   POST { unindex: string[] }   prediction rows only: marks them `thin` (kept, and still linked
//                                from posted takes, but out of search and the take builder's
//                                catalog, which offer only `tradeable` rows). Indexing them again
//                                restores them.
//   POST { liquidity: { id, liquidity: "tradeable" | "thin" }[] }   spot and perp rows only: what the
//                                asset bank's live probes say can be bought and priced
//                                (packages/take-builder/src/liquidity-sync.ts). Search and the take
//                                builder offer only `tradeable` rows.
//
// For each row: writes a 1–2 sentence description + themes (only if missing,
// or force) and upserts. Search (`search_assets`, full text over `search_doc`) and the take
// builder (`basket_catalog`, BM25) read the description and themes; nothing uses embeddings
// any more, so none are computed. `indexed_text` records the indexed text.
// Rows come from packages/take-builder (catalog.ts → index-catalog.ts).
//
// Descriptions: OPENAI_FAST_MODEL. Secrets: SECURITIES_INDEX_SECRET, OPENAI_API_KEY (+ platform SUPABASE_*).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { jsonCall } from "../_shared/openai.ts";

const SECRET = Deno.env.get("SECURITIES_INDEX_SECRET") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type CatalogRow = {
  id: string; kind: string; symbol: string; name: string; underlying: string | null; issuer: string | null;
  venue: string; mint: string | null; themes: string[]; liquidity: string; us_persons: string;
  can_short: boolean; expires_at: string | null; data: Record<string, unknown>;
};
type Described = { id: string; description: string; themes: string[] };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sameSecret(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const KIND_LABEL: Record<string, string> = {
  stock: "Stock", etf: "ETF", commodity: "Commodity", "pre-ipo": "Pre-IPO company", leveraged: "Leveraged stock",
  yield: "Cash yield", perp: "Perpetual future", prediction: "Prediction market", card: "Trading cards", other: "Asset",
};

async function describe(rows: CatalogRow[]): Promise<Described[]> {
  const items = rows.map((r) => ({
    id: r.id, kind: KIND_LABEL[r.kind] ?? r.kind, name: r.name, symbol: r.symbol, underlying: r.underlying,
    venue: r.venue, issuer: r.issuer, themes: r.themes, expires: r.expires_at,
  }));
  const system =
    "You write catalog entries for a search index of investable things (stocks, ETFs, commodities, pre-IPO companies, " +
    "prediction markets, perpetual futures, cash yield, trading cards). For each item write: description = 1-2 plain " +
    "sentences on what the underlying business/market is and what tends to move it (who benefits from which trends). " +
    "No prices, no numbers, no dates you are unsure of, no hype. For tokenized stocks describe the company, not the " +
    "token. For prediction markets describe the question. themes = 3-6 short lowercase investment themes it is exposed " +
    "to (e.g. 'ai data centers', 'electricity demand', 'interest rates'). If you don't know the item, say so briefly " +
    "from its name only.";
  const schema = {
    type: "object", additionalProperties: false, required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["id", "description", "themes"],
          properties: { id: { type: "string" }, description: { type: "string" }, themes: { type: "array", items: { type: "string" } } },
        },
      },
    },
  };
  const parsed = await jsonCall<{ items: Described[] }>(system, items, "catalog_entries", schema, { maxTokens: 6000 });
  return parsed.items;
}

function indexText(r: CatalogRow, description: string, themes: string[]) {
  return `${r.name} (${r.symbol}). ${KIND_LABEL[r.kind] ?? r.kind} on ${r.venue}.` +
    (r.underlying ? ` Underlying: ${r.underlying}.` : "") +
    ` ${description} Themes: ${themes.join(", ")}.`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!sameSecret(req.headers.get("x-index-secret") ?? "", SECRET)) return json(401, { error: "unauthorized" });

  let body: { rows?: CatalogRow[]; force?: boolean; unindex?: string[]; liquidity?: { id?: unknown; liquidity?: unknown }[] };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (Array.isArray(body.liquidity)) {
    const items = body.liquidity.slice(0, 1000);
    const byClass: Record<"tradeable" | "thin", string[]> = { tradeable: [], thin: [] };
    for (const x of items) {
      if (typeof x?.id === "string" && (x.liquidity === "tradeable" || x.liquidity === "thin")) byClass[x.liquidity].push(x.id);
    }
    let updated = 0;
    for (const [liquidity, ids] of Object.entries(byClass)) {
      if (!ids.length) continue;
      const { error, count } = await db.from("securities")
        .update({ liquidity, updated_at: new Date().toISOString() }, { count: "exact" })
        .in("id", ids).in("kind", ["stock", "etf", "commodity", "pre-ipo", "leveraged", "perp"]);
      if (error) return json(500, { error: error.message });
      updated += count ?? 0;
    }
    return json(200, { updated });
  }
  if (Array.isArray(body.unindex)) {
    const ids = body.unindex.filter((id) => typeof id === "string").slice(0, 500);
    const { error, count } = await db.from("securities")
      .update({ liquidity: "thin", updated_at: new Date().toISOString() }, { count: "exact" })
      .in("id", ids).eq("kind", "prediction");
    if (error) return json(500, { error: error.message });
    return json(200, { unindexed: count ?? 0 });
  }
  const rows = body.rows ?? [];
  if (!rows.length || rows.length > 60) return json(400, { error: "send 1-60 rows" });

  const { data: existing, error: readErr } = await db.from("securities")
    .select("id, description, themes").in("id", rows.map((r) => r.id));
  if (readErr) return json(500, { error: readErr.message });
  const prev = new Map((existing ?? []).map((e) => [e.id as string, e]));

  // 1. Descriptions for rows that don't have one yet. A row can bring its own (Gemini contracts:
  // the event and the contract say what they are), which saves a model call per row.
  const given = (r: CatalogRow) => (typeof r.data?.description === "string" ? (r.data.description as string) : null);
  const toDescribe = rows.filter((r) => !given(r) && (body.force || !prev.get(r.id)?.description));
  const described = new Map<string, Described>();
  if (toDescribe.length) {
    for (const d of await describe(toDescribe)) described.set(d.id, d);
  }

  // 2. The text each row is indexed by.
  const final = rows.map((r) => {
    const d = described.get(r.id);
    const description = given(r) ?? d?.description ?? (prev.get(r.id)?.description as string | undefined) ?? r.name;
    const generated = d?.themes ?? [];
    const themes = [...new Set([...r.themes.map((t) => t.toLowerCase()), ...generated.map((t) => t.toLowerCase())])].slice(0, 10);
    return { r, description, themes, text: indexText(r, description, themes) };
  });

  // 3. Upsert.
  const upserts = final.map(({ r, description, themes, text }) => ({
    ...r,
    description,
    themes,
    indexed_text: text,
    updated_at: new Date().toISOString(),
  }));
  const { error: writeErr } = await db.from("securities").upsert(upserts, { onConflict: "id" });
  if (writeErr) return json(500, { error: writeErr.message });

  return json(200, { rows: rows.length, described: described.size, indexed: rows.length });
});
