"use client";

import { Sparkles } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLocalAgents } from "@/lib/hooks/use-local-agents";
import { useSettings, useUpdateSettings } from "@/lib/hooks/use-settings";

/**
 * Models for the agent in play — the one this process launched, or the one
 * that last exited. A catalog of every installed CLI is not a picker: the
 * choice only reaches the next Start, and only if that CLI offers the id.
 */
export function AgentModelSelect({ disabled }: { disabled?: boolean } = {}) {
  const agents = useLocalAgents();
  const settings = useSettings();
  const update = useUpdateSettings();

  const allAgents = agents.data?.agents ?? [];
  const running = agents.data?.running ?? null;
  const lastExit = agents.data?.lastExit ?? null;
  const focusId = running?.id ?? lastExit?.id ?? null;
  const focus = focusId ? (allAgents.find((a) => a.id === focusId) ?? null) : null;
  const models = focus?.models ?? [];

  if (models.length === 0) return null;

  const known = models.some((m) => m.id === settings.agentModel);

  return (
    <Select
      value={known ? settings.agentModel : "default"}
      onValueChange={(value) =>
        update({ agentModel: value === "default" ? "" : value })
      }
      disabled={disabled}
    >
      <SelectTrigger
        size="xs"
        aria-label="Model for your agent"
        className="h-6 rounded-[var(--radius-md)] border border-border-subtle bg-surface-1 px-2 text-[11px] text-fg-secondary hover:bg-surface-hover hover:text-fg transition-colors gap-1.5 focus-visible:ring-0 focus-visible:outline-none"
      >
        <Sparkles className="size-3 shrink-0 text-fg-tertiary" strokeWidth={1.5} />
        <SelectValue placeholder="Default model" />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value="default">Default model</SelectItem>
        {models.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
