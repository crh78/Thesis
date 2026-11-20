import { continueRender, delayRender, Easing, interpolate, spring, staticFile } from "remotion";

export const FPS = 30;
export const W = 1920;
export const H = 1080;

export const C = {
  bg: "#07080B",
  text: "#F2F3F5",
  muted: "#9AA0AA",
  faint: "rgba(242,243,245,0.42)",
  hair: "rgba(255,255,255,0.09)",
  glass: "rgba(255,255,255,0.035)",
  up: "#A6E3B8",
  down: "#F2A9C2",
  trade: "#A9E3BA",
  fade: "#F3B6CC",
  aurora: "#8296FF",
  gold: "#E8C46A",
  picks: ["#3987E5", "#D95926", "#199E70", "#C98500", "#D55181", "#8296FF"],
};

export const F = {
  sans: "Geist",
  mono: "GeistMono",
  serif: "GeistSerif",
  pixel: "GeistPixel",
};

const faces: [string, string, string][] = [
  ["Geist", "Geist-Regular.ttf", "400"],
  ["Geist", "Geist-Medium.ttf", "500"],
  ["Geist", "Geist-SemiBold.ttf", "600"],
  ["Geist", "Geist-Bold.ttf", "700"],
  ["GeistMono", "GeistMono-Regular.ttf", "400"],
  ["GeistMono", "GeistMono-Medium.ttf", "500"],
  ["GeistMono", "GeistMono-SemiBold.ttf", "600"],
  ["GeistSerif", "GeistSerif-Regular.ttf", "400"],
  ["GeistPixel", "GeistPixel-Square.ttf", "400"],
];

if (typeof document !== "undefined") {
  const handle = delayRender("fonts");
  Promise.all(
    faces.map(([family, file, weight]) => {
      const face = new FontFace(family, `url(${staticFile(`fonts/${file}`)})`, { weight });
      return face.load().then((f) => document.fonts.add(f));
    }),
  ).then(() => continueRender(handle));
}

export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

/** 0→1 between frames a and b with ease-out. */
export const prog = (f: number, a: number, b: number, ease = easeOut) =>
  interpolate(f, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });

export const sp = (frame: number, fps: number, delay = 0, damping = 18, mass = 0.8) =>
  spring({ frame: frame - delay, fps, config: { damping, mass, stiffness: 140 } });

/** Deterministic pseudo-random in [0,1). */
export const rand = (seed: number) => {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};
