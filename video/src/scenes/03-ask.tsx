/**
 * Beat 3 — what do I say to it.
 *
 * Four prompts, typed one at a time into the composer, each one staying on
 * screen after it is asked. By the end the viewer is looking at a short,
 * still list of things they could type tomorrow.
 *
 * An early cut ran six prompts at 0.8 seconds each with tool names and green
 * ticks flying past. Nobody can read that. This is four prompts at two seconds
 * each, no tool names, no ticks — because at this point in the video the
 * question is "what do I say to it", not "which function did it call". That
 * comes next.
 *
 * The first four are the app's own `SUGGESTIONS`, verbatim, from
 * `apps/web/src/components/agent/agent-view.tsx`.
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from "remotion";
import { T } from "../ui/tokens";
import { FONT, SMOOTH } from "../ui/kit";
import { Beat, Line, Hi } from "../ui/beat";
import * as I from "../ui/icons";

const PROMPTS = [
  "What came in today that needs a reply?",
  "Summarise the unread mail in my work mailbox.",
  "Find the last invoice from Stripe.",
  "Every weekday at 8, summarise what came in overnight.",
];

/** Frames per prompt: 30 to type, 30 to sit there and be read. */
const SLOT = 60;

export const AskScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: SMOOTH, durationInFrames: 26 });

  const idx = Math.min(PROMPTS.length - 1, Math.floor(frame / SLOT));
  const local = frame - idx * SLOT;
  const current = PROMPTS[idx];

  const typed = current.slice(
    0,
    Math.max(0, Math.min(current.length, Math.round((local / 30) * current.length))),
  );
  const settled = local >= 31;

  return (
    <Beat
      drift={2}
      line={
        <Line>
          Just <Hi>ask</Hi>, in plain English.
        </Line>
      }
    >
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          flexDirection: "column",
          paddingTop: 210,
          opacity: enter,
        }}
      >
        {/* The prompts already asked, kept still and legible. They are the
            point of the scene, not history to be faded out. */}
        <div
          style={{
            width: 1120,
            height: 180,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            gap: 18,
            marginBottom: 34,
          }}
        >
          {PROMPTS.slice(0, idx).map((p) => (
            <div
              key={p}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                fontFamily: FONT,
                fontSize: 30,
                letterSpacing: "-0.018em",
                color: T.fgTertiary,
              }}
            >
              <I.Check size={20} color={T.success} />
              {p}
            </div>
          ))}
        </div>

        {/* The composer, at 2.5x its real size so the caret is visible on a
            phone. Everything below the text field in the real composer is
            removed: the model picker and the hint line are two more things to
            read and neither answers the question this scene asks. */}
        <div
          style={{
            width: 1120,
            borderRadius: 18,
            border: `1px solid ${T.accentLine}`,
            background: T.surface1,
            boxShadow: T.shadowDialog,
            padding: "30px 34px",
            fontFamily: FONT,
            display: "flex",
            alignItems: "center",
            gap: 20,
          }}
        >
          <div
            style={{
              flex: 1,
              fontSize: 36,
              lineHeight: "48px",
              color: T.fg,
              letterSpacing: "-0.02em",
              minHeight: 48,
            }}
          >
            {typed}
            <span
              style={{
                display: "inline-block",
                width: 3,
                height: 36,
                background: T.accent,
                marginLeft: 4,
                transform: "translateY(5px)",
                opacity: settled && Math.floor(frame / 8) % 2 === 0 ? 0.15 : 1,
              }}
            />
          </div>
          <span
            style={{
              width: 44,
              height: 44,
              borderRadius: 11,
              flexShrink: 0,
              background: typed.length ? T.accentFill : T.surface2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <I.Send
              size={21}
              color={typed.length ? T.accentFillFg : T.fgDisabled}
            />
          </span>
        </div>
      </AbsoluteFill>
    </Beat>
  );
};
