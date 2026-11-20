// The agent's pure rules (no env, no network), shared by index.ts and its tests.

/** Play money is $1,000 an account; the program's minimum stake is $10. */
export const MIN_USD = 10;
export const MAX_USD = 1000;
/** The most any account may allow (the database's check), for wallets with a bigger play-money cap. */
export const HARD_MAX_USD = 10_000;

/**
 * Wallets whose limits may go past $1,000 (the team's accounts, whose play money is capped higher:
 * the fork API's FORK_DEPOSIT_CAP_OVERRIDES): AGENT_LIMIT_OVERRIDES="<wallet>=10000".
 */
export function parseLimitOverrides(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (raw ?? "").split(",")) {
    const [wallet, usd] = part.split("=").map((x) => x?.trim());
    const n = Number(usd);
    if (wallet && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet) && Number.isFinite(n) && n >= MIN_USD) out.set(wallet, Math.min(n, HARD_MAX_USD));
  }
  return out;
}
export const LINK_TTL_MS = 30 * 60_000;

export type Limits = { perTradeUsd: number; dailyUsd: number };

/** The limits screen's choice, or null when it's out of range. */
export function readLimits(b: Record<string, unknown>, max = MAX_USD): Limits | null {
  const perTradeUsd = Number(b.per_trade_usd);
  const dailyUsd = Number(b.daily_usd);
  if (!Number.isFinite(perTradeUsd) || !Number.isFinite(dailyUsd)) return null;
  if (perTradeUsd < MIN_USD || perTradeUsd > max || dailyUsd < perTradeUsd || dailyUsd > max) return null;
  return { perTradeUsd: Math.round(perTradeUsd * 100) / 100, dailyUsd: Math.round(dailyUsd * 100) / 100 };
}

/** Who a bot is asking for: an X account id or an iMessage handle. */
export type Who = { x: string } | { imessage: string };

export function readWho(v: unknown): Who | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.x === "string" && /^[0-9]{1,25}$/.test(o.x)) return { x: o.x };
  if (typeof o.imessage === "string") {
    const h = normalizeHandle(o.imessage);
    if (h) return { imessage: h };
  }
  return null;
}

/** An iMessage handle as stored: E.164 for phones (US numbers without +1 get it), lowercased emails. */
export function normalizeHandle(raw: string): string | null {
  const s = raw.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 120) return s.toLowerCase();
  const digits = s.replace(/[^\d+]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

export type Action = "post" | "back" | "fade" | "sell";
export const ACTIONS: readonly Action[] = ["post", "back", "fade", "sell"];
export const SURFACES = ["x", "imessage", "copy", "mcp"] as const;
export type Surface = (typeof SURFACES)[number];

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function linkToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A bot's draft → the legs POST /takes takes (apps/www lib/compose.ts fromBuilt + normalized) ------

type BuiltLeg = {
  id?: string; key?: string | null; name: string; kind: string; weight: number; why?: string;
  canShort?: boolean; can_short?: boolean; side?: string | null; leverage?: number | null;
};
export type TakeLeg = { name: string; kind: string; weight: number; why: string; slot: number; fade_how: string | null; asset_id: string | null };

/** "NVIDIA xStock" → "NVIDIA" (the apps' displayName). */
export function displayName(raw: string): string {
  return raw
    .replace(/\s+-\s+Backpack Securities$/, "")
    .replace(/,?\s+(Inc\.|Corporation|Corp\.|N\.V\.|Limited|Ltd\.)(\s+Common Stock)?$/, "")
    .replace(/\s+(PreStocks|Common Stock)$/, "")
    .replace(/\s+(xStock|Tokenized Stock|Tokenized|rStock)\b.*$/, "")
    .replace(/\s*\((Ondo|Backpack|Tokenized)[^)]*\)$/, "")
    .trim();
}

const LABEL: Record<string, string> = { etf: "ETF", commodity: "Commodity", "pre-ipo": "Pre-IPO", leveraged: "Leveraged", yield: "Earns interest", card: "Cards" };

/** Weights that add up to 100, each at least 1 (the apps' BasketMath). */
export function normalizedWeights(weights: number[]): number[] {
  if (!weights.length) return [];
  const total = weights.reduce((s, w) => s + Math.max(w, 0), 0);
  let assigned = 0;
  const out = weights.map((w, i) => {
    const share = total > 0 ? (Math.max(w, 0) / total) * 100 : 100 / weights.length;
    const v = i === weights.length - 1 ? 100 - assigned : Math.max(1, Math.round(share));
    assigned += v;
    return v;
  });
  const last = out.length - 1;
  if (out[last] < 1) {
    const big = out.reduce((b, w, i) => (w > out[b] ? i : b), 0);
    out[big] -= 1 - out[last];
    out[last] = 1;
  }
  return out;
}

export function takeLegs(built: BuiltLeg[]): TakeLeg[] {
  const legs = built.slice(0, 5);
  const weights = normalizedWeights(legs.map((l) => Number(l.weight) || 0));
  return legs.map((b, i) => {
    const kind = b.kind === "perp" ? (b.leverage ? `Stock · ${b.leverage}x` : "Leveraged")
      : b.kind === "prediction" ? (b.side === "no" ? "Prediction · No" : "Prediction · Yes")
      : LABEL[b.kind] ?? "Stock";
    return {
      name: (b.kind === "yield" ? "Cash" : displayName(b.name)).slice(0, 120),
      kind,
      weight: weights[i],
      why: (b.why ?? "").slice(0, 300),
      slot: i,
      fade_how: (b.canShort ?? b.can_short) ? (b.kind === "prediction" ? "Bets No" : "Bets the stock falls") : null,
      asset_id: typeof b.id === "string" && b.id.length <= 120 ? b.id : null,
    };
  });
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

/** The topic tile and up to three tags, from the claim and the picks (the apps' topicGuess). */
export function topicGuess(claim: string, legs: { name: string }[]): { topic: string; tags: string[] } {
  const words = new Set([claim, ...legs.map((l) => l.name)].join(" ").toLowerCase().split(/[^a-z-]+/).filter(Boolean));
  const matches = TOPIC_RULES.filter(([ws]) => ws.some((w) => words.has(w)));
  return { topic: matches[0]?.[1] ?? "topic-coin", tags: [...new Set(matches.map((m) => m[2]))].slice(0, 3) };
}

/** A fork API refusal that a fresh build is expected to fix (prices moved; nothing left the wallet). */
export const isRequote = (code: string | undefined, body: Record<string, unknown> | undefined) =>
  body?.requote === true || code === "requote" || code === "quote_stale" || code === "build_gone";
