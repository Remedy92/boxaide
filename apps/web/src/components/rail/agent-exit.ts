import type { LocalAgentExit, RunningLocalAgent } from "@/lib/api/endpoints";

/**
 * Whether an agent row should say it exited.
 *
 * Read off `reason`, never the exit code. A driven agent (Claude Code) has no
 * process exit to report, and a long-lived child that was asked to stop dies on
 * a signal with no code — so "code !== 0" called Stop a crash on some CLIs and a
 * clean stop on others, for the same click.
 *
 * Scoped the same way it always was: a crash belongs to the agent it happened
 * to, and only until the next start replaces it.
 */
export function agentExitedBadly(
  agentId: string,
  state: { running: RunningLocalAgent | null; lastExit: LocalAgentExit | null },
): boolean {
  if (state.running) return false;
  if (state.lastExit?.id !== agentId) return false;
  return state.lastExit.reason !== "stopped";
}
