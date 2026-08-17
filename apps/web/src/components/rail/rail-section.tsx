"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A rail section that folds.
 *
 * The rail carries eight kinds of thing and only one of them is being used at
 * any moment. Folding is what keeps the chat list from pushing the mailboxes
 * off the bottom, and it is why there is one rail here and not two.
 *
 * `summary` is the rule that makes folding safe: anything the open section was
 * saying with a number — an approval count, how many chats exist — is still
 * said on the folded header. A section is never a place where a signal can
 * hide.
 *
 * The header is a real disclosure button. `aria-expanded` and a controlled
 * region id, not a div with an onClick.
 */
export function RailSection({
  id,
  label,
  open,
  onToggle,
  summary,
  action,
  children,
}: {
  id: string;
  label: string;
  open: boolean;
  onToggle: () => void;
  /** Shown on the header while folded. Keep it to a count or one short word. */
  summary?: React.ReactNode;
  /** Shown on the header while open — a "new" button, usually. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const region = `rail-section-${id}`;
  return (
    <div className="space-y-px">
      <div className="flex h-6 items-center justify-between gap-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={region}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-md)] px-1 py-0.5 text-left",
            "text-fg-tertiary transition-colors duration-[var(--dur-fast)] hover:duration-0",
            "hover:text-fg-secondary",
          )}
        >
          <ChevronRight
            aria-hidden="true"
            strokeWidth={1.5}
            className={cn(
              "size-3 shrink-0 transition-transform duration-[var(--dur-fast)] motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <span className="truncate text-[11px] leading-4 font-medium tracking-[var(--tracking-label)] uppercase">
            {label}
          </span>
        </button>
        {open ? action : summary}
      </div>
      {/* Unmounted, not hidden: a folded section must not keep rendering rows
          that fetch, poll, or measure. */}
      {open && <div id={region}>{children}</div>}
    </div>
  );
}
