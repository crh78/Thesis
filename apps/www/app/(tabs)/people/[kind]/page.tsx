"use client";
// Your followers and who you follow, like the iOS ConnectionsView: unfollow from Following, and
// remove someone from your followers (they aren't told and can follow again).
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Avatar from "@/components/Avatar";
import { money, type Person } from "@/lib/data";
import { useSession } from "@/lib/session";
import TopBar from "@/components/TopBar";

type Row = Person & { follows_you?: boolean };

export default function PeoplePage() {
  const { kind } = useParams<{ kind: string }>();
  const tab = kind === "following" ? "following" : "followers";
  const { snapshot, social } = useSession();
  const me = snapshot?.profile;
  const [people, setPeople] = useState<Row[] | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!me?.id) return;
    setPeople(null);
    social<{ people: Row[] }>("GET", `${tab}/${me.id}`).then((r) => setPeople(r.people)).catch((e) => { setPeople([]); setError(e instanceof Error ? e.message : String(e)); });
  }, [me?.id, tab, social]);
  useEffect(load, [load]);

  async function act(p: Row) {
    setError(null);
    try {
      await social("DELETE", tab === "following" ? `follows/${p.id}` : `followers/${p.id}`);
      setGone((s) => new Set(s).add(p.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirm(null);
    }
  }

  const list = (people ?? []).filter((p) => !gone.has(p.id));
  return (
    <main className="page">
      <TopBar />
      <h1 className="title">{me?.display_name ?? "You"}</h1>
      <div className="segmented" style={{ gridTemplateColumns: "1fr 1fr" }} role="tablist">
        <Link href="/people/following" replace role="tab" aria-selected={tab === "following"} className={`seg-link${tab === "following" ? " on" : ""}`}>Following</Link>
        <Link href="/people/followers" replace role="tab" aria-selected={tab === "followers"} className={`seg-link${tab === "followers" ? " on" : ""}`}>Followers</Link>
      </div>
      {error ? <p className="err">{error}</p> : null}
      {people == null ? <p className="muted search-empty">Loading…</p> : null}
      {people != null && list.length === 0 ? <p className="muted search-empty">{tab === "following" ? "You don't follow anyone yet." : "No followers yet."}</p> : null}
      {list.map((p) => (
        <div key={p.id} className="prow">
          <Link href={p.handle ? `/u/${p.handle}` : "#"}><Avatar person={p} size={44} /></Link>
          <Link href={p.handle ? `/u/${p.handle}` : "#"} className="prow-main">
            <b>{p.display_name ?? p.handle}</b>
            <span className="muted small">
              @{p.handle}{p.follows_you && tab === "following" ? " · Follows you" : ""} · {money(p.made ?? 0, true)} made · {p.takes ?? 0} {(p.takes ?? 0) === 1 ? "take" : "takes"}
            </span>
          </Link>
          <button className="pill small" onClick={() => (tab === "following" ? act(p) : setConfirm(p))}>{tab === "following" ? "Following" : "Remove"}</button>
        </div>
      ))}
      {confirm ? (
        <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && setConfirm(null)}>
          <div className="sheet" role="alertdialog" aria-label="Remove follower">
            <h3>Remove @{confirm.handle}?</h3>
            <p className="muted">They won&apos;t be told, and they can follow you again.</p>
            <button className="obtn filled down-fill" onClick={() => act(confirm)}>Remove</button>
            <button className="obtn plain" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
