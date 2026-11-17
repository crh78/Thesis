// Where the bank lives. The poller writes through a sink; getAssetBank() and
// bestIssuer() read through the same one.
//   FileSink      one JSON file (default: <repo>/.data/asset-bank.json, gitignored)
//   SupabaseSink  tables from supabase/migrations/0004_asset_bank.sql, via PostgREST
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { envVar } from "../../registry/src/lib/env.ts";
import { BANK_VERSION, bankBestIssuer, emptyState, type BankState } from "./state.ts";

export type Dirty = { tokens: Set<string>; underlyings: Set<string>; venues: Set<string>; meta: boolean };
export const cleanDirty = (): Dirty => ({ tokens: new Set(), underlyings: new Set(), venues: new Set(), meta: false });
export const isDirty = (d: Dirty) => d.meta || d.tokens.size > 0 || d.underlyings.size > 0 || d.venues.size > 0;

export interface BankSink {
  readonly name: string;
  load(): Promise<BankState | null>;
  /** Writes what changed. A sink may write more (the file sink rewrites everything). */
  save(state: BankState, dirty: Dirty): Promise<void>;
}

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

export class FileSink implements BankSink {
  readonly name = "file";
  path: string;
  constructor(path?: string) {
    this.path = path ?? envVar("ASSET_BANK_FILE") ?? join(repoRoot(), ".data", "asset-bank.json");
  }
  async load(): Promise<BankState | null> {
    if (!existsSync(this.path)) return null;
    const s = JSON.parse(readFileSync(this.path, "utf8")) as BankState;
    return s.version === BANK_VERSION ? s : null;
  }
  async save(state: BankState): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.path); // atomic on one filesystem: readers never see half a file
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const SUPABASE_TABLES = { tokens: "asset_bank_tokens", underlyings: "asset_bank_underlyings", venues: "asset_bank_venues" } as const;

/** PostgREST upserts with the service-role key. Rows keep the full entry in `data` plus indexed columns for queries. */
export class SupabaseSink implements BankSink {
  readonly name = "supabase";
  #url: string;
  #key: string;
  #fetch: FetchLike;
  batchSize = 500;
  constructor(url: string, serviceRoleKey: string, fetchImpl: FetchLike = fetch) {
    this.#url = url.replace(/\/+$/, "");
    this.#key = serviceRoleKey;
    this.#fetch = fetchImpl;
  }

  #headers(extra: Record<string, string> = {}) {
    return { apikey: this.#key, authorization: `Bearer ${this.#key}`, "content-type": "application/json", ...extra };
  }

  async #upsert(table: string, conflict: string, rows: object[]) {
    for (let i = 0; i < rows.length; i += this.batchSize) {
      const res = await this.#fetch(`${this.#url}/rest/v1/${table}?on_conflict=${conflict}`, {
        method: "POST",
        headers: this.#headers({ prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify(rows.slice(i, i + this.batchSize)),
      });
      if (!res.ok) throw new Error(`supabase upsert ${table}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }

  async #delete(table: string, column: string, values: string[]) {
    for (let i = 0; i < values.length; i += 100) {
      const list = values.slice(i, i + 100).map((v) => `"${v}"`).join(",");
      const res = await this.#fetch(`${this.#url}/rest/v1/${table}?${column}=in.(${encodeURIComponent(list)})`, { method: "DELETE", headers: this.#headers({ prefer: "return=minimal" }) });
      if (!res.ok) throw new Error(`supabase delete ${table}: HTTP ${res.status}`);
    }
  }

  async #selectAll(table: string, order: string): Promise<any[]> {
    const out: any[] = [];
    for (let offset = 0; ; offset += 1000) {
      const res = await this.#fetch(`${this.#url}/rest/v1/${table}?select=data&order=${order}&limit=1000&offset=${offset}`, { headers: this.#headers() });
      if (!res.ok) throw new Error(`supabase select ${table}: HTTP ${res.status}`);
      const rows = (await res.json()) as { data: any }[];
      out.push(...rows.map((r) => r.data));
      if (rows.length < 1000) return out;
    }
  }

  async load(): Promise<BankState | null> {
    const [tokens, underlyings, venues] = await Promise.all([this.#selectAll(SUPABASE_TABLES.tokens, "mint"), this.#selectAll(SUPABASE_TABLES.underlyings, "key"), this.#selectAll(SUPABASE_TABLES.venues, "venue")]);
    const meta = venues.find((v) => v?.kind === "meta");
    if (!meta && !tokens.length) return null;
    const state = emptyState();
    if (meta) Object.assign(state, { version: meta.version, createdAt: meta.createdAt, updatedAt: meta.updatedAt, tiers: meta.tiers ?? {} });
    if (state.version !== BANK_VERSION) return null;
    for (const t of tokens) state.tokens[t.mint] = t;
    for (const u of underlyings) state.underlyings[u.key] = u;
    for (const v of venues) if (v?.kind === "venue") (state.venues as any)[v.venue] = v.value;
    return state;
  }

  async save(state: BankState, dirty: Dirty): Promise<void> {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const f = { maxProbeAgeMs: 20 * 60_000, maxPriceAgeMs: 10 * 60_000 };
    const tokenRows = [...dirty.tokens].filter((m) => state.tokens[m]).map((m) => {
      const t = state.tokens[m];
      return {
        mint: t.mint,
        underlying_key: t.underlying,
        symbol: t.symbol,
        issuer_tag: t.issuerTag,
        class: t.liquidity.class,
        comparable: t.ratio.comparable,
        us_persons: t.usPersons,
        price_usd: t.price?.usd ?? null,
        priced_at: t.price?.at ?? null,
        probed_at: t.probe?.at ?? null,
        units_per_usd_100: t.liquidity.unitsPerUsd100,
        cost_100_pct: t.liquidity.cost100Pct,
        updated_at: now,
        data: t,
      };
    });
    const underlyingRows = [...dirty.underlyings].filter((k) => state.underlyings[k]).map((k) => {
      const u = state.underlyings[k];
      return { key: u.key, id_hex: u.idHex, class: u.cls, code: u.code, name: u.name, themes: u.themes, best_mint: bankBestIssuer(state, u, nowMs, f)?.mint ?? null, ref_price_usd: u.refPriceUsd, updated_at: now, data: u };
    });
    const venueRows = [...dirty.venues].map((v) => ({ venue: v, refreshed_at: (state.venues as any)[v]?.at ?? null, updated_at: now, data: { kind: "venue", venue: v, value: (state.venues as any)[v] ?? null } }));
    if (dirty.meta) venueRows.push({ venue: "meta", refreshed_at: state.updatedAt, updated_at: now, data: { kind: "meta", version: state.version, createdAt: state.createdAt, updatedAt: state.updatedAt, tiers: state.tiers } as any });
    // Underlyings before tokens: tokens reference underlyings.
    await this.#upsert(SUPABASE_TABLES.underlyings, "key", underlyingRows);
    await this.#upsert(SUPABASE_TABLES.tokens, "mint", tokenRows);
    await this.#upsert(SUPABASE_TABLES.venues, "venue", venueRows);
    const goneTokens = [...dirty.tokens].filter((m) => !state.tokens[m]);
    const goneUnderlyings = [...dirty.underlyings].filter((k) => !state.underlyings[k]);
    if (goneTokens.length) await this.#delete(SUPABASE_TABLES.tokens, "mint", goneTokens);
    if (goneUnderlyings.length) await this.#delete(SUPABASE_TABLES.underlyings, "key", goneUnderlyings);
  }
}

/** ASSET_BANK_SINK=supabase uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; anything else uses the JSON file. */
export function defaultSink(get: (k: string) => string | null = envVar): BankSink {
  if (get("ASSET_BANK_SINK") === "supabase") {
    const url = get("SUPABASE_URL");
    const key = get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("ASSET_BANK_SINK=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    return new SupabaseSink(url, key);
  }
  return new FileSink(get("ASSET_BANK_FILE") ?? undefined);
}
