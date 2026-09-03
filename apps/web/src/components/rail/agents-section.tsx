"use client";

import { BookOpen, Plug } from "lucide-react";
import { toast } from "sonner";
import { SectionLabel, Spinner, StatusDot } from "@/components/atoms";
import { AgentSignIn } from "@/components/agent/agent-sign-in";
import { displayAgentName } from "@/components/agent/agent-presence";
import { agentExitedBadly, agentSignedOut } from "@/components/rail/agent-exit";
import { NavItem } from "@/components/rail/nav-item";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/api/errors";
import { useLocalAgents, useStopLocalAgent } from "@/lib/hooks/use-local-agents";

/**
 * Boxaide still cannot tell you whether an agent is CONNECTED.
 *
 * POST /mcp is stateless: it handles `initialize`, stores nothing and mints no
 * session id, so a client that has configured Boxaide and gone quiet is
 * indistinguishable from one that was never started. Nothing here claims
 * otherwise: no agent count, no "connected", no activity feed.
 *
 * What became knowable is narrower and is reported elsewhere. An agent parked
 * in `chat_await_message` is holding a request open. The Agent nav row calls
 * that "listening", and only that. The conversation header also names the
 * CLI this process spawned (picked in the composer), which is a different
 * fact: see AgentChannel.presence.launchedAgent. Neither is "connected".
 */
export function AgentsSection({
  collapsed = false,
  hideLabel = false,
  onOpenAgentConnect,
  onOpenCapabilities,
}: {
  collapsed?: boolean;
  /** Set when the rail wraps this in a folding section that has its own label. */
  hideLabel?: boolean;
  onOpenAgentConnect: () => void;
  onOpenCapabilities: () => void;
}) {
  if (collapsed) {
    return <CollapsedAgentButton onOpenAgentConnect={onOpenAgentConnect} />;
  }

  return (
    <div className="space-y-0.5">
      {!hideLabel && <SectionLabel>Agents</SectionLabel>}
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
 * The icon rail has no room for a row, so a running agent becomes a dot on the
 * control that opens the views popover. The number itself is one click away.
 */
function CollapsedAgentButton({
  onOpenAgentConnect,
}: {
  onOpenAgentConnect: () => void;
}) {
  const agents = useLocalAgents();
  const running = agents.data?.running ?? null;
  const label = running
    ? `Agent running: ${agents.data?.agents.find((a) => a.id === running.id)?.label ?? displayAgentName(running.id)}`
    : "Connect your agent";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          className="relative w-full"
          onClick={onOpenAgentConnect}
        >
          <Plug className="size-4" strokeWidth={1.5} />
          {running && (
            <StatusDot tone="accent" className="absolute top-1.5 right-1.5" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The running agent, shown directly under the top Agent row so stopping it
 * never requires opening the Agents section. The section below keeps only
 * setup and the agents that exited badly; this is the one live control.
 */
export function RunningAgentRow() {
  const agents = useLocalAgents();
  const stop = useStopLocalAgent();
  const running = agents.data?.running ?? null;
  if (!running) return null;
  const label =
    agents.data?.agents.find((a) => a.id === running.id)?.label ??
    displayAgentName(running.id);
  const busy = stop.isPending;

  return (
    <div className="flex h-7 items-center gap-2 rounded-[var(--radius-md)] py-0 pr-1 pl-8">
      <StatusDot tone="accent" />
      <span
        className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg"
        title={`Running${running.model ? ` on ${running.model}` : ""}`}
      >
        {label}
      </span>
      {/* Confinement is not a choice offered here any more. It is on. This is
          the exception: the machine could not apply it, or the install turned
          it off, and either way the reason is worth a line rather than a
          silence. */}
      {running.accessNotice && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-[11px] text-warning">full access</span>
          </TooltipTrigger>
          <TooltipContent>{running.accessNotice}</TooltipContent>
        </Tooltip>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-5 px-1.5 text-[11px] text-fg-secondary"
        disabled={busy}
        onClick={() =>
          stop.mutate(undefined, {
            onError: (err) =>
              toast.error(
                friendlyError(err instanceof Error ? err.message : String(err)),
              ),
          })
        }
      >
        {busy && <Spinner />}
        Stop
      </Button>
    </div>
  );
}

/**
 * Only the agents that just died. The running one lives under the top Agent
 * row now, next to the conversation it answers; a rail listing it twice would
 * be a second Stop for the same process, and the two disagreed about nothing.
 *
 * Choosing an agent happens in the composer, next to the question it will
 * answer. A rail listing every installed CLI with a Start button was a second
 * place to make the same choice, and the two disagreed.
 *
 * No status dot per row. A row is here because it exited; "signed out" says
 * why, on the control that fixes it.
 */
function LocalAgentList() {
  const agents = useLocalAgents();
  const running = agents.data?.running ?? null;
  const lastExit = agents.data?.lastExit ?? null;
  const rows = (agents.data?.agents ?? []).filter(
    (a) => a.installed && agentExitedBadly(a.id, { running, lastExit }),
  );
  if (rows.length === 0) return null;

  return (
    <div className="space-y-0.5 pb-1">
      {rows.map((agent) => {
        const crashed = agentExitedBadly(agent.id, { running, lastExit });
        // A signed-out CLI is a crash with a known cause and a one-click fix,
        // so it says the cause instead of "exited" and offers the fix.
        const signedOut = agentSignedOut(agent.id, { running, lastExit });
        return (
          <div
            key={agent.id}
            className="flex h-7 items-center gap-2 rounded-[var(--radius-md)] px-2"
          >
            <span
              className="min-w-0 flex-1 truncate text-[13px] text-fg-secondary"
              title={
                signedOut
                  ? "This CLI is signed out."
                  : crashed
                    ? lastExit?.stderrTail || "exited"
                    : undefined
              }
            >
              {agent.label}
              {crashed && (
                <span className="ml-1.5 text-[11px] text-danger">
                  {signedOut ? "signed out" : "exited"}
                </span>
              )}
            </span>
            {signedOut && <AgentSignIn agentId={agent.id} compact />}
          </div>
        );
      })}
    </div>
  );
}
