// pnpm fork:friend <back|fade> <take-id> [usd] — a second person for dogfooding, over HTTP only.
//
// Acts as a stand-in friend against the fork API at FORK_API_URL (required), the
// way the app does: adds fake cash, builds the trade, signs it like Privy's signTransaction and
// submits it. Needs no RPC access, so it works from any machine against the shared fork. Use it to
// back or fade your own take, so creator fees and "someone traded your take" notifications have
// something to show.
//
// The wallet is kept in .data/fork/friend.json, so later runs are the same person.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, VersionedTransaction } from "@solana/web3.js";

if (!process.env.FORK_API_URL) {
  console.error("Set FORK_API_URL to the fork API (https://<fork-host>, or http://127.0.0.1:18901 for a local fork).");
  process.exit(1);
}
const API = process.env.FORK_API_URL.replace(/\/$/, "");
const KEY = join(dirname(fileURLToPath(import.meta.url)), "../../.data/fork/friend.json");

function friend(): Keypair {
  if (existsSync(KEY)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, "utf8"))));
  const k = Keypair.generate();
  mkdirSync(dirname(KEY), { recursive: true });
  writeFileSync(KEY, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  return k;
}

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(json)}`);
  return json;
}

async function run(): Promise<void> {
  const [side, take, usdArg] = process.argv.slice(2);
  if ((side !== "back" && side !== "fade") || !take) {
    console.error("usage: pnpm fork:friend <back|fade> <take-id> [usd=20]");
    process.exit(2);
  }
  const usd = Number(usdArg ?? 20);
  const me = friend();
  const owner = me.publicKey.toBase58();
  console.log(`friend ${owner} on ${API}`);

  const dep = await call("POST", `/wallets/${owner}/deposits`, { usd: usd + 5 });
  console.log(`cash: $${dep.usdc}`);

  const built = await call("POST", `/takes/${take}/trades`, { owner, side, usd });
  for (const x of built.excluded ?? []) console.log(`  left out ${x.name}: ${x.reason}`);
  const signed = built.transactions.map((b64: string) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    tx.sign([me]);
    return Buffer.from(tx.serialize()).toString("base64");
  });
  const sent = await call("POST", "/submit", { buildId: built.buildId, transactions: signed });
  console.log(`${side} $${usd}: ${sent.signatures.join(", ")}`);
}

run().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
