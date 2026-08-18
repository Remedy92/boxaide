"use client";

import { useState } from "react";
import { Bot, Check } from "lucide-react";
import { toast } from "sonner";
import {
  Command,
  CommandEmpty,
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
import {
  modelForStart,
  usePickedAgent,
  useLocalAgents,
  useStartLocalAgent,
  useStopLocalAgent,
} from "@/lib/hooks/use-local-agents";
import { useSettings, useUpdateSettings } from "@/lib/hooks/use-settings";
import { cn } from "@/lib/utils";

/**
 * Which agent CLI answers, chosen where the question is typed.
 *
 * Only CLIs found on the server's machine are listed; ones this build cannot
 * launch yet say "soon" rather than vanishing, so an install that looks right
 * to the user is not silently missing. Picking does not start anything on its
 * own — a send does that (useEnsureAgentRunning) — with one exception below.
 *
 * Not searchable, unlike the model select: this list is a handful of installed
 * CLIs, never the several hundred rows a model catalog can reach.
 */
export function AgentSelect({ disabled }: { disabled?: boolean } = {}) {
  const agents = useLocalAgents();
  const { picked, running } = usePickedAgent();
  const { agentModel } = useSettings();
  const update = useUpdateSettings();
  const start = useStartLocalAgent();
  const stop = useStopLocalAgent();
  const [open, setOpen] = useState(false);

  const rows = (agents.data?.agents ?? []).filter((a) => a.available);
  if (rows.length === 0) return null;

  const busy = start.isPending || stop.isPending;

  const fail = (err: unknown) =>
    toast.error(friendlyError(err instanceof Error ? err.message : String(err)));

  const choose = async (agent: LocalAgent) => {
    setOpen(false);
    // Nothing running means nothing to do beyond remembering the choice: the
    // next send starts it.
    if (!running || running.id === agent.id) {
      update({ agentId: agent.id });
      return;
    }
    // One agent runs at a time, so a swap mid-session has to put the old one
    // down before it can ask for the new one. The pick only moves once that
    // has happened: an agent this control could not stop is still the one
    // answering, and naming a different one would be a lie the user cannot see
    // through.
    try {
      await stop.mutateAsync();
    } catch (err) {
      fail(err);
      return;
    }
    update({ agentId: agent.id });
    try {
      await start.mutateAsync({
        id: agent.id,
        model: modelForStart(agent, agentModel),
      });
    } catch (err) {
      // The pick stands: nothing is running now, the toast said why, and the
      // next send starts this agent rather than the one that just went down.
      fail(err);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled || busy}
        aria-label="Agent to answer with"
        className="flex h-6 min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] border border-border-subtle bg-surface-1 px-2 text-[11px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline-none disabled:opacity-50"
      >
        <Bot className="size-3 shrink-0 text-fg-tertiary" strokeWidth={1.5} />
        <span className="truncate">{picked?.label ?? "Choose agent"}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command>
          <CommandList className="max-h-64">
            <CommandEmpty>No agent found on this machine.</CommandEmpty>
            {rows.map((agent) => (
              <CommandItem
                key={agent.id}
                value={agent.label}
                disabled={!agent.supported}
                onSelect={() => void choose(agent)}
                className="text-[12px]"
              >
                <Check
                  className={cn(
                    "size-3 shrink-0",
                    picked?.id === agent.id ? "opacity-100" : "opacity-0",
                  )}
                  strokeWidth={2}
                />
                <span className="truncate">{agent.label}</span>
                {running?.id === agent.id && (
                  <span className="ml-auto text-[11px] text-fg-tertiary">
                    running
                  </span>
                )}
                {!agent.supported && (
                  <span className="ml-auto text-[11px] text-fg-tertiary">
                    soon
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
