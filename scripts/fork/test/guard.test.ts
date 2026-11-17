import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ApiError } from "../api/common.ts";
import { BuildGate, Guard, parseServiceKeys, verifyPrivyToken, type GuardOptions } from "../api/guard.ts";
import { forkApiServer } from "../api/server.ts";
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
