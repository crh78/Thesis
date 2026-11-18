"use client";
// A split trade that stopped partway (the fork API's `trade_incomplete`): part of it landed, so the
// wallet holds tokens that aren't in a position. The owner's decision: retry once ("Finish the
// trade"), and if that fails, sweep them back to USDC ("Swap the leftover back to cash"). Drawn in
// TradeDock's sheet right after a trade stops, and as a card on Me (GET /wallets/:w/incomplete),
// so it can be finished after a reload or on another device.
import { useState } from "react";
import { usd } from "@/lib/data";
import { ForkError, retryTrade, sweepToCash, type Built, type Incomplete, type Recovery } from "@/lib/fork";

const DONE: Record<Recovery, string> = {
  complete: "Done: the trade went through.",
  swept: "The leftover is back in your balance as cash.",
  partial: "Most of the leftover is back in your balance as cash. If any is left, Me shows it with the same button.",
  nothing: "Nothing was left to swap: it's already back in your balance.",
  gone: "Nothing left to do: this trade was already cleared up.",
};

export default function StoppedTrade(props: {
  address: string;
  trade: Incomplete | null;
  /** Whether its one retry is left (the refusal's `retry`, or `next === "retry"` on Me). */
  retry: boolean;
  signAndSubmit: (b: Built) => Promise<string[]>;
  /** Called once it's sorted out, with what to tell the user. */
  onDone: (text: string, outcome: Recovery) => void;
  /** Me's card: a smaller title, no sheet chrome. */
  card?: boolean;
}) {
  const { address, trade, signAndSubmit, onDone } = props;
  const position = trade?.position ?? null;
  const [canRetry, setCanRetry] = useState(props.retry);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, work: () => Promise<Recovery>) {
    setBusy(label);
    setError(null);
    try {
      const outcome = await work();
      onDone(DONE[outcome], outcome);
    } catch (e) {
      // Only the sweep is left: a retry already used, one that can't be built, or one that stopped again.
      if (e instanceof ForkError && e.data?.retry === false) {
        setCanRetry(false);
        setError("Finishing it didn't work. Swap the leftover back to cash instead.");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(null);
    }
  }

  const finish = () => run("Finishing the trade…", () => retryTrade(address, position, signAndSubmit));
  const sweep = () => run("Swapping back to cash…", () => sweepToCash(address, position, signAndSubmit));
  const what = trade ? `Your ${usd(trade.usd).replace(/\.00$/, "")} ${trade.side === "fade" ? "fade" : "trade"}` : "Your trade";

  return (
    <>
      {props.card ? <div style={{ fontWeight: 600 }}>{what} didn&apos;t finish</div> : <h3>The trade didn&apos;t finish</h3>}
      <p className={props.card ? "muted small" : "muted"} style={props.card ? { margin: "4px 0 10px" } : undefined}>
        Part of it went through and the rest didn&apos;t, so some of your cash is in tokens that aren&apos;t in a position yet.
        {canRetry ? " Finish the trade, or swap them back to cash." : " Swap them back to have it as cash again."}
      </p>
      {error ? <div className="err">{error}</div> : null}
      {canRetry ? (
        <button className={props.card ? "obtn filled" : "btn light"} style={props.card ? { height: 44 } : { width: "100%", marginTop: 16 }} disabled={!!busy} onClick={finish}>
          {busy === "Finishing the trade…" ? busy : "Finish the trade"}
        </button>
      ) : null}
      <button
        className={canRetry ? (props.card ? "obtn" : "btn ghost") : props.card ? "obtn filled" : "btn light"}
        style={props.card ? { height: 44, marginTop: canRetry ? 8 : 0 } : { width: "100%", marginTop: canRetry ? 8 : 16 }}
        disabled={!!busy}
        onClick={sweep}
      >
        {busy === "Swapping back to cash…" ? busy : "Swap the leftover back to cash"}
      </button>
    </>
  );
}
