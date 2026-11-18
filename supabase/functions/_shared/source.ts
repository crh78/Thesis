// Turns something a person read into a take: an article shared into Thesis from the iOS share
// sheet, or an X post (shared, or new from an account they copy). Used by functions/source and
// functions/x-poll.
//
//   readSource(url, given?)  the page's title, site and text. X posts come from X's public oEmbed
//                            (no key). Articles are fetched; text the share extension already read
//                            from Safari wins, since paywalled sites send little to a server.
//   draftTake(source)        one fast model call: the take in plain words, risk, and whether the
//                            source itself makes a market call. No horizon: a take runs until its
//                            author sells, or a year at most.

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
  /** The source itself takes a market view; news with no view is false. */
  is_call: boolean;
};

const X_POST = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})/i;
const MAX_TEXT = 6000;

export class SourceError extends Error {}

// Fetching a page someone shared (SSRF guards) ------------------------------------------------
//
// The server fetches URLs users send, so every request must go to a public host: each hop of a
// redirect is checked before it's requested, the host's DNS answers must all be public addresses,
// only ports 80 and 443, and the body is cut off while it streams. Left open: the fetch resolves
// the name again, so a DNS answer that changes between the check and the request (rebinding)
// isn't caught; the edge runtime can't pin the address it checked.

/** Ports a page may be fetched from (no port in the URL means 80 or 443). */
const PORTS = new Set(["", "80", "443"]);
const MAX_REDIRECTS = 3;
/** Bytes of a page read at most; the rest isn't downloaded. */
export const MAX_PAGE_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 7000;
const USER_AGENT =
  // A browser's: some news sites send bots an empty page.
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

function ipv4(s: string): number[] | null {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

/** 8 groups of 16 bits, or null. Takes "[…]", a zone ("%en0") and a dotted IPv4 tail. */
function ipv6(raw: string): number[] | null {
  let s = raw.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  const tail = s.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (tail) {
    const b = ipv4(tail[1]);
    if (!b) return null;
    s = s.slice(0, -tail[1].length) + ((b[0] << 8) | b[1]).toString(16) + ":" + ((b[2] << 8) | b[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h: string) => (h === "" ? [] : h.split(":"));
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function privateV4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10: carrier NAT, Tailscale
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) ||
    a >= 224; // multicast, reserved, broadcast
}

const v4Of = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

function privateV6(g: number[]): boolean {
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return privateV4(v4Of(g[6], g[7])); // ::ffff:a.b.c.d
  if (zeros(0, 6)) return true; // ::, ::1, ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) return !zeros(2, 6) || privateV4(v4Of(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return privateV4(v4Of(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
  if (g[0] === 0x100 && zeros(1, 4)) return true; // discard
  return (g[0] & 0xfe00) === 0xfc00 || // unique local
    (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || // link-local, site-local
    (g[0] & 0xff00) === 0xff00; // multicast
}

/** Whether an address (IPv4 or IPv6) is on the public internet: not private, loopback, link-local or CGNAT. */
export function isPublicIp(ip: string): boolean {
  const v4 = ipv4(ip);
  if (v4) return !privateV4(v4);
  const v6 = ipv6(ip);
  return v6 !== null && !privateV6(v6);
}

/** http(s) on port 80 or 443 to a public host name: never localhost or a private address. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new SourceError("invalid_url");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new SourceError("invalid_url");
  if (!PORTS.has(u.port) || u.username || u.password) throw new SourceError("invalid_url");
  // The URL parser already turned "0x7f.1" and "2130706433" into "127.0.0.1".
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (
    h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") ||
    !h.includes(".") || h.startsWith("[") || (ipv4(h) !== null && !isPublicIp(h))
  ) throw new SourceError("invalid_url");
  return u;
}

/** A host name's addresses (A and AAAA); none when it doesn't resolve. Gives up when `signal` aborts. */
export type Resolve = (host: string, signal?: AbortSignal) => Promise<string[]>;

export const resolveHost: Resolve = async (host, signal) => {
  // Without DNS nothing can be checked, so nothing is fetched: say so rather than fail quietly.
  if (typeof Deno.resolveDns !== "function") {
    console.error("source: Deno.resolveDns is unavailable, so pages aren't fetched");
    return [];
  }
  const found: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    try {
      found.push(...await Deno.resolveDns(host, type, { signal }));
    } catch (e) {
      if (signal?.aborted) throw e; // out of time: not "no records"
      // No records of this type.
    }
  }
  return found;
};

/**
 * Refuses a host unless it resolves, and every address it resolves to is public:
 * unresolved_host or private_host.
 */
export async function checkHost(u: URL, resolve: Resolve = resolveHost, signal?: AbortSignal): Promise<void> {
  const h = u.hostname.replace(/\.$/, "");
  if (ipv4(h)) return; // a literal: checkUrl already checked it
  const ips = await resolve(h, signal);
  if (!ips.length) throw new SourceError("unresolved_host");
  if (!ips.every(isPublicIp)) throw new SourceError("private_host");
}

export type FetchDeps = { fetch?: typeof fetch; resolve?: Resolve };

/**
 * GETs a public page. Redirects are followed by hand (at most 3), each new URL checked like the
 * first before it's requested. Returns the last URL and its response, whose body is still unread.
 */
export async function fetchPublic(raw: string, accept: string, deps: FetchDeps = {}): Promise<{ url: URL; response: Response }> {
  const get = deps.fetch ?? fetch;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let u = checkUrl(raw);
  for (let hop = 0;; hop++) {
    await checkHost(u, deps.resolve, signal);
    const r = await get(u.toString(), { headers: { accept, "user-agent": USER_AGENT }, redirect: "manual", signal });
    const location = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!location) return { url: u, response: r };
    await r.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new SourceError("too_many_redirects");
    let next: URL;
    try {
      next = new URL(location, u);
    } catch {
      throw new SourceError("invalid_url");
    }
    u = checkUrl(next.toString());
  }
}

/** A response's text, reading at most `max` bytes: the rest is never downloaded. */
export async function readCapped(r: Response, max = MAX_PAGE_BYTES): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, max - n);
      chunks.push(part);
      n += part.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
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

/** An X post's text and author, from X's public oEmbed endpoint (a fixed host, not the user's URL). */
async function readXPost(url: string, post: { username: string; id: string }): Promise<Source> {
  const canonical = `https://x.com/${post.username}/status/${post.id}`;
  const r = await fetch(`https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(canonical)}`, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
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
export async function readSource(
  rawUrl: string,
  given: { title?: string | null; text?: string | null; html?: string | null } = {},
  deps: FetchDeps = {},
): Promise<Source> {
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
      const { url, response: r } = await fetchPublic(u.toString(), "text/html,application/xhtml+xml", deps);
      if (r.ok && (r.headers.get("content-type") ?? "").includes("html")) {
        finalUrl = url;
        html = await readCapped(r);
      } else {
        await r.body?.cancel();
      }
    } catch (e) {
      // Unreachable, blocked, or not a public host: what the phone sent is all there is. Logged
      // (host and reason only), so DNS trouble on the hosted runtime doesn't go unnoticed.
      console.warn(`source: didn't fetch ${u.hostname}: ${e instanceof Error ? e.message || e.name : String(e)}`);
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
is_call: true if the source says or implies which way something tradable is heading: a market view, a big move with a reason ("Bitcoin falls below $65,000 as liquidations hit $1.8 billion"), or news that clearly helps or hurts a company, sector or asset. False for jokes, quotes, life updates, politics with no market angle, and data with no direction; still write the most natural take a reader would have.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claim", "risk", "is_call"],
  properties: {
    claim: { type: "string" },
    risk: { type: "string", enum: ["low", "medium", "high"] },
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
  return { claim: fallback.length >= 3 ? fallback : "This is going to move markets.", risk: "medium", is_call: false };
}
