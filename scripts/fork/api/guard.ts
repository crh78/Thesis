// Abuse limits for the public fork API:
//
// - Money routes act for one wallet. The caller proves it's that wallet's owner with a Privy access
//   token (`Authorization: Bearer <token>`; its user's embedded Solana wallet must be that wallet),
//   or is a server with a service key (`x-thesis-service-key`), which may act for any wallet (the
//   X agent; e2e suites). `FORK_API_AUTH`: `report` (default) logs a missing or wrong token and
//   serves anyway; `enforce` refuses (401 / 403); `off` skips the check.
// - Each wallet gets 10 money actions a minute and 100 a day (rolling), whatever the auth mode.
// - Reads: 120 a minute per IP. Behind the web app's proxy (Vercel) every visitor shares a few IPs,
//   so the proxy sends `x-thesis-proxy-key` and `x-thesis-client-ip`, and only then is that IP
//   used. `FORK_API_READ_LIMIT`: `report` (default) logs who'd be limited; `enforce` refuses (429).
// - Builds that call Jupiter wait their turn: a few at once, a short queue, then 503 `busy` with
//   Retry-After instead of hanging (the free Jupiter key is shared by everything on the fork).
//
// Limits are kept in memory, so they reset when the API restarts.
import { createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ApiError } from "./common.ts";

export type Mode = "off" | "report" | "enforce";

export type GuardOptions = {
  auth: Mode;
  readLimit: Exclude<Mode, "off">;
  /** Service keys by name (FORK_API_SERVICE_KEYS="agent=<secret>,e2e=<secret>"). */
  serviceKeys: Map<string, string>;
  /** The web proxy's key (FORK_API_PROXY_KEY); without it, x-thesis-client-ip is ignored. */
  proxyKey: string | null;
  /** Privy app values; without them no token can be checked (every token reads as missing). */
  privy: { appId: string; verificationKey: string; appSecret: string } | null;
  limits?: Partial<Limits>;
  log?: (m: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
};

export type Limits = {
  moneyPerMinute: number;
  moneyPerDay: number;
  readsPerMinute: number;
  buildsAtOnce: number;
  buildQueue: number;
};

export const DEFAULT_LIMITS: Limits = { moneyPerMinute: 10, moneyPerDay: 100, readsPerMinute: 120, buildsAtOnce: 2, buildQueue: 6 };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WALLET_CACHE_MS = 10 * MINUTE;
const NO_WALLET_CACHE_MS = MINUTE;

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** `name=secret,name=secret` → name → secret. Bare secrets are named `service`. */
export function parseServiceKeys(raw: string | null): Map<string, string> {
  const keys = new Map<string, string>();
  for (const part of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    const [name, secret] = eq > 0 ? [part.slice(0, eq), part.slice(eq + 1)] : ["service", part];
    if (secret.length < 16) throw new Error(`FORK_API_SERVICE_KEYS: the key for "${name}" is shorter than 16 characters`);
    keys.set(name, secret);
  }
  return keys;
}

export function parseMode<T extends Mode>(raw: string | null, allowed: readonly T[], fallback: T): T {
  if (raw == null) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new Error(`unknown mode "${raw}" (one of ${allowed.join(", ")})`);
  return raw as T;
}

/**
 * Checks a Privy access token (ES256 JWT) and returns its user's DID, or null. Mirrors
 * supabase/functions/_shared/privy.ts: issuer privy.io, audience the app ID, not expired.
 */
export function verifyPrivyToken(token: string, key: KeyObject, appId: string, nowMs: number): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (head.alg !== "ES256") return null;
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url"))) return null;
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const now = nowMs / 1000;
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (p.iss !== "privy.io" || !aud.includes(appId)) return null;
    if (typeof p.exp !== "number" || p.exp <= now) return null;
    if (typeof p.nbf === "number" && p.nbf > now + 60) return null;
    return typeof p.sub === "string" && p.sub ? p.sub : null;
  } catch {
    return null;
  }
}

/** Timestamps in a rolling window per key. */
class Window {
  #hits = new Map<string, number[]>();
  readonly span: number;
  readonly max: number;
  constructor(span: number, max: number) {
    this.span = span;
    this.max = max;
  }

  /** Records a hit unless the key is at its max; returns how long until there's room (0: recorded). */
  take(key: string, now: number, record = true): number {
    const list = (this.#hits.get(key) ?? []).filter((t) => t > now - this.span);
    if (list.length >= this.max) {
      this.#hits.set(key, list);
      return list[0] + this.span - now;
    }
    if (record) list.push(now);
    this.#hits.set(key, list);
    return 0;
  }

  /** Drops keys with nothing left in the window (called now and then, to bound memory). */
  sweep(now: number) {
    for (const [k, list] of this.#hits) if (!list.some((t) => t > now - this.span)) this.#hits.delete(k);
  }
}

export function rateLimited(retryMs: number, what: string): ApiError {
  const s = Math.max(1, Math.ceil(retryMs / 1000));
  const e = new ApiError(429, "rate_limited", `Too many ${what}. Try again in ${s} s.`);
  e.headers = { "retry-after": String(s) };
  return e;
}

/** Who a money request acts as, once checked. */
export type Actor = { wallet: string; via: "token" | "service" | "unverified"; name?: string };

export class Guard {
  readonly limits: Limits;
  #o: GuardOptions;
  #key: KeyObject | null;
  #wallets = new Map<string, { at: number; wallet: string | null }>();
  #moneyMinute: Window;
  #moneyDay: Window;
  #reads: Window;
  #reported = new Map<string, number>();
  #gate: BuildGate;

  constructor(o: GuardOptions) {
    this.#o = o;
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.#key = o.privy ? createPublicKey(o.privy.verificationKey.replace(/\\n/g, "\n")) : null;
    this.#moneyMinute = new Window(MINUTE, this.limits.moneyPerMinute);
    this.#moneyDay = new Window(DAY, this.limits.moneyPerDay);
    this.#reads = new Window(MINUTE, this.limits.readsPerMinute);
    this.#gate = new BuildGate(this.limits.buildsAtOnce, this.limits.buildQueue, o.log);
    setInterval(() => this.sweep(), 10 * MINUTE).unref();
  }

  /** Drops rate-limit windows with nothing left in them and report marks older than a minute, to bound memory. */
  sweep() {
    const now = this.#now();
    for (const w of [this.#moneyMinute, this.#moneyDay, this.#reads]) w.sweep(now);
    for (const [k, at] of this.#reported) if (at <= now - MINUTE) this.#reported.delete(k);
  }

  /** How many report marks are kept (for tests). */
  get reportedKeys(): number {
    return this.#reported.size;
  }

  #now() {
    return this.#o.now?.() ?? Date.now();
  }

  /** Logs a report-mode finding at most once a minute per key. */
  #report(key: string, message: string) {
    const now = this.#now();
    if ((this.#reported.get(key) ?? 0) > now - MINUTE) return;
    this.#reported.set(key, now);
    this.#o.log?.(message);
  }

  /** The service key's name, if the request carries a valid one. */
  service(req: IncomingMessage): string | null {
    const given = header(req, "x-thesis-service-key");
    if (!given) return null;
    for (const [name, secret] of this.#o.serviceKeys) if (sameSecret(given, secret)) return name;
    return null;
  }

  /** The caller's IP: the web proxy's word for its visitor (with its key), else who reached us. */
  clientIp(req: IncomingMessage): string {
    const proxy = header(req, "x-thesis-proxy-key");
    const claimed = header(req, "x-thesis-client-ip");
    if (proxy && claimed && this.#o.proxyKey && sameSecret(proxy, this.#o.proxyKey)) return `client:${claimed.trim()}`;
    // Tailscale Funnel proxies from loopback and appends the address it saw to X-Forwarded-For;
    // only that last entry is ours to trust.
    const forwarded = header(req, "x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    const peer = req.socket.remoteAddress ?? "unknown";
    const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    return loopback && forwarded ? forwarded : peer;
  }

  /** A read (GET, or a harmless POST): counted per IP. */
  checkRead(req: IncomingMessage) {
    if (this.service(req)) return;
    const ip = this.clientIp(req);
    const wait = this.#reads.take(ip, this.#now());
    if (!wait) return;
    if (this.#o.readLimit === "enforce") throw rateLimited(wait, "requests");
    this.#report(`read:${ip}`, `read limit (report only): ${ip} is over ${this.limits.readsPerMinute} requests a minute`);
  }

  /** A route only servers may call (POST /digests): refused without a service key, in every auth mode. */
  checkServiceOnly(req: IncomingMessage, route: string) {
    if (this.service(req)) return;
    // In every auth mode: report mode used to log and run it, which sent the day's digests early.
    this.#report(`svc:${route}`, `${route} refused: no service key`);
    throw new ApiError(401, "service_key_required", "This route needs a service key.");
  }

  /**
   * A money action for `wallet` (trade, publish, sale, cash in, cash-out, claim): checks who's
   * asking, then counts it against the wallet's limits. Returns who it acts as.
   */
  async checkMoney(req: IncomingMessage, wallet: string, route: string): Promise<Actor> {
    const actor = await this.#actor(req, wallet, route);
    // Unverified callers (report mode) count per IP and wallet, so nobody can use up someone
    // else's allowance by naming their wallet.
    const key = actor.via === "unverified" ? `${this.clientIp(req)}|${wallet}` : wallet;
    const now = this.#now();
    const day = this.#moneyDay.take(key, now, false);
    if (day) throw rateLimited(day, "trades today");
    const minute = this.#moneyMinute.take(key, now);
    if (minute) throw rateLimited(minute, "trades in a minute");
    this.#moneyDay.take(key, now);
    return actor;
  }

  async #actor(req: IncomingMessage, wallet: string, route: string): Promise<Actor> {
    const name = this.service(req);
    if (name) return { wallet, via: "service", name };
    if (this.#o.auth === "off") return { wallet, via: "unverified" };
    const token = header(req, "authorization")?.replace(/^Bearer\s+/i, "") ?? header(req, "privy-token");
    const did = token && this.#key && this.#o.privy ? verifyPrivyToken(token, this.#key, this.#o.privy.appId, this.#now()) : null;
    const owned = did ? await this.#walletOf(did) : null;
    if (owned === wallet) return { wallet, via: "token" };
    const problem = !token ? "no token" : !did ? "an invalid token" : !owned ? "a token whose user has no wallet" : "a token for another wallet";
    if (this.#o.auth === "enforce") {
      throw !token || !did ? new ApiError(401, "unauthorized", "Sign in again.") : new ApiError(403, "wrong_wallet", "That wallet isn't yours.");
    }
    this.#report(`auth:${route}:${wallet}`, `auth (report only): ${route} for ${wallet.slice(0, 6)}… with ${problem}`);
    return { wallet, via: "unverified" };
  }

  /** The user's embedded Solana wallet from Privy (lowest wallet index), cached. */
  async #walletOf(did: string): Promise<string | null> {
    const hit = this.#wallets.get(did);
    const now = this.#now();
    if (hit && now - hit.at < (hit.wallet ? WALLET_CACHE_MS : NO_WALLET_CACHE_MS)) return hit.wallet;
    const privy = this.#o.privy!;
    const r = await (this.#o.fetch ?? fetch)(`https://api.privy.io/v1/users/${encodeURIComponent(did)}`, {
      headers: {
        "privy-app-id": privy.appId,
        authorization: `Basic ${Buffer.from(`${privy.appId}:${privy.appSecret}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!r?.ok) {
      this.#o.log?.(`Privy user lookup failed: ${r ? `HTTP ${r.status}` : "no response"}`);
      return hit?.wallet ?? null;
    }
    type Linked = { type: string; chain_type?: string; wallet_client_type?: string; wallet_index?: number; address?: string };
    const accounts = (((await r.json()) as { linked_accounts?: Linked[] }).linked_accounts ?? []);
    const wallet = accounts
      .filter((a) => a.type === "wallet" && a.chain_type === "solana" && a.wallet_client_type === "privy")
      .sort((a, b) => (a.wallet_index ?? 0) - (b.wallet_index ?? 0))[0]?.address ?? null;
    this.#wallets.set(did, { at: now, wallet });
    return wallet;
  }

  /** Runs a build that calls Jupiter in its turn (see BuildGate). */
  build<T>(work: () => Promise<T>): Promise<T> {
    return this.#gate.run(work);
  }
}

/**
 * At most `atOnce` builds run together and `queue` wait; anyone past that gets 503 `busy` with a
 * Retry-After from how long builds have been taking. Logs the queue whenever someone waits.
 */
export class BuildGate {
  #running = 0;
  #waiting: (() => void)[] = [];
  #avgMs = 5_000;
  readonly atOnce: number;
  readonly queue: number;
  readonly log?: (m: string) => void;

  constructor(atOnce: number, queue: number, log?: (m: string) => void) {
    this.atOnce = atOnce;
    this.queue = queue;
    this.log = log;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running >= this.atOnce) {
      if (this.#waiting.length >= this.queue) {
        const s = Math.max(1, Math.ceil(((this.#waiting.length + 1) / this.atOnce) * (this.#avgMs / 1000)));
        this.log?.(`builds busy: ${this.#running} running, ${this.#waiting.length} waiting; turned one away (retry in ${s} s)`);
        const e = new ApiError(503, "busy", `Lots of trades right now. Try again in ${s} s.`);
        e.headers = { "retry-after": String(s) };
        throw e;
      }
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
      this.log?.(`builds queue: ${this.#running} running, ${this.#waiting.length} still waiting`);
    } else {
      this.#running++;
    }
    const started = Date.now();
    try {
      return await work();
    } finally {
      this.#avgMs = this.#avgMs * 0.8 + (Date.now() - started) * 0.2;
      const next = this.#waiting.shift();
      // The slot passes straight to the next in line; otherwise it's freed.
      if (next) next();
      else this.#running--;
    }
  }
}
