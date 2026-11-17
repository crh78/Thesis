// What the settler needs from the asset bank: on-chain underlying id → underlying, and
// issuer mint → underlying and units per token.
import { cardLeg, predictionLeg, underlyingIdHex, type BankState, type PredictionLeg, type ScaledUi } from "@thesis/venues/bank";
import type { CardRef } from "./card-legs.ts";
import type { PerpInfo } from "./phoenix-legs.ts";
import type { TokenRef, UnderlyingRef } from "./pricing.ts";

export type BankToken = TokenRef & { underlyingKey: string; underlyingIdHex: string };

export interface BankIndex {
  underlyingById(idHex: string): UnderlyingRef | null;
  token(mint: string): BankToken | null;
  /** The Gemini contract and side a prediction leg's id names, while the bank still holds it. */
  prediction(idHex: string): PredictionLeg | null;
  /** A Phoenix market by symbol: the underlying it tracks, and underlying units per contract. */
  perp(symbol: string): PerpInfo | null;
  /** The Collector Crypt card a card leg's id names, with the bank's last reading, while it holds it. */
  card(idHex: string): CardRef | null;
}

const cardRef = (state: BankState, idHex: string): CardRef | null => {
  const c = cardLeg(state, idHex);
  return c ? { cardId: c.cardId, name: c.name, insuredValueUsd: c.insuredValueUsd, readAtSec: Math.floor(Date.parse(c.readAt) / 1000) } : null;
};

export function bankIndex(state: BankState): BankIndex {
  const byId = new Map<string, UnderlyingRef>();
  for (const u of Object.values(state.underlyings)) byId.set(u.idHex, { key: u.key, cls: u.cls, code: u.code });
  const token = (mint: string): BankToken | null => {
    const t = state.tokens[mint];
    if (!t) return null;
    return {
      mint,
      underlyingKey: t.underlying,
      underlyingIdHex: underlyingIdHex(t.underlying),
      underlyingPerUiToken: t.ratio.comparable ? t.ratio.underlyingPerUiToken : null,
      // Corporate actions: pricing scales by its multiplier at each moment (pricing.ts).
      scaledUi: t.scaledUi ?? null,
    };
  };
  const perps = new Map((state.venues.phoenix?.markets ?? []).map((m) => [m.symbol, { underlyingKey: m.underlying, unitsPerContract: m.unitsPerContract }]));
  return {
    underlyingById: (id) => byId.get(id) ?? null,
    token,
    prediction: (id) => predictionLeg(state, id),
    perp: (symbol) => perps.get(symbol) ?? null,
    card: (id) => cardRef(state, id),
  };
}

/** A fixed index, for tests and the fork: underlying keys plus any issuer tokens. */
export function staticBankIndex(
  underlyings: string[],
  tokens: { mint: string; underlyingKey: string; underlyingPerUiToken: number | null; scaledUi?: ScaledUi | null }[] = [],
  predictions: Record<string, PredictionLeg> = {},
  perps: Record<string, PerpInfo> = {},
  cards: Record<string, CardRef> = {},
): BankIndex {
  const byId = new Map<string, UnderlyingRef>();
  for (const key of underlyings) {
    const parts = key.split(":");
    byId.set(underlyingIdHex(key), { key, cls: parts[0], code: parts[parts.length - 1] });
  }
  const byMint = new Map(tokens.map((t) => [t.mint, { ...t, underlyingIdHex: underlyingIdHex(t.underlyingKey) }]));
  return {
    underlyingById: (id) => byId.get(id) ?? null,
    token: (m) => byMint.get(m) ?? null,
    prediction: (id) => predictions[id] ?? null,
    perp: (symbol) => perps[symbol] ?? null,
    card: (id) => cards[id] ?? null,
  };
}
