"use client";
// When a page fails to render (Supabase or the fork API down, a missing setting): say so in the
// app's look, with a retry, instead of Next's bare error screen.
import Link from "next/link";
import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="page">
      <div className="top">
        <Link href="/" className="brand">thesis</Link>
      </div>
      <div className="empty">
        <h2>Something went wrong</h2>
        <p className="muted">Thesis couldn&apos;t load this page. Try again in a moment.</p>
        {error.digest ? <p className="caps">Ref {error.digest}</p> : null}
        <div className="actions">
          <button className="btn light" onClick={reset}>Try again</button>
          <Link href="/" className="btn ghost">Home</Link>
        </div>
      </div>
    </main>
  );
}
