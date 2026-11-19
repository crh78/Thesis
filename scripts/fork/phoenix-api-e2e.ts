// pnpm fork:phoenix-api-e2e — Phoenix legs end to end through the fork API and the Thesis program.
//
// A take made up for the run (NVIDIA, a spot leg Phoenix also lists, and a 5x Solana perp) goes
// on-chain as a demo mirror, its author's buy-in opening the perp. Then a throwaway wallet:
//   1. backs it: a Jupiter swap for NVIDIA, a 5x SOL long on Phoenix in its own child, proved
//      on-chain (the receipt names the child, whose position grew inside the trade);
//   2. fades it: a short of each leg on Phoenix (NVIDIA 1x, SOL at its 5x);
//   3. sells both: the sale closes the Phoenix positions and records the exit; then "Cash out"
//      sweeps each child's cash back to USDC until nothing is left;
//   4. with --settle, runs the real settler until both sales are priced on Phoenix's marks and
//      settled (no clock change: a sale settles as soon as its prices land), and checks the
//      wallet's profile scored them.
// Needs the program with Phoenix proof of trade on the fork (`fork:up` after it merges), the
// asset bank and JUPITER_API_KEY, like fork:api-e2e. Adds only throwaway wallets and one take.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { USDC_MINT_MAINNET, profileAddress, thesisProgram, TAKE_LIFETIME_SECS } from "@thesis/chain";
import { decodeTrader, positionSize } from "@thesis/venues/phoenix";
import type { AppTake } from "./api/common.ts";
import { forkApiServer } from "./api/server.ts";
import { startForkService } from "./api.ts";
import { REPO_ROOT, RPC_URL, connection, main, syncClock } from "./lib.ts";

const SETTLE = process.argv.includes("--settle");

/** One tick of the real settler against this fork. */
function settlerTick(): string {
  return execFileSync("pnpm", ["--silent", "--filter", "@thesis/executor", "settler", "--", "--once"], {
    cwd: REPO_ROOT,
    env: { ...process.env, SOLANA_RPC_URL: RPC_URL },
    encoding: "utf8",
  });
}

async function e2e(): Promise<void> {
  const lead = await syncClock();
  if (lead > 120) throw new Error(`The fork's clock is ${lead}s ahead of real time: restart the fork.`);
  const take: AppTake = {
    id: randomUUID(),
    claim: "Phoenix e2e: AI compute keeps compounding",
    risk: "high",
    settles_at: new Date(Date.now() + TAKE_LIFETIME_SECS * 1000).toISOString(),
    author: { handle: "phoenix-e2e" },
    legs: [
      { name: "NVIDIA", kind: "Stock", weight: 50, fade_how: "Bets the stock falls" },
      { name: "Solana perp", kind: "Stock · 5x", weight: 50, fade_how: "Bets the stock falls", asset_id: "phoenix:SOL" },
    ],
  };
  const service = await startForkService((m) => console.log(`  [api] ${m}`), { takes: async (id) => (id === take.id ? take : null) });
  const server = forkApiServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json()) as any };
  };
  const conn = connection();
  const thesis = thesisProgram(conn);
  const user = Keypair.generate();
  const me = user.publicKey.toBase58();
  const usdc = async () => Number((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(USDC_MINT_MAINNET, user.publicKey, true), "confirmed")).value.amount) / 1e6;
  const send = async (label: string, built: { status: number; json: any }) => {
    if (built.status !== 200) throw new Error(`${label}: ${built.status} ${JSON.stringify(built.json)}`);
    for (const s of built.json.steps ?? []) console.log(`  ${s.labels.join(" + ")}: ${s.bytes} B`);
    const signed = built.json.transactions.map((b64: string) => {
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      tx.sign([user]);
      return Buffer.from(tx.serialize()).toString("base64");
    });
    const r = await call("POST", "/submit", { buildId: built.json.buildId, transactions: signed });
    if (r.status !== 200) throw new Error(`${label} submit: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json.signatures as string[];
  };
  /** Each child the receipt's proof named for this position, and what it holds now. */
  const children = async (position: string) => {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(position), { limit: 20 }, "confirmed");
    const out: { account: string; size: bigint; long: boolean }[] = [];
    for (const s of sigs) {
      const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const keys = tx ? tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }).keySegments().flat() : [];
      for (const k of keys) {
        const info = await conn.getAccountInfo(k, "confirmed");
        const t = info && decodeTrader(info.data);
        if (t && t.authority.equals(user.publicKey) && t.subaccountIndex > 0 && !out.some((o) => o.account === k.toBase58())) {
          out.push({ account: k.toBase58(), size: positionSize(t), long: (t.positions[0]?.baseLots ?? 0n) > 0n });
        }
      }
    }
    return out;
  };
  const checks: [string, boolean][] = [];
  try {
    console.log(`user ${me}`);
    await call("POST", `/wallets/${me}/deposits`, { usd: 200 });
    const start = await usdc();

    const receipt0 = await call("GET", `/takes/${take.id}?viewer=${me}`);
    const perpLeg = receipt0.json.legs[1];
    checks.push(["receipt: the perp leg is on Phoenix SOL at 5x (the most it can take)", perpLeg?.perp?.symbol === "SOL" && perpLeg?.perp?.leverage === 5]);
    checks.push(["receipt: both legs can be faded (Phoenix shorts)", receipt0.json.canFade === true && receipt0.json.legs.every((l: any) => l.fadeBlocked === null)]);

    console.log("\n1. Back $30");
    const back = await call("POST", `/takes/${take.id}/trades`, { owner: me, side: "back", usd: 30 });
    for (const x of back.json.excluded ?? []) console.log(`  left out ${x.name}: ${x.reason}`);
    await send("back", back);
    let r1 = await call("GET", `/takes/${take.id}?viewer=${me}`);
    // A value needs live prices (Jupiter, Phoenix): read once more if one was missing.
    if (typeof r1.json.viewerPositions.find((p: any) => p.side === "back" && !p.exited)?.valueUsd !== "number") {
      await sleep(5_000);
      r1 = await call("GET", `/takes/${take.id}?viewer=${me}`);
    }
    const backPos = r1.json.viewerPositions.find((p: any) => p.side === "back" && !p.exited);
    console.log(`  back's value now: ${typeof backPos.valueUsd === "number" ? `$${backPos.valueUsd.toFixed(2)}` : "unknown"}`);
    checks.push(["back: included both legs", JSON.stringify(back.json.included) === "[0,1]"]);
    // The author's buy-in counts as the first backer.
    checks.push(["back: on-chain, the author's buy-in and the back", r1.json.backers === 2 && r1.json.onChain === true]);
    const backKids = await children(backPos.address);
    checks.push(["back: a long in its own Phoenix child", backKids.length === 1 && backKids[0].long && backKids[0].size > 0n]);
    checks.push(["back: valued (tokens + Phoenix)", typeof backPos.valueUsd === "number" && backPos.valueUsd > 25]);
    // Liquidation warnings: a 5x long sits about 18% above its liquidation price,
    // inside the 25% "near" band, so the receipt flags it and the watcher alerts once.
    const risk = (backPos.phoenix ?? [])[0];
    console.log(`  SOL 5x long: entry $${risk?.entryUsd?.toFixed(2)}, mark $${risk?.markUsd?.toFixed(2)}, liquidates at $${risk?.liquidationUsd?.toFixed(2)} (${Math.round((risk?.distance ?? NaN) * 100)}% away, ${risk?.level})`);
    checks.push(["receipt: the 5x leg's liquidation price, below the entry", risk?.symbol === "SOL" && risk.liquidationUsd > 0 && risk.liquidationUsd < risk.entryUsd]);
    checks.push(["receipt: a 5x leg reads as near liquidation (within 25%)", risk?.level === "near" || risk?.level === "close"]);
    const alerts = await service.liquidationAlerts();
    const mine = alerts.filter((a) => a.wallet === me);
    console.log(`  alert: ${mine[0]?.title} / ${mine[0]?.body}`);
    checks.push(["watcher: one alert for the 5x leg, keyed by position, leg and level", mine.length === 1 && mine[0].key === `${backPos.address}:1:${risk?.level}`]);

    console.log("\n2. Fade $20");
    const fade = await call("POST", `/takes/${take.id}/trades`, { owner: me, side: "fade", usd: 20 });
    for (const x of fade.json.excluded ?? []) console.log(`  left out ${x.name}: ${x.reason}`);
    await send("fade", fade);
    const r2 = await call("GET", `/takes/${take.id}?viewer=${me}`);
    const fadePos = r2.json.viewerPositions.find((p: any) => p.side === "fade" && !p.exited);
    const fadeKids = await children(fadePos.address);
    checks.push(["fade: recorded on-chain", r2.json.faders === 1]);
    checks.push(["fade: a short of each leg, each in its own child", fadeKids.length === 2 && fadeKids.every((k) => !k.long && k.size > 0n)]);
    checks.push(["fade: children apart from the back's", !fadeKids.some((k) => k.account === backKids[0].account)]);

    console.log("\n2b. Sell 40% of the back");
    const partQuote = await call("POST", `/takes/${take.id}/positions/${backPos.address}/exit`, { owner: me, bps: 4_000 });
    console.log(`  part: expect $${partQuote.json.expectedUsd?.toFixed(2)}, at least $${partQuote.json.minimumUsd?.toFixed(2)}`);
    await send("sell 40% of the back", partQuote);
    checks.push(["partial sale: $12 of $30, no cash-out (the freed margin stays with the rest)", partQuote.json.full === false && partQuote.json.sale?.stakeUsd === 12 && partQuote.json.phoenixCashOut === false]);
    const partKids = await children(backPos.address);
    const kept = Number(partKids[0]?.size ?? 0n) / Number(backKids[0].size);
    console.log(`  the long kept ${(kept * 100).toFixed(1)}% of its lots`);
    checks.push(["partial sale: the long is cut to about 60% of its lots, still open", partKids.length === 1 && partKids[0].long && kept > 0.55 && kept < 0.65]);
    const partChain = await thesis.account.position.fetch(new PublicKey(backPos.address), "confirmed");
    checks.push(["partial sale: $18 left on-chain, not sold", partChain.remaining.toNumber() === 18_000_000 && !partChain.exited]);

    console.log("\n3. Sell both, then cash out");
    for (const pos of [backPos, fadePos]) {
      const quote = await call("POST", `/takes/${take.id}/positions/${pos.address}/exit`, { owner: me });
      console.log(`  ${pos.side}: expect $${quote.json.expectedUsd?.toFixed(2)}, at least $${quote.json.minimumUsd?.toFixed(2)}`);
      await send(`sell ${pos.side}`, quote);
      checks.push([`sale (${pos.side}): asks for a Phoenix cash-out`, quote.json.phoenixCashOut === true]);
      const p = await thesis.account.position.fetch(new PublicKey(pos.address), "confirmed");
      checks.push([`sale (${pos.side}): the position is marked sold`, p.exited === true]);
    }
    const before = await call("GET", `/wallets/${me}/phoenix`);
    console.log(`  Phoenix cash before the sweep: $${before.json.cashUsd}, ${before.json.openPositions} open`);
    checks.push(["sales closed every Phoenix position", before.json.openPositions === 0 && before.json.cashUsd > 0]);
    for (let i = 0; i < 3; i++) {
      const out = await call("POST", `/wallets/${me}/phoenix/cash-out`);
      if (out.json.done) break;
      await send("cash out", out);
    }
    const after = await call("GET", `/wallets/${me}/phoenix`);
    checks.push(["cash-out: nothing left on Phoenix", after.json.cashUsd === 0 && after.json.openPositions === 0]);
    const end = await usdc();
    console.log(`\nUSDC ${start} → ${end} (fees, spread and price moves on $50 of stake)`);
    checks.push(["most of the money came back (over 95%)", end > start - 50 * 0.05]);

    if (SETTLE) {
      console.log("\n4. Settle");
      const keys = [backPos.address, fadePos.address].map((a: string) => new PublicKey(a));
      let open = keys.length;
      // Phoenix's one-minute bars land a minute or so after a moment; ticks retry until then.
      for (let i = 0; i < 12 && open > 0; i++) {
        const out = settlerTick();
        for (const line of out.split("\n").filter((l) => keys.some((k) => l.includes(k.toBase58())) || l.includes("FAILED"))) console.log(`  [settler] ${line.slice(0, 220)}`);
        open = (await Promise.all(keys.map((k) => conn.getAccountInfo(k, "confirmed")))).filter(Boolean).length;
        if (open) await sleep(15_000);
      }
      checks.push(["settler: both sales priced on Phoenix and settled", open === 0]);
      const profile = await thesis.account.profile.fetchNullable(profileAddress(user.publicKey, thesis.programId), "confirmed");
      console.log(`  profile: settled ${profile?.positionsSettled}, scored ${profile?.scoredPositions}, pnl ${profile?.scoredPnl.toString()}`);
      checks.push(["profile: both positions scored", profile?.positionsSettled === 2 && profile?.scoredPositions === 2]);
    }
  } finally {
    server.close();
  }
  console.log("");
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("fork:phoenix-api-e2e failed");
}

if (import.meta.main) await main(e2e);
