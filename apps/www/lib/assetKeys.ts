"use client";
// Each pick's logo key (its ticker) by catalog id, for take logos in lists: every row asks with its
// own legs, the asks made in one render go out as one read (assetKeys), and the answers are kept
// for the rest of the visit.
import { useEffect, useState } from "react";
import { assetKeys } from "./data";

const known = new Map<string, string | null>();
const waiting = new Set<string>();
const listeners = new Set<() => void>();
let queued = false;

function request(ids: string[]) {
  for (const id of ids) if (id && !known.has(id)) waiting.add(id);
  if (queued || !waiting.size) return;
  queued = true;
  queueMicrotask(async () => {
    const batch = [...waiting];
    waiting.clear();
    queued = false;
    const found = await assetKeys(batch).catch(() => ({} as Record<string, string>));
    for (const id of batch) known.set(id, found[id] ?? null);
    listeners.forEach((l) => l());
  });
}

/** The tickers for these asset ids, as they arrive (missing ones until then, or if unknown). */
export function useAssetKeys(ids: (string | null | undefined)[]): Record<string, string> {
  const list = ids.filter((x): x is string => !!x);
  const key = list.join(",");
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    listeners.add(on);
    request(key ? key.split(",") : []);
    return () => { listeners.delete(on); };
  }, [key]);
  const out: Record<string, string> = {};
  for (const id of list) { const k = known.get(id); if (k) out[id] = k; }
  return out;
}
