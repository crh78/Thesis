import React from "react";
import { AbsoluteFill, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Mark } from "./Logo";
import { AssetScene, BadgeScene, LogoScene, OutroScene, ReceiptScene } from "./scenes";
import { C, easeInOut, F, prog, sp } from "./theme";
import { Avatar, Background, Brand, Donut, Headline } from "./ui";

/**
 * Part 2: a walkthrough of the app, one take from start to finish.
 * A phone stays on screen the whole time; the left column says what's happening, step by step,
 * with numbered notes that match highlights on the phone. Steps 1–3 are the real app recording
 * (public/app/take-flow.mp4, "Betting apps are taking over"); the rest are drawn to match it.
 */

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// ── layout ────────────────────────────────────────────────────────────────
const PH = 860; // phone screen height
const PW = Math.round((PH * 1206) / 2622); // screen width, 396
const BEZ = 11;
const PX = 1090; // phone frame left
const SIDE = PX + PW + BEZ * 2 + 30; // cards beside the phone
const PY = (1080 - PH - BEZ * 2) / 2; // phone frame top
const LX = 120; // left column
const LW = 930;

// ── the take ─────────────────────────────────────────────────────────────
const TAKE = "Betting apps are taking over";
const PICKS = [
  { k: "DKNG", n: "DraftKings", kind: "Stock", w: 45 },
  { k: "RDDT", n: "Reddit", kind: "Stock", w: 19 },
  { k: "META", n: "Meta Platforms", kind: "Stock", w: 11 },
  { k: "HOOD", n: "Robinhood", kind: "Stock", w: 25 },
];
const LIVE = 12.4; // return while friends are trading it

// ── chapters ─────────────────────────────────────────────────────────────
type Box = { x: number; y: number; w: number; h: number }; // fractions of the screen
type Note = { at: number; title: string; sub?: string; hl?: Box; until?: number; extra?: React.ReactNode };
type Tap = { at: number; x: number; y: number };
type Chapter = {
  label: string;
  a: string;
  b: string;
  dur: number;
  notes: Note[];
  taps?: Tap[];
  tech: string[];
  Screen?: React.FC<{ dur: number }>;
  Side?: React.FC<{ dur: number }>;
  /** A full-frame scene from the older technical section; the phone steps aside for it. */
  Full?: React.FC<{ dur: number }>;
};

// Steps 1–3 follow the recording: v = seconds into take-flow.mp4.
const V0 = 2.5; // footage starts here (the feed, just before typing)
const FOOT_END = 30.4;

const full = (label: string, dur: number, Full: React.FC<{ dur: number }>): Chapter => ({ label, a: "", b: "", dur, notes: [], tech: [], Full });

const CHAPTERS: Chapter[] = [
  {
    label: "Say it",
    a: "Say it",
    b: "in plain words.",
    dur: 315, // v 2.5 → 13.0
    notes: [
      { at: 12, title: "Type a take, not a ticker.", sub: `“${TAKE}”`, hl: { x: 0.02, y: 0.815, w: 0.96, h: 0.13 }, until: 128 },
      { at: 145, title: "Answer two questions.", sub: "how much risk · how long it runs", hl: { x: 0.02, y: 0.46, w: 0.96, h: 0.28 }, until: 315 },
      { at: 222, title: "Risk decides the instruments.", sub: "low keeps some cash earning interest · high adds leverage" },
    ],
    taps: [{ at: 120, x: 0.93, y: 0.875 }, { at: 210, x: 0.81, y: 0.545 }, { at: 272, x: 0.84, y: 0.67 }, { at: 305, x: 0.5, y: 0.913 }],
    tech: ["Privy wallet made at sign-up", "low → USDC yield on Jupiter Lend", "high → Phoenix perps, up to 5x"],
  },
  {
    label: "Build",
    a: "Thesis builds",
    b: "the basket.",
    dur: 255, // v 13.0 → 21.5
    notes: [
      { at: 4, title: "Reads your take.", sub: "~200 stocks, perps & vaults in a cached prompt" },
      { at: 32, title: "Finds stocks and predictions that match.", sub: "BM25 search over live prediction markets" },
      { at: 62, title: "Checks how closely each one fits.", sub: "and how easy it is to buy", hl: { x: 0.03, y: 0.55, w: 0.94, h: 0.17 }, until: 168 },
      { at: 184, title: "Every pick says why it's in.", sub: "the whole basket in ~2s", hl: { x: 0.02, y: 0.64, w: 0.96, h: 0.27 } },
    ],
    taps: [{ at: 170, x: 0.5, y: 0.913 }],
    tech: ["take builder", "only assets with $50k pooled liquidity and <1% price impact make the cut"],
  },
  {
    label: "Tweak",
    a: "Change it",
    b: "in plain words.",
    dur: 285, // v 21.5 → 30.4, then holds
    notes: [
      { at: 10, title: "Ask for a change.", sub: "“add Robinhood” · “less crypto” · “add AMD”", hl: { x: 0.02, y: 0.592, w: 0.96, h: 0.062 }, until: 138 },
      { at: 140, title: "It rebuilds and reweights.", sub: "3 picks → 4", hl: { x: 0.2, y: 0.19, w: 0.6, h: 0.27 }, until: 278 },
    ],
    taps: [{ at: 82, x: 0.93, y: 0.622 }],
    tech: ["the asset bank routes each asset to its best issuer", "swaps via Jupiter"],
  },
  full("Any asset", 387, AssetScene),
  {
    label: "Buy",
    a: "Buy in.",
    b: "One tap, one transaction.",
    dur: 360,
    notes: [
      { at: 10, title: "Set an amount, tap Buy in & post.", sub: "$25 here" },
      { at: 64, title: "Your wallet signs once.", sub: "every pick swaps together · Thesis never holds your money", hl: { x: 0.03, y: 0.5, w: 0.94, h: 0.3 }, until: 168 },
      { at: 186, title: "A receipt is frozen on Solana.", sub: "same transaction as the swaps · no edits, no deletes", hl: { x: 0.04, y: 0.8, w: 0.92, h: 0.12 } },
    ],
    taps: [{ at: 28, x: 0.66, y: 0.915 }],
    tech: ["Privy embedded wallet", "Jupiter swaps + receipt in one Solana transaction", "the program never holds funds"],
    Screen: ({ dur }) => <BuyScreen dur={dur} />,
  },
  {
    label: "Trade",
    a: "Friends trade it",
    b: "or fade it.",
    dur: 390,
    notes: [
      { at: 10, title: "Your take lands in friends' feeds.", sub: "it's live: anyone can see the return" },
      { at: 80, title: "Trade it to ride along. Fade it if it's wrong.", hl: { x: 0.03, y: 0.895, w: 0.94, h: 0.08 }, until: 230 },
      { at: 236, title: "Every trade or fade pays you.", sub: "5 bps of the 10 bps fee goes to the author", hl: { x: 0.03, y: 0.06, w: 0.94, h: 0.1 } },
    ],
    taps: [],
    tech: ["fees live in an on-chain config, not in code"],
    Screen: ({ dur }) => <TakeScreen dur={dur} />,
  },
  {
    label: "Chats",
    a: "No app open?",
    b: "Say it in the group chat.",
    dur: 270,
    notes: [
      { at: 10, title: "Tag @thesis in any group chat." },
      { at: 92, title: "It drafts the take in the thread.", sub: "3 picks · medium risk · 6 months" },
      { at: 172, title: "Tap to post. Only from your wallet.", hl: { x: 0.04, y: 0.637, w: 0.73, h: 0.058 }, until: 262 },
    ],
    taps: [{ at: 186, x: 0.4, y: 0.667 }],
    tech: ["iMessage bot on BlueBubbles", "a draft goes live only from the tapper's own wallet"],
    Screen: ({ dur }) => <ChatScreen dur={dur} />,
  },
  {
    label: "X",
    a: "Or tag it",
    b: "on X.",
    dur: 300,
    notes: [
      { at: 10, title: "Mention @yourthesisxyz in any post." },
      { at: 80, title: "It replies with a draft.", sub: "the bot vets every mention first", hl: { x: 0.02, y: 0.335, w: 0.96, h: 0.4 }, until: 160 },
      { at: 166, title: "Tap to post and trade it.", sub: "from your own wallet, like everywhere else" },
    ],
    taps: [{ at: 178, x: 0.55, y: 0.565 }],
    tech: ["X bot live on @yourthesisxyz", "mentions vetted before it replies"],
    Screen: ({ dur }) => <XScreen dur={dur} />,
  },
  {
    label: "Copy",
    a: "Copy the people",
    b: "you trust.",
    dur: 330,
    notes: [
      { at: 10, title: "Copy anyone on X.", sub: "@macromike, for example" },
      { at: 64, title: "Their next call arrives as your draft.", hl: { x: 0.03, y: 0.33, w: 0.94, h: 0.15 }, until: 120 },
      { at: 150, title: "You tap to buy in.", sub: "it never trades for you" },
    ],
    taps: [{ at: 104, x: 0.5, y: 0.4 }],
    tech: ["followed accounts checked every 15 min", "each call → a drafted take + a notification"],
    Screen: ({ dur }) => <CopyScreen dur={dur} />,
    Side: ({ dur }) => <MikeSide dur={dur} />,
  },
  full("Cards", 185, ReceiptScene),
  full("Badges", 150, BadgeScene),
];

const STARTS: number[] = [];
CHAPTERS.forEach((c, i) => STARTS.push(i === 0 ? 0 : STARTS[i - 1] + CHAPTERS[i - 1].dur));
const WALK = STARTS[STARTS.length - 1] + CHAPTERS[CHAPTERS.length - 1].dur;
const LOGO = 110;
const OUTRO = 180;
export const GUIDE = LOGO + WALK + OUTRO;
const STEPS = CHAPTERS.filter((c) => !c.Full).length;
const stepOf = (i: number) => CHAPTERS.slice(0, i + 1).filter((c) => !c.Full).length;
/** Frames where the real recording is on the phone. */
const REAL_END = STARTS[CHAPTERS.findIndex((c) => c.Full)];
/** Spans where the phone steps aside (runs of full-frame scenes) and the end. */
const AWAY: [number, number][] = [];
CHAPTERS.forEach((c, i) => {
  if (!c.Full) return;
  const last = AWAY[AWAY.length - 1];
  if (last && last[1] === STARTS[i]) last[1] = STARTS[i] + c.dur;
  else AWAY.push([STARTS[i], STARTS[i] + c.dur]);
});

// ── left column ──────────────────────────────────────────────────────────

const NoteRow: React.FC<{ n: number; note: Note; live: boolean }> = ({ n, note, live }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = sp(f, fps, note.at, 20);
  if (f < note.at) return null;
  return (
    <div style={{ display: "flex", gap: 20, opacity: s * (live ? 1 : 0.62), transform: `translateY(${(1 - s) * 18}px)` }}>
      <div style={{ width: 38, height: 38, borderRadius: 19, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.mono, fontSize: 18, fontWeight: 600, color: live ? "#06210F" : C.text, background: live ? C.trade : "rgba(255,255,255,0.08)", marginTop: 1 }}>{n}</div>
      <div>
        <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 31, color: C.text, lineHeight: 1.25 }}>{note.title}</div>
        {note.sub ? <div style={{ fontFamily: F.mono, fontSize: 18, color: C.muted, marginTop: 6 }}>{note.sub}</div> : null}
        {note.extra}
      </div>
    </div>
  );
};

/** The mono technical line along the bottom of the left column. */
const TechLine: React.FC<{ items: string[]; delay?: number }> = ({ items, delay = 30 }) => {
  const f = useCurrentFrame();
  const full = items.join("  ·  ");
  const n = Math.floor(interpolate(f, [delay, delay + full.length * 0.4], [0, full.length], clamp));
  return (
    <div style={{ position: "absolute", left: LX, top: 968, width: LW, display: "flex", gap: 14, fontFamily: F.mono, fontSize: 17, color: C.muted, opacity: f > delay ? 1 : 0 }}>
      <div style={{ width: 8, height: 8, borderRadius: 2, marginTop: 7, flexShrink: 0, background: C.trade, opacity: 0.55 + 0.45 * Math.sin(f / 6), boxShadow: `0 0 12px ${C.trade}` }} />
      <div style={{ lineHeight: 1.5 }}>{full.slice(0, n)}</div>
    </div>
  );
};

const ChapterText: React.FC<{ c: Chapter; i: number }> = ({ c, i }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 12, c.dur - 10, c.dur], [0, 1, 1, 0], clamp);
  const live = c.notes.filter((n) => f >= n.at).length - 1;
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <div style={{ position: "absolute", left: LX, top: 172, fontFamily: F.mono, fontSize: 18, letterSpacing: 2, color: C.trade }}>STEP {String(stepOf(i)).padStart(2, "0")} / {String(STEPS).padStart(2, "0")}</div>
      <Headline a={c.a} b={c.b} x={LX} y={212} size={76} />
      <div style={{ position: "absolute", left: LX, top: 438, width: LW, display: "flex", flexDirection: "column", gap: 30 }}>
        {c.notes.map((n, j) => <NoteRow key={j} n={j + 1} note={n} live={j === live} />)}
      </div>
      <TechLine items={c.tech} />
    </AbsoluteFill>
  );
};

// ── phone overlays ───────────────────────────────────────────────────────

/** Spotlight: the rest of the screen dims, with a thin outline just outside the area, so nothing covers it. */
const Highlight: React.FC<{ box: Box; at: number; until: number }> = ({ box, at, until }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [at, at + 10, until - 10, until], [0, 1, 1, 0], clamp);
  if (o <= 0) return null;
  const pad = 5;
  return (
    <>
      <div style={{ position: "absolute", left: box.x * PW, top: box.y * PH, width: box.w * PW, height: box.h * PH, borderRadius: 12, boxShadow: `0 0 0 ${PH * 2}px rgba(0,0,0,${0.52 * o})` }} />
      <div style={{ position: "absolute", left: box.x * PW - pad, top: box.y * PH - pad, width: box.w * PW + pad * 2, height: box.h * PH + pad * 2, borderRadius: 15, boxSizing: "border-box", border: `1.5px solid ${C.trade}`, opacity: o * 0.85, boxShadow: `0 0 14px ${C.trade}55` }} />
    </>
  );
};

const TapRipple: React.FC<{ t: Tap }> = ({ t }) => {
  const f = useCurrentFrame();
  const d = f - t.at;
  if (d < -6 || d > 22) return null;
  const press = interpolate(d, [-6, 0, 6], [0, 1, 0], clamp);
  const ring = prog(d, 0, 20);
  return (
    <div style={{ position: "absolute", left: t.x * PW, top: t.y * PH }}>
      <div style={{ position: "absolute", left: -18, top: -18, width: 36, height: 36, borderRadius: 18, background: "rgba(255,255,255,0.55)", opacity: press, transform: `scale(${0.7 + 0.3 * press})` }} />
      <div style={{ position: "absolute", left: -18, top: -18, width: 36, height: 36, borderRadius: 18, border: "2px solid rgba(255,255,255,0.8)", opacity: d >= 0 ? 1 - ring : 0, transform: `scale(${1 + ring * 1.6})` }} />
    </div>
  );
};

/** The recording for steps 1–3, then its last frame held. */
const Footage: React.FC = () => (
  <AbsoluteFill>
    <Img src={staticFile("app/take-flow-last.png")} style={{ width: PW, height: PH }} />
    <Sequence durationInFrames={Math.round((FOOT_END - V0) * 30)}>
      <OffthreadVideo src={staticFile("app/take-flow.mp4")} trimBefore={Math.round(V0 * 30)} muted style={{ width: PW, height: PH }} />
    </Sequence>
  </AbsoluteFill>
);

const Phone: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const w = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = sp(w, fps, 0, 22);
  const away = Math.max(0, ...AWAY.map(([a, b]) => prog(w, a - 8, a + 14, easeInOut) * (1 - (b >= WALK ? 0 : prog(w, b - 14, b + 8, easeInOut)))));
  const tilt = -5 + 1.5 * Math.sin(w / 70);
  const real = interpolate(w, [10, 26, REAL_END - 20, REAL_END - 6], [0, 1, 1, 0], clamp);
  return (
    <div style={{ position: "absolute", left: PX, top: PY, transform: `translateX(${(1 - enter) * 500 + away * 700}px) perspective(1800px) rotateY(${tilt}deg)`, opacity: Math.min(enter * 1.5, 1) * (1 - away) }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: -44, display: "flex", justifyContent: "center", opacity: real }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 14px", borderRadius: 999, background: "rgba(255,255,255,0.06)", border: `1px solid ${C.hair}`, fontFamily: F.mono, fontSize: 14, letterSpacing: 1.2, color: C.text }}>
          <div style={{ width: 8, height: 8, borderRadius: 4, background: "#FF453A", opacity: 0.6 + 0.4 * Math.sin(w / 5), boxShadow: "0 0 8px #FF453A" }} />
          REAL APP · SCREEN RECORDING
        </div>
      </div>
      <div style={{ width: PW + BEZ * 2, height: PH + BEZ * 2, borderRadius: PH * 0.075, padding: BEZ, boxSizing: "border-box", background: "linear-gradient(145deg,#2a2d33,#0d0e11)", boxShadow: "0 50px 120px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.08), 0 0 90px rgba(130,150,255,0.13)" }}>
        <div style={{ position: "relative", width: PW, height: PH, borderRadius: PH * 0.066, overflow: "hidden", background: "#0B0C10" }}>{children}</div>
      </div>
    </div>
  );
};

// ── drawn screens (PW × PH px, about iOS points) ─────────────────────────

const ui = { bg: "#0B0C10", card: "#15161B", line: "rgba(255,255,255,0.08)" };

const Status: React.FC = () => (
  <>
    <div style={{ position: "absolute", top: 11, left: PW / 2 - 60, width: 120, height: 34, borderRadius: 17, background: "#000", zIndex: 5 }} />
    <div style={{ position: "absolute", top: 18, left: 34, right: 30, display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: F.sans, fontWeight: 600, fontSize: 16, color: "#fff", zIndex: 4 }}>
      <span>9:41</span>
      <div style={{ display: "flex", gap: 5, alignItems: "flex-end" }}>
        {[5, 7, 9, 11].map((h) => <div key={h} style={{ width: 3, height: h, borderRadius: 1, background: "#fff" }} />)}
        <div style={{ marginLeft: 5, width: 24, height: 11, borderRadius: 3, border: "1.5px solid rgba(255,255,255,0.6)", padding: 1.5, boxSizing: "border-box" }}><div style={{ width: "80%", height: "100%", borderRadius: 1, background: C.trade }} /></div>
      </div>
    </div>
  </>
);

const Nav: React.FC<{ title?: string; right?: string }> = ({ title, right }) => (
  <div style={{ position: "absolute", top: 58, left: 16, right: 16, height: 40, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
    <div style={{ width: 36, height: 36, borderRadius: 18, background: "rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center", color: C.text, fontFamily: F.sans, fontSize: 20 }}>‹</div>
    <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 16, color: C.text }}>{title}</div>
    <div style={{ width: 36, fontFamily: F.sans, fontSize: 13, color: C.muted, textAlign: "right" }}>{right}</div>
  </div>
);

const Spinner: React.FC<{ size?: number }> = ({ size = 16 }) => {
  const f = useCurrentFrame();
  return <div style={{ width: size, height: size, borderRadius: size, border: `2px solid ${C.hair}`, borderTopColor: C.text, transform: `rotate(${f * 18}deg)` }} />;
};
const Check: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <div style={{ width: size, height: size, borderRadius: size, background: C.trade, color: "#06210F", fontSize: size * 0.62, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.sans }}>✓</div>
);

const PickLine: React.FC<{ p: (typeof PICKS)[number]; i: number; right: React.ReactNode; o?: number }> = ({ p, i, right, o = 1 }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, opacity: o }}>
    <div style={{ width: 8, height: 8, borderRadius: 2, background: C.picks[i] }} />
    <Brand k={p.k} size={24} />
    <div style={{ flex: 1 }}>
      <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 15, color: C.text }}>{p.n}</div>
      <div style={{ fontFamily: F.sans, fontSize: 11.5, color: C.muted }}>{p.kind} · {p.w}%</div>
    </div>
    {right}
  </div>
);

/** Step 4: Buy in & post → a sheet that buys every pick in one go → the on-chain receipt. */
const BuyScreen: React.FC<{ dur: number }> = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sheet = sp(f, fps, 40, 24);
  const done = (i: number) => f >= 92 + i * 10;
  const posted = f >= 140;
  const rec = prog(f, 168, 184);
  return (
    <AbsoluteFill>
      <Img src={staticFile("app/take-flow-last.png")} style={{ width: PW, height: PH, filter: `brightness(${1 - sheet * 0.5})` }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: PH * 0.6, transform: `translateY(${(1 - sheet) * PH * 0.62}px)`, background: "#121318", borderTopLeftRadius: 30, borderTopRightRadius: 30, borderTop: `1px solid ${ui.line}`, padding: "12px 22px", boxSizing: "border-box" }}>
        <div style={{ width: 40, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.2)", margin: "0 auto 18px" }} />
        <div style={{ fontFamily: F.serif, fontSize: 28, color: C.text }}>Buy in · $25</div>
        <div style={{ fontFamily: F.mono, fontSize: 12, color: C.muted, marginTop: 4 }}>4 PICKS · ONE TRANSACTION</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 20 }}>
          {PICKS.map((p, i) => (
            <PickLine key={p.k} p={p} i={i} right={
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: F.mono, fontSize: 14, color: C.text }}>${((25 * p.w) / 100).toFixed(2)}</span>
                {done(i) ? <Check /> : <Spinner />}
              </div>
            } />
          ))}
        </div>
        <div style={{ marginTop: 24, height: 50, borderRadius: 25, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontFamily: F.sans, fontWeight: 600, fontSize: 16, background: posted ? "linear-gradient(90deg,#BDEDCB,#97DBAB)" : "rgba(255,255,255,0.07)", color: posted ? "#06210F" : C.text }}>
          {posted ? "Posted · your take is live" : <><Spinner size={14} /> Signing with your wallet…</>}
        </div>
      </div>
      <AbsoluteFill style={{ opacity: rec, background: ui.bg }}>
        <Receipt />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Receipt: React.FC = () => {
  const f = useCurrentFrame();
  const stat = (k: string, v: string) => (
    <div style={{ flex: 1 }}>
      <div style={{ fontFamily: F.sans, fontSize: 11.5, color: C.muted }}>{k}</div>
      <div style={{ fontFamily: F.mono, fontWeight: 600, fontSize: 16, color: C.text, marginTop: 2 }}>{v}</div>
    </div>
  );
  return (
    <AbsoluteFill>
      <Status />
      <Nav title="Receipt" />
      <div style={{ position: "absolute", top: 118, left: 22, right: 22 }}>
        <div style={{ fontFamily: F.mono, fontSize: 11.5, letterSpacing: 1.5, color: C.trade }}>ON-CHAIN RECEIPT</div>
        <div style={{ fontFamily: F.serif, fontSize: 27, color: C.text, marginTop: 8, lineHeight: 1.15 }}>{TAKE}</div>
        <div style={{ fontFamily: F.sans, fontSize: 13, color: C.muted, marginTop: 6 }}>@dev · High risk · 6 months · settles May 19</div>
        <div style={{ display: "flex", marginTop: 20, padding: "14px 0", borderTop: `1px solid ${ui.line}`, borderBottom: `1px solid ${ui.line}` }}>
          {stat("You put in", "$25.00")}
          {stat("Picks", "4")}
          {stat("Fee", "$0.03")}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 18 }}>
          {PICKS.map((p, i) => <PickLine key={p.k} p={p} i={i} o={prog(f, 184 + i * 5, 196 + i * 5)} right={<span style={{ fontFamily: F.mono, fontSize: 14, color: C.text }}>${((25 * p.w) / 100).toFixed(2)}</span>} />)}
        </div>
      </div>
      <div style={{ position: "absolute", left: 22, right: 22, top: PH * 0.81, padding: "12px 14px", borderRadius: 14, background: ui.card, border: `1px solid ${ui.line}`, opacity: prog(f, 200, 214) }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: F.mono, fontSize: 12.5, color: C.muted }}>
          <span>Solana · confirmed</span>
          <span style={{ color: C.text }}>4mZq…8Vbe ↗</span>
        </div>
        <div style={{ fontFamily: F.sans, fontSize: 13, color: C.text, marginTop: 6 }}>🔒 Frozen: no edits, no deletes.</div>
      </div>
    </AbsoluteFill>
  );
};

const Banner: React.FC<{ at: number; app?: string; title: string; body: string; top?: number; leave?: number }> = ({ at, app = "THESIS", title, body, top = 52, leave }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = sp(f, fps, at, 20);
  const out = leave ? prog(f, leave, leave + 10) : 0;
  if (f < at) return null;
  return (
    <div style={{ position: "absolute", left: 10, right: 10, top, zIndex: 6, padding: "11px 13px", borderRadius: 20, display: "flex", gap: 11, alignItems: "center", background: "rgba(48,51,60,0.94)", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 12px 30px rgba(0,0,0,0.5)", transform: `translateY(${(1 - s) * -90 - out * 90}px)`, opacity: 1 - out }}>
      <div style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, background: app === "X" ? "#000" : ui.bg, border: "1px solid rgba(255,255,255,0.14)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {app === "X" ? <span style={{ color: "#fff", fontFamily: F.sans, fontWeight: 700, fontSize: 18 }}>𝕏</span> : <div style={{ transform: "scale(0.3)" }}><Mark size={90} /></div>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: F.sans, fontSize: 11, color: "rgba(255,255,255,0.55)" }}><span>{app}</span><span>now</span></div>
        <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 14, color: "#fff", marginTop: 1 }}>{title}</div>
        <div style={{ fontFamily: F.sans, fontSize: 12.5, color: "rgba(255,255,255,0.75)", marginTop: 1, lineHeight: 1.3 }}>{body}</div>
      </div>
    </div>
  );
};

/** Step 5: the live take page, friends trading and fading it, comments, author fees. */
const TakeScreen: React.FC<{ dur: number }> = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ret = interpolate(f, [20, 200], [0, LIVE], { ...clamp, easing: easeInOut });
  const trades = Math.round(interpolate(f, [60, 300], [0, 87], clamp));
  const fades = Math.round(interpolate(f, [90, 300], [0, 12], clamp));
  const w = PW - 44, h = 130;
  const pts = Array.from({ length: 48 }, (_, i) => {
    const t = i / 47;
    return [t * w, h * 0.72 - t * h * 0.5 + Math.sin(i * 0.9) * 7 + Math.sin(i * 0.31) * 9];
  });
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const comments = [
    { n: 0 as const, who: "maya", side: "TRADED", c: C.up, text: "every ad during the game is a sportsbook" },
    { n: 1 as const, who: "kai", side: "FADED", c: C.down, text: "regulators are coming for this" },
    { n: 0 as const, who: "dre", side: "TRADED", c: C.up, text: "my grandma has a parlay now 😭" },
  ];
  return (
    <AbsoluteFill style={{ background: ui.bg }}>
      <Status />
      <Nav right="↗" />
      <div style={{ position: "absolute", top: 108, left: 22, right: 22 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Avatar n={1} size={28} />
          <span style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 14, color: C.text }}>dev</span>
          <span style={{ fontFamily: F.sans, fontSize: 13, color: C.muted }}>@dev · you</span>
        </div>
        <div style={{ fontFamily: F.serif, fontSize: 30, color: C.text, marginTop: 12, lineHeight: 1.12 }}>{TAKE}</div>
        <div style={{ fontFamily: F.mono, fontSize: 10.5, color: C.muted, marginTop: 10, letterSpacing: 0.6 }}>HIGH RISK · 6MO · 4 PICKS · {comments.filter((_, i) => f >= 140 + i * 30).length} COMMENTS</div>
        <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 38, color: C.up, marginTop: 10 }}>+{ret.toFixed(1)}%</div>
        <div style={{ fontFamily: F.mono, fontSize: 11, color: C.muted }}>since posted</div>
        <svg width={w} height={h} style={{ marginTop: 6 }}>
          <line x1={0} x2={w} y1={h * 0.72} y2={h * 0.72} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 4" />
          <path d={d} fill="none" stroke={C.up} strokeWidth={2.5} strokeLinecap="round" pathLength={1} strokeDasharray={`${prog(f, 14, 200)} 1`} />
        </svg>
        <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
          {PICKS.map((p) => <Brand key={p.k} k={p.k} size={20} />)}
          <span style={{ fontFamily: F.sans, fontSize: 12, color: C.muted, marginLeft: 4 }}>DraftKings, Reddit +2</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          {comments.map((c, i) => {
            const s = sp(f, fps, 140 + i * 30, 20);
            if (f < 140 + i * 30) return null;
            return (
              <div key={c.who} style={{ display: "flex", gap: 9, opacity: s, transform: `translateY(${(1 - s) * 12}px)` }}>
                <Avatar n={c.n} size={24} />
                <div>
                  <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                    <span style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 12.5, color: C.text }}>@{c.who}</span>
                    <span style={{ fontFamily: F.mono, fontSize: 9, color: c.c, border: `1px solid ${c.c}66`, borderRadius: 4, padding: "1px 4px" }}>{c.side}</span>
                  </div>
                  <div style={{ fontFamily: F.sans, fontSize: 13, color: C.text, marginTop: 2 }}>{c.text}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ position: "absolute", left: 14, right: 14, top: PH * 0.9, display: "flex", gap: 10 }}>
        <div style={{ width: 110, height: 48, borderRadius: 24, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.sans, fontWeight: 600, fontSize: 15, color: "#330A1A", background: "linear-gradient(90deg,#F8C8D8,#EFA5C0)" }}>↘ Fade {fades}</div>
        <div style={{ flex: 1, height: 48, borderRadius: 24, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.sans, fontWeight: 600, fontSize: 15, color: "#06210F", background: "linear-gradient(90deg,#BDEDCB,#97DBAB)" }}>↗ Trade this take · {trades}</div>
      </div>
      <Banner at={96} title="Maya traded your take" body="$50 · you're up 4.1% together" leave={170} />
      <Banner at={236} title="You earned $18.40 in author fees" body="87 trades and 12 fades so far" />
    </AbsoluteFill>
  );
};

const Bubble: React.FC<{ at: number; who?: string; me?: boolean; children: React.ReactNode }> = ({ at, who, me, children }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = sp(f, fps, at, 18);
  if (f < at) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: me ? "flex-end" : "flex-start", opacity: s, transform: `translateY(${(1 - s) * 12}px) scale(${0.96 + 0.04 * s})`, transformOrigin: me ? "right bottom" : "left bottom" }}>
      {who ? <div style={{ fontFamily: F.sans, fontSize: 11, color: C.muted, margin: "0 12px 3px" }}>{who}</div> : null}
      <div style={{ maxWidth: 290, padding: "9px 13px", borderRadius: 18, fontFamily: F.sans, fontSize: 15, lineHeight: 1.3, color: "#fff", background: me ? "#0A84FF" : "#26272B" }}>{children}</div>
    </div>
  );
};

const MiniDraft: React.FC<{ title: string; picks: { k: string; w: number }[]; meta: string; button: React.ReactNode }> = ({ title, picks, meta, button }) => (
  <div style={{ marginTop: 8, width: 264, borderRadius: 14, overflow: "hidden", background: "#0F1014", border: `1px solid ${C.hair}` }}>
    <div style={{ padding: 12, display: "flex", gap: 11, alignItems: "center" }}>
      <Donut weights={picks.map((p) => p.w)} size={54} stroke={7} />
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: F.mono, fontSize: 9, color: C.muted, letterSpacing: 0.8 }}>{meta}</div>
        <div style={{ fontFamily: F.serif, fontSize: 16, color: C.text, marginTop: 3, lineHeight: 1.15 }}>{title}</div>
        <div style={{ display: "flex", gap: 5, marginTop: 6 }}>{picks.map((p) => <Brand key={p.k} k={p.k} size={18} />)}</div>
      </div>
    </div>
    {button}
  </div>
);

const SPORTS = [{ k: "DKNG", w: 40 }, { k: "META", w: 35 }, { k: "RDDT", w: 25 }];

/** Step 6: the iMessage group chat; @thesis drafts a take, you post it. */
const ChatScreen: React.FC<{ dur: number }> = () => {
  const f = useCurrentFrame();
  const posted = f >= 190;
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Status />
      <div style={{ position: "absolute", top: 54, left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center", paddingBottom: 10, borderBottom: "1px solid #1C1C1E" }}>
        <div style={{ display: "flex" }}><Avatar n={0} size={34} /><div style={{ marginLeft: -10 }}><Avatar n={1} size={34} /></div></div>
        <div style={{ fontFamily: F.sans, fontSize: 12, color: C.text, marginTop: 4 }}>the group chat ›</div>
      </div>
      <div style={{ position: "absolute", top: 128, left: 12, right: 12, display: "flex", flexDirection: "column", gap: 9 }}>
        <Bubble at={8} who="Kai">every ad during the game was a betting app</Bubble>
        <Bubble at={30} who="Maya">they're paying for the whole super bowl lol</Bubble>
        <Bubble at={58} me>@thesis sportsbooks are eating the ad market</Bubble>
        <Bubble at={92} who="Thesis">
          Built it: 3 picks, medium risk, 6 months.
          <MiniDraft title="Sportsbooks are eating the ad market" picks={SPORTS} meta="DRAFT TAKE · 3 PICKS · MED · 6MO" button={
            <div style={{ padding: "9px 12px", fontFamily: F.sans, fontWeight: 600, fontSize: 13, color: "#06210F", background: posted ? C.trade : "linear-gradient(90deg,#BDEDCB,#97DBAB)" }}>{posted ? "✓ Posted from your wallet" : "Post & trade it →"}</div>
          } />
        </Bubble>
        <Bubble at={226} who="Maya">trading it 🫡</Bubble>
      </div>
    </AbsoluteFill>
  );
};

/** The X step: you mention @yourthesisxyz, the bot replies with a draft, you post it. */
const XScreen: React.FC<{ dur: number }> = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const posted = f >= 180;
  const r = sp(f, fps, 70, 20);
  const m = sp(f, fps, 224, 20);
  const who = (name: string, handle: string, extra = "") => (
    <div style={{ fontFamily: F.sans, fontSize: 14 }}><b style={{ color: C.text }}>{name}</b> <span style={{ color: C.muted }}>{handle}{extra}</span></div>
  );
  const ThesisAv = () => (
    <div style={{ width: 38, height: 38, borderRadius: 19, flexShrink: 0, background: "#0F1014", border: `1px solid ${C.hair}`, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}><div style={{ transform: "scale(0.32)" }}><Mark size={90} /></div></div>
  );
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Status />
      <Nav title="Post" />
      <div style={{ position: "absolute", top: 112, left: 16, right: 16 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", opacity: prog(f, 4, 16) }}>
          <Avatar n={1} size={38} />
          {who("dev", "@dev")}
        </div>
        <div style={{ fontFamily: F.sans, fontSize: 19, color: C.text, marginTop: 10, lineHeight: 1.3, opacity: prog(f, 4, 16) }}>prediction markets will be bigger than sportsbooks <span style={{ color: "#1D9BF0" }}>@yourthesisxyz</span></div>
        <div style={{ fontFamily: F.sans, fontSize: 12.5, color: C.muted, marginTop: 10, paddingBottom: 12, borderBottom: "1px solid #2F3336" }}>9:41 AM · Nov 20 · <b style={{ color: C.text }}>48</b> Likes</div>
        {f >= 70 ? (
          <div style={{ display: "flex", gap: 10, marginTop: 14, opacity: r, transform: `translateY(${(1 - r) * 14}px)` }}>
            <ThesisAv />
            <div style={{ flex: 1 }}>
              {who("Thesis", "@yourthesisxyz", " · now")}
              <div style={{ fontFamily: F.sans, fontSize: 12.5, color: C.muted, marginTop: 1 }}>Replying to <span style={{ color: "#1D9BF0" }}>@dev</span></div>
              <div style={{ fontFamily: F.sans, fontSize: 15, color: C.text, marginTop: 6, lineHeight: 1.3 }}>Built it: 3 picks, high risk, 12 months. Tap to trade it with your own wallet.</div>
              <MiniDraft title="Prediction markets beat sportsbooks" picks={[{ k: "KALSHI", w: 40 }, { k: "POLYMARKET", w: 35 }, { k: "COIN", w: 25 }]} meta="DRAFT · 3 PICKS · HIGH · 12MO" button={
                <div style={{ padding: "9px 12px", fontFamily: F.sans, fontWeight: 600, fontSize: 13, color: "#06210F", background: posted ? C.trade : "linear-gradient(90deg,#BDEDCB,#97DBAB)" }}>{posted ? "✓ Posted from your wallet" : "Post & trade it →"}</div>
              } />
            </div>
          </div>
        ) : null}
        {f >= 224 ? (
          <div style={{ display: "flex", gap: 10, marginTop: 16, paddingTop: 12, borderTop: "1px solid #2F3336", opacity: m, transform: `translateY(${(1 - m) * 14}px)` }}>
            <Avatar n={0} size={38} />
            <div>
              {who("maya", "@maya", " · now")}
              <div style={{ fontFamily: F.sans, fontSize: 15, color: C.text, marginTop: 4 }}>trading this 🫡</div>
            </div>
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

const LockScreen: React.FC<{ date: string; children?: React.ReactNode }> = ({ date, children }) => (
  <AbsoluteFill style={{ background: "linear-gradient(180deg,#1B2340 0%,#0B0D16 60%,#07080B)" }}>
    <Status />
    <div style={{ position: "absolute", top: 70, width: "100%", textAlign: "center", fontFamily: F.sans, fontSize: 15, fontWeight: 600, color: "rgba(255,255,255,0.8)" }}>{date}</div>
    <div style={{ position: "absolute", top: 88, width: "100%", textAlign: "center", fontFamily: F.sans, fontWeight: 600, fontSize: 92, color: "#fff", letterSpacing: -2 }}>9:41</div>
    {children}
  </AbsoluteFill>
);

const GOLD = [{ k: "GOLD", n: "Gold", w: 60 }, { k: "SILVER", n: "Silver", w: 25 }, { k: "USDC", n: "Cash", w: 15 }];

/** Step 7: a call from someone you copy arrives as a draft. */
const CopyScreen: React.FC<{ dur: number }> = () => {
  const f = useCurrentFrame();
  const open = prog(f, 112, 128);
  return (
    <AbsoluteFill>
      <LockScreen date="Thursday, December 3">
        <Banner at={52} title="New call from @macromike" body="“Gold has its best year since 1979.” Drafted for you. Tap to buy in." top={PH * 0.34} />
      </LockScreen>
      <AbsoluteFill style={{ opacity: open, background: ui.bg, zIndex: 10 }}>
        <Status />
        <Nav title="Draft" />
        <div style={{ position: "absolute", top: 118, left: 22, right: 22 }}>
          <div style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: 1.2, color: C.aurora }}>FROM @MACROMIKE · DRAFT</div>
          <div style={{ fontFamily: F.serif, fontSize: 28, color: C.text, marginTop: 8, lineHeight: 1.15 }}>Gold has its best year since 1979</div>
          <div style={{ display: "flex", justifyContent: "center", margin: "26px 0" }}>
            <Donut weights={GOLD.map((g) => g.w)} size={180} progress={prog(f, 124, 160)}>
              <div style={{ fontFamily: F.sans, fontWeight: 700, fontSize: 40, color: C.text }}>3</div>
              <div style={{ fontFamily: F.sans, fontSize: 11, color: C.muted }}>picks</div>
            </Donut>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {GOLD.map((g, i) => (
              <div key={g.k} style={{ display: "flex", alignItems: "center", gap: 10, opacity: prog(f, 136 + i * 6, 148 + i * 6) }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: C.picks[i] }} />
                <Brand k={g.k} size={24} />
                <div style={{ flex: 1, fontFamily: F.sans, fontWeight: 600, fontSize: 15, color: C.text }}>{g.n}</div>
                <div style={{ fontFamily: F.mono, fontSize: 14, color: C.text }}>{g.w}%</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ position: "absolute", left: 14, right: 14, top: PH * 0.86, opacity: prog(f, 150, 164) }}>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ width: 96, height: 48, borderRadius: 24, background: "rgba(255,255,255,0.08)", display: "flex", flexDirection: "column", justifyContent: "center", paddingLeft: 16 }}>
              <div style={{ fontFamily: F.sans, fontSize: 10, color: C.muted }}>Buy-in</div>
              <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 16, color: C.text }}>$25</div>
            </div>
            <div style={{ flex: 1, height: 48, borderRadius: 24, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F.sans, fontWeight: 600, fontSize: 15, color: "#06210F", background: "linear-gradient(90deg,#BDEDCB,#97DBAB)" }}>Buy in</div>
          </div>
          <div style={{ textAlign: "center", fontFamily: F.sans, fontSize: 11.5, color: C.muted, marginTop: 8 }}>Nothing trades until you tap.</div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Step 7, beside the phone: the X post the draft came from. */
const MikeSide: React.FC<{ dur: number }> = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = sp(f, fps, 10, 20);
  const line = prog(f, 30, 52);
  return (
    <div style={{ position: "absolute", left: SIDE, top: 230, opacity: a, transform: `translateX(${(1 - a) * 80}px)` }}>
      <div style={{ width: 340, padding: 18, borderRadius: 18, background: "rgba(0,0,0,0.92)", border: "1px solid #2F3336", boxShadow: "0 30px 70px rgba(0,0,0,0.6)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: F.sans, fontSize: 14 }}><b style={{ color: C.text }}>Macro Mike</b> <span style={{ color: C.muted }}>@macromike</span></div>
          <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 11, color: "#06210F", background: C.trade, borderRadius: 999, padding: "4px 10px" }}>Copying</div>
        </div>
        <div style={{ fontFamily: F.sans, fontSize: 17, color: C.text, marginTop: 10, lineHeight: 1.35 }}>Gold is about to have its best year since 1979.</div>
      </div>
      <div style={{ marginLeft: 40, width: 2, height: 90 * line, background: `linear-gradient(180deg, ${C.hair}, ${C.trade})` }} />
      <div style={{ marginLeft: 26, fontFamily: F.mono, fontSize: 13, color: C.trade, opacity: line }}>→ drafted in Thesis</div>
    </div>
  );
};

// ── the walkthrough ──────────────────────────────────────────────────────

const ScreenFade: React.FC<{ dur: number; children: React.ReactNode }> = ({ dur, children }) => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: interpolate(f, [0, 8, dur - 8, dur], [0, 1, 1, 0], clamp) }}>{children}</AbsoluteFill>;
};

const Walkthrough: React.FC = () => (
  <AbsoluteFill>
    {CHAPTERS.map((c, i) => (
      <Sequence key={`t${i}`} from={STARTS[i]} durationInFrames={c.dur} name={`${i + 1} ${c.label}`}>
        {c.Full ? <c.Full dur={c.dur} /> : <ChapterText c={c} i={i} />}
        {c.Side ? <c.Side dur={c.dur} /> : null}
      </Sequence>
    ))}
    <Phone>
      <Sequence durationInFrames={REAL_END} name="recording">
        <Footage />
      </Sequence>
      {CHAPTERS.map((c, i) => (
        <Sequence key={`s${i}`} from={STARTS[i]} durationInFrames={c.dur} name={`screen ${i + 1}`}>
          {c.Screen ? (c.label === "Buy" ? <c.Screen dur={c.dur} /> : <ScreenFade dur={c.dur}><c.Screen dur={c.dur} /></ScreenFade>) : null}
          {c.notes.map((n, j) => (n.hl ? <Highlight key={j} box={n.hl} at={n.at} until={n.until ?? c.dur - 6} /> : null))}
          {(c.taps ?? []).map((t, j) => <TapRipple key={j} t={t} />)}
        </Sequence>
      ))}
    </Phone>
  </AbsoluteFill>
);

/** Part 2: logo → the walkthrough → end card. */
export const Guide: React.FC = () => (
  <AbsoluteFill style={{ background: "#000" }}>
    <Background />
    <Sequence durationInFrames={LOGO} name="logo">
      <LogoScene dur={LOGO} />
    </Sequence>
    <Sequence from={LOGO} durationInFrames={WALK + 20} name="walkthrough">
      <Walkthrough />
    </Sequence>
    <Sequence from={LOGO + WALK} durationInFrames={OUTRO} name="outro">
      <OutroScene dur={OUTRO} />
    </Sequence>
  </AbsoluteFill>
);
