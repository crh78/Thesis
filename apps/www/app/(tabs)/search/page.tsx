"use client";
// Search, like the iOS SearchView: All, Takes, People and Assets. Nothing typed shows topics,
// suggested people, the week's top callers and trending takes; typing searches (debounced) and
// All shows the best few of each kind, assets first.
import Link from "next/link";
import { useEffect, useState } from "react";
import { AssetRow, TakeListRow, type Asset } from "@/components/AssetBits";
import Avatar from "@/components/Avatar";
import SuggestedFollows from "@/components/SuggestedFollows";
import XTradersRow from "@/components/XTraders";
import type { FeedTake } from "@/components/TakeRow";
import { rpcNow, type Person } from "@/lib/data";
import { useSession } from "@/lib/session";

type Scope = "all" | "takes" | "people" | "assets";
const SCOPES: [Scope, string][] = [["all", "All"], ["takes", "Takes"], ["people", "People"], ["assets", "Assets"]];
const TOPICS = ["All", "AI", "Energy", "Rates", "Chips", "Housing"];
const PROMPT: Record<Scope, string> = {
  all: "Anything: a ticker, an idea, a person",
  takes: "Anything: a ticker, an idea, a person",
  people: "Name or @handle",
  assets: "Ticker, company or idea",
};

/** "+$4.1k" for tight spaces, like the app's Fmt.compact. */
const compact = (v: number) => (Math.abs(v) < 1000 ? `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(0)}` : `${v < 0 ? "−" : "+"}$${(Math.abs(v) / 1000).toFixed(1)}k`);

export default function SearchPage() {
  const { snapshot, assets: assetsFn } = useSession();
  const me = snapshot?.profile;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [topic, setTopic] = useState("All");
  const [takes, setTakes] = useState<FeedTake[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [callers, setCallers] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = query.trim();
  const tag = topic === "All" ? null : topic;

  // The week's top callers, for the empty Takes page.
  useEffect(() => {
    rpcNow<{ person: Person }[]>("leaderboard", { p_period: "week", p_board: "own", p_sort: "cash" })
      .then((rows) => setCallers(rows.slice(0, 6).map((r) => r.person).filter((p) => p.id !== me?.id)))
      .catch(() => {});
  }, [me?.id]);

  useEffect(() => {
    let live = true;
    const run = async () => {
      setSearching(true);
      setError(null);
      const takesFor = () => (q ? rpcNow<FeedTake[]>("search_takes", { p_query: q, p_tag: tag }) : rpcNow<FeedTake[]>("trending", { p_tag: tag }));
      const peopleFor = () => rpcNow<Person[]>("search_people", { p_query: q });
      const assetsFor = () => assetsFn<{ assets: Asset[] }>(`search?q=${encodeURIComponent(q)}&limit=20`).then((r) => r.assets);
      try {
        if (scope === "all" && q) {
          // All three at once; one failing (or slow) doesn't hold up the others.
          const [a, p, t] = await Promise.all([assetsFor().catch(() => []), peopleFor().catch(() => []), takesFor().catch(() => [])]);
          if (!live) return;
          setAssets(a); setPeople(p); setTakes(t);
        } else if (scope === "all" || scope === "takes") {
          const t = await takesFor();
          if (live) setTakes(t);
        } else if (scope === "people") {
          const p = q ? await peopleFor() : [];
          if (live) setPeople(p);
        } else {
          const a = await assetsFor();
          if (live) setAssets(a);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Search didn't go through.");
      } finally {
        if (live) setSearching(false);
      }
    };
    const id = window.setTimeout(run, q ? 180 : 0);
    return () => { live = false; window.clearTimeout(id); };
  }, [q, tag, scope, assetsFn]);

  const empty = (text: string) => <p className="muted search-empty">{searching ? "Searching…" : text}</p>;
  const noResults = empty(`No results for "${q}"`);

  const takesPage = (
    <>
      <div className="chip-row">
        {TOPICS.map((t) => (
          <button key={t} className={`topic-chip${topic === t ? " on" : ""}`} onClick={() => setTopic(t)}>{t}</button>
        ))}
      </div>
      {!q ? (
        <>
          <SuggestedFollows />
          {callers.length ? (
            <section>
              <h2 className="search-h">Top calls this week</h2>
              <div className="callers">
                {callers.map((p) => (
                  <Link key={p.id} href={p.handle ? `/u/${p.handle}` : "#"} className="caller">
                    <span className="caller-ring"><Avatar person={p} size={56} /></span>
                    <span className="small" style={{ fontWeight: 500 }}>{p.handle}</span>
                    <span className="mono up" style={{ fontSize: 11 }}>{compact(p.made ?? 0)}</span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
      <h2 className="search-h">{q ? "Results" : tag ? `Trending ${tag.toLowerCase()} takes` : "Trending takes"}</h2>
      {takes.map((t) => <TakeListRow key={t.id} take={t} />)}
      {!takes.length ? (q ? noResults : empty(`No ${tag ? `${tag} ` : ""}takes so far.`)) : null}
    </>
  );

  const section = (title: string, more: Scope | null) => (
    <div className="search-sec">
      <h2 className="search-h" style={{ margin: 0 }}>{title}</h2>
      {more ? <button className="up small" style={{ fontWeight: 600 }} onClick={() => setScope(more)}>See all</button> : null}
    </div>
  );

  return (
    <main className="page search">
      <h1 className="title">Search</h1>
      <div className="search-box">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>
        <input type="search" inputMode="search" enterKeyHint="search" placeholder={PROMPT[scope]} aria-label="Search" value={query} onChange={(e) => setQuery(e.target.value)} autoCapitalize="none" autoCorrect="off" />
        {query ? <button aria-label="Clear" className="muted" onClick={() => setQuery("")}>×</button> : null}
      </div>
      <div className="segmented four" role="tablist" aria-label="Search for">
        {SCOPES.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={scope === k} className={scope === k ? "on" : ""} onClick={() => setScope(k)}>{l}</button>
        ))}
      </div>
      {error ? <p className="err">{error}</p> : null}

      {scope === "all" && !q ? <><XTradersRow />{takesPage}</> : null}
      {scope === "all" && q ? (
        <>
          {assets.length ? <>{section("Assets", assets.length > 4 ? "assets" : null)}{assets.slice(0, 4).map((a) => <AssetRow key={a.id} asset={a} />)}</> : null}
          {people.length ? <>{section("People", people.length > 3 ? "people" : null)}{people.slice(0, 3).map((p) => <PersonRow key={p.id} person={p} />)}</> : null}
          {takes.length ? <>{section("Takes", takes.length > 5 ? "takes" : null)}{takes.slice(0, 5).map((t) => <TakeListRow key={t.id} take={t} />)}</> : null}
          {!assets.length && !people.length && !takes.length ? noResults : null}
        </>
      ) : null}
      {scope === "takes" ? takesPage : null}
      {scope === "people" ? (
        !q ? (
          <>
            <SuggestedFollows />
            <p className="muted small" style={{ marginTop: 18 }}>Search by name or @handle.</p>
          </>
        ) : people.length ? people.map((p) => <PersonRow key={p.id} person={p} />) : noResults
      ) : null}
      {scope === "assets" ? (
        <>
          <h2 className="search-h">{q ? "Assets" : "Most traded"}</h2>
          {assets.map((a) => <AssetRow key={a.id} asset={a} />)}
          {!assets.length ? (q ? noResults : empty("Nothing to show yet.")) : null}
        </>
      ) : null}
    </main>
  );
}

function PersonRow({ person }: { person: Person }) {
  return (
    <Link href={person.handle ? `/u/${person.handle}` : "#"} className="prow">
      <Avatar person={person} size={44} />
      <span className="prow-main">
        <b>{person.display_name ?? person.handle}</b>
        <span className="muted small">@{person.handle}{person.takes != null ? ` · ${person.takes} ${person.takes === 1 ? "take" : "takes"}` : ""}</span>
      </span>
    </Link>
  );
}
