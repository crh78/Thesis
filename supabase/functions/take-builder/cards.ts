// Collector Crypt cards for the take builder (docs/cards-plan.md).
//
// Card legs are paper-filled at the card's insured value (Collector Crypt's own market estimate),
// so any card CC prices can be picked, listed or not. The builder searches CC live (one request,
// ~0.2-0.4 s, no key) instead of a synced table, and a picked card gets one `securities` row
// (`card:<cardId>`) so take_legs.asset_id can point at it. Cards aren't in basket_catalog or
// search_assets (kind 'card'), so those rows never show up in other searches.
//
// Rules: medium and high risk only. A take about cards (isCardTake) may be all cards; any
// other take gets at most one card, at most 20% of the basket, never alone.
// CC's `search` parameter isn't in its docs (it works for now); if it stops working the
// search returns nothing and baskets are built without cards.
import type { Security } from "../_shared/catalog.ts";

export const CC_API = "https://api.collectorcrypt.com";
export const CARD_PREFIX = "card:";
export const MAX_CARD_WEIGHT = 20;
const SEARCH_TIMEOUT_MS = 2500;

const positive = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** A CC browse row as a catalog row, or null when it can't be a leg (no id, no insured value, not a live token). */
// deno-lint-ignore no-explicit-any
export function cardSecurity(raw: any): Security | null {
  const cardId = str(raw?.id);
  const insured = positive(raw?.insuredValue);
  if (!cardId || insured === null) return null;
  if (raw.deletedAt || raw.burnedForBridge === true || (raw.nftStatus != null && raw.nftStatus !== "Valid")) return null;
  const name = str(raw.itemName) ?? cardId;
  const category = str(raw.category);
  const grade = [str(raw.gradingCompany), str(raw.grade)].filter(Boolean).join(" ") || null;
  return {
    id: `${CARD_PREFIX}${cardId}`,
    kind: "card",
    symbol: category ?? "Card",
    name,
    underlying: null,
    issuer: null,
    venue: "Collector Crypt",
    mint: str(raw.nftAddress),
    themes: ["Collectibles", ...(category ? [category] : [])],
    description: `A ${grade ? `${grade} ` : ""}${category ? `${category} ` : ""}collectible on Collector Crypt, insured at $${fmt(insured)}.`,
    liquidity: "tradeable",
    us_persons: "unknown",
    can_short: false,
    expires_at: null,
    data: {
      cardId, insuredValueUsd: insured, category, grade, set: str(raw.set), year: positive(raw.year),
      image: str(raw.images?.frontS) ?? str(raw.images?.frontM) ?? str(raw.frontImage),
    },
  };
}

const fmt = (n: number) => (n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2).replace(/\.00$/, ""));

/** What the model sees for a card: what it is and what it's worth. */
export const cardAbout = (s: Security) => {
  const d = s.data ?? {};
  const v = positive(d.insuredValueUsd);
  return [d.category, v !== null ? `worth $${fmt(v)}` : null].filter(Boolean).join(", ");
};

/**
 * Collector Crypt's search wants every word in a card's title, and treats accented letters as
 * different ones (when measured: "graded Pokémon cards" finds nothing, "Pokemon card" 1,823,
 * "vintage Charizard" nothing, "Charizard PSA 10" 1,799). So queries lose their accents and the
 * words titles don't carry, and a search that finds nothing tries again with fewer words.
 */
const FILLER = new Set([
  "a", "an", "the", "of", "and", "or", "for", "with", "in", "on",
  "card", "cards", "graded", "grade", "slab", "slabs", "slabbed", "vintage", "collectible", "collectibles",
  "trading", "tcg", "rare", "expensive", "valuable", "best", "top", "high", "end", "high-end", "market",
]);

/** The words to search for: no accents, no punctuation but #-/&., no filler, at most six. */
export function searchWords(query: string): string[] {
  const plain = query.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9#&./' -]+/g, " ");
  const words = plain.split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w.toLowerCase()));
  return (kept.length ? kept : words).slice(0, 6);
}

/**
 * Cards matching `query`, the most relevant first, from Collector Crypt's live search. A search
 * that finds nothing drops its last word and tries again (at most two more requests). Errors and
 * timeouts give an empty list: a basket never waits on cards.
 */
export async function searchCards(query: string, limit = 8, fetchFn: typeof fetch = fetch): Promise<Security[]> {
  const words = searchWords(query.slice(0, 100));
  for (let n = words.length, tries = 0; n > 0 && tries < 3; n--, tries++) {
    const found = await searchOnce(words.slice(0, n).join(" "), limit, fetchFn);
    if (found === null) return []; // CC failed or timed out: don't keep trying
    if (found.length) return found;
  }
  return [];
}

/** One search request: the cards found (maybe none), or null when the request failed. */
async function searchOnce(q: string, limit: number, fetchFn: typeof fetch): Promise<Security[] | null> {
  const url = `${CC_API}/marketplace?${new URLSearchParams({ step: String(Math.min(25, limit * 2)), search: q })}`;
  try {
    const res = await fetchFn(url, {
      headers: { "user-agent": "thesis-take-builder/1.0", accept: "application/json" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`card search: Collector Crypt answered ${res.status}`);
      return null;
    }
    const body = await res.json();
    const rows: unknown[] = Array.isArray(body?.filterNFtCard) ? body.filterNFtCard : [];
    const out: Security[] = [];
    for (const r of rows) {
      const s = cardSecurity(r);
      if (s && !out.some((o) => o.id === s.id)) out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  } catch (e) {
    console.error("card search failed:", (e as Error).message);
    return null;
  }
}

type Weighted = { s: Pick<Security, "kind">; weight: number };

/**
 * Whether a take is about cards or collectibles themselves (then the basket may
 * be all cards). Words a card take uses; card words that mean something else (credit card, gift
 * card, graphics card, ...) don't count. Accents are stripped first, so "Pokémon" matches.
 */
const CARD_TAKE = /\b(trading cards?|cards?|tcg|pokemon|pikachu|charizard|one piece|yu-?gi-?oh|magic the gathering|mtg|psa ?\d*|bgs|cgc|graded|slabs?|slabbed|collectibles?|collector crypt|rookie cards?|topps|panini|booster box(es)?|sealed product)\b/i;
const NOT_CARDS = /\b(credit|debit|gift|sim|sd|graphics?|video|report|green|id|business|wild) cards?\b/gi;

export function isCardTake(text: string): boolean {
  const plain = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(NOT_CARDS, " ");
  return CARD_TAKE.test(plain);
}

/**
 * At most one card, at most 20%, never alone, unless the take is about cards
 * (`cardTake`): then cards are like any other pick, as many and as much as the
 * basket's other rules allow, alone included. Extra cards are dropped and a
 * basket that would be only a card loses it (empty, so the caller falls back). With a card, the
 * weights come back as whole percents adding up to 100, the card's at most 20 (cut to 20 and the
 * rest scaled up when it was more), so `normalize`'s rounding can't push it past the cap.
 */
export function capCards<T extends Weighted>(picks: T[], cardTake = false): T[] {
  if (cardTake) return picks;
  let seen = false;
  const kept = picks.filter((p) => p.s.kind !== "card" || (!seen && (seen = true)));
  const card = kept.find((p) => p.s.kind === "card");
  if (!card) return kept;
  const others = kept.filter((p) => p !== card);
  if (!others.length) return [];
  const w = (p: T) => Math.max(p.weight, 0);
  const total = kept.reduce((a, p) => a + w(p), 0) || 1;
  const cardWeight = Math.max(1, Math.min(MAX_CARD_WEIGHT, Math.round((w(card) / total) * 100)));
  // The others share the rest in whole percents (largest remainder).
  const rest = others.reduce((a, p) => a + w(p), 0) || 1;
  const exact = others.map((p) => (w(p) / rest) * (100 - cardWeight));
  const whole = exact.map(Math.floor);
  let left = 100 - cardWeight - whole.reduce((a, b) => a + b, 0);
  for (const i of exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if (left <= 0) break;
    whole[i]++;
    left--;
  }
  return kept.map((p) => ({ ...p, weight: p === card ? cardWeight : whole[others.indexOf(p)] }));
}
