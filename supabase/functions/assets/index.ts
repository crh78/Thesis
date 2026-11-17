// assets: search what you can put in a basket, and asset pages.
//
//   GET /assets/search?q=&limit=       → { assets: [summary] }  tickers and names first
//                                        ("nvda", "nvidia", "nvi" while typing), then general
//                                        searches by theme and description ("ai", "chip
//                                        makers", "housing"); an empty q lists the most traded.
//                                        One indexed query (search_assets, ~15-80 ms) and prices
//                                        capped at 900 ms: a slow price shows without it.
//   GET /assets/:id?range=1D|1W|1M|1Y  → { asset, price, chart }  one asset's page
//   GET /assets/:id/chart?range=       → { chart }
//   header privy-token: <jwt>  (or x-index-secret for admin testing, as a US user)
//
// Takes that hold an asset are a public read: the app calls asset_takes() directly, like the
// other feeds, so fork builds get their chain counts.
//
// Prices: Jupiter Price API (live, by token). History: GeckoTerminal OHLCV of the token's
// most traded pool, cached in public.asset_charts. Both are free; COINGECKO_API_KEY (a free demo
// key) makes the history reliable (see _shared/catalog.ts).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { privyDid } from "../_shared/privy.ts";
import {
  assetSummary, chart, displayName, firstSentence, kindLabel, priceMint, prices,
  RANGES, type Range, type Security, SECURITY_COLUMNS, treatAsUS, unavailableNote, US_RESTRICTIONS, withLiveApy,
} from "../_shared/catalog.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const INDEX_SECRET = Deno.env.get("SECURITIES_INDEX_SECRET") ?? "";
/** Search answers without prices rather than wait longer than this for them. */
const SEARCH_PRICE_MS = 900;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sameSecret(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isUSPerson(did: string | null) {
  if (!US_RESTRICTIONS) return false;
  if (!did) return true;
  const { data } = await db.from("accounts").select("country").eq("privy_did", did).maybeSingle();
  return treatAsUS(data?.country);
}

// --- Search ---------------------------------------------------------------------------------------

async function search(q: string, limit: number, usPerson: boolean) {
  // One query (migrations/*_asset_search.sql): tickers and names, then full-text over themes
  // and descriptions. It used to be a LIKE scan plus an embedding and a vector search (1-3 s).
  const { data, error } = await db.rpc("search_assets", { p_query: q, p_us_person: usPerson, p_limit: limit });
  if (error) throw new Error(`search_assets: ${error.message}`);
  const found = (data ?? []) as Security[];

  // Yield rows show the Jupiter Lend vault's live APY (the catalog's is a snapshot).
  await withLiveApy(found);
  // Prices are cached per worker; a cold or slow lookup shouldn't hold the results back.
  const mints = found.map((s) => s.mint).filter((m): m is string => !!m);
  type Quotes = Awaited<ReturnType<typeof prices>>;
  const quoted = await Promise.race([
    prices(mints),
    new Promise<Quotes>((resolve) => setTimeout(() => resolve(new Map() as Quotes), SEARCH_PRICE_MS)),
  ]);
  return found.map((s) => assetSummary(s, usPerson, s.mint ? quoted.get(s.mint) : null));
}

// --- Asset page -----------------------------------------------------------------------------------

async function page(id: string, range: Range, usPerson: boolean) {
  const { data, error } = await db.from("securities").select(SECURITY_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const s = data as Security;
  await withLiveApy([s]);
  const mint = await priceMint(db, s);
  const [quote, points] = await Promise.all([
    mint ? prices([mint]).then((m) => m.get(mint) ?? null) : Promise.resolve(null),
    mint && s.kind !== "yield" ? chart(db, s.id, mint, range) : Promise.resolve(null),
  ]);
  const summary = assetSummary(s, usPerson, quote);
  return {
    asset: {
      ...summary,
      about: s.description ?? summary.about,
      issuer: s.issuer,
      // What "fade" does for this asset, in the app's words; null = it can't be faded.
      fade_how: s.can_short ? (s.kind === "prediction" ? "Bets No" : "Bets the stock falls") : null,
      unavailable_note: summary.available ? null : unavailableNote,
      /** The words the app puts on a pick made from this asset (same as the take builder's). */
      pick: { name: s.kind === "yield" ? "Cash" : displayName(s.name), kind: kindLabel(s.kind), why: firstSentence(s.description) ?? "" },
    },
    price: quote ? { usd: quote.usd, change_24h_pct: quote.change24hPct, source: quote.source ?? "token", note: quote.note ?? null } : null,
    // A dust pool's chart is as wrong as its price: none when the stock's price stands in.
    chart: points && quote?.source !== "stock" ? { range, points } : null,
  };
}

// --- Handler --------------------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
  const admin = sameSecret(req.headers.get("x-index-secret") ?? "", INDEX_SECRET);
  const did = admin ? null : await privyDid(req);
  if (!admin && !did) return json(401, { error: "invalid_privy_token" });

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("assets");
  const [first, sub] = parts.slice(at + 1).map(decodeURIComponent);
  const range = (RANGES as string[]).includes(url.searchParams.get("range") ?? "") ? url.searchParams.get("range") as Range : "1M";

  try {
    const usPerson = await isUSPerson(did);
    if (first === "search" && !sub) {
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 40);
      return json(200, { assets: await search(q, limit, usPerson) });
    }
    if (first && !sub) {
      const out = await page(first, range, usPerson);
      return out ? json(200, out) : json(404, { error: "not_found" });
    }
    if (first && sub === "chart") {
      const out = await page(first, range, usPerson);
      return out ? json(200, { chart: out.chart }) : json(404, { error: "not_found" });
    }
    return json(404, { error: "no_such_route" });
  } catch (e) {
    console.error(e);
    return json(500, { error: "internal" });
  }
});
