// Sends catalog.json to the securities-index function in batches.
//
//   node packages/take-builder/src/catalog.ts        # registry → catalog.json
//   node packages/take-builder/src/index-catalog.ts  # catalog.json → public.securities
//   node packages/take-builder/src/index-catalog.ts --force   # regenerate descriptions
//
// Reads SUPABASE_URL from the repo-root .env and SECURITIES_INDEX_SECRET from
// supabase/functions/.env (same values as the deployed function's secrets).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");

function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

const env = { ...readEnv(join(root, ".env")), ...readEnv(join(root, "supabase/functions/.env")), ...process.env };
const url = `${env.SUPABASE_URL}/functions/v1/securities-index`;
const secret = env.SECURITIES_INDEX_SECRET;
if (!env.SUPABASE_URL || !secret) throw new Error("Need SUPABASE_URL (.env) and SECURITIES_INDEX_SECRET (supabase/functions/.env)");

const force = process.argv.includes("--force");
// Prediction contracts are indexed by index-gemini.ts, with their expiry. Never upsert one from
// here: an old catalog.json's event-level rows (gemini:<eventTicker>) would be re-marked tradeable.
const rows = (JSON.parse(readFileSync(join(here, "../catalog.json"), "utf8")).rows as { kind: string }[])
  .filter((r) => r.kind !== "prediction");
// Small batches: descriptions are a model call per batch.
const BATCH = 6;
const PARALLEL = 4;
const batches: unknown[][] = [];
for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));

let described = 0, indexed = 0, done = 0;
async function send(batch: unknown[], n: number) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-index-secret": secret },
      body: JSON.stringify({ rows: batch, force }),
    });
    const text = await res.text();
    if (res.ok) {
      const body = JSON.parse(text);
      described += body.described; indexed += body.indexed; done++;
      console.log(`batch ${n}/${batches.length} (${done} done): ${body.described} described, ${body.indexed} indexed`);
      return;
    }
    if (attempt >= 3) throw new Error(`batch ${n}: ${res.status} ${text.slice(0, 200)}`);
    console.log(`batch ${n}: ${res.status}, retrying`);
  }
}
let next = 0;
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  while (next < batches.length) { const n = next++; await send(batches[n], n + 1); }
}));
console.log(`done: ${rows.length} rows, ${described} described, ${indexed} indexed`);
