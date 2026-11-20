// One mention → what the bot posts (or nothing): vet it, build the basket as a draft take, and
// fill the reply template; or trade ("back $20", "fade $50") and sell ("sell", "sell half") from
// the asker's own account. No X calls here, so `pnpm try` runs the same path offline.
import { buildBasket, takeIdFrom, type AgentApi, type BasketConfig, type TradeResult } from "@thesis/agent";
import {
  COPY_LIMIT, COPY_SELF, COPY_WHO, copyIntent, copyReply, EXPLAIN, NO_EXPOSURE, NOT_HELD, NOT_LINKED, overLimit, plainCommand, safeClaim, scoreIntent, scoreReply, SELL_KEEP_10, SELL_WHICH, sellIntent, sellReply,
  TAKE_TAIL, takeReply, takeTradeReply, TRADE_FAILED, tradeIntent, tradeReply,
} from "./compose.ts";
import type { Mention, Vet } from "./vet.ts";

/** X takes are always built at high risk: up to 30% in perps at up to 5x (the take builder's cap), the rest spot. */
export const X_RISK = "high" as const;

type Pick = { name: string; weight: number };
/**
 * What one of the bot's replies carries: the draft it showed, or the take it traded. `side` is the
 * take's (back = agree), never the legs': on a take that bets against its picks (`inverted`) the
 * fork API holds a back short. Only the reply's wording changes.
 */
export type BotPost = { draftId?: string; takeId?: string; side?: "back" | "fade"; forX?: string; claim?: string; legs?: Pick[]; inverted?: boolean };
/** A take an X user traded in a conversation, for "sell" anywhere in that thread. */
export type Held = { takeId: string; side: "back" | "fade"; claim?: string };
/** A basket built for a post, reused for everyone else replying under it (no second build). */
export type Shared = { draftId: string; claim: string; legs: Pick[]; at: number; inverted?: boolean };

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

export type Plan =
  | { kind: "skip"; reason: string }
  | {
    kind: "reply"; text: string; link?: string;
    /** The basket as a picture (the web app's /d/<id>/basket.png), attached to the reply. */
    image?: string;
    what: "take" | "no_exposure" | "no_view" | "explain" | "opt_out" | "opt_in" | "trade" | "trade_refused" | "trade_failed" | "not_linked" | "sell" | "score" | "copy";
    trade?: { status: string; takeId?: string; error?: string };
    remember?: Remember;
  };

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

export async function plan(m: MentionInput, deps: { vet: Vet; basket: BasketConfig; trading?: AgentApi; memory?: Memory; lookup?: AgentApi }): Promise<Plan> {
  const trading = deps.trading && m.authorId ? deps.trading : undefined;
  const mem = deps.memory;
  const who = { x: m.authorId ?? "" };
  const me = m.author.username.toLowerCase();
  const web = deps.basket.webUrl.replace(/\/$/, "");
  const imageOf = (draftId: string) => `${web}/d/${draftId}/basket.png`;
  const linkTake = (m.links ?? []).map((u) => (/\/t\//.test(u) ? takeIdFrom(u) : null)).find(Boolean) ?? null;
  // A reply to one of the bot's own posts: what that post carried.
  const parentPost = m.toBot && m.parentId ? mem?.botPost(m.parentId) : undefined;

  // "score": the Thesis record of the post's author (under someone's post), "score @jake", or "score me".
  const sc = deps.lookup ? scoreIntent(m.text) : null;
  if (sc) {
    const parentAuthor = m.parent && !m.toBot ? m.parent.username.toLowerCase() : null;
    const target = sc.handle === "me" ? me : sc.handle ?? parentAuthor ?? me;
    const s = await deps.lookup!.score(target);
    return { kind: "reply", text: scoreReply(target, target === me, s), what: "score", ...(s.found ? { image: `${web}/u/${encodeURIComponent(s.handle)}/score.png` } : {}) };
  }

  // "copy" under someone's post (that author), or "copy @handle": auto-copy them for the asker.
  const cp = trading ? copyIntent(m.text) : null;
  if (cp) {
    const parentAuthor = m.parent && !m.toBot ? m.parent.username : null;
    const target = cp.handle ?? parentAuthor?.toLowerCase() ?? null;
    if (!target) return { kind: "reply", text: COPY_WHO, what: "copy" };
    if (target === me) return { kind: "reply", text: COPY_SELF, what: "copy" };
    const r = await trading!.copy(who, target, cp.handle ? undefined : parentAuthor ?? undefined);
    if (!r.copying) {
      const text = r.error === "not_linked" ? NOT_LINKED : r.error === "copy_limit" ? COPY_LIMIT : r.error === "cant_copy_self" ? COPY_SELF : TRADE_FAILED;
      return { kind: "reply", text, what: r.error === "not_linked" ? "not_linked" : "copy" };
    }
    return { kind: "reply", text: copyReply(r), what: "copy" };
  }

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
    const text = tradeReply(parentPost.claim, parentPost.legs, intent.usd, !!parentPost.inverted);
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
    if (v.action === "ignore") return { kind: "skip", reason: `vetted out: ${v.reason}` };
    if (v.action === "explain") return { kind: "reply", text: EXPLAIN, what: "explain" };
    if (v.action === "no_view") return { kind: "reply", text: NO_EXPOSURE, what: "no_view" };
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
  if (out.verdict === "error") return { kind: "skip", reason: `build failed: ${out.reason}` };
  if (out.verdict === "no_clean_exposure") return { kind: "reply", text: NO_EXPOSURE, what: "no_exposure" };
  const image = imageOf(out.draftId);
  const picks = out.legs.map((l) => ({ name: l.name, weight: l.weight }));
  // A bearish claim ("crypto is done", or a fade's opposite view) can come back as a basket that bets
  // against its picks: still the asker's take, so a buy-in is a back; the replies say "Betting against".
  // A copied basket (`share`) keeps the first one's direction if the drafts route didn't say.
  const inverted = out.inverted || !!share?.inverted;
  const shared: Remember["shared"] = !share && fromParent && m.parentId ? { parentId: m.parentId, side, value: { draftId: out.draftId, claim, legs: picks, ...(inverted ? { inverted } : {}) } } : undefined;

  if (intent) {
    // The basket is the asker's take: posted with their buy-in (a fade's claim is the opposite view).
    const r = await trading!.trade(who, "x", m.id, { action: "post", draftId: out.draftId, usd: intent.usd });
    if (!r.ok) {
      const p = refusal(r);
      // Not connected yet: the draft still waits for them in the app.
      if (p.kind === "reply" && p.what === "not_linked") {
        const draft = takeReply(claim, out.legs, inverted);
        return draft ? { ...p, text: draft.replace(TAKE_TAIL, NOT_LINKED), image, remember: { post: { draftId: out.draftId, forX: me, claim, legs: picks, ...(inverted ? { inverted } : {}) }, shared } } : p;
      }
      return p;
    }
    if (r.status === "failed") return failed(r);
    const text = tradeReply(claim, out.legs, intent.usd, inverted);
    if (!text) return { kind: "skip", reason: "reply failed the checks" };
    return {
      kind: "reply", text, what: "trade", link: r.url, image, trade: { status: r.status, takeId: r.takeId },
      remember: { post: { takeId: r.takeId, side: "back", claim, ...(inverted ? { inverted } : {}) }, held: { takeId: r.takeId, side: "back", claim }, shared },
    };
  }

  const text = takeReply(claim, out.legs, inverted);
  if (!text) return { kind: "skip", reason: "reply failed the checks" };
  return { kind: "reply", text, what: "take", link: out.link, image, remember: { post: { draftId: out.draftId, forX: me, claim, legs: picks, ...(inverted ? { inverted } : {}) }, shared } };
}
