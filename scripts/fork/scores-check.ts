// pnpm fork:scores-check <wallet> [...] | --all — checks the backend's on-chain scores against the chain.
//
// For each wallet, compares what Supabase computes from the Stream's events (chain_wallet_stats,
// supabase/migrations/*_chain_scores.sql) with the raw stats the program keeps in the wallet's
// Profile account: scored stake, scored P&L, wins, settled positions and settled takes. Run it
// after a fork e2e with `pnpm fork:relay` (or the fork API's own relay) delivering the fork's
// events to THESIS_WEBHOOK_URL. Exits non-zero on any difference.
//
// Every fork reports as network solana-mainnet-fork, so a wallet used on two forks (an app test
// account, say) mixes both forks' events. Check wallets this fork made (the e2e scripts' own);
// --all checks every Profile account on the fork, which on a fresh fork is just those.
//
// Settings: FORK_RPC_PORT / FORK_RPC_URL, SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY (required).
import { PublicKey } from "@solana/web3.js";
import { profileAddress, thesisProgram } from "@thesis/chain";
import { envVar } from "../../packages/venues/registry/src/lib/env.ts";
import { connection, main } from "./lib.ts";

const SUPABASE_URL = envVar("SUPABASE_URL");
const SUPABASE_KEY = envVar("SUPABASE_PUBLISHABLE_KEY");
const NETWORK = "solana-mainnet-fork";

type Stats = { owner: string; scored_stake: number; pnl: number; wins: number; settled: number; takes_settled: number };

main(async () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set (repo-root .env).");
  const program = thesisProgram(connection());
  const wallets = process.argv.includes("--all")
    ? (await program.account.profile.all()).map((p) => p.account.owner.toBase58())
    : process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (!wallets.length) throw new Error("Usage: pnpm fork:scores-check <wallet> [...] | --all");
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/chain_wallet_stats`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "content-type": "application/json" },
    body: JSON.stringify({ p_network: NETWORK }),
  });
  if (!r.ok) throw new Error(`chain_wallet_stats: HTTP ${r.status} ${await r.text()}`);
  const rows = new Map(((await r.json()) as Stats[]).map((s) => [s.owner, s]));

  let bad = 0;
  for (const wallet of wallets) {
    const profile = await program.account.profile.fetchNullable(profileAddress(new PublicKey(wallet)), "confirmed");
    if (!profile) {
      console.log(`?    ${wallet}: no Profile account on this fork`);
      bad++;
      continue;
    }
    const s = rows.get(wallet);
    const pairs: [string, number, number][] = [
      ["scored stake", Number(profile.scoredStake), Number(s?.scored_stake ?? 0)],
      ["scored P&L", Number(profile.scoredPnl), Number(s?.pnl ?? 0)],
      ["wins", profile.wins, Number(s?.wins ?? 0)],
      ["settled positions", profile.positionsSettled, Number(s?.settled ?? 0)],
      ["settled takes", profile.takesSettled, Number(s?.takes_settled ?? 0)],
    ];
    for (const [what, chain, backend] of pairs) {
      const ok = chain === backend;
      if (!ok) bad++;
      console.log(`${ok ? "ok  " : "FAIL"} ${wallet.slice(0, 8)}… ${what}: chain ${chain}, backend ${backend}`);
    }
  }
  if (bad) throw new Error(`${bad} difference(s) between the chain and the backend`);
  console.log("\nThe backend's scores match the chain.");
});
