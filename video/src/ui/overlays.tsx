/**
 * The approval card and the command palette, rebuilt from
 * `agent-approvals.tsx` and `command-palette.tsx`. The copy is the app's own,
 * to the word — "Your agent asked for this. Nothing has been sent." is the
 * whole argument of the video's third act, so paraphrasing it would be a lie.
 */
import React from "react";
import { T } from "./tokens";
import * as I from "./icons";

const font = "Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif";

export const ApprovalCard: React.FC<{
  /** 0..1 — how far the card has settled in. */
  enter: number;
}> = ({ enter }) => (
  <div
    style={{
      width: 560,
      borderRadius: T.radiusMd,
      border: `1px solid ${T.borderControl}`,
      background: T.surface1,
      padding: "10px 12px",
      fontFamily: font,
      opacity: enter,
      transform: `translateY(${(1 - enter) * 14}px)`,
    }}
  >
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      <I.Send size={14} color={T.warning} style={{ marginTop: 2 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: T.ui,
            lineHeight: "18px",
            fontWeight: 500,
            color: T.fg,
          }}
        >
          Send “Re: Q3 roadmap review” to ceo@work.test
        </div>
        <div
          style={{
            marginTop: 2,
            fontSize: T.micro,
            lineHeight: "16px",
            color: T.fgTertiary,
          }}
        >
          Your agent asked for this. Nothing has been sent.
        </div>
      </div>
    </div>

    <div
      style={{
        marginTop: 8,
        display: "grid",
        gridTemplateColumns: "auto minmax(0,1fr)",
        columnGap: 12,
        rowGap: 2,
        fontSize: T.micro,
        lineHeight: "16px",
      }}
    >
      <span style={{ color: T.fgTertiary }}>From</span>
      {/* describe() prints the raw `account` argument the agent passed.
          The app never composes an address-plus-alias string. */}
      <span style={{ color: T.fgSecondary }}>work</span>
      <span style={{ color: T.fgTertiary }}>To</span>
      <span style={{ color: T.fgSecondary }}>ceo@work.test</span>
      <span style={{ color: T.fgTertiary }}>Subject</span>
      <span style={{ color: T.fgSecondary }}>Re: Q3 roadmap review</span>
    </div>

    <div
      style={{
        marginTop: 8,
        borderRadius: T.radiusSm,
        background: T.surfaceHover,
        padding: "8px 10px",
        fontSize: T.meta,
        lineHeight: "18px",
        color: T.fgSecondary,
      }}
    >
      Thanks — reviewing the roadmap now, comments back before Friday.
    </div>

    <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
      {/* The label never changes to "Sent". Approving removes the card and
          raises a toast reading exactly "Done." — there is no confirmation
          state on the button, and inventing one undercut the whole beat. */}
      <span
        style={{
          height: 24,
          display: "flex",
          alignItems: "center",
          padding: "0 8px",
          borderRadius: T.radiusSm,
          background: T.accentFill,
          color: T.accentFillFg,
          fontSize: T.meta,
          fontWeight: 500,
        }}
      >
        Send it
      </span>
      <span
        style={{
          height: 24,
          display: "flex",
          alignItems: "center",
          padding: "0 8px",
          borderRadius: T.radiusSm,
          color: T.fgSecondary,
          fontSize: T.meta,
        }}
      >
        Don&rsquo;t
      </span>
    </div>
  </div>
);

const PALETTE_ROWS: {
  group?: string;
  icon: React.FC<{ size?: number; color?: string }>;
  label: string;
  key: string;
}[] = [
  { group: "Mail", icon: I.PenLine, label: "Compose", key: "c" },
  { icon: I.Reply, label: "Reply", key: "r" },
  { icon: I.ReplyAll, label: "Reply all", key: "a" },
  { icon: I.Forward, label: "Forward", key: "f" },
  { icon: I.MailOpen, label: "Mark unread", key: "u" },
  { icon: I.RefreshCw, label: "Refresh list", key: "" },
  { icon: I.Search, label: "Search mail…", key: "/" },
  { group: "Go to", icon: I.Sparkles, label: "Agent conversation", key: "g a" },
  { icon: I.Inbox, label: "Inbox (all mailboxes)", key: "g i" },
  { icon: I.MailOpen, label: "Unread only", key: "g u" },
  { icon: I.FileText, label: "Drafts", key: "g d" },
];

export const CommandPalette: React.FC<{
  enter: number;
  selected: number;
  query?: string;
}> = ({ enter, selected, query = "" }) => (
  <div
    style={{
      width: 560,
      borderRadius: T.radiusLg,
      border: `1px solid ${T.borderStrong}`,
      background: T.surface2,
      boxShadow: T.shadowDialog,
      overflow: "hidden",
      fontFamily: font,
      opacity: enter,
      transform: `scale(${0.97 + enter * 0.03})`,
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 42,
        padding: "0 14px",
        borderBottom: `1px solid ${T.borderSubtle}`,
        boxShadow: `inset 0 0 0 2px ${T.accent}`,
        borderRadius: `${T.radiusLg}px ${T.radiusLg}px 0 0`,
      }}
    >
      <I.Search size={14} color={T.fgTertiary} />
      <span style={{ fontSize: T.ui, color: query ? T.fg : T.fgTertiary }}>
        {query || "Search commands, mailboxes, folders"}
      </span>
    </div>

    <div style={{ padding: "6px 0 8px" }}>
      {PALETTE_ROWS.map((r, i) => (
        <React.Fragment key={r.label}>
          {r.group && (
            <div
              style={{
                padding: "8px 14px 4px",
                fontSize: T.micro,
                letterSpacing: T.trackLabel,
                color: T.fgTertiary,
                fontWeight: 500,
              }}
            >
              {r.group}
            </div>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              height: 30,
              margin: "0 6px",
              padding: "0 8px",
              borderRadius: T.radiusSm,
              background: selected === i ? T.accentSubtle : "transparent",
              color: selected === i ? T.accent : T.fgSecondary,
              fontSize: T.ui,
            }}
          >
            <r.icon size={14} color={selected === i ? T.accent : T.fgTertiary} />
            <span style={{ flex: 1 }}>{r.label}</span>
            {r.key && (
              <span
                style={{
                  fontSize: T.micro,
                  color: T.fgTertiary,
                  padding: "1px 5px",
                  borderRadius: T.radiusXs,
                  background: T.surfaceHover,
                }}
              >
                {r.key}
              </span>
            )}
          </div>
        </React.Fragment>
      ))}
    </div>
  </div>
);
