"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMemoryFile,
  listMemoryFiles,
  reviewMemoryFile,
  saveMemoryFile,
} from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/errors";
import { useApiCtx } from "@/lib/hooks/use-settings";
import type { MemoryFileDetail } from "@/lib/types";

/**
 * The agent's workspace notes: the reads behind Settings → What I remember,
 * and the one write a person has — correcting a line the agent got wrong.
 *
 * Nothing here is optimistic. A note that only looked saved would be read by
 * the next conversation unchanged, which is worse than a visible failure; the
 * save resolves and then writes its own answer into the caches.
 */

export function memoryFilesKey(baseUrl: string, token: string) {
  return ["memory-files", baseUrl, token] as const;
}

export function memoryFileKey(baseUrl: string, token: string, name: string) {
  return ["memory-file", baseUrl, token, name] as const;
}

/** Every note the agent keeps, index first. Cheap enough to open on a whim. */
export function useMemoryFiles(enabled = true) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: memoryFilesKey(ctx.baseUrl, ctx.token),
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => listMemoryFiles({ ...ctx, signal }),
    staleTime: 30_000,
  });
}

/**
 * One note's text.
 *
 * Unlike a message body this is NOT immutable — the agent may rewrite a topic
 * at any time — so a short staleTime rather than Infinity: coming back to a
 * file later refetches instead of serving yesterday's text for ever.
 */
export function useMemoryFile(name: string | null) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: memoryFileKey(ctx.baseUrl, ctx.token, name ?? ""),
    enabled: ctx.baseUrl.length > 0 && ctx.token.length > 0 && !!name,
    queryFn: ({ signal }) => getMemoryFile(name as string, { ...ctx, signal }),
    staleTime: 30_000,
    retry: (count, error) =>
      !(error instanceof ApiError && (error.status === 404 || error.status === 401)) &&
      count < 1,
  });
}

/**
 * Replaces one note's whole text. On success the saved content is written
 * into the detail cache — it IS what a refetch would return — so the editor
 * stops looking dirty without a round trip, and the list is invalidated so
 * the size and updated time come back true.
 */
export function useSaveMemoryFile() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; content: string }) =>
      saveMemoryFile(input.name, input.content, ctx),
    onSuccess: (_result, input) => {
      queryClient.setQueryData<MemoryFileDetail>(
        memoryFileKey(ctx.baseUrl, ctx.token, input.name),
        { name: input.name, content: input.content },
      );
      void queryClient.invalidateQueries({ queryKey: ["memory-files"] });
    },
  });
}

/**
 * "This reads right": marks the note as a person has seen it, which is what
 * lets a scheduled automation use it at all. Only the list carries review
 * state, so only the list is invalidated.
 */
export function useReviewMemoryFile() {
  const ctx = useApiCtx();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => reviewMemoryFile(name, ctx),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["memory-files"] });
    },
  });
}
