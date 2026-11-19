// pnpm fork:exit-e2e — selling a position on the fork, in part and then whole, end to end over the
// fork API.
//
// A throwaway wallet adds cash and backs a take made up for the run (the legs of the low-risk
// "Mortgage rates dip under 6%" demo take, so a jlUSDC yield leg is in the sale too). It sells a
// quarter first ($10 of $40: `sell_part`), after a partial sale too large to keep the $10 minimum is
// refused with how much can be sold. Then it sells the rest the way the app does: quote, sign,
// submit. It checks:
//   - the partial sale: USDC back, the program's remaining stake and partial sale account, and the
//     receipt's remaining, sold and settling amounts;
//   - the wallet got USDC back and holds none of the position's tokens;
//   - the program marked the position sold and created its exit account;
//   - the receipt shows it sold and the portfolio no longer lists it;
//   - a second sale is refused.
// Then an author posts a take of the same legs and a holder backs it. The author's sale closes the
// take: the quote says so, the receipt shows it closed, new backs and fades get 409 take_closed,
// and the holder can still sell (through the holding route, `/takes/:id/sell`).
// Then a wallet backs a four-stock take twice and sells its holding of the two positions through
// the holding route: half (the smaller position whole and part of the bigger one), then the rest.
// Each token is swapped once per sale however many positions sell it, the records ride last (in
// the last transaction when the sale needs several), and the second sale reuses the sell routes
// the first one kept: at most one Jupiter call.
// With `--settle` it then runs the real settler until the sales are priced and settled, before the
// take's horizon: the partial sale settles first, then the first position and its exit account
// close into a scored profile, and the
// author's take settles on the author's sale.
//
// Needs the asset bank and `JUPITER_API_KEY`, like fork:api-e2e.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { USDC_MINT_MAINNET, exitAddress, partSaleAddress, profileAddress, thesisProgram, TAKE_LIFETIME_SECS } from "@thesis/chain";
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
/** Four stocks, a quarter each: a holding of two backs of it sells eight token amounts as four swaps. */
const FOUR: AppTake = {
  ...TAKE,
  id: randomUUID(),
  claim: "Exit e2e: four stocks",
  risk: "medium",
  author: { handle: "exit-e2e-four" },
  legs: [
    { name: "NVIDIA", kind: "Stock", weight: 25, fade_how: "Bets the stock falls", asset_id: "jup:Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" },
    { name: "Microsoft", kind: "Stock", weight: 25, fade_how: "Bets the stock falls", asset_id: "jup:XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX" },
    { name: "Amazon", kind: "Stock", weight: 25, fade_how: "Bets the stock falls", asset_id: "jup:Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg" },
    { name: "S&P 500", kind: "Index fund", weight: 25, fade_how: null, asset_id: "jup:XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W" },
  ],
};
/** The Jupiter calls a build's Server-Timing reports (its `jupiter` note), or null without one. */
const jupiterCalls = (timing: string | null) => {
  const m = timing?.match(/jupiter;desc="lane [0-9]+, ([0-9]+) calls/);
  return m ? Number(m[1]) : null;
};
/** The same legs, posted by a wallet the run holds (set below), so its author can sell. */
const AUTHORED: AppTake = { ...TAKE, id: randomUUID(), claim: "Exit e2e: the author sells", author: { handle: "exit-e2e-author" } };
const SETTLE = args.includes("--settle");

async function e2e(): Promise<void> {
  const lead = await syncClock();
  if (lead > 120) throw new Error(`The fork's clock is ${lead}s ahead of real time: restart the fork.`);
  const service = await startForkService((m) => console.log(`  [api] ${m}`), { takes: async (id) => [TAKE, AUTHORED, FOUR].find((t) => t.id === id) ?? null });
  const server = forkApiServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json()) as any, timing: r.headers.get("server-timing") };
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
  const usdc = async (owner = user.publicKey) => {
    const ata = getAssociatedTokenAddressSync(USDC_MINT_MAINNET, owner, true);
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
    checks.push(["receipt: $40 left, up to 75% sellable in part", mine.remainingStakeUsd === 40 && mine.minStakeUsd === 10 && mine.maxPartialBps === 7_500]);

    // Part of it: too much first (it would leave less than $10), then a quarter.
    const tooMuch = await call("POST", `/takes/${TAKE.id}/positions/${mine.address}/exit`, { owner: me, bps: 8_000 });
    checks.push(["a partial sale leaving under $10: 422 with how much can be sold", tooMuch.status === 422 && tooMuch.json.error === "remainder_below_minimum" && tooMuch.json.maxPartialBps === 7_500 && tooMuch.json.minStakeUsd === 10]);
    const partQuote = await call("POST", `/takes/${TAKE.id}/positions/${mine.address}/exit`, { owner: me, bps: 2_500 });
    if (partQuote.status !== 200) throw new Error(`partial quote: ${partQuote.status} ${JSON.stringify(partQuote.json)}`);
    console.log(`partial sale quote: expect $${partQuote.json.expectedUsd.toFixed(2)}, at least $${partQuote.json.minimumUsd.toFixed(2)}`);
    checks.push(["partial quote: a quarter, $10 of $40, in one transaction", partQuote.json.bps === 2_500 && partQuote.json.full === false && partQuote.json.sale.stakeUsd === 10 && partQuote.json.sale.remainingStakeUsd === 30 && partQuote.json.transactions.length === 1]);
    const partSold = await call("POST", "/submit", { buildId: partQuote.json.buildId, transactions: sign(partQuote.json.transactions) });
    if (partSold.status !== 200) throw new Error(`partial submit: ${partSold.status} ${JSON.stringify(partSold.json)}`);
    const afterPart = await usdc();
    console.log(`sold a quarter: +$${(afterPart - afterBack).toFixed(2)}; wallet ${afterPart} USDC`);
    checks.push(["partial sale: USDC back, at least the quoted minimum", afterPart - afterBack >= partQuote.json.minimumUsd - 0.005]);
    const partKey = new PublicKey(mine.address);
    const halfway = await thesis.account.position.fetch(partKey, "confirmed");
    const part = await thesis.account.partSale.fetchNullable(partSaleAddress(partKey, 0, thesis.programId), "confirmed");
    checks.push(["chain: $30 left, one partial sale, not sold", halfway.remaining.toNumber() === 30_000_000 && halfway.parts === 1 && !halfway.exited]);
    checks.push(["chain: the partial sale account records $10 at 2,500 bps", part?.stake.toNumber() === 10_000_000 && part?.bps === 2_500]);
    const partView = (await call("GET", `/takes/${TAKE.id}?viewer=${me}`)).json.viewerPositions.find((p: any) => p.address === mine.address);
    checks.push(["receipt: $30 left, $10 sold, the part settling, the stake as first paid", partView?.remainingStakeUsd === 30 && partView?.soldStakeUsd === 10 && partView?.pendingSales?.length === 1 && partView?.stakeUsd === 40]);

    const quote = await call("POST", `/takes/${TAKE.id}/positions/${mine.address}/exit`, { owner: me });
    if (quote.status !== 200) throw new Error(`exit quote: ${quote.status} ${JSON.stringify(quote.json)}`);
    console.log(`sale quote: expect $${quote.json.expectedUsd.toFixed(2)}, at least $${quote.json.minimumUsd.toFixed(2)}`);
    for (const s of quote.json.steps) console.log(`  ${s.labels.join(" + ")}: ${s.bytes} bytes`);
    checks.push(["quote: the rest, $30, in one transaction", quote.json.transactions.length === 1 && quote.json.full === true && quote.json.sale.stakeUsd === 30]);
    checks.push(["quote: a backer's sale doesn't close the take", quote.json.closesTake === false]);
    // A second quote prepared before the first sale lands.
    const second = await call("POST", `/takes/${TAKE.id}/positions/${mine.address}/exit`, { owner: me });
    if (second.status !== 200) console.log(`second quote: ${second.status} ${JSON.stringify(second.json)}`);

    const sold = await call("POST", "/submit", { buildId: quote.json.buildId, transactions: sign(quote.json.transactions) });
    if (sold.status !== 200) throw new Error(`exit submit: ${sold.status} ${JSON.stringify(sold.json)}`);
    const afterSale = await usdc();
    const proceeds = afterSale - afterPart;
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
    // The holder sells through the holding route: everything they hold on the back side.
    const holderQuote = await call("POST", `/takes/${AUTHORED.id}/sell`, { owner: h, side: "back", bps: 10_000 });
    checks.push(["holder's quote: sells their one position, doesn't close anything", holderQuote.json.closesTake === false && holderQuote.json.positions?.length === 1 && holderQuote.json.positions[0] === held?.address]);
    await submit("holder's sale", holderQuote, holder);

    // A holding of two positions on a four-stock take, sold in two goes through the holding route.
    const seller = Keypair.generate();
    const s = seller.publicKey.toBase58();
    await call("POST", `/wallets/${s}/deposits`, { usd: 200 });
    const firstBack = await call("POST", `/takes/${FOUR.id}/trades`, { owner: s, side: "back", usd: 20 });
    await submit("four-stock back ($20)", firstBack, seller);
    await submit("four-stock back ($30)", await call("POST", `/takes/${FOUR.id}/trades`, { owner: s, side: "back", usd: 30 }), seller);
    const bought = firstBack.json.included.length as number;
    console.log(`four-stock take: backed $20 and $30, ${bought} legs bought`);
    const fourView = await call("GET", `/takes/${FOUR.id}?viewer=${s}`);
    const [small, big] = [20, 30].map((usd) => fourView.json.viewerPositions.find((p: any) => !p.exited && p.stakeUsd === usd)?.address as string);
    const labelsOf = (q: { json: any }) => q.json.steps.flatMap((x: any) => x.labels) as string[];
    const swapsIn = (q: { json: any }) => labelsOf(q).filter((l) => l.startsWith("Sell ")).length;
    // Every record after every swap, the receipt last in the last transaction.
    const recordsLast = (q: { json: any }) => {
      const labels = labelsOf(q);
      const isRecord = (l: string) => l.startsWith("Record") || l === "thesis receipt";
      const first = labels.findIndex(isRecord);
      return first !== -1 && labels.slice(first).every(isRecord) && q.json.steps.at(-1).labels.at(-1) === "thesis receipt";
    };
    const beforeHalf = await usdc(seller.publicKey);
    const half = await call("POST", `/takes/${FOUR.id}/sell`, { owner: s, side: "back", bps: 5_000 });
    if (half.status !== 200) throw new Error(`holding half quote: ${half.status} ${JSON.stringify(half.json)}`);
    console.log(`holding half: ${half.json.transactions.length} transaction(s), Jupiter ${jupiterCalls(half.timing)} calls`);
    for (const x of half.json.steps) console.log(`  ${x.labels.join(" + ")}: ${x.bytes} bytes`);
    checks.push(["holding half: $25 of $50, the $20 position whole and part of the $30 one", half.json.full === false && half.json.sale.stakeUsd === 25 && half.json.positions?.length === 2 && half.json.positions[0] === small && half.json.positions[1] === big]);
    checks.push(["holding half: one swap per token, the records last", swapsIn(half) === bought && recordsLast(half)]);
    await submit("holding half", half, seller);
    const afterHalf = await usdc(seller.publicKey);
    checks.push(["holding half: USDC back, at least the quoted minimum", afterHalf - beforeHalf >= half.json.minimumUsd - 0.005]);
    const [smallAfter, bigAfter] = await thesis.account.position.fetchMultiple([new PublicKey(small), new PublicKey(big)], "confirmed");
    checks.push(["chain: the $20 position sold, $25 left of the $30 one with one partial sale", smallAfter?.exited === true && bigAfter?.remaining.toNumber() === 25_000_000 && bigAfter?.parts === 1 && !bigAfter?.exited]);
    const rest = await call("POST", `/takes/${FOUR.id}/sell`, { owner: s, side: "back", bps: 10_000 });
    if (rest.status !== 200) throw new Error(`holding rest quote: ${rest.status} ${JSON.stringify(rest.json)}`);
    console.log(`holding rest: ${rest.json.transactions.length} transaction(s), Jupiter ${jupiterCalls(rest.timing)} calls (${rest.timing})`);
    checks.push(["holding rest: the $25 left, whole, one swap per token", rest.json.full === true && rest.json.sale.stakeUsd === 25 && rest.json.positions?.length === 1 && swapsIn(rest) === bought]);
    checks.push(["holding rest: the sell routes kept, at most one Jupiter call", (jupiterCalls(rest.timing) ?? 99) <= 1]);
    await submit("holding rest", rest, seller);
    const bigSold = await thesis.account.position.fetch(new PublicKey(big), "confirmed");
    checks.push(["chain: the $30 position sold too", bigSold.exited === true]);
    const leftover = await conn.getParsedTokenAccountsByOwner(seller.publicKey, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed");
    checks.push(["wallet: none of the four stocks left", leftover.value.every((a) => Number(a.account.data.parsed.info.tokenAmount.amount) === 0)]);

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
      checks.push(["chain: the partial sale settled and closed first", !(await conn.getAccountInfo(partSaleAddress(positionKey, 0, thesis.programId), "confirmed"))]);
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
