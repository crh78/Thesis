// Price sweep: tries to break basket pricing against live mainnet data, one check per kind.
//
//   node apps/executor/scripts/price-sweep.ts [--bank <asset-bank.json>] [--only stocks,perps,...]
//        [--app N] [--gemini N] [--json out.json]
//
// Sections (each prints PASS / WARN / FAIL lines and a summary):
//   stocks     tokenized stocks + ETFs: token-implied price vs Alpaca's last trade vs Jupiter's own
//              stock price; issuers of the same stock vs each other
//   commodity  PAXG etc. vs Pyth metal spot
//   perps      Phoenix mid and last mark vs Pyth spot of the underlying (per underlying unit)
//   predict    Gemini contracts: prices in [0,1], bid <= ask, yes+no asks >= 1, legPrice() fade math
//   yield      what the settler can price for each catalog yield row (Jupiter Lend share value only)
//   settle     runs the settler's own priceLeg() on every tradeable catalog row as an entry now,
//              and as a late entry (past the live window): what can actually be scored
//   app        the app's asset page (/assets/:id): shown price vs live Jupiter, chart's last
//              point vs shown price (catches charts that ignore the xStocks multiplier)
//   catalog    DB consistency: picks with no catalog row, expired or illiquid picks, kind mismatches
//
// Reads keys from the repo-root .env (and supabase/functions/.env for SECURITIES_INDEX_SECRET).
// Read-only: it never writes to Supabase or the chain.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fetchGeminiEvent, geminiProxy, legPrice, type GeminiContract } from "@thesis/venues/gemini";
import { jupiterLendShareValue } from "@thesis/venues/jupiter";
import { PhoenixVenue } from "@thesis/venues/phoenix";
import type { BankState, TokenEntry } from "@thesis/venues/bank";
import { envVar } from "../../../packages/venues/registry/src/lib/env.ts";
import { AlpacaStocks, JupiterPrices, priceLeg, type LegToPrice, type PriceRules, type Sources } from "../src/settler/index.ts";
import { alpacaLatest as alpacaRef, cryptoSpot, metalSpot } from "./refs.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : null;
};
const only = arg("only")?.split(",") ?? null;
const run = (s: string) => !only || only.includes(s);
const fnEnv = (() => {
  const p = join(REPO, "supabase/functions/.env");
  const out: Record<string, string> = {};
  if (existsSync(p)) for (const l of readFileSync(p, "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
})();

const SUPABASE_URL = envVar("SUPABASE_URL")!;
const SUPABASE_KEY = envVar("SUPABASE_PUBLISHABLE_KEY")!;
const JUP_KEY = envVar("JUPITER_API_KEY");
// Prices go through the keyless lite-api so the sweep doesn't eat the asset bank's keyed budget.
const JUP = "https://lite-api.jup.ag";
const JUP_H: Record<string, string> = {};
const ALPACA_H = { "APCA-API-KEY-ID": envVar("ALPACA_API_KEY_ID") ?? "", "APCA-API-SECRET-KEY": envVar("ALPACA_API_SECRET_KEY") ?? "" };
const retry = async <T>(fn: () => Promise<T>, tries = 6): Promise<T> => {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries || !/429|5\d\d/.test(String(e))) throw e; await new Promise((r) => setTimeout(r, Math.min(30_000, 1500 * 2 ** i))); }
  }
};
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (a: number, b: number) => (a / b - 1) * 100;
const f = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(d));

// --- Report --------------------------------------------------------------------------------------
type Level = "PASS" | "WARN" | "FAIL" | "INFO";
type Finding = { section: string; level: Level; id: string; msg: string; data?: unknown };
const findings: Finding[] = [];
const note = (section: string, level: Level, id: string, msg: string, data?: unknown) => {
  findings.push({ section, level, id, msg, data });
  if (level !== "PASS" || process.argv.includes("--verbose")) console.log(`  ${level.padEnd(4)} ${id.padEnd(28)} ${msg}`);
};
const header = (s: string) => console.log(`\n== ${s} ${"=".repeat(Math.max(0, 70 - s.length))}`);

async function getJson(url: string, headers: Record<string, string> = {}, tries = 6): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) }).catch((e) => ({ ok: false, status: 0, e }) as any);
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500 || r.status === 0) && i < tries) {
      await sleep(Math.min(30_000, 1500 * 2 ** i));
      continue;
    }
    throw new Error(`${new URL(url).host}${new URL(url).pathname}: HTTP ${r.status}`);
  }
}
const sb = (path: string) => getJson(`${SUPABASE_URL}/rest/v1/${path}`, { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` });

// --- Inputs --------------------------------------------------------------------------------------
type Security = {
  id: string; kind: string; symbol: string; name: string; underlying: string | null; issuer: string | null;
  venue: string; mint: string | null; liquidity: string; us_persons: string; can_short: boolean; expires_at: string | null; data: any;
};
async function catalog(): Promise<Security[]> {
  const out: Security[] = [];
  // Predictions are ~15k rows: only the tradeable non-prediction rows in full, predictions sampled later.
  for (let from = 0; ; from += 1000) {
    const page: Security[] = await sb(`securities?select=id,kind,symbol,name,underlying,issuer,venue,mint,liquidity,us_persons,can_short,expires_at,data&kind=neq.prediction&order=id&offset=${from}&limit=1000`);
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

const bankPath = arg("bank") ?? envVar("ASSET_BANK_FILE") ?? join(REPO, ".data/asset-bank.json");
const bank: BankState | null = existsSync(bankPath) ? JSON.parse(readFileSync(bankPath, "utf8")) : null;
const tokenByMint = new Map<string, TokenEntry>(Object.entries(bank?.tokens ?? {}));

async function jupPrices(mints: string[]): Promise<Map<string, { usdPrice: number; liquidity: number; stock: number | null; raw: any }>> {
  const out = new Map();
  const uniq = [...new Set(mints)];
  for (let i = 0; i < uniq.length; i += 50) {
    const batch = uniq.slice(i, i + 50);
    const j = await getJson(`${JUP}/price/v3?ids=${batch.join(",")}`, JUP_H);
    for (const m of batch) {
      const p = j?.[m];
      if (p && typeof p.usdPrice === "number") out.set(m, { usdPrice: p.usdPrice, liquidity: p.liquidity ?? 0, stock: p.stockData?.price ?? null, raw: p });
    }
    await sleep(1400);
  }
  return out;
}

async function alpacaLatest(symbols: string[]): Promise<Map<string, { p: number; t: number }>> {
  const out = new Map();
  const uniq = [...new Set(symbols)];
  for (let i = 0; i < uniq.length; i += 100) {
    const batch = uniq.slice(i, i + 100);
    const j = await getJson(`https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${encodeURIComponent(batch.join(","))}&feed=iex`, ALPACA_H);
    for (const [s, t] of Object.entries<any>(j?.trades ?? {})) out.set(s, { p: t.p, t: Math.floor(Date.parse(t.t) / 1000) });
  }
  return out;
}

// --- 1. Stocks and ETFs ----------------------------------------------------------------------------
async function stocks(cat: Security[]) {
  header("stocks + ETFs: token-implied vs Alpaca vs Jupiter's stock price");
  const rows = cat.filter((s) => (s.kind === "stock" || s.kind === "etf") && s.mint && s.liquidity !== "n/a");
  const jp = await jupPrices(rows.map((s) => s.mint!));
  const codes = rows.map((s) => s.underlying).filter((x): x is string => !!x);
  const alp = await alpacaLatest(codes).catch((e) => (note("stocks", "FAIL", "alpaca", String(e)), new Map()));
  const marketOpenish = [...alp.values()].some((t) => nowSec() - t.t < 900);
  console.log(`  ${rows.length} rows, ${jp.size} Jupiter prices, ${alp.size}/${new Set(codes).size} Alpaca symbols, market ${marketOpenish ? "open" : "closed (comparing to last trade)"}`);
  const warn = marketOpenish ? 1.5 : 3;
  const fail = marketOpenish ? 4 : 8;
  const byU = new Map<string, { id: string; implied: number; issuer: string; liq: number }[]>();
  for (const s of rows) {
    const p = jp.get(s.mint!);
    const tok = tokenByMint.get(s.mint!);
    const perUi = tok?.ratio.comparable ? tok.ratio.underlyingPerUiToken : tok ? null : 1;
    const tag = `${s.symbol} (${s.issuer?.split(" ")[0] ?? "?"}, ${s.liquidity})`;
    if (!p) { note("stocks", s.liquidity === "tradeable" ? "FAIL" : "WARN", tag, `${s.liquidity} in the catalog but Jupiter has no price`); continue; }
    if (perUi == null) { note("stocks", "WARN", tag, `bank marks the ratio not comparable${tok && !tok.ratio.comparable ? `: ${tok.ratio.reason}` : ""}`); continue; }
    if (tok?.liquidity.ratioSuspect) note("stocks", "FAIL", tag, `bank flags ratioSuspect (quote too good vs reference: multiplier probably wrong)`);
    const implied = p.usdPrice / perUi;
    const ref = s.underlying ? alp.get(s.underlying) : undefined;
    if (!s.underlying) { note("stocks", "WARN", tag, "no underlying ticker: settler has no stock fallback"); continue; }
    if (!ref) { note("stocks", "FAIL", tag, `Alpaca has no trade for "${s.underlying}": the stock fallback can never price this leg`); }
    const dev = ref ? pct(implied, ref.p) : NaN;
    const devJ = p.stock ? pct(implied, p.stock) : NaN;
    const lvl: Level = !ref ? "INFO" : Math.abs(dev) > fail ? "FAIL" : Math.abs(dev) > warn ? "WARN" : "PASS";
    note("stocks", lvl, tag, `implied $${f(implied)} vs Alpaca $${f(ref?.p)} (${f(dev)}%), vs Jupiter stockData $${f(p.stock)} (${f(devJ)}%), pooled $${Math.round(p.liquidity).toLocaleString()}${p.liquidity < 100_000 ? " <100k: settler skips the token" : ""}`, { implied, alpaca: ref?.p, jupStock: p.stock, liq: p.liquidity, perUi, multiplier: tok?.scaledUi });
    if (Number.isFinite(dev) && Math.abs(dev) > 40) {
      const ratio = ref!.p / implied;
      note("stocks", "FAIL", tag, `off by ${f(ratio, 3)}x: looks like a units-per-token / multiplier error, not market noise`);
    }
    const list = byU.get(s.underlying) ?? [];
    list.push({ id: tag, implied, issuer: s.issuer ?? "?", liq: p.liquidity });
    byU.set(s.underlying, list);
  }
  for (const [u, list] of byU) {
    if (list.length < 2) continue;
    const hi = Math.max(...list.map((x) => x.implied));
    const lo = Math.min(...list.map((x) => x.implied));
    const spread = pct(hi, lo);
    if (spread > 3) note("stocks", spread > 8 ? "FAIL" : "WARN", `${u} issuers`, `issuers disagree by ${f(spread)}%: ${list.map((x) => `${x.id} $${f(x.implied)}`).join(", ")}`);
  }
}

// --- 2. Commodities ------------------------------------------------------------------------------
async function commodity(cat: Security[]) {
  header("commodities: token-implied vs Kraken XAUT (gold spot, another issuer)");
  const rows = cat.filter((s) => s.kind === "commodity" && s.mint);
  const jp = await jupPrices(rows.map((s) => s.mint!));
  for (const s of rows) {
    const p = jp.get(s.mint!);
    const tok = tokenByMint.get(s.mint!);
    const perUi = tok?.ratio.comparable ? tok.ratio.underlyingPerUiToken : null;
    const metal = /silver|XAG/i.test(`${s.name} ${s.underlying}`) ? "XAG" : "XAU";
    const tag = `${s.symbol} (${s.liquidity})`;
    if (!p) { note("commodity", s.liquidity === "tradeable" ? "FAIL" : "WARN", tag, "no Jupiter price"); continue; }
    const ref = await metalSpot(metal);
    if (!perUi) { note("commodity", "WARN", tag, `bank has no comparable ratio (${tok ? (tok.ratio as any).reason : "token not in bank"}); token $${f(p.usdPrice)} vs ${metal} $${f(ref)}`); continue; }
    const implied = p.usdPrice / perUi;
    const dev = ref ? pct(implied, ref) : NaN;
    note("commodity", !ref ? "INFO" : Math.abs(dev) > 3 ? "FAIL" : Math.abs(dev) > 1 ? "WARN" : "PASS", tag,
      `implied $${f(implied)}/oz vs ${metal} $${f(ref)} (${f(dev)}%), pooled $${Math.round(p.liquidity).toLocaleString()}${p.liquidity < 100_000 ? " <100k: settler can't price it (no stock fallback)" : p.liquidity < 150_000 ? " (within 50% of the settler's $100k floor)" : ""}`);
  }
}

// --- 3. Perps ------------------------------------------------------------------------------------
async function perps() {
  header("perps: Phoenix mid + mark vs spot (Coinbase / Alpaca / XAUT), per underlying unit");
  const phx = new PhoenixVenue({ rpcUrl: envVar("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com" });
  const markets = bank?.venues.phoenix?.markets ?? [];
  if (!markets.length) { note("perps", "WARN", "bank", "no Phoenix markets in the bank file: run asset-bank --once first"); return; }
  const want = markets.filter((m) => m.tradeable);
  const stockCodes = want.filter((m) => /^(equity|etf)/.test(m.underlying)).map((m) => m.underlying.split(":").pop()!);
  const alp = await alpacaRef(stockCodes, ALPACA_H);
  console.log(`  ${want.length} tradeable markets (${stockCodes.length} on stocks)`);
  for (const m of want) {
    const [cls] = m.underlying.split(":");
    const base = m.underlying.split(":").pop()!.toUpperCase();
    const isGold = /^(XAU|GOLD)$/.test(base);
    const ref = cls === "crypto" ? await cryptoSpot(base) : cls === "commodity" ? (isGold ? await metalSpot("XAU") : null) : alp.get(base)?.p ?? null;
    const refName = cls === "crypto" ? "Coinbase" : cls === "commodity" ? "XAUT" : "Alpaca (last trade)";
    const mid = await phx.mid(m.symbol).catch(() => null);
    const mark = await phx.markAtOrAfter(m.symbol, nowSec() - 180, 170).catch(() => null);
    await sleep(2100); // Phoenix: about one read per two seconds
    const u = m.unitsPerContract || 1;
    if (mid == null && mark == null) { note("perps", "FAIL", m.symbol, "no mid and no mark in the last 3 minutes: the settler can't price this perp now"); continue; }
    if (!ref) { note("perps", "INFO", m.symbol, `mid ${f(mid, 6)} mark ${f(mark?.price, 6)} (no ${refName} reference for ${m.underlying})`); continue; }
    const perUnitMid = mid != null ? mid / u : NaN;
    const perUnitMark = mark ? mark.price / u : NaN;
    const devMid = pct(perUnitMid, ref);
    const devMark = pct(perUnitMark, ref);
    const rawDev = mark ? pct(mark.price, ref) : NaN;
    const closed = cls !== "crypto";
    const [w, fl] = closed ? [3, 8] : [1, 3];
    const worst = Math.max(Math.abs(Number.isFinite(devMid) ? devMid : 0), Math.abs(Number.isFinite(devMark) ? devMark : 0));
    let lvl: Level = worst > fl ? "FAIL" : worst > w ? "WARN" : "PASS";
    let msg = `per unit: mid ${f(perUnitMid, 8)} (${f(devMid)}%), mark ${f(perUnitMark, 8)} (${f(devMark)}%) vs ${refName} ${f(ref, 8)}; unitsPerContract ${u}`;
    if (u !== 1 && Math.abs(rawDev) < 1) { lvl = "FAIL"; msg += ` — the RAW mark matches spot, so dividing by ${u} is wrong`; }
    if (Number.isFinite(devMid) && Number.isFinite(devMark) && Math.abs(devMid - devMark) > 1) msg += `; mid and mark ${f(Math.abs(devMid - devMark))} pts apart`;
    if (m.spreadBps != null && m.spreadBps > 100) msg += `, spread ${m.spreadBps}bps`;
    note("perps", lvl, m.symbol, msg);
  }
}

// --- 4. Predictions ------------------------------------------------------------------------------
async function predictions(n: number) {
  header(`predictions: ${n} live Gemini events`);
  let proxy;
  try { proxy = geminiProxy(envVar); } catch (e) { note("predict", "WARN", "proxy", String(e)); return; }
  // Catalog rows whose event already happened but are still offered.
  const stale: Security[] = await sb(`securities?select=id,expires_at,data&kind=eq.prediction&liquidity=eq.tradeable&or=(expires_at.is.null,expires_at.lt.${new Date().toISOString()})&limit=50`);
  if (stale.length) note("predict", "WARN", "catalog", `${stale.length}${stale.length === 50 ? "+" : ""} tradeable prediction rows have no expiry or an expiry in the past (search hides past ones; null-expiry ones stay offered), e.g. ${stale.slice(0, 3).map((s) => s.id).join(", ")}`);
  const sample: Security[] = await sb(`securities?select=id,data,expires_at&kind=eq.prediction&liquidity=eq.tradeable&expires_at=gt.${new Date().toISOString()}&order=expires_at.asc&limit=400`);
  const tickers = [...new Set(sample.map((s) => s.data?.eventTicker).filter(Boolean))];
  // spread across soon / later events
  const pick = tickers.filter((_, i) => i % Math.max(1, Math.floor(tickers.length / n)) === 0).slice(0, n);
  let contracts = 0;
  for (const t of pick) {
    let cs: GeminiContract[];
    try { cs = await fetchGeminiEvent(proxy, t); } catch (e) { note("predict", "FAIL", t, `event read failed: ${e}`); continue; }
    await sleep(1100);
    if (!cs.length) { note("predict", "FAIL", t, "the catalog offers this event but Gemini returns no contracts"); continue; }
    for (const c of cs) {
      contracts++;
      const id = c.instrumentSymbol.slice(0, 28);
      const vals = [c.ask.yes, c.ask.no, c.bid.yes, c.bid.no];
      if (vals.some((v) => v != null && !(v >= 0 && v <= 1))) note("predict", "FAIL", id, `price outside [0,1]: ${JSON.stringify({ ask: c.ask, bid: c.bid })}`);
      for (const side of ["yes", "no"] as const) {
        const a = c.ask[side], b = c.bid[side];
        if (a != null && b != null && b > a) note("predict", "FAIL", id, `crossed ${side} book: bid ${b} > ask ${a}`);
      }
      if (c.ask.yes != null && c.ask.no != null && c.ask.yes + c.ask.no < 0.999) note("predict", "FAIL", id, `yes ask + no ask = ${f(c.ask.yes + c.ask.no, 3)} < 1 (free money: the prices are wrong or stale)`);
      // legPrice: fade = 1 - other side; back entry = own ask; round trip immediately should lose the spread
      for (const side of ["yes", "no"] as const) {
        const other = side === "yes" ? "no" : "yes";
        const be = legPrice(c, side, "back", "entry"), bx = legPrice(c, side, "back", "exit");
        const fe = legPrice(c, side, "fade", "entry"), fx = legPrice(c, side, "fade", "exit");
        if (be != null && c.ask[side] != null && Math.abs(be - c.ask[side]!) > 1e-9) note("predict", "FAIL", id, `back ${side} entry ${be} != ${side} ask ${c.ask[side]}`);
        if (fe != null && c.ask[other] != null && Math.abs(fe - (1 - c.ask[other]!)) > 1e-9) note("predict", "FAIL", id, `fade ${side} entry ${fe} != 1 - ${other} ask`);
        if (be != null && bx != null && bx > be + 1e-9 && !c.resolutionSide) note("predict", "WARN", id, `back ${side}: instant round trip shows a GAIN (${be} -> ${bx})`);
        // the program's "No" formula: fade return uses (1 - exit)/(1 - entry) on the leg's terms
        if (fe != null && fx != null && !c.resolutionSide && 1 - fx > 1 - fe + 1e-9) note("predict", "WARN", id, `fade ${side}: instant round trip shows a GAIN (${fe} -> ${fx})`);
      }
    }
  }
  note("predict", "INFO", "summary", `${pick.length} events, ${contracts} contracts checked`);
}

// --- 5. Yield ------------------------------------------------------------------------------------
// Every yield pick is traded as a Jupiter Lend jlUSDC deposit (scripts/fork/api/legs.ts YIELD_KEY,
// how: "lend"), whatever vault the catalog row names. So the score is jlUSDC's share value; check
// that it's sane and that the APY the app shows for the named vault isn't far from what jlUSDC earns.
async function yieldLegs(cat: Security[]) {
  header("yield: jlUSDC share value, and catalog APY vs what the deposit earns");
  const rows = cat.filter((s) => s.kind === "yield" && s.liquidity === "tradeable");
  const lendList: any[] = await getJson(`https://lite-api.jup.ag/lend/v1/earn/tokens`).catch(() => []);
  const jl = lendList.find((x) => x.asset?.symbol === "USDC" || x.symbol === "jlUSDC");
  if (!jl) { note("yield", "FAIL", "jlUSDC", "Jupiter Lend doesn't list jlUSDC: every yield leg would be unpriced"); return; }
  const jlApy = (Number(jl.totalRate ?? jl.supplyRate ?? 0)) / 100; // basis points → %
  const a = await retry(() => jupiterLendShareValue(jl.address, {}));
  await sleep(4000);
  const b = await retry(() => jupiterLendShareValue(jl.address, {}));
  if (!a || !b) note("yield", "FAIL", "jlUSDC", "share value unreadable");
  else {
    const lvl: Level = b.usdcPerShare < a.usdcPerShare ? "FAIL" : a.usdcPerShare < 1 || a.usdcPerShare > 2 ? "WARN" : "PASS";
    note("yield", lvl, "jlUSDC", `share value ${a.usdcPerShare} → ${b.usdcPerShare} over 4s, APY ~${f(jlApy)}%`);
  }
  for (const s of rows) {
    const apy = s.data?.apyPct ?? s.data?.apy ?? null;
    if (apy == null) { note("yield", "INFO", s.symbol.slice(0, 28), `${s.name.slice(0, 40)}: no APY in the catalog`); continue; }
    const gap = apy - jlApy;
    note("yield", Math.abs(gap) > 3 ? "WARN" : "PASS", `${s.symbol} ${s.venue}`.slice(0, 28), `${s.name.slice(0, 36)} shows ${f(apy)}% but the pick deposits jlUSDC at ~${f(jlApy)}% (${gap > 0 ? "+" : ""}${f(gap)} pts)`);
  }
}

// --- 6. Settle: the settler's own priceLeg on every tradeable row ----------------------------------
async function settle(cat: Security[]) {
  header("settle: settler priceLeg() as an entry now, and 6 minutes late");
  const rules: PriceRules = { minLiquidityUsd: 50_000, liveWindowSecs: 300, maxDelaySecs: 3600, staleRefSecs: 900 };
  const src: Sources = {
    stocks: new AlpacaStocks(ALPACA_H["APCA-API-KEY-ID"], ALPACA_H["APCA-API-SECRET-KEY"]),
    tokens: new JupiterPrices(JUP_KEY), // keyed: the bank isn't running alongside
    phoenix: new PhoenixVenue({ rpcUrl: envVar("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com" }),
    lend: { shareValue: async (m) => { const v = await retry(() => jupiterLendShareValue(m, {})); return v && { usdcPerShare: v.usdcPerShare, at: nowSec(), raw: v.raw }; } },
  };
  // yield rows are all traded as jlUSDC (see yieldLegs), so one jlUSDC leg stands for them
  const rows = cat.filter((s) => s.liquidity === "tradeable" && ["stock", "etf", "commodity", "pre-ipo", "card"].includes(s.kind));
  const jl: any = (await getJson(`https://lite-api.jup.ag/lend/v1/earn/tokens`).catch(() => [])).find((x: any) => x.asset?.symbol === "USDC");
  if (jl) rows.push({ id: "lend:jlUSDC", kind: "yield", symbol: "jlUSDC", name: "Jupiter Lend USDC", underlying: null, issuer: null, venue: "Jupiter Lend Earn", mint: jl.address, liquidity: "tradeable", us_persons: "yes", can_short: false, expires_at: null, data: {} });
  const tally = new Map<string, Map<string, number>>();
  const bump = (kind: string, k: string) => {
    const m = tally.get(kind) ?? new Map();
    m.set(k, (m.get(k) ?? 0) + 1);
    tally.set(kind, m);
  };
  for (const s of rows) {
    const tok = s.mint ? tokenByMint.get(s.mint) : undefined;
    const ukey = tok?.underlying ?? (s.underlying ? `${s.kind === "etf" ? "etf" : s.kind === "stock" ? "equity" : s.kind}:US:${s.underlying}` : null);
    const u = ukey ? bank?.underlyings[ukey] : null;
    const leg: LegToPrice = {
      index: 0,
      kind: s.kind === "yield" ? "yield" : s.kind === "card" ? "card" : "spot",
      underlying: u ? { key: u.key, cls: u.cls, code: u.code } : null,
      token: s.mint ? { mint: s.mint, underlyingPerUiToken: tok ? tok.ratio.underlyingPerUiToken : null } : null,
    };
    for (const [label, lateBy] of [["now", 10], ["late", 360]] as const) {
      const t = nowSec();
      const out = await priceLeg(leg, t - lateBy, t, rules, src).catch((e) => ({ ok: false as const, retry: false, reason: `threw: ${e}` }));
      const key = out.ok ? `priced via ${out.quote.rule}` : `${out.retry ? "waits" : "UNPRICED"}: ${out.reason.replace(/^[^:]*: /, "").replace(/\b[A-Z0-9.]{1,6}\b(?= trade)/, "<sym>")}`;
      bump(`${s.kind} (${label})`, key);
      if (!out.ok && !out.retry && label === "now") note("settle", "FAIL", s.symbol.slice(0, 28), `${s.kind} offered as tradeable but an entry now can never be priced: ${out.reason}`);
    }
    await sleep(1500);
  }
  for (const [k, m] of [...tally].sort()) {
    console.log(`  ${k}`);
    for (const [r, n] of [...m].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(4)}  ${r}`);
  }
  findings.push({ section: "settle", level: "INFO", id: "tally", msg: "outcomes", data: Object.fromEntries([...tally].map(([k, m]) => [k, Object.fromEntries(m)])) });
}

// --- 7. App asset pages --------------------------------------------------------------------------
async function app(cat: Security[], n: number) {
  header(`app: /assets/:id shown price and chart vs live (${n} assets)`);
  const secret = fnEnv.SECURITIES_INDEX_SECRET;
  if (!secret) { note("app", "WARN", "secret", "SECURITIES_INDEX_SECRET not in supabase/functions/.env: skipping"); return; }
  // one per (kind, issuer), most traded first
  const seen = new Set<string>();
  const pick: Security[] = [];
  for (const s of [...cat].filter((s) => s.liquidity === "tradeable" && s.kind !== "card").sort((a, b) => (b.data?.volume24hUsd ?? 0) - (a.data?.volume24hUsd ?? 0))) {
    const k = `${s.kind}:${s.issuer ?? s.venue}`;
    if (seen.has(k) && pick.length >= Math.ceil(n / 2)) continue;
    seen.add(k);
    pick.push(s);
    if (pick.length >= n) break;
  }
  const live = await jupPrices(pick.map((s) => s.mint).filter((m): m is string => !!m));
  for (const s of pick) {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/assets/${encodeURIComponent(s.id)}?range=1D`, { headers: { "x-index-secret": secret, apikey: SUPABASE_KEY } });
    await sleep(2500); // GeckoTerminal behind it: ~30/min
    const tag = `${s.symbol} (${s.kind})`.slice(0, 28);
    if (!r.ok) { note("app", "FAIL", tag, `asset page HTTP ${r.status}`); continue; }
    const page = await r.json();
    const shown = page.price?.usd ?? null;
    const pts: [number, number][] = page.chart?.points ?? [];
    const last = pts.at(-1);
    if (shown == null) { note("app", s.kind === "prediction" || s.kind === "yield" ? "INFO" : "WARN", tag, "asset page shows no price"); continue; }
    const lv = s.mint ? live.get(s.mint)?.usdPrice : null;
    const d1 = lv ? pct(shown, lv) : NaN;
    if (Number.isFinite(d1) && Math.abs(d1) > 1) note("app", "WARN", tag, `shown $${f(shown)} vs live Jupiter $${f(lv)} (${f(d1)}%)`);
    if (last) {
      const d2 = pct(last[1], shown);
      const ageMin = (Date.now() / 1000 - (last[0] > 1e12 ? last[0] / 1000 : last[0])) / 60;
      const ratio = shown / last[1];
      const lvl: Level = Math.abs(d2) > 10 ? "FAIL" : Math.abs(d2) > 3 ? "WARN" : "PASS";
      note("app", lvl, tag, `chart last $${f(last[1])} (${f(ageMin, 0)} min old) vs shown $${f(shown)} (${f(d2)}%)${Math.abs(d2) > 10 ? ` — ${f(ratio, 3)}x apart: chart likely ignores the token's multiplier` : ""}`);
      const first = pts[0];
      if (first && page.price?.change_24h_pct != null) {
        const chartChange = pct(last[1], first[1]);
        if (Math.abs(chartChange - page.price.change_24h_pct) > 3) note("app", "WARN", tag, `chart's 1D move ${f(chartChange)}% vs shown 24h change ${f(page.price.change_24h_pct)}%`);
      }
    } else note("app", "INFO", tag, "no chart");
  }
}

// --- 8. Catalog / DB consistency -----------------------------------------------------------------
async function catalogChecks() {
  header("catalog: picks vs catalog rows");
  const legs: any[] = await sb(`take_legs?select=take_id,idx,name,kind,asset_id,weight,ret_pct&limit=2000`);
  const ids = [...new Set(legs.map((l) => l.asset_id).filter(Boolean))];
  const secs: Security[] = ids.length ? await sb(`securities?select=id,kind,liquidity,expires_at,mint,symbol&id=in.(${ids.map((x) => `"${x}"`).join(",")})`) : [];
  const byId = new Map(secs.map((s) => [s.id, s]));
  const kindMap: Record<string, string[]> = { Stock: ["stock", "etf", "pre-ipo"], ETF: ["etf"], Commodity: ["commodity"], Perp: ["perp"], Prediction: ["prediction"], Cash: ["yield"], Yield: ["yield"] };
  for (const l of legs) {
    const tag = `${l.take_id.slice(0, 8)}#${l.idx} ${l.name}`.slice(0, 28);
    if (!l.asset_id) { note("catalog", "WARN", tag, `pick "${l.name}" (${l.kind}) has no catalog row: no asset page, no price`); continue; }
    const s = byId.get(l.asset_id);
    if (!s) { note("catalog", "FAIL", tag, `asset_id ${l.asset_id} no longer exists`); continue; }
    if (s.liquidity !== "tradeable") note("catalog", "WARN", tag, `pick's asset is now ${s.liquidity}`);
    if (s.expires_at && Date.parse(s.expires_at) < Date.now()) note("catalog", "INFO", tag, `prediction expired ${s.expires_at}`);
    const want = kindMap[l.kind];
    if (want && !want.includes(s.kind)) note("catalog", "WARN", tag, `pick says "${l.kind}" but the asset is a ${s.kind}`);
  }
  const stats: any[] = await sb(`take_stats?select=take_id,ret_pct,updated_at&limit=2000`);
  const moving = stats.filter((s) => Number(s.ret_pct) !== 0);
  const newest = moving.map((s) => s.updated_at).sort().at(-1);
  note("catalog", moving.length && newest && Date.now() - Date.parse(newest) < 3_600_000 ? "PASS" : "FAIL", "live returns", `${moving.length}/${stats.length} takes have a non-zero live return; newest change ${newest ?? "never"}. Nothing marks open takes to market.`);
}

// --- Main ----------------------------------------------------------------------------------------
const t0 = Date.now();
console.log(`price sweep ${new Date().toISOString()}  bank: ${bank ? `${bankPath} (${bank.updatedAt}, ${tokenByMint.size} tokens)` : "NONE (ratios assumed 1, perps skipped)"}`);
const cat = await catalog();
console.log(`catalog: ${cat.length} non-prediction rows`);
const sections: [string, () => Promise<void>][] = [
  ["catalog", catalogChecks],
  ["stocks", () => stocks(cat)],
  ["commodity", () => commodity(cat)],
  ["yield", () => yieldLegs(cat)],
  ["predict", () => predictions(Number(arg("gemini") ?? 12))],
  ["app", () => app(cat, Number(arg("app") ?? 24))],
  ["perps", perps],
  ["settle", () => settle(cat)],
];
for (const [name, fn] of sections) {
  if (!run(name)) continue;
  try { await fn(); } catch (e) { note(name, "FAIL", "section", `crashed: ${e instanceof Error ? e.stack : e}`); }
}
header("summary");
const by = new Map<string, Record<Level, number>>();
for (const x of findings) {
  const r = by.get(x.section) ?? { PASS: 0, WARN: 0, FAIL: 0, INFO: 0 };
  r[x.level]++;
  by.set(x.section, r);
}
for (const [s, r] of by) console.log(`  ${s.padEnd(10)} PASS ${String(r.PASS).padStart(4)}  WARN ${String(r.WARN).padStart(4)}  FAIL ${String(r.FAIL).padStart(4)}`);
console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const out = arg("json");
if (out) writeFileSync(out, JSON.stringify(findings, null, 1));
