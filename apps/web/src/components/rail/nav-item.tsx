"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The one row shape shared by Inbox, Unread, Drafts, every folder and the agent
 * entries. 28px tall, one 16px icon, one 13px label, no counts and no badges.
 *
 * The active state is a background shift plus the accent, never a left bar and
 * never a shadow. There is no disabled state — a nav target that cannot be
 * navigated to is simply not drawn, except in the folder section, which
 * explains itself in prose instead.
 */
export function NavItem({
  icon: Icon,
  label,
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
        "flex h-7 w-full items-center gap-2 rounded-[var(--radius-md)] px-2 text-left",
        "transition-colors duration-[var(--dur-fast)] hover:duration-0",
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
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px] leading-[18px]",
            active && "font-medium",
          )}
        >
          {label}
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
