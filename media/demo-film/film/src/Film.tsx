import React from "react";
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion";
import { AssetScene, BadgeScene, ChatScene, CopyScene, LogoScene, OutroScene, ReceiptScene, RiskScene, SocialScene, TradableScene } from "./scenes";
import { STORY, Story } from "./Story";
import { Background } from "./ui";

// The story (Story.tsx) runs first; the technical section starts as its taillights fade.
export const REEL = STORY;
const HANDOFF = 12;

export const SECTIONS: [string, React.FC<{ dur: number }>, number][] = [
  ["logo", LogoScene, 115],
  ["tradable", TradableScene, 185],
  ["risk", RiskScene, 240],
  ["assets", AssetScene, 387],
  ["chat", ChatScene, 205],
  ["copy", CopyScene, 135],
  ["social", SocialScene, 150],
  ["receipt", ReceiptScene, 185],
  ["badges", BadgeScene, 120],
  ["outro", OutroScene, 135],
];
export const TECH = SECTIONS.reduce((a, s) => a + s[2], 0);

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

/** The whole film: the story → its taillights burst into the logo's pixels → the technical section. */
export const Film: React.FC = () => (
  <AbsoluteFill style={{ background: "#000" }}>
    <Sequence durationInFrames={REEL} name="story">
      <Story />
    </Sequence>
    <Sequence from={REEL - HANDOFF} durationInFrames={TECH} name="tech">
      <FadeIn frames={HANDOFF}><Tech /></FadeIn>
    </Sequence>
  </AbsoluteFill>
);

const FadeIn: React.FC<{ frames: number; children: React.ReactNode }> = ({ frames, children }) => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: interpolate(f, [0, frames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>{children}</AbsoluteFill>;
};
