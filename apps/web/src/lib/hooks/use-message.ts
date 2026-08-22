"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMessage } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/errors";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { MailMessage } from "@/lib/types";

/** How long a fetched body is kept after nothing is rendering it. */
const BODY_GC_MS = 30 * 60_000;

export function messageKey(
  baseUrl: string,
  token: string,
  accountId: string,
  messageId: string,
) {
  return ["message", baseUrl, token, accountId, messageId] as const;
}

/**
 * Bodies are immutable, so a fetched message never goes stale — and `gcTime`
 * has to say so too. With only `staleTime: Infinity` the QueryClient's
 * five-minute default still evicted every unmounted body, so re-opening a
 * message read six minutes ago refetched it in full.
 */
export function useMessage(accountId: string | null, messageId: string | null) {
  const ctx = useApiCtx();
  return useQuery<MailMessage>({
    queryKey: messageKey(ctx.baseUrl, ctx.token, accountId ?? "", messageId ?? ""),
    enabled:
      ctx.baseUrl.length > 0 &&
      ctx.token.length > 0 &&
      !!accountId &&
      !!messageId,
    queryFn: ({ signal }) =>
      getMessage(accountId as string, messageId as string, { ...ctx, signal }),
    staleTime: Infinity,
    gcTime: BODY_GC_MS,
    retry: (count, error) =>
      !(error instanceof ApiError && (error.status === 404 || error.status === 401)) &&
      count < 1,
  });
}

/**
 * Prefetch a body. Every superseded prefetch is aborted through a keyed
 * in-flight map, so j-scrubbing cancels the previous fetch and a stale response
 * can never overwrite newer state.
 */
export function usePrefetchMessage() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  const inFlight = React.useRef(new Map<string, AbortController>());

  React.useEffect(() => {
    const map = inFlight.current;
    return () => {
      for (const controller of map.values()) controller.abort();
      map.clear();
    };
  }, []);

  return React.useCallback(
    (accountId: string, messageId: string) => {
      if (!ctx.baseUrl || !ctx.token) return;
      const key = messageKey(ctx.baseUrl, ctx.token, accountId, messageId);
      const cacheKey = key.join("\0");
      if (queryClient.getQueryData(key)) return;
      if (inFlight.current.has(cacheKey)) return;
      const controller = new AbortController();
      inFlight.current.set(cacheKey, controller);
      void queryClient
        .prefetchQuery({
          queryKey: key,
          queryFn: () =>
            getMessage(accountId, messageId, { ...ctx, signal: controller.signal }),
          staleTime: Infinity,
          gcTime: BODY_GC_MS,
        })
        .finally(() => {
          inFlight.current.delete(cacheKey);
        });
    },
    [ctx, queryClient],
  );
}
