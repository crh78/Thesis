// Abuse limits for the public fork API:
//
// - Money routes act for one wallet. The caller proves it's that wallet's owner with a Privy access
//   token (`Authorization: Bearer <token>`; its user's embedded Solana wallet must be that wallet),
//   or is a server with a service key (`x-thesis-service-key`), which may act for any wallet (the
//   X agent; e2e suites). `FORK_API_AUTH`: `report` (default) logs a missing or wrong token and
//   serves anyway; `enforce` refuses (401 / 403); `off` skips the check.
// - Each wallet gets 10 money actions a minute and 100 a day (rolling), whatever the auth mode.
//   A prebuild (built ahead of the tap) checks who's asking without counting (`checkAuth`); its
//   money action counts at submit (`countMoney`), once the wallet's signature checked out.
// - Reads: 120 a minute per signed-in Privy user (a valid token on the read), otherwise per IP.
//   Behind the web app's proxy (Vercel) every visitor shares a few IPs, so the proxy sends
//   `x-thesis-proxy-key` and `x-thesis-client-ip`, and only then is that IP used; a browser or app
//   calling directly through Caddy (infra/executor/caddy, which sets X-Forwarded-For to the address
//   it saw) is counted by that header's last entry.
//   `FORK_API_READ_LIMIT`: `report` (default) logs who'd be limited; `enforce` refuses (429).
//   Verified tokens are cached for a minute (at most until they expire), so a read or a money
//   route checks a token's signature once, not on every request.
// - Jupiter calls, not whole builds, wait their turn (JupiterBudget): a free key allows about 60
//   requests a minute for its whole organisation, so the API keeps to 30 a minute (bursts of 10)
//   by default, or FORK_API_JUPITER_RPM / FORK_API_JUPITER_BURST (the fork: its own trade key,
//   JUPITER_TRADE_API_KEY, at 50 a minute in bursts of 3), in three lanes: (1) builds at tap time
//   wait for a request, up to a few seconds, then get 503 `busy`; (2) prebuilds and (3) route
//   checks are refused instead whenever the bucket would drop below its reserve (6 by default,
//   burst − 2 when the burst is set) or Jupiter just answered 429, and never wait out a 429 (a
//   prebuild may wait a few seconds for the reserve; a sell seed waits its retry-after and goes
//   again, routing.ts). While builds' calls run or wait, the asset bank's
//   `trade-builds.busy` file is touched every few seconds (`busyFile`), so the poller's probes
//   leave the Jupiter key to trades.
//
// Limits are kept in memory, so they reset when the API restarts.
import { createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { markBuildsBusy } from "@thesis/venues/bank";
import { JUPITER_MAX_429_WAIT_MS, type FetchFn } from "@thesis/venues/jupiter";
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
  /** The Jupiter budget whose builds signal busy and log (default: the process's, jupiterBudget). */
  budget?: JupiterBudget;
  /** The asset bank's busy file (buildsBusyFileFor), touched while builds' Jupiter calls run or wait; null: none. */
  busyFile?: string | null;
  log?: (m: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
};

export type Limits = {
  moneyPerMinute: number;
  moneyPerDay: number;
  readsPerMinute: number;
};

/** How often the busy signal repeats while builds run or wait (the bank's hold is 15 s). */
export const BUSY_EVERY_MS = 5_000;

export const DEFAULT_LIMITS: Limits = { moneyPerMinute: 10, moneyPerDay: 100, readsPerMinute: 120 };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WALLET_CACHE_MS = 10 * MINUTE;
const NO_WALLET_CACHE_MS = MINUTE;
/** How long a verified token is trusted without checking its signature again (never past its expiry). */
const TOKEN_CACHE_MS = MINUTE;
/** Verified tokens kept at most (the oldest go first). */
const TOKEN_CACHE_MAX = 10_000;

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
  return verifyPrivyClaims(token, key, appId, nowMs)?.sub ?? null;
}

/** As verifyPrivyToken, with the token's expiry (unix s). */
function verifyPrivyClaims(token: string, key: KeyObject, appId: string, nowMs: number): { sub: string; exp: number } | null {
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
    return typeof p.sub === "string" && p.sub ? { sub: p.sub, exp: p.exp } : null;
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
  /** Verified tokens → their user, until when (ms) it's trusted without a fresh check. */
  #tokens = new Map<string, { did: string; until: number }>();
  #moneyMinute: Window;
  #moneyDay: Window;
  #reads: Window;
  #reported = new Map<string, number>();

  constructor(o: GuardOptions) {
    this.#o = o;
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.#key = o.privy ? createPublicKey(o.privy.verificationKey.replace(/\\n/g, "\n")) : null;
    this.#moneyMinute = new Window(MINUTE, this.limits.moneyPerMinute);
    this.#moneyDay = new Window(DAY, this.limits.moneyPerDay);
    this.#reads = new Window(MINUTE, this.limits.readsPerMinute);
    const busyFile = o.busyFile;
    const budget = o.budget ?? jupiterBudget;
    budget.log ??= o.log;
    if (busyFile) budget.onBusy = () => void markBuildsBusy(busyFile).catch(() => {});
    setInterval(() => this.sweep(), 10 * MINUTE).unref();
  }

  /** Drops rate-limit windows with nothing left in them and report marks older than a minute, to bound memory. */
  sweep() {
    const now = this.#now();
    for (const w of [this.#moneyMinute, this.#moneyDay, this.#reads]) w.sweep(now);
    for (const [k, at] of this.#reported) if (at <= now - MINUTE) this.#reported.delete(k);
    for (const [k, t] of this.#tokens) if (t.until <= now) this.#tokens.delete(k);
  }

  /** How many verified tokens are cached (for tests). */
  get cachedTokens(): number {
    return this.#tokens.size;
  }

  /** The Privy token a request carries (Authorization: Bearer, or privy-token), if any. */
  #tokenOf(req: IncomingMessage): string | undefined {
    return header(req, "authorization")?.replace(/^Bearer\s+/i, "") ?? header(req, "privy-token");
  }

  /**
   * The Privy user a token belongs to, or null if it isn't valid (or no Privy values are set).
   * A valid token is cached for TOKEN_CACHE_MS, never past its expiry; invalid ones aren't cached.
   */
  #did(token: string): string | null {
    const now = this.#now();
    const hit = this.#tokens.get(token);
    if (hit && hit.until > now) return hit.did;
    if (hit) this.#tokens.delete(token);
    if (!this.#key || !this.#o.privy) return null;
    const claims = verifyPrivyClaims(token, this.#key, this.#o.privy.appId, now);
    if (!claims) return null;
    if (this.#tokens.size >= TOKEN_CACHE_MAX) this.#tokens.delete(this.#tokens.keys().next().value!);
    this.#tokens.set(token, { did: claims.sub, until: Math.min(now + TOKEN_CACHE_MS, claims.exp * 1000) });
    return claims.sub;
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
    // Caddy (and Tailscale Funnel, while it still serves older builds) proxies from loopback and
    // sets the address it saw as X-Forwarded-For's last entry: only that entry is ours to trust.
    const forwarded = header(req, "x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    const peer = req.socket.remoteAddress ?? "unknown";
    const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    return loopback && forwarded ? forwarded : peer;
  }

  /**
   * Who a read counts against: the Privy user when the request carries a valid token (so people
   * behind one IP don't share a limit), otherwise the caller's IP.
   */
  readKey(req: IncomingMessage): string {
    const token = this.#tokenOf(req);
    const did = token ? this.#did(token) : null;
    return did ? `user:${did}` : this.clientIp(req);
  }

  /** A read (GET, or a harmless POST): counted per Privy user with a valid token, else per IP. */
  checkRead(req: IncomingMessage) {
    if (this.service(req)) return;
    const key = this.readKey(req);
    const wait = this.#reads.take(key, this.#now());
    if (!wait) return;
    if (this.#o.readLimit === "enforce") throw rateLimited(wait, "requests");
    this.#report(`read:${key}`, `read limit (report only): ${key} is over ${this.limits.readsPerMinute} requests a minute`);
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
    this.#count(actor.via === "unverified" ? `${this.clientIp(req)}|${wallet}` : wallet);
    return actor;
  }

  /**
   * A prebuild for `wallet` (built ahead of the tap): checks who's asking, as checkMoney does
   * (401 / 403 in enforce mode), without counting a money action. Its money action counts at
   * submit, with countMoney. Its own window of prebuilds a minute is the server's (server.ts).
   */
  async checkAuth(req: IncomingMessage, wallet: string, route: string): Promise<Actor> {
    return this.#actor(req, wallet, route);
  }

  /**
   * Counts one money action for `wallet`: a prebuilt trade, at its submit. The API calls it once
   * the wallet's signature on the build checked out, so only the owner can use up the allowance,
   * and it counts per wallet in every auth mode. Past the limits it throws the same 429 (with
   * Retry-After) as checkMoney and counts nothing, so the build can be submitted again later.
   */
  countMoney(wallet: string): void {
    this.#count(wallet);
  }

  /** Counts a money action against `key`'s minute and day windows, or throws 429 without counting. */
  #count(key: string) {
    const now = this.#now();
    const day = this.#moneyDay.take(key, now, false);
    if (day) throw rateLimited(day, "trades today");
    const minute = this.#moneyMinute.take(key, now);
    if (minute) throw rateLimited(minute, "trades in a minute");
    this.#moneyDay.take(key, now);
  }

  async #actor(req: IncomingMessage, wallet: string, route: string): Promise<Actor> {
    const name = this.service(req);
    if (name) return { wallet, via: "service", name };
    if (this.#o.auth === "off") return { wallet, via: "unverified" };
    const token = this.#tokenOf(req);
    const did = token ? this.#did(token) : null;
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

  /**
   * Runs a build. Builds no longer queue as a whole: their Jupiter calls do, in the Jupiter
   * budget's lanes (JupiterBudget), so a build that needs no Jupiter call never waits.
   */
  build<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}

/**
 * At most `atOnce` pieces of work (Jupiter calls, in JupiterBudget) run together and `queue` wait;
 * anyone past that gets 503 `busy` with a Retry-After from how long they have been taking. Logs the
 * queue whenever someone waits. `onBusy` runs when work is let in or queued, and every
 * BUSY_EVERY_MS while any runs or waits.
 */
export class BuildGate {
  #running = 0;
  #waiting: (() => void)[] = [];
  #avgMs = 5_000;
  readonly atOnce: number;
  readonly queue: number;
  readonly log?: (m: string) => void;
  readonly onBusy?: () => void;
  #busyTimer: NodeJS.Timeout | null = null;

  constructor(atOnce: number, queue: number, log?: (m: string) => void, onBusy?: () => void) {
    this.atOnce = atOnce;
    this.queue = queue;
    this.log = log;
    this.onBusy = onBusy;
  }

  /** Whether a build is running or waiting. */
  get busy(): boolean {
    return this.#running > 0 || this.#waiting.length > 0;
  }

  /** Signals busy now, and keeps signalling while builds run or wait. */
  #markBusy() {
    if (!this.onBusy) return;
    this.onBusy();
    this.#busyTimer ??= setInterval(() => {
      if (!this.busy) {
        clearInterval(this.#busyTimer!);
        this.#busyTimer = null;
        return;
      }
      this.onBusy!();
    }, BUSY_EVERY_MS);
    this.#busyTimer.unref?.();
  }

  /** Runs `work` in its turn; with `wait` false, refuses (503 busy) instead of queueing. */
  async run<T>(work: () => Promise<T>, wait = true): Promise<T> {
    if (this.#running >= this.atOnce) {
      if (!wait || this.#waiting.length >= this.queue) {
        const s = Math.max(1, Math.ceil(((this.#waiting.length + 1) / this.atOnce) * (this.#avgMs / 1000)));
        if (wait) this.log?.(`builds busy: ${this.#running} running, ${this.#waiting.length} waiting; turned one away (retry in ${s} s)`);
        const e = new ApiError(503, "busy", `Lots of trades right now. Try again in ${s} s.`);
        e.headers = { "retry-after": String(s) };
        throw e;
      }
      const turn = new Promise<void>((resolve) => this.#waiting.push(resolve));
      this.#markBusy();
      await turn;
      this.log?.(`builds queue: ${this.#running} running, ${this.#waiting.length} still waiting`);
    } else {
      this.#running++;
      this.#markBusy();
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

/**
 * Which Jupiter lane a call is in. 1: a build at tap time (waits its turn); 2: a prebuild (built
 * before the tap, so it may fail and be built again at the tap); 3: a route check (a receipt's
 * "can this leg be bought right now").
 */
export type Lane = 1 | 2 | 3;
export const LANE = { tap: 1, prebuild: 2, routeCheck: 3 } as const;

export type BudgetLimits = {
  /** Requests a minute the fork API spends (the free key's 60 are shared with the asset bank and the settler). */
  perMinute: number;
  /** Requests that can go at once after a quiet spell. */
  burst: number;
  /** Lanes 2 and 3 fail fast rather than leave fewer than this many requests for taps. */
  reserve: number;
  /** How long a prebuild waits for the bucket to climb above `reserve` (no 429, no tap waiting) before it's refused. */
  prebuildWaitMs: number;
  /** A tap-time call that would wait longer than this for its turn gets 503 busy instead. */
  maxWaitMs: number;
  /** Jupiter calls of builds in flight at once, and how many taps may queue for a slot. */
  atOnce: number;
  queue: number;
};

export const JUPITER_BUDGET: BudgetLimits = { perMinute: 30, burst: 10, reserve: 6, maxWaitMs: 8_000, prebuildWaitMs: 4_000, atOnce: 8, queue: 24 };
/** How long a 429 without `x-ratelimit-reset` stops every lane. */
const PAUSE_ON_429_MS = 2_000;
/** The longest a 429's `x-ratelimit-reset` stops every lane. */
const MAX_PAUSE_MS = 15_000;

/**
 * One build's (or one route check's) use of Jupiter, for the timings log: requests made (each
 * retry counts), how long it waited for its turn, and 429s seen. Routing adds what its caches saved.
 */
export type JupiterUse = {
  lane: Lane;
  /** Jupiter requests made: `quotes`, `instructions` (swap and Lend instructions) and `prices` (Price v3 reads). */
  calls: number;
  quotes: number;
  instructions: number;
  prices: number;
  /** Time spent waiting for the budget (tap-time builds only; the others fail fast). */
  waitedMs: number;
  /** 429s Jupiter answered. */
  rateLimited: number;
  /** Underlyings quoted against the issuer that last won (one quote) / against every issuer. */
  winnerHits: number;
  winnerMisses: number;
  /**
   * The shared routing (api/routing.ts): "hit" reused another build's, "wait" waited for one in
   * flight, "scaled" rewrote one made at another stake moments ago, "route" repriced every swap
   * leg from kept routes at the tokens' prices now (no quote; its one call, if any, is the price
   * read), "miss" routed its own (some legs may still be repriced: see templatedLegs). Unset when
   * the trade has no traded legs.
   */
  template?: "hit" | "wait" | "scaled" | "route" | "miss";
  /** Swap legs built from another wallet's (or another stake's, or a kept route's) template (no Jupiter call each). */
  templatedLegs: number;
  /** The first call the budget refused (lanes 2 and 3, or a full queue): routing answers 503 busy with it. */
  refused?: ApiError;
  /** A prebuild's first call, once let in (JupiterBudget.run): the build's later calls go in a tap's turn. */
  first?: Promise<void>;
};

export const newUse = (lane: Lane = 1): JupiterUse => ({ lane, calls: 0, quotes: 0, instructions: 0, prices: 0, waitedMs: 0, rateLimited: 0, winnerHits: 0, winnerMisses: 0, templatedLegs: 0 });

/**
 * The fork API's Jupiter budget: a token bucket (BudgetLimits) with lanes, behind a concurrency
 * gate (BuildGate) for builds' calls. Tap-time calls queue for a request in order and wait up to
 * `maxWaitMs`; prebuilds and route checks take one only while more than `reserve` are left and no
 * tap is waiting. A prebuild short only of spare requests waits up to `prebuildWaitMs` for the bucket
 * to refill (the sheet is open, nobody has tapped yet); route checks, and anything after a 429 or
 * behind a waiting tap, are refused at once. A 429 (or a window Jupiter says is used up)
 * empties the bucket until the window resets, so nothing else piles on.
 */
export class JupiterBudget {
  readonly limits: BudgetLimits;
  /** Logs turned-away calls (set by the Guard). */
  log?: (m: string) => void;
  /** Signals the asset bank while builds' calls (lanes 1 and 2) run or wait (set by the Guard). */
  onBusy?: () => void;
  /** Totals since start, by lane (index 0 unused). */
  readonly stats = { calls: [0, 0, 0, 0], refused: [0, 0, 0, 0], rateLimited: 0, waitedMs: 0 };
  #tokens: number;
  #at: number;
  #pausedUntil = 0;
  #waiters: (() => void)[] = [];
  #timer: NodeJS.Timeout | null = null;
  #gate: BuildGate;
  #now: () => number;

  constructor(limits: Partial<BudgetLimits> = {}, now: () => number = Date.now) {
    this.limits = { ...JUPITER_BUDGET, ...limits };
    this.#now = now;
    this.#tokens = this.limits.burst;
    this.#at = now();
    this.#gate = new BuildGate(this.limits.atOnce, this.limits.queue, (m) => this.log?.(`Jupiter calls: ${m}`), () => this.onBusy?.());
  }

  /** Requests left now (fractional while refilling). */
  get tokens(): number {
    this.#refill();
    return this.#tokens;
  }

  #refill() {
    const now = this.#now();
    const from = Math.max(this.#at, this.#pausedUntil);
    if (now > from) this.#tokens = Math.min(this.limits.burst, this.#tokens + ((now - from) * this.limits.perMinute) / 60_000);
    this.#at = Math.max(now, this.#at);
  }

  /** ms until the bucket holds `n` requests. */
  #msUntil(n: number): number {
    const pause = Math.max(0, this.#pausedUntil - this.#now());
    return pause + Math.ceil((Math.max(0, n - this.#tokens) * 60_000) / this.limits.perMinute);
  }

  #refuse(lane: Lane, ms: number, why: string): ApiError {
    this.stats.refused[lane]++;
    const s = Math.max(1, Math.ceil(ms / 1000));
    const e = new ApiError(503, "busy", lane === 1 ? `Lots of trades right now. Try again in ${s} s.` : `Jupiter's rate limit is kept for trades right now (${why}). Try again in ${s} s.`);
    e.headers = { "retry-after": String(s) };
    return e;
  }

  /** Takes one request for `lane`: waits in line (lane 1) or is refused (lanes 2, 3). Returns ms waited. */
  async #take(lane: Lane, retried = false, waited = 0): Promise<number> {
    this.#refill();
    const now = this.#now();
    if (lane !== 1) {
      if (now < this.#pausedUntil) throw this.#refuse(lane, this.#pausedUntil - now, "Jupiter answered 429");
      if (this.#waiters.length) throw this.#refuse(lane, this.#msUntil(this.#waiters.length + 1 + this.limits.reserve), "trades are waiting");
      if (this.#tokens - 1 < this.limits.reserve) {
        const wait = this.#msUntil(this.limits.reserve + 1);
        // A prebuild only short of spare requests waits for the bucket (once, and within its limit),
        // then checks again: a tap or a 429 in the meantime still turns it away.
        if (lane === 2 && !retried && wait <= this.limits.prebuildWaitMs) {
          const started = Date.now();
          await new Promise((resolve) => setTimeout(resolve, wait + 5));
          return this.#take(lane, true, Date.now() - started);
        }
        throw this.#refuse(lane, wait, "the last few requests");
      }
      this.#tokens -= 1;
      return waited;
    }
    if (!this.#waiters.length && now >= this.#pausedUntil && this.#tokens >= 1) {
      this.#tokens -= 1;
      return 0;
    }
    const wait = this.#msUntil(this.#waiters.length + 1);
    if (wait > this.limits.maxWaitMs) {
      this.log?.(`Jupiter budget: ${this.#waiters.length} waiting, ${this.#tokens.toFixed(1)} left; turned a trade away (${wait} ms to wait)`);
      throw this.#refuse(1, wait, "busy");
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
      this.#pump();
    });
    return this.#now() - now;
  }

  /** Lets waiting taps through, in order, as requests come back. */
  #pump() {
    if (this.#timer) return;
    this.#refill();
    while (this.#waiters.length && this.#now() >= this.#pausedUntil && this.#tokens >= 1) {
      this.#tokens -= 1;
      this.#waiters.shift()!();
    }
    if (!this.#waiters.length) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#pump();
    }, Math.max(1, this.#msUntil(1)));
    this.#timer.unref?.();
  }

  /** Jupiter's 429, or a window it says is used up: no lane gets a request until it resets. */
  rateLimited(resetSec?: number) {
    const now = this.#now();
    const until = resetSec !== undefined && Number.isFinite(resetSec) && resetSec > 0 ? Math.min(resetSec * 1000 + 250, now + MAX_PAUSE_MS) : now + PAUSE_ON_429_MS;
    this.#refill();
    this.#tokens = 0;
    this.#pausedUntil = Math.max(this.#pausedUntil, until);
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#pump();
    }
  }

  /** Runs one Jupiter request in `lane`'s turn, counted in `use`. */
  async run<T>(lane: Lane, work: () => Promise<T>, use?: JupiterUse): Promise<T> {
    // A prebuild that has already made a call finishes like a tap: refusing its second call at the
    // reserve would waste the first and fail the build (a sale's legs need several), and the next
    // try would do the same. One build's worth of calls, so taps lose little.
    // The build's first call holds `first`; calls made alongside it (a sale's legs are quoted in
    // parallel) wait on it, then go in a tap's turn, or fail with it if it was refused.
    let turn: Lane = lane;
    let release: (() => void) | undefined;
    let fail: ((e: unknown) => void) | undefined;
    if (lane === 2 && use) {
      if (use.first) {
        await use.first;
        turn = 1;
      } else {
        use.first = new Promise<void>((resolve, reject) => {
          release = resolve;
          fail = reject;
        });
        use.first.catch(() => {});
      }
    }
    const go = async () => {
      const waited = await this.#take(turn);
      release?.();
      this.stats.calls[lane]++;
      this.stats.waitedMs += waited;
      if (use) {
        use.calls++;
        use.waitedMs += waited;
      }
      return work();
    };
    try {
      // Route checks skip the gate: they never wait, and they don't hold the asset bank's probes
      // back. Builds' calls take a slot (taps queue for one, prebuilds don't).
      return lane === 3 ? await go() : await this.#gate.run(go, turn === 1);
    } catch (e) {
      fail?.(e);
      if (use && e instanceof ApiError && e.code === "busy") use.refused ??= e;
      throw e;
    }
  }

  /**
   * A fetch for Jupiter's endpoints through the budget in `lane`: each request (retries too)
   * takes its turn, and a 429 stops every lane until Jupiter's window resets.
   */
  fetchFn(lane: Lane, use?: JupiterUse, inner: FetchFn = fetch): FetchFn {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const r = await this.run(lane, () => inner(url, init), use);
      if (use) {
        if (String(url).includes("/swap/v1/quote?")) use.quotes++;
        else if (String(url).includes("/price/v3?")) use.prices++;
        else use.instructions++;
      }
      const reset = Number(r.headers?.get?.("x-ratelimit-reset"));
      const remaining = r.headers?.get?.("x-ratelimit-remaining");
      if (r.status === 429) {
        this.stats.rateLimited++;
        if (use) use.rateLimited++;
        this.rateLimited(reset);
        // Prebuilds and route checks don't wait out a 429 (max429WaitMs): answer busy with when to
        // try again, not the venue's raw error (which would be a 500).
        if (lane !== 1) {
          const e = this.#refuse(lane, Math.max(1_000, this.#pausedUntil - this.#now()), "Jupiter answered 429");
          if (use) use.refused ??= e;
          throw e;
        }
      } else if (remaining != null && remaining !== "" && Number(remaining) <= 0) {
        this.rateLimited(reset);
      }
      return r;
    }) as FetchFn;
  }

  /** How long a call in `lane` may wait out Jupiter's 429s: taps as before, the others not at all. */
  max429WaitMs(lane: Lane): number {
    return lane === 1 ? JUPITER_MAX_429_WAIT_MS : 0;
  }

  /** The budget at a glance, for logs. */
  snapshot() {
    return { tokens: Math.floor(this.tokens * 10) / 10, waiting: this.#waiters.length, pausedMs: Math.max(0, this.#pausedUntil - this.#now()), ...this.stats };
  }
}

/** The process's Jupiter budget: routing and the guard share it, as every request shares the key. */
/**
 * The fork API's requests a minute: FORK_API_JUPITER_RPM, else JUPITER_BUDGET's 30 (sized for a
 * key shared with the asset bank and the settler). With its own key (JUPITER_TRADE_API_KEY) the
 * fork API can take most of Jupiter's 60 a minute.
 */
export function budgetFromEnv(env: Record<string, string | undefined> = process.env): Partial<BudgetLimits> {
  const out: Partial<BudgetLimits> = {};
  const whole = (name: string, min: number, max: number, what: string) => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number of ${what} (${min}–${max}), not "${raw}"`);
    return n;
  };
  const perMinute = whole("FORK_API_JUPITER_RPM", 1, 600, "requests a minute");
  if (perMinute !== undefined) out.perMinute = perMinute;
  // Jupiter's free tier is about one request a second: a smaller burst paces calls closer to it.
  const burst = whole("FORK_API_JUPITER_BURST", 1, 60, "requests at once");
  if (burst !== undefined) {
    out.burst = burst;
    out.reserve = Math.min(JUPITER_BUDGET.reserve, Math.max(0, burst - 2));
  }
  return out;
}

export const jupiterBudget = new JupiterBudget(budgetFromEnv());
