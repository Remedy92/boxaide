/**
 * Beat 6 — what happens while I'm away.
 *
 * One automation card, alone, at readable size, with its instructions already
 * open. Not three cards and not a camera move into one of them.
 *
 * The card is the argument: a schedule in plain words, the cron expression the
 * scheduler actually evaluates beside it, and a paragraph of instructions that
 * is obviously something somebody said out loud rather than filled into a
 * form. That last part is why the instructions are open from the start —
 * unfolding them mid-scene made it a reveal, and it is not a reveal, it is the
 * content.
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from "remotion";
import { AutomationCard, AUTOMATIONS } from "../ui/automations";
import { SMOOTH } from "../ui/kit";
import { Beat, Line, Hi, BELOW_BAND } from "../ui/beat";

export const AutomationsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const card = spring({ frame: frame - 8, fps, config: SMOOTH, durationInFrames: 32 });

  return (
    <Beat
      drift={1}
      line={
        <Line>
          Say it <Hi>once</Hi>. It runs every morning.
        </Line>
      }
    >
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            marginTop: BELOW_BAND,
            width: 700,
            transform: `scale(${1.62}) translateY(${(1 - card) * 14}px)`,
            opacity: card,
          }}
        >
          <AutomationCard a={AUTOMATIONS[0]} open />
        </div>
      </AbsoluteFill>
    </Beat>
  );
};
