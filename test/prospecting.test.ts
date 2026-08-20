/**
 * Prospecting, tested at the two seams that matter: the request Apollo would
 * receive, and the record an agent would read back.
 *
 * The call log is half the contract. A filter mapped to the wrong Apollo field
 * name is not a wrong answer, it is a different question asked with the
 * operator's credits, and normalisation alone would never catch it.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { ApolloProvider } from "../src/prospecting/apollo.js";
import {
  APOLLO_ENV_KEY,
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
function stubApollo(
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
    const calls = stubApollo(() => ({ body: { organizations: [ACME_ORG], pagination: { total_entries: 812 } } }));
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
    stubApollo(() => ({
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
    const calls = stubApollo(() => ({ body: { organizations: [] } }));
    await service("k").findCompanies({ keywords: ["saas"], limit: 5_000 });
    expect(calls[0].body.per_page).toBe(MAX_COMPANY_LIMIT);
    expect(calls[0].body.page).toBe(1);

    await service("k").findCompanies({ keywords: ["saas"] });
    expect(calls[1].body.per_page).toBe(DEFAULT_COMPANY_LIMIT);
  });

  it("refuses an unfiltered search rather than spending a credit on it", async () => {
    const calls = stubApollo(() => ({ body: { organizations: [] } }));
    await expect(service("k").findCompanies({})).rejects.toThrow(/at least one filter/);
    expect(calls).toHaveLength(0);
  });

  it("passes on a truncated result and a suppressed EU account", async () => {
    stubApollo(() => ({
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
    const calls = stubApollo(() => ({ body: { organizations: [], pagination: {} } }));
    await service("k-1").findCompanies({ domains: ["acme", "ACME Corp"] });

    expect(calls[0].body.q_organization_domains_list).toEqual(["acme", "acme corp"]);
    expect(calls[0].body).toHaveProperty("q_organization_domains_list");
  });

  it("still folds a pasted URL, port and all, down to the bare host", async () => {
    const calls = stubApollo(() => ({ body: { organizations: [], pagination: {} } }));
    await service("k-1").findCompanies({
      domains: ["https://www.Acme.com:8443/about?x=1", "acme.com"],
    });

    expect(calls[0].body.q_organization_domains_list).toEqual(["acme.com", "acme.com"]);
  });
});

describe("apollo people search", () => {
  it("maps the filters and never returns the obfuscated last name", async () => {
    const calls = stubApollo(() => ({ body: { people: [SEARCH_HIT], pagination: { total_entries: 9 } } }));
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
    const calls = stubApollo(() => ({ body: { people: [] } }));
    await service("k").findPeople({ titles: ["cto"] });
    expect(calls[0].url).not.toMatch(/\/mixed_people\/search$/);
    expect(calls[0].url).not.toMatch(/\/people\/search$/);
  });

  it("reveals by Apollo id and hands back crm_contact_upsert arguments", async () => {
    const calls = stubApollo((url) => {
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
    stubApollo((url) => {
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
    stubApollo((url) => {
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
    stubApollo((url) => {
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
    const calls = stubApollo((url) => {
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
    stubApollo(() => ({ status: 403, body: { error: "insufficient scope" } }));
    await expect(service("k").findPeople({ titles: ["cto"] })).rejects.toThrow(
      /HTTP 403.*scoped to other endpoints.*mixed_people\/api_search.*Do not retry/s,
    );
  });

  it("reports the rate limit with the wait Apollo asked for", async () => {
    stubApollo(() => ({
      status: 429,
      body: { error: "rate limited" },
      headers: { "retry-after": "30", "x-minute-requests-left": "0" },
    }));
    await expect(service("k").findCompanies({ keywords: ["saas"] })).rejects.toThrow(
      /HTTP 429.*Retry after 30s.*Requests left this minute: 0/s,
    );
  });

  it("never puts the key in an error message", async () => {
    stubApollo(() => ({ status: 401, body: { error: "unauthorized" } }));
    const err = await service("sk-secret-value")
      .findCompanies({ keywords: ["saas"] })
      .catch((e: Error) => e);
    expect(String(err)).not.toContain("sk-secret-value");
    expect(String(err)).toMatch(/HTTP 401/);
  });

  it("refuses with the connector name and the env key when no key is set", async () => {
    const calls = stubApollo(() => ({ body: {} }));
    const empty = service(undefined);
    expect(empty.isConfigured()).toBe(false);
    await expect(empty.findCompanies({ keywords: ["saas"] })).rejects.toThrow(
      new RegExp(`Settings > Connectors.*${APOLLO_ENV_KEY}`, "s"),
    );
    await expect(empty.findPeople({ titles: ["cto"] })).rejects.toThrow(/Apollo is not configured/);
    expect(calls).toHaveLength(0);
  });

  it("reads the key live, so one saved after construction works", async () => {
    const calls = stubApollo(() => ({ body: { organizations: [] } }));
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
    const calls = stubApollo((url) => {
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
