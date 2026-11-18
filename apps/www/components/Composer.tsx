"use client";
// New take, like the iOS CreateFlow: write it (plus risk and horizon) → Thesis builds the basket →
// review it (risk, "change something…", weights, add or remove picks) → buy in and post. Buying in
// is required to post: the take stays "posting" (yours only) until its on-chain buy-in confirms,
// and this screen waits for that, then opens the take.
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { cardValue, isCardKind, money, SERIES } from "@/lib/data";
import {
  adding, basketFrom, builderLegs, type Built, type Draft, HORIZONS, horizonOf, type Leg, MAX_PICKS, newDraft, type PickAsset,
  removing, type Risk, RISKS, setting, settleDate, topicGuess,
} from "@/lib/compose";
import { centsInput, fork, useForkWallet, type WalletSummary } from "@/lib/fork";
import { postingBuyIns, sendBuyIn, showMyTakes, waitUntilLive } from "@/lib/posting";
import { useSession } from "@/lib/session";
import { AssetLogo, type Asset } from "./AssetBits";
import { AddCash } from "./CashSheets";
import { PostingAtLaunch } from "./PostingRecovery";

type Open = Partial<Draft> & { autoBuild?: boolean };
const ComposerContext = createContext<{ open: (init?: Open) => void } | null>(null);

export function useComposer() {
  const ctx = useContext(ComposerContext);
  if (!ctx) throw new Error("useComposer outside ComposerProvider");
  return ctx;
}

/** Anywhere can open the composer: the "What's your take?" bar, an asset page, an X call. */
export function ComposerProvider({ children }: { children: React.ReactNode }) {
  const [init, setInit] = useState<Open | null>(null);
  const value = useMemo(() => ({ open: (i: Open = {}) => setInit(i) }), []);
  return (
    <ComposerContext.Provider value={value}>
      {children}
      {init ? <Composer init={init} onClose={() => setInit(null)} /> : null}
      {/* Takes that didn't post (their buy-in never landed): Retry or Discard, once per session. */}
      <PostingAtLaunch />
    </ComposerContext.Provider>
  );
}

type Step = "write" | "building" | "basket" | "posting";

function Composer({ init, onClose }: { init: Open; onClose: () => void }) {
  const { token } = useSession();
  const [draft, setDraft] = useState<Draft>(() => newDraft(init));
  // A basket that came built (a chat bot's draft) opens on the basket.
  const [step, setStep] = useState<Step>(init.legs?.length && init.claim ? "basket" : init.autoBuild && init.claim ? "building" : "write");
  const [closing, setClosing] = useState(false);

  // Wake the take builder while you write, so Build doesn't wait on a cold start.
  useEffect(() => {
    token().then((t) => fetch("/api/take-builder", { headers: { "privy-token": t } })).catch(() => {});
  }, [token]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const requestClose = () => (draft.claim.trim() && step !== "posting" ? setClosing(true) : onClose());

  return (
    <div className="composer" role="dialog" aria-label="New take">
      {/* A basket built for exactly this take (picks you changed included) is reused; anything else builds. */}
      {step === "write" ? <Write draft={draft} setDraft={setDraft} onClose={requestClose} onNext={() => setStep(draft.legs?.length ? "basket" : "building")} /> : null}
      {step === "building" ? <Building draft={draft} setDraft={setDraft} onClose={requestClose} onBack={() => setStep("write")} onNext={() => setStep("basket")} auto={!!init.autoBuild} /> : null}
      {step === "basket" ? <Basket draft={draft} setDraft={setDraft} onClose={requestClose} onBack={() => setStep("write")} onPosted={() => setStep("posting")} /> : null}
      {step === "posting" ? <Posting draft={draft} onClose={onClose} /> : null}
      {closing ? (
        <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && setClosing(false)}>
          <div className="sheet" role="alertdialog" aria-label="Discard this take?">
            <h3>Discard this take?</h3>
            <p className="muted">It isn&apos;t posted yet, so nothing is saved.</p>
            <button className="obtn filled down-fill" onClick={onClose}>Discard</button>
            <button className="obtn plain" onClick={() => setClosing(false)}>Keep editing</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Header({ title, onClose, onBack }: { title: string; onClose?: () => void; onBack?: () => void }) {
  return (
    <header className="cmp-head">
      {onBack ? <button className="back" onClick={onBack}>‹ Back</button> : <span />}
      <b>{title}</b>
      {onClose ? <button className="x" style={{ float: "none" }} aria-label="Close" onClick={onClose}>×</button> : <span />}
    </header>
  );
}

function SourceMark({ draft }: { draft: Draft }) {
  return draft.source ? <span className="muted small">via {draft.source.label}</span> : null;
}

// Write the take ------------------------------------------------------------------------------

function Write({ draft, setDraft, onClose, onNext }: { draft: Draft; setDraft: (f: (d: Draft) => Draft) => void; onClose: () => void; onNext: () => void }) {
  const ok = draft.claim.trim().length >= 3;
  // Changing the take, risk, horizon or starting asset throws away the basket built for the old one,
  // so an edited take never posts the old basket (and "no clean way" → edit → build builds again).
  const edit = (patch: Partial<Draft>) =>
    setDraft((d) => {
      const changed = (Object.keys(patch) as (keyof Draft)[]).some((k) => JSON.stringify(d[k]) !== JSON.stringify(patch[k]));
      return changed ? { ...d, ...patch, legs: null, summary: null, noExposure: null, edited: false } : d;
    });
  return (
    <div className="cmp">
      <Header title="New take" onClose={onClose} />
      <div className="cmp-body">
        <label className="muted small" htmlFor="claim" style={{ fontWeight: 600 }}>Your take</label>
        <textarea id="claim" className="claim-input" autoFocus maxLength={140} placeholder="AI power demand is underrated." value={draft.claim}
          onChange={(e) => edit({ claim: e.target.value })} />
        <p className="muted small">Say it in plain words. Thesis finds investments that match it, or tells you if there&apos;s no clean way to bet on it.</p>
        {draft.seed ? (
          <div className="chip-line">Your basket starts with {draft.seed.name}<button aria-label={`Don't start with ${draft.seed.name}`} onClick={() => edit({ seed: null })}>×</button></div>
        ) : null}
        {draft.source ? (
          <div className="chip-line">via {draft.source.label}<button aria-label={`Don't credit ${draft.source.label}`} onClick={() => setDraft((d) => ({ ...d, source: null }))}>×</button></div>
        ) : null}

        <div className="cmp-thesis"><span className="orb" aria-hidden /> <b>Thesis</b> <span className="muted">· two quick questions</span></div>

        <h3 className="cmp-q">How much risk?</h3>
        <div className="risk-cards" role="radiogroup" aria-label="Risk">
          {RISKS.map((r) => (
            <button key={r.key} role="radio" aria-checked={draft.risk === r.key} className={draft.risk === r.key ? "on" : ""} onClick={() => edit({ risk: r.key })}>
              <b>{r.label}</b><span className="muted small">{r.note}</span>
            </button>
          ))}
        </div>

        <h3 className="cmp-q">How long should it run?</h3>
        <div className="segmented four" role="radiogroup" aria-label="Horizon">
          {HORIZONS.map((h) => (
            <button key={h.key} role="radio" aria-checked={draft.horizon === h.key} className={draft.horizon === h.key ? "on" : ""} onClick={() => edit({ horizon: h.key })}>{h.short}</button>
          ))}
        </div>
        <p className="muted small">Your take settles at the end, and the result goes on your record.</p>
      </div>
      <div className="cmp-foot">
        <button className="obtn filled" disabled={!ok} onClick={onNext}>Build my basket →</button>
      </div>
    </div>
  );
}

// Build the basket ----------------------------------------------------------------------------

const PHASES = [
  { title: "Reading your take", sub: "Working out what has to be true for you to be right." },
  { title: "Searching for matches", sub: "Stocks, predictions and other picks tied to your idea." },
  { title: "Checking the fit", sub: "How closely each pick tracks your take, and how easy it is to buy." },
];
const LABELS = ["Reading your take", "Finding stocks and predictions that match", "Checking how closely each one fits"];

async function callBuilder(token: string, body: Record<string, unknown>): Promise<Built> {
  const r = await fetch("/api/take-builder", { method: "POST", headers: { "privy-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((json as { message?: string }).message ?? "Check your connection and try again.");
  return json as Built;
}

const builderBody = (d: Draft) => ({ claim: d.claim.trim(), risk: d.risk, horizon: horizonOf(d.horizon).long });

function Building({ draft, setDraft, onClose, onBack, onNext, auto }: { draft: Draft; setDraft: (f: (d: Draft) => Draft) => void; onClose: () => void; onBack: () => void; onNext: () => void; auto: boolean }) {
  const { token } = useSession();
  const [phase, setPhase] = useState(0);
  const [built, setBuilt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const done = built && phase >= PHASES.length;

  useEffect(() => {
    let live = true;
    setError(null);
    setBuilt(false);
    setPhase(0);
    const timers = [1, 2].map((i) => window.setTimeout(() => live && setPhase(i), i * 450));
    (async () => {
      try {
        const body = { ...builderBody(draft), ...(draft.seed ? { include: [draft.seed.id] } : {}) };
        const b = basketFrom(await callBuilder(await token(), body));
        if (!live) return;
        setDraft((d) => ({ ...d, legs: b.legs, summary: b.summary, noExposure: b.noExposure, edited: false }));
        setBuilt(true);
        setPhase(PHASES.length);
        if (auto && !b.noExposure) window.setTimeout(() => live && onNext(), 600);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { live = false; timers.forEach(window.clearTimeout); };
    // A new attempt rebuilds; the draft is read once per attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const current = PHASES[Math.min(phase, PHASES.length - 1)];
  return (
    <div className="cmp">
      <Header title="New take" onClose={onClose} onBack={onBack} />
      <div className="cmp-body">
        <div className={`take-card${done || error ? "" : " beam"}`}>
          <div className="muted small" style={{ fontWeight: 600 }}>Your take</div>
          <div className="take-card-claim">{draft.claim}</div>
          <div className="muted small">{RISKS.find((r) => r.key === draft.risk)!.label} risk · {horizonOf(draft.horizon).long}</div>
          <SourceMark draft={draft} />
        </div>
        <div className="build-status">
          <span className={`orb big${done || error ? " still" : ""}`} aria-hidden />
          <h2>{error ? "Couldn't build your basket" : done ? (draft.noExposure ? "No clean way to trade this" : "Your basket is ready") : current.title}</h2>
          <p className="muted">{error ?? (done ? (draft.noExposure ?? `${draft.legs?.length ?? 0} ${draft.legs?.length === 1 ? "pick" : "picks"} · ${RISKS.find((r) => r.key === draft.risk)!.label} risk · ${horizonOf(draft.horizon).long}`) : current.sub)}</p>
        </div>
        <div className="build-steps">
          {LABELS.map((l, i) => (
            <div key={l} className="build-step">
              <span className={`step-dot${done || i < phase ? " done" : i === phase ? " now" : ""}`} aria-hidden>{done || i < phase ? "✓" : ""}</span>
              <span style={{ color: !done && i > phase ? "var(--muted)" : undefined }}>{l}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="cmp-foot">
        {error ? <button className="obtn filled" onClick={() => setAttempt((a) => a + 1)}>Try again</button>
          : done && draft.noExposure ? <button className="obtn filled" onClick={onBack}>Edit your take</button>
          : <button className="obtn filled" disabled={!done} onClick={onNext}>{done ? "See your basket →" : "Building your basket…"}</button>}
      </div>
    </div>
  );
}

// Review the basket ---------------------------------------------------------------------------

function Donut({ legs, selected }: { legs: Leg[]; selected: string | null }) {
  const r = 80;
  const c = 2 * Math.PI * r;
  const total = legs.reduce((s, l) => s + l.weight, 0) || 1;
  let offset = 0;
  return (
    <svg viewBox="0 0 210 210" width="210" height="210" aria-hidden>
      {legs.map((l) => {
        const len = (l.weight / total) * c;
        const el = (
          <circle key={l.name} cx="105" cy="105" r={r} fill="none" stroke={SERIES[l.slot] ?? SERIES[0]} strokeWidth={selected === l.name ? 26 : 20}
            strokeDasharray={`${Math.max(0, len - 3)} ${c}`} strokeDashoffset={-offset} transform="rotate(-90 105 105)"
            opacity={selected && selected !== l.name ? 0.35 : 1} style={{ transition: "stroke-width 0.2s, opacity 0.2s" }} />
        );
        offset += len;
        return el;
      })}
    </svg>
  );
}

function Basket({ draft, setDraft, onClose, onBack, onPosted }: { draft: Draft; setDraft: (f: (d: Draft) => Draft) => void; onClose: () => void; onBack: () => void; onPosted: () => void }) {
  const { token } = useSession();
  const { address } = useForkWallet();
  const legs = draft.legs ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [ask, setAsk] = useState("");
  const [menu, setMenu] = useState<Leg | null>(null);
  const [weighing, setWeighing] = useState<Leg | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [short, setShort] = useState(false);
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [config, setConfig] = useState({ feeRate: 0.001, minStakeUsd: 10 });
  // The field's text, so "12." and "12.5" can be typed; at most 2 decimals (the fork API takes cents).
  const [buyInText, setBuyInText] = useState(draft.buyIn ? String(draft.buyIn) : "");
  const picked = legs.find((l) => l.name === selected) ?? null;
  const locked = rebuilding || checking;

  useEffect(() => { fork<{ feeRate: number; minStakeUsd: number }>("GET", "/config").then(setConfig).catch(() => {}); }, []);

  const change = (next: Leg[]) => { setNote(null); setDraft((d) => ({ ...d, legs: next, edited: true })); };

  async function sendAsk() {
    const text = ask.trim();
    if (!text || locked) return;
    setRebuilding(true);
    setNote(null);
    try {
      const b = basketFrom(await callBuilder(await token(), { ...builderBody(draft), mode: "edit", ask: text, legs: builderLegs(legs) }));
      if (JSON.stringify(b.legs) !== JSON.stringify(legs)) { setDraft((d) => ({ ...d, legs: b.legs, edited: true, summary: b.summary ?? d.summary })); setSelected(null); }
      setNote(b.note);
      if (!b.note) setAsk("");
    } catch {
      setNote("Couldn't change the basket. Try again.");
    } finally {
      setRebuilding(false);
    }
  }

  // A new risk: picks you changed stay (only the cash or leveraged pick moves); otherwise build again.
  async function riskChanged(risk: Risk) {
    const next = { ...draft, risk };
    setDraft(() => next);
    setSelected(null);
    setRebuilding(true);
    setNote(null);
    try {
      const body = draft.edited ? { ...builderBody(next), mode: "risk", legs: builderLegs(legs) } : { ...builderBody(next), ...(draft.seed ? { include: [draft.seed.id] } : {}) };
      const b = basketFrom(await callBuilder(await token(), body));
      if (b.noExposure) setNote(b.noExposure);
      else if (b.legs.length) setDraft((d) => ({ ...d, legs: b.legs, summary: b.summary ?? d.summary }));
    } catch {
      setNote(`Couldn't rebuild for ${risk} risk. Try again.`);
    } finally {
      setRebuilding(false);
    }
  }

  async function buyIn() {
    if (locked || !address) return;
    setError(null);
    setShort(false);
    if (!(draft.buyIn >= config.minStakeUsd)) return setError(`The minimum buy-in is ${money(config.minStakeUsd).replace(/\.00$/, "")}.`);
    setChecking(true);
    try {
      const w = await fork<WalletSummary>("GET", `/wallets/${address}`);
      setWallet(w);
      // The program checks it too; this just says so before the post.
      if (draft.buyIn * (1 + config.feeRate) > w.usdc) { setShort(true); setError("Not enough cash for that buy-in."); return; }
      onPosted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  const riskNote = note ?? draft.summary ?? RISKS.find((r) => r.key === draft.risk)!.basket;
  return (
    <div className="cmp">
      <Header title="Your basket" onClose={onClose} onBack={onBack} />
      <div className="cmp-body">
        <div style={{ textAlign: "center" }}>
          <div className="take-card-claim">{draft.claim}</div>
          <div className="muted small">{horizonOf(draft.horizon).long} · settles {settleDate(draft.horizon).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
          <SourceMark draft={draft} />
        </div>
        <div className="donut-wrap" style={{ opacity: rebuilding ? 0.4 : 1 }}>
          <Donut legs={legs} selected={selected} />
          <div className="donut-center">
            <b>{picked ? `${Math.round(picked.weight)}%` : legs.length}</b>
            <span className="muted small">{picked ? picked.name : `${legs.length === 1 ? "pick" : "picks"} · tap one to see it`}</span>
          </div>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Risk">
          {RISKS.map((r) => (
            <button key={r.key} role="radio" aria-checked={draft.risk === r.key} disabled={locked} className={draft.risk === r.key ? "on" : ""} onClick={() => draft.risk !== r.key && riskChanged(r.key)}>{r.label} risk</button>
          ))}
        </div>
        <p className={`small basket-note${note ? "" : " muted"}`}>{rebuilding ? "Working on it…" : riskNote}</p>

        <form className="ask-bar" onSubmit={(e) => { e.preventDefault(); sendAsk(); }}>
          <span className="muted" aria-hidden>✦</span>
          <input placeholder="Change something… (add AMD, less crypto)" value={ask} disabled={locked} onChange={(e) => setAsk(e.target.value)} aria-label="Change the basket" enterKeyHint="send" />
          {ask.trim() ? <button type="submit" className="send" disabled={locked} aria-label="Change the basket">↑</button> : null}
        </form>

        <div className="legs">
          {legs.map((l) => (
            <div key={l.name} className={`leg-row${selected === l.name ? " on" : ""}`}>
              <button className="leg-main" onClick={() => setSelected((s) => (s === l.name ? null : l.name))} aria-pressed={selected === l.name}>
                <span className="leg-logo" style={{ boxShadow: `0 0 0 2px ${SERIES[l.slot] ?? SERIES[0]}` }}>
                  {l.imageUrl && /^https:\/\//.test(l.imageUrl) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="card-thumb" src={l.imageUrl} alt="" />
                  ) : <AssetLogo assetKey={l.assetKey} name={l.name} kind={l.kind} size={34} />}
                </span>
                <span className="leg-text">
                  <span className="leg-top"><b className="mono">{Math.round(l.weight)}%</b> <b>{l.name}</b><span className="muted small" style={{ marginLeft: "auto" }}>{isCardKind(l.kind) ? cardValue(l.insuredValueUsd) : l.kind}</span></span>
                  {l.why ? <span className="muted small">{l.why}</span> : null}
                </span>
              </button>
              <button className="leg-more" aria-label={`More for ${l.name}`} disabled={locked} onClick={() => setMenu(l)}>⋯</button>
            </div>
          ))}
          {legs.length < MAX_PICKS ? <button className="add-pick up" disabled={locked} onClick={() => setPicking(true)}>+ Add a pick</button> : null}
        </div>
        <p className="muted small" style={{ textAlign: "center" }}>You buy in to post. Once it&apos;s live, the take is locked for good.</p>
      </div>

      <div className="cmp-foot">
        {error ? <div className="err">{error}</div> : null}
        <div className="buyin-row">
          <label className="buyin">
            <span className="muted" style={{ fontSize: 11 }}>Buy-in</span>
            <span className="mono">$<input inputMode="decimal" value={buyInText} disabled={locked} aria-label="Buy-in"
              onChange={(e) => { const text = centsInput(e.target.value); setBuyInText(text); setDraft((d) => ({ ...d, buyIn: Number(text) || 0 })); }} /></span>
          </label>
          <button className="obtn filled" style={{ flex: 1 }} disabled={locked || !legs.length} onClick={buyIn}>{checking ? "Checking…" : "Buy in & post"}</button>
        </div>
      </div>

      {menu ? (
        <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && setMenu(null)}>
          <div className="sheet" role="dialog" aria-label={menu.name}>
            <h3>{menu.name}</h3>
            <button className="obtn" style={{ marginTop: 12 }} disabled={legs.length < 2} onClick={() => { setWeighing(menu); setMenu(null); }}>Set weight</button>
            <button className="obtn plain down" disabled={legs.length < 2} onClick={() => { if (selected === menu.name) setSelected(null); change(removing(menu, legs)); setMenu(null); }}>Remove</button>
          </div>
        </div>
      ) : null}
      {weighing ? <WeightSheet leg={weighing} picks={legs.length} onClose={() => setWeighing(null)} onDone={(w) => { change(setting(weighing, w, legs)); setWeighing(null); }} /> : null}
      {picking ? <AssetPicker legs={legs} onClose={() => setPicking(false)} onPick={(a) => { change(adding(a, legs)); setPicking(false); }} /> : null}
      {short && address ? <AddCash address={address} summary={wallet} onClose={() => setShort(false)} onDone={(s) => { setWallet(s); setError(null); setShort(false); }} /> : null}
    </div>
  );
}

function WeightSheet({ leg, picks, onClose, onDone }: { leg: Leg; picks: number; onClose: () => void; onDone: (w: number) => void }) {
  const [w, setW] = useState(Math.round(leg.weight));
  return (
    <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label={`Set weight for ${leg.name}`} style={{ textAlign: "center" }}>
        <b>{leg.name}</b>
        <div className="me-big" style={{ margin: "8px 0" }}>{w}%</div>
        <input type="range" min={1} max={100 - (picks - 1)} step={1} value={w} onChange={(e) => setW(Number(e.target.value))} className="weight-slider" aria-label="Weight" />
        <p className="muted small">The other picks share the rest.</p>
        <button className="obtn filled" onClick={() => onDone(w)}>Done</button>
      </div>
    </div>
  );
}

function AssetPicker({ legs, onClose, onPick }: { legs: Leg[]; onClose: () => void; onPick: (a: PickAsset) => void }) {
  const { assets } = useSession();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Asset[] | null>(null);
  useEffect(() => {
    let live = true;
    const id = window.setTimeout(() => {
      assets<{ assets: Asset[] }>(`search?q=${encodeURIComponent(q.trim())}&limit=20`).then((r) => live && setFound(r.assets)).catch(() => live && setFound([]));
    }, q ? 180 : 0);
    return () => { live = false; window.clearTimeout(id); };
  }, [q, assets]);
  return (
    <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label="Add a pick">
        <button className="x" aria-label="Close" onClick={onClose}>×</button>
        <h3>Add a pick</h3>
        <div className="search-box">
          <input autoFocus placeholder="Ticker, company or idea" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        </div>
        {found == null ? <p className="muted search-empty">Searching…</p> : null}
        {found?.length === 0 ? <p className="muted search-empty">No results.</p> : null}
        {found?.map((a) => {
          const inBasket = legs.some((l) => l.assetKey === a.key || l.assetId === a.id || l.name === a.name);
          return (
            <button key={a.id} className={`arow${a.available ? "" : " unavailable"}`} style={{ width: "100%", textAlign: "left" }} disabled={inBasket || !a.available} onClick={() => onPick(a)}>
              <AssetLogo assetKey={a.key} name={a.name} kind={a.kind} />
              <span className="arow-main"><b>{a.name}</b><span className="muted small">{a.symbol} · {a.kindLabel}</span></span>
              <span className="muted small">{inBasket ? "In your basket" : "+"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Post ----------------------------------------------------------------------------------------

type PostState = { kind: "sending" | "waiting" } | { kind: "live"; id: string } | { kind: "unconfirmed"; id: string } | { kind: "failed"; id: string | null; message: string };

const WALLET_WAIT_MS = 20_000;

function Posting({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const router = useRouter();
  const { social, source } = useSession();
  const { address, wallet, signAndSubmit } = useForkWallet();
  // Signing needs Privy's wallet object, which loads after the address (from the user's linked
  // accounts): ready only when both are there.
  const walletReady = !!address && !!wallet;
  const [state, setState] = useState<PostState>({ kind: "sending" });
  // The take is created once per post: a re-run effect (React's dev double run, a remount, Retry)
  // reuses this promise, so the chain's takeCreated event can only match the one take we publish.
  const created = useRef<Promise<string> | null>(null);
  const takeId = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [discarding, setDiscarding] = useState(false);

  const create = useCallback(async () => {
    const legs = draft.legs ?? [];
    const { topic, tags } = topicGuess(draft.claim, legs);
    const r = await social<{ take: { id: string } }>("POST", "takes", {
      claim: draft.claim.trim(), topic, tags, risk: draft.risk, horizon: draft.horizon, await_chain: true,
      legs: legs.map((l) => ({ name: l.name, kind: l.kind, weight: l.weight, why: l.why, slot: l.slot, fade_how: l.fadeHow, asset_id: l.assetId })),
    });
    // Retry on Me (after closing this, or a reload) sends the same buy-in.
    postingBuyIns.set(r.take.id, draft.buyIn);
    // Credit where it came from; not worth failing the post over.
    if (draft.source) await source("POST", "attach", { take_id: r.take.id, url: draft.source.url, label: draft.source.label, kind: draft.source.kind }).catch(() => {});
    return r.take.id;
  }, [draft, social, source]);

  useEffect(() => {
    let live = true;
    // The Privy wallet can still be loading when you tap Post: wait for it (this effect re-runs
    // when it's ready) and only give up after a while.
    if (!walletReady) {
      setState({ kind: "sending" });
      const t = window.setTimeout(() => { if (live) setState({ kind: "failed", id: takeId.current, message: "Your wallet didn't load. Try again in a moment." }); }, WALLET_WAIT_MS);
      return () => { live = false; window.clearTimeout(t); };
    }
    (async () => {
      try {
        setState({ kind: "sending" });
        if (!created.current) {
          created.current = create();
          // A failed create can be retried; a created take is never created again.
          created.current.catch(() => { created.current = null; });
        }
        const id = await created.current;
        takeId.current = id;
        if (!live) return;
        // The buy-in: required to post. An earlier send that landed is fine.
        await sendBuyIn(id, address!, draft.buyIn, signAndSubmit);
        if (!live) return;
        // Wait for the chain event to make it live; halfway, ask the fork API to deliver it again.
        setState({ kind: "waiting" });
        const r = await waitUntilLive(id, () => live);
        if (r === "live") { postingBuyIns.set(id, null); setState({ kind: "live", id }); }
        else if (r === "unconfirmed") setState({ kind: "unconfirmed", id });
        else if (r === "failed") setState({ kind: "failed", id, message: "Your buy-in didn't go through." });
      } catch (e) {
        if (live) setState({ kind: "failed", id: takeId.current, message: e instanceof Error ? e.message : "Couldn't post your take. Try again." });
      }
    })();
    return () => { live = false; };
    // Retry re-runs this with the same take.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, walletReady]);

  useEffect(() => {
    if (state.kind === "live") {
      // A chat bot's draft now points at your take, so its link opens the live take.
      if (draft.draftId) source("PUT", `drafts/${draft.draftId}`, { take_id: state.id }).catch(() => {});
      const id = window.setTimeout(() => { onClose(); router.push(`/t/${state.id}`); }, 900);
      return () => window.clearTimeout(id);
    }
  }, [state, onClose, router, draft.draftId, source]);

  async function discard() {
    setDiscarding(true);
    if (takeId.current) {
      await social("DELETE", `takes/${takeId.current}`).catch(() => {});
      postingBuyIns.set(takeId.current, null);
    }
    onClose();
  }

  const openMyTakes = () => { onClose(); router.push("/me?tab=takes"); showMyTakes(); };

  return (
    <div className="cmp">
      {/* Closing keeps the take: it goes live once its buy-in lands, and Me shows how it's going. */}
      <Header title="Posting" onClose={state.kind === "live" ? undefined : onClose} />
      <div className="cmp-body posting">
        <div className="take-card"><div className="take-card-claim">{draft.claim}</div><div className="muted small">{money(draft.buyIn)} buy-in</div></div>
        {state.kind === "sending" || state.kind === "waiting" ? (
          <div className="build-status">
            <span className="orb big" aria-hidden />
            <h2>{state.kind === "sending" ? "Sending your buy-in" : "Waiting for the chain"}</h2>
            <p className="muted">Only you can see it until it&apos;s live. This can take up to a minute. You can close this: it keeps posting, and My takes on Me shows how it&apos;s going.</p>
          </div>
        ) : null}
        {state.kind === "live" ? (
          <div className="build-status"><div className="check">✓</div><h2>Your take is live</h2><p className="muted">Opening it…</p></div>
        ) : null}
        {state.kind === "unconfirmed" ? (
          <div className="build-status">
            <h2>It&apos;s on-chain</h2>
            <p className="muted">Your buy-in landed; the take will show up shortly.</p>
          </div>
        ) : null}
        {state.kind === "failed" ? (
          <div className="build-status">
            <h2>Didn&apos;t post</h2>
            <p className="muted">{state.message}</p>
          </div>
        ) : null}
      </div>
      <div className="cmp-foot">
        {state.kind === "unconfirmed" ? <button className="obtn filled" onClick={openMyTakes}>See my takes</button> : null}
        {state.kind === "failed" ? (
          <>
            <button className="obtn filled" onClick={() => setAttempt((a) => a + 1)}>Retry</button>
            {/* No take made (you're already posting this claim, say): the one posting is on Me. */}
            {state.id ? <button className="obtn plain down" disabled={discarding} onClick={discard}>{discarding ? "Discarding…" : "Discard"}</button>
              : <button className="obtn plain" onClick={openMyTakes}>Open My takes</button>}
          </>
        ) : null}
      </div>
    </div>
  );
}
