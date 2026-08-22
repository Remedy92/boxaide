"use client";

import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { markRead } from "@/lib/api/endpoints";
import { friendlyError } from "@/lib/api/errors";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type {
  FolderGroupsResponse,
  MailAccountMeta,
  MailFolder,
  MailMessage,
  MessageListResponse,
} from "@/lib/types";

export type MarkReadInput = {
  accountId: string;
  messageId: string;
  seen: boolean;
  /** Suppresses the Undo action for the optimistic j/k pass. */
  silent?: boolean;
};

/**
 * Every way one mailbox is spelled in a ["folders", …] query key.
 *
 * useFolders is keyed on whatever ref its caller had: the reader and the
 * palette pass the account id, the rail passes the alias out of the account
 * filter. Both entries hold folders whose paths are mostly the same strings,
 * INBOX above all, so patching by path alone would walk another mailbox's
 * badge. The accounts list is read out of the cache rather than through
 * useAccounts because this runs inside a mutation, not a render.
 */
function refsFor(
  queryClient: QueryClient,
  ctx: { baseUrl: string; token: string },
  accountId: string,
): Set<string> {
  const accounts = queryClient.getQueryData<MailAccountMeta[]>([
    "accounts",
    ctx.baseUrl,
    ctx.token,
  ]);
  const refs = new Set<string>([accountId]);
  const account = accounts?.find((row) => row.id === accountId);
  if (account) refs.add(account.alias);
  return refs;
}

/**
 * Walk one folder's unread count by `delta`, leaving every other folder alone.
 *
 * A folder with no `unread` is left with no `unread`: absent means the index
 * has never synced it, and inventing a count here would be exactly the
 * confident zero the rail refuses to draw. `exact` rides through untouched,
 * because a floor that loses a read message is still a floor.
 */
function bumpFolder(
  folders: MailFolder[],
  folder: string,
  delta: number,
): MailFolder[] {
  let changed = false;
  const next = folders.map((entry) => {
    if (entry.path !== folder || !entry.unread) return entry;
    changed = true;
    return {
      ...entry,
      unread: {
        ...entry.unread,
        count: Math.max(0, entry.unread.count + delta),
      },
    };
  });
  return changed ? next : folders;
}

/**
 * Move the cached unread counts instead of refetching them, and hand back the
 * rollback.
 *
 * The rail's number comes from the local index, not from the server's own
 * state, so a read this client just performed is something it can apply
 * itself. That is the whole point: GET /api/folders is one IMAP LIST per
 * mailbox, and marking read is the commonest thing that happens here. The j/k
 * pass fires a silent mark for every row the cursor rests on for 400ms, so
 * refetching would put a LIST behind every row the user scrolls past, on every
 * connected mailbox, for a number SQLite had already answered.
 */
function patchUnread(
  queryClient: QueryClient,
  refs: Set<string>,
  accountId: string,
  folder: string,
  delta: number,
): () => void {
  const undo: Array<() => void> = [];

  for (const [key, data] of queryClient.getQueriesData<MailFolder[]>({
    queryKey: ["folders"],
  })) {
    if (!data || !refs.has(String(key[3]))) continue;
    const next = bumpFolder(data, folder, delta);
    if (next === data) continue;
    queryClient.setQueryData<MailFolder[]>(key, next);
    undo.push(() => queryClient.setQueryData<MailFolder[]>(key, data));
  }

  for (const [key, data] of queryClient.getQueriesData<FolderGroupsResponse>({
    queryKey: ["folder-groups"],
  })) {
    if (!data) continue;
    let changed = false;
    const groups = data.groups.map((group) => {
      if (group.accountId !== accountId) return group;
      const folders = bumpFolder(group.folders, folder, delta);
      if (folders === group.folders) return group;
      changed = true;
      return { ...group, folders };
    });
    if (!changed) continue;
    queryClient.setQueryData<FolderGroupsResponse>(key, { ...data, groups });
    undo.push(() => queryClient.setQueryData<FolderGroupsResponse>(key, data));
  }

  return () => {
    for (const restore of undo) restore();
  };
}

/**
 * Optimistic with rollback. Every cached list is patched, plus the full-message
 * entry if it has been fetched, so the reader's toggle and the row agree
 * immediately. Undo is a second POST, the only undo this backend has.
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
      // The row's own folder and its seen state before this call, both read
      // off the cached row. Not parsed out of the message id: that is
      // `${accountId}:${folder}:${uid}` and a mailbox path may itself hold a
      // colon, so the row is the only safe place to read the folder from.
      let folder: string | undefined;
      let was: boolean | undefined;
      for (const [key, data] of listSnapshots) {
        if (!data) continue;
        queryClient.setQueryData<MessageListResponse>(key, {
          ...data,
          messages: data.messages.map((row) => {
            if (row.id !== input.messageId) return row;
            folder = row.folder;
            was = row.seen;
            return { ...row, seen: input.seen };
          }),
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
        folder ??= messageSnapshot.folder;
        was ??= messageSnapshot.seen;
        queryClient.setQueryData<MailMessage>(messageKey, {
          ...messageSnapshot,
          seen: input.seen,
        });
      }

      // Only when this call actually changes the flag. Marking read a message
      // already read is a no-op on the server and must be one on the badge
      // too, or a repeated `u` walks the count away from the truth.
      const rollbackUnread =
        folder !== undefined && was !== undefined && was !== input.seen
          ? patchUnread(
              queryClient,
              refsFor(queryClient, ctx, input.accountId),
              input.accountId,
              folder,
              input.seen ? -1 : 1,
            )
          : null;

      return { listSnapshots, messageKey, messageSnapshot, rollbackUnread };
    },

    onError: (error, input, context) => {
      for (const [key, data] of context?.listSnapshots ?? []) {
        queryClient.setQueryData(key, data);
      }
      if (context?.messageSnapshot) {
        queryClient.setQueryData(context.messageKey, context.messageSnapshot);
      }
      context?.rollbackUnread?.();
      toast.error(
        input.seen ? "Could not mark as read" : "Could not mark as unread",
        { description: friendlyError(error instanceof Error ? error.message : error) },
      );
    },

    onSuccess: (_result, input) => {
      // Stale, but NOT refetched. The counts were moved above, and a refetch
      // here would cost one IMAP LIST per connected mailbox for every row the
      // j/k pass rests on. Marking stale hands the reconciliation to the next
      // mount or window focus, which is where a count that drifted, because
      // another client read the same mail, gets corrected anyway.
      void queryClient.invalidateQueries({
        queryKey: ["folders"],
        refetchType: "none",
      });
      void queryClient.invalidateQueries({
        queryKey: ["folder-groups"],
        refetchType: "none",
      });

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
