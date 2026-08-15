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
  /* A live run means one agent took this message and has not answered — a
     claim this server wrote, not a guess. So silence downgrades the headline;
     it never contradicts the claim. "No connection" was the old copy and it
     was wrong twice over: nothing is connected in the first place (MCP is
     request/response), and the agent is usually mid-task. An agent Boxaide
     launched rarely gets here at all now, because its own output keeps the
     seen stamp fresh — see channel.noteAgentActivity. */
  if (lastSeenAt === null) return "Working — no update yet";
  const seen = Date.parse(lastSeenAt);
  if (now - seen >= SEEN_FRESH_MS) {
    return `Working — no update for ${formatClock((now - seen) / 1000)}`;
  }
  return toolLabel ? `Working — ${toolLabel}` : "Working";
}
