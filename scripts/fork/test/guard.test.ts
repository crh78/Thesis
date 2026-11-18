import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ApiError } from "../api/common.ts";
import { BUSY_EVERY_MS, BuildGate, Guard, parseServiceKeys, verifyPrivyToken, type GuardOptions } from "../api/guard.ts";
import { CORS, corsHeaders, forkApiServer, parseCorsOrigins } from "../api/server.ts";
import type { ForkService } from "../api/service.ts";

const APP = "privy-app";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const WALLET = "Wa11et1111111111111111111111111111111111111";
const OTHER = "0ther11111111111111111111111111111111111111";
const SERVICE = "agent-secret-0123456789";

function jwt(payload: Record<string, unknown>, key: KeyObject = privateKey, alg = "ES256") {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg, typ: "JWT" })}.${enc(payload)}`;
  const sig = sign("sha256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${body}.${sig}`;
}
const NOW = 1_800_000_000_000;
const token = (sub = "did:privy:me", extra: Record<string, unknown> = {}) =>
  jwt({ iss: "privy.io", aud: APP, sub, exp: NOW / 1000 + 3600, ...extra });

const req = (headers: Record<string, string> = {}, remoteAddress = "203.0.113.9") =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

function guard(o: Partial<GuardOptions> = {}) {
  const logs: string[] = [];
  let now = NOW;
  let lookups = 0;
  const g = new Guard({
    auth: "enforce",
    readLimit: "enforce",
    serviceKeys: parseServiceKeys(`agent=${SERVICE}`),
    proxyKey: "proxy-secret-0123456789",
    privy: { appId: APP, verificationKey: PEM.replace(/\n/g, "\\n"), appSecret: "s" },
    log: (m) => logs.push(m),
    now: () => now,
    fetch: (async (url: string) => {
      lookups++;
      const did = decodeURIComponent(String(url).split("/").at(-1)!);
      const wallet = did === "did:privy:me" ? WALLET : did === "did:privy:other" ? OTHER : null;
      return new Response(JSON.stringify({
        linked_accounts: wallet ? [
          { type: "wallet", chain_type: "ethereum", wallet_client_type: "privy", address: "0xabc" },
          { type: "wallet", chain_type: "solana", wallet_client_type: "privy", wallet_index: 0, address: wallet },
        ] : [],
      }));
    }) as typeof fetch,
    ...o,
  });
  return { g, logs, tick: (ms: number) => (now += ms), lookups: () => lookups };
}

const rejects = async (p: Promise<unknown>, status: number, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof ApiError && e.status === status && e.code === code);
};

test("Privy tokens: signature, issuer, audience and expiry are checked", () => {
  assert.equal(verifyPrivyToken(token(), publicKey, APP, NOW), "did:privy:me");
  assert.equal(verifyPrivyToken(jwt({ iss: "privy.io", aud: [APP], sub: "d", exp: NOW / 1000 + 5 }), publicKey, APP, NOW), "d");
  assert.equal(verifyPrivyToken(token("did:privy:me", { aud: "other-app" }), publicKey, APP, NOW), null);
  assert.equal(verifyPrivyToken(token("did:privy:me", { iss: "evil" }), publicKey, APP, NOW), null);
  assert.equal(verifyPrivyToken(token("did:privy:me", { exp: NOW / 1000 - 1 }), publicKey, APP, NOW), null);
  const stranger = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  assert.equal(verifyPrivyToken(jwt({ iss: "privy.io", aud: APP, sub: "x", exp: NOW / 1000 + 60 }, stranger), publicKey, APP, NOW), null);
  assert.equal(verifyPrivyToken("not.a.jwt", publicKey, APP, NOW), null);
});

test("enforce: a money route needs the wallet's own token or a service key", async () => {
  const { g, lookups } = guard();
  await rejects(g.checkMoney(req(), WALLET, "trades"), 401, "unauthorized");
  await rejects(g.checkMoney(req({ authorization: "Bearer junk" }), WALLET, "trades"), 401, "unauthorized");
  await rejects(g.checkMoney(req({ authorization: `Bearer ${token("did:privy:other")}` }), WALLET, "trades"), 403, "wrong_wallet");
  assert.deepEqual(await g.checkMoney(req({ authorization: `Bearer ${token()}` }), WALLET, "trades"), { wallet: WALLET, via: "token" });
  await g.checkMoney(req({ authorization: `Bearer ${token()}` }), WALLET, "trades");
  assert.equal(lookups(), 2, "the wallet lookup is cached per user (me, other)");
  assert.deepEqual(await g.checkMoney(req({ "x-thesis-service-key": SERVICE }), OTHER, "trades"), { wallet: OTHER, via: "service", name: "agent" });
  await rejects(g.checkMoney(req({ "x-thesis-service-key": "agent-secret-wrong-guess" }), OTHER, "trades"), 401, "unauthorized");
});

test("report: a missing token is logged, and the request is served", async () => {
  const { g, logs } = guard({ auth: "report" });
  assert.equal((await g.checkMoney(req(), WALLET, "deposit")).via, "unverified");
  await g.checkMoney(req(), WALLET, "deposit");
  assert.equal(logs.filter((l) => l.includes("auth (report only)")).length, 1, "logged once a minute per wallet and route");
});

test("POST /digests needs a service key in every auth mode", () => {
  for (const auth of ["off", "report", "enforce"] as const) {
    const { g } = guard({ auth });
    assert.throws(() => g.checkServiceOnly(req(), "POST /digests"), (e: unknown) => e instanceof ApiError && e.status === 401 && e.code === "service_key_required", auth);
    assert.doesNotThrow(() => g.checkServiceOnly(req({ "x-thesis-service-key": SERVICE }), "POST /digests"), auth);
  }
});

test("money: 10 a minute and 100 a day per wallet, with Retry-After", async () => {
  const { g, tick } = guard();
  const me = req({ authorization: `Bearer ${token()}` });
  for (let i = 0; i < 10; i++) await g.checkMoney(me, WALLET, "trades");
  await assert.rejects(g.checkMoney(me, WALLET, "trades"), (e: unknown) =>
    e instanceof ApiError && e.status === 429 && Number(e.headers?.["retry-after"]) === 60);
  // Another wallet has its own allowance.
  await g.checkMoney(req({ "x-thesis-service-key": SERVICE }), OTHER, "trades");
  for (let i = 0; i < 9; i++) {
    tick(61_000);
    for (let j = 0; j < 10; j++) await g.checkMoney(me, WALLET, "trades");
  }
  tick(61_000);
  await assert.rejects(g.checkMoney(me, WALLET, "trades"), (e: unknown) => e instanceof ApiError && e.status === 429 && /today/.test(e.message));
  tick(24 * 3600_000);
  // A day later there's room again (the token has expired by now; the service key acts for it).
  await g.checkMoney(req({ "x-thesis-service-key": SERVICE }), WALLET, "trades");
});

test("report mode: unverified callers can't use up someone else's allowance", async () => {
  const { g } = guard({ auth: "report" });
  for (let i = 0; i < 10; i++) await g.checkMoney(req({}, "198.51.100.1"), WALLET, "trades");
  await rejects(g.checkMoney(req({}, "198.51.100.1"), WALLET, "trades"), 429, "rate_limited");
  await g.checkMoney(req({}, "198.51.100.2"), WALLET, "trades");
  await g.checkMoney(req({ authorization: `Bearer ${token()}` }), WALLET, "trades");
});

test("reads: 120 a minute per IP; the web proxy's visitor IP counts only with its key", () => {
  const { g, tick } = guard();
  const viaFunnel = (ip: string, extra: Record<string, string> = {}) => req({ "x-forwarded-for": `1.1.1.1, ${ip}`, ...extra }, "127.0.0.1");
  assert.equal(g.clientIp(viaFunnel("192.0.2.7")), "192.0.2.7", "the last X-Forwarded-For entry, which Funnel adds");
  assert.equal(g.clientIp(viaFunnel("192.0.2.7", { "x-thesis-client-ip": "10.9.9.9" })), "192.0.2.7", "no key: the claimed IP is ignored");
  assert.equal(g.clientIp(viaFunnel("192.0.2.7", { "x-thesis-client-ip": "10.9.9.9", "x-thesis-proxy-key": "proxy-secret-0123456789" })), "client:10.9.9.9");
  for (let i = 0; i < 120; i++) g.checkRead(viaFunnel("192.0.2.7"));
  assert.throws(() => g.checkRead(viaFunnel("192.0.2.7")), (e: unknown) => e instanceof ApiError && e.status === 429);
  g.checkRead(viaFunnel("192.0.2.8"));
  g.checkRead(req({ "x-thesis-service-key": SERVICE }, "127.0.0.1"));
  tick(60_001);
  g.checkRead(viaFunnel("192.0.2.7"));
});

test("reads in report mode are logged, not refused", () => {
  const { g, logs } = guard({ readLimit: "report" });
  for (let i = 0; i < 125; i++) g.checkRead(req());
  assert.equal(logs.filter((l) => l.includes("read limit (report only)")).length, 1);
});

test("builds signal busy (for the asset bank's probes) when let in or queued, and while they last", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let marks = 0;
  const gate = new BuildGate(1, 2, undefined, () => marks++);
  const release: (() => void)[] = [];
  const work = () => gate.run(() => new Promise<void>((r) => release.push(r)));
  const a = work();
  assert.equal(marks, 1, "let in");
  const b = work();
  await new Promise((r) => setImmediate(r));
  assert.equal(marks, 2, "queued");
  t.mock.timers.tick(BUSY_EVERY_MS);
  assert.equal(marks, 3, "again while they last");
  release.shift()!();
  await a;
  await new Promise((r) => setImmediate(r));
  release.shift()!();
  await b;
  assert.equal(gate.busy, false);
  t.mock.timers.tick(BUSY_EVERY_MS);
  const after = marks;
  t.mock.timers.tick(3 * BUSY_EVERY_MS);
  assert.equal(marks, after, "quiet once nothing runs or waits");
});

test("builds: a few at once, a short queue, then 503 busy with Retry-After", async () => {
  const gate = new BuildGate(2, 1);
  const release: (() => void)[] = [];
  const work = () => gate.run(() => new Promise<string>((r) => release.push(() => r("done"))));
  const a = work();
  const b = work();
  const c = work();
  await new Promise((r) => setImmediate(r));
  assert.equal(release.length, 2, "two run, one waits");
  await assert.rejects(work(), (e: unknown) => e instanceof ApiError && e.status === 503 && e.code === "busy" && Number(e.headers?.["retry-after"]) >= 1);
  release.shift()!();
  assert.equal(await a, "done");
  await new Promise((r) => setImmediate(r));
  assert.equal(release.length, 2, "the waiting build took the free slot");
  for (const r of release.splice(0)) r();
  assert.deepEqual(await Promise.all([b, c]), ["done", "done"]);
});

test("server: withdrawals are off, money routes go through the guard, errors carry Retry-After", async (t) => {
  const deposits: unknown[][] = [];
  const service = {
    deposit: async (...args: unknown[]) => (deposits.push(args), { usdc: 10 }),
    wallet: async () => ({ usdc: 0 }),
    publicConfig: async () => ({}),
  } as unknown as ForkService;
  const { g } = guard({ limits: { moneyPerMinute: 1 } });
  const server = forkApiServer(service, () => {}, { guard: g });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ usd: 10 }) });

  assert.equal((await post(`/wallets/${WALLET}/withdrawals`, { "x-thesis-service-key": SERVICE })).status, 403);
  assert.equal((await post(`/wallets/${WALLET}/deposits`)).status, 401);
  assert.equal(deposits.length, 0);
  // The guard's clock is fixed in the past for the token; a service key acts for the wallet.
  assert.equal((await post(`/wallets/${WALLET}/deposits`, { "x-thesis-service-key": SERVICE })).status, 200);
  const limited = await post(`/wallets/${WALLET}/deposits`, { "x-thesis-service-key": SERVICE });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(deposits.length, 1);
  assert.equal((await fetch(`${url}/health`)).status, 200);
});

test("report marks are swept once they're older than a minute", async () => {
  const { g, logs, tick } = guard({ auth: "report" });
  await g.checkMoney(req(), WALLET, "trades");
  assert.equal(g.reportedKeys, 1);
  assert.equal(logs.filter((l) => l.startsWith("auth (report only)")).length, 1);
  tick(30_000);
  g.sweep();
  assert.equal(g.reportedKeys, 1, "still within its minute");
  tick(31_000);
  g.sweep();
  assert.equal(g.reportedKeys, 0);
});

test("server: a money route checks the wallet is an address before the guard; 500s don't leak details", async (t) => {
  const deposits: unknown[][] = [];
  const service = {
    deposit: async (...args: unknown[]) => (deposits.push(args), { usdc: 10 }),
    wallet: async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.7:18899 (internal)");
    },
    publicConfig: async () => ({}),
  } as unknown as ForkService;
  const { g } = guard({ auth: "report" });
  const logs: string[] = [];
  const server = forkApiServer(service, (m) => logs.push(m), { guard: g });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const junk = "x".repeat(2_000);
  const r = await fetch(`${url}/wallets/${junk}/deposits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usd: 10 }) });
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { error: string }).error, "invalid_wallet");
  assert.equal(g.reportedKeys, 0, "the guard never saw it");
  assert.equal(deposits.length, 0);

  const failed = await fetch(`${url}/wallets/${WALLET}`);
  assert.equal(failed.status, 500);
  const body = (await failed.json()) as { error: string; message: string };
  assert.equal(body.error, "internal");
  assert.ok(!body.message.includes("ECONNREFUSED"), "the message is generic");
  assert.ok(logs.some((l) => l.includes("ECONNREFUSED")), "the details are logged");
});

test("reads: counted per Privy user with a valid token, per IP without one", () => {
  const { g, tick } = guard();
  const shared = (headers: Record<string, string> = {}) => req({ "x-forwarded-for": "192.0.2.50", ...headers }, "127.0.0.1");
  const me = { authorization: `Bearer ${token("did:privy:me")}` };
  const other = { authorization: `Bearer ${token("did:privy:other")}` };
  assert.equal(g.readKey(shared(me)), "user:did:privy:me");
  assert.equal(g.readKey(shared({ authorization: "Bearer not-a-token" })), "192.0.2.50", "an invalid token counts per IP");
  for (let i = 0; i < 120; i++) g.checkRead(shared(me));
  assert.throws(() => g.checkRead(shared(me)), (e: unknown) => e instanceof ApiError && e.status === 429);
  // Someone else behind the same IP, signed in or not, has their own allowance.
  g.checkRead(shared(other));
  g.checkRead(shared());
  tick(60_001);
  g.checkRead(shared(me));
});

test("verified tokens are cached for a minute, never past their expiry, and swept", async () => {
  const { g, tick, lookups } = guard();
  const short = token("did:privy:me", { exp: NOW / 1000 + 30 });
  const r = () => req({ authorization: `Bearer ${short}` });
  g.checkRead(r());
  g.checkRead(r());
  assert.equal(g.cachedTokens, 1, "verified once");
  // The money route uses the same cache (and its wallet lookup).
  await g.checkMoney(r(), WALLET, "trades");
  assert.equal(g.cachedTokens, 1);
  assert.equal(lookups(), 1);
  tick(31_000);
  assert.equal(g.readKey(r()), "203.0.113.9", "expired: no longer trusted, from the cache or otherwise");
  g.sweep();
  assert.equal(g.cachedTokens, 0);
});

test("CORS: allowed origins get the headers and a 204 preflight; others and unset get none", async (t) => {
  assert.deepEqual([...parseCorsOrigins(" https://yourthesis.xyz, https://www.yourthesis.xyz/ ")], ["https://yourthesis.xyz", "https://www.yourthesis.xyz"]);
  assert.equal(parseCorsOrigins(undefined).size, 0);
  assert.throws(() => parseCorsOrigins("https://yourthesis.xyz/app"), /just an origin/);
  assert.throws(() => parseCorsOrigins("*"), /isn't an origin/);
  assert.deepEqual(corsHeaders(new Set(), "https://yourthesis.xyz"), {});

  const service = { wallet: async () => ({ usdc: 0 }), publicConfig: async () => ({}) } as unknown as ForkService;
  const { g } = guard({ limits: { readsPerMinute: 1 } });
  const start = async (cors?: Set<string>) => {
    const server = forkApiServer(service, () => {}, { guard: g, cors });
    server.listen(0, "127.0.0.1");
    t.after(() => server.close());
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const url = await start(parseCorsOrigins("https://yourthesis.xyz"));
  const preflight = await fetch(`${url}/wallets/${WALLET}`, {
    method: "OPTIONS",
    headers: { origin: "https://yourthesis.xyz", "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://yourthesis.xyz");
  assert.equal(preflight.headers.get("access-control-allow-methods"), CORS.methods);
  assert.equal(preflight.headers.get("access-control-allow-headers"), "authorization, content-type, x-thesis-wallet-auth");
  assert.equal(preflight.headers.get("access-control-max-age"), "600");
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null, "no credentials mode");
  assert.equal(preflight.headers.get("vary"), "Origin");
  // Preflights aren't reads: the one read allowed is still there.
  const read = await fetch(`${url}/wallets/${WALLET}`, { headers: { origin: "https://yourthesis.xyz" } });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("access-control-allow-origin"), "https://yourthesis.xyz");
  assert.equal(read.headers.get("access-control-expose-headers"), "retry-after");
  // Errors carry the headers too, so the browser can read a 429's Retry-After.
  const limited = await fetch(`${url}/wallets/${WALLET}`, { headers: { origin: "https://yourthesis.xyz" } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("access-control-allow-origin"), "https://yourthesis.xyz");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);

  const stranger = await fetch(`${url}/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(stranger.headers.get("access-control-allow-origin"), null);
  assert.equal(stranger.headers.get("vary"), "Origin");
  assert.equal((await fetch(`${url}/health`, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status, 404);

  const off = await start();
  const plain = await fetch(`${off}/health`, { headers: { origin: "https://yourthesis.xyz" } });
  assert.equal(plain.headers.get("access-control-allow-origin"), null);
  assert.equal(plain.headers.get("vary"), null, "unset: today's behaviour");
  assert.equal((await fetch(`${off}/health`, { method: "OPTIONS", headers: { origin: "https://yourthesis.xyz" } })).status, 404);
});

test("server: an incomplete split trade answers 422 with its sweep hint; retry and sweep are money routes", async (t) => {
  const calls: unknown[][] = [];
  const incomplete = { position: "P", next: "retry" };
  const service = {
    submit: async () => {
      const e = new ApiError(422, "trade_incomplete", "Part of this trade went through.");
      e.body = { retry: true, sweep: true, incomplete };
      throw e;
    },
    buildSweep: async (...args: unknown[]) => (calls.push(["sweep", ...args]), { done: true }),
    buildRetry: async (...args: unknown[]) => (calls.push(["retry", ...args]), { buildId: "b", transactions: [] }),
    incompleteTrades: () => ({ trades: [incomplete] }),
  } as unknown as ForkService;
  const { g } = guard();
  const server = forkApiServer(service, () => {}, { guard: g });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  const r = await post("/submit", { buildId: "x", transactions: [] });
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), { retry: true, sweep: true, incomplete, error: "trade_incomplete", message: "Part of this trade went through." });
  assert.equal((await post(`/wallets/${WALLET}/sweep`, {})).status, 401, "needs the wallet's token");
  const auth = { authorization: `Bearer ${token()}` };
  assert.deepEqual(await (await post(`/wallets/${WALLET}/sweep`, {}, auth)).json(), { done: true });
  assert.equal((await post(`/wallets/${WALLET}/retry`, { position: "P" }, auth)).status, 200);
  assert.deepEqual(calls, [["sweep", WALLET, undefined], ["retry", WALLET, "P"]]);
  assert.deepEqual(await (await fetch(`${url}/wallets/${WALLET}/incomplete`)).json(), { trades: [incomplete] });
});
