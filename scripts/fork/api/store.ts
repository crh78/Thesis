// The fork API's saved state (.data/fork/api-state.json) and per-wallet serialization.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { PublicKey } from "@solana/web3.js";
import type { State } from "./common.ts";

export class StateStore {
  readonly state: State;
  #path: string;
  #walletUpdates = new Map<string, Promise<unknown>>();

  /**
   * The fork's state is in memory: after `fork:down` / `fork:up` every mirror is gone. The lookup
   * table address is new on each fresh fork, so it tells a stale state file apart.
   */
  constructor(path: string, lookupTable: PublicKey | null) {
    this.#path = path;
    const forkId = lookupTable?.toBase58() ?? "none";
    const saved: State | null = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    this.state = saved?.forkId === forkId ? saved : { forkId, takes: {}, cash: [] };
  }

  /** Writes the state atomically (a temp file, then a rename). */
  save() {
    const next = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(next, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(next, this.#path);
  }

  /**
   * Runs `update` after every earlier update for the same wallet has finished, so cash changes,
   * trades and chart snapshots of one wallet never interleave.
   */
  withWallet<T>(addr: string, update: () => Promise<T>): Promise<T> {
    const previous = this.#walletUpdates.get(addr);
    const next = Promise.resolve(previous).catch(() => {}).then(update).finally(() => {
      if (this.#walletUpdates.get(addr) === next) this.#walletUpdates.delete(addr);
    });
    this.#walletUpdates.set(addr, next);
    return next;
  }
}
