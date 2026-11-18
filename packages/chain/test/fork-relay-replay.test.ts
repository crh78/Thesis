// The fork relay's delivery queue (infra/quicknode/fork-relay.ts `Relay`): back-fill since the
// last transaction it handled, order, retries with backoff, skips and the queue cap. A fake RPC
// and webhook serve recorded fork transactions; nothing touches the network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  Relay,
  loadFilter,
  signaturesSince,
  type LogsNotification,
  type PostResult,
  type RpcCall,
  type RpcTransaction,
  type SignatureInfo,
} from "../../../infra/quicknode/fork-relay.ts";

const filter = loadFilter();
const { recordings } = JSON.parse(readFileSync(join(import.meta.dirname, "../../../infra/quicknode/fixtures/fork-logs-notifications.json"), "utf8")) as {
  recordings: { notification: LogsNotification; transaction: RpcTransaction }[];
};

/** A recorded transaction under another signature and slot. */
function txAs(signature: string, slot: number): RpcTransaction {
  const base = structuredClone(recordings[0].transaction);
  return { ...base, slot, transaction: { ...base.transaction, signatures: [signature] } };
}

/** A fake chain: the program's transactions in order, oldest first. */
function chain(sigs: string[], failed = new Set<string>()) {
  const txs = new Map(sigs.map((s, i) => [s, txAs(s, 100 + i)]));
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc = (async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    if (method === "getTransaction") {
      const tx = txs.get(params[0] as string) ?? null;
      return tx && failed.has(tx.transaction.signatures[0]) ? { ...tx, meta: { ...tx.meta, err: { InstructionError: [0, "Custom"] } } } : tx;
    }
    if (method === "getSignaturesForAddress") {
      const o = params[1] as { until?: string; before?: string; limit: number };
      const newestFirst: SignatureInfo[] = sigs.map((s, i) => ({ signature: s, slot: 100 + i, err: failed.has(s) ? {} : null })).reverse();
      let from = 0;
      if (o.before) from = newestFirst.findIndex((x) => x.signature === o.before) + 1;
      const out: SignatureInfo[] = [];
      for (const x of newestFirst.slice(from)) {
        if (x.signature === o.until || out.length >= o.limit) break;
        out.push(x);
      }
      return out;
    }
    throw new Error(`unexpected ${method}`);
  }) as RpcCall;
  return { rpc, calls, txs };
}

const signatureOf = (payload: unknown) => (payload as { transactions: { signature: string }[] }).transactions[0].signature;
const note = (signature: string, slot: number, err: unknown = null): LogsNotification => ({ context: { slot }, value: { signature, err, logs: [] } });
const memoryState = (last: string | null = null) => {
  const saved: string[] = [];
  return { saved, state: { last: () => saved.at(-1) ?? last, save: (s: string) => void saved.push(s) } };
};
const quiet = { log: () => {}, error: () => {} };

test("signaturesSince pages newest-first results back into oldest-first order, up to a cap", async () => {
  const sigs = Array.from({ length: 2500 }, (_, i) => `s${i}`);
  const { rpc, calls } = chain(sigs);
  const all = await signaturesSince(rpc, "P", "s99", 10_000);
  assert.equal(all.truncated, false);
  assert.equal(all.signatures.length, 2400);
  assert.equal(all.signatures[0].signature, "s100");
  assert.equal(all.signatures.at(-1)!.signature, "s2499");
  assert.equal(calls.length, 3, "1000 + 1000 + 400");
  const capped = await signaturesSince(rpc, "P", "s99", 1000);
  assert.equal(capped.truncated, true);
  assert.equal(capped.signatures[0].signature, "s1500", "the newest 1000");
});

test("on start, everything since the saved signature is delivered in order before live ones, and the state follows", async () => {
  const sigs = ["a", "b", "c", "d", "e", "f"];
  const { rpc } = chain(sigs, new Set(["d"]));
  const delivered: string[] = [];
  const { saved, state } = memoryState("b");
  const relay = new Relay({ filter, rpc, state, post: async (p) => (delivered.push(signatureOf(p)), { ok: true }), sleep: async () => {}, ...quiet });
  relay.backfill();
  relay.notify(note("e", 104)); // also in the back-fill: delivered once
  relay.notify(note("f", 105));
  await relay.drained();
  assert.deepEqual(delivered, ["c", "e", "f"], "d failed on chain: skipped, not delivered");
  assert.deepEqual(saved, ["c", "d", "e", "f"]);
});

test("with no state, the first start sets a starting point instead of replaying history", async () => {
  const { rpc } = chain(["a", "b", "c"]);
  const delivered: string[] = [];
  const { saved, state } = memoryState(null);
  const relay = new Relay({ filter, rpc, state, post: async (p) => (delivered.push(signatureOf(p)), { ok: true }), sleep: async () => {}, ...quiet });
  relay.backfill();
  await relay.drained();
  assert.deepEqual(delivered, []);
  assert.deepEqual(saved, ["c"]);
});

test("a failing webhook is retried with backoff, in order, not dropped after three tries", async () => {
  const { rpc } = chain(["a", "b"]);
  const results: PostResult[] = [
    { ok: false, status: 503, detail: "down" },
    { ok: false, status: null, detail: "timeout" },
    { ok: false, status: 500, detail: "" },
    { ok: false, status: 429, detail: "" },
    { ok: true },
  ];
  const posts: string[] = [];
  const waits: number[] = [];
  const errors: string[] = [];
  const { saved, state } = memoryState("x");
  const relay = new Relay({
    filter, rpc, state,
    post: async (p) => (posts.push(signatureOf(p)), results.shift() ?? { ok: true }),
    sleep: async (ms) => void waits.push(ms),
    log: () => {},
    error: (l) => errors.push(l),
  });
  relay.notify(note("a", 100));
  relay.notify(note("b", 101));
  await relay.drained();
  assert.deepEqual(posts, ["a", "a", "a", "a", "a", "b"]);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000]);
  assert.ok(errors.some((l) => /a: HTTP 500; retry 3/.test(l)), "loud from the third retry on");
  assert.deepEqual(saved, ["a", "b"]);
});

test("a permanent rejection is skipped at once; anything else after giveUpMs, loudly", async () => {
  const { rpc } = chain(["a", "b"]);
  let now = 0;
  const errors: string[] = [];
  const posts: string[] = [];
  const relay = new Relay({
    filter, rpc, state: memoryState("x").state,
    post: async (p) => (posts.push(signatureOf(p)), signatureOf(p) === "a" ? { ok: false, status: 400, detail: "bad payload" } : { ok: false, status: 502, detail: "" }),
    sleep: async (ms) => void (now += ms),
    now: () => now,
    giveUpMs: 10_000,
    log: () => {},
    error: (l) => errors.push(l),
  });
  relay.notify(note("a", 100));
  relay.notify(note("b", 101));
  await relay.drained();
  assert.equal(posts.filter((s) => s === "a").length, 1);
  assert.match(errors[0], /a: the webhook rejected it \(HTTP 400\): skipped/);
  assert.ok(errors.some((l) => /b: not delivered after 0 min \(HTTP 502\): skipped/.test(l)));
});

test("past the queue cap new transactions are dropped, then back-filled once it drains", async () => {
  const sigs = ["a", "b", "c", "d"];
  const { rpc } = chain(sigs);
  const delivered: string[] = [];
  const errors: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const relay = new Relay({
    filter, rpc, state: memoryState("x0").state, maxQueue: 1,
    post: async (p) => {
      await gate;
      delivered.push(signatureOf(p));
      return { ok: true };
    },
    sleep: async () => {},
    log: () => {},
    error: (l) => errors.push(l),
  });
  relay.notify(note("a", 100)); // taken off the queue at once and waiting on the gate
  await new Promise((r) => setTimeout(r, 10));
  relay.notify(note("b", 101)); // queued
  relay.notify(note("c", 102)); // over the cap
  relay.notify(note("d", 103));
  release();
  await relay.drained();
  assert.equal(errors.filter((l) => /queue full/.test(l)).length, 1);
  assert.deepEqual(delivered, ["a", "b", "c", "d"], "c and d came back through the back-fill, in order");
});

test("a live notification of a failed transaction is skipped without fetching it", async () => {
  const { rpc, calls } = chain(["a"]);
  const relay = new Relay({ filter, rpc, state: memoryState("x").state, post: async () => ({ ok: true }), sleep: async () => {}, ...quiet });
  relay.notify(note("a", 100, { InstructionError: [0, "Custom"] }));
  await relay.drained();
  assert.equal(calls.length, 0);
});
