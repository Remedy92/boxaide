"use client";

import { BookOpen, Plug } from "lucide-react";
import { toast } from "sonner";
import { SectionLabel, Spinner } from "@/components/atoms";
import { NavItem } from "@/components/rail/nav-item";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/api/errors";
import {
  useLocalAgents,
  useStartLocalAgent,
  useStopLocalAgent,
} from "@/lib/hooks/use-local-agents";

/**
 * mailmux still cannot tell you whether an agent is CONNECTED.
 *
 * POST /mcp is stateless: it handles `initialize`, stores nothing and mints no
 * session id, so a client that has configured mailmux and gone quiet is
 * indistinguishable from one that was never started. Nothing here claims
 * otherwise: no agent count, no "connected", no activity feed.
 *
 * What became knowable is narrower and is reported elsewhere. An agent parked
 * in `chat_await_message` is holding a request open — the Agent nav row calls
 * that "listening", and only that. The conversation header also names the
 * CLI this process spawned (sidebar Start), which is a different fact: see
 * AgentChannel.presence.launchedAgent. Neither is "connected".
 */
export function AgentsSection({
  collapsed = false,
  onOpenAgentConnect,
  onOpenCapabilities,
}: {
  collapsed?: boolean;
  onOpenAgentConnect: () => void;
  onOpenCapabilities: () => void;
}) {
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Connect your agent"
            className="w-full"
            onClick={onOpenAgentConnect}
          >
            <Plug className="size-4" strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Connect your agent</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="space-y-0.5">
      <SectionLabel>Agents</SectionLabel>
      <LocalAgentList />
      <NavItem
        icon={Plug}
        label="Connect your agent"
        onClick={onOpenAgentConnect}
      />
      <NavItem
        icon={BookOpen}
        label="What this client can do"
        onClick={onOpenCapabilities}
      />
    </div>
  );
}

/**
 * Agent CLIs found on this machine, launchable in one click. The server does
 * the launching (POST /api/agents/:id/start) with read and draft tools
 * pre-approved — never message_send. Only installed CLIs appear; installed
 * ones this build cannot launch yet say so instead of hiding.
 *
 * No status dot per row. Five rows of grey dots and one green one is a legend
 * the reader has to learn; "Stop" already means running and "Start" already
 * means stopped, in words, on the control that changes it.
 */
function LocalAgentList() {
  const agents = useLocalAgents();
  const start = useStartLocalAgent();
  const stop = useStopLocalAgent();

  const rows = (agents.data?.agents ?? []).filter((a) => a.available);
  if (rows.length === 0) return null;
  const running = agents.data?.running ?? null;
  const lastExit = agents.data?.lastExit ?? null;
  const busy = start.isPending || stop.isPending;

  return (
    <div className="space-y-0.5 pb-1">
      {rows.map((agent) => {
        const isRunning = running?.id === agent.id;
        // A crash is only worth surfacing on the agent it belongs to, and
        // only until the next successful start replaces it.
        const crashed =
          !running && lastExit?.id === agent.id && lastExit.code !== 0;
        return (
          <div
            key={agent.id}
            className="flex h-7 items-center gap-2 rounded-[var(--radius-md)] px-2"
          >
            <span
              className={
                isRunning
                  ? "min-w-0 flex-1 truncate text-[13px] font-medium text-fg"
                  : agent.supported
                    ? "min-w-0 flex-1 truncate text-[13px] text-fg-secondary"
                    : "min-w-0 flex-1 truncate text-[13px] text-fg-tertiary"
              }
              title={crashed ? lastExit?.stderrTail || "exited" : undefined}
            >
              {agent.label}
              {crashed && <span className="ml-1.5 text-[11px] text-danger">exited</span>}
            </span>
            {agent.supported ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[11px] text-fg-secondary"
                disabled={busy || (running !== null && !isRunning)}
                onClick={() => {
                  if (isRunning) {
                    stop.mutate();
                    return;
                  }
                  start.mutate(agent.id, {
                    onError: (err) =>
                      toast.error(
                        friendlyError(err instanceof Error ? err.message : String(err)),
                      ),
                  });
                }}
              >
                {busy && <Spinner />}
                {isRunning ? "Stop" : "Start"}
              </Button>
            ) : (
              <span className="text-[11px] text-fg-tertiary">soon</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
