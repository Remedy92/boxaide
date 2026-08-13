"use client";

import { useQuery } from "@tanstack/react-query";
import { getCrmPipeline } from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * The whole board in one request: stages in board order, each already carrying
 * its deals in board order. There is one pipeline (the spec puts multi-pipeline
 * out of scope), so this is a single query key with no parameters.
 */
export function useCrmPipeline(enabled = true) {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["crm-pipeline", ctx.baseUrl, ctx.token],
    enabled: enabled && ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => getCrmPipeline({ ...ctx, signal }),
    staleTime: 30_000,
  });
}
