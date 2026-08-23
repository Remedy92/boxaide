/**
 * Agent reasons, in words a person who never opened a terminal can read.
 *
 * The server writes one sentence per blocked agent, and that sentence names
 * paths, environment variables and config files because it is remediation: the
 * one place it has to be exact is the place someone is going to act on it. A
 * picker row is not that place. Most readers here only need to know whether
 * this agent is a choice right now.
 *
 * So the picker shows the short label and keeps the server's sentence on the
 * `title` tooltip, where the person who does want it can still reach it.
 */

/** Two or three words for a picker row. Null when nothing is wrong. */
export function shortAgentReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  // Keyed on the shape of the server's sentence, not on an exact match, so a
  // reworded remediation still lands on "Needs setup" rather than leaking.
  if (reason.includes("is not installed")) return "Not installed";
  if (reason.includes("cannot run automations yet")) return "Chat only";
  if (reason.includes("cannot be launched yet")) return "Automations only";
  return "Needs setup";
}

/** The same words inside a trigger label, as in "Antigravity (needs setup)". */
export function shortAgentSuffix(reason: string | null | undefined): string {
  const short = shortAgentReason(reason);
  return short === null ? "" : ` (${short.toLowerCase()})`;
}

/**
 * A server message rendered as prose. The reasons are written as sentences but
 * end without a stop, because they are also thrown as error strings.
 */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
