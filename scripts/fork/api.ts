// pnpm fork:api — the local fork API the app talks to in fork mode (see api/server.ts for routes).
//
// Builds each trade with real Jupiter routes and the Thesis receipt, lets the user's Privy wallet
// sign it, then adds the fork app fee payer's signature and sends it to the fork. Takes come from
// Supabase (public reads with the publishable key); demo takes are mirrored on-chain on first trade.
//
// Settings: FORK_API_PORT (18901), FORK_HOST (127.0.0.1; 0.0.0.0 for a phone on the same Wi-Fi),
// SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY (required), JUPITER_API_KEY,
// ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY (live returns on receipts; optional),
// THESIS_WEBHOOK_URL / THESIS_WEBHOOK_TOKEN (as for `pnpm fork:relay`: an app take's publish is
// delivered to the backend as soon as it lands, which is what makes the take live; FORK_API_RELAY=0
// leaves that to the relay).
import { PhoenixVenue } from "@thesis/venues/phoenix";
import { ensureForkOnboarder } from "./phoenix.ts";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlpacaStocks, AuditBases } from "@thesis/executor/settler";
import { FileSink, buildsBusyFileFor, defaultSink, loadBankState, type BankState } from "@thesis/venues/bank";
import { fetchGeminiEvent, geminiProxy } from "@thesis/venues/gemini";
import { envVar } from "../../packages/venues/registry/src/lib/env.ts";
import { quicknodeHeaders, relayTransactions, webhookConfigured } from "../../infra/quicknode/fork-relay.ts";
import { blinkServer } from "../../apps/web/blink.ts";
import { LiveContracts } from "./api/gemini-live.ts";
import { Guard, parseMode, parseServiceKeys } from "./api/guard.ts";
import { forkApiServer, parseCorsOrigins } from "./api/server.ts";
import { DEFAULT_STATE_PATH, ForkService, type AppTake, type TakeSource } from "./api/service.ts";
import { DATA_DIR, FORK_DEXES, HOST, PATHS, addUsdc, connection, deployedElf, loadKeypair, main, refreshMarkets, requireSurfpool, setUsdc, thesisLookupTable, topUpSol } from "./lib.ts";
import { fetchConfig, thesisProgram } from "@thesis/chain";

/** Longest wait for one Supabase, Gemini (proxy) or Alpaca read before it's abandoned. */
const HTTP_TIMEOUT_MS = 10_000;

/** `fetch` that gives up after HTTP_TIMEOUT_MS (unless the caller passed its own signal). */
const fetchWithTimeout: typeof fetch = (input, init) => fetch(input, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), ...init });

/** Supabase's public client settings (repo-root .env), required to read app takes. */
function supabaseSettings(): { url: string; key: string } {
  const url = envVar("SUPABASE_URL");
  const key = envVar("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set (repo-root .env) to read takes from Supabase.");
  return { url, key };
}

/**
 * A take by id, including one still posting (only its author has that id): `take_for_chain`.
 * Falls back to the public `take` on a database without it (posting takes then read as missing).
 */
export const supabaseTakes: TakeSource = async (id) => {
  const { url, key } = supabaseSettings();
  const read = (fn: string) =>
    fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: key, "content-type": "application/json" },
      body: JSON.stringify({ p_id: id }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  let r = await read("take_for_chain");
  if (r.status === 404) r = await read("take");
  if (!r.ok) throw new Error(`Supabase take(${id}): HTTP ${r.status}`);
  return (await r.json()) as AppTake | null;
};

/** The take builder's catalog rows, for resolving the leg names the AI writes. */
function takeBuilderCatalog() {
  const path = join(import.meta.dirname, "../../packages/take-builder/catalog.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")).rows ?? []) : [];
}

/** Live Gemini reads through the Supabase proxy, or null (bank prices only) without GEMINI_PROXY_TOKEN. */
function liveGemini(log: (m: string) => void): LiveContracts | null {
  try {
    const proxy = geminiProxy(envVar);
    return new LiveContracts((ticker) => fetchGeminiEvent(proxy, ticker, fetchWithTimeout), { log });
  } catch (e) {
    log(`prediction legs use the asset bank's prices only: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * `takes` replaces Supabase as the take source (e2e checks with a take made up for the run).
 * `statePath`: the state file. Only the live API (`pnpm fork:api`) passes the shared one; anything
 * else (e2e suites, scripts) gets a throwaway file of its own, so a test run can never overwrite
 * the live fork API's mirrors, cash records and charts.
 */
export async function startForkService(log: (m: string) => void, o: { takes?: TakeSource; statePath?: string } = {}) {
  // Without a take source of its own, the service reads takes from Supabase: fail now if it can't.
  if (!o.takes) supabaseSettings();
  await requireSurfpool();
  if (!(await deployedElf())) throw new Error("Thesis isn't deployed on the fork. Run `pnpm fork:up`.");
  let bank: BankState = await loadBankState();
  setInterval(async () => (bank = await loadBankState().catch(() => bank)), 10 * 60_000).unref();
  const alpacaId = envVar("ALPACA_API_KEY_ID");
  const alpacaSecret = envVar("ALPACA_API_SECRET_KEY");
  const conn = connection();
  const relay = webhookConfigured() && process.env.FORK_API_RELAY !== "0";
  // Phoenix perps: the fork's onboarder registers traders (scripts/fork/phoenix.ts). FORK_PHOENIX=0 turns it off.
  const phoenix = process.env.FORK_PHOENIX === "0"
    ? null
    : await ensureForkOnboarder().then(
      (onboarder) => ({ venue: new PhoenixVenue({ rpcUrl: conn.rpcEndpoint }), onboarder }),
      (e: unknown) => {
        log(`Phoenix legs are off: ${e instanceof Error ? e.message : e}`);
        return null;
      },
    );
  return new ForkService({
    connection: conn,
    appPayer: loadKeypair(PATHS.appPayer),
    lookupTable: thesisLookupTable(),
    bank: () => bank,
    takes: o.takes ?? supabaseTakes,
    stocks: alpacaId && alpacaSecret ? new AlpacaStocks(alpacaId, alpacaSecret, fetchWithTimeout) : null,
    // The settler's audit log (same default as SETTLER_AUDIT_FILE there): each leg's entry basis.
    bases: new AuditBases(envVar("SETTLER_AUDIT_FILE") ?? join(DATA_DIR, "..", "settler", "audit.jsonl")),
    gemini: liveGemini(log),
    catalog: takeBuilderCatalog(),
    jupiterApiKey: envVar("JUPITER_API_KEY"),
    dexes: FORK_DEXES,
    statePath: o.statePath ?? join(mkdtempSync(join(tmpdir(), "thesis-fork-api-")), "api-state.json"),
    fork: { addUsdc: (w, usd) => addUsdc(w, usd), setUsdc, refreshMarkets },
    relay: relay ? (signatures) => relayTransactions(conn.rpcEndpoint, signatures) : undefined,
    phoenix,
    log,
  });
}

/**
 * Sends today's position digests to the `notify` function (NOTIFY_URL, signed with NOTIFY_TOKEN),
 * which turns them into inbox notifications. Without both set it only logs what it would send.
 */
export async function sendDigests(service: ForkService, log: (m: string) => void, day = digestTime(new Date()).day) {
  const { digests, markSent } = await service.dailyDigests(day);
  const url = envVar("NOTIFY_URL");
  const token = envVar("NOTIFY_TOKEN");
  if (!url || !token) {
    for (const d of digests) log(`digest (not sent: set NOTIFY_URL and NOTIFY_TOKEN) ${d.wallet.slice(0, 6)}…: ${d.title}`);
    return { day, digests, sent: false, stored: 0 };
  }
  if (!digests.length) return { day, digests, sent: true, stored: 0 };
  const body = JSON.stringify({ network: "solana-mainnet-fork", day, digests });
  const r = await fetch(url, { method: "POST", headers: quicknodeHeaders(body, {}, token), body });
  const j = (await r.json().catch(() => ({}))) as { stored?: number };
  log(`digests for ${day}: ${digests.length} sent, ${j.stored ?? 0} new (HTTP ${r.status})`);
  if (r.ok) markSent();
  return { day, digests, sent: r.ok, stored: j.stored ?? 0 };
}

/**
 * Sends inbox alerts for Phoenix legs near or close to liquidation to `notify` (signed like the
 * digests). `notify` stores each (wallet, key) once, so checking every few minutes is fine.
 */
export async function sendLiquidationAlerts(service: ForkService, log: (m: string) => void) {
  const alerts = await service.liquidationAlerts();
  if (!alerts.length) return { alerts, stored: 0 };
  const url = envVar("NOTIFY_URL");
  const token = envVar("NOTIFY_TOKEN");
  if (!url || !token) {
    for (const a of alerts) log(`liquidation alert (not sent: set NOTIFY_URL and NOTIFY_TOKEN) ${a.wallet.slice(0, 6)}…: ${a.title}`);
    return { alerts, stored: 0 };
  }
  const body = JSON.stringify({ network: "solana-mainnet-fork", alerts });
  const r = await fetch(url, { method: "POST", headers: quicknodeHeaders(body, {}, token), body });
  const j = (await r.json().catch(() => ({}))) as { stored?: number };
  if (!r.ok || j.stored) log(`liquidation alerts: ${alerts.length} at risk, ${j.stored ?? 0} new (HTTP ${r.status})`);
  return { alerts, stored: j.stored ?? 0 };
}

/** How often open Phoenix legs are checked against their liquidation prices. */
const LIQUIDATION_CHECK_MS = Number(envVar("LIQUIDATION_CHECK_SEC") ?? 300) * 1000;

const newYorkClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", hourCycle: "h23",
});
const DIGEST_HOUR_UTC = envVar("DIGEST_HOUR_UTC");

function digestTime(now: Date) {
  const { year, month, day, hour } = Object.fromEntries(newYorkClock.formatToParts(now).map(({ type, value }) => [type, value]));
  return {
    day: `${year}-${month}-${day}`,
    due: DIGEST_HOUR_UTC == null ? Number(hour) >= 9 : now.getUTCHours() >= Number(DIGEST_HOUR_UTC),
  };
}

/** The asset bank's `trade-builds.busy`, next to its file sink's bank (null with the Supabase sink). */
function bankBusyFile(): string | null {
  try {
    const sink = defaultSink();
    return sink instanceof FileSink ? buildsBusyFileFor(sink.path) : null;
  } catch {
    return null;
  }
}

/**
 * The public fork's abuse limits from the environment (see api/guard.ts and the README's "Abuse
 * limits"): FORK_API_AUTH, FORK_API_READ_LIMIT, FORK_API_SERVICE_KEYS, FORK_API_PROXY_KEY and the
 * Privy app values PRIVY_APP_ID, PRIVY_VERIFICATION_KEY, PRIVY_APP_SECRET.
 */
export function forkGuard(log: (m: string) => void): Guard {
  const appId = envVar("PRIVY_APP_ID");
  const verificationKey = envVar("PRIVY_VERIFICATION_KEY");
  const appSecret = envVar("PRIVY_APP_SECRET");
  const privy = appId && verificationKey && appSecret ? { appId, verificationKey, appSecret } : null;
  const auth = parseMode(envVar("FORK_API_AUTH"), ["off", "report", "enforce"] as const, "report");
  const readLimit = parseMode(envVar("FORK_API_READ_LIMIT"), ["report", "enforce"] as const, "report");
  if (auth === "enforce" && !privy) throw new Error("FORK_API_AUTH=enforce needs PRIVY_APP_ID, PRIVY_VERIFICATION_KEY and PRIVY_APP_SECRET");
  const serviceKeys = parseServiceKeys(envVar("FORK_API_SERVICE_KEYS"));
  log(`abuse limits: auth ${auth}${privy ? "" : " (no Privy values: tokens can't be checked)"}, read limit ${readLimit}, ${serviceKeys.size} service key(s)`);
  return new Guard({ auth, readLimit, serviceKeys, proxyKey: envVar("FORK_API_PROXY_KEY"), privy, log, busyFile: bankBusyFile() });
}

async function serve(): Promise<void> {
  const stamp = () => new Date().toISOString().slice(11, 19);
  const log = (m: string) => console.log(`${stamp()} ${m}`);
  const service = await startForkService(log, { statePath: DEFAULT_STATE_PATH(DATA_DIR) });
  const port = Number(process.env.FORK_API_PORT ?? 18901);
  const digest = () => sendDigests(service, log);
  const guard = forkGuard(log);
  // Origins whose browsers call the API directly instead of through the web app's proxy.
  const cors = parseCorsOrigins(envVar("FORK_API_CORS_ORIGINS"));
  log(cors.size ? `CORS for ${[...cors].join(", ")}` : "CORS off (FORK_API_CORS_ORIGINS unset)");
  forkApiServer(service, log, { digest, guard, cors }).listen(port, HOST, () => log(`fork API on http://${HOST}:${port} (run \`pnpm fork:settler\` too, for prices)`));
  const blinkPort = envVar("FORK_BLINK_PORT");
  if (blinkPort) {
    const port = Number(blinkPort);
    const origin = new URL(envVar("FORK_BLINK_ORIGIN") ?? `http://127.0.0.1:${port}`).origin;
    // Surfpool inherits mainnet's genesis hash. Give the preview a custom chain
    // reference so clients can't mistake the Action for a public mainnet Action.
    const forkReference = thesisLookupTable()?.toBase58().slice(0, 27) ?? "local";
    blinkServer(service, origin, `solana:fork-${forkReference}`, log)
      .listen(port, "127.0.0.1", () => log(`fork Blink on ${origin}`));
  }
  // Checked hourly; each wallet gets one digest per day (marked in the state file, and the
  // notify function refuses a second one for the same day).
  setInterval(() => {
    if (digestTime(new Date()).due) digest().catch((e) => log(`digest failed: ${e instanceof Error ? e.message : e}`));
  }, 60 * 60_000).unref();
  // Phoenix legs against their liquidation prices, every 5 minutes (LIQUIDATION_CHECK_SEC).
  setInterval(() => {
    sendLiquidationAlerts(service, log).catch((e) => log(`liquidation check failed: ${e instanceof Error ? e.message : e}`));
  }, LIQUIDATION_CHECK_MS).unref();
  // The app fee payer and the settler pay every trade's fees and rent: keep them in fake SOL.
  const topUp = () => keepFeePayersFunded(log).catch((e) => log(`SOL top-up failed: ${e instanceof Error ? e.message : e}`));
  void topUp();
  setInterval(topUp, TOPUP_CHECK_MS).unref();
  // The state file is written a few seconds after a change: write what's pending before stopping.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      try {
        service.flush();
      } catch (e) {
        log(`STATE NOT SAVED on ${signal}: ${e instanceof Error ? e.message : e}`);
        process.exit(1);
      }
      process.exit(0);
    });
  }
}

/** How often the fee-paying keys' SOL is checked. */
const TOPUP_CHECK_MS = 10 * 60_000;

/** Tops up the app fee payer and the settler key (the config's) on this fork (see `topUpSol`). */
async function keepFeePayersFunded(log: (m: string) => void) {
  const settler = (await fetchConfig(thesisProgram(connection()))).settler;
  return topUpSol([{ name: "app fee payer", key: loadKeypair(PATHS.appPayer).publicKey }, { name: "settler", key: settler }], log);
}

if (import.meta.main) await main(serve);
