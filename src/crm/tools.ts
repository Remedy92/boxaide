/**
 * CRM MCP tools. Tool list + dispatcher, concatenated into tools/list by
 * src/mcp/server.ts. Surface: docs/specs/agent-platform.md (MCP tool surface).
 * Description style: follow src/mcp/server.ts — say when NOT to use a tool.
 */
import type { Platform, ToolDef } from "../platform.js";

export const CRM_TOOLS: ToolDef[] = [
  // TODO(crm): crm_sync, crm_contacts_search, crm_contact_get,
  // crm_contact_upsert, crm_contact_delete, crm_note_add, crm_org_upsert,
  // crm_orgs_list, crm_interactions_list, crm_pipeline_get, crm_deal_upsert,
  // crm_deal_move, crm_deal_delete.
];

export const CRM_TOOL_NAMES: ReadonlySet<string> = new Set(
  CRM_TOOLS.map((t) => t.name),
);

export async function dispatchCrmTool(
  _platform: Platform,
  name: string,
  _args: Record<string, unknown>,
): Promise<unknown> {
  // TODO(crm)
  throw new Error(`unknown tool: ${name}`);
}
