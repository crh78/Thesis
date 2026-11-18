// pnpm fork:exit-e2e — selling a whole position on the fork, end to end over the fork API.
//
// A throwaway wallet adds cash and backs a take made up for the run (the legs of the low-risk
// "Mortgage rates dip under 6%" demo take, so a jlUSDC yield leg is in the sale too). Then it sells the position the
// way the app does: quote, sign, submit. It checks:
//   - the wallet got USDC back and holds none of the position's tokens;
//   - the program marked the position sold and created its exit account;
//   - the receipt shows it sold and the portfolio no longer lists it;
//   - a second sale is refused.
// Then an author posts a take of the same legs and a holder backs it. The author's sale closes the
// take: the quote says so, the receipt shows it closed, new backs and fades get 409 take_closed,
// and the holder can still sell.
// With `--settle` it then runs the real settler until the sales are priced and settled, before the
// take's horizon: the first position and its exit account close into a scored profile, and the
// author's take settles on the author's sale.
//
// Needs the asset bank and `JUPITER_API_KEY`, like fork:api-e2e.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { USDC_MINT_MAINNET, exitAddress, profileAddress, thesisProgram, TAKE_LIFETIME_SECS } from "@thesis/chain";
import { forkApiServer } from "./api/server.ts";
import type { AppTake } from "./api/service.ts";
import { startForkService } from "./api.ts";
import { REPO_ROOT, RPC_URL, connection, main, syncClock } from "./lib.ts";

/** One tick of the real settler against this fork. */
function settlerTick(): string {
  return execFileSync("pnpm", ["--silent", "--filter", "@thesis/executor", "settler", "--", "--once"], {
    cwd: REPO_ROOT,
    env: { ...process.env, SOLANA_RPC_URL: RPC_URL },
    encoding: "utf8",
  });
}

const args = process.argv.slice(2);
/**
 * A take made up for the run, with the seeded low-risk "Mortgage rates" take's legs (a jlUSDC yield
 * leg is in the sale too). It never reaches Supabase, so the run's trades stay out of every public
 * feed, count and board.
 */
const TAKE: AppTake = {
  id: randomUUID(),
  claim: "Exit e2e: mortgage rates dip under 6%",
  risk: "low",
  settles_at: new Date(Date.now() + TAKE_LIFETIME_SECS * 1000).toISOString(),
  author: { handle: "exit-e2e" },
  legs: [
    { name: "Rates under 6%: Yes", kind: "Prediction · Yes", weight: 50, fade_how: "Bets No", asset_id: null },
    { name: "S&P 500", kind: "Index fund", weight: 30, fade_how: null, asset_id: "jup:XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W" },
    { name: "Cash", kind: "Earns interest", weight: 20, fade_how: null, asset_id: "yield:9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D" },
  ],
};
/** The same legs, posted by a wallet the run holds (set below), so its author can sell. */
const AUTHORED: AppTake = { ...TAKE, id: randomUUID(), claim: "Exit e2e: the author sells", author: { handle: "exit-e2e-author" } };
const SETTLE = args.includes("--settle");

async function e2e(): Promise<void> {
  const lead = await syncClock();
  if (lead > 120) throw new Error(`The fork's clock is ${lead}s ahead of real time: restart the fork.`);
  const service = await startForkService((m) => console.log(`  [api] ${m}`), { takes: async (id) => [TAKE, AUTHORED].find((t) => t.id === id) ?? null });
  const server = forkApiServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json()) as any };
  };
  const user = Keypair.generate();
  const me = user.publicKey.toBase58();
  const sign = (transactions: string[], kp = user) =>
    transactions.map((b64) => {
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      tx.sign([kp]);
      return Buffer.from(tx.serialize()).toString("base64");
    });
  const submit = async (what: string, built: { status: number; json: any }, kp: Keypair) => {
    if (built.status !== 200) throw new Error(`${what}: ${built.status} ${JSON.stringify(built.json)}`);
    const sent = await call("POST", "/submit", { buildId: built.json.buildId, transactions: sign(built.json.transactions, kp) });
    if (sent.status !== 200) throw new Error(`${what} submit: ${sent.status} ${JSON.stringify(sent.json)}`);
  };
  const conn = connection();
  const thesis = thesisProgram(conn);
  const usdc = async () => {
    const ata = getAssociatedTokenAddressSync(USDC_MINT_MAINNET, user.publicKey, true);
    return Number((await conn.getTokenAccountBalance(ata, "confirmed")).value.amount) / 1e6;
  };
  const checks: [string, boolean][] = [];
  try {
    console.log(`user ${me}`);
    await call("POST", `/wallets/${me}/deposits`, { usd: 200 });

    const built = await call("POST", `/takes/${TAKE.id}/trades`, { owner: me, side: "back", usd: 40 });
    if (built.status !== 200) throw new Error(`back: ${built.status} ${JSON.stringify(built.json)}`);
    console.log(`  bought legs ${built.json.included.join(", ")}`);
    for (const x of built.json.excluded) console.log(`  left out ${x.name}: ${x.reason}`);
    const backed = await call("POST", "/submit", { buildId: built.json.buildId, transactions: sign(built.json.transactions) });
    if (backed.status !== 200) throw new Error(`back submit: ${backed.status} ${JSON.stringify(backed.json)}`);
    const afterBack = await usdc();
    console.log(`backed $40; wallet ${afterBack} USDC`);

    const receipt = await call("GET", `/takes/${TAKE.id}?viewer=${me}`);
    const mine = receipt.json.viewerPositions.find((p: any) => !p.exited);
    if (!mine) throw new Error("no position on the receipt");
    checks.push(["receipt: the new back can be sold", mine.canExit === true]);

    const quote = await call("POST", `/takes/${TAKE.id}/positions/${mine.address}/exit`, { owner: me });
    if (quote.status !== 200) throw new Error(`exit quote: ${quote.status} ${JSON.stringify(quote.json)}`);
    console.log(`sale quote: expect $${quote.json.expectedUsd.toFixed(2)}, at least $${quote.json.minimumUsd.toFixed(2)}`);
    for (const s of quote.json.steps) console.log(`  ${s.labels.join(" + ")}: ${s.bytes} bytes`);
    checks.push(["quote: one transaction", quote.json.transactions.length === 1]);
    checks.push(["quote: a backer's sale doesn't close the take", quote.json.closesTake === false]);
    // A second quote prepared before the first sale lands.
    const second = await call("POST", `/takes/${TAKE.id}/positions/${mine.address}/exit`, { owner: me });
    if (second.status !== 200) console.log(`second quote: ${second.status} ${JSON.stringify(second.json)}`);

    const sold = await call("POST", "/submit", { buildId: quote.json.buildId, transactions: sign(quote.json.transactions) });
    if (sold.status !== 200) throw new Error(`exit submit: ${sold.status} ${JSON.stringify(sold.json)}`);
    const afterSale = await usdc();
    const proceeds = afterSale - afterBack;
    console.log(`sold: +$${proceeds.toFixed(2)}; wallet ${afterSale} USDC`);
    checks.push(["sale: USDC back, at least the quoted minimum", proceeds >= quote.json.minimumUsd - 0.005]);

    const positionKey = new PublicKey(mine.address);
    const position = await thesis.account.position.fetch(positionKey, "confirmed");
    const exitAccount = await thesis.account.exit.fetchNullable(exitAddress(positionKey, thesis.programId), "confirmed");
    checks.push(["chain: the position is marked sold", position.exited === true]);
    checks.push(["chain: its exit account records the sale", exitAccount?.position.toBase58() === mine.address]);

    const after = await call("GET", `/takes/${TAKE.id}?viewer=${me}`);
    const shown = after.json.viewerPositions.find((p: any) => p.address === mine.address);
    checks.push(["receipt: shows it sold, not sellable", shown?.exited === true && shown?.canExit === false]);
    const portfolio = await call("GET", `/wallets/${me}/portfolio`);
    checks.push(["portfolio: no longer lists it", !portfolio.json.positions.some((p: any) => p.address === mine.address)]);

    if (second.status === 200) {
      const again = await call("POST", "/submit", { buildId: second.json.buildId, transactions: sign(second.json.transactions) });
      checks.push(["a second sale is refused", again.status === 409 && again.json.error === "already_exited"]);
    }
    const third = await call("POST", `/takes/${TAKE.id}/positions/${mine.address}/exit`, { owner: me });
    checks.push(["a new quote is refused", third.status === 409 && third.json.error === "already_exited"]);

    // The author's sale closes the take.
    const author = Keypair.generate();
    const holder = Keypair.generate();
    const [a, h] = [author.publicKey.toBase58(), holder.publicKey.toBase58()];
    AUTHORED.author_wallet = a;
    await call("POST", `/wallets/${a}/deposits`, { usd: 100 });
    await call("POST", `/wallets/${h}/deposits`, { usd: 100 });
    await submit("publish", await call("POST", `/takes/${AUTHORED.id}/publish`, { author: a, usd: 10 }), author);
    await submit("holder's back", await call("POST", `/takes/${AUTHORED.id}/trades`, { owner: h, side: "back", usd: 20 }), holder);
    const posted = await call("GET", `/takes/${AUTHORED.id}?viewer=${a}`);
    console.log(`authored take ${posted.json.address}: posted with $10, backed with $20`);
    checks.push(["receipt: open until the author sells", posted.json.status === "open" && posted.json.closedAt === null && posted.json.canBack === true]);
    const buyIn = posted.json.viewerPositions.find((p: any) => !p.exited);
    const authorQuote = await call("POST", `/takes/${AUTHORED.id}/positions/${buyIn?.address}/exit`, { owner: a });
    checks.push(["author's quote: selling closes the take", authorQuote.json.closesTake === true]);
    await submit("author's sale", authorQuote, author);
    const closedView = await call("GET", `/takes/${AUTHORED.id}?viewer=${h}`);
    const held = closedView.json.viewerPositions.find((p: any) => !p.exited);
    checks.push(["receipt: closed at the sale, no new backs or fades", closedView.json.status === "closed" && typeof closedView.json.closedAt === "number" && closedView.json.canBack === false && closedView.json.canFade === false]);
    checks.push(["receipt: the holder can still sell", held?.canExit === true]);
    const onChain = await thesis.account.take.fetch(new PublicKey(posted.json.address), "confirmed");
    checks.push(["chain: the take is closed", "closed" in onChain.status && onChain.closedAt.toNumber() === closedView.json.closedAt]);
    const lateBack = await call("POST", `/takes/${AUTHORED.id}/trades`, { owner: me, side: "back", usd: 20 });
    const lateFade = await call("POST", `/takes/${AUTHORED.id}/trades`, { owner: me, side: "fade", usd: 20 });
    checks.push(["a back after the author's sale: 409 take_closed", lateBack.status === 409 && lateBack.json.error === "take_closed"]);
    checks.push(["a fade after the author's sale: 409 take_closed", lateFade.status === 409 && lateFade.json.error === "take_closed"]);
    const holderQuote = await call("POST", `/takes/${AUTHORED.id}/positions/${held?.address}/exit`, { owner: h });
    checks.push(["holder's quote: doesn't close anything", holderQuote.json.closesTake === false]);
    await submit("holder's sale", holderQuote, holder);

    if (SETTLE) {
      // A tick prices the sale, the next settles it. Token prices need the trade's transactions
      // to be readable, which can take a tick or two.
      let closed = false;
      for (let i = 0; i < 6 && !closed; i++) {
        const out = settlerTick();
        for (const line of out.split("\n").filter((l) => l.includes(mine.address) || l.includes("FAILED"))) console.log(`  [settler] ${line}`);
        closed = !(await conn.getAccountInfo(positionKey, "confirmed"));
        if (!closed) await sleep(3_000);
      }
      checks.push(["settler: prices the sale and settles it before the horizon", closed]);
      if (closed) {
        const profile = await thesis.account.profile.fetch(profileAddress(user.publicKey, thesis.programId), "confirmed");
        console.log(`profile: settled ${profile.positionsSettled}, scored ${profile.scoredPositions}, pnl ${profile.scoredPnl.toString()}`);
        checks.push(["profile: the sale was scored", profile.positionsSettled === 1]);
        checks.push(["chain: the exit account closed too", !(await conn.getAccountInfo(exitAddress(positionKey, thesis.programId), "confirmed"))]);
      }
      // The authored take settles on its author's sale, long before its horizon; the holder's
      // sale settles on its own.
      const heldKey = new PublicKey(held.address);
      let done = false;
      for (let i = 0; i < 6 && !done; i++) {
        settlerTick();
        const t = await thesis.account.take.fetch(new PublicKey(posted.json.address), "confirmed");
        done = "settled" in t.status && !(await conn.getAccountInfo(heldKey, "confirmed"));
        if (!done) await sleep(3_000);
      }
      const final = await call("GET", `/takes/${AUTHORED.id}`);
      console.log(`authored take: ${final.json.status}, ${final.json.returnBps} bps, closed at ${final.json.closedAt}`);
      checks.push(["settler: the take settles on the author's sale, and the holder's sale settles", done]);
      checks.push(["receipt: settled, with its result and when it closed", final.json.status === "settled" && typeof final.json.returnBps === "number" && final.json.closedAt === closedView.json.closedAt]);
    }
  } finally {
    server.close();
  }
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("exit e2e failed");
}

main(e2e);
