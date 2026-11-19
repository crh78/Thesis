"use client";
// Settings, like the iOS SettingsView: who can see your follow lists, your connected X account,
// and deleting your account. (The app's Appearance setting isn't here: the web follows the
// system's light or dark mode.)
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLinkAccount } from "@privy-io/react-auth";
import { showInstall } from "@/components/AppPrompts";
import { rpcNow } from "@/lib/data";
import { X_BOT, X_LOGIN } from "@/lib/flags";
import { currentSubscription, disablePush, enablePush, isStandalone, pushSupported } from "@/lib/push";
import { useSession } from "@/lib/session";
import TopBar from "@/components/TopBar";

type Privacy = { show_following: boolean; show_followers: boolean };

export default function SettingsPage() {
  const router = useRouter();
  const { snapshot, hints, social, token, logout } = useSession();
  const me = snapshot?.profile;
  const [privacy, setPrivacy] = useState<Privacy | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [push, setPush] = useState<{ supported: boolean; standalone: boolean; on: boolean } | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const { linkTwitter } = useLinkAccount({
    onError: (e) => setLinkError(e === "exited_link_flow" ? null : "Couldn't connect X. Try again."),
  });

  useEffect(() => {
    if (me?.id) rpcNow<Privacy | null>("profile", { p_profile: me.id }).then((p) => p && setPrivacy({ show_following: p.show_following, show_followers: p.show_followers })).catch(() => {});
  }, [me?.id]);

  useEffect(() => {
    (async () => setPush({ supported: pushSupported(), standalone: isStandalone(), on: pushSupported() && Notification.permission === "granted" && !!(await currentSubscription()) }))();
  }, []);

  async function togglePush() {
    if (!push) return;
    setPushError(null);
    try {
      if (push.on) {
        await disablePush(token);
        setPush({ ...push, on: false });
      } else {
        const r = await enablePush(token);
        if (r === "denied") setPushError("Notifications are blocked for Thesis. Turn them on in your phone's or browser's settings.");
        setPush({ ...push, on: r === "on" });
      }
    } catch (e) {
      setPushError(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggle(key: keyof Privacy) {
    if (!privacy) return;
    const next = { ...privacy, [key]: !privacy[key] };
    setPrivacy(next);
    try {
      await social("PATCH", "profile", { [key]: next[key] });
    } catch {
      setPrivacy(privacy);
    }
  }

  async function deleteAccount() {
    setDeleting(true);
    setError(null);
    try {
      const r = await fetch("/api/session", { method: "DELETE", headers: { "privy-token": await token(), "content-type": "application/json" }, body: JSON.stringify({ confirm: "delete" }) });
      if (!r.ok) throw new Error("Couldn't delete your account. Try again.");
      await logout();
      router.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  return (
    <main className="page">
      <TopBar />
      <h1 className="title">Settings</h1>

      <section className="set-sec">
        <div className="caps">Privacy</div>
        <label className="set-row">
          <span>Show who you follow</span>
          <input type="checkbox" className="switch" checked={privacy?.show_following ?? true} disabled={!privacy} onChange={() => toggle("show_following")} />
        </label>
        <label className="set-row">
          <span>Show your followers</span>
          <input type="checkbox" className="switch" checked={privacy?.show_followers ?? true} disabled={!privacy} onChange={() => toggle("show_followers")} />
        </label>
        <p className="muted small">When a list is off, only you can see it. Your follower and following counts stay visible.</p>
      </section>

      <section className="set-sec">
        <div className="caps">App</div>
        {push && !push.standalone ? (
          <button className="set-row" onClick={showInstall}><span>Add to home screen</span><span className="muted">›</span></button>
        ) : null}
        {push?.supported ? (
          <label className="set-row">
            <span>Notifications</span>
            <input type="checkbox" className="switch" checked={push.on} onChange={togglePush} />
          </label>
        ) : push ? (
          <p className="muted small">On iPhone, notifications work once Thesis is on your home screen.</p>
        ) : null}
        {pushError ? <div className="err">{pushError}</div> : null}
      </section>

      {X_LOGIN ? (
      <section className="set-sec">
        <div className="caps">X</div>
        {hints.hasX ? (
          <div className="set-row"><span>Connected</span><span className="muted">@{hints.xHandle}</span></div>
        ) : (
          <button className="set-row" onClick={() => { setLinkError(null); linkTwitter(); }}><span>Connect X</span><span className="muted">›</span></button>
        )}
        <p className="muted small">Reply to any post on X with @{X_BOT} make this a take and we&apos;ll build it a basket, saved here for you to post.</p>
        {linkError ? <div className="err">{linkError}</div> : null}
      </section>
      ) : null}

      <section className="set-sec">
        <div className="caps">Account</div>
        <button className="set-row down" onClick={() => setConfirm(true)}><span>Delete account</span></button>
        <p className="muted small">Deletes your profile, takes, comments, follows and cash for good. This can&apos;t be undone.</p>
        <button className="set-row" onClick={() => logout()}><span>Log out</span></button>
      </section>

      {confirm ? (
        <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && !deleting && setConfirm(false)}>
          <div className="sheet" role="alertdialog" aria-label="Delete account">
            <h3>Delete your account?</h3>
            <p className="muted">Your profile, takes, comments, follows and cash will be gone for good.</p>
            {error ? <div className="err">{error}</div> : null}
            <button className="obtn filled down-fill" disabled={deleting} onClick={deleteAccount}>{deleting ? "Deleting…" : "Delete"}</button>
            <button className="obtn plain" disabled={deleting} onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
