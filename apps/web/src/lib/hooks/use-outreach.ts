"use client";

import { useQuery } from "@tanstack/react-query";
import {
  getOutreachBadge,
  listCampaigns,
  listOutbox,
  listSuppression,
} from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { OutboxStatus } from "@/lib/types";

/**
 * The Outreach view's reads.
 *
 * Everything here is a normal cached query except the badge, which polls: it is
 * the one number the rail shows from a view the user is not looking at.
 */
export function useCampaigns(enabled = true) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["outreach-campaigns", ctx.baseUrl, ctx.token],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => listCampaigns({ ...ctx, signal }),
    staleTime: 30_000,
  });
}

/**
 * Outbox rows, filtered server-side. The approval queue asks for `pending` and
 * nothing else — a queue that also listed sent mail would invite approving a
 * row twice, and the server answers the second one with a 400.
 */
export function useOutbox(status: OutboxStatus | undefined, enabled = true) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["outreach-outbox", ctx.baseUrl, ctx.token, status ?? "all"],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => listOutbox({ status, limit: 200 }, { ...ctx, signal }),
    staleTime: 15_000,
  });
}

export function useSuppression(enabled = true) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["outreach-suppression", ctx.baseUrl, ctx.token],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => listSuppression({ ...ctx, signal }),
    staleTime: 60_000,
  });
}

/**
 * The rail badge: how many drafts an agent has queued and nobody has decided
 * on. Polled every 30s per the spec, from the rail, which is mounted in every
 * view — this is the only thing in the app that says an agent is waiting on a
 * human, so it cannot only update when the Outreach view is open.
 *
 * It stays a single COUNT: no list, no preview, nothing decrypted.
 */
export function useOutreachBadge() {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["outreach-badge", ctx.baseUrl, ctx.token],
    enabled: ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => getOutreachBadge({ ...ctx, signal }),
    staleTime: 15_000,
    refetchInterval: 30_000,
    // A server that is down must not paint the rail with an error; the count
    // simply stops moving until it answers again.
    retry: false,
  });
}
