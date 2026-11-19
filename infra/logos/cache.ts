// Stores a logo for every stock and ETF the app can trade in apps/www/public/logos/, so the web
// app shows them from its own host instead of waiting on (or being refused by) another site.
//
//   pnpm logos:cache        fetch the catalog's tickers and their logos, rewrite the manifest
//
// Tickers come from the hosted catalog (public.securities: kind stock or etf, liquidity tradeable
// or thin, by underlying). Each logo is Financial Modeling Prep's by ticker, unless OVERRIDES
// names a better source (FMP's is wrong or a placeholder for those). Writes
// apps/www/public/logos/<TICKER>.<ext> and apps/www/lib/logos.json ({ ticker: file }), which the
// app reads to know which tickers it has. A ticker whose logo can't be fetched is left out, and
// the app falls back to FMP for it, as before. SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY come
// from the environment or the repo-root .env; nothing about the caller is sent anywhere.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envVar } from "../../packages/venues/registry/src/lib/env.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(root, "apps/www/public/logos");
const manifestPath = join(root, "apps/www/lib/logos.json");

const favicon = (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
const fmp = (ticker: string) => `https://financialmodelingprep.com/image-stock/${ticker}.png`;

/** Tickers whose FMP logo is wrong or a placeholder (checked by eye, 2026-11-19). */
const OVERRIDES: Record<string, string> = {
  FLY: favicon("fireflyspace.com"), // Firefly Aerospace; FMP has Fly Leasing, the ticker's old owner
  DJT: favicon("tmtgcorp.com"), // Trump Media; FMP has the old SPAC
  STRC: favicon("strategy.com"), // Strategy's preferred; FMP has another company
  FWDI: favicon("forwardindustries.com"), // Forward Industries; FMP shows "AS"
  SKHY: "https://commons.wikimedia.org/wiki/Special:FilePath/SK_logo.svg", // SK hynix; FMP's is a blurry crop
  IVV: fmp("EWY"), // iShares; FMP shows a lone "i" for these two
  SLV: fmp("EWY"),
};

const EXT: Record<string, string> = { "image/png": "png", "image/svg+xml": "svg", "image/jpeg": "jpg", "image/webp": "webp" };

async function tickers(): Promise<string[]> {
  const url = envVar("SUPABASE_URL"), key = envVar("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set (repo-root .env).");
  const r = await fetch(`${url}/rest/v1/securities?select=underlying,symbol&kind=in.(stock,etf)&liquidity=in.(tradeable,thin)&limit=5000`, {
    headers: { apikey: key },
  });
  if (!r.ok) throw new Error(`catalog read failed: HTTP ${r.status}`);
  const rows = (await r.json()) as { underlying: string | null; symbol: string }[];
  const set = new Set(rows.map((x) => (x.underlying ?? x.symbol).toUpperCase()).filter((t) => /^[A-Z0-9.]{1,12}$/.test(t)));
  return [...set].sort();
}

async function fetchLogo(ticker: string): Promise<{ ext: string; bytes: Uint8Array } | null> {
  const src = OVERRIDES[ticker] ?? fmp(ticker);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(src, { headers: { "user-agent": "thesis-logo-cache/1.0" }, redirect: "follow" }).catch(() => null);
    if (r?.ok) {
      const ext = EXT[(r.headers.get("content-type") ?? "").split(";")[0].trim()];
      const bytes = new Uint8Array(await r.arrayBuffer());
      // FMP answers unknown tickers with a tiny placeholder: from FMP, under ~600 bytes isn't a logo.
      return ext && (OVERRIDES[ticker] || bytes.length > 600) ? { ext, bytes } : null;
    }
    if (r && r.status < 500 && r.status !== 429) return null;
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  return null;
}

const list = await tickers();
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) rmSync(join(outDir, f));
const manifest: Record<string, string> = {};
const missing: string[] = [];
for (let i = 0; i < list.length; i += 8) {
  await Promise.all(list.slice(i, i + 8).map(async (t) => {
    const logo = await fetchLogo(t);
    if (!logo) return void missing.push(t);
    const file = `${t}.${logo.ext}`;
    writeFileSync(join(outDir, file), logo.bytes);
    manifest[t] = file;
  }));
}
writeFileSync(manifestPath, JSON.stringify(Object.fromEntries(Object.entries(manifest).sort()), null, 1) + "\n");
console.log(`${Object.keys(manifest).length} logos in apps/www/public/logos${missing.length ? `; none for ${missing.sort().join(", ")}` : ""}`);
