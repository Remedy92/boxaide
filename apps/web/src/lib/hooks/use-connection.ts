"use client";

import { useQuery } from "@tanstack/react-query";
import { getMeta } from "@/lib/api/endpoints";
import { ApiError, type FailureKind } from "@/lib/api/errors";
import { useApiHealth, useHealth } from "@/lib/hooks/use-health";
import { useApiCtx } from "@/lib/hooks/use-settings";
import { hostLabel } from "@/lib/settings";

/**
 * §7, resolved in one fixed order with first-match-wins. Every screen that
 * needs to explain why there is no mail reads this, so there is exactly one
 * place the precedence is decided.
 */
export type ConnectionState =
  | { kind: "no-base-url" }
  | { kind: "blocked"; failure: FailureKind; host: string; raw: string }
  | { kind: "unreachable"; host: string; raw: string }
  | { kind: "no-token"; host: string }
  | { kind: "unauthorized"; host: string; raw: string }
  | { kind: "ok"; host: string; fixture: boolean; version: string | null };

/** `tokenHint` is the first four characters plus an ellipsis — safe to show. */
export function useMeta() {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["meta", ctx.baseUrl, ctx.token],
    enabled: ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => getMeta({ ...ctx, signal }),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

const BLOCKED: ReadonlySet<FailureKind> = new Set([
  "cors",
  "lna-denied",
  "mixed-content",
  "forbidden-origin",
]);

export function useConnection(): ConnectionState {
  const ctx = useApiCtx();
  const health = useHealth();
  const apiHealth = useApiHealth();
  const host = hostLabel(ctx.baseUrl);

  if (!ctx.baseUrl) return { kind: "no-base-url" };

  if (health.error) {
    const error = health.error;
    const kind = error instanceof ApiError ? error.kind : "unreachable";
    const raw = error instanceof ApiError ? error.raw : String(error);
    if (BLOCKED.has(kind)) return { kind: "blocked", failure: kind, host, raw };
    return { kind: "unreachable", host, raw };
  }

  if (!ctx.token) return { kind: "no-token", host };

  if (apiHealth.error) {
    const error = apiHealth.error;
    const kind = error instanceof ApiError ? error.kind : "unknown";
    const raw = error instanceof ApiError ? error.raw : String(error);
    if (kind === "unauthorized") return { kind: "unauthorized", host, raw };
    if (BLOCKED.has(kind)) return { kind: "blocked", failure: kind, host, raw };
    return { kind: "unreachable", host, raw };
  }

  return {
    kind: "ok",
    host,
    fixture: health.data?.fixture ?? false,
    version: apiHealth.data?.version ?? null,
  };
}
