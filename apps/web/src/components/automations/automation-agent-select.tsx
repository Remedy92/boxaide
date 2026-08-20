"use client";

import * as React from "react";
import { Check, Sparkles, Terminal } from "lucide-react";
import { toast } from "sonner";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { friendlyError } from "@/lib/api/errors";
import type { LocalAgent } from "@/lib/api/endpoints";
import { useSetAutomationAgent } from "@/lib/hooks/use-automations";
import { useLocalAgents } from "@/lib/hooks/use-local-agents";
import type { Automation } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Sentinel for the "let the server decide" row, which has no id of its own. */
const DEFAULT_VALUE = "__default__";

/**
 * Who runs this automation, and on what.
 *
 * The two pickers are one control: a model id belongs to exactly one CLI, so
 * changing the agent clears the model server-side. The model picker therefore
 * always lists the models of the agent shown beside it — including the one the
 * server would fall back to when no agent is stored, so "Default model" is
 * never an empty promise about a CLI nobody named.
 *
 * Only agents that can carry a scheduled run are offered. Antigravity and
 * OpenCode are detected by the launcher but have no one-shot form, so choosing
 * one would produce an automation that fails at every fire.
 */
export function AutomationAgentSelect({ automation }: { automation: Automation }) {
  const agents = useLocalAgents();
  const save = useSetAutomationAgent();

  const runnable = (agents.data?.agents ?? []).filter((a) => a.runsAutomations);
  // Mirrors resolveRunSpec in src/agent/launcher.ts: with no agent stored, the
  // run goes to the first installed one that can carry it.
  const fallback = runnable.find((a) => a.available) ?? null;
  const chosen = automation.agentId
    ? (runnable.find((a) => a.id === automation.agentId) ?? null)
    : null;
  const effective = chosen ?? (automation.agentId ? null : fallback);
  const models = effective?.models ?? [];
  const pickedModel = models.find((m) => m.id === automation.model) ?? null;

  const apply = (patch: { agentId?: string | null; model?: string | null }) => {
    save.mutate(
      { automationId: automation.id, ...patch },
      {
        onError: (error) =>
          toast.error("Could not change that automation", {
            description: friendlyError(
              error instanceof Error ? error.message : error,
            ),
          }),
      },
    );
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <PickerPopover
        icon={<Terminal className="size-3 shrink-0 text-fg-tertiary" strokeWidth={1.5} />}
        label={agentLabel(automation.agentId, chosen, fallback)}
        ariaLabel={`Agent that runs ${automation.name}`}
        disabled={save.isPending}
        searchPlaceholder="Search agents..."
        emptyText="No agent can run automations."
        defaultRow={{
          label: fallback
            ? `First available (${fallback.label})`
            : "First available",
          selected: automation.agentId === null,
          onSelect: () => apply({ agentId: null }),
        }}
        rows={runnable.map((agent) => ({
          value: `${agent.label} ${agent.id}`,
          label: agent.available ? agent.label : `${agent.label} — not installed`,
          selected: automation.agentId === agent.id,
          onSelect: () => apply({ agentId: agent.id }),
        }))}
      />

      {/* No models to offer means no picker, exactly as in the Agent pane: an
          empty list is a CLI that never named any, not a default worth drawing. */}
      {models.length > 0 && (
        <PickerPopover
          icon={
            <Sparkles className="size-3 shrink-0 text-fg-tertiary" strokeWidth={1.5} />
          }
          label={pickedModel?.label ?? modelFallbackLabel(automation.model)}
          ariaLabel={`Model for ${automation.name}`}
          disabled={save.isPending}
          searchPlaceholder="Search models..."
          emptyText="No model matches."
          defaultRow={{
            label: "Default model",
            selected: automation.model === null,
            onSelect: () => apply({ model: null }),
          }}
          rows={models.map((model) => ({
            // Both, so a search for either the id or the shown label hits.
            value: `${model.label} ${model.id}`,
            label: model.label,
            selected: automation.model === model.id,
            onSelect: () => apply({ model: model.id }),
          }))}
        />
      )}
    </div>
  );
}

/**
 * What the agent trigger says. A stored id the launcher no longer offers is
 * printed as itself rather than silently redrawn as the default: that
 * automation really will fail on its next run, and the name is the only clue.
 */
function agentLabel(
  agentId: string | null,
  chosen: LocalAgent | null,
  fallback: LocalAgent | null,
): string {
  if (chosen) return chosen.available ? chosen.label : `${chosen.label} — not installed`;
  if (agentId) return `${agentId} — unavailable`;
  return fallback ? `${fallback.label} (default)` : "No agent installed";
}

/** Same rule for a model id the CLI has stopped naming. */
function modelFallbackLabel(model: string | null): string {
  return model === null ? "Default model" : `${model} — unavailable`;
}

type Row = {
  value: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
};

function PickerPopover({
  icon,
  label,
  ariaLabel,
  disabled,
  searchPlaceholder,
  emptyText,
  defaultRow,
  rows,
}: {
  icon: React.ReactNode;
  label: string;
  ariaLabel: string;
  disabled: boolean;
  searchPlaceholder: string;
  emptyText: string;
  defaultRow: Omit<Row, "value">;
  rows: Row[];
}) {
  const [open, setOpen] = React.useState(false);
  const pick = (run: () => void) => {
    run();
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={ariaLabel}
        className="flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-[var(--radius-md)] border border-border-subtle bg-surface-1 px-2 text-[11px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline-none disabled:opacity-50"
      >
        {icon}
        <span className="truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} className="h-8 text-[12px]" />
          <CommandList className="max-h-64">
            <CommandEmpty>{emptyText}</CommandEmpty>
            <PickerRow
              value={DEFAULT_VALUE}
              label={defaultRow.label}
              selected={defaultRow.selected}
              onSelect={() => pick(defaultRow.onSelect)}
            />
            {rows.map((row) => (
              <PickerRow
                key={row.value}
                value={row.value}
                label={row.label}
                selected={row.selected}
                onSelect={() => pick(row.onSelect)}
              />
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function PickerRow({ value, label, selected, onSelect }: Row) {
  return (
    <CommandItem value={value} onSelect={onSelect} className="text-[12px]">
      <Check
        className={cn("size-3 shrink-0", selected ? "opacity-100" : "opacity-0")}
        strokeWidth={2}
      />
      <span className="truncate">{label}</span>
    </CommandItem>
  );
}
