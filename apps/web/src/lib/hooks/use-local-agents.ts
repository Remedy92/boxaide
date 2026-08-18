"use client";

import type { LocalAgentAccess } from "@/lib/api/endpoints";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listLocalAgents,
  startLocalAgent,
  stopLocalAgent,
} from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * The launcher's world view: which agent CLIs exist on the server's machine,
 * which one is running, and how the last one died. Polled, not streamed — a
 * launched agent changes state on the order of seconds, and the poll also
 * catches an agent that exited on its own.
 */
const POLL_MS = 5_000;

export function useLocalAgents() {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["local-agents", ctx.baseUrl, ctx.token],
    enabled: ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => listLocalAgents({ ...ctx, signal }),
    refetchInterval: POLL_MS,
  });
}

export function useStartLocalAgent() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      model,
      access,
    }: {
      id: string;
      model?: string;
      access?: LocalAgentAccess;
    }) => startLocalAgent(id, ctx, model, access),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["local-agents"] });
    },
  });
}

export function useStopLocalAgent() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => stopLocalAgent(ctx),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["local-agents"] });
    },
  });
}
