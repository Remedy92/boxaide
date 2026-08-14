"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AgentConnection } from "@/lib/hooks/use-agent";
import type { AgentPresence as Presence } from "@/lib/types";

/**
 * Who the conversation header names.
 *
 * Two facts, never a guess that someone is "connected":
 *   - launchedAgent: Boxaide spawned this CLI (sidebar Start).
 *   - listening / lastAgent: an MCP client is parked in chat_await_message,
 *     or called it within the presence window. lastAgent is that client's
 *     initialize name.
 *
 * A launched agent wins the label. Start next to Grok says Grok even if
 * Claude Code is still parked from an earlier session.
 */
export function AgentPresenceBadge({
  presence,
  connection,
}: {
  presence: Presence;
  connection: AgentConnection;
}) {
  const name = presenceDisplayName(presence);
  const state =
    connection === "offline"
      ? {
          label: "Unreachable",
          className: "text-danger",
          detail: "Boxaide is not answering. Reconnecting.",
        }
      : connection === "unsupported"
        ? {
            label: "No channel",
            className: "text-warning",
            detail:
              "This Boxaide server was built without the chat channel. Update it to talk to an agent here.",
          }
        : name
          ? {
              label: name,
              className: "font-medium text-fg-secondary",
              detail: presence.waiting
                ? name === "Listening"
                  ? "Waiting for your message."
                  : `Waiting for your message — ${name}.`
                : presence.launchedAgent && !presence.listening
                  ? `${name} is running.`
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

/**
 * Header / tray label. The spawned CLI wins; else the last MCP client,
 * and only while that client is actually listening.
 */
export function presenceDisplayName(presence: Presence): string | null {
  if (presence.launchedAgent) return displayAgentName(presence.launchedAgent);
  if (!presence.listening) return null;
  return presence.lastAgent ? displayAgentName(presence.lastAgent) : "Listening";
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
