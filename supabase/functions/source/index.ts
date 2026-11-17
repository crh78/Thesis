// source: takes from what you read, and copying X accounts.
//
//   POST   /source                 { url, title?, text?, html? } → { claim, risk, horizon, is_call,
//                                  source } an article or X post → a take to edit. title/text/html:
//                                  what the phone already has (Safari's page text, a selection, the
//                                  page fetched on the phone: many news sites turn servers away).
//                                  source: { url, label, kind, title }.
//                                  400 invalid_url | nothing_to_read, 404 post_unavailable
//   POST   /source/attach          { take_id, url, label, kind } your new take came from this
//                                  (shown on it as "via …"); once per take → { attached }
//   GET    /source/x               → { accounts } the X accounts you copy, each with its recent
//                                  calls as drafted takes: { post_id, url, text, posted_at, claim,
//                                  risk, horizon }
//   PUT    /source/x/:handle       copy an X account → { account }. The first person to copy one
//                                  reads its last three weeks, so there's something to copy now;
//                                  404 x_account_not_found when it has no recent posts; 403
//                                  copy_limit past MAX_COPIED (10) accounts per person.
//   DELETE /source/x/:handle       stop copying
//   POST   /source/poll            header x-poll-secret: new posts from copied accounts → drafted
//                                  takes → x_call notifications (pg_cron, every 15 minutes)
//
// Reading: X posts through X's public oEmbed, articles by fetching the page (_shared/source.ts);
// copied accounts' timelines through Apify (_shared/x.ts). Drafting: one fast model call.
// Kept out of functions/social so that function's deploys stay its own.
//
// Secrets: OPENAI_API_KEY, OPENAI_FAST_MODEL, PRIVY_* (+ SUPABASE_*). APIFY_TOKEN and X_POLL_SECRET
// come from the function's secrets or, failing that, the Vault (apify_token, x_poll_secret, read
// through source_secret()), where pg_cron reads the poll secret too.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { privyDid } from "../_shared/privy.ts";
import { draftTake, readSource, SourceError } from "../_shared/source.ts";
import { fetchPosts, ingest, parseHandle, recentCalls } from "../_shared/x.ts";

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
    return json(200, { ...d, source: { url: source.url, label: source.label, kind: source.kind, title: source.title }, ms: Date.now() - started });
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
    const posts = await fetchPosts(token, [username], { since: new Date(Date.now() - 21 * 86_400_000), max: 20 });
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
  const posts = (await fetchPosts(await apifyToken(), [...followed.values()].map((a) => a.username), { since, max: 40 }))
    .filter((p) => {
      const a = followed.get(p.username.toLowerCase());
      return a && p.postedAt > a.seenUntil;
    });
  const result = await ingest(db, posts);
  await db.from("x_accounts").update({ polled_at: new Date().toISOString() }).in("handle", [...followed.keys()]);
  console.log("polled", { accounts: followed.size, posts: posts.length, ...result });
  return json(200, { accounts: followed.size, posts: posts.length, ...result });
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
    switch (route) {
      case "POST ": {
        await me(req, false);
        return await draft(await body(req));
      }
      case "POST attach": return await attach(await me(req, true), await body(req));
      case "GET x": return json(200, { accounts: await accounts(await me(req, false)) });
      case "PUT x/:id": return await copy(await me(req, true), id);
      case "DELETE x/:id": return await stopCopying(await me(req, true), id);
      default: return json(404, { error: "no_such_route" });
    }
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.code });
    console.error("source failed", e instanceof Error ? e.message : e);
    return json(500, { error: "internal" });
  }
});
