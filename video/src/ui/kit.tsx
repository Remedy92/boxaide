/**
 * Motion and layout primitives shared by every scene.
 *
 * Two rules hold this video together, and both come from the constraint that X
 * autoplays muted in a small feed rectangle:
 *
 *  1. Every caption is one short line at 44px or larger, held for at least a
 *     second. If a viewer cannot read it at thumbnail size with the sound off,
 *     it does not belong on screen.
 *  2. The product plane never moves faster than the eye can follow. The app is
 *     the argument; motion only points at it.
 *
 * All animation is a pure function of `useCurrentFrame()`. No CSS transitions,
 * no Tailwind animation classes — neither renders deterministically.
 */
import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion";
import { T, APP_W, APP_H } from "./tokens";

export const FONT =
  "Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
export const MONO = "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace";

/** Smooth, no bounce. The default for anything the eye tracks. */
export const SMOOTH = { damping: 200 } as const;
/** Snappy with a hint of overshoot. For UI elements that "land". */
export const SNAPPY = { damping: 22, stiffness: 210 } as const;

export const useEnter = (delay = 0, config = SMOOTH) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config });
};

/** 0 → 1 → 0 across a sequence, so a held card can leave the way it arrived. */
export const useInOut = (holdOutFrames: number, config = SMOOTH) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const inn = spring({ frame, fps, config });
  const out = spring({
    frame,
    fps,
    config,
    durationInFrames: holdOutFrames,
    delay: durationInFrames - holdOutFrames,
  });
  return inn - out;
};

/** Characters revealed by frame, with a blinking caret for typed input. */
export const typeOut = (
  text: string,
  frame: number,
  start: number,
  charsPerFrame: number,
) => {
  const n = Math.max(0, Math.floor((frame - start) * charsPerFrame));
  return text.slice(0, Math.min(n, text.length));
};

export const caretOn = (frame: number) => Math.floor(frame / 15) % 2 === 0;

/* ------------------------------------------------------------ background */

/**
 * The stage behind the product: near-black, one very soft indigo bloom, and a
 * faint grid. It is the app's `--surface-0` pushed one step further back so the
 * window's own border still reads as an edge.
 */
export const Stage: React.FC<{
  children?: React.ReactNode;
  /** Vertical drift of the bloom, in px, so long scenes are not static. */
  drift?: number;
  bloom?: number;
}> = ({ children, drift = 0, bloom = 1 }) => (
  <AbsoluteFill style={{ background: "#050506" }}>
    <AbsoluteFill
      style={{
        backgroundImage: `linear-gradient(${T.borderSubtle} 1px, transparent 1px), linear-gradient(90deg, ${T.borderSubtle} 1px, transparent 1px)`,
        backgroundSize: "64px 64px",
        opacity: 0.5,
        maskImage:
          "radial-gradient(ellipse 70% 60% at 50% 45%, black, transparent 78%)",
      }}
    />
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse 900px 520px at 50% ${38 + drift}%, rgba(92,103,216,0.20), transparent 70%)`,
        opacity: bloom,
      }}
    />
    {children}
  </AbsoluteFill>
);

/* --------------------------------------------------------------- caption */

/**
 * One line of large type with an optional small kicker above it. Each word
 * rises independently on a stagger, which reads as speech rather than as a
 * slide transition.
 */
export const Caption: React.FC<{
  kicker?: string;
  children: string;
  delay?: number;
  size?: number;
  align?: "center" | "left";
  color?: string;
  accentWords?: string[];
  style?: React.CSSProperties;
}> = ({
  kicker,
  children,
  delay = 0,
  size = 52,
  align = "center",
  color = T.fg,
  accentWords = [],
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = children.split(" ");

  const kick = spring({ frame: frame - delay, fps, config: SMOOTH });

  return (
    <div
      style={{
        fontFamily: FONT,
        textAlign: align,
        display: "flex",
        flexDirection: "column",
        alignItems: align === "center" ? "center" : "flex-start",
        gap: 14,
        ...style,
      }}
    >
      {kicker && (
        <div
          style={{
            fontSize: 17,
            fontWeight: 600,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: T.accent,
            opacity: kick,
            transform: `translateY(${(1 - kick) * 10}px)`,
          }}
        >
          {kicker}
        </div>
      )}
      <div
        style={{
          fontSize: size,
          lineHeight: 1.14,
          fontWeight: 600,
          letterSpacing: "-0.026em",
          color,
          display: "flex",
          flexWrap: "wrap",
          gap: `0 ${size * 0.26}px`,
          justifyContent: align === "center" ? "center" : "flex-start",
          maxWidth: 1180,
        }}
      >
        {words.map((w, i) => {
          const p = spring({
            frame: frame - delay - (kicker ? 5 : 0) - i * 2.5,
            fps,
            config: SMOOTH,
          });
          const bare = w.replace(/[.,—]/g, "");
          const hot = accentWords.includes(bare);
          return (
            <span
              key={w + i}
              style={{
                display: "inline-block",
                opacity: p,
                transform: `translateY(${(1 - p) * 26}px)`,
                color: hot ? T.accent : undefined,
              }}
            >
              {w}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** A small monospace pill, used for `npx boxaide` and for tool names. */
export const Code: React.FC<{
  children: React.ReactNode;
  size?: number;
  style?: React.CSSProperties;
}> = ({ children, size = 22, style }) => (
  <span
    style={{
      fontFamily: MONO,
      fontSize: size,
      color: T.fg,
      background: T.surface2,
      border: `1px solid ${T.borderStrong}`,
      borderRadius: 8,
      padding: `${size * 0.36}px ${size * 0.68}px`,
      whiteSpace: "nowrap",
      ...style,
    }}
  >
    {children}
  </span>
);

/**
 * Places the 1440x900 app plane inside the 1920x1080 frame at an arbitrary
 * scale and focal point, so a scene can push in on the message list without
 * ever resampling the text at a non-integer size mid-motion.
 */
export const AppStage: React.FC<{
  children: React.ReactNode;
  scale: number;
  x?: number;
  y?: number;
  rotate?: number;
  opacity?: number;
}> = ({ children, scale, x = 0, y = 0, rotate = 0, opacity = 1 }) => (
  <AbsoluteFill
    style={{
      justifyContent: "center",
      alignItems: "center",
      opacity,
    }}
  >
    <div
      style={{
        transform: `translate(${x}px, ${y}px) scale(${scale}) rotateX(${rotate}deg)`,
        transformOrigin: "center center",
      }}
    >
      {children}
    </div>
  </AbsoluteFill>
);

/** Linear ramp with clamped ends — the workhorse for opacity and offset. */
export const ramp = (
  frame: number,
  from: number,
  to: number,
  a = 0,
  b = 1,
  easing: (n: number) => number = Easing.out(Easing.quad),
) =>
  interpolate(frame, [from, to], [a, b], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });

/* --------------------------------------------------------------- close-up */

/**
 * Where to put the app plane so that the point (px, py) in its own 1440x900
 * coordinate space lands in the middle of the frame at `scale`.
 *
 * Close-ups are how this cut shows detail that 13px type cannot carry at full
 * width — a single message row, the tool-call stream, one automation card.
 * They are always a move *between* two framings rather than a cut, because a
 * hard cut to a cropped UI reads as a different screenshot rather than as the
 * same screen, seen closer.
 */
export const focusOn = (px: number, py: number, scale: number) => ({
  x: -(px - APP_W / 2) * scale,
  y: -(py - APP_H / 2) * scale,
});

/**
 * Interpolates between a wide framing and a close-up on one focal point.
 * `t` is 0 at wide and 1 at the close-up; feed it a spring so the move eases
 * at both ends the way a camera on a rig does.
 *
 * `wideY` is the wide shot's vertical offset in frame space — the app scenes
 * sit low to clear the caption band, and the close-up must start from there
 * rather than from a centred plane, or the move begins with a jump.
 */
export const framing = (
  t: number,
  wide: { scale: number; y: number },
  close: { scale: number; px: number; py: number },
  /** The frame the plane is composited into. */
  view = { w: 1920, h: 1080 },
) => {
  const scale = wide.scale + (close.scale - wide.scale) * t;

  // Clamp the focal point so the close-up cannot pan off the edge of the app
  // plane and expose the stage behind it. A close-up that shows 60px of empty
  // background above the window reads as a bug, not as a camera move, and it
  // is very easy to get wrong by eye when the focal point is written in the
  // app's coordinates rather than the frame's.
  const halfW = view.w / (2 * close.scale);
  const halfH = view.h / (2 * close.scale);
  const px =
    halfW * 2 >= APP_W
      ? APP_W / 2
      : Math.min(Math.max(close.px, halfW), APP_W - halfW);
  const py =
    halfH * 2 >= APP_H
      ? APP_H / 2
      : Math.min(Math.max(close.py, halfH), APP_H - halfH);

  const f = focusOn(px, py, scale);
  return {
    scale,
    x: f.x * t,
    y: wide.y * (1 - t) + f.y * t,
  };
};
