// source: takes from what you read, and copying X accounts.
//
//   POST   /source                 { url, title?, text?, html? } → { claim, risk, horizon, is_call,
//                                  source } an article or X post → a take to edit (horizon is a
//                                  fixed "3 months" that older apps decode; takes have none now:
//                                  they run until the author sells, a year at most). title/text/html:
//                                  what the phone already has (Safari's page text, a selection, the
//                                  page fetched on the phone: many news sites turn servers away).
//                                  source: { url, label, kind, title }.
//                                  400 invalid_url | nothing_to_read, 404 post_unavailable
//   POST   /source/attach          { take_id, url, label, kind } your new take came from this
//                                  (shown on it as "via …"); once per take → { attached }
//   GET    /source/x               → { accounts } the X accounts you copy, each with its recent
//                                  calls as drafted takes: { post_id, url, text, posted_at, claim,
//                                  risk }
//   PUT    /source/x/:handle       copy an X account → { account }. The first person to copy one
//                                  reads its last three weeks, so there's something to copy now;
//                                  404 x_account_not_found when it has no recent posts; 403
//                                  copy_limit past MAX_COPIED (10) accounts per person; 502
//                                  x_fetch_failed when Apify can't answer.
//   DELETE /source/x/:handle       stop copying
//   POST   /source/poll            header x-poll-secret: new posts from copied accounts → drafted
//                                  takes → x_call notifications (pg_cron, every 15 minutes).
//                                  502 { error: x_fetch_failed, reason, detail } when Apify can't
//                                  answer (503 with reason no_token); the next run reads the same window
//   POST   /source/drafts          header x-bot-secret: a chat bot's take { claim, risk,
//                                  source?: { text, url, label }, origin: imessage|x, context?,
//                                  origin_ref? } → the take builder's basket, saved as a draft:
//                                  { verdict: "basket", id, summary, legs, existing } or
//                                  { verdict: "no_clean_exposure", reason }. Its page is /d/<id> on
//                                  the web; the same origin_ref returns the same draft.
//                                  for_x: the X bot's asker (their username), whose drafts wait for
//                                  them in the web app, since the bot's replies carry no link.
//                                  copy_of: another draft's id: its basket, saved again for this
//                                  asker without building (several people replying under one post
//                                  share one basket); 404 no_such_draft.
//   POST   /source/bot-events      header x-bot-secret: { bot: x|imessage, events: [{ at, event,
//                                  ref?, author?, what?, ...rest }] } (up to 100) → { saved }.
//                                  What the bots did, kept in bot_events (rest goes to data).
//   GET    /source/drafts/mine     → { x, drafts } the X bot's unposted drafts for the X account
//                                  linked to your Privy login (x null when none is linked), newest
//                                  first, from the last 14 days: { id, claim, legs, context, created_at }
//   PUT    /source/drafts/:id      { take_id } you posted it: your live take → { posted, take_id }
//                                  (posted false when someone else's live take got there first);
//                                  404 unless the take is yours, 409 take_not_live while it's posting,
//                                  403 draft_for_other_account when the X bot made it for an X account
//                                  (for_x) other than the one your Privy login links
//
// Reading: X posts through X's public oEmbed, articles by fetching the page (_shared/source.ts);
// copied accounts' timelines through Apify (_shared/x.ts). Drafting: one fast model call.
// Kept out of functions/social so that function's deploys stay its own.
//
// Secrets: OPENAI_API_KEY, OPENAI_FAST_MODEL, PRIVY_* (+ SUPABASE_*). APIFY_TOKEN, X_POLL_SECRET
// and BOT_SECRET come from the function's secrets or, failing that, the Vault (apify_token,
// x_poll_secret, bot_secret, read through source_secret()), where pg_cron reads the poll secret too.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { privyDid, privyXUsername } from "../_shared/privy.ts";
import { mayPostDraft } from "../_shared/x_account.ts";
import { draftTake, readSource, SourceError } from "../_shared/source.ts";
import { fetchPosts, ingest, parseHandle, recentCalls, XFetchError } from "../_shared/x.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A poll never reaches further back than this, however long polling was off. */
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const secrets = new Map<string, string>();
/** A function secret, else the Vault's. Cached for the worker's life. */
async function secret(env: string, vault: string): Promise<string> {
  const cached = secrets.get(vault);
  if (cached !== undefined) return cached;
  let value = Deno.env.get(env) ?? "";
  if (!value) {
    const { data, error } = await db.rpc("source_secret", { p_name: vault });
    if (error) console.error("vault", error.message);
    value = typeof data === "string" ? data : "";
  }
  if (value) secrets.set(vault, value);
  return value;
}
const apifyToken = () => secret("APIFY_TOKEN", "apify_token");

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new HttpError(400, code);
}

function dbCheck(error: { message?: string } | null) {
  if (error) throw new Error(error.message ?? "db");
}

function sameSecret(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The signed-in profile's id; writes need a finished profile (a handle). */
async function me(req: Request, needsHandle: boolean): Promise<string> {
  const did = await privyDid(req);
  if (!did) throw new HttpError(401, "invalid_privy_token");
  const { data: id, error } = await db.rpc("ensure_account", { p_privy_did: did });
  dbCheck(error);
  if (needsHandle) {
    const { data, error: e } = await db.from("profiles").select("handle").eq("id", id).single();
    dbCheck(e);
    if (!data?.handle) throw new HttpError(403, "needs_onboarding");
  }
  return id as string;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    check(b && typeof b === "object" && !Array.isArray(b), "invalid_json");
    return b;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "invalid_json");
  }
}

// An article or post → a take ------------------------------------------------------------------

async function draft(b: Record<string, unknown>) {
  check(typeof b.url === "string" && b.url.length <= 2000, "invalid_url");
  const given = {
    title: typeof b.title === "string" ? b.title.slice(0, 300) : null,
    text: typeof b.text === "string" ? b.text.slice(0, 20_000) : null,
    html: typeof b.html === "string" ? b.html.slice(0, 1_500_000) : null,
  };
  const started = Date.now();
  try {
    const source = await readSource(b.url as string, given);
    const d = await draftTake(source);
    return json(200, { ...d, horizon: LEGACY_HORIZON.long, source: { url: source.url, label: source.label, kind: source.kind, title: source.title }, ms: Date.now() - started });
  } catch (err) {
    if (err instanceof SourceError) throw new HttpError(err.message === "post_unavailable" ? 404 : 400, err.message);
    throw err;
  }
}

/** Your take came from this. Only its author, and only once. */
async function attach(profile: string, b: Record<string, unknown>) {
  const takeId = String(b.take_id ?? "");
  check(UUID_RE.test(takeId), "invalid_take_id");
  const url = String(b.url ?? "");
  check(/^https?:\/\/\S+$/.test(url) && url.length <= 500, "invalid_source_url");
  const label = typeof b.label === "string" ? b.label.trim().slice(0, 60) : "";
  check(label.length >= 1, "invalid_source_label");
  const kind = b.kind === "x" ? "x" : "link";
  const { data, error } = await db.from("takes")
    .update({ source_url: url, source_label: label, source_kind: kind })
    .eq("id", takeId).eq("author_id", profile).is("source_url", null)
    .select("id");
  dbCheck(error);
  if (!data?.length) throw new HttpError(404, "not_found");
  return json(200, { attached: true });
}

// Draft takes from the chat bots ------------------------------------------------------------------

const DRAFT_ID_RE = /^[A-Za-z0-9]{8}$/;
/**
 * Takes have no horizon (they run until the author sells, a year at most), so a bot's horizon is
 * ignored. Drafts still store one, and POST /source still answers one, because older web and iOS
 * builds read it (take_drafts.horizon is 2wk…6mo). Nothing acts on it.
 */
const LEGACY_HORIZON = { key: "3mo", long: "3 months" } as const;

function draftId(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => abc[b % abc.length]).join("");
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

type BuiltLeg = { name: string; weight: number; side?: string | null; kind?: string; why?: string };
const DRAFT_COLUMNS = "id, summary, legs";
const drafted = (d: { id: string; summary: string | null; legs: unknown }, existing: boolean, trace?: Trace) =>
  json(200, { verdict: "basket", id: d.id, summary: d.summary, legs: d.legs, existing, ...(trace ? { trace } : {}) });

/** How the take builder got there, for the bots' telemetry (bot_events): never stored on the draft. */
type Trace = { thoughts?: string[]; searches?: string[]; picked?: string[]; raw?: unknown; rounds?: number | null; speculated?: boolean; ms?: unknown };
function traceOf(built: { debug?: Record<string, unknown>; ms?: unknown }): Trace | undefined {
  const d = built.debug;
  if (!d) return undefined;
  return { thoughts: d.thoughts as string[] | undefined, searches: d.searches as string[], picked: d.picked as string[], raw: d.raw, rounds: d.rounds as number | null, speculated: d.speculated as boolean, ms: built.ms };
}

/**
 * A bot's take → the take builder's basket, saved as a draft → { verdict: "basket", id, summary,
 * legs } or { verdict: "no_clean_exposure", reason }. The builder runs here, with this project's
 * SECURITIES_INDEX_SECRET, so the bots hold only the bot secret. The same origin_ref returns the
 * same draft without building again.
 */
async function buildDraft(b: Record<string, unknown>) {
  const claim = str(b.claim, 140).replace(/\s+/g, " ");
  check(claim.length >= 5, "invalid_claim");
  const risk = ["low", "medium", "high"].includes(String(b.risk)) ? String(b.risk) : "medium";
  const origin = b.origin === "x" ? "x" : b.origin === "imessage" ? "imessage" : null;
  check(origin, "invalid_origin");
  const src = (b.source ?? null) as Record<string, unknown> | null;
  const sourceUrl = src && typeof src.url === "string" && /^https?:\/\/\S+$/.test(src.url) && src.url.length <= 500 ? src.url : null;
  const sourceText = src ? str(src.text, 2000) : "";
  const ref = str(b.origin_ref, 64) || null;
  const forX = origin === "x" && typeof b.for_x === "string" ? parseHandle(b.for_x)?.toLowerCase() ?? null : null;

  if (ref) {
    const { data, error } = await db.from("take_drafts").select(DRAFT_COLUMNS).eq("origin", origin).eq("origin_ref", ref).maybeSingle();
    dbCheck(error);
    if (data) return drafted(data, true);
  }

  // The same basket for another asker: no second build.
  if (typeof b.copy_of === "string" && DRAFT_ID_RE.test(b.copy_of)) {
    const { data: from, error } = await db.from("take_drafts")
      .select("claim, risk, horizon, legs, summary, source_url, source_label, source_kind").eq("id", b.copy_of).maybeSingle();
    dbCheck(error);
    if (!from) throw new HttpError(404, "no_such_draft");
    return saveDraft({ ...from, origin, context: str(b.context, 80) || null, origin_ref: ref, for_x: forX }, ref, origin);
  }

  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/take-builder`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-index-secret": Deno.env.get("SECURITIES_INDEX_SECRET") ?? "" },
    body: JSON.stringify({
      claim, risk,
      ...(sourceText.length >= 3 ? { source: { text: sourceText, label: str(src!.label, 60) || null, kind: "post" } } : {}),
      // A bot's draft is a public reply, and its asker isn't waiting on a composer: the builder
      // thinks longer (reasoning medium, ~3 s instead of ~1.5) and gets a take's direction right
      // more often ("$TSLA demand is collapsing" isn't a Tesla buy).
      // thoughts: the model's reasoning summaries come back in debug, passed on as `trace`.
      variant: { reasoning: "medium", timeoutMs: 20_000, thoughts: true },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) throw new Error(`take-builder ${r.status}`);
  const built = await r.json() as { verdict: string; summary?: string; reason?: string | null; legs?: BuiltLeg[]; debug?: Record<string, unknown>; ms?: unknown };
  const trace = traceOf(built);
  const legs = (built.legs ?? []).filter((l) => l && typeof l.name === "string").slice(0, 10);
  if (built.verdict !== "basket" || !legs.length) {
    return json(200, { verdict: "no_clean_exposure", reason: built.reason || "Nothing you can buy tracks this closely enough yet.", ...(trace ? { trace } : {}) });
  }

  const row = {
    claim, risk, horizon: LEGACY_HORIZON.key, legs, origin,
    summary: str(built.summary, 400) || null,
    context: str(b.context, 80) || null,
    origin_ref: ref,
    for_x: forX,
    source_url: sourceUrl,
    source_label: sourceUrl ? str(src!.label, 60) || "the post" : null,
    source_kind: sourceUrl ? (src!.kind === "x" ? "x" : "link") : null,
  };
  return saveDraft(row, ref, origin, trace);
}

/** Inserts a draft under a fresh id (retrying a taken one); a racing retry of the same ref returns the winner. */
async function saveDraft(row: Record<string, unknown> & { summary: string | null; legs: unknown }, ref: string | null, origin: string, trace?: Trace) {
  for (let i = 0; i < 3; i++) {
    const id = draftId();
    const { error } = await db.from("take_drafts").insert({ id, ...row });
    if (!error) return drafted({ id, summary: row.summary, legs: row.legs }, false, trace);
    if (error.code !== "23505") dbCheck(error);
    // A taken id (or a racing retry of the same ref): try again, or return the winner.
    if (ref) {
      const { data } = await db.from("take_drafts").select(DRAFT_COLUMNS).eq("origin", origin).eq("origin_ref", ref).maybeSingle();
      if (data) return drafted(data, true);
    }
  }
  throw new Error("draft id collisions");
}

/** The X bot's drafts waiting for you: the ones it saved for the X account your login links. */
async function myDrafts(req: Request) {
  const did = await privyDid(req);
  if (!did) throw new HttpError(401, "invalid_privy_token");
  const x = await privyXUsername(did);
  if (!x) return json(200, { x: null, drafts: [] });
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db.from("take_drafts")
    .select("id, claim, legs, context, created_at")
    .eq("for_x", x).is("take_id", null).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(10);
  dbCheck(error);
  return json(200, { x, drafts: data ?? [] });
}

/**
 * You posted this draft: point it at your live take, unless someone's live take got there first.
 * A draft the X bot made for an X account is posted only by whoever's login links that account
 * (decided 2026-11-18); its username comes from Privy, never from the client.
 */
async function draftPosted(req: Request, id: string, b: Record<string, unknown>) {
  const profile = await me(req, true);
  check(DRAFT_ID_RE.test(id), "invalid_draft_id");
  const takeId = String(b.take_id ?? "");
  check(UUID_RE.test(takeId), "invalid_take_id");
  const { data: d, error: e } = await db.from("take_drafts").select("take_id, for_x, takes(status)").eq("id", id).maybeSingle();
  dbCheck(e);
  if (!d) throw new HttpError(404, "not_found");
  if (d.for_x) {
    const did = await privyDid(req);
    if (!mayPostDraft(d.for_x, did ? await privyXUsername(did) : null)) throw new HttpError(403, "draft_for_other_account");
  }
  const { data: take, error } = await db.from("takes").select("id, status").eq("id", takeId).eq("author_id", profile).maybeSingle();
  dbCheck(error);
  if (!take) throw new HttpError(404, "not_found");
  // Only a live take: a posting one may never make it on-chain (the web app calls this once it's live).
  if (take.status !== "live") throw new HttpError(409, "take_not_live");
  const current = (Array.isArray(d.takes) ? d.takes[0] : d.takes) as { status: string } | null;
  if (d.take_id && d.take_id !== takeId && current?.status === "live") return json(200, { posted: false, take_id: d.take_id });
  const { error: u } = await db.from("take_drafts").update({ take_id: takeId, posted_at: new Date().toISOString() }).eq("id", id);
  dbCheck(u);
  return json(200, { posted: true, take_id: takeId });
}

// X accounts you copy --------------------------------------------------------------------------

async function accounts(profile: string, only?: string) {
  let q = db.from("x_follows").select("handle, created_at, x_accounts(username, name, avatar_url)").eq("profile_id", profile);
  if (only) q = q.eq("handle", only);
  const { data, error } = await q.order("created_at", { ascending: false });
  dbCheck(error);
  const rows = data ?? [];
  const calls = await recentCalls(db, rows.map((r) => r.handle));
  return rows.map((r) => {
    const a = (Array.isArray(r.x_accounts) ? r.x_accounts[0] : r.x_accounts) as { username: string; name: string | null; avatar_url: string | null } | null;
    return { handle: r.handle, username: a?.username ?? r.handle, name: a?.name ?? null, avatar_url: a?.avatar_url ?? null, calls: calls.get(r.handle) ?? [] };
  });
}

/** The most X accounts one person can copy: each copied account is read by
 *  the poll, and a new one costs an Apify read the first time. */
export const MAX_COPIED = 10;

async function copy(profile: string, raw: string) {
  const username = parseHandle(decodeURIComponent(raw));
  check(username, "invalid_x_handle");
  const handle = username.toLowerCase();
  // The cap is checked before anything reaches Apify; an account you already copy doesn't count again.
  const { data: mine, error: mineErr } = await db.from("x_follows").select("handle").eq("profile_id", profile);
  dbCheck(mineErr);
  if (!(mine ?? []).some((r) => r.handle === handle) && (mine ?? []).length >= MAX_COPIED) {
    throw new HttpError(403, "copy_limit");
  }
  const { data: known, error } = await db.from("x_accounts").select("handle").eq("handle", handle).maybeSingle();
  dbCheck(error);
  if (!known) {
    const token = await apifyToken();
    if (!token) throw new HttpError(503, "x_not_configured");
    const posts = await fetchPosts(token, [username], { since: new Date(Date.now() - 21 * 86_400_000), max: 20 }).catch((e) => {
      if (!(e instanceof XFetchError)) throw e;
      console.error("copy read failed", { handle, reason: e.reason, detail: e.detail });
      throw new HttpError(502, "x_fetch_failed");
    });
    if (!posts.length) throw new HttpError(404, "x_account_not_found");
    const p = posts[0];
    const { error: e } = await db.from("x_accounts").upsert(
      { handle, username: p.username, name: p.name, avatar_url: p.avatar, seen_until: p.postedAt.toISOString() },
      { onConflict: "handle", ignoreDuplicates: true },
    );
    dbCheck(e);
    await ingest(db, posts.slice(0, 12));
  }
  const { error: f } = await db.from("x_follows").upsert({ profile_id: profile, handle }, { onConflict: "profile_id,handle", ignoreDuplicates: true });
  dbCheck(f);
  return json(200, { account: (await accounts(profile, handle))[0] });
}

async function stopCopying(profile: string, raw: string) {
  const username = parseHandle(decodeURIComponent(raw));
  check(username, "invalid_x_handle");
  const { error } = await db.from("x_follows").delete().eq("profile_id", profile).eq("handle", username.toLowerCase());
  dbCheck(error);
  return json(200, { copying: false });
}

/** New posts from every copied account, in one Apify search; none when nobody copies anyone. */
async function poll() {
  const { data: follows, error } = await db.from("x_follows").select("handle, x_accounts(username, seen_until)");
  dbCheck(error);
  const followed = new Map<string, { username: string; seenUntil: Date }>();
  for (const f of follows ?? []) {
    const a = (Array.isArray(f.x_accounts) ? f.x_accounts[0] : f.x_accounts) as { username: string; seen_until: string } | null;
    if (a) followed.set(f.handle, { username: a.username, seenUntil: new Date(a.seen_until) });
  }
  if (!followed.size) return json(200, { accounts: 0, posts: 0, stored: 0, calls: 0 });

  const oldest = Math.min(...[...followed.values()].map((a) => a.seenUntil.getTime()));
  const since = new Date(Math.max(oldest, Date.now() - MAX_LOOKBACK_MS));
  let fetched;
  try {
    fetched = await fetchPosts(await apifyToken(), [...followed.values()].map((a) => a.username), { since, max: 40 });
  } catch (e) {
    if (!(e instanceof XFetchError)) throw e;
    // Apify's actor fails now and then (status FAILED after about a minute). Nothing is lost: the
    // cursors didn't move, so the next run reads the same window. Say why, in the log and in the
    // answer pg_net stores (net._http_response), instead of a bare 500.
    console.error("poll failed", { reason: e.reason, detail: e.detail, accounts: followed.size });
    return json(e.reason === "no_token" ? 503 : 502, { error: "x_fetch_failed", reason: e.reason, detail: e.detail });
  }
  const posts = fetched
    .filter((p) => {
      const a = followed.get(p.username.toLowerCase());
      return a && p.postedAt > a.seenUntil;
    });
  const result = await ingest(db, posts);
  await db.from("x_accounts").update({ polled_at: new Date().toISOString() }).in("handle", [...followed.keys()]);
  console.log("polled", { accounts: followed.size, posts: posts.length, ...result });
  return json(200, { accounts: followed.size, posts: posts.length, ...result });
}

// Bot telemetry --------------------------------------------------------------------------------

const MAX_EVENTS = 100;
const short = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);

/** POST /source/bot-events: what the bots did, one row per event (bot_events). */
async function botEvents(b: Record<string, unknown>) {
  const bot = b.bot;
  check(bot === "x" || bot === "imessage", "invalid_bot");
  check(Array.isArray(b.events) && b.events.length <= MAX_EVENTS, "invalid_events");
  const rows = (b.events as unknown[])
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e) && typeof (e as { event?: unknown }).event === "string")
    .map((e) => {
      const { t, at, event, ref, author, what, ...rest } = e;
      const when = new Date(String(at ?? t ?? ""));
      let data = rest;
      // A long trace loses its reasoning first, then everything is cut.
      if (JSON.stringify(data).length > 60_000 && data.trace) data = { ...rest, trace: { cut: JSON.stringify(rest.trace).slice(0, 30_000) } };
      if (JSON.stringify(data).length > 60_000) data = { truncated: JSON.stringify(rest).slice(0, 60_000) };
      return {
        at: Number.isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString(),
        bot,
        event: String(event).slice(0, 60),
        ref: short(ref, 60),
        author: short(author, 60),
        what: short(what, 40),
        data,
      };
    });
  if (rows.length) dbCheck((await db.from("bot_events").insert(rows)).error);
  return json(200, { saved: rows.length });
}

// Server ---------------------------------------------------------------------------------------

Deno.serve(async (req) => {
  try {
    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    const [resource, id] = parts.slice(parts.indexOf("source") + 1);
    const route = `${req.method} ${resource ?? ""}${id ? "/:id" : ""}`;

    if (route === "POST poll") {
      const pollSecret = await secret("X_POLL_SECRET", "x_poll_secret");
      if (!pollSecret) return json(503, { error: "not_configured" });
      if (!sameSecret(req.headers.get("x-poll-secret") ?? "", pollSecret)) return json(401, { error: "unauthorized" });
      return await poll();
    }
    if (route === "POST drafts" || route === "POST bot-events") {
      const botSecret = await secret("BOT_SECRET", "bot_secret");
      if (!botSecret) return json(503, { error: "not_configured" });
      if (!sameSecret(req.headers.get("x-bot-secret") ?? "", botSecret)) return json(401, { error: "unauthorized" });
      return route === "POST drafts" ? await buildDraft(await body(req)) : await botEvents(await body(req));
    }
    switch (route) {
      case "POST ": {
        await me(req, false);
        return await draft(await body(req));
      }
      case "POST attach": return await attach(await me(req, true), await body(req));
      case "GET x": return json(200, { accounts: await accounts(await me(req, false)) });
      case "PUT x/:id": return await copy(await me(req, true), id);
      case "DELETE x/:id": return await stopCopying(await me(req, true), id);
      case "GET drafts/:id":
        if (id === "mine") return await myDrafts(req);
        return json(404, { error: "no_such_route" });
      case "PUT drafts/:id": return await draftPosted(req, id, await body(req));
      default: return json(404, { error: "no_such_route" });
    }
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.code });
    console.error("source failed", e instanceof Error ? e.message : e);
    return json(500, { error: "internal" });
  }
});
