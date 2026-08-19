"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listLocalAgents,
  signInLocalAgent,
  startLocalAgent,
  stopLocalAgent,
  type LocalAgent,
  type RunningLocalAgent,
} from "@/lib/api/endpoints";
import { friendlyError, needsConfirmation, serverSentence } from "@/lib/api/errors";
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
 * The agent the composer's picker points at, in order of preference: the stored
 * choice while the server still offers it, then whatever is running, then the
 * first CLI on the machine this build can launch.
 *
 * Falling back to the running one matters on a browser that never picked — the
 * pane should name the agent that is actually answering, not "none". Falling
 * back again to the first installed one is what makes a send work out of the
 * box: nothing is stored until the user picks, and a send starts the pick, so
 * without a default the first question on a new machine would queue against an
 * agent nobody ever asked for. The default is not written to settings — it is
 * shown in the composer before the send, and an explicit pick still wins for
 * good.
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
    stored ??
    (running ? (all.find((a) => a.id === running.id) ?? null) : null) ??
    all.find((a) => a.available && a.supported) ??
    null;
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
 *
 * Asks the server before deciding, rather than reading the poll's last answer.
 * The poll is five seconds wide, and both edges of that window are wrong: an
 * agent that has just exited still reads as running, so the send that needed a
 * start would not do one, and an agent that has just started does not read as
 * running yet, so a second send would start it twice.
 */
export function useEnsureAgentRunning(): () => Promise<void> {
  const agents = useLocalAgents();
  const { picked, model } = usePickedAgent();
  const start = useStartLocalAgent();
  const pending = start.isPending;
  return React.useCallback(async () => {
    if (pending || !picked || !picked.supported) return;
    const fresh = await agents.refetch();
    if (fresh.data?.running) return;
    start.mutate(
      { id: picked.id, model },
      {
        onError: (err) => {
          // 409 is the launcher saying an agent is already running, which is
          // two sends racing into one start. The message is answered either
          // way, so there is nothing to tell the user about.
          if (needsConfirmation(err)) return;
          toast.error(
            friendlyError(err instanceof Error ? err.message : String(err)),
          );
        },
      },
    );
  }, [agents, picked, model, pending, start]);
}

/**
 * Sign the launched CLI back in.
 *
 * The request only opens Terminal on the server's machine; the login happens
 * there, and the server restarts the agent itself when it lands. So there is
 * nothing to await — the wait ends when the existing poll reports something
 * running again, which is also what ends it if the user starts the agent by
 * hand instead.
 */
export function useAgentSignIn() {
  const ctx = useApiCtx();
  const agents = useLocalAgents();
  const running = agents.data?.running ?? null;
  // Which exit the ask was made against, so the wait ends by itself: a launch
  // clears `running`, and a second failure writes a new exit — either way the
  // state below stops matching, with no effect to unset it.
  const exitAt = agents.data?.lastExit?.at ?? "";
  const [askedFor, setAskedFor] = React.useState<string | null>(null);
  const signIn = useMutation({
    mutationFn: () => signInLocalAgent(ctx),
    onSuccess: () => setAskedFor(exitAt),
  });

  return {
    signIn: () => signIn.mutate(),
    /** Terminal is open and nothing has come back yet. */
    waiting: !running && (signIn.isPending || askedFor === exitAt),
    /** The server's own sentence — 501 on a machine with no Terminal to open. */
    error: signIn.error ? serverSentence(signIn.error) : null,
  };
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
