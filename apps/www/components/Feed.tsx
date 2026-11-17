"use client";
// Home, like the iOS FeedView: your avatar, the wordmark and your balance on top; For you /
// Following below it (tap, or swipe sideways), with suggested people on top of Following.
import { useCallback, useEffect, useRef, useState } from "react";
import { rpcNow, money } from "@/lib/data";
import { fork, useForkWallet, type WalletSummary } from "@/lib/fork";
import { useSession } from "@/lib/session";
import { AddCash } from "./CashSheets";
import { ProfileMenuButton } from "./Drawer";
import NotificationsBell from "./Notifications";
import SuggestedFollows from "./SuggestedFollows";
import TakeRow, { type FeedTake } from "./TakeRow";

type Page = "forYou" | "following";

export default function Feed({ initial }: { initial: FeedTake[] }) {
  const { snapshot, social } = useSession();
  const { address } = useForkWallet();
  const [page, setPage] = useState<Page>("forYou");
  const [forYou, setForYou] = useState<FeedTake[] | null>(initial.length ? initial : null);
  const [following, setFollowing] = useState<FeedTake[] | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const balance = wallet?.usdc ?? null;
  const [adding, setAdding] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const loadForYou = useCallback(async () => {
    try {
      const takes = await rpcNow<FeedTake[]>("feed", { p_limit: 50 });
      setForYou(takes.filter((t) => t.status === "live"));
      setFailed(null);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      setForYou((t) => t ?? []);
    }
  }, []);

  const loadFollowing = useCallback(async () => {
    setFollowing(await social<{ takes: FeedTake[] }>("GET", "following-feed").then((r) => r.takes).catch(() => []));
  }, [social]);

  useEffect(() => {
    loadForYou();
    loadFollowing();
    social<{ take_ids: string[] }>("GET", "saves").then((r) => setSaved(new Set(r.take_ids))).catch(() => {});
    // Fresh again whenever you come back to the app.
    const onShow = () => { if (document.visibilityState === "visible") { loadForYou(); loadFollowing(); } };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [loadForYou, loadFollowing, social]);

  useEffect(() => {
    if (address) fork<WalletSummary>("GET", `/wallets/${address}`).then(setWallet).catch(() => {});
  }, [address]);

  async function save(id: string, on: boolean) {
    setSaved((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
    try {
      await social(on ? "PUT" : "DELETE", `saves/${id}`);
    } catch {
      setSaved((s) => { const n = new Set(s); if (on) n.delete(id); else n.add(id); return n; });
    }
  }

  // Swipe sideways between the two feeds, like the app's pager.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
  const onTouchEnd = (e: React.TouchEvent) => {
    const t = touch.current;
    touch.current = null;
    if (!t) return;
    const dx = e.changedTouches[0].clientX - t.x;
    const dy = e.changedTouches[0].clientY - t.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    // Swiping right on For you opens the profile drawer, like the app.
    if (dx > 0 && page === "forYou") setDrawer(true);
    else setPage(dx < 0 ? "following" : "forYou");
  };

  const takes = page === "forYou" ? forYou : following;
  const me = snapshot?.profile;

  return (
    <main className="page feed" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="feed-top">
        <header className="topbar">
          <ProfileMenuButton open={drawer} onOpenChange={setDrawer} />
          <span className="brand">thesis</span>
          <div className="feed-actions">
          <NotificationsBell />
          <button className="balance-pill glass" onClick={() => setAdding(true)} aria-label={`Balance ${money(balance ?? 0)}. Add cash`}>
            <span className="mono">{balance == null ? "—" : money(balance)}</span>
            <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 2v8M2 6h8" /></svg>
          </button>
          </div>
        </header>
        <div className="ftabs" role="tablist">
          {(["forYou", "following"] as const).map((p) => (
            <button key={p} role="tab" aria-selected={page === p} className={page === p ? "on" : ""} onClick={() => { setPage(p); window.scrollTo({ top: 0 }); }}>
              {p === "forYou" ? "For you" : "Following"}
            </button>
          ))}
          <i className="ftabs-bar" style={{ transform: `translateX(${page === "forYou" ? 0 : 100}%)` }} />
        </div>
      </div>

      {page === "following" ? <SuggestedFollows onChange={loadFollowing} /> : null}

      {takes == null ? <p className="muted feed-empty">Loading takes…</p> : null}
      {takes?.map((t) => <TakeRow key={t.id} take={t} mine={!!me && t.author.id === me.id} saved={saved.has(t.id)} onSave={(on) => save(t.id, on)} />)}
      {takes?.length === 0 ? (
        page === "forYou" ? (
          failed ? (
            <div className="feed-empty">
              <h2>Couldn&apos;t load takes</h2>
              <p className="muted">{failed}</p>
              <button className="pill" onClick={loadForYou}>Try again</button>
            </div>
          ) : (
            <div className="feed-empty"><h2>No takes yet</h2><p className="muted">Be the first to post one.</p></div>
          )
        ) : (
          <div className="feed-empty"><h2>No takes yet</h2><p className="muted">Follow callers to see their takes here.</p></div>
        )
      ) : null}

      {adding && address ? (
        <AddCash address={address} summary={wallet} onClose={() => setAdding(false)} onDone={setWallet} />
      ) : null}
    </main>
  );
}
