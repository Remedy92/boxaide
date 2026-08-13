/** Matches PRESENCE_WINDOW_MS in src/agent/channel.ts. */
export const SEEN_FRESH_MS = 40_000;

/** `Xs` under a minute, else `Xm YYs` with zero-padded seconds. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return whole < 60
    ? `${whole}s`
    : `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

/** True when a live run has no last-seen stamp inside the presence window. */
export function workStale(lastSeenAt: string | null, now: number): boolean {
  if (lastSeenAt === null) return true;
  return now - Date.parse(lastSeenAt) >= SEEN_FRESH_MS;
}

export function stepsHeadline({
  running,
  lastSeenAt,
  toolLabel,
  stepCount,
  took,
  now,
}: {
  running: boolean;
  lastSeenAt: string | null;
  toolLabel: string | null;
  stepCount: number;
  took: number | null;
  now: number;
}): string {
  if (!running) {
    return `${stepCount} step${stepCount === 1 ? "" : "s"}${
      took === null ? "" : ` · ${took}s`
    }`;
  }
  if (lastSeenAt === null) return "No word from your agent";
  const seen = Date.parse(lastSeenAt);
  if (now - seen >= SEEN_FRESH_MS) {
    return `No word from your agent for ${formatClock((now - seen) / 1000)}`;
  }
  return toolLabel ? `Working — ${toolLabel}` : "Working";
}
