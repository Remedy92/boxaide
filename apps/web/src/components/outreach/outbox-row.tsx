"use client";

import * as React from "react";
import { formatListDate } from "@/lib/format/date";
import { cn } from "@/lib/utils";
import type { OutboxRow as OutboxRowType } from "@/lib/types";

/**
 * One queued email in the approval queue. Same anatomy as MessageRow and
 * ContactRow — two lines, one ellipsizing element each, no avatar — because it
 * sits in the same column at the same width.
 *
 * Line one is the recipient, line two the subject: the queue is answering "who
 * is about to be written to", and the full text is one click away in the pane.
 * Subject and body arrive decrypted and are drawn as text, never as markup.
 */
export const OutboxQueueRow = React.memo(function OutboxQueueRow({
  row,
  selected,
  active,
  onSelect,
  registerRow,
}: {
  row: OutboxRowType;
  selected: boolean;
  /** Holds the roving tabindex. */
  active: boolean;
  onSelect: (outboxId: string) => void;
  registerRow: (id: string, node: HTMLLIElement | null) => void;
}) {
  const { id } = row;

  const ref = React.useCallback(
    (node: HTMLLIElement | null) => registerRow(id, node),
    [id, registerRow],
  );
  const select = React.useCallback(() => onSelect(id), [id, onSelect]);

  return (
    <li
      ref={ref}
      role="option"
      aria-selected={selected}
      aria-label={`To ${row.to}. ${row.subject}`}
      tabIndex={active ? 0 : -1}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        select();
      }}
      className={cn(
        "cursor-pointer px-3 outline-offset-[-2px]",
        "transition-colors duration-[var(--dur-fast)] hover:duration-0",
        selected
          ? "bg-surface-selected"
          : "hover:bg-surface-hover active:bg-surface-selected",
      )}
      style={{
        minHeight: "var(--row-h)",
        paddingTop: "var(--row-pad-y)",
        paddingBottom: "var(--row-pad-y)",
      }}
    >
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] font-medium text-fg">
          {row.to}
        </span>
        <span className="shrink-0 text-[11px] leading-4 text-fg-tertiary">
          {formatListDate(row.createdAt)}
        </span>
      </span>
      <span
        className="block truncate leading-[18px] text-fg-secondary"
        style={{ fontSize: "var(--font-list)" }}
      >
        {row.subject}
      </span>
    </li>
  );
});
