import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, F, H, prog, rand, sp, W } from "./theme";

/** The shared night-sky background: base color, slow aurora glows, drifting pixel dust, vignette. */
export const Background: React.FC = () => {
  const f = useCurrentFrame();
  const dots = Array.from({ length: 90 }, (_, i) => {
    const x = (rand(i) * W + f * (0.15 + rand(i + 7) * 0.35)) % W;
    const y = (rand(i + 3) * H - f * (0.05 + rand(i + 11) * 0.12) + H) % H;
    const s = 1.5 + rand(i + 5) * 2.5;
    const tw = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(f / 30 + i));
    return <div key={i} style={{ position: "absolute", left: x, top: y, width: s, height: s, borderRadius: 0.6, background: i % 9 === 0 ? C.trade : i % 13 === 0 ? C.fade : "#fff", opacity: tw * 0.35 }} />;
  });
  const gx = 50 + 8 * Math.sin(f / 140);
  const gy = 30 + 6 * Math.cos(f / 170);
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <AbsoluteFill style={{ background: `radial-gradient(60% 55% at ${gx}% ${gy}%, rgba(130,150,255,0.13), transparent 70%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(45% 40% at ${100 - gx}% ${80 - gy / 3}%, rgba(169,227,186,0.07), transparent 70%)` }} />
      {dots}
      <AbsoluteFill style={{ background: "radial-gradient(120% 90% at 50% 50%, transparent 55%, rgba(0,0,0,0.65))" }} />
    </AbsoluteFill>
  );
};

/** Fades a scene in and out over `edge` frames. */
export const Scene: React.FC<{ dur: number; edge?: number; children: React.ReactNode }> = ({ dur, edge = 14, children }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, edge, dur - edge, dur], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(f, [0, edge], [14, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o, transform: `translateY(${y}px)` }}>{children}</AbsoluteFill>;
};

/** Two-line serif headline; the second line is green. Words rise in one after another. */
export const Headline: React.FC<{ a: string; b: string; x?: number; y?: number; size?: number; delay?: number; align?: "left" | "center" }> = ({ a, b, x = 120, y = 150, size = 84, delay = 3, align = "left" }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  let k = 0;
  const line = (text: string, color: string) => (
    <div style={{ display: "flex", gap: size * 0.26, justifyContent: align === "center" ? "center" : "flex-start" }}>
      {text.split(" ").map((w, i) => {
        const s = sp(f, fps, delay + k++ * 3, 20);
        return <span key={i} style={{ color, opacity: s, transform: `translateY(${(1 - s) * 26}px)`, filter: `blur(${(1 - s) * 6}px)` }}>{w}</span>;
      })}
    </div>
  );
  return (
    <div style={{ position: "absolute", left: align === "center" ? 0 : x, right: align === "center" ? 0 : undefined, top: y, fontFamily: F.serif, fontSize: size, lineHeight: 1.08, letterSpacing: -1.2 }}>
      {line(a, C.text)}
      {line(b, C.up)}
    </div>
  );
};

/** Muted body line under a headline. */
export const Sub: React.FC<{ text: string; x?: number; y: number; delay?: number; size?: number; width?: number }> = ({ text, x = 120, y, delay = 14, size = 26, width = 720 }) => {
  const f = useCurrentFrame();
  const o = prog(f, delay, delay + 18);
  return <div style={{ position: "absolute", left: x, top: y, width, fontFamily: F.sans, fontSize: size, lineHeight: 1.4, color: C.muted, opacity: o, transform: `translateY(${(1 - o) * 12}px)` }}>{text}</div>;
};

/** The technical caption in the bottom corner: a pulsing dot and mono items typed in. */
export const Tech: React.FC<{ items: string[]; delay?: number }> = ({ items, delay = 20 }) => {
  const f = useCurrentFrame();
  const full = items.join("  ·  ");
  const n = Math.floor(interpolate(f, [delay, delay + full.length * 0.38], [0, full.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const pulse = 0.55 + 0.45 * Math.sin(f / 6);
  return (
    <div style={{ position: "absolute", left: 120, right: 120, bottom: 64, display: "flex", alignItems: "center", gap: 14, fontFamily: F.mono, fontSize: 18, color: C.muted, letterSpacing: 0.2, opacity: f > delay ? 1 : 0 }}>
      <div style={{ width: 8, height: 8, borderRadius: 2, background: C.trade, opacity: pulse, boxShadow: `0 0 12px ${C.trade}` }} />
      <div style={{ whiteSpace: "nowrap" }}>
        {full.slice(0, n)}
        <span style={{ opacity: n < full.length ? 1 : 0, color: C.trade }}>▍</span>
      </div>
    </div>
  );
};

export const Glass: React.FC<{ style?: React.CSSProperties; children?: React.ReactNode }> = ({ style, children }) => (
  <div style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.02))", border: `1px solid ${C.hair}`, borderRadius: 26, boxShadow: "0 30px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)", ...style }}>{children}</div>
);

/** An iPhone frame around a real app screenshot. */
export const Phone: React.FC<{ src: string; height: number; style?: React.CSSProperties }> = ({ src, height, style }) => {
  const w = height * (1206 / 2622);
  return (
    <div style={{ width: w + 22, height: height + 22, borderRadius: height * 0.075, background: "linear-gradient(145deg,#2a2d33,#0d0e11)", padding: 11, boxShadow: "0 50px 120px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.08), 0 0 80px rgba(130,150,255,0.12)", ...style }}>
      <Img src={staticFile(`img/${src}`)} style={{ width: w, height, borderRadius: height * 0.066, display: "block" }} />
    </div>
  );
};

/** The app's basket ring: rounded segments with gaps, drawn on in order. */
export const Donut: React.FC<{ weights: number[]; size: number; stroke?: number; progress?: number; colors?: string[]; children?: React.ReactNode }> = ({ weights, size, stroke = size * 0.12, progress = 1, colors = C.picks, children }) => {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const total = weights.reduce((a, b) => a + b, 0);
  const gap = stroke * 1.15;
  let acc = 0;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        {weights.map((w, i) => {
          const start = acc / total;
          acc += w;
          const len = Math.max(0, (w / total) * circ - gap);
          const shown = Math.max(0, Math.min(len, (progress * circ - start * circ)));
          return <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={colors[i % colors.length]} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${shown} ${circ}`} strokeDashoffset={-start * circ - gap / 2} />;
        })}
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column" }}>{children}</div>
    </div>
  );
};

/** A pick row: color square, name, kind, weight. */
export const PickRow: React.FC<{ color: string; name: string; kind?: string; weight: string; size?: number; o?: number; logo?: string }> = ({ color, name, kind, weight, size = 22, o = 1, logo }) => (
  <div style={{ display: "flex", alignItems: "center", gap: size * 0.6, opacity: o, transform: `translateX(${(1 - o) * 16}px)` }}>
    <div style={{ width: size * 0.5, height: size * 0.5, borderRadius: 3, background: color }} />
    <div style={{ fontFamily: F.mono, fontSize: size * 0.82, color: C.text, width: size * 2.6 }}>{weight}</div>
    {logo ? <Brand k={logo} size={size * 1.25} /> : null}
    <div style={{ fontFamily: F.sans, fontWeight: 600, fontSize: size, color: C.text, flex: 1 }}>{name}</div>
    {kind ? <div style={{ fontFamily: F.sans, fontSize: size * 0.72, color: C.muted }}>{kind}</div> : null}
  </div>
);

export const Avatar: React.FC<{ n: 0 | 1; size: number; ring?: string }> = ({ n, size, ring }) => (
  <div style={{ width: size, height: size, borderRadius: size, background: n === 0 ? "#D1D4F9" : "#FFDFBF", overflow: "hidden", boxShadow: ring ? `0 0 0 3px ${ring}` : undefined, flexShrink: 0 }}>
    <Img src={staticFile(`img/avatar${n}.png`)} style={{ width: size * 1.05, height: size * 1.05, marginLeft: -size * 0.025, marginTop: -size * 0.025 }} />
  </div>
);

const PNG = new Set(["DKNG", "SQQQ", "LULU", "COIN"]);
/** A clean, transparent brand mark (public/img/marks). */
export const Brand: React.FC<{ k: string; size: number; style?: React.CSSProperties }> = ({ k, size, style }) => (
  <Img src={staticFile(`img/marks/${k}.${PNG.has(k) ? "png" : "svg"}`)} style={{ width: size, height: size, objectFit: "contain", flexShrink: 0, ...style }} />
);
