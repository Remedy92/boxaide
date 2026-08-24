/**
 * Prospecting, tested at the two seams that matter: the request the vendor
 * would receive, and the record an agent would read back.
 *
 * The call log is half the contract. A filter mapped to the wrong Apollo field
 * name is not a wrong answer, it is a different question asked with the
 * operator's credits, and normalisation alone would never catch it. The same
 * goes for Hunter, whose filters are a different vocabulary again.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { ApolloProvider } from "../src/prospecting/apollo.js";
import {
  HUNTER_DOMAIN_LIMIT,
  HUNTER_FREE_PLAN_PAGE,
  HunterProspectingProvider,
} from "../src/prospecting/hunter.js";
import {
  APOLLO_ENV_KEY,
  HUNTER_ENV_KEY,
  DEFAULT_COMPANY_LIMIT,
  MAX_COMPANY_LIMIT,
  MAX_PEOPLE_LIMIT,
  PROSPECT_REVEAL_LIMIT,
  ProspectingService,
} from "../src/prospecting/service.js";
import {
  dispatchProspectingTool,
  PROSPECTING_TOOLS,
  PROSPECTING_TOOL_NAMES,
  type ProspectingPlatform,
} from "../src/prospecting/tools.js";
import { CONNECTORS, connectorById } from "../src/connectors/types.js";
import { scopeAllows } from "../src/mcp/scope.js";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

/** Records every request and answers with a canned body, per url. */
function stubVendor(
  reply: (url: string, body: any) => { status?: number; body: unknown; headers?: Record<string, string> },
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const sent = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: sent,
    });
    const answer = reply(url, sent);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json", ...(answer.headers ?? {}) },
    });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One company row, shaped like the documented organization search sample. */
const ACME_ORG = {
  id: "5e66b6381e05b4008c8331b8",
  name: "Acme Logistics",
  website_url: "https://www.acme.com/about",
  primary_domain: "acme.com",
  linkedin_url: "https://www.linkedin.com/company/acme",
  industry: "logistics",
  estimated_num_employees: 42,
  city: "Ghent",
  state: "East Flanders",
  country: "Belgium",
};

/**
 * One people search hit, shaped like the documented sample: the last name is
 * a mask, there is no address and no domain, and the organisation is a set of
 * availability booleans rather than values.
 */
const SEARCH_HIT = {
  id: "67bdafd0c3a4c50001bbd7c2",
  first_name: "Andrew",
  last_name_obfuscated: "Hu***n",
  title: "VP of Sales",
  has_email: true,
  organization: { name: "Acme Logistics", has_industry: true, has_employee_count: true },
};

function service(key: string | undefined): ProspectingService {
  return new ProspectingService({ getKey: () => key });
}

describe("apollo company search", () => {
  it("maps every filter to the field name Apollo documents", async () => {
    const calls = stubVendor(() => ({ body: { organizations: [ACME_ORG], pagination: { total_entries: 812 } } }));
    const result = await service("k-1").findCompanies({
      keywords: ["saas"],
      locations: ["Belgium"],
      excludeLocations: ["France"],
      domains: ["https://www.other.com/"],
      name: "Acme",
      minEmployees: 10,
      maxEmployees: 50,
      limit: 5,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.apollo.io/api/v1/mixed_companies/search");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["x-api-key"]).toBe("k-1");
    expect(calls[0].body).toEqual({
      page: 1,
      per_page: 5,
      q_organization_name: "Acme",
      q_organization_keyword_tags: ["saas"],
      q_organization_domains_list: ["other.com"],
      organization_locations: ["Belgium"],
      organization_not_locations: ["France"],
      organization_num_employees_ranges: ["10,50"],
    });
    expect(result.total).toBe(812);
    expect(result.returned).toBe(1);
    expect(result.companies[0]).toEqual({
      name: "Acme Logistics",
      domain: "acme.com",
      industry: "logistics",
      headcount: 42,
      location: "Ghent, East Flanders, Belgium",
      linkedinUrl: "https://www.linkedin.com/company/acme",
      apolloOrgId: "5e66b6381e05b4008c8331b8",
    });
  });

  it("reports an unknown headcount as null, never as no employees", async () => {
    stubVendor(() => ({
      body: {
        organizations: [{ ...ACME_ORG, estimated_num_employees: null }],
        pagination: { total_entries: 1 },
      },
    }));
    const result = await service("k").findCompanies({ keywords: ["saas"] });
    // Apollo sends null for a company it holds no headcount for, and a 0 here
    // reads as a defunct company.
    expect(result.companies[0].headcount).toBeNull();
  });

  it("clamps the limit to one page, so a call is never more than one credit", async () => {
    const calls = stubVendor(() => ({ body: { organizations: [] } }));
    await service("k").findCompanies({ keywords: ["saas"], limit: 5_000 });
    expect(calls[0].body.per_page).toBe(MAX_COMPANY_LIMIT);
    expect(calls[0].body.page).toBe(1);

    await service("k").findCompanies({ keywords: ["saas"] });
    expect(calls[1].body.per_page).toBe(DEFAULT_COMPANY_LIMIT);
  });

  it("refuses an unfiltered search rather than spending a credit on it", async () => {
    const calls = stubVendor(() => ({ body: { organizations: [] } }));
    await expect(service("k").findCompanies({})).rejects.toThrow(/at least one filter/);
    expect(calls).toHaveLength(0);
  });

  it("passes on a truncated result and a suppressed EU account", async () => {
    stubVendor(() => ({
      body: {
        organizations: [],
        partial_results_only: true,
        partial_results_limit: 100,
        disable_eu_prospecting: true,
        pagination: { total_entries: 0 },
      },
    }));
    const result = await service("k").findCompanies({ locations: ["Belgium"] });
    expect(result.notes.join(" ")).toMatch(/partial results/);
    expect(result.notes.join(" ")).toMatch(/EU prospecting disabled/);
  });

  /**
   * An empty domain list is not a narrower search, it is no search filter at
   * all, and Apollo answers that by billing a credit for a page of its whole
   * database. So a value the normaliser refuses is sent as written: it matches
   * nothing, which is the honest answer to a domain that is not one.
   */
  it("never lets a domain filter normalise away to no filter", async () => {
    const calls = stubVendor(() => ({ body: { organizations: [], pagination: {} } }));
    await service("k-1").findCompanies({ domains: ["acme", "ACME Corp"] });

    expect(calls[0].body.q_organization_domains_list).toEqual(["acme", "acme corp"]);
    expect(calls[0].body).toHaveProperty("q_organization_domains_list");
  });

  it("still folds a pasted URL, port and all, down to the bare host", async () => {
    const calls = stubVendor(() => ({ body: { organizations: [], pagination: {} } }));
    await service("k-1").findCompanies({
      domains: ["https://www.Acme.com:8443/about?x=1", "acme.com"],
    });

    expect(calls[0].body.q_organization_domains_list).toEqual(["acme.com", "acme.com"]);
  });
});

describe("apollo people search", () => {
  it("maps the filters and never returns the obfuscated last name", async () => {
    const calls = stubVendor(() => ({ body: { people: [SEARCH_HIT], pagination: { total_entries: 9 } } }));
    const result = await service("k").findPeople({
      orgDomains: ["acme.com"],
      titles: ["vp of sales"],
      exactTitles: true,
      seniorities: ["vp", "C Suite", "nonsense"],
      locations: ["Belgium"],
      keywords: "logistics",
      limit: 3,
    });

    expect(calls[0].url).toBe("https://api.apollo.io/api/v1/mixed_people/api_search");
    expect(calls[0].body).toEqual({
      page: 1,
      per_page: 3,
      q_organization_domains_list: ["acme.com"],
      person_titles: ["vp of sales"],
      include_similar_titles: false,
      person_seniorities: ["vp", "c_suite"],
      person_locations: ["Belgium"],
      q_keywords: "logistics",
    });
    expect(result.revealed).toBe(0);
    // Apollo puts the match count under `pagination`, the same as the company
    // search. Reading the top level instead silently collapses `total` to the
    // page size, which reads as "that is all there is".
    expect(result.total).toBe(9);
    expect(result.people[0]).toEqual({
      fullName: null,
      firstName: "Andrew",
      lastName: null,
      title: "VP of Sales",
      orgName: "Acme Logistics",
      orgDomain: null,
      linkedinUrl: null,
      email: null,
      emailStatus: "locked",
      revealed: false,
      apolloPersonId: "67bdafd0c3a4c50001bbd7c2",
    });
    expect(JSON.stringify(result)).not.toContain("Hu***n");
  });

  it("uses the api_search path, never the deprecated one", async () => {
    const calls = stubVendor(() => ({ body: { people: [] } }));
    await service("k").findPeople({ titles: ["cto"] });
    expect(calls[0].url).not.toMatch(/\/mixed_people\/search$/);
    expect(calls[0].url).not.toMatch(/\/people\/search$/);
  });

  it("reveals by Apollo id and hands back crm_contact_upsert arguments", async () => {
    const calls = stubVendor((url) => {
      if (url.endsWith("/people/match")) {
        return {
          body: {
            person: {
              id: "67bdafd0c3a4c50001bbd7c2",
              first_name: "Andrew",
              last_name: "Huisman",
              title: "VP of Sales",
              email: "Andrew@Acme.com",
              email_status: "verified",
              linkedin_url: "https://www.linkedin.com/in/andrew",
              organization: { name: "Acme Logistics", primary_domain: "acme.com" },
            },
          },
        };
      }
      return { body: { people: [SEARCH_HIT], pagination: { total_entries: 1 } } };
    });

    const result = await service("k").findPeople({ orgDomains: ["acme.com"], reveal: true });
    expect(calls[1].url).toBe("https://api.apollo.io/api/v1/people/match");
    expect(calls[1].body).toEqual({ id: "67bdafd0c3a4c50001bbd7c2" });
    // The phone and waterfall flags cost eight credits and need a public
    // webhook, so they must never be sent from a self-hosted server.
    expect(Object.keys(calls[1].body)).toEqual(["id"]);

    const person = result.people[0];
    expect(result.revealed).toBe(1);
    expect(person.revealed).toBe(true);
    expect(person.fullName).toBe("Andrew Huisman");
    expect(person.email).toBe("andrew@acme.com");
    expect(person.emailStatus).toBe("verified");
    expect(person.crmContact).toEqual({
      email: "andrew@acme.com",
      name: "Andrew Huisman",
      title: "VP of Sales",
      org: "Acme Logistics",
      orgDomain: "acme.com",
    });
  });

  it("keeps the people it already paid to reveal when Apollo refuses the rest", async () => {
    let matches = 0;
    stubVendor((url) => {
      if (url.endsWith("/people/match")) {
        matches += 1;
        if (matches > 1) {
          return { status: 429, body: { error: "rate limited" } };
        }
        return {
          body: {
            person: {
              id: "p1",
              first_name: "Andrew",
              last_name: "Huisman",
              email: "andrew@acme.com",
              email_status: "verified",
              organization: { name: "Acme", primary_domain: "acme.com" },
            },
          },
        };
      }
      return {
        body: {
          people: [SEARCH_HIT, { ...SEARCH_HIT, id: "p2", first_name: "Grace" }],
          pagination: { total_entries: 2 },
        },
      };
    });

    // A 429 part-way through is an ordinary outcome, and throwing would throw
    // away the credit already spent on the first person.
    const result = await service("k").findPeople({ orgDomains: ["acme.com"], reveal: true });
    expect(result.revealed).toBe(1);
    expect(result.people).toHaveLength(2);
    expect(result.people[0].email).toBe("andrew@acme.com");
    expect(result.people[1].revealed).toBe(false);
    expect(result.notes.join(" ")).toMatch(/Revealed 1 of 2/);
    expect(result.notes.join(" ")).toMatch(/do not run this search again/);
  });

  it("treats Apollo's locked placeholder as no address at all", async () => {
    stubVendor((url) => {
      if (url.endsWith("/people/match")) {
        return {
          body: {
            person: {
              id: "p1",
              first_name: "Andrew",
              last_name: "Huisman",
              email: "email_not_unlocked@domain.com",
              email_status: "unavailable",
              organization: { name: "Acme", primary_domain: "acme.com" },
            },
          },
        };
      }
      return { body: { people: [SEARCH_HIT] } };
    });

    const result = await service("k").findPeople({ orgDomains: ["acme.com"], reveal: true });
    const person = result.people[0];
    expect(person.email).toBeNull();
    expect(person.emailStatus).toBe("locked");
    // Nothing downstream may be handed a contact keyed by a fake address.
    expect(person.crmContact).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("email_not_unlocked");
    // The reveal still gave the two fields enrich_find_email needs next.
    expect(person.fullName).toBe("Andrew Huisman");
    expect(person.orgDomain).toBe("acme.com");
    // And hands them over already named the way that tool wants them, with
    // the rest of the contact waiting under a name nobody can mistake for a
    // call they can make yet.
    expect(person.enrichFindEmail).toEqual({
      fullName: "Andrew Huisman",
      orgDomain: "acme.com",
    });
    expect(person.crmContactPendingEmail).toEqual({
      name: "Andrew Huisman",
      org: "Acme",
      orgDomain: "acme.com",
    });
  });

  it("offers no next step for a revealed person with no employer domain", async () => {
    stubVendor((url) => {
      if (url.endsWith("/people/match")) {
        return {
          body: {
            person: { id: "p1", first_name: "Andrew", last_name: "Huisman" },
          },
        };
      }
      return { body: { people: [SEARCH_HIT] } };
    });

    const result = await service("k").findPeople({ orgDomains: ["acme.com"], reveal: true });
    const person = result.people[0];
    expect(person.emailStatus).toBe("absent");
    expect(person.crmContact).toBeUndefined();
    // enrich_find_email cannot run without a domain, so no arguments for it
    // are offered. An absent field is the honest answer; a half-filled one
    // would invite a paid call that is refused.
    expect(person.enrichFindEmail).toBeUndefined();
    expect(person.crmContactPendingEmail).toEqual({ name: "Andrew Huisman" });
  });

  it("caps a revealing call harder than a free one", async () => {
    const calls = stubVendor((url) => {
      if (url.endsWith("/people/match")) return { body: { person: { id: "x", email: null } } };
      return { body: { people: Array.from({ length: 100 }, (_, i) => ({ ...SEARCH_HIT, id: `p${i}` })) } };
    });

    await service("k").findPeople({ titles: ["cto"], limit: 999 });
    expect(calls[0].body.per_page).toBe(MAX_PEOPLE_LIMIT);

    const revealed = await service("k").findPeople({ titles: ["cto"], limit: 999, reveal: true });
    expect(calls[1].body.per_page).toBe(PROSPECT_REVEAL_LIMIT);
    expect(revealed.revealed).toBe(PROSPECT_REVEAL_LIMIT);
    expect(calls.filter((c) => c.url.endsWith("/people/match"))).toHaveLength(PROSPECT_REVEAL_LIMIT);
  });
});

describe("apollo failures", () => {
  it("names the endpoint on a 403 and tells the operator not to retry", async () => {
    stubVendor(() => ({ status: 403, body: { error: "insufficient scope" } }));
    await expect(service("k").findPeople({ titles: ["cto"] })).rejects.toThrow(
      /HTTP 403.*scoped to other endpoints.*mixed_people\/api_search.*Do not retry/s,
    );
  });

  it("reports the rate limit with the wait Apollo asked for", async () => {
    stubVendor(() => ({
      status: 429,
      body: { error: "rate limited" },
      headers: { "retry-after": "30", "x-minute-requests-left": "0" },
    }));
    await expect(service("k").findCompanies({ keywords: ["saas"] })).rejects.toThrow(
      /HTTP 429.*Retry after 30s.*Requests left this minute: 0/s,
    );
  });

  it("never puts the key in an error message", async () => {
    stubVendor(() => ({ status: 401, body: { error: "unauthorized" } }));
    const err = await service("sk-secret-value")
      .findCompanies({ keywords: ["saas"] })
      .catch((e: Error) => e);
    expect(String(err)).not.toContain("sk-secret-value");
    expect(String(err)).toMatch(/HTTP 401/);
  });

  it("refuses with the connector name and the env key when no key is set", async () => {
    const calls = stubVendor(() => ({ body: {} }));
    const empty = service(undefined);
    expect(empty.isConfigured()).toBe(false);
    await expect(empty.findCompanies({ keywords: ["saas"] })).rejects.toThrow(
      new RegExp(`Settings > Connectors.*${APOLLO_ENV_KEY}.*${HUNTER_ENV_KEY}`, "s"),
    );
    await expect(empty.findPeople({ titles: ["cto"] })).rejects.toThrow(
      /No prospecting provider is configured/,
    );
    expect(calls).toHaveLength(0);
  });

  it("reads the key live, so one saved after construction works", async () => {
    const calls = stubVendor(() => ({ body: { organizations: [] } }));
    let key: string | undefined;
    const svc = new ProspectingService({ getKey: () => key });
    expect(svc.isConfigured()).toBe(false);

    key = "saved-in-settings";
    expect(svc.isConfigured()).toBe(true);
    await svc.findCompanies({ keywords: ["saas"] });
    expect(calls[0].headers["x-api-key"]).toBe("saved-in-settings");
  });

  it("holds a ten second deadline on one call", async () => {
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    vi.useFakeTimers();
    const pending = new ApolloProvider("k").findCompanies({ keywords: ["saas"] }, 5);
    const assertion = expect(pending).rejects.toThrow(/timed out after 10s/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
  });
});

/**
 * Hunter, tested at the same two seams, plus the one that only exists now
 * there are two vendors: which of them a search reaches.
 *
 * The request Hunter would receive is half the contract here too. Hunter's
 * filters are not Apollo's, and a filter quietly dropped rather than mapped is
 * a different question answered under the name of the one that was asked.
 */
const HUNTER_EMAIL = {
  value: "Andrew@Acme.com",
  type: "personal",
  confidence: 94,
  first_name: "Andrew",
  last_name: "Huisman",
  position: "VP of Sales",
  seniority: "executive",
  department: "sales",
  linkedin: "https://www.linkedin.com/in/andrew",
  verification: { date: "2026-01-01", status: "valid" },
};

/** A service with a Hunter key and no Apollo key, which is the fallback case. */
function hunterOnly(): ProspectingService {
  return new ProspectingService({ getKey: (id) => (id === "hunter" ? "h-1" : undefined) });
}

describe("choosing a prospecting provider", () => {
  it("uses Apollo when both keys are set, and says so on the result", async () => {
    const calls = stubVendor(() => ({ body: { organizations: [ACME_ORG], pagination: {} } }));
    const both = new ProspectingService({ getKey: (id) => (id === "apollo" ? "a-1" : "h-1") });

    expect(both.providerId()).toBe("apollo");
    const result = await both.findCompanies({ keywords: ["saas"] });
    expect(result.provider).toBe("apollo");
    expect(calls[0].url).toContain("apollo.io");
    expect(calls[0].url).not.toContain("hunter.io");
  });

  it("falls back to Hunter when only its key is set, rather than refusing", async () => {
    const calls = stubVendor(() => ({ body: { data: [], meta: { results: 0 } } }));
    const svc = hunterOnly();

    expect(svc.isConfigured()).toBe(true);
    expect(svc.providerId()).toBe("hunter");
    const result = await svc.findCompanies({ keywords: ["saas"] });
    expect(result.provider).toBe("hunter");
    expect(calls[0].url).toContain("hunter.io/v2/discover");
  });

  it("is off only when neither key is set", () => {
    expect(new ProspectingService({ getKey: () => undefined }).providerId()).toBeNull();
    expect(new ProspectingService({ getKey: () => "  " }).providerId()).toBeNull();
  });
});

describe("hunter company search", () => {
  it("sends the filters Discover takes structured, and the rest as its query", async () => {
    const calls = stubVendor(() => ({
      body: {
        data: [
          {
            domain: "acme.com",
            organization: "Acme Logistics",
            emails_count: { personal: 12, generic: 3, total: 15 },
          },
        ],
        meta: { results: 240 },
      },
    }));

    const result = await hunterOnly().findCompanies({
      keywords: ["saas", "logistics"],
      locations: ["Belgium"],
      excludeLocations: ["France"],
      domains: ["https://www.other.com/"],
      name: "Acme",
      minEmployees: 10,
      maxEmployees: 60,
      limit: 5,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({
      organization: { domain: ["other.com"], name: ["Acme"] },
      // 10 to 60 touches three of Hunter's buckets. Sending only the bucket
      // the minimum falls in would silently drop the companies in the middle
      // of the range the caller asked for.
      headcount: ["1-10", "11-50", "51-200"],
      query: "saas logistics companies in Belgium not in France",
    });
    expect(result.total).toBe(240);
    expect(result.companies[0]).toEqual({
      name: "Acme Logistics",
      domain: "acme.com",
      industry: null,
      headcount: null,
      location: null,
      linkedinUrl: null,
      apolloOrgId: null,
      contactsKnown: 12,
    });
  });

  it("never sends limit, which Discover only accepts on a Premium plan", async () => {
    const calls = stubVendor(() => ({
      // Discover answers with its own page size whatever was asked for.
      body: { data: Array.from({ length: 8 }, (_, i) => ({ domain: `d${i}.com` })), meta: {} },
    }));

    const result = await hunterOnly().findCompanies({ keywords: ["saas"], limit: 3 });

    expect(calls[0].body).not.toHaveProperty("limit");
    // The page is cut here instead, so a free-plan install still gets the size
    // it asked for rather than a 4xx.
    expect(result.companies).toHaveLength(3);
    expect(result.returned).toBe(3);
  });

  it("says what Discover did not answer, so a thin row is not read as a fact", async () => {
    stubVendor(() => ({ body: { data: [], meta: { results: 0 } } }));
    const result = await hunterOnly().findCompanies({ keywords: ["saas"], locations: ["Belgium"] });

    expect(result.notes.join(" ")).toMatch(/Hunter answered this, not Apollo/);
    expect(result.notes.join(" ")).toMatch(/null because Hunter did not say/);
    // The location half of the filter went into a plain-language question, so
    // an agent must not report it as an exact filter.
    expect(result.notes.join(" ")).toMatch(/approximate/);
  });

  it("keeps the key out of the body, and the same refusal for no filter at all", async () => {
    const calls = stubVendor(() => ({ body: { data: [], meta: {} } }));
    await expect(hunterOnly().findCompanies({})).rejects.toThrow(/at least one filter/);
    expect(calls).toHaveLength(0);
  });
});

describe("hunter people search", () => {
  it("searches each domain, maps the filters, and hands back a whole person", async () => {
    const calls = stubVendor(() => ({
      body: {
        data: { domain: "acme.com", organization: "Acme Logistics", emails: [HUNTER_EMAIL] },
        meta: { results: 12 },
      },
    }));

    const result = await hunterOnly().findPeople({
      orgDomains: ["https://www.Acme.com/about"],
      titles: ["vp of sales", "head of sales"],
      seniorities: ["vp", "director", "nonsense"],
      limit: 10,
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.hunter.io/v2/domain-search");
    expect(url.searchParams.get("domain")).toBe("acme.com");
    expect(url.searchParams.get("limit")).toBe("10");
    // Generic mailboxes are info@ and sales@: not a person to write to.
    expect(url.searchParams.get("type")).toBe("personal");
    expect(url.searchParams.get("job_titles")).toBe("vp of sales,head of sales");
    // Apollo's eleven bands fold into Hunter's three, deduplicated, and a
    // value neither vocabulary has is dropped rather than sent.
    expect(url.searchParams.get("seniority")).toBe("executive,senior");

    expect(result.provider).toBe("hunter");
    expect(result.total).toBe(12);
    // Nothing was locked, so the count of people an agent can write to is the
    // count it got, and no per-person credit was spent to get there.
    expect(result.revealed).toBe(1);
    expect(result.people[0]).toEqual({
      fullName: "Andrew Huisman",
      firstName: "Andrew",
      lastName: "Huisman",
      title: "VP of Sales",
      orgName: "Acme Logistics",
      orgDomain: "acme.com",
      linkedinUrl: "https://www.linkedin.com/in/andrew",
      email: "andrew@acme.com",
      emailStatus: "verified",
      revealed: true,
      apolloPersonId: null,
      crmContact: {
        email: "andrew@acme.com",
        name: "Andrew Huisman",
        title: "VP of Sales",
        org: "Acme Logistics",
        orgDomain: "acme.com",
      },
    });
  });

  it("refuses a title-only search rather than pretending Hunter can answer it", async () => {
    const calls = stubVendor(() => ({ body: { data: { emails: [] }, meta: {} } }));
    await expect(hunterOnly().findPeople({ titles: ["cto"] })).rejects.toThrow(
      /orgDomains is required.*prospect_find_companies/s,
    );
    expect(calls).toHaveLength(0);
  });

  it("bounds the domains it visits, because each one is a billed request", async () => {
    const calls = stubVendor(() => ({
      body: { data: { organization: "Acme", emails: [] }, meta: { results: 0 } },
    }));
    const domains = Array.from({ length: 9 }, (_, i) => `d${i}.com`);
    const result = await hunterOnly().findPeople({ orgDomains: domains });

    expect(calls).toHaveLength(HUNTER_DOMAIN_LIMIT);
    expect(result.notes.join(" ")).toMatch(
      new RegExp(`first ${HUNTER_DOMAIN_LIMIT} of ${domains.length} domains`),
    );
    // The domains nobody searched are named, so "no results" is not read as
    // "nobody works at any of these".
    expect(result.notes.join(" ")).toContain("d8.com");
  });

  it("stops asking once the limit is met, rather than buying rows it throws away", async () => {
    const calls = stubVendor(() => ({
      body: { data: { organization: "Acme", emails: [HUNTER_EMAIL] }, meta: { results: 1 } },
    }));

    const result = await hunterOnly().findPeople({
      orgDomains: ["a.com", "b.com", "c.com"],
      limit: 2,
    });

    // Two domains filled the limit, so the third was never requested: Hunter
    // bills a call that returns anybody, and its rows would have been cut off.
    expect(calls).toHaveLength(2);
    expect(result.people).toHaveLength(2);
    expect(result.notes.join(" ")).toMatch(/Searched the first 2 of 3 domains/);
    expect(result.notes.join(" ")).toContain("c.com");
  });

  it("says out loud which filters Hunter threw away", async () => {
    stubVendor(() => ({ body: { data: { emails: [] }, meta: {} } }));
    const result = await hunterOnly().findPeople({
      orgDomains: ["acme.com"],
      organizationIds: ["5e66b6381e05b4008c8331b8"],
      locations: ["Belgium"],
      keywords: "logistics",
    });

    expect(result.notes.join(" ")).toMatch(/organizationIds were ignored/);
    expect(result.notes.join(" ")).toMatch(/person-location and keywords filters were ignored/);
  });

  it("does not pull a Hunter search down to the Apollo reveal cap", async () => {
    const calls = stubVendor(() => ({ body: { data: { emails: [] }, meta: {} } }));
    // Apollo caps a revealing search at ten because each person billed. Hunter
    // bills per call, so the same cap would throw away free rows.
    await hunterOnly().findPeople({ orgDomains: ["acme.com"], reveal: true, limit: 999 });
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe(String(MAX_PEOPLE_LIMIT));
  });

  it("retries one domain at the free-plan page when Hunter refuses the size", async () => {
    // Hunter's own pagination_error: "the limit additioned to the offset is
    // higher than 10 for a Free plan user". The paid plan is not punished for
    // it, so the asked-for size goes out first and only the refusal drops it.
    const calls = stubVendor((url) => {
      const asked = Number(new URL(url).searchParams.get("limit"));
      if (asked > HUNTER_FREE_PLAN_PAGE) {
        return {
          status: 400,
          body: {
            errors: [
              {
                id: "pagination_error",
                code: 400,
                details: "The supplied limit or offset is invalid.",
              },
            ],
          },
        };
      }
      return {
        body: { data: { organization: "Acme", emails: [HUNTER_EMAIL] }, meta: { results: 1 } },
      };
    });

    const result = await hunterOnly().findPeople({
      orgDomains: ["a.com", "b.com"],
      limit: 40,
    });

    // a.com: refused at 20, retried at 10. b.com: asked at 10 straight away,
    // because the plan is known by then and a second refusal buys nothing.
    expect(calls.map((c) => new URL(c.url).searchParams.get("limit"))).toEqual(["20", "10", "10"]);
    expect(result.people).toHaveLength(2);
    expect(result.notes.join(" ")).toMatch(
      new RegExp(`at most ${HUNTER_FREE_PLAN_PAGE} people per domain`),
    );
  });

  it("does not retry a failure that is not the page size", async () => {
    const calls = stubVendor(() => ({
      status: 400,
      body: { errors: [{ id: "invalid_seniority", code: 400, details: "Bad seniority." }] },
    }));

    await expect(
      hunterOnly().findPeople({ orgDomains: ["a.com"], limit: 40 }),
    ).rejects.toThrow(/HTTP 400.*Bad seniority/s);
    // One billed attempt, not two: the same request would fail the same way.
    expect(calls).toHaveLength(1);
  });

  it("takes Hunter's own words for a failure, without the key", async () => {
    stubVendor(() => ({
      status: 401,
      body: { errors: [{ id: "wrong_auth", code: 401, details: "Invalid API key." }] },
    }));
    const svc = new ProspectingService({
      getKey: (id) => (id === "hunter" ? "hk-secret-value" : undefined),
    });
    const err = await svc.findCompanies({ keywords: ["saas"] }).catch((e: Error) => e);

    expect(String(err)).toMatch(/HTTP 401.*Invalid API key/s);
    expect(String(err)).not.toContain("hk-secret-value");
  });

  it("holds the same ten second deadline on one call", async () => {
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    vi.useFakeTimers();
    const pending = new HunterProspectingProvider("k").findCompanies({ keywords: ["saas"] }, 5);
    const assertion = expect(pending).rejects.toThrow(/timed out after 10s/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
  });
});

/**
 * Web search as the last resort, and the line it must not cross.
 *
 * The value here is that an install with only a search key can still answer
 * "who is in this market". The risk is that a ranking reads like a database,
 * so most of what is asserted below is what the module refuses to claim.
 */
const HITS = [
  { title: "Acme Logistics | Freight software", url: "https://www.acme.com/", snippet: "" },
  { title: "10 best logistics SaaS", url: "https://blog.directory.com/best", snippet: "" },
  { title: "Acme on LinkedIn", url: "https://de.linkedin.com/company/acme", snippet: "" },
  { title: "Acme Logistics - About", url: "https://acme.com/about", snippet: "" },
];

/** A service with no vendor key at all, only a search callback. */
function webOnly(hits = HITS): { svc: ProspectingService; asked: string[] } {
  const asked: string[] = [];
  const svc = new ProspectingService({
    getKey: () => undefined,
    search: async (query, numResults) => {
      asked.push(query);
      return hits.slice(0, numResults);
    },
    searchConfigured: () => true,
  });
  return { svc, asked };
}

describe("web search as the last prospecting resort", () => {
  it("is chosen only when neither vendor key is set", async () => {
    const { svc } = webOnly();
    expect(svc.isConfigured()).toBe(true);
    expect(svc.providerId()).toBe("web");

    const withHunter = new ProspectingService({
      getKey: (id) => (id === "hunter" ? "h-1" : undefined),
      search: async () => HITS,
      searchConfigured: () => true,
    });
    // A vendor that holds records beats a ranking, whatever it costs.
    expect(withHunter.providerId()).toBe("hunter");
  });

  it("is not offered when there is no search key either", () => {
    const svc = new ProspectingService({
      getKey: () => undefined,
      search: async () => HITS,
      searchConfigured: () => false,
    });
    expect(svc.providerId()).toBeNull();
    expect(svc.isConfigured()).toBe(false);
  });

  it("searches in the operator's own words and returns one row per company", async () => {
    const { svc, asked } = webOnly();
    const result = await svc.findCompanies({
      keywords: ["logistics saas"],
      locations: ["Belgium"],
      minEmployees: 10,
      maxEmployees: 50,
    });

    expect(asked).toEqual(["logistics saas companies in Belgium"]);
    expect(result.provider).toBe("web");
    // LinkedIn is not the company. The directory article is kept, because for
    // a market question it is often the best hit there is, and it is kept at
    // the host it actually lives on rather than folded to the parent domain.
    expect(result.companies.map((c) => c.domain)).toEqual(["acme.com", "blog.directory.com"]);
    expect(result.companies[0]).toEqual({
      name: "Acme Logistics",
      domain: "acme.com",
      industry: null,
      headcount: null,
      location: null,
      linkedinUrl: null,
      apolloOrgId: null,
      sourceUrl: "https://www.acme.com/",
    });
  });

  it("never reports a ranking as a count of what exists", async () => {
    const { svc } = webOnly();
    const result = await svc.findCompanies({ keywords: ["logistics"] });

    // total is what came back and nothing more: a search engine cannot say how
    // many companies match, and a number here would be read as if it could.
    expect(result.total).toBe(result.companies.length);
    expect(result.returned).toBe(result.companies.length);
  });

  it("says what a search result is, and which filter it could not apply", async () => {
    const { svc } = webOnly();
    const result = await svc.findCompanies({ keywords: ["logistics"], minEmployees: 10 });
    const notes = result.notes.join(" ");

    expect(notes).toMatch(/not a vetted list of companies/);
    expect(notes).toMatch(/directories or articles/);
    expect(notes).toMatch(/minEmployees and maxEmployees filters could not be applied/);
    expect(notes).toMatch(/excludeLocations was ignored/);
    expect(notes).toMatch(/There is no total/);
    expect(notes).toMatch(/social networks/);
  });

  it("points the search at the domains asked for and drops what is not on them", async () => {
    const { svc, asked } = webOnly();
    const result = await svc.findCompanies({ domains: ["https://www.Acme.com/about"] });

    // Without the domains the query was the bare word "companies", which is
    // not the question anybody asked.
    expect(asked).toEqual(["companies site:acme.com"]);
    // The directory article about Acme is not Acme, and crm_org_upsert would
    // have taken it for a company.
    expect(result.companies.map((c) => c.domain)).toEqual(["acme.com"]);
    expect(result.notes.join(" ")).toMatch(/other hosts than the domains you asked for/);
  });

  it("counts a subdomain of an asked-for domain as that company, under that domain", async () => {
    const { svc } = webOnly([
      { title: "Careers at Acme", url: "https://careers.acme.com/", snippet: "" },
      { title: "Acme review", url: "https://blog.directory.com/acme", snippet: "" },
    ]);
    const result = await svc.findCompanies({ domains: ["acme.com"] });

    // The company is acme.com, not the host the page happened to sit on: the
    // CRM keys organisations by exact domain, so a careers.acme.com row here
    // would become a second organisation for the same company.
    expect(result.companies.map((c) => c.domain)).toEqual(["acme.com"]);
    // The page itself is not lost.
    expect(result.companies[0]?.sourceUrl).toBe("https://careers.acme.com/");
  });

  it("collapses two subdomains of one asked-for domain into one row", async () => {
    const { svc } = webOnly([
      { title: "Careers at Acme", url: "https://careers.acme.com/jobs", snippet: "" },
      { title: "Acme Logistics", url: "https://www.acme.com/", snippet: "" },
      { title: "Acme docs", url: "https://docs.acme.com/", snippet: "" },
    ]);
    const result = await svc.findCompanies({ domains: ["acme.com"] });

    expect(result.companies.map((c) => c.domain)).toEqual(["acme.com"]);
    // The first hit wins, as it does for any repeat of the same domain.
    expect(result.companies[0]?.sourceUrl).toBe("https://careers.acme.com/jobs");
  });

  it("says why an empty answer is empty when the domains filter took everything", async () => {
    const { svc } = webOnly([
      { title: "10 best logistics SaaS", url: "https://blog.directory.com/best", snippet: "" },
    ]);
    const result = await svc.findCompanies({ domains: ["acme.com"] });

    expect(result.companies).toEqual([]);
    // Empty must not read as "acme.com does not exist".
    expect(result.notes.join(" ")).toMatch(/none of them were on acme\.com/);
  });

  it("refuses a people search and names the path that does work", async () => {
    const { svc } = webOnly();
    await expect(svc.findPeople({ orgDomains: ["acme.com"] })).rejects.toThrow(
      /web_fetch.*enrich_address_pattern.*enrich_verify_email/s,
    );
  });
});

describe("prospecting tools", () => {
  const platform = (svc: ProspectingService): ProspectingPlatform => ({ prospectingService: svc });

  it("says on both tools that a prospect is not permission to mail them", () => {
    expect(PROSPECTING_TOOLS.map((t) => t.name)).toEqual([
      "prospect_find_companies",
      "prospect_find_people",
    ]);
    for (const tool of PROSPECTING_TOOLS) {
      expect(tool.description).toContain("does not permit mailing them");
      expect(tool.description).toContain("outbox_queue_draft");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("dispatches both tools and accepts a bare string for a list argument", async () => {
    const calls = stubVendor((url) => {
      if (url.endsWith("/mixed_companies/search")) return { body: { organizations: [ACME_ORG] } };
      return { body: { people: [SEARCH_HIT] } };
    });
    const p = platform(service("k"));

    const companies: any = await dispatchProspectingTool(p, "prospect_find_companies", {
      keywords: "saas",
      minEmployees: 10,
      maxEmployees: 50,
      limit: 4,
    });
    expect(companies.companies[0].domain).toBe("acme.com");
    expect(calls[0].body.q_organization_keyword_tags).toEqual(["saas"]);

    const people: any = await dispatchProspectingTool(p, "prospect_find_people", {
      orgDomains: "acme.com",
      titles: ["vp of sales"],
    });
    expect(people.people[0].orgName).toBe("Acme Logistics");
    expect(calls[1].body.q_organization_domains_list).toEqual(["acme.com"]);

    await expect(dispatchProspectingTool(p, "prospect_nope", {})).rejects.toThrow(/unknown tool/);
  });
});

describe("the apollo connector", () => {
  it("is registered as its own kind, with the documented env name", () => {
    const apollo = connectorById("apollo");
    expect(apollo).toEqual({
      id: "apollo",
      label: "Apollo",
      kind: "prospecting",
      envSuffix: "APOLLO_API_KEY",
    });
    expect(CONNECTORS.filter((c) => c.kind === "search").map((c) => c.id)).toEqual([
      "exa",
      "parallel",
    ]);
  });

  it("gives every launched agent profile both tools", () => {
    for (const name of PROSPECTING_TOOL_NAMES) {
      expect(scopeAllows("chat", name)).toBe(true);
      expect(scopeAllows("driven", name)).toBe(true);
      expect(scopeAllows("run", name)).toBe(true);
    }
  });
});
