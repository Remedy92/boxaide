/**
 * Beat 2 — what it looks like.
 *
 * The app, whole, at rest, held still. One line above it. Nothing else.
 *
 * The rows still cascade in, because a mail list assembling is the one motion
 * that says "this is a real client" rather than "this is a screenshot" — but
 * at one row every five frames rather than every three, and then the frame
 * stops moving for two full seconds so a viewer can actually read a subject
 * line. There is no push-in here: the close-ups come later, and doing one in
 * every scene is what made the first cut restless.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, spring } from "remotion";
import { T } from "../ui/tokens";
import { AppFrame, LeftRail, MessageList, Reader, MESSAGES } from "../ui/app-shell";
import { ramp, SMOOTH } from "../ui/kit";
import { Beat, Line, Hi, AppAt } from "../ui/beat";

export const InboxScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: SMOOTH, durationInFrames: 40 });

  // One row every eight frames. The list assembling is the one motion that
  // says "real client" rather than "screenshot", and at this pace you can read
  // the top two subjects while the rest arrive.
  const rowOpacity = (i: number) => ramp(frame, 34 + i * 8, 50 + i * 8, 0, 1);
  const rowShift = (i: number) =>
    (1 - ramp(frame, 34 + i * 8, 56 + i * 8, 0, 1)) * 8;

  const readerIn = ramp(frame, 110, 138, 0, 1);
  const selected = frame >= 112 ? 3 : null;

  return (
    <Beat
      drift={ramp(frame, 0, 225, 0, 3)}
      line={
        <Line>
          Every mailbox you own, in <Hi>one list</Hi>.
        </Line>
      }
    >
      <AppAt opacity={enter} y={(1 - enter) * 26}>
        <AppFrame>
          <LeftRail active="inbox" />
          <MessageList
            selected={selected}
            rowOpacity={rowOpacity}
            rowShift={rowShift}
          />
          <div style={{ flex: 1, opacity: readerIn, background: T.surface2 }}>
            <Reader msg={MESSAGES[3]} />
          </div>
        </AppFrame>
      </AppAt>
    </Beat>
  );
};
