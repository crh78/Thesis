// Supabase takes store legs as display names ("NVIDIA", "Rate cut: Yes", "Cash"); the program
// needs what each leg tracks. Until the take builder writes underlying keys, this resolves the
// names the app uses to underlyings (a fixed list for the demo takes, then the take builder's
// catalog and the asset bank for names the AI wrote, e.g. "Advanced Micro Devices"), and says
// which legs can actually be traded on the fork.
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { FADE_VIA, LEG_KIND, type LegSpec } from "@thesis/chain";
import { underlyingId } from "@thesis/venues/bank";
import { cardIdHex } from "@thesis/venues/collector-crypt";
import { predictionIdHex, type GeminiContract, type GeminiSide } from "@thesis/venues/gemini";
import { JL_USDC_MINT } from "@thesis/venues/jupiter";

/** A leg as `take(p_id)` returns it. `asset_id` is its catalog row (`gemini:<...>` for predictions). */
export type AppLeg = { name: string; kind: string; weight: number; fade_how: string | null; asset_id?: string | null };

/**
 * A prediction pick's Gemini contract: `asset_id` names a contract (`gemini:<instrumentSymbol>`),
 * or an event with exactly one contract (`gemini:<eventTicker>`, older catalog rows). Null when
 * nothing matches, or an event has several contracts and the pick doesn't say which.
 */
export type ContractResolver = (assetId: string | null | undefined) => { contract: GeminiContract } | { blocked: string };

export type MappedLeg = {
  index: number;
  name: string;
  spec: LegSpec;
  /** Underlying key in the asset bank, for stock and yield legs; `gemini:<instrument>:<side>` for predictions. */
  key: string | null;
  /**
   * `paper`: a prediction leg, filled on paper at Gemini's prices (its share is escrowed, not
   * traded). `card`: a Collector Crypt card, filled on paper at its insured value, escrowed the
   * same way. `perp`: a Phoenix perp leg (leverage).
   */
  how: "swap" | "lend" | "paper" | "card" | "perp" | null;
  /** Perp legs: the Phoenix market a back goes long on, at the leg's leverage. */
  phoenix?: PerpRef;
  /** Spot and perp legs: the Phoenix market a fade shorts, when Phoenix lists the underlying. */
  short?: PerpRef;
  /** Prediction legs: the contract and the side the take holds. */
  prediction?: { contract: GeminiContract; side: GeminiSide };
  /** Card legs: the Collector Crypt card (catalog row `card:<cardId>`). */
  card?: { cardId: string };
  /** Why it can't be traded on the fork, or null if it can. */
  blocked: string | null;
};

/** Names the demo takes show → underlying keys. Names with no tokenized version map to null. */
const NAME_TO_UNDERLYING: Record<string, string | null> = {
  NVIDIA: "equity:US:NVDA",
  TSMC: "equity:US:TSM",
  AMD: "equity:US:AMD",
  Tesla: "equity:US:TSLA",
  Microsoft: "equity:US:MSFT",
  Amazon: "equity:US:AMZN",
  Alphabet: "equity:US:GOOGL",
  Micron: "equity:US:MU",
  Gold: "etf:US:GLD",
  Vistra: "equity:US:VST",
  Constellation: "equity:US:CEG",
  "T-bills": "etf:US:SGOV",
  "S&P 500": "etf:US:SPY",
  Utilities: null,
  Homebuilders: null,
};

/** A Phoenix market, as the asset bank lists it. */
export type PerpRef = { symbol: string; underlying: string; maxLeverage: number; tradeable: boolean };

/** Phoenix markets by symbol and by underlying, from the asset bank's Phoenix tier. */
export type PerpResolver = { bySymbol(symbol: string): PerpRef | null; forUnderlying(key: string | null): PerpRef | null };

export function perpResolver(markets: PerpRef[] | null | undefined): PerpResolver {
  const bySymbol = new Map((markets ?? []).map((m) => [m.symbol, m]));
  const byUnderlying = new Map<string, PerpRef>();
  // The first tradeable market for an underlying, else the first listed.
  for (const m of markets ?? []) if (!byUnderlying.has(m.underlying) || (m.tradeable && !byUnderlying.get(m.underlying)!.tradeable)) byUnderlying.set(m.underlying, m);
  return { bySymbol: (s) => bySymbol.get(s) ?? null, forUnderlying: (k) => (k ? byUnderlying.get(k) ?? null : null) };
}

const noPerps: PerpResolver = perpResolver([]);

/** The most leverage a perp leg can have. */
const MAX_PERP_LEVERAGE = 5;

/**
 * A perp pick's leverage, as the take builder chose it ("Stock · 3x"), never above 5x or what
 * the market allows. There's no default: a perp pick that doesn't say is
 * null, and the leg is left out.
 */
export function perpLeverage(kind: string, market: PerpRef | null): number | null {
  const lever = /(\d+)x/.exec(kind);
  if (!lever) return null;
  return Math.max(1, Math.min(Number(lever[1]), MAX_PERP_LEVERAGE, Math.floor(market?.maxLeverage ?? MAX_PERP_LEVERAGE)));
}

/** Resolves a leg's display name to an underlying key, or null if nothing tracks it. */
export type NameResolver = (name: string) => string | null;

const fixedNames: NameResolver = (name) => NAME_TO_UNDERLYING[name] ?? null;

/** A catalog row's fields this needs (packages/take-builder/catalog.json). */
export type CatalogName = { name: string; symbol: string; kind: string; underlying: string | null };

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ - backpack securities$| xstock$| \(.*\)$/, "")
    .replace(/[.,]/g, "")
    .replace(/\b(inc|corp|corporation|co|ltd|plc|nv|sa|ag|se|class [a-c]|holdings)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Resolves names with the fixed list first, then the take builder's catalog (the names the AI
 * writes, mapped to their ticker), then the asset bank's own names and tickers. Only keys the
 * asset bank knows are returned, so routing can price them.
 */
export function nameResolver(bankUnderlyings: Record<string, { name?: string | null; code: string; cls: string }>, catalog: CatalogName[] = []): NameResolver {
  const inBank = (k: string | null | undefined) => (k && bankUnderlyings[k] ? k : null);
  const catalogKey = new Map<string, string>();
  for (const r of catalog) {
    if (!r.underlying) continue;
    // Stocks and funds by ticker; commodity tokens (PAX Gold) by what they track (XAU).
    const key =
      r.kind === "stock" || r.kind === "etf"
        ? (inBank(`equity:US:${r.underlying}`) ?? inBank(`etf:US:${r.underlying}`))
        : r.kind === "commodity"
          ? inBank(`commodity:${r.underlying}`)
          : null;
    if (!key) continue;
    for (const n of [r.name, r.symbol]) if (!catalogKey.has(norm(n))) catalogKey.set(norm(n), key);
  }
  const bankName = new Map<string, string>();
  for (const [k, u] of Object.entries(bankUnderlyings)) {
    if (!/^(equity|etf):US:/.test(k)) continue;
    for (const n of [u.name, u.code]) if (n && !bankName.has(norm(n))) bankName.set(norm(n), k);
  }
  return (name) => {
    if (name in NAME_TO_UNDERLYING) return NAME_TO_UNDERLYING[name];
    const n = norm(name);
    return catalogKey.get(n) ?? bankName.get(n) ?? null;
  };
}

const YIELD_KEY = `token:${JL_USDC_MINT}`;
/** A picked card's catalog id: `card:<Collector Crypt card id>` (the take builder writes the row). */
export const CARD_PREFIX = "card:";

/** Legs filled on paper (prediction and card legs): nothing is traded, the program escrows their share. */
export const isPaper = (how: MappedLeg["how"]) => how === "paper" || how === "card";
/** On-chain leg kinds the program escrows (its `LegKind::is_escrowed`). */
export const escrowedKind = (kind: object) => "prediction" in kind || "card" in kind;

/** A stable 32-byte id for legs with no bank underlying (prediction markets, unknown names). */
const nameId = (prefix: string, name: string) => new PublicKey(createHash("sha256").update(`thesis:${prefix}:v1:${name}`).digest());

/** Weights in percent (two decimals) → bps that add up to exactly 10,000. */
export function weightsToBps(weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new Error("legs have no weight");
  const bps = weights.map((w) => Math.max(1, Math.floor((w / total) * 10_000)));
  const rest = 10_000 - bps.reduce((a, b) => a + b, 0);
  bps[bps.indexOf(Math.max(...bps))] += rest;
  return bps;
}

/** Resolves `gemini:<...>` asset ids against the asset bank's Gemini contracts. */
export function contractResolver(contracts: Record<string, GeminiContract> | undefined): ContractResolver {
  const byEvent = new Map<string, GeminiContract[]>();
  for (const c of Object.values(contracts ?? {})) byEvent.set(c.eventTicker, [...(byEvent.get(c.eventTicker) ?? []), c]);
  return (assetId) => {
    const id = assetId?.startsWith("gemini:") ? assetId.slice("gemini:".length) : null;
    if (!id) return { blocked: "no Gemini market for this pick" };
    const direct = contracts?.[id];
    if (direct) return { contract: direct };
    const event = byEvent.get(id) ?? [];
    if (event.length === 1) return { contract: event[0] };
    if (event.length > 1) return { blocked: "the pick names a Gemini event with several contracts, not one" };
    return { blocked: "Gemini doesn't list this market right now" };
  };
}

/** "Prediction · No" (or a name ending ": No") holds No; anything else holds Yes. */
export const predictionSide = (l: Pick<AppLeg, "name" | "kind">): GeminiSide =>
  /·\s*no\b/i.test(l.kind) || /:\s*no$/i.test(l.name.trim()) ? "no" : "yes";

const noContracts: ContractResolver = () => ({ blocked: "no Gemini market for this pick" });

export function mapLegs(legs: AppLeg[], resolve: NameResolver = fixedNames, contracts: ContractResolver = noContracts, perps: PerpResolver = noPerps): MappedLeg[] {
  if (!legs.length) throw new Error("take has no legs");
  const bps = weightsToBps(legs.map((l) => Number(l.weight)));
  const used = new Set<string>();
  return legs.map((l, index) => {
    const kind = l.kind.toLowerCase();
    const fadeable = l.fade_how !== null;
    const base = { index, name: l.name, key: null as string | null, how: null as MappedLeg["how"], blocked: null as string | null };
    let spec: LegSpec;
    if (kind.startsWith("prediction")) {
      // Every prediction leg can be faded: a fade holds its other side.
      const found = contracts(l.asset_id);
      if ("contract" in found) {
        const side = predictionSide(l);
        const c = found.contract;
        spec = { kind: LEG_KIND.prediction, asset: new PublicKey(Buffer.from(predictionIdHex(c.instrumentSymbol, side), "hex")), weightBps: bps[index], leverage: 1, fadeVia: FADE_VIA.predictionNo };
        Object.assign(base, { key: `gemini:${c.instrumentSymbol}:${side}`, how: "paper", prediction: { contract: c, side } });
      } else {
        spec = { kind: LEG_KIND.prediction, asset: nameId("prediction", l.name), weightBps: bps[index], leverage: 1, fadeVia: FADE_VIA.predictionNo };
        base.blocked = found.blocked;
      }
    } else if (l.asset_id?.startsWith(CARD_PREFIX)) {
      // A Collector Crypt card the take builder picked: Card kind, filled on
      // paper at the card's insured value, its share escrowed like a prediction leg's. Never faded.
      const cardId = l.asset_id.slice(CARD_PREFIX.length);
      spec = { kind: LEG_KIND.card, asset: new PublicKey(Buffer.from(cardIdHex(cardId), "hex")), weightBps: bps[index], leverage: 1, fadeVia: FADE_VIA.none };
      Object.assign(base, { key: l.asset_id, how: "card", card: { cardId } });
    } else if (l.asset_id?.startsWith("cards:") || kind.includes("card")) {
      // An older card pick names a whole category ("Pokemon trading cards"), not a card, so there's
      // nothing to price: a trade leaves it out. (A card pick's kind can read "Stock", so the
      // catalog id decides, not the name.) Same asset id an unresolved name got before, so takes
      // already posted still match on chain.
      const cleanName = l.name.replace(/\s+\d+x$/i, "").replace(/\s+perp$/i, "");
      spec = { kind: LEG_KIND.card, asset: nameId("name", cleanName), weightBps: bps[index], leverage: 1, fadeVia: FADE_VIA.none };
      base.blocked = "this pick is a whole card category, not one card";
    } else if (kind.includes("interest") || kind.includes("yield")) {
      spec = { kind: LEG_KIND.yield, asset: new PublicKey(underlyingId(YIELD_KEY)), weightBps: bps[index], leverage: 1, fadeVia: FADE_VIA.none };
      Object.assign(base, { key: YIELD_KEY, how: "lend" });
    } else {
      const cleanName = l.name.replace(/\s+\d+x$/i, "").replace(/\s+perp$/i, "");
      // A perp pick names its Phoenix market (`phoenix:<SYMBOL>`); older picks only say "2x".
      const pick = l.asset_id?.startsWith("phoenix:") ? perps.bySymbol(l.asset_id.slice("phoenix:".length)) : null;
      const isPerp = Boolean(pick) || l.asset_id?.startsWith("phoenix:") || /\d+x/.test(kind);
      const key = pick?.underlying ?? resolve(cleanName);
      const asset = key ? new PublicKey(underlyingId(key)) : nameId("name", cleanName);
      const market = pick ?? perps.forUnderlying(key);
      if (isPerp) {
        const leverage = perpLeverage(kind, market);
        spec = { kind: LEG_KIND.perp, asset, weightBps: bps[index], leverage: leverage ?? 1, fadeVia: FADE_VIA.phoenixShort };
        base.key = key;
        if (leverage === null) base.blocked = `${cleanName}: this leveraged pick doesn't say its leverage`;
        else if (!market) base.blocked = `Phoenix lists no ${cleanName} market`;
        else if (!market.tradeable) base.blocked = `Phoenix's ${market.symbol} market is too thin right now`;
        else Object.assign(base, { how: "perp", phoenix: market, short: market });
      } else {
        spec = { kind: LEG_KIND.spot, asset, weightBps: bps[index], leverage: 1, fadeVia: fadeable ? FADE_VIA.phoenixShort : FADE_VIA.none };
        Object.assign(base, key ? { key, how: "swap" } : { blocked: `no tokenized ${cleanName} on Solana` });
        if (fadeable && market?.tradeable) Object.assign(base, { short: market });
      }
    }
    // The program rejects two legs with the same asset (e.g. NVIDIA and NVIDIA 2x).
    const id = spec.asset.toBase58();
    if (used.has(id)) {
      spec = { ...spec, asset: nameId("dup", `${l.name}#${index}`) };
      base.blocked ??= "the same underlying is already another leg";
    }
    used.add(spec.asset.toBase58());
    return { ...base, spec };
  });
}

/** Same legs (asset, weight, leverage, in order) as a take already on-chain? */
export function sameLegs(onChain: { asset: PublicKey; weightBps: number; leverage: number }[], legs: MappedLeg[]): boolean {
  return (
    onChain.length === legs.length &&
    legs.every((l, i) => onChain[i].asset.equals(l.spec.asset) && onChain[i].weightBps === l.spec.weightBps && onChain[i].leverage === l.spec.leverage)
  );
}

/**
 * Lines app legs up with a take already on-chain: a leg whose on-chain asset differs (the take
 * was posted before its name could be resolved) can't be traded, since its receipt would record
 * something other than what was bought.
 */
export function onChainLegs(legs: MappedLeg[], onChain: { asset: PublicKey }[]): MappedLeg[] {
  return legs.map((l, i) =>
    onChain[i] && !onChain[i].asset.equals(l.spec.asset)
      ? { ...l, spec: { ...l.spec, asset: onChain[i].asset }, how: null, phoenix: undefined, short: undefined, blocked: l.blocked ?? "posted before this asset could be traded" }
      : l,
  );
}
