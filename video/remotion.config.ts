import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setCodec("h264");
// X transcodes aggressively; a high bitrate in keeps UI text legible out.
Config.setCrf(16);
Config.setChromiumOpenGlRenderer("angle");
Config.setEntryPoint("src/index.ts");
