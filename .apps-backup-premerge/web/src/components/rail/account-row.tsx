"use client";

import { X } from "lucide-react";
import { AccountRail, StatusDot, type DotTone } from "@/components/atoms";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/api/errors";
import { useApp } from "@/lib/hooks/use-app-state";
import { initials } from "@/lib/format/address";
import { cn } from "@/lib/utils";
import type { MailAccountMeta } from "@/lib/types";

/**
 * §6.2 row 4. The status dot has exactly three states and every one is derived
 * from real data: the account is absent from the last list response's errors[],
 * present in it, or no list response has arrived yet this session. There is no
 * fourth "connecting" state, because nothing on the wire reports one.
 */
export type AccountHealth =
  | { state: "ok" }
  | { state: "failing"; error: string }
  | { state: "unchecked" };

const TONE: Record<AccountHealth["state"], DotTone> = {
  ok: "success",
  failing: "danger",
  unchecked: "muted",
};

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

  const statusWords =
    health.state === "ok"
      ? "Loaded on the last refresh"
      : health.state === "failing"
        ? friendlyError(health.error)
        : "Not checked yet";

  const rowLabel = `${account.alias} — ${account.email}. ${statusWords}`;

  if (collapsed) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={rowLabel}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(account.alias)}
              className={cn(
                "flex h-8 w-full items-center justify-center gap-1 rounded-[var(--radius-md)]",
                selected ? "bg-surface-selected" : "hover:bg-surface-hover",
              )}
            >
              <AccountRail seed={account.id} className="h-7" />
              <Monogram seed={account.email} size={24} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {account.alias} — {statusWords}
          </TooltipContent>
        </Tooltip>
      </>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-[var(--radius-md)] pr-1 pl-1",
        compact ? "h-8" : "h-10",
        selected ? "bg-surface-selected" : "hover:bg-surface-hover",
      )}
    >
      <AccountRail seed={account.id} className={compact ? "h-6" : "h-7"} />
      <button
        type="button"
        onClick={() => onSelect(account.alias)}
        aria-label={rowLabel}
        aria-current={selected ? "true" : undefined}
        title={account.email}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <Monogram seed={account.email} size={24} />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-[13px] leading-[18px] text-fg",
              selected ? "font-semibold" : "font-medium",
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

      {/* The dot is replaced by the remove control on hover / focus-within. */}
      <span className="relative flex size-5 items-center justify-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="flex size-5 items-center justify-center group-hover:hidden group-focus-within:hidden"
              title={health.state === "failing" ? health.error : undefined}
            >
              <StatusDot tone={TONE[health.state]} />
              <span className="sr-only">{statusWords}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">{statusWords}</TooltipContent>
        </Tooltip>
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

/** The rail's own monogram: neutral, like the list's. Colour is the rail's job. */
function Monogram({ seed, size }: { seed: string; size: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-border-subtle bg-surface-2 font-mono text-[11px] font-semibold text-fg-secondary"
      style={{ width: size, height: size }}
    >
      {initials(seed)}
    </span>
  );
}
