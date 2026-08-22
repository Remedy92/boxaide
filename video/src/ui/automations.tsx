/**
 * The Automations view, rebuilt from `automations-view.tsx` and
 * `automation-card.tsx`.
 *
 * Two details of the real card are load-bearing and are kept exactly:
 *
 *  - the schedule is printed twice — `describeCron()`'s sentence and, beside
 *    it in mono, the raw cron expression the scheduler actually evaluates;
 *  - the status word always follows the status dot. The app never lets a dot
 *    carry meaning on its own, and neither does this.
 *
 * The prompts are written the way `automation_create`'s own description tells
 * an agent to write them: standalone instructions to a future run with no
 * memory and nobody to ask.
 */
import React from "react";
import { T } from "./tokens";
import * as I from "./icons";
import { PaneHeader } from "./agent-view";

const font = "Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
const mono = "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace";

export type Automation = {
  name: string;
  cron: string;
  schedule: string;
  next: string;
  last: string;
  status: "ok" | "running" | null;
  statusLabel: string;
  enabled: boolean;
  prompt: string;
};

export const AUTOMATIONS: Automation[] = [
  {
    name: "Overnight digest",
    // "0 8 * * 1-5" was wrong twice: describeCron has no day-of-week RANGE
    // branch, so it falls through to `return raw` and the card would print the
    // cron expression twice side by side. A plain daily expression is the only
    // one that produces the sentence shown.
    cron: "0 8 * * *",
    schedule: "Daily at 08:00 AM",
    // formatReaderDate has no "Tomorrow" and no relative branch, and treats
    // any future date as today.
    next: "Today at 08:00 AM",
    last: "Today at 08:00 AM",
    status: "ok",
    statusLabel: "Succeeded",
    enabled: true,
    prompt:
      "Summarise everything that arrived in personal and work INBOX since 18:00 yesterday. Group by sender. Flag anything with a deadline inside 72 hours.",
  },
  {
    name: "Invoice watch",
    cron: "*/30 * * * *",
    schedule: "Every 30 minutes",
    next: "Today at 01:10 PM",
    last: "Today at 12:58 PM",
    status: "ok",
    statusLabel: "Succeeded",
    enabled: true,
    prompt:
      "Search work for unread mail matching invoice OR receipt OR \"past due\". For each, add a CRM note on the sender and queue a draft acknowledging receipt. Do not send.",
  },
  {
    name: "Follow-up sweep",
    cron: "0 17 * * 5",
    // The exact string describeCron returns for this expression. The plural
    // "Fridays at 17:00" exists nowhere in the app.
    schedule: "Weekly on Friday at 05:00 PM",
    next: "Not scheduled",
    last: "Never",
    status: null,
    statusLabel: "",
    enabled: false,
    prompt:
      "List every contact in the pipeline whose last inbound message is older than 10 days and whose deal is not Closed. Draft one follow-up each into Drafts.",
  },
];

const Switch: React.FC<{ on: boolean }> = ({ on }) => (
  <span
    style={{
      width: 28,
      height: 16,
      borderRadius: 999,
      background: on ? T.accentFill : T.surfaceSelected,
      border: `1px solid ${on ? T.accentFill : T.borderStrong}`,
      display: "flex",
      alignItems: "center",
      padding: 2,
      justifyContent: on ? "flex-end" : "flex-start",
      flexShrink: 0,
    }}
  >
    <span
      style={{
        width: 11,
        height: 11,
        borderRadius: 999,
        background: on ? T.accentFillFg : T.fgTertiary,
      }}
    />
  </span>
);

const Btn: React.FC<{
  children: React.ReactNode;
  icon?: React.FC<{ size?: number; color?: string }>;
  ghost?: boolean;
}> = ({ children, icon: Icon, ghost }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      height: 24,
      padding: "0 8px",
      borderRadius: T.radiusSm,
      border: ghost ? "1px solid transparent" : `1px solid ${T.borderStrong}`,
      background: ghost ? "transparent" : T.surface2,
      color: ghost ? T.fgSecondary : T.fg,
      fontSize: T.meta,
      fontWeight: 500,
    }}
  >
    {Icon && <Icon size={13} color={ghost ? T.fgSecondary : T.fgSecondary} />}
    {children}
  </span>
);

const SmallPill: React.FC<{
  children: React.ReactNode;
  icon?: React.FC<{ size?: number; color?: string }>;
}> = ({ children, icon: Icon }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      height: 22,
      padding: "0 7px",
      borderRadius: T.radiusSm,
      border: `1px solid ${T.borderSubtle}`,
      color: T.fgSecondary,
      fontSize: T.micro,
    }}
  >
    {Icon && <Icon size={11} color={T.fgTertiary} />}
    {children}
    <I.ChevronDown size={10} color={T.fgTertiary} />
  </span>
);

export const AutomationCard: React.FC<{
  a: Automation;
  /** Whether the collapsed <details> is showing its instructions. */
  open?: boolean;
  enter?: number;
}> = ({ a, open = false, enter = 1 }) => (
  <div
    style={{
      borderRadius: T.radiusMd,
      border: `1px solid ${T.borderSubtle}`,
      background: T.surface1,
      padding: 12,
      fontFamily: font,
      opacity: enter,
      transform: `translateY(${(1 - enter) * 16}px)`,
    }}
  >
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: T.ui,
            lineHeight: "18px",
            fontWeight: 500,
            color: T.fg,
          }}
        >
          {a.name}
        </div>
        {/* The sentence and the expression, side by side — the app prints both
            because only one of them is what the scheduler evaluates. */}
        <div
          style={{
            marginTop: 2,
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            fontSize: T.meta,
            lineHeight: "18px",
            color: T.fgSecondary,
          }}
        >
          {a.schedule}
          <span style={{ fontFamily: mono, fontSize: T.micro, color: T.fgTertiary }}>
            {a.cron}
          </span>
        </div>
      </div>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
          fontSize: T.meta,
          lineHeight: "16px",
          color: T.fgSecondary,
        }}
      >
        {a.enabled ? "On" : "Paused"}
        <Switch on={a.enabled} />
      </span>
    </div>

    <div
      style={{
        marginTop: 8,
        display: "flex",
        gap: 18,
        fontSize: T.meta,
        lineHeight: "18px",
      }}
    >
      <span style={{ display: "flex", gap: 6 }}>
        <span style={{ color: T.fgTertiary }}>Next</span>
        <span style={{ color: T.fgSecondary }}>
          {a.enabled ? a.next : "Not scheduled"}
        </span>
      </span>
      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ color: T.fgTertiary }}>Last</span>
        <span
          style={{
            color: T.fgSecondary,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {a.last}
          {a.status && (
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: a.status === "ok" ? T.success : T.accent,
                }}
              />
              {a.statusLabel}
            </span>
          )}
        </span>
      </span>
    </div>

    <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
      <SmallPill icon={I.Terminal}>Claude Code</SmallPill>
      <SmallPill>Default model</SmallPill>
    </div>

    <div
      style={{
        marginTop: 8,
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        fontSize: T.meta,
        color: T.fgTertiary,
      }}
    >
      {open ? (
        <I.ChevronDown size={12} color={T.fgTertiary} />
      ) : (
        <I.ChevronRight size={12} color={T.fgTertiary} />
      )}
      Instructions
    </div>
    {open && (
      <div
        style={{
          marginTop: 4,
          paddingLeft: 18,
          fontSize: T.ui,
          lineHeight: "18px",
          color: T.fgSecondary,
        }}
      >
        {a.prompt}
      </div>
    )}

    <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
      <Btn icon={I.Play}>Run now</Btn>
      <Btn ghost icon={I.ChevronRight}>
        Runs
      </Btn>
    </div>
  </div>
);

export const AutomationsView: React.FC<{
  /** How many cards have landed. */
  revealed?: number;
  /** Index of the card whose instructions are expanded, or null. */
  openIndex?: number | null;
  cardEnter?: (i: number) => number;
}> = ({ revealed = AUTOMATIONS.length, openIndex = null, cardEnter }) => (
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
    <PaneHeader
      label="Automations"
      // Just the refresh button. There is no count of any kind in this header.
      right={<I.RefreshCw size={14} color={T.fgTertiary} />}
    />
    <div
      style={{
        flex: 1,
        minHeight: 0,
        padding: "16px 0",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 640,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {AUTOMATIONS.slice(0, revealed).map((a, i) => (
          <AutomationCard
            key={a.name}
            a={a}
            open={openIndex === i}
            enter={cardEnter ? cardEnter(i) : 1}
          />
        ))}
      </div>
    </div>
  </div>
);
