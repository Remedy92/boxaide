"use client";

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listLocalAgents,
  startLocalAgent,
  stopLocalAgent,
  type LocalAgent,
  type RunningLocalAgent,
} from "@/lib/api/endpoints";
import { friendlyError } from "@/lib/api/errors";
import { useApiCtx, useSettings } from "@/lib/hooks/use-settings";

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
    mutationFn: ({ id, model }: { id: string; model?: string }) =>
      startLocalAgent(id, ctx, model),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["local-agents"] });
    },
  });
}

/**
 * The model id to hand a start, or nothing. Only an agent that offers the id
 * gets it; the others start on their own default rather than failing the
 * launch on a model they have never heard of.
 */
export function modelForStart(
  agent: LocalAgent,
  agentModel: string,
): string | undefined {
  return agent.models.some((m) => m.id === agentModel) ? agentModel : undefined;
}

/**
 * The agent the composer's picker points at: the stored choice while the server
 * still offers it, otherwise whatever is running. Falling back to the running
 * one matters on a browser that never picked — the pane should name the agent
 * that is actually answering, not "none".
 */
export function usePickedAgent(): {
  picked: LocalAgent | null;
  running: RunningLocalAgent | null;
  model: string | undefined;
} {
  const agents = useLocalAgents();
  const { agentId, agentModel } = useSettings();
  const all = agents.data?.agents ?? [];
  const running = agents.data?.running ?? null;
  const stored = all.find((a) => a.id === agentId && a.available) ?? null;
  const picked =
    stored ?? (running ? (all.find((a) => a.id === running.id) ?? null) : null);
  return {
    picked,
    running,
    model: picked ? modelForStart(picked, agentModel) : undefined,
  };
}

/**
 * Start the picked agent, unless one is already running.
 *
 * Called on send, AFTER the message is posted. That order is the safe one: a
 * message posted with nobody listening is queued on the server and handed over
 * the moment an agent starts, so there is nothing to wait for here.
 */
export function useEnsureAgentRunning(): () => void {
  const { picked, running, model } = usePickedAgent();
  const start = useStartLocalAgent();
  const pending = start.isPending;
  return useCallback(() => {
    if (running || pending || !picked || !picked.supported) return;
    start.mutate(
      { id: picked.id, model },
      {
        onError: (err) =>
          toast.error(
            friendlyError(err instanceof Error ? err.message : String(err)),
          ),
      },
    );
  }, [picked, running, model, pending, start]);
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
