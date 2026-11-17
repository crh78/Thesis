// Records live data for the tests: the bank entries of a few underlyings and live Jupiter
// quotes for each of their issuer tokens. Run by hand; CI only reads the result.
//
//   node packages/venues/bank/test/record-fixtures.ts <bank.json>
//
// Needs a bank file from a poller run (ASSET_BANK_FILE) and JUPITER_API_KEY. Quotes are
// trimmed to the fields routing reads; no keys are written.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../../registry/src/lib/env.ts";
import { FileSink } from "../src/sinks.ts";
import { JupiterClient } from "../src/jupiter.ts";
import { readScaledUi } from "../src/ratios.ts";
import { Rpc } from "../../registry/src/lib/solana.ts";

const KEYS = ["equity:US:NVDA", "etf:US:SPY", "commodity:XAU", "private:OPENAI"];
const SIZES = [100, 1000];

const state = (await new FileSink(process.argv[2]).load())!;
const env = loadEnv();
const jup = new JupiterClient(env.jupiterApiKey, 40);
const rpc = new Rpc(env.rpcUrl);
const tokens: Record<string, unknown> = {};
const underlyings: Record<string, unknown> = {};
const quotes: Record<string, Record<string, unknown>> = {};
for (const k of KEYS) {
  const u = state.underlyings[k];
  underlyings[k] = { ...u, perps: [] };
  const live = await rpc.getAccounts(u.mints, "jsonParsed");
  for (const m of u.mints) {
    tokens[m] = { ...state.tokens[m], scaledUi: live.get(m) ? readScaledUi(live.get(m)) : null };
    for (const usd of SIZES) {
      const r = await jup.quote(m, usd, { maxAccounts: 30 });
      const q = r.quote;
      (quotes[m] ??= {})[usd] = q
        ? { quote: { inAmount: q.inAmount, outAmount: q.outAmount, otherAmountThreshold: q.otherAmountThreshold, priceImpactPct: q.priceImpactPct, slippageBps: q.slippageBps, routePlan: q.routePlan.map((p) => ({ swapInfo: { label: p.swapInfo.label }, percent: p.percent })), contextSlot: q.contextSlot }, error: null }
        : { quote: null, error: r.error };
    }
  }
}
const out = { recordedAt: new Date().toISOString(), note: "Live Jupiter quotes (USDC in, maxAccounts=30) and bank entries; see record-fixtures.ts", underlyings, tokens, quotes };
const path = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live.json");
writeFileSync(path, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${path}: ${Object.keys(tokens).length} tokens, ${Object.values(quotes).reduce((a, q) => a + Object.keys(q).length, 0)} quotes`);
