// build_basket tool: the `source` function's POST /drafts runs the take builder (the catalog in a
// cached prompt, BM25 search over prediction markets, one Luna pick) and saves the basket as a
// draft take; this returns the draft's web page. A bot can't post a take as
// someone, so whoever taps the link posts it as theirs (decided 2026-11-16; apps/www/app/d).

export const RISKS = ["low", "medium", "high"] as const;
type Risk = (typeof RISKS)[number];

export type BasketConfig = {
  /** https://<ref>.supabase.co/functions/v1/take-builder: only warmed up from here. */
  takeBuilderUrl: string;
  /** https://<ref>.supabase.co/functions/v1/source/drafts: builds the basket and saves the draft. */
  draftsUrl: string;
  /** The Vault's bot_secret: the bots' key to save drafts. */
  botSecret: string;
  /** The web app, where a draft's page lives: https://yourthesis.xyz */
  webUrl: string;
};

// No horizon: a take runs until its author sells, a year at most (CLAUDE.md "No-timeline takes").
export type BasketArgs = { claim: string; risk: Risk };

/** Where a draft came from, for its page and link preview. */
export type DraftMeta = {
  origin: "imessage" | "x";
  /** "From a group chat", "@jake asked on X" (80 chars max). */
  context?: string;
  /** The message or post it answers, so a retry reuses the draft. */
  originRef?: string;
  /** What the take copies: an X post's text, shown on the take as "via …". */
  source?: { text: string; url: string; label: string };
  /** The X bot's asker: the draft waits for them in the web app once they sign in with this X account. */
  forX?: string;
  /** Another draft whose basket this one reuses (no second build): several people under one post. */
  copyOf?: string;
};

type Leg = { id: string; name: string; kind: string; weight: number; side?: string | null; why: string };
type BuilderReply = {
  verdict: "basket" | "no_clean_exposure";
  summary: string;
  reason: string | null;
  legs: Leg[];
  /** The take bets against these picks ("crypto sucks" over BTC/ETH/SOL): agreeing is short every one. */
  inverted?: boolean;
};

/**
 * A built basket as the bots show it. `inverted`: the take bets against its picks, so each leg's
 * `side` is what agreeing holds: "short", or a prediction's other outcome.
 */
export type BasketResult =
  | { verdict: "basket"; summary: string; legs: { name: string; weight: number; side: string; why: string }[]; link: string; draftId: string; inverted: boolean }
  | { verdict: "no_clean_exposure"; reason: string }
  | { verdict: "error"; reason: string };

export const basketTool = {
  type: "function" as const,
  name: "build_basket",
  description:
    "Turn a take (a plain-language market opinion) into a Thesis basket: 1-5 real investments that pay off if the take is right, " +
    "plus a link where anyone can post it as their take and buy in. Use whenever someone states or asks about a take.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["claim", "risk"],
    properties: {
      claim: { type: "string", description: "The take as one short sentence in the person's words, 5-140 chars." },
      risk: { type: "string", enum: [...RISKS], description: "Default medium unless they said otherwise." },
    },
  },
};

/** Plain names for a non-investor: drop the venue suffixes the catalog carries. */
export const plainName = (name: string) =>
  name.replace(/\s+-\s+Backpack Securities$/, "").replace(/,?\s+(Inc\.|Corporation|Corp\.)(\s+Common Stock)?$/, "").replace(/\s+(xStock|Common Stock)$/, "").trim();

export async function buildBasket(cfg: BasketConfig, args: BasketArgs, meta: DraftMeta): Promise<BasketResult> {
  const claim = args.claim.trim().replace(/\s+/g, " ").slice(0, 140);
  if (claim.length < 5) return { verdict: "error", reason: "Take is too short." };
  // The drafts route runs the take builder and saves what it built, in one call.
  const res = await fetch(cfg.draftsUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bot-secret": cfg.botSecret },
    body: JSON.stringify({
      claim, risk: args.risk,
      origin: meta.origin, context: meta.context, origin_ref: meta.originRef, for_x: meta.forX, copy_of: meta.copyOf,
      ...(meta.source ? { source: { text: meta.source.text.slice(0, 2000), url: meta.source.url, label: meta.source.label, kind: "x" } } : {}),
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) return { verdict: "error", reason: `drafts ${res.status}` };
  const out = (await res.json()) as BuilderReply & { id?: string };
  if (out.verdict !== "basket" || !out.legs?.length || !out.id) {
    return { verdict: "no_clean_exposure", reason: out.reason || "Nothing you can buy tracks this closely enough yet." };
  }
  const id = out.id;
  const inverted = out.inverted === true;

  return {
    verdict: "basket",
    summary: out.summary,
    // A cash pick's catalog name ("jupiter lend USDC (Jupiter Lend Earn)") reads as "Cash" in a reply.
    legs: out.legs.map((l) => ({ name: l.kind === "yield" ? "Cash" : plainName(l.name), weight: l.weight, side: legSide(l.side, inverted), why: l.why })),
    link: `${cfg.webUrl.replace(/\/$/, "")}/d/${id}`,
    draftId: id,
    inverted,
  };
}

/** What agreeing with the take holds of a leg: long (a prediction's own side), or for a take that
 *  bets against its picks, short (a prediction's other side). */
export function legSide(side: string | null | undefined, inverted: boolean): string {
  if (!inverted) return side ?? "long";
  return side === "yes" ? "no" : side === "no" ? "yes" : "short";
}

/** The picks as one line each, `Name 40%`; a take that bets against them says so first. */
export function picksLines(r: { inverted: boolean; legs: { name: string; weight: number }[] }): string[] {
  const picks = r.legs.map((l) => `${l.name} ${Math.round(l.weight)}%`);
  return r.inverted ? [`betting against: ${picks.join(", ")}`] : picks;
}

/** Boots the edge worker and its search index so the first real take is fast. */
export async function warmBasket(cfg: BasketConfig): Promise<void> {
  await fetch(cfg.takeBuilderUrl, { method: "GET", signal: AbortSignal.timeout(20_000) }).catch(() => {});
}

/** The basket config from the bots' shared env (apps/imessage/.env, apps/x/.env). */
export function basketConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BasketConfig {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Missing ${k} (see the bot's .env.example)`);
    return v;
  };
  const functions = `${need("SUPABASE_URL").replace(/\/$/, "")}/functions/v1`;
  return {
    takeBuilderUrl: `${functions}/take-builder`,
    draftsUrl: `${functions}/source/drafts`,
    botSecret: need("THESIS_BOT_SECRET"),
    webUrl: env.WEB_URL || "https://yourthesis.xyz",
  };
}
