/**
 * ProspectingService: discovery against whichever vendor has a key.
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
 *
 * One provider is in force per call, never a waterfall. Apollo wins when its
 * key is set because it answers every question these tools ask; Hunter answers
 * the domain-shaped half; web search answers the company half alone and is
 * what an install with only a search key gets instead of a refusal. Falling
 * through from one to the next would spend a second vendor's quota to ask a
 * question the first already answered, and they disagree about what a search
 * means often enough that the agent would have to be told which half came from
 * where.
 *
 * The order is by how much each one knows, not by price. A web search is the
 * cheapest of the three and the last resort anyway: it returns a ranking, and
 * a ranking is weaker evidence than a database row even when the row cost a
 * credit.
 */
import { envNamed } from "../config.js";
import { ApolloProvider } from "./apollo.js";
import { HunterProspectingProvider } from "./hunter.js";
import { WebProspectingProvider, type WebSearch } from "./web.js";
import type {
  CompanyQuery,
  CompanySearchResult,
  PeopleQuery,
  PeopleSearchResult,
  ProspectingProvider,
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
export const HUNTER_ENV_KEY = "BOXAIDE_HUNTER_API_KEY";

export const NOT_CONFIGURED = `No prospecting provider is configured, so there is no way to find new prospects from here. Add an Apollo key or a Hunter key under Settings > Connectors, or set ${APOLLO_ENV_KEY} or ${HUNTER_ENV_KEY} in the environment of the Boxaide server. Apollo answers both searches; Hunter finds companies and finds the people at a domain you name; a web search key alone finds companies. Tell the user this rather than guessing at companies or people.`;

export type ProspectingDeps = {
  /**
   * Reads the API key for one provider id. Production passes the connectors
   * service, which answers from settings first and the environment second.
   * Read per call, so a key saved in Settings needs no restart.
   */
  getKey?: (providerId: string) => string | undefined;
  /**
   * Runs one web search, for the last-resort provider. Production passes the
   * research service's own search, so prospecting never learns which search
   * vendor is behind it and never imports one. Absent means an install with
   * no search key: the fallback is simply not offered.
   */
  search?: WebSearch;
  /** Whether a search key is set right now. Asked per call, like the others. */
  searchConfigured?: () => boolean;
};

export class ProspectingService {
  private getKey: (providerId: string) => string | undefined;
  private search: WebSearch | null;
  private searchConfigured: (() => boolean) | null;

  constructor(deps: ProspectingDeps = {}) {
    this.getKey =
      deps.getKey ??
      ((id) => envNamed(id === "hunter" ? "HUNTER_API_KEY" : "APOLLO_API_KEY"));
    this.search = deps.search ?? null;
    this.searchConfigured = deps.searchConfigured ?? null;
  }

  /** False when neither key is set. Both searches refuse in that state. */
  isConfigured(): boolean {
    return this.providerId() !== null;
  }

  /**
   * Which vendor a search would reach right now, or null for none. The tools
   * put this on every result, and the Connectors screen has a use for it too:
   * an operator who set a Hunter key alone should be able to see that
   * prospecting is on rather than infer it.
   */
  providerId(): "apollo" | "hunter" | "web" | null {
    if (this.keyFor("apollo")) return "apollo";
    if (this.keyFor("hunter")) return "hunter";
    if (this.searchAvailable()) return "web";
    return null;
  }

  async findCompanies(query: CompanyQuery): Promise<CompanySearchResult> {
    const provider = this.providerNow();
    if (!hasCompanyFilter(query)) {
      throw new Error(
        "give at least one filter: keywords, name, domains, locations, or an employee range. An unfiltered search answers with the whole database, which at Apollo is a credit spent on nothing and at either vendor is a page of companies picked for no reason.",
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
    // Revealing is the paid half at Apollo, so the search is pulled back to
    // the reveal cap rather than searching for fifty and opening ten: the
    // forty nobody paid for are first names without last names, and an agent
    // handed a page of those reports masks as prospects. Hunter has no paid
    // half to protect, so the cap does not apply to it: every row it returns
    // already carries the name and the address.
    const limit =
      query.reveal && provider.revealCostsPerPerson
        ? clamp(query.limit, PROSPECT_REVEAL_LIMIT, PROSPECT_REVEAL_LIMIT)
        : clamp(query.limit, DEFAULT_PEOPLE_LIMIT, MAX_PEOPLE_LIMIT);
    return provider.findPeople(query, limit, PROSPECT_REVEAL_LIMIT);
  }

  /**
   * The provider as it stands right now. Rebuilt per call because a key can
   * arrive from the Connectors screen between two searches, and the object
   * holds nothing but that key.
   */
  private providerNow(): ProspectingProvider {
    const apollo = this.keyFor("apollo");
    if (apollo) return new ApolloProvider(apollo);
    const hunter = this.keyFor("hunter");
    if (hunter) return new HunterProspectingProvider(hunter);
    if (this.search && this.searchAvailable()) return new WebProspectingProvider(this.search);
    throw new Error(NOT_CONFIGURED);
  }

  /** A search key is set and a search callback was wired. Both, or neither. */
  private searchAvailable(): boolean {
    if (!this.search) return false;
    return this.searchConfigured ? this.searchConfigured() : true;
  }

  private keyFor(providerId: string): string | undefined {
    const key = this.getKey(providerId);
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
