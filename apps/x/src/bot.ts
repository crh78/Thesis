// One mention → what the bot posts (or nothing): vet it, build the basket as a draft take, and
// fill the reply template. No X calls here, so `pnpm try` runs the same path offline.
import { buildBasket, type BasketConfig } from "@thesis/agent";
import { EXPLAIN, NO_EXPOSURE, safeClaim, takeReply } from "./compose.ts";
import type { Mention, Vet } from "./vet.ts";

export type Plan =
  | { kind: "skip"; reason: string }
  | { kind: "reply"; text: string; what: "take" | "no_exposure" | "explain" | "opt_out" | "opt_in"; link?: string };

export type MentionInput = Mention & {
  /** The mention's post id: the draft's origin_ref, so a retry reuses its draft. */
  id: string;
  /** The parent post's link, credited on the take as "via @user on X". */
  parentUrl: string | null;
};

export async function plan(m: MentionInput, deps: { vet: Vet; basket: BasketConfig }): Promise<Plan> {
  const v = await deps.vet(m);
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
  if (out.verdict === "no_clean_exposure") return { kind: "reply", text: NO_EXPOSURE, what: "no_exposure" };

  const text = takeReply(claim, out.legs);
  if (!text) return { kind: "skip", reason: "reply failed the checks" };
  return { kind: "reply", text, what: "take", link: out.link };
}
