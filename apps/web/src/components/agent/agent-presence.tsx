"use client";

import { StatusDot } from "@/components/atoms";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AgentConnection } from "@/lib/hooks/use-agent";
import type { AgentPresence as Presence } from "@/lib/types";

/**
 * Whether an agent is listening — and nothing more than the server can prove.
 *
 * "Listening" means an agent is parked in an open `chat_await_message` call, or
 * called one within the last few seconds. That is a fact about a request that
 * is open right now, not a guess. It deliberately does NOT claim an agent is
 * "connected": an MCP client that has merely configured mailmux, or that is
 * using the mail tools without the chat loop, is invisible here and should be.
 *
 * The words carry the state; the dot is redundant with them (1.4.1).
 */
export function AgentPresenceBadge({
  presence,
  connection,
}: {
  presence: Presence;
  connection: AgentConnection;
}) {
  const state =
    connection === "offline"
      ? {
          tone: "danger" as const,
          label: "Server unreachable",
          detail: "mailmux is not answering. Reconnecting.",
        }
      : connection === "unsupported"
        ? {
            tone: "warning" as const,
            label: "No agent channel",
            detail:
              "This mailmux server was built without the chat channel. Update it to talk to an agent here.",
          }
        : presence.listening
          ? {
              tone: "success" as const,
              label: presence.lastAgent ?? "Agent listening",
              detail: presence.waiting
                ? `Waiting for your message${presence.lastAgent ? ` — ${presence.lastAgent}` : ""}.`
                : "An agent called in within the last few seconds.",
            }
          : {
              tone: "muted" as const,
              label: "No agent listening",
              detail:
                "Nothing is polling for your messages. Anything you send is queued and delivered the moment an agent starts listening.",
            };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex h-6 items-center gap-1.5 rounded-[var(--radius-full)] border border-border-subtle px-2 text-[11px] leading-4 text-fg-secondary">
          <StatusDot tone={state.tone} />
          <span className="max-w-[22ch] truncate">{state.label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{state.detail}</TooltipContent>
    </Tooltip>
  );
}
