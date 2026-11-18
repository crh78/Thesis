"use client";
// "Post it" on a chat bot's draft (/d/<id>): sign in if needed (onboarding comes first), then the
// composer opens on the basket the bot built. Like TradeDock, a sign-in that leaves the page
// (Google) comes back to the same ask through sessionStorage. An X draft (`for_x`) is for the X
// account that asked: anyone else signed in sees who it's for instead (the server refuses them too).
import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { fromBotDraft } from "@/lib/compose";
import type { TakeDraft } from "@/lib/data";
import { useSession } from "@/lib/session";
import { useComposer } from "./Composer";
import SignIn from "./SignIn";

export default function DraftActions({ draft }: { draft: TakeDraft }) {
  const { ready, authenticated, user } = usePrivy();
  const { phase } = useSession();
  const composer = useComposer();
  const key = `thesis.draft.${draft.id}`;
  const [pending, setPending] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  // Only the X account it was made for may post an X draft (X usernames ignore case).
  const forX = draft.for_x?.toLowerCase() || null;
  const notYours = authenticated && !!forX && user?.twitter?.username?.toLowerCase() !== forX;

  useEffect(() => {
    try { if (sessionStorage.getItem(key)) setPending(true); } catch { /* private mode */ }
  }, [key]);

  useEffect(() => {
    if (!pending || phase.kind !== "ready") return;
    setPending(false);
    setSigningIn(false);
    try { sessionStorage.removeItem(key); } catch { /* private mode */ }
    // Signed in with another account: the dock says who it's for, and nothing opens.
    if (!notYours) composer.open(fromBotDraft(draft));
  }, [pending, phase.kind, composer, draft, key, notYours]);

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
          {notYours ? (
            <button className="btn back" disabled>This take was made for @{forX}</button>
          ) : (
            <button className="btn back" disabled={!ready} onClick={post}>Post it and buy in</button>
          )}
        </div>
      </div>
      {signingIn && !authenticated ? (
        <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && setSigningIn(false)}>
          <div className="sheet">
            <button className="x" aria-label="Close" onClick={() => setSigningIn(false)}>×</button>
            <h3>Sign in to post it</h3>
            <p className="muted small">
              {forX ? `Made for @${forX}: sign in with that X account to post it.` : "One account for posting, trading and your scores. It's play money for now."}
            </p>
            <div style={{ marginTop: 16 }}><SignIn /></div>
          </div>
        </div>
      ) : null}
    </>
  );
}
