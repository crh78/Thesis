// Uploads the badge catalog to Supabase Storage's public `badges` bucket: each badge's image
// (infra/badges/images/<slug>.png, from render.swift) and its Token-2022 metadata JSON
// (<slug>.json), which wallets and explorers read from the badge's on-chain URI.
//
//   pnpm badges:upload             upload (replaces what's there)
//   pnpm badges:upload -- --dry    print the metadata, upload nothing
//
// SUPABASE_URL from the environment or the repo-root .env. With SUPABASE_SERVICE_ROLE_KEY it
// uploads over Storage's API; without it, through the Supabase CLI's login and linked project
// (`supabase login`, `supabase link`). Keys are never printed. The bucket comes from
// supabase/migrations/*_badges_bucket.sql.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envVar } from "../../packages/venues/registry/src/lib/env.ts";
import { BADGE_META, supabaseBadgeUriBase, type BadgeKindName } from "../../packages/chain/src/types.ts";

/** What each badge is for (the catalog in CLAUDE.md). */
const DESCRIPTION: Record<BadgeKindName, string> = {
  firstTake: "Posted a first take on Thesis, with the author's own money behind it.",
  firstOver50: "A first take that finished at +50% or more.",
  firstOver100: "A first take that finished at +100% or more.",
  tenOver50: "Ten takes that each finished at +50% or more.",
  over1000: "A take that finished at +1,000% or more.",
};

/** Token-2022 metadata JSON, in the shape wallets read (Metaplex's token standard). */
export function badgeMetadata(base: string, kind: BadgeKindName) {
  const { name, slug } = BADGE_META[kind];
  const image = `${base}${slug}.png`;
  return {
    name,
    symbol: "THESIS",
    description: `${DESCRIPTION[kind]} Non-transferable: earned, not bought.`,
    image,
    attributes: [
      { trait_type: "Badge", value: name },
      { trait_type: "Transferable", value: "No" },
    ],
    properties: { category: "image", files: [{ uri: image, type: "image/png" }] },
  };
}

async function upload(url: string, key: string, path: string, body: Buffer | string, type: string) {
  const res = await fetch(`${url}/storage/v1/object/badges/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, apikey: key, "content-type": type, "x-upsert": "true", "cache-control": "max-age=300" },
    body,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/**
 * Without a service-role key: the Supabase CLI, run from supabase/ so it finds the linked
 * project. Its `cp` won't overwrite, so the old object goes first (a missing one is fine).
 */
function uploadWithCli(path: string, body: Buffer | string, type: string) {
  const dir = mkdtempSync(join(tmpdir(), "thesis-badges-"));
  const cli = (...args: string[]) =>
    execFileSync("npx", ["-y", "supabase@2", "--experimental", "storage", ...args, "--linked"], {
      cwd: join(import.meta.dirname, "../../supabase"),
      stdio: ["ignore", "ignore", "pipe"],
    });
  try {
    const file = join(dir, path);
    writeFileSync(file, body);
    try {
      cli("rm", `ss:///badges/${path}`, "--yes");
    } catch {
      // Not there yet.
    }
    cli("cp", file, `ss:///badges/${path}`, "--content-type", type, "--cache-control", "max-age=300");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const url = envVar("SUPABASE_URL")?.replace(/\/$/, "");
  if (!url) throw new Error("SUPABASE_URL is not set");
  const base = supabaseBadgeUriBase(url);
  const dry = process.argv.includes("--dry");
  const key = envVar("SUPABASE_SERVICE_ROLE_KEY");
  const put = async (path: string, body: Buffer | string, type: string) =>
    key ? upload(url, key, path, body, type) : uploadWithCli(path, body, type);
  if (!dry && !key) console.log("No SUPABASE_SERVICE_ROLE_KEY: uploading with the Supabase CLI's login.");
  for (const kind of Object.keys(BADGE_META) as BadgeKindName[]) {
    const { slug } = BADGE_META[kind];
    const meta = JSON.stringify(badgeMetadata(base, kind), null, 2);
    if (dry) {
      console.log(meta);
      continue;
    }
    await put(`${slug}.png`, readFileSync(join(import.meta.dirname, "images", `${slug}.png`)), "image/png");
    await put(`${slug}.json`, meta, "application/json");
    console.log(`✓ ${base}${slug}.json`);
  }
}

if (import.meta.main) await main();
