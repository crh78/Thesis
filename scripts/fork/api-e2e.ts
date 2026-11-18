// pnpm fork:api-e2e — the iOS app's fork-mode flow, against a real fork API over HTTP.
//
// Starts the fork API in-process on a spare port, then does what the app does: adds cash, reads a
// test take's receipt, builds a $25 back, signs it the way the Privy wallet's signTransaction would,
// submits it, and checks the receipt and the wallet. It also checks that a fade builds Phoenix
// shorts of the stock legs (without sending it; fork:phoenix-api-e2e trades them) and that a
// transaction changed after building is refused.
//
// Uses a take made up for the run with the seeded "AI power demand" take's legs (NVIDIA, Microsoft,
// Amazon, ...), mirrored on-chain on first trade; it never reaches Supabase or the public feed.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { forkApiServer } from "./api/server.ts";
import type { AppTake } from "./api/service.ts";
import { startForkService } from "./api.ts";
import { main, syncClock } from "./lib.ts";
import { TAKE_LIFETIME_SECS } from "@thesis/chain";

/**
 * A take made up for the run, with the legs of the seeded "AI power demand" take. It never reaches
 * Supabase, so the run's trades stay out of every public feed, count and board.
 */
const TAKE: AppTake = {
  id: randomUUID(),
  claim: "API e2e: AI power demand",
  risk: "medium",
  settles_at: new Date(Date.now() + TAKE_LIFETIME_SECS * 1000).toISOString(),
  author: { handle: "api-e2e" },
  legs: [
    { name: "NVIDIA", kind: "Stock", weight: 40, fade_how: "Bets the stock falls", asset_id: "jup:Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" },
    { name: "Microsoft", kind: "Stock", weight: 20, fade_how: "Bets the stock falls", asset_id: "jup:XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX" },
    { name: "Amazon", kind: "Stock", weight: 20, fade_how: "Bets the stock falls", asset_id: "jup:Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg" },
    { name: "Data-center spending", kind: "Prediction · Yes", weight: 20, fade_how: "Bets No", asset_id: null },
  ],
};

async function e2e(): Promise<void> {
  const lead = await syncClock();
  if (lead > 120) throw new Error(`The fork's clock is ${lead}s ahead of real time: restart the fork.`);
  const service = await startForkService((m) => console.log(`  [api] ${m}`), { takes: async (id) => (id === TAKE.id ? TAKE : null) });
  const server = forkApiServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json()) as any };
  };
  const checks: [string, boolean][] = [];
  try {
    const user = Keypair.generate();
    const me = user.publicKey.toBase58();
    console.log(`user ${me}`);

    const config = await call("GET", "/config");
    checks.push(["config: the program's fee (10 bps, 5 to the creator) and $10 minimum", config.status === 200 && config.json.feeRate === 0.001 && config.json.creatorFeeBps === 5 && config.json.minStakeUsd === 10]);
    checks.push(["config: takes run a year unless their author sells", config.json.takeLifetimeSecs === TAKE_LIFETIME_SECS]);

    const dep = await call("POST", `/wallets/${me}/deposits`, { usd: 200 });
    checks.push(["deposit: 200 USDC on the fork", dep.status === 200 && dep.json.usdc === 200]);

    const before = await call("GET", `/takes/${TAKE.id}?viewer=${me}`);
    console.log(`receipt before: onChain=${before.json.onChain} backers=${before.json.backers ?? 0}`);
    for (const l of before.json.legs) console.log(`  leg ${l.index} ${l.name}: ${l.tradable ? "tradable" : l.blocked}`);
    const backersBefore = before.json.backers ?? 1; // a fresh mirror starts with the author's buy-in

    const built = await call("POST", `/takes/${TAKE.id}/trades`, { owner: me, side: "back", usd: 25 });
    if (built.status !== 200) throw new Error(`build: ${built.status} ${JSON.stringify(built.json)}`);
    console.log(`built ${built.json.transactions.length} transaction(s), fee $${built.json.feeUsd}`);
    for (const s of built.json.steps) console.log(`  ${s.labels.join(" + ")}: ${s.bytes} bytes`);
    for (const x of built.json.excluded) console.log(`  left out ${x.name}: ${x.reason}`);
    checks.push(["build: some legs included, fee is the config's rate", built.json.included.length > 0 && built.json.feeUsd === 25 * config.json.feeRate]);

    // A transaction from another build is refused.
    const other = await call("POST", `/takes/${TAKE.id}/trades`, { owner: me, side: "back", usd: 10 });
    const swapped = await call("POST", "/submit", { buildId: built.json.buildId, transactions: [other.json.transactions[0], ...built.json.transactions.slice(1)] });
    checks.push(["submit: a changed transaction is refused", swapped.status === 400 && swapped.json.error === "transaction_changed"]);

    // What Privy's signTransaction does: add the wallet's signature, leave the rest.
    const signed = built.json.transactions.map((b64: string) => {
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      tx.sign([user]);
      return Buffer.from(tx.serialize()).toString("base64");
    });
    const sent = await call("POST", "/submit", { buildId: built.json.buildId, transactions: signed });
    if (sent.status !== 200) throw new Error(`submit: ${sent.status} ${JSON.stringify(sent.json)}`);
    console.log(`sent ${sent.json.signatures.join(", ")}`);
    const replay = await call("POST", "/submit", { buildId: built.json.buildId, transactions: signed });
    checks.push(["submit: a build can't be sent twice", replay.status === 410]);

    const after = await call("GET", `/takes/${TAKE.id}?viewer=${me}`);
    checks.push([`receipt: on-chain, backers ${backersBefore} -> ${after.json.backers}`, after.json.onChain && after.json.backers === backersBefore + 1]);
    const mine = after.json.viewerPositions;
    checks.push(["receipt: my $25 back is listed", mine.length === 1 && mine[0].side === "back" && mine[0].stakeUsd === 25]);

    const wallet = await call("GET", `/wallets/${me}`);
    console.log(`wallet: ${wallet.json.usdc} USDC, holdings ${wallet.json.holdings.map((h: any) => `${h.symbol ?? h.mint.slice(0, 6)} ${h.amount}`).join(", ")}`);
    checks.push(["wallet: USDC down by $25 + fee", Math.abs(wallet.json.usdc - (200 - 25.025)) < 1e-6]);
    checks.push(["wallet: holds the basket's tokens", wallet.json.holdings.length === built.json.included.length]);
    checks.push(["wallet: activity shows the back and the deposit", wallet.json.activity.some((a: any) => a.kind === "back" && a.takeId === TAKE.id) && wallet.json.activity.some((a: any) => a.kind === "deposit")]);

    // Phoenix lists NVIDIA, Microsoft and Amazon: a fade shorts them there (docs/phoenix-plan.md).
    const fade = await call("POST", `/takes/${TAKE.id}/trades`, { owner: me, side: "fade", usd: 10 });
    const shorts = (fade.json.steps ?? []).flatMap((s: any) => s.labels).filter((l: string) => /Phoenix .*short/.test(l));
    console.log(`fade: ${fade.status} ${fade.status === 200 ? shorts.join(", ") : JSON.stringify(fade.json)}`);
    checks.push(["fade: builds Phoenix shorts of the stock legs", fade.status === 200 && shorts.length > 0 && fade.json.included.length > 0]);

    const out = await call("POST", `/wallets/${me}/withdrawals`, { usd: 50 });
    checks.push(["withdrawal: refused (play money stays on the fork)", out.status === 403 && out.json.error === "withdrawals_off"]);
    const over = await call("POST", `/wallets/${me}/deposits`, { usd: 900 });
    checks.push(["deposit: refused past the $1,000 cap, with what's left", over.status === 403 && over.json.error === "deposit_cap" && /\$800\.00/.test(over.json.message)]);
  } finally {
    server.close();
  }
  console.log("");
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("fork API e2e failed");
}

if (import.meta.main) await main(e2e);
