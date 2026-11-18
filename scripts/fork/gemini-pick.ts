// The Gemini contract an e2e suite trades: from the asset bank's sweep, the first that also reads
// live through the `gemini` proxy (as the fork API reads it for a trade) with a two-sided market
// on both sides. A bank copy can be hours old, and one event's live read can fail (HTTP 500 for a
// days-old NFL event), which made the API leave the leg out and the suite fail with fade_unavailable.
import { ineligible, type GeminiContract } from "@thesis/venues/gemini";

/** Candidates tried at most, so a bad sweep doesn't read dozens of events. */
export const MAX_TRIES = 10;

/** What the suite needs: both sides tradable, Yes priced away from the edges, and days to run. */
export function suits(c: GeminiContract, now: number): string | null {
  const why = ineligible(c, "yes", now) ?? ineligible(c, "no", now);
  if (why) return why;
  if (c.ask.yes! < 0.15 || c.ask.yes! > 0.85) return `Yes asks ${c.ask.yes}, too near the edges`;
  if (!(Date.parse(c.expiry!) > now + 2 * 86_400_000)) return "it resolves within two days";
  return null;
}

/**
 * The first contract in the bank (soonest to resolve first, among those that suit) whose live read
 * suits too, trying at most MAX_TRIES. Throws with what was skipped and why.
 */
export async function pickLiveContract(
  bank: GeminiContract[],
  read: (eventTicker: string) => Promise<GeminiContract[]>,
  now = Date.now(),
): Promise<GeminiContract> {
  const candidates = bank.filter((c) => !suits(c, now)).sort((a, b) => Date.parse(a.expiry!) - Date.parse(b.expiry!));
  const skipped: string[] = [];
  for (const c of candidates.slice(0, MAX_TRIES)) {
    let live: GeminiContract | undefined;
    try {
      live = (await read(c.eventTicker)).find((x) => x.instrumentSymbol === c.instrumentSymbol);
    } catch (e) {
      skipped.push(`${c.instrumentSymbol}: live read failed (${e instanceof Error ? e.message.slice(0, 100) : e})`);
      continue;
    }
    const why = live ? suits(live, now) : "not in its event's live read";
    if (!why) return live!;
    skipped.push(`${c.instrumentSymbol}: ${why} (live)`);
  }
  const head = candidates.length
    ? `None of the ${Math.min(candidates.length, MAX_TRIES)} Gemini contract(s) tried reads live with a two-sided market on both sides`
    : "No eligible Gemini contract in the asset bank: run asset-bank --once --tiers=gemini";
  throw new Error(skipped.length ? `${head}:\n  ${skipped.join("\n  ")}` : head);
}
