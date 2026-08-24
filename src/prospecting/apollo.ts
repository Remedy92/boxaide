/**
 * The Apollo adapter: company search, people search, and the reveal that
 * turns a search hit into a person with a name and an address.
 *
 * Three Apollo facts shape this file.
 *
 * People search is free and returns almost nothing. The last name comes back
 * as "Hu***n", there is no address, no company domain and no profile link,
 * and the organisation sub-object is a set of has_* availability booleans
 * rather than values. So `has_email: true` means "Apollo holds an address,
 * pay to see it" and is mapped to the 'locked' status, never to an address.
 *
 * Revealing costs credits, one to nine per person, and is the only call that
 * produces a whole name. The phone and waterfall flags are deliberately never
 * sent: both deliver asynchronously and demand a public webhook URL that a
 * self-hosted Boxaide will not have, and the phone reveal is the eight-credit
 * line item.
 *
 * The endpoint paths are hardcoded and never configurable. Apollo deprecated
 * /mixed_people/search and /people/search for API callers, and those paths now
 * answer 403 rather than saying they are gone.
 *
 * Keys are read per call by the service, not held here beyond one request.
 */
import {
  probeRequest,
  unreachable,
  verdictForStatus,
  type ConnectorProbeResult,
} from "../connectors/probe.js";
import { bareDomain } from "../domain.js";
import {
  apolloRequest,
  type CompanyQuery,
  type CompanySearchResult,
  type PeopleQuery,
  type PeopleSearchResult,
  type ProspectCompany,
  type ProspectEmailStatus,
  type ProspectingProvider,
  type ProspectPerson,
} from "./types.js";

const PEOPLE_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_people/api_search";
const PEOPLE_MATCH_URL = "https://api.apollo.io/api/v1/people/match";
const COMPANY_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_companies/search";

/**
 * Apollo's placeholder for an address it will not show. It is a syntactically
 * valid address at a domain that does not exist, so anything that treats it as
 * one mails nowhere and burns a sending reputation doing it.
 */
const LOCKED_EMAIL = /email_not_unlocked/i;

/** Seniority values Apollo accepts. Anything else is dropped, not sent. */
export const APOLLO_SENIORITIES: readonly string[] = [
  "owner",
  "founder",
  "c_suite",
  "partner",
  "vp",
  "head",
  "director",
  "manager",
  "senior",
  "entry",
  "intern",
];

export class ApolloProvider implements ProspectingProvider {
  readonly id = "apollo" as const;
  /** Apollo bills one to nine credits for each person it opens. */
  readonly revealCostsPerPerson = true;

  constructor(private readonly apiKey: string) {}

  /**
   * One page of companies. One page only: Apollo bills a credit per page even
   * when the page comes back empty, so a loop over pages is a way to spend
   * money on nothing. The per-page maximum of 100 is also this tool's cap.
   */
  async findCompanies(query: CompanyQuery, limit: number): Promise<CompanySearchResult> {
    const body: Record<string, unknown> = { page: 1, per_page: limit };
    if (query.name) body.q_organization_name = query.name;
    const keywords = list(query.keywords);
    if (keywords.length) body.q_organization_keyword_tags = keywords;
    const domains = domainList(query.domains);
    if (domains.length) body.q_organization_domains_list = domains;
    const locations = list(query.locations);
    if (locations.length) body.organization_locations = locations;
    const excluded = list(query.excludeLocations);
    if (excluded.length) body.organization_not_locations = excluded;
    const range = employeeRange(query.minEmployees, query.maxEmployees);
    if (range) body.organization_num_employees_ranges = [range];

    const payload = await this.post(COMPANY_SEARCH_URL, body, "company search");
    const rows = objects(payload.organizations);
    const pagination = record(payload.pagination);
    return {
      provider: this.id,
      companies: rows.slice(0, limit).map(normaliseCompany),
      total: numberOf(pagination.total_entries) ?? rows.length,
      returned: Math.min(rows.length, limit),
      notes: notesFor(payload),
    };
  }

  /**
   * One page of people, free of credits, and optionally the paid reveal of
   * each hit. Unrevealed hits keep their first name and title and nothing
   * else: see the header for why the last name is dropped rather than shown.
   */
  async findPeople(
    query: PeopleQuery,
    limit: number,
    revealLimit: number,
  ): Promise<PeopleSearchResult> {
    const body: Record<string, unknown> = { page: 1, per_page: limit };
    const domains = domainList(query.orgDomains);
    if (domains.length) body.q_organization_domains_list = domains;
    const orgIds = list(query.organizationIds);
    if (orgIds.length) body.organization_ids = orgIds;
    const titles = list(query.titles);
    if (titles.length) body.person_titles = titles;
    if (query.exactTitles) body.include_similar_titles = false;
    const seniorities = list(query.seniorities)
      .map((value) => value.toLowerCase().replace(/[\s-]+/g, "_"))
      .filter((value) => APOLLO_SENIORITIES.includes(value));
    if (seniorities.length) body.person_seniorities = seniorities;
    const locations = list(query.locations);
    if (locations.length) body.person_locations = locations;
    if (query.keywords) body.q_keywords = query.keywords;

    const payload = await this.post(PEOPLE_SEARCH_URL, body, "people search");
    const pagination = record(payload.pagination);
    const rows = objects(payload.people).slice(0, limit);
    const notes = notesFor(payload);
    let people = rows.map(normaliseSearchHit);

    let revealed = 0;
    if (query.reveal) {
      const opened: ProspectPerson[] = [];
      let stopped: string | null = null;
      for (const person of people) {
        // The cap counts reveals, not rows. Counting rows would let a run of
        // hits with no Apollo id, which cost nothing because they cannot be
        // opened at all, use up the credits the caller asked to spend.
        if (stopped || revealed >= revealLimit || !person.apolloPersonId) {
          opened.push(person);
          continue;
        }
        try {
          opened.push(await this.reveal(person.apolloPersonId));
          revealed += 1;
        } catch (err) {
          // Every reveal before this one was paid for. Throwing here would
          // throw those away too, and the agent's next move is to ask for the
          // same people again and pay a second time. So the ones that opened
          // are returned, the rest stay as search hits, and the note says so.
          stopped = err instanceof Error ? err.message : String(err);
          opened.push(person);
        }
      }
      people = opened;
      if (stopped) {
        notes.push(
          `Revealed ${revealed} of ${people.length} people, then Apollo refused the rest: ${stopped} The people already revealed are in this result and were paid for, so do not run this search again to get them. The rest carry a first name and a job title and no address.`,
        );
      } else if (revealed < rows.length) {
        notes.push(
          `Revealed ${revealed} of ${rows.length} hits; the rest carry a first name and a job title and no address.`,
        );
      }
    }

    return {
      provider: this.id,
      people,
      total:
        numberOf(pagination.total_entries) ?? numberOf(payload.total_entries) ?? rows.length,
      returned: people.length,
      revealed,
      notes,
    };
  }

  /** One person opened by Apollo id. This is the call that spends credits. */
  async reveal(apolloPersonId: string): Promise<ProspectPerson> {
    const payload = await this.post(PEOPLE_MATCH_URL, { id: apolloPersonId }, "reveal");
    const person = record(payload.person);
    return normaliseRevealed(person, apolloPersonId);
  }

  /**
   * One POST, with the error text an operator can act on.
   *
   * A 403 is the one worth spelling out: Apollo answers it both for a key
   * scoped to other endpoints and for a plan that does not expose this one,
   * and neither is fixed by trying again.
   */
  private async post(
    url: string,
    body: Record<string, unknown>,
    what: string,
  ): Promise<Record<string, unknown>> {
    const res = await apolloRequest(url, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw httpError(what, url, res.status, res.body, res.headers);
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error(`apollo ${what} returned a body that is not JSON`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`apollo ${what} returned a body that is not JSON`);
    }
    return parsed as Record<string, unknown>;
  }
}

/** The message an operator reads. It never carries the key or a whole body. */
function httpError(
  what: string,
  url: string,
  status: number,
  body: string,
  headers: Headers,
): Error {
  const detail = body.trim().slice(0, 200);
  if (status === 401) {
    return new Error(
      `apollo ${what} was refused (HTTP 401): the Apollo key was rejected. Check the key under Settings > Connectors. ${detail}`,
    );
  }
  if (status === 403) {
    return new Error(
      `apollo ${what} was refused (HTTP 403): the Apollo key is scoped to other endpoints, or the plan does not expose ${url}. Give the key the scope for this endpoint in Apollo, or use a master key. Do not retry this call. ${detail}`,
    );
  }
  if (status === 429) {
    const retry = headers.get("retry-after");
    const left = headers.get("x-minute-requests-left");
    const wait = retry ? ` Retry after ${retry}s.` : "";
    const remaining = left === null ? "" : ` Requests left this minute: ${left}.`;
    return new Error(
      `apollo ${what} hit the rate limit (HTTP 429).${wait}${remaining} ${detail}`,
    );
  }
  return new Error(`apollo ${what} failed (HTTP ${status}): ${detail}`);
}

/**
 * The flags Apollo sets instead of failing. A truncated result set and a
 * suppressed EU one both look like a thin answer, and a European operator
 * reading "0 companies" deserves to be told which of the two it was.
 */
function notesFor(payload: Record<string, unknown>): string[] {
  const pagination = record(payload.pagination);
  const notes: string[] = [];
  const partial = payload.partial_results_only ?? pagination.partial_results_only;
  if (partial === true) {
    const cap = numberOf(payload.partial_results_limit ?? pagination.partial_results_limit);
    notes.push(
      `Apollo returned partial results${cap ? ` and caps this account at ${cap} records` : ""}, so the count is a floor, not the whole match.`,
    );
  }
  const euOff = payload.disable_eu_prospecting ?? pagination.disable_eu_prospecting;
  if (euOff === true) {
    notes.push(
      "This Apollo account has EU prospecting disabled, so records for people and companies in the EU are suppressed. A thin or empty result for a European query is that setting, not an absence of matches.",
    );
  }
  return notes;
}

function normaliseCompany(row: Record<string, unknown>): ProspectCompany {
  return {
    name: text(row.name) ?? "",
    domain: bareDomain(text(row.primary_domain) ?? text(row.website_url)),
    industry: text(row.industry),
    headcount: numberOf(row.estimated_num_employees) ?? null,
    location: placeOf(row),
    linkedinUrl: text(row.linkedin_url),
    apolloOrgId: text(row.id),
  };
}

/**
 * A free search hit. first_name and title are the whole of what is knowable
 * without paying, and last_name_obfuscated is deliberately never read: there
 * is no field on ProspectPerson a mask could honestly go in.
 */
function normaliseSearchHit(row: Record<string, unknown>): ProspectPerson {
  const org = record(row.organization);
  return {
    fullName: null,
    firstName: text(row.first_name),
    lastName: null,
    title: text(row.title),
    orgName: text(org.name),
    orgDomain: null,
    linkedinUrl: text(row.linkedin_url),
    email: null,
    emailStatus: row.has_email === true ? "locked" : "absent",
    revealed: false,
    apolloPersonId: text(row.id),
  };
}

/** A revealed person. The only path that can produce a whole name. */
function normaliseRevealed(
  person: Record<string, unknown>,
  fallbackId: string,
): ProspectPerson {
  const org = record(person.organization);
  const first = text(person.first_name);
  const last = text(person.last_name);
  const raw = text(person.email);
  const email = realEmail(raw);
  const status = emailStatusOf(email, text(person.email_status), raw !== null);
  const orgName = text(org.name) ?? text(person.organization_name);
  const orgDomain = bareDomain(text(org.primary_domain) ?? text(org.website_url));
  const out: ProspectPerson = {
    fullName: text(person.name) ?? joinName(first, last),
    firstName: first,
    lastName: last,
    title: text(person.title),
    orgName,
    orgDomain,
    linkedinUrl: text(person.linkedin_url),
    email,
    emailStatus: status,
    revealed: true,
    apolloPersonId: text(person.id) ?? fallbackId,
  };
  const named = {
    ...(out.fullName ? { name: out.fullName } : {}),
    ...(out.title ? { title: out.title } : {}),
    ...(orgName ? { org: orgName } : {}),
    ...(orgDomain ? { orgDomain } : {}),
  };
  if (email) {
    out.crmContact = { email, ...named };
  } else {
    // No address, so no contact yet: the CRM is keyed by one. What the agent
    // gets instead is the half it already has, under a name that cannot be
    // mistaken for a call it can make, plus the arguments for the lookup that
    // fills the other half.
    out.crmContactPendingEmail = named;
    if (out.fullName && orgDomain) {
      out.enrichFindEmail = { fullName: out.fullName, orgDomain };
    }
  }
  return out;
}

/** An address, or null when Apollo sent its locked placeholder instead. */
function realEmail(value: string | null): string | null {
  if (!value || !value.includes("@")) return null;
  if (LOCKED_EMAIL.test(value)) return null;
  return value.toLowerCase();
}

/**
 * A non-empty value that is not an address is Apollo's locked placeholder, so
 * it is reported as locked and never as nothing: an agent told 'absent' would
 * stop looking, when the address exists and costs a credit.
 */
function emailStatusOf(
  email: string | null,
  status: string | null,
  hadValue: boolean,
): ProspectEmailStatus {
  if (!email) return hadValue ? "locked" : "absent";
  return status?.toLowerCase() === "verified" ? "verified" : "unverified";
}

function joinName(first: string | null, last: string | null): string | null {
  const whole = [first, last].filter(Boolean).join(" ").trim();
  return whole === "" ? null : whole;
}

/** "City, State, Country" from whichever parts the record held. */
function placeOf(row: Record<string, unknown>): string | null {
  const parts = [text(row.city), text(row.state), text(row.country)].filter(Boolean);
  return parts.length === 0 ? null : parts.join(", ");
}

/** Apollo wants headcount as one "min,max" string. */
function employeeRange(min: number | undefined, max: number | undefined): string | null {
  if (min === undefined && max === undefined) return null;
  const low = Math.max(1, Math.floor(min ?? 1));
  const high = Math.max(low, Math.floor(max ?? 1_000_000));
  return `${low},${high}`;
}

function list(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value).trim()).filter((value) => value !== "");
}

/**
 * Domains are bare hosts to Apollo, so a pasted URL is trimmed down first.
 *
 * A value bareDomain refuses is sent as written rather than dropped. An empty
 * list means "no domain filter" at the call site, and Apollo answers a search
 * with no filters by billing a credit for a page of the whole database, so
 * folding `["acme"]` to `[]` would silently turn the narrowest question an
 * agent can ask into the widest and most expensive one. A domain that is not
 * one simply matches nothing, which is the honest answer to it.
 */
function domainList(values: string[] | undefined): string[] {
  return list(values).map((value) => bareDomain(value) ?? value.toLowerCase());
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A number, or null. null and "" are not zero: Apollo sends
 * estimated_num_employees: null for a company it has no headcount for, and
 * Number(null) is 0, which would report that company as having no staff.
 */
function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => {
    return typeof entry === "object" && entry !== null;
  });
}

/**
 * Is this Apollo key one Apollo accepts?
 *
 * One page of one person from the free people search, which is the cheapest
 * authenticated thing Apollo will answer: people search spends no credits, and
 * asking for a single row keeps even the response small. Company search is not
 * used here because Apollo bills a credit per page of it, empty or not.
 *
 * A 403 counts as refused like a 401 does. Apollo answers 403 for a key scoped
 * to other endpoints and for a plan that does not expose this one, and neither
 * is a key an agent could go on to use.
 */
export async function probeApollo(
  apiKey: string,
  doFetch?: typeof globalThis.fetch,
): Promise<ConnectorProbeResult> {
  const reply = await probeRequest(
    PEOPLE_SEARCH_URL,
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ page: 1, per_page: 1 }),
    },
    doFetch,
  );
  if (!reply.reached) return unreachable(reply.reason);
  return verdictForStatus(reply.status, reply.body);
}
