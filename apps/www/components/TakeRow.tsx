"use client";
// The iOS feed's TakeRow: avatar column, then the take. The claim, return, sparkline and allocation
// bar open the take page; Trade / Fade open it with that sheet up; then comments, save and share.
import Link from "next/link";
import { pct, SERIES, type Take } from "@/lib/data";
import Avatar from "./Avatar";

export type FeedTake = Take & { tags?: string[]; history?: number[]; topic?: string; money_in?: number; posting?: boolean };

const RISK: Record<string, string> = { low: "LOW", medium: "MED", high: "HIGH" };

/** "now", "5m", "2h", "3d", then "Dec 4", like the app's take.age. */
export function age(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function Sparkline({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * 130).toFixed(1)} ${(4 + (1 - (v - min) / span) * 28).toFixed(1)}`).join("");
  return (
    <svg className="spark" viewBox="0 0 130 36" aria-hidden>
      <path d={d} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function AllocationBar({ legs }: { legs: Take["legs"] }) {
  const total = legs.reduce((s, l) => s + l.weight, 0) || 1;
  return (
    <div className="alloc" aria-hidden>
      {legs.map((l, i) => <span key={i} style={{ flex: l.weight / total, background: SERIES[l.slot] ?? SERIES[i % SERIES.length] }} />)}
    </div>
  );
}

const Arrow = ({ down }: { down?: boolean }) => (
  <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {down ? <path d="M3 3l6 6M9 4v5H4" /> : <path d="M3 9l6-6M4 3h5v5" />}
  </svg>
);

// `mine`: your own take, which you can't fade, so it shows no Fade pill.
export default function TakeRow({ take, saved, onSave, mine = false }: { take: FeedTake; saved: boolean; onSave: (on: boolean) => void; mine?: boolean }) {
  const up = take.ret >= 0;
  const href = `/t/${take.id}`;
  const profile = take.author.handle ? `/u/${take.author.handle}` : href;

  async function share() {
    const url = new URL(href, window.location.origin).toString();
    if (navigator.share) {
      try { await navigator.share({ text: take.claim, url }); return; } catch (e) { if ((e as Error).name === "AbortError") return; }
    }
    try { await navigator.clipboard.writeText(url); } catch { window.prompt("Copy this link", url); }
  }

  return (
    <article className="trow">
      <Link href={profile} aria-label={take.author.display_name ?? take.author.handle ?? "Author"}><Avatar person={take.author} size={42} /></Link>
      <div className="trow-main">
        <div className="trow-head">
          <Link href={profile} className="trow-who">
            <b>{take.author.display_name ?? take.author.handle}</b>
            <span className="muted">@{take.author.handle} · {age(take.created_at)}</span>
          </Link>
          <span className="caps trow-tag">{RISK[take.risk] ?? take.risk} · {take.horizon.toUpperCase()}</span>
        </div>
        <Link href={href} className="trow-body">
          <div className="trow-claim">{take.claim}</div>
          <div className="trow-ret">
            <div>
              <div className={`trow-pct ${up ? "up" : "down"}`}>{pct(take.ret)}</div>
              <div className="caps" style={{ fontSize: 11 }}>since {new Date(take.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
            </div>
            <Sparkline values={take.history ?? []} up={up} />
          </div>
          <AllocationBar legs={take.legs} />
        </Link>
        {take.posting ? (
          <div className="muted small" style={{ padding: "10px 0" }}>Posting… only you can see it</div>
        ) : (
          <div className="trow-actions">
            <Link href={`${href}?side=back`} className="sidepill up-pill"><Arrow /> Trade <span className="mono">{take.backs}</span></Link>
            {mine ? null : <Link href={`${href}?side=fade`} className="sidepill down-pill"><Arrow down /> Fade <span className="mono">{take.fades}</span></Link>}
            <span style={{ flex: 1 }} />
            <Link href={`${href}?comments=1`} className="trow-icon" aria-label={`${take.comments} comments`}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><path d="M4 5h16v11H9l-5 4V5Z" strokeLinejoin="round" /></svg>
              <span className="mono">{take.comments}</span>
            </Link>
            <button className="trow-icon" aria-label={saved ? "Saved" : "Save"} aria-pressed={saved} onClick={() => onSave(!saved)}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" aria-hidden><path d="M6 3h12v18l-6-4-6 4V3Z" strokeLinejoin="round" /></svg>
            </button>
            <button className="trow-icon" aria-label="Share" onClick={share}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3v12M7 8l5-5 5 5M5 13v7h14v-7" /></svg>
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
