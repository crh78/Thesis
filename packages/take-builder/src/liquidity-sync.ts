// Keeps public.securities.liquidity in line with what can actually be bought and priced, from the
// asset bank's live probes. The catalog's flags came from a one-off registry build,
// so it still offered XLEx (a $113 pool, 40% off its stock) and pre-IPO tokens whose pools are
// under the settler's floor (never scorable). Search and the take builder only offer
// `tradeable` rows, so syncing the flag is what takes them out (and puts them back).
//
//   every token       tradeable only with both: the bank's $100 probe routes
//                     under 1% (the trade router's price-impact rule), and the floor
//                     (PRICEABLE_MIN_POOLED_USD, $50k) pooled. XLEx had $110 pooled but passed
//                     the $100 probe on one order book, so the old one-off build called it tradeable;
//   other tokens      also need a known ratio: with no stock to fall back to, a token whose units
//                     can't be compared can't be priced;
//   perps             the Phoenix market's own tradeable flag;
//   no information    (not in the bank, not probed yet): left as it is.
//
// Sent through the securities-index function's `liquidity` op (SECURITIES_INDEX_SECRET), only for
// rows whose flag changes. Refuses to run on a stale probe tier, or when it would take more than
// half of the current tradeable rows out (a probe outage looks like that).
import type { BankState, PerpMarket, TokenEntry } from "../../venues/bank/src/state.ts";
import { parseUnderlyingKey } from "../../venues/bank/src/identity.ts";
import { PRICEABLE_MIN_POOLED_USD } from "../../venues/bank/src/route.ts";
import type { IndexEnv } from "./gemini-index.ts";

export type Liquidity = "tradeable" | "thin";
export type CatalogFlag = { id: string; kind: string; liquidity: string };
export type LiquidityChange = { id: string; liquidity: Liquidity; was: string; why: string };

const SYNCED_KINDS = new Set(["stock", "etf", "commodity", "pre-ipo", "leveraged", "perp"]);
/** The probe tier must have succeeded this recently. */
export const MAX_PROBE_AGE_MS = 3 * 3_600_000;
/** Refuse a sync that would take more than this share of tradeable rows out. */
export const MAX_DOWNGRADE_SHARE = 0.5;

/** What the bank says about one token, or null when it doesn't know enough. */
export function tokenLiquidity(t: TokenEntry | undefined): { liquidity: Liquidity; why: string } | null {
  if (!t) return null;
  const c = t.liquidity.class;
  if (c === "unprobed") return null;
  if (c !== "tradeable") return { liquidity: "thin", why: `bank: ${c}${t.liquidity.reason ? ` (${t.liquidity.reason})` : ""}` };
  if (t.liquidity.ratioSuspect) return { liquidity: "thin", why: "bank: quote too good against the reference (ratio suspect)" };
  let cls: string;
  try {
    cls = parseUnderlyingKey(t.underlying).cls;
  } catch {
    return null;
  }
  const pooled = t.jupiterPooledUsd ?? 0;
  if (pooled < PRICEABLE_MIN_POOLED_USD) return { liquidity: "thin", why: `pooled $${Math.round(pooled).toLocaleString("en-US")} < the $${PRICEABLE_MIN_POOLED_USD.toLocaleString("en-US")} floor` };
  if (cls === "equity" || cls === "etf") return { liquidity: "tradeable", why: "bank: $100 routes under 1%, and pooled above the floor" };
  if (!t.ratio.comparable) return { liquidity: "thin", why: "units per token unknown" };
  return { liquidity: "tradeable", why: "bank: routes, and pooled above the settler's floor" };
}

export function perpLiquidity(m: PerpMarket | undefined): { liquidity: Liquidity; why: string } | null {
  if (!m) return null;
  return m.tradeable ? { liquidity: "tradeable", why: "Phoenix: fills $1,000 within 1%" } : { liquidity: "thin", why: "Phoenix: too thin" };
}

/** The flag changes the bank implies for these catalog rows (pure). */
export function liquidityChanges(state: BankState, catalog: CatalogFlag[]): LiquidityChange[] {
  const perps = new Map((state.venues.phoenix?.markets ?? []).map((m) => [m.symbol, m]));
  const out: LiquidityChange[] = [];
  for (const row of catalog) {
    if (!SYNCED_KINDS.has(row.kind)) continue;
    const said = row.id.startsWith("jup:")
      ? tokenLiquidity(state.tokens[row.id.slice(4)])
      : row.id.startsWith("phoenix:")
        ? perpLiquidity(perps.get(row.id.slice(8)))
        : null;
    if (!said || said.liquidity === row.liquidity) continue;
    out.push({ id: row.id, liquidity: said.liquidity, was: row.liquidity, why: said.why });
  }
  return out;
}

/** Why a sync shouldn't run now, or null. */
export function syncBlocked(state: BankState, catalog: CatalogFlag[], changes: LiquidityChange[], nowMs: number): string | null {
  const probes = state.tiers?.probes?.lastOkAt ? Date.parse(state.tiers.probes.lastOkAt) : NaN;
  if (!Number.isFinite(probes) || nowMs - probes > MAX_PROBE_AGE_MS) return "the bank's probes haven't succeeded in the last 3 hours";
  const tradeable = catalog.filter((r) => SYNCED_KINDS.has(r.kind) && r.liquidity === "tradeable").length;
  const down = changes.filter((c) => c.liquidity === "thin" && c.was === "tradeable").length;
  if (tradeable && down / tradeable > MAX_DOWNGRADE_SHARE) return `it would take ${down} of ${tradeable} tradeable rows out (a probe outage?)`;
  return null;
}

export type SyncOptions = { dryRun?: boolean; log?: (m: string) => void; nowMs?: number; fetch?: typeof fetch };

/** Reads the catalog's spot and perp flags, and sends the changes. Returns them (sent or not). */
export async function syncLiquidity(state: BankState, env: IndexEnv, o: SyncOptions = {}): Promise<LiquidityChange[]> {
  const log = o.log ?? console.log;
  const fetchFn = o.fetch ?? fetch;
  if (!env.secret && !o.dryRun) throw new Error("Need SECURITIES_INDEX_SECRET (supabase/functions/.env) to sync liquidity");
  const catalog: CatalogFlag[] = [];
  for (const prefix of ["jup:", "phoenix:"]) {
    for (let from = 0; ; from += 1000) {
      const r = await fetchFn(`${env.supabaseUrl}/rest/v1/securities?select=id,kind,liquidity&id=like.${prefix}*&order=id`, {
        headers: { apikey: env.publishableKey ?? "", authorization: `Bearer ${env.publishableKey ?? ""}`, range: `${from}-${from + 999}` },
      });
      if (!r.ok) throw new Error(`reading securities: HTTP ${r.status}`);
      const page = (await r.json()) as CatalogFlag[];
      catalog.push(...page);
      if (page.length < 1000) break;
    }
  }
  const changes = liquidityChanges(state, catalog);
  const blocked = syncBlocked(state, catalog, changes, o.nowMs ?? Date.now());
  const up = changes.filter((c) => c.liquidity === "tradeable").length;
  log(`liquidity sync: ${catalog.length} rows, ${up} to tradeable, ${changes.length - up} to thin${blocked ? `; not sent: ${blocked}` : ""}`);
  for (const c of changes.slice(0, 5)) log(`  ${c.id}: ${c.was} → ${c.liquidity} (${c.why})`);
  if (blocked || o.dryRun || !changes.length) return changes;
  for (let i = 0; i < changes.length; i += 500) {
    const res = await fetchFn(`${env.supabaseUrl}/functions/v1/securities-index`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-index-secret": env.secret! },
      body: JSON.stringify({ liquidity: changes.slice(i, i + 500).map((c) => ({ id: c.id, liquidity: c.liquidity })) }),
    });
    if (!res.ok) throw new Error(`securities-index liquidity: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return changes;
}
