"use client";

import * as React from "react";
import { Menu, Plug, Trash2 } from "lucide-react";
import { AgentComposer } from "@/components/agent/agent-composer";
import { AgentPresenceBadge } from "@/components/agent/agent-presence";
import { AgentTurnView } from "@/components/agent/agent-turn";
import { BrandGlyph, TechnicalDetails } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useAgent } from "@/lib/hooks/use-agent";
import { useApp } from "@/lib/hooks/use-app-state";

/**
 * The agent conversation — the app's first screen.
 *
 * mailmux runs no model. Everything on this pane came from, or is going to, an
 * MCP client the user runs themselves; the server's only job is to hold the
 * conversation and hand messages over. That is why there is no "thinking"
 * indicator and no streaming caret: mailmux genuinely does not know whether an
 * agent is composing a reply, only whether one has asked for a message.
 *
 * One measure, centred. The composer is pinned; the log scrolls under it.
 */

const SUGGESTIONS = [
  "What came in today that needs a reply?",
  "Summarise the unread mail in my work mailbox.",
  "Find the last invoice from Stripe.",
  "Draft a polite decline to the newest meeting request.",
];

export function AgentView({
  onOpenRail,
  showRailButton,
}: {
  onOpenRail: () => void;
  showRailButton: boolean;
}) {
  const app = useApp();
  const agent = useAgent();
  const accounts = useAccounts();
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const bottom = React.useRef<HTMLDivElement | null>(null);

  /* Follow the tail only while the user is already at it. Yanking the view down
     while somebody is reading an older answer is the single rudest thing a
     conversation pane can do. */
  const pinned = React.useRef(true);
  const onScroll = React.useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
    pinned.current = gap < 80;
  }, []);

  const lastSeq = agent.turns.at(-1)?.seq ?? 0;
  React.useEffect(() => {
    if (!pinned.current) return;
    bottom.current?.scrollIntoView({
      block: "end",
      behavior: app.reducedMotion ? "auto" : "smooth",
    });
  }, [lastSeq, app.reducedMotion]);

  const empty = agent.turns.length === 0;
  const noMailboxes = !accounts.isPending && (accounts.data ?? []).length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 px-3">
        {showRailButton && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Open mailboxes and folders"
            onClick={onOpenRail}
          >
            <Menu className="size-4" strokeWidth={1.5} />
          </Button>
        )}
        <h2 className="text-[13px] leading-[18px] font-medium text-fg">Agent</h2>

        <div className="ml-auto flex items-center gap-1.5">
          <AgentPresenceBadge presence={agent.presence} connection={agent.connection} />
          {!empty && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear this conversation"
                  onClick={() => void agent.clear()}
                >
                  <Trash2 className="size-4" strokeWidth={1.5} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clear this conversation</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="pane-scroll min-h-0 flex-1 overflow-y-auto"
      >
        {/* Bottom-anchored. A short conversation belongs against the composer,
            not stranded at the top of a tall empty pane — the gap reads as
            "something failed to load". `min-h-full` on the inner column is what
            lets justify-end have any effect inside a scroller. */}
        <div
          className={`mx-auto flex min-h-full w-full max-w-[720px] flex-col px-5 pb-6 ${
            empty ? "" : "justify-end"
          }`}
        >
          {empty ? (
            <EmptyState
              noMailboxes={noMailboxes}
              listening={agent.presence.listening}
              onConnectAgent={() => app.openDialog("agent")}
              onConnectMailbox={() => app.openDialog("connect")}
              onPick={(text) => void agent.send(text)}
            />
          ) : (
            <div className="space-y-5 pt-4">
              {agent.turns.map((turn) => (
                <AgentTurnView key={turn.seq} turn={turn} />
              ))}
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>

      <div className="shrink-0 px-5 pb-4">
        <div className="mx-auto w-full max-w-[720px]">
          {agent.error && (
            <div className="mb-2 rounded-[var(--radius-md)] border border-border-subtle bg-danger-bg px-3 py-2 text-[12px] leading-4 text-danger">
              {agent.error}
              <TechnicalDetails raw={agent.error} />
            </div>
          )}
          <AgentComposer
            onSend={(text) => void agent.send(text)}
            sending={agent.sending}
            disabled={agent.connection === "unsupported"}
            autoFocus={!app.narrow}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * First run for this pane.
 *
 * The two things that can be missing are named separately, because they have
 * different fixes and either can be true on its own: no mailbox connected, and
 * no agent listening. Neither blocks typing — a queued message is delivered as
 * soon as an agent arrives — so both read as guidance, not as errors.
 */
function EmptyState({
  noMailboxes,
  listening,
  onConnectAgent,
  onConnectMailbox,
  onPick,
}: {
  noMailboxes: boolean;
  listening: boolean;
  onConnectAgent: () => void;
  onConnectMailbox: () => void;
  onPick: (text: string) => void;
}) {
  return (
    <div className="flex min-h-[52vh] flex-col justify-center py-10">
      <BrandGlyph size={20} className="mb-4 text-fg-tertiary" />
      <h3 className="title-15 text-fg">Talk to your agent about your mail</h3>
      <p className="mt-1.5 max-w-[52ch] text-[13px] leading-[20px] text-fg-secondary">
        Your own agent — Claude Code, Codex, Cursor, anything that speaks MCP —
        reads and answers here. mailmux runs no model of its own and sends your
        mail nowhere.
      </p>

      {(noMailboxes || !listening) && (
        <div className="mt-5 space-y-2">
          {noMailboxes && (
            <Row
              text="No mailbox is connected yet, so there is nothing for an agent to read."
              action="Connect a mailbox"
              onAction={onConnectMailbox}
            />
          )}
          {!listening && (
            <Row
              text="No agent is listening. You can still type — your message waits and is delivered as soon as one starts."
              action="Connect your agent"
              icon
              onAction={onConnectAgent}
            />
          )}
        </div>
      )}

      <ul className="mt-7 space-y-1.5">
        {SUGGESTIONS.map((text) => (
          <li key={text}>
            <button
              type="button"
              onClick={() => onPick(text)}
              className="w-full rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-[13px] leading-[18px] text-fg-secondary transition-colors duration-[var(--dur-fast)] hover:bg-surface-hover hover:text-fg"
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({
  text,
  action,
  onAction,
  icon = false,
}: {
  text: string;
  action: string;
  onAction: () => void;
  icon?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[var(--radius-md)] border border-border-subtle bg-surface-1 px-3 py-2">
      <p className="min-w-0 flex-1 text-[12px] leading-4 text-fg-secondary">{text}</p>
      <Button type="button" variant="outline" size="sm" onClick={onAction}>
        {icon && <Plug className="size-3.5" strokeWidth={1.5} />}
        {action}
      </Button>
    </div>
  );
}
