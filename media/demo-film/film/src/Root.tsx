import React from "react";
import { Composition } from "remotion";
import { Film, REEL, Tech, TECH } from "./Film";
import { GroupChatInsert, INSERT } from "./Insert";
import { ChatScreen, NotifScreen, PHONE_UI, PhoneUI, SH, SW } from "./Screens";
import { STORY, Story } from "./Story";
import { GUIDE, Guide } from "./Guide";
import { FullFilm } from "./FullFilm";
import { FPS, H, W } from "./theme";

export const Root: React.FC = () => (
  <>
    <Composition id="Film" component={Film} durationInFrames={REEL - 12 + TECH} fps={FPS} width={W} height={H} />
    <Composition id="Tech" component={Tech} durationInFrames={TECH} fps={FPS} width={W} height={H} />
    <Composition id="GroupChatInsert" component={GroupChatInsert} durationInFrames={INSERT} fps={FPS} width={W} height={H} />
    <Composition id="NotifScreen" component={NotifScreen} durationInFrames={1} fps={FPS} width={SW} height={SH} />
    <Composition id="ChatScreen" component={ChatScreen} durationInFrames={1} fps={FPS} width={SW} height={SH} />
    <Composition id="Guide" component={Guide} durationInFrames={GUIDE} fps={FPS} width={W} height={H} />
    <Composition id="FullFilm" component={FullFilm} durationInFrames={STORY + GUIDE} fps={FPS} width={W} height={H} />
    <Composition id="PhoneUI" component={PhoneUI} durationInFrames={PHONE_UI.frames} fps={PHONE_UI.fps} width={PHONE_UI.w} height={PHONE_UI.h} />
    <Composition id="Story" component={Story} durationInFrames={STORY} fps={FPS} width={W} height={H} />
  </>
);
