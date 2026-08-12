"use client";

import * as React from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { Markdown } from "@/lib/format/markdown";
import { isoAttr, isoTitle } from "@/lib/format/date";
import { displayAgentName } from "@/components/agent/agent-presence";
import { cn } from "@/lib/utils";
import type { AgentTurn, AgentWork } from "@/lib/types";

/**
 * One exchange: the question, the steps taken, the answer.
 *
 * A run is assembled from the flat turn log rather than stored — the server
 * appends turns and nothing else, so the grouping lives here. It is the shape
 * the conversation actually has: a user turn, any number of activity lines the
 * agent posted while it worked, then the answer.
 *
 * What is NOT here is a token stream. mailmux runs no model; an answer arrives
 * as one finished `chat_say`. The live part of a run is real all the same — the
 * activity lines and the mail tools being called are events this server
 * handled, so "working" is a fact about a claimed message, not a guess about a
 * model that nobody here can see.
 */
export type Run = {
  /** The user turn that opened it. Null when an agent spoke unprompted. */
  question: AgentTurn | null;
  /** `activity` turns posted since the question. */
  steps: AgentTurn[];
  /** `agent` turns since the question. More than one is allowed. */
  answers: AgentTurn[];
  /** Sort key — the earliest turn in the run. */
  seq: number;
};

export function groupRuns(turns: AgentTurn[]): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;
  for (const turn of turns) {
    if (turn.role === "user" || !current) {
      current = {
        question: turn.role === "user" ? turn : null,
        steps: [],
        answers: [],
        seq: turn.seq,
      };
      runs.push(current);
      if (turn.role === "user") continue;
    }
    if (turn.role === "activity") current.steps.push(turn);
    else if (turn.role === "agent") current.answers.push(turn);
  }
  return runs;
}

/** Plain words for the mail tools, so a step reads as an action, not an API. */
const TOOL_WORDS: Record<string, string> = {
  accounts_list: "Checking which mailboxes are connected",
  messages_list: "Reading your inbox",
  messages_search: "Searching your mail",
  message_get: "Opening a message",
  message_send: "Sending a message",
  message_mark_read: "Marking a message read",
  draft_create: "Writing a draft",
  draft_update: "Revising a draft",
  drafts_list: "Reading your drafts",
  draft_delete: "Deleting a draft",
  folders_list: "Listing folders",
};

export function toolWords(name: string): string {
  return TOOL_WORDS[name] ?? name.replace(/_/g, " ");
}

/** Question asked to answer given, in seconds. Null unless the run finished. */
const tookSeconds = (run: Run): number | null => {
  const answer = run.answers[0];
  if (!run.question || !answer) return null;
  const ms = new Date(answer.at).getTime() - new Date(run.question.at).getTime();
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
};

export function AgentRunView({
  run,
  work,
  listening,
  claimed,
}: {
  run: Run;
  /** Set when THIS run is the one an agent is answering right now. */
  work: AgentWork | null;
  listening: boolean;
  /** True once an agent has taken this question — see useAgent().claimed. */
  claimed: boolean;
}) {
  const running = work !== null;
  const unanswered = run.answers.length === 0;

  return (
    <div className="space-y-3">
      {run.question && <Question turn={run.question} />}

      {(run.steps.length > 0 || running) && (
        <Steps steps={run.steps} work={work} took={tookSeconds(run)} />
      )}

      {run.answers.map((answer) => (
        <Answer key={answer.seq} turn={answer} />
      ))}

      {/* No answer, and nothing in flight. Which of the two reasons it is
          changes what the user should do, so they are never merged. */}
      {unanswered && !running && run.question && (
        <Unanswered listening={listening} claimed={claimed} />
      )}
    </div>
  );
}

function Question({ turn }: { turn: AgentTurn }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[82%] min-w-0 rounded-[var(--radius-lg)] bg-surface-selected px-3 py-2 text-[13px] leading-[20px] text-fg">
        <Markdown text={turn.text} />
      </div>
    </div>
  );
}

function Answer({ turn }: { turn: AgentTurn }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 flex items-baseline gap-2 text-[11px] leading-4 text-fg-tertiary">
        <span className="font-medium text-fg-secondary">
          {turn.agent ? displayAgentName(turn.agent) : "Agent"}
        </span>
        <time dateTime={isoAttr(turn.at)} title={isoTitle(turn.at)} className="tnum">
          {new Date(turn.at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </p>
      <div className="mailmux-answer text-[13px] leading-[20px] text-fg">
        <Markdown text={turn.text} />
      </div>
    </div>
  );
}

/**
 * The steps block.
 *
 * While the run is live it is open, and the newest step is the headline: that
 * is the one piece of "what is happening right now" the product has. Once the
 * answer lands it collapses to a summary — the steps were scaffolding, and
 * leaving eight of them stacked above every answer would bury the answer.
 *
 * The count in that summary is the agent's own `chat_activity` lines, and only
 * those. A tool row is a live hint: the channel keeps the LAST call and drops
 * it when the work ends, so a finished run has no tools to count and the list
 * you expand afterwards is exactly the list the number describes. Making the
 * two agree the other way — persisting tool calls as turns — would write rows
 * the agent then reads back through `chat_history` as if it had said them.
 */
function Steps({
  steps,
  work,
  took,
}: {
  steps: AgentTurn[];
  work: AgentWork | null;
  took: number | null;
}) {
  const running = work !== null;
  const [open, setOpen] = React.useState(false);
  const expanded = running || open;

  /* Everything that happened, in the order it happened. An activity line is a
     turn the agent wrote; a tool row is a call this server handled and never
     wrote down, so it has no seq and only the latest one is known. */
  const rows: Array<{ key: string; text: string; at: string }> = steps.map(
    (step) => ({ key: `s${step.seq}`, text: step.text, at: step.at }),
  );
  const tool = work?.tool;
  if (tool && steps.at(-1)?.text !== toolWords(tool.name)) {
    rows.push({ key: `t${tool.at}`, text: toolWords(tool.name), at: tool.at });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at));

  /* Steps read downward, oldest first, the way the rest of the conversation
     does — the newest one ends up closest to where the answer will land. The
     headline is therefore a state, not the latest line: putting "now" on top
     of "before that" made the block read 3, 1, 2.

     Once the answer lands the whole block folds into one summary row. The
     steps were scaffolding; eight of them stacked over every answer would bury
     the answer. */
  const liveKey = running ? rows.at(-1)?.key : undefined;
  const headline = running
    ? "Working"
    : `${steps.length} step${steps.length === 1 ? "" : "s"}${
        took === null ? "" : ` · ${took}s`
      }`;

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={expanded}
        aria-label={
          running
            ? `Your agent is working. ${rows.at(-1)?.text ?? "No step reported yet"}`
            : `${headline}. Show what it did.`
        }
        disabled={running}
        className={cn(
          "group flex w-full items-center gap-1.5 rounded-[var(--radius-md)] py-0.5 text-left",
          "text-[12px] leading-4 text-fg-tertiary transition-colors duration-[var(--dur-fast)]",
          "hover:text-fg-secondary disabled:cursor-default disabled:hover:text-fg-tertiary",
        )}
      >
        {running ? (
          <WorkingDot />
        ) : (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-[var(--dur-fast)]",
              expanded && "rotate-90",
            )}
            strokeWidth={1.5}
          />
        )}
        <span className="min-w-0 truncate">{headline}</span>
        {running && <Elapsed since={work.since} />}
      </button>

      {expanded && rows.length > 0 && (
        <ol className="mt-1 ml-[6px] space-y-1 border-l border-border-subtle pl-3.5">
          {rows.map((row) => (
            <li
              key={row.key}
              className={cn(
                "relative text-[12px] leading-4 before:absolute before:top-[5px] before:-left-[18px] before:size-1 before:rounded-[var(--radius-full)]",
                // The newest line, while it is still the newest and something
                // is still happening. Everything above it is settled history.
                row.key === liveKey
                  ? "mailmux-shimmer before:bg-accent"
                  : "text-fg-tertiary before:bg-[var(--dot-muted)]",
              )}
            >
              {row.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * A question with no answer, and the two ways that happens.
 *
 * Queued is recoverable and needs nothing from the user: the message sits
 * unclaimed on disk and the next agent to call in gets it.
 *
 * Dropped is not. A hand-off is permanent — `claimNextUserTurn` marks the row
 * delivered inside the claim transaction and no agent is ever offered it again
 * — so an agent that took this one and went away took it with it. Telling
 * somebody to wait for that would be telling them to wait for nothing.
 */
function Unanswered({
  listening,
  claimed,
}: {
  listening: boolean;
  claimed: boolean;
}) {
  if (claimed) {
    return (
      <p className="flex items-start gap-2 text-[12px] leading-4 text-fg-tertiary">
        <TriangleAlert
          aria-hidden="true"
          className="mt-px size-3.5 shrink-0 text-warning"
          strokeWidth={1.5}
        />
        <span>
          Your agent took this one and never answered. It will not be handed
          over again — send it once more to try another agent.
        </span>
      </p>
    );
  }

  return (
    <p className="flex items-center gap-2 text-[12px] leading-4 text-fg-tertiary">
      <span
        aria-hidden="true"
        className="block size-1.5 shrink-0 rounded-[var(--radius-full)] bg-[var(--dot-muted)]"
      />
      {listening
        ? "Handing this to your agent…"
        : "Waiting for an agent. This is delivered as soon as one starts."}
    </p>
  );
}

/**
 * The running mark: an accent dot with one ring breathing out of it.
 *
 * Two pieces of motion on the whole screen — this and the shimmer on the step
 * text — and they only ever run while a message is genuinely claimed.
 */
export function WorkingDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("relative flex size-3.5 shrink-0 items-center justify-center", className)}
    >
      <span className="mailmux-ping absolute size-3.5 rounded-[var(--radius-full)] bg-accent" />
      <span className="relative block size-1.5 rounded-[var(--radius-full)] bg-accent" />
    </span>
  );
}

/** Seconds since the hand-off. Ticks; the number is the point. */
function Elapsed({ since }: { since: string }) {
  const start = React.useMemo(() => new Date(since).getTime(), [since]);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.round((now - start) / 1000));
  const label =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;

  return (
    <span className="tnum ml-auto shrink-0 pl-2 text-[11px] text-fg-tertiary">
      {label}
    </span>
  );
}
