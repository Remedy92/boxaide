"use client";

import { Rows2, Rows3, Settings2 } from "lucide-react";
import { StatusDot, type DotTone } from "@/components/atoms";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConnectionState } from "@/lib/hooks/use-connection";
import type { Density } from "@/lib/settings";
import { hostLabel } from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * §6.2 row 7 and §7.5–7.6. The footer states one thing precisely: whether this
 * browser can talk to the server, and — once a listing has come back — how many
 * mailboxes answered. Per-account health from `errors[]` is the only live
 * signal the product has, and it is the one doing the work here.
 */
export function railFooterState(
  connection: ConnectionState,
  partial: { loaded: number; total: number } | null,
): { tone: DotTone; label: string; detail: string } {
  switch (connection.kind) {
    case "no-base-url":
      return {
        tone: "muted",
        label: "Not configured",
        detail: "No server URL is set.",
      };
    case "unreachable":
      return {
        tone: "danger",
        label: "Offline",
        detail: `Cannot reach ${connection.host}.`,
      };
    case "blocked":
      return {
        tone: "danger",
        label: "Blocked",
        detail: "The browser or the server refused this page's origin.",
      };
    case "no-token":
      return {
        tone: "danger",
        label: "Not signed in",
        detail: "No access token is set.",
      };
    case "unauthorized":
      return {
        tone: "danger",
        label: "Not signed in",
        detail: "The server rejected this token.",
      };
    case "ok":
      if (partial && partial.loaded < partial.total) {
        return {
          tone: "warning",
          label: `${partial.loaded}/${partial.total} mailboxes`,
          detail: "Some mailboxes did not load on the last refresh.",
        };
      }
      return {
        tone: "success",
        label: "Connected",
        detail: connection.version
          ? `mailmux ${connection.version}`
          : "Server reachable.",
      };
  }
}

export function RailFooter({
  connection,
  partial,
  baseUrl,
  density,
  collapsed = false,
  gPending,
  onOpenSettings,
  onToggleDensity,
}: {
  connection: ConnectionState;
  partial: { loaded: number; total: number } | null;
  baseUrl: string;
  density: Density;
  collapsed?: boolean;
  gPending: boolean;
  onOpenSettings: () => void;
  onToggleDensity: () => void;
}) {
  const state = railFooterState(connection, partial);
  const host = baseUrl ? hostLabel(baseUrl) : "no server set";
  const connectionLabel = `Connection: ${state.label}. ${state.detail} Open settings.`;
  const DensityIcon = density === "compact" ? Rows2 : Rows3;
  const densityLabel =
    density === "compact"
      ? "Density: compact. Switch to comfortable."
      : "Density: comfortable. Switch to compact.";

  return (
    <div className="border-t border-border-subtle p-3">
      {collapsed ? (
        <div className="flex flex-col items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={connectionLabel}
                onClick={onOpenSettings}
                className="flex size-7 items-center justify-center rounded-[var(--radius-md)] hover:bg-surface-hover"
              >
                <StatusDot tone={state.tone} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {state.label} — {host}
            </TooltipContent>
          </Tooltip>
          <FooterIcons
            densityIcon={<DensityIcon className="size-4" strokeWidth={1.5} />}
            densityLabel={densityLabel}
            onOpenSettings={onOpenSettings}
            onToggleDensity={onToggleDensity}
            stacked
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            aria-label={connectionLabel}
            title={state.detail}
            onClick={onOpenSettings}
            className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-1 py-1 text-left hover:bg-surface-hover"
          >
            <StatusDot tone={state.tone} />
            <span className="truncate font-mono text-[11px] leading-4 text-fg-tertiary">
              {host}
            </span>
            <span className="ml-auto shrink-0 text-[11px] leading-4 text-fg-tertiary">
              {state.label}
            </span>
          </button>

          <div className="mt-1 flex items-center gap-1">
            {/* The text node is rendered conditionally, not hidden with
                opacity: aria-live fires on content mutation, never on a style
                change, so an always-present "g…" announced nothing at all. */}
            <span
              aria-live="polite"
              className={cn(
                "font-mono text-[11px] text-fg-tertiary transition-opacity",
                gPending ? "opacity-100" : "opacity-0",
              )}
            >
              {gPending ? "g…" : ""}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <FooterIcons
                densityIcon={<DensityIcon className="size-4" strokeWidth={1.5} />}
                densityLabel={densityLabel}
                onOpenSettings={onOpenSettings}
                onToggleDensity={onToggleDensity}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FooterIcons({
  densityIcon,
  densityLabel,
  onOpenSettings,
  onToggleDensity,
  stacked = false,
}: {
  densityIcon: React.ReactNode;
  densityLabel: string;
  onOpenSettings: () => void;
  onToggleDensity: () => void;
  stacked?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-1", stacked && "flex-col")}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Open settings"
            onClick={onOpenSettings}
            className="text-fg-tertiary hover:text-fg-secondary"
          >
            <Settings2 className="size-4" strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Settings</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={densityLabel}
            onClick={onToggleDensity}
            className="text-fg-tertiary hover:text-fg-secondary"
          >
            {densityIcon}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Row density</TooltipContent>
      </Tooltip>

      <ThemeToggle />
    </div>
  );
}
