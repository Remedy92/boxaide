"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import {
  getAutomationBadge,
  listAutomationRuns,
  listAutomations,
  markAutomationRunsSeen,
  runAutomationNow,
  updateAutomation,
} from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * The Automations view's reads and its three writes.
 *
 * There is no create hook: automations are authored by talking to the agent
 * (spec: Web UI), so this app can only change how a run happens — pause it,
 * run it now, choose the agent and model — and read what happened.
 */
export function useAutomations(enabled = true) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["automations", ctx.baseUrl, ctx.token],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => listAutomations({ ...ctx, signal }),
    staleTime: 30_000,
  });
}

/**
 * One automation's runs. Fetched only while its history is open — a run row
 * carries up to 4 KiB of decrypted log, and holding every automation's tail in
 * the cache to draw a collapsed row would be mail content nobody asked to see.
 *
 * `running` rows are the reason for the poll: a run started from this view
 * finishes minutes later, in another process, with no event to listen for.
 */
export function useAutomationRuns(automationId: string | null, open: boolean) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["automation-runs", ctx.baseUrl, ctx.token, automationId],
    enabled:
      open &&
      automationId !== null &&
      ctx.baseUrl.length > 0 &&
      ctx.token.length > 0,
    queryFn: ({ signal }) =>
      listAutomationRuns(automationId as string, { ...ctx, signal }, 20),
    staleTime: 10_000,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((run) => run.status === "running")
        ? 5_000
        : false,
  });
}

/**
 * The rail's count: runs that finished since the Automations view was last
 * open, and whether any of them failed. Same cadence and the same rules as
 * the Outreach badge: a server that is down stops the number, it never paints
 * an error.
 */
export function useAutomationBadge(enabled = true) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["automation-badge", ctx.baseUrl, ctx.token],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => getAutomationBadge({ ...ctx, signal }),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });
}

/**
 * Mounted by the Automations view. Marks every finished run as seen when the
 * view opens, and again whenever the badge rises while it is open — a run
 * that finishes under the user's eyes is not news. The badge query is then
 * overwritten with the server's answer rather than waiting for the next poll.
 */
export function useMarkAutomationRunsSeen(enabled: boolean) {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  const badge = useAutomationBadge(enabled);
  const unseen = badge.data?.unseen ?? 0;
  const ready = enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0;
  React.useEffect(() => {
    if (!ready) return;
    if (badge.data !== undefined && unseen === 0) return;
    const controller = new AbortController();
    markAutomationRunsSeen({ ...ctx, signal: controller.signal })
      .then((next) => {
        queryClient.setQueryData(
          ["automation-badge", ctx.baseUrl, ctx.token],
          next,
        );
      })
      .catch(() => {
        // Nothing to show: the count simply stays until the next visit.
      });
    return () => controller.abort();
    // `badge.data` is not a dependency: the effect should fire on a rise in
    // `unseen`, and on first mount before the badge has answered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, unseen, ctx.baseUrl, ctx.token, queryClient]);
}

export function useToggleAutomation() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { automationId: string; enabled: boolean }) =>
      updateAutomation(input.automationId, { enabled: input.enabled }, ctx),
    onSuccess: () => {
      // The server recomputes next_run_at on every save, so the whole list is
      // refetched rather than the one row patched in place.
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
    },
  });
}

/**
 * Which CLI runs an automation, and on which model. Null for either means the
 * default — the first installed agent, and that agent's own default model.
 *
 * Both go in one mutation because they are one decision: the server clears a
 * stored model when the agent changes under it, so a UI that patched them
 * separately would show a model the run will not use.
 */
export function useSetAutomationAgent() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      automationId: string;
      agentId?: string | null;
      model?: string | null;
    }) =>
      updateAutomation(
        input.automationId,
        { agentId: input.agentId, model: input.model },
        ctx,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
    },
  });
}

/**
 * Enqueue a run. The 202 says "queued", not "finished": runs are serialized one
 * at a time server-side, so the outcome arrives through the run list — which is
 * why this invalidates it rather than reporting a result of its own.
 */
export function useRunAutomationNow() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (automationId: string) => runAutomationNow(automationId, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["automation-runs"] });
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
    },
  });
}
