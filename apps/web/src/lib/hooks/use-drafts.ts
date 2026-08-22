"use client";

import * as React from "react";
import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createDraft,
  deleteDraft,
  listDrafts,
  updateDraft,
} from "@/lib/api/endpoints";
import { useAccounts } from "@/lib/hooks/use-accounts";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { DraftInput, MailAccountMeta, MailDraft } from "@/lib/types";

/**
 * Drafts, unified client-side.
 *
 * `GET /api/drafts` takes one mailbox and 400s on `account=all` — there is no
 * unified draft endpoint the way there is for messages. So "All mailboxes" is a
 * fan-out: one query per connected account, merged newest-first here, with the
 * per-account failures surfaced instead of swallowed. That mirrors the
 * `errors[]` contract the message list already has, so a mailbox that is down
 * costs you that mailbox's drafts and nothing else.
 */

/** Drafts only change through this app, which invalidates on every mutation. */
const DRAFTS_STALE_MS = 5 * 60_000;

export type DraftListResult = {
  drafts: MailDraft[];
  /** `account` is the ALIAS, matching AccountError on the message list. */
  errors: Array<{ account: string; error: string }>;
  isPending: boolean;
  isFetching: boolean;
  /** True only when every mailbox failed — the list has nothing to show. */
  isError: boolean;
  refetch: () => void;
};

function accountsFor(
  accountRef: string,
  all: MailAccountMeta[],
): MailAccountMeta[] {
  if (accountRef === "all") return all;
  return all.filter(
    (entry) => entry.alias === accountRef || entry.id === accountRef,
  );
}

/**
 * `enabled` is what keeps the inbox from paying for the Drafts view. With it
 * false there are no queries at all — not disabled ones — so switching mailbox
 * while reading mail issues no draft requests.
 */
export function useDrafts(accountRef: string, enabled = true): DraftListResult {
  const ctx = useApiCtx();
  const accounts = useAccounts();
  const all = React.useMemo(() => accounts.data ?? [], [accounts.data]);
  const targets = React.useMemo(
    () => (enabled ? accountsFor(accountRef, all) : []),
    [accountRef, all, enabled],
  );

  const results = useQueries({
    queries: targets.map((account) => ({
      queryKey: ["drafts", ctx.baseUrl, ctx.token, account.id],
      enabled: ctx.baseUrl.length > 0 && ctx.token.length > 0,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listDrafts(account.id, { ...ctx, signal }),
      // Drafts change only through this app's own mutations, and every one of
      // them invalidates below. Thirty seconds meant leaving Drafts and coming
      // back re-ran the whole per-account fan-out, each leg an IMAP round trip.
      staleTime: DRAFTS_STALE_MS,
      // Same reason the message list keeps its previous page: switching mailbox
      // while in Drafts blanked the list to a skeleton.
      placeholderData: keepPreviousData,
    })),
  });

  const queryClient = useQueryClient();
  const refetch = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["drafts"] });
  }, [queryClient]);

  // The dependency is the results array, which useQueries rebuilds each render.
  // Deriving inside useMemo on its *contents* is not possible without a deep
  // compare, so this is a plain derivation — it is O(drafts) on a list the
  // server caps at 50 per mailbox.
  const drafts: MailDraft[] = [];
  const errors: DraftListResult["errors"] = [];
  let isPending = targets.length > 0;
  let isFetching = false;
  let failed = 0;

  results.forEach((result, index) => {
    if (!result.isPending) isPending = false;
    if (result.isFetching) isFetching = true;
    if (result.error) {
      failed += 1;
      errors.push({
        account: targets[index]?.alias ?? "unknown",
        error:
          result.error instanceof Error
            ? result.error.message
            : String(result.error),
      });
      return;
    }
    for (const draft of result.data ?? []) drafts.push(draft);
  });

  drafts.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  return {
    drafts,
    errors,
    isPending: enabled && (accounts.isPending || (isPending && targets.length > 0)),
    isFetching: enabled && (accounts.isFetching || isFetching),
    isError: targets.length > 0 && failed === targets.length,
    refetch,
  };
}

/** Create. Returns the DraftRef — content has to be refetched from the list. */
export function useCreateDraft() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { account: string; draft: DraftInput }) =>
      createDraft(input.account, input.draft, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
}

/**
 * Update. The server replaces the draft and answers with a NEW id, so the
 * caller must adopt `result.id`; the previous one no longer resolves.
 */
export function useUpdateDraft() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      accountId: string;
      draftId: string;
      draft: DraftInput;
    }) => updateDraft(input.accountId, input.draftId, input.draft, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
}

export function useDeleteDraft() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: string; draftId: string }) =>
      deleteDraft(input.accountId, input.draftId, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
}
