/**
 * Automation MCP tools. Surface: docs/specs/agent-platform.md.
 * automation_create's description must teach the agent to write the prompt
 * as instructions to a future, context-free agent run.
 */
import type { Platform, ToolDef } from "../platform.js";

export const AUTOMATION_TOOLS: ToolDef[] = [
  // TODO(automation): automation_create, automation_update, automation_delete,
  // automations_list, automation_run_now, automation_runs_list.
];

export const AUTOMATION_TOOL_NAMES: ReadonlySet<string> = new Set(
  AUTOMATION_TOOLS.map((t) => t.name),
);

export async function dispatchAutomationTool(
  _platform: Platform,
  name: string,
  _args: Record<string, unknown>,
): Promise<unknown> {
  // TODO(automation)
  throw new Error(`unknown tool: ${name}`);
}
