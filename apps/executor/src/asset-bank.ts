// Asset-bank poller: keeps the bank of tradeable assets fresh for the AI.
//
//   pnpm --filter @thesis/executor asset-bank                 run forever (Ctrl-C to stop)
//   pnpm --filter @thesis/executor asset-bank -- --once       every tier once, then exit
//   ... --once --tiers=discovery,prices,probes --max-probes=20
//
// Cadences and limits come from ASSET_BANK_* env vars (packages/venues/bank/README.md).
// ASSET_BANK_SINK=supabase writes to Supabase; the default is <repo>/.data/asset-bank.json.
// After each Gemini sweep the take builder's catalog gets the new contracts (and loses the
// expired ones) when SECURITIES_INDEX_SECRET is set (supabase/functions/.env), and every 15 minutes
// the catalog's tradeable/thin flags follow what the settler can actually price
// (packages/take-builder/src/liquidity-sync.ts). --no-index turns both off.
// The cards tier also reads every card a basket has picked (the catalog's card:<cardId> rows,
// public, with SUPABASE_PUBLISHABLE_KEY) so the settler can price card legs.
// Keys are read from the environment or the repo-root .env and never printed.
import { AssetBankPoller, RequestCounter, TIERS, defaultSink, loadBankConfig, type TierName } from "@thesis/venues/bank";
import { geminiIndexEnv, indexGeminiContracts } from "@thesis/take-builder/gemini-index";
import { syncLiquidity } from "@thesis/take-builder/liquidity-sync";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.slice(2).split("=");
    return [k, v ?? "true"];
  }),
);
const tiers = args.tiers ? (String(args.tiers).split(",") as TierName[]) : undefined;
for (const t of tiers ?? []) if (!TIERS.includes(t)) throw new Error(`unknown tier ${t}; tiers are ${TIERS.join(", ")}`);

const config = loadBankConfig();
const sink = defaultSink();
const counter = new RequestCounter();
counter.install();
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m: string) => console.log(`${stamp()} ${m}`);
const indexEnv = args["no-index"] ? null : geminiIndexEnv();
if (!indexEnv?.secret) log("asset-bank: Gemini sweeps won't update the take builder's catalog (set SECURITIES_INDEX_SECRET, or --no-index was given)");
const afterGemini = indexEnv?.secret ? (contracts: Parameters<typeof indexGeminiContracts>[0]) => indexGeminiContracts(contracts, indexEnv, { log }).then(() => {}) : undefined;
// Cards baskets have picked: the catalog's card:<cardId> rows (the take builder writes them).
const catalogEnv = geminiIndexEnv();
const pickedCards = catalogEnv?.publishableKey
  ? async (): Promise<string[]> => {
    const key = catalogEnv.publishableKey!;
    const ids: string[] = [];
    for (let from = 0; ; from += 1000) {
      const r = await fetch(`${catalogEnv.supabaseUrl}/rest/v1/securities?kind=eq.card&select=id&order=id`, {
        headers: { apikey: key, authorization: `Bearer ${key}`, range: `${from}-${from + 999}` },
      });
      if (!r.ok) throw new Error(`catalog card rows: HTTP ${r.status}`);
      const rows = (await r.json()) as { id: string }[];
      for (const { id } of rows) if (id.startsWith("card:")) ids.push(id.slice("card:".length));
      if (rows.length < 1000) return ids;
    }
  }
  : undefined;
if (!pickedCards) log("asset-bank: card legs won't be tracked (set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY)");
const poller = await AssetBankPoller.open({ sink, config, log, afterGemini, pickedCards });
if (args["max-probes"]) poller.maxProbesPerRun = Number(args["max-probes"]);
console.log(`${stamp()} asset-bank: sink=${sink.name}, jupiter=${poller.jup.label} at ${config.jupiterRpm} req/min, ${Object.keys(poller.state.tokens).length} tokens loaded`);

// The catalog's tradeable/thin flags, from the bank's live probes (refuses on stale probes).
const syncLiq = () =>
  indexEnv?.secret ? syncLiquidity(poller.state, indexEnv, { log }).then(() => {}).catch((e) => log(`liquidity sync: ${e instanceof Error ? e.message : e}`)) : Promise.resolve();

if (args.once) {
  const res = await poller.runOnce(tiers ?? TIERS);
  await syncLiq();
  for (const [t, r] of Object.entries(res)) console.log(`${t.padEnd(10)} ${r.ok ? "ok    " : "FAILED"} ${(r.ms / 1000).toFixed(1)}s${r.error ? `  ${r.error}` : ""}`);
  console.log(`requests by host: ${JSON.stringify(counter.byHost)}`);
  process.exit(Object.values(res).every((r) => r.ok) ? 0 : 1);
}

// On a stop, tiers that are running get STOP_GRACE_MS to finish; then the bank is flushed with
// what they've written so far (each write is atomic) and the process exits, instead of systemd
// killing it after 90 s and losing the unflushed changes.
const STOP_GRACE_MS = 10_000;
const ctl = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => ctl.abort());
const report = setInterval(() => console.log(`${stamp()} requests/hour by host: ${JSON.stringify(counter.perHour())}`), 15 * 60_000);
const liq = setInterval(syncLiq, 15 * 60_000);
const graceOver = new Promise<"grace">((resolve) =>
  ctl.signal.addEventListener("abort", () => setTimeout(() => resolve("grace"), STOP_GRACE_MS).unref(), { once: true }),
);
const ended = await Promise.race([poller.scheduler(tiers).loop(ctl.signal), graceOver]);
clearInterval(report);
clearInterval(liq);
await poller.flush().catch((e) => log(`asset-bank: final flush failed: ${e instanceof Error ? e.message : e}`));
console.log(`${stamp()} asset-bank: stopped${ended === "grace" ? " (tiers still running were cut off)" : ""}, bank flushed`);
process.exit(0);
