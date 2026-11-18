// A page that doesn't exist: a take, profile or draft link that's wrong or gone, or a typo.
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found · Thesis", robots: { index: false } };

export default function NotFound() {
  return (
    <main className="page">
      <div className="top">
        <Link href="/" className="brand">thesis</Link>
      </div>
      <div className="empty">
        <h2>Nothing here</h2>
        <p className="muted">This link is wrong, or what it pointed to is gone.</p>
        <div className="actions">
          <Link href="/" className="btn light">Go to Thesis</Link>
        </div>
      </div>
    </main>
  );
}
