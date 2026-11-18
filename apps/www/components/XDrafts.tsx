"use client";
// "Your takes from X": what @yourthesisxyz built for you. The bot replies on X with no link (a
// reply with a URL costs $0.20), saying "sign in with X at the link in our bio"; the draft waits
// here for whoever signs in with that X account (source GET drafts/mine checks it with Privy).
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/session";

type Draft = { id: string; claim: string; legs: { name: string; weight: number }[]; created_at: string };

export default function XDrafts() {
  const { source, hints } = useSession();
  const [drafts, setDrafts] = useState<Draft[]>([]);

  useEffect(() => {
    if (!hints.hasX) return setDrafts([]);
    source<{ drafts: Draft[] }>("GET", "drafts/mine").then((r) => setDrafts(r.drafts)).catch(() => {});
  }, [source, hints.hasX]);

  if (!drafts.length) return null;
  return (
    <section className="suggest">
      <div className="caps">Your takes from X</div>
      <div className="xdrafts">
        {drafts.map((d) => (
          <Link key={d.id} href={`/d/${d.id}`} className="xdraft">
            <b>{d.claim}</b>
            <span className="muted small">{d.legs.slice(0, 3).map((l) => l.name).join(", ")}{d.legs.length > 3 ? `, +${d.legs.length - 3} more` : ""}</span>
            <span className="pill small pill-on">Post it</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
