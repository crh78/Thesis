"use client";
// Screens that follow the signed-in person on every page: onboarding until it's done, then (once) the
// prompt to link X for people who signed in another way, then the add-to-home-screen and
// notification prompts (one at a time).
import { useEffect, useState } from "react";
import { useLinkAccount } from "@privy-io/react-auth";
import { X_LOGIN } from "@/lib/flags";
import { REAUTH_EVENT } from "@/lib/fork";
import { useSession } from "@/lib/session";
import AppPrompts from "./AppPrompts";
import Onboarding from "./Onboarding";

export default function SessionScreens() {
  const { phase } = useSession();
  const reauth = <Reauth />;
  // The install and notification prompts wait until the connect-X prompt is answered (or not needed).
  const [xOpen, setXOpen] = useState<boolean | null>(null);
  if (phase.kind === "onboarding") {
    return (
      <div className="overlay">
        <Onboarding step={phase.step} />
      </div>
    );
  }
  if (phase.kind === "ready") {
    return (
      <>
        {reauth}
        <LinkXPrompt onOpenChange={setXOpen} />
        <AppPrompts ready={xOpen === false} />
      </>
    );
  }
  return null;
}

const dismissedKey = (userId: string) => `thesis.linkx.dismissed.${userId}`;

/** Once after sign-in, for accounts with no X: replies to @thesis on X trade from the X-linked account. */
function LinkXPrompt({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { hints, userId } = useSession();
  // null until decided, so the prompts after it don't start alongside it.
  const [open, setOpen] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { linkTwitter } = useLinkAccount({
    onSuccess: () => setOpen(false),
    onError: (e) => setError(e === "exited_link_flow" ? null : "Couldn't connect X. Try again."),
  });

  useEffect(() => {
    // Off until X login is switched on (lib/flags.ts).
    if (!X_LOGIN || !userId || hints.hasX) return setOpen(false);
    try {
      setOpen(localStorage.getItem(dismissedKey(userId)) !== "1");
    } catch {
      setOpen(true);
    }
  }, [userId, hints.hasX]);

  const showing = open === true && !!userId;
  useEffect(() => { if (open !== null) onOpenChange(showing); }, [open, showing, onOpenChange]);

  if (!showing || !userId) return null;
  const dismiss = () => {
    try { localStorage.setItem(dismissedKey(userId), "1"); } catch { /* private mode: ask again next time */ }
    setOpen(false);
  };

  return (
    <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && dismiss()}>
      <div className="sheet" role="dialog" aria-labelledby="linkx-title">
        <button className="x" aria-label="Close" onClick={dismiss}>×</button>
        <h3 id="linkx-title">Connect your X</h3>
        <p className="muted">Reply to any post on X with <b className="mono">@thesis back $20</b> and it trades from this account. Connect X so we know it&apos;s you.</p>
        {error ? <div className="err">{error}</div> : null}
        <button className="obtn filled" style={{ marginTop: 16 }} onClick={() => { setError(null); linkTwitter(); }}>Connect X</button>
        <button className="obtn plain" onClick={dismiss}>Not now</button>
      </div>
    </div>
  );
}

/** The fork API refused this session for the wallet (an expired token, or another account's wallet). */
function Reauth() {
  const { logout } = useSession();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(REAUTH_EVENT, on);
    return () => window.removeEventListener(REAUTH_EVENT, on);
  }, []);
  if (!open) return null;
  return (
    <div className="sheet-wrap reauth">
      <div className="sheet" role="alertdialog" aria-labelledby="reauth-title">
        <h3 id="reauth-title">Sign in again</h3>
        <p className="muted">Your session ended, so that didn&apos;t go through. Sign in again and try once more.</p>
        <button className="obtn filled" style={{ marginTop: 14 }} onClick={() => { setOpen(false); logout(); }}>Sign in again</button>
        <button className="obtn plain" onClick={() => setOpen(false)}>Not now</button>
      </div>
    </div>
  );
}

