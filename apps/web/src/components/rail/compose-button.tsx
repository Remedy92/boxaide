"use client";

import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * §6.2 row 2. Disabled when there are no accounts — `POST /api/messages/send`
 * needs an `account`, and the server forces `from` to that account's address,
 * so a composer with nothing to send from cannot succeed.
 *
 * aria-disabled rather than `disabled`, because `disabled` suppresses the
 * pointer events the tooltip needs to explain why.
 */
export function ComposeButton({
  disabled,
  collapsed = false,
  onClick,
}: {
  disabled: boolean;
  collapsed?: boolean;
  onClick: () => void;
}) {
  /* Secondary, not the accent fill. A full-width saturated block at the top of
     the sidebar would be the loudest thing on screen, and the accent is spent
     on selection, focus and the unread dot — the states that carry meaning. */
  const button = (
    <Button
      type="button"
      variant="secondary"
      size={collapsed ? "icon" : "default"}
      aria-disabled={disabled || undefined}
      aria-label={collapsed ? "Compose" : undefined}
      onClick={disabled ? undefined : onClick}
      className={collapsed ? "" : "w-full justify-start bg-surface-2 font-medium"}
    >
      <PenLine
        aria-hidden="true"
        className="size-4 text-fg-tertiary"
        strokeWidth={1.5}
      />
      {!collapsed && "Compose"}
    </Button>
  );

  if (!disabled && !collapsed) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={collapsed ? "" : "block w-full"}>{button}</span>
      </TooltipTrigger>
      <TooltipContent side="right">
        {disabled ? "Connect a mailbox first" : "Compose"}
      </TooltipContent>
    </Tooltip>
  );
}
