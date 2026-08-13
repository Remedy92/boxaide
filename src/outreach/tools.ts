/**
 * Outreach MCP tools. Surface: docs/specs/agent-platform.md.
 *
 * Deliberately absent, forever: approve/reject/send tools. An agent must not
 * be able to approve its own email (spec invariant 1). Do not add them.
 */
import type { Platform, ToolDef } from "../platform.js";
import { readContacts } from "./crm-read.js";
import type { CampaignStatus, OutboxStatus, StepInput } from "./store.js";

/**
 * Repeated on the one tool that gets agent-written mail moving. It is the
 * whole bargain of this module, so it is stated where the agent reads it.
 */
const QUEUE_DRAFT_DESC =
  "Queue one email for human review. This is the ONLY way an automation or agent gets outreach toward delivery; a human reviews it in the mailmux Outreach view before anything is sent. Nothing here sends mail, and there is no tool that approves or sends a queued row — do not look for one. An opt-out footer is appended automatically.";

export const OUTREACH_TOOLS: ToolDef[] = [
  {
    name: "campaign_create",
    description:
      "Create an outreach campaign with its email sequence. The campaign starts as a draft and queues nothing until a human sets it active. Step 0 is the first email; every later step waits waitDays after the previous one. Subjects and bodies are templates: {{name}}, {{email}} and {{org}} are filled per contact.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Unique campaign name." },
        account: { type: "string", description: "Sending account alias or id." },
        steps: {
          type: "array",
          description: "Sequence in order; the first entry is the initial mail.",
          items: {
            type: "object",
            properties: {
              subject: { type: "string" },
              body: { type: "string", description: "Plain text. No HTML." },
              waitDays: {
                type: "number",
                description: "Days after the previous step. Ignored on step 0.",
                default: 0,
              },
            },
            required: ["subject", "body"],
          },
        },
      },
      required: ["name", "account", "steps"],
      additionalProperties: false,
    },
  },
  {
    name: "campaign_update",
    description:
      "Rename a campaign, change its status ('draft'|'active'|'paused'|'done'), or replace its steps. Steps can only be replaced while the campaign is still a draft — once contacts are moving through a sequence, rewriting it would send them mail nobody approved the campaign for.",
    inputSchema: {
      type: "object" as const,
      properties: {
        campaignId: { type: "string" },
        name: { type: "string" },
        status: {
          type: "string",
          enum: ["draft", "active", "paused", "done"],
        },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              subject: { type: "string" },
              body: { type: "string" },
              waitDays: { type: "number", default: 0 },
            },
            required: ["subject", "body"],
          },
        },
      },
      required: ["campaignId"],
      additionalProperties: false,
    },
  },
  {
    name: "campaigns_list",
    description:
      "List campaigns with their sending account, status, and contact counts per state (active, replied, opted_out, done, suppressed).",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "campaign_add_contacts",
    description:
      "Add CRM contacts (ids from crm_contacts_search) to a campaign. Suppressed addresses are refused and reported back, never quietly enrolled.",
    inputSchema: {
      type: "object" as const,
      properties: {
        campaignId: { type: "string" },
        contactIds: { type: "array", items: { type: "string" } },
      },
      required: ["campaignId", "contactIds"],
      additionalProperties: false,
    },
  },
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
        campaignId: { type: "string", description: "Campaign this belongs to, when any." },
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

function stepsOf(raw: unknown): StepInput[] {
  if (!Array.isArray(raw)) throw new Error("steps must be an array");
  return raw.map((entry) => {
    const step = (entry ?? {}) as Record<string, unknown>;
    if (!step.subject && !step.body) {
      throw new Error("each step needs a subject and a body");
    }
    return {
      subject: String(step.subject ?? ""),
      body: String(step.body ?? ""),
      waitDays: Number(step.waitDays ?? 0),
    };
  });
}

export async function dispatchOutreachTool(
  platform: Platform,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const store = platform.outreachStore;

  switch (name) {
    case "campaign_create": {
      const campaign = store.createCampaign({
        name: String(args.name ?? ""),
        accountId: String(args.account ?? ""),
        steps: stepsOf(args.steps),
      });
      return { campaign, steps: store.listSteps(campaign.id) };
    }

    case "campaign_update": {
      const id = String(args.campaignId ?? "");
      const campaign = store.updateCampaign(id, {
        name: args.name === undefined ? undefined : String(args.name),
        status:
          args.status === undefined
            ? undefined
            : (String(args.status) as CampaignStatus),
        steps: args.steps === undefined ? undefined : stepsOf(args.steps),
      });
      if (!campaign) throw new Error(`campaign not found: ${id}`);
      return { campaign, steps: store.listSteps(campaign.id) };
    }

    case "campaigns_list":
      return { campaigns: store.listCampaigns() };

    case "campaign_add_contacts": {
      const campaignId = String(args.campaignId ?? "");
      if (!store.getCampaign(campaignId)) {
        throw new Error(`campaign not found: ${campaignId}`);
      }
      const ids = Array.isArray(args.contactIds)
        ? args.contactIds.map((v) => String(v))
        : [];
      const contacts = readContacts(platform.crmStore.db, ids);
      const known = new Set(contacts.map((c) => c.id));
      const refused = contacts
        .filter((c) => store.isSuppressed(c.email))
        .map((c) => ({ contactId: c.id, email: c.email, reason: "suppressed" }));
      const refusedIds = new Set(refused.map((r) => r.contactId));
      const accepted = ids.filter(
        (id) => known.has(id) && !refusedIds.has(id),
      );
      const added = store.addCampaignContacts(campaignId, accepted);
      return {
        added,
        refused,
        unknown: ids.filter((id) => !known.has(id)),
      };
    }

    case "outbox_queue_draft": {
      const row = store.queueOutbox({
        accountId: String(args.account ?? ""),
        to: String(args.to ?? ""),
        subject: String(args.subject ?? ""),
        body: String(args.body ?? ""),
        contactId: args.contactId === undefined ? null : String(args.contactId),
        campaignId:
          args.campaignId === undefined ? null : String(args.campaignId),
      });
      return {
        queued: row,
        note: "pending human approval in the mailmux Outreach view",
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
