"use client";
// "Post it" on a chat bot's draft (/d/<id>): sign in if needed (onboarding comes first), then the
// composer opens on the basket the bot built. Like TradeDock, a sign-in that leaves the page
// (Google) comes back to the same ask through sessionStorage.
import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { fromBotDraft } from "@/lib/compose";
import type { TakeDraft } from "@/lib/data";
import { useSession } from "@/lib/session";
import { useComposer } from "./Composer";
import SignIn from "./SignIn";

export default function DraftActions({ draft }: { draft: TakeDraft }) {
  const { ready, authenticated } = usePrivy();
  const { phase } = useSession();
  const composer = useComposer();
  const key = `thesis.draft.${draft.id}`;
  const [pending, setPending] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    try { if (sessionStorage.getItem(key)) setPending(true); } catch { /* private mode */ }
  }, [key]);

  useEffect(() => {
    if (!pending || phase.kind !== "ready") return;
    setPending(false);
    setSigningIn(false);
    try { sessionStorage.removeItem(key); } catch { /* private mode */ }
    composer.open(fromBotDraft(draft));
  }, [pending, phase.kind, composer, draft, key]);

  const post = () => {
    setPending(true);
    if (!authenticated) {
      try { sessionStorage.setItem(key, "1"); } catch { /* private mode */ }
      setSigningIn(true);
    }
  };

  return (
    <>
      <div className="dock">
        <div className="dock-inner">
          <button className="btn back" disabled={!ready} onClick={post}>Post it and buy in</button>
        </div>
      </div>
      {signingIn && !authenticated ? (
        <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && setSigningIn(false)}>
          <div className="sheet">
            <button className="x" aria-label="Close" onClick={() => setSigningIn(false)}>×</button>
            <h3>Sign in to post it</h3>
            <p className="muted small">One account for posting, trading and your scores. It&apos;s play money for now.</p>
            <div style={{ marginTop: 16 }}><SignIn /></div>
          </div>
        </div>
      ) : null}
    </>
  );
}
