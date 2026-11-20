import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Badge, TIERS } from "./Badge";
import { Mark, Wordmark } from "./Logo";
import { C, easeInOut, F, prog, sp } from "./theme";
import { Avatar, Brand, Donut, Glass, Headline, Phone, PickRow, Scene, Tech } from "./ui";

const BET = "Everyone is betting on everything";
const BET_BASKET = [
  { name: "Kalshi", kind: "Pre-IPO", w: 30, logo: "KALSHI" },
  { name: "DraftKings", kind: "Stock", w: 25, logo: "DKNG" },
  { name: "Polymarket", kind: "Pre-IPO", w: 20, logo: "POLYMARKET" },
  { name: "Coinbase", kind: "Stock", w: 15, logo: "COIN" },
  { name: "Robinhood", kind: "Stock", w: 10, logo: "HOOD" },
];

/* 1 ─ The logo assembles from pixels. */
// The story's last shot (s8) hands over its taillights: frame 0 here is s8 at 3.30 s, where the join
// (build-film.sh) starts a 0.5 s crossfade. Measured from s8 at 1920x1080: [frame, left x, right x], y 556.
const TAIL: [number, number, number][] = [[0, 1469, 1541], [3, 1484, 1545], [6, 1496, 1547], [9, 1506, 1550], [12, 1515, 1554], [15, 1522, 1557]];
const TAIL_Y = 556;
const BURST = 13;
const MARK_AT: [number, number] = [795, 300]; // the 330px mark's top-left on the 1920x1080 frame (before the lift)
const tailX = (f: number, side: 1 | 2) => interpolate(f, TAIL.map((t) => t[0]), TAIL.map((t) => t[side]), { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

/** The car's two taillights, still glowing as the street dissolves, until they break into the mark's squares. */
const Taillights: React.FC = () => {
  const f = useCurrentFrame();
  const o = interpolate(f, [BURST, BURST + 10], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const w = interpolate(f, [0, 15], [40, 22], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const flare = 1 + 0.6 * Math.max(0, 1 - Math.abs(f - BURST) / 4);
  return (
    <AbsoluteFill style={{ opacity: o }}>
      {([1, 2] as const).map((side) => (
        <div key={side} style={{ position: "absolute", left: tailX(f, side) - w / 2, top: TAIL_Y - w * 0.18, width: w, height: w * 0.36, borderRadius: w,
          background: "#FF4A3D", boxShadow: `0 0 ${10 * flare}px #FF3B30, 0 0 ${26 * flare}px rgba(255,59,48,0.7)`, transform: `scale(${flare})` }} />
      ))}
    </AbsoluteFill>
  );
};

export const LogoScene: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const lift = interpolate(f, [58, 78], [0, -40], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut });
  const from: [number, number][] = ([1, 2] as const).map((side) => [tailX(BURST, side) - MARK_AT[0], TAIL_Y - MARK_AT[1]]);
  return (
    <>
    <Taillights />
    <Scene dur={dur} edge={8}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ transform: `translateY(${lift}px)`, display: "flex", flexDirection: "column", alignItems: "center" }}>
          <Mark size={330} assemble from={from} burst={BURST} />
          <div style={{ marginTop: -18 }}>
            <Wordmark size={120} start={60} tagline="social trading for ideas" />
          </div>
        </div>
      </AbsoluteFill>
    </Scene>
    </>
  );
};

/* 2 ─ Your ideas, made tradable. The take from the film becomes a basket; the portfolio on the right. */
export const TradableScene: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const typed = Math.floor(interpolate(f, [22, 50], [0, BET.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const ph = sp(f, fps, 4, 22);
  const ring = prog(f, 58, 100);
  return (
    <Scene dur={dur}>
      <Headline a="Your ideas," b="made tradable." y={170} size={96} />
      <Glass style={{ position: "absolute", left: 120, top: 430, width: 820, padding: "28px 32px" }}>
        <div style={{ fontFamily: F.mono, fontSize: 16, color: C.muted, letterSpacing: 1.5 }}>YOUR TAKE</div>
        <div style={{ fontFamily: F.serif, fontSize: 40, color: C.text, marginTop: 10, minHeight: 50 }}>
          {BET.slice(0, typed)}<span style={{ color: C.trade, opacity: typed < BET.length ? 1 : 0 }}>|</span>
        </div>
        <div style={{ display: "flex", gap: 34, alignItems: "center", marginTop: 26, opacity: prog(f, 54, 66) }}>
          <Donut weights={BET_BASKET.map((b) => b.w)} size={170} progress={ring}>
            <div style={{ fontFamily: F.sans, fontWeight: 700, fontSize: 44, color: C.text }}>5</div>
            <div style={{ fontFamily: F.sans, fontSize: 14, color: C.muted }}>picks</div>
          </Donut>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
            {BET_BASKET.map((b, i) => <PickRow key={b.name} color={C.picks[i]} name={b.name} kind={b.kind} weight={`${b.w}%`} size={22} logo={b.logo} o={prog(f, 64 + i * 5, 78 + i * 5)} />)}
          </div>
        </div>
      </Glass>
      <div style={{ position: "absolute", right: 210, top: 70, transform: `translateX(${(1 - ph) * 260}px) perspective(1600px) rotateY(${-14 + 6 * Math.sin(f / 60)}deg) rotateX(3deg)`, opacity: ph }}>
        <Phone src="app-money-3.png" height={900} />
      </div>
      <Tech items={["take builder", "~200 stocks, perps & vaults in a cached prompt", "BM25 over live prediction markets", "basket in ~2s"]} />
    </Scene>
  );
};

/* 3 ─ Any idea, any risk level. A real take ("Ai is on the rise") on a turning wheel; what each level changes lights up. */
type Pick = { n: string; k: string; w: number; changed?: boolean; l?: string };
const LOGO: Record<string, string> = { NVIDIA: "NVDA", CoreWeave: "CRWV", Broadcom: "AVGO", "SK Hynix": "SKHY", Anthropic: "ANTHROPIC", Cash: "USDC" };
const AI = "Ai is on the rise";
const LEVELS: { label: string; sub: string; color: string; change: string; picks: Pick[] }[] = [
  { label: "LOW", sub: "Earns interest", color: C.up, change: "the perp becomes cash earning interest", picks: [
    { n: "NVIDIA", k: "Stock", w: 26 }, { n: "CoreWeave", k: "Stock", w: 18 }, { n: "Broadcom", k: "Stock", w: 12 }, { n: "SK Hynix", k: "Stock", w: 6 },
    { n: "Cash", k: "Earns interest", w: 38, changed: true }] },
  { label: "MEDIUM", sub: "Plain basket", color: C.text, change: "the plain basket", picks: [
    { n: "NVIDIA", k: "Stock", w: 32 }, { n: "CoreWeave", k: "Stock", w: 24 }, { n: "Broadcom", k: "Stock", w: 16 }, { n: "SK Hynix", k: "Stock", w: 8 },
    { n: "Anthropic", k: "Perp · 1x", w: 20 }] },
  { label: "HIGH", sub: "Adds leverage", color: C.fade, change: "picks turn into 2–3x perps", picks: [
    { n: "NVIDIA", k: "Perp · 3x", w: 32, changed: true }, { n: "CoreWeave", k: "Stock", w: 24 }, { n: "Broadcom", k: "Perp · 2x", w: 16, changed: true },
    { n: "SK Hynix", k: "Stock", w: 8 }, { n: "Anthropic", k: "Perp · 2x", w: 20, changed: true }] },
];

const hex2 = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");

export const RiskScene: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const seg = (dur - 30) / 3;
  let turn = 0;
  for (let i = 0; i < 3; i++) turn += prog(f, 14 + seg * i + seg * 0.62, 14 + seg * (i + 1), easeInOut);
  const angle = -turn * 120 + Math.sin(f / 40) * 2;
  const front = Math.round(turn) % 3;
  // when this level reached the front, for the highlight
  const arrived = front === 0 ? 6 : 14 + seg * (front - 1) + seg;
  const lit = prog(f, arrived, arrived + 10) * (0.8 + 0.2 * Math.sin(f / 5));
  const lv = LEVELS[front];
  return (
    <Scene dur={dur}>
      <Headline a="Any idea." b="Any risk level." y={190} size={92} />
      <div style={{ position: "absolute", left: 120, top: 430, display: "flex", gap: 14 }}>
        {LEVELS.map((l, i) => (
          <div key={l.label} style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 22, padding: "12px 26px", borderRadius: 999, color: i === front ? C.bg : C.muted, background: i === front ? l.color : "rgba(255,255,255,0.05)", border: `1px solid ${C.hair}` }}>
            {l.label[0] + l.label.slice(1).toLowerCase()}
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", left: 120, top: 540, width: 640, fontFamily: F.serif, fontSize: 40, lineHeight: 1.2, color: C.text, opacity: lit }}>
        <span style={{ color: C.muted, fontSize: 22, fontFamily: F.mono, letterSpacing: 1.5 }}>{lv.label} RISK →</span>
        <div style={{ color: lv.color, marginTop: 8 }}>{lv.change}</div>
      </div>
      <div style={{ position: "absolute", left: 860, top: 90, width: 1000, height: 900 }}>
        {LEVELS.map((l, i) => {
          const th = ((angle + i * 120) * Math.PI) / 180;
          const depth = Math.cos(th);
          const x = Math.sin(th) * 440;
          const sc = 0.62 + 0.38 * ((depth + 1) / 2);
          return { l, i, x, sc, depth };
        })
          .sort((a, b) => a.depth - b.depth)
          .map(({ l, i, x, sc, depth }) => {
            const on = i === front ? lit : 0;
            return (
              <div key={l.label} style={{ position: "absolute", left: 500 - 240 + x, top: 80, width: 480, transform: `scale(${sc}) rotateY(${-x / 30}deg)`, opacity: 0.55 + 0.45 * Math.max(0, (depth + 0.5) / 1.5), filter: `brightness(${0.72 + 0.28 * Math.max(0, depth)}) blur(${Math.max(0, 0.6 - depth) * 1.2}px)` }}>
                <Glass style={{ padding: 30, background: "linear-gradient(180deg, rgba(22,24,32,0.97), rgba(12,13,18,0.97))", boxShadow: `0 30px 80px rgba(0,0,0,0.55), 0 0 ${50 * on}px ${l.color}${hex2(on * 0.35)}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontFamily: F.mono, fontSize: 16, letterSpacing: 2, color: l.color }}>{l.label} RISK</div>
                    <div style={{ fontFamily: F.sans, fontSize: 15, color: C.muted }}>{l.sub}</div>
                  </div>
                  <div style={{ fontFamily: F.serif, fontSize: 32, color: C.text, margin: "14px 0 18px" }}>{AI}</div>
                  <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
                    <Donut weights={l.picks.map((p) => p.w)} size={180}>
                      <div style={{ fontFamily: F.sans, fontWeight: 700, fontSize: 38, color: C.text }}>5</div>
                    </Donut>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {l.picks.map((p, j) => (
                      <div key={j} style={{ borderRadius: 10, padding: "5px 8px", margin: "0 -8px", background: p.changed ? `${l.color}${hex2(on * 0.18)}` : "transparent", boxShadow: p.changed ? `inset 0 0 0 1px ${l.color}${hex2(on * 0.7)}` : undefined }}>
                        <PickRow color={C.picks[j]} name={p.n} kind={p.k} weight={`${p.w}%`} size={19} logo={LOGO[p.n]} />
                      </div>
                    ))}
                  </div>
                </Glass>
              </div>
            );
          })}
      </div>
      <Tech delay={24} items={["same picks; risk swaps the instruments", "low → USDC yield on Jupiter Lend", "high → Phoenix perps, up to 5x"]} />
    </Scene>
  );
};

/* 4 ─ Any asset class: each one gets its own picture, then they all fall into one basket. */
const CLASSES = [
  { t: "Tokenized stocks", v: "xStocks · Backpack · Ondo" },
  { t: "Pre-IPO", v: "Tessera · PreStocks" },
  { t: "Prediction markets", v: "Gemini" },
  { t: "Perps", v: "Phoenix" },
  { t: "Yield", v: "Jupiter Lend" },
  { t: "Collectibles", v: "Collector Crypt" },
];

const Spark: React.FC<{ w: number; h: number; seed: number; progress: number; color: string }> = ({ w, h, seed, progress, color }) => {
  const pts = Array.from({ length: 24 }, (_, i) => {
    const t = i / 23;
    const y = h * (0.15 + 0.7 * (1 - t)) + Math.sin(i * 1.7 + seed) * h * 0.08;
    return [t * w, y];
  });
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h}>
      <path d={d} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={`${progress} 1`} />
    </svg>
  );
};

const AssetVisual: React.FC<{ i: number; t: number }> = ({ i, t }) => {
  // t: frames since this class became active
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = sp(t, fps, 0, 18);
  const box: React.CSSProperties = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", opacity: a, transform: `scale(${0.94 + 0.06 * a})` };
  if (i === 0) {
    const rows = [["DKNG", "DraftKings", "$58.40", "+3.2%"], ["COIN", "Coinbase", "$341.12", "+5.8%"], ["NVDA", "NVIDIA", "$187.55", "+2.1%"]];
    return (
      <div style={box}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {rows.map(([tk, n, px, ch], j) => {
            const s = sp(t, fps, j * 4, 18);
            return (
              <Glass key={tk} style={{ width: 640, padding: "20px 24px", display: "flex", alignItems: "center", gap: 20, opacity: s, transform: `translateX(${(1 - s) * 40}px)` }}>
                <Brand k={tk} size={58} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 26, color: C.text }}>{n}</div>
                  <div style={{ fontFamily: F.mono, fontSize: 15, color: C.muted }}>{tk}x · tokenized 1:1</div>
                </div>
                <Spark w={150} h={50} seed={j * 3} progress={prog(t, 4 + j * 4, 24 + j * 4)} color={C.up} />
                <div style={{ textAlign: "right", width: 120 }}>
                  <div style={{ fontFamily: F.mono, fontSize: 22, color: C.text }}>{px}</div>
                  <div style={{ fontFamily: F.mono, fontSize: 16, color: C.up }}>{ch}</div>
                </div>
              </Glass>
            );
          })}
        </div>
      </div>
    );
  }
  if (i === 1) {
    const cos = [["KALSHI", "Kalshi"], ["POLYMARKET", "Polymarket"], ["ANTHROPIC", "Anthropic"]];
    return (
      <div style={box}>
        <div style={{ display: "flex", gap: 26 }}>
          {cos.map(([k, n], j) => {
            const s = sp(t, fps, j * 4, 16);
            const unlock = prog(t, 12 + j * 4, 22 + j * 4);
            return (
              <Glass key={n} style={{ width: 210, padding: "28px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, opacity: s, transform: `translateY(${(1 - s) * 30}px)` }}>
                <div style={{ height: 84, display: "flex", alignItems: "center" }}><Brand k={k} size={76} /></div>
                <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 24, color: C.text }}>{n}</div>
                <div style={{ fontFamily: F.mono, fontSize: 15, letterSpacing: 1, padding: "5px 10px", borderRadius: 6, color: unlock > 0.5 ? "#06210F" : C.muted, background: unlock > 0.5 ? C.trade : "rgba(255,255,255,0.06)" }}>{unlock > 0.5 ? "🔓 TRADABLE" : "🔒 PRIVATE"}</div>
              </Glass>
            );
          })}
        </div>
      </div>
    );
  }
  if (i === 2) {
    const yes = interpolate(t, [0, 30], [48, 62], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return (
      <div style={box}>
        <Glass style={{ width: 680, padding: 0, overflow: "hidden" }}>
          <div style={{ position: "relative", height: 210 }}>
            <Img src={staticFile("img/fed.jpg")} style={{ width: "100%", height: 210, objectFit: "cover", filter: "brightness(0.7) saturate(0.9)", transform: `scale(${1.04 + 0.04 * prog(t, 0, 40)})` }} />
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, transparent 40%, rgba(12,13,18,0.95))" }} />
            <div style={{ position: "absolute", left: 24, top: 18, display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", borderRadius: 999, background: "rgba(0,0,0,0.55)" }}>
              <Brand k="GEMINI" size={22} />
              <span style={{ fontFamily: F.mono, fontSize: 14, color: C.text, letterSpacing: 1 }}>GEMINI PREDICTIONS</span>
            </div>
            <div style={{ position: "absolute", right: 14, bottom: 8, fontFamily: F.mono, fontSize: 10, color: "rgba(255,255,255,0.45)" }}>Photo: AgnosticPreachersKid · CC BY-SA 3.0</div>
          </div>
          <div style={{ padding: "6px 30px 30px" }}>
            <div style={{ fontFamily: F.serif, fontSize: 38, color: C.text, margin: "0 0 20px" }}>Will the Fed cut rates by March?</div>
            <div style={{ height: 14, borderRadius: 7, background: `${C.down}55`, overflow: "hidden" }}>
              <div style={{ width: `${yes}%`, height: "100%", background: C.up, borderRadius: 7 }} />
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 20 }}>
              <div style={{ flex: 1, padding: "14px 0", textAlign: "center", borderRadius: 14, background: `${C.up}22`, border: `1px solid ${C.up}66`, fontFamily: F.sans, fontWeight: 600, fontSize: 24, color: C.up }}>Yes {Math.round(yes)}¢</div>
              <div style={{ flex: 1, padding: "14px 0", textAlign: "center", borderRadius: 14, background: `${C.down}22`, border: `1px solid ${C.down}66`, fontFamily: F.sans, fontWeight: 600, fontSize: 24, color: C.down }}>No {100 - Math.round(yes)}¢</div>
            </div>
          </div>
        </Glass>
      </div>
    );
  }
  if (i === 3) {
    const lev = Math.min(5, 1 + Math.floor(prog(t, 4, 26) * 4.99));
    return (
      <div style={box}>
        <Glass style={{ width: 640, padding: 30 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Brand k="NVDA" size={48} />
            <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 26, color: C.text }}>NVIDIA perp</div>
            <div style={{ marginLeft: "auto", fontFamily: F.mono, fontSize: 40, color: C.fade }}>{lev}x</div>
          </div>
          <div style={{ marginTop: 18 }}><Spark w={580} h={150} seed={5} progress={prog(t, 0, 28)} color={C.up} /></div>
          <div style={{ display: "flex", gap: 16, marginTop: 14 }}>
            <div style={{ flex: 1, padding: "14px 0", textAlign: "center", borderRadius: 999, background: "linear-gradient(90deg,#BDEDCB,#97DBAB)", fontFamily: F.sans, fontWeight: 600, fontSize: 22, color: "#06210F" }}>↗ Long</div>
            <div style={{ flex: 1, padding: "14px 0", textAlign: "center", borderRadius: 999, background: "linear-gradient(90deg,#F8C8D8,#EFA5C0)", fontFamily: F.sans, fontWeight: 600, fontSize: 22, color: "#330A1A" }}>↘ Short</div>
          </div>
        </Glass>
      </div>
    );
  }
  if (i === 4) {
    const k = prog(t, 0, 32, (x) => x);
    const bal = 10000 + k * 41.37;
    const pts = Array.from({ length: 40 }, (_, j) => j / 39);
    const w = 600, h = 170;
    const path = pts.map((x, j) => `${j ? "L" : "M"}${(x * w).toFixed(1)},${(h - 12 - Math.pow(x, 1.6) * (h - 30)).toFixed(1)}`).join(" ");
    return (
      <div style={box}>
        <Glass style={{ width: 680, padding: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <Brand k="USDC" size={56} style={{ filter: `drop-shadow(0 0 ${12 + 8 * Math.sin(f / 7)}px rgba(39,117,202,0.7))` }} />
            <div>
              <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 26, color: C.text }}>Cash</div>
              <div style={{ fontFamily: F.mono, fontSize: 15, color: C.muted }}>USDC · lent on Jupiter Lend</div>
            </div>
            <div style={{ marginLeft: "auto", fontFamily: F.mono, fontSize: 18, color: "#06210F", background: C.trade, borderRadius: 999, padding: "6px 14px" }}>EARNING</div>
          </div>
          <div style={{ fontFamily: F.mono, fontSize: 64, color: C.text, marginTop: 22, letterSpacing: -1 }}>${bal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div style={{ fontFamily: F.mono, fontSize: 18, color: C.up }}>+${(bal - 10000).toFixed(2)} interest · accrues every block</div>
          <svg width={w} height={h} style={{ marginTop: 14 }}>
            <defs><linearGradient id="yf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2775CA" stopOpacity="0.45" /><stop offset="1" stopColor="#2775CA" stopOpacity="0" /></linearGradient></defs>
            <clipPath id="yc"><rect x={0} y={0} width={w * Math.max(0.02, k)} height={h} /></clipPath>
            <g clipPath="url(#yc)">
              <path d={`${path} L${w},${h} L0,${h} Z`} fill="url(#yf)" />
              <path d={path} fill="none" stroke="#5AA9FF" strokeWidth={3} />
            </g>
          </svg>
        </Glass>
      </div>
    );
  }
  // Collectibles: the real PSA 10 card from the catalog, with a holo sweep.
  const sweep = interpolate(t, [4, 30], [-60, 160], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
        <div style={{ position: "relative", width: 300, height: 509, borderRadius: 14, overflow: "hidden", transform: `perspective(1200px) rotateY(${-12 + 10 * Math.sin(t / 14)}deg)`, boxShadow: "0 40px 90px rgba(0,0,0,0.7), 0 0 60px rgba(255,220,150,0.15)" }}>
          <Img src={staticFile("img/serena-psa10.png")} style={{ width: 300, height: 509 }} />
          <div style={{ position: "absolute", inset: 0, background: `linear-gradient(115deg, transparent ${sweep - 30}%, rgba(255,255,255,0.55) ${sweep}%, transparent ${sweep + 30}%)`, mixBlendMode: "overlay" }} />
        </div>
        <Glass style={{ padding: "24px 28px", width: 330 }}>
          <div style={{ fontFamily: F.mono, fontSize: 14, color: C.muted, letterSpacing: 1 }}>COLLECTIBLE · CARD</div>
          <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 26, color: C.text, marginTop: 8 }}>Serena · Full Art</div>
          <div style={{ fontFamily: F.sans, fontSize: 19, color: C.muted, marginTop: 4 }}>Silver Tempest #193 · PSA 10</div>
          <div style={{ fontFamily: F.mono, fontSize: 16, color: C.up, marginTop: 16 }}>graded · vaulted · insured</div>
        </Glass>
      </div>
    </div>
  );
};

export const AssetScene: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const step = 52; // ~1.7s per asset class, long enough to take each one in
  const start = 16;
  const active = Math.min(5, Math.max(0, Math.floor((f - start) / step)));
  const t = f - start - active * step;
  const collapse = prog(f, start + 6 * step, start + 6 * step + 18);
  return (
    <Scene dur={dur}>
      <Headline a="Any asset class." b="One basket." y={110} size={80} />
      <div style={{ position: "absolute", left: 120, top: 330, display: "flex", flexDirection: "column", gap: 10 }}>
        {CLASSES.map((c, i) => {
          const on = i === active && collapse < 0.5;
          const seen = f >= start + i * step;
          return (
            <div key={c.t} style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 20px", borderRadius: 14, width: 560, background: on ? "rgba(255,255,255,0.07)" : "transparent", border: `1px solid ${on ? C.hair : "transparent"}`, opacity: seen ? (on || collapse > 0.5 ? 1 : 0.5) : 0.18 }}>
              <div style={{ width: 14, height: 14, borderRadius: 3, background: C.picks[i] }} />
              <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 28, color: C.text, flex: 1 }}>{c.t}</div>
              <div style={{ fontFamily: F.mono, fontSize: 15, color: C.muted }}>{c.v}</div>
            </div>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 780, top: 230, width: 1040, height: 640, opacity: 1 - collapse, transform: `scale(${1 - 0.15 * collapse})` }}>
        {f >= start ? <AssetVisual i={active} t={t} /> : null}
      </div>
      <div style={{ position: "absolute", left: 1110, top: 300, opacity: collapse, transform: `scale(${0.8 + 0.2 * collapse})` }}>
        <Donut weights={[26, 18, 16, 14, 16, 10]} size={400} progress={prog(f, start + 6 * step, start + 6 * step + 28)}>
          <div style={{ fontFamily: F.serif, fontSize: 32, color: C.text, textAlign: "center", lineHeight: 1.15 }}>one take,<br />one basket</div>
        </Donut>
      </div>
      <Tech delay={20} items={["the asset bank routes each asset to its best issuer", "tradeable = $50k pooled liquidity & <1% impact", "swaps via Jupiter"]} />
    </Scene>
  );
};

/* 5 ─ Group chats and X, with two more real takes. */
const Bubble: React.FC<{ who?: string; me?: boolean; text: string; o: number; children?: React.ReactNode }> = ({ who, me, text, o, children }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: me ? "flex-end" : "flex-start", opacity: o, transform: `translateY(${(1 - o) * 18}px) scale(${0.96 + 0.04 * o})`, transformOrigin: me ? "right bottom" : "left bottom" }}>
    {who ? <div style={{ fontFamily: F.sans, fontSize: 15, color: C.muted, margin: "0 14px 4px" }}>{who}</div> : null}
    <div style={{ maxWidth: 470, padding: "13px 18px", borderRadius: 22, fontFamily: F.sans, fontSize: 22, lineHeight: 1.3, color: "#fff", background: me ? "#0A84FF" : "#26272B" }}>
      {text}
      {children}
    </div>
  </div>
);

type CardPick = { logo: string; name: string; w: number };
const DraftCard: React.FC<{ scale?: number; title: string; picks: CardPick[]; meta: string }> = ({ scale = 1, title, picks, meta }) => (
  <div style={{ marginTop: 10, width: 430 * scale, borderRadius: 16, overflow: "hidden", background: "#0F1014", border: `1px solid ${C.hair}` }}>
    <div style={{ padding: 18 * scale, display: "flex", gap: 16 * scale, alignItems: "center" }}>
      <Donut weights={picks.map((p) => p.w)} size={84 * scale} stroke={10 * scale} />
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: F.mono, fontSize: 12 * scale, color: C.muted, letterSpacing: 1 }}>{meta}</div>
        <div style={{ fontFamily: F.serif, fontSize: 22 * scale, color: C.text, marginTop: 6 }}>{title}</div>
        <div style={{ display: "flex", gap: 6 * scale, marginTop: 10 * scale }}>
          {picks.map((p) => <Brand key={p.name} k={p.logo} size={28 * scale} />)}
        </div>
      </div>
    </div>
    <div style={{ padding: `${12 * scale}px ${18 * scale}px`, background: "linear-gradient(90deg,#BDEDCB,#97DBAB)", fontFamily: F.sans, fontWeight: 600, fontSize: 18 * scale, color: "#06210F" }}>Post & back it →</div>
  </div>
);

const GYM: CardPick[] = [{ logo: "LULU", name: "lululemon", w: 40 }, { logo: "NKE", name: "Nike", w: 35 }, { logo: "USDC", name: "Cash", w: 25 }];
const WASTELAND: CardPick[] = [{ logo: "SQQQ", name: "ProShares UltraPro Short QQQ", w: 100 }];

export const ChatScene: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const at = (a: number) => prog(f, a, a + 10);
  const x = sp(f, useVideoConfig().fps, 92, 20);
  return (
    <Scene dur={dur}>
      <Headline a="Say it in the group chat." b="Trade it right there." y={80} size={72} />
      <Glass style={{ position: "absolute", left: 120, top: 290, width: 720, height: 680, padding: 28, boxSizing: "border-box", background: "rgba(10,11,14,0.92)" }}>
        <div style={{ textAlign: "center", fontFamily: F.sans, fontWeight: 600, fontSize: 20, color: C.text, paddingBottom: 16, borderBottom: `1px solid ${C.hair}`, marginBottom: 20 }}>gym rats 🏋️</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Bubble who="Kai" text="the gym was packed at 5am again" o={at(6)} />
          <Bubble who="Maya" text="everyone's in lulu now fr" o={at(22)} />
          <Bubble me text="@thesis physical activity is the new trend" o={at(40)} />
          <Bubble who="Thesis" text="Built it. 3 picks, low risk, 6 months:" o={at(62)}>
            <DraftCard scale={0.92} title="Physical activity is the new trend" picks={GYM} meta="DRAFT TAKE · 3 PICKS · LOW · 6MO" />
          </Bubble>
        </div>
      </Glass>
      <div style={{ position: "absolute", left: 900, top: 330, width: 880, opacity: x, transform: `translateX(${(1 - x) * 80}px)` }}>
        <Glass style={{ padding: 28, background: "rgba(0,0,0,0.88)" }}>
          <div style={{ display: "flex", gap: 14 }}>
            <Avatar n={1} size={52} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: F.sans, fontSize: 20 }}><b style={{ color: C.text }}>dev</b> <span style={{ color: C.muted }}>@dev · 2m</span></div>
              <div style={{ fontFamily: F.sans, fontSize: 24, color: C.text, marginTop: 6 }}>the internet will be a wasteland in a year. <span style={{ color: "#1D9BF0" }}>@yourthesisxyz</span></div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 22, paddingTop: 20, borderTop: `1px solid ${C.hair}`, opacity: prog(f, 120, 132) }}>
            <div style={{ width: 52, height: 52, borderRadius: 26, background: "#0F1014", display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${C.hair}` }}>
              <div style={{ transform: "scale(0.5)" }}><MiniMark /></div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: F.sans, fontSize: 20 }}><b style={{ color: C.text }}>Thesis</b> <span style={{ color: C.muted }}>@yourthesisxyz · now</span></div>
              <div style={{ fontFamily: F.sans, fontSize: 22, color: C.text, marginTop: 6 }}>Built it: short the Nasdaq-100. Tap to back it with your own wallet.</div>
              <DraftCard scale={0.95} title="The internet will be a wasteland in a year" picks={WASTELAND} meta="DRAFT TAKE · 1 PICK · MEDIUM · 12MO" />
            </div>
          </div>
        </Glass>
      </div>
      <Tech items={["iMessage bot on BlueBubbles", "X bot vets every mention first", "a draft goes live only from the tapper's own Privy wallet"]} />
    </Scene>
  );
};

const MiniMark: React.FC = () => <div style={{ width: 70, height: 70 }}><Mark size={70} /></div>;

/* 6 ─ Copy anyone on X. */
export const CopyScene: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = sp(f, fps, 8, 20), b = sp(f, fps, 36, 20), c = sp(f, fps, 62, 16);
  const arrow = prog(f, 26, 42);
  return (
    <Scene dur={dur}>
      <Headline a="Copy anyone on X." b="Their next call is your next draft." y={110} size={76} />
      <div style={{ position: "absolute", left: 120, top: 400, display: "flex", alignItems: "center", gap: 40 }}>
        <Glass style={{ width: 520, padding: 26, opacity: a, transform: `translateY(${(1 - a) * 24}px)`, background: "rgba(0,0,0,0.9)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontFamily: F.sans, fontSize: 20 }}><b style={{ color: C.text }}>Macro Mike</b> <span style={{ color: C.muted }}>@macromike</span></div>
            <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 15, color: "#06210F", background: C.trade, borderRadius: 999, padding: "6px 14px" }}>Copying</div>
          </div>
          <div style={{ fontFamily: F.sans, fontSize: 25, color: C.text, marginTop: 16, lineHeight: 1.35 }}>Gold is about to have its best year since 1979.</div>
        </Glass>
        <div style={{ width: 120, height: 2, background: `linear-gradient(90deg, ${C.hair}, ${C.trade})`, transform: `scaleX(${arrow})`, transformOrigin: "left" }} />
        <div style={{ opacity: b, transform: `translateY(${(1 - b) * 24}px)` }}>
          <DraftCard scale={1.1} title="Gold has its best year since 1979" picks={[{ logo: "GOLD", name: "Gold", w: 60 }, { logo: "SILVER", name: "Silver", w: 25 }, { logo: "USDC", name: "Cash", w: 15 }]} meta="FROM @MACROMIKE · 3 PICKS · 12MO" />
        </div>
      </div>
      <div style={{ position: "absolute", right: 140, top: 760, opacity: c, transform: `translateY(${(1 - c) * -30}px)` }}>
        <Glass style={{ width: 560, padding: "18px 22px", display: "flex", gap: 16, alignItems: "center", background: "rgba(28,30,36,0.92)", borderRadius: 22 }}>
          <div style={{ width: 44, height: 44, borderRadius: 11, background: C.bg, border: `1px solid ${C.hair}`, display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ transform: "scale(0.45)" }}><MiniMark /></div></div>
          <div>
            <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 18, color: C.text }}>New call from @macromike</div>
            <div style={{ fontFamily: F.sans, fontSize: 17, color: C.muted }}>“Gold has its best year…” is drafted. Tap to buy in.</div>
          </div>
        </Glass>
      </div>
      <Tech items={["followed accounts polled every 15 min", "each call → a drafted take + a notification", "you tap to buy in; it never auto-trades"]} />
    </Scene>
  );
};

/* 7 ─ Back it, fade it, talk about it; the author gets paid. Another real take: "Pokemon will boom". */
export const SocialScene: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const card = sp(f, fps, 4, 20);
  const backs = Math.round(interpolate(f, [20, 100], [41, 87], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const paid = interpolate(f, [20, 110], [0, 18.4], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const comments = [
    { who: "maya", text: "serena full art in a 10?? instant back", side: "BACKED", c: C.up },
    { who: "kai", text: "fading. pokémon peaked in 1999", side: "FADED", c: C.down },
    { who: "dev", text: "graded cards only go one way 📈", side: "AUTHOR", c: C.aurora },
  ];
  return (
    <Scene dur={dur}>
      <Headline a="Back it. Fade it." b="The author gets paid." y={130} size={84} />
      <Glass style={{ position: "absolute", left: 120, top: 390, width: 760, padding: 32, opacity: card, transform: `translateY(${(1 - card) * 26}px)` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Avatar n={1} size={50} />
          <div style={{ fontFamily: F.sans, fontSize: 20 }}><b style={{ color: C.text }}>dev</b> <span style={{ color: C.muted }}>@dev · 3mo</span></div>
          <div style={{ marginLeft: "auto", fontFamily: F.mono, fontSize: 15, color: C.muted }}>HIGH · 12MO</div>
        </div>
        <div style={{ display: "flex", gap: 22, alignItems: "center", margin: "18px 0 10px" }}>
          <Img src={staticFile("img/serena-psa10.png")} style={{ width: 70, height: 119, borderRadius: 6 }} />
          <div>
            <div style={{ fontFamily: F.serif, fontSize: 42, color: C.text }}>Pokemon will boom</div>
            <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 50, color: C.up }}>+38.0%</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 18 }}>
          <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 22, padding: "12px 24px", borderRadius: 999, background: "linear-gradient(90deg,#BDEDCB,#97DBAB)", color: "#06210F" }}>↗ Trade {backs}</div>
          <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 22, padding: "12px 24px", borderRadius: 999, background: "linear-gradient(90deg,#F8C8D8,#EFA5C0)", color: "#330A1A" }}>↘ Fade 12</div>
          <div style={{ marginLeft: "auto", alignSelf: "center", fontFamily: F.mono, fontSize: 18, color: C.up }}>author earned ${paid.toFixed(2)}</div>
        </div>
      </Glass>
      <div style={{ position: "absolute", left: 940, top: 390, width: 860, display: "flex", flexDirection: "column", gap: 18 }}>
        {comments.map((c, i) => {
          const s = sp(f, fps, 26 + i * 16, 18);
          return (
            <Glass key={c.who} style={{ padding: "20px 24px", display: "flex", gap: 16, alignItems: "flex-start", opacity: s, transform: `translateX(${(1 - s) * 60}px)` }}>
              <Avatar n={(i % 2) as 0 | 1} size={44} />
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 19, color: C.text }}>@{c.who}</span>
                  <span style={{ fontFamily: F.mono, fontSize: 13, color: c.c, border: `1px solid ${c.c}66`, borderRadius: 6, padding: "2px 7px" }}>{c.side}</span>
                </div>
                <div style={{ fontFamily: F.sans, fontSize: 22, color: C.text, marginTop: 6 }}>{c.text}</div>
              </div>
            </Glass>
          );
        })}
      </div>
      <Tech items={["10 bps fee on every back or fade", "5 bps of it to the take's author", "fees live in an on-chain config, not in code"]} />
    </Scene>
  );
};

/* 8 ─ The app's on-chain receipt, and the app's real share cards. */
export const ReceiptScene: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const r = sp(f, fps, 4, 20);
  const ret = interpolate(f, [16, 50], [0, 104.2], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const legs: [string, string, string][] = [["Kalshi", "$0.42 → $0.91", "KALSHI"], ["DraftKings", "$31.20 → $58.40", "DKNG"], ["Polymarket", "$1.10 → $2.37", "POLYMARKET"], ["Coinbase", "$212.40 → $341.12", "COIN"], ["Robinhood", "$48.15 → $96.02", "HOOD"]];
  const cards = ["receipt", "terminal", "gold", "holo", "glow"];
  const stat = (label: string, value: string, color = C.text) => (
    <div style={{ flex: 1 }}>
      <div style={{ fontFamily: F.sans, fontSize: 19, color: C.muted }}>{label}</div>
      <div style={{ fontFamily: F.mono, fontWeight: 600, fontSize: 26, color, marginTop: 2 }}>{value}</div>
    </div>
  );
  return (
    <Scene dur={dur}>
      <Headline a="Frozen on Solana." b="No edits. No deletes." y={90} size={78} />
      <Glass style={{ position: "absolute", left: 120, top: 310, width: 720, padding: 32, opacity: r, transform: `translateY(${(1 - r) * 24}px)`, background: "rgba(8,9,12,0.95)" }}>
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 28, color: C.text }}>On-chain receipt</div>
          <div style={{ marginLeft: "auto", fontFamily: F.mono, fontSize: 17, color: C.muted }}>FORK · LIVE</div>
        </div>
        <div style={{ display: "flex", marginTop: 22 }}>
          {stat("Backers", "128")}
          {stat("Faders", "9")}
          {stat("Money in", "$41,260")}
          {stat("Return", `+${ret.toFixed(1)}%`, C.up)}
        </div>
        <div style={{ fontFamily: F.mono, fontSize: 17, color: C.muted, marginTop: 14 }}>Take 7xKX…9fQe on the mainnet fork</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 20 }}>
          {legs.map(([n, px, lg], i) => (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 12, opacity: prog(f, 18 + i * 4, 28 + i * 4) }}>
              <Brand k={lg} size={26} />
              <div style={{ fontFamily: F.sans, fontSize: 22, color: C.text }}>{n}</div>
              <div style={{ marginLeft: "auto", fontFamily: F.mono, fontSize: 18, color: C.muted }}>{px}</div>
            </div>
          ))}
        </div>
        <div style={{ height: 1, background: C.hair, margin: "20px 0" }} />
        <div style={{ display: "flex", alignItems: "baseline", opacity: prog(f, 44, 56) }}>
          <div style={{ fontFamily: F.sans, fontSize: 22, color: C.text }}>You traded $25</div>
          <div style={{ marginLeft: "auto", fontFamily: F.mono, fontWeight: 600, fontSize: 21, color: C.up }}>$51.05 · +104.2%</div>
        </div>
        <div style={{ fontFamily: F.sans, fontSize: 18, color: C.muted, marginTop: 4, opacity: prog(f, 48, 60) }}>Score +104.2% · on-chain prices</div>
      </Glass>
      <div style={{ position: "absolute", left: 900, top: 250, width: 900, height: 760 }}>
        {cards.map((c, i) => {
          const s = sp(f, fps, 40 + i * 9, 15);
          const rot = [-14, -7, 0, 7, 14][i];
          const x = 20 + i * 122;
          return (
            <div key={c} style={{ position: "absolute", zIndex: 10 - Math.abs(i - 2), left: x, top: 40 + Math.abs(i - 2) * 22, width: 330, height: 587, borderRadius: 22, overflow: "hidden", boxShadow: "0 30px 70px rgba(0,0,0,0.65)", opacity: s, transform: `translateY(${(1 - s) * 120}px) rotate(${rot * s}deg)`, transformOrigin: "bottom center" }}>
              <Img src={staticFile(`img/cards/${c}.png`)} style={{ width: 330, height: 587 }} />
            </div>
          );
        })}
      </div>
      <Tech items={["receipt written in the same transaction as your swaps", "your wallet trades; the program never holds funds", "7 card looks, rendered in-app, one tap to share"]} />
    </Scene>
  );
};

/* 9 ─ Badges. */
export const BadgeScene: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Scene dur={dur}>
      <Headline a="Called it?" b="Can't be bought. Can't be transferred." y={110} size={76} align="center" />
      <div style={{ position: "absolute", left: 0, right: 0, top: 400, display: "flex", justifyContent: "center", alignItems: "center", gap: 46, perspective: 1400 }}>
        {TIERS.map((tier, i) => {
          const s = sp(f, fps, 10 + i * 6, 12, 0.7);
          const shine = prog(f, 30 + i * 6, 58 + i * 6);
          const tilt = Math.sin(f / 22 + i) * 10;
          const big = i === 4 ? 1.12 : 1;
          return (
            <div key={i} style={{ transform: `translateY(${(1 - s) * 60 + Math.sin(f / 18 + i) * 6}px) scale(${s * big}) rotateY(${(1 - s) * 180 + tilt}deg)`, opacity: Math.min(1, s * 1.4) }}>
              <Badge tier={tier} size={260} seed={i + 1} shine={shine} />
            </div>
          );
        })}
      </div>
      <Tech items={["badges are non-transferable Token-2022 mints", "earned only by the take's author", "metadata points at the badge art"]} />
    </Scene>
  );
};

/* 10 ─ Outro. */
export const OutroScene: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  return (
    <Scene dur={dur} edge={18}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
          <Mark size={170} />
          <div style={{ fontFamily: F.pixel, fontSize: 120, color: C.text, marginLeft: -20 }}>thesis</div>
        </div>
        <div style={{ fontFamily: F.serif, fontSize: 50, color: C.text, marginTop: 30, opacity: prog(f, 8, 24), textAlign: "center", lineHeight: 1.2 }}>
          Say a take. Friends back it or fade it.<br /><span style={{ color: C.up }}>The chain keeps score.</span>
        </div>
        <div style={{ fontFamily: F.mono, fontSize: 20, color: C.muted, marginTop: 40, opacity: prog(f, 24, 40), letterSpacing: 0.5 }}>
          Solana · Jupiter · Phoenix · Gemini · Privy · QuickNode · Supabase
        </div>
      </AbsoluteFill>
    </Scene>
  );
};
