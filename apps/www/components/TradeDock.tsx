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
//
// The sheet has Buy | Sell tabs once you hold something in the take (Buy opens first). Sell sells
// all or part of a side's holding (lib/sell.ts), by % or $, built ahead of the tap like a trade.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { closedReason, legName, money, pct, takeState, usd, type Position, type Receipt } from "@/lib/data";
// The fork client adds the Privy token on money calls and handles "Sign in again".
import { cashOutPhoenix, centsInput, depositLeft, fork, ForkError, markTraded, stoppedTrade, stopwatch, submit, useForkWallet, type Built, type Incomplete, type PhoenixLeg, type PhoenixRisk, type Stopwatch, type WalletSummary } from "@/lib/fork";
import { ALL_BPS, bpsOf, exitKey, holdingKey, holdingsOf, isAll, legacyBuild, limitNote, missingRoute, normalize, parseSaleKey, partLabel, PCT_PRESETS, remainingOf, saleBody, saleRefusal, soldAll, USD_PRESETS, type Holding, type SaleAmount } from "@/lib/sell";
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
 * `trade` is the Buy tab, `sell` the Sell tab for one side's holding (`position`: which position an
 * older fork API, without partial sales, sells whole).
 * `sell` with `closing`: the sale build said it's all of the author's buy-in (`closesTake`), so the
 * sheet warns that selling closes the take before anything is signed (the build waits for the
 * second tap). The warning usually shows before that, from the position's `closesTakeIfSoldAll`.
 * `placed`: "You're in" (or "Sold"); `confirming` until the watch says it landed, `slow` when it
 * couldn't tell. `failed`: it was accepted but didn't confirm, so nothing happened.
 */
type Step =
  | { kind: "closed" }
  | { kind: "signin" }
  | { kind: "trade"; side: Side }
  | { kind: "sell"; side: Side; position?: string; closing?: boolean }
  | { kind: "incomplete"; trade: Incomplete | null; retry: boolean }
  | { kind: "done"; text: string }
  | { kind: "placed"; buildId: string; sale: boolean; text: string; confirming: boolean; slow?: boolean }
  | { kind: "failed"; side: Side; usd: number | null }
  | { kind: "failed"; side: "sell"; sellSide: Side | null };
/** The receipt's legs and positions also carry their Phoenix details (lib/fork.ts). */
type Leg = Receipt["legs"][number] & PhoenixLeg;
const phoenixOf = (p: Position) => (p as Position & { phoenix?: PhoenixRisk[] }).phoenix;

const CHIPS = [10, 20, 50, 100];
/** Typing an amount builds it once the typing stops for this long; a chip builds at once. */
const TYPING_MS = 500;

// Early builds are cached by what they'd buy: "back:2000" ($20), "fade:5000"; sales by what they'd
// sell (lib/sell.ts): "sell:back:b2500" (25%), "sell:back:u1000" ($10), "exit:<position>".
const tradeKey = (side: Side, usdAmount: number) => `${side}:${Math.round(usdAmount * 100)}`;
const isSaleKey = (key: string) => parseSaleKey(key) != null;

const CLOSED_NOTE = " Your take is closed now: no new trades, and its result is final.";
/**
 * What a sale says once sent: all of it, or the part (`bps` of the holding) with the rest still open.
 * `cash`: "back" in the balance, "moving" from leveraged legs, or "stranded" there (Cash out on Me).
 */
function soldText(b: Built, cash: "back" | "moving" | "stranded"): string {
  const what = soldAll(b)
    ? "Sold, and the position is scored at today's prices."
    : `Sold ${partLabel(b.bps ?? ALL_BPS)} of it, scored at today's prices. The rest stays open.`;
  const where = cash === "back" ? " The cash is back in your balance."
    : cash === "moving" ? " Moving the cash from its leveraged legs back to your balance…"
    : " The cash from its leveraged legs is still on its way: tap Cash out on Me to move it to your balance.";
  return what + where + (b.closesTake ? CLOSED_NOTE : "");
}
/** Early refusals of a sale that the sheet shows before the tap (the part is too big, too small…). */
const EARLY_SALE_REFUSALS = new Set(["remainder_below_minimum", "part_too_small", "too_many_open_sales", "invalid_amount"]);

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
  /** Why a fade link couldn't open (the take has no leg a fade can take). */
  const [fadeNote, setFadeNote] = useState<string | null>(null);
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
  // A sale sent and still confirming: its holding (or, with an older fork API, its one position)
  // shows "Selling…" instead of Sell.
  const [selling, setSelling] = useState<{ side: Side | null; position: string | null } | null>(null);
  // The Sell tab: by % (a preset) or $ (a preset or typed), All to start with.
  const [saleMode, setSaleMode] = useState<"pct" | "usd">("pct");
  const [salePct, setSalePct] = useState(ALL_BPS);
  const [saleUsd, setSaleUsd] = useState("");
  // The fork API has no partial sales (a sale build came back without `bps`, or no holding route):
  // the Sell tab offers only "Sell all" of a position, as before.
  const [legacy, setLegacy] = useState(false);
  // The largest part the API said a holding can sell (a `remainder_below_minimum` refusal), per side,
  // until the next sale; it has the last word over the positions' own figures.
  const [learnedMax, setLearnedMax] = useState<Partial<Record<Side, number | null>>>({});
  // The latest early sale build, and an early sale refusal, with the key each was for.
  const [quote, setQuote] = useState<{ key: string; built: Built } | null>(null);
  const [refusal, setRefusal] = useState<{ key: string; text: string; sellAll: boolean } | null>(null);

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
    // A fade link on a take nobody can fade: say why, instead of quietly showing the trade button.
    else if (pending === "fade" && !closedText) setFadeNote(receipt?.fadeBlocked ?? "This take can't be faded right now.");
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

  // ── What you hold here, and the Sell tab's sale ─────────────────────────────────────────────
  const positions = (receipt?.viewerPositions ?? []).filter((p) => !p.exited);
  const held = holdingsOf(positions, config.minStakeUsd);
  const sellable = held.filter((h) => h.canSell);
  // A take not on the fork yet (a demo take, or after a fork reset) is put on-chain by its first trade.
  const canBack = receipt?.canBack ?? true;
  const canFade = !!receipt?.canFade;
  const sellHolding = step.kind === "sell" ? held.find((h) => h.side === step.side) ?? null : null;
  // Parts can be sold: the API sends the sale fields and hasn't shown it's an older one.
  const partial = !!sellHolding?.partial && !legacy;
  const learned = sellHolding ? learnedMax[sellHolding.side] : undefined;
  const maxBps = sellHolding ? (learned !== undefined ? learned : sellHolding.maxPartialBps) : null;
  const usdTyped = Number(saleUsd) || 0;
  const saleAmount: SaleAmount | null = !sellHolding ? null
    : !partial ? { bps: ALL_BPS }
    : saleMode === "pct" ? { bps: salePct }
    : usdTyped > 0 ? normalize({ usd: usdTyped }, sellHolding.valueUsd) : null;
  // An older API sells one whole position at a time: the one asked for, else the first sellable.
  const legacyPosition = step.kind === "sell" && sellHolding
    ? (sellHolding.positions.find((p) => p.address === step.position && p.canExit) ?? sellHolding.positions.find((p) => p.canExit))?.address ?? null
    : null;
  const saleKeyNow = !sellHolding || !saleAmount ? null
    : partial ? holdingKey(sellHolding.side, saleAmount)
    : legacyPosition ? exitKey(legacyPosition) : null;
  const saleBps = saleAmount && sellHolding ? bpsOf(saleAmount, sellHolding.valueUsd) : null;
  // A part bigger than what can be sold now (what's left would be under the minimum): not built.
  const overMax = partial && !!saleAmount && !isAll(saleAmount) && saleBps != null && (maxBps == null || saleBps > maxBps);
  const quoteNow = quote && quote.key === saleKeyNow ? quote.built : null;
  const refusalNow = refusal && refusal.key === saleKeyNow ? refusal : null;
  // Selling all of the author's buy-in closes the take: said before the tap, from the position (or
  // the build). Only a sale of all of the holding sells all of the buy-in (a part never sells it
  // whole); an older API sells one position whole, so it's that position's own flag.
  const soldWhole = !sellHolding ? false
    : partial ? isAll(saleAmount) && !!sellHolding.closesTakeIfSoldAll
    : !!sellHolding.positions.find((p) => p.address === legacyPosition)?.closesTakeIfSoldAll;
  const closing = step.kind === "sell" && (!!step.closing || !!quoteNow?.closesTake || soldWhole);

  /** Open the Sell tab on a side's holding (`position`: the one an older API sells whole). */
  const openSell = (side: Side, position?: string) => {
    setError(null);
    setRefusal(null);
    setSaleMode("pct");
    setSalePct(ALL_BPS);
    setSaleUsd("");
    setStep({ kind: "sell", side, position });
  };
  /** A new part picked: what the last one said no longer applies. */
  const picked = () => {
    setError(null);
    setStep((s) => (s.kind === "sell" && s.closing ? { ...s, closing: false } : s));
  };

  // ── Early builds ────────────────────────────────────────────────────────────────────────────
  const sheetOpen = step.kind === "trade" || step.kind === "sell";
  const early = useEarlyBuild({
    // Sales go on in a closed take (its holders can still sell); trades and fades don't.
    ready: sheetOpen && phase.kind === "ready" && !!wallet && !!address && (step.kind === "sell" || !closedText),
    make: async (key, prebuild) => {
      const flag = prebuild ? { prebuild: true } : {};
      const sale = parseSaleKey(key);
      if (sale?.kind === "exit") return fork<Built>("POST", `/takes/${takeId}/positions/${sale.position}/exit`, { owner: address, ...flag });
      if (sale) {
        try {
          return await fork<Built>("POST", `/takes/${takeId}/sell`, saleBody(sale, address!, prebuild));
        } catch (e) {
          // An older fork API: no holding route. The tab turns into "Sell all" of a position.
          if (missingRoute(e)) {
            setLegacy(true);
            throw new ForkError("no_partial_sales", "Selling part of a position isn't available right now. Sell all of it instead.");
          }
          throw e;
        }
      }
      const [side, cents] = key.split(":");
      return fork<Built>("POST", `/takes/${takeId}/trades`, { owner: address, side, usd: Number(cents) / 100, ...flag });
    },
    // Never build behind a trade that's still confirming: wait for it first.
    beforeEarly: async () => {
      const p = address ? pendingTrade.get(address) : null;
      return !p || (await watchSubmission(p.buildId))?.status !== "incomplete";
    },
    // A sale's build: what it sells and gets (and whether it closes the take), shown before the tap.
    onEarlyBuilt: (key, built) => {
      if (!isSaleKey(key)) return;
      if (key.startsWith("sell:") && legacyBuild(built)) setLegacy(true);
      setQuote({ key, built });
      setRefusal((r) => (r?.key === key ? null : r));
    },
    // A part the API won't sell (too big, too small, too many settling): say why before the tap.
    onEarlyError: (key, e) => {
      const sale = parseSaleKey(key);
      if (!sale || !(e instanceof ForkError) || !EARLY_SALE_REFUSALS.has(e.code)) return;
      const r = saleRefusal(e);
      if (sale.kind === "sell" && e.code === "remainder_below_minimum") setLearnedMax((m) => ({ ...m, [sale.side]: r.maxPartialBps ?? null }));
      setRefusal({ key, text: r.text, sellAll: r.sellAll });
    },
  });
  // How long to wait before building the amount: 0 for the sheet opening or a chip, TYPING_MS
  // after a keystroke (set just before the amount changes).
  const buildDelay = useRef(0);
  const n = Number(amount) || 0;
  const affordable = cash != null && cash >= n + n * config.feeRate;
  const tradeSide = step.kind === "trade" ? step.side : null;
  const sellOpen = step.kind === "sell";
  useEffect(() => {
    const delay = buildDelay.current;
    buildDelay.current = 0;
    if (tradeSide) early.want(n >= config.minStakeUsd && affordable ? tradeKey(tradeSide, n) : null, delay);
    else if (sellOpen) early.want(overMax ? null : saleKeyNow, delay);
  }, [early, tradeSide, sellOpen, saleKeyNow, overMax, n, affordable, config.minStakeUsd]);
  const typeAmount = (s: string) => { buildDelay.current = TYPING_MS; setAmount(s); };
  const typeSaleUsd = (s: string) => { buildDelay.current = TYPING_MS; picked(); setSaleUsd(s); };

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
  const rolledBack = useCallback((p: Pick<PendingTrade, "kind" | "usd" | "position" | "side">, s: Submission | null) => {
    if (s?.status === "incomplete") {
      markTraded();
      return setStep({ kind: "incomplete", trade: s.incomplete ?? null, retry: s.incomplete?.next === "retry" });
    }
    if (p.kind === "sell") {
      const side = p.side ?? (receipt?.viewerPositions ?? []).find((x) => x.address === p.position)?.side ?? null;
      return setStep({ kind: "failed", side: "sell", sellSide: side });
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
    if (p.kind === "sell") setSelling(null);
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
    const text = soldText(built, stranded ? "stranded" : "back");
    setStep((x) => (x.kind === "placed" && x.buildId === buildId ? { ...x, text } : x));
  }

  // A trade still confirming when the page was left or reloaded: watch it to the end here, and on
  // this take's page say so if it didn't go through.
  useEffect(() => {
    const p = address ? pendingTrade.get(address) : null;
    if (!p) return;
    let live = true;
    if (p.kind === "sell" && p.takeId === takeId) setSelling({ side: p.side ?? null, position: p.position });
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
    // What the API said a holding could sell held until now; the sale changes it.
    setLearnedMax({});
    setQuote(null);
    setRefusal(null);
    if (p.kind === "sell") setSelling({ side: p.side ?? null, position: p.position });
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
   * Sell the Sell tab's part of a holding (all of it, or one position whole with an older API).
   * All of the author's buy-in closes the take (`closesTake` on the build): the sheet shows that
   * warning before the tap when it knows (the position's `closesTakeIfSoldAll`, or the early build);
   * otherwise the first tap shows it and only the tap after the warning signs.
   */
  async function sell() {
    if (!sellHolding || !saleKeyNow || !address) return;
    const h = sellHolding;
    const key = saleKeyNow;
    const warned = closing;
    const asked = saleAmount;
    setError(null);
    setRefusal(null);
    const sw = stopwatch();
    try {
      setBusy("Selling…");
      if (!(await priorSettled())) return;
      setBusy("Selling…");
      const t = await early.take(key);
      if (t.built.closesTake && !warned) {
        early.put(key, t);
        return setStep((s) => (s.kind === "sell" ? { ...s, closing: true } : s));
      }
      sw.mark("built", t.at);
      const signed = await sign(t.built, sw);
      const exit = parseSaleKey(key)?.kind === "exit";
      const text = soldText(t.built, t.built.phoenixCashOut ? "moving" : "back");
      await place({ kind: "sell", takeId, usd: null, position: exit ? legacyPosition : null, side: h.side }, t.built, signed, sw, text);
    } catch (e) {
      const r = saleRefusal(e);
      if (e instanceof ForkError && e.code === "remainder_below_minimum") setLearnedMax((m) => ({ ...m, [h.side]: r.maxPartialBps ?? null }));
      if (r.sellAll && !isAll(asked) && partial) setRefusal({ key, text: r.text, sellAll: true });
      else setError(r.text);
    } finally {
      setBusy(null);
    }
  }

  /** "Sell all instead" (and the All chip): the part becomes All, built at once. */
  const sellAllInstead = () => {
    picked();
    setRefusal(null);
    setSaleMode("pct");
    setSalePct(ALL_BPS);
  };

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

  // The Buy tab's side: the one asked for when this take allows it, else the one it does.
  const sheetSide = step.kind === "trade" || step.kind === "sell" ? step.side : "back";
  const buySide: Side | null = closedText ? null
    : (sheetSide === "back" ? canBack : canFade) ? sheetSide
    : canBack ? "back" : canFade ? "fade" : null;
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
          {positions.map((p) => {
            const sending = !!selling && selling.side === p.side && (selling.position == null || selling.position === p.address);
            return (
              <div className="row" key={p.address}>
                <div>
                  <span className={p.side === "back" ? "up" : "down"}>{p.side === "back" ? "Traded" : "Faded"}</span> {usd(remainingOf(p))}
                  {/* After a partial sale: what's still held of what was bought. */}
                  {p.soldStakeUsd ? <span className="muted"> of {usd(p.stakeUsd)}</span> : null}
                  <div className="note">{p.pendingNote ? legName(p.pendingNote) : `Score ${pct(p.returnBps == null ? null : p.returnBps / 100)}`}</div>
                  {p.realizedPnlUsd != null ? (
                    <div className="note">Realized <span className={p.realizedPnlUsd < 0 ? "down" : "up"}>{money(p.realizedPnlUsd, true)}</span> from sales</div>
                  ) : null}
                  {p.pendingSales?.length ? <div className="note">Selling… a sale settles once its prices are in</div> : null}
                  {/* Leveraged legs and fade shorts: where each one is liquidated, and how close it is. */}
                  <LiquidationLines risks={phoenixOf(p)} leverage={(i) => (receipt?.legs.find((l) => l.index === i) as Leg | undefined)?.perp?.leverage ?? null} />
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="mono">{usd(p.valueUsd)}</div>
                  {sending ? (
                    <div className="note">Selling…</div>
                  ) : p.canExit ? (
                    <button className="pill small" style={{ marginTop: 6 }} onClick={() => openSell(p.side, p.address)}>Sell</button>
                  ) : null}
                </div>
              </div>
            );
          })}
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
      {fadeNote && !canFade ? <p className="small muted" role="status" style={{ marginTop: 20 }}>{fadeNote}</p> : null}

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
          {/* With Buy | Sell tabs the sheet keeps one height, so switching tabs doesn't move them. */}
          <div className={(step.kind === "trade" || step.kind === "sell") && sellable.length ? "sheet tabbed" : "sheet"} onPointerDown={early.touch}>
            <button className="x" aria-label="Close" disabled={!!busy} onClick={() => setStep({ kind: "closed" })}>×</button>
            {/* Buy | Sell once there's something here to sell (Buy opens first). */}
            {(step.kind === "trade" || step.kind === "sell") && sellable.length ? (
              <nav className="utabs sheet-tabs" role="tablist" aria-label="Buy or sell">
                <button role="tab" aria-selected={step.kind === "trade"} className={step.kind === "trade" ? "on" : ""} disabled={!buySide || !!busy}
                  title={buySide ? undefined : closedText ?? "This take can't be traded right now."}
                  onClick={() => { if (buySide) { setError(null); setStep({ kind: "trade", side: buySide }); } }}>Buy</button>
                <button role="tab" aria-selected={step.kind === "sell"} className={step.kind === "sell" ? "on" : ""} disabled={!!busy}
                  onClick={() => step.kind !== "sell" && openSell(sellable.find((h) => h.side === sheetSide)?.side ?? sellable[0].side)}>Sell</button>
              </nav>
            ) : null}
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
              sellHolding ? (
                <SellSheet
                  holdings={sellable.length ? sellable : [sellHolding]}
                  holding={sellHolding}
                  onSide={(side) => openSell(side)}
                  partial={partial}
                  legacyPosition={legacyPosition}
                  onLegacyPosition={(a) => { picked(); setStep({ kind: "sell", side: sellHolding.side, position: a }); }}
                  mode={saleMode}
                  setMode={(m) => { picked(); setSaleMode(m); }}
                  setPct={(b) => { picked(); setSalePct(b); }}
                  usdText={saleUsd}
                  setUsd={(s) => { picked(); setSaleUsd(s); }}
                  typeUsd={typeSaleUsd}
                  amount={saleAmount}
                  maxBps={maxBps}
                  overMax={overMax}
                  quote={quoteNow}
                  closing={closing}
                  refusal={refusalNow}
                  error={error}
                  busy={busy}
                  onSellAll={sellAllInstead}
                  onConfirm={sell}
                />
              ) : (
                <p className="muted">Nothing left to sell here.</p>
              )
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
                  step.sellSide && held.some((h) => h.side === step.sellSide) ? (
                    <button className="btn light" style={{ width: "100%", marginTop: 12 }} onClick={() => openSell(step.sellSide!)}>Try again</button>
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

/**
 * The Sell tab: one side's holding in this take (a switch when you hold both sides), sold by % or
 * $ with presets or a typed amount. Parts above what can be sold now are greyed out and the sheet
 * says why (what's left keeps at least the minimum); All always works. An older fork API sells only
 * a whole position: the tab then offers just that.
 */
function SellSheet(props: {
  holdings: Holding[];
  holding: Holding;
  onSide: (side: Side) => void;
  partial: boolean;
  legacyPosition: string | null;
  onLegacyPosition: (address: string) => void;
  mode: "pct" | "usd";
  setMode: (m: "pct" | "usd") => void;
  setPct: (bps: number) => void;
  usdText: string;
  /** A $ chip: built at once. */
  setUsd: (s: string) => void;
  /** Typed: built once the typing stops. */
  typeUsd: (s: string) => void;
  amount: SaleAmount | null;
  maxBps: number | null;
  overMax: boolean;
  quote: Built | null;
  closing: boolean;
  refusal: { text: string; sellAll: boolean } | null;
  error: string | null;
  busy: string | null;
  onSellAll: () => void;
  onConfirm: () => void;
}) {
  const { holding: h, partial, amount, maxBps, quote, busy } = props;
  const all = !partial || isAll(amount);
  const value = h.valueUsd;
  const bps = amount ? bpsOf(amount, value) : null;
  const maxUsd = value != null && maxBps != null ? (value * maxBps) / ALL_BPS : null;
  // What it sells and what stays: the build's figures once it's in, else from today's value.
  const getUsd = quote?.sale?.valueUsd ?? quote?.expectedUsd ?? (amount && "usd" in amount ? amount.usd : value != null && bps != null ? (value * bps) / ALL_BPS : null);
  const leftUsd = quote?.sale ? quote.sale.remainingValueUsd : value != null && getUsd != null ? Math.max(0, value - getUsd) : null;
  const leftStake = quote?.sale ? quote.sale.remainingStakeUsd : bps != null ? (h.remainingStakeUsd * (ALL_BPS - bps)) / ALL_BPS : null;
  const pctOff = (b: number) => b < ALL_BPS && (maxBps == null || b > maxBps);
  // A $ chip at or past the whole value is just All; past what can be sold now, greyed out.
  const usdOff = (c: number) => value == null || c >= value * 0.995 || maxUsd == null || c > maxUsd;
  const limited = partial && (maxBps == null || maxBps < PCT_PRESETS[PCT_PRESETS.length - 2] || props.overMax);
  const note = limited ? limitNote(h, maxBps) : null;
  const sideLabel = (x: Holding) => (x.side === "back" ? "Traded" : "Faded");
  const legacyList = h.positions.filter((p) => p.canExit);
  const label = busy ?? (props.closing ? "Sell and close the take"
    : all ? (partial ? "Sell all" : "Confirm full sale")
    : amount && "usd" in amount ? `Sell ${usd(amount.usd)}` : `Sell ${partLabel(bps ?? 0)}`);

  return (
    <>
      <h3>{props.closing ? "Sell and close your take" : "Sell"}</h3>
      <p className="muted small" style={{ margin: 0 }}>
        {partial
          ? "Sell all of it or part. Each sale is scored at today's prices, and money held for prediction legs comes back with it. No fee."
          : "Sells the whole position for fork USDC, including money held for prediction legs. It's scored at today's prices and settles right away."}
      </p>
      {props.holdings.length > 1 ? (
        <div className="ranges sell-sides" role="tablist" aria-label="Which side">
          {props.holdings.map((x) => (
            <button key={x.side} role="tab" aria-selected={x.side === h.side} className={x.side === h.side ? "on" : ""} disabled={!!busy} onClick={() => x.side !== h.side && props.onSide(x.side)}>
              {sideLabel(x)} {usd(x.valueUsd ?? x.remainingStakeUsd)}
            </button>
          ))}
        </div>
      ) : null}
      <div className="row" style={{ marginTop: 10 }}><span>Worth now</span><span className="mono">{usd(value)}</span></div>
      <div className="row muted small"><span>Cost basis held</span><span className="mono">{usd(h.remainingStakeUsd)}</span></div>
      {h.realizedPnlUsd != null ? (
        <div className="row muted small"><span>Realized from sales</span><span className={`mono ${h.realizedPnlUsd < 0 ? "down" : "up"}`}>{money(h.realizedPnlUsd, true)}</span></div>
      ) : null}

      {partial ? (
        <>
          <div className="sell-mode">
            <div className="ranges" role="tablist" aria-label="Sell by percent or dollars">
              <button role="tab" aria-selected={props.mode === "pct"} className={props.mode === "pct" ? "on" : ""} onClick={() => props.setMode("pct")}>%</button>
              <button role="tab" aria-selected={props.mode === "usd"} className={props.mode === "usd" ? "on" : ""} disabled={value == null} title={value == null ? "Can't price it right now" : undefined} onClick={() => props.setMode("usd")}>$</button>
            </div>
          </div>
          {props.mode === "usd" ? (
            <div className="amount">
              $<input inputMode="decimal" placeholder="0" value={props.usdText} onChange={(e) => props.typeUsd(centsInput(e.target.value))} aria-label="Amount to sell" />
            </div>
          ) : null}
          <div className="chips">
            {props.mode === "pct"
              ? PCT_PRESETS.map((b) => (
                <button key={b} className={`chip sell ${amount && "bps" in amount && amount.bps === b ? "on" : ""}`} disabled={pctOff(b) || !!busy} onClick={() => props.setPct(b)}>
                  {b >= ALL_BPS ? "All" : `${b / 100}%`}
                </button>
              ))
              : [...USD_PRESETS.map((c) => (
                <button key={c} className={`chip sell ${amount && "usd" in amount && amount.usd === c ? "on" : ""}`} disabled={usdOff(c) || !!busy} onClick={() => props.setUsd(String(c))}>${c}</button>
              )), (
                <button key="all" className={`chip sell ${all ? "on" : ""}`} disabled={!!busy} onClick={props.onSellAll}>All</button>
              )]}
          </div>
          {note ? <p className="note" style={{ marginTop: -8 }}>{note}</p> : null}
          {!all ? (
            <>
              <div className="row"><span>You get about</span><span className="mono">{usd(getUsd)}</span></div>
              <div className="row muted small"><span>Still held</span><span className="mono">{usd(leftUsd)}{leftStake != null ? ` · cost ${usd(leftStake)}` : ""}</span></div>
            </>
          ) : null}
        </>
      ) : legacyList.length > 1 ? (
        <div role="radiogroup" aria-label="Which position">
          {legacyList.map((p) => (
            <label key={p.address} className="row" style={{ cursor: "pointer" }}>
              <span><input type="radio" name="sell-position" checked={props.legacyPosition === p.address} onChange={() => props.onLegacyPosition(p.address)} /> {usd(p.stakeUsd)} position</span>
              <span className="mono">{usd(p.valueUsd)}</span>
            </label>
          ))}
        </div>
      ) : null}

      {props.closing ? (
        // All of the author's own buy-in (the position's closesTakeIfSoldAll, or the build's closesTake).
        <p className="note">
          Selling all of it closes this take: no new trades, and its result is final at today&apos;s prices. Others keep their positions.
        </p>
      ) : partial && h.closesTakeIfSoldAll ? (
        <p className="note">Selling part keeps your take open. Selling all of it closes the take.</p>
      ) : null}
      {props.refusal ? (
        <div className="err" role="alert">
          {props.refusal.text}
          {props.refusal.sellAll && !all ? (
            <button className="pill small" style={{ display: "block", marginTop: 8 }} disabled={!!busy} onClick={props.onSellAll}>Sell all instead</button>
          ) : null}
        </div>
      ) : null}
      {props.error ? <div className="err">{props.error}</div> : null}
      <button className="btn light" style={{ width: "100%", marginTop: 16 }} disabled={!!busy || !h.canSell || !amount || props.overMax || (!partial && !props.legacyPosition)} onClick={props.onConfirm}>
        {label}
      </button>
    </>
  );
}

