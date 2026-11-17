"use client";
// The X-style sidebar from your avatar, like the iOS ProfileDrawer: who you are, following and
// followers, both scores, then Profile, Saved, Followers, Scores, Add cash and Cash activity, with
// Settings and Log out at the bottom. (No Withdraw: off on the public fork.)
import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { money, pct, rpcNow, type Profile } from "@/lib/data";
import { fork, useForkWallet, type WalletSummary } from "@/lib/fork";
import { useSession } from "@/lib/session";
import Avatar from "./Avatar";
import { AddCash, CashActivity } from "./CashSheets";

/** Your avatar in a header; opens the drawer. `open`/`onOpenChange` let Home open it on a swipe too. */
export function ProfileMenuButton({ open: openProp, onOpenChange }: { open?: boolean; onOpenChange?: (o: boolean) => void }) {
  const { snapshot } = useSession();
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const me = snapshot?.profile;
  return (
    <>
      <button aria-label="Open menu" onClick={() => setOpen(true)} style={{ justifySelf: "start" }}>{me ? <Avatar person={me} size={34} /> : <span />}</button>
      {/* On <body>: a header with backdrop-filter traps position: fixed children (the drawer got
          clipped to the header's 98 px and the feed painted over it). */}
      {open ? createPortal(<Drawer onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}

function Drawer({ onClose }: { onClose: () => void }) {
  const { snapshot, social, logout } = useSession();
  const { address } = useForkWallet();
  const me = snapshot?.profile;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [sheet, setSheet] = useState<"add" | "cash" | null>(null);

  useEffect(() => {
    if (me?.id) rpcNow<Profile | null>("profile", { p_profile: me.id }).then(setProfile).catch(() => {});
    social<{ take_ids: string[] }>("GET", "saves").then((r) => setSaved(r.take_ids.length)).catch(() => {});
  }, [me?.id, social]);
  useEffect(() => {
    if (address) fork<WalletSummary>("GET", `/wallets/${address}`).then(setWallet).catch(() => {});
  }, [address]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!me) return null;
  const made = profile?.made ?? 0;
  const backers = profile?.backers_made ?? 0;

  return (
    <div className="drawer-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" aria-label="Menu">
        <div className="drawer-head">
          <Link href="/me" onClick={onClose} aria-label="Your profile"><Avatar person={me} size={48} /></Link>
          <div>
            <div className="drawer-name">{me.display_name ?? me.handle}</div>
            <div className="muted">@{me.handle}</div>
          </div>
          <div className="me-follow small">
            <Link href="/people/following" onClick={onClose}><b>{profile?.following ?? 0}</b> <span className="muted">Following</span></Link>
            <Link href="/people/followers" onClick={onClose}><b>{profile?.followers ?? 0}</b> <span className="muted">Followers</span></Link>
          </div>
          <div className="mono" style={{ fontSize: 12 }}><span className={made < 0 ? "down" : "up"}>{money(made, true)}</span> <span className="muted">made · {pct(profile?.return_pct ?? 0)}</span></div>
          <div className="mono" style={{ fontSize: 12 }}><span className={backers < 0 ? "down" : "up"}>{money(backers, true)}</span> <span className="muted">made for backers · {pct(profile?.backers_pct ?? 0)}</span></div>
        </div>
        <div className="hair" />
        <nav className="drawer-items">
          <Link href="/me" onClick={onClose} className="ditem">Profile</Link>
          <Link href="/saved" onClick={onClose} className="ditem">Saved {saved ? <span className="muted mono">{saved}</span> : null}</Link>
          <Link href="/people/followers" onClick={onClose} className="ditem">Followers</Link>
          <Link href="/scores" onClick={onClose} className="ditem">Scores</Link>
          <button className="ditem" onClick={() => setSheet("add")}>Add cash {wallet ? <span className="muted mono">{money(wallet.usdc)}</span> : null}</button>
          <button className="ditem" onClick={() => setSheet("cash")}>Cash activity</button>
        </nav>
        <div style={{ flex: 1 }} />
        <div className="hair" />
        <Link href="/settings" onClick={onClose} className="ditem">Settings</Link>
        <button className="ditem down" onClick={() => logout()}>Log out</button>
      </aside>
      {sheet === "add" && address ? <AddCash address={address} summary={wallet} onClose={() => setSheet(null)} onDone={setWallet} /> : null}
      {sheet === "cash" ? <CashActivity balance={wallet?.usdc ?? 0} activity={wallet?.activity ?? []} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}
