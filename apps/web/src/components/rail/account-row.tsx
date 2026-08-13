"use client";

import { TriangleAlert, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/api/errors";
import { useApp } from "@/lib/hooks/use-app-state";
import { cn } from "@/lib/utils";
import type { MailAccountMeta } from "@/lib/types";

/**
 * A mailbox in the sidebar.
 *
 * Health has three states and every one is derived from real data: the account
 * is absent from the last list response's errors[], present in it, or no list
 * response has arrived yet this session.
 *
 * Only ONE of the three is drawn. A mailbox that loaded is the normal case, and
 * the normal case gets no ink — a green dot beside every row is a row of green
 * dots, which is decoration that has to be read before it can be dismissed.
 * "Not checked yet" is not news either. A failure is news, and it is the only
 * thing that marks a row. The words stay in the accessible name for all three.
 */
export type AccountHealth =
  | { state: "ok" }
  | { state: "failing"; error: string }
  | { state: "unchecked" };

export function AccountRow({
  account,
  health,
  selected,
  compact,
  collapsed = false,
  onSelect,
}: {
  account: MailAccountMeta;
  health: AccountHealth;
  selected: boolean;
  compact: boolean;
  collapsed?: boolean;
  onSelect: (alias: string) => void;
}) {
  // The confirmation itself is mounted once by AppShell, so this row and the
  // command palette open the same dialog rather than two copies of it.
  const app = useApp();

  const failing = health.state === "failing";
  const statusWords =
    health.state === "ok"
      ? "Loaded on the last refresh"
      : failing
        ? friendlyError(health.error)
        : "Not checked yet";

  const rowLabel = `${account.alias} — ${account.email}. ${statusWords}`;

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={rowLabel}
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelect(account.alias)}
            className={cn(
              "flex h-7 w-full items-center justify-center rounded-[var(--radius-md)]",
              "font-mono text-[11px] font-semibold transition-colors duration-[var(--dur-fast)]",
              selected ? "bg-surface-selected text-fg" : "text-fg-tertiary hover:bg-surface-hover",
              failing && "text-warning",
            )}
          >
            {/* The rail is 52px wide here: a letter identifies the mailbox, a
                dot identifies nothing. */}
            {failing ? (
              <TriangleAlert aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
            ) : (
              account.alias.slice(0, 2).toUpperCase()
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {account.alias} — {statusWords}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-[var(--radius-md)] pr-1 pl-2",
        "transition-colors duration-[var(--dur-fast)]",
        compact ? "h-7" : "h-9",
        selected ? "bg-surface-selected" : "hover:bg-surface-hover",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(account.alias)}
        aria-label={rowLabel}
        aria-current={selected ? "true" : undefined}
        title={account.email}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-[13px] leading-[18px]",
              selected ? "font-medium text-fg" : "text-fg-secondary",
            )}
          >
            {account.alias}
          </span>
          {!compact && (
            <span className="block truncate font-mono text-[11px] leading-4 text-fg-tertiary">
              {account.email}
            </span>
          )}
        </span>
      </button>

      {/* Empty unless the mailbox failed. The remove control takes the slot on
          hover / focus-within either way. */}
      <span className="relative flex size-5 items-center justify-center">
        {failing && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Warning, not danger, and the footer's partial-load row is the
                  reason: one mailbox that did not answer the last refresh is
                  the same event in both places, and it read red here and amber
                  there. Nothing is broken — the other mailboxes loaded. */}
              <span
                className="flex size-5 items-center justify-center text-warning group-hover:hidden group-focus-within:hidden"
                title={health.error}
              >
                <TriangleAlert aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
                <span className="sr-only">{statusWords}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">{statusWords}</TooltipContent>
          </Tooltip>
        )}
        <button
          type="button"
          aria-label={`Remove ${account.alias}`}
          onClick={() => app.requestRemoveAccount(account)}
          className="absolute hidden size-5 items-center justify-center rounded-[var(--radius-sm)] text-fg-tertiary hover:bg-surface-hover hover:text-fg group-focus-within:flex group-hover:flex"
        >
          <X aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
        </button>
      </span>
    </div>
  );
}
