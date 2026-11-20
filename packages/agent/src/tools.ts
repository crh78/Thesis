// The chat agent's trade tools: post a basket as the sender's take with a buy-in, back, fade, sell
// and list positions, all from the sender's own Thesis account through the `agent` function
// (./trade.ts). Pure enough to test: the API is passed in.
import { draftIdFrom, takeIdFrom, type AgentApi, type TradeResult, type Who } from "./trade.ts";

const money = { type: "number", description: "Dollars, at least 10." } as const;
const takeRef = { type: "string", description: "The take: its id from [Recent in this chat], or a take link." } as const;

export const tradeTools = [
  {
    type: "function" as const, name: "post_take", strict: true,
    description: "Post a basket you built (build_basket) as the sender's own take, buying in with their money. Use when they ask to make a take and put money in, or say they're in on a basket that isn't posted yet.",
    parameters: { type: "object", additionalProperties: false, required: ["draft_id", "usd"], properties: { draft_id: { type: "string", description: "The draft_id build_basket returned, or the draft's id from [Recent in this chat]." }, usd: money } },
  },
  {
    type: "function" as const, name: "back_take", strict: true,
    description: "Back a posted take with the sender's money (\"I'm in for $50 on Jake's take\").",
    parameters: { type: "object", additionalProperties: false, required: ["take", "usd"], properties: { take: takeRef, usd: money } },
  },
  {
    type: "function" as const, name: "fade_take", strict: true,
    description: "Fade (bet against) a posted take with the sender's money (\"fading Jake for $25\"). Not their own take.",
    parameters: { type: "object", additionalProperties: false, required: ["take", "usd"], properties: { take: takeRef, usd: money } },
  },
  {
    type: "function" as const, name: "sell_position", strict: true,
    description: "Sell the sender's position in a take: all of it, a percent, or a dollar amount. At least $10 must stay in after a partial sale.",
    parameters: {
      type: "object", additionalProperties: false, required: ["take", "side", "percent", "usd"],
      properties: {
        take: takeRef,
        side: { type: "string", enum: ["back", "fade"], description: "Which position: back unless they faded it." },
        percent: { type: ["number", "null"], description: "1-100, or null." },
        usd: { type: ["number", "null"], description: "Dollars to sell, or null. Both null sells all of it." },
      },
    },
  },
  {
    type: "function" as const, name: "my_positions", strict: true,
    description: "The sender's open positions: take ids, claims, stake, value and return.",
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
];

export const TRADE_TOOL_NAMES = new Set(tradeTools.map((t) => t.name));

/** What a trade tool hands back to the model, and the links the reply must carry. */
export type ToolOut = { output: Record<string, unknown>; link?: string; take?: { id: string; claim?: string } };

const amount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

function fromTrade(r: TradeResult, what: string): ToolOut {
  if (r.ok) {
    return {
      output: { status: r.status, what, usd: r.usd, take_id: r.takeId, ...(r.closesTake ? { closed_take: true } : {}), ...(r.error ? { error: r.error } : {}), ...(r.existing ? { already_done: true } : {}) },
      link: r.url,
      take: { id: r.takeId },
    };
  }
  return {
    output: { error: r.error, ...(r.message ? { message: r.message } : {}), ...(r.perTradeUsd != null ? { per_trade_limit_usd: r.perTradeUsd, left_today_usd: r.leftUsd } : {}) },
    link: r.confirmUrl,
  };
}

/**
 * Runs one trade tool for the sender. `ref` keys the trade on the inbound message, so a redelivered
 * message is the same trade. An unlinked sender gets a one-time connect link instead.
 */
export async function runTradeTool(api: AgentApi, who: Who, ref: string | null, name: string, args: Record<string, unknown>): Promise<ToolOut> {
  if (name === "my_positions") {
    try {
      const ps = await api.positions(who);
      return { output: { positions: ps.slice(0, 15).map((p) => ({ take_id: p.take_id, claim: p.claim, side: p.side, stake_usd: p.stake_usd, value_usd: p.value_usd, return_pct: p.return_bps == null ? null : p.return_bps / 100, closes_take_if_sold_all: p.closes_take_if_sold_all, ...(p.inverted ? { inverted: true } : {}) })) } };
    } catch (e) {
      if (String((e as Error).message).includes("not_linked")) return notLinked(api, who);
      throw e;
    }
  }

  let r: TradeResult;
  const key = (k: string) => (ref ? `${ref}:${name}:${k}`.slice(0, 120) : null);
  if (name === "post_take") {
    const draftId = draftIdFrom(String(args.draft_id ?? ""));
    const usd = amount(args.usd);
    if (!draftId) return { output: { error: "unknown_draft" } };
    if (!usd || usd < 10) return { output: { error: "minimum_is_10_usd" } };
    r = await api.trade(who, "imessage", key(draftId), { action: "post", draftId, usd });
  } else if (name === "back_take" || name === "fade_take") {
    const takeId = takeIdFrom(String(args.take ?? ""));
    const usd = amount(args.usd);
    if (!takeId) return { output: { error: "unknown_take", hint: "Ask which take, or for its link." } };
    if (!usd || usd < 10) return { output: { error: "minimum_is_10_usd" } };
    r = await api.trade(who, "imessage", key(takeId), { action: name === "back_take" ? "back" : "fade", takeId, usd });
  } else if (name === "sell_position") {
    const takeId = takeIdFrom(String(args.take ?? ""));
    if (!takeId) return { output: { error: "unknown_take", hint: "Call my_positions to find it." } };
    const pct = amount(args.percent);
    const usd = amount(args.usd);
    const bps = pct && pct > 0 && pct < 100 ? Math.round(pct * 100) : undefined;
    r = await api.trade(who, "imessage", key(takeId), { action: "sell", takeId, side: args.side === "fade" ? "fade" : "back", ...(bps ? { bps } : !pct && usd ? { usd } : {}) });
  } else {
    return { output: { error: `unknown tool ${name}` } };
  }
  if (!r.ok && r.error === "not_linked") return notLinked(api, who);
  return fromTrade(r, name);
}

async function notLinked(api: AgentApi, who: Who): Promise<ToolOut> {
  if (!("imessage" in who)) return { output: { error: "not_linked" } };
  const url = await api.connectLink(who.imessage);
  return { output: { error: "not_linked", connect_url: url, note: "One-time link: they sign in, set limits, and then trades by text just work." }, link: url };
}
