// One mention → what the bot posts (or nothing): vet it, build the basket as a draft take, and
// fill the reply template. No X calls here, so `pnpm try` runs the same path offline.
import { buildBasket, takeIdFrom, type AgentApi, type BasketConfig, type TradeResult } from "@thesis/agent";
import {
  EXPLAIN, NO_EXPOSURE, NOT_LINKED, overLimit, safeClaim, TAKE_TAIL, takeReply, takeTradeReply, TRADE_FAILED, tradeIntent, tradeReply,
} from "./compose.ts";
import type { Mention, Vet } from "./vet.ts";

export type Plan =
  | { kind: "skip"; reason: string }
  | {
    kind: "reply"; text: string; link?: string;
    /** The basket as a picture (the web app's /d/<id>/basket.png), attached to the reply. */
    image?: string;
    what: "take" | "no_exposure" | "explain" | "opt_out" | "opt_in" | "trade" | "trade_refused" | "trade_failed" | "not_linked";
    trade?: { status: string; takeId?: string; error?: string };
  };

export type MentionInput = Mention & {
  /** The mention's post id: the draft's origin_ref, so a retry reuses its draft. */
  id: string;
  /** The parent post's link, credited on the take as "via @user on X". */
  parentUrl: string | null;
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
  return { kind: "reply", text: TRADE_FAILED, what: "trade_failed", trade: { status: "failed", error: r.error } };
}

export async function plan(m: MentionInput, deps: { vet: Vet; basket: BasketConfig; trading?: AgentApi }): Promise<Plan> {
  // "back $20" / "fade $50": trade from the asker's own account, within the limits they set.
  const intent = deps.trading && m.authorId ? tradeIntent(m.text) : null;
  const who = { x: m.authorId ?? "" };

  // Under a shared Thesis take: back or fade that take itself.
  const takeId = intent ? (m.links ?? []).map((u) => (/\/t\//.test(u) ? takeIdFrom(u) : null)).find(Boolean) ?? null : null;
  if (intent && takeId) {
    const r = await deps.trading!.trade(who, "x", m.id, { action: intent.side, takeId, usd: intent.usd });
    if (!r.ok) return refusal(r);
    if (r.status === "failed") return { kind: "reply", text: TRADE_FAILED, what: "trade_failed", trade: { status: r.status, takeId: r.takeId, error: r.error } };
    return { kind: "reply", text: takeTradeReply(intent.side, intent.usd), what: "trade", link: r.url, trade: { status: r.status, takeId: r.takeId } };
  }

  const v = await deps.vet({ ...m, fade: intent?.side === "fade" });
  if (v.action === "ignore") return { kind: "skip", reason: `vetted out: ${v.reason}` };
  if (v.action === "explain") return { kind: "reply", text: EXPLAIN, what: "explain" };

  const claim = safeClaim(v.claim);
  if (!claim) return { kind: "skip", reason: "claim failed the checks" };

  const fromParent = v.fromParent && m.parent && m.parentUrl;
  const out = await buildBasket(deps.basket, { claim, risk: v.risk }, {
    origin: "x",
    originRef: m.id,
    forX: m.author.username,
    context: fromParent && m.parent!.username.toLowerCase() !== m.author.username.toLowerCase()
      ? `@${m.author.username} asked about @${m.parent!.username}'s post`.slice(0, 80)
      : `@${m.author.username} on X`.slice(0, 80),
    ...(fromParent ? { source: { text: m.parent!.text, url: m.parentUrl!, label: `@${m.parent!.username} on X`.slice(0, 60) } } : {}),
  });
  if (out.verdict === "error") return { kind: "skip", reason: `build failed: ${out.reason}` };
  const image = out.verdict === "basket" ? `${deps.basket.webUrl.replace(/\/$/, "")}/d/${out.draftId}/basket.png` : undefined;
  if (out.verdict === "no_clean_exposure") return { kind: "reply", text: NO_EXPOSURE, what: "no_exposure" };

  if (intent) {
    // The basket is the asker's take: posted with their buy-in (a fade's claim is the opposite view).
    const r = await deps.trading!.trade(who, "x", m.id, { action: "post", draftId: out.draftId, usd: intent.usd });
    if (!r.ok) {
      const p = refusal(r);
      // Not connected yet: the draft still waits for them in the app.
      if (p.kind === "reply" && p.what === "not_linked") {
        const draft = takeReply(claim, out.legs);
        return draft ? { ...p, text: draft.replace(TAKE_TAIL, NOT_LINKED), image } : p;
      }
      return p;
    }
    if (r.status === "failed") return { kind: "reply", text: TRADE_FAILED, what: "trade_failed", trade: { status: r.status, takeId: r.takeId, error: r.error } };
    const text = tradeReply(claim, out.legs, intent.usd);
    if (!text) return { kind: "skip", reason: "reply failed the checks" };
    return { kind: "reply", text, what: "trade", link: r.url, image, trade: { status: r.status, takeId: r.takeId } };
  }

  const text = takeReply(claim, out.legs);
  if (!text) return { kind: "skip", reason: "reply failed the checks" };
  return { kind: "reply", text, what: "take", link: out.link, image };
}
