/**
 * Enrichment MCP tools. Surface: docs/specs/agent-platform.md.
 *
 * Every tool here spends the operator's money or writes to the CRM, so each
 * description says what it costs and what it is not for. Finding an address is
 * not permission to mail it: the outreach module still owns the queue, the
 * suppression list, and the human approval step.
 *
 * The dispatcher takes a structural platform rather than the full Platform
 * type so this module compiles on its own. Wiring supplies the real object.
 */
import type { ToolDef } from "../platform.js";
import type { EnrichmentService } from "./service.js";
import { MAX_IMPORT_ROWS } from "./csv.js";

/** The slice of Platform this module needs. Wiring adds the field. */
export type EnrichmentPlatform = {
  enrichmentService: EnrichmentService;
};

/**
 * Stated on both lookup tools. An agent that thinks a found address is a green
 * light to send is the failure this module has to design against.
 */
const NOT_A_SEND_LICENCE =
  "Finding or verifying an address does not permit mailing it. Queue anything you want sent with outbox_queue_draft, which a human approves.";

export const ENRICHMENT_TOOLS: ToolDef[] = [
  {
    name: "enrich_find_email",
    description:
      `Find the work email address for one person at one organisation domain. Give either fullName, or firstName and lastName, plus orgDomain. Returns the address with a confidence from 0 to 100, a status of 'valid', 'risky', 'unknown' or 'invalid', and which provider answered. This is a paid lookup against an external provider, so call it once per person and use crm_contact_upsert to keep what you learn. Do not call it to check an address you already hold; enrich_verify_email is the cheaper tool for that. ${NOT_A_SEND_LICENCE}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        fullName: {
          type: "string",
          description: "Whole name, when the parts are not separated.",
        },
        firstName: { type: "string" },
        lastName: { type: "string" },
        orgDomain: {
          type: "string",
          description:
            "Organisation domain such as 'acme.com'. Not a website URL, and not the person's own address.",
        },
      },
      required: ["orgDomain"],
      additionalProperties: false,
    },
  },
  {
    name: "enrich_verify_email",
    description:
      `Check whether one address is deliverable before anything is queued to it. Returns the same shape as enrich_find_email: confidence 0 to 100, a status of 'valid', 'risky', 'unknown' or 'invalid', and the provider. A 'risky' status means a catch-all domain that accepts anything, so the address is unproven rather than good. This is a paid lookup; the answer is cached for a day, and a repeat call inside that day costs nothing. ${NOT_A_SEND_LICENCE}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        email: { type: "string", description: "One address to check." },
      },
      required: ["email"],
      additionalProperties: false,
    },
  },
  {
    name: "crm_contacts_import",
    description:
      `Import contacts into the CRM from CSV text. The first line is a header; 'email' is required and 'name', 'title', 'org', 'orgDomain' and 'tags' are optional. Quoted fields and commas inside quotes are handled. Addresses that are not addresses are skipped, repeats of an earlier line are skipped, and every skip comes back with its line number and reason. At most ${MAX_IMPORT_ROWS} rows per call: a longer file is refused outright, so split it rather than expecting a partial import. Nothing here contacts anyone.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        csv: {
          type: "string",
          description: "The whole CSV document, header line included.",
        },
      },
      required: ["csv"],
      additionalProperties: false,
    },
  },
];

export const ENRICHMENT_TOOL_NAMES: ReadonlySet<string> = new Set(
  ENRICHMENT_TOOLS.map((t) => t.name),
);

/**
 * Tools that reach a third party and bill the operator for it. Hand-written,
 * the way src/calendar/tools.ts writes its send set, so a new tool cannot
 * become a free-for-all by being forgotten. The local set is derived from it.
 */
export const ENRICHMENT_PAID_TOOL_NAMES: ReadonlySet<string> = new Set([
  "enrich_find_email",
  "enrich_verify_email",
]);

export const ENRICHMENT_LOCAL_TOOL_NAMES: ReadonlySet<string> = new Set(
  ENRICHMENT_TOOLS.map((t) => t.name).filter(
    (name) => !ENRICHMENT_PAID_TOOL_NAMES.has(name),
  ),
);

export async function dispatchEnrichmentTool(
  platform: EnrichmentPlatform,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const service = platform.enrichmentService;

  switch (name) {
    case "enrich_find_email": {
      const result = await service.findEmail({
        firstName: str(args.firstName),
        lastName: str(args.lastName),
        fullName: str(args.fullName),
        domain: str(args.orgDomain) ?? "",
      });
      return { result: publicResult(result) };
    }

    case "enrich_verify_email": {
      const result = await service.verifyEmail(str(args.email) ?? "");
      return { result: publicResult(result) };
    }

    case "crm_contacts_import": {
      const outcome = service.importContacts(str(args.csv) ?? "");
      return {
        imported: outcome.imported,
        importedCount: outcome.imported.length,
        skipped: outcome.skipped,
      };
    }
  }

  throw new Error(`unknown tool: ${name}`);
}

/**
 * The provider's own body is kept on the result for debugging but never
 * returned: it is a page of vendor JSON that would fill an agent's context
 * without telling it anything the four normalised fields do not.
 */
function publicResult(result: {
  email: string | null;
  confidence: number;
  status: string;
  provider: string;
}) {
  return {
    email: result.email,
    confidence: result.confidence,
    status: result.status,
    provider: result.provider,
  };
}

/** Trimmed string, or undefined when the argument was absent or blank. */
function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}
