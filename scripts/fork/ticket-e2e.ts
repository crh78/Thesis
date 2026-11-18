// pnpm fork:ticket-e2e — abandoned trade tickets get cancelled (security review L-4).
//
// A split trade whose later transaction never lands leaves its ticket, and the rent the app's
// fee payer put up for it, behind. The fork API cancels such tickets in a short extra transaction
// at the end of the owner's next trade (the owner signs it with the trade; it's sent after the
// trade lands). This makes one: the first transaction of a split trade (begin_trade … trade_step)
// with no receipt after it. Then the owner backs a take and the ticket is gone, its rent back with
// the app's payer. Needs the asset bank and JUPITER_API_KEY.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Keypair, Transaction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { beginTradeIx, thesisProgram, ticketAddress, tradeStepIx, TAKE_LIFETIME_SECS } from "@thesis/chain";
import { forkApiServer } from "./api/server.ts";
import type { AppTake } from "./api/service.ts";
import { startForkService } from "./api.ts";
import { PATHS, addSol, connection, loadKeypair, main } from "./lib.ts";

async function e2e(): Promise<void> {
  const take: AppTake = {
    id: randomUUID(),
    claim: "Ticket e2e: NVIDIA",
    risk: "medium",
    settles_at: new Date(Date.now() + TAKE_LIFETIME_SECS * 1000).toISOString(),
    author: { handle: "ticket-e2e" },
    legs: [{ name: "NVIDIA", kind: "Stock", weight: 100, fade_how: null }],
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
  const program = thesisProgram(conn);
  const appPayer = loadKeypair(PATHS.appPayer);
  const checks: [string, boolean][] = [];

  try {
    const user = Keypair.generate();
    await addSol(user.publicKey, 1);
    await call("POST", `/wallets/${user.publicKey.toBase58()}/deposits`, { usd: 100 });

    // The first transaction of a split trade, and nothing after it.
    const position = Keypair.generate().publicKey;
    const ticket = ticketAddress(user.publicKey, position, program.programId);
    const leg = { owner: user.publicKey, position, outputsMask: 0, outputs: [] };
    const tx = new Transaction().add(
      await beginTradeIx(program, { ...leg, payer: appPayer.publicKey }),
      await tradeStepIx(program, { ...leg, open: false }),
    );
    tx.feePayer = appPayer.publicKey;
    await sendAndConfirmTransaction(conn, tx, [appPayer, user], { commitment: "confirmed" });
    const rent = (await conn.getAccountInfo(ticket, "confirmed"))?.lamports ?? 0;
    console.log(`abandoned ticket ${ticket.toBase58()} (${rent} lamports of the app payer's)`);
    checks.push(["setup: an abandoned ticket the app paid for", rent > 0]);

    // The owner's next trade carries the cleanup, last.
    const built = await call("POST", `/takes/${take.id}/trades`, { owner: user.publicKey.toBase58(), side: "back", usd: 20 });
    if (built.status !== 200) throw new Error(`back: ${built.status} ${JSON.stringify(built.json)}`);
    const steps = built.json.steps as { labels: string[] }[];
    for (const s of steps) console.log(`  ${s.labels.join(" + ")}`);
    checks.push(["build: the last transaction cancels the abandoned ticket", /abandoned/.test(steps.at(-1)!.labels.join(" "))]);
    const signed = (built.json.transactions as string[]).map((b64) => {
      const v = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      v.sign([user]);
      return Buffer.from(v.serialize()).toString("base64");
    });
    const sent = await call("POST", "/submit", { buildId: built.json.buildId, transactions: signed });
    if (sent.status !== 200) throw new Error(`submit: ${sent.status} ${JSON.stringify(sent.json)}`);
    checks.push(["submit: the back landed", sent.json.signatures.length === steps.length - 1]);
    checks.push(["chain: the abandoned ticket is closed", !(await conn.getAccountInfo(ticket, "confirmed"))]);

    // Nothing left to clean up: the next build is just the trade.
    const again = await call("POST", `/takes/${take.id}/trades`, { owner: user.publicKey.toBase58(), side: "back", usd: 20 });
    checks.push(["build: no cleanup once there's nothing abandoned", again.status === 200 && !(again.json.steps as { labels: string[] }[]).some((s) => /abandoned/.test(s.labels.join(" ")))]);
  } finally {
    server.close();
  }
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("ticket e2e failed");
}

main(e2e);
