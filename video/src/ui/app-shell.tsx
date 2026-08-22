/**
 * A faithful, static rebuild of the Boxaide app shell at its real logical size
 * (1440x900), dark theme.
 *
 * These are not mockups in the "close enough" sense. The class names in
 * `apps/web/src/components` were read row by row and translated into inline
 * styles: the 228px rail, the 360px list, the 62px comfortable row, the 18px
 * dot column, the 13px/18px sender line, the 12px tabular date, the 28px nav
 * row with its 16px icon at 1.5 stroke. Colours come from `tokens.ts`, which is
 * `globals.css`. Where this file and the app disagree, this file is wrong.
 *
 * Everything is a pure function of props so the scenes can drive selection,
 * hover and content per frame without any component holding state.
 */
import React from "react";
import { T, APP_W, APP_H } from "./tokens";
import * as I from "./icons";

export type Msg = {
  from: string;
  mailbox: "personal" | "work";
  subject: string;
  snippet: string;
  time: string;
  seen: boolean;
};

/**
 * The fixture inbox, exactly as `--fixture` seeds it — subjects, senders,
 * seen flags and bodies all copied from `src/cli.ts`. The snippet is the
 * message body truncated at 120 chars, which is what `fixture.ts` does.
 */
export const MESSAGES: Msg[] = [
  {
    from: "airlines@example.com",
    mailbox: "personal",
    subject: "Flight confirmation NYC",
    snippet: "Your flight to Boston is on Tuesday 9am.",
    time: "01:58 PM",
    seen: false,
  },
  {
    from: "ceo@work.test",
    mailbox: "work",
    subject: "Q3 roadmap review",
    snippet: "Please review the attached roadmap before Friday.",
    time: "01:58 PM",
    seen: false,
  },
  {
    from: "newsletter@example.com",
    mailbox: "personal",
    subject: "Weekly digest with pictures",
    snippet: "Your weekly digest. View this mail in an HTML client to see the charts.",
    time: "12:58 PM",
    seen: false,
  },
  {
    from: "ap@acme.test",
    mailbox: "work",
    subject: "Invoice from Acme",
    snippet: "Invoice INV-220 is due next week.",
    time: "12:58 PM",
    seen: false,
  },
  {
    from: "billing@shop.test",
    mailbox: "personal",
    subject: "Receipt #9841",
    snippet: "You paid $42.00 for headphones.",
    time: "11:58 AM",
    seen: true,
  },
];

const font = "Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
export const mono =
  "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace";

/* ------------------------------------------------------------------ rail */

const RailSection: React.FC<{ label: string }> = ({ label }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 4,
      height: 24,
      paddingLeft: 2,
      marginTop: 14,
      fontSize: T.micro,
      lineHeight: "16px",
      letterSpacing: T.trackLabel,
      textTransform: "uppercase",
      color: T.fgTertiary,
      fontWeight: 500,
    }}
  >
    <I.ChevronDown size={12} color={T.fgTertiary} />
    {label}
  </div>
);

const NavItem: React.FC<{
  icon: React.FC<{ size?: number; color?: string }>;
  label: string;
  active?: boolean;
  trailing?: React.ReactNode;
  dim?: number;
}> = ({ icon: Icon, label, active, trailing, dim = 1 }) => (
  <div
    style={{
      display: "flex",
      height: 28,
      width: "100%",
      alignItems: "center",
      gap: 8,
      borderRadius: T.radiusMd,
      paddingLeft: 8,
      paddingRight: 8,
      background: active ? T.accentSubtle : "transparent",
      color: active ? T.accent : T.fgSecondary,
      opacity: dim,
    }}
  >
    <Icon size={16} color={active ? T.accent : T.fgTertiary} />
    <span
      style={{
        flex: 1,
        minWidth: 0,
        fontSize: T.ui,
        lineHeight: "18px",
        letterSpacing: T.trackNormal,
        fontWeight: active ? 500 : 400,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {label}
    </span>
    {trailing}
  </div>
);

export type RailView =
  | "agent"
  | "inbox"
  | "unread"
  | "drafts"
  | "automations"
  | "outreach"
  | "people"
  | "calendar";

export const LeftRail: React.FC<{ active: RailView }> = ({ active }) => (
  <div
    style={{
      width: T.railW,
      flexShrink: 0,
      height: "100%",
      background: T.surface0,
      borderRight: `1px solid ${T.borderSubtle}`,
      display: "flex",
      flexDirection: "column",
      padding: "0 10px",
      fontFamily: font,
    }}
  >
    {/* §6.2 row 1 — brand plus the truthful FIXTURE badge. */}
    <div style={{ display: "flex", height: 48, alignItems: "center", gap: 8 }}>
      <I.BrandGlyph size={14} color={T.fg} />
      <span
        style={{
          fontSize: T.ui,
          fontWeight: 600,
          letterSpacing: T.trackTight,
          color: T.fg,
        }}
      >
        Boxaide
      </span>
      <span
        style={{
          fontSize: 10,
          lineHeight: "14px",
          padding: "0 6px",
          borderRadius: T.radiusXs,
          background: T.warningBg,
          color: T.warning,
          fontWeight: 600,
          letterSpacing: T.trackLabel,
        }}
      >
        FIXTURE
      </span>
    </div>

    <div
      style={{
        display: "flex",
        height: 30,
        alignItems: "center",
        gap: 8,
        borderRadius: T.radiusMd,
        border: `1px solid ${T.borderSubtle}`,
        background: T.surface1,
        padding: "0 10px",
        marginBottom: 8,
        color: T.fgSecondary,
        fontSize: T.ui,
      }}
    >
      <I.Plus size={14} color={T.fgSecondary} />
      New chat
    </div>

    <NavItem icon={I.Sparkles} label="Agent" active={active === "agent"} />

    <RailSection label="Chats" />
    {/* The empty state. A second "New chat" row here duplicated the pinned
        button two rows above and read as a UI bug on screen. */}
    <div
      style={{
        paddingLeft: 20,
        fontSize: T.meta,
        lineHeight: "22px",
        color: T.fgTertiary,
      }}
    >
      No chats yet.
    </div>
    <div
      style={{
        paddingLeft: 26,
        fontSize: T.ui,
        lineHeight: "22px",
        color: T.fgSecondary,
      }}
    >
      All chats
    </div>
    <div
      style={{
        paddingLeft: 26,
        fontSize: T.meta,
        lineHeight: "20px",
        color: T.fgTertiary,
      }}
    >
      0 B of 50.0 MB
    </div>

    <div style={{ height: 10 }} />
    <NavItem icon={I.CalendarIcon} label="Calendar" active={active === "calendar"} />

    <RailSection label="Mail" />
    <NavItem icon={I.Inbox} label="Inbox" active={active === "inbox"} />
    <NavItem icon={I.MailOpen} label="Unread" active={active === "unread"} />
    <NavItem icon={I.PenLine} label="Compose" />
    <NavItem icon={I.FileText} label="Drafts" active={active === "drafts"} />
    {/* No trailing badge: the real slot holds a count of unseen automation
        runs, and a fresh fixture server has none. */}
    <NavItem icon={I.Clock} label="Automations" active={active === "automations"} />

    <RailSection label="CRM" />
    <NavItem icon={I.Users} label="People" active={active === "people"} />
    <NavItem icon={I.Columns} label="Pipeline" />
    <NavItem icon={I.Send} label="Outreach" active={active === "outreach"} />

    <RailSection label="Mailboxes" />
    {/* Two lines per account, and NO status dot: AccountRow draws nothing at
        all for a healthy mailbox — only a failing one gets an amber warning.
        Three green dots down the rail implied a liveness system the app
        deliberately does not have. */}
    <AccountRow alias="personal" email="you@personal.test" />
    <AccountRow alias="work" email="you@work.test" />

    <div style={{ flex: 1 }} />
    {/* Settings, density, theme — right-aligned above a hairline. The old
        Columns/Server/Clock trio implied a server panel and a scheduler that
        do not live here, and left out the theme toggle every viewer looks for. */}
    <div
      style={{
        display: "flex",
        gap: 14,
        alignItems: "center",
        justifyContent: "flex-end",
        height: 40,
        paddingRight: 4,
        borderTop: `1px solid ${T.borderSubtle}`,
        color: T.fgTertiary,
      }}
    >
      <I.Settings2 size={14} color={T.fgTertiary} />
      <I.Rows3 size={14} color={T.fgTertiary} />
      <I.Sun size={14} color={T.fgTertiary} />
    </div>
  </div>
);

/**
 * A mailbox in the rail: the alias, and the account's own address underneath.
 * Two lines, because one alias is not enough to tell two mailboxes apart, and
 * the addresses are what make the multi-mailbox story legible in one frame.
 */
const AccountRow: React.FC<{ alias: string; email: string }> = ({ alias, email }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      height: 36,
      paddingLeft: 8,
    }}
  >
    <span style={{ fontSize: T.ui, lineHeight: "18px", color: T.fgSecondary }}>
      {alias}
    </span>
    <span
      style={{
        fontFamily: mono,
        fontSize: T.micro,
        lineHeight: "16px",
        color: T.fgTertiary,
      }}
    >
      {email}
    </span>
  </div>
);

const Dot: React.FC<{ color: string }> = ({ color }) => (
  <span
    style={{
      width: 6,
      height: 6,
      borderRadius: 999,
      background: color,
      flexShrink: 0,
    }}
  />
);

/* ------------------------------------------------------------------ list */

export const MessageList: React.FC<{
  messages?: Msg[];
  selected?: number | null;
  /** 0..n — how many rows have landed; the rest are not painted yet. */
  revealed?: number;
  rowOpacity?: (i: number) => number;
  rowShift?: (i: number) => number;
}> = ({
  messages = MESSAGES,
  selected = null,
  revealed = 99,
  rowOpacity,
  rowShift,
}) => (
  <div
    style={{
      width: T.listW,
      flexShrink: 0,
      height: "100%",
      background: T.surface1,
      borderRight: `1px solid ${T.borderSubtle}`,
      display: "flex",
      flexDirection: "column",
      fontFamily: font,
    }}
  >
    <div style={{ padding: "8px 10px 0" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 30,
          borderRadius: T.radiusMd,
          border: `1px solid ${T.borderStrong}`,
          background: T.surface2,
          padding: "0 10px",
          color: T.fgTertiary,
          fontSize: T.ui,
        }}
      >
        <I.Search size={13} color={T.fgTertiary} />
        Search mail
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 34,
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 18,
              height: 22,
              borderRadius: T.radiusSm,
              border: `1px solid ${T.borderSubtle}`,
              padding: "0 6px",
              fontSize: T.meta,
              color: T.fgSecondary,
            }}
          >
            All mailboxes
            <I.ChevronDown size={12} color={T.fgTertiary} />
          </div>
          <span style={{ fontSize: T.meta, color: T.fgTertiary }}>Folder</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <I.MailOpen size={14} color={T.fgTertiary} />
          <I.RefreshCw size={14} color={T.fgTertiary} />
        </div>
      </div>
    </div>

    <div style={{ borderTop: `1px solid ${T.borderSubtle}` }} />

    <div style={{ flex: 1, overflow: "hidden" }}>
      {messages.map((m, i) => {
        if (i >= revealed) return null;
        const isSel = selected === i;
        return (
          <div
            key={m.subject}
            style={{
              display: "grid",
              gridTemplateColumns: "18px minmax(0,1fr) auto",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              minHeight: T.rowH,
              background: isSel ? T.surfaceSelected : "transparent",
              opacity: rowOpacity ? rowOpacity(i) : 1,
              transform: `translateY(${rowShift ? rowShift(i) : 0}px)`,
            }}
          >
            <span
              style={{
                display: "flex",
                height: "100%",
                alignItems: "flex-start",
                justifyContent: "center",
                paddingTop: 3,
              }}
            >
              {!m.seen && <Dot color={T.accent} />}
            </span>

            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: "flex",
                  minWidth: 0,
                  alignItems: "baseline",
                  gap: 6,
                }}
              >
                <span
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: T.ui,
                    lineHeight: "18px",
                    letterSpacing: T.trackNormal,
                    fontWeight: m.seen ? 400 : 500,
                    color: m.seen ? T.fgSecondary : T.fg,
                  }}
                >
                  {m.from}
                </span>
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: T.micro,
                    lineHeight: "16px",
                    color: T.fgTertiary,
                  }}
                >
                  {m.mailbox}
                </span>
              </span>
              <span
                style={{
                  display: "block",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: T.ui,
                }}
              >
                <span
                  style={{
                    lineHeight: "18px",
                    fontWeight: m.seen || isSel ? 400 : 500,
                    color: m.seen && !isSel ? T.fgSecondary : T.fg,
                  }}
                >
                  {m.subject}
                </span>
                <span style={{ color: T.fgTertiary }}> {m.snippet}</span>
              </span>
            </span>

            <span
              style={{
                flexShrink: 0,
                alignSelf: "flex-start",
                paddingTop: 1,
                fontSize: T.meta,
                lineHeight: "18px",
                whiteSpace: "nowrap",
                color: T.fgTertiary,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {m.time}
            </span>
          </div>
        );
      })}
    </div>
  </div>
);

/* ---------------------------------------------------------------- reader */

export const Reader: React.FC<{ msg: Msg; bodyChars?: number }> = ({
  msg,
  bodyChars = 999,
}) => (
  <div
    style={{
      flex: 1,
      height: "100%",
      background: T.surface2,
      display: "flex",
      flexDirection: "column",
      fontFamily: font,
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 40,
        padding: "0 16px",
        gap: 14,
        borderBottom: `1px solid ${T.borderSubtle}`,
        color: T.fgSecondary,
        fontSize: T.ui,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <I.Reply size={14} color={T.fgSecondary} />
        Reply
      </span>
      <I.ReplyAll size={14} color={T.fgTertiary} />
      <I.Forward size={14} color={T.fgTertiary} />
      {/* A closed envelope, because the selected message is unread: the app
          only shows the open one once seen. Archive sits between the read
          toggle and More — it is the action the video's own story leans on. */}
      <I.Mail size={14} color={T.fgTertiary} />
      <I.Archive size={14} color={T.fgTertiary} />
      <I.MoreHorizontal size={14} color={T.fgTertiary} />
      <span style={{ flex: 1 }} />
      <I.ChevronLeft size={14} color={T.fgTertiary} />
      <I.ChevronRight size={14} color={T.fgTertiary} />
    </div>

    <div style={{ padding: "22px 44px", maxWidth: 900 }}>
      <div
        style={{
          fontSize: T.read,
          fontWeight: 600,
          letterSpacing: T.trackTight,
          color: T.fg,
          marginBottom: 16,
        }}
      >
        {msg.subject}
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: T.radiusSm,
            border: `1px solid ${T.borderSubtle}`,
            background: T.surface1,
            color: T.fgTertiary,
            fontSize: T.micro,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {msg.from.slice(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
            }}
          >
            <span style={{ fontSize: T.ui, fontWeight: 500, color: T.fg }}>
              {msg.from}
            </span>
            <span
              style={{
                fontFamily: mono,
                fontSize: T.meta,
                color: T.fgTertiary,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              Today at {msg.time}
            </span>
          </div>
          <div style={{ fontSize: T.meta, color: T.fgTertiary }}>{msg.from}</div>
          {/* Three separate things, not one caption: a recipients disclosure,
              a mono provenance pair, and the unread state with its accent dot. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 6,
              fontSize: T.meta,
              lineHeight: "16px",
              color: T.fgSecondary,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
              To: you@work.test
              <I.ChevronDown size={11} color={T.fgTertiary} />
            </span>
            <span style={{ fontFamily: mono, fontSize: T.micro, color: T.fgTertiary }}>
              {msg.mailbox} · INBOX
            </span>
            {!msg.seen && (
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: T.micro,
                  color: T.fgTertiary,
                }}
              >
                <Dot color={T.accent} />
                Unread
              </span>
            )}
          </div>
        </div>
      </div>

      <div
        style={{
          fontSize: T.read,
          lineHeight: "24px",
          color: T.fg,
          marginBottom: 26,
          minHeight: 24,
        }}
      >
        {msg.snippet.slice(0, bodyChars)}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 38,
          borderRadius: T.radiusMd,
          border: `1px solid ${T.borderSubtle}`,
          background: T.surface1,
          padding: "0 12px",
          color: T.fgTertiary,
          fontSize: T.ui,
        }}
      >
        Reply to {msg.from}…
        <I.PenLine size={14} color={T.fgTertiary} />
      </div>
    </div>
  </div>
);

/* ------------------------------------------------------------- app frame */

/**
 * The window the app sits in. A hairline border and one soft shadow, not a
 * skeuomorphic laptop: the product is the thing on screen.
 */
export const AppFrame: React.FC<{
  children: React.ReactNode;
  title?: string;
  style?: React.CSSProperties;
}> = ({ children, title = "Boxaide", style }) => (
  <div
    style={{
      width: APP_W,
      height: APP_H,
      borderRadius: 14,
      overflow: "hidden",
      background: T.surface1,
      border: `1px solid ${T.borderStrong}`,
      boxShadow:
        "0 40px 120px -30px rgb(0 0 0 / 0.85), 0 0 0 1px rgb(255 255 255 / 0.03)",
      display: "flex",
      flexDirection: "column",
      ...style,
    }}
  >
    <div
      style={{
        height: 30,
        flexShrink: 0,
        background: T.surface0,
        borderBottom: `1px solid ${T.borderSubtle}`,
        display: "flex",
        alignItems: "center",
        paddingLeft: 12,
        gap: 7,
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: 999, background: "#2f3033" }} />
      <span style={{ width: 10, height: 10, borderRadius: 999, background: "#2f3033" }} />
      <span style={{ width: 10, height: 10, borderRadius: 999, background: "#2f3033" }} />
      <span
        style={{
          flex: 1,
          textAlign: "center",
          fontFamily: font,
          fontSize: T.micro,
          color: T.fgDisabled,
          marginRight: 60,
          letterSpacing: T.trackLabel,
        }}
      >
        {title}
      </span>
    </div>
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>{children}</div>
  </div>
);
