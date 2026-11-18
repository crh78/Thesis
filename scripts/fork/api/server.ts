// HTTP in front of ForkService. JSON in and out; errors are { error, message } with a status.
//
//   GET  /health
//   GET  /takes/:id?viewer=<wallet>                 the on-chain receipt (or what would be on-chain): status
//                                                     open | closed (its author sold) | settled, closedAt
//   POST /takes/:id/trades   { owner, side, usd, prebuild? }  → { buildId, transactions[], included, excluded, feeUsd,
//                                                     expiresAt, quotedAt }; prebuild: built ahead of the tap (its own
//                                                     per-wallet window; the money action counts at submit)
//                                                     409 take_closed once the take isn't open
//   POST /takes/:id/positions/:pos/exit  { owner, prebuild? }  → a sale's build, with closesTake (the author's buy-in)
//   POST /takes/:id/publish  { author, usd }        → same, for posting an app take with the author's buy-in
//   POST /takes/:id/confirm                         → { onChain, take?, relayed }: is the author's publish
//                                                     on-chain here? If so, its events go to the backend again
//   POST /submit             { buildId, transactions[], until?, timings? }  signed by the user → { signatures[] }
//                                                     once landed; with until: "accepted", 202 { status: "pending",
//                                                     buildId, signatures } once the fork accepted them all. The
//                                                     same build and bytes again: its status; other bytes: 409
//                                                     build_used. `timings`: the client's marks (ms from the tap)
//   POST /builds/:buildId/refresh                   → the build again with a fresh blockhash (same id, new
//                                                     transactions, expiresAt); 409 quote_stale, 410 build_gone
//   GET  /submissions/:buildId?wait=<ms ≤ 10000>     → { status: pending | landed | failed | incomplete, signatures,
//                                                     error?, incomplete? }, waiting while pending
//
// Builds and submits answer with a Server-Timing header: where the server's time went.
//   GET  /wallets/:address                          USDC, holdings, activity
//   GET  /wallets/:address/portfolio                open positions across takes, and badges held
//   GET  /wallets/:address/history?range=1D|1W|1M|ALL  portfolio value over time, for the chart
//   POST /digests                                   send today's daily position digests now
//   POST /wallets/:address/deposits     { usd }
//   POST /wallets/:address/withdrawals  { usd }  → 403 withdrawals_off (play money can't be withdrawn)
//   GET  /wallets/:address/creator-fees             creator fees per take (earned, claimed, unclaimed); needs
//                                                   x-thesis-wallet-auth: <unix s>.<base64 signature of
//                                                   "Thesis creator fees <address> <unix s>"> from that wallet
//   POST /wallets/:address/creator-fees/claim  { takes? }  → { buildId, transactions[], steps, amountUsd }
//   GET  /wallets/:address/incomplete               split trades that stopped partway → { trades[] }
//   POST /wallets/:address/retry  { position? }     build the rest of one once more → a trade build
//   POST /wallets/:address/sweep  { position? }     sell what it bought back to USDC → a build, or { done: true }
//
// A split trade whose later transaction fails after an earlier one landed answers /submit with
// 422 trade_incomplete (api/split.ts and the README's "Split trades").
//
// Browsers on the web app's origins (FORK_API_CORS_ORIGINS) may call this directly: see corsHeaders.
//
// The shared fork is public, so money routes (trades, publish, sales, cash in, Phoenix cash-out,
// claims) go through the Guard when one is passed: a Privy token or a service key, per-wallet rate
// limits, and a queue for builds that call Jupiter. Reads are rate-limited per IP. Withdrawals are
// off: play money stays on the fork. See api/guard.ts and the README's "Abuse limits".
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { checkWalletAuth } from "./creator-fees.ts";
import { rateLimited, type Guard } from "./guard.ts";
import { Timings, parseKey } from "./common.ts";
import { ApiError, SUBMISSION_WAIT_MAX_MS, type ForkService } from "./service.ts";

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** What a browser may send and read across origins (the README's "Direct browser calls"): a 429's Retry-After, and Server-Timing. */
export const CORS = {
  methods: "GET, POST, OPTIONS",
  headers: "authorization, content-type, x-thesis-wallet-auth",
  expose: "retry-after, server-timing",
  /** Seconds a browser may reuse a preflight (Chrome caps it at 7,200). */
  maxAge: "600",
};

/**
 * FORK_API_CORS_ORIGINS: comma-separated origins (scheme, host and port only, no path), e.g.
 * `https://yourthesis.xyz,https://www.yourthesis.xyz`. Unset or empty: no CORS headers at all.
 * Wildcards aren't allowed: money routes carry a Privy token.
 */
export function parseCorsOrigins(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    let origin: string;
    try {
      origin = new URL(part).origin;
    } catch {
      throw new Error(`FORK_API_CORS_ORIGINS: "${part}" isn't an origin (e.g. https://yourthesis.xyz)`);
    }
    if (origin === "null" || origin !== part.replace(/\/$/, "")) throw new Error(`FORK_API_CORS_ORIGINS: "${part}" must be just an origin (scheme://host[:port]), no path or wildcard`);
    out.add(origin);
  }
  return out;
}

/**
 * CORS headers for a request from `origin`: none when CORS is off (no origins configured);
 * `Vary: Origin` whenever it's on; the echoed origin and the exposed headers when it's allowed.
 * No credentials mode: auth is a bearer token, never a cookie.
 */
export function corsHeaders(allowed: Set<string>, origin: string | undefined): Record<string, string> {
  if (!allowed.size) return {};
  if (!origin || !allowed.has(origin)) return { vary: "Origin" };
  // Timing-Allow-Origin: the page's resource timing may read Server-Timing too.
  return { vary: "Origin", "access-control-allow-origin": origin, "access-control-expose-headers": CORS.expose, "timing-allow-origin": origin };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new ApiError(413, "too_large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

const str = (v: unknown, name: string) => {
  if (typeof v !== "string" || !v) throw new ApiError(400, `missing_${name}`);
  return v;
};
const optionalStr = (v: unknown, name: string) => {
  if (v === undefined || v === null) return undefined;
  return str(v, name);
};
const num = (v: unknown, name: string) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new ApiError(400, `missing_${name}`);
  return n;
};

/**
 * What a prebuild needs from the guard (api/guard.ts): who's asking, without counting a money
 * action (`checkAuth`), and counting it when the prebuilt trade is submitted (`countMoney`, which
 * throws 429 past the limit). A guard without both counts a prebuild as a money action, as any build.
 */
type PrebuildGuard = {
  checkAuth?: (req: IncomingMessage, wallet: string, route: string) => Promise<unknown>;
  countMoney?: (wallet: string) => void;
};

/** Prebuilds (`prebuild: true`) a wallet may ask for in a minute: the sheet builds as the amount changes. */
export const PREBUILDS_PER_MINUTE = 30;

/**
 * `digest`: runs today's position digests now (POST /digests), when the caller wires it.
 * `guard`: abuse limits (api/guard.ts); without one every route is open, as on a private fork.
 * `cors`: origins whose browsers may call directly (parseCorsOrigins); empty or none: no CORS.
 */
export function forkApiServer(
  service: ForkService,
  log: (m: string) => void = () => {},
  hooks: { digest?: () => Promise<unknown>; guard?: Guard; cors?: Set<string> } = {},
): Server {
  const guard = hooks.guard;
  const cors = hooks.cors ?? new Set<string>();
  /**
   * A money action for `wallet`: who's asking, and the wallet's rate limits. The wallet must be an
   * address first, so the guard's per-wallet limits never key on arbitrary text from a request.
   */
  const money = async (req: IncomingMessage, wallet: string, route: string) => {
    parseKey(wallet);
    if (guard) await guard.checkMoney(req, wallet, route);
  };
  const g = guard as (Guard & PrebuildGuard) | undefined;
  /** The guard can check a prebuild's caller without counting it: its money action counts at submit. */
  const deferMoney = Boolean(g && typeof g.checkAuth === "function" && typeof g.countMoney === "function");
  /** Wallet → its prebuilds in the last minute. */
  const prebuilds = new Map<string, number[]>();
  /**
   * A build route's limits: a money action, or with `prebuild` (and a guard that can defer it) the
   * caller's check and the wallet's own window of PREBUILDS_PER_MINUTE.
   */
  const buildLimits = async (req: IncomingMessage, wallet: string, route: string, prebuild: boolean) => {
    if (!prebuild || !deferMoney) return money(req, wallet, route);
    parseKey(wallet);
    await g!.checkAuth!(req, wallet, route);
    const now = Date.now();
    const recent = (prebuilds.get(wallet) ?? []).filter((at) => at > now - 60_000);
    if (recent.length >= PREBUILDS_PER_MINUTE) throw rateLimited(recent[0] + 60_000 - now, "price checks");
    recent.push(now);
    prebuilds.set(wallet, recent);
    if (prebuilds.size > 10_000) for (const [k, list] of prebuilds) if (!list.some((at) => at > now - 60_000)) prebuilds.delete(k);
  };
  /** Builds that call Jupiter wait their turn behind the guard's queue (the wait is step `queue`). */
  const queued = <T>(work: () => Promise<T>, t?: Timings) => {
    if (!guard) return work();
    const waiting = Date.now();
    return guard.build(() => {
      t?.add("queue", Date.now() - waiting);
      return work();
    });
  };
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const allow = corsHeaders(cors, header(req, "origin"));
    /** Builds, refreshes and submits: where the time went, sent as Server-Timing (errors too). */
    let timings: Timings | undefined;
    const timed = () => (timings = new Timings());
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      const serverTiming: Record<string, string> = timings ? { "server-timing": timings.header() } : {};
      res.writeHead(status, { "content-type": "application/json", ...allow, ...serverTiming, ...headers });
      res.end(JSON.stringify(payload));
      log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    };
    try {
      const m = req.method;
      // A preflight from an allowed origin: answered before the guard (it isn't a read).
      if (m === "OPTIONS" && allow["access-control-allow-origin"]) {
        res.writeHead(204, {
          ...allow,
          "access-control-allow-methods": CORS.methods,
          "access-control-allow-headers": CORS.headers,
          "access-control-max-age": CORS.maxAge,
        });
        res.end();
        log(`OPTIONS ${url.pathname} 204 ${Date.now() - started}ms`);
        return;
      }
      if (m === "GET" && url.pathname === "/health") return send(200, { ok: true });
      if (m === "GET") guard?.checkRead(req);
      if (m === "GET" && url.pathname === "/config") return send(200, await service.publicConfig());
      if (m === "POST" && url.pathname === "/digests" && hooks.digest) {
        guard?.checkServiceOnly(req, "POST /digests");
        return send(200, await hooks.digest());
      }
      if (parts[0] === "takes" && parts[1]) {
        if (!UUID.test(parts[1])) throw new ApiError(400, "invalid_take_id");
        if (m === "GET" && parts.length === 2) return send(200, await service.receipt(parts[1], url.searchParams.get("viewer") ?? undefined));
        if (m === "POST" && parts[2] === "trades") {
          const b = await body(req);
          const side = b.side === "fade" ? "fade" : b.side === "back" ? "back" : null;
          if (!side) throw new ApiError(400, "invalid_side");
          const owner = str(b.owner, "owner");
          const usd = num(b.usd, "usd");
          const prebuild = b.prebuild === true;
          await buildLimits(req, owner, "trades", prebuild);
          const t = timed();
          return send(200, await queued(() => service.buildTrade(parts[1], owner, side, usd, { timings: t, prebuild }), t));
        }
        if (m === "POST" && parts[2] === "positions" && parts[3] && parts[4] === "exit" && parts.length === 5) {
          const b = await body(req);
          const owner = str(b.owner, "owner");
          const prebuild = b.prebuild === true;
          await buildLimits(req, owner, "sell", prebuild);
          const t = timed();
          return send(200, await queued(() => service.buildExit(parts[1], parts[3], owner, { timings: t, prebuild }), t));
        }
        if (m === "POST" && parts[2] === "confirm" && parts.length === 3) {
          // Harmless (it only re-delivers a landed publish), so it counts as a read.
          guard?.checkRead(req);
          return send(200, await service.confirmPublish(parts[1]));
        }
        if (m === "POST" && parts[2] === "publish") {
          const b = await body(req);
          const author = str(b.author, "author");
          const usd = num(b.usd, "usd");
          const prebuild = b.prebuild === true;
          await buildLimits(req, author, "publish", prebuild);
          const t = timed();
          return send(200, await queued(() => service.buildPublish(parts[1], author, usd, { timings: t, prebuild }), t));
        }
      }
      // No token needed: the API only sends what it built, and checks the owner's signature on it.
      // The body may come as text/plain (a CORS simple request: no preflight).
      if (m === "POST" && url.pathname === "/submit") {
        const b = await body(req);
        if (!Array.isArray(b.transactions) || !b.transactions.every((t) => typeof t === "string")) throw new ApiError(400, "missing_transactions");
        if (b.until !== undefined && b.until !== "accepted" && b.until !== "confirmed") throw new ApiError(400, "invalid_until", 'until is "accepted" or left out');
        const t = timed();
        const r = await service.submit(str(b.buildId, "buildId"), b.transactions as string[], {
          timings: t,
          clientTimings: b.timings,
          until: b.until === "accepted" ? "accepted" : undefined,
          // A prebuilt trade's money action counts now, once it's really being sent.
          admit: deferMoney ? ({ owner, prebuilt }) => void (prebuilt && g!.countMoney!(owner)) : undefined,
        });
        return send(r.status === "pending" ? 202 : 200, r);
      }
      // A fresh blockhash for a build (no Jupiter call): harmless, so it counts as a read.
      if (m === "POST" && parts[0] === "builds" && parts[1] && parts[2] === "refresh" && parts.length === 3) {
        if (!UUID.test(parts[1])) throw new ApiError(400, "invalid_build_id");
        guard?.checkRead(req);
        const t = timed();
        return send(200, await service.refreshBuild(parts[1], { timings: t }));
      }
      if (m === "GET" && parts[0] === "submissions" && parts[1] && parts.length === 2) {
        if (!UUID.test(parts[1])) throw new ApiError(400, "invalid_build_id");
        const wait = Math.max(0, Math.min(SUBMISSION_WAIT_MAX_MS, Number(url.searchParams.get("wait") ?? 0) || 0));
        return send(200, await service.submission(parts[1], wait));
      }
      if (parts[0] === "wallets" && parts[1] && parts[2] === "creator-fees") {
        if (m === "GET" && parts.length === 3) {
          // Only the wallet itself: it signs a short-lived message (Privy's signMessage).
          checkWalletAuth(parts[1], header(req, "x-thesis-wallet-auth"));
          return send(200, await service.creatorFees(parts[1]));
        }
        if (m === "POST" && parts[3] === "claim" && parts.length === 4) {
          const b = await body(req);
          const takes = Array.isArray(b.takes) ? b.takes.filter((t): t is string => typeof t === "string").slice(0, 200) : undefined;
          await money(req, parts[1], "claim");
          return send(200, await service.buildClaimCreatorFees(parts[1], takes));
        }
      }
      if (parts[0] === "wallets" && parts[1] && parts[2] === "phoenix") {
        if (m === "GET" && parts.length === 3) return send(200, await service.phoenixCash(parts[1]));
        if (m === "POST" && parts[3] === "cash-out" && parts.length === 4) {
          await money(req, parts[1], "cash-out");
          return send(200, await service.buildPhoenixCashOut(parts[1]));
        }
      }
      if (parts[0] === "wallets" && parts[1] && parts.length === 3 && ["incomplete", "retry", "sweep"].includes(parts[2])) {
        // Split trades that stopped partway (api/split.ts).
        if (m === "GET" && parts[2] === "incomplete") return send(200, service.incompleteTrades(parts[1]));
        if (m === "POST" && parts[2] !== "incomplete") {
          const position = optionalStr((await body(req)).position, "position");
          await money(req, parts[1], parts[2]);
          return send(200, await queued<unknown>(() => (parts[2] === "retry" ? service.buildRetry(parts[1], position) : service.buildSweep(parts[1], position))));
        }
      }
      if (parts[0] === "wallets" && parts[1]) {
        if (m === "GET" && parts.length === 2) return send(200, await service.wallet(parts[1]));
        if (m === "GET" && parts[2] === "portfolio") return send(200, await service.portfolio(parts[1]));
        if (m === "GET" && parts[2] === "history") return send(200, await service.history(parts[1], url.searchParams.get("range") ?? "ALL"));
        if (m === "POST" && parts[2] === "deposits") {
          const usd = num((await body(req)).usd, "usd");
          await money(req, parts[1], "deposit");
          return send(200, await service.deposit(parts[1], usd));
        }
        // Play money stays on the fork.
        if (m === "POST" && parts[2] === "withdrawals") throw new ApiError(403, "withdrawals_off", "Play money can't be withdrawn.");
      }
      throw new ApiError(404, "no_such_route");
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { ...e.body, error: e.code, message: e.message }, e.headers);
      // The details go to the log only: they can name internal hosts, keys' owners or RPC errors.
      log(`error: ${e instanceof Error ? e.stack : e}`);
      return send(500, { error: "internal", message: "Something went wrong. Try again in a moment." });
    }
  });
}
