"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { listMessages, searchMessages } from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { MessageListResponse } from "@/lib/types";

export type MessageListParams = {
  account: string;
  folder?: string;
  unreadOnly: boolean;
  /** Non-empty switches the request to GET /api/messages/search. */
  q: string;
  limit?: number;
};

/**
 * A partial account failure is a 200 whose errors[] names the mailbox, so
 * React Query sees success and would never retry it. Gmail in particular
 * refuses a login burst and accepts the identical credential seconds later —
 * observed live, not hypothetical. These three delays retry that window
 * automatically; past them the banner's manual Retry is the honest state.
 */
const PARTIAL_RETRY_DELAYS_MS = [3_000, 8_000, 20_000] as const;

/**
 * One query for both listing and search. `keepPreviousData` is what stops the
 * pane blanking to a skeleton on every filter change — the single biggest thing
 * that makes a mail client feel slow.
 *
 * Search never carries `folder`: routes.ts:197 does not forward it, so search
 * always runs against Inbox and sending it would be a lie about the request.
 */
export function useMessages(params: MessageListParams) {
  const ctx = useApiCtx();
  const searching = params.q.trim().length > 0;
  return useQuery<MessageListResponse>({
    refetchInterval: (query) => {
      const errors = query.state.data?.errors;
      if (!errors || errors.length === 0) return false;
      // dataUpdateCount counts every settled fetch of this query instance, so
      // it walks the delay ladder once per failing refresh and then stops.
      const attempt = Math.min(
        query.state.dataUpdateCount - 1,
        PARTIAL_RETRY_DELAYS_MS.length,
      );
      return attempt < PARTIAL_RETRY_DELAYS_MS.length
        ? PARTIAL_RETRY_DELAYS_MS[attempt]
        : false;
    },
    queryKey: [
      "messages",
      ctx.baseUrl,
      ctx.token,
      params.account,
      searching ? undefined : (params.folder ?? null),
      searching ? false : params.unreadOnly,
      searching ? params.q.trim() : "",
    ],
    enabled: ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) =>
      searching
        ? searchMessages(
            { q: params.q.trim(), account: params.account, limit: params.limit },
            { ...ctx, signal },
          )
        : listMessages(
            {
              account: params.account,
              folder: params.folder,
              unreadOnly: params.unreadOnly,
              limit: params.limit,
            },
            { ...ctx, signal },
          ),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}
