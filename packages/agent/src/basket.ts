// build_basket tool: runs the deployed take-builder edge function (the catalog
// in a cached prompt, BM25 search over prediction markets, one Luna pick) and
// returns a link that opens the built basket in the Thesis app.

export const RISKS = ["low", "medium", "high"] as const;
export const HORIZONS = ["2 weeks", "1 month", "3 months", "6 months"] as const;
type Risk = (typeof RISKS)[number];
type Horizon = (typeof HORIZONS)[number];

export type BasketConfig = {
  /** https://<ref>.supabase.co/functions/v1/take-builder */
  takeBuilderUrl: string;
  /** SECURITIES_INDEX_SECRET: server-to-server auth (runs as a US user). */
  takeBuilderSecret: string;
  /** https://<ref>.supabase.co/functions/v1/open — redirects into the app. */
  openUrl: string;
  /** Which installed app the link opens: Debug ("Thesis Dev") or Release. */
  app: "dev" | "prod";
};

export type BasketArgs = { claim: string; risk: Risk; horizon: Horizon };

type Leg = { symbol: string; name: string; kind: string; weight: number; side: string; why: string };
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
    "plus a link that opens the basket in the Thesis app to buy in. Use whenever someone states or asks about a take.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["claim", "risk", "horizon"],
    properties: {
      claim: { type: "string", description: "The take as one short sentence in the person's words, 5-280 chars." },
      risk: { type: "string", enum: [...RISKS], description: "Default medium unless they said otherwise." },
      horizon: { type: "string", enum: [...HORIZONS], description: "Default 3 months unless they said otherwise." },
    },
  },
};

export function basketLink(cfg: BasketConfig, args: BasketArgs): string {
  const q = new URLSearchParams({ app: cfg.app, claim: args.claim, risk: args.risk, horizon: args.horizon });
  return `${cfg.openUrl}?${q}`;
}

export async function buildBasket(cfg: BasketConfig, args: BasketArgs): Promise<BasketResult> {
  const claim = args.claim.trim().slice(0, 280);
  if (claim.length < 5) return { verdict: "error", reason: "Take is too short." };
  const res = await fetch(cfg.takeBuilderUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-index-secret": cfg.takeBuilderSecret },
    body: JSON.stringify({ claim, risk: args.risk, horizon: args.horizon }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { verdict: "error", reason: `take-builder ${res.status}` };
  const out = (await res.json()) as BuilderReply;
  if (out.verdict !== "basket" || !out.legs?.length) {
    return { verdict: "no_clean_exposure", reason: out.reason || "Nothing you can buy tracks this closely enough yet." };
  }
  return {
    verdict: "basket",
    summary: out.summary,
    // Plain names for a non-investor; drop venue suffixes the catalog carries.
    legs: out.legs.map((l) => ({
      name: l.name.replace(/ - Backpack Securities$| xStock$/, ""),
      weight: l.weight,
      side: l.side,
      why: l.why,
    })),
    link: basketLink(cfg, { ...args, claim }),
  };
}

/** Boots the edge worker and its search index so the first real take is fast. */
export async function warmBasket(cfg: BasketConfig): Promise<void> {
  await fetch(cfg.takeBuilderUrl, { method: "GET", signal: AbortSignal.timeout(20_000) }).catch(() => {});
}
