// The asset bank's picked cards: every Collector Crypt card a basket has picked (catalog rows
// `card:<cardId>`), with its last insured value, so the settler can turn a card leg's on-chain id
// back into its card and price it (docs/cards-plan.md). Card legs are paper:
// escrowed, and priced at the card's insured value.
import { cardIdHex, type CardRecord } from "../../collector-crypt/src/index.ts";
import type { BankState } from "./state.ts";

export type PickedCard = {
  cardId: string;
  name: string;
  /** Collector Crypt's insured value in USD at `readAt`, or null when it had none (or the card is gone). */
  insuredValueUsd: number | null;
  /** When CC last changed the card's metadata (ms), if known. */
  metadataUpdatedAt: number | null;
  /** When the bank read it (ISO). */
  readAt: string;
};

/** Refreshed this often per card; the tier reads at most `maxReads` cards per run, the stalest first. */
export const CARD_REFRESH_MS = 60 * 60_000;

/** A card as the bank keeps it, from a single-card read. Null price when CC can't price it now. */
export function pickedCard(card: CardRecord, price: number | null, readAt: string): PickedCard {
  return { cardId: card.id, name: card.name, insuredValueUsd: price, metadataUpdatedAt: card.metadataUpdatedAt, readAt };
}

/**
 * The card ids to read this run: picked cards the bank doesn't hold yet first, then held ones
 * older than `CARD_REFRESH_MS`, stalest first, at most `maxReads`.
 */
export function cardsToRead(held: Record<string, PickedCard>, picked: string[], nowMs: number, maxReads: number): string[] {
  const byId = new Map(Object.values(held).map((c) => [c.cardId, c]));
  const fresh = picked.filter((id) => !byId.has(id));
  const stale = [...byId.values()]
    .filter((c) => nowMs - Date.parse(c.readAt) >= CARD_REFRESH_MS)
    .sort((a, b) => Date.parse(a.readAt) - Date.parse(b.readAt))
    .map((c) => c.cardId);
  return [...new Set([...fresh, ...stale])].slice(0, Math.max(0, maxReads));
}

/** The card a leg id (hex) names, while the bank holds it. */
export function cardLeg(state: Pick<BankState, "venues">, idHex: string): PickedCard | null {
  return state.venues.cards?.picked?.[idHex] ?? null;
}

/** Adds or replaces cards, keyed by their leg id. */
export function mergePicked(held: Record<string, PickedCard>, read: PickedCard[]): Record<string, PickedCard> {
  const out = { ...held };
  for (const c of read) out[cardIdHex(c.cardId)] = c;
  return out;
}
