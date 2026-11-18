"use client";
// Trade or fade a take from the browser, the way the iOS app does in fork mode: the fork API builds
// the transactions, the user's Privy Solana wallet signs them (it never sends), and the API adds
// the app's fee payer and sends them. Sign-in is the app's (X, Google or email), so the same person
// gets the same wallet and Thesis profile as in the app; onboarding is drawn by SessionScreens.
//
// Fast trades (lib/trade.ts): the sheet builds as soon as it opens and again as the amount changes,
// so the tap only signs and sends. "You're in" shows once the fork has accepted the transactions;
// confirmation is watched in the background, and the rare trade that doesn't confirm is rolled back
// on screen ("That trade didn't go through").
import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { closedReason, legName, pct, takeState, usd, type Position, type Receipt } from "@/lib/data";
// The fork client adds the Privy token on money calls and handles "Sign in again".
import { cashOutPhoenix, centsInput, depositLeft, fork, ForkError, markTraded, stoppedTrade, stopwatch, submit, useForkWallet, type Built, type Incomplete, type PhoenixLeg, type PhoenixRisk, type Stopwatch, type WalletSummary } from "@/lib/fork";
import { pendingTrade, useEarlyBuild, watchSubmission, type PendingTrade, type Submission } from "@/lib/trade";
import { cardValue } from "@/lib/data";
import { X_LOGIN } from "@/lib/flags";
import { useSession } from "@/lib/session";
import { LiquidationLines } from "./Phoenix";
import SignIn from "./SignIn";
import StoppedTrade from "./StoppedTrade";

type Side = "back" | "fade";
/**
 * `incomplete`: a trade split over several transactions stopped partway (the fork API's `trade_incomplete`).
 * `sell` with `closing`: the exit build said it's the author's buy-in (`closesTake`), so the sheet
 * warns that selling closes the take before anything is signed (the build waits for the second tap).
 * `placed`: "You're in" (or "Sold"); `confirming` until the watch says it landed, `slow` when it
 * couldn't tell. `failed`: it was accepted but didn't confirm, so nothing happened.
 */
type Step =
  | { kind: "closed" }
  | { kind: "signin" }
  | { kind: "trade"; side: Side }
  | { kind: "sell"; position: Position; closing?: boolean }
  | { kind: "incomplete"; trade: Incomplete | null; retry: boolean }
  | { kind: "done"; text: string }
  | { kind: "placed"; buildId: string; sale: boolean; text: string; confirming: boolean; slow?: boolean }
  | { kind: "failed"; side: Side; usd: number | null }
  | { kind: "failed"; side: "sell"; position: Position | null };
/** The receipt's legs and positions also carry their Phoenix details (lib/fork.ts). */
type Leg = Receipt["legs"][number] & PhoenixLeg;
const phoenixOf = (p: Position) => (p as Position & { phoenix?: PhoenixRisk[] }).phoenix;

const CHIPS = [10, 20, 50, 100];
/** Typing an amount builds it once the typing stops for this long; a chip builds at once. */
const TYPING_MS = 500;

// Early builds are cached by what they'd buy: "back:2000" ($20), "fade:5000", "sell:<position>".
const tradeKey = (side: Side, usdAmount: number) => `${side}:${Math.round(usdAmount * 100)}`;
const saleKey = (position: string) => `sell:${position}`;

const SOLD = "Sold. The cash is back in your balance, and the position is scored at today's prices.";
const SOLD_PHOENIX = "Sold, and the position is scored at today's prices. Moving the cash from its leveraged legs back to your balance…";
const SOLD_STRANDED = "Sold, and the position is scored at today's prices. The cash from its leveraged legs is still on its way: tap Cash out on Me to move it to your balance.";
const CLOSED_NOTE = " Your take is closed now: no new trades, and its result is final.";

/**
 * `closed`: why the take can't be traded ("Closed: @jake sold"), when the server render already
 * knows it's closed; `handle` (the author's, null for a deleted account) words it when the receipt
 * here finds out later (the author sold while the page was open).
 */
export default function TradeDock({ takeId, author, handle = null, receipt: initial, closed = null }: { takeId: string; author: string; handle?: string | null; receipt: Receipt | null; closed?: string | null }) {
  const { ready, authenticated } = usePrivy();
  const { phase, snapshot, logout } = useSession();
  // The user's Privy (embedded) Solana wallet, the one the app also uses.
  const { address, wallet, sign, signAndSubmit } = useForkWallet();

  const [step, setStep] = useState<Step>({ kind: "closed" });
  const [pending, setPending] = useState<Side | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(initial);
  // Closed (its author sold, or it settled): no Trade or Fade, only this. The receipt read here
  // can find out after the server render did.
  const now = takeState(null, receipt);
  const closedText = now.open ? closed : closedReason(now, handle);
  // The receipt as this wallet sees it (canFade is false on your own take): a fade waits for it.
  const [viewerReceipt, setViewerReceipt] = useState(false);
  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const cash = summary?.usdc ?? null;
  const [config, setConfig] = useState({ feeRate: 0.001, minStakeUsd: 10 });
  const [amount, setAmount] = useState("20");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A sale sent and still confirming: its position shows "Selling…" instead of Sell.
  const [selling, setSelling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    const [w, r] = await Promise.all([
      fork<WalletSummary>("GET", `/wallets/${address}`).catch(() => null),
      fork<Receipt>("GET", `/takes/${takeId}?viewer=${address}`).catch(() => null),
    ]);
    if (w) setSummary(w);
    if (r) { setReceipt(r); setViewerReceipt(true); }
  }, [address, takeId]);

  useEffect(() => {
    fork<{ feeRate: number; minStakeUsd: number }>("GET", "/config").then(setConfig).catch(() => {});
  }, []);

  // Once signed in and set up, load the wallet's cash and positions.
  useEffect(() => {
    if (phase.kind === "ready" && address) refresh().catch(() => {});
  }, [phase.kind, address, refresh]);

  // Signing in with X or Google leaves the page and comes back: remember which button was tapped.
  const pendingKey = `thesis.pending.${takeId}`;
  // The feed's Trade / Fade pills link here with `?side=back|fade`: open that sheet straight away.
  useEffect(() => {
    const fromLink = new URLSearchParams(window.location.search).get("side");
    if (fromLink === "back" || fromLink === "fade") {
      window.history.replaceState(null, "", window.location.pathname);
      setPending(fromLink);
      return;
    }
    try {
      const saved = sessionStorage.getItem(pendingKey);
      if (saved === "back" || saved === "fade") setPending(saved);
    } catch { /* private mode */ }
  }, [pendingKey]);

  // Open whatever the user asked for once they're signed in and set up (onboarding comes first).
  useEffect(() => {
    if (!pending || phase.kind !== "ready" || !wallet) return;
    // A fade from a link opens only once the receipt for this viewer is in (the server's copy has no viewer).
    if (pending === "fade" && !viewerReceipt) return;
    // Only a side this take allows right now (a link can ask for one it doesn't, or the take closed).
    const allowed = !closedText && (pending === "back" ? (receipt?.canBack ?? true) : !!receipt?.canFade);
    if (allowed) setStep({ kind: "trade", side: pending });
    setPending(null);
    try { sessionStorage.removeItem(pendingKey); } catch { /* private mode */ }
  }, [pending, phase.kind, wallet, pendingKey, receipt, viewerReceipt, closedText]);

  const start = (side: Side, usdAmount = 20) => {
    setError(null);
    setAmount(String(usdAmount));
    setPending(side);
    if (!authenticated) {
      try { sessionStorage.setItem(pendingKey, side); } catch { /* private mode */ }
      setStep({ kind: "signin" });
    }
  };

  // ── Early builds ────────────────────────────────────────────────────────────────────────────
  const sheetOpen = step.kind === "trade" || step.kind === "sell";
  const early = useEarlyBuild({
    ready: sheetOpen && phase.kind === "ready" && !!wallet && !!address && !closedText,
    make: (key, prebuild) => {
      const [kind, rest] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      const flag = prebuild ? { prebuild: true } : {};
      if (kind === "sell") return fork<Built>("POST", `/takes/${takeId}/positions/${rest}/exit`, { owner: address, ...flag });
      return fork<Built>("POST", `/takes/${takeId}/trades`, { owner: address, side: kind, usd: Number(rest) / 100, ...flag });
    },
    // Never build behind a trade that's still confirming: wait for it first.
    beforeEarly: async () => {
      const p = address ? pendingTrade.get(address) : null;
      return !p || (await watchSubmission(p.buildId))?.status !== "incomplete";
    },
    // The author's own buy-in: the sheet warns that selling closes the take before the tap.
    onEarlyBuilt: (key, built) => {
      if (built.closesTake) setStep((s) => (s.kind === "sell" && saleKey(s.position.address) === key ? { ...s, closing: true } : s));
    },
  });
  // How long to wait before building the amount: 0 for the sheet opening or a chip, TYPING_MS
  // after a keystroke (set just before the amount changes).
  const buildDelay = useRef(0);
  const n = Number(amount) || 0;
  const affordable = cash != null && cash >= n + n * config.feeRate;
  const tradeSide = step.kind === "trade" ? step.side : null;
  const saleOf = step.kind === "sell" ? step.position.address : null;
  useEffect(() => {
    const delay = buildDelay.current;
    buildDelay.current = 0;
    if (tradeSide) early.want(n >= config.minStakeUsd && affordable ? tradeKey(tradeSide, n) : null, delay);
    else if (saleOf) early.want(saleKey(saleOf));
  }, [early, tradeSide, saleOf, n, affordable, config.minStakeUsd]);
  const typeAmount = (s: string) => { buildDelay.current = TYPING_MS; setAmount(s); };

  // ── Confirmation ────────────────────────────────────────────────────────────────────────────
  // The stopwatch of the trade on screen: "shown" is marked when "You're in" renders.
  const shownWatch = useRef<Stopwatch | null>(null);
  const onShown = useCallback(() => {
    const sw = shownWatch.current;
    shownWatch.current = null;
    if (!sw) return;
    sw.mark("shown");
    // Verbose level in the browser console: tap → "You're in", for checking on a phone.
    console.debug("[thesis] trade timings (ms since the tap)", sw.marks);
  }, []);

  /** A trade or sale that ended without landing (or stopped partway): say so, on any screen of the sheet. */
  const rolledBack = useCallback((p: Pick<PendingTrade, "kind" | "usd" | "position">, s: Submission | null) => {
    if (s?.status === "incomplete") {
      markTraded();
      return setStep({ kind: "incomplete", trade: s.incomplete ?? null, retry: s.incomplete?.next === "retry" });
    }
    if (p.kind === "sell") {
      const held = (receipt?.viewerPositions ?? []).find((x) => x.address === p.position) ?? null;
      return setStep({ kind: "failed", side: "sell", position: held });
    }
    setStep({ kind: "failed", side: p.kind, usd: p.usd });
  }, [receipt]);

  /**
   * Watches a trade the fork accepted until it confirms. Landed: "Confirming…" turns into
   * "Confirmed", and a sale with Phoenix legs moves their cash back. Failed or stopped: the sheet
   * says so. Then the trade's timings, with "shown" and how it ended, go to the fork API once more.
   */
  const confirm = useCallback(async (p: PendingTrade, extra: { built: Built; signed: string[]; sw: Stopwatch } | null) => {
    const s = await watchSubmission(p.buildId);
    pendingTrade.clear(p.buildId);
    if (p.kind === "sell") setSelling((x) => (x === p.position ? null : x));
    refresh().catch(() => {});
    if (extra) {
      extra.sw.mark(s?.status ?? "unknown");
      // Same build, same bytes: the API answers with its status and logs the timings with the build id.
      submit(p.buildId, extra.signed, { until: "accepted", timings: { ...extra.sw.marks }, keepalive: true }).catch(() => {});
    }
    if (s && s.status !== "landed") return rolledBack(p, s);
    markTraded();
    setStep((x) => (x.kind === "placed" && x.buildId === p.buildId ? { ...x, confirming: false, slow: !s } : x));
    if (s && extra?.built.phoenixCashOut) await cashOut(p.buildId, extra.built);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rolledBack]);

  // A sale with Phoenix legs closed them; their cash comes back to USDC in a second step (as iOS),
  // after the sale has landed. If that fails, it waits on Me with "Cash out".
  async function cashOut(buildId: string, built: Built) {
    let stranded = false;
    await cashOutPhoenix(address!, signAndSubmit).catch(() => { stranded = true; });
    refresh().catch(() => {});
    const text = (stranded ? SOLD_STRANDED : SOLD) + (built.closesTake ? CLOSED_NOTE : "");
    setStep((x) => (x.kind === "placed" && x.buildId === buildId ? { ...x, text } : x));
  }

  // A trade still confirming when the page was left or reloaded: watch it to the end here, and on
  // this take's page say so if it didn't go through.
  useEffect(() => {
    const p = address ? pendingTrade.get(address) : null;
    if (!p) return;
    let live = true;
    if (p.kind === "sell" && p.takeId === takeId) setSelling(p.position);
    watchSubmission(p.buildId).then((s) => {
      pendingTrade.clear(p.buildId);
      if (!live) return;
      setSelling(null);
      refresh().catch(() => {});
      if (s?.status === "landed") markTraded();
      else if (s && p.takeId === takeId) rolledBack(p, s);
    });
    return () => { live = false; };
    // Once per wallet and take: rolledBack changes with every receipt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, takeId]);

  /**
   * Before a new build at the tap: a trade still confirming is waited for. False when it stopped
   * partway: the sheet offers to finish it or swap it back first. One that failed left nothing
   * behind, so this trade goes ahead.
   */
  async function priorSettled(): Promise<boolean> {
    const p = address ? pendingTrade.get(address) : null;
    if (!p) return true;
    setBusy("Finishing your last trade…");
    const s = await watchSubmission(p.buildId);
    if (s?.status !== "incomplete") return true;
    rolledBack(p, s);
    return false;
  }

  /**
   * Sends a signed build and shows it as placed: right away when the fork has accepted it (then
   * watched to the end), or once it's confirmed with an older fork API that waits for that.
   */
  async function place(p: Omit<PendingTrade, "buildId" | "owner" | "at">, built: Built, signed: string[], sw: Stopwatch, text: string) {
    early.reset();
    sw.mark("submit");
    const sent = await submit(built.buildId, signed, { until: "accepted", timings: { ...sw.marks } });
    sw.mark("accepted");
    const pend: PendingTrade = { ...p, buildId: built.buildId, owner: address!, at: Date.now() };
    shownWatch.current = sw;
    setStep({ kind: "placed", buildId: built.buildId, sale: p.kind === "sell", text, confirming: sent.pending });
    if (p.kind === "sell") setSelling(p.position);
    if (sent.pending) {
      pendingTrade.set(pend);
      void confirm(pend, { built, signed, sw });
    } else {
      // Already confirmed (an older fork API).
      if (p.kind === "sell") setSelling(null);
      markTraded();
      refresh().catch(() => {});
      if (built.phoenixCashOut) void cashOut(built.buildId, built);
    }
  }

  async function trade(side: Side) {
    const usdAmount = Number(amount);
    if (!(usdAmount >= config.minStakeUsd)) return setError(`The minimum is $${config.minStakeUsd}.`);
    setError(null);
    const sw = stopwatch();
    try {
      setBusy(side === "back" ? "Trading…" : "Fading…");
      if (!(await priorSettled())) return;
      setBusy(side === "back" ? "Trading…" : "Fading…");
      const t = await early.take(tradeKey(side, usdAmount));
      sw.mark("built", t.at);
      const signed = await sign(t.built, sw);
      await place({ kind: side, takeId, usd: usdAmount, position: null }, t.built, signed, sw, `You ${side === "back" ? "traded" : "faded"} ${author}'s take with $${usdAmount}.`);
    } catch (e) {
      const stopped = stoppedTrade(e);
      if (stopped) {
        // Some legs were bought, the rest (and the receipt) weren't: finish it, or swap them back.
        markTraded();
        await refresh().catch(() => {});
        return setStep({ kind: "incomplete", ...stopped });
      }
      // The author sold while this was open: read the receipt again so the dock shows it's closed.
      if (e instanceof ForkError && e.code === "take_closed") await refresh().catch(() => {});
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function recovered(text: string) {
    markTraded();
    await refresh().catch(() => {});
    setStep({ kind: "done", text });
  }

  /**
   * Sell the whole position. The author's own buy-in closes the take (`closesTake` on the build):
   * the sheet shows that warning once the build says so (usually before the first tap, since the
   * sheet builds when it opens), and only the tap after the warning signs.
   */
  async function sell(position: Position, closing?: boolean) {
    setError(null);
    const sw = stopwatch();
    const key = saleKey(position.address);
    try {
      setBusy("Selling…");
      if (!(await priorSettled())) return;
      setBusy("Selling…");
      const t = await early.take(key);
      if (t.built.closesTake && !closing) {
        early.put(key, t);
        return setStep({ kind: "sell", position, closing: true });
      }
      sw.mark("built", t.at);
      const signed = await sign(t.built, sw);
      const text = (t.built.phoenixCashOut ? SOLD_PHOENIX : SOLD) + (t.built.closesTake ? CLOSED_NOTE : "");
      await place({ kind: "sell", takeId, usd: null, position: position.address }, t.built, signed, sw, text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function addCash(usdAmount: number) {
    if (!address) return;
    setError(null);
    try {
      setBusy("Adding cash…");
      setSummary(await fork<WalletSummary>("POST", `/wallets/${address}/deposits`, { usd: usdAmount }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const positions = (receipt?.viewerPositions ?? []).filter((p) => !p.exited);
  // A take not on the fork yet (a demo take, or after a fork reset) is put on-chain by its first trade.
  const canBack = receipt?.canBack ?? true;
  const canFade = !!receipt?.canFade;
  // The fork's own words when it can't trade this take at all (it says why, e.g. an earlier fork).
  const missing = !canBack ? (receipt?.missing ?? null) : null;
  const blockedLabel = missing ? "Can't be traded here" : "Can't trade right now";

  const ret = receipt?.returnBps != null ? receipt.returnBps / 100 : null;

  return (
    <>
      {receipt?.onChain ? (
        <div className="section">
          <h2>On-chain receipt <span className="caps">{receipt.status}</span></h2>
          <div className="stats">
            <div><span className="caps">Traders</span><b>{receipt.backers ?? 0}</b></div>
            <div><span className="caps">Faders</span><b>{receipt.faders ?? 0}</b></div>
            <div><span className="caps">Money in</span><b>{usd((receipt.totalBackedUsd ?? 0) + (receipt.totalFadedUsd ?? 0)).replace(".00", "")}</b></div>
            <div><span className="caps">Return</span><b className={(ret ?? 0) >= 0 ? "up" : "down"}>{pct(ret)}</b></div>
          </div>
        </div>
      ) : null}

      {authenticated && positions.length ? (
        <div className="section">
          <h2>Your positions</h2>
          {positions.map((p) => (
            <div className="row" key={p.address}>
              <div>
                <span className={p.side === "back" ? "up" : "down"}>{p.side === "back" ? "Traded" : "Faded"}</span> {usd(p.stakeUsd)}
                <div className="note">{p.pendingNote ? legName(p.pendingNote) : `Score ${pct(p.returnBps == null ? null : p.returnBps / 100)}`}</div>
                {/* Leveraged legs and fade shorts: where each one is liquidated, and how close it is. */}
                <LiquidationLines risks={phoenixOf(p)} leverage={(i) => (receipt?.legs.find((l) => l.index === i) as Leg | undefined)?.perp?.leverage ?? null} />
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="mono">{usd(p.valueUsd)}</div>
                {selling === p.address ? (
                  <div className="note">Selling…</div>
                ) : p.canExit ? (
                  <button className="pill small" style={{ marginTop: 6 }} onClick={() => { setError(null); setStep({ kind: "sell", position: p }); }}>Sell</button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {authenticated ? (
        <p className="small muted" style={{ marginTop: 20 }}>
          Signed in{snapshot?.profile.handle ? ` as @${snapshot.profile.handle}` : ""}
          {cash != null ? ` · cash ${usd(cash)}` : ""} ·{" "}
          <button className="small muted" style={{ textDecoration: "underline" }} onClick={() => logout()}>Log out</button>
        </p>
      ) : null}

      {missing ? <p className="small muted" style={{ marginTop: 20 }}>{missing}</p> : null}

      <div className="dock">
        <div className="dock-inner">
          {closedText ? (
            // Closed takes take no new trades or fades; positions in it can still be sold above.
            <div className="dock-closed" role="status">{closedText}</div>
          ) : (
            <>
              {canFade ? (
                <button className="btn fade" disabled={!ready} onClick={() => start("fade")}>Fade</button>
              ) : null}
              <button className="btn back" disabled={!ready || !canBack} onClick={() => start("back")}>
                {canBack ? "Trade this take" : blockedLabel}
              </button>
            </>
          )}
        </div>
      </div>

      {step.kind !== "closed" ? (
        <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && !busy && setStep({ kind: "closed" })}>
          {/* Any touch keeps the sheet's early build fresh (it stops after 3 minutes untouched). */}
          <div className="sheet" onPointerDown={early.touch}>
            <button className="x" aria-label="Close" disabled={!!busy} onClick={() => setStep({ kind: "closed" })}>×</button>
            {step.kind === "signin" ? (
              <>
                <h3>Sign in to trade</h3>
                <p className="muted small">{X_LOGIN ? "Your account works here and on X." : "One account for trading, posting and your scores."}</p>
                <div style={{ marginTop: 16 }}><SignIn /></div>
              </>
            ) : null}
            {step.kind === "trade" ? (
              <TradeSheet
                side={step.side}
                author={author}
                receipt={receipt}
                amount={amount}
                setAmount={setAmount}
                typeAmount={typeAmount}
                cash={cash}
                depositLeftUsd={depositLeft(summary).left}
                feeRate={config.feeRate}
                busy={busy}
                error={error}
                onAddCash={addCash}
                onConfirm={() => trade(step.side)}
              />
            ) : null}
            {step.kind === "sell" ? (
              <>
                <h3>{step.closing ? "Sell and close your take" : "Sell position"}</h3>
                <p className="muted">
                  Sells the whole position for fork USDC, including money held for prediction legs. It&apos;s scored at today&apos;s
                  prices and settles right away.
                </p>
                {step.closing ? (
                  // The author's own buy-in (the exit build's closesTake).
                  <p className="note">
                    Selling closes this take: no new trades, and its result is final at today&apos;s prices. Others keep their positions.
                  </p>
                ) : null}
                <div className="row"><span>Worth now</span><span className="mono">{usd(step.position.valueUsd)}</span></div>
                {error ? <div className="err">{error}</div> : null}
                <button className="btn light" style={{ width: "100%", marginTop: 16 }} disabled={!!busy} onClick={() => sell(step.position, step.closing)}>
                  {busy ?? (step.closing ? "Sell and close the take" : "Confirm full sale")}
                </button>
              </>
            ) : null}
            {step.kind === "incomplete" && address ? (
              <StoppedTrade address={address} trade={step.trade} retry={step.retry} signAndSubmit={signAndSubmit} onDone={recovered} />
            ) : null}
            {step.kind === "done" ? (
              <div style={{ textAlign: "center" }}>
                <div className="check">✓</div>
                <h3>Done</h3>
                <p className="muted">{step.text}</p>
                {cash != null ? <p className="mono">Cash {usd(cash)}</p> : null}
                <button className="btn ghost" style={{ width: "100%", marginTop: 12 }} onClick={() => setStep({ kind: "closed" })}>Back to the take</button>
              </div>
            ) : null}
            {step.kind === "placed" ? (
              <Placed key={step.buildId} sale={step.sale} text={step.text} confirming={step.confirming} slow={!!step.slow} cash={cash} onShown={onShown} onClose={() => setStep({ kind: "closed" })} />
            ) : null}
            {step.kind === "failed" ? (
              <div style={{ textAlign: "center" }}>
                <h3>{step.side === "sell" ? "That sale didn't go through." : "That trade didn't go through."}</h3>
                <p className="muted">{step.side === "sell" ? "You still hold the position." : "Nothing left your balance."}</p>
                {step.side === "sell" ? (
                  step.position ? (
                    <button className="btn light" style={{ width: "100%", marginTop: 12 }} onClick={() => { setError(null); setStep({ kind: "sell", position: step.position! }); }}>Try again</button>
                  ) : null
                ) : !closedText ? (
                  <button className={`btn ${step.side}`} style={{ width: "100%", marginTop: 12, flex: "none" }} onClick={() => start(step.side as Side, step.usd ?? 20)}>Try again</button>
                ) : null}
                <button className="btn ghost" style={{ width: "100%", marginTop: 8 }} onClick={() => setStep({ kind: "closed" })}>Back to the take</button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * "You're in" (or "Sold") as soon as the fork has accepted it, with "Confirming on-chain…" until it
 * lands. `onShown` runs once it's on screen: the trade's "shown" timing mark.
 */
function Placed(props: { sale: boolean; text: string; confirming: boolean; slow: boolean; cash: number | null; onShown: () => void; onClose: () => void }) {
  const { onShown } = props;
  useEffect(() => { onShown(); }, [onShown]);
  return (
    <div style={{ textAlign: "center" }}>
      <div className="check">✓</div>
      <h3>{props.sale ? "Sold" : "You're in"}</h3>
      <p className="small muted" role="status" style={{ marginTop: 0 }}>
        {props.confirming ? "Confirming on-chain…" : props.slow ? "Still confirming on-chain. Me shows it once it lands." : "Confirmed on-chain."}
      </p>
      <p className="muted">{props.text}</p>
      {/* The balance is read again once it lands: until then it would still show the cash before. */}
      {!props.confirming && props.cash != null ? <p className="mono">Cash {usd(props.cash)}</p> : null}
      <button className="btn ghost" style={{ width: "100%", marginTop: 12 }} onClick={props.onClose}>Back to the take</button>
    </div>
  );
}

function TradeSheet(props: {
  side: Side;
  author: string;
  receipt: Receipt | null;
  amount: string;
  /** A chip: built at once. */
  setAmount: (s: string) => void;
  /** Typed: built once the typing stops. */
  typeAmount: (s: string) => void;
  cash: number | null;
  /** How much more cash this wallet can add (the fork API's cap); Infinity without one. */
  depositLeftUsd: number;
  feeRate: number;
  busy: string | null;
  error: string | null;
  onAddCash: (usd: number) => void;
  onConfirm: () => void;
}) {
  const { side, receipt, amount, cash, feeRate, busy } = props;
  const n = Number(amount) || 0;
  const fee = n * feeRate;
  const legs: Leg[] = receipt?.legs ?? [];
  // Fading leaves out legs that can't be shorted: card legs always (docs/cards-plan.md), shown as excluded.
  const blockedFor = (l: Receipt["legs"][number]) =>
    side === "back" ? (l.tradable ? null : l.blocked ?? "not tradable") : (l.fadeBlocked ?? (l.card ? "Cards can't be faded" : null));
  const included = legs.filter((l) => !blockedFor(l));
  const totalWeight = included.reduce((s, l) => s + l.weightBps, 0) || 1;
  const short = cash != null && cash < n + fee;
  // Held on Phoenix: a back's perp legs (long, at the take's leverage), a fade's shorts (at the leg's own).
  const onPhoenix = (l: Leg) => (side === "back" ? !!l.perp : !!l.short);
  const leverageOf = (l: Leg) => l.perp?.leverage ?? 1;
  const anyPhoenix = included.some(onPhoenix);
  // "Add $100 cash", never more than the cap has left (cents, as the API takes them).
  const room = Math.floor(props.depositLeftUsd * 100) / 100;
  const add = Math.min(Math.max(100, Math.ceil(n + fee)), room);
  const stillShort = cash != null && cash + add < n + fee;

  return (
    <>
      <h3>{side === "back" ? `Trade ${props.author}'s take` : `Fade ${props.author}'s take`}</h3>
      <p className="muted small" style={{ margin: 0 }}>
        {side === "back" ? "You get the same basket at today's prices." : `You win if ${props.author} is wrong. Fades are public.`}
      </p>
      <div className="amount">
        $<input inputMode="decimal" value={amount} onChange={(e) => props.typeAmount(centsInput(e.target.value))} aria-label="Amount" />
      </div>
      <div className="chips">
        {CHIPS.map((c) => (
          <button key={c} className={`chip ${n === c ? "on" : ""} ${side}`} onClick={() => props.setAmount(String(c))}>${c}</button>
        ))}
      </div>
      <div className="caps" style={{ marginBottom: 6 }}>{side === "back" ? "What you're buying" : "What you're betting"}</div>
      {legs.map((l) => {
        const blocked = blockedFor(l);
        const pred = l.prediction;
        const heldSide = pred ? (side === "back" ? pred.side : pred.side === "yes" ? "no" : "yes") : null;
        const price = pred && heldSide ? pred.ask[heldSide] : null;
        return (
          <div className={`row ${blocked ? "out" : ""}`} key={l.index}>
            <div>
              <span className="name">{legName(l.name)}</span>
              {blocked ? <div className="note">{l.card && side === "fade" ? "Cards can't be faded" : blocked}</div>
                : heldSide ? <div className="note">{heldSide === "yes" ? "Yes" : "No"}{price != null ? ` · ${Math.round(price * 100)}¢` : ""}</div>
                : l.card ? <div className="note">{cardValue(l.card.insuredValueUsd)}</div>
                : onPhoenix(l) ? <div className="note">{leverageOf(l)}x {side === "back" ? "long" : "short"} on {side === "back" ? l.perp?.symbol : l.short}</div> : null}
            </div>
            <span className="mono">{blocked ? (side === "fade" ? "Excluded" : "Left out") : usd((n * l.weightBps) / totalWeight)}</span>
          </div>
        );
      })}
      <div className="row muted small"><span>Bought from your wallet · Thesis fee {(feeRate * 100).toFixed(2)}%</span><span className="mono">{usd(fee)}</span></div>
      {anyPhoenix ? (
        <p className="note">Leveraged legs can be liquidated if the market moves against them. Each one&apos;s liquidation price shows on your position, and you get an alert when one gets close.</p>
      ) : null}
      {props.error ? <div className="err">{props.error}</div> : null}
      {short && add >= 1 ? (
        <button className="btn ghost" style={{ width: "100%", marginTop: 12 }} disabled={!!busy} onClick={() => props.onAddCash(add)}>
          {busy === "Adding cash…" ? busy : `Add ${usd(add).replace(/\.00$/, "")} cash`}
        </button>
      ) : null}
      {short && (add < 1 || stillShort) ? (
        <p className="note">
          {add < 1 ? "You've added the most cash you can." : `You can add ${usd(add)} more, which isn't enough for this amount.`} Pick a smaller amount, or sell a position to free up cash.
        </p>
      ) : null}
      <button
        className={`btn ${side}`}
        style={{ width: "100%", marginTop: 12, flex: "none" }}
        disabled={!!busy || short || !included.length || n <= 0}
        onClick={props.onConfirm}
      >
        {busy && busy !== "Adding cash…" ? busy : `${side === "back" ? "Trade" : "Fade"} for $${n || 0}`}
      </button>
      <p className="small muted" style={{ textAlign: "center" }}>
        {cash != null ? `From your balance · ${usd(Math.max(0, cash - n - fee))} left` : "From your balance"}
      </p>
    </>
  );
}

