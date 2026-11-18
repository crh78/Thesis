"use client";
// Me, laid out like the iOS ProfileView on the fork: who you are and your two scores, your portfolio
// (cash plus positions) charted over a range, your cash, creator fees once earned, then open
// positions, your takes and badges. Positions show the fork API's valueUsd against costUsd.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useLinkAccount } from "@privy-io/react-auth";
import Avatar from "@/components/Avatar";
import { AddCash, CapLine, CashActivity } from "@/components/CashSheets";
import Chart from "@/components/Chart";
import CreatorFees from "@/components/CreatorFees";
import EditProfile from "@/components/EditProfile";
import { hasPhoenixCash, LiquidationLines, PhoenixCashCard } from "@/components/Phoenix";
import { PostingRow } from "@/components/PostingRecovery";
import ShareButton from "@/components/ShareButton";
import { money, pct, rpcNow, topicImage, type Profile, type Take } from "@/lib/data";
import { fork, holdings, markTraded, TRADED_AT_KEY, TRADED_EVENT, useForkWallet, type CreatorFees as Fees, type History, type Incomplete, type PhoenixCash, type Portfolio, type WalletSummary } from "@/lib/fork";
import StoppedTrade from "@/components/StoppedTrade";
import { X_LOGIN } from "@/lib/flags";
import { MY_TAKES_EVENT } from "@/lib/posting";
import { useSession } from "@/lib/session";

type Tab = "positions" | "takes" | "badges";
const RANGES = ["1D", "1W", "1M", "All"] as const;
const CAPTION: Record<string, string> = { "1D": "today", "1W": "past week", "1M": "past month", All: "all time" };

export default function MePage() {
  const { snapshot, hints, social, logout } = useSession();
  const { address, wallet, signAndSubmit, creatorFees } = useForkWallet();
  const { linkTwitter } = useLinkAccount();
  const me = snapshot?.profile;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [takes, setTakes] = useState<(Take & { posting?: boolean })[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [history, setHistory] = useState<Record<string, History>>({});
  const [fees, setFees] = useState<Fees | null>(null);
  const [phoenix, setPhoenix] = useState<PhoenixCash | null>(null);
  const [stopped, setStopped] = useState<Incomplete[]>([]);
  // What finishing or sweeping a stopped trade did, once its card is gone.
  const [stoppedNote, setStoppedNote] = useState<string | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]>("1W");
  const [scrub, setScrub] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("positions");
  // "Didn't post" links here with ?tab=takes (and says so with an event when Me is already open).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "takes") setTab("takes");
    const on = () => setTab("takes");
    window.addEventListener(MY_TAKES_EVENT, on);
    return () => window.removeEventListener(MY_TAKES_EVENT, on);
  }, []);
  const [sheet, setSheet] = useState<"add" | "cash" | null>(null);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped by every trade, sale or post (markTraded), even one made while Me stays open.
  const [traded, setTraded] = useState(0);
  useEffect(() => {
    const on = () => setTraded((n) => n + 1);
    window.addEventListener(TRADED_EVENT, on);
    return () => window.removeEventListener(TRADED_EVENT, on);
  }, []);

  // Your profile and takes (Supabase), as everyone sees them; the ones still posting only you see.
  const loadSocial = useCallback(async () => {
    if (!me?.id) return;
    const [p, live, posting] = await Promise.all([
      rpcNow<Profile | null>("profile", { p_profile: me.id }).catch(() => null),
      rpcNow<Take[]>("profile_takes", { p_profile: me.id }).catch(() => []),
      social<{ takes: Take[] }>("GET", "takes/posting").then((r) => r.takes).catch(() => []),
    ]);
    setProfile(p);
    setTakes([...posting.map((t) => ({ ...t, posting: true })), ...live.filter((t) => t.status === "live")]);
  }, [me?.id, social]);

  // Your money on the fork: cash, positions and badges.
  const loadFork = useCallback(async () => {
    if (!address) return;
    try {
      const [s, p] = await Promise.all([
        fork<WalletSummary>("GET", `/wallets/${address}`),
        fork<Portfolio>("GET", `/wallets/${address}/portfolio`),
      ]);
      setSummary(s);
      setPortfolio(p);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [address]);

  // Cash a sale left on Phoenix (leveraged legs, fade shorts), waiting for "Cash out". Loaded on
  // open, after a trade or sale, and when the Cash sheet opens; not with every portfolio poll.
  const loadPhoenix = useCallback(async () => {
    if (!address) return;
    setPhoenix(await fork<PhoenixCash>("GET", `/wallets/${address}/phoenix`).catch(() => null));
  }, [address]);
  useEffect(() => { loadPhoenix(); }, [loadPhoenix, traded]);
  useEffect(() => { if (sheet === "cash") loadPhoenix(); }, [sheet, loadPhoenix]);

  // Split trades that stopped partway (StoppedTrade), so they can be finished or swapped back to
  // cash after a reload or from another device. Loaded on open and after a trade.
  const loadStopped = useCallback(async () => {
    if (!address) return;
    setStopped(await fork<{ trades: Incomplete[] }>("GET", `/wallets/${address}/incomplete`).then((r) => r.trades ?? []).catch(() => []));
  }, [address]);
  useEffect(() => { loadStopped(); }, [loadStopped, traded]);

  // Once per wallet (it signs a message), and again after a claim.
  const walletReady = !!wallet;
  const loadFees = useCallback(async () => {
    if (!walletReady) return;
    setFees(await creatorFees().catch(() => null));
  }, [walletReady, creatorFees]);

  useEffect(() => { loadSocial(); }, [loadSocial]);
  useEffect(() => {
    loadFork();
    // A trade takes a while to land on the fork and show in the portfolio. If you traded in the last
    // two minutes, check again every 5 s until then; and again whenever you come back to the app.
    let tradedAt = 0;
    try { tradedAt = Number(sessionStorage.getItem(TRADED_AT_KEY) ?? 0); } catch { /* private mode */ }
    const until = tradedAt + 120_000;
    // A post shows here as posting, then live once the chain confirms it: takes reload too.
    if (traded) loadSocial();
    const poll = Date.now() < until ? window.setInterval(() => (Date.now() < until ? (loadFork(), loadSocial()) : window.clearInterval(poll)), 5000) : 0;
    const onShow = () => { if (document.visibilityState === "visible") { loadFork(); loadSocial(); } };
    document.addEventListener("visibilitychange", onShow);
    return () => { window.clearInterval(poll); document.removeEventListener("visibilitychange", onShow); };
  }, [loadFork, loadSocial, traded]);
  useEffect(() => { loadFees(); }, [loadFees]);
  useEffect(() => {
    if (!address) return;
    setScrub(null);
    fork<History>("GET", `/wallets/${address}/history?range=${range.toUpperCase()}`)
      .then((h) => setHistory((all) => ({ ...all, [range]: h })))
      .catch(() => {});
  }, [address, range, traded]);

  const balance = summary?.usdc ?? 0;
  const held = holdings((portfolio?.positions ?? []).filter((p) => !p.exited));
  // Without a history yet (or if it can't load), a flat line at what you have now: cash plus positions.
  const now = balance + held.reduce((s, p) => s + (p.valueUsd ?? p.stakeUsd), 0);
  const h = history[range];
  let points = (h?.points ?? []).map((p) => p.value);
  if (points.length < 2) {
    const v = points[0] ?? h?.value ?? now;
    points = [v, v];
  }
  const last = points.length - 1;
  // The headline is what you have now (cash plus positions), not the history's last sample.
  if (summary && portfolio) points = [...points.slice(0, last), now];
  const idx = scrub ?? last;
  const value = points[idx];
  const change = value - points[0];
  const changePct = points[0] > 0 ? (change / points[0]) * 100 : 0;
  const whole = money(value).replace(/\.\d+$/, "");
  const cents = money(value).match(/\.\d+$/)?.[0] ?? "";
  const label = scrub == null
    ? CAPTION[range]
    : new Date((h?.points[scrub]?.at ?? Date.now() / 1000) * 1000).toLocaleString("en-US", range === "1D" ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" });

  const made = profile?.made ?? 0;
  const backers = profile?.backers_made ?? 0;

  if (!me) return null;

  return (
    <main className="page me-page">
      <header className="topbar">
        <span />
        <span />
        <div className="me-actions">
          <button className="icon-btn" onClick={() => setEditing(true)}>Edit profile</button>
          <ShareButton text="My takes on Thesis" label="Share" className="icon-btn" icon url={me.handle ? `/u/${me.handle}` : undefined} />
          <div className="menu-wrap">
            <button className="icon-btn" aria-label="Settings" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>
            </button>
            {menu ? (
              <div className="menu glass" role="menu">
                {!X_LOGIN ? null : hints.hasX ? (
                  <div className="menu-item muted" role="menuitem">X connected · @{hints.xHandle}</div>
                ) : (
                  <button className="menu-item" role="menuitem" onClick={() => { setMenu(false); linkTwitter(); }}>Connect X</button>
                )}
                <button className="menu-item down" role="menuitem" onClick={() => logout()}>Log out</button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <section className="me-head">
        <Avatar person={me} size={72} />
        <h1>{me.display_name ?? me.handle}</h1>
        <div className="muted small">@{me.handle}</div>
        {profile?.bio ? <p className="me-bio">{profile.bio}</p> : null}
        <div className="me-follow small">
          <span><b>{profile?.following ?? 0}</b> <span className="muted">Following</span></span>
          <span><b>{profile?.followers ?? 0}</b> <span className="muted">Followers</span></span>
        </div>
        <div className="caps me-counts">
          <span>{takes.length} {takes.length === 1 ? "take" : "takes"}</span>
          <span>{held.length} {held.length === 1 ? "position" : "positions"}</span>
        </div>
        <div className="mono me-scores">
          <span><span className={made < 0 ? "down" : "up"}>{money(made, true)}</span> <span className="muted">OWN P&amp;L · {pct(profile?.return_pct ?? 0)}</span></span>
          <span><span className={backers < 0 ? "down" : "up"}>{money(backers, true)}</span> <span className="muted">MADE FOR BACKERS · {pct(profile?.backers_pct ?? 0)}</span></span>
        </div>
      </section>

      <div className="hair" />

      <section className="me-value">
        <div>
          <div className="me-big">{whole}<span className="muted">{cents}</span></div>
          <div className="mono small">
            <span className={change < 0 ? "down" : "up"}>{money(change, true)} ({pct(changePct, 2)})</span>{" "}
            <span className="muted">{label}</span>
          </div>
        </div>
        <div className="ranges" role="tablist" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r} role="tab" aria-selected={range === r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
      </section>
      <Chart values={points} scrub={scrub} onScrub={setScrub} />

      <section className="me-cash">
        <button className="me-cash-label" onClick={() => setSheet("cash")}>
          Cash balance <b className="mono">{money(balance)}</b> <span className="muted">›</span>
        </button>
        <button className="pill small" onClick={() => setSheet("add")}>Add cash</button>
      </section>
      {summary ? <CapLine summary={summary} /> : null}
      {address ? stopped.map((t) => (
        <div className="phx-card" key={t.position}>
          <StoppedTrade card address={address} trade={t} retry={t.next === "retry"} signAndSubmit={signAndSubmit}
            onDone={(text) => { setStoppedNote(text); markTraded(); }} />
        </div>
      )) : null}
      {stoppedNote && !stopped.length ? <p className="muted small" style={{ margin: "8px 0" }}>{stoppedNote}</p> : null}
      {hasPhoenixCash(phoenix) && address ? <PhoenixCashCard address={address} phoenix={phoenix} onDone={() => { loadPhoenix(); loadFork(); }} /> : null}
      {loadError ? <div className="err">Couldn&apos;t load your money: {loadError}</div> : null}
      <div className="hair" />

      {fees && fees.earnedUsd > 0 && address ? (
        <>
          <CreatorFees fees={fees} address={address} signAndSubmit={signAndSubmit} onClaimed={() => { loadFees(); loadFork(); }} />
          <div className="hair" />
        </>
      ) : null}

      <nav className="utabs" role="tablist">
        {([["positions", "Open positions"], ["takes", "My takes"], ["badges", "Badges"]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      <div className="me-list">
        {tab === "positions" ? (
          held.length ? held.map((p) => {
            const ret = p.valueUsd != null && p.costUsd != null && p.costUsd > 0 ? (p.valueUsd / p.costUsd - 1) * 100 : null;
            const detail = p.pendingNote ?? (p.returnBps != null ? `score ${pct(p.returnBps / 100)}` : "pricing…");
            return (
              <Link key={p.address} href={`/t/${p.takeId}`} className="item">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="tile" src={topicImage(p.topic)} alt="" />
                <div className="item-main">
                  <div className="item-claim">{p.claim}</div>
                  <div className="item-meta"><b className={p.side === "fade" ? "down" : "up"}>{p.side === "fade" ? "Faded" : "Traded"}</b> · {[p.authorHandle && `@${p.authorHandle}`, detail].filter(Boolean).join(" · ")}</div>
                  {/* Leveraged legs and fade shorts: where each is liquidated (the take page adds the leverage). */}
                  <LiquidationLines risks={p.phoenix} />
                </div>
                <div className="item-num">
                  <div className="mono">{money(p.valueUsd ?? p.stakeUsd)}</div>
                  {ret != null ? <div className={`mono small ${ret < 0 ? "down" : "up"}`}>{pct(ret)}</div> : null}
                </div>
              </Link>
            );
          }) : <p className="muted me-empty">Trade or fade a take and it shows up here.</p>
        ) : null}

        {tab === "takes" ? (
          takes.length ? takes.map((t) => (
            t.posting ? (
              <PostingRow key={t.id} take={t} onChanged={loadSocial} />
            ) : (
              <Link key={t.id} href={`/t/${t.id}`} className="item">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="tile" src={topicImage((t as Take & { topic?: string }).topic)} alt="" />
                <div className="item-main">
                  <div className="item-claim">{t.claim}</div>
                  <div className="item-meta"><b>Live</b> · {t.settles_at ? `ends ${new Date(t.settles_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ` : ""}{t.backs} traded</div>
                </div>
                <div className="item-num">
                  <div className="mono">{money((t as Take & { money_in?: number }).money_in ?? 0).replace(/\.00$/, "")}</div>
                  <div className={`mono small ${t.ret < 0 ? "down" : "up"}`}>{pct(t.ret)}</div>
                </div>
              </Link>
            )
          )) : <p className="muted me-empty">Takes you post show up here.</p>
        ) : null}

        {tab === "badges" ? (
          portfolio?.badges.length ? portfolio.badges.map((b) => (
            <div key={b.mint} className="item">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="tile" src={b.image ?? topicImage(null)} alt="" />
              <div className="item-main">
                <div className="item-claim">{b.title}</div>
                <div className="item-meta"><b className="up">Badge</b> · on-chain · {b.mint.slice(0, 4)}…{b.mint.slice(-4)}</div>
              </div>
            </div>
          )) : <p className="muted me-empty">Call it right and you&apos;ll earn a badge.</p>
        ) : null}
      </div>

      <div className="hair" />
      <button className="obtn plain down" onClick={() => logout()}>Log out</button>

      {sheet === "add" && address ? (
        <AddCash address={address} summary={summary} onClose={() => setSheet(null)} onDone={(s) => { setSummary(s); loadFork(); }} />
      ) : null}
      {editing ? <EditProfile bio={profile?.bio ?? ""} onClose={() => setEditing(false)} onSaved={loadSocial} /> : null}
      {sheet === "cash" ? (
        <CashActivity balance={balance} activity={summary?.activity ?? []} onClose={() => setSheet(null)}>
          {hasPhoenixCash(phoenix) && address ? <PhoenixCashCard address={address} phoenix={phoenix} onDone={() => { loadPhoenix(); loadFork(); }} /> : null}
        </CashActivity>
      ) : null}
    </main>
  );
}
