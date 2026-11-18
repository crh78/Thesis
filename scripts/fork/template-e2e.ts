// Shared swap templates against live Jupiter (no fork needed): a swap built for one wallet,
// retargeted to a second, must match Jupiter's own answer for the second wallet byte for byte,
// and the fork API's router must build the second wallet's trade from the first one's routing
// with no Jupiter call, each leg filling the second wallet's own account for exactly its part.
//
//   node scripts/fork/template-e2e.ts [--keys equity:US:NVDA,etf:US:SPY] [--usd 20] [--second <pubkey>]
//
// Needs JUPITER_API_KEY (or uses the keyless lite-api) and the asset bank (ASSET_BANK_FILE or the
// Supabase sink, as the fork API reads it). About 5 Jupiter requests per underlying, inside the
// fork API's own budget of 30 a minute; run it on the VM like the other e2e suites. `--second`
// checks a real wallet as the second one (one that holds tokens on mainnet may get a different
// setup from Jupiter: the check then says the first wallet's answer wasn't shareable, or differs).
import { Keypair, PublicKey } from "@solana/web3.js";
import { PRICEABLE_MIN_POOLED_USD, issuerPool, loadBankState } from "@thesis/venues/bank";
import { buyInstructions, fromTemplate, jupiterQuote, jupiterSwapInstructions, legDiff, swapTemplate, unshareable, type JupiterBuy } from "@thesis/venues/jupiter";
import { JupiterBudget, newUse } from "./api/guard.ts";
import type { MappedLeg } from "./api/legs.ts";
import { Router } from "./api/routing.ts";
import { FORK_DEXES } from "./lib.ts";
import { envVar } from "../../packages/venues/registry/src/lib/env.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const usd = Number(arg("usd") ?? 20);
const apiKey = envVar("JUPITER_API_KEY");
const state = await loadBankState();
const route = { maxAccounts: 30, minPooledUsd: PRICEABLE_MIN_POOLED_USD };
const keys = arg("keys")?.split(",") ?? Object.keys(state.underlyings).filter((k) => {
  try {
    return issuerPool(k, state, route).pool.length > 0;
  } catch {
    return false;
  }
}).slice(0, 3);
if (!keys.length) throw new Error("no routable underlying in the asset bank");
const budget = new JupiterBudget();
const access = { apiKey, fetchFn: budget.fetchFn(1), max429WaitMs: budget.max429WaitMs(1) };
const payer = Keypair.generate().publicKey;
const first = Keypair.generate().publicKey;
const second = arg("second") ? new PublicKey(arg("second")!) : Keypair.generate().publicKey;
let failures = 0;
const fail = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

// 1. Per issuer token: one quote, the first wallet's answer as a template, retargeted to the
//    second wallet, against Jupiter's answer for the second wallet with the same quote.
console.log(`Templates against Jupiter's own answer (${apiKey ? "api.jup.ag" : "lite-api"}, $${usd} each):`);
for (const key of keys) {
  const mint = issuerPool(key, state, route).pool[0].mint;
  const { quote, error } = await jupiterQuote({ ...access, outputMint: mint, amount: BigInt(Math.round(usd * 1e6)), maxAccounts: 30, dexes: FORK_DEXES });
  if (!quote) {
    console.log(`- ${key} (${mint}): no quote (${error}), skipped`);
    continue;
  }
  const q = quote as typeof quote & { outputMint: string; inputMint?: string };
  const [resA, resB] = await Promise.all([first, second].map((user) => jupiterSwapInstructions({ ...access, quote, user })));
  const why = unshareable({ res: resA, quote: q }, first);
  const t = swapTemplate({ res: resA, quote: q }, first);
  if (!t) {
    fail(`${key}: the first wallet's answer isn't shareable (${why})`);
    continue;
  }
  const diff = legDiff(fromTemplate(t, second, payer, key), buyInstructions(resB, q, second, payer, key));
  if (diff) fail(`${key}: the retargeted swap differs from Jupiter's answer for the second wallet: ${diff}`);
  else console.log(`- ${key} (${state.tokens[mint]?.symbol ?? mint}, ${quote.routePlan.length} hops): same bytes`);
}

// 2. Through the router: the second wallet's build of the same trade reuses the routing.
console.log(`\nThe router: one basket of ${keys.join(", ")}, $${usd}:`);
const legs: MappedLeg[] = keys.map((key, index) => ({
  index,
  name: key,
  key,
  how: "swap",
  spec: { weightBps: Math.floor(10_000 / keys.length), leverage: 1, fadeVia: { none: {} } } as unknown as MappedLeg["spec"],
  blocked: null,
}));
const router = new Router({ bank: () => state, appPayer: Keypair.generate(), jupiterApiKey: apiKey, dexes: FORK_DEXES } as unknown as ConstructorParameters<typeof Router>[0], { budget, readMints: null });
const a = await router.venueLegs(legs, first, usd, payer);
const useB = newUse(1);
const b = await router.venueLegs(legs, second, usd, payer, undefined, { use: useB });
console.log(`- first wallet: ${a.jupiter.calls} Jupiter calls (template ${a.jupiter.template}); second: ${useB.calls} (template ${useB.template}, ${useB.templatedLegs} legs from templates)`);
if (useB.template !== "hit") fail(`the second build didn't reuse the routing (${useB.template})`);
if (useB.calls !== 0) fail(`the second build made ${useB.calls} Jupiter calls`);
if (JSON.stringify(a.included) !== JSON.stringify(b.included)) fail(`included legs differ: ${a.included} vs ${b.included}`);
const spent = (legs: typeof b.venue) => legs.reduce((n, l) => n + ((l as unknown as JupiterBuy).inUsdc ?? 0n), 0n);
if (spent(a.venue) !== spent(b.venue)) fail(`USDC in differs: ${spent(a.venue)} vs ${spent(b.venue)}`);
for (const [i, l] of b.venue.entries()) {
  const mine = (l as unknown as JupiterBuy).mint;
  const ata = l.output.account.toBase58();
  const filled = l.instructions.flatMap((ix) => ix.keys).find((k) => k.pubkey.toBase58() === ata && k.isWritable);
  if (!filled) fail(`leg ${i}: the second wallet's output account isn't in its instructions`);
  if (l.instructions.some((ix) => ix.keys.some((k) => k.pubkey.equals(first)))) fail(`leg ${i} (${mine}): names the first wallet`);
  if (!l.instructions.some((ix) => ix.keys.some((k) => k.pubkey.equals(second) && k.isSigner))) fail(`leg ${i} (${mine}): the second wallet doesn't sign it`);
}
console.log(`\nJupiter calls in all: ${budget.stats.calls.reduce((x, y) => x + y, 0)}; ${budget.stats.rateLimited} answered 429.`);
if (failures) {
  console.log(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All template checks passed.");
