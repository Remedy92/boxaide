"use client";

import { BookOpen, Plug } from "lucide-react";
import { SectionLabel } from "@/components/atoms";
import { NavItem } from "@/components/rail/nav-item";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * mailmux still cannot tell you whether an agent is CONNECTED.
 *
 * POST /mcp is stateless: it handles `initialize`, stores nothing and mints no
 * session id, so a client that has configured mailmux and gone quiet is
 * indistinguishable from one that was never started. Nothing here claims
 * otherwise: no agent count, no "connected", no activity feed.
 *
 * What became knowable is narrower and is reported elsewhere. An agent parked
 * in `chat_await_message` is holding a request open, and that request is a
 * fact — the Agent nav row and the conversation header call that "listening",
 * and only that. See AgentChannel.presence and AgentPresenceBadge; the wording
 * in both is deliberate and should not be widened to "connected".
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
