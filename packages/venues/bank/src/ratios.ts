// How much of the underlying one issuer token buys, so different issuers of the
// same underlying can be compared per dollar.
//
//   underlying units = raw amount / 10^decimals * uiMultiplier * underlyingPerUiToken
//
// uiMultiplier is the Token-2022 ScaledUiAmount multiplier read from the mint
// (1 when the mint has no such extension). Issuers raise it for reinvested
// dividends and splits, so the UI amount stays equal to share-equivalents:
//   - xStocks: "the multiplier sets the ratio between an xStock and its underlying"
//     (Kraken xStocks FAQ); dividends raise it instead of paying cash.
//   - Ondo Global Markets: dividends are reinvested and, on Solana, "reflected in the
//     displayed token balance" through Scaled UI (Ondo corporate-actions docs).
//   - Backpack Securities: 1:1 backed by shares; multiplier 1 on almost every mint.
// Checked by hand: Jupiter Price v3's usdPrice for these tokens is per UI unit
// and matches its own stockData.price (the share price) within 0.1%, including NFLXx
// and NFLXon at multiplier 10 against Backpack's NFLX at multiplier 1.
//
// Anything we cannot source is NOT comparable: it is never chosen over a comparable
// issuer, and is used only when it is the sole issuer of its underlying.
import type { Source } from "../../registry/src/curated.ts";
import { MINT_INFO } from "../../registry/src/curated.ts";

export type UsPersons = "no" | "unverified" | "yes";

export type RatioInfo =
  | { comparable: true; underlyingPerUiToken: number; unit: string; basis: string; sources: Source[] }
  | { comparable: false; underlyingPerUiToken: null; reason: string; sources: Source[] };

type IssuerPolicy = { usPersons: UsPersons; ratio: RatioInfo };

const SCALED_SHARES = (issuer: string, sources: Source[]): RatioInfo => ({
  comparable: true,
  underlyingPerUiToken: 1,
  unit: "share",
  basis: `${issuer}: one UI token (raw amount x ScaledUiAmount multiplier) = one share-equivalent`,
  sources,
});

/** Keyed by the registry's issuer tag. */
export const ISSUER_POLICY: Record<string, IssuerPolicy> = {
  xstocks: {
    usPersons: "no",
    ratio: SCALED_SHARES("xStocks", [
      { url: "https://support.kraken.com/articles/xstocks-faq", note: "multiplier = ratio between an xStock and its underlying" },
      { url: "https://support.kraken.com/articles/corporate-actions-xstocks-kraken-app", note: "dividends raise the multiplier" },
      { url: "https://solana.com/docs/tokens/extensions/scaled-ui-amount", note: "UI amount = raw amount x multiplier" },
    ]),
  },
  ondo: {
    usPersons: "no",
    ratio: SCALED_SHARES("Ondo Global Markets", [
      { url: "https://docs.ondo.finance/ondo-global-markets/corporate-actions", note: "dividends reinvested, shown in the Scaled UI balance on Solana" },
      { url: "https://solana.com/docs/tokens/extensions/scaled-ui-amount" },
    ]),
  },
  backpack: {
    usPersons: "unverified",
    ratio: SCALED_SHARES("Backpack Securities", [
      { url: "https://solanacompass.com/news/backpack-securities-launches-tokenized-us-equity-and-etf-trading-on-solana", note: "1:1 backed by shares" },
    ]),
  },
  remora: {
    usPersons: "unverified",
    ratio: { comparable: false, underlyingPerUiToken: null, reason: "Remora rStocks: issuer terms and multiplier semantics are unpublished", sources: [] },
  },
  prestocks: {
    usPersons: "unverified",
    ratio: { comparable: false, underlyingPerUiToken: null, reason: "PreStocks are SPV units; shares per token are not published", sources: [] },
  },
  tessera: {
    usPersons: "unverified",
    ratio: { comparable: false, underlyingPerUiToken: null, reason: "Tessera pre-IPO units; shares per token are not published", sources: [] },
  },
  shift: {
    usPersons: "unverified",
    ratio: { comparable: true, underlyingPerUiToken: 1, unit: "token", basis: "SHIFT leveraged token is its own underlying (token:<mint>)", sources: [] },
  },
};

export type RatioInput = { mint: string; issuerTag: string | null; underlyingKey: string };

export function ratioFor(t: RatioInput): RatioInfo {
  if (t.underlyingKey.startsWith("token:")) {
    return { comparable: true, underlyingPerUiToken: 1, unit: "token", basis: "the token is its own underlying", sources: [] };
  }
  if (t.issuerTag && ISSUER_POLICY[t.issuerTag]) return ISSUER_POLICY[t.issuerTag].ratio;
  const mi = MINT_INFO[t.mint];
  if (mi?.ratio) {
    return { comparable: true, underlyingPerUiToken: mi.ratio.underlyingPerToken, unit: mi.ratio.unit, basis: `${mi.issuer}: 1 token = ${mi.ratio.unit}`, sources: [mi.ratio.source] };
  }
  return { comparable: false, underlyingPerUiToken: null, reason: mi ? `${mi.issuer}: no published units per token` : "issuer not in the curated list", sources: [] };
}

export function usPersonsFor(t: { mint: string; issuerTag: string | null }): UsPersons {
  if (t.issuerTag && ISSUER_POLICY[t.issuerTag]) return ISSUER_POLICY[t.issuerTag].usPersons;
  return MINT_INFO[t.mint]?.usPersons ?? "unverified";
}

/** The ScaledUiAmount config as stored on the mint. Timestamps are unix seconds. */
export type ScaledUi = { multiplier: number; newMultiplier: number; newMultiplierEffectiveAt: number };

/** Reads the ScaledUiAmount config from a jsonParsed mint account, or null if the mint has none. */
export function readScaledUi(acc: any): ScaledUi | null {
  const ext = (acc?.data?.parsed?.info?.extensions ?? []).find((e: any) => e.extension === "scaledUiAmountConfig");
  if (!ext) return null;
  const st = ext.state ?? {};
  return { multiplier: Number(st.multiplier ?? 1), newMultiplier: Number(st.newMultiplier ?? st.multiplier ?? 1), newMultiplierEffectiveAt: Number(st.newMultiplierEffectiveTimestamp ?? 0) };
}

/** The multiplier in force at `nowSec` (a scheduled newMultiplier takes over at its timestamp). */
export function effectiveMultiplier(s: ScaledUi | null, nowSec: number): number {
  if (!s) return 1;
  const m = s.newMultiplierEffectiveAt > 0 && nowSec >= s.newMultiplierEffectiveAt ? s.newMultiplier : s.multiplier;
  return Number.isFinite(m) && m > 0 ? m : 1;
}

export type UnitsInput = { decimals: number; scaledUi: ScaledUi | null; underlyingPerUiToken: number; transferFeeBps?: number | null };

/** Underlying units delivered by `rawAmount` base units of a token, net of any Token-2022 transfer fee. */
export function underlyingUnits(rawAmount: string | number | bigint, t: UnitsInput, nowSec: number): number {
  const ui = (Number(rawAmount) / 10 ** t.decimals) * effectiveMultiplier(t.scaledUi, nowSec);
  const fee = (t.transferFeeBps ?? 0) / 1e4;
  return ui * t.underlyingPerUiToken * (1 - fee);
}
