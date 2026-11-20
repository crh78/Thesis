import React from "react";
import { Composition } from "remotion";
import { Film, REEL, Tech, TECH } from "./Film";
import { FPS, H, W } from "./theme";

export const Root: React.FC = () => (
  <>
    <Composition id="Film" component={Film} durationInFrames={REEL + 8 + TECH} fps={FPS} width={W} height={H} />
    <Composition id="Tech" component={Tech} durationInFrames={TECH} fps={FPS} width={W} height={H} />
  </>
);
