"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listAutomationRuns,
  listAutomations,
  runAutomationNow,
  updateAutomation,
} from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * The Automations view's reads and its two writes.
 *
 * There is no create hook: automations are authored by talking to the agent
 * (spec: Web UI), so this app can toggle one, run one now, and read what
 * happened — nothing else.
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
