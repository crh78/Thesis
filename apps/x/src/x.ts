// The X API v2, as @yourthesisxyz: OAuth 1.0a user context (the app's consumer key and the bot
// account's access token), signed by hand so there's no SDK to trust. Only the three calls the bot
// makes: who am I, my mentions, and a reply.
//
// Pay-per-use prices (checked 2026-11-16): reading your own mentions $0.001 per post, a post
// $0.015, a post with a URL $0.20, a "summoned" reply $0.010. Prepaid credits.
import { createHmac, randomBytes } from "node:crypto";

export type XCreds = { consumerKey: string; consumerSecret: string; accessToken: string; accessSecret: string };

export type XUser = { id: string; username: string; name: string; public_metrics?: { followers_count: number } };
export type XPost = {
  id: string;
  text: string;
  author_id: string;
  conversation_id?: string;
  created_at?: string;
  referenced_tweets?: { type: "replied_to" | "quoted" | "retweeted"; id: string }[];
  note_tweet?: { text: string };
};
export type Mentions = { posts: XPost[]; users: Map<string, XUser>; refs: Map<string, XPost>; newestId: string | null };

const API = "https://api.x.com/2";

/** RFC 3986 percent-encoding, as OAuth 1.0a wants it. */
export const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The OAuth 1.0a Authorization header. `params` are the query (and form body) parameters; a JSON
 * body isn't signed. nonce and timestamp are injectable for the test vector.
 */
export function oauthHeader(
  method: string,
  url: string,
  params: Record<string, string>,
  creds: XCreds,
  nonce = randomBytes(16).toString("hex"),
  timestamp = Math.floor(Date.now() / 1000).toString(),
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const all = { ...params, ...oauth };
  const paramString = Object.keys(all).sort().map((k) => `${pct(k)}=${pct(all[k])}`).join("&");
  const base = [method.toUpperCase(), pct(url), pct(paramString)].join("&");
  const key = `${pct(creds.consumerSecret)}&${pct(creds.accessSecret)}`;
  const signature = createHmac("sha1", key).update(base).digest("base64");
  return "OAuth " + Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(", ");
}

export class XError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`X ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export function xClient(creds: XCreds) {
  async function call<T>(method: "GET" | "POST", path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
    const url = `${API}${path}`;
    const qs = new URLSearchParams(query).toString();
    const res = await fetch(qs ? `${url}?${qs}` : url, {
      method,
      headers: {
        authorization: oauthHeader(method, url, query, creds),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new XError(res.status, text);
    return JSON.parse(text) as T;
  }

  return {
    me: async () => (await call<{ data: XUser }>("GET", "/users/me")).data,

    /**
     * Mentions after sinceId (or, before the first one, since startTime), oldest first, with their
     * authors and the posts they reply to or quote. At most 300 a poll.
     */
    async mentions(userId: string, after: { sinceId: string } | { startTime: string }): Promise<Mentions> {
      const posts: XPost[] = [];
      const users = new Map<string, XUser>();
      const refs = new Map<string, XPost>();
      let newestId: string | null = null;
      let next: string | undefined;
      for (let page = 0; page < 3; page++) {
        const q: Record<string, string> = {
          max_results: "100",
          "tweet.fields": "author_id,conversation_id,created_at,referenced_tweets,note_tweet",
          expansions: "author_id,referenced_tweets.id,referenced_tweets.id.author_id",
          "user.fields": "username,name,public_metrics",
        };
        if ("sinceId" in after) q.since_id = after.sinceId;
        else q.start_time = after.startTime;
        if (next) q.pagination_token = next;
        const r = await call<{
          data?: XPost[];
          includes?: { users?: XUser[]; tweets?: XPost[] };
          meta?: { newest_id?: string; next_token?: string };
        }>("GET", `/users/${userId}/mentions`, q);
        posts.push(...(r.data ?? []));
        for (const u of r.includes?.users ?? []) users.set(u.id, u);
        for (const t of r.includes?.tweets ?? []) refs.set(t.id, t);
        if (page === 0) newestId = r.meta?.newest_id ?? null;
        next = r.meta?.next_token;
        if (!next) break;
      }
      posts.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      return { posts, users, refs, newestId };
    },

    async reply(toPostId: string, text: string): Promise<string> {
      const r = await call<{ data: { id: string } }>("POST", "/tweets", {}, { text, reply: { in_reply_to_tweet_id: toPostId } });
      return r.data.id;
    },
  };
}

export type XClient = ReturnType<typeof xClient>;

/** A post's full text (long posts carry it in note_tweet). */
export const fullText = (p: XPost) => p.note_tweet?.text ?? p.text;
