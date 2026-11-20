import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { GUIDE, Guide } from "./Guide";
import { STORY, Story } from "./Story";

/** The whole film: the cinematic story, then the app walkthrough. */
export const FullFilm: React.FC = () => (
  <AbsoluteFill style={{ background: "#000" }}>
    <Sequence durationInFrames={STORY} name="story">
      <Story />
    </Sequence>
    <Sequence from={STORY} durationInFrames={GUIDE} name="walkthrough">
      <Guide />
    </Sequence>
  </AbsoluteFill>
);
