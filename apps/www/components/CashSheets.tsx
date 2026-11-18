"use client";
// Cash, as the iOS app's fork mode: Add cash is a deposit of the fork's dollars, up to the
// play-money cap ($1,000 per wallet, ever; withdrawals are off on the public fork). The
// activity list is the wallet's history from the fork API.
import { useState } from "react";
import { depositLeft, fork, type Activity, type WalletSummary } from "@/lib/fork";
import { money, shortDate } from "@/lib/data";

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label={title}>
        <button className="x" aria-label="Close" onClick={onClose}>×</button>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** "$850 of $1,000 left to add", with a bar: how much play money this wallet can still add. */
export function CapLine({ summary }: { summary: WalletSummary | null }) {
  const { cap, left } = depositLeft(summary);
  return (
    <div className="cap-line">
      <div className="cap-bar" aria-hidden><span style={{ width: `${Math.min(100, ((cap - left) / cap) * 100)}%` }} /></div>
      <div className="small"><b className="mono">{money(left).replace(/\.00$/, "")}</b> <span className="muted">of {money(cap).replace(/\.00$/, "")} left to add</span></div>
    </div>
  );
}

/** Add cash tapped before this account has its wallet (Privy creates it at sign-in; a reload retries). */
export function WalletPending({ onClose }: { onClose: () => void }) {
  return (
    <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-labelledby="wallet-pending-title">
        <button className="x" aria-label="Close" onClick={onClose}>×</button>
        <h3 id="wallet-pending-title">Setting up your account</h3>
        <p className="muted">Your Thesis balance is still being set up. Reload the page in a moment, then add cash.</p>
        <button className="obtn filled" style={{ marginTop: 14 }} onClick={() => window.location.reload()}>Reload</button>
        <button className="obtn plain" onClick={onClose}>Not now</button>
      </div>
    </div>
  );
}

export function AddCash({ address, summary, onClose, onDone }: { address: string; summary: WalletSummary | null; onClose: () => void; onDone: (s: WalletSummary) => void }) {
  const { left } = depositLeft(summary);
  const chips = [50, 100, 250, 500].filter((c) => c <= left);
  const [amount, setAmount] = useState(Math.min(100, Math.floor(left)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<WalletSummary | null>(null);
  const tooMuch = amount > left + 0.004;

  async function go() {
    setError(null);
    setBusy(true);
    try {
      const s = await fork<WalletSummary>("POST", `/wallets/${address}/deposits`, { usd: amount });
      setDone(s);
      onDone(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Sheet title={`${money(amount, true)} added`} onClose={onClose}>
        <div className="row"><span className="muted">New balance</span><span className="mono">{money(done.usdc)}</span></div>
        <CapLine summary={done} />
        <button className="obtn filled" style={{ marginTop: 16 }} onClick={onClose}>Done</button>
      </Sheet>
    );
  }

  if (left < 1) {
    return (
      <Sheet title="Add cash" onClose={onClose}>
        <CapLine summary={summary} />
        <p className="muted">You&apos;ve added the most you can. Selling a position puts its cash back in your balance.</p>
        <button className="obtn filled" style={{ marginTop: 8 }} onClick={onClose}>OK</button>
      </Sheet>
    );
  }

  return (
    <Sheet title="Add cash" onClose={onClose}>
      <CapLine summary={summary} />
      <div className="amount">
        <span>$</span>
        <input inputMode="decimal" aria-label="Amount" value={amount || ""} onChange={(e) => setAmount(Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)} />
      </div>
      <div className="chips">
        {chips.map((c) => (
          <button key={c} className={`chip${amount === c ? " on" : ""}`} onClick={() => setAmount(c)}>${c}</button>
        ))}
        <button className={`chip${amount === Math.floor(left) ? " on" : ""}`} onClick={() => setAmount(Math.floor(left))}>Max</button>
      </div>
      {tooMuch ? <div className="err">You can add up to {money(left)} more.</div> : null}
      {error ? <div className="err">{error}</div> : null}
      <button className="obtn filled" disabled={busy || amount <= 0 || tooMuch} onClick={go}>
        {busy ? "Adding…" : `Add ${money(amount)}`}
      </button>
      <p className="muted small" style={{ textAlign: "center" }}>No fee</p>
    </Sheet>
  );
}

const ACTIVITY: Record<string, string> = { deposit: "Added cash", withdrawal: "Withdrew", back: "Traded", fade: "Faded", exit: "Sold", sale: "Sold", fee: "Fee", claim: "Creator fees" };

export function CashActivity({ balance, activity, onClose }: { balance: number; activity: Activity[]; onClose: () => void }) {
  return (
    <Sheet title="Cash" onClose={onClose}>
      <div className="muted small">Cash balance</div>
      <div className="big" style={{ marginTop: 4 }}>{money(balance)}</div>
      <div className="caps" style={{ marginTop: 18 }}>Activity</div>
      {activity.length === 0 ? <p className="muted small">Deposits, withdrawals, trades and fades show up here.</p> : null}
      {activity.map((a, i) => {
        const inflow = a.kind === "deposit" || a.kind === "exit" || a.kind === "sale" || a.kind === "claim";
        return (
          <div className="row" key={`${a.at}-${i}`}>
            <div>
              <div style={{ fontWeight: 600 }}>{ACTIVITY[a.kind] ?? a.kind.replace(/_/g, " ")}</div>
              <div className="note">{shortDate(a.at)}</div>
            </div>
            <span className={`mono ${inflow ? "up" : ""}`}>{inflow ? "+" : "−"}{money(Math.abs(a.usd))}</span>
          </div>
        );
      })}
    </Sheet>
  );
}
