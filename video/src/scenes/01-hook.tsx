/**
 * Beat 1 — what is it.
 *
 * The mark draws itself, then one sentence. That is the whole scene.
 *
 * The first cut had the mark, a struck-through line, a second line and a
 * third line of small print, all inside four seconds. It looked like a slide
 * with builds. This holds on the mark, states the thing once, and stops.
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from "remotion";
import { T } from "../ui/tokens";
import { SMOOTH, ramp } from "../ui/kit";
import { Beat, Line, Hi } from "../ui/beat";

const DrawGlyph: React.FC<{ size: number; progress: number }> = ({
  size,
  progress,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={T.fg}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path
      d="M10.55 7.78L8.7 7.78L8.7 11.34L7.12 12L8.7 12.66L8.7 16.22L10.55 16.22"
      strokeWidth={1.24}
      pathLength={1}
      strokeDasharray={1}
      strokeDashoffset={1 - progress}
    />
    <path
      d="M13.45 7.78L15.3 7.78L15.3 11.34L16.88 12L15.3 12.66L15.3 16.22L13.45 16.22"
      strokeWidth={1.24}
      pathLength={1}
      strokeDasharray={1}
      strokeDashoffset={1 - progress}
    />
    <path
      d="M10.81 12L13.19 12"
      strokeWidth={1.27}
      stroke={T.accent}
      pathLength={1}
      strokeDasharray={1}
      strokeDashoffset={1 - Math.max(0, (progress - 0.55) / 0.45)}
    />
  </svg>
);

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 34 frames to draw, which is slow for a logo animation and deliberately so:
  // it sets the pace for everything after it.
  const draw = spring({ frame, fps, config: SMOOTH, durationInFrames: 34 });

  return (
    <Beat bloom={ramp(frame, 0, 46, 0.35, 1)}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          flexDirection: "column",
          gap: 56,
        }}
      >
        <DrawGlyph size={150} progress={draw} />
        <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
          <Line delay={44} size={58}>
            An inbox your agent can use,
            <br />
            that runs on <Hi>your own machine</Hi>.
          </Line>
        </div>
      </AbsoluteFill>
    </Beat>
  );
};
