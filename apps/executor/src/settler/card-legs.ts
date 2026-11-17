// Card legs (docs/cards-plan.md): paper-filled Collector Crypt cards, priced
// in dollars at the card's insured value (CC's own market estimate) at entry, horizon and sale.
//
//   - Read at or after the moment, like every other leg: a live read of the card while the price
//     window (`maxDelaySecs` after the moment) is open; if CC can't be read, the asset bank's own
//     reading of the card counts when it was made inside the window.
//   - No price (CC down, no insured value, the card redeemed or burned): retry while the window
//     is open, then the leg stays unpriced and the position settles unscored after the grace
//     period, like other legs.
//   - Cards can't be faded (the program refuses it), so there's one side.
// Card legs exist on-chain once the program change at the next reset gives `LegKind::Card` escrow.
import type { EntryBasis } from "./basis.ts";
import type { LegOutcome, PriceRules } from "./pricing.ts";

/** One card read live from Collector Crypt (`CollectorCryptClient.card` + `cardPrice`). */
export type CardSource = {
  card(cardId: string): Promise<{ insuredValueUsd: number | null; at: number; raw: unknown } | null>;
};

/** What the asset bank knows about the leg's card (`cardLeg`), by its on-chain id. */
export type CardRef = { cardId: string; name: string; insuredValueUsd: number | null; readAtSec: number };

export async function priceCard(
  leg: { index: number; card?: CardRef | null },
  momentSec: number,
  nowSec: number,
  rules: Pick<PriceRules, "maxDelaySecs">,
  src: CardSource | undefined,
  entry: EntryBasis | null,
): Promise<LegOutcome> {
  // The entry's basis names the card; an exit with none (a lost audit log) finds it through the bank.
  const cardId = entry?.source === "card" ? entry.cardId : (leg.card?.cardId ?? null);
  if (!cardId) return { ok: false, retry: true, reason: "the leg's card isn't in the asset bank yet" };
  if (nowSec < momentSec) return { ok: false, retry: true, reason: "moment not reached" };
  const until = momentSec + rules.maxDelaySecs;
  const open = nowSec <= until;
  const basis: EntryBasis = entry?.source === "card" ? entry : { source: "card", cardId };
  const quote = (price: number, publishedAt: number, inputs: Record<string, unknown>): LegOutcome => ({
    ok: true,
    quote: { leg: leg.index, price, publishedAt, rule: "card-insured-value", basis, inputs: { cardId, insuredValueUsd: price, ...inputs } },
  });

  let why = "Collector Crypt couldn't be read";
  if (open && src) {
    const live = await src.card(cardId).catch(() => null);
    if (live && live.insuredValueUsd !== null && live.insuredValueUsd > 0) {
      return quote(live.insuredValueUsd, Math.max(momentSec, Math.min(nowSec, live.at)), { card: live.raw });
    }
    if (live) why = `Collector Crypt has no insured value for card ${cardId} right now`;
  } else if (!src) {
    why = "no Collector Crypt source configured";
  }
  // The bank's reading, if it was made at or after the moment and inside the window.
  const b = leg.card && leg.card.cardId === cardId ? leg.card : null;
  if (b && b.insuredValueUsd !== null && b.insuredValueUsd > 0 && b.readAtSec >= momentSec && b.readAtSec <= Math.min(nowSec, until)) {
    return quote(b.insuredValueUsd, b.readAtSec, { from: "asset bank" });
  }
  return open ? { ok: false, retry: true, reason: why } : { ok: false, retry: false, reason: "past the price deadline" };
}
