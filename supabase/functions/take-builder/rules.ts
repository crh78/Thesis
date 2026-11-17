// House rules for a basket's perps, applied to whatever produced it (the model, the rules
// fallback, an edit, a switch of risk):
//   - One pick per name: the program rejects two legs on the same asset, so a perp on a name the
//     basket already holds as a stock is dropped (the stock stays).
//   - A perp weighs at most 30% when the basket has picks that aren't perps; the excess goes to
//     them, in proportion. A basket of perps only (one or several) keeps its weights (chosen after
//     live builds).
//   - Leverage stays the model's choice, under a ceiling that falls with the horizon.

export const MAX_PERP_WEIGHT = 30;
export const HORIZON_MAX_LEVERAGE: Record<string, number> = { "2 weeks": 5, "1 month": 4, "3 months": 3, "6 months": 2 };

/** What the rules read from a pick: its kind, its name's key (an underlying), weight and leverage. */
export type RuleView = { kind: string; key: string; weight: number; leverage: number };

/** Whole-number weights summing to 100, in the same proportions (the last pick takes the rounding). */
export function normalizeWeights(weights: number[]): number[] {
  const total = weights.reduce((a, w) => a + Math.max(w, 0), 0) || 1;
  let assigned = 0;
  return weights.map((w, i) => {
    const v = i === weights.length - 1 ? 100 - assigned : Math.round((Math.max(w, 0) / total) * 100);
    assigned += v;
    return v;
  });
}

/**
 * Applies the house rules. `view` reads a pick; `update` returns it with a new weight and leverage.
 */
export function applyHouseRules<T>(picks: T[], horizon: string, view: (p: T) => RuleView, update: (p: T, weight: number, leverage: number) => T): T[] {
  const stocks = new Set(picks.map(view).filter((v) => v.kind !== "perp").map((v) => v.key));
  const kept = picks.filter((p) => {
    const v = view(p);
    return v.kind !== "perp" || !stocks.has(v.key);
  });
  if (!kept.length) return kept;
  const ceiling = HORIZON_MAX_LEVERAGE[horizon] ?? 2;
  const views = kept.map(view);
  let weights = normalizeWeights(views.map((v) => v.weight));
  const othersTotal = weights.reduce((a, w, i) => a + (views[i].kind === "perp" ? 0 : w), 0);
  const over = weights.reduce((a, w, i) => a + (views[i].kind === "perp" ? Math.max(0, w - MAX_PERP_WEIGHT) : 0), 0);
  if (over > 0 && othersTotal > 0) {
    weights = normalizeWeights(weights.map((w, i) =>
      views[i].kind === "perp" ? Math.min(w, MAX_PERP_WEIGHT) : w + over * (w / othersTotal)));
  }
  return kept.map((p, i) => update(p, weights[i], views[i].kind === "perp" ? Math.min(views[i].leverage, ceiling) : views[i].leverage));
}
