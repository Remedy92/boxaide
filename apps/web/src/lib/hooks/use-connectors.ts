"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  checkConnector,
  listConnectors,
  setConnectorKey,
} from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { ConnectorsSnapshot } from "@/lib/types";

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

/**
 * Asks the provider whether one key works, and writes the verdict straight
 * into the cached list.
 *
 * Written in rather than refetched: the answer the server just gave is the
 * same answer a refetch would return, and a second round trip would leave the
 * row saying "checking" for longer than the check itself took. A refetch still
 * happens on the next mount, from the verdict the server stored.
 */
export function useCheckConnector() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => checkConnector(id, ctx),
    onSuccess: (result) => {
      queryClient.setQueryData<ConnectorsSnapshot>(
        ["connectors", ctx.baseUrl, ctx.token],
        (previous) =>
          previous === undefined
            ? previous
            : {
                connectors: previous.connectors.map((row) =>
                  row.id === result.connector.id ? result.connector : row,
                ),
                checks: { ...previous.checks, [result.connector.id]: result.check },
              },
      );
    },
  });
}
