import { describe, it, expect, afterEach, vi } from "vitest";
import {
  allProviders,
  exaProvider,
  parallelProvider,
  EXA_ENV_KEY,
  PARALLEL_ENV_KEY,
} from "../src/research/providers.js";
import {
  ResearchService,
  clampResults,
  DEFAULT_NUM_RESULTS,
  MAX_NUM_RESULTS,
} from "../src/research/service.js";
import {
  RESEARCH_TOOLS,
  RESEARCH_TOOL_NAMES,
  dispatchResearchTool,
} from "../src/research/tools.js";
import { extractTitle, htmlToText, MAX_PAGE_CHARS } from "../src/research/fetch-page.js";
import type { SearchProvider } from "../src/research/types.js";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/**
 * Records what the provider sent and answers with one canned body, the same
 * shape test/calendar-attendee-status.test.ts uses for Google. The call log is
 * the point: normalisation is only half the contract, the request we make is
 * the other half.
 */
function stubApi(body: unknown, opts: { status?: number; text?: string } = {}): Call[] {
  const calls: Call[] = [];
  const fetchStub = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const status = opts.status ?? 200;
    if (status !== 200) {
      return new Response(opts.text ?? "nope", { status });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", fetchStub);
  return calls;
}

/** A provider that answers instantly, for the selection and clamping tests. */
function fakeProvider(id: string, configured: boolean): SearchProvider {
  return {
    id,
    isConfigured: () => configured,
    async search(query, opts) {
      return Array.from({ length: opts.numResults }, (_, i) => ({
        title: `${id} ${query} ${i}`,
        url: `https://example.com/${id}/${i}`,
        snippet: "",
      }));
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("research tool surface", () => {
  it("exposes exactly the two spec tools", () => {
    expect(RESEARCH_TOOLS.map((t) => t.name).sort()).toEqual(["web_fetch", "web_search"]);
    expect([...RESEARCH_TOOL_NAMES].sort()).toEqual(["web_fetch", "web_search"]);
  });

  it("closes every input schema", () => {
    for (const tool of RESEARCH_TOOLS) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(80);
    }
  });
});

describe("exa provider", () => {
  it("normalises results and asks for page text", async () => {
    const calls = stubApi({
      results: [
        {
          title: "Acme Corp",
          url: "https://acme.example/about",
          text: "  Acme  makes\n anvils. ",
          publishedDate: "2026-01-02T00:00:00Z",
          score: 0.9,
        },
      ],
    });
    const provider = exaProvider({ apiKey: () => "key-1" });
    const results = await provider.search("acme corp", { numResults: 3 });

    expect(results).toEqual([
      {
        title: "Acme Corp",
        url: "https://acme.example/about",
        snippet: "Acme makes anvils.",
        publishedDate: "2026-01-02T00:00:00Z",
      },
    ]);
    expect(calls[0].url).toBe("https://api.exa.ai/search");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["x-api-key"]).toBe("key-1");
    expect(calls[0].body).toMatchObject({ query: "acme corp", numResults: 3 });
    expect((calls[0].body as { contents: unknown }).contents).toBeTruthy();
  });

  it("drops a hit with no url and falls back to the url for a missing title", async () => {
    stubApi({
      results: [
        { title: "no url here", text: "orphan" },
        { url: "https://acme.example/x" },
      ],
    });
    const results = await exaProvider({ apiKey: () => "k" }).search("q", { numResults: 5 });
    expect(results).toEqual([
      { title: "https://acme.example/x", url: "https://acme.example/x", snippet: "" },
    ]);
  });

  it("names the provider and the status when the API fails", async () => {
    stubApi(null, { status: 401, text: "bad key" });
    await expect(exaProvider({ apiKey: () => "k" }).search("q", { numResults: 1 })).rejects.toThrow(
      /exa search failed \(HTTP 401\)/,
    );
  });

  it("names the env key when it has none", async () => {
    await expect(
      exaProvider({ apiKey: () => undefined }).search("q", { numResults: 1 }),
    ).rejects.toThrow(EXA_ENV_KEY);
  });
});

describe("parallel provider", () => {
  it("joins excerpts into one snippet and sends the objective", async () => {
    const calls = stubApi({
      results: [
        {
          title: "Acme Corp",
          url: "https://acme.example/",
          excerpts: ["Acme makes anvils.", "Founded 1949."],
          published_date: "2026-02-03",
        },
      ],
    });
    const results = await parallelProvider({ apiKey: () => "key-2" }).search("acme", {
      numResults: 2,
    });

    expect(results).toEqual([
      {
        title: "Acme Corp",
        url: "https://acme.example/",
        snippet: "Acme makes anvils. Founded 1949.",
        publishedDate: "2026-02-03",
      },
    ]);
    expect(calls[0].url).toBe("https://api.parallel.ai/v1beta/search");
    expect(calls[0].headers["x-api-key"]).toBe("key-2");
    expect(calls[0].body).toMatchObject({ objective: "acme", search_queries: ["acme"] });
  });

  it("survives a body with no results array", async () => {
    stubApi({ ok: true });
    const results = await parallelProvider({ apiKey: () => "k" }).search("q", { numResults: 3 });
    expect(results).toEqual([]);
  });

  it("names the env key when it has none", async () => {
    await expect(
      parallelProvider({ apiKey: () => undefined }).search("q", { numResults: 1 }),
    ).rejects.toThrow(PARALLEL_ENV_KEY);
  });
});

describe("provider selection", () => {
  it("uses the first configured provider when none is named", async () => {
    const service = new ResearchService({
      providers: [fakeProvider("exa", false), fakeProvider("parallel", true)],
    });
    const res = await service.search({ query: "anvils" });
    expect(res.provider).toBe("parallel");
  });

  it("prefers the earlier provider when both are configured", async () => {
    const service = new ResearchService({
      providers: [fakeProvider("exa", true), fakeProvider("parallel", true)],
    });
    expect((await service.search({ query: "q" })).provider).toBe("exa");
  });

  it("uses the provider the caller named", async () => {
    const service = new ResearchService({
      providers: [fakeProvider("exa", true), fakeProvider("parallel", true)],
    });
    const res = await service.search({ query: "q", provider: "Parallel" });
    expect(res.provider).toBe("parallel");
  });

  it("refuses a named provider that has no key rather than falling back", async () => {
    const service = new ResearchService({
      providers: [fakeProvider("exa", false), fakeProvider("parallel", true)],
    });
    await expect(service.search({ query: "q", provider: "exa" })).rejects.toThrow(
      `exa is not configured: set ${EXA_ENV_KEY}`,
    );
  });

  it("refuses an unknown provider and lists the known ones", async () => {
    const service = new ResearchService({ providers: [fakeProvider("exa", true)] });
    await expect(service.search({ query: "q", provider: "bing" })).rejects.toThrow(
      /unknown search provider: bing \(known providers: exa\)/,
    );
  });

  it("names both env keys when nothing is configured", async () => {
    const service = new ResearchService({
      providers: [fakeProvider("exa", false), fakeProvider("parallel", false)],
    });
    await expect(service.search({ query: "q" })).rejects.toThrow(
      new RegExp(`${PARALLEL_ENV_KEY}[\\s\\S]*${EXA_ENV_KEY}`),
    );
  });

  /**
   * The default order is a price decision, not a detail. Parallel does the same
   * search as Exa for a seventh of the money, so an operator who pasted both
   * keys and named neither must not be billed through the dearer one. See
   * allProviders() in src/research/providers.js for the figures.
   */
  it("prefers Parallel over Exa when a search names no provider", () => {
    expect(allProviders().map((provider) => provider.id)).toEqual(["parallel", "exa"]);
  });

  it("still reaches Exa when a search names it", async () => {
    const service = new ResearchService({
      providers: [fakeProvider("parallel", true), fakeProvider("exa", true)],
    });
    expect(service.select().id).toBe("parallel");
    expect(service.select("exa").id).toBe("exa");
  });

  it("reports which providers have a key", () => {
    const service = new ResearchService({
      providers: [fakeProvider("exa", false), fakeProvider("parallel", true)],
    });
    expect(service.listProviders()).toEqual([
      { id: "exa", configured: false },
      { id: "parallel", configured: true },
    ]);
  });
});

/**
 * The two HTTP seams are separate names because one of them IS the SSRF guard.
 * ResearchDeps used to intersect two types that both called theirs `fetch`, so
 * a stub meant for Exa silently replaced the transport behind web_fetch too.
 * These pin that each name reaches only what it is named for.
 */
describe("the two fetch seams", () => {
  it("sends searches through providerFetch and never through pageFetch", async () => {
    const provider: string[] = [];
    const page: string[] = [];
    const service = new ResearchService({
      getKey: () => "k",
      providerFetch: (async (input: string | URL | Request) => {
        provider.push(String(input));
        return new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof globalThis.fetch,
      pageFetch: (async (input: string | URL | Request) => {
        page.push(String(input));
        return new Response("no", { status: 500 });
      }) as typeof globalThis.fetch,
    });

    await service.search({ query: "anvils" });
    // Parallel, because it is first in allProviders() and this search names
    // nobody. The assertion is that ONE seam was used, not which vendor.
    expect(provider).toEqual(["https://api.parallel.ai/v1beta/search"]);
    expect(page).toEqual([]);
  });

  it("sends page reads through pageFetch and never through providerFetch", async () => {
    const provider: string[] = [];
    const page: string[] = [];
    const service = new ResearchService({
      getKey: () => "k",
      resolve: async () => ["93.184.216.34"],
      providerFetch: (async (input: string | URL | Request) => {
        provider.push(String(input));
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }) as typeof globalThis.fetch,
      pageFetch: (async (input: string | URL | Request) => {
        page.push(String(input));
        return new Response("<p>hello</p>", {
          headers: { "content-type": "text/html" },
        });
      }) as typeof globalThis.fetch,
    });

    const read = await service.fetch("https://example.com/about");
    expect(read.text).toBe("hello");
    expect(page).toEqual(["https://example.com/about"]);
    expect(provider).toEqual([]);
  });
});

describe("result count", () => {
  it("defaults and clamps instead of refusing", () => {
    expect(clampResults(undefined)).toBe(DEFAULT_NUM_RESULTS);
    expect(clampResults(Number.NaN)).toBe(DEFAULT_NUM_RESULTS);
    expect(clampResults(0)).toBe(1);
    expect(clampResults(-4)).toBe(1);
    expect(clampResults(99)).toBe(MAX_NUM_RESULTS);
    expect(clampResults(3.7)).toBe(3);
  });

  it("trims a provider that returns more than asked for", async () => {
    const service = new ResearchService({ providers: [fakeProvider("exa", true)] });
    const res = await service.search({ query: "q", numResults: 50 });
    expect(res.results).toHaveLength(MAX_NUM_RESULTS);
  });
});

describe("research tool dispatch", () => {
  const service = new ResearchService({ providers: [fakeProvider("exa", true)] });
  const platform = { researchService: service };

  it("runs web_search through the service", async () => {
    const res = (await dispatchResearchTool(platform, "web_search", {
      query: "  anvils  ",
      numResults: 2,
    })) as { provider: string; query: string; results: unknown[] };
    expect(res.provider).toBe("exa");
    expect(res.query).toBe("anvils");
    expect(res.results).toHaveLength(2);
  });

  it("requires a query", async () => {
    await expect(dispatchResearchTool(platform, "web_search", { query: "   " })).rejects.toThrow(
      "query is required",
    );
  });

  it("requires a url", async () => {
    await expect(dispatchResearchTool(platform, "web_fetch", {})).rejects.toThrow("url is required");
  });

  it("throws on a name it does not own", async () => {
    await expect(dispatchResearchTool(platform, "nope", {})).rejects.toThrow("unknown tool: nope");
  });
});

describe("html to text", () => {
  it("drops scripts, styles and tags and keeps paragraph shape", () => {
    const html = `<html><head><title>Acme &amp; Co</title><style>p{color:red}</style></head>
      <body><script>alert(1)</script><p>Acme makes anvils.</p><p>Since 1949.</p>
      <ul><li>Anvils</li><li>Rockets</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).not.toMatch(/alert|color:red|<p>/);
    expect(text).toContain("Acme makes anvils.");
    expect(text).toContain("Since 1949.");
    expect(text.split("\n").map((l) => l.trim())).toContain("Anvils");
  });

  it("decodes the entities that matter and reads the title", () => {
    expect(htmlToText("<p>Tom &amp; Jerry &#8212; &quot;hi&quot;</p>")).toBe(
      'Tom & Jerry — "hi"',
    );
    expect(extractTitle("<title>  Acme &amp;  Co </title>")).toBe("Acme & Co");
    expect(extractTitle("<p>no title</p>")).toBeUndefined();
  });

  it("has a page cap well above a snippet", () => {
    expect(MAX_PAGE_CHARS).toBeGreaterThan(10_000);
  });
});
