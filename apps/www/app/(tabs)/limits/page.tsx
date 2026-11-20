"use client";
// Trading by text: the spending limits you approve once so Thesis can trade for you when you text
// it in iMessage or reply to @yourthesisxyz on X (the `agent` function). Allowing adds Thesis's
// Privy session signer to your wallet; it can only trade within these limits (checked by the agent
// on every trade), and turning it off removes the signer. /limits?link=<token> comes from the
// iMessage bot: approving here connects that number to your account.
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSigners } from "@privy-io/react-auth";
import TopBar from "@/components/TopBar";
import { X_BOT } from "@/lib/flags";
import { useForkWallet } from "@/lib/fork";
import { useSession } from "@/lib/session";

type Grant = { per_trade_usd: number; daily_usd: number; left_usd: number; x_username: string | null; imessage: string | null; active: boolean };
type GrantReply = { grant: Grant | null; signer_id: string | null; policy_ids: string[] };

const PER_TRADE = [25, 50, 100, 250];
const DAILY = [100, 250, 500, 1000];
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

const ERRORS: Record<string, string> = {
  link_expired: "That link expired or was already used. Text Thesis again for a new one.",
  no_wallet: "Your wallet isn't ready yet. Try again in a moment.",
  signer_missing: "Thesis couldn't be added to your wallet. Try again.",
  signer_not_configured: "Trading by text isn't switched on yet.",
  invalid_limits: "Pick a daily limit at least as big as the per-trade limit.",
};

async function readError(r: Response): Promise<Error & { code?: string }> {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  const e = new Error(ERRORS[j.error ?? ""] ?? "Something went wrong. Try again.") as Error & { code?: string };
  e.code = j.error;
  return e;
}

function Limits() {
  const params = useSearchParams();
  const link = params.get("link");
  const { token } = useSession();
  const { address } = useForkWallet();
  const { addSigners, removeSigners } = useSigners();
  const [state, setState] = useState<GrantReply | null>(null);
  const [linkHandle, setLinkHandle] = useState<{ handle: string; expired: boolean } | null>(null);
  const [perTrade, setPerTrade] = useState(100);
  const [daily, setDaily] = useState(250);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const call = useCallback(async <T,>(method: string, body?: unknown): Promise<T> => {
    const r = await fetch("/api/agent/grant", {
      method,
      headers: { "privy-token": await token(), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!r.ok) throw await readError(r);
    return (await r.json()) as T;
  }, [token]);

  useEffect(() => {
    call<GrantReply>("GET").then((s) => {
      setState(s);
      if (s.grant) { setPerTrade(s.grant.per_trade_usd); setDaily(s.grant.daily_usd); }
    }).catch((e) => setError(e.message));
  }, [call]);

  useEffect(() => {
    if (!link) return;
    fetch(`/api/agent/links/${encodeURIComponent(link)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { handle: null, expired: true }))
      .then((j) => setLinkHandle({ handle: j.handle ?? "", expired: !!j.expired }))
      .catch(() => setLinkHandle({ handle: "", expired: true }));
  }, [link]);

  const active = !!state?.grant?.active;
  const useLink = link && linkHandle && !linkHandle.expired && !connected ? link : undefined;

  async function allow() {
    if (!state?.signer_id) return setError(ERRORS.signer_not_configured);
    if (!address) return setError(ERRORS.no_wallet);
    setBusy(true);
    setError(null);
    const body = { per_trade_usd: perTrade, daily_usd: Math.max(daily, perTrade), ...(useLink ? { link: useLink } : {}) };
    try {
      let r: { grant: Grant };
      try {
        // Already on the wallet (changing limits, or approved before): just save.
        r = await call<{ grant: Grant }>("PUT", body);
      } catch (e) {
        if ((e as { code?: string }).code !== "signer_missing") throw e;
        await addSigners({ address, signers: [{ signerId: state.signer_id, ...(state.policy_ids.length ? { policyIds: state.policy_ids } : {}) }] });
        r = await call<{ grant: Grant }>("PUT", body);
      }
      setState({ ...state, grant: r.grant });
      setEditing(false);
      if (useLink) setConnected(true);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't turn it on. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    if (!address || !state) return;
    setBusy(true);
    setError(null);
    try {
      // Stop the agent first, so nothing trades while the signer is being removed.
      await call("DELETE");
      await removeSigners({ address }).catch(() => {});
      setState({ ...state, grant: state.grant ? { ...state.grant, active: false } : null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const picker = (
    <>
      <div className="caps">Most per trade</div>
      <div className="chips">
        {PER_TRADE.map((n) => (
          <button key={n} className={`chip${perTrade === n ? " on" : ""}`} onClick={() => { setPerTrade(n); if (daily < n) setDaily(DAILY.find((d) => d >= n) ?? n); }}>{usd(n)}</button>
        ))}
      </div>
      <div className="caps">Most per day</div>
      <div className="chips">
        {DAILY.map((n) => (
          <button key={n} className={`chip${daily === n ? " on" : ""}`} disabled={n < perTrade} onClick={() => setDaily(n)}>{usd(n)}</button>
        ))}
      </div>
    </>
  );

  return (
    <main className="page">
      <TopBar />
      <h1 className="title">Trading by text</h1>

      {link && linkHandle ? (
        <section className="set-sec">
          {linkHandle.expired && !connected ? (
            <div className="err">{ERRORS.link_expired}</div>
          ) : connected ? (
            <p>Connected your iMessage {linkHandle.handle}. Go back to Messages and text your trade.</p>
          ) : (
            <p>Connect your iMessage {linkHandle.handle} so Thesis can trade when you text it.</p>
          )}
        </section>
      ) : null}

      <section className="set-sec">
        <p className="muted">
          Thesis trades for you when you text it (&quot;I&apos;m in for $50 on Jake&apos;s take&quot;) or reply to a post with
          @{X_BOT} back $20. Only up to these limits; anything bigger sends you a link to do it yourself. Turn it off any time.
        </p>
      </section>

      {!state ? (
        error ? <div className="err">{error}</div> : <p className="muted">Loading…</p>
      ) : active && !editing && !useLink ? (
        <section className="set-sec">
          <div className="caps">On</div>
          <div className="set-row"><span>Most per trade</span><span className="muted">{usd(state.grant!.per_trade_usd)}</span></div>
          <div className="set-row"><span>Most per day</span><span className="muted">{usd(state.grant!.daily_usd)}</span></div>
          <div className="set-row"><span>Left today</span><span className="muted">{usd(state.grant!.left_usd)}</span></div>
          <div className="set-row"><span>X</span><span className="muted">{state.grant!.x_username ? `@${state.grant!.x_username}` : "Not connected"}</span></div>
          <div className="set-row"><span>iMessage</span><span className="muted">{state.grant!.imessage ? `…${state.grant!.imessage.slice(-4)}` : "Text Thesis to connect"}</span></div>
          {!state.grant!.x_username ? <p className="muted small">Connect X in <Link href="/settings">Settings</Link> to trade from replies on X.</p> : null}
          {error ? <div className="err">{error}</div> : null}
          <button className="obtn filled" disabled={busy} onClick={() => setEditing(true)}>Change limits</button>
          <button className="obtn plain" disabled={busy} onClick={turnOff}>{busy ? "Turning off…" : "Turn off"}</button>
        </section>
      ) : (
        <section className="set-sec">
          {picker}
          {error ? <div className="err">{error}</div> : null}
          <button className="obtn filled" disabled={busy || !address} onClick={allow}>
            {busy ? "Saving…" : useLink ? (active ? "Connect" : "Allow and connect") : active ? "Save limits" : "Allow"}
          </button>
          {editing ? <button className="obtn plain" disabled={busy} onClick={() => setEditing(false)}>Cancel</button> : null}
          <p className="muted small">It&apos;s play money for now. Sales by text don&apos;t count against the limits.</p>
        </section>
      )}
    </main>
  );
}

export default function LimitsPage() {
  // useSearchParams needs a Suspense boundary for the static build.
  return <Suspense fallback={null}><Limits /></Suspense>;
}
