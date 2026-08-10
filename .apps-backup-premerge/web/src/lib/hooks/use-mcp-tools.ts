"use client";

import { useMutation } from "@tanstack/react-query";
import { mcpToolsList } from "@/lib/api/endpoints";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * User-triggered only, never on load.
 *
 * POST /mcp is stateless: mcp/server.ts handles `initialize` and stores
 * nothing, mints no session id and records no call. A response proves the
 * endpoint answers with this token and shows what an agent would get. It never
 * means an agent is connected, and the UI must never say so.
 */
export function useMcpTools() {
  const ctx = useApiCtx();
  return useMutation({
    mutationFn: async () => {
      const response = await mcpToolsList(ctx);
      if (response.error) throw new Error(response.error.message);
      return response.result?.tools ?? [];
    },
  });
}
