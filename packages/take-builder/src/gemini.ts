// Gemini prediction contracts as take-builder catalog rows (public.securities), one per contract,
// so a pick names the contract the fork API trades (`gemini:<instrumentSymbol>`). See
// docs/gemini-plan.md: all categories; a contract qualifies while it resolves at least an hour
// out and is two-sided on both sides: every pick can be faded, and a fade buys the other side
// (requiring only one side could offer a fade with no book).
import { ineligibleAsPick, type GeminiContract } from "../../venues/gemini/src/markets.ts";

export type CatalogRow = {
  id: string; kind: "prediction"; symbol: string; name: string; underlying: null; issuer: string;
  venue: string; mint: null; themes: string[]; liquidity: "tradeable"; us_persons: "yes";
  can_short: boolean; expires_at: string | null; data: Record<string, unknown>;
};

export function geminiRows(contracts: GeminiContract[], nowMs = Date.now()): CatalogRow[] {
  return contracts
    .filter((c) => !ineligibleAsPick(c, nowMs))
    .map((c) => {
      // Gemini's event titles are questions ("Gold price on December 20?"): drop the "?" before the
      // contract's label, so the name reads "Gold price on December 20: $3,975 or above".
      const name = c.label && c.label !== c.eventTitle ? `${c.eventTitle.replace(/\?\s*$/, "")}: ${c.label}` : c.eventTitle;
      return {
        id: `gemini:${c.instrumentSymbol}`,
        kind: "prediction",
        symbol: c.instrumentSymbol,
        name: name.slice(0, 160),
        underlying: null,
        issuer: "Gemini",
        venue: "Gemini",
        mint: null,
        themes: c.category ? [c.category.toLowerCase()] : [],
        liquidity: "tradeable",
        // Gemini's prediction markets are open to US users (CLAUDE.md, US mode).
        us_persons: "yes",
        // Fades hold the other side.
        can_short: true,
        expires_at: c.expiry,
        // Static fields only: prices are read live, never stored in the catalog.
        data: { eventTicker: c.eventTicker, eventTitle: c.eventTitle, label: c.label, category: c.category, description: `Prediction market on Gemini: ${name}.` },
      };
    });
}
