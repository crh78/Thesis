// pnpm fork:load-trades [-- --users N --takes K --usd N --stocks-only --ramp S] — a few people
// trading at once on the one fork: how fast builds, accepts and landings stay, and what fails.
//
// Starts the fork API in-process with the abuse limits in front (as fork:latency-bench), makes up
// K takes (they never reach Supabase, so no feed or board shows them), each with every kind of leg:
// two stocks (a different pair per take, so first builds quote Jupiter afresh), a 2x CoreWeave perp
// (Phoenix; its sends run one at a time, api/phoenix-lock.ts), a live Gemini prediction (picked as
// gemini-e2e does) and a Collector Crypt card (one the asset bank tracks). `--stocks-only` keeps
// the stocks. Each take is put on-chain first (its demo author's buy-in), then N throwaway wallets
// (local keypairs, no profile) start at once, or over `--ramp S` seconds. Each gets cash, backs
// (every third one fades: Phoenix shorts and the prediction's other side; cards stay out) at its
// own amount, as a person tapping (built at the tap, signed, sent until "accepted", watched until
// it lands, a `requote` built again once), waits a few seconds, sells all of it the same way, and
// cashes out Phoenix. It prints p50 / p90 / max per step, every error with its message, and the
// Jupiter budget's waits and 429s. A run of 4 users costs a few dozen Jupiter calls.
//
// Never moves the fork's clock. Run it while nobody else trades: its API is a second process on
// the same Jupiter organisation (its budget is the live API's, FORK_API_JUPITER_RPM), and its
// Phoenix maker sync could undo a live Phoenix fill that lands between its read and write.
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { TAKE_LIFETIME_SECS } from "@thesis/chain";
import { loadBankState } from "@thesis/venues/bank";
import { fetchGeminiEvent, geminiProxy } from "@thesis/venues/gemini";
import { envVar } from "../../packages/venues/registry/src/lib/env.ts";
import { Guard } from "./api/guard.ts";
import { forkApiServer } from "./api/server.ts";
import type { AppTake } from "./api/service.ts";
import { startForkService } from "./api.ts";
import { pickLiveContract } from "./gemini-pick.ts";
import { main, numberFlag, parseArgs, syncClock } from "./lib.ts";

/** Liquid stocks the fork can route, paired differently per take. */
const STOCKS = ["NVIDIA", "Microsoft", "Broadcom", "Apple", "Tesla", "Amazon", "Meta", "Alphabet"];

/** The non-stock legs every take gets: a live Gemini contract and a card the asset bank tracks. */
type Extras = { prediction: { symbol: string; label: string } | null; card: string | null };

async function extras(): Promise<Extras> {
  const bank = await loadBankState();
  const card = Object.values(bank.venues.cards?.picked ?? {}).find((c) => c.insuredValueUsd)?.cardId ?? null;
  let prediction: Extras["prediction"] = null;
  try {
    const proxy = geminiProxy(envVar);
    const pick = await pickLiveContract(Object.values(bank.venues.gemini?.contracts ?? {}), (ticker) =>
      fetchGeminiEvent(proxy, ticker, (input, init) => fetch(input, { signal: AbortSignal.timeout(15_000), ...init })), Date.now());
    prediction = { symbol: pick.instrumentSymbol, label: pick.label };
  } catch (e) {
    console.log(`no Gemini contract to use (${e instanceof Error ? e.message.slice(0, 120) : e}): takes go without a prediction leg`);
  }
  if (!card) console.log("no card the asset bank tracks: takes go without a card leg");
  return { prediction, card };
}

function takes(k: number, x: Extras | null): AppTake[] {
  return Array.from({ length: k }, (_, i) => {
    const picks = [0, 1].map((j) => STOCKS[(i * 2 + j) % STOCKS.length]);
    const legs: AppTake["legs"] = picks.map((name) => ({ name, kind: "Stock", weight: 30, fade_how: "Bets the stock falls" }));
    if (x) {
      legs.push({ name: "CoreWeave perp", kind: "Stock · 2x", weight: 15, fade_how: "Bets the stock falls", asset_id: "phoenix:CRWV" });
      if (x.prediction) legs.push({ name: x.prediction.label, kind: "Prediction · Yes", weight: 10, fade_how: "No", asset_id: `gemini:${x.prediction.symbol}` });
      if (x.card) legs.push({ name: "Card", kind: "Card", weight: 15, fade_how: null, asset_id: `card:${x.card}` });
    }
    // Whole percents adding up to 100: the first stock takes what's left.
    legs[0].weight += 100 - legs.reduce((a, l) => a + l.weight, 0);
    return {
      id: randomUUID(),
      claim: `Load test ${i + 1}: ${legs.map((l) => l.name).join(", ")}`,
      risk: x ? "high" : "medium",
      settles_at: new Date(Date.now() + TAKE_LIFETIME_SECS * 1000).toISOString(),
      author: { handle: "load-test" },
      legs,
    };
  });
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

async function load(): Promise<void> {
  const { flags } = parseArgs();
  const users = numberFlag(flags, "users", 4);
  const k = numberFlag(flags, "takes", 2);
  const usd = numberFlag(flags, "usd", 12);
  const rampS = numberFlag(flags, "ramp", 0);
  const every = flags["stocks-only"] !== true;
  const lead = await syncClock();
  if (lead > 120) throw new Error(`The fork's clock is ${lead}s ahead of real time: restart the fork.`);

  const all = takes(k, every ? await extras() : null);
  for (const t of all) console.log(`take ${t.id.slice(0, 8)}: ${t.legs.map((l) => `${l.name} ${l.weight}%`).join(", ")}`);
  const byId = new Map(all.map((t) => [t.id, t]));
  const serviceKey = randomBytes(24).toString("hex");
  const guard = new Guard({ auth: "enforce", readLimit: "enforce", serviceKeys: new Map([["load", serviceKey]]), proxyKey: null, privy: null, busyFile: null });
  const notes = { jupiterWaitMs: 0, jupiter429: 0, lockWaitMs: [] as number[], incomplete: 0 };
  const service = await startForkService((m) => {
    const wait = /jupiter wait (\d+)/.exec(m);
    if (wait) notes.jupiterWaitMs += Number(wait[1]);
    const r = /429s (\d+)/.exec(m);
    if (r) notes.jupiter429 += Number(r[1]);
    const lock = /phoenix lock (\d+)/.exec(m);
    if (lock) notes.lockWaitMs.push(Number(lock[1]));
    if (m.includes("stopped after")) notes.incomplete++;
    if (/failed|error|PANICKED|429/i.test(m) && !/timing .* failed \((busy|already_exited)\)/.test(m)) console.log(`  [api] ${m.slice(0, 260)}`);
  }, { takes: async (id) => byId.get(id) ?? null });
  const server = forkApiServer(service, (m) => { if (m.startsWith("error:")) console.log(`  [api] ${m}`); }, { guard });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", "x-thesis-service-key": serviceKey },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };

  const steps: Record<string, number[]> = {};
  const errors = new Map<string, number>();
  const add = (name: string, ms: number) => (steps[name] ??= []).push(ms);
  const count = (key: string) => errors.set(key, (errors.get(key) ?? 0) + 1);
  const fail = (what: string, r: { status: number; json: any }) => {
    count(`${what}: ${r.status} ${r.json?.error ?? "?"} (${String(r.json?.message ?? "").slice(0, 160)})`);
    return false;
  };
  /** Builds (at the tap), signs, sends until "accepted" and watches it land, as the apps do: a `requote` is built and sent once more. */
  const trade = async (kind: string, kp: Keypair, build: () => Promise<{ status: number; json: any }>): Promise<boolean> => {
    const tap = performance.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const b0 = performance.now();
      const built = await build();
      add(`${kind} build`, performance.now() - b0);
      if (built.status !== 200) return fail(`${kind} build`, built);
      const transactions = built.json.transactions.map((b64: string) => {
        const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
        tx.sign([kp]);
        return Buffer.from(tx.serialize()).toString("base64");
      });
      const s0 = performance.now();
      const sent = await call("POST", "/submit", { buildId: built.json.buildId, transactions, until: "accepted" });
      if (sent.status >= 300) {
        if (sent.json?.requote === true && attempt === 0) {
          count(`${kind}: requote, built again (${String(sent.json?.message ?? "").slice(0, 120)})`);
          continue;
        }
        return fail(`${kind} submit`, sent);
      }
      add(`${kind} accepted`, performance.now() - s0);
      add(`${kind} tap → accepted`, performance.now() - tap);
      const w0 = performance.now();
      const watched = await call("GET", `/submissions/${built.json.buildId}?wait=10000`);
      if (watched.json?.status !== "landed") return fail(`${kind} landing`, { status: watched.status, json: { error: watched.json?.status ?? watched.json?.error, message: watched.json?.error?.message } });
      add(`${kind} landed after accepted`, performance.now() - w0);
      return true;
    }
    return false;
  };

  // Each take on-chain first (its demo author's buy-in), one at a time: real takes are on-chain
  // from their author's post, so the users' first builds shouldn't race to create them.
  const warm = Keypair.generate();
  await call("POST", `/wallets/${warm.publicKey.toBase58()}/deposits`, { usd: 100 });
  for (const t of all) {
    const r = await call("POST", `/takes/${t.id}/trades`, { owner: warm.publicKey.toBase58(), side: "back", usd, prebuild: true });
    const left = r.json?.excluded?.length ? `; left out ${r.json.excluded.map((x: any) => `${x.name} (${x.reason})`).join(", ")}` : "";
    console.log(`take ${t.id.slice(0, 8)} on-chain: ${r.status === 200 ? "yes" : `${r.status} ${r.json?.error}: ${String(r.json?.message).slice(0, 160)}`}${left}`);
  }

  console.log(`\n${users} users, ${k} takes, $${usd}–$${usd * 3} each${rampS ? `, starting over ${rampS} s` : ", all at once"}`);
  const started = performance.now();
  let opened = 0;
  let sales = 0;
  await Promise.all(Array.from({ length: users }, async (_, u) => {
    if (rampS) await sleep((u / users) * rampS * 1000);
    const kp = Keypair.generate();
    const me = kp.publicKey.toBase58();
    const take = all[u % all.length];
    const amount = Math.round((usd + (u % 5) * (usd / 2)) * 100) / 100;
    const dep = await call("POST", `/wallets/${me}/deposits`, { usd: amount * 2 + 20 });
    if (dep.status !== 200) return fail("deposit", dep);
    const side = every && u % 3 === 2 ? "fade" : "back";
    if (!(await trade(side, kp, () => call("POST", `/takes/${take.id}/trades`, { owner: me, side, usd: amount })))) return;
    opened++;
    await sleep(3_000 + (u % 6) * 1_000);
    if (await trade("sale", kp, () => call("POST", `/takes/${take.id}/sell`, { owner: me, side }))) sales++;
    if (every) {
      for (let i = 0; i < 4; i++) {
        const out = await call("POST", `/wallets/${me}/phoenix/cash-out`);
        if (out.json?.done || !out.json?.transactions?.length) break;
        await trade("cash-out", kp, async () => out);
      }
    }
  }));
  const seconds = (performance.now() - started) / 1000;
  server.close();
  service.flush();

  const row = (name: string, xs: number[]) => `${name.padEnd(30)} ${String(xs.length).padStart(4)} ${String(Math.round(pct(xs, 50))).padStart(7)} ${String(Math.round(pct(xs, 90))).padStart(7)} ${String(Math.round(Math.max(...xs))).padStart(7)}`;
  console.log(`\n${"step (ms)".padEnd(30)} ${"n".padStart(4)} ${"p50".padStart(7)} ${"p90".padStart(7)} ${"max".padStart(7)}`);
  for (const [name, xs] of Object.entries(steps)) console.log(row(name, xs));
  console.log(`\nbacks and fades landed ${opened}/${users}, sales landed ${sales}/${users}, in ${seconds.toFixed(0)} s`);
  console.log(`Jupiter: ${(notes.jupiterWaitMs / 1000).toFixed(1)} s waited in all, ${notes.jupiter429} answered 429`);
  if (every) console.log(`Phoenix lock: ${notes.lockWaitMs.length} sends waited, p50 ${Math.round(pct(notes.lockWaitMs, 50))} ms, max ${Math.round(Math.max(0, ...notes.lockWaitMs))} ms`);
  if (notes.incomplete) console.log(`split trades that stopped partway: ${notes.incomplete}`);
  console.log(errors.size ? `errors:\n${[...errors].map(([e, n]) => `  ${n} × ${e}`).join("\n")}` : "errors: none");
}

if (import.meta.main) await main(load);
