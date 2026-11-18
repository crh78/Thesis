// pnpm fork:creator-fees-e2e — creator fees end to end, against a real fork API over HTTP.
//
// An author posts three takes made up for the run (one stock leg each) with a $10 buy-in, and a
// backer backs each with $100, $60 and $40. A third wallet fades the first take with $20 (a
// Phoenix short of NVIDIA). The author's creator share is 5 bps of each back and of the fade
// (fades pay it too; none on their own buy-in). Then:
// - the fee read refuses a missing or foreign signature, and with the author's shows exactly what
//   each take earned, all unclaimed;
// - "Claim" on one take: the author's USDC rises by exactly that take's share;
// - "Claim all": the other two in one transaction, USDC up by exactly their shares;
// - the read shows everything claimed, and another claim is refused.
// Needs the asset bank, JUPITER_API_KEY and Phoenix on the fork (not FORK_PHOENIX=0).
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { USDC_MINT_MAINNET, thesisProgram } from "@thesis/chain";
import { forkApiServer } from "./api/server.ts";
import type { AppTake } from "./api/service.ts";
import { creatorFeesAuthMessage } from "./api/creator-fees.ts";
import { startForkService } from "./api.ts";
import { connection, main, syncClock } from "./lib.ts";

const BACKS = [100, 60, 40];
/** A fade of the first take, by someone else. */
const FADE = 20;
/** 5 bps of the stake, in USDC base units, rounded down like the program. */
const share = (usd: number) => BigInt(usd * 1_000_000) * 5n / 10_000n;

/** What Privy's signMessage returns: the wallet's Ed25519 signature, base64. */
function signMessage(kp: Keypair, message: string): string {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(kp.secretKey.subarray(0, 32))]);
  return sign(null, Buffer.from(message, "utf8"), createPrivateKey({ key: der, format: "der", type: "pkcs8" })).toString("base64");
}

async function e2e(): Promise<void> {
  const lead = await syncClock();
  if (lead > 120) throw new Error(`The fork's clock is ${lead}s ahead of real time: restart the fork.`);
  const run = randomUUID().slice(0, 8);
  const takes: AppTake[] = BACKS.map((_, i) => ({
    id: randomUUID(),
    claim: `Creator fees e2e ${run} #${i + 1}: NVIDIA keeps leading`,
    risk: "medium",
    settles_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    author: { handle: "fees-e2e" },
    // Only the first take is faded: Phoenix lists NVIDIA, so its fade is a short there.
    legs: [{ name: "NVIDIA", kind: "Stock", weight: 100, fade_how: i === 0 ? "Bets the stock falls" : null }],
  }));
  const service = await startForkService((m) => console.log(`  [api] ${m}`), {
    takes: async (id) => takes.find((t) => t.id === id) ?? null,
  });
  const server = forkApiServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json()) as any };
  };
  const signAndSubmit = async (built: any, kp: Keypair) => {
    const signed = built.transactions.map((b64: string) => {
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      tx.sign([kp]);
      return Buffer.from(tx.serialize()).toString("base64");
    });
    const sent = await call("POST", "/submit", { buildId: built.buildId, transactions: signed });
    if (sent.status !== 200) throw new Error(`submit: ${sent.status} ${JSON.stringify(sent.json)}`);
    return sent.json.signatures as string[];
  };
  const conn = connection();
  const checks: [string, boolean][] = [];
  try {
    const author = Keypair.generate();
    const backer = Keypair.generate();
    const a = author.publicKey.toBase58();
    // Only a take's author can publish it: these takes are the author's.
    for (const t of takes) t.author_wallet = a;
    const fader = Keypair.generate();
    const b = backer.publicKey.toBase58();
    const f = fader.publicKey.toBase58();
    console.log(`author ${a}\nbacker ${b}\nfader ${f}`);
    await call("POST", `/wallets/${a}/deposits`, { usd: 100 });
    await call("POST", `/wallets/${b}/deposits`, { usd: 300 });
    await call("POST", `/wallets/${f}/deposits`, { usd: 100 });

    const addresses: string[] = [];
    for (const [i, take] of takes.entries()) {
      const pub = await call("POST", `/takes/${take.id}/publish`, { author: a, usd: 10 });
      if (pub.status !== 200) throw new Error(`publish ${i + 1}: ${pub.status} ${JSON.stringify(pub.json)}`);
      await signAndSubmit(pub.json, author);
      addresses.push(pub.json.take);
      const back = await call("POST", `/takes/${take.id}/trades`, { owner: b, side: "back", usd: BACKS[i] });
      if (back.status !== 200) throw new Error(`back ${i + 1}: ${back.status} ${JSON.stringify(back.json)}`);
      await signAndSubmit(back.json, backer);
      console.log(`take ${i + 1} ${pub.json.take}: posted with $10, backed with $${BACKS[i]}`);
    }

    // A fade pays the author too. Before it, the first take holds only its back's share.
    const takeAccount = async () => (await thesisProgram(conn).account.take.fetch(new PublicKey(addresses[0]), "confirmed")) as any;
    const beforeFade = BigInt((await takeAccount()).creatorFeesUnclaimed.toString());
    // Authors can't fade their own take: the build is refused, and their receipt says so.
    const selfFade = await call("POST", `/takes/${takes[0].id}/trades`, { owner: a, side: "fade", usd: FADE });
    const authorView = await call("GET", `/takes/${takes[0].id}?viewer=${a}`);
    const faderView = await call("GET", `/takes/${takes[0].id}?viewer=${f}`);
    checks.push(["fade: the author's own fade is refused (409 cannot_fade_own_take)", selfFade.status === 409 && selfFade.json.error === "cannot_fade_own_take"]);
    checks.push(["fade: the author's receipt has canFade false, with why; someone else's has it true", authorView.json.canFade === false && /own take/.test(authorView.json.fadeBlocked) && faderView.json.canFade === true]);
    const fade = await call("POST", `/takes/${takes[0].id}/trades`, { owner: f, side: "fade", usd: FADE });
    if (fade.status !== 200) throw new Error(`fade: ${fade.status} ${JSON.stringify(fade.json)}`);
    for (const x of fade.json.excluded ?? []) console.log(`  fade left out ${x.name}: ${x.reason}`);
    await signAndSubmit(fade.json, fader);
    const afterFade = await takeAccount();
    const fadeGain = BigInt(afterFade.creatorFeesUnclaimed.toString()) - beforeFade;
    console.log(`take 1: faded with $${FADE}, faders ${afterFade.faders}`);
    checks.push(["fade: recorded on-chain against the first take", Number(afterFade.faders) === 1]);
    checks.push([`fade: the take's unclaimed creator share rose by exactly 5 bps of the fade, ${share(FADE)} (got ${fadeGain})`, fadeGain === share(FADE)]);

    // Only the wallet itself can read its fees.
    const path = `/wallets/${a}/creator-fees`;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = await call("GET", path);
    checks.push(["read: refused without a signature", unsigned.status === 401]);
    const foreign = await call("GET", path, undefined, { "x-thesis-wallet-auth": `${now}.${signMessage(backer, creatorFeesAuthMessage(a, now))}` });
    checks.push(["read: refused with another wallet's signature", foreign.status === 401]);
    const auth = () => {
      const t = Math.floor(Date.now() / 1000);
      return { "x-thesis-wallet-auth": `${t}.${signMessage(author, creatorFeesAuthMessage(a, t))}` };
    };
    const before = await call("GET", path, undefined, auth());
    if (before.status !== 200) throw new Error(`read: ${before.status} ${JSON.stringify(before.json)}`);
    const row = (json: any, take: string) => json.takes.find((t: any) => t.take === take);
    /** What each take earned: its back, plus the fade on the first. */
    const earned = BACKS.map((usd, i) => share(usd) + (i === 0 ? share(FADE) : 0n));
    const total = earned.reduce((s, x) => s + x, 0n);
    checks.push([
      `read: each take earned 5 bps of its back, and the first of its fade too, all unclaimed (${earned.join(", ")})`,
      earned.every((x, i) => row(before.json, addresses[i])?.earned === x.toString() && row(before.json, addresses[i])?.unclaimed === x.toString() && row(before.json, addresses[i])?.claimed === "0"),
    ]);
    checks.push([`read: totals earned ${total}, unclaimed ${total}`, before.json.earned === total.toString() && before.json.unclaimed === total.toString()]);
    checks.push(["read: the app take id comes with each take", BACKS.every((_, i) => row(before.json, addresses[i])?.takeId === takes[i].id)]);

    const usdcAccount = getAssociatedTokenAddressSync(USDC_MINT_MAINNET, author.publicKey, true);
    const balance = async () => BigInt((await conn.getTokenAccountBalance(usdcAccount, "confirmed")).value.amount);

    // Claim one take.
    let start = await balance();
    const one = await call("POST", `${path}/claim`, { takes: [addresses[0]] });
    if (one.status !== 200) throw new Error(`claim one: ${one.status} ${JSON.stringify(one.json)}`);
    await signAndSubmit(one.json, author);
    let gained = (await balance()) - start;
    checks.push([`claim one: USDC up by exactly ${earned[0]}, the back's share and the fade's (got ${gained})`, gained === earned[0]]);

    // Claim all: the other two, together.
    start = await balance();
    const all = await call("POST", `${path}/claim`, {});
    if (all.status !== 200) throw new Error(`claim all: ${all.status} ${JSON.stringify(all.json)}`);
    console.log(`claim all: ${all.json.transactions.length} transaction(s): ${all.json.steps.map((s: any) => `${s.takes.length} claim(s), ${s.bytes} bytes`).join("; ")}`);
    checks.push(["claim all: both remaining takes in one transaction", all.json.transactions.length === 1 && all.json.steps[0].takes.length === 2]);
    await signAndSubmit(all.json, author);
    gained = (await balance()) - start;
    const rest = earned[1] + earned[2];
    checks.push([`claim all: USDC up by exactly ${rest} (got ${gained})`, gained === rest]);

    const after = await call("GET", path, undefined, auth());
    checks.push([`read: all ${total} claimed, nothing left`, after.json.claimed === total.toString() && after.json.unclaimed === "0" && after.json.earned === total.toString()]);
    const again = await call("POST", `${path}/claim`, {});
    checks.push(["claim again: nothing to claim", again.status === 409 && again.json.error === "nothing_to_claim"]);
  } finally {
    server.close();
  }
  console.log("");
  for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("Creator fees e2e failed");
  console.log("\n✓ Creator fees e2e passed");
  process.exit(0);
}

main(e2e);
