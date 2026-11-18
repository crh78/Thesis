// The fork API's saved state (.data/fork/api-state.json) and per-wallet serialization.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PublicKey } from "@solana/web3.js";
import type { State } from "./common.ts";

/** How long a save waits for more changes before writing the file, at most. */
export const SAVE_DEBOUNCE_MS = 3_000;

/** Every store with unsaved changes, written out when the process exits. */
const dirty = new Set<StateStore>();
let exitHook = false;

export class StateStore {
  readonly state: State;
  #path: string;
  #walletUpdates = new Map<string, Promise<unknown>>();
  #timer: NodeJS.Timeout | null = null;

  /**
   * The fork's state is in memory: after `fork:down` / `fork:up` every mirror is gone. The lookup
   * table address is new on each fresh fork, so it tells a stale state file apart.
   */
  constructor(path: string, lookupTable: PublicKey | null) {
    this.#path = path;
    const forkId = lookupTable?.toBase58() ?? "none";
    const saved: State | null = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    this.state = saved?.forkId === forkId ? saved : { forkId, takes: {}, cash: [] };
    if (!exitHook) {
      exitHook = true;
      process.on("exit", () => {
        for (const s of dirty) {
          // A throwaway state file whose folder is already gone (a test's): nothing to keep.
          if (!existsSync(dirname(s.#path))) continue;
          try {
            s.flush();
          } catch (e) {
            console.error(`saving ${s.#path} on exit failed: ${e instanceof Error ? e.message : e}`);
          }
        }
      });
    }
  }

  /**
   * Marks the state changed. The file is written at most every SAVE_DEBOUNCE_MS (a chart
   * snapshot, a trade and a deposit in the same few seconds are one write), and on `flush` or
   * exit. The whole state is one file, so writing it on every change blocked the event loop.
   */
  save() {
    dirty.add(this);
    this.#timer ??= setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS).unref();
  }

  /** Writes pending changes now, atomically (a temp file, then a rename), as compact JSON. */
  flush() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (!dirty.delete(this)) return;
    const next = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(next, JSON.stringify(this.state), { mode: 0o600 });
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
