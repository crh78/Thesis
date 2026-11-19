"use client";
// Selling all of a holding from Me: swipe a position left (touch or mouse) or tap its red arrow,
// confirm "Sell all of your $X position in …?", and it sells through the fork API's holding route
// (`POST /takes/:id/sell`, bps 10,000) with the same flow as the take page's trades: built while the
// question is up, signed on the tap, "Sold" once the fork accepted it, confirmed in the background,
// and said so if it didn't go through. An older fork API without the holding route sells each of
// the holding's positions whole (`/positions/:pos/exit`), as before (lib/sell.ts).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { money } from "@/lib/data";
import { cashOutPhoenix, fork, ForkError, markTraded, stopwatch, submit, useForkWallet, type Built, type PortfolioPosition } from "@/lib/fork";
import { ALL_BPS, exitKey, holdingKey, missingRoute, parseSaleKey, saleBody, saleRefusal } from "@/lib/sell";
import { pendingTrade, useEarlyBuild, watchSubmission, type PendingTrade } from "@/lib/trade";

const CLOSED_NOTE = " Your take is closed now: no new trades, and its result is final.";
const soldText = (b: Built, cash: "back" | "moving" | "stranded") =>
  "Sold, and the position is scored at today's prices." +
  (cash === "back" ? " The cash is back in your balance."
    : cash === "moving" ? " Moving the cash from its leveraged legs back to your balance…"
    : " The cash from its leveraged legs is still on its way: tap Cash out here to move it to your balance.") +
  (b.closesTake ? CLOSED_NOTE : "");

type Step =
  | { kind: "ask"; closing: boolean }
  | { kind: "placed"; buildId: string; confirming: boolean; slow?: boolean; text: string }
  | { kind: "failed" }
  | { kind: "stopped" };

/** The holding's worth now (its cost basis while a price is missing). */
export const holdingWorth = (h: PortfolioPosition) => h.valueUsd ?? h.remainingStakeUsd ?? h.stakeUsd;

/**
 * The "Sell all?" sheet for one holding. `onPlaced` once the fork accepted the sale (Me shows the
 * holding as "Selling…"), `onSettled` once it ended either way.
 */
export function SellAllSheet({ holding, onClose, onPlaced, onSettled }: {
  holding: PortfolioPosition;
  onClose: () => void;
  onPlaced: (p: PendingTrade) => void;
  onSettled: (p: PendingTrade) => void;
}) {
  const { address, wallet, sign, signAndSubmit } = useForkWallet();
  const members = holding.members ?? [holding.address];
  // An older fork API: no sale fields on its positions, or no holding route.
  const [legacy, setLegacy] = useState(holding.remainingStakeUsd == null);
  // All of the author's buy-in closes the take: asked up front when the position says so.
  const [step, setStep] = useState<Step>({ kind: "ask", closing: !!holding.closesTakeIfSoldAll });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = legacy ? exitKey(members[0]) : holdingKey(holding.side, { bps: ALL_BPS });
  const many = legacy && members.length > 1;

  const exitBuild = (position: string, prebuild: boolean) =>
    fork<Built>("POST", `/takes/${holding.takeId}/positions/${position}/exit`, { owner: address, ...(prebuild ? { prebuild: true } : {}) });

  const early = useEarlyBuild({
    ready: step.kind === "ask" && !!wallet && !!address && !many,
    make: async (k, prebuild) => {
      const sale = parseSaleKey(k);
      if (sale?.kind === "exit") return exitBuild(sale.position, prebuild);
      if (!sale) throw new Error(`Unknown sale ${k}`);
      try {
        return await fork<Built>("POST", `/takes/${holding.takeId}/sell`, saleBody(sale, address!, prebuild));
      } catch (e) {
        // No holding route: an older fork API. Sell the position whole instead (or each of them, on the tap).
        if (!missingRoute(e)) throw e;
        setLegacy(true);
        if (members.length > 1) throw new ForkError("no_partial_sales", "Try again: this sells each of these positions in turn.");
        return exitBuild(members[0], prebuild);
      }
    },
    beforeEarly: async () => {
      const p = address ? pendingTrade.get(address) : null;
      return !p || (await watchSubmission(p.buildId))?.status !== "incomplete";
    },
    onEarlyBuilt: (_k, built) => {
      if (built.closesTake) setStep((s) => (s.kind === "ask" ? { ...s, closing: true } : s));
    },
  });
  useEffect(() => {
    if (step.kind === "ask" && !many) early.want(key);
  }, [early, key, step.kind, many]);

  async function cashOut(buildId: string, built: Built) {
    let stranded = false;
    await cashOutPhoenix(address!, signAndSubmit).catch(() => { stranded = true; });
    markTraded();
    setStep((s) => (s.kind === "placed" && s.buildId === buildId ? { ...s, text: soldText(built, stranded ? "stranded" : "back") } : s));
  }

  /** Watches an accepted sale to the end: confirmed, or said so when it didn't go through. */
  async function watch(p: PendingTrade, built: Built) {
    const s = await watchSubmission(p.buildId);
    pendingTrade.clear(p.buildId);
    onSettled(p);
    markTraded();
    if (s?.status === "incomplete") return setStep({ kind: "stopped" });
    if (s && s.status !== "landed") return setStep({ kind: "failed" });
    setStep((x) => (x.kind === "placed" && x.buildId === p.buildId ? { ...x, confirming: false, slow: !s } : x));
    if (s && built.phoenixCashOut) await cashOut(p.buildId, built);
  }

  /** An older fork API with several positions in the holding: each sold whole, one after another. */
  async function sellEach() {
    let phoenix = false;
    let last: Built | null = null;
    for (const position of members) {
      last = await exitBuild(position, false);
      phoenix ||= !!last.phoenixCashOut;
      await signAndSubmit(last);
    }
    markTraded();
    const done = { ...last!, phoenixCashOut: phoenix };
    setStep({ kind: "placed", buildId: done.buildId, confirming: false, text: soldText(done, phoenix ? "moving" : "back") });
    if (phoenix) await cashOut(done.buildId, done);
  }

  async function confirm() {
    if (!address || step.kind !== "ask") return;
    const warned = step.closing;
    setError(null);
    const sw = stopwatch();
    try {
      setBusy("Selling…");
      // Never sell behind a trade that's still confirming: wait for it first.
      const prior = pendingTrade.get(address);
      if (prior && (await watchSubmission(prior.buildId))?.status === "incomplete") {
        markTraded();
        return setStep({ kind: "stopped" });
      }
      if (many) return await sellEach();
      const t = await early.take(key);
      if (t.built.closesTake && !warned) {
        early.put(key, t);
        return setStep({ kind: "ask", closing: true });
      }
      sw.mark("built", t.at);
      const signed = await sign(t.built, sw);
      early.reset();
      sw.mark("submit");
      const sent = await submit(t.built.buildId, signed, { until: "accepted", timings: { ...sw.marks } });
      const p: PendingTrade = { buildId: t.built.buildId, owner: address, takeId: holding.takeId, kind: "sell", usd: null, position: legacy ? members[0] : null, side: holding.side, at: Date.now() };
      setStep({ kind: "placed", buildId: p.buildId, confirming: sent.pending, text: soldText(t.built, t.built.phoenixCashOut ? "moving" : "back") });
      onPlaced(p);
      if (sent.pending) {
        pendingTrade.set(p);
        void watch(p, t.built);
      } else {
        // Already confirmed (an older fork API).
        onSettled(p);
        markTraded();
        if (t.built.phoenixCashOut) void cashOut(p.buildId, t.built);
      }
    } catch (e) {
      setError(saleRefusal(e).text);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="sheet" onPointerDown={early.touch} role="dialog" aria-modal="true" aria-label="Sell all">
        <button className="x" aria-label="Close" disabled={!!busy} onClick={onClose}>×</button>
        {step.kind === "ask" ? (
          <>
            <h3>{step.closing ? "Sell and close your take?" : "Sell all?"}</h3>
            <p className="muted">Sell all of your {money(holdingWorth(holding))} position in “{holding.claim}”?</p>
            <p className="muted small">It&apos;s scored at today&apos;s prices, and money held for prediction legs comes back with it. No fee.</p>
            {step.closing ? (
              <p className="note">Selling all of it closes this take: no new trades, and its result is final at today&apos;s prices. Others keep their positions.</p>
            ) : null}
            {error ? <div className="err">{error}</div> : null}
            <button className="btn light" style={{ width: "100%", marginTop: 16 }} disabled={!!busy} onClick={confirm}>
              {busy ?? (step.closing ? "Sell all and close the take" : "Sell all")}
            </button>
            <button className="btn ghost" style={{ width: "100%", marginTop: 8 }} disabled={!!busy} onClick={onClose}>Cancel</button>
          </>
        ) : null}
        {step.kind === "placed" ? (
          <div style={{ textAlign: "center" }}>
            <div className="check">✓</div>
            <h3>Sold</h3>
            <p className="small muted" role="status" style={{ marginTop: 0 }}>
              {step.confirming ? "Confirming on-chain…" : step.slow ? "Still confirming on-chain. It shows here once it lands." : "Confirmed on-chain."}
            </p>
            <p className="muted">{step.text}</p>
            <button className="btn ghost" style={{ width: "100%", marginTop: 12 }} onClick={onClose}>Done</button>
          </div>
        ) : null}
        {step.kind === "failed" ? (
          <div style={{ textAlign: "center" }}>
            <h3>That sale didn&apos;t go through.</h3>
            <p className="muted">You still hold the position.</p>
            <button className="btn light" style={{ width: "100%", marginTop: 12 }} onClick={() => { setError(null); setStep({ kind: "ask", closing: !!holding.closesTakeIfSoldAll }); }}>Try again</button>
            <button className="btn ghost" style={{ width: "100%", marginTop: 8 }} onClick={onClose}>Close</button>
          </div>
        ) : null}
        {step.kind === "stopped" ? (
          <div style={{ textAlign: "center" }}>
            <h3>Your last trade stopped partway.</h3>
            <p className="muted">Finish it or swap it back to cash on this page first, then sell.</p>
            <button className="btn ghost" style={{ width: "100%", marginTop: 12 }} onClick={onClose}>Close</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** How far a row moves before letting go sells, and how far it can be pulled. */
const SWIPE_AT = 72;
const SWIPE_MAX = 140;

/**
 * A row that swipes left to sell, with pointer events so touch and a mouse both work; vertical
 * moves still scroll the page (touch-action: pan-y). A swipe never also opens the row's link. The
 * red left-arrow (`arrowLabel`) does the same with a tap or the keyboard.
 */
export function SwipeRow({ onSell, disabled, arrowLabel, children }: { onSell: () => void; disabled?: boolean; arrowLabel: string; children: ReactNode }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; horizontal: boolean | null; dx: number } | null>(null);
  const swallowClick = useRef(false);

  const end = (sell: boolean) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    setDx(0);
    if (d?.horizontal) swallowClick.current = true;
    if (sell) onSell();
  };

  return (
    <div className="swipe">
      {dx < 0 ? <div className="swipe-under" aria-hidden>Sell all</div> : null}
      <div
        className="swipe-row"
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dragging ? "none" : "transform 0.2s ease" }}
        onPointerDown={(e) => {
          if (disabled || (e.pointerType === "mouse" && e.button !== 0)) return;
          swallowClick.current = false;
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, horizontal: null, dx: 0 };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          const mx = e.clientX - d.x;
          const my = e.clientY - d.y;
          if (d.horizontal == null) {
            if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
            d.horizontal = Math.abs(mx) > Math.abs(my);
            if (!d.horizontal) { drag.current = null; return; }
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
          }
          d.dx = Math.max(-SWIPE_MAX, Math.min(0, mx));
          setDx(d.dx);
        }}
        onPointerUp={(e) => { if (drag.current?.id === e.pointerId) end(!!drag.current.horizontal && drag.current.dx <= -SWIPE_AT); }}
        onPointerCancel={() => end(false)}
        onLostPointerCapture={() => { if (drag.current?.horizontal) end(false); }}
        // A drag isn't a tap: the link under it doesn't open, and links and images don't start a native drag.
        onClickCapture={(e) => { if (swallowClick.current) { e.preventDefault(); e.stopPropagation(); swallowClick.current = false; } }}
        onDragStart={(e) => e.preventDefault()}
      >
        {children}
        {disabled ? null : (
          <button type="button" className="sell-arrow" aria-label={arrowLabel} title="Sell all" onClick={onSell}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5" /><path d="m11 6-6 6 6 6" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}
