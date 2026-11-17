// Loads API keys from the repo-root .env without ever printing their values.
// Walks up from this file, so it finds the main checkout's .env even from a
// git worktree under .claude/worktrees/. THESIS_ENV_FILE overrides the path.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Env = {
  rpcUrl: string | null; // QUICKNODE_RPC_URL
  jupiterApiKey: string | null; // JUPITER_API_KEY
  pythApiKey: string | null; // PYTH_API_KEY
  envFile: string | null;
};

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function findEnvFile(): string | null {
  if (process.env.THESIS_ENV_FILE) return existsSync(process.env.THESIS_ENV_FILE) ? process.env.THESIS_ENV_FILE : null;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return null;
}

let cached: { envFile: string | null; vars: Record<string, string> } | null = null;
function fileVars() {
  if (!cached) {
    const envFile = findEnvFile();
    cached = { envFile, vars: envFile ? parseDotenv(readFileSync(envFile, "utf8")) : {} };
  }
  return cached;
}

/** One variable: process.env first, then the repo-root .env. Null when unset or empty. Never log the value. */
export function envVar(k: string): string | null {
  const v = process.env[k] ?? fileVars().vars[k];
  return v && v.length > 0 ? v : null;
}

export function loadEnv(): Env {
  const { envFile } = fileVars();
  const pick = envVar;
  return {
    rpcUrl: pick("QUICKNODE_RPC_URL"),
    jupiterApiKey: pick("JUPITER_API_KEY"),
    pythApiKey: pick("PYTH_API_KEY"),
    envFile,
  };
}

/** Safe one-line description: says whether each key is set, never the value. */
export function describeEnv(env: Env): string {
  const s = (v: string | null) => (v ? "set" : "empty");
  return `QUICKNODE_RPC_URL=${s(env.rpcUrl)} JUPITER_API_KEY=${s(env.jupiterApiKey)} PYTH_API_KEY=${s(env.pythApiKey)}`;
}
