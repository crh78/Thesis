// cash: your balance, deposits, withdrawals, and trades / fades (any amount from $1).
//
//   GET  /cash                              → { balance, rules, activity, has_more } (newest 50)
//   GET  /cash/activity?before_at=…&before_id=…  → { activity, has_more } (the next 50)
//   GET  /cash/positions                    → { positions: [{ take, side, amount, shares, avg_price, price, value, count, first_at, last_at }] }
//   POST /cash/deposits     { amount, method }   → same summary
//   POST /cash/withdrawals  { amount, method }   → same summary
//   POST /cash/trades       { take_id, side, amount? }  → { cash: summary, take }  (amount defaults to $20)
//   POST /cash/sells        { take_id, side, amount? }  → { cash: summary, sold, pnl, closed }  (no amount = all of it)
//
// method: 'apple_pay' | 'debit' | 'bank' | 'transfer'. side: 'trade' | 'fade'.
// A take's price is 1 + its return; trades buy shares at it and sells pay at it
// (see migrations/*_positions_and_selling.sql).
// Errors: 400 { error: below_minimum | over_daily_limit | insufficient_funds | no_position | not_tradeable | invalid_… },
// 401 invalid_privy_token, 403 needs_onboarding, 404 not_found.
//
// The money logic (limits, balance checks, the platform's side of every
// transfer) lives in SQL (migrations/*_cash.sql) so it's atomic per user.
// Deposits and withdrawals are simulated until an on/offramp provider exists.
// Gateway JWT verification is off (config.toml): the token is Privy's.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { privyDid } from "../_shared/privy.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = new Set(["apple_pay", "debit", "bank", "transfer"]);
const SIDES = new Set(["trade", "fade"]);
// Messages the SQL functions raise for the user to see.
const USER_ERRORS = new Set([
  "below_minimum", "over_daily_limit", "insufficient_funds", "invalid_side", "no_position", "not_tradeable",
]);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fail = (status: number, error: string) => json(status, { error });

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    if (error.code === "22023" && USER_ERRORS.has(error.message)) throw new HttpError(400, error.message);
    if (error.code === "P0002") throw new HttpError(404, "not_found");
    console.error(fn, error);
    throw new HttpError(500, "internal");
  }
  return data as T;
}

/** Dollars with at most two decimals. */
function amountFrom(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0 || Math.round(n * 100) !== n * 100) {
    throw new HttpError(400, "invalid_amount");
  }
  return n;
}

Deno.serve(async (req) => {
  try {
    const did = await privyDid(req);
    if (!did) return fail(401, "invalid_privy_token");
    const me = await rpc<string>("ensure_account", { p_privy_did: did });

    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    const at = parts.indexOf("cash");
    const resource = parts[at + 1] ?? "";

    if (req.method === "GET" && resource === "") {
      return json(200, await rpc("cash_summary", { p_profile: me }));
    }
    // Your positions: every take you've traded or faded.
    if (req.method === "GET" && resource === "positions") {
      return json(200, { positions: await rpc("cash_positions", { p_profile: me }) });
    }
    // Older activity: the page after the last entry you have.
    if (req.method === "GET" && resource === "activity") {
      const q = new URL(req.url).searchParams;
      const beforeAt = q.get("before_at");
      const beforeId = q.get("before_id");
      if (!beforeAt || Number.isNaN(Date.parse(beforeAt)) || !beforeId || !UUID_RE.test(beforeId)) {
        return fail(400, "invalid_cursor");
      }
      return json(200, await rpc("cash_activity", { p_profile: me, p_before_at: beforeAt, p_before_id: beforeId }));
    }
    if (req.method !== "POST") return fail(405, "method_not_allowed");

    const { data: profile, error } = await db.from("profiles").select("handle").eq("id", me).single();
    if (error) throw new HttpError(500, "internal");
    if (!profile.handle) return fail(403, "needs_onboarding");

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return fail(400, "invalid_json");
    }
    if (!body || typeof body !== "object") return fail(400, "invalid_json");

    switch (resource) {
      case "deposits":
      case "withdrawals": {
        const method = String(body.method ?? "");
        if (!METHODS.has(method)) return fail(400, "invalid_method");
        const fn = resource === "deposits" ? "cash_deposit" : "cash_withdraw";
        return json(200, await rpc(fn, { p_profile: me, p_amount: amountFrom(body.amount), p_method: method }));
      }
      case "trades": {
        const takeId = String(body.take_id ?? "");
        const side = String(body.side ?? "");
        if (!UUID_RE.test(takeId)) return fail(400, "invalid_take_id");
        if (!SIDES.has(side)) return fail(400, "invalid_side");
        // Any amount from $1 (SQL checks it and the balance); none sent = $20.
        const amount = body.amount === undefined || body.amount === null ? null : amountFrom(body.amount);
        return json(200, await rpc("place_trade", { p_profile: me, p_take: takeId, p_side: side, p_amount: amount }));
      }
      case "sells": {
        const takeId = String(body.take_id ?? "");
        const side = String(body.side ?? "");
        if (!UUID_RE.test(takeId)) return fail(400, "invalid_take_id");
        if (!SIDES.has(side)) return fail(400, "invalid_side");
        // Dollars of the position to sell at the current price; none sent = all of it.
        const amount = body.amount === undefined || body.amount === null ? null : amountFrom(body.amount);
        return json(200, await rpc("sell_position", { p_profile: me, p_take: takeId, p_side: side, p_amount: amount }));
      }
      default:
        return fail(404, "no_such_route");
    }
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code);
    console.error(e);
    return fail(500, "internal");
  }
});
