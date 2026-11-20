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
/** Server-side only: the fork API service key for the pages' own reads (the receipt), so server
 *  renders don't count against the read limit as one Vercel IP. Never NEXT_PUBLIC_, never sent to
 *  the browser: a service key may act for any wallet. */
const forkServiceKey = () => required("FORK_API_SERVICE_KEY", process.env.FORK_API_SERVICE_KEY);

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
  /** A deleted account's placeholder (take_json, comments): no handle, "Deleted account", no profile. */
  deleted?: boolean;
};

/** An author who deleted their account (or has no handle): shown as "Deleted account", never linked. */
export const isDeleted = (p: Pick<Person, "handle" | "deleted">) => !!p.deleted || !p.handle;
export const DELETED_NAME = "Deleted account";
/** An author's name: their display name, else @handle; "Deleted account" once they're gone. */
export const authorName = (p: Pick<Person, "display_name" | "handle" | "deleted">) =>
  isDeleted(p) ? DELETED_NAME : p.display_name || `@${p.handle}`;

export type Profile = Person & { followers?: number; following?: number };

export type TakeLeg = {
  slot: number;
  name: string;
  kind: string;
  weight: number;
  why?: string | null;
  ret?: number;
  /** How a fade takes the other side of this leg (a Phoenix short, a prediction's other side), or null. */
  fade_how?: string | null;
  /** The catalog row (public.securities) the pick came from, when known. */
  asset_id?: string | null;
};

/** Whether a fade can take any of this take's legs (unknown legs count as maybe: the take page checks). */
export const fadeable = (t: Pick<Take, "legs">) => !t.legs?.length || t.legs.some((l) => l.fade_how !== null);

export type Take = {
  id: string;
  claim: string;
  status: string;
  risk: string;
  /** Old takes' horizon ("3mo"); new takes all say "12mo". Not shown: a take runs until its author sells. */
  horizon?: string | null;
  created_at: string;
  /** When it auto-settles if its author never sells (a year after posting for new takes). */
  settles_at: string | null;
  /** When the author sold their buy-in, which closed the take. Null while open; missing from older APIs. */
  closed_at?: string | null;
  /** The take's result is final on-chain (after the author's sale, or at settles_at). Missing from older APIs. */
  settled?: boolean;
  settled_at?: string | null;
  backs: number;
  fades: number;
  comments: number;
  ret: number;
  legs: TakeLeg[];
  author: Person;
  /** Where it came from: an article shared into Thesis, or an X post ("via …"). */
  source?: { url: string; label: string; kind: "link" | "x" } | null;
};

/** The X post a take was made from (the post its author replied to, or copied), or null. */
export const xSource = (t: { source?: Take["source"] }) =>
  t.source?.kind === "x" && /^https:\/\/(x|twitter)\.com\//.test(t.source.url) ? t.source.url : null;

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

/** A partial sale that has landed and waits for its prices (`priced`) and its settlement. */
export type PendingSale = { seq: number; bps: number; stakeUsd: number; soldAt: number; priced: boolean };

/**
 * What a fork API with partial sales adds to each position (all missing from an older one):
 * `remainingStakeUsd` the cost basis still held (`stakeUsd` stays what was bought), `valueUsd` is
 * then of what remains; `realizedPnlUsd` from settled partial sales; `maxPartialBps` the largest
 * part that can be sold now (null: only "sell all", since what's left must stay `minStakeUsd`);
 * `closesTakeIfSoldAll` the author's own buy-in, whose full sale closes the take.
 */
export type SaleFields = {
  remainingStakeUsd?: number;
  soldStakeUsd?: number;
  realizedPnlUsd?: number | null;
  pendingSales?: PendingSale[];
  minStakeUsd?: number;
  maxPartialBps?: number | null;
  closesTakeIfSoldAll?: boolean;
};

export type Position = SaleFields & {
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
  /** "open", "closed" (its author sold) or "settled"; older APIs send only "open" and "settled". */
  status: string;
  /** Unix seconds: when it auto-settles if the author never sells. */
  horizonEnd?: number;
  /** Unix seconds of the author's sale, once they sold (also once settled early). Missing from older APIs. */
  closedAt?: number | null;
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

/** A chat bot's draft take (/d/<id>): the take builder's basket, waiting for someone to post it. */
export type TakeDraft = {
  id: string;
  claim: string;
  risk: "low" | "medium" | "high";
  /** Old drafts' horizon; ignored (a take runs until its author sells, a year at most). */
  horizon?: string | null;
  summary: string | null;
  /** The take builder's legs, as it returned them (lib/compose.ts basketFrom reads them). */
  legs: import("./compose").Built["legs"];
  origin: "imessage" | "x";
  /** "From a group chat", "@jake asked on X". */
  context: string | null;
  created_at: string;
  source: { url: string; label: string; kind: "link" | "x" } | null;
  /** Its live take, once someone posted it. */
  take_id: string | null;
  /**
   * An X draft's asker (lowercased, no @): only that X account may post it. Null (or missing, from
   * a database before the field) for iMessage drafts, which anyone with the link may post.
   */
  for_x?: string | null;
};

export async function getDraft(id: string): Promise<TakeDraft | null> {
  if (!/^[A-Za-z0-9]{8}$/.test(id)) return null;
  return rpc<TakeDraft | null>("take_draft", { p_id: id }, 10).catch(() => null);
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
  const live = takes.filter((t) => t.status === "live").slice(0, PROFILE_TAKES);
  const receipts = await mapLimit(live, RECEIPTS_AT_ONCE, (t) => getReceipt(t.id));
  return live.map((t, i) => ({ ...t, ...withClosed(t, receipts[i]), ret: takeReturn(t, receipts[i]) }));
}

/** closed_at / settled, filled in from the on-chain receipt where the take's copy doesn't have them
 *  yet (a database from before take_json had them, or the chain event not ingested yet). */
function withClosed(t: Take, r: Receipt | null): Pick<Take, "closed_at" | "settled"> {
  const sold = r?.onChain && r.closedAt ? new Date(r.closedAt * 1000).toISOString() : null;
  return { closed_at: t.closed_at ?? sold, settled: !!t.settled || (!!r?.onChain && r.status === "settled") };
}

/** A profile shows at most this many takes, and reads their receipts this many at a time, so one
 *  render doesn't send the fork API a burst of 40 receipt builds at once (40 at 8 at a time is at
 *  most 5 rounds of getReceipt's 5 s timeout). */
const PROFILE_TAKES = 40;
const RECEIPTS_AT_ONCE = 8;

/** `fn` over `items`, at most `limit` running at once, results in order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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

export const nameOf = (p: Pick<Person, "display_name" | "handle" | "deleted">) => p.deleted ? DELETED_NAME : p.display_name || (p.handle ? `@${p.handle}` : "Someone");

/** A take's on-chain receipt, read by the server (pages, link previews) with the service key. */
export async function getReceipt(id: string): Promise<Receipt | null> {
  if (!UUID.test(id)) return null;
  const url = `${forkApiUrl()}/takes/${id}`; // outside the catch: a missing setting is a setup error
  const headers = { "x-thesis-service-key": forkServiceKey() };
  // A slow receipt (cold position scans right after a fork API restart) gives up after 5 s and the
  // page shows the social figure instead, as on a 429, so a profile render stays inside Vercel's limit.
  const r = await fetch(url, { headers, next: { revalidate: 15 }, signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS) }).catch(() => null);
  return r?.ok ? ((await r.json().catch(() => null)) as Receipt | null) : null;
}
const RECEIPT_TIMEOUT_MS = 5000;

/** A profile's Solana wallet (profiles are public), or null. */
export async function getProfileWallet(profileId: string): Promise<string | null> {
  if (!UUID.test(profileId)) return null;
  const r = await fetch(`${supabaseUrl()}/rest/v1/profiles?select=solana_address&id=eq.${profileId}`, {
    headers: { apikey: supabaseKey() },
    next: { revalidate: 3600 },
  }).catch(() => null);
  const rows = r?.ok ? ((await r.json().catch(() => [])) as { solana_address: string | null }[]) : [];
  return rows[0]?.solana_address ?? null;
}

/** A wallet's portfolio over all its history (the fork API's chart: deposits don't move it), or null. */
export async function getPortfolioHistory(wallet: string): Promise<{ value: number; change: number; changePct: number; points: { at: number; value: number }[] } | null> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return null;
  const r = await fetch(`${forkApiUrl()}/wallets/${wallet}/history?range=ALL`, {
    headers: { "x-thesis-service-key": forkServiceKey() },
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
  }).catch(() => null);
  return r?.ok ? await r.json().catch(() => null) : null;
}

/**
 * Your return on one side of a take, from your open positions on it: what's held now over what it
 * cost (each position's cost scaled to the part still held after partial sales), in percent; null
 * without a price or an open position.
 */
export function holdingReturn(positions: Position[], side: "back" | "fade"): number | null {
  const open = positions.filter((p) => !p.exited && p.side === side);
  if (!open.length || open.some((p) => p.valueUsd == null)) return null;
  const cost = open.reduce((s, p) => s + (p.remainingStakeUsd != null && p.stakeUsd > 0 ? (p.costUsd * p.remainingStakeUsd) / p.stakeUsd : p.costUsd), 0);
  const value = open.reduce((s, p) => s + (p.valueUsd ?? 0), 0);
  return cost > 0 ? (value / cost - 1) * 100 : null;
}

/** Someone's own position in a take, for their P&L card (/c/<id>?by=<handle>&side=…). */
export type Holder = { person: Pick<Person, "handle" | "display_name" | "avatar_url">; side: "back" | "fade"; ret: number };

/**
 * `handle`'s open position on `side` of take `id`, read from the chain through the fork API (by the
 * wallet on their public profile), so a shared P&L card shows what they really hold. Null when they
 * hold nothing open there, or it can't be read.
 */
export async function getHolder(id: string, handle: string, side: "back" | "fade"): Promise<Holder | null> {
  if (!UUID.test(id) || !/^[a-z0-9_]{1,30}$/i.test(handle)) return null;
  const pr = await fetch(`${supabaseUrl()}/rest/v1/profiles?select=handle,display_name,avatar_url,solana_address&handle=eq.${encodeURIComponent(handle.toLowerCase())}`, {
    headers: { apikey: supabaseKey() }, next: { revalidate: 60 },
  }).catch(() => null);
  const person = pr?.ok ? ((await pr.json().catch(() => [])) as (Holder["person"] & { solana_address: string | null })[])[0] : null;
  if (!person?.solana_address) return null;
  const r = await fetch(`${forkApiUrl()}/takes/${id}?viewer=${encodeURIComponent(person.solana_address)}`, {
    headers: { "x-thesis-service-key": forkServiceKey() }, next: { revalidate: 15 }, signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
  }).catch(() => null);
  const receipt = r?.ok ? ((await r.json().catch(() => null)) as Receipt | null) : null;
  const ret = receipt ? holdingReturn(receipt.viewerPositions ?? [], side) : null;
  if (ret == null) return null;
  return { person: { handle: person.handle, display_name: person.display_name, avatar_url: person.avatar_url }, side, ret };
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

/**
 * Where a take stands. It's open until its author sells their buy-in, which closes it: no new
 * trades or fades, and its result is final. If they never sell, it settles a year after posting.
 * Reads the new fields (take_json's closed_at / settled, the receipt's "closed" and closedAt) and
 * the old ones (a receipt that's only "open" or "settled", a take without closed_at), so takes
 * from before the change read right too. `bySale`: the author sold (else it settled at its end).
 */
export type TakeState = { open: true } | { open: false; at: Date | null; bySale: boolean };

type StateFields = Pick<Take, "closed_at" | "settled" | "settled_at" | "settles_at">;

export function takeState(take: StateFields | null, receipt?: Pick<Receipt, "onChain" | "status" | "closedAt"> | null): TakeState {
  const r = receipt?.onChain ? receipt : null;
  const closedAt = r?.closedAt ? new Date(r.closedAt * 1000) : take?.closed_at ? new Date(take.closed_at) : null;
  const settled = r?.status === "settled" || !!take?.settled;
  if (!closedAt && r?.status !== "closed" && !settled) return { open: true };
  // Settled at its end (never sold): the day it settled, else the day it was due to.
  const settledAt = take?.settled_at ?? (settled ? take?.settles_at : null) ?? null;
  return { open: false, at: closedAt ?? (settledAt ? new Date(settledAt) : null), bySale: !!closedAt || r?.status === "closed" };
}

/** "Nov 18", with the year when it isn't this one. */
export function dayLabel(d: Date): string {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** "@jake", or "the author" for a deleted account. */
const byline = (handle: string | null | undefined) => (handle ? `@${handle}` : "the author");

/** "Closed Nov 18 · +4.2%" for a closed take (the take page); an open take shows nothing. */
export function stateLabel(state: TakeState, ret?: number | null): string {
  if (state.open) return "";
  return [state.at ? `Closed ${dayLabel(state.at)}` : "Closed", ret != null ? pct(ret) : null].filter(Boolean).join(" · ");
}

/** "open" or "closed Nov 18", for tight spots (profile cards, link previews). */
export const stateShort = (state: TakeState) => (state.open ? "open" : state.at ? `closed ${dayLabel(state.at)}` : "closed");

/** Why a closed take can't be traded: "Closed: @jake sold", or that it settled at its end. */
export function closedReason(state: TakeState, handle: string | null | undefined): string {
  return state.open ? "" : state.bySale ? `Closed: ${byline(handle)} sold` : "Closed: this take has settled";
}

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

/** Each catalog row's logo key (its underlying ticker, else its symbol), by id, for take logos. */
export async function assetKeys(ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return {};
  const list = unique.map((id) => `"${id.replace(/["\\]/g, "")}"`).join(",");
  // The catalog rarely changes: a server render keeps the answer for an hour.
  const r = await fetch(`${supabaseUrl()}/rest/v1/securities?select=id,underlying,symbol&id=in.(${encodeURIComponent(list)})`, {
    headers: { apikey: supabaseKey() },
    next: { revalidate: 3600 },
  });
  if (!r.ok) throw new Error("securities: " + r.status);
  const rows = (await r.json()) as { id: string; underlying: string | null; symbol: string }[];
  return Object.fromEntries(rows.map((x) => [x.id, x.underlying ?? x.symbol]));
}

/** A card leg's kind, however it's labelled ("Cards" from the app, "card" from the take builder). */
/** A Collector Crypt card leg's kind: "card", "Cards", or a label such as "Card · $1,240 value". */
export const isCardKind = (kind: string | null | undefined) => /^cards?\b/i.test(kind ?? "");

/** "$1,240 value": a card's insured value (Collector Crypt's estimate, what the settler prices it at). */
export const cardValue = (usdValue: number | null | undefined) => (usdValue == null ? "Card" : `Card · ${"$" + Math.round(usdValue).toLocaleString("en-US")} value`);

