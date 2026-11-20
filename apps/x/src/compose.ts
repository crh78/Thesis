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

/** "Cameco 40%, Vistra 35%, Uranium ETF 25%", as many as fit, then "+2 more". */
function pickLine(picks: Pick[], room: number): string {
  const parts = picks.map((p) => `${p.name.replace(/[@#]/g, "").slice(0, 28)} ${Math.round(p.weight)}%`);
  for (let n = Math.min(parts.length, 4); n >= 1; n--) {
    const more = parts.length - n;
    const line = parts.slice(0, n).join(", ") + (more ? `, +${more} more` : "");
    if (line.length <= room) return line;
  }
  return `${parts.length} picks`;
}

/**
 * No link: a reply with a URL costs $0.20 on X, without one $0.015. The draft is saved for the
 * asker, and the web app (link in the bot's bio) shows it once they sign in with that X account.
 */
export const TAKE_TAIL = "Saved for you: sign in with X at the link in our bio to post it as your take.";

export function takeReply(claim: string, picks: Pick[]): string | null {
  if (picks.some((p) => NEVER.test(p.name))) return null;
  const head = `${claim}.`;
  const tail = TAKE_TAIL;
  const room = MAX - xLength(head) - xLength(tail) - 4;
  const text = cleanReply(`${head}\n\n${pickLine(picks, room)}\n\n${tail}`);
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

/** A trade went through: it's the replier's take now (posted with their buy-in). */
export function tradeReply(claim: string, picks: { name: string; weight: number }[], usd: number): string | null {
  if (picks.some((p) => NEVER.test(p.name))) return null;
  const head = `You're in: ${dollars(usd)} on "${claim}".`;
  const tail = `It's your take on Thesis now. See it at ${BIO}.`;
  const room = MAX - xLength(head) - xLength(tail) - 4;
  const text = cleanReply(`${head}\n\n${pickLine(picks, room)}\n\n${tail}`);
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
