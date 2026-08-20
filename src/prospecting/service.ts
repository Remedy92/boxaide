/**
 * ProspectingService: discovery against Apollo, and nothing else.
 *
 * No store, no timers, no master key. A prospect is a fact about the outside
 * world at one moment; anything worth keeping goes into the CRM through
 * crm_contact_upsert, by an agent that decided it was worth keeping. That is
 * the same bargain src/research/service.ts makes, and it is why this module
 * never imports the CRM.
 *
 * The key is read per call, never cached on the instance, so a key saved in
 * the Connectors screen is in force on the next search with no restart.
 *
 * Every limit here is a hard cap rather than a suggestion. Apollo bills a
 * credit per page of company search even when the page is empty, and one to
 * nine credits per revealed person, so an unbounded loop is an unbounded bill.
 */
import { envNamed } from "../config.js";
import { ApolloProvider } from "./apollo.js";
import type {
  CompanyQuery,
  CompanySearchResult,
  PeopleQuery,
  PeopleSearchResult,
} from "./types.js";

/** Companies returned when the caller does not say, and at most. */
export const DEFAULT_COMPANY_LIMIT = 25;
/** Apollo's own per-page maximum, and so one credit for any call we make. */
export const MAX_COMPANY_LIMIT = 100;

export const DEFAULT_PEOPLE_LIMIT = 25;
export const MAX_PEOPLE_LIMIT = 50;
/**
 * People opened per call at most. Search is free; this is the paid half, at
 * one to nine credits each, so it is capped well below the search cap and an
 * agent that wants more has to ask again and mean it.
 */
export const PROSPECT_REVEAL_LIMIT = 10;

/** Quoted verbatim when no key is set. */
export const APOLLO_ENV_KEY = "BOXAIDE_APOLLO_API_KEY";

export const NOT_CONFIGURED = `Apollo is not configured, so there is no way to find new prospects from here. Add the Apollo key under Settings > Connectors, or set ${APOLLO_ENV_KEY} in the environment of the Boxaide server. Tell the user this rather than guessing at companies or people.`;

export type ProspectingDeps = {
  /**
   * Reads the API key for one provider id. Production passes the connectors
   * service, which answers from settings first and the environment second.
   * Read per call, so a key saved in Settings needs no restart.
   */
  getKey?: (providerId: string) => string | undefined;
};

export class ProspectingService {
  private getKey: (providerId: string) => string | undefined;

  constructor(deps: ProspectingDeps = {}) {
    this.getKey = deps.getKey ?? (() => envNamed("APOLLO_API_KEY"));
  }

  /** False when no Apollo key is set. Both searches refuse in that state. */
  isConfigured(): boolean {
    return this.keyNow() !== undefined;
  }

  async findCompanies(query: CompanyQuery): Promise<CompanySearchResult> {
    const provider = this.providerNow();
    if (!hasCompanyFilter(query)) {
      throw new Error(
        "give at least one filter: keywords, name, domains, locations, or an employee range. Apollo answers an unfiltered search with the whole database, which is a credit spent on nothing.",
      );
    }
    return provider.findCompanies(
      query,
      clamp(query.limit, DEFAULT_COMPANY_LIMIT, MAX_COMPANY_LIMIT),
    );
  }

  async findPeople(query: PeopleQuery): Promise<PeopleSearchResult> {
    const provider = this.providerNow();
    if (!hasPeopleFilter(query)) {
      throw new Error(
        "give at least one filter: orgDomains, organizationIds, titles, seniorities, locations, or keywords. An unfiltered people search returns the whole database in no useful order.",
      );
    }
    // Revealing is the paid half, so the search is pulled back to the reveal
    // cap rather than searching for fifty and opening ten: the forty nobody
    // paid for are first names without last names, and an agent handed a page
    // of those reports masks as prospects.
    const limit = query.reveal
      ? clamp(query.limit, PROSPECT_REVEAL_LIMIT, PROSPECT_REVEAL_LIMIT)
      : clamp(query.limit, DEFAULT_PEOPLE_LIMIT, MAX_PEOPLE_LIMIT);
    return provider.findPeople(query, limit, PROSPECT_REVEAL_LIMIT);
  }

  /**
   * The provider as it stands right now. Rebuilt per call because a key can
   * arrive from the Connectors screen between two searches, and the object
   * holds nothing but that key.
   */
  private providerNow(): ApolloProvider {
    const key = this.keyNow();
    if (!key) throw new Error(NOT_CONFIGURED);
    return new ApolloProvider(key);
  }

  private keyNow(): string | undefined {
    const key = this.getKey("apollo");
    return key && key.trim() !== "" ? key.trim() : undefined;
  }
}

function hasCompanyFilter(query: CompanyQuery): boolean {
  return Boolean(
    query.name ||
      query.keywords?.length ||
      query.domains?.length ||
      query.locations?.length ||
      query.minEmployees !== undefined ||
      query.maxEmployees !== undefined,
  );
}

function hasPeopleFilter(query: PeopleQuery): boolean {
  return Boolean(
    query.orgDomains?.length ||
      query.organizationIds?.length ||
      query.titles?.length ||
      query.seniorities?.length ||
      query.locations?.length ||
      query.keywords,
  );
}

/** Out of range is clamped, not refused: a bad count is not worth a failed call. */
export function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return Math.min(fallback, max);
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  return whole > max ? max : whole;
}
