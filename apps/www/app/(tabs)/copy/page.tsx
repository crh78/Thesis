"use client";
// Copy trading: everyone you copy (X accounts and Thesis traders), each one's auto-copy settings,
// and your recent auto-copies. Auto-copy trades for you when they make a call, within your
// trading-by-text limits (/limits): an X account's call becomes your own take (kept out of the
// feeds), a trader's new take is backed. Add X accounts in Copy from X (/x) or by replying
// "@yourthesisxyz copy" on X; add a trader from their profile.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import TopBar from "@/components/TopBar";
import Avatar from "@/components/Avatar";
import { X_BOT } from "@/lib/flags";
import { useCopies, type CopySettings, type CopyJob } from "@/lib/copies";

const AMOUNTS = [10, 20, 50, 100];
const DAILY = [1, 3, 5, 10];
const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 60 ? `${Math.max(m, 1)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

function Settings({ auto, amount, daily, onSave, onRemove }: { auto: boolean; amount: number; daily: number; onSave: (s: CopySettings) => void; onRemove: () => void }) {
  return (
    <div className="copy-settings">
      {auto ? (
        <p className="muted small">Only calls posted after you turned it on are copied.</p>
      ) : null}
      {auto ? (
        <>
          <div className="caps">Per call</div>
          <div className="chips">
            {AMOUNTS.map((n) => <button key={n} className={`chip${amount === n ? " on" : ""}`} onClick={() => onSave({ usd: n })}>{usd(n)}</button>)}
          </div>
          <div className="caps">Most a day</div>
          <div className="chips">
            {DAILY.map((n) => <button key={n} className={`chip${daily === n ? " on" : ""}`} onClick={() => onSave({ daily: n })}>{n}</button>)}
          </div>
        </>
      ) : null}
      <button className="set-row down" onClick={onRemove}><span>Stop copying</span></button>
    </div>
  );
}

function JobRow({ j, name }: { j: CopyJob; name: string }) {
  const body = j.status === "done" ? `${usd(j.usd)} on "${j.claim ?? "a take"}"` : j.reason ?? (j.status === "queued" || j.status === "running" ? "Placing it…" : "Couldn't place it.");
  const row = (
    <div className="copy-job">
      <span className={j.status === "done" ? "up" : j.status === "queued" || j.status === "running" ? "muted" : "down"}>
        {j.status === "done" ? "Copied" : j.status === "queued" || j.status === "running" ? "Pending" : "Skipped"}
      </span>
      <span className="copy-job-body"><b>{name}</b> {body}</span>
      <span className="muted small">{ago(j.at)}</span>
    </div>
  );
  return j.take_id ? <Link href={`/t/${j.take_id}`} className="copy-job-link">{row}</Link> : row;
}

export default function CopyPage() {
  const router = useRouter();
  const { copies, error, setX, removeX, setTrader, removeTrader } = useCopies();
  const [open, setOpen] = useState<string | null>(null);
  const traderName = (id: string | null) => copies?.traders.find((t) => t.trader_id === id)?.handle ?? "a trader";

  return (
    <main className="page">
      <TopBar />
      <h1 className="title">Copy trading</h1>
      <p className="muted">When someone you copy makes a call, Thesis puts money into it for you, up to your limits. Copies are yours to sell any time.</p>

      {copies && !copies.linked ? (
        <section className="set-sec">
          <div className="err">Auto-copy needs trading by text. <Link href="/limits">Turn it on</Link>.</div>
        </section>
      ) : null}
      {error ? <div className="err">{error}</div> : null}

      {!copies ? <p className="muted">Loading…</p> : (
        <>
          <section className="set-sec">
            <div className="caps">X accounts</div>
            {copies.x.length ? copies.x.map((c) => (
              <div key={c.handle} className="copy-item">
                <button className="copy-head" onClick={() => setOpen(open === `x:${c.handle}` ? null : `x:${c.handle}`)}>
                  {c.avatar_url
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={c.avatar_url} alt="" width={40} height={40} className="copy-avatar" />
                    : <span className="copy-avatar copy-letter">{c.handle.slice(0, 1).toUpperCase()}</span>}
                  <span className="copy-name"><b>{c.name || `@${c.username ?? c.handle}`}</b><span className="muted small">@{c.username ?? c.handle} on X</span></span>
                  <span className={c.auto ? "up small" : "muted small"}>{c.auto ? `Auto · ${usd(c.usd)} · ${c.daily}/day` : "Auto-copy off"}</span>
                </button>
                <input type="checkbox" className="switch copy-switch" checked={c.auto} aria-label={`Auto-copy @${c.username ?? c.handle}`}
                  onChange={() => (copies.linked || c.auto ? setX(c.handle, { auto: !c.auto }).catch(() => {}) : router.push("/limits"))} />
                {open === `x:${c.handle}` ? (
                  <Settings auto={c.auto} amount={c.usd} daily={c.daily} onSave={(s) => setX(c.handle, s).catch(() => {})} onRemove={() => removeX(c.handle).catch(() => {})} />
                ) : null}
              </div>
            )) : <p className="muted small">None yet.</p>}
            <Link href="/x" className="set-row"><span>Add an X account</span><span className="muted">›</span></Link>
            <p className="muted small">Or reply to any post with @{X_BOT} copy.</p>
          </section>

          <section className="set-sec">
            <div className="caps">Traders on Thesis</div>
            {copies.traders.length ? copies.traders.map((t) => (
              <div key={t.trader_id} className="copy-item">
                <button className="copy-head" onClick={() => setOpen(open === `t:${t.trader_id}` ? null : `t:${t.trader_id}`)}>
                  <Avatar person={{ handle: t.handle ?? null, avatar_url: t.avatar_url ?? null }} size={40} />
                  <span className="copy-name"><b>{t.display_name || `@${t.handle}`}</b><span className="muted small">@{t.handle}</span></span>
                  <span className={t.auto ? "up small" : "muted small"}>{t.auto ? `Auto · ${usd(t.usd)} · ${t.daily}/day` : "Auto-copy off"}</span>
                </button>
                <input type="checkbox" className="switch copy-switch" checked={t.auto} aria-label={`Auto-copy @${t.handle}`}
                  onChange={() => (copies.linked || t.auto ? setTrader(t.trader_id, { auto: !t.auto }).catch(() => {}) : router.push("/limits"))} />
                {open === `t:${t.trader_id}` ? (
                  <Settings auto={t.auto} amount={t.usd} daily={t.daily} onSave={(s) => setTrader(t.trader_id, s).catch(() => {})} onRemove={() => removeTrader(t.trader_id).catch(() => {})} />
                ) : null}
              </div>
            )) : <p className="muted small">Open someone&apos;s profile and tap Copy.</p>}
          </section>

          <section className="set-sec">
            <div className="caps">Recent copies</div>
            {copies.jobs.length
              ? copies.jobs.map((j) => <JobRow key={j.id} j={j} name={j.kind === "x_call" ? `@${j.handle}` : `@${traderName(j.trader_id)}`} />)
              : <p className="muted small">Nothing copied yet.</p>}
          </section>
        </>
      )}
    </main>
  );
}
