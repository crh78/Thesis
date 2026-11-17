"use client";
// What the tabs show, like the iOS AppGate: the welcome screen when signed out, a short loader while
// Privy and the profile load, and the app once set up. Onboarding is drawn over every page by
// SessionScreens (so it also follows a sign-in from a take page).
import { useSession } from "@/lib/session";
import Welcome from "./Welcome";

export function Loader({ text }: { text?: string }) {
  return (
    <main className="page loader" aria-busy="true">
      <span className="brand">thesis</span>
      {text ? <p className="muted small">{text}</p> : null}
    </main>
  );
}

export default function AppGate({ children }: { children: React.ReactNode }) {
  const { phase, retry, logout } = useSession();
  switch (phase.kind) {
    case "ready":
      return <>{children}</>;
    case "signedOut":
      return <Welcome />;
    case "failed":
      return (
        <main className="page loader">
          <span className="brand">thesis</span>
          <p className="muted">Couldn&apos;t load your account. {phase.message}</p>
          <button className="obtn filled" onClick={retry}>Try again</button>
          <button className="obtn plain" onClick={() => logout()}>Log out</button>
        </main>
      );
    case "settingUp":
      return <Loader text="Setting up your account" />;
    default:
      return <Loader />;
  }
}
