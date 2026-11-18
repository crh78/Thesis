// Small files next to the asset bank's file, for the other processes on the same machine (the
// VM's `/opt/thesis/.data/`):
//
//   asset-bank.prices.json  The bank's token prices (Jupiter Price v3, refreshed about every 90 s)
//                           and pooled liquidity, rewritten on every flush. The fork API's live
//                           display values read it before asking Jupiter themselves: the main bank
//                           file is ~25 MB, too big to re-read that often.
//   trade-builds.busy       Touched by the fork API while user trade builds run or wait. The poller's
//                           probes pause while it's fresh, so the one Jupiter key (shared by every
//                           process) goes to trades first.
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BankState } from "./state.ts";

export type BankPrices = {
  at: string;
  /** By mint: USD per UI token, when Jupiter priced it, and Jupiter's pooled liquidity (hourly). */
  tokens: Record<string, { usd: number; at: string; pooledUsd: number | null }>;
};

export const pricesFileFor = (bankFile: string): string => `${bankFile.replace(/\.json$/, "")}.prices.json`;
export const buildsBusyFileFor = (bankFile: string): string => join(dirname(bankFile), "trade-builds.busy");

/** The priced tokens of a bank state. */
export function bankPrices(state: BankState, now = new Date()): BankPrices {
  const tokens: BankPrices["tokens"] = {};
  for (const [mint, t] of Object.entries(state.tokens)) {
    if (t.price && t.price.usd > 0) tokens[mint] = { usd: t.price.usd, at: t.price.at, pooledUsd: t.jupiterPooledUsd ?? null };
  }
  return { at: now.toISOString(), tokens };
}

/** Writes the prices file atomically (tmp + rename), as the bank file is written. */
export function writeBankPrices(state: BankState, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(bankPrices(state)));
  renameSync(tmp, path);
}

/** The prices file, or null when it's missing or unreadable. */
export async function readBankPrices(path: string): Promise<BankPrices | null> {
  try {
    const p = JSON.parse(await readFile(path, "utf8")) as BankPrices;
    return p && typeof p.tokens === "object" ? p : null;
  } catch {
    return null;
  }
}

/** How long one touch of the busy file pauses the probes. The fork API touches it again while builds last. */
export const BUILDS_BUSY_HOLD_MS = 15_000;

/** Marks trade builds as running or waiting (the fork API's build gate calls this; cheap: one utimes). */
export async function markBuildsBusy(path: string, now = new Date()): Promise<void> {
  try {
    await utimes(path, now, now);
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
    await utimes(path, now, now);
  }
}

/** True while the busy file was touched within `holdMs`. A missing file: not busy. */
export function buildsBusy(path: string, nowMs = Date.now(), holdMs = BUILDS_BUSY_HOLD_MS): boolean {
  try {
    const age = nowMs - statSync(path).mtimeMs;
    return age >= -holdMs && age <= holdMs;
  } catch {
    return false;
  }
}
