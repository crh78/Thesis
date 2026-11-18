"use client";
// Fast trades (backs, fades and sales): the sheet builds before the tap, the tap only signs and
// sends, and "You're in" shows once the fork has accepted the transactions; confirmation finishes
// in the background and is watched here. A rare trade that doesn't confirm is rolled back on screen.
//
// Works against an older fork API too: one that ignores `prebuild` (no `expiresAt` on its builds)
// gets no more early builds after the first, since each would count against the money limit; one
// that ignores `until` answers /submit only once it's confirmed (no `status: "pending"`); one with
// no /builds/:id/refresh answers 404, and the sheet builds again.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { fork, ForkError, type Built, type Incomplete } from "./fork";

/** How a submitted trade ended (`GET /submissions/:buildId`). */
export type Submission = {
  status: "pending" | "landed" | "failed" | "incomplete";
  signatures: string[];
  error?: { code: string; message: string };
  incomplete?: Incomplete;
};
/** `unknown`: the watch gave up (the API never said, or doesn't know the build). */
export type Outcome = Submission["status"] | "unknown";

/** A trade sent with `until: "accepted"` and not yet confirmed: kept across reloads (sessionStorage). */
export type PendingTrade = { buildId: string; owner: string; takeId: string; kind: "back" | "fade" | "sell"; usd: number | null; position: string | null; at: number };

const PENDING_KEY = "thesis.pendingTrade";
export const pendingTrade = {
  get(owner: string): PendingTrade | null {
    try {
      const p = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as PendingTrade | null;
      // Older than any confirmation can take: forget it.
      if (!p || p.owner !== owner || Date.now() - p.at > WATCH_FOR_MS) return null;
      return p;
    } catch { return null; }
  },
  set(p: PendingTrade | null) {
    try {
      if (p) sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
      else sessionStorage.removeItem(PENDING_KEY);
    } catch { /* private mode */ }
  },
  clear(buildId: string) {
    try {
      const p = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as PendingTrade | null;
      if (p?.buildId === buildId) sessionStorage.removeItem(PENDING_KEY);
    } catch { /* private mode */ }
  },
};

/** How long a confirmation is watched before giving up. */
const WATCH_FOR_MS = 120_000;
/** The long poll's wait (the API allows up to 10 s). */
const POLL_WAIT_MS = 10_000;

// One watch per build, shared: the sheet, a check before the next build and a reload all wait on it.
const watches = new Map<string, Promise<Submission | null>>();

/**
 * Waits until a submitted build is no longer pending (long polls `GET /submissions/:id`). Null
 * when that can't be told: the API doesn't know the build (404), or it's been too long.
 */
export function watchSubmission(buildId: string): Promise<Submission | null> {
  let w = watches.get(buildId);
  if (!w) {
    w = (async () => {
      const start = Date.now();
      let misses = 0;
      while (Date.now() - start < WATCH_FOR_MS) {
        try {
          const s = await fork<Submission>("GET", `/submissions/${encodeURIComponent(buildId)}?wait=${POLL_WAIT_MS}`);
          if (s.status !== "pending") return s;
          misses = 0;
        } catch (e) {
          // It doesn't know this build (or has no such route): nothing more to learn here.
          if (e instanceof ForkError && (e.status === 404 || e.status === 410)) return null;
          // Offline, rate-limited or busy: wait a little longer each time, then ask again.
          misses++;
          await new Promise((r) => setTimeout(r, Math.min(8_000, 500 * 2 ** misses)));
        }
      }
      return null;
    })().finally(() => setTimeout(() => watches.delete(buildId), 30_000));
    watches.set(buildId, w);
  }
  return w;
}

/** Early builds: when to make them and how long they stay good. */
const EARLY = {
  /** Refresh a build with less than this left, while its sheet is visible. */
  refreshLeftMs: 15_000,
  /** A tap uses a build only with at least this left (signing and sending take well under it). */
  useLeftMs: 5_000,
  /** No touches on the sheet for this long: stop keeping builds fresh. */
  idleMs: 180_000,
  /** An older fork API's builds last 55 s from the start of the build; this leaves a margin. */
  legacyTtlMs: 45_000,
  /** After a refused early build (busy, rate-limited), wait this long before another. */
  backoffMs: 20_000,
};

/** Refusals that mean "this build can't be refreshed" (as do 404, 409 and 410): build again instead. */
const REBUILD = new Set(["quote_stale", "build_gone", "build_expired"]);

type Entry = { built: Built; receivedAt: number; expiresAt: number };
/** What a tap signs: `at` is when the build was there (performance.now(), before the tap when early). */
export type Taken = { built: Built; at: number; early: boolean; expiresAt: number };

/**
 * Builds a trade or sale before the tap, as the sheet is used: `want(key, delay)` when the sheet
 * opens or its amount changes (0 for a chip, 500 ms after typing), `take(key)` on the tap (a fresh
 * early build, the one still on its way, or a build made now). `make(key, prebuild)` asks the fork
 * API for the build behind a key; a build is signed once. `ready` false (the sheet closed, the
 * wallet not ready) stops it, and anything cached just expires. `beforeEarly` runs before each
 * early build (the check that the last trade has finished confirming); false skips that build.
 */
export function useEarlyBuild(opts: {
  ready: boolean;
  make: (key: string, prebuild: boolean) => Promise<Built>;
  beforeEarly?: () => Promise<boolean>;
  onEarlyBuilt?: (key: string, built: Built) => void;
}) {
  const live = useRef(opts);
  live.current = opts;
  const cache = useRef(new Map<string, Entry>());
  const flying = useRef(new Map<string, Promise<Entry | null>>());
  // null until the first build says: true when the fork API takes `prebuild` (its builds carry expiresAt).
  const supported = useRef<boolean | null>(null);
  const current = useRef<string | null>(null);
  // Bumped by reset(): an early build that comes back after it is dropped.
  const gen = useRef(0);
  const lastTouch = useRef(0);
  const backoffUntil = useRef(0);
  const debounce = useRef<number | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (debounce.current != null) window.clearTimeout(debounce.current);
    if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
    debounce.current = refreshTimer.current = null;
  }, []);

  const fresh = (e: Entry | null | undefined, leftMs: number): e is Entry => !!e && e.expiresAt - Date.now() > leftMs;
  const entryOf = (built: Built, startedAt: number): Entry => ({ built, receivedAt: Date.now(), expiresAt: built.expiresAt ?? startedAt + EARLY.legacyTtlMs });

  // Refreshes the current key's build 15 s before it runs out, while the page is visible and the
  // sheet was touched in the last 3 minutes. An older API's builds can't be refreshed.
  const schedule = useCallback(() => {
    if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
    const key = current.current;
    const entry = key ? cache.current.get(key) : null;
    if (!key || !entry || !supported.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      if (!live.current.ready || document.visibilityState !== "visible") return;
      if (Date.now() - lastTouch.current > EARLY.idleMs) return;
      if (current.current === key && cache.current.get(key) === entry) void early(key, entry);
    }, Math.max(0, entry.expiresAt - EARLY.refreshLeftMs - Date.now()));
    // `early` is declared below; it only runs later, from the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const early = useCallback(async (key: string, refreshOf?: Entry) => {
    const o = live.current;
    if (!o.ready || flying.current.has(key) || Date.now() < backoffUntil.current) return;
    // An older API counts every build against the wallet's money limit: only the first is early.
    if (supported.current === false) return;
    // Until the first answer says which API this is, one early build at a time.
    if (supported.current === null && flying.current.size) return;
    const g = gen.current;
    const startedAt = Date.now();
    const job = (async (): Promise<Entry | null> => {
      try {
        if (o.beforeEarly && !(await o.beforeEarly())) return null;
        let built: Built | null = null;
        if (refreshOf) {
          try {
            // Same shape as the build; keep what only the first answer carried (closesTake…).
            built = { ...refreshOf.built, ...(await fork<Built>("POST", `/builds/${encodeURIComponent(refreshOf.built.buildId)}/refresh`, {})) };
          } catch (e) {
            if (!(e instanceof ForkError) || !(REBUILD.has(e.code) || e.status === 404 || e.status === 409 || e.status === 410)) throw e;
          }
        }
        built ??= await o.make(key, true);
        supported.current = built.expiresAt != null;
        if (g !== gen.current) return null;
        const entry = entryOf(built, startedAt);
        cache.current.set(key, entry);
        live.current.onEarlyBuilt?.(key, built);
        return entry;
      } catch (e) {
        // Busy, rate-limited or unreachable: leave it for a while (the tap still builds now).
        // Anything else (no cash, the take closed) the tap's own build says.
        if (e instanceof ForkError && ["busy", "rate_limited", "fork_unreachable"].includes(e.code)) backoffUntil.current = Date.now() + EARLY.backoffMs;
        return null;
      } finally {
        flying.current.delete(key);
      }
    })();
    flying.current.set(key, job);
    const entry = await job;
    const now = current.current;
    if (entry && key === now) schedule();
    // The amount changed while the first build was out (and was skipped then): build it now.
    else if (now && now !== key && !flying.current.has(now) && !fresh(cache.current.get(now), EARLY.useLeftMs)) void early(now);
    // `early` calls itself; its identity never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule]);

  /** The sheet now shows `key` (null: nothing to build): build it after `delayMs`, unless a fresh one is there. */
  const want = useCallback((key: string | null, delayMs = 0) => {
    lastTouch.current = Date.now();
    current.current = key;
    if (debounce.current != null) window.clearTimeout(debounce.current);
    debounce.current = null;
    if (!key || fresh(cache.current.get(key), EARLY.refreshLeftMs)) return schedule();
    debounce.current = window.setTimeout(() => {
      debounce.current = null;
      const had = cache.current.get(key);
      void early(key, fresh(had, EARLY.useLeftMs) ? had : undefined);
    }, delayMs);
  }, [early, schedule]);

  /** Any touch on the sheet keeps its build fresh for another 3 minutes. */
  const touch = useCallback(() => {
    const idle = Date.now() - lastTouch.current > EARLY.idleMs;
    lastTouch.current = Date.now();
    if (idle && current.current) want(current.current);
  }, [want]);

  /** The build to sign on the tap: removed from the cache, since a build is signed once. */
  const take = useCallback(async (key: string): Promise<Taken> => {
    lastTouch.current = Date.now();
    if (debounce.current != null) window.clearTimeout(debounce.current);
    debounce.current = null;
    let entry: Entry | null | undefined = cache.current.get(key);
    // One on its way is usually sooner than a new one.
    if (!fresh(entry, EARLY.useLeftMs)) entry = await (flying.current.get(key) ?? null);
    cache.current.delete(key);
    if (fresh(entry, EARLY.useLeftMs)) {
      schedule();
      return { built: entry.built, at: performance.now() - (Date.now() - entry.receivedAt), early: true, expiresAt: entry.expiresAt };
    }
    const startedAt = Date.now();
    const built = await live.current.make(key, false);
    supported.current ??= built.expiresAt != null;
    return { built, at: performance.now(), early: false, expiresAt: entryOf(built, startedAt).expiresAt };
  }, [schedule]);

  /** Puts a taken build back, unsigned (a sale's "this closes your take" step signs it on the second tap). */
  const put = useCallback((key: string, t: Taken) => {
    cache.current.set(key, { built: t.built, receivedAt: Date.now() - (performance.now() - t.at), expiresAt: t.expiresAt });
    if (key === current.current) schedule();
  }, [schedule]);

  /** Forgets every build: after a trade is sent, builds made before it may not go through. */
  const reset = useCallback(() => {
    clearTimers();
    gen.current++;
    cache.current.clear();
    current.current = null;
  }, [clearTimers]);

  // The sheet closed or the wallet isn't ready: stop; what's cached just expires.
  useEffect(() => {
    if (!opts.ready) clearTimers();
  }, [opts.ready, clearTimers]);

  // Back on the page: build the current key again if it ran out while hidden.
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState === "visible" && live.current.ready && current.current && Date.now() - lastTouch.current <= EARLY.idleMs) want(current.current);
    };
    document.addEventListener("visibilitychange", onShow);
    return () => { document.removeEventListener("visibilitychange", onShow); clearTimers(); };
  }, [want, clearTimers]);

  return useMemo(() => ({ want, touch, take, put, reset }), [want, touch, take, put, reset]);
}

