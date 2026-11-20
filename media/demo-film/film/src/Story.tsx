import React from "react";
import { AbsoluteFill, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { easeInOut, F, rand } from "./theme";

/**
 * The story as one continuous film: every Seedance shot (public/shots) joined with a real transition,
 * a light grade, letterbox, grain and a slow push on every shot. No music; each shot keeps its own
 * dialogue and sound, crossfaded at the joins.
 */

type In = "open" | "push" | "whip" | "dissolve" | "flash" | "black" | "cut";
type Shot = { id: string; dur: number; in: In; t: number; muted?: boolean; card?: boolean };

// dur in frames at 30 fps (the 24 fps clips' full length); t = frames of overlap with the shot before.
const SHOTS: Shot[] = [
  { id: "intro", dur: 151, in: "open", t: 0, muted: true },
  { id: "s1", dur: 211, in: "cut", t: 0 },
  { id: "s2", dur: 181, in: "cut", t: 0 },
  { id: "s3", dur: 151, in: "cut", t: 0 },
  { id: "s3b", dur: 181, in: "cut", t: 0 },
  { id: "s4a", dur: 151, in: "cut", t: 0 },
  { id: "s4x", dur: 211, in: "cut", t: 0 },
  { id: "s4b", dur: 151, in: "cut", t: 0 },
  { id: "s4c", dur: 181, in: "cut", t: 0 },
  { id: "card", dur: 66, in: "cut", t: 0, card: true },
  { id: "s5", dur: 211, in: "cut", t: 0 },
  { id: "s6", dur: 211, in: "cut", t: 0 },
  { id: "s7", dur: 241, in: "cut", t: 0 },
  { id: "s8", dur: 121, in: "cut", t: 0 },
];

const starts: number[] = [];
SHOTS.forEach((s, i) => starts.push(i === 0 ? 0 : starts[i - 1] + SHOTS[i - 1].dur - s.t));
export const STORY = starts[SHOTS.length - 1] + SHOTS[SHOTS.length - 1].dur;

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const BAR = 64; // letterbox, close to 2:1

/** How a shot enters and leaves, as transform/filter/opacity, from its own frame. */
const look = (f: number, s: Shot, next?: Shot) => {
  let x = 0, scale = 1, blur = 0, o = 1, bright = 1;
  const p = s.t > 0 ? interpolate(f, [0, s.t], [0, 1], { ...clamp, easing: easeInOut }) : 1;
  if (s.in === "open") o = interpolate(f, [0, 18], [0, 1], clamp);
  if (s.in === "push") { scale *= 1.18 - 0.18 * p; o = p; blur += (1 - p) * 6; }
  if (s.in === "whip") { x += (1 - p) * 900; blur += (1 - p) * 28; o = Math.min(1, p * 2.5); }
  if (s.in === "dissolve") o = p;
  if (s.in === "black") o = interpolate(f, [0, 12], [0, 1], clamp);
  if (s.in === "cut") o = p;
  // leaving: match the next shot's entrance
  if (next) {
    const q = next.t > 0 ? interpolate(f, [s.dur - next.t, s.dur], [0, 1], { ...clamp, easing: easeInOut }) : 0;
    if (next.in === "push") { scale *= 1 + q * 0.35; blur += q * 8; }
    if (next.in === "whip") { x -= q * 900; blur += q * 28; }
    if (next.in === "black") bright *= interpolate(f, [s.dur - 12, s.dur], [1, 0], clamp);
  } else {
    bright *= interpolate(f, [s.dur - 20, s.dur], [1, 0], clamp); // the very end
  }
  scale *= 1 + 0.02 * (f / s.dur); // a slow, barely-there push on every shot
  return { x, scale, blur, o, bright };
};

const vol = (f: number, s: Shot, next?: Shot) => {
  if (s.muted || s.card) return 0;
  const a = s.t > 0 ? interpolate(f, [0, s.t], [0, 1], clamp) : interpolate(f, [0, 4], [0, 1], clamp);
  const n = next && next.t > 0 ? next.t : 6;
  const b = interpolate(f, [s.dur - n, s.dur], [1, 0], clamp);
  return Math.min(a, b);
};

const Card: React.FC = () => {
  const f = useCurrentFrame();
  const o = interpolate(f, [8, 22, 50, 64], [0, 1, 1, 0], clamp);
  const sp = interpolate(f, [8, 64], [6, 12], clamp);
  return (
    <AbsoluteFill style={{ background: "#000", alignItems: "center", justifyContent: "center" }}>
      <div style={{ fontFamily: F.serif, fontSize: 76, color: "#fff", opacity: o, letterSpacing: sp * 0.1, filter: `blur(${(1 - o) * 4}px)` }}>Six months later.</div>
    </AbsoluteFill>
  );
};

const ShotView: React.FC<{ s: Shot; next?: Shot }> = ({ s, next }) => {
  const f = useCurrentFrame();
  if (s.card) return <Card />;
  const { x, scale, blur, o, bright } = look(f, s, next);
  const chat = 0;
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <OffthreadVideo src={staticFile(`shots/${s.id}.mp4`)} volume={(fr) => vol(fr, s, next)}
        style={{ width: "100%", height: "100%", objectFit: "cover",
          transform: `translateX(${x}px) scale(${scale + chat * 0.03})`,
          filter: `blur(${blur + chat * 9}px) brightness(${bright * (1 - chat * 0.35)}) contrast(1.06) saturate(1.08)` }} />
    </AbsoluteFill>
  );
};

/** White flash at a hard cut. */
const Flash: React.FC = () => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ background: "#FFF6E0", opacity: interpolate(f, [0, 3, 14], [0, 0.95, 0], clamp) }} />;
};

export const Story: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {SHOTS.map((s, i) => (
        <Sequence key={s.id} from={starts[i]} durationInFrames={s.dur} name={s.id}>
          <ShotView s={s} next={SHOTS[i + 1]} />
        </Sequence>
      ))}
      {SHOTS.map((s, i) => s.in === "flash" ? (
        <Sequence key={`flash-${s.id}`} from={starts[i] - 3} durationInFrames={16} name="flash"><Flash /></Sequence>
      ) : null)}
      {/* grade: warm highlights, vignette */}
      <AbsoluteFill style={{ background: "radial-gradient(120% 95% at 50% 45%, transparent 55%, rgba(0,0,0,0.55))", pointerEvents: "none" }} />
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(255,170,90,0.05), transparent 40%, rgba(40,60,120,0.06))", mixBlendMode: "soft-light" }} />
      {/* grain */}
      <AbsoluteFill style={{ backgroundImage: `url(${staticFile("img/grain.png")})`, backgroundSize: "512px 512px", backgroundPosition: `${Math.floor(rand(f) * 512)}px ${Math.floor(rand(f + 99) * 512)}px`, opacity: 0.07, mixBlendMode: "overlay" }} />
      {/* letterbox */}
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: BAR, background: "#000" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: BAR, background: "#000" }} />
    </AbsoluteFill>
  );
};
