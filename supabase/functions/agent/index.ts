// agent: trades for people by text, within the limits they approved once (decided 2026-11-19).
// The X reply agent, iMessage trading, and later auto-copy and the MCP server all trade here.
//
// The user's own routes (Privy token, from the web app's limits screen /limits):
//   GET    /agent/grant              → { grant, signer_id, policy_ids, max_usd } the caller's limits
//                                      (grant null when never approved): { per_trade_usd, daily_usd,
//                                      left_usd, x_username, imessage, active }
//   PUT    /agent/grant              { per_trade_usd, daily_usd, link? } after the web app added our
//                                      session signer to the caller's wallet: saves the limits, the X
//                                      account Privy links, and (link: the token from an iMessage
//                                      connect link) that iMessage handle → { grant }.
//                                      409 signer_missing when the signer isn't on the wallet yet,
//                                      409 no_wallet, 410 link_expired
//   DELETE /agent/grant              stops the agent (the web app removes the signer too) → { revoked }
//   GET    /agent/copies             → { x, traders, jobs, linked } who the caller copies, each with
//                                      its auto-copy settings, and their last 20 auto-copies
//   PUT    /agent/copies/x/:handle   { auto?, usd?, daily? } settings for an X account the caller
//                                      copies (added through functions/source PUT /source/x/:handle)
//   PUT    /agent/copies/trader/:id  { auto?, usd?, daily? } copy a Thesis trader (auto-backs their
//                                      new takes) or change the settings → { trader }
//   DELETE /agent/copies/x/:handle | /agent/copies/trader/:id   stop copying
//   GET    /agent/links/:token       → { handle, expired } an iMessage connect link: the handle,
//                                      masked to its last 4, so the screen can say who it connects
//
// The bots' routes (header x-bot-secret: the Vault's bot_secret, as for functions/source):
//   POST   /agent/links              { imessage } → { url } a one-time connect link (30 minutes)
//   POST   /agent/whois              { who: { x: <X user id> } | { imessage } } → { linked: false,
//                                      signed_up } or { linked, signed_up, active, per_trade_usd,
//                                      daily_usd, left_usd, handle }; signed_up: a Thesis account links
//                                      that X account (asked of Privy; null when it didn't answer)
//   POST   /agent/trades             { who, surface: x|imessage|copy|mcp, ref?, action, ... }
//                                      action post: { draft_id, usd } posts a bot's draft as the
//                                        user's take with that buy-in;
//                                      back | fade: { take_id, usd };
//                                      sell: { take_id, side?: back|fade, bps? | usd? } (all of it
//                                        when neither). Sides are take-relative, as the fork API
//                                        reads them: back agrees with the take, fade disagrees (on
//                                        an inverted take, agreeing is an on-chain fade). A sale
//                                        with no side sells the side held (back when both or none).
//                                      A draft the builder read as inverted posts an inverted take
//                                        (the buy-in fades the basket); 400 legs_not_fadeable when
//                                        a leg can't be faded.
//                                      → { status: landed|pending|failed, trade_id, take_id, url,
//                                        usd, signatures, closes_take?, error? }. The same surface +
//                                      ref is the same trade (a retried message never trades twice).
//                                      403 not_linked | over_trade_limit | over_daily_limit
//                                      ({ per_trade_usd, left_usd, confirm_url }: the take's page,
//                                      to trade it by hand), 409 draft_posted, 403
//                                      draft_for_other_account; a fork refusal passes through as
//                                      { error, message } with its status
//   POST   /agent/positions          { who } → { positions } open positions (the fork API's portfolio;
//                                      side take-relative, and each take's inverted)
//   POST   /agent/score              { x_username } → { found: false } or { found: true, handle,
//                                      display_name, made, return_pct, backers_made, backers_pct,
//                                      takes }: the Thesis account that links this X account, and its
//                                      two scores as its profile shows them (the X bot's "score")
//   POST   /agent/copy               { who: { x }, handle, username? } the X bot's "copy": copies that
//                                      X account with auto-copy on; one that's on Thesis is copied as a
//                                      trader (their takes, no X reads) → { copying, kind: x|trader,
//                                      handle, thesis_handle?, usd, daily, already }; 403 not_linked,
//                                      409 copy_limit (10 X accounts), 400 cant_copy_self
//   POST   /agent/copy-run           the copy runner (pg_cron, every minute): runs queued copy_jobs
//                                      (migrations/*_copy_trading.sql) → { ran, done, skipped, failed }
//   POST   /agent/takes              { take_id } → { claim, author, status, inverted } a live take
//                                      (the bots' confirmation text names it); 404 no_such_take
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
// PRIVY_SIGNER_POLICY_IDS (optional, comma-separated), CHAIN_NETWORK (default solana-mainnet-fork), FORK_API_URL and FORK_API_SERVICE_KEY (the
// fork API's "agent" service key), WEB_URL (default https://yourthesis.xyz), AGENT_LIMIT_OVERRIDES
// (optional: "<wallet>=10000" lets a wallet with more play money allow more than $1,000). BOT_SECRET from the
// function's secrets or the Vault's bot_secret.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { privyDid } from "../_shared/privy.ts";
import { embeddedSolana, hasSigner, linkedX, PrivyError, privyClient } from "./privy.ts";
import {
  ACTIONS, type Action, HARD_MAX_USD, heldTakeSide, isRequote, LINK_TTL_MS, linkToken, MAX_USD, MIN_USD, normalizeHandle, parseLimitOverrides, readLimits, readWho, sha256Hex,
  SURFACES, type Surface, takeLegs, topicGuess, type Who,
} from "./rules.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const env = (k: string) => Deno.env.get(k) ?? "";
/** The chain the apps show: the database's read functions answer on-chain scores for it (as the web app's reads). */
const NETWORK = Deno.env.get("CHAIN_NETWORK") || "solana-mainnet-fork";
const chainDb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
  global: { headers: { "x-thesis-network": NETWORK } },
});
const WEB_URL = (env("WEB_URL") || "https://yourthesis.xyz").replace(/\/$/, "");
const SIGNER_ID = env("PRIVY_SIGNER_ID") || null;
const POLICY_IDS = env("PRIVY_SIGNER_POLICY_IDS").split(",").map((s) => s.trim()).filter(Boolean);
const LIMIT_OVERRIDES = parseLimitOverrides(env("AGENT_LIMIT_OVERRIDES"));
/** The most this wallet may allow per trade and per day. */
const maxFor = (wallet: string | null | undefined) => (wallet && LIMIT_OVERRIDES.get(wallet)) || MAX_USD;
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
async function botSecretValue(): Promise<string> {
  if (botSecret === null) {
    let v = env("BOT_SECRET");
    if (!v) {
      const { data } = await db.rpc("source_secret", { p_name: "bot_secret" });
      v = typeof data === "string" ? data : "";
    }
    if (!v) throw new HttpError(503, "bot_secret_missing");
    botSecret = v;
  }
  return botSecret;
}
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
  // Before a first grant there's no wallet on file: read it from the profile for max_usd.
  const wallet = (data as Grant | null)?.wallet ?? (await db.from("profiles").select("solana_address").eq("id", profile).maybeSingle()).data?.solana_address;
  return json(200, { grant: data ? await grantView(data as Grant) : null, signer_id: SIGNER_ID, policy_ids: POLICY_IDS, max_usd: maxFor(wallet) });
}

async function putGrant(did: string, profile: string, b: Record<string, unknown>) {
  if (!SIGNER_ID) throw new HttpError(503, "signer_not_configured");
  const user = await privy.user(did);
  const sol = embeddedSolana(user);
  if (!sol) throw new HttpError(409, "no_wallet");
  const limits = readLimits(b, maxFor(sol.address));
  check(limits, "invalid_limits");
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
  // signed_up: a Thesis account links this X account (null: Privy didn't answer). The X bot gives
  // people who haven't signed up one reply.
  if (!g) return json(200, { linked: false, signed_up: "x" in who ? await privy.hasXAccount(who.x) : null });
  const { data } = await db.from("profiles").select("handle").eq("id", g.profile_id).maybeSingle();
  return json(200, { linked: true, signed_up: true, handle: data?.handle ?? null, ...await grantView(g) });
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
  takeId: string | null; draftId: string | null; usd: number | null; bps: number | null;
  /** Take-relative (the fork API's sides); null: a sale that didn't say, which sells the side held. */
  side: "back" | "fade" | null;
  /** An auto-copy (functions/agent copy-run): the take it posts is marked auto_copy, out of the feeds. */
  autoCopy?: boolean;
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
  if (usd !== null) check(Number.isFinite(usd) && usd > 0 && usd <= HARD_MAX_USD, "invalid_usd");
  if (bps !== null) check(Number.isInteger(bps) && bps >= 1 && bps <= 10_000, "invalid_bps");
  if (action === "post") check(draftId && usd !== null && usd >= MIN_USD, draftId ? "invalid_usd" : "invalid_draft_id");
  if (action === "back" || action === "fade") check(takeId && usd !== null && usd >= MIN_USD, takeId ? "invalid_usd" : "invalid_take_id");
  if (action === "sell") check(takeId, "invalid_take_id");
  const side = b.side === "fade" ? "fade" : b.side === "back" ? "back" : null;
  return { who, surface, ref, action, takeId, draftId, usd, bps, side, wait: b.wait !== false };
}

async function finish(id: string, fields: Record<string, unknown>) {
  const { error } = await db.from("agent_trades").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) console.error("agent_trades update", error.message);
}

/** Posts a bot's draft as the user's take (status posting until its buy-in lands): its take id. */
async function createFromDraft(g: Grant, draftId: string, autoCopy = false): Promise<{ takeId: string; draft: Record<string, unknown> }> {
  const { data: d, error } = await db.from("take_drafts").select("*").eq("id", draftId).maybeSingle();
  dbCheck(error);
  if (!d) throw new HttpError(404, "no_such_draft");
  if (d.take_id) throw new HttpError(409, "draft_posted", { take_id: d.take_id });
  if (d.for_x && d.for_x !== g.x_username) throw new HttpError(403, "draft_for_other_account");
  const legs = takeLegs(Array.isArray(d.legs) ? d.legs : []);
  check(legs.length, "draft_has_no_legs");
  // The builder read it as a bet against the basket: the buy-in fades every leg.
  const inverted = d.inverted === true;
  if (inverted) check(legs.every((l) => l.fade_how), "legs_not_fadeable");
  const { topic, tags } = topicGuess(d.claim, legs);
  const { data: takeId, error: e2 } = await db.rpc("create_take", {
    p_author: g.profile_id, p_claim: d.claim, p_topic: topic, p_risk: d.risk, p_horizon: null,
    p_tags: tags, p_legs: legs, p_status: "posting", p_inverted: inverted,
  });
  if (e2?.message?.includes("takes_one_posting_claim")) throw new HttpError(409, "already_posting");
  dbCheck(e2);
  // Before it can go live, so an auto-copy never shows in the feeds.
  if (autoCopy) dbCheck((await db.from("takes").update({ auto_copy: true }).eq("id", takeId)).error);
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
    return fork<Built>("POST", `/takes/${takeId}/sell`, { owner: g.wallet, side: t.side ?? "back", ...(t.bps ? { bps: t.bps } : t.usd ? { usd: t.usd } : {}) });
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

/**
 * The take-relative side the wallet holds on this take (rules.ts heldTakeSide), from the chain
 * rows the stream keeps: "back" when it holds both, none, or they can't be read.
 */
async function heldSide(wallet: string, takeId: string): Promise<"back" | "fade"> {
  const { data: ct } = await db.from("chain_takes").select("address, inverted")
    .eq("network", NETWORK).eq("take_id", takeId)
    .order("created_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  if (!ct) return "back";
  const { data: held } = await db.from("chain_positions").select("side")
    .eq("network", NETWORK).eq("take", ct.address).eq("owner", wallet).is("exited_at", null).is("settled_at", null);
  return heldTakeSide((held ?? []).map((p) => String(p.side)), ct.inverted === true);
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
  return json(200, await executeTrade(t, g));
}

/** One trade for a grant: reserved against the limits, built, signed, sent. Refusals throw HttpError. */
async function executeTrade(t: TradeReq, g: Grant): Promise<Record<string, unknown>> {
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
    return {
      status: res.status, trade_id: tradeId, take_id: takeId, url: takeId ? `${WEB_URL}/t/${takeId}` : null,
      usd: t.usd, signatures: res.signatures ?? [], existing: true, ...(res.error ? { error: { code: res.error } } : {}),
    };
  }

  let takeId = t.takeId;
  let created = false;
  try {
    if (t.action === "post") {
      takeId = (await createFromDraft(g, t.draftId!, t.autoCopy)).takeId;
      created = true;
      await finish(tradeId, { take_id: takeId });
    }
    if (t.action === "sell" && !t.side) t.side = await heldSide(g.wallet, takeId!);
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
      return {
        status: "pending", trade_id: tradeId, take_id: takeId, url: `${WEB_URL}/t/${takeId}`, usd: t.usd ?? built.expectedUsd ?? null,
        signatures: sub.signatures ?? [], closes_take: built.closesTake ?? false,
      };
    }
    const done = await settle(built.buildId, sub);
    const status = done.status === "landed" ? "landed" : done.status === "pending" ? "pending" : "failed";
    await finish(tradeId, { status, build_id: built.buildId, signatures: done.signatures ?? null, error: done.error?.code?.slice(0, 200) ?? null });
    if (status === "failed" && created) await db.rpc("discard_posting_take", { p_author: g.profile_id, p_id: takeId });
    return {
      status, trade_id: tradeId, take_id: takeId, url: `${WEB_URL}/t/${takeId}`, usd: t.usd ?? built.expectedUsd ?? null,
      signatures: done.signatures ?? [], closes_take: built.closesTake ?? false, ...(done.error ? { error: done.error } : {}),
    };
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
  const { data, error } = await db.from("takes").select("claim, status, inverted, profiles:author_id(handle)").eq("id", id).maybeSingle();
  dbCheck(error);
  if (!data || data.status !== "live") throw new HttpError(404, "no_such_take");
  const author = (data.profiles as { handle?: string | null } | null)?.handle ?? null;
  // Inverted: it bets against its basket (backing it is an on-chain fade); the fork API's sides are the take's.
  return json(200, { claim: data.claim, author, status: data.status, inverted: data.inverted === true });
}

async function score(b: Record<string, unknown>) {
  const username = typeof b.x_username === "string" ? b.x_username.trim().replace(/^@/, "").toLowerCase() : "";
  check(/^[a-z0-9_]{1,15}$/.test(username), "invalid_username");
  const user = await privy.userByXUsername(username);
  if (!user) return json(200, { found: false });
  const { data: acct, error } = await db.from("accounts").select("profile_id").eq("privy_did", user.id).maybeSingle();
  dbCheck(error);
  if (!acct) return json(200, { found: false });
  // On-chain scores, as the profile shows them (without the network header the function answers the old off-chain figures).
  const { data: p, error: e2 } = await chainDb.rpc("profile", { p_profile: acct.profile_id });
  dbCheck(e2);
  const prof = p as Record<string, unknown> | null;
  // Not onboarded yet (no handle) or deleted: nothing to show.
  if (!prof || typeof prof.handle !== "string" || !prof.handle || prof.deleted) return json(200, { found: false });
  const n = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
  return json(200, {
    found: true, handle: prof.handle, display_name: prof.display_name ?? null,
    made: n(prof.made), return_pct: n(prof.return_pct), backers_made: n(prof.backers_made), backers_pct: n(prof.backers_pct), takes: n(prof.takes),
  });
}

// Copy trading ------------------------------------------------------------------------------------

const MAX_COPIED_X = 10;
const COPY_MAX_AGE_MS = 45 * 60_000;
const money = (n: number) => `$${Number.isInteger(n) ? n : Number(n).toFixed(2)}`;

function readCopySettings(b: Record<string, unknown>, max: number): { auto?: boolean; auto_usd?: number; auto_daily?: number } {
  const out: { auto?: boolean; auto_usd?: number; auto_daily?: number } = {};
  if (typeof b.auto === "boolean") out.auto = b.auto;
  if (b.usd != null) {
    const usd = Math.round(Number(b.usd) * 100) / 100;
    check(Number.isFinite(usd) && usd >= MIN_USD && usd <= max, "invalid_usd");
    out.auto_usd = usd;
  }
  if (b.daily != null) {
    const daily = Math.round(Number(b.daily));
    check(Number.isInteger(daily) && daily >= 1 && daily <= 20, "invalid_daily");
    out.auto_daily = daily;
  }
  return out;
}

async function listCopies(profile: string) {
  const [x, traders, jobs, grant] = await Promise.all([
    db.from("x_follows").select("handle, auto, auto_usd, auto_daily, created_at, x_accounts(username, name, avatar_url)").eq("profile_id", profile).order("created_at"),
    db.from("trader_follows").select("trader_id, auto, auto_usd, auto_daily, created_at, profiles:trader_id(handle, display_name, avatar_url)").eq("profile_id", profile).order("created_at"),
    db.from("copy_jobs").select("id, kind, handle, trader_id, usd, status, reason, result_take, created_at, x_calls(claim), takes:result_take(claim)").eq("profile_id", profile).order("created_at", { ascending: false }).limit(20),
    db.from("agent_grants").select("revoked_at").eq("profile_id", profile).maybeSingle(),
  ]);
  for (const r of [x, traders, jobs, grant]) dbCheck(r.error);
  const one = <T>(v: T | T[] | null) => (Array.isArray(v) ? v[0] : v) ?? null;
  return json(200, {
    linked: !!grant.data && !grant.data.revoked_at,
    x: (x.data ?? []).map((r) => ({ handle: r.handle, auto: r.auto, usd: Number(r.auto_usd), daily: r.auto_daily, ...(one(r.x_accounts as never) ?? {}) })),
    traders: (traders.data ?? []).map((r) => ({ trader_id: r.trader_id, auto: r.auto, usd: Number(r.auto_usd), daily: r.auto_daily, ...(one(r.profiles as never) ?? {}) })),
    jobs: (jobs.data ?? []).map((j) => ({
      id: j.id, kind: j.kind, handle: j.handle, trader_id: j.trader_id, usd: Number(j.usd), status: j.status, reason: j.reason,
      take_id: j.result_take, claim: (one(j.takes as never) as { claim?: string } | null)?.claim ?? (one(j.x_calls as never) as { claim?: string } | null)?.claim ?? null, at: j.created_at,
    })),
  });
}

async function walletMax(profile: string) {
  const { data } = await db.from("profiles").select("solana_address").eq("id", profile).maybeSingle();
  return maxFor(data?.solana_address);
}

async function putXCopy(profile: string, handle: string, b: Record<string, unknown>) {
  check(/^[a-z0-9_]{1,15}$/.test(handle), "invalid_handle");
  const set = readCopySettings(b, await walletMax(profile));
  const { data: cur, error } = await db.from("x_follows").select("auto").eq("profile_id", profile).eq("handle", handle).maybeSingle();
  dbCheck(error);
  if (!cur) throw new HttpError(404, "not_copying");
  // Turning auto-copy on starts from now: earlier calls are never copied.
  const row: Record<string, unknown> = { ...set, ...(set.auto && !cur.auto ? { auto_since: new Date().toISOString() } : {}) };
  dbCheck((await db.from("x_follows").update(row).eq("profile_id", profile).eq("handle", handle)).error);
  return listCopies(profile);
}

async function putTraderCopy(profile: string, traderId: string, b: Record<string, unknown>) {
  check(UUID_RE.test(traderId), "invalid_trader");
  if (traderId === profile) throw new HttpError(400, "cant_copy_self");
  const set = readCopySettings(b, await walletMax(profile));
  const { data: trader } = await db.from("profiles").select("id, handle").eq("id", traderId).maybeSingle();
  if (!trader?.handle) throw new HttpError(404, "no_such_trader");
  const { data: cur } = await db.from("trader_follows").select("auto").eq("profile_id", profile).eq("trader_id", traderId).maybeSingle();
  const row: Record<string, unknown> = { profile_id: profile, trader_id: traderId, ...set };
  if (!cur || (set.auto && !cur.auto)) row.auto_since = new Date().toISOString();
  dbCheck((await db.from("trader_follows").upsert(row, { onConflict: "profile_id,trader_id" })).error);
  return listCopies(profile);
}

async function deleteCopy(profile: string, kind: string, key: string) {
  if (kind === "x") dbCheck((await db.from("x_follows").delete().eq("profile_id", profile).eq("handle", key)).error);
  else dbCheck((await db.from("trader_follows").delete().eq("profile_id", profile).eq("trader_id", key)).error);
  return listCopies(profile);
}

/** The X bot's "copy": the asker copies that X account, auto-copy on. */
async function botCopy(b: Record<string, unknown>) {
  const who = readWho(b.who);
  check(who, "invalid_who");
  const handle = typeof b.handle === "string" ? b.handle.trim().replace(/^@/, "").toLowerCase() : "";
  check(/^[a-z0-9_]{1,15}$/.test(handle), "invalid_handle");
  const g = await grantFor(who);
  if (!g || g.revoked_at) throw new HttpError(403, "not_linked");
  const usd = Math.min(20, Number(g.per_trade_usd));

  // On Thesis: copy their real takes (backed as they post them), no X reads at all.
  const user = await privy.userByXUsername(handle).catch(() => null);
  const acct = user ? (await db.from("accounts").select("profile_id").eq("privy_did", user.id).maybeSingle()).data : null;
  const trader = acct ? (await db.from("profiles").select("id, handle").eq("id", acct.profile_id).maybeSingle()).data : null;
  if (trader?.handle && trader.id !== g.profile_id) {
    const { data: hadT } = await db.from("trader_follows").select("auto, auto_usd, auto_daily").eq("profile_id", g.profile_id).eq("trader_id", trader.id).maybeSingle();
    if (!hadT?.auto) {
      dbCheck((await db.from("trader_follows").upsert({ profile_id: g.profile_id, trader_id: trader.id, auto: true, auto_since: new Date().toISOString(), ...(hadT ? {} : { auto_usd: usd }) }, { onConflict: "profile_id,trader_id" })).error);
    }
    return json(200, { copying: true, kind: "trader", handle, thesis_handle: trader.handle, usd: Number(hadT?.auto_usd ?? usd), daily: hadT?.auto_daily ?? 3, already: !!hadT?.auto });
  }
  if (trader?.id === g.profile_id) throw new HttpError(400, "cant_copy_self");

  const { count } = await db.from("x_follows").select("handle", { count: "exact", head: true }).eq("profile_id", g.profile_id);
  const { data: had } = await db.from("x_follows").select("auto").eq("profile_id", g.profile_id).eq("handle", handle).maybeSingle();
  if (!had && (count ?? 0) >= MAX_COPIED_X) throw new HttpError(409, "copy_limit");
  // The account row (its name and picture fill in on the next poll); posts before now are never copied.
  dbCheck((await db.from("x_accounts").upsert({ handle, username: typeof b.username === "string" ? b.username.slice(0, 15) : handle }, { onConflict: "handle", ignoreDuplicates: true })).error);
  const row = { profile_id: g.profile_id, handle, auto: true, ...(had?.auto ? {} : { auto_since: new Date().toISOString(), auto_usd: usd }) };
  dbCheck((await db.from("x_follows").upsert(row, { onConflict: "profile_id,handle" })).error);
  const { data: now } = await db.from("x_follows").select("auto_usd, auto_daily").eq("profile_id", g.profile_id).eq("handle", handle).single();
  return json(200, { copying: true, kind: "x", handle, usd: Number(now?.auto_usd ?? usd), daily: now?.auto_daily ?? 3, already: !!had?.auto });
}

type CopyJob = {
  id: string; profile_id: string; kind: "x_call" | "take"; post_id: string | null; handle: string | null;
  source_take: string | null; trader_id: string | null; usd: number; attempts: number;
};

/** Why a refused trade was skipped, as the copier reads it. */
function skipReason(code: string, extra: Record<string, unknown>): string {
  if (code === "not_linked") return "Trading by text is off. Turn it on in Limits.";
  if (code === "over_trade_limit") return `Over your ${money(Number(extra.per_trade_usd ?? 0))} per-trade limit.`;
  if (code === "over_daily_limit") return `Past your daily limit (${money(Number(extra.left_usd ?? 0))} left today).`;
  if (code === "take_closed") return "The take had closed.";
  if (code === "insufficient_funds" || code === "insufficient_usdc") return "Not enough cash.";
  return "Couldn't place it.";
}

async function notifyCopy(j: CopyJob, ok: boolean, title: string, body: string, takeId: string | null) {
  const { error } = await db.from("notifications").insert({
    profile_id: j.profile_id, kind: ok ? "copy_done" : "copy_skipped", take_id: takeId, title, body: body.slice(0, 300),
    data: { job: j.id, handle: j.handle, trader: j.trader_id }, dedupe_key: j.id,
  });
  if (error && error.code !== "23505") console.error("copy notify", error.message);
}

async function endJob(j: CopyJob, status: "done" | "skipped" | "failed" | "queued", reason: string | null, takeId: string | null = null) {
  dbCheck((await db.from("copy_jobs").update({ status, reason: reason?.slice(0, 200) ?? null, result_take: takeId, updated_at: new Date().toISOString() }).eq("id", j.id)).error);
}

/** The basket for an X call, built once and shared by every copier (its draft id), or null. */
async function callDraft(call: { post_id: string; handle: string; url: string; text: string; claim: string; draft_id: string | null; basket: string | null }): Promise<string | null> {
  if (call.basket === "no_clean_exposure") return null;
  if (call.draft_id) return call.draft_id;
  const secret = await botSecretValue();
  const r = await fetch(`${env("SUPABASE_URL")}/functions/v1/source/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bot-secret": secret },
    body: JSON.stringify({
      claim: call.claim, risk: "high", origin: "x", origin_ref: `call:${call.post_id}`,
      context: `Auto-copied from @${call.handle}`.slice(0, 80),
      source: { text: call.text.slice(0, 2000), url: call.url, label: `@${call.handle} on X`.slice(0, 60), kind: "x" },
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!r.ok) throw new Error(`drafts ${r.status}`);
  const out = await r.json() as { verdict?: string; id?: string };
  const basket = out.verdict === "basket" && out.id ? "basket" : "no_clean_exposure";
  await db.from("x_calls").update({ basket, draft_id: basket === "basket" ? out.id : null }).eq("post_id", call.post_id);
  return basket === "basket" ? out.id! : null;
}

/** The copier's own copy of a call's basket (the take they'll post). */
async function copierDraft(sharedId: string, j: CopyJob): Promise<string> {
  const { data: d, error } = await db.from("take_drafts").select("claim, risk, horizon, legs, summary, source_url, source_label, source_kind").eq("id", sharedId).single();
  dbCheck(error);
  const ref = `copy:${j.id}`;
  const { data: had } = await db.from("take_drafts").select("id").eq("origin", "x").eq("origin_ref", ref).maybeSingle();
  if (had) return had.id as string;
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  for (let i = 0; i < 3; i++) {
    const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => abc[b % abc.length]).join("");
    const { error: e } = await db.from("take_drafts").insert({ id, ...d, origin: "x", origin_ref: ref, context: `Auto-copied from @${j.handle}`.slice(0, 80) });
    if (!e) return id;
    if (e.code !== "23505") dbCheck(e);
  }
  throw new Error("draft id collisions");
}

async function runJob(j: CopyJob): Promise<"done" | "skipped" | "failed" | "queued"> {
  const { data: g } = await db.from("agent_grants").select("*").eq("profile_id", j.profile_id).maybeSingle();
  const grant = g as Grant | null;
  const who: Who = grant?.x_user_id ? { x: grant.x_user_id } : { imessage: grant?.imessage ?? "" };
  const label = j.kind === "x_call" ? `@${j.handle}` : "a trader you copy";

  // Still copying, auto-copy still on, and under the daily cap for this account?
  const settings = j.kind === "x_call"
    ? (await db.from("x_follows").select("auto, auto_daily").eq("profile_id", j.profile_id).eq("handle", j.handle!).maybeSingle()).data
    : (await db.from("trader_follows").select("auto, auto_daily").eq("profile_id", j.profile_id).eq("trader_id", j.trader_id!).maybeSingle()).data;
  if (!settings?.auto) { await endJob(j, "skipped", "Auto-copy is off."); return "skipped"; }
  const { data: today } = await db.rpc("copies_today", { p_profile: j.profile_id, p_handle: j.handle, p_trader: j.trader_id });
  if (Number(today) >= settings.auto_daily) {
    const why = `Daily cap of ${settings.auto_daily} reached.`;
    await endJob(j, "skipped", why);
    await notifyCopy(j, false, `Skipped a copy of ${label}`, why, null);
    return "skipped";
  }
  if (!grant || grant.revoked_at) {
    const why = skipReason("not_linked", {});
    await endJob(j, "skipped", why);
    await notifyCopy(j, false, `Skipped a copy of ${label}`, why, null);
    return "skipped";
  }

  let t: TradeReq;
  let claim: string | null = null;
  if (j.kind === "x_call") {
    const { data: call } = await db.from("x_calls").select("post_id, handle, url, text, claim, posted_at, draft_id, basket").eq("post_id", j.post_id!).maybeSingle();
    if (!call?.claim) { await endJob(j, "skipped", "Not a call."); return "skipped"; }
    if (Date.now() - new Date(call.posted_at).getTime() > COPY_MAX_AGE_MS) { await endJob(j, "skipped", "The call was too old to copy."); return "skipped"; }
    const shared = await callDraft(call as never);
    if (!shared) { await endJob(j, "skipped", "No clean way to trade that call."); return "skipped"; }
    claim = call.claim;
    t = { who, surface: "copy", ref: `copy:${j.id}`, action: "post", wait: false, takeId: null, draftId: await copierDraft(shared, j), usd: Number(j.usd), bps: null, side: "back", autoCopy: true };
  } else {
    const { data: take } = await db.from("takes").select("claim, status").eq("id", j.source_take!).maybeSingle();
    if (take?.status !== "live") { await endJob(j, "skipped", "The take isn't live."); return "skipped"; }
    claim = take.claim;
    t = { who, surface: "copy", ref: `copy:${j.id}`, action: "back", wait: false, takeId: j.source_take, draftId: null, usd: Number(j.usd), bps: null, side: "back" };
  }

  try {
    const r = await executeTrade(t, grant);
    if (r.status === "failed") throw new Error("trade failed");
    const takeId = (r.take_id as string | null) ?? null;
    await endJob(j, "done", null, takeId);
    await notifyCopy(j, true, `Auto-copied ${label}`, `${money(Number(j.usd))} on "${claim}"`, takeId);
    return "done";
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) {
      const why = skipReason(e.code, e.extra);
      await endJob(j, "skipped", why);
      await notifyCopy(j, false, `Skipped a copy of ${label}`, why, null);
      return "skipped";
    }
    console.error("copy job", j.id, e instanceof Error ? e.message : e);
    if (j.attempts < 2) { await endJob(j, "queued", null); return "queued"; }
    await endJob(j, "failed", "Couldn't place it.");
    await notifyCopy(j, false, `Couldn't copy ${label}`, "Couldn't place it.", null);
    return "failed";
  }
}

async function copyRun() {
  const { data, error } = await db.rpc("claim_copy_jobs", { p_limit: 10 });
  dbCheck(error);
  const jobs = (data ?? []) as CopyJob[];
  const deadline = Date.now() + 100_000;
  const tally = { ran: 0, done: 0, skipped: 0, failed: 0, requeued: 0 };
  for (const j of jobs) {
    // Out of time: back in the queue for the next minute.
    if (Date.now() > deadline) { await endJob(j, "queued", null); tally.requeued++; continue; }
    tally.ran++;
    const r = await runJob(j).catch(async (e) => { console.error("copy job", e); await endJob(j, "queued", null).catch(() => {}); return "queued" as const; });
    if (r === "queued") tally.requeued++; else tally[r]++;
  }
  return json(200, tally);
}

async function positions(b: Record<string, unknown>) {
  const who = readWho(b.who);
  check(who, "invalid_who");
  const g = await grantFor(who);
  if (!g || g.revoked_at) throw new HttpError(403, "not_linked");
  const p = await fork<{ positions?: Record<string, unknown>[] }>("GET", `/wallets/${g.wallet}/portfolio`);
  const held = (p.positions ?? []).filter((x) => !x.exited);
  // Which of these takes are inverted (bet against their basket), from the app's takes. side is
  // already take-relative (the fork API's): back agrees with the take.
  const ids = [...new Set(held.map((x) => x.takeId).filter((id): id is string => typeof id === "string" && UUID_RE.test(id)))];
  const inverted = new Set<string>();
  if (ids.length) {
    const { data, error } = await db.from("takes").select("id").in("id", ids).eq("inverted", true);
    dbCheck(error);
    for (const t of data ?? []) inverted.add(t.id as string);
  }
  const open = held.map((x) => ({
    take_id: x.takeId, claim: x.claim, side: x.side, inverted: inverted.has(String(x.takeId)), stake_usd: x.stakeUsd,
    value_usd: x.valueUsd, return_bps: x.returnBps, can_exit: x.canExit, closes_take_if_sold_all: x.closesTakeIfSoldAll ?? false,
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
    if (route === "copies") {
      const { profile } = await requireUser(req);
      const [, , , kind, key] = parts.slice(i >= 0 ? i : 0);
      if (m === "GET" && !arg) return await listCopies(profile);
      if (arg === "x" && kind) {
        if (m === "PUT") return await putXCopy(profile, kind.toLowerCase(), await body());
        if (m === "DELETE") return await deleteCopy(profile, "x", kind.toLowerCase());
      }
      if (arg === "trader" && kind) {
        if (m === "PUT") return await putTraderCopy(profile, kind, await body());
        if (m === "DELETE") return await deleteCopy(profile, "trader", kind);
      }
      void key;
    }
    if (m === "POST" && ["links", "whois", "trades", "positions", "takes", "score", "copy", "copy-run"].includes(route ?? "")) {
      await requireBot(req);
      const b = await body();
      if (route === "links") return await makeLink(b);
      if (route === "whois") return await whois(b);
      if (route === "trades") return await trade(b);
      if (route === "positions") return await positions(b);
      if (route === "takes") return await takeInfo(b);
      if (route === "score") return await score(b);
      if (route === "copy") return await botCopy(b);
      if (route === "copy-run") return await copyRun();
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
