// take-builder: turns a take ("AI power demand is underrated.") into a basket in ~2-3 s.
//
//   POST { claim, risk: "low"|"medium"|"high",
//          include?: [assetId], source?: { text, label?, kind?: "post"|"article"|"holdings" } }
//                                                      build (include: picks the basket must keep;
//                                                      source: what the take copies. Holdings, or a
//                                                      post's $cashtags, naming 2+ buyable things
//                                                      make the basket exactly those)
//   POST { ..., mode: "edit", legs: [{ id, weight, why, side? }], ask: "add NVDA" }
//                                                      change the basket the way the ask says
//   POST { ..., mode: "risk", legs: [...] }            new risk, same picks: swaps only the cash
//                                                      (low) or leveraged (high) pick, no model call
//   legs[].leverage: 1, or for a perp the leverage chosen for it (by the model from the risk and
//   how directly it's the take, at most 5x and the market's max; 2x when there's no model call)
//   There's no horizon: a take runs until its author sells their buy-in, or 365 days at most. An
//   old client's horizon is ignored.
//   header privy-token: <jwt>
//   → { verdict: "basket"|"no_clean_exposure", summary, reason, legs: [...], note, ms, picker }
//     note: why an edit didn't do what was asked ("NVIDIA isn't available in the US yet.")
//
// How (replaces the gte-small embedding search):
//   1. A BM25 index over everything a basket can hold (public.basket_catalog(): ~16,000 rows,
//      names, tickers, themes, prediction questions), built in the worker and cached. No
//      descriptions or embeddings needed.
//   2. Every spot name, perp and the deepest cash vaults (~200, names, tickers and a few words on
//      what each is) are listed at the end of the system prompt, the same text every call
//      (prompt-cached), so stocks never need a search. Prediction markets (thousands) are
//      BM25-searched on the take's words up front; the model (reasoning low, priority tier) calls
//      `search` only for a market the take is about that wasn't found (a team by its city), and a
//      search that finds nothing new costs no extra round (the tools-off answer runs alongside).
//      Most builds are one model call.
//   3. It answers with picks by number and name, from what search showed it. The harness checks
//      every pick (shown, number and name agree, one per underlying, the risk's kinds, a copy only
//      what it copies, weights sum to 100) and drops one the model says falls if the take is right
//      (gains_if_right; a bearish post's $cashtags aren't copied as buys). When nothing listed is in
//      the take (nuclear, utilities, airlines today), it answers no_clean_exposure rather than a
//      stand-in. If the model is slow or fails, the names the take or source spell out go in
//      instead (picker: "rules").
//
// Cards (cards.ts): at medium and high risk the model also gets a `cards`
// tool, a live Collector Crypt search. A take about cards (isCardTake) may be
// all cards; any other take may add one card at up to 20% when a card fits it.
// A picked card gets a securities row (card:<cardId>) before the reply, so the take can link to it.
//
// Warm-up: GET builds the index, so the real request skips that. The app sends it when the
// composer opens.
//
// Admin testing: send x-index-secret instead of a Privy token. Adds the searches the model ran
// and its raw answer to the reply (debug).
//
// Secrets: OPENAI_API_KEY, OPENAI_FAST_MODEL (gpt-6-luna), TAKE_AGENT_TIMEOUT_MS,
// SECURITIES_INDEX_SECRET, US_RESTRICTIONS, PRIVY_* (+ platform SUPABASE_*).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { privyDid } from "../_shared/privy.ts";
import { FAST_MODEL, type Tool, toolCall } from "../_shared/openai.ts";
import { BM25, tokenize } from "../_shared/bm25.ts";
import { assetKey, available, BASKET_KINDS, displayName, firstSentence, SECURITY_COLUMNS, textSearch, treatAsUS, type Security, US_RESTRICTIONS, withLiveApy } from "../_shared/catalog.ts";
import { capCards, CARD_PREFIX, cardAbout, isCardTake, searchCards } from "./cards.ts";

/** What the model is told about cards for this take (the `cards` field of its input). */
const cardRule = (cardTake: boolean) => cardTake
  ? "This take is about cards: the basket can be all cards (up to 5), or cards with stocks that move with them."
  : "At most one card, at most 20% of the basket, never the only pick.";
import { applyHouseRules, MAX_LEVERAGE, MAX_PERP_WEIGHT, RULES_LEVERAGE } from "./rules.ts";

/** Every yield pick is traded as a Jupiter Lend jlUSDC deposit (scripts/fork/api/legs.ts), so it's the one yield row offered: another vault's APY would be a rate the pick never earns. */
const TRADED_YIELD_VENUE = "Jupiter Lend Earn";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const INDEX_SECRET = Deno.env.get("SECURITIES_INDEX_SECRET") ?? "";
/** The whole model exchange, searches included. Past it, the rules basket goes out. */
const AGENT_TIMEOUT_MS = Number(Deno.env.get("TAKE_AGENT_TIMEOUT_MS") ?? 8000);

const SPOT = new Set(["stock", "etf", "commodity", "pre-ipo", "leveraged", "other"]);
/** A take runs until its author sells, or this long at most (it then settles at that day's prices). */
const TAKE_LIFETIME_DAYS = 365;
/**
 * The last day a take posted now can run (YYYY-MM-DD), for the model: prediction markets that
 * resolve by it are preferred; later ones are allowed (the take exits them at the bid).
 */
const endsBy = () => new Date(Date.now() + TAKE_LIFETIME_DAYS * 86_400_000).toISOString().slice(0, 10);

type Role = "core" | "second_order" | "prediction" | "yield" | "leverage";
/** `leverage`: 1 for everything but a perp, whose leverage the model picks (see `leverageFor`). */
type Pick = { s: Security; role: Role; weight: number; why: string; side: "long" | "yes" | "no"; purity: string; leverage: number };

/** The most leverage a perp pick can have (rules.ts), and never above its market's own max. */
const capFor = (maxLeverage: unknown) => Math.max(1, Math.min(MAX_LEVERAGE, Math.floor(Number(maxLeverage ?? MAX_LEVERAGE))));
const leverageCap = (s: Security) => capFor(s.data?.maxLeverage);
/** A pick's leverage within its cap: 1 unless it's a perp. */
const leverageFor = (s: Security, wanted: number) => (s.kind === "perp" ? Math.max(1, Math.min(leverageCap(s), Math.round(wanted) || 1)) : 1);
/**
 * When there's no model call (the rules fallback, a switch to high risk, an "add" by name): 2x.
 * A take can run up to a year, and a leveraged position held longer has longer to hit its
 * liquidation price on the way.
 */
const ruleLeverage = (s: Security) => leverageFor(s, RULES_LEVERAGE);
/**
 * The house rules on the final basket (rules.ts): one pick per name, the 30% perp cap, the 5x
 * leverage ceiling; then the card rules (cards.ts): one card, at most 20%, never alone,
 * unless the take is about cards (`cardTake`).
 * The perp cap hands its excess to the other picks, which can lift a card past 20%, and cutting
 * the card can lift a perp, so the two run again until both hold (a few rounds at most). If they
 * can't both hold (a card and a perp only), the card's cap wins.
 */
const finalize = (ps: Pick[], cardTake = false) => {
  const house = (xs: Pick[]) =>
    applyHouseRules(xs, (p) => ({ kind: p.s.kind, key: key(p.s), weight: p.weight, leverage: p.leverage }), (p, weight, leverage) => ({ ...p, weight, leverage }));
  let out = capCards(house(ps), cardTake);
  for (let round = 0; round < 4 && out.length > 1 && out.some((p) => p.s.kind === "perp" && p.leverage > 1 && p.weight > MAX_PERP_WEIGHT); round++) out = capCards(house(out), cardTake);
  return out;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sameSecret(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const key = (s: Security) => assetKey(s);
const MAX_LEGS = 10;
const descriptionOrName = (s: Security) => firstSentence(s.description) ?? s.name;

// --- 1. The search index --------------------------------------------------------------------

/** One catalog row as search needs it (public.basket_catalog). */
type Row = {
  id: string; kind: string; symbol: string; name: string; underlying: string | null; themes: string[];
  question: string | null; outcome: string | null; expires: string | null; us: string;
  maxLeverage: number | null; apy: number | null; depth: number; category: string | null;
  /** What it is, for the listed rows (spot, perps, cash), from their catalog description; markets have none. */
  about?: string;
};
/** `listed`: per US-or-not, the spot names, perps and cash every prompt lists (see `listedFor`). */
type Index = { rows: Row[]; bm25: BM25; listed: Map<boolean, Listed> };
/** What every prompt lists by number, 1..n: few enough (~200) to show whole, so only markets need searching. */
type Listed = { rows: Row[]; text: string };

const INDEX_TTL_MS = 10 * 60_000;
let cached: { at: number; index: Promise<Index> } | null = null;

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
/** A description's first sentence, cut to `n` characters; none when it only guesses from the name. */
const VAGUE = /\bname (alone )?(does not|doesn't|suggests|identifies)|cannot be (reliably )?identified|is unclear|does not identify|not (clearly )?specified/i;
function short(d: string | null | undefined, n: number): string | undefined {
  const t = (firstSentence(d) ?? "").replace(/\s+/g, " ").trim();
  if (!t || VAGUE.test(t)) return undefined;
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t;
}

async function buildIndex(): Promise<Index> {
  // The ~200 rows the prompt lists get a few words on what they are (Roblox is games, not
  // robots); the thousands of markets need none, their question says it.
  const [{ data, error }, abouts] = await Promise.all([
    db.rpc("basket_catalog"),
    db.from("securities").select("id, description").neq("kind", "prediction").eq("liquidity", "tradeable"),
  ]);
  if (error) throw error;
  const aboutOf = new Map(((abouts.data ?? []) as { id: string; description: string | null }[]).map((r) => [r.id, r.description]));
  const rows: Row[] = (data as unknown[][]).map((r) => ({
    id: r[0] as string, kind: r[1] as string, symbol: r[2] as string, name: r[3] as string, underlying: r[4] as string | null,
    themes: (r[5] as string[] | null) ?? [], question: r[6] as string | null, outcome: r[7] as string | null,
    expires: r[8] as string | null, us: r[9] as string, maxLeverage: r[10] as number | null, apy: r[11] as number | null,
    depth: Number(r[12] ?? 0), category: r[13] as string | null,
    about: r[1] === "prediction" ? undefined : short(aboutOf.get(r[0] as string), 70),
  }));
  // Names and tickers count most; a prediction's question and outcome are its name.
  const docs = rows.map((r): [string, number][] => r.kind === "prediction"
    ? [[r.question ?? r.name, 2], [r.outcome ?? "", 2], [r.category ?? "", 1]]
    : [[displayName(r.name), 3], [`${r.symbol} ${r.underlying ?? ""}`, 3], [r.themes.join(" "), 1],
      [r.kind === "perp" ? "perp leverage" : r.kind === "yield" ? "cash yield interest savings" : r.kind, 1]]);
  return { rows, bm25: new BM25(docs), listed: new Map() };
}

const LISTED_ORDER = ["stock", "etf", "commodity", "pre-ipo", "leveraged", "other", "perp", "yield"];
const CASH_SLOTS = 3;

/**
 * The spot names (one per company), perps and the deepest few cash vaults this user can buy, in a
 * fixed order, as numbered lines. It goes at the end of the system prompt, the same for every
 * request until the index rebuilds, so it's prompt-cached; prediction markets (thousands) are
 * found by search instead.
 */
function listedFor(index: Index, usPerson: boolean): Listed {
  const hit = index.listed.get(usPerson);
  if (hit) return hit;
  const ok = index.rows.filter((r) => r.kind !== "prediction" && available({ us_persons: r.us }, usPerson) && (displayName(r.name) || r.symbol));
  const companies = new Set<string>();
  const spot: Row[] = [];
  for (const r of ok.filter((r) => SPOT.has(r.kind)).sort((a, b) => LISTED_ORDER.indexOf(a.kind) - LISTED_ORDER.indexOf(b.kind) || b.depth - a.depth)) {
    const company = r.underlying ?? r.symbol;
    if (companies.has(company)) continue;
    companies.add(company);
    spot.push(r);
  }
  const byName = (a: Row, b: Row) => LISTED_ORDER.indexOf(a.kind) - LISTED_ORDER.indexOf(b.kind) || displayName(a.name).localeCompare(displayName(b.name));
  const rows = [
    ...spot.sort(byName),
    ...ok.filter((r) => r.kind === "perp").sort(byName),
    ...ok.filter((r) => r.kind === "yield").sort((a, b) => b.depth - a.depth).slice(0, CASH_SLOTS),
  ];
  const listed = { rows, text: rows.map((r, i) => line(r, i + 1)).join("\n") };
  index.listed.set(usPerson, listed);
  return listed;
}

/** A request's numbering: the listed rows first, at their fixed numbers. */
function shownFor(index: Index, usPerson: boolean): { shown: Shown; listed: Listed } {
  const listed = listedFor(index, usPerson);
  const shown = new Shown();
  for (const r of listed.rows) shown.add(r);
  return { shown, listed };
}

/**
 * The index, built once per worker and rebuilt every few minutes (the catalog changes when the
 * indexer runs). Reading the catalog takes ~1.5 s, so a stale index keeps serving while the next
 * one builds; only a cold worker waits (the app's warm-up GET covers that).
 */
let building: Promise<Index> | null = null;
function indexFor(): Promise<Index> {
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.index;
  if (!building) {
    building = buildIndex();
    building.then((index) => (cached = { at: Date.now(), index: Promise.resolve(index) }))
      .catch((e) => console.error("index build failed:", e))
      .finally(() => (building = null));
  }
  return cached?.index ?? building;
}

function rowOf(s: Security): Row {
  return {
    id: s.id, kind: s.kind, symbol: s.symbol, name: s.name, underlying: s.underlying, themes: s.themes ?? [],
    question: (s.data?.eventTitle as string | undefined) ?? null, outcome: (s.data?.label as string | undefined) ?? null,
    expires: s.expires_at, us: s.us_persons, maxLeverage: (s.data?.maxLeverage as number | undefined) ?? null,
    apy: (s.data?.apyPct as number | undefined) ?? null, depth: 0, category: null,
    ...(s.kind === "card" ? { about: cardAbout(s) } : {}),
  };
}

/** What the model has been shown this request, by number. It can only pick these. */
class Shown {
  private rows: Row[] = [];
  private numbers = new Map<string, number>();
  add(r: Row): number {
    let n = this.numbers.get(r.id);
    if (!n) {
      this.rows.push(r);
      this.numbers.set(r.id, (n = this.rows.length));
    }
    return n;
  }
  get(n: number): Row | undefined {
    return this.rows[n - 1];
  }
  get size(): number {
    return this.rows.length;
  }
  /**
   * The row a pick means: its number, checked against the name the model gave it, since a fast
   * model sometimes cites the wrong number from a long list. On a mismatch, the shown row that
   * best matches the name; none → undefined (the pick is dropped).
   */
  resolve(n: number, name: string): Row | undefined {
    const words = new Set(tokenize(name));
    const overlap = (r: Row) => tokenize(`${displayName(r.name)} ${r.symbol} ${r.underlying ?? ""} ${r.outcome ?? ""}`).filter((w) => words.has(w)).length;
    const byNumber = this.get(n);
    if (byNumber && (!words.size || overlap(byNumber) > 0)) return byNumber;
    let best: Row | undefined, score = 0;
    for (const r of this.rows) {
      const o = overlap(r);
      if (o > score) (best = r, score = o);
    }
    return best;
  }
}

/** One line per result: `12 stock NVIDIA (NVDA)`, `40 prediction Fed decision in December? → Cut 25bps (resolves 2026-12-11)`. */
function line(r: Row, n: number): string {
  const name = displayName(r.name) || r.symbol;
  const ticker = r.underlying && r.underlying !== "USDC" ? ` (${r.underlying})` : "";
  switch (r.kind) {
    case "prediction": return `${n} prediction ${r.question ?? r.name} → ${r.outcome ?? r.name} (resolves ${day(r.expires)})`;
    case "perp": return `${n} perp ${name}${ticker}, up to ${capFor(r.maxLeverage)}x`;
    case "yield": return `${n} cash ${name}${r.apy ? `, ${r.apy.toFixed(1)}% a year` : ""}`;
    default: return `${n} ${r.kind} ${name}${ticker}${r.about ? `: ${r.about}` : ""}`;
  }
}

const KINDS: Record<string, (k: string) => boolean> = {
  any: () => true,
  stock: (k) => k === "stock" || k === "pre-ipo" || k === "leveraged" || k === "other",
  etf: (k) => k === "etf",
  commodity: (k) => k === "commodity",
  prediction: (k) => k === "prediction",
  perp: (k) => k === "perp",
  cash: (k) => k === "yield",
};

/**
 * BM25 over the catalog, as numbered lines. Spot names once per company (the most traded issuer),
 * at most four outcomes per prediction question, ties to the deeper market.
 */
function search(index: Index, shown: Shown, query: string, kind: string, usPerson: boolean, limit = 12): string {
  const ok = KINDS[kind] ?? KINDS.any;
  const soonest = Date.now() + 60 * 60_000;
  const hits = index.bm25.search(query, 300, (d) => {
    const r = index.rows[d];
    // A prediction market needs an expiry (one with none is a stale row); other kinds have none.
    return ok(r.kind) && available({ us_persons: r.us }, usPerson) &&
      (r.expires ? Date.parse(r.expires) > soonest : r.kind !== "prediction");
  }).sort((a, b) => (b.score - a.score) || (index.rows[b.doc].depth - index.rows[a.doc].depth));
  const lines: string[] = [];
  const companies = new Set<string>();
  const questions = new Map<string, number>();
  for (const { doc } of hits) {
    const r = index.rows[doc];
    if (SPOT.has(r.kind)) {
      const company = r.underlying ?? r.symbol;
      if (companies.has(company)) continue;
      companies.add(company);
    } else if (r.kind === "prediction") {
      const q = `${r.question}|${day(r.expires)}`;
      if ((questions.get(q) ?? 0) >= 4) continue;
      questions.set(q, (questions.get(q) ?? 0) + 1);
    }
    lines.push(line(r, shown.add(r)));
    if (lines.length >= limit) break;
  }
  return lines.length ? lines.join("\n") : `Nothing matches "${query}". Try a company, ticker, team's city, person or event name.`;
}

/**
 * Prediction markets on the take's own words, for the prompt: only ones that match at least two of
 * its words (or its only word) and score near the best, so a shared word like "power" doesn't
 * bring in a golfer. Empty is fine: the model can search.
 */
function marketsFor(index: Index, shown: Shown, text: string, usPerson: boolean, limit = 10): string {
  const words = new Set(tokenize(text, true)).size;
  const soonest = Date.now() + 60 * 60_000;
  const hits = index.bm25.search(text, 200, (d) => {
    const r = index.rows[d];
    return r.kind === "prediction" && available({ us_persons: r.us }, usPerson) && !!r.expires && Date.parse(r.expires) > soonest;
  });
  const top = hits[0]?.score ?? 0;
  const good = hits.filter((h) => h.matched >= Math.min(2, words) && h.score >= top * 0.6)
    .sort((a, b) => (b.score - a.score) || (index.rows[b.doc].depth - index.rows[a.doc].depth));
  const lines: string[] = [];
  const questions = new Map<string, number>();
  for (const { doc } of good) {
    const r = index.rows[doc];
    const q = `${r.question}|${day(r.expires)}`;
    if ((questions.get(q) ?? 0) >= 4) continue;
    questions.set(q, (questions.get(q) ?? 0) + 1);
    lines.push(line(r, shown.add(r)));
    if (lines.length >= limit) break;
  }
  return lines.join("\n") || "none on this take's words";
}

function searchTool(index: Index, shown: Shown, usPerson: boolean): Tool {
  return {
    name: "search",
    description: "Search prediction markets (and anything else not in the list) by the words of a market's question: " +
      "the event, person, team (teams go by city, e.g. Green Bay for the Packers), asset or date. One idea per query; " +
      "call it several times at once.",
    parameters: {
      type: "object", additionalProperties: false, required: ["query", "kind"],
      properties: {
        query: { type: "string", description: "e.g. \"Fed decision December\", \"BTC price November 30\", \"Green Bay Minnesota\", \"Stripe IPO\"" },
        kind: { type: "string", enum: Object.keys(KINDS) },
      },
    },
    run: (args) => search(index, shown, String(args.query ?? ""), String(args.kind ?? "any"), usPerson),
  };
}

/**
 * The same search without the in-memory index: Postgres full-text on securities.search_doc
 * (websearch syntax) plus search_securities (tickers and names), for the eval's "no index" variant.
 */
async function dbSearch(shown: Shown, query: string, kind: string, usPerson: boolean, limit = 12): Promise<string> {
  const ok = KINDS[kind] ?? KINDS.any;
  const kinds = [...BASKET_KINDS].filter(ok);
  const soonest = new Date(Date.now() + 60 * 60_000).toISOString();
  const [fts, byName] = await Promise.all([
    db.from("securities").select(SECURITY_COLUMNS).eq("liquidity", "tradeable").in("kind", kinds)
      .or(`and(expires_at.is.null,kind.neq.prediction),expires_at.gt.${soonest}`).textSearch("search_doc", query, { type: "websearch", config: "english" }).limit(40),
    textSearch(db, query, usPerson, 10),
  ]);
  const lines: string[] = [];
  const companies = new Set<string>();
  const questions = new Map<string, number>();
  for (const s of [...byName.filter((s) => ok(s.kind)), ...((fts.data ?? []) as Security[])]) {
    if (!available(s, usPerson)) continue;
    const r = rowOf(s);
    if (SPOT.has(r.kind)) {
      const company = r.underlying ?? r.symbol;
      if (companies.has(company)) continue;
      companies.add(company);
    } else if (r.kind === "prediction") {
      const q = `${r.question}|${day(r.expires)}`;
      if ((questions.get(q) ?? 0) >= 4) continue;
      questions.set(q, (questions.get(q) ?? 0) + 1);
    }
    lines.push(line(r, shown.add(r)));
    if (lines.length >= limit) break;
  }
  return lines.length ? lines.join("\n") : `Nothing matches "${query}". Try a company, ticker, team's city, person or event name.`;
}

function dbSearchTool(shown: Shown, usPerson: boolean): Tool {
  return {
    name: "search",
    description: "Search everything a basket can hold (stocks, ETFs, commodities, pre-IPO, perps, cash, prediction markets) by " +
      "name, ticker or the words of a market's question (teams go by city). One idea per query; call it as often as you like.",
    parameters: {
      type: "object", additionalProperties: false, required: ["query", "kind"],
      properties: { query: { type: "string" }, kind: { type: "string", enum: Object.keys(KINDS) } },
    },
    run: (args) => dbSearch(shown, String(args.query ?? ""), String(args.kind ?? "any"), usPerson),
  };
}

/** Collector Crypt cards, searched live (cards.ts). What it finds goes in `found`, by id, for the picks. */
function cardsTool(shown: Shown, found: Map<string, Security>): Tool {
  return {
    name: "cards",
    description: "Search graded trading cards and other collectibles on Collector Crypt (Pok\u00e9mon, One Piece, sports, " +
      "Yu-Gi-Oh!, sealed product\u2026) by card name, player, character, set or grade. Each result shows what the card is worth. " +
      "Use short queries made of words in a card's title (\"Charizard\", \"Charizard PSA 10\", \"Michael Jordan\", \"Pikachu\"), " +
      "not descriptions (\"graded\", \"vintage\" or \"cards\" match nothing).",
    parameters: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: { query: { type: "string", description: "e.g. \"Charizard PSA 10\", \"Michael Jordan rookie\", \"Monkey D. Luffy\"" } },
    },
    run: async (args) => {
      const cards = await searchCards(String(args.query ?? ""));
      for (const c of cards) found.set(c.id, c);
      return cards.length ? cards.map((c) => line(rowOf(c), shown.add(rowOf(c)))).join("\n") : `No cards match "${String(args.query ?? "")}".`;
    },
  };
}

// --- 2. The model picks ---------------------------------------------------------------------

/** Kinds a fresh basket can hold at each risk (an edit can add any). */
const RISK_KINDS: Record<string, (kind: string) => boolean> = {
  low: (k) => k !== "perp" && k !== "card",
  medium: (k) => k !== "perp" && k !== "yield",
  high: (k) => k !== "yield",
};

const RISK_RULES: Record<string, string> = {
  low: "Low risk: up to 4 picks (a perp at leverage 1 only for a name with no stock listed). Spread out, prefer big well-known companies and broad ETFs. Include exactly one cash pick at 20-30%.",
  medium: "Medium risk: up to 5 picks of stocks/ETFs/commodities (a perp at leverage 1 only for a name with no stock listed), fewer when fewer fit directly. Add one prediction market (10-20%) only if one asks about this take.",
  high: "High risk: up to 4 picks, concentrated in the purest names. You may use one perp (max 30%, or the whole basket when it's the only pick) on a name the take is about, in place of that name's stock: never both. " +
    "Choose its leverage, from 2 up to its max (at most 5x): more for a name that IS the take, less for a looser fit. " +
    "The take may be held up to a year, and a leveraged bet held longer is likelier to be liquidated on the way.",
};

type Picked = {
  verdict: "basket" | "no_clean_exposure";
  bearish?: boolean;
  summary: string;
  reason: string;
  picks: { n: number; name: string; weight: number; side: "yes" | "no"; gains_if_right?: boolean; why: string; leverage: number }[];
};

const PICK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["verdict", "bearish", "summary", "reason", "picks"],
  properties: {
    verdict: { type: "string", enum: ["basket", "no_clean_exposure"] },
    /** The take (or the post it copies) expects what it names to fall: its $cashtags aren't buys. */
    bearish: { type: "boolean" },
    summary: { type: "string" },
    reason: { type: "string" },
    picks: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["n", "name", "weight", "side", "gains_if_right", "why", "leverage"],
        properties: {
          n: { type: "integer" },
          /** As shown (for a prediction, the outcome): checked against n. */
          name: { type: "string" },
          weight: { type: "number" },
          side: { type: "string", enum: ["yes", "no"] },
          /** Does this pick (on its side) go up if the take comes true? A new basket drops the ones that don't. */
          gains_if_right: { type: "boolean" },
          why: { type: "string" },
          leverage: { type: "integer" },
        },
      },
    },
  },
};

const BUILD_SYSTEM = [
  "You build an investment basket for a take (an opinion) on Thesis, a social trading app.",
  "Everything listed at the end (stocks, ETFs, commodities, pre-IPO, perps, cash) can go in a basket. Prediction",
  "markets aren't listed: markets is a search of them on the take's own words. Pick by number, with the name as shown.",
  "Call search only when the take is about one specific event, person, team or date (a game, a season title, an",
  "election, an award, an IPO, a price on a day) and markets doesn't show that event's market: search its question",
  "words (a team by its city), all at once. A company, sector, theme, country or broad market take never needs a",
  "search, and nothing listed is ever searched for: answer right away.",
  "Pick what pays off most directly if the take is right: the names the take is about first, then second-order winners",
  "(suppliers, picks and shovels). Two direct picks beat five loose ones: never add a pick whose why has to stretch,",
  "and never one that moves against the take. Skip anything only loosely related, and never stand in a lookalike for a company",
  "that isn't listed (no generic AI name for a take about one AI company).",
  "Every pick must be IN what the take is about: that company, that sector's own companies, that commodity, that country.",
  "A side project, a customer or a different sector doesn't count (Lockheed isn't nuclear power, SpaceX isn't robotaxis,",
  "a cinema chain isn't doughnuts, oil isn't copper or natural gas), and neither does a broad index for a narrower take",
  "(the S&P 500 isn't a utilities, airline, bank or Brazil bet). The S&P 500 and Nasdaq are for takes on the US market or",
  "economy as a whole. When nothing listed is in it, the answer is no_clean_exposure: an honest \"nothing fits yet\" beats",
  "a basket that doesn't move with the take.",
  "Direction: every pick must gain if the take is right. A bearish take (a company, sector or the economy slumps, is in",
  "trouble, loses customers, crashes, is a bubble) never gets that company, its rivals or the broad market bought as a",
  "stand-in: use no on a market about it or an inverse fund on it (an inverse Nasdaq fund for a tech or market crash).",
  "With neither, no_clean_exposure. A company whose own product causes the slump can go in (a GLP-1 drug maker when",
  "food sales fall).",
  "A perp is how you hold a company the take is about when it has no stock listed (Eli Lilly, Netflix): at low and",
  "medium risk too, at leverage 1.",
  "If there's a source (an X post, an article, a fund's or trader's holdings or trades), it's what the take copies:",
  "hold what the source names, at the weights it gives or implies. When the source lists picks, don't pad with names",
  "it doesn't hold (fewer picks is fine, risk_rules' counts don't apply); add others only when the source states a",
  "view without naming enough to buy. Never say in a why that something is missing.",
  "Follow risk_rules. Weights sum to 100. Max one pick per company: its stock or its perp, never both. A single pick is fine when",
  "one asset is the take (e.g. gold). keep: numbers the user already chose; include them and build around them.",
  "A perp only on a name the take is about, that's already in the basket, or that has no stock listed (the perp is",
  "the only way to hold it); never as filler.",
  "Prediction markets: only one whose question is about this take, never a different event. Pick the outcome that",
  "matches the take exactly (\"the Fed holds\": the hold outcome, yes, not a hike); on a price ladder, the outcome at",
  "the take's own number (\"above 5\": the one at 5); if no outcome sits at that number, leave the market out rather than",
  "take a harder bet.",
  "A take about one event (a game, a title, an election, an award, a review score, an IPO, a deal, a price on a day)",
  "whose market is shown: the basket is that market, alone, or with at most one stock that profits directly from that",
  "exact outcome. Never pad it with loosely related companies; risk_rules' pick counts don't apply to it.",
  "Of the markets that fit, prefer the one on the take's own timeframe when it names one (\"by December\"), and one",
  "that resolves by ends_by (a year from today, the longest a take runs). One resolving after ends_by is allowed:",
  "the take exits it at its price then.",
  "side: yes for everything; for a prediction market, yes or no, whichever the take implies. Everything is bought: to",
  "bet against something, use no on its market or an inverse fund, never its stock, and never call a pick a short.",
  "leverage: 1 for everything except a perp.",
  "bearish: true when the take, or the post it copies, expects the companies or things it names to fall (\"foot",
  "traffic at $MCD is falling\"); a post's $cashtags are then what it's against, never what to hold.",
  "gains_if_right: true only when that pick, on its side, goes up if the take comes true. A pick that would fall (a",
  "restaurant's stock on \"restaurants are in trouble\") is false, and false picks are thrown out: leave them out.",
  "Cards (only when you have the cards tool): a collectible card is a pick when it moves with the take: the take is",
  "about collectibles, or a card tied to it (a Pok\u00e9mon card on a Nintendo take, a player's rookie card on their",
  "season). Search cards for it; how many cards and how much of the basket follows `cards` in the input.",
  "no_clean_exposure when the take states no market view at all (a greeting, a feeling) or nothing listed or",
  "found is in it and moves with it. A broad view still gets a basket when something listed is in it: \"buy the dip\" the",
  "S&P 500 fund, a country's boom that country's companies or fund, a commodity theme its miners or the commodity. Then",
  "reason = one short sentence why, empty picks; otherwise reason = \"\".",
  "A prediction market goes in only when its question is this take's own question: a take on a company's sales never",
  "gets a market on a deal, a stake or a lawsuit about that company.",
  "summary: max 18 words, what has to be true for the take to pay off. why: max 12 words, how the pick ties to THIS",
  "take, and true of that pick (never call an asset something it isn't: gold isn't copper, Roblox isn't robotics).",
  "Plain words for a non-investor; never mention tokens, chains, USDC or wallets.",
].join(" ");

/** For variants with nothing listed: the model finds everything by searching, as much as it likes. */
const AGENT_SYSTEM = BUILD_SYSTEM.replace(
  /Everything listed at the end[\s\S]*?answer right away\./,
  "Nothing is listed: find everything by calling search, as many times and rounds as you need (companies and funds " +
    "by name or ticker, the commodity, a perp at high risk, cash at low risk, the prediction market on the event by its " +
    "question words, a team by its city), several searches at once per round. markets, when present, is a search of " +
    "prediction markets on the take's own words. Pick only by the numbers search showed you, with the name as shown.",
).replace("that isn't listed", "that search can't find");

/** The system prompt: the rules, then everything listed (the same text every call, so it's cached). */
const withListed = (system: string, listed: Listed) => `${system}\n\nListed (number kind name):\n${listed.text}`;

/**
 * What a take copies. kind: "holdings" (a fund's or trader's positions: the basket is what they
 * hold), "post" (an X post) or "article". A post's $cashtags count as holdings too.
 */
type Source = { text: string; label: string | null; kind: "holdings" | "post" | "article" };
const sourceJSON = (s: Source) => ({ kind: s.kind, from: s.label ?? `a ${s.kind}`, text: s.text });

type Agent = { out: Picked; calls: string[]; rounds: number; model: string; speculated?: boolean };

/**
 * How a build runs. The defaults are what ships; an admin request (the eval) can try others
 * without a redeploy: no listed catalog, no up-front market search, more search rounds, a search
 * that goes to Postgres instead of the in-memory index, or some reasoning.
 */
type Variant = {
  listed: boolean; markets: boolean; rounds: number; speculate: boolean;
  search: "bm25" | "db"; reasoning: "none" | "low" | "medium"; timeoutMs: number;
};
// Reasoning low (from the 100-case eval): same quality as none, and the model
// is sure enough to skip searches, so p90 fell from 5.8 s to 4.0 s.
const SHIPPED: Variant = { listed: true, markets: true, rounds: 2, speculate: true, search: "bm25", reasoning: "low", timeoutMs: AGENT_TIMEOUT_MS };

function variantOf(raw: unknown): Variant {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = <T>(k: keyof Variant, ok: (x: unknown) => boolean, d: T): T => (ok(v[k]) ? v[k] as T : d);
  return {
    listed: pick("listed", (x) => typeof x === "boolean", SHIPPED.listed),
    markets: pick("markets", (x) => typeof x === "boolean", SHIPPED.markets),
    rounds: Math.max(1, Math.min(10, pick("rounds", (x) => Number.isInteger(x), SHIPPED.rounds))),
    speculate: pick("speculate", (x) => typeof x === "boolean", SHIPPED.speculate),
    search: pick("search", (x) => x === "bm25" || x === "db", SHIPPED.search),
    reasoning: pick("reasoning", (x) => x === "none" || x === "low" || x === "medium", SHIPPED.reasoning),
    timeoutMs: Math.max(2000, Math.min(45_000, pick("timeoutMs", (x) => Number.isFinite(x), SHIPPED.timeoutMs))),
  };
}

async function runAgent(system: string, input: unknown, index: Index, shown: Shown, usPerson: boolean, maxTokens: number, v: Variant = SHIPPED, extra: Tool[] = []): Promise<Agent | null> {
  // Speculate: if the model's searches only show it what it already had, its tools-off answer
  // (asked for in parallel) goes out without a second round.
  const before = shown.size;
  const tool = v.search === "db" ? dbSearchTool(shown, usPerson) : searchTool(index, shown, usPerson);
  try {
    const r = await toolCall<Picked>(system, input, [tool, ...extra], "basket", PICK_SCHEMA, {
      timeoutMs: v.timeoutMs, maxTokens: maxTokens + (v.reasoning === "none" ? 0 : 2500), priority: true, rounds: v.rounds,
      fresh: v.speculate ? () => shown.size > before : undefined, reasoning: v.reasoning,
    });
    return { ...r, model: FAST_MODEL };
  } catch (e) {
    console.error("model pick failed or timed out:", (e as Error).message);
    return null;
  }
}

// --- 3. Checks + fallback -------------------------------------------------------------------

function normalize(picks: Pick[]): Pick[] {
  const total = picks.reduce((a, p) => a + Math.max(p.weight, 0), 0) || 1;
  let assigned = 0;
  return picks.map((p, i) => {
    const weight = i === picks.length - 1 ? 100 - assigned : Math.round((Math.max(p.weight, 0) / total) * 100);
    assigned += weight;
    return { ...p, weight };
  });
}

const roleFor = (s: Security, first: boolean): Role =>
  s.kind === "prediction" ? "prediction" : s.kind === "yield" ? "yield" : s.kind === "perp" ? "leverage" : first ? "core" : "second_order";

/** Full catalog rows for what the model picked, by id (`have`: rows already loaded). */
async function rowsFor(out: Picked, shown: Shown, have: Security[] = []): Promise<Map<string, Security>> {
  const rows = new Map(have.map((s) => [s.id, s]));
  const ids = out.picks.map((p) => shown.resolve(p.n, p.name)?.id).filter((id): id is string => !!id && !rows.has(id));
  for (const s of await securitiesById([...new Set(ids)])) rows.set(s.id, s);
  return rows;
}

/**
 * The model's picks, checked: only numbers it was shown, one per company, positive weights.
 * `whys`: the current basket's lines by asset id, kept when the model leaves a kept pick's empty.
 * `allowed`: what this basket can hold (a perp at high risk, or below it only at 1x for a name
 * with no stock listed; cash only at low; a copy only what it copies); `keep` ids are always
 * allowed.
 */
function fromModel(out: Picked, shown: Shown, rows: Map<string, Security>, cap = 5, whys = new Map<string, string>(), allowed: (s: Security) => boolean = () => true, keep = new Set<string>()): Pick[] {
  const used = new Set<string>();
  const picks: Pick[] = [];
  for (const p of out.picks) {
    const id = shown.resolve(p.n, p.name)?.id;
    const s = id ? rows.get(id) : undefined;
    if (!s || p.weight <= 0) continue;
    // One per company, a perp apart here; finalize() then drops a perp whose name is also held as a stock.
    const company = s.kind === "perp" ? `perp:${key(s)}` : key(s);
    if (used.has(company)) continue;
    if (!allowed(s) && !keep.has(s.id)) continue;
    used.add(company);
    // Role and side come from the asset, not the model.
    picks.push({
      s, weight: p.weight, why: p.why.trim() || whys.get(s.id) || firstSentence(s.description) || "", role: roleFor(s, picks.length === 0),
      purity: "partial", side: s.kind === "prediction" ? (p.side === "no" ? "no" : "yes") : "long",
      leverage: leverageFor(s, p.leverage),
    });
    if (picks.length === cap) break;
  }
  return normalize(picks);
}

const COMMON = new Set(["the", "and", "for", "will", "with", "this", "that", "are", "was", "has", "have", "not", "but", "its", "it's", "they", "their", "than", "then", "into", "over", "under", "about", "after", "before", "going", "gonna", "keep", "keeps", "still", "just", "next", "year", "years", "month", "months", "week", "weeks", "today", "now", "new", "big", "more", "less", "most", "very", "much", "up", "down", "all", "out", "off", "win", "wins", "lose", "loses", "higher", "lower", "rally", "rallies", "crash", "dump", "pump", "buy", "sell", "long", "short", "stock", "stocks", "market", "markets", "price", "prices", "bull", "bear", "bullish", "bearish", "call", "calls"]);

/**
 * Names and tickers → spot rows, for `named` (built once per index). Ranked like
 * search_securities: ticker or underlying exact (and "NVDA" for "NVDAx"), display name exact,
 * display name prefix; ties to stocks, then the deeper market.
 */
type Names = { exact: Map<string, Row>; display: [string, Row][] };
const names = new WeakMap<Index, Map<boolean, Names>>();
function namesFor(index: Index, usPerson: boolean): Names {
  let byUs = names.get(index);
  if (!byUs) names.set(index, (byUs = new Map()));
  const hit = byUs.get(usPerson);
  if (hit) return hit;
  const rank = (r: Row) => LISTED_ORDER.indexOf(r.kind) * 1e15 - r.depth;
  const rows = index.rows.filter((r) => SPOT.has(r.kind) && available({ us_persons: r.us }, usPerson)).sort((a, b) => rank(a) - rank(b));
  const exact = new Map<string, Row>();
  const display: [string, Row][] = [];
  for (const r of rows) {
    for (const k of [r.symbol, r.symbol.replace(/x$/, ""), r.underlying ?? ""]) {
      const lk = k.toLowerCase();
      if (lk && !exact.has(lk)) exact.set(lk, r);
    }
    display.push([displayName(r.name).toLowerCase(), r]);
  }
  const out = { exact, display };
  byUs.set(usPerson, out);
  return out;
}

/**
 * Picks named outright in the take or its source ("$NVDA", "Nvidia", "gold"), matched in memory
 * against the index (no database search per word). Short words count only as $cashtags or in
 * capitals (BE is Bloom Energy; "be" is a verb).
 */
async function named(index: Index, text: string, usPerson: boolean, max = 12, cashtagsOnly = false): Promise<Security[]> {
  const tokens = (text.match(/\$?[A-Za-z0-9][A-Za-z0-9&.\-]*/g) ?? []).filter((t) => !cashtagsOnly || /^\$[A-Za-z]/.test(t));
  const words = [...new Set(tokens.filter((t) => {
    const w = t.replace(/^\$/, "").toLowerCase();
    if (COMMON.has(w) || STOPWORDS.has(w) || w.length > 24) return false;
    return t.startsWith("$") || (w.length <= 5 && t === t.toUpperCase() && /[A-Z]/.test(t)) || w.length >= 4;
  }).map((t) => t.replace(/^\$/, "").toLowerCase().replace(/[.,;:!?]+$/, "")))].slice(0, max);
  const { exact, display } = namesFor(index, usPerson);
  const found: Row[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const r = exact.get(w) ?? display.find(([d]) => d === w)?.[1] ?? (w.length >= 4 ? display.find(([d]) => d.startsWith(w))?.[1] : undefined);
    const company = r ? (r.underlying ?? r.symbol) : "";
    if (r && !seen.has(company)) (seen.add(company), found.push(r));
  }
  return await securitiesById(found.map((r) => r.id));
}

const equalWeights = (rows: Security[]): Pick[] =>
  normalize(rows.map((s, i) => ({ s, role: i === 0 ? "core" : "second_order", weight: 1, why: descriptionOrName(s), side: "long", purity: "partial", leverage: 1 })));

/**
 * No model: the names the take or its source spell out, equal weights, plus the risk's cash or
 * leveraged pick. Nothing named → no basket (better than a guess).
 */
async function fromRules(index: Index, text: string, risk: string, usPerson: boolean): Promise<Pick[]> {
  const core = (await named(index, text, usPerson)).slice(0, risk === "medium" ? 4 : 3);
  if (!core.length) return [];
  return risk === "medium" ? equalWeights(core) : await adjustRisk(equalWeights(core), risk, usPerson);
}

// --- Edits -----------------------------------------------------------------------------------

type CurrentLeg = { id: string; weight: number; why: string; side: "long" | "yes" | "no"; leverage?: number };

/** Catalog rows by id, in the order asked for (unknown ids dropped). */
async function securitiesById(ids: string[]): Promise<Security[]> {
  if (!ids.length) return [];
  const { data, error } = await db.from("securities").select(SECURITY_COLUMNS).in("id", ids);
  if (error) throw error;
  const byId = new Map((data as Security[]).map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is Security => !!r);
}

function currentPicks(rows: Security[], legs: CurrentLeg[]): Pick[] {
  const byId = new Map(legs.map((l) => [l.id, l]));
  return rows.map((s, i) => ({
    s, weight: byId.get(s.id)?.weight ?? 0, why: byId.get(s.id)?.why ?? "", role: roleFor(s, i === 0),
    side: s.kind === "prediction" ? (byId.get(s.id)?.side === "no" ? "no" : "yes") : "long", purity: "partial",
    leverage: leverageFor(s, byId.get(s.id)?.leverage ?? 1),
  }));
}

const YIELD_WHY = "Money that isn't invested yet earns interest while the take runs.";

/**
 * New risk, same picks: drop the cash / perp pick the old risk added, add the new one's (low: the
 * deepest cash vault; high: the first pick Phoenix lists becomes its perp, at the rules'
 * leverage), and keep the rest in proportion. No model call, so it's instant and never touches
 * picks you chose.
 */
async function adjustRisk(current: Pick[], risk: string, usPerson: boolean, cardTake = false): Promise<Pick[]> {
  // A perp stood in for its name's stock (one pick per name): below high risk, the stock comes back.
  const back = await Promise.all(current.filter((p) => p.s.kind === "perp" && p.s.underlying).map(async (p) => {
    const { data } = await db.from("securities").select(SECURITY_COLUMNS).eq("underlying", p.s.underlying!).in("kind", [...SPOT]).eq("liquidity", "tradeable").limit(5);
    const stock = ((data ?? []) as Security[]).filter((s) => available(s, usPerson))[0];
    return stock ? { ...p, s: stock, role: roleFor(stock, false), why: firstSentence(stock.description) ?? p.why, leverage: 1 } : null;
  }));
  // Cards stay out of low-risk baskets; at most one card, at most 20%, unless
  // the take is about cards.
  let kept = capCards([...current.filter((p) => p.s.kind !== "yield" && p.s.kind !== "perp" && (risk !== "low" || p.s.kind !== "card")), ...back.filter((p): p is Pick => !!p)], cardTake);
  let extra: Pick | null = null;
  if (risk === "low") {
    const { data } = await db.from("securities").select(SECURITY_COLUMNS).eq("kind", "yield").eq("liquidity", "tradeable").eq("venue", TRADED_YIELD_VENUE);
    const vault = ((data ?? []) as Security[]).filter((v) => available(v, usPerson))
      .sort((a, b) => Number(b.data?.tvlUsd ?? 0) - Number(a.data?.tvlUsd ?? 0))[0];
    if (vault) extra = { s: vault, weight: 25, why: YIELD_WHY, role: "yield", side: "long", purity: "partial", leverage: 1 };
  } else if (risk === "high") {
    const lead = kept.find((p) => SPOT.has(p.s.kind) && p.s.underlying);
    const perp = lead ? (await securitiesById([`phoenix:${lead.s.underlying}`]))[0] : undefined;
    if (lead && perp && available(perp, usPerson) && perp.liquidity === "tradeable") {
      const lev = ruleLeverage(perp);
      // One pick per name: the perp takes its stock's place (finalize caps it at 30% when other picks aren't perps).
      const swapped: Pick = { s: perp, weight: lead.weight, why: `${displayName(lead.s.name)} at ${lev}x: gains and losses move faster.`, role: "leverage", side: "long", purity: "partial", leverage: lev };
      kept = kept.map((p) => (p === lead ? swapped : p));
    }
  }
  if (!kept.length) return extra ? normalize([extra]) : [];
  const keptTotal = kept.reduce((a, p) => a + p.weight, 0) || 1;
  const share = extra ? 75 : 100;
  return normalize([...kept.map((p) => ({ ...p, weight: (p.weight / keptTotal) * share })), ...(extra ? [extra] : [])]);
}

const STOPWORDS = new Set(["add", "and", "the", "more", "less", "some", "remove", "drop", "swap", "for", "with", "into", "make", "put", "it", "to", "of", "a", "an", "no", "in", "out", "my", "me", "too", "much", "instead", "replace", "take", "basket", "pick", "picks"]);

/** Things the ask names that this user can't buy, for the note (never while US restrictions are off). */
async function blockedBy(ask: string, current: Security[], usPerson: boolean): Promise<Security[]> {
  if (!usPerson) return [];
  const words = [...new Set(ask.toLowerCase().match(/[a-z0-9&.\-]{2,}/g) ?? [])].filter((w) => !STOPWORDS.has(w)).slice(0, 6);
  const [whole, perWord] = await Promise.all([
    textSearch(db, ask, usPerson, 6),
    Promise.all(words.map((w) => textSearch(db, w, usPerson, 3))),
  ]);
  const held = new Set(current.map(key));
  const seen = new Set<string>();
  return [...whole, ...perWord.flat()].filter((s) =>
    (s.score ?? 0) >= 95 && BASKET_KINDS.has(s.kind) && !available(s, usPerson) && !held.has(key(s)) && !seen.has(key(s)) && seen.add(key(s)));
}

const EDIT_SYSTEM = [
  "You edit an investment basket for a take (an opinion) on Thesis, a social trading app. current is the basket",
  "now, by number, with its weights. Apply the user's change and return the WHOLE new basket.",
  "Everything listed at the end can go in a basket; markets is a search of prediction markets on the change's words.",
  "Pick by number, with the name as shown. Call search only for a prediction market the change asks for that markets",
  "doesn't show, all at once; never search for anything listed. Otherwise answer right away.",
  "Keep every current pick and its weight unless the change is about it; rebalance only as much as needed.",
  "\"add X\" means include X (about an equal share, the others shrink in proportion). \"less X\" / \"more X\" changes",
  "its weight. \"remove X\" / \"no X\" drops it (and anything of that type, e.g. \"no crypto\"). \"swap A for B\" replaces A.",
  "Weights sum to 100. Max one pick per company (its stock or its perp, never both), at most 10 picks, at least 1.",
  "side: yes for everything; for a prediction market, yes or no, whichever the take implies. Of the markets that fit,",
  "prefer one that resolves by ends_by (a year from today, the longest a take runs); a later one is allowed.",
  "leverage: 1 for everything except a perp; keep a kept perp's leverage unless the change is about it; a new perp's,",
  "from 2 up to its max (at most 5x), more for a name that IS the take, less for a looser fit.",
  "why: max 12 words, how the pick ties to THIS take; for a kept pick return \"\" to keep its current line.",
  "summary: max 18 words, what has to be true for the take to pay off (keep it unless the basket's idea changed).",
  "verdict: always basket. reason: \"\" if you made the change; otherwise one short sentence saying why not",
  "(e.g. what was asked for can't be found), and return the current basket unchanged.",
  "If the change asks for something in not_available_here, never add a lookalike instead: leave the basket unchanged.",
  "A trading card or collectible is found with the cards tool when you have it (how many and how much follows `cards`); without",
  "the tool, cards can't be added at this risk: return the basket unchanged and say so in reason.",
  "\"add a prediction market\" (or predictions, odds, a bet on it) means the market on THIS take's own question, from",
  "markets or a search for the take's event: a company with \"market\" in its name is never one. If no market's",
  "question is about this take, return the basket unchanged and reason = \"There's no prediction market on this yet.\"",
  "Plain words for a non-investor; never mention tokens, chains, USDC or wallets.",
].join(" ");

/** No model: "add X" / "remove X" by name, so a slow call still does the obvious thing. */
async function editByRules(current: Pick[], ask: string, usPerson: boolean): Promise<Pick[] | null> {
  const a = ask.trim().toLowerCase();
  const add = a.match(/^(?:add|include|plus)\s+(.+)$/);
  const remove = a.match(/^(?:remove|drop|no|without)\s+(.+)$/);
  const matches = (s: Security, name: string) =>
    [s.symbol, s.underlying ?? "", displayName(s.name)].some((n) => n && n.toLowerCase().replace(/x$/, "") === name.replace(/x$/, ""));
  if (add) {
    const held = new Set(current.map((p) => key(p.s)));
    const s = (await textSearch(db, add[1].trim(), usPerson, 3)).find((c) => SPOT.has(c.kind) && !held.has(key(c)) && matches(c, add[1].trim()));
    if (!s || current.length >= MAX_LEGS) return null;
    const share = 100 / (current.length + 1);
    return normalize([
      ...current.map((p) => ({ ...p, weight: p.weight * (1 - share / 100) })),
      { s, weight: share, why: firstSentence(s.description) ?? "", role: roleFor(s, false), side: "long", purity: "partial", leverage: ruleLeverage(s) },
    ]);
  }
  if (remove) {
    const left = current.filter((p) => !matches(p.s, remove[1].trim()));
    return left.length && left.length < current.length ? normalize(left) : null;
  }
  return null;
}

async function edit(claim: string, risk: string, current: Pick[], ask: string, usPerson: boolean, source: Source | null, cardTake = false) {
  const [index, blocked] = await Promise.all([indexFor(), blockedBy(ask, current.map((p) => p.s), usPerson)]);
  const { shown, listed } = shownFor(index, usPerson);
  const input = {
    take: claim, risk, ends_by: endsBy(), change: ask, cards: cardRule(cardTake),
    current: current.map((p) => ({
      n: shown.add(rowOf(p.s)), name: displayName(p.s.name), kind: p.s.kind, weight: p.weight, why: p.why,
      ...(p.s.kind === "prediction" ? { side: p.side } : {}),
      ...(p.s.kind === "perp" ? { leverage: p.leverage, max_leverage: leverageCap(p.s) } : {}),
    })),
    ...(blocked.length ? { not_available_here: blocked.map((s) => displayName(s.name)) } : {}),
    ...(source ? { source: sourceJSON(source) } : {}),
    // The take's words too: "add prediction markets" says nothing about which event.
    markets: marketsFor(index, shown, `${claim} ${ask}`, usPerson, 8),
  };
  const found = new Map<string, Security>();
  const agent = await runAgent(withListed(EDIT_SYSTEM, listed), input, index, shown, usPerson, 450, SHIPPED, risk === "low" ? [] : [cardsTool(shown, found)]);
  const whys = new Map(current.map((p) => [p.s.id, p.why]));
  const blockedNote = blocked.length
    ? `${blocked.map((s) => displayName(s.name)).join(" and ")} ${blocked.length > 1 ? "aren't" : "isn't"} available in the US yet.`
    : null;
  if (agent) {
    const rows = await rowsFor(agent.out, shown, [...current.map((p) => p.s), ...found.values()]);
    // Asked for prediction markets: what's added has to be one (Robinhood Markets isn't).
    const held = new Set(current.map((p) => p.s.id));
    const wantsMarkets = /\bpredictions?\b|\bprediction markets?\b|\bodds\b|\bpolymarket\b|\bkalshi\b/i.test(ask);
    const allowed = (s: Security) => !wantsMarkets || held.has(s.id) || s.kind === "prediction";
    const picks = normalize(capCards(fromModel(agent.out, shown, rows, MAX_LEGS, whys, (s) => held.has(s.id) || (allowed(s) && (risk !== "low" || s.kind !== "card"))), cardTake));
    if (picks.length) {
      const unchanged = picks.length === current.length && picks.every((p, i) => p.s.id === current[i].s.id && Math.abs(p.weight - current[i].weight) < 1);
      return { picks, summary: agent.out.summary, note: blockedNote ?? (unchanged ? (agent.out.reason || "Nothing to change there.") : (agent.out.reason || null)), picker: agent.model, agent };
    }
  }
  const ruled = await editByRules(current, ask, usPerson);
  return ruled
    ? { picks: ruled, summary: null, note: null, picker: "rules", agent }
    : { picks: current, summary: null, note: blockedNote ?? "Couldn't make that change. Try saying it another way.", picker: "rules", agent };
}

// --- Handler ---------------------------------------------------------------------------------

/** The basket's legs as JSON, with the Jupiter Lend yield pick at its live APY (the catalog's is a snapshot). */
async function legsJSON(ps: Pick[]) {
  ps = await withSavedCards(ps);
  await withLiveApy(ps.map((p) => p.s));
  return ps.map(legJSON);
}

/**
 * A picked card's catalog row (card:<cardId>), written before the reply so take_legs.asset_id can
 * point at it. If the write fails the card leaves the basket rather than break posting.
 */
async function withSavedCards(ps: Pick[]): Promise<Pick[]> {
  const cards = ps.filter((p) => p.s.kind === "card" && p.s.id.startsWith(CARD_PREFIX));
  if (!cards.length) return ps;
  const rows = cards.map(({ s }) => ({
    id: s.id, kind: s.kind, symbol: s.symbol, name: s.name, underlying: s.underlying, issuer: s.issuer, venue: s.venue, mint: s.mint ?? null,
    themes: s.themes, description: s.description, liquidity: s.liquidity, us_persons: s.us_persons, can_short: s.can_short,
    expires_at: s.expires_at, data: s.data, updated_at: new Date().toISOString(),
  }));
  const { error } = await db.from("securities").upsert(rows, { onConflict: "id" });
  if (!error) return ps;
  console.error("saving card rows failed:", error.message);
  return normalize(ps.filter((p) => p.s.kind !== "card"));
}

function legJSON(p: Pick) {
  return {
    id: p.s.id, key: key(p.s), symbol: p.s.symbol, name: p.s.name, kind: p.s.kind, venue: p.s.venue, liquidity: p.s.liquidity,
    canShort: p.s.can_short, expiresAt: p.s.expires_at,
    apyPct: (p.s.data?.apyPct as number | undefined) ?? null, maxLeverage: (p.s.data?.maxLeverage as number | undefined) ?? null,
    weight: p.weight, role: p.role, side: p.side, why: p.why,
    /** 1 for everything but a perp: the leverage the model chose for it, at most 5x. */
    leverage: p.leverage,
    /** Cards: what Collector Crypt insures it at (its price), and a picture. */
    ...(p.s.kind === "card" ? { insuredValueUsd: (p.s.data?.insuredValueUsd as number | undefined) ?? null, imageUrl: (p.s.data?.image as string | undefined) ?? null } : {}),
  };
}

/** Admin replies: what the model searched and picked. */
function debugOf(agent: Agent | null, shown: Shown, copied: Security[] = []) {
  return {
    debug: {
      rounds: agent?.rounds ?? null, speculated: agent?.speculated ?? false, searches: agent?.calls ?? [], raw: agent?.out ?? null, copied: copied.map((s) => s.symbol),
      picked: (agent?.out.picks ?? []).map((p) => {
        const r = shown.resolve(p.n, p.name);
        return r ? line(r, p.n) + (r !== shown.get(p.n) ? ` (fixed from ${p.n} for "${p.name}")` : "") : `${p.n} "${p.name}" (never shown)`;
      }),
    },
  };
}

Deno.serve(async (req) => {
  const t0 = performance.now();
  const ms: Record<string, number> = {};
  const lap = (name: string) => (ms[name] = Math.round(performance.now() - t0));

  if (req.method === "GET") {
    await indexFor().catch((e) => console.error("index failed:", e));
    return new Response(null, { status: 204 });
  }
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const admin = sameSecret(req.headers.get("x-index-secret") ?? "", INDEX_SECRET);
  const did = admin ? null : await privyDid(req);
  if (!admin && !did) return json(401, { error: "invalid_privy_token" });

  let body: { claim?: string; risk?: string; mode?: string; legs?: unknown; ask?: string; include?: unknown; source?: { text?: unknown; label?: unknown; kind?: unknown }; system?: unknown; variant?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const claim = String(body.claim ?? "").trim();
  if (claim.length < 5 || claim.length > 280) return json(400, { error: "invalid_claim" });
  const risk = ["low", "medium", "high"].includes(String(body.risk)) ? String(body.risk) : "medium";
  const mode = body.mode === "edit" || body.mode === "risk" ? body.mode : "build";
  // What the take copies: an X post, an article, a fund's or trader's holdings ("NVDA 40%, VST 25%, …").
  const sourceText = typeof body.source?.text === "string" ? body.source.text.trim().slice(0, 2000) : "";
  const sourceKind = body.source?.kind === "holdings" || body.source?.kind === "article" ? body.source.kind : "post";
  const source: Source | null = sourceText.length >= 3
    ? { text: sourceText, label: typeof body.source?.label === "string" ? body.source.label.trim().slice(0, 60) || null : null, kind: sourceKind }
    : null;
  // A take about cards may be all cards; others keep one card at most 20%.
  const cardTake = isCardTake(source ? `${claim} ${source.text.slice(0, 400)}` : claim);

  const country = did && US_RESTRICTIONS ? db.from("accounts").select("country").eq("privy_did", did).maybeSingle() : Promise.resolve({ data: null });

  // --- Edits: the current basket, changed -------------------------------------------------------
  if (mode !== "build") {
    const legs = Array.isArray(body.legs) ? body.legs as Record<string, unknown>[] : [];
    const current: CurrentLeg[] = legs.slice(0, MAX_LEGS).map((l) => ({
      id: String(l?.id ?? ""), weight: Number(l?.weight) || 0, why: typeof l?.why === "string" ? l.why.slice(0, 300) : "",
      side: l?.side === "no" ? "no" as const : l?.side === "yes" ? "yes" as const : "long" as const,
      leverage: Number.isFinite(Number(l?.leverage)) ? Number(l?.leverage) : undefined,
    })).filter((l) => l.id);
    if (!current.length) return json(400, { error: "invalid_legs" });
    const ask = String(body.ask ?? "").trim();
    if (mode === "edit" && (ask.length < 2 || ask.length > 200)) return json(400, { error: "invalid_ask" });

    const [rows, account] = await Promise.all([securitiesById(current.map((l) => l.id)), country]);
    const usPerson = treatAsUS(account.data?.country);
    const picks = currentPicks(rows, current);
    if (!picks.length) return json(400, { error: "invalid_legs" });
    lap("load");

    if (mode === "risk") {
      const next = await adjustRisk(picks, risk, usPerson, cardTake);
      lap("risk");
      return json(200, { verdict: "basket", summary: null, reason: null, legs: await legsJSON(finalize(next, cardTake)), note: null, ms, picker: "rules" });
    }
    const out = await edit(claim, risk, normalize(picks), ask, usPerson, source, cardTake);
    lap("edit");
    return json(200, {
      verdict: "basket", summary: out.summary, reason: null, legs: await legsJSON(finalize(out.picks, cardTake)), note: out.note, ms, picker: out.picker,
      ...(admin ? { debug: { rounds: out.agent?.rounds ?? null, searches: out.agent?.calls ?? [], raw: out.agent?.out ?? null } } : {}),
    });
  }

  // --- Build ------------------------------------------------------------------------------------
  const includeIds = (Array.isArray(body.include) ? body.include : []).map(String).filter(Boolean).slice(0, 3);

  // The index + where the user lives (only read while US restrictions are on; see treatAsUS).
  const [account, included, index] = await Promise.all([
    country, securitiesById(includeIds), indexFor().catch((e) => (console.error("index failed:", e), null)),
  ]);
  if (!index) return json(500, { error: "search_failed" });
  const usPerson = treatAsUS(account.data?.country);
  const must = included.filter((s) => available(s, usPerson) && BASKET_KINDS.has(s.kind));
  lap("index");

  const v = admin ? variantOf((body as { variant?: unknown }).variant) : SHIPPED;
  const { shown, listed } = v.listed ? shownFor(index, usPerson) : { shown: new Shown(), listed: listedFor(index, usPerson) };
  const keep = must.map((s) => shown.add(rowOf(s)));
  const words = source ? `${claim} ${source.text.slice(0, 400)}` : claim;
  const input = {
    take: claim, risk, risk_rules: RISK_RULES[risk] ?? RISK_RULES.medium, cards: cardRule(cardTake),
    today: new Date().toISOString().slice(0, 10),
    ends_by: endsBy(),
    ...(keep.length ? { keep } : {}),
    ...(source ? { source: sourceJSON(source) } : {}),
    ...(v.markets ? { markets: marketsFor(index, shown, words, usPerson, 10) } : {}),
  };
  // A copy holds what it copies: when holdings (or a post's $cashtags) name two or more things
  // you can buy, the basket is those and only those (plus cash at low risk). An article naming a
  // company in passing doesn't count.
  const found = new Map<string, Security>();
  const [agent, copied] = await Promise.all([
    // Admin only: a system prompt to try instead of BUILD_SYSTEM (the eval's prompt variants), no redeploy.
    runAgent(
      admin && typeof body.system === "string" ? withListed(body.system, listed)
        : v.listed ? withListed(BUILD_SYSTEM, listed) : AGENT_SYSTEM,
      input, index, shown, usPerson, 400, v, risk === "low" ? [] : [cardsTool(shown, found)],
    ),
    source && source.kind !== "article" ? named(index, source.text, usPerson, 24, source.kind === "post") : Promise.resolve([] as Security[]),
  ]);
  lap("pick");
  // A post against what it tags ("$MCD $WEN traffic is falling") isn't copied as buys of them.
  const againstTags = source?.kind === "post" && agent?.out?.bearish === true;
  const copyKeys = copied.length >= 2 && !againstTags ? new Set(copied.map(key)) : null;
  // Holdings are positions someone holds: copied as they are. Anything else drops a pick that falls
  // if the take is right.
  const holdingsCopy = !!copyKeys && source?.kind === "holdings";
  // A perp only on a name the take (or its source) names: "same bet at 2x", never filler.
  const takeWords = new Set(tokenize(words, true));
  const spotKeys = new Set(listed.rows.filter((r) => SPOT.has(r.kind)).map((r) => r.underlying ?? r.symbol));
  // A perp on a name the take names, or one with no stock to buy instead (IREN: the perp is the only way to hold it).
  const takeNames = (s: Security) => tokenize(`${displayName(s.name)} ${s.underlying ?? ""}`).some((w) => w !== "perp" && takeWords.has(w));
  const perpNamed = (s: Security) => !spotKeys.has(key(s)) || takeNames(s);
  // Below high risk, a perp only when it's the one way to hold a name (Eli Lilly, Netflix: no stock
  // listed), at 1x, the same bet its stock would be. Without this the model's main pick was dropped
  // and its filler (cash, an off-topic market) became the whole basket.
  const onlyWay = (s: Security) => s.kind === "perp" && risk !== "high" && !spotKeys.has(key(s));
  const allowed = (s: Security) => (RISK_KINDS[risk](s.kind) || onlyWay(s)) && (!copyKeys || copyKeys.has(key(s)) || s.kind === "yield");
  const debug = admin ? debugOf(agent, shown, copied) : {};
  const noExposure = (reason: string, summary = claim) =>
    json(200, { verdict: "no_clean_exposure", summary, reason, legs: [], note: null, ms, ...debug });

  const out = agent?.out;
  let picks: Pick[] = [];
  let summary = claim;
  let picker = agent?.model ?? "rules";
  if (out?.verdict === "no_clean_exposure" && !must.length && !copyKeys) {
    return noExposure(out.reason || "Nothing you can buy tracks this closely enough yet.", out.summary || claim);
  }
  // A pick the model itself says falls when the take is right moves against it (a long on a bearish
  // take). Copied holdings are exempt. If that leaves nothing, nothing fits.
  if (out?.verdict === "basket" && !holdingsCopy && out.picks.length && out.picks.every((p) => p.gains_if_right === false) && !must.length) {
    return noExposure("Nothing you can buy goes up if this is right.", out.summary || claim);
  }
  if (out?.verdict === "basket") {
    const kept = holdingsCopy ? out : { ...out, picks: out.picks.filter((p) => p.gains_if_right !== false) };
    picks = fromModel(kept, shown, await rowsFor(out, shown, [...must, ...found.values()]), copyKeys ? MAX_LEGS : 5, undefined, allowed, new Set(must.map((s) => s.id)));
    const held = new Set(picks.filter((p) => p.s.kind !== "perp").map((p) => key(p.s)));
    picks = normalize(capCards(picks.filter((p) => p.s.kind !== "perp" || held.has(key(p.s)) || perpNamed(p.s) || must.some((m) => m.id === p.s.id)), cardTake))
      .map((p) => (p.s.kind === "perp" && risk !== "high" ? { ...p, leverage: 1 } : p));
    summary = out.summary || claim;
    // Nothing but cash left (the picks that were the take didn't hold up): that's not a basket for it.
    const aboutCash = ["cash", "yield", "saving", "stablecoin", "usdc"].some((w) => takeWords.has(w));
    if (picks.length && picks.every((p) => p.s.kind === "yield") && !must.length && !aboutCash) {
      return noExposure("Nothing you can buy tracks this closely enough yet.", summary);
    }
  }
  // The model answered, but none of its picks held up: the names the take spells out would be
  // bought whatever the take says about them ("restaurants are in trouble" bought McDonald's), so
  // that's no basket. The rules fallback is for when the model is slow or fails.
  if (!picks.length && out?.verdict === "basket" && !copyKeys && !must.length) {
    return noExposure("Nothing you can buy tracks this closely enough yet.", out.summary || claim);
  }
  if (!picks.length) {
    picker = "rules";
    summary = claim;
    picks = copyKeys ? equalWeights(copied.slice(0, MAX_LEGS)) : await fromRules(index, words, risk, usPerson);
    if (!picks.length && !must.length) return noExposure("Couldn't build this one just now. Try again in a moment.");
  }
  // The asset you started from is always in, at a fair share if the model left it out.
  for (const s of must) {
    if (picks.some((p) => p.s.id === s.id)) continue;
    picks = normalize([...picks.map((p) => ({ ...p, weight: p.weight * 0.8 })),
      { s, weight: picks.length ? 20 : 100, why: firstSentence(s.description) ?? "", role: roleFor(s, false), side: "long", purity: "partial", leverage: ruleLeverage(s) }]);
  }
  const note = included.length > must.length ? "That one isn't available in the US yet, so it's not in the basket." : null;

  return json(200, { verdict: "basket", summary, reason: null, legs: await legsJSON(finalize(picks, cardTake)), note, ms, picker, ...debug });
});
