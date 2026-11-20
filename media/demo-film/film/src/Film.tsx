import React from "react";
import { AbsoluteFill, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { AssetScene, BadgeScene, ChatScene, CopyScene, LogoScene, OutroScene, ReceiptScene, RiskScene, SocialScene, TradableScene } from "./scenes";
import { Background } from "./ui";

export const REEL = 2046; // 68.2s of the vertical story reel at 30 fps
const FADE = 36;

export const SECTIONS: [string, React.FC<{ dur: number }>, number][] = [
  ["logo", LogoScene, 115],
  ["tradable", TradableScene, 185],
  ["risk", RiskScene, 240],
  ["assets", AssetScene, 255],
  ["chat", ChatScene, 205],
  ["copy", CopyScene, 135],
  ["social", SocialScene, 150],
  ["receipt", ReceiptScene, 185],
  ["badges", BadgeScene, 120],
  ["outro", OutroScene, 135],
];
export const TECH = SECTIONS.reduce((a, s) => a + s[2], 0);

/** The vertical reel, centered over a blurred fill, fading to black at the end. */
const Reel: React.FC = () => {
  const f = useCurrentFrame();
  const fade = interpolate(f, [REEL - FADE, REEL], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const src = staticFile("reel.mp4");
  return (
    <AbsoluteFill style={{ background: "#000", opacity: fade }}>
      <AbsoluteFill style={{ filter: "blur(40px) brightness(0.35) saturate(1.2)", transform: "scale(1.2)" }}>
        <OffthreadVideo src={src} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <OffthreadVideo src={src} volume={(fr) => interpolate(fr, [REEL - FADE, REEL], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} style={{ height: 1080, width: 1080 * (480 / 854), boxShadow: "0 0 120px rgba(0,0,0,0.8)" }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Just the Remotion section, for previewing without the reel. */
export const Tech: React.FC = () => {
  let at = 0;
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Background />
      {SECTIONS.map(([name, S, dur]) => {
        const from = at;
        at += dur;
        return (
          <Sequence key={name} from={from} durationInFrames={dur} name={name}>
            <S dur={dur} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

/** The whole film: reel → fade to black → the technical section. */
export const Film: React.FC = () => (
  <AbsoluteFill style={{ background: "#000" }}>
    <Sequence durationInFrames={REEL} name="reel">
      <Reel />
    </Sequence>
    <Sequence from={REEL + 8} durationInFrames={TECH} name="tech">
      <Tech />
    </Sequence>
  </AbsoluteFill>
);
