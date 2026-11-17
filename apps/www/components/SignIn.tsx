"use client";
// The ways to sign in, as on the iOS welcome screen: X first (so a reply to @thesis on X maps to the
// same account), then Google, then email with a one-time code. All Privy, headless (no Privy modal).
import { useState } from "react";
import { useLoginWithEmail, useLoginWithOAuth } from "@privy-io/react-auth";
import { X_LOGIN } from "@/lib/flags";

function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/not allowed|not enabled|disabled/i.test(m)) return "That sign-in isn't switched on yet. Try another way.";
  if (/invalid.*code|incorrect/i.test(m)) return "That code didn't work. Check it and try again.";
  if (/cancel|closed/i.test(m)) return "";
  return "Couldn't sign in. Try again.";
}

const XLogo = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="currentColor">
    <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78L17.75 3Zm-1.08 16.17h1.7L7.42 4.74H5.6l11.07 14.43Z" />
  </svg>
);
const GoogleLogo = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
    <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.08 3.57-5.15 3.57-8.81Z" />
    <path fill="#34A853" d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.87-3A7.17 7.17 0 0 1 12 19.25a7.2 7.2 0 0 1-6.76-4.97h-4v3.09A12 12 0 0 0 12 24Z" />
    <path fill="#FBBC05" d="M5.24 14.28a7.2 7.2 0 0 1 0-4.56V6.63h-4a12 12 0 0 0 0 10.74l4-3.09Z" />
    <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.6 4.58 1.8l3.43-3.43A12 12 0 0 0 1.24 6.63l4 3.09A7.2 7.2 0 0 1 12 4.75Z" />
  </svg>
);
const MailIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
    <rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" />
  </svg>
);

export default function SignIn() {
  const [busy, setBusy] = useState<"twitter" | "google" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState(false);
  const { initOAuth } = useLoginWithOAuth();

  async function oauth(provider: "twitter" | "google") {
    setError(null);
    setBusy(provider);
    try {
      // Redirects to X or Google and back here; Privy finishes the login on return.
      await initOAuth({ provider });
    } catch (e) {
      setError(friendly(e) || null);
      setBusy(null);
    }
  }

  if (email) return <EmailSignIn onBack={() => setEmail(false)} />;

  return (
    <div className="signin">
      {error ? <div className="err">{error}</div> : null}
      {X_LOGIN ? (
        <button className="obtn filled" disabled={!!busy} onClick={() => oauth("twitter")}>
          <XLogo /> {busy === "twitter" ? "Opening X…" : "Continue with X"}
        </button>
      ) : null}
      <button className={`obtn${X_LOGIN ? "" : " filled"}`} disabled={!!busy} onClick={() => oauth("google")}>
        <GoogleLogo /> {busy === "google" ? "Opening Google…" : "Continue with Google"}
      </button>
      <button className="obtn" disabled={!!busy} onClick={() => setEmail(true)}>
        <MailIcon /> Continue with email
      </button>
    </div>
  );
}

function EmailSignIn({ onBack }: { onBack: () => void }) {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kept here rather than read from Privy's state, which drops back to "error" on a wrong code.
  const [sent, setSent] = useState(false);
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim());

  async function run(work: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(friendly(e) || null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="signin"
      onSubmit={(e) => {
        e.preventDefault();
        if (!sent) run(async () => { await sendCode({ email: address.trim() }); setSent(true); });
        else run(() => loginWithCode({ code: code.trim() }));
      }}
    >
      {!sent ? (
        <>
          <label className="caps" htmlFor="email">Email</label>
          <input id="email" className="field" type="email" inputMode="email" autoComplete="email" autoFocus placeholder="you@example.com" value={address} onChange={(e) => setAddress(e.target.value)} />
        </>
      ) : (
        <>
          <p className="muted small" style={{ margin: "0 0 4px" }}>We sent a code to {address.trim()}.</p>
          <label className="caps" htmlFor="code">Code</label>
          <input id="code" className="field mono" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
        </>
      )}
      {error ? <div className="err">{error}</div> : null}
      <button className="obtn filled" type="submit" disabled={busy || (!sent ? !valid : code.length < 6)}>
        {busy ? "One moment…" : sent ? "Sign in" : "Send code"}
      </button>
      <button className="obtn plain" type="button" disabled={busy} onClick={onBack}>Other ways to sign in</button>
    </form>
  );
}
