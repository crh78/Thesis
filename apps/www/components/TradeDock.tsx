"use client";
// Trade or fade a take from the browser, the way the iOS app does in fork mode: the fork API builds
// the transactions, the user's Privy Solana wallet signs them (it never sends), and the API adds
// the app's fee payer and sends them. Sign-in is the app's (X, Google or email), so the same person
// gets the same wallet and Thesis profile as in the app; onboarding is drawn by SessionScreens.
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { closedReason, legName, pct, takeState, usd, type Position, type Receipt } from "@/lib/data";
// The fork client adds the Privy token on money calls and handles "Sign in again".
import { cashOutPhoenix, centsInput, depositLeft, fork, ForkError, markTraded, stoppedTrade, type Built, type Incomplete, type PhoenixLeg, type PhoenixRisk, type WalletSummary } from "@/lib/fork";
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
 * warns that selling closes the take before anything is signed; `built` is that build, kept to sign
 * on the second tap (null once it's been used or failed, and the next tap builds again).
 */
type Step = { kind: "closed" } | { kind: "signin" } | { kind: "trade"; side: Side } | { kind: "sell"; position: Position; closing?: { built: Built | null } } | { kind: "incomplete"; trade: Incomplete | null; retry: boolean } | { kind: "done"; text: string };
/** The receipt's legs and positions also carry their Phoenix details (lib/fork.ts). */
type Leg = Receipt["legs"][number] & PhoenixLeg;
const phoenixOf = (p: Position) => (p as Position & { phoenix?: PhoenixRisk[] }).phoenix;

const CHIPS = [10, 20, 50, 100];

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/**
 * `closed`: why the take can't be traded ("Closed: @jake sold"), when the server render already
 * knows it's closed; `handle` (the author's, null for a deleted account) words it when the receipt
 * here finds out later (the author sold while the page was open).
 */
export default function TradeDock({ takeId, author, handle = null, receipt: initial, closed = null }: { takeId: string; author: string; handle?: string | null; receipt: Receipt | null; closed?: string | null }) {
  const { ready, authenticated, user } = usePrivy();
  const { phase, snapshot, logout } = useSession();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();

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

  // The user's Privy (embedded) Solana wallet, the one the app also uses.
  const address = useMemo(() => {
    const linked = (user?.linkedAccounts ?? []) as Array<{ type: string; chainType?: string; walletClientType?: string; address?: string }>;
    return linked.find((a) => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy")?.address ?? null;
  }, [user]);
  const wallet = useMemo(() => wallets.find((w) => w.address === address) ?? null, [wallets, address]);

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

  const start = (side: Side) => {
    setError(null);
    setAmount("20");
    setPending(side);
    if (!authenticated) {
      try { sessionStorage.setItem(pendingKey, side); } catch { /* private mode */ }
      setStep({ kind: "signin" });
    }
  };

  async function signAndSubmit(built: Built): Promise<string[]> {
    if (!wallet) throw new Error("Your wallet isn't ready yet. Try again in a moment.");
    const signed: string[] = [];
    for (const tx of built.transactions) {
      const { signedTransaction } = await signTransaction({
        transaction: b64ToBytes(tx),
        wallet,
        options: { uiOptions: { showWalletUIs: false } },
      });
      signed.push(bytesToB64(signedTransaction));
    }
    const sent = await fork<{ signatures: string[] }>("POST", "/submit", { buildId: built.buildId, transactions: signed });
    return sent.signatures;
  }

  async function trade(side: Side) {
    const usdAmount = Number(amount);
    if (!(usdAmount >= config.minStakeUsd)) return setError(`The minimum is $${config.minStakeUsd}.`);
    setError(null);
    try {
      setBusy(side === "back" ? "Trading…" : "Fading…");
      const built = await fork<Built>("POST", `/takes/${takeId}/trades`, { owner: address, side, usd: usdAmount });
      await signAndSubmit(built);
      markTraded();
      await refresh();
      setStep({ kind: "done", text: `You ${side === "back" ? "traded" : "faded"} ${author}'s take with $${usdAmount}.` });
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
   * the first tap only builds and shows that warning, and the second signs (`closing.built`, or a
   * new build once that one was used or failed).
   */
  async function sell(position: Position, closing?: { built: Built | null }) {
    setError(null);
    let built: Built | null = closing?.built ?? null;
    try {
      setBusy("Selling…");
      built ??= await fork<Built>("POST", `/takes/${takeId}/positions/${position.address}/exit`, { owner: address });
      if (built.closesTake && !closing) return setStep({ kind: "sell", position, closing: { built } });
      // A build is signed once: if this fails, the next tap builds again.
      if (closing) setStep({ kind: "sell", position, closing: { built: null } });
      await signAndSubmit(built);
      markTraded();
      // A sale with Phoenix legs closed them; their cash comes back to USDC in a second step (as
      // iOS). If that fails, it waits on Me with "Cash out".
      let stranded = false;
      if (built.phoenixCashOut) {
        setBusy("Moving cash back…");
        await cashOutPhoenix(address!, signAndSubmit).catch(() => { stranded = true; });
      }
      await refresh();
      const closedNote = built.closesTake ? " Your take is closed now: no new trades, and its result is final." : "";
      setStep({
        kind: "done",
        text: (stranded
          ? "Sold, and the position is scored at today's prices. The cash from its leveraged legs is still on its way: tap Cash out on Me to move it to your balance."
          : "Sold. The cash is back in your balance, and the position is scored at today's prices.") + closedNote,
      });
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
                {p.canExit ? (
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
          <div className="sheet">
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
          </div>
        </div>
      ) : null}
    </>
  );
}

function TradeSheet(props: {
  side: Side;
  author: string;
  receipt: Receipt | null;
  amount: string;
  setAmount: (s: string) => void;
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
        $<input inputMode="decimal" value={amount} onChange={(e) => props.setAmount(centsInput(e.target.value))} aria-label="Amount" />
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

