// pnpm fork:blink <action-url> [--keypair <path>] [--href <action href>]
//
// Plays the wallet's part in a Blink (Solana Action) against the fork, for when no wallet on
// hand can point at a custom RPC. It GETs the action, POSTs `{ account }` to the first linked
// action (or --href), signs the returned transaction with a fork-only test wallet, sends it to
// the fork and prints the Thesis events. The Blink server must build its transactions against
// the fork RPC too (its blockhash has to come from the fork).
//
// The test wallet defaults to .data/fork/blink-wallet.json, created and funded on first use.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VersionedTransaction } from "@solana/web3.js";
import { thesisEventToJson, thesisProgram, thesisTransactionEvents } from "@thesis/chain";
import { DATA_DIR, addSol, addUsdc, connection, loadOrCreateKeypair, main, parseArgs, requireSurfpool } from "./lib.ts";

interface ActionGet {
  title?: string;
  label?: string;
  links?: { actions?: { href: string; label: string; parameters?: { name: string }[] }[] };
}

async function blink(): Promise<void> {
  const { positional, flags } = parseArgs();
  if (positional.length !== 1) throw new Error("Usage: pnpm fork:blink <action-url> [--keypair <path>] [--href <action href>]");
  await requireSurfpool();
  const actionUrl = new URL(positional[0].replace(/^solana-action:/, ""));

  const keypairPath = typeof flags.keypair === "string" ? flags.keypair : join(DATA_DIR, "blink-wallet.json");
  const isNew = !existsSync(keypairPath);
  const { keypair } = loadOrCreateKeypair(keypairPath);
  if (isNew) {
    await addSol(keypair.publicKey, 1);
    await addUsdc(keypair.publicKey, 1_000);
    console.log(`Created and funded test wallet ${keypair.publicKey.toBase58()} (${keypairPath})`);
  }

  const meta = (await (await fetch(actionUrl)).json()) as ActionGet;
  console.log(`GET  ${actionUrl}\n     ${meta.title ?? ""} — ${meta.label ?? ""}`);
  const linked = meta.links?.actions ?? [];
  for (const a of linked) console.log(`     action: ${a.label} → ${a.href}`);
  const href = typeof flags.href === "string" ? flags.href : (linked[0]?.href ?? actionUrl.toString());
  if (/\{\w+\}/.test(href)) throw new Error(`Action ${href} takes parameters: fill them in and pass it with --href`);
  const postUrl = new URL(href, actionUrl);

  const res = await fetch(postUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: keypair.publicKey.toBase58() }),
  });
  const body = (await res.json()) as { transaction?: string; message?: string };
  if (!res.ok || !body.transaction) throw new Error(`POST ${postUrl} → ${res.status}: ${JSON.stringify(body)}`);
  console.log(`POST ${postUrl}${body.message ? `\n     ${body.message}` : ""}`);

  const tx = VersionedTransaction.deserialize(Buffer.from(body.transaction, "base64"));
  tx.sign([keypair]);
  const conn = connection();
  const sig = await conn.sendRawTransaction(tx.serialize());
  const latest = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  const sent = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (sent?.meta?.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(sent.meta.err)}`);
  console.log(`\nSent ${sig}`);
  for (const e of thesisTransactionEvents(thesisProgram(conn), sent).map(thesisEventToJson)) {
    console.log(`  ${e.name} ${JSON.stringify(e.data)}`);
  }
}

if (import.meta.main) await main(blink);
