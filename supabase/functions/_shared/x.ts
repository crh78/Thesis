// X accounts people copy: reading their posts (Apify) and turning calls into takes.
// Apify's cheapest tweet scraper for the demo (about $0.003 per poll, one
// search for every followed account); it scrapes X against its terms, so move to the official
// X API before launch. Only `fetchPosts` knows about Apify.
//
// The Apify token comes from the caller (functions/source: APIFY_TOKEN, else the Vault).

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { draftTake, type Draft } from "./source.ts";

const ACTOR = "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest";
/** X search queries stay well under its 512-character limit with this many `from:` terms. */
const HANDLES_PER_QUERY = 12;

export const HANDLE_RE = /^@?([A-Za-z0-9_]{1,15})$/;

export type XPost = {
  id: string;
  url: string;
  text: string;
  postedAt: Date;
  username: string;
  name: string | null;
  avatar: string | null;
};

type ApifyTweet = {
  id?: string | number;
  type?: string;
  url?: string;
  text?: string;
  createdAt?: string;
  isReply?: boolean;
  retweeted_tweet?: unknown;
  author?: { userName?: string; name?: string; profilePicture?: string };
};

/** "@KobeissiLetter", "x.com/KobeissiLetter" or "KobeissiLetter" → "KobeissiLetter", else null. */
export function parseHandle(raw: string): string | null {
  const s = raw.trim().replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, "").replace(/[/?#].*$/, "");
  return s.match(HANDLE_RE)?.[1] ?? null;
}

/**
 * Reading posts failed: `reason` says why in one word (no_token, timeout, run_failed, http_<status>,
 * bad_response), `detail` is Apify's own message. The poll answers 502 with the reason, so
 * net._http_response shows it next to the cron run.
 */
export class XFetchError extends Error {
  constructor(readonly reason: string, readonly detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

/** One Apify call's answer → its items, or an XFetchError saying what went wrong. */
export async function apifyItems(r: Response): Promise<ApifyTweet[]> {
  const text = await r.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch { /* not JSON: reported below */ }
  if (!r.ok) {
    // {"error":{"type":"run-failed","message":"Actor run did not succeed (run ID: …, status: FAILED)."}}
    const err = (body as { error?: { type?: string; message?: string } } | null)?.error;
    const reason = err?.type === "run-failed" ? "run_failed" : err?.type === "run-timeout-exceeded" ? "timeout" : `http_${r.status}`;
    throw new XFetchError(reason, (err?.message ?? text).slice(0, 200));
  }
  if (!Array.isArray(body)) throw new XFetchError("bad_response", text.slice(0, 200));
  return body as ApifyTweet[];
}

/**
 * Original posts (no replies or reposts) from these accounts, newest first, after `since`.
 * `max` caps what one call can cost. Throws XFetchError when Apify can't answer.
 */
export async function fetchPosts(token: string, handles: string[], opts: { since?: Date; max?: number } = {}): Promise<XPost[]> {
  if (!token) throw new XFetchError("no_token");
  const out: XPost[] = [];
  for (let i = 0; i < handles.length; i += HANDLES_PER_QUERY) {
    const group = handles.slice(i, i + HANDLES_PER_QUERY);
    const since = opts.since ? ` since_time:${Math.floor(opts.since.getTime() / 1000)}` : "";
    const query = `(${group.map((h) => `from:${h}`).join(" OR ")}) -filter:replies -filter:nativeretweets${since}`;
    const max = opts.max ?? 40;
    const r = await fetch(
      `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?maxTotalChargeUsd=0.05&timeout=90`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ searchTerms: [query], maxItems: max, queryType: "Latest" }),
        signal: AbortSignal.timeout(100_000),
      },
    ).catch((e) => {
      throw e instanceof DOMException && e.name === "TimeoutError" ? new XFetchError("timeout") : new XFetchError("network", String(e).slice(0, 200));
    });
    const items = await apifyItems(r);
    for (const t of items) {
      // The scraper pads small results with "mock_tweet" notices (id -1).
      if (t.type !== "tweet" || !t.id || String(t.id) === "-1" || t.isReply || t.retweeted_tweet) continue;
      const username = t.author?.userName;
      const postedAt = t.createdAt ? new Date(t.createdAt) : null;
      if (!username || !t.text || !postedAt || Number.isNaN(postedAt.getTime())) continue;
      out.push({
        id: String(t.id),
        url: t.url ?? `https://x.com/${username}/status/${t.id}`,
        text: t.text.replace(/\s*https:\/\/t\.co\/\w+\s*$/g, "").trim(),
        postedAt,
        username,
        // _normal is 48 px; _200x200 is the same picture, big enough for the app.
        avatar: t.author?.profilePicture?.replace("_normal.", "_200x200.") ?? null,
        name: t.author?.name ?? null,
      });
    }
  }
  return out.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/**
 * Stores new posts with the take drafted from each (null claim when it isn't a call). Storing a
 * call notifies whoever copies the account (trigger x_calls_notify). Returns how many were new.
 */
export async function ingest(db: SupabaseClient, posts: XPost[]): Promise<{ stored: number; calls: number }> {
  if (!posts.length) return { stored: 0, calls: 0 };
  const { data: known, error } = await db.from("x_calls").select("post_id").in("post_id", posts.map((p) => p.id));
  if (error) throw new Error(error.message);
  const seen = new Set((known ?? []).map((k) => k.post_id as string));
  const fresh = posts.filter((p) => !seen.has(p.id) && p.text.length >= 12);

  const drafts = await mapLimit(fresh, 6, async (p): Promise<Draft | null> => {
    try {
      return await draftTake({ url: p.url, kind: "x", label: `@${p.username} on X`, title: p.name, text: p.text, username: p.username });
    } catch {
      return null;
    }
  });

  const rows = fresh.map((p, i) => {
    const d = drafts[i];
    const call = d && d.is_call && d.claim.length >= 3;
    return {
      post_id: p.id,
      handle: p.username.toLowerCase(),
      url: p.url,
      text: p.text.slice(0, 2000),
      posted_at: p.postedAt.toISOString(),
      claim: call ? d!.claim : null,
      risk: call ? d!.risk : null,
      horizon: call ? d!.horizon : null,
    };
  });
  if (rows.length) {
    const { error: e } = await db.from("x_calls").upsert(rows, { onConflict: "post_id", ignoreDuplicates: true });
    if (e) throw new Error(e.message);
  }

  // Keep names and pictures current, and move each account's cursor past what we've read.
  const byHandle = new Map<string, XPost>();
  for (const p of posts) if (!byHandle.has(p.username.toLowerCase())) byHandle.set(p.username.toLowerCase(), p);
  for (const [handle, p] of byHandle) {
    await db.from("x_accounts").update({ username: p.username, name: p.name, avatar_url: p.avatar, seen_until: p.postedAt.toISOString() })
      .eq("handle", handle).lt("seen_until", p.postedAt.toISOString());
  }
  return { stored: rows.length, calls: rows.filter((r) => r.claim).length };
}

/** An account's recent calls with drafted takes, newest first, for the app. */
export async function recentCalls(db: SupabaseClient, handles: string[], perAccount = 6) {
  if (!handles.length) return new Map<string, unknown[]>();
  const { data, error } = await db.from("x_calls")
    .select("post_id, handle, url, text, posted_at, claim, risk, horizon")
    .in("handle", handles)
    .not("claim", "is", null)
    .order("posted_at", { ascending: false })
    .limit(perAccount * handles.length * 2);
  if (error) throw new Error(error.message);
  const out = new Map<string, unknown[]>();
  for (const row of data ?? []) {
    const list = out.get(row.handle) ?? [];
    if (list.length < perAccount) list.push(row);
    out.set(row.handle, list);
  }
  return out;
}
