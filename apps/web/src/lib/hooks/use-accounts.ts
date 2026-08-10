"use client";

import { useQuery } from "@tanstack/react-query";
import { listAccounts } from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

export function useAccounts() {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["accounts", ctx.baseUrl, ctx.token],
    enabled: ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => listAccounts({ ...ctx, signal }),
    staleTime: 5 * 60_000,
  });
}
