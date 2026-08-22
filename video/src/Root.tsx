import React from "react";
import { Composition, Still } from "remotion";
import { Launch, LaunchSquare, TOTAL, FPS } from "./Launch";
import { HAS_VOICEOVER } from "./voiceover";
import { CTA } from "./scenes/08-cta";

/**
 * Two cuts, a silent fallback, and a poster.
 *
 * `LaunchX` is the one to post: 1920x1080 at 30fps is X's own recommendation
 * for landscape, and the product is a three-pane desktop app that a 9:16 crop
 * would destroy. `LaunchSquare` is the same cut letterboxed into 1:1 for the
 * mobile timeline, where a square post occupies close to twice the height.
 *
 * `LaunchXSilent` exists because X autoplays muted and some people post that
 * way deliberately. It also renders before `scripts/make-voiceover.mjs` has
 * ever run.
 *
 * `Poster` is the frame X shows before playback starts — the CTA, so a
 * scroll-past still carries the name and the licence.
 */
export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="LaunchX"
      component={Launch}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ voiceover: HAS_VOICEOVER, music: true }}
    />
    <Composition
      id="LaunchSquare"
      component={LaunchSquare}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1080}
      height={1080}
      defaultProps={{ voiceover: HAS_VOICEOVER, music: true }}
    />
    <Composition
      id="LaunchXSilent"
      component={Launch}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ voiceover: false, music: false }}
    />
    <Still id="Poster" component={CTA} width={1920} height={1080} />
  </>
);
