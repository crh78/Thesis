// House rules for a basket's perps, applied to whatever produced it (the model, the rules
// fallback, an edit, a switch of risk):
//   - One pick per name: the program rejects two legs on the same asset, so a perp on a name the
//     basket already holds as a stock is dropped (the stock stays).
//   - A leveraged perp (above 1x) weighs at most 30% when the basket has picks that aren't perps;
//     the excess goes to them, in proportion. A basket of perps only (one or several) keeps its weights (chosen
//     after live builds). A 1x perp is the same bet as the stock (how a name with no stock listed is
//     held, Eli Lilly at low risk), so it isn't capped.
//   - Leverage stays the model's choice, at most 5x (and the market's own max, applied where the
//     pick is made). Takes have no horizon: they run until the author sells, a year at most.

export const MAX_PERP_WEIGHT = 30;
/** The most leverage any perp pick gets. */
export const MAX_LEVERAGE = 5;
/** A perp's leverage when no model chose it (the rules fallback, a switch to high risk, an add by name). */
export const RULES_LEVERAGE = 2;

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
export function applyHouseRules<T>(picks: T[], view:(p: T) => RuleView, update: (p: T, weight: number, leverage: number) => T): T[] {
  const stocks = new Set(picks.map(view).filter((v) => v.kind !== "perp").map((v) => v.key));
  const kept = picks.filter((p) => {
    const v = view(p);
    return v.kind !== "perp" || !stocks.has(v.key);
  });
  if (!kept.length) return kept;
  const views = kept.map(view);
  let weights = normalizeWeights(views.map((v) => v.weight));
  const capped = views.map((v) => v.kind === "perp" && v.leverage > 1);
  const othersTotal = weights.reduce((a, w, i) => a + (views[i].kind === "perp" ? 0 : w), 0);
  const over = weights.reduce((a, w, i) => a + (capped[i] ? Math.max(0, w - MAX_PERP_WEIGHT) : 0), 0);
  if (over > 0 && othersTotal > 0) {
    weights = normalizeWeights(weights.map((w, i) =>
      capped[i] ? Math.min(w, MAX_PERP_WEIGHT) : w + over * (w / othersTotal)));
  }
  return kept.map((p, i) => update(p, weights[i], views[i].kind === "perp" ? Math.min(views[i].leverage, MAX_LEVERAGE) : views[i].leverage));
}
