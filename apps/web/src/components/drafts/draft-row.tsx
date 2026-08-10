"use client";

import * as React from "react";
import { AccountRail } from "@/components/atoms";
import { formatListDate, isoAttr, isoTitle } from "@/lib/format/date";
import { cn } from "@/lib/utils";
import type { MailDraft } from "@/lib/types";

/**
 * A draft row. Same geometry as a message row minus the read state, because a
 * draft has none: it was never delivered and never received.
 *
 * The leading column is the recipient rather than the sender — a draft's whole
 * identity is who it is going to, and half of them have no recipient yet.
 */
export const DraftRow = React.memo(function DraftRow({
  draft,
  selected,
  active,
  showRail,
  onSelect,
  registerRow,
}: {
  draft: MailDraft;
  selected: boolean;
  /** Holds the roving tabindex. */
  active: boolean;
  /** Only in the unified view: one mailbox means one tint, which is noise. */
  showRail: boolean;
  onSelect: (selection: { accountId: string; draftId: string }) => void;
  registerRow: (id: string, node: HTMLLIElement | null) => void;
}) {
  const { accountId, id } = draft;

  const ref = React.useCallback(
    (node: HTMLLIElement | null) => registerRow(id, node),
    [id, registerRow],
  );

  const select = React.useCallback(
    () => onSelect({ accountId, draftId: id }),
    [accountId, id, onSelect],
  );

  const to = draft.to.trim();
  const subject = draft.subject.trim();
  const preview = draft.snippet && draft.snippet !== subject ? draft.snippet : "";
  const label = `Draft. ${to || "No recipient"}. ${
    subject || "No subject"
  }. ${formatListDate(draft.date)}`;

  return (
    <li
      ref={ref}
      role="option"
      aria-selected={selected}
      aria-label={label}
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
        "grid cursor-pointer items-center gap-3 px-3 outline-offset-[-2px]",
        showRail
          ? "grid-cols-[2px_minmax(0,1fr)_auto]"
          : "grid-cols-[minmax(0,1fr)_auto]",
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
      {showRail && <AccountRail seed={accountId} className="h-full" />}

      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "truncate text-[13px] leading-[18px]",
              to ? "font-medium text-fg" : "text-fg-tertiary italic",
            )}
          >
            {to || "No recipient"}
          </span>
        </span>
        <span className="block overflow-hidden text-[13px] leading-[18px] text-ellipsis whitespace-nowrap">
          <span className={subject ? "text-fg-secondary" : "text-fg-tertiary"}>
            {subject || "No subject"}
          </span>
          {preview && <span className="text-fg-tertiary"> {preview}</span>}
        </span>
      </span>

      <time
        dateTime={isoAttr(draft.date)}
        title={isoTitle(draft.date)}
        className="tnum shrink-0 self-start text-[12px] leading-[18px] whitespace-nowrap text-fg-tertiary"
      >
        {formatListDate(draft.date)}
      </time>
    </li>
  );
});
