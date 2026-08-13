"use client";

import { Rows2, Rows3, Settings2, TriangleAlert } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConnectionState } from "@/lib/hooks/use-connection";
import type { Density } from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * §6.2 row 7 and §7.5–7.6. The footer states one thing: whether something is
 * wrong with the connection to the server.
 *
 * It used to state the opposite too — a green dot, `127.0.0.1:8787` and the
 * word "Connected", permanently. None of that was news. The address is the one
 * the user typed into settings and can read there; "Connected" is the condition
 * under which every other pixel on screen already has mail in it. A working
 * connection is now silent, and the row appears only when it stops working, or
 * when some of the mailboxes did not answer.
 *
 * `tone` and `label` are still returned for a failure so callers (and tests)
 * have one place that decides precedence.
 */
export type FooterAlert = {
  tone: "warning" | "danger";
  label: string;
  detail: string;
};

export function railFooterAlert(
  connection: ConnectionState,
  partial: { loaded: number; total: number } | null,
): FooterAlert | null {
  switch (connection.kind) {
    case "no-base-url":
      return {
        tone: "warning",
        label: "No server set",
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
          label: `${partial.total - partial.loaded} mailbox${
            partial.total - partial.loaded === 1 ? "" : "es"
          } did not load`,
          detail: "Some mailboxes did not answer on the last refresh.",
        };
      }
      return null;
  }
}

export function RailFooter({
  connection,
  partial,
  density,
  collapsed = false,
  gPending,
  onOpenSettings,
  onToggleDensity,
}: {
  connection: ConnectionState;
  partial: { loaded: number; total: number } | null;
  density: Density;
  collapsed?: boolean;
  gPending: boolean;
  onOpenSettings: () => void;
  onToggleDensity: () => void;
}) {
  const alert = railFooterAlert(connection, partial);
  const DensityIcon = density === "compact" ? Rows2 : Rows3;
  const densityLabel =
    density === "compact"
      ? "Density: compact. Switch to comfortable."
      : "Density: comfortable. Switch to compact.";

  const alertButton = alert && (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${alert.label}. ${alert.detail} Open settings.`}
          onClick={onOpenSettings}
          className={cn(
            "flex items-center gap-2 rounded-[var(--radius-md)] hover:bg-surface-hover",
            alert.tone === "danger" ? "text-danger" : "text-warning",
            collapsed ? "size-7 justify-center" : "w-full px-1.5 py-1 text-left",
          )}
        >
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.5} />
          {!collapsed && (
            <span className="truncate text-[12px] leading-4">{alert.label}</span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side={collapsed ? "right" : "top"}>{alert.detail}</TooltipContent>
    </Tooltip>
  );

  return (
    <div className="border-t border-border-subtle p-3">
      {collapsed ? (
        <div className="flex flex-col items-center gap-1">
          {alertButton}
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
          {alertButton && <div className="mb-1">{alertButton}</div>}
          <div className="flex items-center gap-1">
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
