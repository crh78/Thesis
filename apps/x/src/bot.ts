// One mention → what the bot posts (or nothing): vet it, build the basket as a draft take, and
// fill the reply template; or trade ("back $20", "fade $50") and sell ("sell", "sell half") from
// the asker's own account. No X calls here, so `pnpm try` runs the same path offline.
import { buildBasket, takeIdFrom, type AgentApi, type BasketConfig, type BuildTrace, type TradeResult } from "@thesis/agent";
import {
  EXPLAIN, NO_EXPOSURE, NOT_HELD, NOT_LINKED, overLimit, plainCommand, safeClaim, SELL_KEEP_10, SELL_WHICH, sellIntent, sellReply,
  TAKE_TAIL, takeReply, takeTradeReply, TRADE_FAILED, tradeIntent, tradeReply,
} from "./compose.ts";
import type { Mention, Verdict, Vet, VetTrace } from "./vet.ts";

/** X takes are always built at high risk: up to 30% in perps at up to 5x (the take builder's cap), the rest spot. */
export const X_RISK = "high" as const;

type Pick = { name: string; weight: number };
/** What one of the bot's replies carries: the draft it showed, or the take it traded. */
export type BotPost = { draftId?: string; takeId?: string; side?: "back" | "fade"; forX?: string; claim?: string; legs?: Pick[] };
/** A take an X user traded in a conversation, for "sell" anywhere in that thread. */
export type Held = { takeId: string; side: "back" | "fade"; claim?: string };
/** A basket built for a post, reused for everyone else replying under it (no second build). */
export type Shared = { draftId: string; claim: string; legs: Pick[]; at: number };

/** What the bot remembers across mentions (apps/x/src/state.ts keeps it). */
export type Memory = {
  botPost(id: string): BotPost | undefined;
  held(authorId: string, conversation: string): Held | undefined;
  shared(parentId: string, side: "back" | "fade"): Shared | undefined;
};

/** What to remember once the reply is out. */
export type Remember = {
  post?: BotPost;
  held?: Held;
  shared?: { parentId: string; side: "back" | "fade"; value: Omit<Shared, "at"> };
};

/** How the bot decided: the vetting model's verdict and reasoning summary, and the take builder's. For telemetry only. */
export type PlanTrace = {
  vet?: Omit<Verdict, "trace"> & Partial<VetTrace>;
  build?: { verdict: string; reason?: string; summary?: string; legs?: unknown; trace?: BuildTrace };
};

export type Plan = (
  | { kind: "skip"; reason: string }
  | {
    kind: "reply"; text: string; link?: string;
    /** The basket as a picture (the web app's /d/<id>/basket.png), attached to the reply. */
    image?: string;
    what: "take" | "no_exposure" | "explain" | "opt_out" | "opt_in" | "trade" | "trade_refused" | "trade_failed" | "not_linked" | "sell";
    trade?: { status: string; takeId?: string; error?: string };
    remember?: Remember;
  }
) & { trace?: PlanTrace };

export type MentionInput = Mention & {
  /** The mention's post id: the draft's origin_ref, so a retry reuses its draft. */
  id: string;
  /** The parent post's link, credited on the take as "via @user on X". */
  parentUrl: string | null;
  /** The parent post's id (what the mention replies to or quotes). */
  parentId?: string | null;
  /** The thread: "sell" anywhere in it finds the take the asker traded there. */
  conversationId?: string;
  /** The asker's X user id: whose Thesis account a trade uses. */
  authorId?: string;
  /** Expanded links in the mention and its parent: a shared Thesis take (/t/<id>) is traded as it is. */
  links?: string[];
};

/** What a refused or failed trade says. */
function refusal(r: Extract<TradeResult, { ok: false }>): Plan {
  if (r.error === "not_linked") return { kind: "reply", text: NOT_LINKED, what: "not_linked", trade: { status: "refused", error: r.error } };
  if (r.error === "over_trade_limit" || r.error === "over_daily_limit") {
    return { kind: "reply", text: overLimit(r.error === "over_trade_limit" ? "trade" : "daily", r.perTradeUsd, r.leftUsd), what: "trade_refused", trade: { status: "refused", error: r.error } };
  }
  if (r.error === "position_missing" || r.error === "already_exited") return { kind: "reply", text: NOT_HELD, what: "trade_refused", trade: { status: "refused", error: r.error } };
  if (r.error === "remainder_below_minimum") return { kind: "reply", text: SELL_KEEP_10, what: "trade_refused", trade: { status: "refused", error: r.error } };
  return { kind: "reply", text: TRADE_FAILED, what: "trade_failed", trade: { status: "failed", error: r.error } };
}

const failed = (r: { status: string; takeId?: string; error?: string }): Plan =>
  ({ kind: "reply", text: TRADE_FAILED, what: "trade_failed", trade: { status: r.status, takeId: r.takeId, error: r.error } });

type Deps = { vet: Vet; basket: BasketConfig; trading?: AgentApi; memory?: Memory };

/** What the bot posts for a mention, with how it decided (`trace`) when a model was involved. */
export async function plan(m: MentionInput, deps: Deps): Promise<Plan> {
  const trace: PlanTrace = {};
  const out = await decide(m, deps, trace);
  return trace.vet || trace.build ? { ...out, trace } : out;
}

async function decide(m: MentionInput, deps: Deps, trace: PlanTrace): Promise<Plan> {
  const trading = deps.trading && m.authorId ? deps.trading : undefined;
  const mem = deps.memory;
  const who = { x: m.authorId ?? "" };
  const me = m.author.username.toLowerCase();
  const web = deps.basket.webUrl.replace(/\/$/, "");
  const imageOf = (draftId: string) => `${web}/d/${draftId}/basket.png`;
  const linkTake = (m.links ?? []).map((u) => (/\/t\//.test(u) ? takeIdFrom(u) : null)).find(Boolean) ?? null;
  // A reply to one of the bot's own posts: what that post carried.
  const parentPost = m.toBot && m.parentId ? mem?.botPost(m.parentId) : undefined;

  // "sell", "sell half", "sell 25%", "sell $20": the take under this reply, or the one traded in this thread.
  const sell = trading ? sellIntent(m.text) : null;
  if (sell) {
    const held = m.authorId && m.conversationId ? mem?.held(m.authorId, m.conversationId) : undefined;
    const target = linkTake ? { takeId: linkTake, side: "back" as const, claim: undefined }
      : parentPost?.takeId ? { takeId: parentPost.takeId, side: parentPost.side ?? "back", claim: parentPost.claim }
      : held ?? null;
    if (!target) return { kind: "reply", text: SELL_WHICH, what: "trade_refused" };
    const r = await trading!.trade(who, "x", m.id, { action: "sell", takeId: target.takeId, side: target.side, ...(sell.bps ? { bps: sell.bps } : sell.usd ? { usd: sell.usd } : {}) });
    if (!r.ok) return refusal(r);
    if (r.status === "failed") return failed(r);
    return { kind: "reply", text: sellReply(sell, target.claim ?? null, r.closesTake), what: "sell", link: r.url, trade: { status: r.status, takeId: r.takeId } };
  }

  // "back $20" / "fade $50": trade from the asker's own account, within the limits they set.
  const intent = trading ? tradeIntent(m.text) : null;

  // A take that already exists: a shared Thesis take, or one the bot's reply above traded.
  const takeId = intent ? linkTake ?? parentPost?.takeId ?? null : null;
  if (intent && takeId) {
    const r = await trading!.trade(who, "x", m.id, { action: intent.side, takeId, usd: intent.usd });
    if (!r.ok) return refusal(r);
    if (r.status === "failed") return failed(r);
    return {
      kind: "reply", text: takeTradeReply(intent.side, intent.usd), what: "trade", link: r.url, trade: { status: r.status, takeId: r.takeId },
      remember: { post: { takeId: r.takeId, side: intent.side, claim: parentPost?.claim }, held: { takeId: r.takeId, side: intent.side, claim: parentPost?.claim } },
    };
  }

  // "back $20" under the bot's own draft reply, by the person it was made for: buy that exact basket.
  if (intent?.side === "back" && parentPost?.draftId && parentPost.forX === me && parentPost.claim && parentPost.legs) {
    const r = await trading!.trade(who, "x", m.id, { action: "post", draftId: parentPost.draftId, usd: intent.usd });
    if (!r.ok) return refusal(r);
    if (r.status === "failed") return failed(r);
    const text = tradeReply(parentPost.claim, parentPost.legs, intent.usd);
    if (!text) return { kind: "skip", reason: "reply failed the checks" };
    return {
      kind: "reply", text, what: "trade", link: r.url, image: imageOf(parentPost.draftId), trade: { status: r.status, takeId: r.takeId },
      remember: { post: { takeId: r.takeId, side: "back", claim: parentPost.claim }, held: { takeId: r.takeId, side: "back", claim: parentPost.claim } },
    };
  }

  const side = intent?.side ?? "back";
  const context = (fromParent: boolean) => fromParent && m.parent && m.parent.username.toLowerCase() !== me
    ? `@${m.author.username} asked about @${m.parent.username}'s post`.slice(0, 80)
    : `@${m.author.username} on X`.slice(0, 80);
  const source = m.parent && m.parentUrl ? { text: m.parent.text, url: m.parentUrl, label: `@${m.parent.username} on X`.slice(0, 60) } : null;

  // Someone else already got a basket for this post (and side): reuse it, no vetting or building.
  const share = m.parentId && source && plainCommand(m.text) ? mem?.shared(m.parentId, side) : undefined;
  let claim: string;
  let fromParent: boolean;
  if (share) {
    claim = share.claim;
    fromParent = true;
  } else {
    const v = await deps.vet({ ...m, fade: side === "fade" });
    { const { trace: t, ...verdict } = v; trace.vet = { ...verdict, ...t }; }
    if (v.action === "ignore") return { kind: "skip", reason: `vetted out: ${v.reason}` };
    if (v.action === "explain") return { kind: "reply", text: EXPLAIN, what: "explain" };
    const c = safeClaim(v.claim);
    if (!c) return { kind: "skip", reason: "claim failed the checks" };
    claim = c;
    fromParent = !!(v.fromParent && source);
  }

  const out = await buildBasket(deps.basket, { claim, risk: X_RISK }, {
    origin: "x",
    originRef: m.id,
    forX: m.author.username,
    context: context(fromParent),
    ...(fromParent && source ? { source } : {}),
    ...(share ? { copyOf: share.draftId } : {}),
  });
  trace.build = out.verdict === "basket"
    ? { verdict: out.verdict, summary: out.summary, legs: out.legs, trace: out.trace }
    : { verdict: out.verdict, reason: out.reason, ...(out.verdict === "no_clean_exposure" ? { trace: out.trace } : {}) };
  if (out.verdict === "error") return { kind: "skip", reason: `build failed: ${out.reason}` };
  if (out.verdict === "no_clean_exposure") return { kind: "reply", text: NO_EXPOSURE, what: "no_exposure" };
  const image = imageOf(out.draftId);
  const picks = out.legs.map((l) => ({ name: l.name, weight: l.weight }));
  const shared: Remember["shared"] = !share && fromParent && m.parentId ? { parentId: m.parentId, side, value: { draftId: out.draftId, claim, legs: picks } } : undefined;

  if (intent) {
    // The basket is the asker's take: posted with their buy-in (a fade's claim is the opposite view).
    const r = await trading!.trade(who, "x", m.id, { action: "post", draftId: out.draftId, usd: intent.usd });
    if (!r.ok) {
      const p = refusal(r);
      // Not connected yet: the draft still waits for them in the app.
      if (p.kind === "reply" && p.what === "not_linked") {
        const draft = takeReply(claim, out.legs);
        return draft ? { ...p, text: draft.replace(TAKE_TAIL, NOT_LINKED), image, remember: { post: { draftId: out.draftId, forX: me, claim, legs: picks }, shared } } : p;
      }
      return p;
    }
    if (r.status === "failed") return failed(r);
    const text = tradeReply(claim, out.legs, intent.usd);
    if (!text) return { kind: "skip", reason: "reply failed the checks" };
    return {
      kind: "reply", text, what: "trade", link: r.url, image, trade: { status: r.status, takeId: r.takeId },
      remember: { post: { takeId: r.takeId, side: "back", claim }, held: { takeId: r.takeId, side: "back", claim }, shared },
    };
  }

  const text = takeReply(claim, out.legs);
  if (!text) return { kind: "skip", reason: "reply failed the checks" };
  return { kind: "reply", text, what: "take", link: out.link, image, remember: { post: { draftId: out.draftId, forX: me, claim, legs: picks }, shared } };
}
