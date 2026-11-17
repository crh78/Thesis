"use client";
// "Suggested for you": people to follow, as cards in a sideways row (the app's SuggestedFollowsRow).
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/session";
import Avatar from "./Avatar";

type Person = { id: string; handle: string | null; display_name: string | null; avatar_url: string | null; reason?: string | null };

export default function SuggestedFollows({ onChange }: { onChange?: () => void }) {
  const { social } = useSession();
  const [people, setPeople] = useState<Person[]>([]);
  const [followed, setFollowed] = useState<Set<string>>(new Set());

  useEffect(() => {
    social<{ people: Person[] }>("GET", "suggestions?limit=8").then((r) => setPeople(r.people)).catch(() => {});
  }, [social]);

  async function follow(id: string) {
    const on = !followed.has(id);
    setFollowed((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
    try {
      await social(on ? "PUT" : "DELETE", `follows/${id}`);
      onChange?.();
    } catch {
      setFollowed((s) => { const n = new Set(s); if (on) n.delete(id); else n.add(id); return n; });
    }
  }

  if (!people.length) return null;
  return (
    <section className="suggest">
      <div className="caps">Suggested for you</div>
      <div className="suggest-row">
        {people.map((p) => (
          <div key={p.id} className="suggest-card">
            <Link href={p.handle ? `/u/${p.handle}` : "#"}><Avatar person={p} size={52} /></Link>
            <b className="small">{p.display_name ?? p.handle}</b>
            <span className="muted" style={{ fontSize: 11 }}>{p.reason || `@${p.handle}`}</span>
            <button className={`pill small${followed.has(p.id) ? "" : " pill-on"}`} onClick={() => follow(p.id)}>{followed.has(p.id) ? "Following" : "Follow"}</button>
          </div>
        ))}
      </div>
    </section>
  );
}
