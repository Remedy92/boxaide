"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { markRead } from "@/lib/api/endpoints";
import { friendlyError } from "@/lib/api/errors";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { MailMessage, MessageListResponse } from "@/lib/types";

export type MarkReadInput = {
  accountId: string;
  messageId: string;
  seen: boolean;
  /** Suppresses the Undo action for the optimistic j/k pass. */
  silent?: boolean;
};

/**
 * Optimistic with rollback. Every cached list is patched, plus the full-message
 * entry if it has been fetched, so the reader's toggle and the row agree
 * immediately. Undo is a second POST — the only undo this backend has.
 */
export function useMarkRead() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (input: MarkReadInput) =>
      markRead(input.accountId, input.messageId, input.seen, ctx),

    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ["messages"] });
      const listSnapshots = queryClient.getQueriesData<MessageListResponse>({
        queryKey: ["messages"],
      });
      for (const [key, data] of listSnapshots) {
        if (!data) continue;
        queryClient.setQueryData<MessageListResponse>(key, {
          ...data,
          messages: data.messages.map((row) =>
            row.id === input.messageId ? { ...row, seen: input.seen } : row,
          ),
        });
      }

      const messageKey = [
        "message",
        ctx.baseUrl,
        ctx.token,
        input.accountId,
        input.messageId,
      ];
      const messageSnapshot = queryClient.getQueryData<MailMessage>(messageKey);
      if (messageSnapshot) {
        queryClient.setQueryData<MailMessage>(messageKey, {
          ...messageSnapshot,
          seen: input.seen,
        });
      }
      return { listSnapshots, messageKey, messageSnapshot };
    },

    onError: (error, input, context) => {
      for (const [key, data] of context?.listSnapshots ?? []) {
        queryClient.setQueryData(key, data);
      }
      if (context?.messageSnapshot) {
        queryClient.setQueryData(context.messageKey, context.messageSnapshot);
      }
      toast.error(
        input.seen ? "Could not mark as read" : "Could not mark as unread",
        { description: friendlyError(error instanceof Error ? error.message : error) },
      );
    },

    onSuccess: (_result, input) => {
      // The j/k pass marks read on a 400ms debounce and must stay silent; a
      // toast per row while scrubbing would be unusable. An explicit toggle
      // gets the one undo this backend has: a second POST …/read.
      if (input.silent) return;
      toast.success(input.seen ? "Marked as read" : "Marked as unread", {
        action: {
          label: "Undo",
          onClick: () =>
            mutation.mutate({
              accountId: input.accountId,
              messageId: input.messageId,
              seen: !input.seen,
              silent: true,
            }),
        },
      });
    },
  });

  return mutation;
}
