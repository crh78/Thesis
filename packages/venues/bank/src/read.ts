// What the AI reads: only tradeable, recently measured assets, grouped by
// underlying and by theme, each with its best current issuer.
import type { CardsSummary } from "../../registry/src/sources/cards.ts";
import type { GeminiSummary } from "../../registry/src/sources/gemini.ts";
import type { YieldVault } from "../../registry/src/sources/yield.ts";
import { FRESHNESS_ENV } from "./config.ts";
import { envVar } from "../../registry/src/lib/env.ts";
import { defaultSink, type BankSink } from "./sinks.ts";
import { effectiveMultiplier, type UsPersons } from "./ratios.ts";
import { ageMs, bankBestIssuer, isFreshTradeable, type BankState, type PerpMarket, type TokenEntry, type UnderlyingEntry } from "./state.ts";
import type { UnderlyingClass } from "./identity.ts";

export type IssuerView = {
  mint: string;
  symbol: string;
  issuer: string;
  issuerTag: string | null;
  comparable: boolean;
  /** How units were derived, or why they cannot be. */
  ratioNote: string;
  underlyingPerUiToken: number | null;
  uiMultiplier: number;
  usPersons: UsPersons;
  priceUsd: number | null;
  unitsPerUsd100: number | null;
  premium100Pct: number | null;
  cost100Pct: number | null;
  cost1000Pct: number | null;
  transferFeeBps: number | null;
  permanentDelegate: boolean;
  pricedAt: string | null;
  probedAt: string | null;
};

export type UnderlyingView = {
  key: string;
  /** sha256("thesis:underlying:v1:" + key), hex: LegSpec.asset for spot legs. */
  idHex: string;
  cls: UnderlyingClass;
  code: string;
  name: string;
  themes: string[];
  refPriceUsd: number | null;
  pythFeedId: string | null;
  /** Bank-time best issuer (from the last probes). Re-check with bestIssuer() at trade time. */
  best: IssuerView | null;
  issuers: IssuerView[];
  perps: PerpMarket[];
};

export type AssetBank = {
  readAt: string;
  updatedAt: string;
  source: string;
  freshness: { maxProbeAgeMs: number; maxPriceAgeMs: number; maxVenueAgeMs: number; maxGeminiAgeMs: number };
  underlyings: UnderlyingView[];
  /** Theme -> underlying keys. Underlyings with no curated theme are under "Other". */
  byTheme: Record<string, string[]>;
  usdcYield: YieldVault[];
  predictions: GeminiSummary | null;
  cards: CardsSummary | null;
  /** Tiers whose last success is older than the freshness window, so callers can tell the bank is degraded. */
  staleTiers: string[];
};

export type GetAssetBankOpts = {
  sink?: BankSink;
  state?: BankState;
  now?: number;
  freshness?: Partial<AssetBank["freshness"]>;
};

function defaultFreshness(get: (k: string) => string | null = envVar): AssetBank["freshness"] {
  const out: Record<string, number> = {};
  for (const [k, [name, dflt, unit]] of Object.entries(FRESHNESS_ENV)) {
    const raw = get(name);
    out[k] = (raw !== null && Number.isFinite(Number(raw)) ? Number(raw) : dflt) * unit;
  }
  return out as AssetBank["freshness"];
}

function issuerView(t: TokenEntry, nowSec: number): IssuerView {
  return {
    mint: t.mint,
    symbol: t.symbol,
    issuer: t.issuer,
    issuerTag: t.issuerTag,
    comparable: t.ratio.comparable,
    ratioNote: t.ratio.comparable ? t.ratio.basis : t.ratio.reason,
    underlyingPerUiToken: t.ratio.underlyingPerUiToken,
    uiMultiplier: effectiveMultiplier(t.scaledUi, nowSec),
    usPersons: t.usPersons,
    priceUsd: t.price?.usd ?? null,
    unitsPerUsd100: t.liquidity.unitsPerUsd100,
    premium100Pct: t.liquidity.premium100Pct,
    cost100Pct: t.liquidity.cost100Pct,
    cost1000Pct: t.liquidity.cost1000Pct,
    transferFeeBps: t.transferFeeBps,
    permanentDelegate: t.permanentDelegate,
    pricedAt: t.price?.at ?? null,
    probedAt: t.probe?.at ?? null,
  };
}

/** Pure view over a state; getAssetBank() loads the state and calls this. */
export function viewAssetBank(state: BankState, nowMs: number, freshness: AssetBank["freshness"], source = "state"): AssetBank {
  const nowSec = Math.floor(nowMs / 1000);
  const phx = state.venues.phoenix && ageMs(state.venues.phoenix.at, nowMs) <= freshness.maxVenueAgeMs ? state.venues.phoenix : null;
  const perpsBy = new Map<string, PerpMarket[]>();
  for (const m of phx?.markets ?? []) if (m.tradeable) perpsBy.set(m.underlying, [...(perpsBy.get(m.underlying) ?? []), m]);

  const underlyings: UnderlyingView[] = [];
  for (const u of Object.values(state.underlyings) as UnderlyingEntry[]) {
    const fresh = u.mints.map((m) => state.tokens[m]).filter((t): t is TokenEntry => Boolean(t) && isFreshTradeable(t, nowMs, freshness));
    const perps = perpsBy.get(u.key) ?? [];
    if (!fresh.length && !perps.length) continue;
    const best = bankBestIssuer(state, u, nowMs, freshness);
    const issuers = fresh.map((t) => issuerView(t, nowSec)).sort((a, b) => (b.unitsPerUsd100 ?? -1) - (a.unitsPerUsd100 ?? -1) || (a.cost100Pct ?? 99) - (b.cost100Pct ?? 99));
    underlyings.push({ key: u.key, idHex: u.idHex, cls: u.cls, code: u.code, name: u.name, themes: u.themes, refPriceUsd: u.refPriceUsd, pythFeedId: u.pythFeedId, best: best ? issuerView(best, nowSec) : null, issuers, perps });
  }
  underlyings.sort((a, b) => a.key.localeCompare(b.key));
  const byTheme: Record<string, string[]> = {};
  for (const u of underlyings) for (const th of u.themes.length ? u.themes : ["Other"]) (byTheme[th] ??= []).push(u.key);

  const venueFresh = <T extends { at: string } | null>(v: T, maxMs = freshness.maxVenueAgeMs) => (v && ageMs(v.at, nowMs) <= maxMs ? v : null);
  const maxTierAge = (name: string) => (name === "discovery" ? 3 * 3_600_000 : name === "gemini" ? freshness.maxGeminiAgeMs : freshness.maxVenueAgeMs);
  const staleTiers = Object.entries(state.tiers)
    .filter(([name, s]) => name !== "flush" && ageMs(s.lastOkAt, nowMs) > maxTierAge(name))
    .map(([name]) => name);
  return {
    readAt: new Date(nowMs).toISOString(),
    updatedAt: state.updatedAt,
    source,
    freshness,
    underlyings,
    byTheme,
    usdcYield: [...(venueFresh(state.venues.yield)?.vaults ?? [])].sort((a, b) => (b.apyPct ?? 0) - (a.apyPct ?? 0)),
    predictions: venueFresh(state.venues.gemini, freshness.maxGeminiAgeMs)?.summary ?? null,
    cards: venueFresh(state.venues.cards)?.summary ?? null,
    staleTiers,
  };
}

export async function loadBankState(sink: BankSink = defaultSink()): Promise<BankState> {
  const s = await sink.load();
  if (!s) throw new Error(`asset bank is empty (${sink.name} sink): start the poller with 'pnpm --filter @thesis/executor asset-bank'`);
  return s;
}

/** The AI's entry point. Reads the bank from the configured sink (JSON file by default). */
export async function getAssetBank(o: GetAssetBankOpts = {}): Promise<AssetBank> {
  const sink = o.sink ?? (o.state ? null : defaultSink());
  const state = o.state ?? (await loadBankState(sink!));
  return viewAssetBank(state, o.now ?? Date.now(), { ...defaultFreshness(), ...o.freshness }, sink?.name ?? "state");
}
