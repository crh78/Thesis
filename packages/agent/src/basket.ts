// build_basket tool: the `source` function's POST /drafts runs the take builder (the catalog in a
// cached prompt, BM25 search over prediction markets, one Luna pick) and saves the basket as a
// draft take; this returns the draft's web page. A bot can't post a take as
// someone, so whoever taps the link posts it as theirs (decided 2026-11-16; apps/www/app/d).

export const RISKS = ["low", "medium", "high"] as const;
export const HORIZONS = ["2 weeks", "1 month", "3 months", "6 months"] as const;
type Risk = (typeof RISKS)[number];
type Horizon = (typeof HORIZONS)[number];

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

export type BasketArgs = { claim: string; risk: Risk; horizon: Horizon };

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
};

type Leg = { id: string; name: string; kind: string; weight: number; side?: string | null; why: string };
type BuilderReply = {
  verdict: "basket" | "no_clean_exposure";
  summary: string;
  reason: string | null;
  legs: Leg[];
};

export type BasketResult =
  | { verdict: "basket"; summary: string; legs: { name: string; weight: number; side: string; why: string }[]; link: string }
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
    required: ["claim", "risk", "horizon"],
    properties: {
      claim: { type: "string", description: "The take as one short sentence in the person's words, 5-140 chars." },
      risk: { type: "string", enum: [...RISKS], description: "Default medium unless they said otherwise." },
      horizon: { type: "string", enum: [...HORIZONS], description: "Default 3 months unless they said otherwise." },
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
      claim, risk: args.risk, horizon: args.horizon,
      origin: meta.origin, context: meta.context, origin_ref: meta.originRef, for_x: meta.forX,
      ...(meta.source ? { source: { text: meta.source.text.slice(0, 2000), url: meta.source.url, label: meta.source.label, kind: "x" } } : {}),
    }),
    signal: AbortSignal.timeout(35_000),
  });
  if (!res.ok) return { verdict: "error", reason: `drafts ${res.status}` };
  const out = (await res.json()) as BuilderReply & { id?: string };
  if (out.verdict !== "basket" || !out.legs?.length || !out.id) {
    return { verdict: "no_clean_exposure", reason: out.reason || "Nothing you can buy tracks this closely enough yet." };
  }
  const id = out.id;

  return {
    verdict: "basket",
    summary: out.summary,
    legs: out.legs.map((l) => ({ name: plainName(l.name), weight: l.weight, side: l.side ?? "long", why: l.why })),
    link: `${cfg.webUrl.replace(/\/$/, "")}/d/${id}`,
  };
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
