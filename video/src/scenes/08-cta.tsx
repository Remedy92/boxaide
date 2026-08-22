/**
 * Beat 8 — how do I get it.
 *
 * Mark, name, the two install lines, the repo. This is the one scene allowed
 * more than one element, because a call to action that says only its own name
 * is not a call to action.
 *
 * The commands are the ones on the real install page, character for character
 * (`COMMAND_LINES` in `apps/web/src/app/install/page.tsx`). A launch video
 * that invents a friendlier `npx` line sends every viewer to a command that
 * does not work.
 *
 * It fades to the ground the hook opened on, so X's default loop reads as
 * deliberate rather than as a cut.
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from "remotion";
import { T } from "../ui/tokens";
import { FONT, MONO, SMOOTH, ramp } from "../ui/kit";
import { Beat } from "../ui/beat";
import * as I from "../ui/icons";

const LINES = [
  "git clone https://github.com/Remedy92/boxaide.git",
  "cd boxaide && npm install && npm run dev",
] as const;

export const CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const mark = spring({ frame: frame - 4, fps, config: SMOOTH, durationInFrames: 30 });
  const term = spring({ frame: frame - 34, fps, config: SMOOTH, durationInFrames: 30 });
  const foot = spring({ frame: frame - 96, fps, config: SMOOTH });

  const outro = ramp(frame, durationInFrames - 16, durationInFrames, 0, 1);

  return (
    <Beat bloom={1 - outro * 0.65}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          flexDirection: "column",
          gap: 40,
          opacity: 1 - outro * 0.92,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 22,
            opacity: mark,
            transform: `translateY(${(1 - mark) * 16}px)`,
          }}
        >
          <I.BrandGlyph size={80} color={T.fg} />
          <span
            style={{
              fontFamily: FONT,
              fontSize: 86,
              fontWeight: 600,
              letterSpacing: "-0.035em",
              color: T.fg,
            }}
          >
            Boxaide
          </span>
        </div>

        <div
          style={{
            width: 820,
            borderRadius: 14,
            border: `1px solid ${T.borderStrong}`,
            background: T.surface1,
            padding: "26px 30px",
            fontFamily: MONO,
            fontSize: 22,
            opacity: term,
            transform: `translateY(${(1 - term) * 18}px)`,
          }}
        >
          {LINES.map((l, i) => {
            const chars = Math.max(0, Math.floor((frame - 46 - i * 30) * 2.4));
            return (
              <div key={l} style={{ lineHeight: "38px", whiteSpace: "pre" }}>
                <span style={{ color: T.accent }}>$ </span>
                <span style={{ color: T.fg }}>{l.slice(0, chars)}</span>
              </div>
            );
          })}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            fontFamily: FONT,
            fontSize: 28,
            color: T.fgSecondary,
            opacity: foot,
            transform: `translateY(${(1 - foot) * 12}px)`,
          }}
        >
          <I.GitHub size={26} color={T.fg} />
          <span style={{ color: T.fg }}>github.com/Remedy92/boxaide</span>
          <span style={{ color: T.borderStrong }}>·</span>
          <span style={{ color: T.accent, fontWeight: 600 }}>MIT</span>
        </div>
      </AbsoluteFill>
    </Beat>
  );
};
