// Keeps the take builder's Gemini contracts current: one sweep of every active contract through
// the Supabase `gemini` proxy (never Gemini directly), then gemini-index.ts. The asset-bank poller
// does the same after each of its sweeps (every 6 hours), so this is for a manual refresh.
//
//   node packages/take-builder/src/index-gemini.ts            # new contracts only
//   node packages/take-builder/src/index-gemini.ts --all      # every eligible contract
//   node packages/take-builder/src/index-gemini.ts --dry-run  # count what it would send
import { loadGeminiMarkets } from "../../venues/registry/src/sources/gemini.ts";
import { geminiIndexEnv, indexGeminiContracts } from "./gemini-index.ts";

const env = geminiIndexEnv();
if (!env) throw new Error("Need SUPABASE_URL (.env)");
const { contracts } = await loadGeminiMarkets();
await indexGeminiContracts(contracts, env, { all: process.argv.includes("--all"), dryRun: process.argv.includes("--dry-run") });
