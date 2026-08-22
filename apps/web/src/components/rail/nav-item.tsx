"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The one row shape shared by Inbox, Unread, Drafts, every folder and the agent
 * entries. 28px tall, one 16px icon, one 13px label.
 *
 * The active state is a background shift plus the accent, never a left bar and
 * never a shadow.
 *
 * A row can carry a trailing slot, used by Automations, by Outreach and by a
 * folder's unread count, and it has a disabled state, used by Compose while no
 * mailbox is connected. Neither is decoration: both say something the label
 * cannot.
 *
 * A folder row is also a drop target for a message being filed, which is why
 * the drag handlers land on the button itself rather than on a wrapper: the
 * tooltip path below renders the button through TooltipTrigger asChild, and a
 * wrapper would keep the handlers off the element the pointer is actually over.
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
  depth,
  drop,
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
  /**
   * How deep in the folder tree the row sits. The indent is inline padding on
   * the button and not a padded wrapper, because the hover and active
   * backgrounds live on the button: wrapping it would tear them away from the
   * rail edge and leave a stripe of untinted background beside every row.
   * Capped, so a deep Courier tree cannot squeeze the label out of the rail.
   */
  depth?: number;
  /**
   * Drop handling for a folder row. `state` paints it: "over" is the accepting
   * row under the pointer, "invalid" is a row this drag can never land on and
   * says so before it is hovered.
   */
  drop?: {
    onDragEnter: (event: React.DragEvent<HTMLButtonElement>) => void;
    onDragOver: (event: React.DragEvent<HTMLButtonElement>) => void;
    onDragLeave: (event: React.DragEvent<HTMLButtonElement>) => void;
    onDrop: (event: React.DragEvent<HTMLButtonElement>) => void;
    state: "idle" | "over" | "invalid";
  };
}) {
  const dimmed = disabled || drop?.state === "invalid";

  const button = (
    <button
      type="button"
      title={title ?? (collapsed ? label : undefined)}
      aria-label={ariaLabel ?? (collapsed ? label : undefined)}
      aria-current={active ? "true" : undefined}
      aria-disabled={disabled ? "true" : undefined}
      onClick={disabled ? undefined : onClick}
      onDragEnter={drop?.onDragEnter}
      onDragOver={drop?.onDragOver}
      onDragLeave={drop?.onDragLeave}
      onDrop={drop?.onDrop}
      style={
        // The collapsed row is centred with no horizontal padding at all, so an
        // indent there would push a 16px icon off its own centre line.
        depth !== undefined && !collapsed
          ? { paddingLeft: 8 + 12 * Math.min(depth, 4) }
          : undefined
      }
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-[var(--radius-md)] px-2 text-left",
        "transition-colors duration-[var(--dur-fast)] hover:duration-0",
        collapsed && "justify-center px-0",
        drop?.state === "over" && "ring-2 ring-accent ring-inset",
        dimmed
          ? cn("text-fg-disabled", disabled && "cursor-not-allowed")
          : active
            ? "bg-accent-subtle text-accent"
            : "text-fg-secondary hover:bg-surface-hover hover:text-fg",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0",
          dimmed
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
