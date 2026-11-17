// node scripts/fork/cards-e2e.ts — card legs on the fork, against a real fork API over HTTP
// (after the cards reset: the program with card legs, docs/cards-reset.md step 7).
//
// Starts the fork API in-process, like fork:api-e2e, on a take made up for the run: one
// Collector Crypt card at 20% and NVIDIA at 80%. It backs $25 from a throwaway wallet, checks
// that the card leg went in and its share is escrowed (nothing bought for it), that a fade leaves
// the card out, then sells and checks that the escrow comes back. The take never reaches Supabase,
// so it stays out of every feed and board.
//
//   CARDS_E2E_CARD   the Collector Crypt card id to use. Default: a card the asset bank already tracks
//                    (one a take builder basket picked), so the settler can price it.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { forkApiServer } from "./api/server.ts";
import type { AppTake } from "./api/service.ts";
import { startForkService } from "./api.ts";
import { loadBankState } from "@thesis/venues/bank";
import { main, syncClock } from "./lib.ts";

const CARD = process.env.CARDS_E2E_CARD ?? Object.values((await loadBankState()).venues.cards?.picked ?? {}).find((c) => c.insuredValueUsd)?.cardId;
if (!CARD) throw new Error("No card to trade: set CARDS_E2E_CARD, or build a take with a card so the asset bank tracks one.");
const TAKE: AppTake = {
  id: randomUUID(),
  claim: "Cards e2e: graded Pokémon keep climbing",
  risk: "medium",
  settles_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  author: { handle: "cards-e2e" },
  legs: [
    { name: "NVIDIA", kind: "Stock", weight: 80, fade_how: "Bets the stock falls", asset_id: "jup:Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" },
    { name: "Card", kind: "Card", weight: 20, fade_how: null, asset_id: `card:${CARD}` },
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
  const sign = (user: Keypair, txs: string[]) =>
    txs.map((b64) => {
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      tx.sign([user]);
      return Buffer.from(tx.serialize()).toString("base64");
    });
  const checks: [string, boolean][] = [];
  try {
    const user = Keypair.generate();
    const me = user.publicKey.toBase58();
    console.log(`user ${me}, card ${CARD}, take ${TAKE.id}`);
    const dep = await call("POST", `/wallets/${me}/deposits`, { usd: 100 });
    checks.push(["deposit: 100 USDC", dep.status === 200]);

    const before = await call("GET", `/takes/${TAKE.id}?viewer=${me}`);
    const cardLeg = before.json.legs?.find((l: any) => l.index === 1);
    console.log(`card leg: ${cardLeg?.tradable ? "tradable" : cardLeg?.blocked}; fade: ${cardLeg?.fadeBlocked}; card ${JSON.stringify(cardLeg?.card)}`);
    checks.push(["receipt: the card leg is tradable, shown as a card", cardLeg?.tradable === true && cardLeg?.card?.cardId === CARD]);
    checks.push(["receipt: a fade leaves the card out", typeof cardLeg?.fadeBlocked === "string" && /can't be faded/.test(cardLeg.fadeBlocked)]);

    const built = await call("POST", `/takes/${TAKE.id}/trades`, { owner: me, side: "back", usd: 25 });
    if (built.status !== 200) throw new Error(`build: ${built.status} ${JSON.stringify(built.json)}`);
    for (const x of built.json.excluded) console.log(`  left out ${x.name}: ${x.reason}`);
    console.log(`built: included ${built.json.included}, escrow $${built.json.escrowUsd}`);
    checks.push(["build: the card is in, and 20% of $25 is escrowed for it", built.json.included.includes(1) && Math.abs(built.json.escrowUsd - 5) < 1e-6]);
    const sent = await call("POST", "/submit", { buildId: built.json.buildId, transactions: sign(user, built.json.transactions) });
    if (sent.status !== 200) throw new Error(`submit: ${sent.status} ${JSON.stringify(sent.json)}`);
    console.log(`sent ${sent.json.signatures.join(", ")}`);

    const after = await call("GET", `/takes/${TAKE.id}?viewer=${me}`);
    const pos = after.json.viewerPositions?.[0];
    checks.push(["position: on-chain, card leg included, $5 escrowed", !!pos && (pos.legsMask & 0b10) !== 0 && Math.abs(pos.escrowedUsd - 5) < 1e-6]);
    const wallet = await call("GET", `/wallets/${me}`);
    checks.push(["wallet: holds NVIDIA only (no card token)", wallet.json.holdings.length === 1]);

    const fade = await call("POST", `/takes/${TAKE.id}/trades`, { owner: me, side: "fade", usd: 10 });
    const fadeOut = (fade.json.excluded ?? []).find((x: any) => x.index === 1);
    console.log(`fade build: ${fade.status} ${fadeOut ? `card left out: ${fadeOut.reason}` : JSON.stringify(fade.json).slice(0, 200)}`);
    checks.push(["fade: built without the card", fade.status === 200 && !!fadeOut && !fade.json.included.includes(1)]);

    const usdcBefore = wallet.json.usdc;
    const exit = await call("POST", `/takes/${TAKE.id}/positions/${pos.address}/exit`, { owner: me });
    if (exit.status !== 200) throw new Error(`exit build: ${exit.status} ${JSON.stringify(exit.json)}`);
    console.log(`sale: escrow back $${exit.json.escrowUsd}, expected $${exit.json.expectedUsd}`);
    const sold = await call("POST", "/submit", { buildId: exit.json.buildId, transactions: sign(user, exit.json.transactions) });
    if (sold.status !== 200) throw new Error(`exit submit: ${sold.status} ${JSON.stringify(sold.json)}`);
    const end = await call("GET", `/wallets/${me}`);
    console.log(`USDC ${usdcBefore} -> ${end.json.usdc}`);
    checks.push(["sale: the $5 escrow comes back", Math.abs(exit.json.escrowUsd - 5) < 1e-6 && end.json.usdc - usdcBefore >= 5 - 1e-6]);
    console.log(`\nposition ${pos.address}: the settler signs the card's entry once the asset bank holds card ${CARD} (rule card-insured-value in price_audit).`);
  } finally {
    server.close();
  }
  console.log("");
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("cards e2e failed");
}

if (import.meta.main) await main(e2e);
