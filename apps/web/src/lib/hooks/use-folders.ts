"use client";

import { useQuery } from "@tanstack/react-query";
import { listFolders, listFolderGroups } from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * One mailbox's folders, flat.
 *
 * Disabled on "all", and not because the server refuses it any more: it answers
 * a grouped shape there. It is disabled because everything reading this hook,
 * the palette's folder page, the reader's move menu and use-move, wants one
 * mailbox's flat list and has an account in hand. The grouped shape has its own
 * hook and its own query key below, so what lives under ["folders", ...] never
 * changes meaning underneath those readers.
 */
export function useFolders(accountRef: string) {
  const ctx = useApiCtx();
  const enabled =
    ctx.baseUrl.length > 0 &&
    ctx.token.length > 0 &&
    accountRef.length > 0 &&
    accountRef !== "all";
  return useQuery({
    queryKey: ["folders", ctx.baseUrl, ctx.token, accountRef],
    enabled,
    queryFn: ({ signal }) => listFolders(accountRef, { ...ctx, signal }),
    staleTime: 5 * 60_000,
  });
}

/**
 * Every mailbox's folders, grouped by account, for the rail under "All
 * mailboxes".
 *
 * Its own key rather than ["folders", ..., "all"]: that key already means "a
 * flat MailFolder[]" to three other readers, and handing them a different shape
 * under the same key is how a cache poisons a feature it never heard of.
 *
 * The 5 minute staleTime is load-bearing, here more than anywhere: each group
 * is one IMAP LIST on the server, so a shorter window would relist every
 * mailbox on every window focus.
 */
export function useFolderGroups(enabled: boolean) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["folder-groups", ctx.baseUrl, ctx.token],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => listFolderGroups({ ...ctx, signal }),
    staleTime: 5 * 60_000,
  });
}
