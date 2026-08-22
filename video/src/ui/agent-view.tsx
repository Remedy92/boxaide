/**
 * The Agent conversation pane.
 *
 * This file used to invent a developer's tool trace — mono `accounts_list`,
 * an argument column, green ticks, per-step milliseconds. A verification pass
 * against `apps/web/src/components/agent/agent-run.tsx` found none of that is
 * real, and it was the single worst inaccuracy in the video: it sold a debug
 * console instead of a mail app, in the beat that is on screen longest.
 *
 * What the app actually renders, and what this now renders:
 *
 *  - Steps are **plain-English present-tense sentences** the agent wrote via
 *    `chat_activity`, not tool identifiers. The phrasing below is lifted from
 *    the real `TOOL_WORDS` map in agent-run.tsx.
 *  - Each step is a 12px/16px `fg-tertiary` line with a **5px hollow ring** in
 *    `--dot-muted`, hung off a 1px rail that fades downward toward the answer.
 *  - The headline is `Working — <plain words>` while running and
 *    `<n> steps · <t>s` once settled (see `steps-copy.ts:stepsHeadline`).
 *  - The list is expanded while running and collapsible after; the video shows
 *    it expanded throughout, which is the running state.
 */
import React from "react";
import { T } from "./tokens";
import * as I from "./icons";

const font = "Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif";

/**
 * The activity lines for "What came in today that needs a reply?".
 *
 * `label` is the short form the headline uses while that step is in flight —
 * the app's own `TOOL_WORDS` value. `text` is the sentence the agent narrates.
 * Both are the app's register: present tense, no jargon, no arguments.
 */
export type Step = { label: string; text: string };

export const STEPS: Step[] = [
  {
    label: "Checking which mailboxes are connected",
    text: "Checking which mailboxes are connected",
  },
  { label: "Reading your inbox", text: "Reading your personal inbox" },
  { label: "Reading your inbox", text: "Reading your work inbox" },
  {
    label: "Searching your mail",
    text: "Looking for anything from today that has no reply yet",
  },
  { label: "Opening a message", text: "Opening the Q3 roadmap review" },
  { label: "Writing a draft", text: "Writing a reply for you to check" },
];

export const PaneHeader: React.FC<{ label: string; right?: React.ReactNode }> = ({
  label,
  right,
}) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      height: 40,
      flexShrink: 0,
      padding: "0 16px",
      borderBottom: `1px solid ${T.borderSubtle}`,
      fontFamily: font,
      fontSize: T.ui,
      color: T.fg,
      fontWeight: 500,
      letterSpacing: T.trackNormal,
    }}
  >
    {label}
    <span style={{ flex: 1 }} />
    {right}
  </div>
);

/** The three-dot mark the app shows while a run is live. */
const WorkingMark: React.FC<{ frame: number }> = ({ frame }) => (
  <span
    style={{
      display: "flex",
      width: 14,
      height: 14,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
      gap: 2,
    }}
  >
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        style={{
          width: 3,
          height: 3,
          borderRadius: 999,
          background: T.accent,
          opacity: 0.35 + 0.65 * (Math.sin((frame / 6) - i * 0.8) * 0.5 + 0.5),
        }}
      />
    ))}
  </span>
);

export const AgentView: React.FC<{
  /** The prompt, already sent, sitting in its bubble. */
  typed: string;
  sent: boolean;
  /** How many activity lines have streamed in. */
  steps: number;
  /** The answer, revealed a character at a time. */
  answer: string;
  caret: boolean;
  /** Drives the working mark's animation. */
  frame?: number;
  /** Elapsed seconds shown beside a live headline. */
  elapsed?: string;
}> = ({ typed, sent, steps, answer, caret, frame = 0, elapsed }) => {
  const running = steps < STEPS.length;
  const headline = running
    ? `Working — ${STEPS[Math.min(steps, STEPS.length - 1)].label}`
    : `${STEPS.length} steps · 12s`;

  return (
    <div
      style={{
        flex: 1,
        height: "100%",
        background: T.surface2,
        display: "flex",
        flexDirection: "column",
        fontFamily: font,
        minWidth: 0,
      }}
    >
      <PaneHeader label="Agent" />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: "24px 0",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div style={{ width: 760, display: "flex", flexDirection: "column", gap: 18 }}>
          {sent && (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <div
                style={{
                  maxWidth: "82%",
                  borderRadius: T.radiusLg,
                  background: T.surfaceSelected,
                  padding: "8px 12px",
                  fontSize: T.ui,
                  lineHeight: "20px",
                  color: T.fg,
                }}
              >
                {typed}
              </div>
            </div>
          )}

          {sent && steps > 0 && (
            <div style={{ minWidth: 0 }}>
              {/* The headline row: working mark or chevron, then the words. */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "2px 0",
                  fontSize: T.meta,
                  lineHeight: "16px",
                  color: T.fgTertiary,
                }}
              >
                {running ? (
                  <WorkingMark frame={frame} />
                ) : (
                  <span
                    style={{
                      display: "flex",
                      width: 14,
                      height: 14,
                      flexShrink: 0,
                      alignItems: "center",
                      justifyContent: "center",
                      transform: "rotate(90deg)",
                    }}
                  >
                    <I.ChevronRight size={14} color={T.fgTertiary} />
                  </span>
                )}
                <span>{headline}</span>
                {running && elapsed && (
                  <span
                    style={{
                      marginLeft: "auto",
                      paddingLeft: 8,
                      fontSize: T.micro,
                      color: T.fgTertiary,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {elapsed}
                  </span>
                )}
              </div>

              {/* The rail: 1px, fading downward toward where the answer lands. */}
              <div
                style={{
                  position: "relative",
                  marginTop: 6,
                  marginLeft: 6,
                  paddingLeft: 16,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 3,
                    bottom: 3,
                    width: 1,
                    background: `linear-gradient(to bottom, ${T.borderStrong}, transparent)`,
                  }}
                />
                {STEPS.slice(0, steps).map((s, i) => (
                  <div
                    key={s.text + i}
                    style={{
                      position: "relative",
                      fontSize: T.meta,
                      lineHeight: "16px",
                      color: T.fgTertiary,
                    }}
                  >
                    {/* Hollow, not filled: a settled step is a checkpoint
                        passed, and an outline reads quieter than a solid dot. */}
                    <span
                      style={{
                        position: "absolute",
                        top: 5,
                        left: -18.5,
                        width: 5,
                        height: 5,
                        borderRadius: 999,
                        border: `1px solid ${T.dotMuted}`,
                        background: "transparent",
                      }}
                    />
                    {s.text}
                  </div>
                ))}
              </div>
            </div>
          )}

          {answer.length > 0 && (
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  marginBottom: 6,
                  fontSize: T.micro,
                  lineHeight: "16px",
                  color: T.fgTertiary,
                }}
              >
                <span style={{ fontWeight: 500, color: T.fgSecondary }}>Claude Code</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>01:58 PM</span>
              </div>
              <div
                style={{
                  fontSize: T.ui,
                  lineHeight: "20px",
                  color: T.fg,
                  whiteSpace: "pre-wrap",
                }}
              >
                {answer}
                {caret && (
                  <span
                    style={{
                      display: "inline-block",
                      width: 1.5,
                      height: 13,
                      background: T.accent,
                      marginLeft: 2,
                      transform: "translateY(2px)",
                    }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* The composer. Its two pill triggers are how a user picks which agent
          and which model runs — drawing them as flat text hid a real control. */}
      <div style={{ padding: "0 0 20px", display: "flex", justifyContent: "center" }}>
        <div
          style={{
            width: 760,
            borderRadius: T.radiusLg,
            border: `1px solid ${T.borderSubtle}`,
            background: T.surface1,
            padding: 12,
            minHeight: 92,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              flex: 1,
              fontSize: T.ui,
              lineHeight: "20px",
              color: T.fgTertiary,
            }}
          >
            Ask about your mail…
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: T.micro,
              color: T.fgTertiary,
            }}
          >
            <Pill icon={I.Bot}>Claude Code</Pill>
            <Pill>Default model</Pill>
            <span style={{ marginLeft: 4 }}>
              Enter to send, Shift+Enter for a new line
            </span>
            <span style={{ flex: 1 }} />
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: T.radiusSm,
                background: T.surface2,
                border: `1px solid ${T.borderSubtle}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <I.ArrowUp size={12} color={T.fgDisabled} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

const Pill: React.FC<{
  children: React.ReactNode;
  icon?: React.FC<{ size?: number; color?: string }>;
}> = ({ children, icon: Icon }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      height: 24,
      padding: "0 7px",
      borderRadius: T.radiusSm,
      border: `1px solid ${T.borderSubtle}`,
      color: T.fgSecondary,
      fontSize: T.micro,
    }}
  >
    {Icon && <Icon size={12} color={T.fgTertiary} />}
    {children}
    <I.ChevronDown size={11} color={T.fgTertiary} />
  </span>
);
