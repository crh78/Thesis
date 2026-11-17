"use client";
// The signed-in person, like the iOS app's SessionStore: Privy login → the `session` edge function
// (find-or-create the Thesis profile) → which screen to show. Phases follow the app exactly:
// sign-in, then onboarding (profile → photo → location → follows), then the app.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { setForkAuth } from "./fork";
import { disablePush } from "./push";

export type Snapshot = {
  profile: { id: string; handle: string | null; display_name: string | null; avatar_url: string | null; bio?: string | null };
  account: { country: string | null; us_state: string | null; onboarded_at: string | null };
  needs_onboarding: boolean;
};

export type Step = "profile" | "photo" | "location" | "follows";
export type Phase =
  | { kind: "launching" }
  | { kind: "signedOut" }
  | { kind: "settingUp" }
  | { kind: "onboarding"; step: Step }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

/** What the sign-in accounts already know, to prefill onboarding (X first, then Google). */
export type Hints = { name: string; handle: string; photo: string | null; hasX: boolean; xHandle: string | null };

type Ctx = {
  phase: Phase;
  snapshot: Snapshot | null;
  hints: Hints;
  userId: string | null;
  token: () => Promise<string>;
  /** Saves onboarding fields. `hold` keeps the current screen (call `apply` once the rest is saved). */
  update: (body: Record<string, unknown>, opts?: { hold?: boolean }) => Promise<Snapshot>;
  apply: (s: Snapshot) => Snapshot;
  uploadPhoto: (image: Blob) => Promise<Snapshot>;
  social: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  /** The `assets` function (search, asset pages), which needs the Privy token. */
  assets: <T>(path: string) => Promise<T>;
  /** The `source` function's X-copy routes (GET x, PUT / DELETE x/<handle>). */
  source: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  finishOnboarding: () => void;
  retry: () => void;
  logout: () => Promise<void>;
};

const SessionContext = createContext<Ctx | null>(null);

export function useSession(): Ctx {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}

/** Friendly text for the session function's error codes. */
const ERRORS: Record<string, string> = {
  handle_taken: "That handle is taken.",
  invalid_handle: "Handles are 3–20 letters, numbers or underscores.",
  invalid_display_name: "Add your name.",
  invalid_country: "Pick your country.",
  invalid_us_state: "Pick your state.",
  us_state_requires_us: "Pick your state.",
  image_too_large: "That photo is over 3 MB. Try a smaller one.",
  x_account_not_found: "No recent posts from that account. Check the handle.",
  copy_limit: "You can copy up to 10 accounts. Stop copying one to add another.",
  unsupported_image_type: "Use a JPEG or PNG photo.",
  already_posting: "You're already posting this take. Wait for it to go live, or discard it from Me.",
  invalid_leg_name: "One of your picks has a name too long to post. Remove it or swap it for another and try again.",
};

/** A basket the social function refused (a pick's kind, weight or note): never the raw code. */
const BASKET_ERROR = "Couldn't post this basket. Change a pick and try again.";

/** The `assets` function answers in snake_case (`kind_label`, `price_usd`, `change_24h_pct`); the
 *  app reads camelCase (`kindLabel`, `priceUsd`, `change24hPct`). Converted here, once, for every read. */
export function camelKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()), camelKeys(x)]));
}

async function readError(r: Response): Promise<Error> {
  const json = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
  const code = json.error ?? json.message ?? `error_${r.status}`;
  if (ERRORS[code]) return new Error(ERRORS[code]);
  if (/^(invalid_leg|weights_must)/.test(code)) return new Error(BASKET_ERROR);
  // Other codes read as words ("not found"), never with underscores.
  return new Error(/^[a-z0-9_]+$/.test(code) ? code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) + "." : "Something went wrong. Try again.");
}

function stepFor(s: Snapshot): Step | null {
  if (!s.needs_onboarding) return null;
  if (!s.profile.handle) return "profile";
  if (!s.profile.avatar_url) return "photo";
  return "location";
}

/** X's picture URLs end in `_normal` (48px); `_400x400` is the full-size one. */
const bigXPhoto = (url: string | null | undefined) => (url ? url.replace(/_normal(\.\w+)$/, "_400x400$1") : null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, user, getAccessToken, logout: privyLogout } = usePrivy();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "launching" });
  const [attempt, setAttempt] = useState(0);
  const loadedFor = useRef<string | null>(null);

  // Money calls to the fork API carry this person's Privy token (the fork API's abuse guard).
  useEffect(() => {
    setForkAuth(authenticated ? () => getAccessToken() : null);
    return () => setForkAuth(null);
  }, [authenticated, getAccessToken]);

  const token = useCallback(async () => {
    const t = await getAccessToken();
    if (!t) throw new Error("Signed out. Sign in again.");
    return t;
  }, [getAccessToken]);

  const apply = useCallback((s: Snapshot) => {
    setSnapshot(s);
    const step = stepFor(s);
    // Location finishes onboarding on the server; the follow step still comes before the app.
    setPhase((p) => {
      if (step) return { kind: "onboarding", step };
      if (p.kind === "onboarding" && p.step !== "follows") return { kind: "onboarding", step: "follows" };
      if (p.kind === "onboarding" && p.step === "follows") return p;
      return { kind: "ready" };
    });
    return s;
  }, []);

  // Signed in: make sure there's a Thesis profile, then pick the screen.
  useEffect(() => {
    if (!ready) return;
    if (!authenticated || !user) {
      loadedFor.current = null;
      setSnapshot(null);
      setPhase({ kind: "signedOut" });
      return;
    }
    const key = `${user.id}:${attempt}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    setPhase({ kind: "settingUp" });
    (async () => {
      try {
        const r = await fetch("/api/session", { headers: { "privy-token": await token() }, cache: "no-store" });
        if (!r.ok) throw await readError(r);
        apply((await r.json()) as Snapshot);
      } catch (e) {
        setPhase({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, [ready, authenticated, user, attempt, token, apply]);

  const update = useCallback(async (body: Record<string, unknown>, opts?: { hold?: boolean }) => {
    const r = await fetch("/api/session", {
      method: "PATCH",
      headers: { "privy-token": await token(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await readError(r);
    const s = (await r.json()) as Snapshot;
    return opts?.hold ? s : apply(s);
  }, [token, apply]);

  const uploadPhoto = useCallback(async (image: Blob) => {
    const r = await fetch("/api/session", {
      method: "POST",
      headers: { "privy-token": await token(), "content-type": image.type },
      body: image,
    });
    if (!r.ok) throw await readError(r);
    return apply((await r.json()) as Snapshot);
  }, [token, apply]);

  const social = useCallback(async <T,>(method: string, path: string, body?: unknown) => {
    const r = await fetch(`/api/social/${path}`, {
      method,
      headers: { "privy-token": await token(), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!r.ok) throw await readError(r);
    return (await r.json()) as T;
  }, [token]);

  const assets = useCallback(async <T,>(path: string) => {
    const r = await fetch(`/api/assets/${path}`, { headers: { "privy-token": await token() }, cache: "no-store" });
    if (!r.ok) throw await readError(r);
    return camelKeys(await r.json()) as T;
  }, [token]);

  const source = useCallback(async <T,>(method: string, path: string, body?: unknown) => {
    const r = await fetch(`/api/source/${path}`, {
      method,
      headers: { "privy-token": await token(), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!r.ok) throw await readError(r);
    return (await r.json()) as T;
  }, [token]);

  const hints = useMemo<Hints>(() => {
    const x = user?.twitter;
    const g = user?.google;
    const emailName = user?.email?.address?.split("@")[0] ?? "";
    const handle = (x?.username ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
    return {
      name: x?.name || g?.name || "",
      handle: handle || emailName.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20),
      photo: bigXPhoto(x?.profilePictureUrl),
      hasX: !!x,
      xHandle: x?.username ?? null,
    };
  }, [user]);

  const value = useMemo<Ctx>(() => ({
    phase,
    snapshot,
    hints,
    userId: user?.id ?? null,
    token,
    update,
    apply,
    uploadPhoto,
    social,
    assets,
    source,
    finishOnboarding: () => setPhase((p) => (p.kind === "onboarding" && p.step === "follows" ? { kind: "ready" } : p)),
    retry: () => setAttempt((a) => a + 1),
    logout: async () => {
      // This browser stops getting your pushes before the session ends (the token is still good now).
      await disablePush(token).catch(() => {});
      await privyLogout();
      setSnapshot(null);
      setPhase({ kind: "signedOut" });
    },
  }), [phase, snapshot, hints, user?.id, token, update, apply, uploadPhoto, social, assets, source, privyLogout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
