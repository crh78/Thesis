// pnpm fork:phoenix-makers-e2e — many Phoenix trades in a thin market, as a dogfooder makes them.
//
// A take made up for the run (NVIDIA, Broadcom and a 2x CoreWeave perp: one maker holds CoreWeave's
// whole short side) goes on-chain as a demo mirror. Then one throwaway wallet backs it RUNS times
// in a row, a few seconds apart, sells the whole holding (the profile's sell-all), and cashes out.
// Before the maker sync (lib.ts syncPhoenixMakers), the fork's copy of that maker drifted with
// every fill and Phoenix panicked from about the third back on, on every order and close in the
// market. Every back must land in full, and the sale too.
//
// Never moves the fork's clock. Adds one throwaway wallet and one take; costs a few Jupiter calls
// per back (NVIDIA and Broadcom). `--runs N` (default 10), `--usd N` (default 12).
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { TAKE_LIFETIME_SECS } from "@thesis/chain";
import type { AppTake } from "./api/common.ts";
import { forkApiServer } from "./api/server.ts";
import { startForkService } from "./api.ts";
import { main, numberFlag, parseArgs, syncClock } from "./lib.ts";

async function e2e(): Promise<void> {
  const { flags } = parseArgs();
  const runs = numberFlag(flags, "runs", 10);
  const usd = numberFlag(flags, "usd", 12);
  const lead = await syncClock();
  if (lead > 120) throw new Error(`The fork's clock is ${lead}s ahead of real time: restart the fork.`);
  const take: AppTake = {
    id: randomUUID(),
    claim: "Phoenix makers e2e: AI compute keeps compounding",
    risk: "high",
    settles_at: new Date(Date.now() + TAKE_LIFETIME_SECS * 1000).toISOString(),
    author: { handle: "phoenix-makers-e2e" },
    legs: [
      { name: "NVIDIA", kind: "Stock", weight: 40, fade_how: "Bets the stock falls" },
      { name: "Broadcom", kind: "Stock", weight: 30, fade_how: "Bets the stock falls" },
      { name: "CoreWeave perp", kind: "Stock · 2x", weight: 30, fade_how: "Bets the stock falls", asset_id: "phoenix:CRWV" },
    ],
  };
  const synced: string[] = [];
  const service = await startForkService((m) => {
    if (m.startsWith("Phoenix makers")) synced.push(m);
    console.log(`  [api] ${m}`);
  }, { takes: async (id) => (id === take.id ? take : null) });
  const server = forkApiServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json()) as any };
  };
  const user = Keypair.generate();
  const me = user.publicKey.toBase58();
  /** Builds, signs and sends; the API's answer (200 once every transaction landed). */
  const trade = async (label: string, built: { status: number; json: any }) => {
    if (built.status !== 200) return { ok: false, why: `build ${built.status} ${JSON.stringify(built.json).slice(0, 300)}` };
    const transactions = built.json.transactions.map((b64: string) => {
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      tx.sign([user]);
      return Buffer.from(tx.serialize()).toString("base64");
    });
    const r = await call("POST", "/submit", { buildId: built.json.buildId, transactions });
    const ok = r.status === 200;
    console.log(`  ${label}: ${ok ? "landed" : `${r.status} ${r.json.error}: ${String(r.json.message).slice(0, 200)}`}`);
    return { ok, why: ok ? "" : `${r.json.error}: ${r.json.message}` };
  };
  const checks: [string, boolean][] = [];
  try {
    console.log(`user ${me}`);
    await call("POST", `/wallets/${me}/deposits`, { usd: Math.min(1_000, runs * usd + 50) });
    const receipt = await call("GET", `/takes/${take.id}?viewer=${me}`);
    const perp = receipt.json.legs?.[2]?.perp;
    checks.push(["receipt: the perp leg is on Phoenix CRWV", perp?.symbol === "CRWV"]);

    console.log(`\n1. Back $${usd}, ${runs} times`);
    let landed = 0;
    for (let i = 1; i <= runs; i++) {
      const r = await trade(`back ${i}`, await call("POST", `/takes/${take.id}/trades`, { owner: me, side: "back", usd }));
      if (r.ok) landed++;
      await sleep(2_000);
    }
    checks.push([`every back landed in full (${landed} of ${runs})`, landed === runs]);
    const held = await call("GET", `/takes/${take.id}?viewer=${me}`);
    const open = (held.json.viewerPositions ?? []).filter((p: any) => p.side === "back" && !p.exited);
    checks.push([`receipt: ${runs} open backs`, open.length === runs]);

    console.log("\n2. Sell all of it (the profile's sell-all), then cash out");
    const sale = await trade("sell all", await call("POST", `/takes/${take.id}/sell`, { owner: me, side: "back" }));
    checks.push(["the sale of the whole holding landed", sale.ok]);
    for (let i = 0; i < 6; i++) {
      const out = await call("POST", `/wallets/${me}/phoenix/cash-out`);
      if (out.json.done || !out.json.transactions?.length) break;
      await trade("cash-out", out);
    }
    const after = await call("GET", `/wallets/${me}/phoenix`);
    checks.push(["cash-out: nothing left on Phoenix", after.json.cashUsd === 0 && after.json.openPositions === 0]);
    checks.push(["the maker sync ran before the Phoenix sends", synced.length > 0 || landed === runs]);
  } finally {
    server.close();
    service.flush();
  }
  console.log("");
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("fork:phoenix-makers-e2e failed");
}

if (import.meta.main) await main(e2e);
