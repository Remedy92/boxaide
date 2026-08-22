/**
 * Beat 5 — can I trust it.
 *
 * The most important claim in the video, so it gets the emptiest frame: the
 * approval card alone, at twice its real size, on the stage rather than
 * inside the app window.
 *
 * Taking it out of the window is the one place this video shows something
 * other than the literal UI, and it earns that: the card is 560px wide in a
 * 1440px app, which at rest scale is 448px of a 1920px frame — a quarter of
 * the screen for the sentence the whole product rests on. The copy on it is
 * the app's own, to the word.
 *
 * An early cut put this card inside the window, under a caption, over a mono
 * line, above a second mono line listing four tool names. Four things saying
 * one thing.
 *
 * It also flipped the primary button to a green "Sent" chip partway through.
 * That state does not exist: approving removes the card and raises a toast
 * reading exactly "Done." Inventing a confirmation undercut the one beat whose
 * entire job is to be believed, so the card now holds still and says "Send it"
 * for its whole time on screen.
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from "remotion";
import { ApprovalCard } from "../ui/overlays";
import { SMOOTH, ramp } from "../ui/kit";
import { Beat, Line, Hi, BELOW_BAND } from "../ui/beat";

export const ApprovalScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const card = spring({ frame: frame - 10, fps, config: SMOOTH, durationInFrames: 32 });

  return (
    <Beat
      drift={-2}
      bloom={ramp(frame, 0, 40, 0.7, 1)}
      line={
        <Line>
          It <Hi>never</Hi> sends without asking you first.
        </Line>
      }
    >
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            marginTop: BELOW_BAND,
            transform: `scale(${1.72 + (1 - card) * -0.05})`,
            opacity: card,
          }}
        >
          <ApprovalCard enter={1} />
        </div>
      </AbsoluteFill>
    </Beat>
  );
};
