/**
 * The Hunter adapter: company discovery through Discover, and the people at a
 * domain through Domain Search.
 *
 * It exists because Apollo was the only way to find somebody Boxaide did not
 * already hold, so an install with a Hunter key and no Apollo key could verify
 * an address it was given and never find one of its own. Hunter indexes the
 * same two questions from the other end.
 *
 * Four Hunter facts shape this file.
 *
 * Discover is free and answers with almost nothing: a domain, a company name,
 * and how many addresses Hunter holds there. No headcount, no industry, no
 * head office, no LinkedIn. Those fields come back null rather than guessed,
 * and the count Hunter does give is the useful one, because it says which of
 * these domains a people search would find anybody at.
 *
 * Discover's structured filters are enums, and a value outside one is a 400
 * rather than a narrower search. So keywords and locations are passed as
 * Hunter's own natural-language `query` and the result says they were matched
 * loosely. Only the filters that cannot be mistyped are sent structured:
 * domains, company name, and the headcount buckets.
 *
 * Domain Search needs a domain. There is no "everybody with this title
 * anywhere" question here, which is the one thing Apollo can answer and this
 * cannot: without orgDomains the call is refused before any HTTP.
 *
 * There is no reveal. Domain Search returns the whole name and the address in
 * the one call, so `reveal` is not a second paid step here and every row comes
 * back revealed. Hunter counts a request only when a call returns at least one
 * result, so an empty search costs nothing.
 *
 * Domain Search's own `limit` is plan-dependent in a way the parameter table
 * does not say: it defaults to 10 and goes to 100, but Hunter's error list has
 * `pagination_error` as "The supplied `limit` or `offset` is invalid. This
 * error can also be returned if the `limit` additioned to the `offset` is
 * higher than 10 for a Free plan user." A free-plan install therefore cannot
 * ask for eleven people at one domain. The asked-for limit is still sent,
 * because clamping every install to 10 would spend a paid plan's request on a
 * tenth of the page it is entitled to; the free plan is found out by asking,
 * and the one call that fails is retried at 10.
 */
import { bareDomain } from "../domain.js";
import {
  PROSPECTING_TIMEOUT_MS,
  type CompanyQuery,
  type CompanySearchResult,
  type PeopleQuery,
  type PeopleSearchResult,
  type ProspectCompany,
  type ProspectEmailStatus,
  type ProspectingProvider,
  type ProspectPerson,
} from "./types.js";

const DISCOVER_URL = "https://api.hunter.io/v2/discover";
const DOMAIN_SEARCH_URL = "https://api.hunter.io/v2/domain-search";

/**
 * Domains one people search will visit. Domain Search takes one domain per
 * call and bills per call that finds anybody, so a list of fifty domains is
 * fifty requests off the operator's plan. Past this the extra domains are
 * reported in the notes rather than searched.
 */
export const HUNTER_DOMAIN_LIMIT = 5;

/**
 * The most one Domain Search call may ask for on a free plan. Hunter's own
 * number, from the `pagination_error` description, not a guess.
 */
export const HUNTER_FREE_PLAN_PAGE = 10;

/** Hunter's headcount buckets, in order. Discover accepts these strings only. */
const HEADCOUNT_BUCKETS: readonly { label: string; min: number; max: number }[] = [
  { label: "1-10", min: 1, max: 10 },
  { label: "11-50", min: 11, max: 50 },
  { label: "51-200", min: 51, max: 200 },
  { label: "201-500", min: 201, max: 500 },
  { label: "501-1000", min: 501, max: 1000 },
  { label: "1001-5000", min: 1001, max: 5000 },
  { label: "5001-10000", min: 5001, max: 10_000 },
  { label: "10001+", min: 10_001, max: Number.MAX_SAFE_INTEGER },
];

/**
 * Apollo's eleven seniority bands folded into Hunter's three.
 *
 * The two vocabularies are not the same shape and the fold is lossy in one
 * direction that matters: Apollo's 'vp' and 'founder' are both 'executive'
 * here, so a search for one finds the other. The tool description says so.
 */
const SENIORITY_MAP: Record<string, string> = {
  owner: "executive",
  founder: "executive",
  c_suite: "executive",
  partner: "executive",
  vp: "executive",
  head: "senior",
  director: "senior",
  manager: "senior",
  senior: "senior",
  entry: "junior",
  intern: "junior",
};

export class HunterProspectingProvider implements ProspectingProvider {
  readonly id = "hunter" as const;
  /** Domain Search hands over the address in the search itself. */
  readonly revealCostsPerPerson = false;

  constructor(private readonly apiKey: string) {}

  /**
   * One page of companies from Discover. The limit is not sent: Discover's own
   * limit defaults to 100 and can only be changed on a Premium plan, so a body
   * carrying `limit` is a 4xx on every free-plan install rather than a narrower
   * page. Hunter's 100 is taken and cut to the asked-for size here, which costs
   * nothing extra because Discover bills per call, not per row.
   */
  async findCompanies(query: CompanyQuery, limit: number): Promise<CompanySearchResult> {
    const body: Record<string, unknown> = {};
    const organization: Record<string, unknown> = {};
    const domains = domainList(query.domains);
    if (domains.length) organization.domain = domains;
    if (query.name) organization.name = [query.name];
    if (Object.keys(organization).length) body.organization = organization;
    const buckets = headcountBuckets(query.minEmployees, query.maxEmployees);
    if (buckets.length) body.headcount = buckets;
    const asked = naturalQuery(query);
    if (asked) body.query = asked;

    const payload = await this.post(DISCOVER_URL, body, "discover");
    const rows = objects(payload.data);
    const meta = record(payload.meta);
    const notes = [
      "Hunter answered this, not Apollo. Discover returns a company name, a domain and how many addresses Hunter holds there, and nothing else: industry, headcount, location and linkedinUrl are null because Hunter did not say, not because the company has none.",
    ];
    if (asked) {
      notes.push(
        `Keywords and locations were matched as the plain-language question "${asked}", because Hunter's structured filters take fixed values only. Treat that part of the filter as approximate and check the companies before you write to anybody there.`,
      );
    }
    return {
      provider: this.id,
      companies: rows.slice(0, limit).map(normaliseDiscovered),
      total: numberOf(meta.results) ?? rows.length,
      returned: Math.min(rows.length, limit),
      notes,
    };
  }

  /**
   * The people at each named domain. One Hunter call per domain, the limit
   * split between them, and the address arrives with the row.
   */
  async findPeople(query: PeopleQuery, limit: number): Promise<PeopleSearchResult> {
    const domains = domainList(query.orgDomains);
    if (!domains.length) {
      throw new Error(
        "Hunter finds people at a domain you name, so orgDomains is required. Run prospect_find_companies first and pass the domains it returned. A title-only search across every company is an Apollo question, and Apollo is not configured here.",
      );
    }
    const searched = domains.slice(0, HUNTER_DOMAIN_LIMIT);
    const perDomain = Math.max(1, Math.floor(limit / searched.length));
    const notes: string[] = [
      "Hunter answered this, not Apollo. Every row carries the whole name and the address already, so nothing here was locked behind a reveal and 'reveal' changed nothing.",
    ];
    if (query.organizationIds?.length) {
      notes.push(
        "organizationIds were ignored: those are Apollo's own ids and Hunter does not know them. Only orgDomains narrowed this search.",
      );
    }
    if (query.locations?.length || query.keywords) {
      notes.push(
        "The person-location and keywords filters were ignored: Hunter's domain search filters on job title and seniority only. Read the titles that came back rather than trusting the filter you asked for.",
      );
    }

    const people: ProspectPerson[] = [];
    let total = 0;
    let visited = 0;
    // Dropped to Hunter's free-plan page the first time it refuses the size
    // asked for, so the domains after that one ask for a size this plan takes
    // rather than failing the same way again.
    let pageSize = perDomain;
    let planCapped = false;
    for (const domain of searched) {
      // Hunter bills a request the moment it returns anybody, and the rows past
      // the limit are thrown away below. So the domain that would only produce
      // discarded rows is never asked for.
      if (people.length >= limit) break;
      visited += 1;
      const ask = (size: number): Promise<Record<string, unknown>> => {
        const params = new URLSearchParams({
          domain,
          api_key: this.apiKey,
          limit: String(size),
          // Generic addresses are info@ and sales@: a mailbox, not a person,
          // and the outreach chain writes to people.
          type: "personal",
        });
        const titles = list(query.titles);
        if (titles.length) params.set("job_titles", titles.join(","));
        const seniorities = hunterSeniorities(query.seniorities);
        if (seniorities.length) params.set("seniority", seniorities.join(","));
        return this.get(`${DOMAIN_SEARCH_URL}?${params}`, "domain search");
      };

      let payload: Record<string, unknown>;
      try {
        payload = await ask(pageSize);
      } catch (err) {
        // Only Hunter's own pagination_error, by id. A retry on anything else
        // would be a second billed call for a failure that will repeat.
        if (!isPaginationError(err) || pageSize <= HUNTER_FREE_PLAN_PAGE) throw err;
        pageSize = HUNTER_FREE_PLAN_PAGE;
        planCapped = true;
        payload = await ask(pageSize);
      }
      const data = record(payload.data);
      const meta = record(payload.meta);
      const orgName = text(data.organization);
      total += numberOf(meta.results) ?? 0;
      for (const row of objects(data.emails)) {
        people.push(normaliseHunterPerson(row, orgName, domain));
      }
    }

    if (planCapped) {
      notes.push(
        `This Hunter plan takes at most ${HUNTER_FREE_PLAN_PAGE} people per domain in one request, so each domain was asked again for ${HUNTER_FREE_PLAN_PAGE} instead of the ${perDomain} it was first asked for. Fewer people here does not mean fewer people work there. Search a domain on its own to spend the whole limit on it, or upgrade the Hunter plan.`,
      );
    }

    if (domains.length > visited) {
      // Two different reasons stop the walk, and an agent reading "not searched"
      // needs to know which: a budget it can spend more of by asking again, or a
      // limit it already filled.
      const why =
        visited < searched.length
          ? `the ${limit} people asked for were already found and each further domain is a separate billed Hunter request`
          : "each domain is a separate Hunter request";
      notes.push(
        `Searched the first ${visited} of ${domains.length} domains, because ${why}. The rest were not searched: ${domains.slice(visited).join(", ")}. Ask again with those to cover them.`,
      );
    }

    return {
      provider: this.id,
      people: people.slice(0, limit),
      total,
      returned: Math.min(people.length, limit),
      // Every row arrived open. Reporting them as revealed is the true count
      // of people an agent can write to, and it cost no per-person credit.
      revealed: Math.min(people.length, limit),
      notes,
    };
  }

  private async get(url: string, what: string): Promise<Record<string, unknown>> {
    return this.call(url, { method: "GET", headers: { accept: "application/json" } }, what);
  }

  private async post(
    url: string,
    body: Record<string, unknown>,
    what: string,
  ): Promise<Record<string, unknown>> {
    // Discover takes the key as a query parameter like the rest of the v2 API,
    // so the body stays the filter and nothing else.
    const withKey = `${url}?api_key=${encodeURIComponent(this.apiKey)}`;
    return this.call(
      withKey,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      },
      what,
    );
  }

  private async call(
    url: string,
    init: RequestInit,
    what: string,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), PROSPECTING_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`hunter ${what} timed out after ${PROSPECTING_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    } finally {
      clearTimeout(deadline);
    }
    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (!res.ok) throw httpError(what, res.status, raw, []);
      throw new Error(`hunter ${what} returned a body that is not JSON`);
    }
    if (!res.ok) throw httpError(what, res.status, detailOf(parsed) ?? raw, errorIdsOf(parsed));
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`hunter ${what} returned a body that is not JSON`);
    }
    return parsed as Record<string, unknown>;
  }
}

/**
 * A failure Hunter named. The message is what an operator reads; the ids are
 * what the code branches on, because Hunter's wording is prose that can change
 * and its error ids are the documented contract.
 */
class HunterError extends Error {
  constructor(
    message: string,
    readonly ids: readonly string[],
  ) {
    super(message);
    this.name = "HunterError";
  }
}

/** Hunter refused the page size, by its own error id. */
function isPaginationError(err: unknown): boolean {
  return err instanceof HunterError && err.ids.includes("pagination_error");
}

/** The message an operator reads, plus the ids the code reads. */
function httpError(what: string, status: number, detail: string, ids: readonly string[]): Error {
  return new HunterError(httpMessage(what, status, detail), ids);
}

/** The message an operator reads. It never carries the key. */
function httpMessage(what: string, status: number, detail: string): string {
  const tail = detail.trim().slice(0, 200);
  if (status === 401) {
    return `hunter ${what} was refused (HTTP 401): the Hunter key was rejected. Check the key under Settings > Connectors. ${tail}`;
  }
  if (status === 403) {
    return `hunter ${what} was refused (HTTP 403): the Hunter plan does not include this endpoint, or the request rate was exceeded. Do not retry this call immediately. ${tail}`;
  }
  if (status === 429) {
    return `hunter ${what} hit the usage limit (HTTP 429): this Hunter plan has no requests left. ${tail}`;
  }
  if (status === 451) {
    return `hunter ${what} was refused for legal reasons (HTTP 451): Hunter suppresses this record on privacy grounds. That is a decision about the record, not a fault to retry. ${tail}`;
  }
  return `hunter ${what} failed (HTTP ${status}): ${tail}`;
}

/** Hunter reports its own failures as an errors array with a details string. */
function detailOf(parsed: unknown): string | null {
  const body = record(parsed);
  const errors = objects(body.errors);
  const details = errors.map((entry) => text(entry.details)).filter(Boolean);
  return details.length ? details.join("; ") : null;
}

/** The ids beside those details. These are Hunter's documented names. */
function errorIdsOf(parsed: unknown): string[] {
  return objects(record(parsed).errors)
    .map((entry) => text(entry.id))
    .filter((id): id is string => id !== null);
}

/** One Discover row. Everything Hunter did not say is null, never guessed. */
function normaliseDiscovered(row: Record<string, unknown>): ProspectCompany {
  const counts = record(row.emails_count);
  return {
    name: text(row.organization) ?? "",
    domain: bareDomain(text(row.domain)) ?? text(row.domain),
    industry: null,
    headcount: null,
    location: null,
    linkedinUrl: null,
    apolloOrgId: null,
    contactsKnown: numberOf(counts.personal) ?? numberOf(counts.total) ?? null,
  };
}

/** One Domain Search row: a whole person, address included. */
function normaliseHunterPerson(
  row: Record<string, unknown>,
  orgName: string | null,
  domain: string,
): ProspectPerson {
  const email = emailOf(row.value);
  const first = text(row.first_name);
  const last = text(row.last_name);
  const fullName = joinName(first, last);
  const title = text(row.position) ?? text(row.position_raw);
  const person: ProspectPerson = {
    fullName,
    firstName: first,
    lastName: last,
    title,
    orgName,
    orgDomain: domain,
    linkedinUrl: text(row.linkedin),
    email,
    emailStatus: emailStatusOf(email, record(row.verification)),
    revealed: true,
    apolloPersonId: null,
  };
  const named = {
    ...(fullName ? { name: fullName } : {}),
    ...(title ? { title } : {}),
    ...(orgName ? { org: orgName } : {}),
    orgDomain: domain,
  };
  if (email) {
    person.crmContact = { email, ...named };
  } else {
    person.crmContactPendingEmail = named;
    if (fullName) person.enrichFindEmail = { fullName, orgDomain: domain };
  }
  return person;
}

/**
 * Hunter's own verification of the address it just gave.
 *
 * Only its 'valid' becomes 'verified'. Everything else, its 'accept_all' and
 * its unchecked rows alike, is 'unverified': the address is real enough to
 * carry forward, and the outreach chain verifies before it queues anyway.
 * 'locked' never applies here, because Hunter has no address it will not show.
 */
function emailStatusOf(
  email: string | null,
  verification: Record<string, unknown>,
): ProspectEmailStatus {
  if (!email) return "absent";
  return text(verification.status)?.toLowerCase() === "valid" ? "verified" : "unverified";
}

function emailOf(value: unknown): string | null {
  const address = text(value);
  if (!address || !address.includes("@")) return null;
  return address.toLowerCase();
}

/**
 * Keywords and locations as one plain-language question, which is the form
 * Discover takes them in. Nothing is invented: the words are the operator's.
 */
function naturalQuery(query: CompanyQuery): string | null {
  const parts: string[] = [];
  const keywords = list(query.keywords);
  if (keywords.length) parts.push(keywords.join(" "));
  parts.push("companies");
  const locations = list(query.locations);
  if (locations.length) parts.push(`in ${locations.join(" or ")}`);
  const excluded = list(query.excludeLocations);
  if (excluded.length) parts.push(`not in ${excluded.join(" or ")}`);
  if (!keywords.length && !locations.length && !excluded.length) return null;
  return parts.join(" ");
}

/** Every bucket the asked-for range touches. Hunter takes the labels only. */
function headcountBuckets(min: number | undefined, max: number | undefined): string[] {
  if (min === undefined && max === undefined) return [];
  const low = Math.max(1, Math.floor(min ?? 1));
  const high = Math.max(low, Math.floor(max ?? Number.MAX_SAFE_INTEGER));
  return HEADCOUNT_BUCKETS.filter((b) => b.min <= high && b.max >= low).map((b) => b.label);
}

/** Apollo's bands folded into Hunter's, deduplicated, unknown values dropped. */
function hunterSeniorities(values: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const value of list(values)) {
    const key = value.toLowerCase().replace(/[\s-]+/g, "_");
    const mapped = SENIORITY_MAP[key] ?? (key === "executive" || key === "junior" ? key : null);
    if (mapped) out.add(mapped);
  }
  return [...out];
}

function joinName(first: string | null, last: string | null): string | null {
  const whole = [first, last].filter(Boolean).join(" ").trim();
  return whole === "" ? null : whole;
}

function list(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value).trim()).filter((value) => value !== "");
}

/** Bare hosts, as Apollo's adapter does, so a pasted URL still matches. */
function domainList(values: string[] | undefined): string[] {
  return list(values).map((value) => bareDomain(value) ?? value.toLowerCase());
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

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
