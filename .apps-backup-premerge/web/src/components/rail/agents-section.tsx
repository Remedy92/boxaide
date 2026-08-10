"use client";

import * as React from "react";
import { BookOpen, Check, Copy, Plug } from "lucide-react";
import { toast } from "sonner";
import {
  SectionLabel,
  Spinner,
  StatusDot,
  TechnicalDetails,
} from "@/components/atoms";
import { NavItem } from "@/components/rail/nav-item";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/api/errors";
import { useMcpTools } from "@/lib/hooks/use-mcp-tools";
import { useSettings } from "@/lib/hooks/use-settings";
import { hostLabel } from "@/lib/settings";
import { copyToClipboard } from "@/lib/utils";

/**
 * §8. mailmux cannot tell you whether an agent is connected.
 *
 * POST /mcp is stateless: it handles `initialize`, stores nothing, mints no
 * session id and records no call. stdio MCP runs in a different process the
 * server cannot observe even in principle, and Store.migrate creates one table
 * — `accounts` — so there is nowhere to put an event.
 *
 * Therefore: no "Agent connected", no green agent dot, no agent count, no
 * last-seen and no activity feed. What is left is configuration, a
 * user-triggered reachability test, and an honest capability disclosure.
 */
export function AgentsSection({
  collapsed = false,
  onOpenCapabilities,
}: {
  collapsed?: boolean;
  onOpenCapabilities: () => void;
}) {
  const settings = useSettings();
  const test = useMcpTools();
  const [copied, setCopied] = React.useState(false);
  const endpoint = `${settings.baseUrl}/mcp`;
  const label = `${hostLabel(settings.baseUrl)}/mcp`;
  // The rail unmounts this on collapse, well inside the 1200ms window.
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copyEndpoint = async () => {
    const ok = await copyToClipboard(endpoint);
    if (!ok) {
      toast.warning("Press ⌘C to copy", {
        description: "This browser blocked clipboard access.",
      });
      return;
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
    toast.success("Copied MCP endpoint");
  };

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="What this client can do"
            onClick={onOpenCapabilities}
          >
            <Plug className="size-4" strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">What this client can do</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="space-y-1">
      <SectionLabel>Agents</SectionLabel>

      {/* Row 1 — configuration, stated as configuration. The leading indicator
          is a static icon, not a status dot: this row says an endpoint exists,
          not that anything is using it. */}
      <div className="flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1">
        <Plug
          aria-hidden="true"
          className="size-4 shrink-0 text-fg-tertiary"
          strokeWidth={1.5}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-[18px] text-fg">
            MCP endpoint ready
          </span>
          <span
            className="block truncate font-mono text-[11px] leading-4 text-fg-tertiary"
            title={endpoint}
          >
            {label}
          </span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Copy the MCP endpoint URL"
          onClick={() => void copyEndpoint()}
        >
          {copied ? (
            <Check className="size-3.5 text-success" strokeWidth={1.5} />
          ) : (
            <Copy className="size-3.5" strokeWidth={1.5} />
          )}
        </Button>
      </div>

      {/* Row 2 — user-triggered only, never on load. */}
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        aria-busy={test.isPending || undefined}
        disabled={test.isPending}
        onClick={() => test.mutate()}
      >
        {test.isPending && <Spinner />}
        {test.isPending ? "Testing…" : "Test MCP endpoint"}
      </Button>

      {/* Mounted whether or not a test has run: focus stays on the button, so
          this is the only thing that can report the outcome. */}
      <div role="status" aria-live="polite">
      {test.isSuccess && (
        <details className="px-1">
          <summary className="flex cursor-pointer items-center gap-1.5 py-1 text-[12px] text-fg-secondary">
            <StatusDot tone="success" />
            Responded — {test.data.length} tools available
          </summary>
          <ul className="mt-1 space-y-0.5 pl-3">
            {test.data.map((tool) => (
              <li key={tool.name} className="font-mono text-[12px] text-fg-tertiary">
                {tool.name}
              </li>
            ))}
          </ul>
        </details>
      )}

      {test.isError && (
        <div className="px-1 py-1">
          <p className="flex items-center gap-1.5 text-[12px] text-danger">
            <StatusDot tone="danger" />
            Did not respond
          </p>
          <p className="mt-0.5 text-[12px] leading-4 text-fg-secondary">
            {friendlyError(
              test.error instanceof Error ? test.error.message : test.error,
            )}
          </p>
          <TechnicalDetails
            raw={test.error instanceof Error ? test.error.message : test.error}
          />
        </div>
      )}
      </div>

      {/* Row 3 — the capability disclosure. */}
      <NavItem
        icon={BookOpen}
        label="What this client can do"
        onClick={onOpenCapabilities}
      />
    </div>
  );
}
