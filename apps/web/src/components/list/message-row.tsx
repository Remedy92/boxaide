"use client";

import * as React from "react";
import { Archive, Paperclip, Sparkle, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { displayName } from "@/lib/format/address";
import { formatListDate, isoAttr, isoTitle } from "@/lib/format/date";
import { cn } from "@/lib/utils";
import type { MailMessageSummary } from "@/lib/types";

/**
 * Row anatomy. Read vs unread is carried by two redundant signals — the dot and
 * the weight — and never by a background change, which is what keeps selection
 * unambiguous without a second colour.
 *
 * Exactly one element per line may ellipsize, or the row jitters as widths
 * change. Nothing here scales or lifts on hover: transform on a list row blurs
 * the text mid-transition, and a shadow on a 62px row is noise.
 *
 * The right button opens three actions, and only three, because those are the
 * three whole things a person does to one message without opening it: file it,
 * bin it, or hand it to their agent. Everything else this app can do to a
 * message needs the message open, and lives in the reader.
 */
export const MessageRow = React.memo(function MessageRow({
  message,
  selected,
  active,
  compact,
  mailbox,
  onSelect,
  onPrefetch,
  registerRow,
  onArchive,
  onTrash,
  onAskAgent,
  onDragStart,
  onDragEnd,
}: {
  message: MailMessageSummary;
  selected: boolean;
  /** Holds the roving tabindex. */
  active: boolean;
  compact: boolean;
  /**
   * The mailbox alias, in the unified view of more than one mailbox. Undefined
   * anywhere the answer is the same on every row, where it would be noise.
   */
  mailbox?: string;
  /* All three are stable across parent renders — the row closes over its own
     id rather than receiving a freshly built closure, which is what lets
     React.memo above actually bail out. */
  onSelect: (selection: { accountId: string; messageId: string }) => void;
  onPrefetch: (accountId: string, messageId: string) => void;
  registerRow: (id: string, node: HTMLLIElement | null) => void;
  /* The three context-menu actions. Each takes the whole summary rather than a
     selection, because the agent one quotes the subject and the sender. */
  onArchive: (message: MailMessageSummary) => void;
  onTrash: (message: MailMessageSummary) => void;
  onAskAgent: (message: MailMessageSummary) => void;
  /* Also stable across parent renders, for the same reason as the five above.
     Dragging a row onto a folder in the rail files it there. */
  onDragStart: (
    message: MailMessageSummary,
    event: React.DragEvent<HTMLLIElement>,
  ) => void;
  onDragEnd: () => void;
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
  }. ${formatListDate(message.date)}${mailbox ? `. In ${mailbox}` : ""}${
    message.hasAttachments ? ". Has attachments" : ""
  }`;

  return (
    // ContextMenu.Root renders no element of its own and the trigger is the
    // row itself, so the listbox still has an <li> as its direct child.
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* Enter and Space are handled here, not by the global map. The global
            `open` handler acts on the *selected* message and falls back to
            index 0, which is not necessarily the row holding the roving
            tabindex, and it is suspended entirely while any dialog is open. A
            row that can be reached by Tab must be operable from the keyboard on
            its own (2.1.1). */}
        <li
          ref={ref}
          role="option"
          aria-selected={selected}
          aria-label={label}
          tabIndex={active ? 0 : -1}
          data-message-id={message.id}
          onClick={select}
          /* The right button selects before it opens the menu: a menu that
             acts on one message while the reader shows another is a way to
             archive the wrong mail. Radix composes this with its own handler
             and runs ours first. It covers the keyboard path too, because
             Shift+F10 and the Menu key make the browser fire the same
             contextmenu event on the focused row. */
          onContextMenu={select}
          draggable
          /* Dragging selects first, the same rule as the right button above and
             for the same reason: a drop that files one message while the reader
             shows another is a way to file the wrong mail. It is also what makes
             the palette's Move page a true equivalent of the drag, because the
             palette acts on exactly this selection. */
          onDragStart={(event) => {
            select();
            onDragStart(message, event);
          }}
          onDragEnd={onDragEnd}
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
            "grid-cols-[18px_minmax(0,1fr)_auto]",
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
          {/* There is no avatar and no monogram in this pane. The API has no avatar
              source, hashing a correspondent's address to Gravatar would leak it,
              and a coloured initial per row is the loudest thing a dense list can
              carry. Unread is a 6px dot and a weight change; that is enough. */}
          <span className="flex h-full items-center justify-center self-start pt-[3px]">
            {!message.seen && (
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-[var(--radius-full)] bg-accent"
              />
            )}
          </span>

          <span className="min-w-0">
            {/* The sender truncates; the mailbox never does. Letting the pair share
                the ellipsis would cut the alias to "wo…" on the rows with the
                longest sender names, which are exactly the rows where knowing the
                mailbox matters. */}
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span
                className={cn(
                  "min-w-0 truncate text-[13px] leading-[18px]",
                  message.seen ? "font-normal text-fg-secondary" : "font-medium text-fg",
                )}
              >
                {sender}
              </span>
              {mailbox && (
                <span className="shrink-0 text-[11px] leading-4 text-fg-tertiary">
                  {mailbox}
                </span>
              )}
            </span>
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap"
              style={{ fontSize: "var(--font-list)" }}
            >
              <span
                className={cn(
                  "leading-[18px]",
                  message.seen || selected ? "" : "font-medium",
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

          <span className="flex shrink-0 items-center gap-1.5 self-start pt-[1px]">
            {!compact && message.hasAttachments && (
              <Paperclip
                aria-label="Has attachments"
                role="img"
                className="size-3 text-fg-tertiary"
                strokeWidth={1.5}
              />
            )}
            <time
              dateTime={isoAttr(message.date)}
              title={isoTitle(message.date)}
              className="tnum text-[12px] leading-[18px] whitespace-nowrap text-fg-tertiary"
            >
              {formatListDate(message.date)}
            </time>
          </span>
        </li>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-64">
        <ContextMenuItem onSelect={() => onArchive(message)}>
          <Archive strokeWidth={1.5} />
          Archive
        </ContextMenuItem>
        {/* Delete is a move to Trash, which is why it reads as an ordinary
            action and not as a warning. The destructive colour is still right:
            it is the one row here that takes the message out of the mailbox
            the user files things in. */}
        <ContextMenuItem variant="destructive" onSelect={() => onTrash(message)}>
          <Trash2 strokeWidth={1.5} />
          Delete
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onAskAgent(message)}>
          <Sparkle strokeWidth={1.5} />
          Start conversation about this email
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
