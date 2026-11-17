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

export function takeReply(claim: string, picks: Pick[], link: string): string | null {
  if (picks.some((p) => NEVER.test(p.name))) return null;
  const head = `${claim}.`;
  const tail = `Post it as your take: ${link}`;
  const room = MAX - xLength(head) - xLength(tail) - 4;
  const text = cleanReply(`${head}\n\n${pickLine(picks, room)}\n\n${tail}`);
  return xLength(text) <= MAX ? text : null;
}

export const NO_EXPOSURE = "No clean way to trade that one yet. Try a sharper take, like which companies win if you're right.";
export const EXPLAIN = "Thesis turns a take into a basket of real investments. Reply to any post with @yourthesisxyz and I'll build one you can post and trade.";
