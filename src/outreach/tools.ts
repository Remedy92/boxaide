/**
 * Outreach MCP tools. Surface: docs/specs/agent-platform.md.
 *
 * Deliberately absent, forever: approve/reject/send tools. An agent must not
 * be able to approve its own email (spec invariant 1). Do not add them.
 */
import type { Platform, ToolDef } from "../platform.js";

export const OUTREACH_TOOLS: ToolDef[] = [
  // TODO(outreach): campaign_create, campaign_update, campaigns_list,
  // campaign_add_contacts, outbox_queue_draft, outbox_list, suppression_add,
  // suppression_list.
];

export const OUTREACH_TOOL_NAMES: ReadonlySet<string> = new Set(
  OUTREACH_TOOLS.map((t) => t.name),
);

export async function dispatchOutreachTool(
  _platform: Platform,
  name: string,
  _args: Record<string, unknown>,
): Promise<unknown> {
  // TODO(outreach)
  throw new Error(`unknown tool: ${name}`);
}
