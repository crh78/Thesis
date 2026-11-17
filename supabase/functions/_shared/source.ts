// Turns something a person read into a take: an article shared into Thesis from the iOS share
// sheet, or an X post (shared, or new from an account they copy). Used by functions/source and
// functions/x-poll.
//
//   readSource(url, given?)  the page's title, site and text. X posts come from X's public oEmbed
//                            (no key). Articles are fetched; text the share extension already read
//                            from Safari wins, since paywalled sites send little to a server.
//   draftTake(source)        one fast model call: the take in plain words, risk, horizon, and
//                            whether the source itself makes a market call.

import { FAST_MODEL, jsonCall } from "./openai.ts";

export type Source = {
  url: string;
  kind: "link" | "x";
  /** "Reuters", "@KobeissiLetter on X": shown on the take as "via …". */
  label: string;
  title: string | null;
  text: string;
  /** X posts: the author as X shows the handle, without "@". */
  username?: string;
};

export type Draft = {
  claim: string;
  risk: "low" | "medium" | "high";
  horizon: "2 weeks" | "1 month" | "3 months" | "6 months";
  /** The source itself takes a market view; news with no view is false. */
  is_call: boolean;
};

const X_POST = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})/i;
const MAX_TEXT = 6000;

export class SourceError extends Error {}

/** http(s) to a public host only: never localhost or a private address. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new SourceError("invalid_url");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new SourceError("invalid_url");
  const h = u.hostname.toLowerCase();
  if (
    h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") ||
    /^(10|127|0)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) || h.startsWith("[")
  ) throw new SourceError("invalid_url");
  return u;
}

export function xPost(url: string): { username: string; id: string } | null {
  const m = url.match(X_POST);
  return m ? { username: m[1], id: m[2] } : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "-", ndash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

export function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

const stripTags = (s: string) => decode(s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

function meta(html: string, ...names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content?.trim()) return decode(content.trim());
  }
  return null;
}

/** The readable text of an article page: its paragraphs, scripts and chrome left out. */
export function articleText(html: string): string {
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, " ");
  const scope = body.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? body;
  const paras = [...scope.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1]))
    .filter((p) => p.length > 40);
  return paras.join("\n").slice(0, MAX_TEXT);
}

function siteLabel(u: URL, site: string | null): string {
  const name = site ?? u.hostname.replace(/^www\./, "");
  return name.slice(0, 60);
}

async function get(url: string, accept: string): Promise<Response> {
  return await fetch(url, {
    headers: {
      accept,
      // A browser's: some news sites send bots an empty page.
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(7000),
  });
}

/** An X post's text and author, from X's public oEmbed endpoint. */
async function readXPost(url: string, post: { username: string; id: string }): Promise<Source> {
  const canonical = `https://x.com/${post.username}/status/${post.id}`;
  const r = await get(`https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(canonical)}`, "application/json");
  if (!r.ok) throw new SourceError("post_unavailable");
  const o = await r.json() as { author_name?: string; author_url?: string; html?: string };
  const p = o.html?.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
  // Links X shortens (t.co) and attached pictures say nothing about the call.
  const text = stripTags(p.replace(/<a[^>]*>(?:pic\.twitter\.com|https?:\/\/t\.co)[^<]*<\/a>/gi, ""));
  const username = o.author_url?.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i)?.[1] ?? post.username;
  if (!text) throw new SourceError("post_unavailable");
  return { url: canonical, kind: "x", label: `@${username} on X`, title: o.author_name ?? null, text, username };
}

/**
 * What the source says. `given` is what the share extension read on the device (Safari's page
 * text, a selection, or a title): used as is when it's substantial, else the page is fetched.
 */
/** "fed-cuts-rates-again-2026-12-14" in a URL's path → "Fed cuts rates again", or null. */
export function slugTitle(u: URL): string | null {
  const slug = u.pathname.split("/").filter(Boolean)
    .map((p) => p.replace(/\.[a-z]+$/i, ""))
    .filter((p) => (p.match(/-/g) ?? []).length >= 2)
    .sort((a, b) => b.length - a.length)[0];
  if (!slug) return null;
  const words = slug.split("-").filter((w) => w && !/^(?:id)?[0-9a-f]{6,}$/i.test(w) && !/^\d+$/.test(w));
  if (words.length < 3) return null;
  const t = words.join(" ");
  return t[0].toUpperCase() + t.slice(1);
}

/**
 * What the source says. `given` is what the phone already has: Safari's page text or a
 * selection (`text`), its title, or the page itself (`html`, fetched on the phone, since many news
 * sites turn away servers). The server fetches the page only when the phone sent no page.
 */
export async function readSource(rawUrl: string, given: { title?: string | null; text?: string | null; html?: string | null } = {}): Promise<Source> {
  const u = checkUrl(rawUrl);
  const post = xPost(u.toString());
  if (post) return await readXPost(u.toString(), post);

  const givenText = (given.text ?? "").trim().slice(0, MAX_TEXT);
  let title = given.title?.trim() || null;
  let site: string | null = null;
  let text = givenText;
  let finalUrl = u;

  let html = given.html ?? null;
  if (!html) {
    try {
      const r = await get(u.toString(), "text/html,application/xhtml+xml");
      if (r.ok && (r.headers.get("content-type") ?? "").includes("html")) {
        finalUrl = checkUrl(r.url || u.toString());
        html = (await r.text()).slice(0, 1_500_000);
      }
    } catch {
      // Unreachable or blocked: what the phone sent is all there is.
    }
  }
  if (html) {
    const tag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    title = meta(html, "og:title", "twitter:title") ?? title ?? (tag ? stripTags(tag) : null);
    site = meta(html, "og:site_name", "application-name");
    if (givenText.length < 400) {
      const description = meta(html, "og:description", "description", "twitter:description") ?? "";
      text = [givenText, description, articleText(html)].filter(Boolean).join("\n").slice(0, MAX_TEXT);
    }
  }
  title ??= slugTitle(finalUrl);
  if (!text && !title) throw new SourceError("nothing_to_read");
  return { url: finalUrl.toString().slice(0, 500), kind: "link", label: siteLabel(finalUrl, site), title: title?.slice(0, 200) ?? null, text };
}

const SYSTEM = `You turn something a person read into a take for Thesis, a social app where a take is a market view that people back or fade with a basket of stocks, ETFs, commodities, crypto and prediction markets.

Write the take the way a sharp friend would text it:
- one plain sentence, at most 110 characters
- a clear direction: something goes up or down, wins or loses, happens or doesn't
- name the company, asset or event in words people know (Nvidia, gold, the Fed), no "$" tickers
- no hashtags, no emojis, no quotes, no em dashes or en dashes
- the view, not the news: "Alphabet's cash burn drags the stock lower" rather than "Alphabet's free cash flow turned negative"

risk: low for a safe, slow view; medium for most; high for a bold or fast one.
horizon: from the timeframe in the source ("by year end", "this quarter"), else "3 months".
is_call: true if the source says or implies which way something tradable is heading: a market view, a big move with a reason ("Bitcoin falls below $65,000 as liquidations hit $1.8 billion"), or news that clearly helps or hurts a company, sector or asset. False for jokes, quotes, life updates, politics with no market angle, and data with no direction; still write the most natural take a reader would have.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claim", "risk", "horizon", "is_call"],
  properties: {
    claim: { type: "string" },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    horizon: { type: "string", enum: ["2 weeks", "1 month", "3 months", "6 months"] },
    is_call: { type: "boolean" },
  },
};

/** Keeps a claim inside the take rules (3 to 140 characters, no dashes the bot never writes). */
export function cleanClaim(s: string): string {
  const c = s.replace(/\s*[–—]\s*/g, ", ").replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim();
  if (c.length <= 140) return c;
  const cut = c.slice(0, 139);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 100)).replace(/[,;:]$/, "") + "…";
}

export async function draftTake(s: Source, opts: { timeoutMs?: number } = {}): Promise<Draft> {
  const input = {
    from: s.kind === "x" ? `an X post by @${s.username}` : `an article on ${s.label}`,
    title: s.title,
    text: s.text.slice(0, MAX_TEXT),
    today: new Date().toISOString().slice(0, 10),
  };
  try {
    const d = await jsonCall<Draft>(SYSTEM, input, "take_draft", SCHEMA, {
      timeoutMs: opts.timeoutMs ?? 9000,
      maxTokens: 200,
      priority: true,
      model: FAST_MODEL,
    });
    const claim = cleanClaim(d.claim);
    if (claim.length >= 3) return { ...d, claim };
  } catch (err) {
    console.error("draft failed", err instanceof Error ? err.message : err);
  }
  // No model: the headline (or the post's first line) is a start the person can edit.
  const fallback = cleanClaim((s.title && s.kind === "link" ? s.title : s.text.split("\n")[0]) || "");
  return { claim: fallback.length >= 3 ? fallback : "This is going to move markets.", risk: "medium", horizon: "3 months", is_call: false };
}
