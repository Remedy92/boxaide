/**
 * Beat 4 — what it actually does. The centrepiece, and the longest beat.
 *
 * Fourteen seconds, one slow move, and six activity lines that land one every
 * second and a half. The previous cut gave this eight seconds and ran the same
 * six lines through it in three, at 10px on screen — you could not read one of
 * them, which made the most important beat in the video the least legible.
 *
 * Two changes fix that:
 *
 *  1. The lines are the app's real plain-English narration, not tool names.
 *     "Reading your work inbox" is legible at a glance in a way that
 *     `messages_list │ work · INBOX · 31` never is, at any size.
 *  2. The camera pushes from rest to 1.5x over two seconds and then stops. At
 *     1.5x a 12px line is 18px of frame, which is readable on a phone.
 *
 * The caption fades as the camera moves, because at 1.5x the app plane fills
 * the frame and there is nowhere for it to sit. The narration carries the
 * label from there.
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from "remotion";
import { AppFrame, LeftRail } from "../ui/app-shell";
import { AgentView, STEPS } from "../ui/agent-view";
import { SMOOTH, framing } from "../ui/kit";
import { Beat, Line, Hi, REST_SCALE, STAGE_CENTER_Y } from "../ui/beat";

const PROMPT = "What came in today that needs a reply?";

/**
 * The answer, and every fact in it is checked. The roadmap review really does
 * say "before Friday" in the fixture seed (`src/cli.ts`) — an earlier cut had
 * the agent read that message and then assert Thursday, which is the worst
 * possible look for a mail product.
 */
const ANSWER =
  "Two of them. The Q3 roadmap review from ceo@work.test asks for\n" +
  "comments before Friday, and Acme's invoice INV-220 is due next week.\n\n" +
  "I have written a reply to the roadmap review. It is in Drafts, unsent.";

const WIDE = { scale: REST_SCALE, y: STAGE_CENTER_Y - 1080 / 2 };
/**
 * 1.34 is not arbitrary: 1920/1440 = 1.333 is the exact scale at which the app
 * plane fills the frame's width. Below it there is black down both sides;
 * above it the left rail walks out of shot, which is what 1.5 did — it framed
 * the conversation beautifully and amputated the app around it.
 *
 * At 1.34 a 12px activity line is 16px of frame, which is readable on a phone,
 * and the whole window is still recognisably the window.
 */
const CLOSE = { scale: 1.34, px: 720, py: 420 };

/** One activity line every 45 frames — a second and a half each. */
const STEP_EVERY = 45;
const FIRST_STEP = 40;

export const AgentScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: SMOOTH, durationInFrames: 30 });

  const steps = Math.max(
    0,
    Math.min(STEPS.length, Math.floor((frame - FIRST_STEP) / STEP_EVERY) + 1),
  );

  const ANSWER_AT = FIRST_STEP + STEPS.length * STEP_EVERY + 20;
  const chars = Math.max(0, Math.floor((frame - ANSWER_AT) * 2.1));
  const answer = ANSWER.slice(0, Math.min(chars, ANSWER.length));
  const typing = chars > 0 && chars < ANSWER.length;

  // One move: hold wide for three seconds, then push in over two, then stop.
  const push = spring({
    frame: frame - 90,
    fps,
    config: SMOOTH,
    durationInFrames: 60,
  });
  const f = framing(push, WIDE, CLOSE);

  // A live run counts up beside the headline.
  const elapsed = `${Math.max(1, Math.round((frame - FIRST_STEP + 30) / fps))}s`;

  return (
    <Beat
      drift={3}
      line={<Line exit={push}>Your own agent does the <Hi>work</Hi>.</Line>}
    >
      <AbsoluteFill
        style={{ justifyContent: "center", alignItems: "center", opacity: enter }}
      >
        <div
          style={{
            transform: `translate(${f.x}px, ${f.y + (1 - enter) * 20}px) scale(${f.scale})`,
            transformOrigin: "center center",
          }}
        >
          <AppFrame>
            <LeftRail active="agent" />
            <AgentView
              typed={PROMPT}
              sent
              steps={steps}
              answer={answer}
              caret={typing}
              frame={frame}
              elapsed={elapsed}
            />
          </AppFrame>
        </div>
      </AbsoluteFill>
    </Beat>
  );
};
