// pnpm fork:latency-bench [-- --runs N --usd N --gap S] — how long a back and a sale take, step by
// step, against the one fork. `--gap S`: wait S seconds between the back landing and the sale, as
// a user would (a back's sell routes are seeded in that time, so the sale should make no quote).
//
// Starts the fork API in-process on a spare port with the abuse limits in front (a service key it
// makes up for the run, as the X agent would use), then per run: a throwaway wallet (a local
// keypair, no profile) gets cash, backs a take made up for the run (it never reaches Supabase, so
// no feed or board shows it), and sells the position. As in the apps, the back is prebuilt and
// refreshed, and both are submitted until "accepted", then watched on /submissions until they
// land. It times each request from here, reads each response's Server-Timing (where the server's
// time went), and prints p50 and p90.
//
// Never moves the fork's clock. Each run costs a few Jupiter calls per leg (quotes, swap
// instructions), so keep --runs small: the free Jupiter key is shared with the live API.
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { TAKE_LIFETIME_SECS } from "@thesis/chain";
import { Guard } from "./api/guard.ts";
import { forkApiServer } from "./api/server.ts";
import type { AppTake } from "./api/service.ts";
import { startForkService } from "./api.ts";
import { main, numberFlag, parseArgs, syncClock } from "./lib.ts";

/** Two Phoenix-listed stocks, bought on Jupiter (the api-e2e take's first legs). */
const TAKE: AppTake = {
  id: randomUUID(),
  claim: "Latency bench: chips and cloud",
  risk: "medium",
  settles_at: new Date(Date.now() + TAKE_LIFETIME_SECS * 1000).toISOString(),
  author: { handle: "latency-bench" },
  legs: [
    { name: "NVIDIA", kind: "Stock", weight: 60, fade_how: "Bets the stock falls", asset_id: "jup:Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" },
    { name: "Microsoft", kind: "Stock", weight: 40, fade_how: "Bets the stock falls", asset_id: "jup:XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX" },
  ],
};

/** Nearest-rank percentile of `xs` (ms). */
function percentile(xs: number[], p: number): number {
  if (!xs.length) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** `name;dur=12, other;desc="x"` → { name: 12 } (durations only). */
function parseServerTiming(header: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (header ?? "").split(",")) {
    const [name, ...params] = part.trim().split(";");
    const dur = params.map((p) => p.trim()).find((p) => p.startsWith("dur="));
    if (name && dur) out[name] = Number(dur.slice(4));
  }
  return out;
}

async function bench(): Promise<void> {
  const { flags } = parseArgs();
  const runs = numberFlag(flags, "runs", 5);
  const usd = numberFlag(flags, "usd", 20);
  const gapS = numberFlag(flags, "gap", 0);
  const lead = await syncClock();
  if (lead > 120) throw new Error(`The fork's clock is ${lead}s ahead of real time: restart the fork.`);

  const serviceKey = randomBytes(24).toString("hex");
  const guard = new Guard({ auth: "enforce", readLimit: "enforce", serviceKeys: new Map([["bench", serviceKey]]), proxyKey: null, privy: null, busyFile: null });
  const service = await startForkService((m) => console.log(`  [api] ${m}`), { takes: async (id) => (id === TAKE.id ? TAKE : null) });
  // Only the server's errors (an internal error's stack goes to the log, not the answer).
  const server = forkApiServer(service, (m) => { if (m.startsWith("error:")) console.log(`  [api] ${m}`); }, { guard });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** Client-side milliseconds per step, and the server's own steps per request kind. */
  const client: Record<string, number[]> = {};
  const serverSteps: Record<string, Record<string, number[]>> = {};
  const record = (name: string, ms: number, timing?: Record<string, number>) => {
    (client[name] ??= []).push(ms);
    for (const [step, d] of Object.entries(timing ?? {})) ((serverSteps[name] ??= {})[step] ??= []).push(d);
  };
  /** Prebuilds the Jupiter budget turned away (503 busy) and retried after Retry-After, as the apps do. */
  let busyRetries = 0;
  const call = async (method: string, path: string, body?: unknown, name?: string) => {
    let started = performance.now();
    let r: Response;
    let json: any;
    for (let attempt = 0; ; attempt++) {
      started = performance.now();
      r = await fetch(base + path, {
        method,
        headers: { "content-type": "application/json", "x-thesis-service-key": serviceKey },
        body: body ? JSON.stringify(body) : undefined,
      });
      json = (await r.json()) as any;
      const prebuild = Boolean((body as { prebuild?: boolean } | undefined)?.prebuild);
      if (!(prebuild && r.status === 503 && json?.error === "busy" && attempt < 4)) break;
      busyRetries++;
      await new Promise((resolve) => setTimeout(resolve, Math.min(15, Number(r.headers.get("retry-after")) || 5) * 1_000));
    }
    const ms = performance.now() - started;
    if (name && r.ok) record(name, ms, parseServerTiming(r.headers.get("server-timing")));
    return { status: r.status, json, ms };
  };
  const ok = <T extends { status: number; json: any }>(what: string, r: T): T => {
    if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`);
    return r;
  };
  const sign = (transactions: string[], kp: Keypair) =>
    transactions.map((b64) => {
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
      tx.sign([kp]);
      return Buffer.from(tx.serialize()).toString("base64");
    });

  /**
   * Submits until=accepted (as the apps do): times the answer ("accepted"), then the status watch
   * until it landed ("confirm", from the answer). A repeat must answer the same submit.
   */
  const accepted = async (what: string, build: { buildId: string; transactions: string[] }, kp: Keypair) => {
    const transactions = sign(build.transactions, kp);
    const r = ok(`${what} submit`, await call("POST", "/submit", { buildId: build.buildId, transactions, until: "accepted", timings: { bench: 0 } }, `${what} accepted`));
    if (r.status !== 202 && r.json.status !== "landed") throw new Error(`${what} submit: expected 202 pending, got ${r.status} ${JSON.stringify(r.json)}`);
    const started = performance.now();
    const watched = ok(`${what} status`, await call("GET", `/submissions/${build.buildId}?wait=10000`));
    if (watched.json.status !== "landed") throw new Error(`${what}: ${JSON.stringify(watched.json)}`);
    record(`${what} confirm`, performance.now() - started);
    const repeat = await call("POST", "/submit", { buildId: build.buildId, transactions, until: "accepted" });
    if (repeat.status !== 200 || repeat.json.status !== "landed") throw new Error(`${what} repeat: ${repeat.status} ${JSON.stringify(repeat.json)}`);
  };

  try {
    for (let run = 1; run <= runs; run++) {
      const user = Keypair.generate();
      const me = user.publicKey.toBase58();
      ok("deposit", await call("POST", `/wallets/${me}/deposits`, { usd: usd * 2 }));

      // As the apps do: build when the sheet opens (prebuild), refresh it before it expires, tap.
      const built = ok("back build", await call("POST", `/takes/${TAKE.id}/trades`, { owner: me, side: "back", usd, prebuild: true }, "back build"));
      if (typeof built.json.expiresAt !== "number" || typeof built.json.quotedAt !== "number") throw new Error(`back build: no expiresAt/quotedAt in ${JSON.stringify(built.json)}`);
      const refreshed = ok("back refresh", await call("POST", `/builds/${built.json.buildId}/refresh`, undefined, "back refresh"));
      if (refreshed.json.buildId !== built.json.buildId || refreshed.json.quotedAt !== built.json.quotedAt) throw new Error(`back refresh: ${JSON.stringify(refreshed.json)}`);
      // The transactions answered before the refresh can't be sent any more.
      // The set a refresh replaced stays good until the first submit (a tap during a refresh); bytes
      // from two refreshes back are refused.
      const again = ok("back refresh", await call("POST", `/builds/${built.json.buildId}/refresh`, undefined, "back refresh"));
      // (Only when the blockhash moved: refreshes within one blockhash answer the same bytes.)
      if (JSON.stringify(again.json.transactions) !== JSON.stringify(built.json.transactions) && JSON.stringify(refreshed.json.transactions) !== JSON.stringify(built.json.transactions)) {
        const stale = await call("POST", "/submit", { buildId: built.json.buildId, transactions: sign(built.json.transactions, user), until: "accepted" });
        if (stale.status !== 400 || stale.json.error !== "transaction_changed") throw new Error(`stale submit: ${stale.status} ${JSON.stringify(stale.json)}`);
      }
      await accepted("back", again.json, user);

      const receipt = ok("receipt", await call("GET", `/takes/${TAKE.id}?viewer=${me}`));
      const mine = receipt.json.viewerPositions?.find((p: any) => !p.exited);
      if (!mine) throw new Error("the back isn't on the receipt");
      // A user's pause before selling: the back's sell routes are seeded meanwhile (routing.ts seedSells).
      if (gapS > 0) await new Promise((resolve) => setTimeout(resolve, gapS * 1_000));
      // The Sell sheet builds ahead too: prebuilt, refreshed, submitted; then a second sale is refused.
      const sale = ok("sale build", await call("POST", `/takes/${TAKE.id}/positions/${mine.address}/exit`, { owner: me, prebuild: true }, "sale build"));
      const saleFresh = ok("sale refresh", await call("POST", `/builds/${sale.json.buildId}/refresh`, undefined, "sale refresh"));
      await accepted("sale", saleFresh.json, user);
      const twice = await call("POST", `/takes/${TAKE.id}/positions/${mine.address}/exit`, { owner: me });
      if (twice.status !== 409 || twice.json.error !== "already_exited") throw new Error(`a second sale: ${twice.status} ${JSON.stringify(twice.json)}`);
      const last = (k: string) => client[k].at(-1)!.toFixed(0);
      const quotes = serverSteps["sale build"]?.quotes?.at(-1);
      console.log(`run ${run}/${runs}${gapS ? ` (sale ${gapS} s after the back)` : ""}: back build ${last("back build")} ms, accepted ${last("back accepted")} ms, landed +${last("back confirm")} ms; sale build ${last("sale build")} ms, accepted ${last("sale accepted")} ms, landed +${last("sale confirm")} ms${quotes !== undefined ? ` (its quotes step ${quotes.toFixed(0)} ms)` : ""}`);
    }
  } finally {
    server.close();
    service.flush();
  }

  const row = (name: string, xs: number[]) => `${name.padEnd(28)} ${String(Math.round(percentile(xs, 50))).padStart(6)} ${String(Math.round(percentile(xs, 90))).padStart(6)}`;
  console.log(`\n${"step (ms, from here)".padEnd(28)} ${"p50".padStart(6)} ${"p90".padStart(6)}`);
  for (const [name, xs] of Object.entries(client)) {
    console.log(row(name, xs));
    for (const [step, ds] of Object.entries(serverSteps[name] ?? {})) console.log(row(`  ${step}`, ds));
  }
  if (busyRetries) console.log(`\n${busyRetries} prebuild(s) answered 503 busy and were retried after Retry-After (timed from the try that worked).`);
}

if (import.meta.main) await main(bench);
