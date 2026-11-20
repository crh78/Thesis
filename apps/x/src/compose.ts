// The bot's replies, from templates: the only model-written words that reach X are the vetted
// claim and the take builder's pick names, and both pass the checks below first.
import { cleanReply } from "@thesis/agent";

/** X counts every URL as 23 characters. */
const URL_LEN = 23;
const MAX = 280;

// A last line of defence behind the vetting model: words the bot never posts, whatever the claim.
const NEVER = /\b(kill|murder|rape|suicid|nazi|hitler|terroris|shooting|massacre|genocide|porn|nude|n[i1]gg|f[a@]gg|retard|kike|chink|spic|tranny|cunt|whore)\w*/i;

/** The vetted claim, made safe to post: no handles, links, tags, cashtags or emoji. Null if it fails. */
export function safeClaim(raw: string): string | null {
  const c = raw
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[@#$]\w+/g, (m) => (m[0] === "$" ? m.slice(1).toUpperCase() : ""))
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*[.!?]+$/, "")
    .trim();
  if (c.length < 5 || c.length > 120) return null;
  if (NEVER.test(c) || /\b(?:www\.|\w+\.(?:com|io|xyz|net|org)\b)/i.test(c)) return null;
  return c;
}

export const xLength = (s: string) => s.replace(/https?:\/\/\S+/g, "x".repeat(URL_LEN)).length;

type Pick = { name: string; weight: number };

/**
 * "Cameco 40%, Vistra 35%, Uranium ETF 25%", as many as fit, then "+2 more". A take that bets
 * against its picks (`inverted`: agreeing is short every one) reads "Betting against: Bitcoin 40%, …".
 */
function pickLine(picks: Pick[], room: number, inverted = false): string {
  const lead = inverted ? "Betting against: " : "";
  const parts = picks.map((p) => `${p.name.replace(/[@#]/g, "").slice(0, 28)} ${Math.round(p.weight)}%`);
  for (let n = Math.min(parts.length, 4); n >= 1; n--) {
    const more = parts.length - n;
    const line = lead + parts.slice(0, n).join(", ") + (more ? `, +${more} more` : "");
    if (line.length <= room) return line;
  }
  return inverted ? `Betting against ${parts.length} picks` : `${parts.length} picks`;
}

/**
 * No link: a reply with a URL costs $0.20 on X, without one $0.015. The draft is saved for the
 * asker, and the web app (link in the bot's bio) shows it once they sign in with that X account.
 */
export const TAKE_TAIL = "Saved for you: sign in with X at the link in our bio to post it as your take.";

export function takeReply(claim: string, picks: Pick[], inverted = false): string | null {
  if (picks.some((p) => NEVER.test(p.name))) return null;
  const head = `${claim}.`;
  const tail = TAKE_TAIL;
  const room = MAX - xLength(head) - xLength(tail) - 4;
  const text = cleanReply(`${head}\n\n${pickLine(picks, room, inverted)}\n\n${tail}`);
  return xLength(text) <= MAX ? text : null;
}

export const NO_EXPOSURE = "No clean way to trade that one yet. Try a sharper take.";
export const EXPLAIN = "Thesis turns a take into a basket of real investments. Reply to any post with @yourthesisxyz and I'll build one you can post and trade. Mention me with \"stop\" to opt out.";

// Opting out, as X's automation rules require: "stop" ends replies to that person, "start" brings them back.
export const OPTED_OUT = "Got it, I won't reply to you anymore. Mention me with \"start\" to turn replies back on.";
export const OPTED_IN = "Welcome back. Reply to any post with @yourthesisxyz and I'll build a take from it.";

/** "stop" / "start" (the whole mention, handles already stripped), else null. */
export function optCommand(text: string): "stop" | "start" | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(stop|unsubscribe|opt ?out)$/.test(t)) return "stop";
  if (/^(start|opt ?in)$/.test(t)) return "start";
  return null;
}

// Trading from a reply ("@yourthesisxyz back $20", "fade $50") ------------------------------------

export type Intent = { side: "back" | "fade"; usd: number };

/** "back $20", "in for 20", "fade $50", "bet against this $25" → the side and dollars, else null. */
export function tradeIntent(text: string): Intent | null {
  const t = text.toLowerCase().replace(/,/g, "");
  const m = t.match(/\b(back|backing|in for|i'?m in(?: for)?|buy|fade|fading|bet against|against|short)\b[^$\d]{0,20}\$?\s?(\d{1,4}(?:\.\d{1,2})?)\b/)
    ?? t.match(/\$\s?(\d{1,4}(?:\.\d{1,2})?)\s+(?:on|to)?\s*(back|fade|against)\b/);
  if (!m) return null;
  const [word, num] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
  const usd = Number(num);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return { side: /fad|against|short/.test(word) ? "fade" : "back", usd };
}

const dollars = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
export const BIO = "the link in our bio";

/** A trade went through: it's the replier's take now (posted with their buy-in). `inverted`: it bets against its picks. */
export function tradeReply(claim: string, picks: { name: string; weight: number }[], usd: number, inverted = false): string | null {
  if (picks.some((p) => NEVER.test(p.name))) return null;
  const head = `You're in: ${dollars(usd)} on "${claim}".`;
  const tail = `It's your take on Thesis now. See it at ${BIO}.`;
  const room = MAX - xLength(head) - xLength(tail) - 4;
  const text = cleanReply(`${head}\n\n${pickLine(picks, room, inverted)}\n\n${tail}`);
  return xLength(text) <= MAX ? text : null;
}

/** A trade on a Thesis take someone shared. */
export const takeTradeReply = (side: "back" | "fade", usd: number) =>
  side === "back" ? `You're in: ${dollars(usd)} backing this take. See it at ${BIO}.` : `Done: ${dollars(usd)} fading this take. See it at ${BIO}.`;

export const NOT_LINKED = `To trade from replies, sign in at ${BIO} and set your limits once. Then reply again.`;
export const overLimit = (kind: "trade" | "daily", limit: number | undefined, left: number | undefined) =>
  kind === "trade"
    ? `That's over your ${limit != null ? `${dollars(limit)} ` : ""}per-trade limit. Change it or trade by hand at ${BIO}.`
    : `That's past your daily limit${left != null ? ` (${dollars(left)} left today)` : ""}. Trade by hand at ${BIO}.`;
export const TRADE_FAILED = `Couldn't place that trade just now. Try again in a minute, or at ${BIO}.`;

// Selling from a reply ("@yourthesisxyz sell", "sell half", "sell 25%", "sell $20") ------------------

export type SellIntent = { bps?: number; usd?: number };

/** "sell" (all of it), "sell half", "sell 25%", "sell $20" → what to sell, else null. */
export function sellIntent(text: string): SellIntent | null {
  const t = text.toLowerCase().replace(/,/g, "");
  if (!/\b(sell|cash out|close)\b/.test(t)) return null;
  if (/\bhalf\b/.test(t)) return { bps: 5000 };
  const pct = t.match(/(\d{1,3}(?:\.\d+)?)\s?%/);
  if (pct) {
    const p = Number(pct[1]);
    return p > 0 && p < 100 ? { bps: Math.round(p * 100) } : {};
  }
  const usd = t.match(/\$\s?(\d{1,5}(?:\.\d{1,2})?)\b/);
  if (usd && Number(usd[1]) > 0) return { usd: Number(usd[1]) };
  return {};
}

export function sellReply(s: SellIntent, claim: string | null, closesTake: boolean): string {
  const what = s.bps ? `${s.bps / 100}% of your position` : s.usd ? `${dollars(s.usd)} of your position` : "your position";
  const on = claim ? ` in "${claim.length > 80 ? `${claim.slice(0, 77)}...` : claim}"` : "";
  return `Sold ${what}${on}.${closesTake ? " That closed your take to new backers." : ""} See it at ${BIO}.`;
}

export const SELL_WHICH = `Not sure which position. Reply "sell" under my reply to your trade, or under the take you hold.`;
export const NOT_HELD = "You don't hold that one.";
export const SELL_KEEP_10 = `At least $10 has to stay in. Reply "sell" on its own to sell all of it.`;

/**
 * A mention that only asks for the post's take (or a trade on it): "make this a take", "back $20",
 * "@yourthesisxyz" alone. Those can share one basket per post; anything with its own words can't.
 */
export function plainCommand(text: string): boolean {
  const t = text.toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(back|backing|in for|i'?m in(?: for)?|buy|fade|fading|bet against|against|short)\b[^$\d]{0,20}\$?\s?\d{1,4}(?:\.\d{1,2})?/g, " ")
    .replace(/[^a-z' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t === "" || /^(make (this|it) (a|into a) take|make a take|take|take this|this|basket|basket this|what'?s the trade|trade this|trade it|this one|on this)$/.test(t);
}

// Scores ("@yourthesisxyz score", "score @jake", "score me") -----------------------------------------

/** "score" / "score @jake" / "score me" / "what's my score" → whom to score (null: the default), else not a score ask. */
export function scoreIntent(text: string): { handle: string | null } | null {
  const m = text.trim().match(/^(?:what'?s\s+(?:my|the|their|his|her)\s+)?score(?:\s+(?:of|for))?(?:\s+@?([A-Za-z0-9_]{1,15}))?\s*[?.!]*$/i);
  if (!m) return null;
  const h = m[1]?.toLowerCase() ?? null;
  return { handle: h === "me" || h === "my" || h === "mine" ? "me" : h };
}

const signed = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const signedPct = (n: number) => `${n < 0 ? "-" : "+"}${Math.abs(n).toFixed(1)}%`;

export function scoreReply(xUsername: string, self: boolean, s: { found: false } | { found: true; made: number; return_pct: number; backers_made: number; backers_pct: number; takes: number }): string {
  const who = self ? "You" : `@${xUsername}`;
  if (!s.found) return self ? `You're not on Thesis yet. Sign in with X at ${BIO}.` : `@${xUsername} isn't on Thesis yet. Anyone can join at ${BIO}.`;
  return `${who} on Thesis: own P&L ${signed(s.made)} (${signedPct(s.return_pct)}), made for backers ${signed(s.backers_made)} (${signedPct(s.backers_pct)}), ${s.takes} ${s.takes === 1 ? "take" : "takes"}. Full profile at ${BIO}.`;
}

// Copy trading ("@yourthesisxyz copy" under someone's post, or "copy @handle") ---------------------

/** "copy" / "copy them" / "copytrade" / "copy @jake" → whom (null: the post's author), else not a copy ask. */
export function copyIntent(text: string): { handle: string | null } | null {
  const m = text.trim().match(/^(?:auto[- ]?)?copy(?:[- ]?trade)?(?:\s+(?:them|him|her|this|this account))?(?:\s+@?([A-Za-z0-9_]{1,15}))?\s*[.!]*$/i);
  if (!m) return null;
  return { handle: m[1]?.toLowerCase() ?? null };
}

export function copyReply(r: { copying: true; kind: "x" | "trader"; handle: string; thesis_handle?: string; usd: number; daily: number; already: boolean }): string {
  if (r.already) return `You already copy @${r.handle}. Change it in Copy trading at ${BIO}.`;
  const what = r.kind === "trader" ? "each new take they post on Thesis" : "each new call they post";
  return `Copying @${r.handle}: Thesis will put ${dollars(r.usd)} into ${what}, up to ${r.daily} a day. Change it in Copy trading at ${BIO}.`;
}

export const COPY_WHO = `Reply "copy" under a post from the account you want to copy, or "copy @handle".`;
export const COPY_LIMIT = `You copy 10 accounts already. Remove one in Copy trading at ${BIO}.`;
export const COPY_SELF = "You can't copy yourself.";
