// Making a take, the iOS composer's model: drafts, the take builder's legs, hand edits to the basket
// (BasketMath.swift), and the topic and tags a take is posted with (TopicGuess).

export type Risk = "low" | "medium" | "high";
export type Horizon = "2wk" | "1mo" | "3mo" | "6mo";

export const RISKS: { key: Risk; label: string; note: string; basket: string }[] = [
  { key: "low", label: "Low", note: "Earns interest", basket: "Plain basket, plus interest on cash that isn't invested yet." },
  { key: "medium", label: "Medium", note: "Plain basket", basket: "Stocks and a prediction. No leverage." },
  { key: "high", label: "High", note: "Adds leverage", basket: "Adds leverage, up to 5x, on picks that support it: more for short takes, less for long ones." },
];

export const HORIZONS: { key: Horizon; short: string; long: string; unit: "week" | "month"; n: number }[] = [
  { key: "2wk", short: "2 wks", long: "2 weeks", unit: "week", n: 2 },
  { key: "1mo", short: "1 mo", long: "1 month", unit: "month", n: 1 },
  { key: "3mo", short: "3 mo", long: "3 months", unit: "month", n: 3 },
  { key: "6mo", short: "6 mo", long: "6 months", unit: "month", n: 6 },
];

export const horizonOf = (k: Horizon) => HORIZONS.find((h) => h.key === k)!;

/** When a take posted now settles, as the server's post_take sets settles_at. */
export function settleDate(k: Horizon, from = new Date()): Date {
  const h = horizonOf(k);
  const d = new Date(from);
  if (h.unit === "week") d.setDate(d.getDate() + 7 * h.n);
  else d.setMonth(d.getMonth() + h.n);
  return d;
}

export type Source = { url: string; label: string; kind: "x" | "link" };

export type Leg = {
  name: string;
  /** "Stock", "Prediction · Yes", "Stock · 3x", "Earns interest". */
  kind: string;
  weight: number;
  why: string;
  slot: number;
  fadeHow: string | null;
  assetId: string | null;
  assetKey: string | null;
  /** Card legs (docs/cards-plan.md): the insured value and picture the take builder sends. */
  insuredValueUsd?: number | null;
  imageUrl?: string | null;
};

export type Draft = {
  claim: string;
  risk: Risk;
  horizon: Horizon;
  buyIn: number;
  legs: Leg[] | null;
  summary: string | null;
  noExposure: string | null;
  /** Started from an asset page: the basket keeps this asset. */
  seed: { id: string; name: string } | null;
  /** You changed the picks: a new risk keeps them instead of rebuilding. */
  edited: boolean;
  source: Source | null;
};

export const newDraft = (init: Partial<Draft> = {}): Draft => ({
  claim: "", risk: "medium", horizon: "3mo", buyIn: 25, legs: null, summary: null, noExposure: null, seed: null, edited: false, source: null, ...init,
});

export const predictionSide = (l: Leg) => (l.kind.startsWith("Prediction") ? (l.kind.endsWith("No") ? "no" : "yes") : undefined);
export const leverageOf = (l: Leg) => { const m = l.kind.match(/(\d+)x$/); return m ? Number(m[1]) : undefined; };

/** "NVIDIA xStock" → "NVIDIA", "Krispy Kreme, Inc. Common Stock" → "Krispy Kreme" (the app's displayName). */
export function displayName(raw: string): string {
  return raw
    .replace(/\s+-\s+Backpack Securities$/, "")
    .replace(/,?\s+(Inc\.|Corporation|Corp\.|N\.V\.|Limited|Ltd\.)(\s+Common Stock)?$/, "")
    .replace(/\s+(PreStocks|Common Stock)$/, "")
    .replace(/\s+(xStock|Tokenized Stock|Tokenized|rStock)\b.*$/, "")
    .replace(/\s*\((Ondo|Backpack|Tokenized)[^)]*\)$/, "")
    .trim();
}

type BuiltLeg = { id: string; key?: string | null; name: string; kind: string; role: string; weight: number; why: string; can_short: boolean; side?: string | null; leverage?: number | null;
  /** Card legs: sent in camelCase, unlike the other fields; either spelling is read. */
  insuredValueUsd?: number | null; imageUrl?: string | null };
export type Built = { verdict: string; summary?: string | null; reason?: string | null; legs: BuiltLeg[]; note?: string | null };

/** The take builder's leg as the app shows it. */
export function fromBuilt(b: BuiltLeg, slot: number): Leg {
  const label: Record<string, string> = { etf: "ETF", commodity: "Commodity", "pre-ipo": "Pre-IPO", leveraged: "Leveraged", yield: "Earns interest", card: "Cards" };
  // No default leverage: without the builder's number the leg says "Leveraged".
  const kind = b.kind === "perp" ? (b.leverage ? `Stock · ${b.leverage}x` : "Leveraged")
    : b.kind === "prediction" ? (b.side === "no" ? "Prediction · No" : "Prediction · Yes")
    : label[b.kind] ?? "Stock";
  return {
    // Yield vaults have crypto names; to the user it's cash earning interest.
    name: b.kind === "yield" ? "Cash" : displayName(b.name),
    kind,
    weight: b.weight,
    why: b.why,
    slot,
    fadeHow: b.can_short ? (b.kind === "prediction" ? "Bets No" : "Bets the stock falls") : null,
    assetId: b.id,
    assetKey: b.key ?? b.id,
    ...(b.kind === "card" ? { insuredValueUsd: b.insuredValueUsd ?? null, imageUrl: b.imageUrl ?? null } : {}),
  };
}

export function basketFrom(b: Built): { legs: Leg[]; summary: string | null; noExposure: string | null; note: string | null } {
  return {
    legs: b.legs.map((l, i) => fromBuilt(l, i)),
    summary: b.summary ?? null,
    noExposure: b.verdict === "no_clean_exposure" ? (b.reason ?? "Nothing you can buy tracks this closely enough yet.") : null,
    note: b.note ?? null,
  };
}

/** The legs as the take builder takes them back (edit and risk modes). */
export const builderLegs = (legs: Leg[]) =>
  legs.filter((l) => l.assetId).map((l) => ({ id: l.assetId, weight: l.weight, why: l.why, side: predictionSide(l), leverage: leverageOf(l) }));

// Basket math: the weights always add up to 100 (BasketMath.swift).
export const MAX_PICKS = 10;

export function normalized(legs: Leg[]): Leg[] {
  if (!legs.length) return [];
  const total = legs.reduce((s, l) => s + Math.max(l.weight, 0), 0);
  let assigned = 0;
  const out = legs.map((l, i) => {
    const share = total > 0 ? (Math.max(l.weight, 0) / total) * 100 : 100 / legs.length;
    const w = i === legs.length - 1 ? 100 - assigned : Math.max(1, Math.round(share));
    assigned += w;
    return { ...l, weight: w };
  });
  const last = out.length - 1;
  if (out[last].weight < 1) {
    const big = out.reduce((b, l, i) => (l.weight > out[b].weight ? i : b), 0);
    out[big].weight -= 1 - out[last].weight;
    out[last].weight = 1;
  }
  return out;
}

export const nextSlot = (legs: Leg[]) => {
  const used = new Set(legs.map((l) => l.slot));
  for (let i = 0; i < MAX_PICKS; i++) if (!used.has(i)) return i;
  return legs.length % MAX_PICKS;
};

export type PickAsset = { id: string; key: string; name: string; kind: string; kindLabel: string; about?: string | null; canShort: boolean };

export const holds = (a: PickAsset, legs: Leg[]) => legs.some((l) => l.assetKey === a.key || l.assetId === a.id || l.name === a.name);

export function adding(a: PickAsset, legs: Leg[]): Leg[] {
  if (holds(a, legs) || legs.length >= MAX_PICKS) return legs;
  const share = 100 / (legs.length + 1);
  const scaled = legs.map((l) => ({ ...l, weight: l.weight * (1 - share / 100) }));
  const leg: Leg = {
    name: displayName(a.name),
    kind: a.kind === "prediction" ? "Prediction · Yes" : a.kindLabel,
    weight: share,
    why: a.about ?? "",
    slot: nextSlot(legs),
    fadeHow: a.canShort ? (a.kind === "prediction" ? "Bets No" : "Bets the stock falls") : null,
    assetId: a.id,
    assetKey: a.key,
  };
  return normalized([...scaled, leg]);
}

export function removing(leg: Leg, legs: Leg[]): Leg[] {
  const rest = legs.filter((l) => l.name !== leg.name);
  return rest.length ? normalized(rest) : legs;
}

export function setting(leg: Leg, weight: number, legs: Leg[]): Leg[] {
  if (legs.length < 2) return legs;
  const w = Math.min(Math.max(Math.round(weight), 1), 100 - (legs.length - 1));
  const others = legs.filter((l) => l.name !== leg.name);
  const othersTotal = others.reduce((s, l) => s + l.weight, 0);
  let out = legs.map((l) => ({ ...l, weight: l.name === leg.name ? w : (othersTotal > 0 ? l.weight / othersTotal : 1 / others.length) * (100 - w) }));
  const fixed = out.findIndex((l) => l.name === leg.name);
  out = normalized(out);
  const drift = out[fixed].weight - w;
  if (drift !== 0) {
    const other = out.reduce((b, l, i) => (i !== fixed && (b < 0 || l.weight > out[b].weight) ? i : b), -1);
    if (other >= 0) { out[fixed].weight = w; out[other].weight += drift; }
  }
  return out;
}

const TOPIC_RULES: [string[], string, string][] = [
  [["nuclear", "reactor", "uranium"], "topic-nuclear", "Energy"],
  [["power", "energy", "oil", "gas", "grid", "solar", "utility", "utilities"], "topic-energy", "Energy"],
  [["fed", "rate", "rates", "inflation", "treasury", "bond", "cpi"], "topic-bank", "Rates"],
  [["mortgage", "housing", "home", "homes", "rent"], "topic-house", "Housing"],
  [["chip", "chips", "semis", "semiconductor", "nvidia", "amd", "tsmc"], "topic-rocket", "Chips"],
  [["ai", "data-center", "datacenter", "compute", "gpu", "openai"], "topic-computer", "AI"],
  [["stream", "streaming", "netflix", "tv", "cable"], "topic-tv", "Media"],
];

/** The topic tile and up to three tags, from the claim and the picks (the app's TopicGuess). */
export function topicGuess(claim: string, legs: Leg[]): { topic: string; tags: string[] } {
  const words = new Set([claim, ...legs.map((l) => l.name)].join(" ").toLowerCase().split(/[^a-z-]+/).filter(Boolean));
  const matches = TOPIC_RULES.filter(([ws]) => ws.some((w) => words.has(w)));
  return { topic: matches[0]?.[1] ?? "topic-coin", tags: [...new Set(matches.map((m) => m[2]))].slice(0, 3) };
}

/** A drafted take from an X call (or its notification): risk and horizon words → the draft's keys. */
export function fromCall(c: { claim: string; risk?: string | null; horizon?: string | null; url?: string | null; label: string }): Partial<Draft> & { autoBuild: boolean } {
  const risk = (["low", "medium", "high"] as const).find((r) => r === c.risk?.toLowerCase()) ?? "medium";
  const horizon = HORIZONS.find((h) => h.long === c.horizon || h.key === c.horizon)?.key ?? "3mo";
  const source = c.url && /^https?:\/\//.test(c.url) ? { url: c.url, label: c.label, kind: "x" as const } : null;
  return { claim: c.claim.slice(0, 140), risk, horizon, source, autoBuild: true };
}
