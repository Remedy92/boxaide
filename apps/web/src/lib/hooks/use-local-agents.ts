"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listLocalAgents,
  signInLocalAgent,
  startLocalAgent,
  stopLocalAgent,
} from "@/lib/api/endpoints";
import { serverSentence } from "@/lib/api/errors";
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
    mutationFn: ({ id, model }: { id: string; model?: string }) =>
      startLocalAgent(id, ctx, model),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["local-agents"] });
    },
  });
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
