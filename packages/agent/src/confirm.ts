// Trades by text wait for a yes: a trade tool sets the trade up and the bot asks
// "On it. Like this message or reply yes to confirm: back "gold to 5k" with $50." A like or love
// tapback on it, or "yes", from the same person in the same chat runs it, with no model call in
// between; "no" drops it. Pure enough to test: the agent API is passed in.
import { draftIdFrom, takeIdFrom, type AgentApi, type TradeAsk, type TradeResult, type Who } from "./trade.ts";

export const CONFIRM_TTL_MS = 10 * 60_000;

export type Pending = {
  who: Who;
  ask: TradeAsk;
  /** "back "gold to 5k" with $50": shown in the ask, and its result. */
  summary: string;
  claim: string | null;
  /** Keys the trade on the message that asked, so a repeated yes never trades twice. */
  ref: string | null;
  expiresAt: number;
};

export type Prepared =
  | { kind: "pending"; pending: Pending; output: Record<string, unknown> }
  | { kind: "done"; output: Record<string, unknown>; link?: string };

const amount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const quoted = (claim: string | null) => (claim ? `"${claim.length > 70 ? `${claim.slice(0, 67)}...` : claim}"` : "that take");

/** "yes" in its usual text forms (and a thumbs up), else null; "no" likewise. */
export function yesNo(text: string): "yes" | "no" | null {
  const t = text.trim().toLowerCase().replace(/[.!\s]+$/, "");
  if (/^(y|yes|yep|yeah|yup|ya|confirm|confirmed|do it|go|go for it|send it|ok|okay|sure|👍|✅|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿)$/u.test(t)) return "yes";
  if (/^(n|no|nope|nah|cancel|stop|don't|dont|never ?mind)$/.test(t)) return "no";
  return null;
}

/** The confirmation ask. */
export const askText = (p: Pending) => `On it. Like this message or reply yes to confirm: ${p.summary}.`;

/**
 * A trade tool's call → a trade waiting for a yes, or an answer now (not connected, over a limit,
 * unknown take, positions). `claims` are the claims this chat knows by draft or take id.
 */
export async function prepareTrade(
  api: AgentApi, who: Who, ref: string | null, name: string, args: Record<string, unknown>,
  claims: Map<string, string>, webUrl: string, now = Date.now(),
): Promise<Prepared> {
  const web = webUrl.replace(/\/$/, "");
  if (name === "my_positions") {
    const w = await api.whois(who);
    if (!w.linked || !w.active) return notLinked(api, who);
    const ps = await api.positions(who);
    return { kind: "done", output: { positions: ps.slice(0, 15).map((p) => ({ take_id: p.take_id, claim: p.claim, side: p.side, stake_usd: p.stake_usd, value_usd: p.value_usd, return_pct: p.return_bps == null ? null : p.return_bps / 100, closes_take_if_sold_all: p.closes_take_if_sold_all })) } };
  }

  let ask: TradeAsk;
  let claim: string | null = null;
  let summary: string;
  let confirmUrl: string | undefined;
  if (name === "post_take") {
    const draftId = draftIdFrom(String(args.draft_id ?? ""));
    const usd = amount(args.usd);
    if (!draftId) return { kind: "done", output: { error: "unknown_draft" } };
    if (!usd || usd < 10) return { kind: "done", output: { error: "minimum_is_10_usd" } };
    claim = claims.get(draftId) ?? null;
    ask = { action: "post", draftId, usd };
    summary = `post ${quoted(claim)} as your take with ${money(usd)}`;
    confirmUrl = `${web}/d/${draftId}`;
  } else if (name === "back_take" || name === "fade_take") {
    const takeId = takeIdFrom(String(args.take ?? ""));
    const usd = amount(args.usd);
    if (!takeId) return { kind: "done", output: { error: "unknown_take", hint: "Ask which take, or for its link." } };
    if (!usd || usd < 10) return { kind: "done", output: { error: "minimum_is_10_usd" } };
    const info = claims.has(takeId) ? { claim: claims.get(takeId)!, author: null } : await api.takeInfo(takeId).catch(() => null);
    if (info === null && !claims.has(takeId)) return { kind: "done", output: { error: "unknown_take", hint: "Ask for the take's link." } };
    claim = info?.claim ?? null;
    const whose = info?.author ? `@${info.author}'s take ` : "";
    ask = { action: name === "back_take" ? "back" : "fade", takeId, usd };
    summary = `${ask.action} ${whose}${quoted(claim)} with ${money(usd)}`;
    confirmUrl = `${web}/t/${takeId}`;
  } else if (name === "sell_position") {
    const takeId = takeIdFrom(String(args.take ?? ""));
    if (!takeId) return { kind: "done", output: { error: "unknown_take", hint: "Call my_positions to find it." } };
    const pct = amount(args.percent);
    const usd = amount(args.usd);
    const bps = pct && pct > 0 && pct < 100 ? Math.round(pct * 100) : undefined;
    const side = args.side === "fade" ? "fade" : "back";
    claim = claims.get(takeId) ?? (await api.takeInfo(takeId).catch(() => null))?.claim ?? null;
    ask = { action: "sell", takeId, side, ...(bps ? { bps } : !pct && usd ? { usd } : {}) };
    const what = bps ? `${bps / 100}%` : !pct && usd ? money(usd) : "all";
    summary = `sell ${what} of your ${side === "fade" ? "fade on " : ""}${quoted(claim)}`;
  } else {
    return { kind: "done", output: { error: `unknown tool ${name}` } };
  }

  // Connected, and within the limits? Checked now, so the ask is never one that can't go through.
  const w = await api.whois(who);
  if (!w.linked || !w.active) return notLinked(api, who);
  if (ask.action !== "sell") {
    if (ask.usd > w.per_trade_usd || ask.usd > w.left_usd) {
      const over = ask.usd > w.per_trade_usd ? "over_trade_limit" : "over_daily_limit";
      return { kind: "done", output: { error: over, per_trade_limit_usd: w.per_trade_usd, left_today_usd: w.left_usd }, link: confirmUrl };
    }
  }
  const pending: Pending = { who, ask, summary, claim, ref: ref ? `${ref}:${name}`.slice(0, 120) : null, expiresAt: now + CONFIRM_TTL_MS };
  return { kind: "pending", pending, output: { status: "awaiting_confirmation", summary } };
}

async function notLinked(api: AgentApi, who: Who): Promise<Prepared> {
  if (!("imessage" in who)) return { kind: "done", output: { error: "not_linked" } };
  const url = await api.connectLink(who.imessage);
  return { kind: "done", output: { error: "not_linked", connect_url: url }, link: url };
}

/** Runs a confirmed trade: the reply text. */
export async function runConfirmed(api: AgentApi, p: Pending): Promise<{ text: string; takeId?: string }> {
  let r: TradeResult;
  try {
    r = await api.trade(p.who, "imessage", p.ref, p.ask, { wait: false });
  } catch {
    return { text: "that didn't go through. try again in a minute." };
  }
  return resultText(p, r);
}

export function resultText(p: Pending, r: TradeResult): { text: string; takeId?: string } {
  if (!r.ok) {
    if (r.error === "not_linked") return { text: "you're not connected anymore. text me again and I'll send a link." };
    if (r.error === "over_trade_limit") return { text: `that's over your ${money(r.perTradeUsd ?? 0)} per-trade limit.${r.confirmUrl ? ` do it yourself here:\n${r.confirmUrl}` : ""}` };
    if (r.error === "over_daily_limit") return { text: `that's past your daily limit (${money(r.leftUsd ?? 0)} left today).${r.confirmUrl ? ` do it yourself here:\n${r.confirmUrl}` : ""}` };
    if (r.error === "draft_posted") return { text: "that basket's already been posted." };
    if (r.error === "take_closed") return { text: "that take is closed, its author sold." };
    return { text: `that didn't go through. try again in a minute.${r.confirmUrl ? ` or do it here:\n${r.confirmUrl}` : ""}` };
  }
  if (r.status === "failed") return { text: "that didn't go through. try again in a minute.", takeId: r.takeId };
  const a = p.ask;
  const c = quoted(p.claim);
  let head: string;
  if (a.action === "sell") head = `sold ${a.bps ? `${a.bps / 100}%` : a.usd ? money(a.usd) : "all"} of ${c}${r.closesTake ? ". that closed your take to new backers" : ""}`;
  else if (a.action === "post") head = `you're in: ${money(a.usd)} on ${c}. it's live as your take`;
  else if (a.action === "back") head = `you're in: ${money(a.usd)} on ${c}`;
  else head = `you're fading ${c} with ${money(a.usd)}`;
  return { text: `${head}\n${r.url}`, takeId: r.takeId };
}
