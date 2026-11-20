import React from "react";
import { Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import logo from "./logo.json";
import { C, F, prog, rand, sp } from "./theme";

const rects = (logo as { rects: { x: number; y: number; w: number; fill: string }[] }).rects;

/**
 * The Pixel reactions mark. With `assemble`, its 82 squares fly in from a scattered cloud and snap
 * onto the grid, then the two reaction avatars pop in. `size` is the mark's box in px (viewBox 100).
 */
/** `from`: px offset (from the mark's top-left) the squares burst out of, starting red, like taillights breaking apart. */
export const Mark: React.FC<{ size: number; assemble?: boolean; start?: number; from?: [number, number] }> = ({ size, assemble = false, start = 0, from }) => {
  const frame = useCurrentFrame() - start;
  const { fps } = useVideoConfig();
  const k = size / 100;
  // bubble center, used to order squares from the middle out
  const cx = 28, cy = 50;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      {rects.map((r, i) => {
        const dist = Math.hypot(r.x - cx, r.y - cy);
        const delay = assemble ? (from ? 2 + rand(i) * 16 : 4 + dist * 0.55 + rand(i) * 10) : 0;
        const s = assemble ? sp(frame, fps, delay, 16, 0.9) : 1;
        const ang = rand(i + 1) * Math.PI * 2;
        const far = 260 + rand(i + 2) * 520;
        const x0 = from ? from[0] - r.x * k + (rand(i + 4) - 0.5) * 40 : Math.cos(ang) * far;
        const y0 = from ? from[1] - r.y * k + (rand(i + 5) - 0.5) * 24 : Math.sin(ang) * far;
        const rot = (rand(i + 3) - 0.5) * 360;
        const o = assemble ? (from ? interpolate(frame, [0, 3], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : interpolate(frame, [delay - 6, delay + 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })) : 1;
        const red = from && assemble ? Math.max(0, 1 - s * 1.6) : 0;
        const glow = assemble ? Math.max(0, 1 - Math.abs(frame - delay - 12) / 10) : 0;
        return (
          <div key={i} style={{
            position: "absolute", left: r.x * k, top: r.y * k, width: r.w * k, height: r.w * k, borderRadius: 0.5 * k, background: red > 0.5 ? "#FF3B30" : r.fill,
            opacity: o, transform: `translate(${x0 * (1 - s)}px, ${y0 * (1 - s)}px) rotate(${rot * (1 - s)}deg) scale(${0.4 + 0.6 * s})`,
            boxShadow: red > 0 ? `0 0 ${18 * red}px #FF3B30` : glow > 0 ? `0 0 ${14 * glow}px ${r.fill}` : undefined,
          }} />
        );
      })}
      {([[0, 86, 22, C.fade], [1, 68, 28, C.trade]] as const).map(([n, x, y, ring], j) => {
        const d = assemble ? 52 + j * 9 : 0;
        const s = assemble ? sp(frame, fps, d, 11, 0.7) : 1;
        const r = 12.5 * k;
        return (
          <div key={n} style={{ position: "absolute", left: (x - 13.9) * k, top: (y - 13.9) * k, width: 27.8 * k, height: 27.8 * k, borderRadius: "50%", border: `${2.8 * k}px solid ${ring}`, transform: `scale(${s})`, opacity: Math.min(1, s * 1.5), display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" }}>
            <div style={{ width: r * 2, height: r * 2, borderRadius: "50%", overflow: "hidden", background: n === 0 ? "#D1D4F9" : "#FFDFBF" }}>
              <Img src={staticFile(`img/avatar${n}.png`)} style={{ width: 26.25 * k, height: 26.25 * k, marginLeft: (r * 2 - 26.25 * k) / 2, marginTop: (r * 2 - 26.25 * k) / 2 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** "thesis" in Geist Pixel, typed in letter by letter, with an optional tagline. */
export const Wordmark: React.FC<{ size: number; start?: number; tagline?: string; animate?: boolean }> = ({ size, start = 0, tagline, animate = true }) => {
  const f = useCurrentFrame() - start;
  const word = "thesis";
  const n = animate ? Math.floor(interpolate(f, [0, 16], [0, word.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })) : word.length;
  const t = animate ? prog(f, 20, 40) : 1;
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontFamily: F.pixel, fontSize: size, color: C.text, letterSpacing: size * 0.02, height: size * 1.1 }}>
        {word.split("").map((ch, i) => <span key={i} style={{ opacity: i < n ? 1 : 0 }}>{ch}</span>)}
      </div>
      {tagline ? <div style={{ fontFamily: F.mono, fontSize: size * 0.2, color: C.muted, letterSpacing: size * 0.012, opacity: t, marginTop: size * 0.08 }}>{tagline}</div> : null}
    </div>
  );
};
