"use client";

import * as React from "react";
import { useApp } from "@/lib/hooks/use-app-state";
import { useMarkRead } from "@/lib/hooks/use-mark-read";
import { usePrefetchMessage } from "@/lib/hooks/use-message";
import { useMessages } from "@/lib/hooks/use-messages";
import type { MailMessageSummary } from "@/lib/types";

/** The rows the list is currently showing, from the same cache entry it uses. */
export function useVisibleMessages(): MailMessageSummary[] {
  const { account, folder, unreadOnly, query } = useApp();
  const messages = useMessages({ account, folder, unreadOnly, q: query });
  return React.useMemo(() => messages.data?.messages ?? [], [messages.data]);
}

/**
 * Selection movement shared by the list rows, the reader's prev/next pair and
 * the j/k keys.
 *
 * This hook is pure read-and-move: it starts nothing. The two side effects that
 * hang off landing on a row live in useSelectionEffects below, which AppShell
 * mounts exactly once — three components read navigation state, and running the
 * effects here would fire three prefetches and three mark-read POSTs per row.
 */
export function useMessageNavigation() {
  const { selected, select } = useApp();
  const rows = useVisibleMessages();
  const prefetch = usePrefetchMessage();

  const index = React.useMemo(
    () => (selected ? rows.findIndex((row) => row.id === selected.messageId) : -1),
    [rows, selected],
  );

  const selectAt = React.useCallback(
    (next: number) => {
      const row = rows[next];
      if (!row) return;
      select({ accountId: row.accountId, messageId: row.id });
      prefetch(row.accountId, row.id);
    },
    [prefetch, rows, select],
  );

  const next = React.useCallback(() => {
    if (rows.length === 0) return;
    selectAt(index < 0 ? 0 : Math.min(index + 1, rows.length - 1));
  }, [index, rows.length, selectAt]);

  const previous = React.useCallback(() => {
    if (rows.length === 0) return;
    selectAt(index <= 0 ? 0 : index - 1);
  }, [index, rows.length, selectAt]);

  const current = index >= 0 ? rows[index] : undefined;

  return {
    rows,
    index,
    current,
    selectAt,
    next,
    previous,
    hasNext: index >= 0 && index < rows.length - 1,
    hasPrevious: index > 0,
  };
}

/**
 * The two side effects of landing on a row. Mounted once, by AppShell.
 *
 *  - Prefetch the row below the current selection while the user reads.
 *  - Mark the landed-on row read, 400ms later. The debounce is what stops
 *    j-scrubbing from marking a trail of messages read, and `silent` keeps it
 *    out of the toast stack — an automatic mark is not an action to undo.
 *
 * The auto-mark runs at most once per message id per session, and the memory is
 * keyed on SELECTION rather than on the mark it performed. Both halves matter:
 *
 *  - Keyed on the mark alone, an explicit `u` on a message that arrived already
 *    read would flip `seen` to false, the effect would see an unread selection
 *    it had never marked, and it would mark it read again 400ms later.
 *  - Not keyed at all, the same thing happens to every message.
 *
 * Either way `u` and the reader's `Mark unread` become unusable on the message
 * the user is actually looking at, which is the only message they can press it
 * on. So an id is recorded the moment it becomes the selection, read or unread.
 */
const HANDLED_CAP = 500;

export function useSelectionEffects() {
  const { rows, index, current } = useMessageNavigation();
  const prefetch = usePrefetchMessage();
  const markRead = useMarkRead();
  const markMutate = markRead.mutate;
  const handled = React.useRef(new Set<string>());

  React.useEffect(() => {
    const below = rows[index + 1];
    if (index >= 0 && below) prefetch(below.accountId, below.id);
  }, [index, prefetch, rows]);

  React.useEffect(() => {
    if (!current) return;
    const ids = handled.current;
    if (ids.has(current.id)) return;
    // Bounded: a very long session must not grow this without limit.
    if (ids.size >= HANDLED_CAP) ids.clear();

    // Already read on arrival: nothing to do, but remember it, so a later `u`
    // is not chased down by this effect.
    if (current.seen) {
      ids.add(current.id);
      return;
    }

    // Unread: record it only when the timer actually fires. Recording on
    // schedule would mean a row that j-scrubbing passed over in under 400ms
    // never auto-marks, even when the user comes back and settles on it.
    const timer = setTimeout(() => {
      ids.add(current.id);
      markMutate({
        accountId: current.accountId,
        messageId: current.id,
        seen: true,
        silent: true,
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [current, markMutate]);
}
