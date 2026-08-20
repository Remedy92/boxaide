"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { archiveMessage, moveMessage } from "@/lib/api/endpoints";
import { ApiError, friendlyError } from "@/lib/api/errors";
import { useApp } from "@/lib/hooks/use-app-state";
import { useMessageNavigation } from "@/lib/hooks/use-selection";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { MessageListResponse } from "@/lib/types";

/**
 * "Archived to Archive" is a sentence nobody writes. Name the mailbox only
 * when it is not simply called Archive — on Gmail it is [Gmail]/All Mail, and
 * there the destination is worth saying out loud. Both "/" and "." split the
 * leaf off: Dovecot- and Courier-style servers spell the same mailbox
 * INBOX.Archive.
 */
function archivedLabel(folder: string): string {
  const leaf = folder.split(/[/.]/).pop() ?? folder;
  return /^archive(s)?$/i.test(leaf) ? "Archived" : `Archived to ${folder}`;
}

/**
 * Message ids with an archive request in flight, shared by every mount of
 * this hook — the reader, the shell's `e` handler and the palette each hold
 * their own mutation instance. Without this a double-pressed `e` sends the
 * same archive twice: the second finds the uid already gone, comes back 404,
 * and the user is shown an error for an archive that in fact worked.
 */
const inflight = new Set<string>();

export type ArchiveInput = {
  accountId: string;
  messageId: string;
};

/**
 * Archive the selected message, optimistically.
 *
 * Three things have to happen together or the pane lies for a moment: the row
 * leaves every cached list, the selection walks to the next row the way it does
 * after j, and the reader stops showing a message that is no longer in the
 * folder it was opened from. All three are undone on failure.
 *
 * Undo is a real move back to the folder the server said the message came from,
 * and it is offered only when the server named the message's new id — without
 * UIDPLUS there is nothing to address, and a button that would 404 is worse
 * than no button.
 */
export function useArchive() {
  const ctx = useApiCtx();
  const app = useApp();
  const nav = useMessageNavigation();
  const queryClient = useQueryClient();

  /* Bound at render time, so onMutate reads the rows as they were before its
     own optimistic removal takes one out. */
  const rows = nav.rows;

  const move = useMutation({
    mutationFn: (input: { accountId: string; messageId: string; folder: string }) =>
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

  const archive = useMutation({
    mutationFn: (input: ArchiveInput) =>
      archiveMessage(input.accountId, input.messageId, ctx),

    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ["messages"] });

      // Where the selection goes next is decided from the list as it stands
      // now — after the removal below, the archived row is no longer in it to
      // have a row below.
      const selection = app.selected;
      const wasSelected = selection?.messageId === input.messageId;
      const index = rows.findIndex((row) => row.id === input.messageId);
      // The row below, or the one above when the archived message was last.
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

      // Only when the archived message is the one on screen. Archiving from the
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
        toast("Already archived elsewhere");
        return;
      }
      for (const [key, data] of context?.listSnapshots ?? []) {
        queryClient.setQueryData(key, data);
      }
      if (context?.selection) app.select(context.selection);
      toast.error("Could not archive that message", {
        description: friendlyError(
          error instanceof Error ? error.message : error,
        ),
      });
    },

    onSuccess: (result, input) => {
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      toast.success(archivedLabel(result.toFolder), {
        action: result.id
          ? {
              label: "Undo",
              onClick: () =>
                move.mutate({
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

  return {
    ...archive,
    mutate: (input: ArchiveInput) => {
      if (inflight.has(input.messageId)) return;
      inflight.add(input.messageId);
      archive.mutate(input, {
        onSettled: () => inflight.delete(input.messageId),
      });
    },
  };
}
