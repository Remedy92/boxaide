/**
 * The cut.
 *
 * Eight beats, ~46 seconds, 30fps, joined by 14-frame cross-fades.
 *
 * One idea per beat, one line of type per beat, and the app held at the same
 * size and position throughout — see `src/ui/beat.tsx` for why. Each beat is
 * long enough that something arrives and then stops moving; the earlier cut
 * of this video never stopped moving and was tiring to watch.
 *
 * Act lengths live in `src/timeline.ts`, not here, because the music and the
 * voiceover are generated against the same numbers.
 *
 * Audio is two stems: a synthesised bed (`scripts/make-music.mjs`) and a
 * narration track (`scripts/make-voiceover.mjs`). The bed ducks under the
 * voice rather than being mixed flat, because X autoplays muted — the video
 * has to work with no audio at all, and then reward turning it on.
 */
import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

import { ACTS, FPS, TOTAL, X } from "./timeline";
import { VO_LINES } from "./voiceover";
import { Hook } from "./scenes/01-hook";
import { InboxScene } from "./scenes/02-inbox";
import { AskScene } from "./scenes/03-ask";
import { AgentScene } from "./scenes/04-agent";
import { ApprovalScene } from "./scenes/05-approval";
import { AutomationsScene } from "./scenes/06-automations";
import { LocalScene } from "./scenes/07-local";
import { CTA } from "./scenes/08-cta";

// Only the weights and the subset this cut uses. The unfiltered call fetches
// 126 font files, which slows every render and every studio reload.
loadInter("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });
loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] });

export { FPS, TOTAL };

const SCENES: Record<string, React.FC> = {
  hook: Hook,
  inbox: InboxScene,
  ask: AskScene,
  agent: AgentScene,
  approval: ApprovalScene,
  automations: AutomationsScene,
  local: LocalScene,
  cta: CTA,
};

export const Visuals: React.FC = () => (
  <TransitionSeries>
    {ACTS.flatMap((act, i) => {
      const Scene = SCENES[act.id];
      const nodes = [
        <TransitionSeries.Sequence
          key={act.id}
          durationInFrames={act.frames}
          premountFor={30}
        >
          <Scene />
        </TransitionSeries.Sequence>,
      ];
      if (i < ACTS.length - 1) {
        nodes.push(
          <TransitionSeries.Transition
            key={`${act.id}-x`}
            presentation={fade()}
            timing={linearTiming({ durationInFrames: X })}
          />,
        );
      }
      return nodes;
    })}
  </TransitionSeries>
);

/**
 * The music bed, ducked under narration.
 *
 * `volume` takes a per-frame function, which is the whole reason the voiceover
 * lines carry their own frame ranges: the bed drops to 32% while a line is
 * speaking and comes back up between them, with a 6-frame ramp on each side so
 * the duck is not audible as a step.
 */
const DUCK = 0.32;
const RAMP = 6;

const bedVolume = (frame: number) => {
  let duck = 1;
  for (const line of VO_LINES) {
    const { from, durationInFrames } = line;
    const to = from + durationInFrames;
    if (frame < from - RAMP || frame > to + RAMP) continue;
    const inRamp = Math.min(1, Math.max(0, (frame - (from - RAMP)) / RAMP));
    const outRamp = Math.min(1, Math.max(0, (to + RAMP - frame) / RAMP));
    duck = Math.min(duck, 1 - (1 - DUCK) * Math.min(inRamp, outRamp));
  }
  return duck;
};

const Bed: React.FC = () => (
  <Audio src={staticFile("soundtrack.wav")} volume={bedVolume} />
);

/**
 * One <Audio> per narration line, each starting on the frame of the beat it
 * describes. Separate clips rather than one long file so a re-recorded line
 * does not shift every line after it.
 *
 * A missing file would fail the render, so the whole track is opt-in: pass
 * `voiceover={false}` (the Silent compositions) to cut without narration.
 */
const Narration: React.FC = () => (
  <>
    {VO_LINES.map((line) => (
      <Sequence
        key={line.id}
        from={line.from}
        durationInFrames={line.durationInFrames}
        layout="none"
      >
        <Audio src={staticFile(`vo/${line.id}.wav`)} />
      </Sequence>
    ))}
  </>
);

export const Launch: React.FC<{ voiceover?: boolean; music?: boolean }> = ({
  voiceover = true,
  music = true,
}) => (
  <AbsoluteFill style={{ background: "#050506" }}>
    <Visuals />
    {music && <Bed />}
    {voiceover && <Narration />}
  </AbsoluteFill>
);

/**
 * The 1:1 cut for the mobile timeline. Same acts, scaled to fit 1080x1080 and
 * pillarboxed on near-black, so the crop never eats a caption. X shows 16:9
 * letterboxed on mobile at roughly half the height a square post gets, which
 * is the whole reason this variant exists.
 */
export const LaunchSquare: React.FC<{
  voiceover?: boolean;
  music?: boolean;
}> = (props) => (
  <AbsoluteFill
    style={{ background: "#050506", justifyContent: "center", alignItems: "center" }}
  >
    <div
      style={{
        width: 1920,
        height: 1080,
        transform: "scale(0.5625)",
        transformOrigin: "center center",
        flexShrink: 0,
      }}
    >
      <Launch {...props} />
    </div>
  </AbsoluteFill>
);
