import { bareDomain } from "../src/domain.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { HunterProvider } from "../src/enrichment/hunter.js";
import { ProspeoProvider } from "../src/enrichment/prospeo.js";
import { EnrichmentService } from "../src/enrichment/service.js";
import {
  MAX_IMPORT_ROWS,
  parseContactCsv,
  type ImportContactRow,
} from "../src/enrichment/csv.js";
import {
  dispatchEnrichmentTool,
  ENRICHMENT_FREE_TOOL_NAMES,
  ENRICHMENT_LOCAL_TOOL_NAMES,
  ENRICHMENT_PAID_TOOL_NAMES,
  ENRICHMENT_TOOLS,
  type EnrichmentPlatform,
} from "../src/enrichment/tools.js";
import {
  PROVIDER_TIMEOUT_MS,
  type EnrichmentProvider,
  type EnrichmentResult,
  type FindEmailQuery,
} from "../src/enrichment/types.js";

type Call = { url: string; method: string; body?: string };

/**
 * Records every request and answers with a canned body. Providers are the only
 * part of this module that touches the network, so this is the one seam the
 * tests have to fake; everything else takes a real object.
 */
function stubFetch(reply: (url: string) => { status?: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const answer = reply(url);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Provider stand-in with a scripted answer and a call counter. */
function fakeProvider(
  id: string,
  answer: Partial<EnrichmentResult> | Error,
  counter: string[],
): EnrichmentProvider {
  const respond = async (): Promise<EnrichmentResult> => {
    counter.push(id);
    if (answer instanceof Error) throw answer;
    return {
      email: `found@acme.com`,
      confidence: 0,
      status: "unknown",
      provider: id,
      ...answer,
    };
  };
  return {
    id,
    findEmail: (_query: FindEmailQuery) => respond(),
    verifyEmail: (_email: string) => respond(),
  };
}

const NAME = { firstName: "Jane", lastName: "Doe", domain: "acme.com" };

/**
 * One fold, shared by the CSV import and the Apollo adapter, because the CRM
 * keys organisations by exact domain: two folds mean one company lands as two
 * rows. These are the cases the two copies used to disagree on.
 */
describe("bareDomain", () => {
  it("folds every way a domain gets written onto one host", () => {
    expect(bareDomain("https://www.Acme.com/about?x=1#top")).toBe("acme.com");
    expect(bareDomain("http://acme.com:8443/")).toBe("acme.com");
    expect(bareDomain("acme.com:8443")).toBe("acme.com");
    expect(bareDomain("  ACME.com  ")).toBe("acme.com");
    expect(bareDomain("ftp://acme.com")).toBe("acme.com");
    expect(bareDomain("https://user:pw@acme.com/x")).toBe("acme.com");
    expect(bareDomain("acme.com")).toBe("acme.com");
  });

  it("refuses what is not a domain", () => {
    expect(bareDomain("acme")).toBeNull();
    expect(bareDomain("")).toBeNull();
    expect(bareDomain(null)).toBeNull();
    expect(bareDomain(undefined)).toBeNull();
    expect(bareDomain("https://")).toBeNull();
  });
});

describe("enrichment tool surface", () => {
  it("exposes exactly the four spec tools", () => {
    expect(ENRICHMENT_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "crm_contacts_import",
        "enrich_address_pattern",
        "enrich_find_email",
        "enrich_verify_email",
      ].sort(),
    );
  });

  /**
   * The paid set is hand-written so a new tool cannot become a free-for-all by
   * being forgotten, and the free set is what a scheduled run is allowed to
   * reach. A tool in neither set, or in both, is a scope bug rather than a
   * naming one, so the sets are asserted rather than derived here too.
   */
  it("sorts every tool into exactly one spend group", () => {
    for (const tool of ENRICHMENT_TOOLS) {
      const groups = [
        ENRICHMENT_PAID_TOOL_NAMES.has(tool.name),
        ENRICHMENT_FREE_TOOL_NAMES.has(tool.name),
        ENRICHMENT_LOCAL_TOOL_NAMES.has(tool.name),
      ].filter(Boolean);
      expect(groups).toHaveLength(1);
    }
    expect([...ENRICHMENT_FREE_TOOL_NAMES]).toEqual(["enrich_address_pattern"]);
  });

  it("closes every input schema", () => {
    for (const tool of ENRICHMENT_TOOLS) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});

/**
 * Address patterns: the free path to an address, and the one that must never
 * be allowed to sound like a found one.
 *
 * Every test here is about restraint as much as inference. What the module
 * knows is which patterns the addresses already held follow; what it must
 * never do is present the result of applying one as a fact, or guess over an
 * address that was there to be looked up.
 */
describe("address patterns", () => {
  const ACME = [
    { email: "andrew.huisman@acme.com", name: "Andrew Huisman" },
    { email: "grace.hopper@acme.com", name: "Grace Hopper" },
    { email: "info@acme.com", name: null },
    { email: "someone.else@other.com", name: "Some One" },
  ];

  function patternService(known = ACME): EnrichmentService {
    return new EnrichmentService({
      providers: [],
      addressesAtDomain: () => known,
    });
  }

  it("learns the pattern and builds a candidate that says it is unchecked", () => {
    const result = patternService().addressPattern("Acme.com", "Ada Lovelace");

    // The address at other.com is not evidence about acme.com, and info@ has
    // no name to learn from.
    expect(result.addressesKnown).toBe(3);
    expect(result.namedKnown).toBe(2);
    expect(result.patterns[0]).toEqual({
      id: "first.last",
      matches: 2,
      example: "andrew.huisman@acme.com",
    });
    expect(result.candidate).toEqual({
      email: "ada.lovelace@acme.com",
      pattern: "first.last",
      derivedFrom: 2,
      verified: false,
    });
    expect(result.notes.join(" ")).toMatch(/is a guess/);
    expect(result.notes.join(" ")).toMatch(/enrich_verify_email before you queue/);
  });

  it("returns the real address rather than guessing at somebody it holds", () => {
    const result = patternService().addressPattern("acme.com", "Grace Hopper");

    expect(result.existing).toEqual({
      email: "grace.hopper@acme.com",
      name: "Grace Hopper",
    });
    // A guess over a held address is the worst outcome available, so there is
    // no candidate at all rather than one that happens to agree.
    expect(result.candidate).toBeNull();
    expect(result.notes.join(" ")).toMatch(/already in the CRM/);
  });

  it("says one example is one example", () => {
    const result = patternService([
      { email: "a.huisman@acme.com", name: "Andrew Huisman" },
    ]).addressPattern("acme.com", "Ada Lovelace");

    expect(result.candidate?.derivedFrom).toBe(1);
    expect(result.notes.join(" ")).toMatch(/coincidence/);
  });

  it("reports a split verdict rather than picking a winner quietly", () => {
    const result = patternService([
      { email: "andrew.huisman@acme.com", name: "Andrew Huisman" },
      { email: "hopper@acme.com", name: "Grace Hopper" },
    ]).addressPattern("acme.com", "Ada Lovelace");

    expect(result.notes.join(" ")).toMatch(/evidence is split/);
  });

  it("invents nothing for a domain that teaches nothing", () => {
    const empty = patternService([]).addressPattern("acme.com", "Ada Lovelace");
    expect(empty.candidate).toBeNull();
    expect(empty.notes.join(" ")).toMatch(/No addresses at acme.com are held yet/);

    const unnamed = patternService([{ email: "info@acme.com", name: null }]).addressPattern(
      "acme.com",
      "Ada Lovelace",
    );
    expect(unnamed.candidate).toBeNull();
    expect(unnamed.notes.join(" ")).toMatch(/none carries a name/);

    const unguessable = patternService([
      { email: "xk41@acme.com", name: "Andrew Huisman" },
    ]).addressPattern("acme.com", "Ada Lovelace");
    expect(unguessable.candidate).toBeNull();
    expect(unguessable.notes.join(" ")).toMatch(/does not write mailboxes in a way that can be guessed/);
  });

  it("folds accents and punctuation the way a mail system does", () => {
    const result = patternService([
      { email: "renee.obrien@acme.com", name: "Renée O'Brien" },
      { email: "andrew.huisman@acme.com", name: "Andrew Huisman" },
    ]).addressPattern("acme.com", "José  Núñez");

    expect(result.patterns[0].matches).toBe(2);
    expect(result.candidate?.email).toBe("jose.nunez@acme.com");
  });

  it("needs no provider key, and refuses what is not a domain", () => {
    const svc = patternService();
    // The whole point: this answers on an install that has bought nothing.
    expect(svc.isConfigured()).toBe(false);
    expect(svc.addressPattern("acme.com").candidate).toBeNull();
    expect(() => svc.addressPattern("acme")).toThrow(/not a domain/);
  });

  it("dispatches through the tool, and reaches no provider doing it", async () => {
    const platform: EnrichmentPlatform = { enrichmentService: patternService() };
    const calls = stubFetch(() => ({ body: {} }));
    const result: any = await dispatchEnrichmentTool(platform, "enrich_address_pattern", {
      orgDomain: "acme.com",
      fullName: "Ada Lovelace",
    });

    expect(result.candidate.email).toBe("ada.lovelace@acme.com");
    expect(result.candidate.verified).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("hunter provider", () => {
  it("normalizes a found address and keeps the provider score", async () => {
    const calls = stubFetch(() => ({
      body: { data: { email: "Jane.Doe@ACME.com", score: 92, result: "deliverable" } },
    }));
    const result = await new HunterProvider("key").findEmail(NAME);
    expect(result).toMatchObject({
      email: "jane.doe@acme.com",
      confidence: 92,
      status: "valid",
      provider: "hunter",
    });
    expect(calls[0].url).toContain("/email-finder?");
    expect(calls[0].url).toContain("first_name=Jane");
    expect(calls[0].url).toContain("api_key=key");
  });

  it("reads accept_all as risky and keeps the address it was asked about", async () => {
    stubFetch(() => ({ body: { data: { score: 55, status: "accept_all" } } }));
    const result = await new HunterProvider("key").verifyEmail("jane@acme.com");
    expect(result.status).toBe("risky");
    expect(result.email).toBe("jane@acme.com");
  });

  it("returns nothing found rather than throwing on an empty body", async () => {
    stubFetch(() => ({ body: { data: { email: null } } }));
    const result = await new HunterProvider("key").findEmail(NAME);
    expect(result.email).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("throws on an HTTP failure", async () => {
    stubFetch(() => ({ status: 401, body: { errors: [{ details: "bad key" }] } }));
    await expect(new HunterProvider("key").findEmail(NAME)).rejects.toThrow(
      /hunter HTTP 401/,
    );
  });
});

describe("prospeo provider", () => {
  it("posts JSON with the key header and scores its verdict word", async () => {
    const calls = stubFetch(() => ({
      body: { error: false, response: { email: "j@acme.com", email_status: "VALID" } },
    }));
    const result = await new ProspeoProvider("pk").findEmail(NAME);
    expect(result).toMatchObject({
      email: "j@acme.com",
      status: "valid",
      provider: "prospeo",
    });
    expect(result.confidence).toBeGreaterThanOrEqual(80);
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({
      first_name: "Jane",
      company: "acme.com",
    });
  });

  it("reads CATCH_ALL as risky, below the acceptance floor", async () => {
    stubFetch(() => ({
      body: { error: false, response: { email: "j@acme.com", email_status: "CATCH_ALL" } },
    }));
    const result = await new ProspeoProvider("pk").verifyEmail("j@acme.com");
    expect(result.status).toBe("risky");
    expect(result.confidence).toBeLessThan(80);
  });

  it("throws on an error flag returned with HTTP 200", async () => {
    stubFetch(() => ({ body: { error: true, message: "NO_CREDITS" } }));
    await expect(new ProspeoProvider("pk").verifyEmail("j@acme.com")).rejects.toThrow(
      /NO_CREDITS/,
    );
  });
});

describe("provider deadline", () => {
  /** A vendor that accepts the connection and then says nothing, ever. */
  function stubHangingFetch(): void {
    vi.stubGlobal(
      "fetch",
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
  }

  it("gives up on a hung hunter call rather than holding the queue", async () => {
    vi.useFakeTimers();
    stubHangingFetch();
    // The assertion is attached before the clock moves, or the rejection
    // lands with nobody listening and vitest reports it as unhandled.
    const settled = expect(
      new HunterProvider("key").verifyEmail("jane@acme.com"),
    ).rejects.toThrow(/hunter timed out after 10s/);
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
    await settled;
  });

  it("gives up on a hung prospeo call too", async () => {
    vi.useFakeTimers();
    stubHangingFetch();
    const settled = expect(
      new ProspeoProvider("key").verifyEmail("jane@acme.com"),
    ).rejects.toThrow(/prospeo timed out after 10s/);
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
    await settled;
  });
});

describe("waterfall", () => {
  it("stops at the first provider confident enough", async () => {
    const seen: string[] = [];
    const service = new EnrichmentService({
      providers: [
        fakeProvider("first", { confidence: 95, status: "valid" }, seen),
        fakeProvider("second", { confidence: 99, status: "valid" }, seen),
      ],
    });
    const result = await service.findEmail(NAME);
    expect(result.provider).toBe("first");
    expect(seen).toEqual(["first"]);
  });

  it("falls through to the next provider when the first is not confident", async () => {
    const seen: string[] = [];
    const service = new EnrichmentService({
      providers: [
        fakeProvider("first", { confidence: 40, status: "risky" }, seen),
        fakeProvider("second", { confidence: 95, status: "valid" }, seen),
      ],
    });
    const result = await service.findEmail(NAME);
    expect(seen).toEqual(["first", "second"]);
    expect(result.provider).toBe("second");
  });

  it("keeps the best weak answer when no provider clears the floor", async () => {
    const seen: string[] = [];
    const service = new EnrichmentService({
      providers: [
        fakeProvider("first", { confidence: 40, status: "risky" }, seen),
        fakeProvider("second", { confidence: 61, status: "risky" }, seen),
      ],
    });
    const result = await service.findEmail(NAME);
    expect(result.provider).toBe("second");
    expect(result.confidence).toBe(61);
  });

  it("keeps a proven invalid verdict over an earlier risky answer", async () => {
    const seen: string[] = [];
    const service = new EnrichmentService({
      providers: [
        fakeProvider("first", { confidence: 70, status: "risky" }, seen),
        fakeProvider("second", { confidence: 0, status: "invalid" }, seen),
      ],
    });
    const result = await service.verifyEmail("gone@acme.com");
    expect(seen).toEqual(["first", "second"]);
    expect(result.status).toBe("invalid");
    expect(result.provider).toBe("second");
  });

  it("stops asking once a provider proved the address dead", async () => {
    const seen: string[] = [];
    const service = new EnrichmentService({
      providers: [
        fakeProvider("first", { confidence: 0, status: "invalid" }, seen),
        fakeProvider("second", { confidence: 95, status: "valid" }, seen),
      ],
    });
    const result = await service.verifyEmail("gone@acme.com");
    expect(seen).toEqual(["first"]);
    expect(result.status).toBe("invalid");
  });

  it("survives a provider that throws", async () => {
    const seen: string[] = [];
    const service = new EnrichmentService({
      providers: [
        fakeProvider("first", new Error("hunter HTTP 401: bad key"), seen),
        fakeProvider("second", { confidence: 95, status: "valid" }, seen),
      ],
    });
    const result = await service.findEmail(NAME);
    expect(seen).toEqual(["first", "second"]);
    expect(result.provider).toBe("second");
  });

  it("reports the failure when every provider throws", async () => {
    const seen: string[] = [];
    const service = new EnrichmentService({
      providers: [
        fakeProvider("first", new Error("hunter HTTP 401: bad key"), seen),
        fakeProvider("second", new Error("prospeo error: NO_CREDITS"), seen),
      ],
    });
    await expect(service.findEmail(NAME)).rejects.toThrow(/NO_CREDITS/);
  });
});

describe("cache", () => {
  it("answers a repeat lookup without billing a provider again", async () => {
    const seen: string[] = [];
    const service = new EnrichmentService({
      providers: [fakeProvider("first", { confidence: 95, status: "valid" }, seen)],
    });
    await service.verifyEmail("Jane@Acme.com");
    const again = await service.verifyEmail("jane@acme.com");
    expect(seen).toEqual(["first"]);
    expect(again.provider).toBe("first");
  });

  it("bills again once the day is up", async () => {
    const seen: string[] = [];
    let clock = 0;
    const service = new EnrichmentService({
      providers: [fakeProvider("first", { confidence: 95, status: "valid" }, seen)],
      now: () => clock,
    });
    await service.verifyEmail("jane@acme.com");
    clock += 25 * 60 * 60 * 1000;
    await service.verifyEmail("jane@acme.com");
    expect(seen).toEqual(["first", "first"]);
  });

  it("does not answer a find from a verify of the same address", async () => {
    const seen: string[] = [];
    const service = new EnrichmentService({
      providers: [fakeProvider("first", { confidence: 95, status: "valid" }, seen)],
    });
    await service.verifyEmail("found@acme.com");
    await service.findEmail({ fullName: "Found", domain: "acme.com" });
    expect(seen).toEqual(["first", "first"]);
  });
});

describe("unconfigured service", () => {
  it("names both env keys instead of failing vaguely", async () => {
    const service = new EnrichmentService({ providers: [] });
    expect(service.isConfigured()).toBe(false);
    await expect(service.findEmail(NAME)).rejects.toThrow(
      /BOXAIDE_HUNTER_API_KEY.*BOXAIDE_PROSPEO_API_KEY/,
    );
    await expect(service.verifyEmail("j@acme.com")).rejects.toThrow(
      /no enrichment provider is configured/,
    );
  });

  it("still imports CSV, which costs nothing and calls nobody", () => {
    const rows: ImportContactRow[] = [];
    const service = new EnrichmentService({
      providers: [],
      upsertContact: (row) => {
        rows.push(row);
        return { id: `c${rows.length}` };
      },
    });
    const outcome = service.importContacts("email\nj@acme.com\n");
    expect(outcome.imported).toEqual([{ email: "j@acme.com", contactId: "c1" }]);
    expect(rows).toHaveLength(1);
  });
});

describe("csv parsing", () => {
  it("reads quoted fields with commas and doubled quotes", () => {
    const csv = [
      "email,name,title,org",
      '"jane@acme.com","Doe, Jane","VP, Sales","The ""Big"" Co"',
    ].join("\n");
    expect(parseContactCsv(csv).rows[0]).toEqual({
      email: "jane@acme.com",
      name: "Doe, Jane",
      title: "VP, Sales",
      org: 'The "Big" Co',
      orgDomain: null,
      tags: [],
      line: 2,
    });
  });

  it("accepts a newline inside a quoted field and keeps line numbers straight", () => {
    const csv = 'email,name\n"a@acme.com","Line\nTwo"\nnope\n';
    const parsed = parseContactCsv(csv);
    expect(parsed.rows[0].name).toBe("Line\nTwo");
    expect(parsed.skipped[0]).toMatchObject({ line: 4, reason: "not an email address" });
  });

  it("folds header spellings and splits tags", () => {
    const csv = "Email Address,Full Name,Company,Org Domain,Tags\nj@acme.com,Jane,Acme,ACME.com,\"vip; eu\"";
    expect(parseContactCsv(csv).rows[0]).toEqual({
      email: "j@acme.com",
      name: "Jane",
      title: null,
      org: "Acme",
      orgDomain: "acme.com",
      tags: ["vip", "eu"],
      line: 2,
    });
  });

  it("folds a website URL onto the bare org domain", () => {
    const csv = "email,website\nj@acme.com,https://www.acme.com/about?x=1";
    expect(parseContactCsv(csv).rows[0].orgDomain).toBe("acme.com");
    const junk = "email,website\nj@acme.com,not a domain";
    expect(parseContactCsv(junk).rows[0].orgDomain).toBe(null);
  });

  it("skips blank, malformed and duplicate addresses with a reason each", () => {
    const csv = [
      "email,name",
      "jane@acme.com,Jane",
      ",Nobody",
      "not-an-email,Bad",
      "JANE@acme.com,Jane again",
    ].join("\n");
    const parsed = parseContactCsv(csv);
    expect(parsed.rows.map((r) => r.email)).toEqual(["jane@acme.com"]);
    expect(parsed.skipped).toEqual([
      { line: 3, reason: "no email" },
      { line: 4, reason: "not an email address", email: "not-an-email" },
      { line: 5, reason: "duplicate of line 2", email: "jane@acme.com" },
    ]);
  });

  it("tolerates CRLF and a byte order mark from Excel", () => {
    const csv = "﻿email\r\nj@acme.com\r\n";
    expect(parseContactCsv(csv).rows.map((r) => r.email)).toEqual(["j@acme.com"]);
  });

  it("refuses a document with no email column", () => {
    expect(() => parseContactCsv("name,org\nJane,Acme")).toThrow(/'email' column/);
  });

  it("refuses an empty document", () => {
    expect(() => parseContactCsv("")).toThrow(/csv is empty/);
  });

  it(`refuses more than ${MAX_IMPORT_ROWS} rows rather than importing part of them`, () => {
    const lines = ["email"];
    for (let i = 0; i <= MAX_IMPORT_ROWS; i++) lines.push(`p${i}@acme.com`);
    expect(() => parseContactCsv(lines.join("\n"))).toThrow(
      new RegExp(`${MAX_IMPORT_ROWS + 1} rows`),
    );
  });

  it(`accepts exactly ${MAX_IMPORT_ROWS} rows`, () => {
    const lines = ["email"];
    for (let i = 0; i < MAX_IMPORT_ROWS; i++) lines.push(`p${i}@acme.com`);
    expect(parseContactCsv(lines.join("\n")).rows).toHaveLength(MAX_IMPORT_ROWS);
  });
});

describe("dispatcher", () => {
  function platformWith(service: EnrichmentService): EnrichmentPlatform {
    return { enrichmentService: service };
  }

  it("returns the normalised result without the provider body", async () => {
    const seen: string[] = [];
    const service = new EnrichmentService({
      providers: [
        fakeProvider("first", { confidence: 95, status: "valid", raw: { huge: true } }, seen),
      ],
    });
    const res = (await dispatchEnrichmentTool(
      platformWith(service),
      "enrich_find_email",
      { firstName: "Jane", lastName: "Doe", orgDomain: "acme.com" },
    )) as { result: Record<string, unknown> };
    expect(res.result).toEqual({
      email: "found@acme.com",
      confidence: 95,
      status: "valid",
      provider: "first",
    });
  });

  it("reports imported rows and skips together", async () => {
    const service = new EnrichmentService({
      providers: [],
      upsertContact: (row) => {
        if (row.email === "boom@acme.com") throw new Error("crm said no");
        return { id: `id-${row.email}` };
      },
    });
    const res = (await dispatchEnrichmentTool(
      platformWith(service),
      "crm_contacts_import",
      { csv: "email\nok@acme.com\nboom@acme.com\nbad\n" },
    )) as { importedCount: number; skipped: { reason: string }[] };
    expect(res.importedCount).toBe(1);
    expect(res.skipped.map((s) => s.reason)).toEqual([
      "not an email address",
      "crm said no",
    ]);
  });

  it("refuses an unknown tool", async () => {
    const service = new EnrichmentService({ providers: [] });
    await expect(
      dispatchEnrichmentTool(platformWith(service), "enrich_nope", {}),
    ).rejects.toThrow(/unknown tool/);
  });
});
