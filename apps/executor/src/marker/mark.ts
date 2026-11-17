// Live marks, the pure part: which asset a pick is, what it's worth now by the settler's rules,
// and the take's return as an index since it was posted. marker.ts does the I/O.
//
// Rules (the settler's, apps/executor/src/settler/pricing.ts, applied "now"):
//   - spot: the issuer token when its pool holds the liquidity floor (no band against the stock);
//     otherwise the stock's latest trade (US stocks and ETFs). A pick keeps the source its base was priced from: a token-priced base is marked on
//     the token, or on the stock times the token's premium at the base when the token can't be
//     used; a stock-priced base stays on the stock. Every mark is scaled by the token's
//     ScaledUiAmount multiplier now over the one at the base, so a split or a reinvested dividend
//     isn't read as a loss.
//   - perp: Phoenix's mark (or mid), per unit of the underlying (kPEPE is 1,000 PEPE).
//   - prediction: the pick's side's bid, or 1/0 once resolved; never from a book that doesn't
//     add up (crossed, or asks under $1: bookProblem).
//   - yield: one jlUSDC share's value (every yield pick is a Jupiter Lend deposit).
//   - card: the card's insured value (Collector Crypt), as the asset bank last read it.
//     A card category pick (cards:<category>) isn't one card: left out.
//   - picks with no catalog row: left out of the take's return (as a position leaves out legs it
//     couldn't buy).
// A pick's return is the program's own formula as a back (positionReturnBps); the take's is the
// weight-weighted average over the picks it includes. A pick with no price this run keeps its
// last mark; one that has never been marked holds the whole take back (no return is written,
// rather than a wrong one).
import { positionReturnBps } from "@thesis/chain";
import { effectiveMultiplier, PRICEABLE_MIN_POOLED_USD, type ScaledUi } from "@thesis/venues/bank";
import { bookProblem, legPrice, type GeminiContract, type GeminiSide } from "@thesis/venues/gemini";
import { toPriceUnits } from "../settler/pricing.ts";

/** A stock trade older than this is a stale close: no premium against it (settler: SETTLER_STALE_REF_SEC). */
export const STALE_REF_SECS = 900;
/** A take first marked within this of posting takes its current marks as bases. */
export const LIVE_BASE_SECS = 900;

export type Security = { id: string; kind: string; symbol: string; name: string; underlying: string | null; mint: string | null; data: any };

export type BankLookup = {
  token(mint: string): { underlyingKey: string; underlyingPerUiToken: number | null; scaledUi: ScaledUi | null } | null;
  perp(symbol: string): { unitsPerContract: number; underlyingKey: string } | null;
  /** The tradeable Phoenix market on an underlying, for a fade's short (heldOnPhoenix). */
  perpFor(underlyingKey: string): { symbol: string; unitsPerContract: number } | null;
};

export type PickAsset =
  | { type: "spot"; mint: string; perUi: number; scaledUi: ScaledUi | null | undefined; stock: string | null; underlyingKey: string | null }
  | { type: "perp"; symbol: string; units: number; leverage: number }
  | { type: "prediction"; eventTicker: string; instrument: string; side: GeminiSide }
  | { type: "yield" }
  | { type: "card"; cardId: string }
  | { type: "void"; reason: string };

/** What priced a base (take_legs.base_source): later marks use the same source. */
export type BaseSource =
  | { source: "token"; rule: "token"; mint: string; perUi: number; multiplier: number; premium: number | null }
  | { source: "stock"; rule: "stock-latest" | "stock-first-trade"; code: string; mint: string | null; multiplier: number | null }
  | { source: "phoenix"; rule: "phoenix-mark" | "phoenix-mid"; symbol: string; units: number }
  | { source: "gemini"; rule: "gemini-bid" | "gemini-resolution" | "gemini-ask"; instrument: string; side: GeminiSide }
  | { source: "lend"; rule: "lend-share-value" }
  | { source: "card"; rule: "card-insured-value"; cardId: string };

export type Base = { price: number; at: string; source: BaseSource & { inputs?: Record<string, unknown>; backfill?: string } };

export type Leg = {
  idx: number;
  name: string;
  kind: string;
  weight: number;
  asset_id: string | null;
  base_price?: number | null;
  base_at?: string | null;
  base_source?: Base["source"] | null;
  mark_price?: number | null;
};

/** Everything the run read, keyed for lookups: marking is synchronous and pure over it. */
export type Snapshot = {
  nowSec: number;
  /** Jupiter Price v3, by mint. `scaledUi` undefined: Jupiter said nothing about it. */
  tokens: Map<string, { usdPrice: number; liquidityUsd: number; scaledUi?: ScaledUi | null }>;
  /** Alpaca's latest trade, by ticker (unix seconds). */
  stocks: Map<string, { price: number; at: number }>;
  /** Phoenix, USD per contract, by symbol, and which rule gave it. */
  perps: Map<string, { price: number; rule: "phoenix-mark" | "phoenix-mid" }>;
  /** Gemini events' contracts, by event ticker. */
  events: Map<string, GeminiContract[]>;
  /** One jlUSDC share in USDC. */
  lend: number | null;
  /** Collector Crypt insured values in USD, by card id (the asset bank's picked cards). */
  cards?: Map<string, number>;
};

export type MarkOutcome = { ok: true; price: number; source: Base["source"] } | { ok: false; reason: string };

/** "Stock · 2x" → 2. */
export const leverageOf = (kind: string) => Number(kind.match(/(\d+)\s*x\b/i)?.[1] ?? 1) || 1;

/** A prediction pick's side, from how the app names it ("Rate cut: No", "Prediction · No"). */
export const predictionSide = (l: Pick<Leg, "name" | "kind">): GeminiSide => (/·\s*No\b|:\s*No\s*$/i.test(`${l.kind} | ${l.name}`) ? "no" : "yes");

const SPOT_KINDS = new Set(["stock", "etf", "commodity", "pre-ipo", "leveraged", "other"]);

export function resolvePick(leg: Pick<Leg, "name" | "kind" | "asset_id">, sec: Security | undefined, bank: BankLookup | null): PickAsset {
  const kind = leg.kind.toLowerCase();
  if (leg.asset_id?.startsWith("card:")) return { type: "card", cardId: leg.asset_id.slice("card:".length) };
  if (leg.asset_id?.startsWith("cards:") || kind.includes("card") || sec?.kind === "card") return { type: "void", reason: "a whole card category, not one card" };
  if (kind.includes("interest") || kind.includes("yield") || sec?.kind === "yield") return { type: "yield" };
  if (!leg.asset_id) return { type: "void", reason: "no catalog row for this pick" };
  if (!sec) return { type: "void", reason: `catalog row ${leg.asset_id} is gone` };
  if (sec.kind === "prediction" || leg.asset_id.startsWith("gemini:")) {
    const eventTicker = sec.data?.eventTicker;
    if (!eventTicker) return { type: "void", reason: "prediction row names no Gemini event" };
    return { type: "prediction", eventTicker, instrument: leg.asset_id.replace(/^gemini:/, ""), side: predictionSide(leg) };
  }
  if (sec.kind === "perp" || leg.asset_id.startsWith("phoenix:")) {
    const symbol = leg.asset_id.replace(/^phoenix:/, "");
    const units = bank?.perp(symbol)?.unitsPerContract ?? (/^k[A-Z]/.test(symbol) ? 1_000 : 1);
    return { type: "perp", symbol, units: units > 0 ? units : 1, leverage: leverageOf(leg.kind) };
  }
  if (SPOT_KINDS.has(sec.kind) && sec.mint) {
    const t = bank?.token(sec.mint) ?? null;
    if (t && !t.underlyingPerUiToken) return { type: "void", reason: `${sec.symbol}: the bank can't compare this token (unknown units per token)` };
    return {
      type: "spot",
      mint: sec.mint,
      perUi: t?.underlyingPerUiToken ?? 1,
      scaledUi: t ? t.scaledUi : undefined,
      stock: (sec.kind === "stock" || sec.kind === "etf") && sec.underlying ? sec.underlying : null,
      underlyingKey: t?.underlyingKey ?? null,
    };
  }
  return { type: "void", reason: `can't price a ${sec.kind} pick` };
}

/** The token's multiplier at `atSec`: Jupiter's live config when it gave one, else the bank's. Undefined: unknown. */
export function multiplierOf(asset: Extract<PickAsset, { type: "spot" }>, snap: Snapshot, atSec: number): number | undefined {
  const live = snap.tokens.get(asset.mint)?.scaledUi;
  const cfg = live !== undefined ? live : asset.scaledUi;
  return cfg === undefined ? undefined : effectiveMultiplier(cfg, atSec);
}

/** A spot pick's price now per underlying unit, by the settler's entry rule, unscaled (no base). */
export function spotNow(asset: Extract<PickAsset, { type: "spot" }>, snap: Snapshot): { price: number; via: "token" | "stock"; premium: number | null } | null {
  const tp = snap.tokens.get(asset.mint);
  const ref = asset.stock ? snap.stocks.get(asset.stock) : undefined;
  const fresh = !!ref && ref.price > 0 && snap.nowSec - ref.at <= STALE_REF_SECS;
  if (tp && tp.usdPrice > 0 && tp.liquidityUsd >= PRICEABLE_MIN_POOLED_USD) {
    const implied = tp.usdPrice / asset.perUi;
    return { price: implied, via: "token", premium: fresh ? implied / ref!.price : null };
  }
  if (ref && ref.price > 0) return { price: ref.price, via: "stock", premium: null };
  return null;
}

/** What a pick is worth now, in its base's terms (or, with no base, what a base would be). */
export function markPick(asset: PickAsset, snap: Snapshot, base: Base["source"] | null): MarkOutcome {
  switch (asset.type) {
    case "void":
      return { ok: false, reason: asset.reason };
    case "yield":
      return snap.lend && snap.lend > 0 ? { ok: true, price: snap.lend, source: { source: "lend", rule: "lend-share-value" } } : { ok: false, reason: "no jlUSDC share value" };
    case "card": {
      const v = snap.cards?.get(asset.cardId);
      return v && v > 0 ? { ok: true, price: v, source: { source: "card", rule: "card-insured-value", cardId: asset.cardId } } : { ok: false, reason: `no insured value for card ${asset.cardId} yet` };
    }
    case "perp": {
      const p = snap.perps.get(asset.symbol);
      if (!p || !(p.price > 0)) return { ok: false, reason: `no Phoenix price for ${asset.symbol}` };
      return { ok: true, price: p.price / asset.units, source: { source: "phoenix", rule: p.rule, symbol: asset.symbol, units: asset.units } };
    }
    case "prediction": {
      const c = snap.events.get(asset.eventTicker)?.find((x) => x.instrumentSymbol === asset.instrument);
      if (!c) return { ok: false, reason: `Gemini doesn't list ${asset.instrument}` };
      if (!c.resolutionSide) {
        const bad = bookProblem(c);
        if (bad) return { ok: false, reason: `${asset.instrument}: Gemini's quotes don't add up (${bad})` };
      }
      const p = legPrice(c, asset.side, "back", "exit");
      if (p === null) return { ok: false, reason: `no bid on ${asset.side} for ${asset.instrument}` };
      return { ok: true, price: p, source: { source: "gemini", rule: c.resolutionSide ? "gemini-resolution" : "gemini-bid", instrument: asset.instrument, side: asset.side } };
    }
    case "spot": {
      const mNow = multiplierOf(asset, snap, snap.nowSec);
      const ref = asset.stock ? snap.stocks.get(asset.stock) : undefined;
      if (!base) {
        const now = spotNow(asset, snap);
        if (!now) return { ok: false, reason: `no liquid token price and no stock trade for ${asset.stock ?? asset.mint}` };
        if (now.via === "token") {
          return { ok: true, price: now.price, source: { source: "token", rule: "token", mint: asset.mint, perUi: asset.perUi, multiplier: mNow ?? 1, premium: now.premium } };
        }
        return { ok: true, price: now.price, source: { source: "stock", rule: "stock-latest", code: asset.stock!, mint: asset.mint, multiplier: mNow ?? null } };
      }
      // Marks after the base: same source, scaled by multiplier now / at the base.
      const baseM = "multiplier" in base && base.multiplier && base.multiplier > 0 ? base.multiplier : null;
      if (baseM && mNow === undefined) return { ok: false, reason: `can't tell ${asset.mint}'s multiplier now` };
      const scale = baseM ? (mNow ?? 1) / baseM : 1;
      if (base.source === "token") {
        const now = spotNow(asset, snap);
        if (now?.via === "token") return { ok: true, price: now.price * scale, source: base };
        if (ref && ref.price > 0 && base.premium) return { ok: true, price: ref.price * base.premium * scale, source: base };
        return { ok: false, reason: `${asset.mint}: token can't be used now and its base has no premium to the stock` };
      }
      if (base.source === "stock") {
        if (ref && ref.price > 0) return { ok: true, price: ref.price * scale, source: base };
        return { ok: false, reason: `no ${base.code} trade` };
      }
      return { ok: false, reason: `a ${base.source} base on a spot pick` };
    }
  }
}

/** A prediction pick's ask now (what a buyer pays), from a coherent, still-active book; null otherwise. */
function predictionAsk(asset: Extract<PickAsset, { type: "prediction" }>, snap: Snapshot): number | null {
  const c = snap.events.get(asset.eventTicker)?.find((x) => x.instrumentSymbol === asset.instrument);
  if (!c || c.resolutionSide || bookProblem(c)) return null;
  const p = legPrice(c, asset.side, "back", "entry");
  return p !== null && p > 0 && p < 1 ? p : null;
}

type ReturnKind = "spot" | "perp" | "prediction" | "yield" | "card";
const returnKind = (a: PickAsset): ReturnKind | null => (a.type === "void" ? null : a.type);

/** One pick's return in percent: the program's formula as a back. Null when it can't be computed (base ≤ 0). */
export function legReturnPct(kind: ReturnKind, leverage: number, base: number, mark: number): number | null {
  if (!(base > 0) || !(mark >= 0)) return null;
  const bps = positionReturnBps([{ kind: { [kind]: {} } as any, weightBps: 10_000, leverage }], {
    side: { back: {} },
    legsMask: 1,
    prices: [{ entry: toPriceUnits(base), exit: toPriceUnits(mark) }],
  });
  return bps === null ? null : bps / 100;
}

/** The take's return in percent over the included picks, by weight (the program's weighted average). */
export function takeReturnPct(legs: { kind: ReturnKind; leverage: number; weight: number; base: number; mark: number }[]): number | null {
  if (!legs.length) return null;
  const weights = legs.map((l) => Math.max(1, Math.round(l.weight * 100)));
  const bps = positionReturnBps(
    legs.map((l, i) => ({ kind: { [l.kind]: {} } as any, weightBps: weights[i], leverage: l.leverage })),
    {
      side: { back: {} },
      legsMask: (1 << legs.length) - 1,
      prices: legs.map((l) => ({ entry: toPriceUnits(l.base), exit: toPriceUnits(l.mark) })),
    },
  );
  return bps === null ? null : bps / 100;
}

export type LegUpdate = {
  take_id: string;
  idx: number;
  mark_price: number;
  marked_at: string;
  ret_pct: number;
  base_price?: number;
  base_at?: string;
  base_source?: Base["source"];
};

export type TakePlan = { legs: LegUpdate[]; take: { take_id: string; ret_pct: number } | null; notes: string[] };

/**
 * One take's run: bases for picks that have none (from `historical` when the marker read one,
 * else the current mark), marks, and the take's return.
 */
export function planTake(
  take: { id: string; created_at: string },
  legs: Leg[],
  assets: Map<number, PickAsset>,
  snap: Snapshot,
  historical: Map<number, Base> = new Map(),
): TakePlan {
  const nowIso = new Date(snap.nowSec * 1000).toISOString();
  const out: LegUpdate[] = [];
  const notes: string[] = [];
  const included: { kind: ReturnKind; leverage: number; weight: number; base: number; mark: number }[] = [];
  let blocked = false;
  for (const l of legs) {
    const asset = assets.get(l.idx) ?? ({ type: "void", reason: "unresolved" } as const);
    const kind = returnKind(asset);
    if (!kind) {
      notes.push(`#${l.idx} ${l.name}: void (${(asset as { reason: string }).reason})`);
      continue;
    }
    const leverage = asset.type === "perp" ? asset.leverage : 1;
    let base: Base | null = l.base_price && l.base_price > 0 && l.base_source ? { price: l.base_price, at: l.base_at ?? nowIso, source: l.base_source } : null;
    let fresh: Base | null = null;
    let why = "";
    if (!base) {
      const h = historical.get(l.idx);
      if (h) fresh = h;
      else {
        const m = markPick(asset, snap, null);
        const late = snap.nowSec - Date.parse(take.created_at) / 1000 > LIVE_BASE_SECS;
        if (m.ok && m.price > 0) {
          fresh = { price: m.price, at: nowIso, source: late ? { ...m.source, backfill: "no price history at posting: the first mark is the base" } : m.source };
        } else {
          // A prediction with no bid yet (one-sided book): the ask, which is what a buyer pays and
          // what the settler signs at entry, so the pick doesn't hold its whole take back.
          const ask = asset.type === "prediction" ? predictionAsk(asset, snap) : null;
          if (ask && asset.type === "prediction") {
            fresh = { price: ask, at: nowIso, source: { source: "gemini", rule: "gemini-ask", instrument: asset.instrument, side: asset.side, ...(late ? { backfill: "no price history at posting: the first ask is the base" } : {}) } as Base["source"] };
          }
          else why = m.ok ? "it's already worth 0" : m.reason;
        }
      }
      base = fresh;
    }
    if (!base) {
      // A prediction that resolved before its first mark can never get a base (Gemini keeps no
      // price history): leave it out, as a void pick, rather than hold the take back for good.
      const resolved = asset.type === "prediction" && snap.events.get(asset.eventTicker)?.find((x) => x.instrumentSymbol === asset.instrument)?.resolutionSide;
      if (resolved) {
        notes.push(`#${l.idx} ${l.name}: void (resolved ${resolved} before it could be marked)`);
        continue;
      }
      notes.push(`#${l.idx} ${l.name}: no base yet (${why})`);
      blocked = true;
      continue;
    }
    const m = markPick(asset, snap, base.source);
    let mark: number | null = m.ok ? m.price : null;
    if (!m.ok) {
      if (l.mark_price != null && l.mark_price >= 0 && !fresh) {
        mark = l.mark_price;
        notes.push(`#${l.idx} ${l.name}: kept last mark (${m.reason})`);
      } else if (fresh?.source.source === "gemini" && fresh.source.rule === "gemini-ask") {
        // Based on the ask with no bid yet: unchanged until a bid appears.
        mark = fresh.price;
        notes.push(`#${l.idx} ${l.name}: marked at its base until a bid appears (${m.reason})`);
      } else {
        notes.push(`#${l.idx} ${l.name}: no mark (${m.reason})`);
        blocked = true;
        continue;
      }
    }
    const ret = legReturnPct(kind, leverage, base.price, mark!);
    if (ret === null) {
      notes.push(`#${l.idx} ${l.name}: return not computable`);
      blocked = true;
      continue;
    }
    included.push({ kind, leverage, weight: l.weight, base: base.price, mark: mark! });
    if (m.ok || fresh) {
      out.push({
        take_id: take.id,
        idx: l.idx,
        mark_price: mark!,
        marked_at: nowIso,
        ret_pct: ret,
        ...(fresh ? { base_price: fresh.price, base_at: fresh.at, base_source: fresh.source } : {}),
      });
    }
  }
  const ret = blocked ? null : takeReturnPct(included);
  if (blocked) notes.push("take return not written: a pick has no price yet");
  return { legs: out, take: ret === null ? null : { take_id: take.id, ret_pct: ret }, notes };
}
