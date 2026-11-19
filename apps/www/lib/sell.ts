// Selling all or part of what you hold in a take. Every buy is its own position on-chain, but the
// apps group a take's positions by side into one holding and sell through the fork API's holding
// route, `POST /takes/:id/sell` { owner, side, bps | usd }: whole positions first, then at most one
// partial sale, in one build and one approval. A part is `bps` of what's left (10,000 = all), or
// dollars of its value (the API converts them at the current value). What stays in a position must
// keep at least the minimum stake ($10), so a $10 position only sells all at once.
//
// An older fork API has no partial sales: its positions carry none of the sale fields, its builds
// answer without `bps` / `full`, and it has no holding route (404 no_such_route). Then the sheet
// only offers "Sell all" of one position at a time, through `POST /takes/:id/positions/:pos/exit`.
import { usd, type Position } from "./data";
import { ForkError, type Built } from "./fork";

export type Side = "back" | "fade";
export const ALL_BPS = 10_000;
/** The % presets: 25%, 50%, 75%, All. */
export const PCT_PRESETS = [2_500, 5_000, 7_500, ALL_BPS];
/** The $ presets (All is its own chip). */
export const USD_PRESETS = [10, 25, 50];
/** A dollar amount this close to the whole value sells all of it (as the API rounds it). */
const ALL_WITHIN = 0.995;

/** What a sale sells: a part of what's left in bps, or dollars of its value. */
export type SaleAmount = { bps: number } | { usd: number };

/** A take's open positions on one side, as one thing to sell. */
export type Holding = {
  side: Side;
  positions: Position[];
  stakeUsd: number;
  /** The cost basis still held (stakeUsd before any partial sale, or from an older API). */
  remainingStakeUsd: number;
  valueUsd: number | null;
  realizedPnlUsd: number | null;
  pendingSales: number;
  minStakeUsd: number;
  /** The largest part that can be sold now; null: only all of it. */
  maxPartialBps: number | null;
  closesTakeIfSoldAll: boolean;
  canSell: boolean;
  /** The API sells parts of it (every position carries the sale fields). */
  partial: boolean;
};

/** A position's cost basis still held. */
export const remainingOf = (p: { stakeUsd: number; remainingStakeUsd?: number }) => p.remainingStakeUsd ?? p.stakeUsd;

/**
 * The largest part of a holding that can be sold now, in bps of the whole: one position's own
 * figure; across several, every other position whole plus the last one's own most. The API sells
 * whole positions first, smallest first, then one part, and the author's buy-in
 * (`closesTakeIfSoldAll`) always comes last and is never sold whole short of all of it, so the
 * last one is the buy-in when there is one, else the largest. An estimate the API has the last
 * word on: a refused part comes back as `remainder_below_minimum` with the API's own figure.
 */
export function holdingMaxBps(ps: Position[]): number | null {
  if (!ps.length) return null;
  if (ps.length === 1) return ps[0].maxPartialBps ?? null;
  const sorted = [...ps].sort((a, b) => Number(!!a.closesTakeIfSoldAll) - Number(!!b.closesTakeIfSoldAll) || remainingOf(a) - remainingOf(b));
  const total = sorted.reduce((s, p) => s + remainingOf(p), 0);
  const last = sorted[sorted.length - 1];
  const part = last.maxPartialBps ? (remainingOf(last) * last.maxPartialBps) / ALL_BPS : 0;
  const bps = total > 0 ? Math.floor(((total - remainingOf(last) + part) / total) * ALL_BPS) : 0;
  return bps >= 1 && bps < ALL_BPS ? bps : null;
}

/** The viewer's open positions in a take, as holdings: Traded first, then Faded. */
export function holdingsOf(positions: Position[], minStakeUsd: number): Holding[] {
  const open = positions.filter((p) => !p.exited);
  return (["back", "fade"] as const).flatMap((side): Holding[] => {
    const ps = open.filter((p) => p.side === side);
    if (!ps.length) return [];
    const partial = ps.every((p) => p.remainingStakeUsd != null);
    return [{
      side,
      positions: ps,
      stakeUsd: ps.reduce((s, p) => s + p.stakeUsd, 0),
      remainingStakeUsd: ps.reduce((s, p) => s + remainingOf(p), 0),
      valueUsd: ps.every((p) => p.valueUsd != null) ? ps.reduce((s, p) => s + (p.valueUsd ?? 0), 0) : null,
      realizedPnlUsd: ps.some((p) => p.realizedPnlUsd != null) ? ps.reduce((s, p) => s + (p.realizedPnlUsd ?? 0), 0) : null,
      pendingSales: ps.reduce((s, p) => s + (p.pendingSales?.length ?? 0), 0),
      minStakeUsd: ps.find((p) => p.minStakeUsd != null)?.minStakeUsd ?? minStakeUsd,
      maxPartialBps: partial ? holdingMaxBps(ps) : null,
      closesTakeIfSoldAll: ps.some((p) => p.closesTakeIfSoldAll),
      canSell: ps.some((p) => p.canExit),
      partial,
    }];
  });
}

/** A dollar amount at (or within 0.5% of) the whole value is all of it. */
export function normalize(a: SaleAmount, valueUsd: number | null): SaleAmount {
  if ("bps" in a) return { bps: Math.min(ALL_BPS, Math.max(1, Math.round(a.bps))) };
  if (valueUsd != null && valueUsd > 0 && a.usd >= valueUsd * ALL_WITHIN) return { bps: ALL_BPS };
  return { usd: Math.round(a.usd * 100) / 100 };
}
export const isAll = (a: SaleAmount | null) => !!a && "bps" in a && a.bps >= ALL_BPS;

/** The share of the holding a sale sells, in bps (from its value for a dollar amount); null if unknown. */
export function bpsOf(a: SaleAmount, valueUsd: number | null): number | null {
  if ("bps" in a) return a.bps;
  return valueUsd != null && valueUsd > 0 ? Math.min(ALL_BPS, Math.round((a.usd / valueUsd) * ALL_BPS)) : null;
}

// Early builds are cached by what they'd sell: "sell:back:b2500" (25%), "sell:fade:u1000" ($10),
// and an older API's whole position, "exit:<position>".
export const holdingKey = (side: Side, a: SaleAmount) => ("bps" in a ? `sell:${side}:b${a.bps}` : `sell:${side}:u${Math.round(a.usd * 100)}`);
export const exitKey = (position: string) => `exit:${position}`;
export type SaleKey = { kind: "exit"; position: string } | { kind: "sell"; side: Side; amount: SaleAmount };
export function parseSaleKey(key: string): SaleKey | null {
  if (key.startsWith("exit:")) return { kind: "exit", position: key.slice(5) };
  const m = key.match(/^sell:(back|fade):(b|u)(\d+)$/);
  if (!m) return null;
  const n = Number(m[3]);
  return { kind: "sell", side: m[1] as Side, amount: m[2] === "b" ? { bps: n } : { usd: n / 100 } };
}
/** The fork API body for a sale key (the route is the key's kind). */
export function saleBody(k: Extract<SaleKey, { kind: "sell" }>, owner: string, prebuild: boolean) {
  return { owner, side: k.side, ...("bps" in k.amount ? { bps: k.amount.bps } : { usd: k.amount.usd }), ...(prebuild ? { prebuild: true } : {}) };
}

/** A sale build from an API without partial sales (no `bps`, no `full`). */
export const legacyBuild = (b: Built) => b.bps == null && b.full == null;
/** The API has no holding route: an older one. */
export const missingRoute = (e: unknown) => e instanceof ForkError && e.status === 404 && e.code === "no_such_route";
/** Whether a landed build sold everything it was asked about (an older API's exit always does). */
export const soldAll = (b: Built) => b.full ?? (b.bps == null || b.bps >= ALL_BPS);

/** "25%" of a part, "all" for 10,000. */
export const partLabel = (bps: number) => (bps >= ALL_BPS ? "all" : `${+(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`);

/**
 * What a refused sale says, with the refusal's own figures: `sellAll` when selling all of it would
 * go through instead (what's left would be too small, or too many parts are still settling), and
 * `maxPartialBps` the API's own largest part (`undefined` when it didn't say).
 */
export function saleRefusal(e: unknown): { text: string; sellAll: boolean; maxPartialBps?: number | null } {
  if (!(e instanceof ForkError)) return { text: e instanceof Error ? e.message : String(e), sellAll: false };
  const d = e.data ?? {};
  const min = typeof d.minStakeUsd === "number" ? d.minStakeUsd : 10;
  if (e.code === "remainder_below_minimum") {
    const maxBps = typeof d.maxPartialBps === "number" && d.maxPartialBps > 0 ? d.maxPartialBps : null;
    const maxUsd = typeof d.maxPartialUsd === "number" && d.maxPartialUsd > 0 ? d.maxPartialUsd : null;
    const text = maxBps
      ? `What's left has to stay at least ${usd(min).replace(/\.00$/, "")}. You can sell up to ${maxUsd != null ? usd(maxUsd) : partLabel(maxBps)} now, or all of it.`
      : `What's left has to stay at least ${usd(min).replace(/\.00$/, "")}, so this sells only all at once.`;
    return { text, sellAll: true, maxPartialBps: maxBps };
  }
  if (e.code === "too_many_open_sales") return { text: e.message, sellAll: true };
  if (e.code === "part_too_small") return { text: e.message, sellAll: true };
  if (e.code === "invalid_amount") return { text: "Pick a part between 1% and 100%, or an amount up to what it's worth.", sellAll: false };
  return { text: e.message, sellAll: false };
}

/** Why some parts can't be picked: what's left keeps at least the minimum. */
export function limitNote(h: Holding, maxBps: number | null): string | null {
  if (!h.partial) return null;
  const min = usd(h.minStakeUsd).replace(/\.00$/, "");
  if (maxBps == null) return `This sells only all at once: what's left has to stay at least ${min}.`;
  const upTo = h.valueUsd != null ? `${partLabel(maxBps)} (about ${usd((h.valueUsd * maxBps) / ALL_BPS)})` : partLabel(maxBps);
  return `You can sell up to ${upTo} now, or all of it: what's left keeps at least ${min}.`;
}
