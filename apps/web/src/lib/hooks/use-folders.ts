"use client";

import { useQuery } from "@tanstack/react-query";
import { listFolders } from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * Folders are per mailbox. `GET /api/folders` 400s on `account=all` and there
 * is no cross-account folder list, so the query is disabled rather than fired
 * and caught.
 */
export function useFolders(accountRef: string) {
  const ctx = useApiCtx();
  const enabled =
    ctx.baseUrl.length > 0 &&
    ctx.token.length > 0 &&
    accountRef.length > 0 &&
    accountRef !== "all";
  return useQuery({
    queryKey: ["folders", ctx.baseUrl, ctx.token, accountRef],
    enabled,
    queryFn: ({ signal }) => listFolders(accountRef, { ...ctx, signal }),
    staleTime: 5 * 60_000,
  });
}
