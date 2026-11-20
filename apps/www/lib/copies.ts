"use client";
// Copy trading's client side: who you copy and their auto-copy settings (the agent function's
// /agent/copies routes, through /api/agent). Used by the Copy trading tab and profiles' Copy button.
import { useCallback, useEffect, useState } from "react";
import { useSession } from "./session";

export type XCopy = { handle: string; username?: string; name?: string | null; avatar_url?: string | null; auto: boolean; usd: number; daily: number };
export type TraderCopy = { trader_id: string; handle?: string | null; display_name?: string | null; avatar_url?: string | null; auto: boolean; usd: number; daily: number };
export type CopyJob = { id: string; kind: "x_call" | "take"; handle: string | null; trader_id: string | null; usd: number; status: string; reason: string | null; take_id: string | null; claim: string | null; at: string };
export type Copies = { linked: boolean; x: XCopy[]; traders: TraderCopy[]; jobs: CopyJob[] };
export type CopySettings = { auto?: boolean; usd?: number; daily?: number };

const ERRORS: Record<string, string> = {
  invalid_usd: "Pick an amount within your limits.",
  not_copying: "You don't copy that account any more.",
  no_such_trader: "That person isn't on Thesis any more.",
  cant_copy_self: "You can't copy yourself.",
};

export function useCopies() {
  const { token, phase } = useSession();
  const [copies, setCopies] = useState<Copies | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = phase.kind === "ready";

  const call = useCallback(async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`/api/agent/${path}`, {
      method,
      headers: { "privy-token": await token(), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(ERRORS[(j as { error?: string }).error ?? ""] ?? "Something went wrong. Try again.");
    return j as Copies;
  }, [token]);

  const reload = useCallback(() => {
    if (!ready) return;
    call("GET", "copies").then(setCopies, (e) => setError(e.message));
  }, [ready, call]);
  useEffect(reload, [reload]);

  const save = useCallback(async (method: "PUT" | "DELETE", path: string, body?: CopySettings) => {
    setError(null);
    try {
      setCopies(await call(method, path, body));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [call]);

  return {
    copies, error, reload,
    setX: (handle: string, s: CopySettings) => save("PUT", `copies/x/${handle}`, s),
    removeX: (handle: string) => save("DELETE", `copies/x/${handle}`),
    setTrader: (id: string, s: CopySettings) => save("PUT", `copies/trader/${id}`, s),
    removeTrader: (id: string) => save("DELETE", `copies/trader/${id}`),
  };
}
