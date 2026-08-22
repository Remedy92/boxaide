/**
 * The one layout every scene uses.
 *
 * The first cut of this video put a kicker, a headline, a floating pill and a
 * row of chips on the same frame as the app, and every scene arranged them
 * differently. The result was busy and, worse, it felt like a different camera
 * setup each time — nothing carried from one cut to the next.
 *
 * So: a fixed caption band across the top, a fixed stage below it, and a hard
 * rule of **one line of type per scene**. The app is always centred on the same
 * point at the same size, so a cut between two app scenes reads as the same
 * screen changing rather than a new shot being set up.
 *
 * Everything that used to be a second or third element is either folded into
 * the one line or cut. If a fact cannot survive that, it was not important
 * enough to be in a 45-second video.
 */
import React from "react";
import {
  AbsoluteFill,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { T } from "./tokens";
import { FONT, SMOOTH, Stage } from "./kit";

/** The caption band. Nothing else is ever drawn in here. */
export const CAPTION_BAND = 210;
/** Where the app plane's centre sits, in frame coordinates. */
export const STAGE_CENTER_Y = 662;
/**
 * How far to nudge free-standing content down so that it is centred in the
 * space *below* the caption band rather than in the whole frame. Half the band,
 * by definition. Scenes that eyeballed this ended up sitting low with a hole
 * above them.
 */
export const BELOW_BAND = CAPTION_BAND / 2;

/** The scale every app scene uses at rest. */
// 0.86 puts the 1440x900 plane at 1238x774. Larger crowds the caption band;
// smaller leaves so much black on either side that the app stops feeling like
// the subject of the frame.
export const REST_SCALE = 0.86;

/**
 * One line, one fade, one rise. No per-word stagger and no kicker: at 45px on
 * a phone the stagger is invisible and the kicker is just a second thing to
 * read before the sentence you actually wrote.
 */
export const Line: React.FC<{
  children: React.ReactNode;
  delay?: number;
  size?: number;
  /** Fades the line out again, for a scene that pushes into a close-up. */
  exit?: number;
}> = ({ children, delay = 6, size = 46, exit = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({
    frame: frame - delay,
    fps,
    config: SMOOTH,
    durationInFrames: 26,
  });
  return (
    <div
      style={{
        fontFamily: FONT,
        fontSize: size,
        lineHeight: 1.18,
        fontWeight: 600,
        letterSpacing: "-0.024em",
        color: T.fg,
        textAlign: "center",
        maxWidth: 1300,
        opacity: p * (1 - exit),
        transform: `translateY(${(1 - p) * 18}px)`,
      }}
    >
      {children}
    </div>
  );
};

/** The accent span used for the one word per line that carries the point. */
export const Hi: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ color: T.accent }}>{children}</span>
);

export const Beat: React.FC<{
  /** The single line of type. Pass `null` for a scene that speaks for itself. */
  line?: React.ReactNode;
  children?: React.ReactNode;
  /** Slow vertical drift of the background bloom, in percent. */
  drift?: number;
  bloom?: number;
}> = ({ line, children, drift = 0, bloom = 1 }) => (
  <Stage drift={drift} bloom={bloom}>
    {children}
    {line !== undefined && line !== null && (
      <AbsoluteFill
        style={{
          height: CAPTION_BAND,
          justifyContent: "center",
          alignItems: "center",
          paddingLeft: 80,
          paddingRight: 80,
        }}
      >
        {line}
      </AbsoluteFill>
    )}
  </Stage>
);

/**
 * Places the app plane at the fixed stage centre. `scale` and `focus` let a
 * scene push in, but the resting position is the same in every scene and is
 * not a per-scene decision.
 */
export const AppAt: React.FC<{
  children: React.ReactNode;
  scale?: number;
  /** Offset from the plane's own centre, already scaled. */
  x?: number;
  y?: number;
  opacity?: number;
}> = ({ children, scale = REST_SCALE, x = 0, y = 0, opacity = 1 }) => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity }}>
    <div
      style={{
        transform: `translate(${x}px, ${
          y + STAGE_CENTER_Y - 1080 / 2
        }px) scale(${scale})`,
        transformOrigin: "center center",
      }}
    >
      {children}
    </div>
  </AbsoluteFill>
);
