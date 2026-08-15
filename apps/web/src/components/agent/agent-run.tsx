"use client";

import * as React from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { Markdown } from "@/lib/format/markdown";
import { isoAttr, isoTitle } from "@/lib/format/date";
import { displayAgentName } from "@/components/agent/agent-presence";
import { cn } from "@/lib/utils";
import type { AgentTurn, AgentWork } from "@/lib/types";
import { groupRuns, type Run } from "./group-runs";
import { formatClock, stepsHeadline, workStale } from "./steps-copy";

export { groupRuns, type Run };

/**
 * Plain words for a tool, so a step reads as an action, not an API.
 *
 * Two vocabularies land here. Boxaide's own tools arrive from the server; a
 * launched CLI's private tools arrive from its event stream, under whichever
 * names that CLI uses, so both spellings of the same act are listed. Anything
 * unlisted falls back to its bare name — a wrong guess would be worse.
 */
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

  // Claude Code's tools, then Grok's, as their streams name them.
  Read: "Reading a file",
  Write: "Writing a file",
  Edit: "Editing a file",
  Bash: "Running a command",
  BashOutput: "Reading command output",
  Glob: "Looking for files",
  Grep: "Searching through files",
  WebSearch: "Searching the web",
  WebFetch: "Reading a web page",
  TodoWrite: "Planning its next steps",
  Task: "Handing part of this to a subagent",
  read_file: "Reading a file",
  write: "Writing a file",
  search_replace: "Editing a file",
  run_terminal_command: "Running a command",
  get_command_or_subagent_output: "Reading command output",
  list_dir: "Looking for files",
  grep: "Searching through files",
  web_search: "Searching the web",
  web_fetch: "Reading a web page",
  todo_write: "Planning its next steps",
  spawn_subagent: "Handing part of this to a subagent",
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
  waiting,
  lastSeenAt,
  claimed,
}: {
  run: Run;
  /** Set when THIS run is the one an agent is answering right now. */
  work: AgentWork | null;
  /** Parked `chat_await_message` count — the only proof a next hand-off is ready. */
  waiting: number;
  lastSeenAt: string | null;
  /** True once an agent has taken this question — see useAgent().claimed. */
  claimed: boolean;
}) {
  const running = work !== null;
  const unanswered = run.answers.length === 0;

  return (
    <div className="space-y-3">
      {run.question && <Question turn={run.question} />}

      {(run.steps.length > 0 || running) && (
        <Steps
          steps={run.steps}
          work={work}
          lastSeenAt={lastSeenAt}
          took={tookSeconds(run)}
        />
      )}

      {run.answers.map((answer) => (
        <Answer key={answer.seq} turn={answer} />
      ))}

      {/* No answer, and nothing in flight. Which of the two reasons it is
          changes what the user should do, so they are never merged. */}
      {unanswered && !running && run.question && (
        <Unanswered waiting={waiting} claimed={claimed} />
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
 * The tool is the live headline; the list and the count are the agent's own
 * `chat_activity` lines. A tool row would vanish when work ends, so the fold
 * would disagree with the list you expand afterwards. Once the answer lands
 * the block folds to that count — the steps were scaffolding, and leaving
 * eight of them stacked above every answer would bury the answer.
 */
function Steps({
  steps,
  work,
  lastSeenAt,
  took,
}: {
  steps: AgentTurn[];
  work: AgentWork | null;
  lastSeenAt: string | null;
  took: number | null;
}) {
  const running = work !== null;
  const [open, setOpen] = React.useState(false);
  const expanded = running || open;
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);

  const stale = running && workStale(lastSeenAt, now);
  const headline = stepsHeadline({
    running,
    lastSeenAt,
    toolLabel: work?.tool ? toolWords(work.tool.name) : null,
    stepCount: steps.length,
    took,
    now,
  });

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={expanded}
        aria-label={running ? headline : `${headline}. Show what it did.`}
        disabled={running}
        className={cn(
          "group flex w-full items-center gap-1.5 rounded-[var(--radius-md)] py-0.5 text-left",
          "text-[12px] leading-4 text-fg-tertiary transition-colors duration-[var(--dur-fast)]",
          "hover:text-fg-secondary disabled:cursor-default disabled:hover:text-fg-tertiary",
        )}
      >
        {stale ? (
          <span
            aria-hidden="true"
            className="flex size-3.5 shrink-0 items-center justify-center"
          >
            <span className="block size-1.5 rounded-[var(--radius-full)] bg-[var(--dot-muted)]" />
          </span>
        ) : running ? (
          <WorkingMark />
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
        <span
          className={cn(
            "min-w-0 truncate",
            running && !stale && "mailmux-shimmer",
          )}
        >
          {headline}
        </span>
        {running && !stale && <Elapsed since={work.since} now={now} />}
      </button>

      {expanded && steps.length > 0 && (
        <ol
          className={cn(
            /* The rail fades downward, toward where the answer will land —
               a timeline dissolving into its result, not a box around it. */
            "relative mt-1.5 ml-[6px] space-y-1.5 pl-4",
            "before:absolute before:inset-y-[3px] before:left-0 before:w-px",
            "before:bg-gradient-to-b before:from-[var(--border-strong)] before:to-transparent",
            /* A settled run can hold a wall of narration. Cap it; the live
               list stays uncapped so the newest line is never hidden. */
            !running && "pane-scroll max-h-60 overflow-y-auto",
          )}
        >
          {steps.map((step, index) => (
            <li
              key={step.seq}
              className={cn(
                "mailmux-step-in relative text-[12px] leading-4 text-fg-tertiary",
                /* Hollow, not filled: a settled step is a checkpoint passed,
                   and an outline reads quieter than a row of solid dots.
                   5px, because a 4px ring is one pixel of border around
                   nothing. */
                "before:absolute before:top-[5px] before:-left-[18.5px] before:size-[5px]",
                "before:rounded-[var(--radius-full)] before:border before:border-[var(--dot-muted)]",
                "before:bg-transparent",
              )}
              /* Streamed rows enter one by one as they land; a settled list
                 mounts whole, so it cascades instead of popping. */
              style={
                running
                  ? undefined
                  : { animationDelay: `${Math.min(index * 25, 200)}ms` }
              }
            >
              {step.text}
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
  waiting,
  claimed,
}: {
  waiting: number;
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
      {waiting > 0
        ? "Handing this to your agent…"
        : "Waiting for an agent. This is delivered as soon as one starts."}
    </p>
  );
}

/**
 * The running mark: the Boxaide glyph writing itself, in the accent.
 *
 * A spinner says "software is busy". This says "Boxaide is holding your
 * message": the same braces-around-a-line the brand mark draws statically,
 * tracing in stroke by stroke, mail line landing last, then starting over.
 * Path data mirrors BrandGlyph in atoms.tsx — generated from
 * apps/desktop/scripts/lib/mark.mjs, never nudged by hand — with pathLength
 * normalised to 1 so the CSS trace maths is unit-length. The stroke is
 * heavier than BrandGlyph's: this renders at 14px in the accent colour, and
 * 1.24 at that size dissolves into the background it is meant to stand out
 * from.
 *
 * It and the shimmer on the headline are the only motion in the pane, and
 * both run only while a message is genuinely claimed.
 */
export function WorkingMark({
  size = 14,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0 text-accent", className)}
    >
      <path
        pathLength={1}
        className="mailmux-trace"
        d="M10.55 7.78L8.7 7.78L8.7 11.34L7.12 12L8.7 12.66L8.7 16.22L10.55 16.22"
        strokeWidth={1.9}
      />
      <path
        pathLength={1}
        className="mailmux-trace"
        d="M13.45 7.78L15.3 7.78L15.3 11.34L16.88 12L15.3 12.66L15.3 16.22L13.45 16.22"
        strokeWidth={1.9}
      />
      <path
        className="mailmux-trace-bar"
        d="M10.81 12L13.19 12"
        strokeWidth={1.9}
      />
    </svg>
  );
}

/** Seconds since the hand-off. Parent ticks; the number is the point. */
function Elapsed({ since, now }: { since: string; now: number }) {
  const seconds = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
  return (
    <span className="tnum ml-auto shrink-0 pl-2 text-[11px] text-fg-tertiary">
      {formatClock(seconds)}
    </span>
  );
}
