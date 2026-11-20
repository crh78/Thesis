"use client";
// The add-to-home-screen prompt (once, after sign-in, on a phone) and the
// notifications ask (once Thesis runs from the home screen). Settings can bring the install steps
// back ("thesis:install" event).
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X_BOT } from "@/lib/flags";
import { enablePush, iosBrowser, isIOS, isPhone, isStandalone, pushSupported, registerServiceWorker, type IOSBrowser } from "@/lib/push";
import { useSession } from "@/lib/session";

type BeforeInstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const seen = (key: string) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } };
const markSeen = (key: string) => { try { localStorage.setItem(key, "1"); } catch { /* private mode */ } };

/** Opens the install steps from anywhere (Settings → Add to home screen). */
export const showInstall = () => window.dispatchEvent(new Event("thesis:install"));

/** Shown after the connect-X prompt is out of the way (`ready`). */
export default function AppPrompts({ ready }: { ready: boolean }) {
  const { userId, token } = useSession();
  const [installEvent, setInstallEvent] = useState<BeforeInstallPrompt | null>(null);
  const [which, setWhich] = useState<"trade" | "install" | "push" | null>(null);
  const installKey = `thesis.install.seen.${userId}`;
  const pushKey = `thesis.push.asked.${userId}`;
  const tradeKey = `thesis.trade.asked.${userId}`;

  // The service worker is always registered (it's what shows a push); Chrome's install event is kept for the button.
  useEffect(() => {
    registerServiceWorker();
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallEvent(e as BeforeInstallPrompt); };
    const onShow = () => setWhich("install");
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("thesis:install", onShow);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("thesis:install", onShow); };
  }, []);

  // Once per account: the install steps on a phone browser; the notifications ask once installed.
  useEffect(() => {
    if (!ready || !userId) return;
    let live = true;
    (async () => {
      // Once per account: trading from X and iMessage (limits for the session signer), unless it's on.
      if (!seen(tradeKey)) {
        const on = await fetch("/api/agent/grant", { headers: { "privy-token": await token() }, cache: "no-store" })
          .then((r) => r.json()).then((j: { grant?: { active?: boolean } | null }) => !!j.grant?.active).catch(() => true);
        if (!live) return;
        if (!on) return setWhich("trade");
        markSeen(tradeKey);
      }
      // Already allowed on this browser: save it for whoever just signed in, every time, so a browser
      // used by another account before moves to this one.
      if (pushSupported() && Notification.permission === "granted") {
        enablePush(token).catch(() => {});
        return;
      }
      if (isStandalone()) {
        if (!pushSupported()) return;
        if (Notification.permission === "default" && !seen(pushKey) && live) setWhich("push");
      } else if (isPhone() && !seen(installKey) && live) {
        setWhich("install");
      }
    })();
    return () => { live = false; };
  }, [ready, userId, installKey, pushKey, tradeKey, token]);

  if (which === "trade") return <TradeSheet onClose={() => { markSeen(tradeKey); setWhich(null); }} />;
  if (which === "install") return <InstallSheet event={installEvent} onClose={() => { markSeen(installKey); setWhich(null); }} />;
  if (which === "push") return <PushSheet onClose={() => { markSeen(pushKey); setWhich(null); }} />;
  return null;
}

const ShareGlyph = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="Share">
    <path d="M12 3v12M7 8l5-5 5 5M5 13v7h14v-7" />
  </svg>
);

/** Add to Home Screen, for the browser this is: Safari's toolbar, Chrome's address bar, Firefox's menu. */
function IOSSteps({ browser }: { browser: IOSBrowser }) {
  const share = <span className="kbd"><ShareGlyph /></span>;
  const first =
    browser === "chrome" ? <>Tap {share} at the right end of Chrome&apos;s address bar.</>
    : browser === "edge" ? <>Tap the menu (☰) at the bottom of Edge, then tap {share} <b>Share</b>.</>
    : browser === "firefox" ? <>Tap the menu (☰) in Firefox, then tap <b>Share</b>.</>
    : browser === "safari" ? <>Tap {share} in Safari&apos;s toolbar.</>
    : <>Tap {share} <b>Share</b> in your browser.</>;
  return (
    <ol className="install-steps">
      <li>{first}</li>
      <li>Scroll down and tap <b>Add to Home Screen</b>. (Not there? Open this page in Safari.)</li>
      <li>Tap <b>Add</b>, then open Thesis from your home screen.</li>
    </ol>
  );
}

/** Trade from X and iMessage: sets up the limits once (/limits), or not now. */
function TradeSheet({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  return (
    <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label="Trade from X and iMessage">
        <h3>Trade from X and iMessage</h3>
        <p className="muted">Reply to any post with @{X_BOT} back $20, text Thesis a take, or auto-copy traders. Thesis trades for you, only up to limits you set. Turn it off any time.</p>
        <button className="obtn filled" onClick={() => { onClose(); router.push("/limits"); }}>Set my limits</button>
        <button className="obtn plain" onClick={onClose}>Not now</button>
      </div>
    </div>
  );
}

function InstallSheet({ event, onClose }: { event: BeforeInstallPrompt | null; onClose: () => void }) {
  const ios = isIOS();
  async function install() {
    if (!event) return;
    await event.prompt();
    await event.userChoice.catch(() => null);
    onClose();
  }
  return (
    <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-labelledby="install-title">
        <button className="x" aria-label="Close" onClick={onClose}>×</button>
        <div className="install-icon" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/icon-192.png" alt="" />
        </div>
        <h3 id="install-title">Add Thesis to your home screen</h3>
        <p className="muted">It opens full screen like an app, and it can tell you when a take you&apos;re in moves.</p>
        {event ? (
          <button className="obtn filled" style={{ marginTop: 14 }} onClick={install}>Install</button>
        ) : ios ? (
          <IOSSteps browser={iosBrowser()} />
        ) : (
          <ol className="install-steps">
            <li>Open your browser&apos;s menu (⋮).</li>
            <li>Tap <b>Add to Home screen</b> or <b>Install app</b>.</li>
          </ol>
        )}
        <button className="obtn plain" onClick={onClose}>Not now</button>
      </div>
    </div>
  );
}

function PushSheet({ onClose }: { onClose: () => void }) {
  const { token } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function turnOn() {
    setBusy(true);
    setError(null);
    try {
      const r = await enablePush(token);
      if (r === "denied") setError("Notifications are off for Thesis. You can turn them on in your phone's settings.");
      else onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="sheet" role="dialog" aria-labelledby="push-title">
        <button className="x" aria-label="Close" onClick={onClose}>×</button>
        <h3 id="push-title">Turn on notifications?</h3>
        <p className="muted">Hear when someone trades or fades your take, when a take you&apos;re in settles, and when people you follow post.</p>
        {error ? <div className="err">{error}</div> : null}
        <button className="obtn filled" style={{ marginTop: 14 }} disabled={busy} onClick={turnOn}>{busy ? "One moment…" : "Turn on"}</button>
        <button className="obtn plain" disabled={busy} onClick={onClose}>Not now</button>
      </div>
    </div>
  );
}
