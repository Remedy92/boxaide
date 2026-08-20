"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  archiveMessage,
  moveMessage,
  trashMessage,
} from "@/lib/api/endpoints";
import { ApiError, friendlyError } from "@/lib/api/errors";
import { useApp } from "@/lib/hooks/use-app-state";
import { useMessageNavigation } from "@/lib/hooks/use-selection";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { MessageListResponse, MoveResult } from "@/lib/types";

/**
 * Archive, Delete and Move to folder are one thing on the server: a MOVE out of
 * the folder the message is in, with the destination decided differently in
 * each case. They are one thing here too, because everything that makes them
 * survivable in the interface is shared, and a second copy of it would be a
 * second place for the selection to get stuck or an undo to go missing.
 */

/**
 * The leaf of an IMAP path. Both "/" and "." split it off: Dovecot- and
 * Courier-style servers spell the same mailbox INBOX.Archive.
 */
function leafOf(folder: string): string {
  return folder.split(/[/.]/).pop() ?? folder;
}

/**
 * "Archived to Archive" is a sentence nobody writes. Name the mailbox only
 * when it is not simply called Archive: on Gmail it is [Gmail]/All Mail, and
 * there the destination is worth saying out loud.
 */
function archivedLabel(folder: string): string {
  return /^archive(s)?$/i.test(leafOf(folder))
    ? "Archived"
    : `Archived to ${folder}`;
}

/** Same rule for Trash, which servers also spell Bin or Deleted Items. */
function deletedLabel(folder: string): string {
  return /^(trash|bin|deleted|deleted items|deleted messages)$/i.test(
    leafOf(folder),
  )
    ? "Deleted"
    : `Deleted to ${folder}`;
}

/**
 * Message ids with a move request in flight, shared by every mount of every one
 * of these hooks: the reader, the shell's `e` and `#` handlers and the palette
 * each hold their own mutation instance. Without this a double-pressed `e`
 * sends the same archive twice: the second finds the uid already gone, comes
 * back 404, and the user is shown an error for an archive that in fact worked.
 *
 * One set across all three actions, not one per action, because the second
 * request is wrong for the same reason whichever of them fires it: the uid it
 * would address has already left the folder.
 *
 * Released in the mutation's own onSettled, never in a per-call one. The
 * palette closes before it runs its action, so the component that fired the
 * move is unmounted by the time the request answers, and query-core skips
 * per-call callbacks once the observer has no listeners
 * (`this.#mutateOptions && this.hasListeners()`). A guard released there
 * would leak the id and make `e` a dead key for that message until reload.
 */
const inflight = new Set<string>();

/** Every one of these actions names one message in one mailbox. */
export type MoveTarget = {
  accountId: string;
  messageId: string;
};

export type MoveToInput = MoveTarget & {
  /** The mailbox path, as listFolders spells it. */
  folder: string;
};

/**
 * Move the message out of the folder it is in, optimistically.
 *
 * Three things have to happen together or the pane lies for a moment: the row
 * leaves every cached list, the selection walks to the next row the way it does
 * after j, and the reader stops showing a message that is no longer in the
 * folder it was opened from. All three are undone on failure.
 *
 * Undo is a real move back to the folder the server said the message came from,
 * and it is offered only when the server named the message's new id: without
 * UIDPLUS there is nothing to address, and a button that would 404 is worse
 * than no button.
 */
function useFiling<I extends MoveTarget>(copy: {
  /** The call that moves the message. Rebuilt per render; read at call time. */
  run: (input: I) => Promise<MoveResult>;
  /** The toast for a move the server confirmed. */
  done: (result: MoveResult) => string;
  /** The toast for a move that failed. */
  failed: string;
  /** The toast for a message another client had already moved. */
  gone: string;
}) {
  const app = useApp();
  const ctx = useApiCtx();
  const nav = useMessageNavigation();
  const queryClient = useQueryClient();

  /* Bound at render time, so onMutate reads the rows as they were before its
     own optimistic removal takes one out. */
  const rows = nav.rows;

  const back = useMutation({
    mutationFn: (input: MoveToInput) =>
      moveMessage(input.accountId, input.messageId, input.folder, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
    },
    onError: (error) => {
      toast.error("Could not move that message back", {
        description: friendlyError(
          error instanceof Error ? error.message : error,
        ),
      });
    },
  });

  const filing = useMutation({
    mutationFn: (input: I) => copy.run(input),

    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ["messages"] });

      // Where the selection goes next is decided from the list as it stands
      // now: after the removal below, the moved row is no longer in it to have
      // a row below.
      const selection = app.selected;
      const wasSelected = selection?.messageId === input.messageId;
      const index = rows.findIndex((row) => row.id === input.messageId);
      // The row below, or the one above when the moved message was last.
      const successor =
        index < 0 ? null : (rows[index + 1] ?? rows[index - 1] ?? null);

      const listSnapshots = queryClient.getQueriesData<MessageListResponse>({
        queryKey: ["messages"],
      });
      for (const [key, data] of listSnapshots) {
        if (!data) continue;
        queryClient.setQueryData<MessageListResponse>(key, {
          ...data,
          messages: data.messages.filter((row) => row.id !== input.messageId),
        });
      }

      // Only when the moved message is the one on screen. Acting from the
      // palette while a different row is selected must not move the selection.
      if (wasSelected) {
        if (successor) {
          app.select({
            accountId: successor.accountId,
            messageId: successor.id,
          });
        } else {
          app.clearSelection();
        }
      }
      return { listSnapshots, selection: wasSelected ? selection : null };
    },

    onError: (error, _input, context) => {
      // 404 is not a failure: the server is saying the message had already
      // left that folder, which another client did a moment ago. Putting the
      // row back would paint a message that no longer exists, so the optimistic
      // removal stands and the list is refetched to find out where it went.
      if (error instanceof ApiError && error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: ["messages"] });
        toast(copy.gone);
        return;
      }
      for (const [key, data] of context?.listSnapshots ?? []) {
        queryClient.setQueryData(key, data);
      }
      if (context?.selection) app.select(context.selection);
      toast.error(copy.failed, {
        description: friendlyError(
          error instanceof Error ? error.message : error,
        ),
      });
    },

    onSettled: (_result, _error, input) => {
      inflight.delete(input.messageId);
    },

    onSuccess: (result, input) => {
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      toast.success(copy.done(result), {
        action: result.id
          ? {
              label: "Undo",
              onClick: () =>
                back.mutate({
                  // The same mailbox: a move never crosses accounts.
                  accountId: input.accountId,
                  messageId: result.id as string,
                  folder: result.fromFolder,
                }),
            }
          : undefined,
      });
    },
  });

  /* Memoised because the message list hands this straight to 200 memoised
     rows: a fresh closure per render would defeat React.memo on every one of
     them. `fire` is query-core's own bound mutate, which never changes. */
  const fire = filing.mutate;
  const mutate = React.useCallback(
    (input: I) => {
      if (inflight.has(input.messageId)) return;
      inflight.add(input.messageId);
      fire(input);
    },
    [fire],
  );

  return { ...filing, mutate };
}

/** Archive the selected message: a move into the account's Archive mailbox. */
export function useArchive() {
  const ctx = useApiCtx();
  return useFiling<MoveTarget>({
    run: (input) => archiveMessage(input.accountId, input.messageId, ctx),
    done: (result) => archivedLabel(result.toFolder),
    failed: "Could not archive that message",
    gone: "Already archived elsewhere",
  });
}

/**
 * Delete the selected message: a move into the account's Trash mailbox.
 *
 * Nothing is expunged and no \Deleted flag is set, so Undo is a move back like
 * every other one here, and a message the user deletes is exactly where their
 * own mail client expects to find it.
 */
export function useTrash() {
  const ctx = useApiCtx();
  return useFiling<MoveTarget>({
    run: (input) => trashMessage(input.accountId, input.messageId, ctx),
    done: (result) => deletedLabel(result.toFolder),
    failed: "Could not delete that message",
    gone: "Already deleted elsewhere",
  });
}

/** Move the selected message to a mailbox the user picked by name. */
export function useMoveTo() {
  const ctx = useApiCtx();
  return useFiling<MoveToInput>({
    run: (input) =>
      moveMessage(input.accountId, input.messageId, input.folder, ctx),
    // The destination is always worth naming here: the user chose it, and the
    // full path is what tells INBOX.Receipts from Receipts.
    done: (result) => `Moved to ${result.toFolder}`,
    failed: "Could not move that message",
    gone: "Already moved elsewhere",
  });
}
