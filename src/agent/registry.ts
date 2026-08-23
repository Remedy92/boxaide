/**
 * Every agent CLI Boxaide knows how to start, in the order it prefers them.
 *
 * The order is the whole of "first available": a run with no agent named
 * takes the first entry here that is installed and can run unattended, so it
 * has to be fixed rather than incidental.
 */
import { ANTIGRAVITY_SPEC } from "./clis/antigravity.js";
import { CLAUDE_SPEC } from "./clis/claude.js";
import { CODEX_SPEC } from "./clis/codex.js";
import { GROK_SPEC } from "./clis/grok.js";
import { OPENCODE_SPEC } from "./clis/opencode.js";
import type { AgentSpec } from "./spec.js";

export const KNOWN_AGENTS: AgentSpec[] = [
  CLAUDE_SPEC,
  GROK_SPEC,
  ANTIGRAVITY_SPEC,
  OPENCODE_SPEC,
  CODEX_SPEC,
];
