"use client";

import * as React from "react";
import { Archive, ArrowDown, Menu, Plug, Trash2 } from "lucide-react";
import { AgentApprovals } from "@/components/agent/agent-approvals";
import { AgentComposer } from "@/components/agent/agent-composer";
import { AgentPresenceBadge } from "@/components/agent/agent-presence";
import { AgentRunView, groupRuns } from "@/components/agent/agent-run";
import { BrandGlyph, TechnicalDetails } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useAgent } from "@/lib/hooks/use-agent";
import { useApp } from "@/lib/hooks/use-app-state";
import {
  useEnsureAgentRunning,
  usePickedAgent,
} from "@/lib/hooks/use-local-agents";

/**
 * The agent conversation — the app's first screen.
 *
 * Boxaide runs no model. Everything on this pane came from, or is going to, an
 * MCP client the user runs themselves; the server's only job is to hold the
 * conversation and hand messages over.
 *
 * So there is no token stream and no typing caret — an answer arrives whole.
 * What IS live is the run: Boxaide hands a message to exactly one agent and
 * knows that agent has not answered yet, and it sees every mail tool that agent
 * calls in the meantime. That is what the working indicator and the step list
 * are made of. Nothing here is inferred from silence.
 *
 * One measure, centred. The composer is pinned; the log scrolls under it.
 */

function gapFromBottom(node: HTMLElement) {
  return node.scrollHeight - node.scrollTop - node.clientHeight;
}

/**
 * How long this view has to stay on screen before it starts an agent.
 *
 * Boxaide opens on the conversation, so this pane mounts on every launch,
 * including the launches that head straight for mail. The wait is what tells
 * those two apart: a pane that is gone before it elapses spawns nothing.
 */
const START_SETTLE_MS = 1_500;

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
  const ensureAgent = useEnsureAgentRunning();
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const column = React.useRef<HTMLDivElement | null>(null);

  /* Follow the tail only while the user is already at it. Yanking the view down
     while somebody is reading an older answer is the single rudest thing a
     conversation pane can do. */
  const pinned = React.useRef(true);
  const [atBottom, setAtBottom] = React.useState(true);
  const syncAtBottom = React.useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    setAtBottom(gapFromBottom(node) < 80);
  }, []);
  const onScroll = React.useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    const near = gapFromBottom(node) < 80;
    pinned.current = near;
    setAtBottom(near);
  }, []);

  /* Move the scroller itself rather than scrollIntoView() a zero-height
     sentinel, and land instantly.

     Both details are load-bearing. `scrollIntoView({behavior:"smooth"})` on an
     empty div is a silent no-op in at least one Chromium build — measured, not
     assumed — so the tail would simply stop following there. And a tail that
     animates loses a race it cannot win: another turn lands mid-animation and
     the pane is already chasing a stale target. */
  const toBottom = React.useCallback(() => {
    pinned.current = true;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, []);

  /* Opening this view is also a start, so the agent is up before the first
     question rather than after it. One attempt per mount; a send still starts
     one below if this one fails.

     Mounted is not on screen, and not every gate here is obvious:
     `ensureAgent` does nothing until the launcher's list has answered, the
     settle keeps a launch that only passes through on its way to mail from
     spawning anything, and the wizard renders OVER this pane, where a spawn
     would tell its last step an agent had been paired. `ensureAgent` is held
     in a ref because it is rebuilt every render and would re-arm the timer
     forever while a run streams. */
  const { picked } = usePickedAgent();
  const ensure = React.useRef(ensureAgent);
  React.useEffect(() => {
    ensure.current = ensureAgent;
  });
  const started = React.useRef(false);
  const ready = picked !== null && !app.wizardOpen;
  React.useEffect(() => {
    if (!ready || started.current) return;
    const timer = window.setTimeout(() => {
      started.current = true;
      void ensure.current();
    }, START_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [ready]);

  /* A send is also a start. The agent is picked in the composer now, not
     started from the sidebar, so the first message on a quiet machine has to
     bring one up. Post first, start second: the server queues a message nobody
     is listening to and hands it over on arrival, and a start that fails must
     not take the question down with it. */
  const send = React.useCallback(
    (text: string) => {
      void agent.send(text);
      void ensureAgent();
    },
    [agent, ensureAgent],
  );

  const runs = React.useMemo(() => groupRuns(agent.turns), [agent.turns]);
  const work = agent.presence.working;

  const lastSeq = agent.turns.at(-1)?.seq ?? 0;
  // A step arriving is as much a reason to follow the tail as a turn is: the
  // run block grows under the reader without any new turn being written.
  const stepKey = work ? `${work.seq}:${work.tool?.at ?? ""}` : "";
  React.useEffect(() => {
    if (!pinned.current) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lastSeq, stepKey]);

  // Expanding a step grows the column without a scroll event.
  React.useEffect(() => {
    const node = scroller.current;
    const inner = column.current;
    if (!node || !inner) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) node.scrollTop = node.scrollHeight;
      syncAtBottom();
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [syncAtBottom]);

  const empty = agent.turns.length === 0;
  const noMailboxes = !accounts.isPending && (accounts.data ?? []).length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="relative flex h-11 shrink-0 items-center gap-2 px-3">
        {/* A 1px accent sweep along the header's base while a message is
            claimed — the whole pane's "a run is live", still visible when the
            run itself is scrolled away. Same keyframes as the list refetch
            bar, slowed: this is a state, not a fetch. Gone entirely under
            reduced motion, where the run block's static mark carries it. */}
        {work && (
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-px overflow-hidden motion-reduce:hidden"
          >
            <div
              className="mailmux-progress h-full w-full bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent opacity-70"
              style={{ animationDuration: "2600ms" }}
            />
          </div>
        )}
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
        {/* The chat's own name, once there is one. Before that it is still the
            Agent pane and says so, rather than showing a placeholder title
            over a conversation that has not started. */}
        <h2 className="min-w-0 truncate text-[13px] leading-[18px] font-medium text-fg">
          {agent.chat && !empty ? agent.chat.title : "Agent"}
        </h2>

        <div className="ml-auto flex items-center gap-1.5">
          <AgentPresenceBadge
            presence={agent.presence}
            connection={agent.connection}
          />
          {agent.chat && !empty && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Archive this chat"
                  onClick={() => void agent.archiveChat(agent.chat!.id)}
                >
                  <Archive className="size-4" strokeWidth={1.5} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Archive this chat</TooltipContent>
            </Tooltip>
          )}
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

      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          className="pane-scroll h-full min-h-0 overflow-y-auto"
        >
          {/* Bottom-anchored. A short conversation belongs against the composer,
              not stranded at the top of a tall empty pane — the gap reads as
              "something failed to load". `min-h-full` on the inner column is
              what lets justify-end have any effect inside a scroller. */}
          <div
            ref={column}
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
                onPick={send}
              />
            ) : (
              <div className="space-y-6 pt-4">
                {/* Said once, at the top, where the missing messages were. The
                    old behaviour dropped them silently and this conversation
                    simply began in the middle. */}
                {agent.chat?.trimmed && (
                  <p className="rounded-[var(--radius-md)] bg-surface-hover px-3 py-2 text-[12px] leading-4 text-fg-tertiary">
                    Older messages in this chat were dropped to keep it inside
                    its limit.
                  </p>
                )}
                {runs.map((run) => (
                  <AgentRunView
                    key={run.seq}
                    run={run}
                    work={work && run.question?.seq === work.seq ? work : null}
                    waiting={agent.presence.waiting}
                    lastSeenAt={agent.presence.lastSeenAt}
                    claimed={
                      run.question !== null && agent.claimed.has(run.question.seq)
                    }
                    /* An agent is holding a message, and it is not this one —
                       including one in another chat, which is the case that
                       used to read as "no agent is listening". */
                    busyElsewhere={
                      work !== null && work.seq !== run.question?.seq
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Only ever drawn when it has something to do. */}
        {!atBottom && !empty && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={toBottom}
              className="pointer-events-auto h-7 rounded-[var(--radius-full)] bg-surface-2 px-2.5 text-[12px] shadow-[var(--shadow-overlay)]"
            >
              <ArrowDown className="size-3.5" strokeWidth={1.5} />
              Latest
            </Button>
          </div>
        )}
      </div>

      <div className="shrink-0 px-5 pb-4">
        <div className="mx-auto w-full max-w-[720px]">
          {/* Above the error and above the composer: this is the one thing on
              the pane that another person is waiting on. */}
          <AgentApprovals />
          {agent.error && (
            <div className="mb-2 rounded-[var(--radius-md)] border border-border-subtle bg-danger-bg px-3 py-2 text-[12px] leading-4 text-danger">
              {agent.error}
              <TechnicalDetails raw={agent.error} />
            </div>
          )}
          <AgentComposer
            onSend={send}
            sending={agent.sending}
            /* This chat's run, not any run. Stop belongs under the answer the
               reader is waiting for; a message being answered in another
               conversation is that conversation's to stop. The seq goes with
               the click, so what is stopped is the run this button was drawn
               for even if another one was claimed in between. */
            onStop={work ? () => void agent.stop(work.seq) : undefined}
            running={work !== null && work.chatId === agent.chat?.id}
            stopping={agent.stopping}
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
        reads and answers here. Boxaide runs no model of its own and sends your
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

      <ul className="mt-7 flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((text) => (
          <li key={text}>
            <button
              type="button"
              onClick={() => onPick(text)}
              className="rounded-[var(--radius-full)] border border-border-subtle px-3 py-1.5 text-left text-[12px] leading-4 text-fg-secondary transition-colors duration-[var(--dur-fast)] hover:border-border-strong hover:bg-surface-hover hover:text-fg"
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
