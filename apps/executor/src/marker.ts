// Marker: live returns for open takes and on-chain positions, every few minutes.
//
//   pnpm --filter @thesis/executor marker               run forever (Ctrl-C to stop)
//   pnpm --filter @thesis/executor marker -- --once     one run, then exit
//   pnpm --filter @thesis/executor marker -- --once --dry-run   print the marks, post nothing
//
// Each run: the open takes and their picks (public reads), every pick's price now by the settler's
// rules (marker/mark.ts), and each open on-chain position's live return from the entry prices
// signed into its account. Positions and takes are read 100 per getMultipleAccounts call, and an
// address the chain doesn't have is skipped until the hourly full check (MissingAccounts). A take's return is its author's buy-in's live return once the settler
// has signed its entry prices, since those set the take's result; until then,
// an index of its picks since it was posted. One POST to the
// `marks` edge function writes it all (apply_marks, 0038_live_marks.sql). Once the author sells,
// the take's return and pick marks stay at the sale; positions still open on it keep moving. take_price()
// reads take_stats.ret_pct, so paper positions and sales move with it.
//
// Settings (environment or the repo-root .env; keys are never printed):
//   SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY   reads
//   MARKS_TOKEN                 the marks function's secret (required unless --dry-run)
//   MARKS_URL                   default ${SUPABASE_URL}/functions/v1/marks
//   MARKER_INTERVAL_SEC         300
//   ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY   US stock prices (required)
//   GEMINI_PROXY_TOKEN          prediction picks (without it they keep their last mark)
//   JUPITER_API_KEY             token prices and Jupiter Lend on api.jup.ag (required; the keyless
//                               lite-api is being retired). One batched call per 50 mints a run.
//   ASSET_BANK_SINK / ASSET_BANK_FILE   the asset bank: units per token, multipliers, Phoenix units
//   SOLANA_RPC_URL              default the local fork; positions are skipped when it's down
//   SETTLER_CHAIN_NETWORK       chain_positions network (solana-mainnet-fork for a local RPC)
import { defaultSink, loadBankState } from "@thesis/venues/bank";
import { geminiProxy } from "@thesis/venues/gemini";
import { PhoenixVenue } from "@thesis/venues/phoenix";
import { envVar } from "../../../packages/venues/registry/src/lib/env.ts";
import { AlpacaStocks } from "./settler/sources.ts";
import { sleepUnless } from "./http.ts";
import { planTake, resolvePick, type Base, type LegUpdate, type PickAsset } from "./marker/mark.ts";
import { bankLookup, Db, historicalBase, snapshot } from "./marker/live.ts";
import { chainReader, FRESH_MS, MissingAccounts, positionExit, positionLiveBps } from "./marker/positions.ts";

const args = process.argv.slice(2);
const once = args.includes("--once");
const dry = args.includes("--dry-run");
const verbose = args.includes("--verbose") || dry;
const limitArg = args[args.indexOf("--limit") + 1];
const limit = args.includes("--limit") ? Number(limitArg) : 500;
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m: string) => console.log(`${stamp()} ${m}`);
const need = (k: string) => {
  const v = envVar(k);
  if (!v) throw new Error(`${k} is not set (environment or repo-root .env)`);
  return v;
};

const supabaseUrl = need("SUPABASE_URL");
const db = new Db(supabaseUrl, need("SUPABASE_PUBLISHABLE_KEY"));
const marksUrl = envVar("MARKS_URL") ?? `${supabaseUrl}/functions/v1/marks`;
const marksToken = dry ? null : need("MARKS_TOKEN");
const alpacaHeaders = { "APCA-API-KEY-ID": need("ALPACA_API_KEY_ID"), "APCA-API-SECRET-KEY": need("ALPACA_API_SECRET_KEY") };
const stocks = new AlpacaStocks(alpacaHeaders["APCA-API-KEY-ID"], alpacaHeaders["APCA-API-SECRET-KEY"]);
const jupiterApiKey = need("JUPITER_API_KEY");
const rpcUrl = envVar("SOLANA_RPC_URL") ?? "http://127.0.0.1:18899";
const local = ["127.0.0.1", "localhost"].includes(new URL(rpcUrl).hostname);
const network = envVar("SETTLER_CHAIN_NETWORK") ?? (local ? "solana-mainnet-fork" : "solana-mainnet");
// Marks and mids come from Phoenix's public API; the RPC is only for its on-chain calls (unused here).
const phoenix = new PhoenixVenue({ rpcUrl });
// Kept across runs: positions and takes the chain didn't have (the old fork's, after a reset).
const missing = new MissingAccounts();
const gemini = (() => {
  try {
    return geminiProxy(envVar);
  } catch (e) {
    log(`prediction picks keep their last mark: ${e instanceof Error ? e.message : e}`);
    return null;
  }
})();

async function run() {
  const t0 = Date.now();
  const state = await loadBankState(defaultSink()).catch((e) => (log(`no asset bank (${e instanceof Error ? e.message : e}): units per token 1, multipliers from Jupiter`), null));
  const bank = bankLookup(state);
  // Card picks mark at the insured value the asset bank last read (its cards tier).
  const cards = new Map(Object.values(state?.venues.cards?.picked ?? {}).flatMap((c) => (c.insuredValueUsd ? [[c.cardId, c.insuredValueUsd] as const] : [])));
  const listed = await db.openTakes(limit);
  if (!db.hasMarkColumns) log("live-marks migration not applied yet: bases are computed in memory, nothing can be written");

  // Positions: which takes have open ones, and the Phoenix shorts their fades hold.
  const chain = await chainReader(rpcUrl, missing);
  const positions = chain ? await db.openPositions(network) : [];
  // A take its author sold out of is marked only while positions are still open on it.
  const held = new Set(positions.map((p) => p.take_id));
  const takes = listed.filter((t) => !t.frozen || held.has(t.id));
  const secs = await db.securities(takes.flatMap((t) => t.legs.map((l) => l.asset_id).filter((x): x is string => !!x)));
  const assets = new Map<string, Map<number, PickAsset>>();
  for (const t of takes) assets.set(t.id, new Map(t.legs.map((l) => [l.idx, resolvePick(l, l.asset_id ? secs.get(l.asset_id) : undefined, bank)])));
  const extraPerps = new Set<string>();
  for (const p of positions) {
    if (p.side !== "fade" || !p.take_id) continue;
    for (const a of assets.get(p.take_id)?.values() ?? []) {
      const perp = a.type === "spot" && a.underlyingKey ? bank?.perpFor(a.underlyingKey) : null;
      if (perp) extraPerps.add(perp.symbol);
    }
  }

  const all = [...assets.values()].flatMap((m) => [...m.values()]);
  const snap = await snapshot(all, { alpacaHeaders, phoenix, gemini, log, cards, jupiterApiKey }, [...extraPerps]);

  // Open positions' live returns, first: the author's buy-in's is the take's return.
  const posRows: { network: string; address: string; live_return_bps: number }[] = [];
  const authorBps = new Map<string, number>();
  let skipped = 0;
  if (chain) {
    const fullCheck = missing.startRun();
    const wanted = positions.filter((p) => p.take_id);
    skipped = fullCheck ? 0 : wanted.filter((p) => missing.has(p.address)).length;
    // Either way: opened_at is the chain's clock, and a fork's clock can run ahead (time travel).
    const recent = wanted.filter((p) => !p.opened_at || Math.abs(Date.now() - Date.parse(p.opened_at)) < FRESH_MS);
    const fresh = new Set(recent.flatMap((p) => [p.address, p.take]));
    const read = await chain.load(wanted.map((p) => p.address), wanted.map((p) => p.take), fresh);
    for (const p of wanted) {
      const a = assets.get(p.take_id!);
      const cl = read.takes.get(p.take);
      const cp = read.positions.get(p.address);
      if (!a || !cl || !cp) continue;
      const opened = p.opened_at ? Math.floor(Date.parse(p.opened_at) / 1000) : null;
      const exits = cl.map((_, i) => positionExit(a.get(i) ?? { type: "void", reason: "no pick" }, p.side, snap, bank, opened));
      const bps = positionLiveBps(cl, cp, exits);
      if (bps === null) continue;
      posRows.push({ network, address: p.address, live_return_bps: bps });
      if (p.isAuthor) authorBps.set(p.take_id!, bps);
    }
  } else log(`chain unreachable at ${rpcUrl}: positions skipped`);

  const legs: LegUpdate[] = [];
  const takeRets: { take_id: string; ret_pct: number }[] = [];
  for (const t of takes) {
    // The author sold: the take's headline and its picks' marks stay at the sale.
    if (t.frozen) continue;
    const a = assets.get(t.id)!;
    // Older takes: bases from history (the stock's first trade, Phoenix's first bar after posting).
    const historical = new Map<number, Base>();
    const createdSec = Math.floor(Date.parse(t.created_at) / 1000);
    for (const l of t.legs) {
      if (l.base_price) continue;
      if (snap.nowSec - createdSec <= 900) continue;
      const h = await historicalBase(a.get(l.idx)!, createdSec, snap.nowSec, { stocks, phoenix }, snap);
      if (h) historical.set(l.idx, h);
    }
    const plan = planTake(t, t.legs, a, snap, historical);
    legs.push(...plan.legs);
    const author = authorBps.get(t.id);
    if (author !== undefined) {
      plan.take = { take_id: t.id, ret_pct: author / 100 };
      plan.notes.push("return: the author's buy-in, on its signed entry prices");
    }
    if (plan.take) takeRets.push(plan.take);
    if (verbose) {
      log(`take ${t.id.slice(0, 8)} ${plan.take ? `${plan.take.ret_pct.toFixed(2)}%` : "—"}  ${plan.legs.map((u) => `#${u.idx} ${u.ret_pct.toFixed(2)}% @${u.mark_price.toPrecision(6)}${u.base_price ? ` (base ${u.base_price.toPrecision(6)} ${u.base_source?.rule})` : ""}`).join("; ")}`);
      for (const n of plan.notes) log(`    ${n}`);
    }
  }

  const marks = { legs, takes: takeRets, positions: posRows };
  log(`${takes.length - takes.filter((t) => t.frozen).length} open takes (+${takes.filter((t) => t.frozen).length} closed with open positions): ${takeRets.length} returns, ${legs.length} pick marks, ${posRows.length}/${positions.length} positions${skipped ? ` (${skipped} not on chain, skipped until the hourly check)` : ""} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  if (dry || !db.hasMarkColumns) {
    if (dry && args.includes("--json")) console.log(JSON.stringify(marks, null, 1));
    return;
  }
  const r = await fetch(marksUrl, { method: "POST", headers: { "content-type": "application/json", "x-marks-token": marksToken! }, body: JSON.stringify({ marks }), signal: AbortSignal.timeout(60_000) });
  const body = await r.text();
  if (!r.ok) throw new Error(`marks: HTTP ${r.status} ${body.slice(0, 200)}`);
  log(`written: ${body}`);
}

const intervalMs = Number(envVar("MARKER_INTERVAL_SEC") ?? 300) * 1000;
// A stop ends the 5-minute wait at once. A run in progress gets STOP_GRACE_MS to finish (its
// marks are rewritten by the next run anyway), then the process exits instead of being killed.
const STOP_GRACE_MS = 15_000;
const stopping = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping.signal.aborted) return;
    stopping.abort();
    setTimeout(() => {
      log("stopped mid-run");
      process.exit(0);
    }, STOP_GRACE_MS).unref();
  });
}
do {
  try {
    await run();
  } catch (e) {
    log(`run failed: ${e instanceof Error ? e.message : e}`);
    if (once) process.exit(1);
  }
  if (!once && !stopping.signal.aborted) await sleepUnless(intervalMs, stopping.signal);
} while (!once && !stopping.signal.aborted);
