"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listConnectors, setConnectorKey } from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * The provider keys behind enrichment and web search, read and written from
 * Settings.
 *
 * Nothing here is optimistic. A key that only looked saved is worse than one
 * that visibly failed: the next agent run would quietly fall back and nobody
 * would know why. The write refetches the list instead, so the panel always
 * shows what the server actually holds.
 */
export function useConnectors(enabled = true) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["connectors", ctx.baseUrl, ctx.token],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => listConnectors({ ...ctx, signal }),
    staleTime: 30_000,
  });
}

/** Saves a key, or clears the saved one when `apiKey` is empty. */
export function useSetConnectorKey() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; apiKey: string }) =>
      setConnectorKey(input.id, input.apiKey, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["connectors"] });
    },
  });
}
