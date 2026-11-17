// pnpm fork:gemini-e2e — Gemini prediction legs, paper-filled, end to end on the fork.
//
// Takes a live Gemini contract from the asset bank and makes up a take for the run (not written
// to Supabase): 60% NVIDIA, 40% Yes on that contract. Then, through the fork API and the real
// settler:
//   - a $40 back swaps $24 into NVIDIA and escrows the $16 prediction share;
//   - a $20 fade takes only the prediction leg (No), escrows all of it, and swaps nothing;
//   - the settler prices the prediction legs from Gemini (through the proxy);
//   - both positions are sold and settle: each gets its escrow back in full.
//
// Needs the asset bank with Gemini contracts (asset-bank --tiers=discovery,prices,gemini),
// GEMINI_PROXY_TOKEN and JUPITER_API_KEY.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { USDC_MINT_MAINNET, escrowVaultAddress, profileAddress, thesisProgram } from "@thesis/chain";
import { loadBankState } from "@thesis/venues/bank";
import { ineligible, type GeminiContract } from "@thesis/venues/gemini";
import { forkApiServer } from "./api/server.ts";
import type { AppTake } from "./api/service.ts";
import { startForkService } from "./api.ts";
import { REPO_ROOT, RPC_URL, connection, main, syncClock } from "./lib.ts";

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

  // A contract with a real two-sided market on both sides, priced away from the edges.
  const bank = await loadBankState();
  const now = Date.now();
  const pick = Object.values(bank.venues.gemini?.contracts ?? {}).find(
    (c: GeminiContract) =>
      !ineligible(c, "yes", now) && !ineligible(c, "no", now) && c.ask.yes! >= 0.15 && c.ask.yes! <= 0.85 &&
      Date.parse(c.expiry!) > now + 2 * 86_400_000,
  );
  if (!pick) throw new Error("No eligible Gemini contract in the asset bank: run asset-bank --once --tiers=gemini");
  console.log(`contract ${pick.instrumentSymbol} "${pick.eventTitle} · ${pick.label}" yes ask ${pick.ask.yes} bid ${pick.bid.yes}, no ask ${pick.ask.no} bid ${pick.bid.no}`);

  const take: AppTake = {
    id: randomUUID(),
    claim: `Gemini e2e: ${pick.eventTitle}`,
    risk: "medium",
    settles_at: new Date(now + 30 * 86_400_000).toISOString(),
    author: { handle: "gemini-e2e" },
    legs: [
      { name: "NVIDIA", kind: "Stock", weight: 60, fade_how: null },
      { name: pick.label, kind: "Prediction · Yes", weight: 40, fade_how: "No", asset_id: `gemini:${pick.instrumentSymbol}` },
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
  const usdc = async (owner: PublicKey) =>
    Number((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(USDC_MINT_MAINNET, owner, true), "confirmed")).value.amount) / 1e6;
  const vault = async () => Number((await conn.getTokenAccountBalance(escrowVaultAddress(thesis.programId), "confirmed")).value.amount) / 1e6;
  // Earlier runs (and app trades) on the same fork leave their own escrow: count this run's only.
  const vaultAtStart = await vault();
  const send = async (user: Keypair, built: { buildId: string; transactions: string[] }) => {
    const signed = built.transactions.map((b64) => {
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      tx.sign([user]);
      return Buffer.from(tx.serialize()).toString("base64");
    });
    const r = await call("POST", "/submit", { buildId: built.buildId, transactions: signed });
    if (r.status !== 200) throw new Error(`submit: ${r.status} ${JSON.stringify(r.json)}`);
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  const checks: [string, boolean][] = [];

  try {
    const backer = Keypair.generate();
    const fader = Keypair.generate();
    await call("POST", `/wallets/${backer.publicKey.toBase58()}/deposits`, { usd: 200 });
    await call("POST", `/wallets/${fader.publicKey.toBase58()}/deposits`, { usd: 100 });

    // A back: NVIDIA swapped, the prediction share escrowed. The first trade mirrors the take
    // (its demo author's $10 buy-in escrows $4 too).
    const backBuilt = await call("POST", `/takes/${take.id}/trades`, { owner: backer.publicKey.toBase58(), side: "back", usd: 40 });
    if (backBuilt.status !== 200) throw new Error(`back: ${backBuilt.status} ${JSON.stringify(backBuilt.json)}`);
    for (const s of backBuilt.json.steps) console.log(`  back: ${s.labels.join(" + ")}: ${s.bytes} bytes`);
    checks.push(["back: both legs included, $16 to escrow", backBuilt.json.included.length === 2 && near(backBuilt.json.escrowUsd, 16)]);
    const vaultBefore = await vault();
    const backerBefore = await usdc(backer.publicKey);
    await send(backer, backBuilt.json);
    checks.push(["back: the escrow vault got $16", near((await vault()) - vaultBefore, 16)]);
    checks.push(["back: the wallet paid the $40 stake plus the 0.10% fee", near(backerBefore - (await usdc(backer.publicKey)), 40.04)]);

    const receipt = await call("GET", `/takes/${take.id}?viewer=${backer.publicKey.toBase58()}`);
    const leg = receipt.json.legs?.[1];
    checks.push(["receipt: the prediction leg is tradable, with its side and market", leg?.tradable === true && leg?.prediction?.side === "yes" && leg?.prediction?.instrument === pick.instrumentSymbol]);
    checks.push(["receipt: fades are open", receipt.json.canFade === true]);
    const backPos = receipt.json.viewerPositions.find((p: any) => !p.exited);
    checks.push(["receipt: the back shows $16 escrowed", near(backPos?.escrowedUsd, 16)]);

    // A fade: only the prediction leg (No); nothing to swap, the whole stake escrowed.
    const fadeBuilt = await call("POST", `/takes/${take.id}/trades`, { owner: fader.publicKey.toBase58(), side: "fade", usd: 20 });
    if (fadeBuilt.status !== 200) throw new Error(`fade: ${fadeBuilt.status} ${JSON.stringify(fadeBuilt.json)}`);
    for (const x of fadeBuilt.json.excluded) console.log(`  fade left out ${x.name}: ${x.reason}`);
    checks.push(["fade: only the prediction leg, all $20 escrowed", fadeBuilt.json.included.join() === "1" && near(fadeBuilt.json.escrowUsd, 20)]);
    const faderBefore = await usdc(fader.publicKey);
    await send(fader, fadeBuilt.json);
    checks.push(["fade: the wallet paid $20 plus the fee, nothing swapped", near(faderBefore - (await usdc(fader.publicKey)), 20.02)]);
    const fadeReceipt = await call("GET", `/takes/${take.id}?viewer=${fader.publicKey.toBase58()}`);
    const fadePos = fadeReceipt.json.viewerPositions.find((p: any) => p.side === "fade");

    // The settler prices both positions' prediction legs from Gemini.
    const entryBit = 1 << 1;
    let priced = false;
    for (let i = 0; i < 6 && !priced; i++) {
      for (const line of settlerTick().split("\n").filter((l) => /FAILED|record_entry/.test(l))) console.log(`  [settler] ${line.slice(0, 160)}`);
      const [b, f] = await Promise.all([thesis.account.position.fetch(backPos.address, "confirmed"), thesis.account.position.fetch(fadePos.address, "confirmed")]);
      priced = Boolean(b.entrySet & entryBit) && Boolean(f.entrySet & entryBit);
      if (!priced) await sleep(3_000);
    }
    checks.push(["settler: entry prices for both positions' prediction legs", priced]);
    if (priced) {
      const [b, f] = await Promise.all([thesis.account.position.fetch(backPos.address, "confirmed"), thesis.account.position.fetch(fadePos.address, "confirmed")]);
      const bEntry = b.prices[1].entry.toNumber() / 1e8;
      const fEntry = f.prices[1].entry.toNumber() / 1e8;
      console.log(`  entries: back Yes at ${bEntry}, fade recorded at ${fEntry} (No at ${(1 - fEntry).toFixed(4)})`);
      checks.push(["prices: the back entered at the Yes ask, the fade at 1 − the No ask (±0.05, prices move)", Math.abs(bEntry - pick.ask.yes!) < 0.05 && Math.abs(fEntry - (1 - pick.ask.no!)) < 0.05]);
    }

    // Both sell: each sale pays the escrow back in full, then settles.
    for (const [who, user, pos, escrow] of [["back", backer, backPos, 16], ["fade", fader, fadePos, 20]] as const) {
      const quote = await call("POST", `/takes/${take.id}/positions/${pos.address}/exit`, { owner: user.publicKey.toBase58() });
      if (quote.status !== 200) throw new Error(`${who} sale: ${quote.status} ${JSON.stringify(quote.json)}`);
      checks.push([`${who} sale: the quote counts the $${escrow} escrow`, near(quote.json.escrowUsd, escrow)]);
      const before = await usdc(user.publicKey);
      const vaultBeforeSale = await vault();
      await send(user, quote.json);
      const afterSale = await usdc(user.publicKey);
      checks.push([`${who} sale: the sale itself paid back exactly the $${escrow} escrow`, near(vaultBeforeSale - (await vault()), escrow)]);
      let closed = false;
      for (let i = 0; i < 6 && !closed; i++) {
        settlerTick();
        closed = !(await conn.getAccountInfo(new PublicKey(pos.address), "confirmed"));
        if (!closed) await sleep(3_000);
      }
      checks.push([`${who} sale: priced and settled before the horizon`, closed]);
      const settled = await usdc(user.publicKey);
      console.log(`  ${who}: sale credited $${(afterSale - before).toFixed(2)}, settlement returned $${(settled - afterSale).toFixed(2)}`);
      checks.push([`${who} sale: settlement had nothing more to return`, near(settled - afterSale, 0)]);
      const profile = await thesis.account.profile.fetch(profileAddress(user.publicKey, thesis.programId), "confirmed");
      console.log(`  ${who} profile: settled ${profile.positionsSettled}, scored ${profile.scoredPositions}, pnl $${(profile.scoredPnl.toNumber() / 1e6).toFixed(2)}`);
      checks.push([`${who} sale: scored on its paper result`, profile.positionsSettled === 1 && profile.scoredPositions === 1]);
    }
    checks.push(["escrow vault: only this run's author's $4 is left", near((await vault()) - vaultAtStart, 4)]);
  } finally {
    server.close();
  }
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("gemini e2e failed");
}

main(e2e);
