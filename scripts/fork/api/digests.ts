// The daily "how your positions are doing" notification for each wallet with priced positions.
import type { DigestMark } from "./common.ts";
import type { StateStore } from "./store.ts";

type PricedPosition = { claim: string; valueUsd: number | null; costUsd: number | null };

/**
 * The digest text for a wallet's priced positions: the change since the last digest (or since
 * getting in, the first time), the total value, and the best position by P&L.
 */
export function digestFor(priced: PricedPosition[], last: DigestMark | null, wallet: string) {
  const value = priced.reduce((s, p) => s + (p.valueUsd ?? 0), 0);
  const cost = priced.reduce((s, p) => s + (p.costUsd ?? 0), 0);
  const from = last ? last.valueUsd : cost;
  const pct = (value / from - 1) * 100;
  const best = priced
    .map((p) => ({ claim: p.claim, pct: ((p.valueUsd ?? 0) / (p.costUsd || 1) - 1) * 100 }))
    .sort((a, b) => b.pct - a.pct)[0];
  const n = priced.length;
  const signed = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1) + "%";
  return {
    wallet,
    title: "Your positions are " + (pct >= 0 ? "up " : "down ") + Math.abs(pct).toFixed(1) + "% " + (last ? "today" : "since you got in"),
    body: n + " open position" + (n === 1 ? "" : "s") + " worth $" + value.toFixed(2) + " · best: " + best.claim + " " + signed(best.pct),
    data: { value_usd: Number(value.toFixed(2)), cost_usd: Number(cost.toFixed(2)), change_pct: Number(pct.toFixed(2)), positions: n },
  };
}

/**
 * One digest per wallet in `owners` with priced open positions. `markSent` records each wallet's
 * value for the next day's change, once the digests have gone out. `day` is YYYY-MM-DD.
 */
export async function dailyDigests(
  day: string,
  owners: Iterable<string>,
  portfolio: (wallet: string) => Promise<{ positions: PricedPosition[] }>,
  store: StateStore,
) {
  const marks = (store.state.digests ??= {});
  const nextMarks: typeof marks = {};
  const digests: ReturnType<typeof digestFor>[] = [];
  for (const wallet of owners) {
    if (marks[wallet]?.day === day) continue;
    const { positions } = await portfolio(wallet);
    const priced = positions.filter((p) => p.valueUsd != null && p.costUsd);
    if (!priced.length) continue;
    digests.push(digestFor(priced, marks[wallet] ?? null, wallet));
    nextMarks[wallet] = { day, valueUsd: priced.reduce((s, p) => s + p.valueUsd!, 0) };
  }
  return {
    digests,
    markSent: () => {
      for (const [wallet, mark] of Object.entries(nextMarks)) {
        if (!marks[wallet] || marks[wallet].day < mark.day) marks[wallet] = mark;
      }
      store.save();
    },
  };
}
