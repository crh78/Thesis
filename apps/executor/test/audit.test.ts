import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalJson, MemoryAuditLog, RemoteAuditLog, sourceHash } from "../src/settler/audit.ts";
import { entryBases } from "../src/settler/basis.ts";

// A document shaped like crank.ts builds it, with raw source data full of floats.
const doc = (position = "Pos1", moment = "entry") => ({
  v: 1,
  program: "Prog",
  take: "Take1",
  position,
  moment,
  momentAt: 1_802_562_400,
  legs: [
    {
      leg: 0,
      price: 160.36040635150923,
      priceUnits: "16036040635",
      publishedAt: 1_802_562_403,
      rule: "issuer-token",
      basis: { source: "token", mint: "NVDAx", underlyingPerUiToken: 1, premium: 0.9847, multiplier: 1.001701196801074 },
      inputs: { token: { mint: "NVDAx", response: { usdPrice: 160.36040635150923, liquidity: 2687182.9995351764, scaledUiConfig: { multiplier: 1.0009180758490996, newMultiplierEffectiveAt: "2027-02-20T00:30:00Z" } } }, tiny: 1e-7, big: 1.5e21 },
    },
  ],
});

const hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

test("the hash on chain is sha256 of the canonical text, and the text survives a JSON round trip unchanged", () => {
  const d = doc();
  const canonical = canonicalJson(d);
  assert.equal(sourceHash(d).toString("hex"), hex(canonical));
  // What the price-audit function and verify-prices.ts rely on: parse + re-canonicalize is the identity.
  assert.equal(canonicalJson(JSON.parse(canonical)), canonical);
  // Key order doesn't matter.
  const shuffled = { legs: d.legs, momentAt: d.momentAt, moment: d.moment, position: d.position, take: d.take, program: d.program, v: d.v };
  assert.equal(canonicalJson(shuffled), canonical);
});

type Call = { url: string; init?: RequestInit };
function fakeFetch(respond: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const c = { url: String(url), init };
    calls.push(c);
    return respond(c, calls.length);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const ok = (body: unknown = { stored: 1, duplicate: 0, rejected: [] }) => new Response(JSON.stringify(body), { status: 200 });

test("append writes the local log at once and publishes in the background, with the exact hashed text", async () => {
  const local = new MemoryAuditLog();
  const { fn, calls } = fakeFetch(() => ok());
  const log = new RemoteAuditLog({ url: "https://x/functions/v1/price-audit", token: "t0k", network: "solana-mainnet-fork", local, fetchFn: fn });
  const d = doc();
  const hash = sourceHash(d).toString("hex");
  log.append({ hash, doc: d });
  assert.equal(local.entries.length, 1, "local first, synchronously");
  await log.flush();
  assert.equal(calls.length, 1);
  assert.equal((calls[0].init!.headers as Record<string, string>)["x-audit-token"], "t0k");
  const body = JSON.parse(String(calls[0].init!.body));
  assert.deepEqual(body.entries, [{ hash, canonical: canonicalJson(d), network: "solana-mainnet-fork" }]);
  assert.equal(log.pending, 0);
  assert.equal(log.sent, 1);
});

test("a network outage never throws into the crank: documents wait and go out once the function is back", async () => {
  let down = true;
  const { fn, calls } = fakeFetch(() => {
    if (down) throw new Error("ECONNREFUSED");
    return ok();
  });
  const msgs: string[] = [];
  const log = new RemoteAuditLog({ url: "u", token: "t", fetchFn: fn, retryMs: 5, maxRetryMs: 10, log: (m) => msgs.push(m) });
  for (const p of ["A", "B", "C"]) {
    const d = doc(p);
    assert.doesNotThrow(() => log.append({ hash: sourceHash(d).toString("hex"), doc: d }));
  }
  await log.flush();
  assert.equal(log.pending, 3);
  assert.ok(log.failures >= 1);
  assert.ok(msgs.some((m) => /retrying/.test(m)));
  down = false;
  await new Promise((r) => setTimeout(r, 40)); // the retry timer fires
  await log.flush();
  assert.equal(log.pending, 0);
  assert.equal(log.sent, 3);
  assert.ok(calls.length >= 2);
});

test("an HTTP 500 is retried; permanent rejections are logged, not retried forever", async () => {
  const { fn } = fakeFetch((_c, n) => (n === 1 ? new Response("boom", { status: 500 }) : ok({ stored: 0, duplicate: 0, rejected: [{ hash: "ab", reason: "sha256(canonical) is not the hash" }] })));
  const msgs: string[] = [];
  const log = new RemoteAuditLog({ url: "u", token: "t", fetchFn: fn, retryMs: 5, log: (m) => msgs.push(m) });
  const d = doc();
  log.append({ hash: sourceHash(d).toString("hex"), doc: d });
  await log.flush();
  assert.equal(log.pending, 1);
  await new Promise((r) => setTimeout(r, 30));
  await log.flush();
  assert.equal(log.pending, 0);
  assert.ok(msgs.some((m) => /rejected/.test(m)));
});

test("a document whose hash doesn't match is never published; duplicates are sent once", async () => {
  const { fn, calls } = fakeFetch(() => ok());
  const log = new RemoteAuditLog({ url: "u", token: "t", fetchFn: fn });
  const d = doc();
  log.append({ hash: "0".repeat(64), doc: d });
  const hash = sourceHash(d).toString("hex");
  log.append({ hash, doc: d });
  log.append({ hash, doc: d });
  await log.flush();
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(String(calls[0].init!.body)).entries.length, 1);
});

test("a lost local file: load() reads entry documents back from price_audit, so exits keep their bases", async () => {
  const d = doc("PosX");
  const canonical = canonicalJson(d);
  const hash = hex(canonical);
  const tampered = { ...doc("PosY") };
  const { fn, calls } = fakeFetch((c) => {
    if (c.url.includes("select=hash,canonical")) return ok([{ hash, canonical }, { hash: "f".repeat(64), canonical: canonicalJson(tampered) }]);
    return ok([{ hash }]);
  });
  const log = new RemoteAuditLog({ url: "u", token: "t", fetchFn: fn, network: "solana-mainnet-fork", read: { supabaseUrl: "https://db/", key: "pk", program: "Prog" }, local: new MemoryAuditLog() });
  assert.equal(await log.load(), 1, "the row whose text doesn't hash to its key is ignored");
  assert.ok(calls.every((c) => c.url.startsWith("https://db/rest/v1/price_audit?") && c.url.includes("program=eq.Prog") && c.url.includes("network=eq.solana-mainnet-fork")));
  const bases = entryBases(log.read());
  assert.deepEqual(bases.get("PosX:0"), d.legs[0].basis);
  assert.equal(bases.has("PosY:0"), false);
});

test("backfill() re-sends local documents price_audit doesn't have; read() doesn't double count", async () => {
  const local = new MemoryAuditLog();
  const a = doc("A");
  const b = doc("B");
  local.append({ hash: sourceHash(a).toString("hex"), doc: a });
  local.append({ hash: sourceHash(b).toString("hex"), doc: b });
  const aHash = sourceHash(a).toString("hex");
  const posted: unknown[] = [];
  const { fn } = fakeFetch((c) => {
    if (c.init?.method === "POST") {
      posted.push(...JSON.parse(String(c.init.body)).entries);
      return ok();
    }
    if (c.url.includes("select=hash,canonical")) return ok([{ hash: aHash, canonical: canonicalJson(a) }]);
    return ok([{ hash: aHash }]);
  });
  const log = new RemoteAuditLog({ url: "u", token: "t", fetchFn: fn, local, read: { supabaseUrl: "https://db", key: "pk" } });
  await log.load();
  assert.equal(log.backfill(), 1, "only B is missing remotely");
  await log.flush();
  assert.deepEqual(posted.map((e) => (e as { hash: string }).hash), [sourceHash(b).toString("hex")]);
  assert.equal(log.read().length, 2, "A comes from the local file once, not again from the remote");
});
