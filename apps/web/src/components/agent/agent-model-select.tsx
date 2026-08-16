"use client";

import { useState } from "react";
import { Check, Sparkles } from "lucide-react";
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
import { useLocalAgents } from "@/lib/hooks/use-local-agents";
import { useSettings, useUpdateSettings } from "@/lib/hooks/use-settings";
import { cn } from "@/lib/utils";

const DEFAULT_VALUE = "default";

/**
 * Models for the agent in play — the one this process launched, or the one
 * that last exited. A catalog of every installed CLI is not a picker: the
 * choice only reaches the next Start, and only if that CLI offers the id.
 *
 * Searchable rather than a plain select, because the list is whatever the CLI
 * reports and that is not always short — OpenCode names several hundred.
 */
export function AgentModelSelect({ disabled }: { disabled?: boolean } = {}) {
  const agents = useLocalAgents();
  const settings = useSettings();
  const update = useUpdateSettings();
  const [open, setOpen] = useState(false);

  const allAgents = agents.data?.agents ?? [];
  const running = agents.data?.running ?? null;
  const lastExit = agents.data?.lastExit ?? null;
  const focusId = running?.id ?? lastExit?.id ?? null;
  const focus = focusId ? (allAgents.find((a) => a.id === focusId) ?? null) : null;
  const models = focus?.models ?? [];

  if (models.length === 0) return null;

  const picked = models.find((m) => m.id === settings.agentModel) ?? null;

  const choose = (id: string) => {
    update({ agentModel: id === DEFAULT_VALUE ? "" : id });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label="Model for your agent"
        className="flex h-6 min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] border border-border-subtle bg-surface-1 px-2 text-[11px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline-none disabled:opacity-50"
      >
        <Sparkles className="size-3 shrink-0 text-fg-tertiary" strokeWidth={1.5} />
        <span className="truncate">{picked?.label ?? "Default model"}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search models..." className="h-8 text-[12px]" />
          <CommandList className="max-h-64">
            <CommandEmpty>No model matches.</CommandEmpty>
            <ModelRow
              label="Default model"
              selected={picked === null}
              onSelect={() => choose(DEFAULT_VALUE)}
              value={DEFAULT_VALUE}
            />
            {models.map((m) => (
              <ModelRow
                key={m.id}
                // Both, so a search for either the id or the shown label hits.
                value={`${m.label} ${m.id}`}
                label={m.label}
                selected={picked?.id === m.id}
                onSelect={() => choose(m.id)}
              />
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ModelRow({
  value,
  label,
  selected,
  onSelect,
}: {
  value: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
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
