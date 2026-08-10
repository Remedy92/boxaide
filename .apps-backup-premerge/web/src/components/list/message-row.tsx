"use client";

import * as React from "react";
import { Paperclip } from "lucide-react";
import { AccountRail } from "@/components/atoms";
import { Monogram } from "@/components/list/monogram";
import { displayName } from "@/lib/format/address";
import { formatListDate, isoAttr, isoTitle } from "@/lib/format/date";
import { cn } from "@/lib/utils";
import type { MailMessageSummary } from "@/lib/types";

/**
 * §6.3 row anatomy. Read vs unread is carried by three redundant signals — the
 * dot, the weight, and the rail's opacity — and never by a background change,
 * which is what keeps selection unambiguous without a fourth colour.
 *
 * Exactly one element per line may ellipsize, or the row jitters as widths
 * change. Nothing here scales or lifts on hover: transform on a list row blurs
 * the text mid-transition.
 */
export const MessageRow = React.memo(function MessageRow({
  message,
  selected,
  active,
  compact,
  onSelect,
  onPrefetch,
  registerRow,
}: {
  message: MailMessageSummary;
  selected: boolean;
  /** Holds the roving tabindex. */
  active: boolean;
  compact: boolean;
  /* All three are stable across parent renders — the row closes over its own
     id rather than receiving a freshly built closure, which is what lets
     React.memo above actually bail out. */
  onSelect: (selection: { accountId: string; messageId: string }) => void;
  onPrefetch: (accountId: string, messageId: string) => void;
  registerRow: (id: string, node: HTMLLIElement | null) => void;
}) {
  const { accountId, id } = message;

  const ref = React.useCallback(
    (node: HTMLLIElement | null) => registerRow(id, node),
    [id, registerRow],
  );

  const select = React.useCallback(
    () => onSelect({ accountId, messageId: id }),
    [accountId, id, onSelect],
  );

  /* 65ms of hover before prefetching, per row rather than per list, so moving
     across rows cancels cleanly and unmounting cannot leave a timer behind. */
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHover = React.useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }, []);
  React.useEffect(() => cancelHover, [cancelHover]);

  const startHover = React.useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => onPrefetch(accountId, id), 65);
  }, [accountId, id, onPrefetch]);

  const sender = displayName(message.from);
  const showSnippet = message.snippet && message.snippet !== message.subject;
  const label = `${message.seen ? "Read" : "Unread"}. ${sender}. ${
    message.subject
  }. ${formatListDate(message.date)}${
    message.hasAttachments ? ". Has attachments" : ""
  }`;

  return (
    // Enter and Space are handled here, not by the global map. The global
    // `open` handler acts on the *selected* message and falls back to index 0,
    // which is not necessarily the row holding the roving tabindex — and it is
    // suspended entirely while any dialog is open. A row that can be reached by
    // Tab must be operable from the keyboard on its own (2.1.1).
    <li
      ref={ref}
      role="option"
      aria-selected={selected}
      aria-label={label}
      tabIndex={active ? 0 : -1}
      data-message-id={message.id}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        select();
      }}
      onMouseEnter={startHover}
      onMouseLeave={cancelHover}
      className={cn(
        "grid cursor-pointer items-center gap-2.5 px-3 outline-offset-[-2px]",
        "grid-cols-[3px_28px_minmax(0,1fr)_auto]",
        "transition-colors duration-[var(--dur-fast)] hover:duration-0",
        selected
          ? "bg-surface-selected"
          : "hover:bg-surface-hover active:bg-surface-selected",
      )}
      style={{
        // min-height, not height: under browser text-only zoom the two lines
        // outgrow a fixed 72px box and overlap the next row (1.4.4).
        minHeight: "var(--row-h)",
        paddingTop: "var(--row-pad-y)",
        paddingBottom: "var(--row-pad-y)",
      }}
    >
      <AccountRail
        seed={message.accountId}
        dim={message.seen && !selected}
        className="h-full"
      />

      <span className="flex h-full flex-col items-center justify-center gap-1">
        {!message.seen && (
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-[var(--radius-full)] bg-accent"
          />
        )}
        {!compact && <Monogram from={message.from} size={24} />}
      </span>

      <span className="min-w-0">
        <span
          className={cn(
            "block max-w-[40%] truncate text-[13px] leading-[18px]",
            message.seen ? "font-normal text-fg-secondary" : "font-semibold text-fg",
          )}
        >
          {sender}
        </span>
        <span
          className="block overflow-hidden text-ellipsis whitespace-nowrap"
          style={{ fontSize: "var(--font-list)" }}
        >
          <span
            className={cn(
              "leading-[18px]",
              message.seen || selected ? "" : "font-semibold",
              message.seen && !selected ? "text-fg-secondary" : "text-fg",
            )}
          >
            {message.subject}
          </span>
          {showSnippet && (
            <span className="text-fg-tertiary">
              {" "}
              {message.snippet}
            </span>
          )}
        </span>
      </span>

      <span className="flex shrink-0 flex-col items-end gap-1">
        <time
          dateTime={isoAttr(message.date)}
          title={isoTitle(message.date)}
          className="tnum font-mono text-[12px] leading-4 whitespace-nowrap text-fg-tertiary"
        >
          {formatListDate(message.date)}
        </time>
        {!compact && message.hasAttachments && (
          <Paperclip
            aria-label="Has attachments"
            role="img"
            className="size-3 text-fg-tertiary"
            strokeWidth={1.5}
          />
        )}
      </span>
    </li>
  );
});
