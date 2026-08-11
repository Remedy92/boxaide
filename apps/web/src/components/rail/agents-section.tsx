"use client";

import { BookOpen, Plug } from "lucide-react";
import { SectionLabel } from "@/components/atoms";
import { NavItem } from "@/components/rail/nav-item";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * mailmux cannot tell you whether an agent is connected.
 *
 * POST /mcp is stateless: it handles `initialize`, stores nothing, mints no
 * session id and records no call. stdio MCP runs in a different process the
 * server cannot observe even in principle, and Store.migrate creates one table
 * — `accounts` — so there is nowhere to put an event.
 *
 * Therefore: no "Agent connected", no green agent dot, no agent count, no
 * last-seen and no activity feed. What the rail offers is a way into the
 * configuration and into the capability disclosure, and nothing that implies a
 * live connection.
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
