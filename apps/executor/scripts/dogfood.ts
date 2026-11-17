// Dogfood: check by hand that what the app shows for an asset or a take matches the market.
//
//   node apps/executor/scripts/dogfood.ts asset <ticker or name>     e.g. asset nvda, asset "gold"
//   node apps/executor/scripts/dogfood.ts take <take id | take link> [--owner <wallet>] [--rpc <url>]
//   node apps/executor/scripts/dogfood.ts take <id> --snap          save leg prices now, to compare later
//
// asset: every issuer of what you searched, its live token price, the price per share implied
//   by it, the real stock's last trade (Alpaca) or spot (Pyth), what the app's asset page shows,
//   and which price the settler would sign right now. Compare the "app page" column with your phone.
//
// take: each pick's live price from the same sources the settler uses, the app's return for
//   the take and each pick, and the on-chain positions in it. With a reachable RPC (the fork,
//   default http://127.0.0.1:18899) it reads each position's entry prices and computes the live
//   return exactly as the program would (positionReturnBps). Without one, use --snap when you buy,
//   then run it again later: it prints each pick's move since the snapshot and the weighted move
//   your position should show.
//
// The loop to dogfood a basket:
//   1. Buy a small basket in the app. Note the take id (share link) and the time.
//   2. node apps/executor/scripts/dogfood.ts take <id> --snap
//   3. Wait (an hour, or across a market open/close, or a weekend).
//   4. node apps/executor/scripts/dogfood.ts take <id>       compare "expected" with the app
//   5. For any pick that looks off: node apps/executor/scripts/dogfood.ts asset <its ticker>
//
// Read-only. Snapshots go to <repo>/.data/dogfood/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { positionReturnBps, thesisProgram } from "@thesis/chain";
import { fetchGeminiEvent, geminiProxy, legPrice } from "@thesis/venues/gemini";
import { jupiterLendShareValue } from "@thesis/venues/jupiter";
import { PhoenixVenue } from "@thesis/venues/phoenix";
import type { BankState } from "@thesis/venues/bank";
import { envVar } from "../../../packages/venues/registry/src/lib/env.ts";
import { toPriceUnits } from "../src/settler/index.ts";
import { cryptoSpot, metalSpot } from "./refs.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
const flag = (k: string) => args.includes(`--${k}`);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : null;
};
const [cmd, ...rest] = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["snap"].includes(args[i - 1].slice(2))));
const target = rest.join(" ");

const SUPABASE_URL = envVar("SUPABASE_URL")!;
const SUPABASE_KEY = envVar("SUPABASE_PUBLISHABLE_KEY")!;
const ALPACA_H = { "APCA-API-KEY-ID": envVar("ALPACA_API_KEY_ID") ?? "", "APCA-API-SECRET-KEY": envVar("ALPACA_API_SECRET_KEY") ?? "" };
const MIN_LIQ = 50_000; // PRICEABLE_MIN_POOLED_USD
const fnSecret = (() => {
  const p = join(REPO, "supabase/functions/.env");
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").match(/^SECURITIES_INDEX_SECRET\s*=\s*"?([^"\n]+)"?/m)?.[1] ?? null;
})();
const bankPath = opt("bank") ?? envVar("ASSET_BANK_FILE") ?? join(REPO, ".data/asset-bank.json");
const bank: BankState | null = existsSync(bankPath) ? JSON.parse(readFileSync(bankPath, "utf8")) : null;

const f = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(d));
const pct = (a: number, b: number) => (a / b - 1) * 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && i < 5) { await sleep(1500 * 2 ** i); continue; }
    throw new Error(`${new URL(url).host}${new URL(url).pathname}: HTTP ${r.status}`);
  }
}
const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "content-type": "application/json" };
const sb = (path: string) => getJson(`${SUPABASE_URL}/rest/v1/${path}`, sbHeaders);
const rpc = async (fn: string, body: unknown) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: sbHeaders, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
};
function table(rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  console.log("  " + cols.map((c, i) => c.padEnd(w[i])).join("  "));
  console.log("  " + w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log("  " + cols.map((c, i) => String(r[c] ?? "").padEnd(w[i])).join("  "));
}

// --- Price sources ---------------------------------------------------------------------------------
async function jup(mints: string[]) {
  if (!mints.length) return {} as Record<string, any>;
  return getJson(`https://lite-api.jup.ag/price/v3?ids=${[...new Set(mints)].join(",")}`);
}
async function alpaca(symbols: string[]): Promise<Record<string, { p: number; t: string }>> {
  if (!symbols.length || !ALPACA_H["APCA-API-KEY-ID"]) return {};
  const j = await getJson(`https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${encodeURIComponent([...new Set(symbols)].join(","))}&feed=iex`, ALPACA_H);
  return j.trades ?? {};
}
const perUi = (mint: string) => {
  const t = bank?.tokens[mint];
  return t ? (t.ratio.comparable ? t.ratio.underlyingPerUiToken : null) : 1;
};
const phoenix = new PhoenixVenue({ rpcUrl: envVar("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com" });
async function perpUnit(symbol: string) {
  const m = bank?.venues.phoenix?.markets.find((x) => x.symbol === symbol);
  if (m) return m.unitsPerContract || 1;
  return /^k[A-Z]/.test(symbol) ? 1000 : 1;
}
async function appPage(id: string) {
  if (!fnSecret) return null;
  const r = await fetch(`${SUPABASE_URL}/functions/v1/assets/${encodeURIComponent(id)}?range=1D`, { headers: { "x-index-secret": fnSecret, apikey: SUPABASE_KEY } });
  return r.ok ? r.json() : null;
}

type Sec = { id: string; kind: string; symbol: string; name: string; underlying: string | null; issuer: string | null; venue: string; mint: string | null; liquidity: string; data: any; expires_at: string | null };

/** The price the settler would sign for this asset now, per underlying unit, and the reference to check it against. */
async function livePrice(s: Sec, side: "yes" | "no" = "yes", held: "back" | "fade" = "back") {
  if (s.kind === "perp") {
    const sym = s.id.replace(/^phoenix:/, "");
    const [mid, units] = [await phoenix.mid(sym).catch(() => null), await perpUnit(sym)];
    const base = sym.replace(/^k(?=[A-Z])/, "");
    const cls = s.data?.assetClass ?? "crypto";
    const stockRef = cls !== "crypto" && s.underlying ? (await alpaca([s.underlying]))[s.underlying]?.p ?? null : null;
    const ref = stockRef ?? (cls === "commodity" ? await metalSpot("XAU") : await cryptoSpot(base));
    const price = mid != null ? mid / units : null;
    return { price, source: `Phoenix mid / ${units}`, ref, refName: stockRef ? "Alpaca last trade" : cls === "commodity" ? "Kraken XAUT" : "Coinbase spot", implied: price };
  }
  if (s.kind === "prediction") {
    const ticker = s.data?.eventTicker;
    const instrument = s.id.replace(/^gemini:/, "");
    try {
      const cs = await fetchGeminiEvent(geminiProxy(envVar), ticker);
      const c = cs.find((x) => x.instrumentSymbol === instrument);
      if (!c) return { price: null, source: "Gemini: contract not listed", ref: null, refName: "" };
      const exit = legPrice(c, side, held, "exit");
      const entry = legPrice(c, side, held, "entry");
      return { price: exit, source: `Gemini ${held} ${side} ${c.resolutionSide ? `resolved ${c.resolutionSide}` : "bid"}`, ref: entry, refName: "ask now (entry price)" };
    } catch (e) {
      return { price: null, source: `Gemini: ${e instanceof Error ? e.message : e}`, ref: null, refName: "" };
    }
  }
  if (s.kind === "yield") {
    const list = await getJson("https://lite-api.jup.ag/lend/v1/earn/tokens");
    const jl = list.find((x: any) => x.asset?.symbol === "USDC");
    const v = jl ? await jupiterLendShareValue(jl.address, {}) : null;
    return { price: v?.usdcPerShare ?? null, source: "jlUSDC share value (every yield pick is a jlUSDC deposit)", ref: null, refName: "" };
  }
  if (!s.mint) return { price: null, source: "no mint", ref: null, refName: "" };
  const [p, trades] = await Promise.all([jup([s.mint]), s.underlying && (s.kind === "stock" || s.kind === "etf") ? alpaca([s.underlying]) : Promise.resolve({})]);
  const tp = p[s.mint];
  const r = perUi(s.mint);
  const implied = tp && r ? tp.usdPrice / r : null;
  const stock = s.underlying ? (trades as any)[s.underlying]?.p ?? null : null;
  const metal = s.kind === "commodity" ? (/silver/i.test(s.name) ? "XAG" : "XAU") : null;
  const ref = stock ?? (metal ? await metalSpot(metal) : null);
  const liquid = (tp?.liquidity ?? 0) >= MIN_LIQ;
  const price = liquid ? implied : stock ?? implied;
  const source = liquid ? `token (pooled $${Math.round(tp.liquidity).toLocaleString()})` : stock ? `stock: token pooled only $${Math.round(tp?.liquidity ?? 0).toLocaleString()}` : `token, ILLIQUID ($${Math.round(tp?.liquidity ?? 0).toLocaleString()}): settler can't price it`;
  return { price, source, ref, refName: stock ? "Alpaca last trade" : metal ? "Kraken XAUT" : "", tokenPrice: tp?.usdPrice ?? null, implied };
}

// --- asset -------------------------------------------------------------------------------------------
async function asset(q: string) {
  let hits: Sec[] = await rpc("search_securities", { p_query: q, p_us_person: false, p_limit: 5 });
  if (!hits.length) {
    // Search shows only tradeable rows; look up thin ones directly so they can be inspected too.
    const u = encodeURIComponent(q.toUpperCase().replace(/X$/, ""));
    hits = await sb(`securities?select=id,kind,symbol,name,underlying,issuer,venue,mint,liquidity,data,expires_at&or=(underlying.eq.${u},symbol.ilike.${encodeURIComponent(q)})&limit=5`);
    if (hits.length) console.log(`(not in the app's search: ${hits[0].liquidity} only)`);
  }
  if (!hits.length) return console.log(`nothing matches "${q}"`);
  const top = hits[0];
  // every issuer of the same underlying
  const all: Sec[] = top.underlying
    ? await sb(`securities?select=id,kind,symbol,name,underlying,issuer,venue,mint,liquidity,data,expires_at&underlying=eq.${encodeURIComponent(top.underlying)}&kind=neq.yield`)
    : [top];
  console.log(`\n${top.name}  (${top.kind}${top.underlying ? `, ${top.underlying}` : ""})  — ${new Date().toLocaleString()}\n`);
  const rows: Record<string, unknown>[] = [];
  for (const s of all.sort((a, b) => (a.liquidity === "tradeable" ? -1 : 1) - (b.liquidity === "tradeable" ? -1 : 1))) {
    const lp = await livePrice(s);
    const page = s.liquidity === "tradeable" ? await appPage(s.id) : null;
    const shown = page?.price?.usd ?? null;
    const chartLast = page?.chart?.points?.at(-1)?.[1] ?? null;
    rows.push({
      issuer: `${s.symbol} ${s.issuer?.split(" ")[0] ?? s.venue}`.slice(0, 22),
      catalog: s.liquidity,
      "app page": shown != null ? `$${f(shown)}` : "—",
      "app chart last": chartLast != null ? `$${f(chartLast)}` : "—",
      "token/share": lp.implied != null ? `$${f(lp.implied)}` : "—",
      reference: lp.ref != null ? `$${f(lp.ref)} ${lp.refName}` : "—",
      "vs ref": lp.ref && lp.implied ? `${f(pct(lp.implied, lp.ref))}%` : "—",
      "settler signs": lp.price != null ? `$${f(lp.price)} (${lp.source})` : lp.source,
    });
    await sleep(600);
  }
  table(rows);
  console.log(`
  What to check on your phone:
   - The asset page price should match "app page"; the chart's last point should match "app chart last".
   - "app page" and "token/share" are per TOKEN and per SHARE; they differ only if the token's multiplier isn't 1.
   - "vs ref" beyond ~1% with the market open (3-8% on a weekend) means the token trades away from the stock:
     what you're scored on is "settler signs".`);
}

// --- take --------------------------------------------------------------------------------------------
async function take(idOrLink: string) {
  const id = idOrLink.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (!id) throw new Error("give a take id or a take link");
  const [t] = await sb(`takes?select=id,claim,risk,horizon,created_at,settles_at&id=eq.${id}`);
  if (!t) throw new Error(`no take ${id}`);
  const legs: any[] = await sb(`take_legs?select=idx,name,kind,weight,asset_id,ret_pct&take_id=eq.${id}&order=idx`);
  const [stats] = await sb(`take_stats?select=ret_pct,history,updated_at&take_id=eq.${id}`);
  const chainTakes: any[] = await sb(`chain_takes?select=network,address,settled,result_bps&take_id=eq.${id}`);
  const ids = legs.map((l) => l.asset_id).filter(Boolean);
  const secs: Sec[] = ids.length ? await sb(`securities?select=id,kind,symbol,name,underlying,issuer,venue,mint,liquidity,data,expires_at&id=in.(${ids.map((x: string) => `"${x}"`).join(",")})`) : [];
  const byId = new Map(secs.map((s) => [s.id, s]));
  console.log(`\n"${t.claim}"  ${t.risk} risk, ${t.horizon}, settles ${t.settles_at}`);
  console.log(`app return: ${f(Number(stats?.ret_pct ?? 0))}% (take_stats updated ${stats?.updated_at ?? "never"})${chainTakes.length ? `, on chain: ${chainTakes.map((c) => `${c.network} ${c.address.slice(0, 8)}… ${c.settled ? `settled ${c.result_bps} bps` : "open"}`).join("; ")}` : ", not on chain"}\n`);

  const snapDir = join(REPO, ".data/dogfood");
  const snapPath = join(snapDir, `${id}.json`);
  const snap = existsSync(snapPath) ? JSON.parse(readFileSync(snapPath, "utf8")) : null;
  const now: { idx: number; price: number | null; source: string }[] = [];
  const rows: Record<string, unknown>[] = [];
  let weighted = 0, totalW = 0, unpriceable = 0;
  for (const l of legs) {
    const s = l.asset_id ? byId.get(l.asset_id) : null;
    const side: "yes" | "no" = /·\s*No\b|: No$/i.test(`${l.kind} ${l.name}`) ? "no" : "yes";
    const lp = s ? await livePrice(s, side) : { price: null, source: l.asset_id ? "asset row gone" : "NO CATALOG ROW: can't be priced", ref: null, refName: "" };
    if (lp.price == null) unpriceable++;
    now.push({ idx: l.idx, price: lp.price, source: lp.source });
    const was = snap?.legs.find((x: any) => x.idx === l.idx)?.price ?? null;
    const lev = Number(String(l.kind).match(/(\d+)x/)?.[1] ?? 1);
    const move = was && lp.price != null ? (s?.kind === "prediction" ? pct(lp.price, was) : lev * pct(lp.price, was)) : null;
    if (move != null) { weighted += Math.max(-100, move) * Number(l.weight); totalW += Number(l.weight); }
    rows.push({
      "#": l.idx,
      pick: `${l.name}`.slice(0, 24),
      kind: l.kind,
      weight: `${l.weight}%`,
      "app pick ret": `${f(Number(l.ret_pct))}%`,
      "price now": lp.price != null ? f(lp.price, lp.price < 1 ? 4 : 2) : "—",
      source: lp.source.slice(0, 48),
      ...(snap ? { "at snap": was != null ? f(was, was < 1 ? 4 : 2) : "—", "move": move != null ? `${f(move)}%` : "—" } : {}),
    });
    await sleep(500);
  }
  table(rows);
  if (unpriceable) console.log(`\n  ! ${unpriceable} pick(s) have no price right now. The program needs every pick priced to settle, so one of these can void the whole basket's score (settles 0%, unscored).`);
  if (snap) console.log(`\n  Since your snapshot (${snap.at}): a BACK should show about ${f(totalW ? weighted / totalW : NaN)}% on the picks priced both times (before fees and the entry spread). Compare with the app.`);

  if (flag("snap")) {
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(snapPath, JSON.stringify({ at: new Date().toISOString(), take: id, legs: now }, null, 1));
    console.log(`\n  snapshot saved: ${snapPath}`);
  }

  // On-chain positions: entry prices from the account, live return as the program computes it.
  const owner = opt("owner");
  const positions: any[] = await sb(`chain_positions?select=network,address,owner,side,stake,opened_at,exited_at,settled_at,scored,return_bps&take=in.(${chainTakes.map((c) => `"${c.address}"`).join(",") || '""'})${owner ? `&owner=eq.${owner}` : ""}&order=opened_at.desc&limit=20`);
  if (!positions.length) return console.log("\n  no on-chain positions for this take" + (owner ? ` owned by ${owner}` : ""));
  const rpcUrl = opt("rpc") ?? envVar("SOLANA_RPC_URL") ?? "http://127.0.0.1:18899";
  const conn = new Connection(rpcUrl, "confirmed");
  const up = await conn.getSlot().then(() => true).catch(() => false);
  console.log(`\n  positions (${positions.length}${owner ? "" : ", pass --owner <wallet> for just yours"}), chain ${up ? rpcUrl : `unreachable at ${rpcUrl}: showing the database only`}`);
  const program = up ? thesisProgram(conn) : null;
  const takeAcct = program && chainTakes[0] ? await program.account.take.fetch(new PublicKey(chainTakes[0].address)).catch(() => null) : null;
  const prow: Record<string, unknown>[] = [];
  for (const p of positions) {
    let live: number | null = null, entries = "—";
    if (program && takeAcct) {
      const acct: any = await program.account.position.fetch(new PublicKey(p.address)).catch(() => null);
      if (acct) {
        const set = acct.prices.find((x: any) => x.leg !== undefined) ? null : acct.prices[0];
        const entryPrices: bigint[] = (set?.prices ?? acct.prices[0]?.prices ?? []).map((x: any) => BigInt(x.price.toString()));
        entries = entryPrices.map((e) => f(Number(e) / 1e8, 4)).join(" / ");
        const exits = now.map((n) => (n.price != null ? toPriceUnits(n.price) : 0n));
        live = positionReturnBps(takeAcct.legs as any, { side: acct.side, legsMask: acct.legsMask, prices: entryPrices.map((e, i) => ({ entry: e, exit: exits[i] ?? 0n })) });
      }
    }
    prow.push({
      position: p.address.slice(0, 8) + "…",
      owner: p.owner.slice(0, 6) + "…",
      side: p.side,
      stake: `$${f(Number(p.stake) / 1e6)}`, // USDC base units
      opened: p.opened_at?.slice(0, 16),
      status: p.settled_at ? `settled ${p.scored ? "" : "UNSCORED "}${p.return_bps} bps` : p.exited_at ? "exited" : "open",
      "entry prices": entries.slice(0, 40),
      "expected now": live != null ? `${f(live / 100)}%` : "—",
    });
  }
  table(prow);
  console.log(`\n  "expected now" is the program's own formula on the position's signed entry prices and the live prices above.
  It should match the position's return in the app within the spread (and exactly at settlement).`);
}

if (cmd === "asset" && target) await asset(target);
else if (cmd === "take" && target) await take(target);
else {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(1);
}
