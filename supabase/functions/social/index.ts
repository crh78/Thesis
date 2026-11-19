// social: every write in the social layer, plus the reads that depend on who's
// asking (saves, follow lists, suggestions, traders).
//
//   GET    /saves                     → { take_ids, takes }
//   GET    /followers/:profileId      → { people }  403 hidden if they hide it (yours: always)
//   GET    /following/:profileId      → { people }  same
//   GET    /following-feed            → { takes }   takes from people you follow
//   GET    /suggestions?limit=        → { people }  who to follow, with a reason
//   GET    /traders/:takeId           → { traders } who traded / faded, people you follow first
//   GET    /notifications?limit=      → { unread, notifications } your inbox, newest first; chain
//                                      activity only for the network in x-thesis-network
//   POST   /notifications/read        { ids? } mark these (or all) read → { unread }
//   PUT    /saves/:takeId             save a take
//   DELETE /saves/:takeId
//   PUT    /follows/:profileId        follow someone
//   DELETE /follows/:profileId
//   GET    /takes/posting             → { takes } your takes still waiting for the chain
//   POST   /takes                     { claim, topic, risk, tags, legs, await_chain? } → { take }
//                                      (each leg may carry asset_id, its securities row). There's
//                                      no horizon: a take runs until its author sells their buy-in,
//                                      or 365 days at most (an old client's horizon is ignored). It's
//                                      posting, seen by you only, until its on-chain takeCreated
//                                      makes it live. Only a project with
//                                      TAKES_LIVE_WITHOUT_CHAIN=on lets a client post it live at
//                                      once by leaving out await_chain: true (./rules.ts).
//   DELETE /takes/:id                 discard your take while it's still posting
//   POST   /comments                  { take_id, parent_id?, body } → { comments } (the take's thread)
//   DELETE /comments/:id              your own comment
//   PUT    /comments/:id/like
//   DELETE /comments/:id/like
//   PATCH  /profile                   { bio?, show_following?, show_followers? } → { profile }
//                                      (an empty bio clears it)
//   DELETE /followers/:profileId      remove someone from your followers
//
// Name, handle and photo are the `session` function's (it owns the signed-in
// profile); it doesn't store bios, so that one lives here.
//
// Public reads (feeds, comments, profiles, Scores) don't come through here: the
// app calls the SQL read functions directly with the publishable key. Anything
// that reveals who someone follows is service-role only and served here, so the
// follow privacy settings hold (migrations/*_follow_privacy.sql).
//
// Auth is the Privy access token (see ../_shared/privy.ts). Writes need a
// finished profile (a handle); otherwise 403 needs_onboarding.
// Gateway JWT verification is off (config.toml): the token is Privy's.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { privyDid } from "../_shared/privy.ts";
import { takeStatus } from "./rules.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOPIC_RE = /^topic-[a-z]+$/;
const RISKS = new Set(["low", "medium", "high"]);

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

function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new HttpError(400, code);
}

function str(v: unknown, code: string, min: number, max: number): string {
  check(typeof v === "string", code);
  const s = (v as string).trim();
  check(s.length >= min && s.length <= max, code);
  return s;
}

/** Throws a 500 for unexpected database errors, mapping the expected ones. */
function dbCheck(error: { code?: string; message?: string } | null) {
  if (!error) return;
  if (error.code === "23503") throw new HttpError(404, "not_found"); // FK: take/profile gone
  if (error.code === "23514" || error.code === "22023") throw new HttpError(400, "invalid");
  // takes_one_posting_claim (migrations/*_go_live_by_take.sql): you're already posting this claim.
  if (error.code === "23505" && error.message?.includes("takes_one_posting_claim")) throw new HttpError(409, "already_posting");
  console.error(error);
  throw new HttpError(500, "internal");
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  dbCheck(error);
  return data as T;
}

// Routes ---------------------------------------------------------------------

/** The chain network the client shows (fork-mode builds send solana-mainnet-fork), or null. */
const network = (req: Request) => req.headers.get("x-thesis-network")?.match(/^[a-z0-9-]+$/)?.[0] ?? null;

async function markRead(me: string, req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // no body: mark everything read
  }
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => Number.isInteger(x)).slice(0, 200) : null;
  let q = db.from("notifications").update({ read_at: new Date().toISOString() }).eq("profile_id", me).is("read_at", null);
  const chain = network(req);
  q = chain ? q.or(`network.is.null,network.eq.${chain}`) : q.is("network", null);
  if (ids) q = q.in("id", ids);
  dbCheck((await q).error);
  const inbox = await rpc<{ unread: number }>("notification_inbox", { p_profile: me, p_network: network(req), p_limit: 1 });
  return json(200, { unread: inbox.unread });
}

async function listSaves(me: string) {
  const { data, error } = await db.from("saves").select("take_id")
    .eq("profile_id", me).order("created_at", { ascending: false });
  dbCheck(error);
  const ids = (data ?? []).map((r) => r.take_id as string);
  const takes = ids.length ? await rpc<unknown[]>("takes_by_ids", { p_ids: ids }) : [];
  return json(200, { take_ids: ids, takes });
}

async function setSave(me: string, takeId: string, on: boolean) {
  check(UUID_RE.test(takeId), "invalid_take_id");
  if (on) await requireLive(takeId);
  const q = on
    ? db.from("saves").upsert({ profile_id: me, take_id: takeId }, { ignoreDuplicates: true })
    : db.from("saves").delete().eq("profile_id", me).eq("take_id", takeId);
  dbCheck((await q).error);
  return json(200, { saved: on });
}

async function setFollow(me: string, profileId: string, on: boolean) {
  check(UUID_RE.test(profileId), "invalid_profile_id");
  check(profileId !== me, "cant_follow_self");
  const q = on
    ? db.from("follows").upsert({ follower_id: me, followee_id: profileId }, { ignoreDuplicates: true })
    : db.from("follows").delete().eq("follower_id", me).eq("followee_id", profileId);
  dbCheck((await q).error);
  return json(200, { following: on });
}

async function createTake(me: string, body: Record<string, unknown>) {
  const claim = str(body.claim, "invalid_claim", 3, 140);
  const topic = typeof body.topic === "string" && TOPIC_RE.test(body.topic) ? body.topic : "topic-coin";
  const risk = String(body.risk ?? "").toLowerCase();
  check(RISKS.has(risk), "invalid_risk");

  const tags = Array.isArray(body.tags) ? body.tags : [];
  check(tags.length <= 5, "invalid_tags");
  const cleanTags = tags.map((t) => str(t, "invalid_tags", 1, 24));

  check(Array.isArray(body.legs), "invalid_legs");
  const rawLegs = body.legs as Record<string, unknown>[];
  // At most 5 legs (the take builder's cap: each swap leg costs Jupiter calls on a trade's first build).
  check(rawLegs.length >= 1 && rawLegs.length <= 5, "invalid_legs");
  const legs = rawLegs.map((leg, i) => {
    check(leg && typeof leg === "object", "invalid_legs");
    const weight = Number(leg.weight);
    check(Number.isFinite(weight) && weight > 0 && weight <= 100, "invalid_leg_weight");
    const slot = leg.slot === undefined ? i : Number(leg.slot);
    check(Number.isInteger(slot) && slot >= 0 && slot <= 9, "invalid_leg_slot");
    const fadeHow = leg.fade_how == null || leg.fade_how === ""
      ? null
      : str(leg.fade_how, "invalid_leg_fade_how", 1, 60);
    return {
      // Up to 120: card titles and prediction questions run long.
      name: str(leg.name, "invalid_leg_name", 1, 120),
      kind: str(leg.kind, "invalid_leg_kind", 1, 40),
      weight,
      why: leg.why == null ? "" : str(leg.why, "invalid_leg_why", 0, 300),
      slot,
      fade_how: fadeHow,
      // The catalog asset it came from; create_take keeps it only if it's a real one.
      asset_id: typeof leg.asset_id === "string" && leg.asset_id.length <= 120 ? leg.asset_id : null,
    };
  });
  const total = legs.reduce((sum, l) => sum + l.weight, 0);
  check(Math.abs(total - 100) <= 1, "weights_must_total_100");
  // Every pick has its own slot (the composer's nextSlot): its color, and its leg on-chain.
  check(new Set(legs.map((l) => l.slot)).size === legs.length, "invalid_leg_slot");

  const id = await rpc<string>("create_take", {
    p_author: me,
    p_claim: claim,
    p_topic: topic,
    p_risk: risk,
    // Ignored: create_take sets the 365-day lifetime (migrations/*_author_sale_closes.sql).
    p_horizon: null,
    p_tags: cleanTags,
    p_legs: legs,
    // The server decides, not the client: the take stays hidden from everyone but its author
    // until the on-chain buy-in's takeCreated event makes it live (migrations/*_post_after_chain.sql).
    p_status: takeStatus(body.await_chain),
  });
  return json(201, { take: await rpc("take", { p_id: id }) });
}

/** 404s unless the take exists and is live: nobody comments on or saves a take still posting. */
async function requireLive(takeId: string) {
  const { data, error } = await db.from("takes").select("status").eq("id", takeId).maybeSingle();
  dbCheck(error);
  if (data?.status !== "live") throw new HttpError(404, "not_found");
}

/** Drops your take if the chain never got it. 404 if it's live, someone else's, or gone. */
async function discardTake(me: string, takeId: string) {
  check(UUID_RE.test(takeId), "invalid_take_id");
  const gone = await rpc<boolean>("discard_posting_take", { p_author: me, p_id: takeId });
  if (!gone) throw new HttpError(404, "not_found");
  return json(200, { discarded: true });
}

async function createComment(me: string, body: Record<string, unknown>) {
  const takeId = String(body.take_id ?? "");
  check(UUID_RE.test(takeId), "invalid_take_id");
  const text = str(body.body, "invalid_body", 1, 500);
  await requireLive(takeId);

  let parentId: string | null = null;
  if (body.parent_id != null) {
    parentId = String(body.parent_id);
    check(UUID_RE.test(parentId), "invalid_parent_id");
    // Replies are one level deep and on the same take: replying to a reply
    // attaches to its top-level comment.
    const { data: parent, error } = await db.from("comments")
      .select("id, take_id, parent_id").eq("id", parentId).maybeSingle();
    dbCheck(error);
    if (!parent || parent.take_id !== takeId) throw new HttpError(404, "parent_not_found");
    parentId = parent.parent_id ?? parent.id;
  }

  const { error } = await db.from("comments")
    .insert({ take_id: takeId, author_id: me, parent_id: parentId, body: text });
  dbCheck(error);
  return json(201, { comments: await rpc("take_comments", { p_take: takeId, p_viewer: me }) });
}

async function deleteComment(me: string, id: string) {
  check(UUID_RE.test(id), "invalid_comment_id");
  const { data, error } = await db.from("comments").delete()
    .eq("id", id).eq("author_id", me).select("id");
  dbCheck(error);
  if (!data?.length) throw new HttpError(404, "not_found");
  return json(200, { deleted: true });
}

async function setLike(me: string, id: string, on: boolean) {
  check(UUID_RE.test(id), "invalid_comment_id");
  const q = on
    ? db.from("comment_likes").upsert({ comment_id: id, profile_id: me }, { ignoreDuplicates: true })
    : db.from("comment_likes").delete().eq("comment_id", id).eq("profile_id", me);
  dbCheck((await q).error);
  return json(200, { liked: on });
}

// Profile ----------------------------------------------------------------------

async function updateProfile(me: string, body: Record<string, unknown>) {
  const update: Record<string, unknown> = {};
  if (body.bio !== undefined) {
    const bio = body.bio === null ? "" : str(body.bio, "invalid_bio", 0, 160);
    update.bio = bio.length ? bio : null;
  }
  for (const key of ["show_following", "show_followers"]) {
    if (body[key] === undefined) continue;
    check(typeof body[key] === "boolean", `invalid_${key}`);
    update[key] = body[key];
  }
  check(Object.keys(update).length > 0, "nothing_to_update");
  dbCheck((await db.from("profiles").update(update).eq("id", me)).error);
  return json(200, { profile: await rpc("profile", { p_profile: me }) });
}

// Follow lists ----------------------------------------------------------------

/** Someone's followers / following, if they show it (your own: always). */
async function followList(me: string, kind: "followers" | "following", profileId: string) {
  check(UUID_RE.test(profileId), "invalid_profile_id");
  if (profileId !== me) {
    const { data, error } = await db.from("profiles").select("show_followers, show_following")
      .eq("id", profileId).maybeSingle();
    dbCheck(error);
    if (!data) return fail(404, "not_found");
    if (!(kind === "followers" ? data.show_followers : data.show_following)) return fail(403, "hidden");
  }
  return json(200, { people: await rpc(kind, { p_profile: profileId, p_viewer: me }) });
}

/** Remove someone from your followers (they can follow again; block is separate). */
async function removeFollower(me: string, profileId: string) {
  check(UUID_RE.test(profileId), "invalid_profile_id");
  dbCheck((await db.from("follows").delete().eq("follower_id", profileId).eq("followee_id", me)).error);
  return json(200, { removed: true });
}

// Server ---------------------------------------------------------------------

Deno.serve(async (req) => {
  try {
    const did = await privyDid(req);
    if (!did) return fail(401, "invalid_privy_token");

    const me = await rpc<string>("ensure_account", { p_privy_did: did });

    // Path after the function name, e.g. /social/saves/<id> → ["saves", "<id>"].
    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    const at = parts.indexOf("social");
    const [resource, id, sub] = parts.slice(at + 1);
    const method = req.method;

    if (method === "GET") {
      if (resource === "saves" && !id) return await listSaves(me);
      if ((resource === "followers" || resource === "following") && id && !sub) return await followList(me, resource, id);
      // Your takes still waiting for the chain (hidden from everyone else).
      if (resource === "takes" && id === "posting" && !sub) return json(200, { takes: await rpc("posting_takes", { p_author: me }) });
      if (resource === "following-feed" && !id) return json(200, { takes: await rpc("following_feed", { p_profile: me }) });
      if (resource === "suggestions" && !id) {
        const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit") ?? 20) || 20, 1), 50);
        return json(200, { people: await rpc("suggested_follows", { p_profile: me, p_limit: limit }) });
      }
      if (resource === "notifications" && !id) {
        const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit") ?? 50) || 50, 1), 100);
        return json(200, await rpc("notification_inbox", { p_profile: me, p_network: network(req), p_limit: limit }));
      }
      if (resource === "traders" && id && !sub) {
        check(UUID_RE.test(id), "invalid_take_id");
        return json(200, { traders: await rpc("take_traders", { p_take: id, p_viewer: me }) });
      }
      return fail(404, "no_such_route");
    }

    // Reading your own inbox needs no handle.
    if (method === "POST" && resource === "notifications" && id === "read") return await markRead(me, req);

    // Everything else writes: needs a finished profile.
    const { data: profile, error } = await db.from("profiles").select("handle").eq("id", me).single();
    dbCheck(error);
    if (!profile?.handle) return fail(403, "needs_onboarding");

    let body: Record<string, unknown> = {};
    if (method === "POST" || method === "PATCH") {
      try {
        body = await req.json();
      } catch {
        return fail(400, "invalid_json");
      }
      check(body && typeof body === "object" && !Array.isArray(body), "invalid_json");
    }

    switch (`${method} ${resource}${id ? "/:id" : ""}${sub ? `/${sub}` : ""}`) {
      case "PUT saves/:id": return await setSave(me, id, true);
      case "DELETE saves/:id": return await setSave(me, id, false);
      case "PUT follows/:id": return await setFollow(me, id, true);
      case "DELETE follows/:id": return await setFollow(me, id, false);
      case "POST takes": return await createTake(me, body);
      case "DELETE takes/:id": return await discardTake(me, id);
      case "POST comments": return await createComment(me, body);
      case "DELETE comments/:id": return await deleteComment(me, id);
      case "PATCH profile": return await updateProfile(me, body);
      case "DELETE followers/:id": return await removeFollower(me, id);
      case "PUT comments/:id/like": return await setLike(me, id, true);
      case "DELETE comments/:id/like": return await setLike(me, id, false);
      default: return fail(404, "no_such_route");
    }
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code);
    console.error(e);
    return fail(500, "internal");
  }
});
