"use client";
// Your creator fees, as the iOS CreatorFeesSection: only on your own profile, only once something's
// been earned; the exact amounts in total and per take, with Claim all and a claim per take.
import { useState } from "react";
import { fork, type Built, type CreatorFees as Fees } from "@/lib/fork";

/** Fees are tiny (5 bps), so show them exactly, down to the cent's hundredths when needed. */
const exact = (x: number) => "$" + x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: x < 1 ? 4 : 2 });

export default function CreatorFees({ fees, address, signAndSubmit, onClaimed }: { fees: Fees; address: string; signAndSubmit: (b: Built) => Promise<string[]>; onClaimed: () => void }) {
  const [claiming, setClaiming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function claim(take: string | null) {
    setError(null);
    setClaiming(take ?? "all");
    try {
      const built = await fork<Built>("POST", `/wallets/${address}/creator-fees/claim`, { takes: take ? [take] : undefined });
      await signAndSubmit(built);
      onClaimed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't claim. Try again.");
    } finally {
      setClaiming(null);
    }
  }

  return (
    <section className="fees">
      <div className="fees-head">
        <div>
          <div style={{ fontWeight: 600 }}>Creator fees</div>
          <div className="muted small">{exact(fees.earnedUsd)} earned · {exact(fees.claimedUsd)} claimed</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="mono up" style={{ fontWeight: 600 }}>{exact(fees.unclaimedUsd)}</div>
          <div className="muted" style={{ fontSize: 11 }}>to claim</div>
        </div>
      </div>
      {fees.unclaimedUsd > 0 ? (
        <button className="obtn" style={{ height: 44, marginTop: 12 }} disabled={!!claiming} onClick={() => claim(null)}>
          {claiming === "all" ? "Claiming…" : "Claim all"}
        </button>
      ) : null}
      {error ? <div className="err">{error}</div> : null}
      {fees.takes.map((t) => (
        <div className="row" key={t.take}>
          <div style={{ minWidth: 0 }}>
            <div className="fee-claim">{t.claim ?? `Take ${t.take.slice(0, 4)}…${t.take.slice(-4)}`}</div>
            <div className="note">{exact(t.earnedUsd)} earned · {exact(t.claimedUsd)} claimed</div>
          </div>
          {t.unclaimedUsd > 0 ? (
            <button className="pill small" disabled={!!claiming} onClick={() => claim(t.take)}>
              {claiming === t.take ? "Claiming…" : `Claim ${exact(t.unclaimedUsd)}`}
            </button>
          ) : (
            <span className="muted small">Claimed</span>
          )}
        </div>
      ))}
    </section>
  );
}
