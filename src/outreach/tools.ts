/**
 * Outreach MCP tools. Surface: docs/specs/agent-platform.md.
 *
 * Deliberately absent, forever: approve/reject/send tools. An agent must not
 * be able to approve its own email (spec invariant 1). Do not add them.
 */
import type { Platform, ToolDef } from "../platform.js";
import type { OutboxStatus } from "./store.js";

/**
 * Repeated on the one tool that gets agent-written mail moving. It is the
 * whole bargain of this module, so it is stated where the agent reads it.
 */
const QUEUE_DRAFT_DESC =
  "Queue one email for human review. This is the ONLY way an automation or agent gets outreach toward delivery; a human reviews it in the Boxaide Outreach view before anything is sent. Nothing here sends mail, and there is no tool that approves or sends a queued row — do not look for one. An opt-out footer is appended automatically.";

export const OUTREACH_TOOLS: ToolDef[] = [
  {
    name: "outbox_queue_draft",
    description: QUEUE_DRAFT_DESC,
    inputSchema: {
      type: "object" as const,
      properties: {
        account: { type: "string", description: "Sending account alias or id." },
        to: { type: "string", description: "One recipient address." },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text. No HTML, no links to trackers." },
        contactId: { type: "string", description: "CRM contact id, when known." },
      },
      required: ["account", "to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "outbox_list",
    description:
      "List queued outreach with decrypted subject and body. Use it to check what is still waiting for a human ('pending') or what already went out ('sent'). Reading is all an agent can do here.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["pending", "approved", "sent", "rejected", "failed"],
        },
        limit: { type: "number", default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "suppression_add",
    description:
      "Never contact this address again. Adding is one-way from here: removing an address is a human decision in the Outreach view. Use it the moment someone asks to be left alone.",
    inputSchema: {
      type: "object" as const,
      properties: {
        email: { type: "string" },
        reason: {
          type: "string",
          enum: ["reply-stop", "manual", "bounce", "agent"],
          default: "agent",
        },
      },
      required: ["email"],
      additionalProperties: false,
    },
  },
  {
    name: "suppression_list",
    description: "List every suppressed address with the reason and the date.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
];

export const OUTREACH_TOOL_NAMES: ReadonlySet<string> = new Set(
  OUTREACH_TOOLS.map((t) => t.name),
);

export async function dispatchOutreachTool(
  platform: Platform,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const store = platform.outreachStore;

  switch (name) {
    case "outbox_queue_draft": {
      const row = store.queueOutbox({
        accountId: String(args.account ?? ""),
        to: String(args.to ?? ""),
        subject: String(args.subject ?? ""),
        body: String(args.body ?? ""),
        contactId: args.contactId === undefined ? null : String(args.contactId),
      });
      return {
        queued: row,
        note: "pending human approval in the Boxaide Outreach view",
      };
    }

    case "outbox_list":
      return {
        outbox: store.listOutbox({
          status:
            args.status === undefined
              ? undefined
              : (String(args.status) as OutboxStatus),
          limit: Number(args.limit ?? 50),
        }),
      };

    case "suppression_add":
      return {
        suppressed: store.addSuppression(
          String(args.email ?? ""),
          String(args.reason ?? "agent"),
        ),
      };

    case "suppression_list":
      return { suppression: store.listSuppression() };
  }

  throw new Error(`unknown tool: ${name}`);
}
