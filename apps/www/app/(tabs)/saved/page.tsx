"use client";
// Saved takes, like the iOS SavedView (the bookmark on a feed row).
import { useEffect, useState } from "react";
import { TakeListRow } from "@/components/AssetBits";
import type { FeedTake } from "@/components/TakeRow";
import { useSession } from "@/lib/session";
import TopBar from "@/components/TopBar";

export default function SavedPage() {
  const { social } = useSession();
  const [takes, setTakes] = useState<FeedTake[] | null>(null);
  useEffect(() => {
    social<{ takes: FeedTake[] }>("GET", "saves").then((r) => setTakes(r.takes)).catch(() => setTakes([]));
  }, [social]);
  return (
    <main className="page">
      <TopBar />
      <h1 className="title">Saved</h1>
      {takes == null ? <p className="muted search-empty">Loading…</p> : null}
      {takes?.length === 0 ? <p className="muted search-empty">Tap the bookmark on a take to save it here.</p> : null}
      {takes?.map((t) => <TakeListRow key={t.id} take={t} />)}
    </main>
  );
}
