import { existsSync } from "node:fs";
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
// 10-core Mac (4 performance + 6 efficiency): 8 tabs keeps every core busy without thrashing.
Config.setConcurrency(8);
// GPU (Metal via ANGLE) for the CSS blurs, glows and blend modes, instead of software rendering.
Config.setChromiumOpenGlRenderer("angle");
// Remotion's bundled headless shell crashed here ("Target closed"); system Chrome works.
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (existsSync(chrome)) Config.setBrowserExecutable(chrome);
