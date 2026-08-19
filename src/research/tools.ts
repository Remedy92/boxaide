/**
 * Research MCP tools: search the web, and read one page of it.
 *
 * Neither tool writes anything, anywhere. They are the module's whole agent
 * surface and they are reads by construction, so there is no approval step and
 * nothing here can reach a contact. What an agent does with the text afterwards
 * is governed by the module that does it: outreach still queues for a human.
 *
 * Surface and seams: docs/specs/agent-platform.md.
 */
import type { ToolDef } from "../platform.js";
import { MAX_PAGE_CHARS } from "./fetch-page.js";
import type { ResearchService } from "./service.js";
import { DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS } from "./service.js";

/**
 * The part an agent gets wrong without being told: search returns snippets an
 * index wrote, not the page. Stated on both tools so the pairing is obvious
 * from either one.
 */
const PAIRING_DESC =
  "web_search returns short snippets chosen by a search index, which are often enough to answer a question and are never enough to quote from. When the answer has to be exact, or the snippet is cut off mid-thought, call web_fetch on the url to read the page itself.";

/**
 * Structural typing rather than an import of Platform: this module is written
 * before platform.ts carries a researchService field, and the real Platform
 * satisfies this the moment the field lands. Nothing else in the object is
 * needed here, which is the honest signature anyway.
 */
export type ResearchPlatform = { researchService: ResearchService };

export const RESEARCH_TOOLS: ToolDef[] = [
  {
    name: "web_search",
    description: `Search the public web and get back ranked results: title, url, snippet, and a publication date when the index knows one. Use it for anything outside the user's own mail and CRM, such as what an organisation does, whether a company still exists, or recent news about a person you are about to write to. Do NOT use it to look up the user's own contacts, past mail or deals: crm_contacts_search and message_search know those and this does not. ${PAIRING_DESC}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "What to search for, phrased as you would type it into a search engine. One question per call; two topics in one query gets you results for neither.",
        },
        numResults: {
          type: "number",
          description: `How many results to return. Default ${DEFAULT_NUM_RESULTS}, maximum ${MAX_NUM_RESULTS}. Values outside that range are clamped, not refused.`,
          default: DEFAULT_NUM_RESULTS,
        },
        provider: {
          type: "string",
          description:
            "Which search back end to use. Omit this unless the user named one: with no value the first configured provider is used, which is what the operator set up.",
          enum: ["exa", "parallel"],
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "web_fetch",
    description: `Read one public web page and get its text back, with the markup, scripts and navigation stripped out. Use it to read a page a search result pointed at, or a link the user gave you. ${PAIRING_DESC} Only public http and https addresses are reachable: private, loopback and cloud metadata addresses are refused at every redirect hop, and so is anything that is not text, such as a PDF or an image. The text is capped at ${MAX_PAGE_CHARS.toLocaleString("en-GB")} characters and the response says whether it was cut, so do not treat a truncated page as the whole story.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description:
            "Absolute http or https URL, e.g. https://example.com/about. Take it from a web_search result or from the user, never from a guess at what a company's page might be called.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

export const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(
  RESEARCH_TOOLS.map((t) => t.name),
);

/**
 * Both tools reach a third party, so both are listed. Nothing in this module is
 * a local read, and a future tool here will not be either: the set is written
 * out by hand so adding one forces a decision about which profiles get it,
 * the same bargain src/calendar/tools.ts makes for its send tools.
 */
export const RESEARCH_EGRESS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "web_search",
  "web_fetch",
]);

export async function dispatchResearchTool(
  platform: ResearchPlatform,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const service = platform.researchService;
  switch (name) {
    case "web_search":
      return service.search({
        query: required(args, "query"),
        numResults: num(args, "numResults"),
        provider: str(args, "provider"),
      });

    case "web_fetch":
      return service.fetch(required(args, "url"));

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/** Trimmed string, or undefined when the argument was absent or blank. */
function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

function required(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (value === undefined) throw new Error(`${key} is required`);
  return value;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
