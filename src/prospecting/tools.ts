/**
 * Prospecting MCP tools: find companies, and find people at them.
 *
 * This is the gap these two close. enrich_find_email is a lookup: it wants a
 * name and a domain you already have. Nothing here needs either. "Who is the
 * VP of Sales at acme.com" and "find SaaS companies in Belgium with 10 to 50
 * staff" are questions only a prospecting index can answer.
 *
 * Both tools spend the operator's money, so both descriptions say what they
 * cost and what they are not for. A discovered prospect is not permission to
 * mail them: the outreach module still owns the queue, the suppression list,
 * and the human approval step.
 *
 * The dispatcher takes a structural platform rather than the full Platform
 * type so this module compiles on its own. Wiring supplies the real object.
 */
import type { ToolDef } from "../platform.js";
import { APOLLO_SENIORITIES } from "./apollo.js";
import type { ProspectingService } from "./service.js";
import {
  DEFAULT_COMPANY_LIMIT,
  DEFAULT_PEOPLE_LIMIT,
  MAX_COMPANY_LIMIT,
  MAX_PEOPLE_LIMIT,
  PROSPECT_REVEAL_LIMIT,
} from "./service.js";

/** The slice of Platform this module needs. Wiring adds the field. */
export type ProspectingPlatform = {
  prospectingService: ProspectingService;
};

/**
 * Stated on both tools, in the words the enrichment tools already use. An
 * agent that reads a list of found people as a list of people to write to is
 * the failure this module has to design against.
 */
const NOT_A_SEND_LICENCE =
  "Finding a prospect does not permit mailing them. Queue anything you want sent with outbox_queue_draft, which a human approves.";

export const PROSPECTING_TOOLS: ToolDef[] = [
  {
    name: "prospect_find_companies",
    description:
      `Find companies that match a description, when you do not yet know which companies they are. Filter on keywords for the industry, on head office location, on employee count, or on a list of domains you already hold. Returns each company as name, domain, industry, headcount, location, linkedinUrl and apolloOrgId, plus a total saying how many matched before the limit. The domain is the useful part: pass it to crm_org_upsert to keep the company, or to prospect_find_people to find who works there. This is a paid search against Apollo and costs one credit per call whatever it returns, so give real filters and read the result rather than calling it again with the same ones. At most ${MAX_COMPANY_LIMIT} companies per call, default ${DEFAULT_COMPANY_LIMIT}; Apollo cannot page past 50,000 records, so a question like 'every company in Europe' has no answer here and needs narrowing. When 'notes' is not empty, carry it into whatever you report: it says when Apollo truncated the result or suppressed EU records, which otherwise looks like a thin answer. Never present a noted result as a complete one. ${NOT_A_SEND_LICENCE}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description:
            "Industry or keyword tags, e.g. ['saas', 'logistics']. This is the industry filter; there is no separate one.",
        },
        name: {
          type: "string",
          description: "Company name, partial match. Use it to look one company up.",
        },
        domains: {
          type: "array",
          items: { type: "string" },
          description:
            "Company domains such as 'acme.com', to look up companies you already hold. Bare domains, not website URLs.",
        },
        locations: {
          type: "array",
          items: { type: "string" },
          description:
            "Head office locations, e.g. ['Belgium', 'California, US']. This is where the company is, not where its staff are.",
        },
        excludeLocations: {
          type: "array",
          items: { type: "string" },
          description: "Head office locations to leave out.",
        },
        minEmployees: { type: "number", description: "Fewest employees, e.g. 10." },
        maxEmployees: { type: "number", description: "Most employees, e.g. 50." },
        limit: {
          type: "number",
          description: `How many companies to return. Default ${DEFAULT_COMPANY_LIMIT}, maximum ${MAX_COMPANY_LIMIT}. Values outside that range are clamped, not refused.`,
          default: DEFAULT_COMPANY_LIMIT,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "prospect_find_people",
    description:
      `Find the people who hold a job at companies you name, when you do not yet know who they are, such as 'the VP of Sales at acme.com'. Filter on orgDomains plus titles or seniorities. This runs in two steps and you must know which one you are getting. The search itself is free and deliberately incomplete: it gives a first name, a job title and an employer, no last name, no address and no company domain, and each such person comes back with fullName null, revealed false and emailStatus 'locked' or 'absent'. Never report one of those as a named prospect; say you found a title at a company and offer to open it. There is no way to open a result you already have. Setting reveal true is a fresh search that spends Apollo credits, one to nine per person, and returns at most ${PROSPECT_REVEAL_LIMIT} people who need not be the same ones a free search returned, each with fullName, orgDomain, linkedinUrl and the address. So when you already intend to write to these people, pass reveal true on the first call with the same filters, and use the free search only to check that the filters find the right kind of person. A revealed person with an address also carries 'crmContact', which is exactly the arguments crm_contact_upsert wants, so pass that object straight on rather than copying fields. When emailStatus is 'locked' or 'absent' after a reveal, the record carries 'enrichFindEmail' instead, which is exactly the arguments enrich_find_email wants, and 'crmContactPendingEmail', which is the same contact minus the address: call enrich_find_email with the first, then give crm_contact_upsert the second with the address it returned added. Never pass crmContactPendingEmail on its own, because a contact is keyed by an address and there is not one yet. At most ${MAX_PEOPLE_LIMIT} people per call without reveal, default ${DEFAULT_PEOPLE_LIMIT}; with reveal true the call is capped at ${PROSPECT_REVEAL_LIMIT} people, because that half is the one that bills. When 'notes' is not empty, carry it into whatever you report, and never present a noted result as a complete one: it says when Apollo truncated the result, suppressed EU records, or refused part of a paid reveal. ${NOT_A_SEND_LICENCE}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        orgDomains: {
          type: "array",
          items: { type: "string" },
          description:
            "Employer domains such as ['acme.com']. This is the 'at acme.com' filter. Bare domains, not website URLs and not a person's address.",
        },
        organizationIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Apollo organisation ids, taken from the apolloOrgId field of a prospect_find_companies result.",
        },
        titles: {
          type: "array",
          items: { type: "string" },
          description:
            "Job titles, e.g. ['sales director', 'director of sales']. Matched loosely unless exactTitles is set, so give the wordings you would accept.",
        },
        exactTitles: {
          type: "boolean",
          description:
            "Restricts titles to near-exact matches. Use it when a loose search returned the wrong department.",
        },
        seniorities: {
          type: "array",
          items: { type: "string", enum: [...APOLLO_SENIORITIES] },
          description:
            "Seniority bands. Anything outside the listed values is dropped rather than sent.",
        },
        locations: {
          type: "array",
          items: { type: "string" },
          description:
            "Where the person is, e.g. ['Belgium']. Not where their employer's head office is.",
        },
        keywords: {
          type: "string",
          description:
            "Free text matched across the person's record. The only way to reach an industry on a people search.",
        },
        reveal: {
          type: "boolean",
          description: `Spend Apollo credits to open the hits and get whole names and addresses. Default false. Capped at ${PROSPECT_REVEAL_LIMIT} people per call.`,
          default: false,
        },
        limit: {
          type: "number",
          description: `How many people to return. Default ${DEFAULT_PEOPLE_LIMIT}, maximum ${MAX_PEOPLE_LIMIT}, and at most ${PROSPECT_REVEAL_LIMIT} when reveal is true. Values outside the range are clamped, not refused.`,
          default: DEFAULT_PEOPLE_LIMIT,
        },
      },
      additionalProperties: false,
    },
  },
];

export const PROSPECTING_TOOL_NAMES: ReadonlySet<string> = new Set(
  PROSPECTING_TOOLS.map((t) => t.name),
);

export async function dispatchProspectingTool(
  platform: ProspectingPlatform,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const service = platform.prospectingService;

  switch (name) {
    case "prospect_find_companies":
      return service.findCompanies({
        keywords: strList(args.keywords),
        name: str(args.name),
        domains: strList(args.domains),
        locations: strList(args.locations),
        excludeLocations: strList(args.excludeLocations),
        minEmployees: num(args.minEmployees),
        maxEmployees: num(args.maxEmployees),
        limit: num(args.limit),
      });

    case "prospect_find_people":
      return service.findPeople({
        orgDomains: strList(args.orgDomains),
        organizationIds: strList(args.organizationIds),
        titles: strList(args.titles),
        exactTitles: args.exactTitles === true,
        seniorities: strList(args.seniorities),
        locations: strList(args.locations),
        keywords: str(args.keywords),
        reveal: args.reveal === true,
        limit: num(args.limit),
      });
  }

  throw new Error(`unknown tool: ${name}`);
}

/** Trimmed string, or undefined when the argument was absent or blank. */
function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

/**
 * A list of trimmed strings. A single string is accepted as a list of one:
 * models pass "acme.com" for an array field often enough that refusing it
 * costs a round trip and teaches nothing.
 */
function strList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const out = raw.map((entry) => String(entry).trim()).filter((entry) => entry !== "");
  return out.length === 0 ? undefined : out;
}

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
