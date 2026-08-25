"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Spinner, StatusDot } from "@/components/atoms";
import { AutomationAgentSelect } from "@/components/automations/automation-agent-select";
import { RunHistory } from "@/components/automations/run-history";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/api/errors";
import { describeCron, runStatusLabel } from "@/lib/format/automation";
import { formatReaderDate, isoAttr, isoTitle } from "@/lib/format/date";
import {
  useDeleteAutomation,
  useRunAutomationNow,
  useToggleAutomation,
} from "@/lib/hooks/use-automations";
import type { Automation, AutomationRunStatus } from "@/lib/types";

/** Same tones as the run history, so the card and the list agree. */
const STATUS_TONE: Record<AutomationRunStatus, "accent" | "success" | "danger" | "warning"> = {
  running: "accent",
  ok: "success",
  error: "danger",
  killed: "warning",
};

/**
 * One automation.
 *
 * Everything about WHAT it does — its name, its schedule, its prompt — is
 * read-only here: automations are written by talking to the agent, and a form
 * that let a person half-edit one would be a second authoring surface with none
 * of the agent's context. What IS editable here is everything about HOW it
 * runs, which needs no such context: whether it runs at all, whether it runs
 * right now, and which agent and model carry it.
 */
export function AutomationCard({ automation }: { automation: Automation }) {
  const toggle = useToggleAutomation();
  const runNow = useRunAutomationNow();
  const [showRuns, setShowRuns] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState(false);
  const switchId = `automation-${automation.id}-enabled`;

  const setEnabled = (enabled: boolean) => {
    toggle.mutate(
      { automationId: automation.id, enabled },
      {
        onSuccess: () =>
          toast.success(
            enabled ? `${automation.name} is on` : `${automation.name} is paused`,
          ),
        onError: (error) =>
          toast.error("Could not change that automation", {
            description: friendlyError(
              error instanceof Error ? error.message : error,
            ),
          }),
      },
    );
  };

  const run = () => {
    runNow.mutate(automation.id, {
      onSuccess: () => {
        // The 202 means queued, not done — runs are serialized one at a time,
        // so saying "ran" here would be a claim the server never made.
        setShowRuns(true);
        toast.success(`Queued ${automation.name}`, {
          description: "One automation runs at a time. Watch it under Runs.",
        });
      },
      onError: (error) =>
        toast.error("Could not queue that run", {
          description: friendlyError(
            error instanceof Error ? error.message : error,
          ),
        }),
    });
  };

  return (
    <section className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-1 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] leading-[18px] font-medium text-fg">
            {automation.name}
          </h3>
          <p className="mt-0.5 flex flex-wrap items-baseline gap-1.5 text-[12px] leading-[18px] text-fg-secondary">
            {describeCron(automation.cron)}
            {/* The expression itself, always, beside the sentence: it is what
                the scheduler evaluates, in the server's timezone. */}
            <code className="font-mono text-[11px] text-fg-tertiary">
              {automation.cron}
            </code>
          </p>
        </div>

        <label
          htmlFor={switchId}
          className="flex shrink-0 items-center gap-2 text-[12px] leading-4 text-fg-secondary"
        >
          {automation.enabled ? "On" : "Paused"}
          <Switch
            id={switchId}
            checked={automation.enabled}
            disabled={toggle.isPending}
            onCheckedChange={setEnabled}
          />
        </label>
      </div>

      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] leading-[18px]">
        <div className="flex gap-1.5">
          <dt className="text-fg-tertiary">Next</dt>
          <dd className="text-fg-secondary">
            {automation.enabled && automation.nextRunAt ? (
              <time
                dateTime={isoAttr(automation.nextRunAt)}
                title={isoTitle(automation.nextRunAt)}
              >
                {formatReaderDate(automation.nextRunAt)}
              </time>
            ) : (
              // A paused automation has a stored next_run_at that will not
              // fire. Printing it would be a schedule that is not kept.
              "Not scheduled"
            )}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-fg-tertiary">Last</dt>
          <dd className="flex items-center gap-1.5 text-fg-secondary">
            {automation.lastRunAt ? (
              <time
                dateTime={isoAttr(automation.lastRunAt)}
                title={isoTitle(automation.lastRunAt)}
              >
                {formatReaderDate(automation.lastRunAt)}
              </time>
            ) : (
              "Never"
            )}
            {/* How it went, beside when. The dot is never alone: the word
                follows it, and the Runs list below says the same in full. */}
            {automation.lastRunStatus && (
              <span className="flex items-center gap-1">
                <StatusDot tone={STATUS_TONE[automation.lastRunStatus]} />
                {runStatusLabel(automation.lastRunStatus)}
              </span>
            )}
          </dd>
        </div>
      </dl>

      <AutomationAgentSelect automation={automation} />

      <details className="mt-2">
        <summary className="cursor-pointer text-[12px] text-fg-tertiary hover:text-fg-secondary">
          Instructions
        </summary>
        <p className="mt-1 text-[13px] leading-[18px] whitespace-pre-wrap text-fg-secondary">
          {automation.prompt}
        </p>
      </details>

      <div className="mt-2.5 flex items-center gap-1.5">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={runNow.isPending}
          onClick={run}
        >
          {runNow.isPending ? <Spinner /> : <Play className="size-3.5" strokeWidth={1.5} />}
          {runNow.isPending ? "Queueing…" : "Run now"}
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={showRuns}
          onClick={() => setShowRuns((open) => !open)}
        >
          {showRuns ? (
            <ChevronDown className="size-3.5" strokeWidth={1.5} />
          ) : (
            <ChevronRight className="size-3.5" strokeWidth={1.5} />
          )}
          Runs
        </Button>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${automation.name}`}
              className="ml-auto text-fg-tertiary hover:text-danger"
              onClick={() => setPendingDelete(true)}
            >
              <Trash2 className="size-3.5" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete automation</TooltipContent>
        </Tooltip>
      </div>

      <DeleteAutomationConfirm
        automation={pendingDelete ? automation : null}
        onClose={() => setPendingDelete(false)}
      />

      {/* Mounted only while open: each run row carries up to 4 KiB of decrypted
          log, and that is mail-derived text nobody asked to see. */}
      {showRuns && <RunHistory automationId={automation.id} />}
    </section>
  );
}

/**
 * The confirmation asked before an automation and its run history are destroyed.
 */
export function DeleteAutomationConfirm({
  automation,
  onClose,
}: {
  automation: Automation | null;
  onClose: () => void;
}) {
  const remove = useDeleteAutomation();

  const confirm = () => {
    if (!automation) return;
    remove.mutate(automation.id, {
      onSuccess: (result) => {
        onClose();
        if (result.deleted) {
          toast.success(`Deleted ${automation.name}`);
        } else {
          toast.warning(`${automation.name} was already gone`);
        }
      },
      onError: (error) => {
        toast.error("Could not delete that automation", {
          description: friendlyError(
            error instanceof Error ? error.message : error,
          ),
        });
      },
    });
  };

  return (
    <AlertDialog
      open={automation !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this automation?</AlertDialogTitle>
          <AlertDialogDescription>
            “{automation?.name}” and its past run history will be deleted.
            Nothing undoes this.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost">Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending}
            onClick={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            {remove.isPending && <Spinner />}
            {remove.isPending ? "Deleting…" : "Delete automation"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
