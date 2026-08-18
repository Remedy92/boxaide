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

/**
 * The narrower case: the last run died because the CLI is signed out.
 *
 * Same scoping as agentExitedBadly, and only ever set on top of it — a server
 * that does not send the field leaves this null and the row keeps saying
 * "exited". The exit is returned rather than a boolean because the chat pane
 * has no agent id in hand and needs to learn it from here.
 */
export function signedOutExit(state: {
  running: RunningLocalAgent | null;
  lastExit: LocalAgentExit | null;
}): LocalAgentExit | null {
  const exit = state.lastExit;
  if (!exit || !exit.authRequired) return null;
  return agentExitedBadly(exit.id, state) ? exit : null;
}

export function agentSignedOut(
  agentId: string,
  state: { running: RunningLocalAgent | null; lastExit: LocalAgentExit | null },
): boolean {
  return signedOutExit(state)?.id === agentId;
}
