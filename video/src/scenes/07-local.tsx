/**
 * Beat 7 — where does my mail live.
 *
 * Three boxes and two dashed runs. Each box gets a name and one line under it,
 * not three, because the diagram has to be readable in the two seconds it is
 * still — and because "127.0.0.1:8787" says everything the three lines were
 * saying.
 *
 * The "No vendor cloud. No account. No subscription." line that used to sit
 * under this diagram is gone. It was a fourth element restating the picture,
 * and the picture is clearer than the sentence.
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from "remotion";
import { T } from "../ui/tokens";
import { FONT, MONO, SMOOTH, ramp } from "../ui/kit";
import { Beat, Line, Hi, BELOW_BAND } from "../ui/beat";
import * as I from "../ui/icons";

const Node: React.FC<{
  icon: React.FC<{ size?: number; color?: string }>;
  title: string;
  sub: string;
  accent?: boolean;
  enter: number;
}> = ({ icon: Icon, title, sub, accent, enter }) => (
  <div
    style={{
      width: 380,
      borderRadius: 18,
      border: `1px solid ${accent ? T.accentLine : T.borderStrong}`,
      background: T.surface1,
      padding: "34px 34px 30px",
      fontFamily: FONT,
      opacity: enter,
      transform: `translateY(${(1 - enter) * 18}px)`,
      position: "relative",
      overflow: "hidden",
    }}
  >
    {accent && (
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 280px 150px at 50% 0%, rgba(92,103,216,0.18), transparent 70%)",
        }}
      />
    )}
    <div style={{ position: "relative" }}>
      <Icon size={38} color={accent ? T.accent : T.fgSecondary} />
      <div
        style={{
          marginTop: 20,
          fontSize: 32,
          fontWeight: 600,
          letterSpacing: "-0.022em",
          color: T.fg,
        }}
      >
        {title}
      </div>
      <div
        style={{
          marginTop: 10,
          fontFamily: MONO,
          fontSize: 19,
          color: T.fgTertiary,
        }}
      >
        {sub}
      </div>
    </div>
  </div>
);

const Link: React.FC<{ dash: number; opacity: number }> = ({ dash, opacity }) => (
  <svg width={110} height={4} style={{ flexShrink: 0, overflow: "visible" }}>
    <line
      x1={6}
      y1={2}
      x2={104}
      y2={2}
      stroke={T.accent}
      strokeWidth={2}
      strokeDasharray="8 14"
      strokeDashoffset={dash}
      strokeLinecap="round"
      opacity={opacity}
    />
  </svg>
);

export const LocalScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const n = (d: number) => spring({ frame: frame - d, fps, config: SMOOTH });
  const dash = -((frame * 2.2) % 22);

  return (
    <Beat
      drift={2}
      line={
        <Line>
          Your machine talks to <Hi>your</Hi> mail server. Nothing in between.
        </Line>
      }
    >
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", marginTop: BELOW_BAND }}>
          <Node
            icon={I.Terminal}
            title="Your agent"
            sub="over MCP"
            enter={n(10)}
          />
          <Link dash={dash} opacity={ramp(frame, 34, 54, 0, 1)} />
          <Node
            icon={I.Laptop}
            title="Boxaide"
            sub="127.0.0.1:8787"
            accent
            enter={n(20)}
          />
          <Link dash={dash} opacity={ramp(frame, 42, 62, 0, 1)} />
          <Node
            icon={I.Server}
            title="Your mail"
            sub="IMAP / SMTP"
            enter={n(30)}
          />
        </div>
      </AbsoluteFill>
    </Beat>
  );
};
