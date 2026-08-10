"use client";

import { useQuery } from "@tanstack/react-query";
import { getApiHealth, getHealth } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/errors";
import { HEALTH_TIMEOUT_MS } from "@/lib/constants";
import { useApiCtx } from "@/lib/hooks/use-settings";

/**
 * Abort a probe that hangs; an 8s wait is already past the point of useful.
 *
 * The timer is cleared in `finally`, not on the controller's abort event: a
 * probe that SUCCEEDS aborts nothing, so an abort-only cleanup left one live
 * timer behind every 15–30s poll, each of them firing later to abort an
 * already-settled controller.
 */
async function withTimeout<T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Unauthenticated reachability. It sends no Authorization header, so it needs
 * no preflight — that is exactly what separates "the box is down" from "the
 * token is wrong" (§7.2 vs §7.3).
 */
export function useHealth() {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["health", ctx.baseUrl],
    enabled: ctx.baseUrl.length > 0,
    queryFn: ({ signal }) =>
      withTimeout(signal, (timed) => getHealth({ ...ctx, signal: timed })),
    staleTime: 30_000,
    retry: false,
    // §7.2: keep probing while unreachable, and recover silently.
    refetchInterval: (query) => (query.state.error ? 15_000 : 30_000),
    refetchOnWindowFocus: true,
  });
}

/** Authenticated. A 401 here means the token is wrong and must never retry. */
export function useApiHealth() {
  const ctx = useApiCtx();
  return useQuery({
    queryKey: ["api-health", ctx.baseUrl, ctx.token],
    enabled: ctx.baseUrl.length > 0 && ctx.token.length > 0,
    queryFn: ({ signal }) => getApiHealth({ ...ctx, signal }),
    staleTime: 30_000,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 401) && count < 1,
    refetchOnWindowFocus: true,
  });
}
