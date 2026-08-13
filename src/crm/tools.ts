/**
 * CRM MCP tools. Tool list + dispatcher, concatenated into tools/list by
 * src/mcp/server.ts. Surface: docs/specs/agent-platform.md (MCP tool surface).
 * Description style: follow src/mcp/server.ts — say when NOT to use a tool.
 */
import type { Platform, ToolDef } from "../platform.js";
import type { CrmStore, Organization } from "./store.js";
import { orgNameFor } from "./service.js";

const CONTACT_ID_DESC =
  "Contact id from crm_contacts_search or crm_contact_get. Not an email address.";

export const CRM_TOOLS: ToolDef[] = [
  {
    name: "crm_sync",
    description:
      "Derive contacts and interactions from the connected mailboxes now, and return how many were new. This already runs every ten minutes on its own, so call it only when the user just connected an account or explicitly asks for a refresh — not before every read, where it only adds latency.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "crm_contacts_search",
    description:
      "Search contacts by name, email address or organisation name, optionally narrowed to one tag. This is the way to find a contact id. It returns identity rows only — no notes, interactions or deals — so follow up with crm_contact_get when you need the history of one person. An empty query lists the most recently touched contacts.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free text matched against name, email and org name.",
        },
        tag: { type: "string", description: "Exact tag, case-sensitive." },
        limit: { type: "number", default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "crm_contact_get",
    description:
      "Read one contact in full: identity, organisation, tags, notes, recent mail interactions and deals. Pass contactId or email, not both. Returns an error when nobody matches — that is a real answer, not a reason to create the contact.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: CONTACT_ID_DESC },
        email: {
          type: "string",
          description: "Email address, matched case-insensitively.",
        },
        limit: {
          type: "number",
          description: "How many interactions to return, newest first.",
          default: 50,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "crm_contact_upsert",
    description:
      "Create a contact, or fill in details on one that already exists, keyed by email address. Use it for people the user tells you about; contacts that appear in mail are created by crm_sync on their own, so do not mirror an inbox by hand. Tags are added, never replaced. Passing `org` links the contact to that organisation, creating it when it is new.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string" },
        name: { type: "string" },
        title: { type: "string", description: "Job title." },
        org: {
          type: "string",
          description: "Organisation name. Created when unknown.",
        },
        orgDomain: {
          type: "string",
          description:
            "Mail domain of the organisation, e.g. 'acme.com'. Improves matching against orgs derived from mail.",
        },
        tags: { type: "array", items: { type: "string" } },
        source: { type: "string", default: "agent" },
      },
      required: ["email"],
      additionalProperties: false,
    },
  },
  {
    name: "crm_contact_delete",
    description:
      "Delete a contact together with its tags, notes and interaction history. This cannot be undone and the next crm_sync will recreate a bare contact if the person is still in the mailbox, so prefer a tag or a note when the user only wants the record set aside. Deals survive with an empty contact field.",
    inputSchema: {
      type: "object",
      properties: { contactId: { type: "string", description: CONTACT_ID_DESC } },
      required: ["contactId"],
      additionalProperties: false,
    },
  },
  {
    name: "crm_note_add",
    description:
      "Append a dated note to a contact. Notes are for what a person said or agreed, written for the user to read later. They are stored encrypted and never sent anywhere — this is not a way to message the contact.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: CONTACT_ID_DESC },
        text: { type: "string" },
      },
      required: ["contactId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "crm_org_upsert",
    description:
      "Create or rename an organisation. Give the domain whenever you know it: orgs derived from mail are keyed by domain, and one without a domain will not merge with them later.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        domain: { type: "string", description: "Mail domain, e.g. 'acme.com'." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "crm_orgs_list",
    description:
      "List every organisation with its domain. Use it to pick an orgId for a deal; to find people at a company, search their org name with crm_contacts_search instead.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "crm_interactions_list",
    description:
      "List one contact's mail interactions, newest first, with decrypted subject and snippet. These are derived summaries, not the mail itself — to read a full message body use message_get with the returned messageId.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: CONTACT_ID_DESC },
        limit: { type: "number", default: 50 },
      },
      required: ["contactId"],
      additionalProperties: false,
    },
  },
  {
    name: "crm_pipeline_get",
    description:
      "Read the whole deal board: every stage in order, each with its deals in board order. Call this before crm_deal_move so you use a stage id that exists.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "crm_deal_upsert",
    description:
      "Create a deal, or edit one by passing dealId. A new deal lands at the bottom of its stage, defaulting to 'lead'. Omitted fields are left as they are on an edit. To change only the stage or the board position, use crm_deal_move.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: {
          type: "string",
          description: "Edit this deal. Omit to create a new one.",
        },
        title: { type: "string" },
        contactId: { type: "string", description: CONTACT_ID_DESC },
        orgId: { type: "string", description: "Organisation id from crm_orgs_list." },
        stageId: {
          type: "string",
          description: "Stage id from crm_pipeline_get.",
          default: "lead",
        },
        value: { type: "number" },
        currency: { type: "string", description: "ISO code, e.g. 'EUR'." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "crm_deal_move",
    description:
      "Move a deal to another stage, optionally to a given index inside it. Position 0 is the top. Use this rather than crm_deal_upsert for stage changes: it renumbers both columns so the board keeps a stable order.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: { type: "string" },
        stageId: { type: "string", description: "Stage id from crm_pipeline_get." },
        position: {
          type: "number",
          description: "0-based index within the stage. Omit to append.",
        },
      },
      required: ["dealId", "stageId"],
      additionalProperties: false,
    },
  },
  {
    name: "crm_deal_delete",
    description:
      "Delete a deal permanently. A deal that ended is normally moved to the 'won' or 'lost' stage instead — that keeps the history the user wants to look back on, so only delete when they ask for the record to be gone.",
    inputSchema: {
      type: "object",
      properties: { dealId: { type: "string" } },
      required: ["dealId"],
      additionalProperties: false,
    },
  },
];

export const CRM_TOOL_NAMES: ReadonlySet<string> = new Set(
  CRM_TOOLS.map((t) => t.name),
);

export async function dispatchCrmTool(
  platform: Platform,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const store = platform.crmStore;
  switch (name) {
    case "crm_sync":
      return platform.crmService.syncFromMail();

    case "crm_contacts_search":
      return {
        contacts: store.searchContacts({
          query: str(args.query),
          tag: str(args.tag),
          limit: num(args.limit) ?? 50,
        }),
      };

    case "crm_contact_get": {
      const contactId = str(args.contactId);
      const email = str(args.email);
      if (!contactId && !email) {
        throw new Error("contactId or email is required");
      }
      const detail = store.contactDetail(
        { contactId, email },
        { interactionLimit: num(args.limit) ?? 50 },
      );
      if (!detail) throw new Error(`contact not found: ${contactId ?? email}`);
      return detail;
    }

    case "crm_contact_upsert": {
      const email = str(args.email);
      if (!email) throw new Error("email is required");
      const org = resolveOrgForContact(store, str(args.org), str(args.orgDomain));
      const contact = store.upsertContact({
        email,
        name: str(args.name),
        title: str(args.title),
        orgId: org?.id ?? null,
        source: str(args.source) ?? "agent",
        // A name the user dictated beats whatever a From header happened to
        // carry, so it replaces rather than losing the longest-name contest.
        force: true,
      });
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
      if (tags.length) store.addTags(contact.id, tags);
      return { contact: store.getContact(contact.id), tags: store.listTags(contact.id) };
    }

    case "crm_contact_delete": {
      const contactId = String(args.contactId ?? "");
      const deleted = store.deleteContact(contactId);
      if (!deleted) throw new Error(`contact not found: ${contactId}`);
      return { deleted };
    }

    case "crm_note_add": {
      const contactId = String(args.contactId ?? "");
      if (!store.getContact(contactId)) {
        throw new Error(`contact not found: ${contactId}`);
      }
      const text = str(args.text);
      if (!text) throw new Error("text is required");
      return { note: store.addNote(contactId, text) };
    }

    case "crm_org_upsert": {
      const orgName = str(args.name);
      if (!orgName) throw new Error("name is required");
      return { org: store.upsertOrg({ name: orgName, domain: str(args.domain) }) };
    }

    case "crm_orgs_list":
      return { orgs: store.listOrgs() };

    case "crm_interactions_list": {
      const contactId = String(args.contactId ?? "");
      if (!store.getContact(contactId)) {
        throw new Error(`contact not found: ${contactId}`);
      }
      return {
        interactions: store.listInteractions(contactId, num(args.limit) ?? 50),
      };
    }

    case "crm_pipeline_get":
      return { stages: store.pipeline() };

    case "crm_deal_upsert": {
      const dealId = str(args.dealId);
      const deal = store.upsertDeal({
        dealId,
        title: str(args.title) ?? undefined,
        contactId: patch(args.contactId),
        orgId: patch(args.orgId),
        stageId: str(args.stageId),
        value: args.value === undefined ? undefined : (num(args.value) ?? null),
        currency: patch(args.currency),
      });
      if (!deal) throw new Error(`deal not found: ${dealId}`);
      return { deal };
    }

    case "crm_deal_move": {
      const dealId = String(args.dealId ?? "");
      const deal = store.moveDeal(
        dealId,
        String(args.stageId ?? ""),
        num(args.position),
      );
      if (!deal) throw new Error(`deal not found: ${dealId}`);
      return { deal };
    }

    case "crm_deal_delete": {
      const dealId = String(args.dealId ?? "");
      const deleted = store.deleteDeal(dealId);
      if (!deleted) throw new Error(`deal not found: ${dealId}`);
      return { deleted };
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/**
 * The org a contact upsert should link, or null when no org was named.
 *
 * With a domain but no name, the caller is pointing at an org, not naming it —
 * so an existing org keeps its name (upsertOrg would rename it to whatever we
 * pass), and a new one gets the same derived name mail sync would have used,
 * never the raw domain string.
 */
export function resolveOrgForContact(
  store: CrmStore,
  name: string | undefined,
  domain: string | undefined,
): Organization | null {
  if (!name && !domain) return null;
  if (!name && domain) {
    const existing = store.getOrgByDomain(domain);
    if (existing) return existing;
  }
  return store.upsertOrg({
    name: name ?? orgNameFor(domain as string),
    domain: domain ?? null,
  });
}

/** Trimmed string, or undefined when the argument was absent or blank. */
function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

/**
 * Three-state field for a patch: absent means "leave it", an empty string or
 * null means "clear it". `str` cannot express the difference, and a deal whose
 * contact the user wants removed has to be able to say so.
 */
function patch(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
