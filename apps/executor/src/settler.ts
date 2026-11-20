// Settler price service: signs entry and exit prices, settles takes and positions, mints badges.
//
//   pnpm --filter @thesis/executor settler             run forever (Ctrl-C to stop)
//   pnpm --filter @thesis/executor settler -- --once   one tick, then exit
//
// Settings (environment or the repo-root .env; keys are never printed):
//   SOLANA_RPC_URL              default the local fork, http://127.0.0.1:18899
//   SETTLER_KEYPAIR             Solana CLI keypair file; default <repo>/.data/fork/settler.json
//   ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY   US stock prices and splits (required)
//   JUPITER_API_KEY             issuer token prices and yield legs, on api.jup.ag (required)
//   COLLECTOR_CRYPT_API_KEY     optional ccsk_ key for card legs' insured values (higher rate limits)
//   SETTLER_MIN_LIQUIDITY_USD   25000 (PRICEABLE_MIN_POOLED_USD): token price used only with this much pooled liquidity
//   SETTLER_LIVE_WINDOW_SEC     300: token prices only within 5 minutes of the trade or horizon
//   SETTLER_STALE_REF_SEC       900: no premium to the stock is measured against an older trade
//   SETTLER_INTERVAL_SEC        20
//   SETTLER_AUDIT_FILE          <repo>/.data/settler/audit.jsonl
//   PRICE_AUDIT_TOKEN           publishes every signed price's source document to public.price_audit
//                               (the price-audit function), so anyone can check the on-chain hash
//                               (scripts/verify-prices.ts); entry bases are read back from it on start.
//                               Without it, the local file only. PRICE_AUDIT_URL overrides the URL.
//   ASSET_BANK_SINK             where the asset bank lives (packages/venues/bank/README.md)
//   SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY   the open positions come from chain_positions (the
//                               Stream's table) between full scans; without them every tick scans
//   SETTLER_CHAIN_NETWORK       chain_positions network: solana-mainnet-fork for a local RPC,
//                               solana-mainnet otherwise
//   SETTLER_FULL_SCAN_SEC       600: the full program scan's period, a backstop for the Stream
//
// Every outbound read times out after 15 s (src/http.ts), so one hung source can't stall a tick
// past the live window.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { thesisProgram } from "@thesis/chain";
import { PRICEABLE_MIN_POOLED_USD, defaultSink, loadBankState } from "@thesis/venues/bank";
import { fetchGeminiEvent, geminiProxy } from "@thesis/venues/gemini";
import { jupiterLendShareValue } from "@thesis/venues/jupiter";
import { CollectorCryptClient, cardPrice } from "@thesis/venues/collector-crypt";
import { decodeTrader, PhoenixVenue } from "@thesis/venues/phoenix";
import { PublicKey } from "@solana/web3.js";
import { envVar } from "../../../packages/venues/registry/src/lib/env.ts";
import { sleepUnless, timedFetch } from "./http.ts";
import {
  AlpacaStocks,
  DEFAULT_MIN_RECEIVED_RATIO,
  FileAuditLog,
  GeminiEvents,
  JupiterPrices,
  RemoteAuditLog,
  Settler,
  SupabaseOpenPositions,
  bankIndex,
} from "./settler/index.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const num = (k: string, d: number) => {
  const v = envVar(k);
  if (v === null) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
  return n;
};
const required = (k: string) => {
  const v = envVar(k);
  if (!v) throw new Error(`${k} is not set (environment or repo-root .env)`);
  return v;
};

const once = process.argv.includes("--once");
const jupiterKey = required("JUPITER_API_KEY");
// For the venue clients that take a fetch function (Gemini proxy, Collector Crypt, Jupiter Lend).
const fetchWithTimeout = timedFetch();
const rpcUrl = envVar("SOLANA_RPC_URL") ?? "http://127.0.0.1:18899";
const keyPath = envVar("SETTLER_KEYPAIR") ?? join(REPO, ".data/fork/settler.json");
const settler = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
const connection = new Connection(rpcUrl, "confirmed");
const program = thesisProgram(connection);
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m: string) => console.log(`${stamp()} ${m}`);

const sink = defaultSink();
let bank = bankIndex(await loadBankState(sink));
let bankLoadedAt = Date.now();

/**
 * Prediction legs' prices: live Gemini events through the Supabase `gemini` proxy (never directly),
 * each read reused for 15 s, and events it's been waiting on for a few minutes read every 1 to 5 minutes
 * (settler/gemini-source.ts). Without GEMINI_PROXY_TOKEN prediction legs wait.
 */
function geminiEvents() {
  try {
    const proxy = geminiProxy(envVar);
    return new GeminiEvents((ticker) => fetchGeminiEvent(proxy, ticker, fetchWithTimeout));
  } catch (e) {
    log(`prediction legs won't be priced: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}

/** chain_positions, when Supabase is configured: the open set between full scans (settler/open-set.ts). */
function openPositions() {
  const url = envVar("SUPABASE_URL");
  const key = envVar("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !key) {
    log("no SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY: every tick scans all program accounts");
    return null;
  }
  const local = ["127.0.0.1", "localhost"].includes(new URL(rpcUrl).hostname);
  return new SupabaseOpenPositions({ url, key, network: envVar("SETTLER_CHAIN_NETWORK") ?? (local ? "solana-mainnet-fork" : "solana-mainnet") });
}
const open = openPositions();

// Phoenix legs (perp legs, fade shorts): positions read from the chain, markets and marks from
// Phoenix's public API (docs/phoenix-plan.md).
const phoenix = new PhoenixVenue({ rpcUrl });
const phoenixReader = {
  trader: async (account: string) => {
    const info = await connection.getAccountInfo(new PublicKey(account), "confirmed");
    return info ? decodeTrader(info.data) : null;
  },
  marketByOrderbook: async (orderbook: string) => (await phoenix.markets()).byOrderbook.get(orderbook) ?? null,
};

// Every signed price's source document: the local file, and public.price_audit when configured, so
// the hash each record_*_prices puts on chain can be checked by anyone and bases survive a lost file.
const fileAudit = new FileAuditLog(envVar("SETTLER_AUDIT_FILE") ?? join(REPO, ".data/settler/audit.jsonl"));
const audit = (() => {
  const supaUrl = envVar("SUPABASE_URL");
  const token = envVar("PRICE_AUDIT_TOKEN");
  if (!token || !supaUrl) return fileAudit;
  const key = envVar("SUPABASE_PUBLISHABLE_KEY");
  const local = ["127.0.0.1", "localhost"].includes(new URL(rpcUrl).hostname);
  return new RemoteAuditLog({
    url: envVar("PRICE_AUDIT_URL") ?? `${supaUrl}/functions/v1/price-audit`,
    token,
    network: envVar("SETTLER_CHAIN_NETWORK") ?? (local ? "solana-mainnet-fork" : "solana-mainnet"),
    local: fileAudit,
    read: key ? { supabaseUrl: supaUrl, key, program: program.programId.toBase58() } : undefined,
    log,
  });
})();
if (audit instanceof RemoteAuditLog) log(`price audit: ${await audit.load()} entry docs read back, ${audit.backfill()} local docs queued`);

const cards = new CollectorCryptClient({ apiKey: envVar("COLLECTOR_CRYPT_API_KEY"), fetchFn: fetchWithTimeout });
const s = new Settler({
  program,
  connection,
  settler,
  get bank() {
    return bank;
  },
  sources: {
    // Trades, plus corporate actions: splits for tokens with no multiplier (pricing.ts).
    stocks: new AlpacaStocks(required("ALPACA_API_KEY_ID"), required("ALPACA_API_SECRET_KEY")),
    tokens: new JupiterPrices(jupiterKey),
    predictions: geminiEvents(),
    phoenix,
    // Yield legs (scored): one vault share's value.
    lend: {
      shareValue: async (mint: string) => {
        const v = await jupiterLendShareValue(mint, { apiKey: jupiterKey, fetchFn: fetchWithTimeout });
        return v && { usdcPerShare: v.usdcPerShare, at: Math.floor(Date.now() / 1000), raw: v.raw };
      },
    },
    // Card legs: the card's insured value, read live (card-legs.ts).
    cards: {
      card: async (cardId: string) => {
        const c = await cards.card(cardId);
        return c && { insuredValueUsd: cardPrice(c), at: Math.floor(Date.now() / 1000), raw: { id: c.id, insuredValue: c.insuredValueUsd, metadataUpdatedAt: c.metadataUpdatedAt, nftStatus: c.nftStatus } };
      },
    },
  },
  phoenix: phoenixReader,
  rules: {
    minLiquidityUsd: num("SETTLER_MIN_LIQUIDITY_USD", PRICEABLE_MIN_POOLED_USD),
    liveWindowSecs: num("SETTLER_LIVE_WINDOW_SEC", 300),
    // A spot leg's tokens must be worth this share of its part of the stake (proof.ts).
    minReceivedRatio: num("SETTLER_MIN_RECEIVED_RATIO", DEFAULT_MIN_RECEIVED_RATIO),
    staleRefSecs: num("SETTLER_STALE_REF_SEC", 900),
  },
  audit,
  log,
  openPositions: open,
  fullScanEverySecs: num("SETTLER_FULL_SCAN_SEC", 600),
});

log(`settler ${settler.publicKey.toBase58()} on ${new URL(rpcUrl).host}, bank from ${sink.name}${open ? `, open positions from ${open.name}` : ""}`);
const intervalMs = num("SETTLER_INTERVAL_SEC", 20) * 1000;
// A stop ends the wait between ticks at once; a tick that's running finishes first.
const stopping = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => stopping.abort());
const stopped = () => stopping.signal.aborted;
do {
  if (Date.now() - bankLoadedAt > 10 * 60_000) {
    bank = bankIndex(await loadBankState(sink));
    bankLoadedAt = Date.now();
  }
  try {
    const t = await s.tick();
    for (const w of t.waiting) log(`waiting: ${w}`);
  } catch (e) {
    log(`tick failed: ${e instanceof Error ? e.message : e}`);
    if (once) process.exit(1);
  }
  if (!once && !stopped()) await sleepUnless(intervalMs, stopping.signal);
} while (!once && !stopped());
if (audit instanceof RemoteAuditLog) await audit.close();
