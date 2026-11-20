// agent: trades for people by text, within the limits they approved once (decided 2026-11-19).
// The X reply agent, iMessage trading, and later auto-copy and the MCP server all trade here.
//
// The user's own routes (Privy token, from the web app's limits screen /limits):
//   GET    /agent/grant              → { grant, signer_id, policy_ids } the caller's limits
//                                      (grant null when never approved): { per_trade_usd, daily_usd,
//                                      left_usd, x_username, imessage, active }
//   PUT    /agent/grant              { per_trade_usd, daily_usd, link? } after the web app added our
//                                      session signer to the caller's wallet: saves the limits, the X
//                                      account Privy links, and (link: the token from an iMessage
//                                      connect link) that iMessage handle → { grant }.
//                                      409 signer_missing when the signer isn't on the wallet yet,
//                                      409 no_wallet, 410 link_expired
//   DELETE /agent/grant              stops the agent (the web app removes the signer too) → { revoked }
//   GET    /agent/links/:token       → { handle, expired } an iMessage connect link: the handle,
//                                      masked to its last 4, so the screen can say who it connects
//
// The bots' routes (header x-bot-secret: the Vault's bot_secret, as for functions/source):
//   POST   /agent/links              { imessage } → { url } a one-time connect link (30 minutes)
//   POST   /agent/whois              { who: { x: <X user id> } | { imessage } } → { linked: false }
//                                      or { linked, active, per_trade_usd, daily_usd, left_usd, handle }
//   POST   /agent/trades             { who, surface: x|imessage|copy|mcp, ref?, action, ... }
//                                      action post: { draft_id, usd } posts a bot's draft as the
//                                        user's take with that buy-in;
//                                      back | fade: { take_id, usd };
//                                      sell: { take_id, side?: back|fade, bps? | usd? } (all of it
//                                        when neither).
//                                      → { status: landed|pending|failed, trade_id, take_id, url,
//                                        usd, signatures, closes_take?, error? }. The same surface +
//                                      ref is the same trade (a retried message never trades twice).
//                                      403 not_linked | over_trade_limit | over_daily_limit
//                                      ({ per_trade_usd, left_usd, confirm_url }: the take's page,
//                                      to trade it by hand), 409 draft_posted, 403
//                                      draft_for_other_account; a fork refusal passes through as
//                                      { error, message } with its status
//   POST   /agent/positions          { who } → { positions } open positions (the fork API's portfolio)
//   POST   /agent/takes              { take_id } → { claim, author, status } a live take (the
//                                      bots' confirmation text names it); 404 no_such_take
//   A trade with wait: false answers once the fork accepted it (status pending) and follows it
//   to the end in the background (EdgeRuntime.waitUntil), so a bot can say "you're in" sooner.
//
// How a trade runs: agent_reserve (migrations/*_agent_grants.sql) holds it to the limits and
// records it; the fork API builds it for the user's wallet (service key); Privy signs each
// transaction with our session signer (./privy.ts); the fork API sends it. A build refused for
// moved prices is built and signed once more.
//
// Secrets: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_VERIFICATION_KEY (as the other functions),
// PRIVY_AUTHORIZATION_KEY (the session signer's private key) and PRIVY_SIGNER_ID (its id),
// PRIVY_SIGNER_POLICY_IDS (optional, comma-separated), FORK_API_URL and FORK_API_SERVICE_KEY (the
// fork API's "agent" service key), WEB_URL (default https://yourthesis.xyz). BOT_SECRET from the
// function's secrets or the Vault's bot_secret.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { privyDid } from "../_shared/privy.ts";
import { embeddedSolana, hasSigner, linkedX, PrivyError, privyClient } from "./privy.ts";
import {
  ACTIONS, type Action, isRequote, LINK_TTL_MS, linkToken, MIN_USD, normalizeHandle, readLimits, readWho, sha256Hex,
  SURFACES, type Surface, takeLegs, topicGuess, type Who,
} from "./rules.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const env = (k: string) => Deno.env.get(k) ?? "";
const WEB_URL = (env("WEB_URL") || "https://yourthesis.xyz").replace(/\/$/, "");
const SIGNER_ID = env("PRIVY_SIGNER_ID") || null;
const POLICY_IDS = env("PRIVY_SIGNER_POLICY_IDS").split(",").map((s) => s.trim()).filter(Boolean);
const privy = privyClient({
  appId: env("PRIVY_APP_ID"),
  appSecret: env("PRIVY_APP_SECRET"),
  authorizationKey: env("PRIVY_AUTHORIZATION_KEY") || null,
  signerId: SIGNER_ID,
});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRAFT_ID_RE = /^[A-Za-z0-9]{8}$/;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(code);
  }
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, privy-token, content-type, x-bot-secret",
  "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
};
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new HttpError(400, code);
}
function dbCheck(error: { message?: string } | null) {
  if (!error) return;
  console.error(error);
  throw new HttpError(500, "internal");
}

// Secrets -----------------------------------------------------------------------------------------

let botSecret: string | null = null;
async function requireBot(req: Request) {
  if (botSecret === null) {
    let v = env("BOT_SECRET");
    if (!v) {
      const { data, error } = await db.rpc("source_secret", { p_name: "bot_secret" });
      if (error) console.error("vault", error.message);
      v = typeof data === "string" ? data : "";
    }
    if (!v) throw new HttpError(503, "bot_secret_missing");
    botSecret = v;
  }
  const given = req.headers.get("x-bot-secret") ?? "";
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(botSecret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  if (diff !== 0) throw new HttpError(401, "invalid_bot_secret");
}

async function requireUser(req: Request): Promise<{ did: string; profile: string }> {
  const did = await privyDid(req);
  if (!did) throw new HttpError(401, "invalid_privy_token");
  const { data, error } = await db.rpc("ensure_account", { p_privy_did: did });
  dbCheck(error);
  return { did, profile: data as string };
}

// Grants ------------------------------------------------------------------------------------------

type Grant = {
  profile_id: string; wallet: string; privy_wallet_id: string; per_trade_usd: number; daily_usd: number;
  x_user_id: string | null; x_username: string | null; imessage: string | null; revoked_at: string | null;
};

async function spent(profile: string): Promise<number> {
  const { data, error } = await db.rpc("agent_spent", { p_profile: profile });
  dbCheck(error);
  return Number(data) || 0;
}

async function grantView(g: Grant) {
  const left = Math.max(Number(g.daily_usd) - await spent(g.profile_id), 0);
  return {
    per_trade_usd: Number(g.per_trade_usd), daily_usd: Number(g.daily_usd), left_usd: left,
    x_username: g.x_username, imessage: g.imessage, active: !g.revoked_at,
  };
}

async function getGrant(profile: string) {
  const { data, error } = await db.from("agent_grants").select("*").eq("profile_id", profile).maybeSingle();
  dbCheck(error);
  return json(200, { grant: data ? await grantView(data as Grant) : null, signer_id: SIGNER_ID, policy_ids: POLICY_IDS });
}

async function putGrant(did: string, profile: string, b: Record<string, unknown>) {
  if (!SIGNER_ID) throw new HttpError(503, "signer_not_configured");
  const limits = readLimits(b);
  check(limits, "invalid_limits");

  const user = await privy.user(did);
  const sol = embeddedSolana(user);
  if (!sol) throw new HttpError(409, "no_wallet");
  const walletId = sol.walletId ?? await privy.walletIdFor(did, sol.address);
  if (!walletId) throw new HttpError(409, "no_wallet");
  const wallet = await privy.wallet(walletId);
  if (wallet.address !== sol.address) throw new HttpError(409, "no_wallet");
  if (!hasSigner(wallet, SIGNER_ID)) throw new HttpError(409, "signer_missing");
  const x = linkedX(user);

  let imessage: string | null | undefined; // undefined: keep what's there
  if (typeof b.link === "string" && b.link) {
    const hash = await sha256Hex(b.link);
    const { data, error } = await db.from("agent_links").update({ used_at: new Date().toISOString() })
      .eq("token_hash", hash).is("used_at", null).gt("expires_at", new Date().toISOString()).select("imessage");
    dbCheck(error);
    if (!data?.length) throw new HttpError(410, "link_expired");
    imessage = data[0].imessage as string;
  }

  // A handle answers to one account: the newest approval takes it.
  if (imessage) dbCheck((await db.from("agent_grants").update({ imessage: null }).eq("imessage", imessage).neq("profile_id", profile)).error);
  if (x) dbCheck((await db.from("agent_grants").update({ x_user_id: null, x_username: null }).eq("x_user_id", x.id).neq("profile_id", profile)).error);

  const row: Record<string, unknown> = {
    profile_id: profile, wallet: sol.address, privy_wallet_id: walletId,
    per_trade_usd: limits.perTradeUsd, daily_usd: limits.dailyUsd,
    x_user_id: x?.id ?? null, x_username: x?.username ?? null,
    revoked_at: null, updated_at: new Date().toISOString(),
  };
  if (imessage !== undefined) row.imessage = imessage;
  const { data, error } = await db.from("agent_grants").upsert(row, { onConflict: "profile_id" }).select("*").single();
  dbCheck(error);
  return json(200, { grant: await grantView(data as Grant) });
}

async function revokeGrant(profile: string) {
  const { error } = await db.from("agent_grants").update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("profile_id", profile);
  dbCheck(error);
  return json(200, { revoked: true });
}

async function grantFor(who: Who): Promise<Grant | null> {
  const q = db.from("agent_grants").select("*");
  const { data, error } = await ("x" in who ? q.eq("x_user_id", who.x) : q.eq("imessage", who.imessage)).maybeSingle();
  dbCheck(error);
  return (data as Grant | null) ?? null;
}

// Links -------------------------------------------------------------------------------------------

async function makeLink(b: Record<string, unknown>) {
  const handle = typeof b.imessage === "string" ? normalizeHandle(b.imessage) : null;
  check(handle, "invalid_imessage");
  const token = linkToken();
  const { error } = await db.from("agent_links").insert({
    token_hash: await sha256Hex(token), imessage: handle, expires_at: new Date(Date.now() + LINK_TTL_MS).toISOString(),
  });
  dbCheck(error);
  // Old links are only clutter: drop the ones that ran out a day ago.
  void db.from("agent_links").delete().lt("expires_at", new Date(Date.now() - 86_400_000).toISOString()).then(() => {});
  return json(200, { url: `${WEB_URL}/limits?link=${token}` });
}

async function peekLink(token: string) {
  const { data, error } = await db.from("agent_links").select("imessage, expires_at, used_at").eq("token_hash", await sha256Hex(token)).maybeSingle();
  dbCheck(error);
  if (!data) throw new HttpError(404, "no_such_link");
  const expired = !!data.used_at || new Date(data.expires_at).getTime() < Date.now();
  return json(200, { handle: `…${String(data.imessage).slice(-4)}`, expired });
}

async function whois(b: Record<string, unknown>) {
  const who = readWho(b.who);
  check(who, "invalid_who");
  const g = await grantFor(who);
  if (!g) return json(200, { linked: false });
  const { data } = await db.from("profiles").select("handle").eq("id", g.profile_id).maybeSingle();
  return json(200, { linked: true, handle: data?.handle ?? null, ...await grantView(g) });
}

// The fork API ------------------------------------------------------------------------------------

class ForkRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body: Record<string, unknown>) {
    super(message);
  }
}

async function fork<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const base = env("FORK_API_URL").replace(/\/$/, "");
  const key = env("FORK_API_SERVICE_KEY");
  if (!base || !key) throw new HttpError(503, "fork_not_configured");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-thesis-service-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });
  const out = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof out.error === "string" ? out.error : `fork_${res.status}`;
    throw new ForkRefusal(res.status, code, typeof out.message === "string" ? out.message : code, out);
  }
  return out as T;
}

type Built = { buildId: string; transactions: string[]; closesTake?: boolean; feeUsd?: number; escrowUsd?: number | null; expectedUsd?: number | null };
type Submission = { status?: string; signatures?: string[]; error?: { code?: string; message?: string } };

// Trades ------------------------------------------------------------------------------------------

type TradeReq = {
  who: Who; surface: Surface; ref: string | null; action: Action; wait: boolean;
  takeId: string | null; draftId: string | null; usd: number | null; bps: number | null; side: "back" | "fade";
};

function readTrade(b: Record<string, unknown>): TradeReq {
  const who = readWho(b.who);
  check(who, "invalid_who");
  const surface = SURFACES.find((s) => s === b.surface);
  check(surface, "invalid_surface");
  const action = ACTIONS.find((a) => a === b.action);
  check(action, "invalid_action");
  const ref = typeof b.ref === "string" && b.ref.trim() ? b.ref.trim().slice(0, 120) : null;
  const takeId = typeof b.take_id === "string" && UUID_RE.test(b.take_id) ? b.take_id : null;
  const draftId = typeof b.draft_id === "string" && DRAFT_ID_RE.test(b.draft_id) ? b.draft_id : null;
  const usd = b.usd == null ? null : Math.round(Number(b.usd) * 100) / 100;
  const bps = b.bps == null ? null : Math.round(Number(b.bps));
  if (usd !== null) check(Number.isFinite(usd) && usd > 0 && usd <= 1000, "invalid_usd");
  if (bps !== null) check(Number.isInteger(bps) && bps >= 1 && bps <= 10_000, "invalid_bps");
  if (action === "post") check(draftId && usd !== null && usd >= MIN_USD, draftId ? "invalid_usd" : "invalid_draft_id");
  if (action === "back" || action === "fade") check(takeId && usd !== null && usd >= MIN_USD, takeId ? "invalid_usd" : "invalid_take_id");
  if (action === "sell") check(takeId, "invalid_take_id");
  return { who, surface, ref, action, takeId, draftId, usd, bps, side: b.side === "fade" ? "fade" : "back", wait: b.wait !== false };
}

async function finish(id: string, fields: Record<string, unknown>) {
  const { error } = await db.from("agent_trades").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) console.error("agent_trades update", error.message);
}

/** Posts a bot's draft as the user's take (status posting until its buy-in lands): its take id. */
async function createFromDraft(g: Grant, draftId: string): Promise<{ takeId: string; draft: Record<string, unknown> }> {
  const { data: d, error } = await db.from("take_drafts").select("*").eq("id", draftId).maybeSingle();
  dbCheck(error);
  if (!d) throw new HttpError(404, "no_such_draft");
  if (d.take_id) throw new HttpError(409, "draft_posted", { take_id: d.take_id });
  if (d.for_x && d.for_x !== g.x_username) throw new HttpError(403, "draft_for_other_account");
  const legs = takeLegs(Array.isArray(d.legs) ? d.legs : []);
  check(legs.length, "draft_has_no_legs");
  const { topic, tags } = topicGuess(d.claim, legs);
  const { data: takeId, error: e2 } = await db.rpc("create_take", {
    p_author: g.profile_id, p_claim: d.claim, p_topic: topic, p_risk: d.risk, p_horizon: null,
    p_tags: tags, p_legs: legs, p_status: "posting",
  });
  if (e2?.message?.includes("takes_one_posting_claim")) throw new HttpError(409, "already_posting");
  dbCheck(e2);
  if (d.source_url) {
    await db.from("takes").update({ source_url: d.source_url, source_label: d.source_label, source_kind: d.source_kind ?? "x" })
      .eq("id", takeId).is("source_url", null);
  }
  // The draft's page only shows the take once it's live (take_draft()).
  await db.from("take_drafts").update({ take_id: takeId, posted_at: new Date().toISOString() }).eq("id", draftId).is("take_id", null);
  return { takeId: takeId as string, draft: d };
}

function buildFor(t: TradeReq, g: Grant, takeId: string): Promise<Built> {
  if (t.action === "post") return fork<Built>("POST", `/takes/${takeId}/publish`, { author: g.wallet, usd: t.usd });
  if (t.action === "sell") {
    return fork<Built>("POST", `/takes/${takeId}/sell`, { owner: g.wallet, side: t.side, ...(t.bps ? { bps: t.bps } : t.usd ? { usd: t.usd } : {}) });
  }
  return fork<Built>("POST", `/takes/${takeId}/trades`, { owner: g.wallet, side: t.action, usd: t.usd });
}

async function signAndSend(t: TradeReq, g: Grant, takeId: string): Promise<{ built: Built; sub: Submission }> {
  for (let attempt = 0; ; attempt++) {
    const built = await buildFor(t, g, takeId);
    const signed = await Promise.all(built.transactions.map((tx) => privy.signTransaction(g.privy_wallet_id, tx)));
    try {
      const sub = await fork<Submission & { buildId?: string }>("POST", "/submit", { buildId: built.buildId, transactions: signed, until: "accepted" });
      return { built, sub };
    } catch (e) {
      if (attempt === 0 && e instanceof ForkRefusal && isRequote(e.code, e.body)) continue;
      throw e;
    }
  }
}

/** Waits up to ~25 s for a pending submit to land. */
async function settle(buildId: string, sub: Submission): Promise<Submission> {
  let s = sub;
  for (let i = 0; i < 3 && (s.status === "pending" || s.status === undefined && !s.signatures?.length); i++) {
    s = await fork<Submission>("GET", `/submissions/${buildId}?wait=9000`).catch(() => s);
  }
  // An older fork API answers /submit only once confirmed, with no status.
  return s.status ? s : { ...s, status: s.signatures?.length ? "landed" : "pending" };
}

async function trade(b: Record<string, unknown>) {
  const t = readTrade(b);
  const g = await grantFor(t.who);
  if (!g || g.revoked_at) throw new HttpError(403, "not_linked");
  const confirmUrl = t.action === "post" ? `${WEB_URL}/d/${t.draftId}` : `${WEB_URL}/t/${t.takeId}`;

  const { data: r, error } = await db.rpc("agent_reserve", {
    p_profile: g.profile_id, p_surface: t.surface, p_ref: t.ref, p_action: t.action,
    p_take: t.takeId, p_usd: t.usd, p_bps: t.bps,
  });
  dbCheck(error);
  const res = r as Record<string, unknown>;
  if (typeof res.error === "string") {
    if (res.error === "no_grant") throw new HttpError(403, "not_linked");
    throw new HttpError(403, res.error, { per_trade_usd: res.per_trade_usd, left_usd: res.left_usd, confirm_url: confirmUrl });
  }
  const tradeId = res.id as string;
  if (res.existing) {
    const takeId = (res.take_id as string | null) ?? t.takeId;
    return json(200, {
      status: res.status, trade_id: tradeId, take_id: takeId, url: takeId ? `${WEB_URL}/t/${takeId}` : null,
      usd: t.usd, signatures: res.signatures ?? [], existing: true, ...(res.error ? { error: { code: res.error } } : {}),
    });
  }

  let takeId = t.takeId;
  let created = false;
  try {
    if (t.action === "post") {
      takeId = (await createFromDraft(g, t.draftId!)).takeId;
      created = true;
      await finish(tradeId, { take_id: takeId });
    }
    const { built, sub } = await signAndSend(t, g, takeId!);
    if (!t.wait && sub.status === "pending") {
      // Answer now; follow it to the end in the background.
      const tail = settle(built.buildId, sub).then(async (d) => {
        const st = d.status === "landed" ? "landed" : d.status === "pending" ? "pending" : "failed";
        await finish(tradeId, { status: st, build_id: built.buildId, signatures: d.signatures ?? null, error: d.error?.code?.slice(0, 200) ?? null });
        if (st === "failed" && created) await db.rpc("discard_posting_take", { p_author: g.profile_id, p_id: takeId });
      }).catch((e) => console.error("settle", e));
      const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
      if (rt) rt.waitUntil(tail);
      await finish(tradeId, { build_id: built.buildId, signatures: sub.signatures ?? null });
      return json(200, {
        status: "pending", trade_id: tradeId, take_id: takeId, url: `${WEB_URL}/t/${takeId}`, usd: t.usd ?? built.expectedUsd ?? null,
        signatures: sub.signatures ?? [], closes_take: built.closesTake ?? false,
      });
    }
    const done = await settle(built.buildId, sub);
    const status = done.status === "landed" ? "landed" : done.status === "pending" ? "pending" : "failed";
    await finish(tradeId, { status, build_id: built.buildId, signatures: done.signatures ?? null, error: done.error?.code?.slice(0, 200) ?? null });
    if (status === "failed" && created) await db.rpc("discard_posting_take", { p_author: g.profile_id, p_id: takeId });
    return json(200, {
      status, trade_id: tradeId, take_id: takeId, url: `${WEB_URL}/t/${takeId}`, usd: t.usd ?? built.expectedUsd ?? null,
      signatures: done.signatures ?? [], closes_take: built.closesTake ?? false, ...(done.error ? { error: done.error } : {}),
    });
  } catch (e) {
    const code = e instanceof ForkRefusal || e instanceof HttpError ? e.code : e instanceof PrivyError ? "signing_failed" : "internal";
    await finish(tradeId, { status: "failed", error: code.slice(0, 200) });
    if (created && takeId) await db.rpc("discard_posting_take", { p_author: g.profile_id, p_id: takeId });
    if (e instanceof ForkRefusal) throw new HttpError(e.status >= 500 ? 502 : e.status, e.code, { message: e.message, confirm_url: confirmUrl });
    if (e instanceof PrivyError) {
      console.error(e.message);
      // 401/403 from Privy: the signer was removed or a policy refused it.
      throw new HttpError(e.status === 401 || e.status === 403 ? 403 : 502, "signing_failed", { confirm_url: confirmUrl });
    }
    throw e;
  }
}

async function takeInfo(b: Record<string, unknown>) {
  const id = typeof b.take_id === "string" && UUID_RE.test(b.take_id) ? b.take_id : null;
  check(id, "invalid_take_id");
  const { data, error } = await db.from("takes").select("claim, status, profiles:author_id(handle)").eq("id", id).maybeSingle();
  dbCheck(error);
  if (!data || data.status !== "live") throw new HttpError(404, "no_such_take");
  const author = (data.profiles as { handle?: string | null } | null)?.handle ?? null;
  return json(200, { claim: data.claim, author, status: data.status });
}

async function positions(b: Record<string, unknown>) {
  const who = readWho(b.who);
  check(who, "invalid_who");
  const g = await grantFor(who);
  if (!g || g.revoked_at) throw new HttpError(403, "not_linked");
  const p = await fork<{ positions?: Record<string, unknown>[] }>("GET", `/wallets/${g.wallet}/portfolio`);
  const open = (p.positions ?? []).filter((x) => !x.exited).map((x) => ({
    take_id: x.takeId, claim: x.claim, side: x.side, stake_usd: x.stakeUsd, value_usd: x.valueUsd,
    return_bps: x.returnBps, can_exit: x.canExit, closes_take_if_sold_all: x.closesTakeIfSoldAll ?? false,
  }));
  return json(200, { positions: open });
}

// Router ------------------------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const i = parts.indexOf("agent");
  const [route, arg] = i >= 0 ? parts.slice(i + 1) : parts;
  const m = req.method;
  const body = async () => {
    try {
      const b = await req.json();
      return b && typeof b === "object" ? b as Record<string, unknown> : {};
    } catch {
      return {};
    }
  };
  try {
    if (route === "grant") {
      const { did, profile } = await requireUser(req);
      if (m === "GET") return await getGrant(profile);
      if (m === "PUT") return await putGrant(did, profile, await body());
      if (m === "DELETE") return await revokeGrant(profile);
    }
    if (route === "links" && arg && m === "GET") return await peekLink(arg);
    if (m === "POST" && ["links", "whois", "trades", "positions", "takes"].includes(route ?? "")) {
      await requireBot(req);
      const b = await body();
      if (route === "links") return await makeLink(b);
      if (route === "whois") return await whois(b);
      if (route === "trades") return await trade(b);
      if (route === "positions") return await positions(b);
      if (route === "takes") return await takeInfo(b);
    }
    return json(404, { error: "not_found" });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.code, ...e.extra });
    if (e instanceof ForkRefusal) return json(e.status >= 500 ? 502 : e.status, { error: e.code, message: e.message });
    if (e instanceof PrivyError) {
      console.error(e.message);
      return json(502, { error: "privy_unavailable" });
    }
    console.error(e);
    return json(500, { error: "internal" });
  }
});
