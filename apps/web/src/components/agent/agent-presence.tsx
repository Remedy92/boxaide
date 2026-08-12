"use client";

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
 * Shown as a byline, not a status light. A pill and a dot both say "dashboard
 * widget"; the name of whoever is in the loop is the fact. Idle is absence, not
 * a grey LED — same rule as the Agent nav row.
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
          label: "Unreachable",
          className: "text-danger",
          detail: "mailmux is not answering. Reconnecting.",
        }
      : connection === "unsupported"
        ? {
            label: "No channel",
            className: "text-warning",
            detail:
              "This mailmux server was built without the chat channel. Update it to talk to an agent here.",
          }
        : presence.listening
          ? {
              label: presence.lastAgent
                ? displayAgentName(presence.lastAgent)
                : "Listening",
              className: "font-medium text-fg-secondary",
              detail: presence.waiting
                ? `Waiting for your message${presence.lastAgent ? ` — ${displayAgentName(presence.lastAgent)}` : ""}.`
                : "An agent called in within the last few seconds.",
            }
          : null;

  if (!state) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`max-w-[22ch] truncate text-[11px] leading-4 ${state.className}`}
        >
          {state.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{state.detail}</TooltipContent>
    </Tooltip>
  );
}

/** MCP clientInfo.name is often a slug. The header should read as a name. */
export function displayAgentName(name: string): string {
  const known: Record<string, string> = {
    "claude-code": "Claude Code",
    "claude-ai": "Claude",
    "claude-desktop": "Claude Desktop",
    grok: "Grok",
    cursor: "Cursor",
    codex: "Codex",
  };
  const mapped = known[name.toLowerCase()];
  if (mapped) return mapped;
  if (/[A-Z]/.test(name.slice(1)) || name.includes(" ")) return name;
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
