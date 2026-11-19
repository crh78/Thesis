"use client";
// Your inbox, like the iOS NotificationsView: new takes from people you follow, comments, trades and
// fades on your takes, settlements, badges, the daily digest, liquidation warnings and calls from X
// accounts you copy. Opening it marks everything read.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fromCall } from "@/lib/compose";
import { useSession } from "@/lib/session";
import { useComposer } from "./Composer";
import { PixelIcon, type PixelIconName } from "./PixelIcon";
import { age } from "./TakeRow";

type Note = {
  id: number;
  kind: string;
  title: string;
  body: string;
  take_id: string | null;
  created_at: string;
  read: boolean;
  data?: { claim?: string | null; risk?: string | null; horizon?: string | null; source_url?: string | null; source_label?: string | null } | null;
};
type Inbox = { unread: number; notifications: Note[] };

// Each kind's pixel icon and the tone of its tile (globals.css: .ntone-*).
const ICON: Record<string, [PixelIconName, string]> = {
  new_take: ["spark", "gold"], comment: ["comment", "blue"], take_traded: ["up", "up"], take_faded: ["down", "down"],
  take_settled: ["flag", "plain"], take_closed: ["flag", "plain"], badge: ["medal", "gold"],
  daily_positions: ["chart", "up"], liquidation_risk: ["warn", "amber"], x_call: ["x", "plain"],
};

/** The bell on Home: a dot while something's unread; opens the inbox. */
export default function NotificationsBell() {
  const { social } = useSession();
  const composer = useComposer();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => social<Inbox>("GET", "notifications?limit=50").then(setInbox).catch(() => {}), [social]);
  useEffect(() => {
    load();
    const onShow = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [load]);

  async function show() {
    setOpen(true);
    await load();
    // Opening the inbox marks everything read (as the app does).
    social<{ unread: number }>("POST", "notifications/read", { ids: null })
      .then((r) => setInbox((i) => (i ? { ...i, unread: r.unread } : i)))
      .catch(() => {});
  }

  const unread = inbox?.unread ?? 0;
  return (
    <>
      <button className="icon-btn bell" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} onClick={show}>
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z" /><path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
        {unread ? <i className="bell-dot" /> : null}
      </button>
      {open ? createPortal(
        <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="sheet" role="dialog" aria-label="Notifications">
            <button className="x" aria-label="Close" onClick={() => setOpen(false)}>×</button>
            <h3>Notifications</h3>
            {inbox == null ? <p className="muted search-empty">Loading…</p> : null}
            {inbox?.notifications.length === 0 ? (
              <p className="muted search-empty">Nothing yet. Follow people to hear when they post, and trade a take to get a daily update on it.</p>
            ) : null}
            {inbox?.notifications.map((n) => {
              const row = (
                <>
                  {(() => {
                    const [icon, tone] = ICON[n.kind] ?? ["spark", "plain"];
                    return <span className={`nglyph ntone-${tone}`} aria-hidden><PixelIcon name={icon} /></span>;
                  })()}
                  <span className="nmain">
                    <span style={{ fontWeight: n.read ? 400 : 600 }}>{n.title}</span>
                    {n.body ? <span className="muted small nbody">{n.body}</span> : null}
                    <span className="mono muted" style={{ fontSize: 11 }}>{age(n.created_at)}</span>
                  </span>
                  {!n.read ? <i className="ndot" aria-label="Unread" /> : <span />}
                </>
              );
              // A call from an X account you copy: open the composer on that take, basket built.
              const call = n.kind === "x_call" && n.data?.claim ? n.data : null;
              if (call) {
                return (
                  <button key={n.id} className="nrow" style={{ width: "100%", textAlign: "left" }}
                    onClick={() => { setOpen(false); composer.open(fromCall({ claim: call.claim!, risk: call.risk, url: call.source_url, label: call.source_label ?? "X" })); }}>
                    {row}
                  </button>
                );
              }
              if (n.take_id) return <Link key={n.id} className="nrow" href={`/t/${n.take_id}`} onClick={() => setOpen(false)}>{row}</Link>;
              return <div key={n.id} className="nrow">{row}</div>;
            })}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
