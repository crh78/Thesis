"use client";
// Phoenix on the web, as the iOS app: each leveraged leg's liquidation line (ForkReceiptView), and
// the Cash screen's "Cash out" card for money a sale (or a settled take) left on Phoenix.
import { useState } from "react";
import { money } from "@/lib/data";
import { cashOutPhoenix, liquidationText, useForkWallet, type PhoenixCash, type PhoenixRisk } from "@/lib/fork";

/**
 * "NVDA 3x long liquidates at $61.21 · 18% away" per Phoenix leg, warning-colored when it's near
 * (within 25%) or close (within 10%). `leverage` gives a leg's leverage where the caller knows it.
 */
export function LiquidationLines({ risks, leverage }: { risks: PhoenixRisk[] | undefined; leverage?: (leg: number) => number | null }) {
  if (!risks?.length) return null;
  return (
    <>
      {risks.map((r) => {
        const alarming = r.level !== "ok";
        const text = liquidationText(r, leverage?.(r.leg));
        return (
          <div key={r.leg} className={`note${r.level === "close" ? " down" : ""}`}
            style={alarming ? { fontWeight: 600, color: r.level === "close" ? undefined : "var(--text)" } : undefined}
            aria-label={alarming ? `Warning: ${text}` : text}>
            {alarming ? "⚠ " : ""}{text}
          </div>
        );
      })}
    </>
  );
}

/** Whether there's anything on Phoenix to cash out. */
export const hasPhoenixCash = (p: PhoenixCash | null | undefined): p is PhoenixCash => !!p && (p.cashUsd > 0.005 || p.openPositions > 0);

/** Money still on Phoenix: a sale's leveraged legs, or positions left open after a take ended. */
export function PhoenixCashCard({ address, phoenix, onDone }: { address: string; phoenix: PhoenixCash; onDone: () => void }) {
  const { signAndSubmit } = useForkWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cashOut() {
    setBusy(true);
    setError(null);
    try {
      await cashOutPhoenix(address, signAndSubmit);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't cash out. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="phx-card">
      <div style={{ fontWeight: 600 }}>{phoenix.openPositions > 0 ? "Leveraged positions still open" : "Cash from leveraged legs"}</div>
      <p className="muted small" style={{ margin: "4px 0 10px" }}>
        {phoenix.openPositions > 0
          ? `${phoenix.markets.join(", ")} kept moving after the take ended. Cash out to close and add it to your balance.`
          : `${money(phoenix.cashUsd)} is waiting to come back to your balance.`}
      </p>
      {error ? <div className="err">{error}</div> : null}
      <button className="obtn filled" style={{ height: 44 }} disabled={busy} onClick={cashOut}>{busy ? "Cashing out…" : "Cash out"}</button>
    </div>
  );
}
