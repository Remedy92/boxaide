/**
 * Prospecting types: the two normalised shapes an agent ever sees, the seam
 * both vendors implement, and the one HTTP helper the Apollo adapter calls.
 *
 * Two adapters sit behind this seam. Apollo answers every question and bills
 * per page and per revealed person; Hunter answers the domain-shaped half of
 * them and hands the address over in the search itself. Which one answered is
 * on every result as `provider`, because the two have different blind spots
 * and an agent reporting a thin answer should be able to say whose it was.
 *
 * Apollo's own records are enormous and two of its endpoints disagree about
 * what a person is. A search hit carries an obfuscated last name, no address
 * and no company domain; an enriched record carries all three. The rest of
 * Boxaide should never learn that difference, so the flattening happens once,
 * in the adapter, and the module only ever hands out a ProspectCompany or a
 * ProspectPerson.
 *
 * The vendor body is never returned. It is a page of JSON that would fill an
 * agent's context without telling it anything these fields do not, which is
 * the same bargain src/enrichment/tools.ts makes.
 */

/** What a company search was asked to look for. Every field is optional. */
export type CompanyQuery = {
  /** Industry or keyword tags, e.g. ["saas", "logistics"]. */
  keywords?: string[];
  /** Company name, partial match. */
  name?: string;
  /** Company domains, e.g. ["acme.com"]. */
  domains?: string[];
  /** Head office locations, e.g. ["Belgium", "California, US"]. */
  locations?: string[];
  /** Head office locations to leave out. */
  excludeLocations?: string[];
  minEmployees?: number;
  maxEmployees?: number;
  limit?: number;
};

/** One company, flat. Every value Apollo did not hold comes back null. */
export type ProspectCompany = {
  name: string;
  /** Primary mail domain, e.g. "acme.com". Ready for crm_org_upsert. */
  domain: string | null;
  industry: string | null;
  /** Employees Apollo estimates, not a range. */
  headcount: number | null;
  /** Head office, as "City, State, Country" with the parts Apollo held. */
  location: string | null;
  linkedinUrl: string | null;
  /** Apollo's own id. Pass it back as organizationIds to narrow a people search. */
  apolloOrgId: string | null;
  /**
   * The page this company was taken from, when it came from a web search
   * rather than a prospect database. Its presence is the signal that this row
   * is a search hit somebody still has to check.
   */
  sourceUrl?: string | null;
  /**
   * How many people at this company the provider holds an address for, when
   * it says. Hunter does; Apollo does not, and leaves it undefined. Zero is a
   * real answer and means a people search here would come back empty.
   */
  contactsKnown?: number | null;
};

/**
 * Whether the address is real, behind a credit, or not held at all.
 *
 * 'locked' is the value that matters. Apollo's free people search says only
 * that it holds an address, and its placeholder for one it will not show is a
 * literal "email_not_unlocked@..." string. Neither is an address, and either
 * one mailed as though it were reaches a domain that does not exist.
 */
export type ProspectEmailStatus = "verified" | "unverified" | "locked" | "absent";

/** One person, flat. Unrevealed hits carry no name beyond the first one. */
export type ProspectPerson = {
  /**
   * Whole name, or null when this hit has not been revealed. Apollo returns
   * the last name of an unrevealed person as "Hu***n", so there is no whole
   * name to give: reporting one would be reporting a mask as a fact.
   */
  fullName: string | null;
  firstName: string | null;
  /** Null until revealed, never the obfuscated form. */
  lastName: string | null;
  title: string | null;
  orgName: string | null;
  /** Null on an unrevealed hit: Apollo's search results carry no domain. */
  orgDomain: string | null;
  linkedinUrl: string | null;
  /** Null unless Apollo gave a real address. Never a placeholder. */
  email: string | null;
  emailStatus: ProspectEmailStatus;
  /** False when this is a search hit that nobody paid to open. */
  revealed: boolean;
  /** Apollo's own person id. The only handle a reveal accepts. */
  apolloPersonId: string | null;
  /**
   * The arguments crm_contact_upsert wants, already named its way. Present
   * only when there is a real address to key a contact by, so an agent can
   * hand it over whole instead of copying five fields and mistyping one.
   *
   * Present means valid. An agent that finds this field can always pass it
   * straight on, which is why the not-yet-usable case gets its own field
   * below rather than this one with a hole in it.
   */
  crmContact?: {
    email: string;
    name?: string;
    title?: string;
    org?: string;
    orgDomain?: string;
  };
  /**
   * The same arguments minus the one that is missing, for a revealed person
   * whose address is locked or absent. It exists so the second half of the
   * chain is a spread rather than four renames: fullName becomes name and
   * orgName becomes org, and an agent doing that by hand gets it wrong often
   * enough to be worth a field.
   *
   * Never passed to crm_contact_upsert as it stands: that call is keyed by
   * address and refuses without one. Fill the address in from
   * enrich_find_email first.
   */
  crmContactPendingEmail?: {
    name?: string;
    title?: string;
    org?: string;
    orgDomain?: string;
  };
  /**
   * The arguments enrich_find_email wants, for that same person. Present only
   * when both halves it needs are known, so its absence is the honest answer
   * that this record cannot be taken any further here.
   */
  enrichFindEmail?: {
    fullName: string;
    orgDomain: string;
  };
};

/** What a company search was asked for, and what came back. */
export type CompanySearchResult = {
  /** Which vendor answered: "apollo" or "hunter". */
  provider: string;
  companies: ProspectCompany[];
  /** Companies Apollo says match the filters, before the limit. */
  total: number;
  returned: number;
  /**
   * Anything the agent must repeat to the user: a truncated result set, or an
   * account that suppresses EU records. Apollo reports both as flags on a
   * successful response rather than as an error, so silence here is the only
   * way a wrong count reaches a person unchallenged.
   */
  notes: string[];
};

export type PeopleSearchResult = {
  /** Which vendor answered: "apollo" or "hunter". */
  provider: string;
  people: ProspectPerson[];
  total: number;
  returned: number;
  /** How many of the returned rows were revealed, and so cost credits. */
  revealed: number;
  notes: string[];
};

/** What a people search was asked to look for. Every field is optional. */
export type PeopleQuery = {
  /** Employer domains, e.g. ["acme.com"]. The "at acme.com" filter. */
  orgDomains?: string[];
  /** Apollo organisation ids, from a company search. */
  organizationIds?: string[];
  /** Job titles, fuzzy unless exactTitles is set. */
  titles?: string[];
  /** Restricts titles to near-exact matches. */
  exactTitles?: boolean;
  seniorities?: string[];
  /** The person's own location, not the employer's. */
  locations?: string[];
  keywords?: string;
  limit?: number;
  /** Spends credits to open the hits. See PROSPECT_REVEAL_LIMIT. */
  reveal?: boolean;
};

/**
 * Deadline for one call to either vendor, matching src/enrichment/types.ts.
 *
 * Both adapters loop: Apollo reveals one person at a time, Hunter searches one
 * domain at a time. A vendor that accepts the connection and then says nothing
 * would otherwise hold the whole batch for Node's five-minute header timeout,
 * once per iteration.
 */
export const PROSPECTING_TIMEOUT_MS = 10_000;

/**
 * One vendor that can find somebody Boxaide does not already hold.
 *
 * Both methods may throw, and the service does not fall through to another
 * vendor when one does: only one provider is in force per call, chosen by
 * which key is set. A failure here is the answer, not a first opinion.
 */
export interface ProspectingProvider {
  /** Stable id, and the value of `provider` on every result it returns. */
  readonly id: "apollo" | "hunter" | "web";
  /**
   * True when opening a person costs credits per person, as Apollo's reveal
   * does. The service pulls a revealing search down to the reveal cap only
   * for a provider that says true; Hunter's addresses arrive with the search
   * and capping it at ten would throw away rows nobody was billed for.
   */
  readonly revealCostsPerPerson: boolean;
  findCompanies(query: CompanyQuery, limit: number): Promise<CompanySearchResult>;
  findPeople(
    query: PeopleQuery,
    limit: number,
    revealLimit: number,
  ): Promise<PeopleSearchResult>;
}

/** One Apollo reply, already read. Headers are kept for the rate-limit story. */
export type ApolloResponse = {
  ok: boolean;
  status: number;
  body: string;
  headers: Headers;
};

/**
 * One request under that deadline, body read inside it.
 *
 * A local copy rather than an import of the enrichment helper: these modules
 * are siblings, this one needs the response headers that one throws away, and
 * a vendor deadline is not a dependency worth coupling two modules over.
 */
export async function apolloRequest(
  url: string,
  init: RequestInit = {},
): Promise<ApolloResponse> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), PROSPECTING_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { ok: res.ok, status: res.status, body: await res.text(), headers: res.headers };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`apollo timed out after ${PROSPECTING_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(deadline);
  }
}
