// Reads for the take pages. Social data comes from Supabase's public read functions (the same ones
// the iOS app calls with the publishable key); the on-chain receipt comes from the fork API.

// Required settings (apps/www/.env.example). Read when used, not at import, so a build without them
// still succeeds and a missing one fails the request with a clear error. NEXT_PUBLIC_* values are
// inlined at build time, so each is read with a literal `process.env.NAME`.
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set (see apps/www/.env.example).`);
  return value;
}
export const supabaseUrl = () => required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
export const supabaseKey = () => required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
/** Server-side only: where /api/fork/* is proxied to (app/api/fork). */
export const forkApiUrl = () => required("FORK_API_URL", process.env.FORK_API_URL).replace(/\/$/, "");

export type Person = {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio?: string;
  made?: number;
  return_pct?: number;
  /** The second score: what everyone who traded this person's takes made (losses subtracted). */
  backers_made?: number;
  backers_pct?: number;
  takes?: number;
};

export type Profile = Person & { followers?: number; following?: number };

export type TakeLeg = {
  slot: number;
  name: string;
  kind: string;
  weight: number;
  why?: string | null;
  ret?: number;
};

export type Take = {
  id: string;
  claim: string;
  status: string;
  risk: string;
  horizon: string;
  created_at: string;
  settles_at: string | null;
  backs: number;
  fades: number;
  comments: number;
  ret: number;
  legs: TakeLeg[];
  author: Person;
  /** Where it came from: an article shared into Thesis, or an X post ("via …"). */
  source?: { url: string; label: string; kind: "link" | "x" } | null;
};

export type ReceiptLeg = {
  index: number;
  name: string;
  tradable: boolean;
  blocked: string | null;
  fadeBlocked: string | null;
  weightBps: number;
  authorEntryUsd: number | null;
  currentUsd: number | null;
  prediction: { side: "yes" | "no"; label: string; event: string; ask: { yes: number | null; no: number | null } } | null;
  /** A Collector Crypt card leg (paper, escrowed like a prediction, never faded; docs/cards-plan.md): its insured value. */
  card?: { cardId: string; insuredValueUsd: number | null } | null;
};

export type Position = {
  address: string;
  side: "back" | "fade";
  exited: boolean;
  canExit: boolean;
  stakeUsd: number;
  costUsd: number;
  valueUsd: number | null;
  returnBps: number | null;
  pendingNote: string | null;
};

export type Receipt = {
  takeId: string;
  onChain: boolean;
  status: string;
  backers?: number;
  faders?: number;
  totalBackedUsd?: number;
  totalFadedUsd?: number;
  returnBps: number | null;
  legs: ReceiptLeg[];
  viewerPositions: Position[];
  canBack: boolean;
  canFade: boolean;
  fadeBlocked: string | null;
  /** Set when the fork can't trade this take at all (posted before a fork reset): why, in words. */
  missing?: string | null;
};

const UUID = /^[0-9a-f-]{36}$/i;

async function rpc<T>(name: string, args: Record<string, unknown>, revalidate = 15): Promise<T> {
  const r = await fetch(`${supabaseUrl()}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: supabaseKey(), "content-type": "application/json", "x-thesis-network": "solana-mainnet-fork" },
    body: JSON.stringify(args),
    next: { revalidate },
  });
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return (await r.json()) as T;
}

export async function getTake(id: string): Promise<Take | null> {
  if (!UUID.test(id)) return null;
  const t = await rpc<Take | null>("take", { p_id: id }).catch(() => null);
  return t && t.status === "live" ? t : null;
}

export async function getFeed(): Promise<Take[]> {
  return rpc<Take[]>("feed", { p_limit: 50 }, 30).catch(() => []);
}

/** A profile by @handle (what share links use) or by id. */
export async function getProfile(handleOrId: string): Promise<Profile | null> {
  const key = decodeURIComponent(handleOrId).replace(/^@/, "").trim();
  if (!key || key.length > 64) return null;
  let id = UUID.test(key) ? key : null;
  if (!id) {
    const hits = await rpc<Person[]>("search_people", { p_query: key, p_limit: 5 }, 60).catch(() => []);
    id = hits.find((p) => p.handle?.toLowerCase() === key.toLowerCase())?.id ?? null;
  }
  return id ? rpc<Profile | null>("profile", { p_profile: id }).catch(() => null) : null;
}

/** A person's live takes, newest first, with `ret` set from the on-chain receipt where there is
 *  one, so the profile, the take page and the called-it page all show the same number. */
export async function getProfileTakes(id: string): Promise<Take[]> {
  const takes = await rpc<Take[]>("profile_takes", { p_profile: id }).catch(() => []);
  const live = takes.filter((t) => t.status === "live").slice(0, 40);
  const receipts = await Promise.all(live.map((t) => getReceipt(t.id)));
  return live.map((t, i) => ({ ...t, ret: takeReturn(t, receipts[i]) }));
}

/** A take is a "called it" once it's up at least this much (percent) since it was posted. */
export const CALLED_IT_MIN = 1;
export const calledIt = (ret: number | null | undefined) => ret != null && ret >= CALLED_IT_MIN;

/** The take's return in percent: the on-chain receipt when there is one, else the social copy. */
export function takeReturn(take: Take, receipt: Receipt | null): number {
  return receipt?.onChain && receipt.returnBps != null ? receipt.returnBps / 100 : take.ret;
}

export function since(iso: string): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export const nameOf = (p: Pick<Person, "display_name" | "handle">) => p.display_name || (p.handle ? `@${p.handle}` : "Someone");

export async function getReceipt(id: string): Promise<Receipt | null> {
  const r = await fetch(`${forkApiUrl()}/takes/${id}`, { next: { revalidate: 15 } }).catch(() => null);
  return r?.ok ? ((await r.json()) as Receipt) : null;
}

const FACE_COLORS = ["#FFD5DC", "#C0AEDE", "#B6E3F4", "#D1D4F9", "#FFDFBF", "#C8ECD4", "#FFFFFF"];

/** `face:<name>:<color>`, `asset:<name>`, or a photo URL, as the app stores them. */
export function avatar(url: string | null | undefined): { src: string | null; bg: string } {
  if (!url) return { src: null, bg: FACE_COLORS[3] };
  if (url.startsWith("face:")) {
    const [, name, color] = url.split(":");
    const n = Number(color) || 0;
    return { src: `/avatars/${name}.png`, bg: FACE_COLORS[((n % 7) + 7) % 7] };
  }
  if (url.startsWith("asset:")) return { src: `/avatars/${url.slice(6).replace(/^avatar-/, "")}.png`, bg: FACE_COLORS[1] };
  return { src: url, bg: FACE_COLORS[3] };
}

export const HORIZON: Record<string, string> = { "2wk": "2 weeks", "1mo": "1 month", "3mo": "3 months", "6mo": "6 months", "1yr": "1 year" };

export const SERIES = ["#3987E5", "#D95926", "#199E70", "#C98500", "#D55181", "#8B6CEF", "#2BB3C0", "#8FB339", "#B07A4F", "#7C8BA1"];

export function pct(x: number | null | undefined, digits = 1): string {
  if (x == null || Number.isNaN(x)) return "—";
  const v = Math.abs(x).toFixed(digits);
  return `${x >= 0 || Number(v) === 0 ? "+" : "−"}${v}%`;
}

export function usd(x: number | null | undefined): string {
  if (x == null) return "—";
  return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Gemini's event titles end in "?", so "Gold on Dec 18?: $3,975 or above" reads as "Gold on Dec 18: …". */
export function legName(name: string): string {
  return name.replace(/\?:\s/, ": ");
}

/** "+$1,284.50" / "−$310.00" with a true minus, like the app's Fmt.usd. `signed`: "+" on gains. */
export function money(x: number, signed = false): string {
  const body = "$" + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (x < 0 && Math.abs(x) >= 0.005) return "−" + body;
  return signed ? "+" + body : body;
}

/** A topic key from the app ("topic-energy") as its tile image. */
export const topicImage = (topic: string | null | undefined) => "/topics/" + (topic ?? "topic-coin").replace(/^topic-/, "") + ".png";

/** Fresh Supabase reads from the browser (no caching), for the signed-in screens. */
export async function rpcNow<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(supabaseUrl() + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: { apikey: supabaseKey(), "content-type": "application/json", "x-thesis-network": "solana-mainnet-fork" },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(name + ": " + r.status);
  return (await r.json()) as T;
}

/** A card leg's kind, however it's labelled ("Cards" from the app, "card" from the take builder). */
export const isCardKind = (kind: string | null | undefined) => /^cards?$/i.test(kind ?? "");

/** "$1,240 value": a card's insured value (Collector Crypt's estimate, what the settler prices it at). */
export const cardValue = (usdValue: number | null | undefined) => (usdValue == null ? "Card" : `Card · ${"$" + Math.round(usdValue).toLocaleString("en-US")} value`);

