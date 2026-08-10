"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * §6.2. The one row shape shared by Unified inbox, Unread, every folder and the
 * Agents entries. 32px tall, 16px icon, 13px label. There is no disabled state
 * on a nav item — a nav target that cannot be navigated to is simply not drawn,
 * except for the folder section, which explains itself in prose instead.
 */
export function NavItem({
  icon: Icon,
  label,
  sublabel,
  active = false,
  onClick,
  title,
  ariaLabel,
  trailing,
  collapsed = false,
  disabled = false,
  disabledReason,
}: {
  icon: LucideIcon;
  label: string;
  sublabel?: string;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  ariaLabel?: string;
  trailing?: React.ReactNode;
  collapsed?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const button = (
    <button
      type="button"
      title={title ?? (collapsed ? label : undefined)}
      aria-label={ariaLabel ?? (collapsed ? label : undefined)}
      aria-current={active ? "true" : undefined}
      aria-disabled={disabled ? "true" : undefined}
      onClick={disabled ? undefined : onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 text-left",
        "transition-colors duration-[var(--dur-fast)] hover:duration-0",
        sublabel && !collapsed ? "min-h-9 py-1" : "h-8",
        collapsed && "justify-center px-0",
        disabled
          ? "cursor-not-allowed text-fg-disabled"
          : active
            ? "bg-accent-subtle text-accent"
            : "text-fg-secondary hover:bg-surface-hover hover:text-fg",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0",
          disabled
            ? "text-fg-disabled"
            : active
              ? "text-accent"
              : "text-fg-tertiary",
        )}
        strokeWidth={1.5}
      />
      {!collapsed && (
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-[13px] leading-[18px]",
              active && "font-medium",
            )}
          >
            {label}
          </span>
          {sublabel && (
            <span className="block truncate font-mono text-[11px] leading-4 text-fg-tertiary">
              {sublabel}
            </span>
          )}
        </span>
      )}
      {!collapsed && trailing}
    </button>
  );

  const tip = disabled ? disabledReason : collapsed ? label : undefined;
  if (!tip) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{tip}</TooltipContent>
    </Tooltip>
  );
}
