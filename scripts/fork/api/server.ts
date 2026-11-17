// HTTP in front of ForkService. JSON in and out; errors are { error, message } with a status.
//
//   GET  /health
//   GET  /takes/:id?viewer=<wallet>                 the on-chain receipt (or what would be on-chain)
//   POST /takes/:id/trades   { owner, side, usd }   → { buildId, transactions[], included, excluded, feeUsd }
//   POST /takes/:id/publish  { author, usd }        → same, for posting an app take with the author's buy-in
//   POST /takes/:id/confirm                         → { onChain, take?, relayed }: is the author's publish
//                                                     on-chain here? If so, its events go to the backend again
//   POST /submit             { buildId, transactions[] }  signed by the user → { signatures[] }
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
//
// The shared fork is public, so money routes (trades, publish, sales, cash in, Phoenix cash-out,
// claims) go through the Guard when one is passed: a Privy token or a service key, per-wallet rate
// limits, and a queue for builds that call Jupiter. Reads are rate-limited per IP. Withdrawals are
// off: play money stays on the fork. See api/guard.ts and the README's "Abuse limits".
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { checkWalletAuth } from "./creator-fees.ts";
import type { Guard } from "./guard.ts";
import { ApiError, type ForkService } from "./service.ts";

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

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
const num = (v: unknown, name: string) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new ApiError(400, `missing_${name}`);
  return n;
};

/**
 * `digest`: runs today's position digests now (POST /digests), when the caller wires it.
 * `guard`: abuse limits (api/guard.ts); without one every route is open, as on a private fork.
 */
export function forkApiServer(
  service: ForkService,
  log: (m: string) => void = () => {},
  hooks: { digest?: () => Promise<unknown>; guard?: Guard } = {},
): Server {
  const guard = hooks.guard;
  /** A money action for `wallet`: who's asking, and the wallet's rate limits. */
  const money = async (req: IncomingMessage, wallet: string, route: string) => {
    if (guard) await guard.checkMoney(req, wallet, route);
  };
  /** Builds that call Jupiter wait their turn behind the guard's queue. */
  const queued = <T>(work: () => Promise<T>) => (guard ? guard.build(work) : work());
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
      log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    };
    try {
      const m = req.method;
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
          await money(req, owner, "trades");
          return send(200, await queued(() => service.buildTrade(parts[1], owner, side, usd)));
        }
        if (m === "POST" && parts[2] === "positions" && parts[3] && parts[4] === "exit" && parts.length === 5) {
          const owner = str((await body(req)).owner, "owner");
          await money(req, owner, "sell");
          return send(200, await queued(() => service.buildExit(parts[1], parts[3], owner)));
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
          await money(req, author, "publish");
          return send(200, await queued(() => service.buildPublish(parts[1], author, usd)));
        }
      }
      // No token needed: the API only sends what it built, and checks the owner's signature on it.
      if (m === "POST" && url.pathname === "/submit") {
        const b = await body(req);
        if (!Array.isArray(b.transactions) || !b.transactions.every((t) => typeof t === "string")) throw new ApiError(400, "missing_transactions");
        return send(200, await service.submit(str(b.buildId, "buildId"), b.transactions as string[]));
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
      if (e instanceof ApiError) return send(e.status, { error: e.code, message: e.message }, e.headers);
      log(`error: ${e instanceof Error ? e.stack : e}`);
      return send(500, { error: "internal", message: e instanceof Error ? e.message : String(e) });
    }
  });
}
