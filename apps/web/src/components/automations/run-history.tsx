"use client";

import * as React from "react";
import { CircleAlert } from "lucide-react";
import { AgentSignIn } from "@/components/agent/agent-sign-in";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { asSentence } from "@/lib/agent-copy";
import { friendlyError } from "@/lib/api/errors";
import { formatReaderDate, isoAttr, isoTitle } from "@/lib/format/date";
import { runStatusLabel } from "@/lib/format/automation";
import { useAutomationRuns } from "@/lib/hooks/use-automations";
import { useLocalAgents } from "@/lib/hooks/use-local-agents";
import type { AutomationRun, AutomationRunStatus } from "@/lib/types";

const TONE: Record<AutomationRunStatus, "success" | "danger" | "warning" | "accent"> = {
  running: "accent",
  ok: "success",
  error: "danger",
  killed: "warning",
};

/** Wall time between the two stamps, at the coarsest unit that stays honest. */
function duration(run: AutomationRun): string {
  if (!run.finishedAt) return "";
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return "under a second";
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * A run that never started. Its log is Boxaide's own reason, not CLI output.
 *
 * The empty agent id is the scheduler's marker for it, written only on the
 * path where nothing was spawned. Null is not that marker: rows written
 * before Boxaide recorded the agent are null too, and their log is captured
 * CLI output that must stay behind the disclosure below.
 */
function blockedReason(run: AutomationRun): boolean {
  return run.status === "error" && run.agentId === "" && run.log !== "";
}

function antigravityAuthRequired(run: AutomationRun): boolean {
  return (
    run.status === "error" &&
    run.agentId === "antigravity" &&
    run.log.includes("[boxaide] auth-required:")
  );
}

/**
 * One automation's runs, newest first.
 *
 * The log is the agent's captured stdout and stderr: it quotes mail, which is
 * why it is encrypted at rest and why it is rendered here as text in a <pre>
 * and never as markup. It is the LAST 4 KiB the server holds, the tail and not
 * the whole run, so it is labelled as such rather than presented as complete.
 */
export function RunHistory({ automationId }: { automationId: string }) {
  const runs = useAutomationRuns(automationId, true);
  const rows = runs.data ?? [];
  // Only to turn a stored id into the label the pickers use. An id the
  // launcher no longer knows prints as itself, which is still the truth.
  const agents = useLocalAgents();
  const agentLabel = (id: string) =>
    agents.data?.agents.find((a) => a.id === id)?.label ?? id;

  if (runs.isError) {
    return (
      <div role="alert" className="mt-2 rounded-[var(--radius-md)] bg-danger-bg p-2.5">
        <p className="flex items-center gap-2 text-[13px] text-danger">
          <CircleAlert aria-hidden="true" className="size-4" strokeWidth={1.5} />
          {friendlyError(
            runs.error instanceof Error ? runs.error.message : runs.error,
          )}
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => void runs.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (runs.isPending) {
    return (
      <div className="mt-2 space-y-1.5">
        <Skeleton className="h-3 w-[40%]" />
        <Skeleton className="h-3 w-[55%]" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="mt-2 text-[13px] leading-[18px] text-fg-tertiary">
        No runs yet.
      </p>
    );
  }

  return (
    <ul className="mt-2 list-none space-y-2">
      {rows.map((run) => (
        <li
          key={run.id}
          className="border-l border-border-subtle py-1 pl-3"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={TONE[run.status] ?? "neutral"}>
              {runStatusLabel(run.status)}
            </Badge>
            <time
              dateTime={isoAttr(run.startedAt)}
              title={isoTitle(run.startedAt)}
              className="text-[11px] leading-4 text-fg-tertiary"
            >
              {formatReaderDate(run.startedAt)}
            </time>
            {duration(run) && (
              <span className="text-[11px] leading-4 text-fg-tertiary">
                · {duration(run)}
              </span>
            )}
            {/* Only when it says something the status does not: 0 is "ok" and
                a killed run has no code at all. */}
            {run.exitCode !== null && run.exitCode !== 0 && (
              <span className="tnum text-[11px] leading-4 text-fg-tertiary">
                · exit {run.exitCode}
              </span>
            )}
            {/* Which agent really carried it, on which model. Null on rows
                written before Boxaide recorded this, and empty on a run that
                never started. */}
            {run.agentId && (
              <span className="text-[11px] leading-4 text-fg-tertiary">
                · {agentLabel(run.agentId)}
                {run.model ? ` · ${run.model}` : ""}
              </span>
            )}
          </div>

          {/* Nothing started: the log is Boxaide's own reason, so it is shown
              plainly. It keeps its paths and file names here, because this is
              the one place the reader has to act on them. Any other log is
              captured CLI output and stays inside the disclosure that carries
              the mail warning. */}
          {blockedReason(run) ? (
            <p className="mt-1 text-[12px] leading-4 whitespace-pre-wrap text-danger">
              {asSentence(run.log)}
            </p>
          ) : antigravityAuthRequired(run) ? (
            <div className="mt-1 space-y-2">
              <p className="text-[12px] leading-4 text-danger">
                Antigravity needs sign-in before this automation can run.
              </p>
              <AgentSignIn agentId="antigravity" relaunch={false} />
            </div>
          ) : run.log ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-[12px] text-fg-tertiary hover:text-fg-secondary">
                Log
              </summary>
              <p className="mt-1 text-[11px] leading-4 text-fg-tertiary">
                The last 4 KiB of what the run wrote. Stored encrypted on this
                machine; it can quote your mail.
              </p>
              <pre className="pane-scroll mt-1 max-h-64 overflow-auto rounded-[var(--radius-md)] border border-border-subtle bg-surface-0 p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-fg-secondary">
                {run.log}
              </pre>
            </details>
          ) : (
            <p className="mt-1 text-[12px] leading-4 text-fg-tertiary">
              {run.status === "running"
                ? "Still running. The log is written when it finishes."
                : "This run wrote nothing."}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
