// Collector Crypt: tokenized graded trading cards (and some sealed product and collectibles),
// each a 1/1 NFT backed by a vaulted physical item. Read-only: public card data from
// api.collectorcrypt.com, no key needed (an optional `ccsk_` key raises the rate limits).
//
// Card legs are paper-filled (docs/cards-plan.md): no card is bought. The
// leg's share of the stake is escrowed like a Gemini prediction leg, and the leg is priced at the
// card's insured value at both ends (after the next reset's program change gives Card-kind legs
// escrow): Collector Crypt's own market estimate (from eBay sold, ALT
// and Fanatics sales, reviewed by hand), not a seller's list price. Any card Collector Crypt
// indexes with an insured value above 0 can be picked, listed or not, from every category.
import { createHash } from "node:crypto";

export const CC_API = "https://api.collectorcrypt.com";
/** Collector Crypt's marketplace program (escrowless USDC listings). Not used while card legs are paper. */
export const CC_MARKETPLACE_PROGRAM_ID = "CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr";
/** Collector Crypt's Solana collections: pNFT and legacy NFT cards, then Core and cNFT cards. */
export const CC_COLLECTIONS = ["CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf", "CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac"] as const;

/** The gap between requests to the API (the liquidity registry uses the same). */
export const CC_MIN_GAP_MS = 250;
/** The browse endpoint's largest page. */
export const CC_MAX_STEP = 200;

type FetchFn = typeof fetch;

/** One card, from a browse row or a single-card read. */
export type CardRecord = {
  /** Collector Crypt's card id (e.g. "2026033156C116510"). Stable for the card's life; the leg id is built from it. */
  id: string;
  /** The card's NFT mint (asset) address. */
  nftAddress: string | null;
  name: string;
  category: string | null;
  set: string | null;
  year: number | null;
  /** E.g. "PRISTINE 10". */
  grade: string | null;
  /** E.g. "PSA", "CGC". */
  gradingCompany: string | null;
  /** Collector Crypt's insured value in USD, or null when it has none (0, missing or not a number). */
  insuredValueUsd: number | null;
  /** When the card's metadata (insured value included) last changed, in ms. Only single-card reads carry it. */
  metadataUpdatedAt: number | null;
  /** The live listing's USDC price, when listed. Shown only: card legs are never priced on it. */
  listedPriceUsd: number | null;
  /** "core", "pnft", "nft" or "cnft-v2". */
  nftStandard: string | null;
  /** "Valid" while the card is a live token. */
  nftStatus: string | null;
  /** Gone from Collector Crypt (deleted, or burned to bridge to another chain). */
  removed: boolean;
  image: string | null;
};

/**
 * The leg id for a card, its 32-byte `LegSpec.asset`: `sha256("thesis:card:v1:collector-crypt:<cardId>")`.
 * Card legs are `LegKind::Card`, escrowed and priced in dollars, once the program change at the next
 * reset lands (until then trades leave them out).
 */
export const CARD_ID_PREFIX = "thesis:card:v1:collector-crypt:";

export function cardIdHex(cardId: string): string {
  if (!cardId.trim()) throw new Error("empty Collector Crypt card id");
  return createHash("sha256").update(CARD_ID_PREFIX + cardId, "utf8").digest("hex");
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const positive = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const ms = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** Reads a browse row (`GET /marketplace`) or a single card (`GET /cards/publicNft/{id}`). Null without an id. */
export function parseCard(raw: any): CardRecord | null {
  const id = str(raw?.id);
  if (!id) return null;
  const listing = raw.listing && typeof raw.listing === "object" ? raw.listing : null;
  return {
    id,
    nftAddress: str(raw.nftAddress),
    name: str(raw.itemName) ?? id,
    category: str(raw.category),
    set: str(raw.set),
    year: num(raw.year),
    grade: str(raw.grade),
    gradingCompany: str(raw.gradingCompany),
    insuredValueUsd: positive(raw.insuredValue),
    metadataUpdatedAt: ms(raw.metadataUpdatedAt),
    listedPriceUsd: listing && (listing.currency ?? "USDC") === "USDC" ? positive(listing.price) : positive(raw.listedPriceUsd),
    nftStandard: str(raw.nftStandard),
    nftStatus: str(raw.nftStatus),
    removed: Boolean(raw.deletedAt) || raw.burnedForBridge === true,
    image: str(raw.images?.frontS) ?? str(raw.images?.frontM) ?? str(raw.frontImage),
  };
}

/** Why a card can't be priced (so can't be picked, or can't be priced now), or null when it can. */
export function cardUnpriceable(card: CardRecord): string | null {
  if (card.removed) return `${card.name} is no longer on Collector Crypt`;
  if (card.nftStatus !== null && card.nftStatus !== "Valid") return `${card.name} isn't a live token (${card.nftStatus})`;
  if (card.insuredValueUsd === null) return `Collector Crypt has no insured value for ${card.name}`;
  return null;
}

/** The USD price the settler signs for a card leg, at entry, exit and sale alike: its insured value. */
export function cardPrice(card: CardRecord): number | null {
  return cardUnpriceable(card) === null ? card.insuredValueUsd : null;
}

export type CardPage = { cards: CardRecord[]; nextCursor: string | null; total: number | null };

export type CollectorCryptOptions = {
  /** An optional `ccsk_` key (10x the anonymous limits). Never logged. */
  apiKey?: string | null;
  fetchFn?: FetchFn;
  minGapMs?: number;
  /** Collector Crypt refuses requests without a User-Agent. A generic name, never anything identifying. */
  userAgent?: string;
  /** Retries after a 429 or a 5xx. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export class CollectorCryptError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Collector Crypt's public card API, one request at a time with a gap between them. */
export class CollectorCryptClient {
  #o: Required<Omit<CollectorCryptOptions, "apiKey">> & { apiKey: string | null };
  #nextAt = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(o: CollectorCryptOptions = {}) {
    this.#o = {
      apiKey: o.apiKey ?? null,
      fetchFn: o.fetchFn ?? fetch,
      minGapMs: o.minGapMs ?? CC_MIN_GAP_MS,
      userAgent: o.userAgent ?? "thesis-venues/1.0",
      retries: o.retries ?? 3,
      sleep: o.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))),
      now: o.now ?? Date.now,
    };
  }

  /** One card's catalogue entry (insured value, grade, when its metadata changed). Null when Collector Crypt doesn't know it. */
  async card(cardId: string): Promise<CardRecord | null> {
    const raw = await this.#get(`/cards/publicNft/${encodeURIComponent(cardId)}`, { notFoundOk: true });
    return raw === null ? null : parseCard(raw);
  }

  /**
   * One page of cards, newest listings first. Without `listedOnly` it covers every card Collector
   * Crypt indexes, listed or not (about 197k at the time of writing).
   */
  async page(o: { cursor?: string | null; step?: number; listedOnly?: boolean } = {}): Promise<CardPage> {
    const q = new URLSearchParams({ step: String(Math.min(Math.max(1, o.step ?? CC_MAX_STEP), CC_MAX_STEP)) });
    if (o.listedOnly) q.set("listPriceMin", "0.000001");
    if (o.cursor) q.set("cursor", o.cursor);
    const raw = await this.#get(`/marketplace?${q}`);
    const rows: unknown[] = Array.isArray(raw?.filterNFtCard) ? raw.filterNFtCard : [];
    return {
      cards: rows.map(parseCard).filter((c): c is CardRecord => c !== null),
      nextCursor: str(raw?.nextCursor),
      total: num(raw?.findTotal),
    };
  }

  /** Every card, page by page (about 1,000 requests for the whole index). Stops after `maxPages` if given. */
  async *allCards(o: { listedOnly?: boolean; maxPages?: number } = {}): AsyncGenerator<CardRecord[]> {
    let cursor: string | null = null;
    for (let n = 0; o.maxPages === undefined || n < o.maxPages; n++) {
      const p: CardPage = await this.page({ cursor, listedOnly: o.listedOnly });
      if (p.cards.length) yield p.cards;
      if (!p.nextCursor || p.nextCursor === cursor) return;
      cursor = p.nextCursor;
    }
  }

  #get(path: string, o: { notFoundOk?: boolean } = {}): Promise<any> {
    // Requests run one after another, so the gap holds across concurrent callers.
    const run = this.#queue.then(() => this.#send(path, o));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #send(path: string, o: { notFoundOk?: boolean }): Promise<any> {
    const headers: Record<string, string> = { "user-agent": this.#o.userAgent, accept: "application/json" };
    if (this.#o.apiKey) headers.authorization = `Bearer ${this.#o.apiKey}`;
    for (let attempt = 0; ; attempt++) {
      const wait = this.#nextAt - this.#o.now();
      if (wait > 0) await this.#o.sleep(wait);
      this.#nextAt = this.#o.now() + this.#o.minGapMs;
      const res = await this.#o.fetchFn(`${CC_API}${path}`, { headers });
      if (res.ok) return res.json();
      if (res.status === 404 && o.notFoundOk) return null;
      const body = await res.text().catch(() => "");
      if ((res.status === 429 || res.status >= 500) && attempt < this.#o.retries) {
        await this.#o.sleep(res.status === 429 ? retryAfterMs(body) : 1000 * 2 ** attempt);
        continue;
      }
      throw new CollectorCryptError(res.status, `Collector Crypt ${res.status} for ${path.split("?")[0]}: ${body.slice(0, 200)}`);
    }
  }
}

/**
 * How long a 429 asks to wait. Collector Crypt puts `retryAfter` in the body (its docs don't give
 * the unit; read as seconds), and usually no Retry-After header. Between 1 and 60 seconds.
 */
export function retryAfterMs(body: string): number {
  let s: number | null = null;
  try {
    s = num(JSON.parse(body)?.retryAfter);
  } catch {
    s = null;
  }
  return Math.min(60, Math.max(1, s ?? 5)) * 1000;
}
