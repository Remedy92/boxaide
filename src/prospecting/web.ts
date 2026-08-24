/**
 * The web-search adapter: companies found through the search key the install
 * already has, when neither prospecting vendor is configured.
 *
 * Discovery is not what an address vendor is for. Finding out which companies
 * exist in a market is a question the open web answers, and Boxaide already
 * pays somebody to search it. So an install with an Exa or Parallel key and no
 * Apollo and no Hunter can still answer "who is in this market", which used to
 * be a flat refusal.
 *
 * What comes back is a search result, and the module says so in every field it
 * can. A company here is a name and a domain lifted from a hit, plus the URL it
 * came from. There is no headcount, no industry and no verification that the
 * hit is a company at all rather than a directory page listing twenty, and an
 * agent that reports these as a vetted list is reporting a ranking as a fact.
 * The notes carry that on every call rather than once in these comments.
 *
 * People are deliberately not attempted. Extracting a name and a title from a
 * team page is a reading job, and code here that pattern-matched at HTML would
 * invent people for any page it misread. The agent doing the asking can read,
 * so findPeople refuses and names the path that works: fetch the page, read it,
 * then build the address with enrich_address_pattern.
 */
import { bareDomain } from "../domain.js";
import type {
  CompanyQuery,
  CompanySearchResult,
  PeopleQuery,
  PeopleSearchResult,
  ProspectCompany,
  ProspectingProvider,
} from "./types.js";

/** One search hit, in the shape src/research hands them out. */
export type WebHit = { title: string; url: string; snippet: string };

/** Runs one web search. Wiring passes the research service's own search. */
export type WebSearch = (query: string, numResults: number) => Promise<WebHit[]>;

/**
 * Hosts that are never the company being looked for. A search for an industry
 * returns the platform the discussion happened on as often as it returns a
 * company, and a list where a third of the rows are social networks reads as a
 * bad answer rather than as the filter it needs.
 *
 * Directories, listicles and review sites are deliberately NOT here. Those
 * pages are frequently the best hit a market search gets, and dropping them
 * would throw away the answer to keep the list tidy. They come back with their
 * source URL and a note saying some rows will be lists rather than companies.
 */
const NOT_A_COMPANY = new Set([
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "tiktok.com",
  "reddit.com",
  "wikipedia.org",
  "quora.com",
  "pinterest.com",
]);

/**
 * Hits asked for at most. The research module caps a search at ten, so asking
 * for more returns ten and reads like a wider search than it was.
 */
export const MAX_WEB_COMPANIES = 10;

export class WebProspectingProvider implements ProspectingProvider {
  readonly id = "web" as const;
  /** Nothing is opened here, so nothing is billed per person either. */
  readonly revealCostsPerPerson = false;

  constructor(private readonly search: WebSearch) {}

  async findCompanies(query: CompanyQuery, limit: number): Promise<CompanySearchResult> {
    const asked = searchQuery(query);
    const wanted = Math.min(limit, MAX_WEB_COMPANIES);
    const hits = await this.search(asked, wanted);

    const onlyDomains = domainList(query.domains);
    const companies: ProspectCompany[] = [];
    const seen = new Set<string>();
    let dropped = 0;
    let offDomain = 0;
    for (const hit of hits) {
      const host = hostOf(hit.url);
      if (!host) continue;
      // A domains filter is the one filter here that can be enforced rather
      // than hinted at. The query names the domains, but a search engine
      // answers with what it ranked, so the article about acme.com is dropped
      // here rather than upserted into the CRM as if it were acme.com.
      const matched = onlyDomains.length ? matchOf(host, onlyDomains) : null;
      if (onlyDomains.length && !matched) {
        offDomain += 1;
        continue;
      }
      if (isNotACompany(host)) {
        dropped += 1;
        continue;
      }
      // The company is the domain that was asked for, not the host the hit
      // happened to live on. careers.acme.com is a page of acme.com, and the
      // CRM keys organisations by exact domain, so reporting the subdomain
      // here would open a second organisation row for the same company. The
      // page itself is not lost: it stays on sourceUrl.
      const domain = matched ?? host;
      if (seen.has(domain)) continue;
      seen.add(domain);
      companies.push({
        name: companyName(hit.title, domain),
        domain,
        industry: null,
        headcount: null,
        location: null,
        linkedinUrl: null,
        apolloOrgId: null,
        sourceUrl: hit.url,
      });
      if (companies.length >= wanted) break;
    }

    const notes = [
      `A web search answered this, not a prospect database: these are the top hits for "${asked}", not a vetted list of companies. Each row is a name and a domain taken from one page, with sourceUrl saying which. Some rows will be directories or articles that list companies rather than companies themselves, so read sourceUrl before you treat a row as a company.`,
      "industry, headcount, location, linkedinUrl and apolloOrgId are null because a search result does not carry them. The minEmployees and maxEmployees filters could not be applied at all, so a headcount range you gave was ignored rather than met. excludeLocations was ignored too: a search query can ask for a place, not against one, so a row from a place you excluded can still be here.",
      "There is no total: a search says how it ranked pages, not how many companies exist. Ask again with a different query to widen this rather than expecting a next page.",
    ];
    if (dropped > 0) {
      notes.push(
        `${dropped} hit(s) were search engines, social networks or reference sites rather than companies, and were dropped.`,
      );
    }
    if (offDomain > 0) {
      notes.push(
        `${offDomain} hit(s) were on other hosts than the domains you asked for and were dropped, because a search ranks pages about a company as readily as the company's own site.`,
      );
    }
    if (offDomain > 0 && companies.length === 0) {
      notes.push(
        `Nothing here is a "not found": the search returned hits, but none of them were on ${onlyDomains.join(", ")}, so the domains filter removed them all. A web search cannot look a domain up the way a prospect database can, so fetch the domain directly if you need to know whether it is a company.`,
      );
    }

    return {
      provider: this.id,
      companies,
      // The count returned IS the count known. Reporting a search engine's
      // result estimate as `total` would put a number nobody can act on where
      // an agent reads "companies that match".
      total: companies.length,
      returned: companies.length,
      notes,
    };
  }

  /** Refused, with the path that does work. See the header for why. */
  async findPeople(_query: PeopleQuery): Promise<PeopleSearchResult> {
    throw new Error(
      "There is no prospecting key set, so people can only be found by reading. Use web_search for the company's team or about page, read it with web_fetch, and take the names and titles from what it says. Then call enrich_address_pattern with the company domain and a name: it builds a candidate address from the addresses you already hold there, which enrich_verify_email must check before anything is queued. Add an Apollo or Hunter key under Settings > Connectors to search for people directly.",
    );
  }
}

/**
 * The query a person would have typed. The operator's own words, joined; no
 * industry vocabulary is invented and no synonyms are added, because a query
 * an agent cannot see the shape of is one it cannot improve on the next call.
 *
 * The domains go in as site: terms. Without them a request that named only
 * domains searched the bare word "companies", which is not the question that
 * was asked; with them the search is pointed at the hosts, and findCompanies
 * still drops whatever comes back from somewhere else.
 */
export function searchQuery(query: CompanyQuery): string {
  const parts: string[] = [];
  if (query.name) parts.push(query.name);
  const keywords = list(query.keywords);
  if (keywords.length) parts.push(keywords.join(" "));
  parts.push("companies");
  const locations = list(query.locations);
  if (locations.length) parts.push(`in ${locations.join(" or ")}`);
  const domains = domainList(query.domains);
  if (domains.length) parts.push(domains.map((domain) => `site:${domain}`).join(" OR "));
  return parts.join(" ");
}

/**
 * A company name from a page title. Titles are "Acme Logistics | Home" and
 * "Acme Logistics - About us", so the first segment is the name far more often
 * than the whole string is. A title that leaves nothing falls back to the
 * domain, which is always something a human can recognise.
 */
function companyName(title: string, domain: string): string {
  const first = title.split(/\s+[|–—-]\s+/)[0]?.trim() ?? "";
  return first === "" ? domain : first;
}

/**
 * Is this host one of the platforms rather than a company? Subdomains count:
 * a hit on de.linkedin.com is the same site as one on linkedin.com, and a
 * blocklist that only matched the bare host would let every country subdomain
 * of every platform straight back in.
 */
function isNotACompany(domain: string): boolean {
  if (NOT_A_COMPANY.has(domain)) return true;
  for (const platform of NOT_A_COMPANY) {
    if (domain.endsWith(`.${platform}`)) return true;
  }
  return false;
}

/**
 * Which asked-for domain does this host belong to, if any? Subdomains count
 * the other way round from the platform blocklist: careers.acme.com is still
 * acme.com, and a filter that only matched the bare host would drop the
 * company's own careers page as an impostor.
 *
 * The asked-for domain is returned rather than a yes, because that is the one
 * the caller and the CRM both know the company by.
 */
function matchOf(host: string, wanted: string[]): string | null {
  return wanted.find((one) => host === one || host.endsWith(`.${one}`)) ?? null;
}

/** Bare hosts, as the vendor adapters do, so a pasted URL still matches. */
function domainList(values: string[] | undefined): string[] {
  return list(values).map((value) => bareDomain(value) ?? value.toLowerCase());
}

/** The bare host of a hit, or null when the URL is not one. */
function hostOf(url: string): string | null {
  try {
    return bareDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}

function list(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value).trim()).filter((value) => value !== "");
}
