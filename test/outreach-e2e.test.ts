/**
 * Outreach end to end, with no connector keys and with keys.
 *
 * The question this file answers is a product one: what does an operator who
 * has bought nothing actually get, and what does buying a key change? So it
 * drives the real wiring — createPlatform, the MCP tool surface, the REST
 * approval route, the engine's own send loop — and stubs only the two edges
 * that leave the machine: the SMTP transport (FixtureProvider) and the global
 * fetch every vendor adapter calls.
 *
 * State A asserts the whole outreach path still works with nothing bought,
 * and that not one vendor request is made on it. State B saves keys through
 * the connectors service, which is the settings-beats-environment path, and
 * asserts what those keys turn on: the pre-send verdict that fails a dead
 * address, and the two lookup tools that were refusing before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import { createPlatform, type Platform } from "../src/platform.js";
import { registerOutreachRoutes } from "../src/outreach/routes.js";
import { handleMcpJsonRpc } from "../src/mcp/server.js";
import { OPT_OUT_FOOTER } from "../src/outreach/store.js";
import { claudeTurnArgs, type AgentLauncher } from "../src/agent/launcher.js";

const baseCreds = {
  imapHost: "fixture",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "fixture",
  smtpPort: 465,
  smtpSecure: true,
  auth: { kind: "password" as const, user: "me@test.com", pass: "ok" },
};

/**
 * Every environment name a provider key could arrive under, blanked for the
 * whole file. Without this the answer to "what happens with no keys" would
 * depend on the shell the suite was started from.
 */
const KEY_SUFFIXES = [
  "HUNTER_API_KEY",
  "PROSPEO_API_KEY",
  "EXA_API_KEY",
  "PARALLEL_API_KEY",
  "APOLLO_API_KEY",
];
const ENV_PREFIXES = ["BOXAIDE_", "SLEY_", "MAILMUX_"];

/** One recorded outbound vendor request. The list must stay empty in state A. */
type VendorCall = { url: string; body: string };

type ToolReply = { ok: boolean; payload: any };

describe("outreach end to end, with and without connector keys", () => {
  let store: Store;
  let mail: MailService;
  let provider: FixtureProvider;
  let platform: Platform;
  let app: Hono;
  let accountId: string;
  let vendorCalls: VendorCall[];
  let vendorReply: (url: string, body: string) => unknown;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    for (const prefix of ENV_PREFIXES) {
      for (const suffix of KEY_SUFFIXES) vi.stubEnv(`${prefix}${suffix}`, "");
    }
    const masterKey = randomBytes(32);
    store = new Store(masterKey, ":memory:");
    provider = new FixtureProvider();
    mail = new MailService(store, provider);
    const account = await mail.connectAccount({
      alias: "work",
      email: "me@test.com",
      creds: baseCreds,
    });
    accountId = account.id;

    vendorCalls = [];
    // Loud by default: a call nobody set up an answer for is a test that
    // reached the real internet, not a test with a thin stub.
    vendorReply = (url) => {
      throw new Error(`unexpected vendor request: ${url}`);
    };
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input);
      const body = typeof init?.body === "string" ? init.body : "";
      vendorCalls.push({ url, body });
      return new Response(JSON.stringify(vendorReply(url, body)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    // Built after the stub is in place: the search adapters read
    // globalThis.fetch once, at construction, so a platform built first would
    // hold the real one and a "no vendor call" assertion would be a lie.
    platform = createPlatform({
      db: store.db,
      masterKey,
      mail,
      launcher: {} as AgentLauncher,
    });
    app = new Hono();
    registerOutreachRoutes(app, platform);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    platform.engine.stop();
    store.db.close();
    vi.unstubAllEnvs();
  });

  /** One MCP tools/call over the same JSON-RPC path an agent uses. */
  async function callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolReply> {
    const res = (await handleMcpJsonRpc(
      mail,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      undefined,
      platform,
    )) as {
      result?: { content: { text: string }[]; isError?: boolean };
      error?: { message: string };
    };
    if (!res.result) {
      throw new Error(`tools/call was refused outright: ${res.error?.message}`);
    }
    return {
      ok: res.result.isError !== true,
      payload: JSON.parse(res.result.content[0].text),
    };
  }

  /** The human decision, over the REST route that is the only place it lives. */
  async function approve(id: string): Promise<number> {
    const res = await app.request(`/api/outreach/outbox/${id}/approve`, {
      method: "POST",
    });
    return res.status;
  }

  /** Import one contact, queue one draft, and hand back the queued row id. */
  async function queueDraft(email: string, name: string): Promise<string> {
    const imported = await callTool("crm_contacts_import", {
      csv: `email,name,org,orgDomain\n${email},${name},Acme,acme.example\n`,
    });
    expect(imported.ok).toBe(true);
    expect(imported.payload.importedCount).toBe(1);
    const contactId = imported.payload.imported[0].contactId;

    const queued = await callTool("outbox_queue_draft", {
      account: accountId,
      to: email,
      subject: `Hi ${name.split(" ")[0]}`,
      body: "About Acme.",
      contactId,
    });
    expect(queued.ok).toBe(true);

    const pending = platform.outreachStore.listOutbox({ status: "pending" });
    expect(pending).toHaveLength(1);
    return pending[0].id;
  }

  /* ---- state A: nothing bought ---------------------------------------- */

  it("runs the whole outreach path with no keys, and calls no vendor", async () => {
    const rowId = await queueDraft("ada@acme.example", "Ada Lovelace");
    const queuedRow = platform.outreachStore.getOutbox(rowId)!;
    expect(queuedRow.to).toBe("ada@acme.example");
    expect(queuedRow.subject).toBe("Hi Ada");
    expect(queuedRow.body).toBe(`About Acme.${OPT_OUT_FOOTER}`);
    // Queued is not sent: the row waits for a person (spec invariant 1).
    expect(provider.getSent()).toHaveLength(0);

    expect(await approve(rowId)).toBe(200);
    await platform.engine.tick();

    expect(platform.outreachStore.getOutbox(rowId)?.status).toBe("sent");
    const sent = provider.getSent();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ada@acme.example");
    expect(sent[0].subject).toBe("Hi Ada");
    // The whole path, import to delivery, without one paid request.
    expect(vendorCalls).toEqual([]);
  });

  it("refuses the paid tools by name, and keeps the free ones working", async () => {
    const find = await callTool("enrich_find_email", {
      fullName: "Ada Lovelace",
      orgDomain: "acme.example",
    });
    expect(find.ok).toBe(false);
    expect(find.payload.error).toContain("BOXAIDE_HUNTER_API_KEY");
    expect(find.payload.error).toContain("BOXAIDE_PROSPEO_API_KEY");

    const verify = await callTool("enrich_verify_email", { email: "ada@acme.example" });
    expect(verify.ok).toBe(false);
    expect(verify.payload.error).toContain("BOXAIDE_HUNTER_API_KEY");

    const search = await callTool("web_search", { query: "acme robotics" });
    expect(search.ok).toBe(false);
    expect(search.payload.error).toContain("BOXAIDE_EXA_API_KEY");
    expect(search.payload.error).toContain("BOXAIDE_PARALLEL_API_KEY");

    // The CSV import needs no vendor, so it keeps working: this is how a
    // contact enters the CRM on an install that bought nothing.
    const imported = await callTool("crm_contacts_import", {
      csv: "email,name\ngrace@navy.example,Grace Hopper\n",
    });
    expect(imported.ok).toBe(true);
    expect(imported.payload.importedCount).toBe(1);

    // web_fetch needs no vendor key either, so it is NOT refused as
    // unconfigured. It is refused by the SSRF guard, which is a different
    // answer and the honest one: reading a page costs nothing.
    const page = await callTool("web_fetch", { url: "http://127.0.0.1:9/admin" });
    expect(page.ok).toBe(false);
    expect(page.payload.error).not.toMatch(/not configured/);
    expect(page.payload.error).toMatch(/blocked address/);

    expect(vendorCalls).toEqual([]);
  });

  it("hands a launched CLI its own web search while no key is set", () => {
    expect(platform.hasSearchConnector()).toBe(false);
    expect(allowedTools(platform)).toContain("WebSearch");
  });

  /* ---- state B: keys saved in settings --------------------------------- */

  /** Save both keys the way the Connectors screen does, not through the env. */
  function configureKeys(): void {
    expect(platform.connectorsService.setKey("hunter", "hunter-key").source).toBe(
      "settings",
    );
    expect(platform.connectorsService.setKey("exa", "exa-key").source).toBe("settings");
  }

  /** Hunter's verifier shape, and Exa's search shape, as the adapters read them. */
  function replyWith(verdicts: Record<string, { result: string; score: number }>): void {
    vendorReply = (url) => {
      if (url.startsWith("https://api.hunter.io/v2/email-verifier")) {
        const email = new URL(url).searchParams.get("email") ?? "";
        const verdict = verdicts[email];
        if (!verdict) throw new Error(`no verdict set up for ${email}`);
        return { data: { email, result: verdict.result, score: verdict.score } };
      }
      if (url.startsWith("https://api.hunter.io/v2/email-finder")) {
        return { data: { email: "ada@acme.example", result: "deliverable", score: 97 } };
      }
      if (url === "https://api.exa.ai/search") {
        return {
          results: [
            {
              title: "Acme Robotics",
              url: "https://acme.example/about",
              text: "Acme Robotics builds  arms\nfor factories.",
              publishedDate: "2026-02-01",
            },
            { title: "no link", text: "dropped" },
          ],
        };
      }
      throw new Error(`unexpected vendor request: ${url}`);
    };
  }

  it("fails an approved row when the key says the address is dead", async () => {
    const rowId = await queueDraft("gone@acme.example", "Gone Person");
    configureKeys();
    replyWith({ "gone@acme.example": { result: "undeliverable", score: 0 } });

    expect(await approve(rowId)).toBe(200);
    await platform.engine.tick();

    const row = platform.outreachStore.getOutbox(rowId);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("gone@acme.example");
    expect(row?.error).toMatch(/did not verify/);
    // Nothing left the machine, and the verdict cost exactly one lookup.
    expect(provider.getSent()).toHaveLength(0);
    expect(vendorCalls).toHaveLength(1);
    expect(vendorCalls[0].url).toContain("api.hunter.io/v2/email-verifier");
  });

  it("verifies and then sends when the key says the address is good", async () => {
    const rowId = await queueDraft("ada@acme.example", "Ada Lovelace");
    configureKeys();
    replyWith({ "ada@acme.example": { result: "deliverable", score: 97 } });

    expect(await approve(rowId)).toBe(200);
    await platform.engine.tick();

    expect(platform.outreachStore.getOutbox(rowId)?.status).toBe("sent");
    expect(provider.getSent()).toHaveLength(1);
    expect(vendorCalls.map((c) => c.url.split("?")[0])).toEqual([
      "https://api.hunter.io/v2/email-verifier",
    ]);
  });

  it("answers the lookup tools from the saved keys, normalised", async () => {
    configureKeys();
    replyWith({});

    const find = await callTool("enrich_find_email", {
      firstName: "Ada",
      lastName: "Lovelace",
      orgDomain: "acme.example",
    });
    expect(find.ok).toBe(true);
    expect(find.payload.result).toEqual({
      email: "ada@acme.example",
      confidence: 97,
      status: "valid",
      provider: "hunter",
    });
    // The vendor's own JSON stays server-side; the agent gets four fields.
    expect(find.payload.result.raw).toBeUndefined();

    const search = await callTool("web_search", { query: "acme robotics" });
    expect(search.ok).toBe(true);
    expect(search.payload.provider).toBe("exa");
    // The hit with no url is dropped rather than returned as a link to nowhere.
    expect(search.payload.results).toEqual([
      {
        title: "Acme Robotics",
        url: "https://acme.example/about",
        snippet: "Acme Robotics builds arms for factories.",
        publishedDate: "2026-02-01",
      },
    ]);

    const keyed = vendorCalls.map((c) => c.url.split("?")[0]);
    expect(keyed).toContain("https://api.hunter.io/v2/email-finder");
    expect(keyed).toContain("https://api.exa.ai/search");
  });

  it("takes the CLI's own web search away once a search key is saved", () => {
    configureKeys();
    expect(platform.hasSearchConnector()).toBe(true);
    expect(allowedTools(platform)).not.toContain("WebSearch");
  });

  /* ---- state C: discovery to approval, on a brand new prospect --------- */

  /**
   * The Apollo bodies the adapter reads, plus the Hunter ones the chain needs
   * after them. Two people on purpose: Apollo gives one an address and locks
   * the other, and the locked one is the case enrichment exists for.
   */
  function replyWithApollo(
    verdicts: Record<string, { result: string; score: number }>,
  ): void {
    vendorReply = (url, body) => {
      if (url === "https://api.apollo.io/api/v1/mixed_companies/search") {
        return {
          organizations: [
            {
              id: "org-1",
              name: "Acme Logistics",
              website_url: "https://www.Acme.example/about",
              industry: "logistics",
              estimated_num_employees: 32,
              city: "Ghent",
              country: "Belgium",
              linkedin_url: "https://linkedin.com/company/acme",
            },
          ],
          pagination: { total_entries: 1 },
        };
      }
      if (url === "https://api.apollo.io/api/v1/mixed_people/api_search") {
        return {
          people: [
            {
              id: "p1",
              first_name: "Ada",
              last_name_obfuscated: "L***e",
              title: "VP of Sales",
              organization: { name: "Acme Logistics" },
              has_email: true,
            },
            {
              id: "p2",
              first_name: "Grace",
              last_name_obfuscated: "H***r",
              title: "Head of Operations",
              organization: { name: "Acme Logistics" },
              has_email: true,
            },
          ],
          pagination: { total_entries: 2 },
        };
      }
      if (url === "https://api.apollo.io/api/v1/people/match") {
        const id = JSON.parse(body).id;
        const org = { name: "Acme Logistics", primary_domain: "acme.example" };
        if (id === "p1") {
          return {
            person: {
              id: "p1",
              name: "Ada Lovelace",
              first_name: "Ada",
              last_name: "Lovelace",
              title: "VP of Sales",
              organization: org,
              email: "Ada@Acme.example",
              email_status: "verified",
              linkedin_url: "https://linkedin.com/in/ada",
            },
          };
        }
        return {
          person: {
            id: "p2",
            name: "Grace Hopper",
            first_name: "Grace",
            last_name: "Hopper",
            title: "Head of Operations",
            organization: org,
            // Apollo's placeholder for an address it holds and will not show.
            email: "email_not_unlocked@domain.com",
          },
        };
      }
      if (url.startsWith("https://api.hunter.io/v2/email-finder")) {
        return {
          data: { email: "grace@acme.example", result: "deliverable", score: 91 },
        };
      }
      if (url.startsWith("https://api.hunter.io/v2/email-verifier")) {
        const email = new URL(url).searchParams.get("email") ?? "";
        const verdict = verdicts[email];
        if (!verdict) throw new Error(`no verdict set up for ${email}`);
        return { data: { email, result: verdict.result, score: verdict.score } };
      }
      throw new Error(`unexpected vendor request: ${url}`);
    };
  }

  it("offers both prospecting tools over the JSON-RPC tool list", async () => {
    const res = (await handleMcpJsonRpc(
      mail,
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      undefined,
      platform,
    )) as { result: { tools: { name: string }[] } };
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain("prospect_find_companies");
    expect(names).toContain("prospect_find_people");
  });

  it("goes from no prospect at all to an approved send, over the tool path", async () => {
    expect(platform.connectorsService.setKey("apollo", "apollo-key").source).toBe(
      "settings",
    );
    expect(platform.connectorsService.setKey("hunter", "hunter-key").source).toBe(
      "settings",
    );
    replyWithApollo({
      "ada@acme.example": { result: "deliverable", score: 95 },
      "grace@acme.example": { result: "deliverable", score: 91 },
    });

    // 1. Who exists. Nobody named a company; the filters did.
    const found = await callTool("prospect_find_companies", {
      keywords: ["logistics"],
      locations: ["Belgium"],
      minEmployees: 10,
      maxEmployees: 50,
    });
    expect(found.ok).toBe(true);
    expect(found.payload.companies).toEqual([
      {
        name: "Acme Logistics",
        domain: "acme.example",
        industry: "logistics",
        headcount: 32,
        location: "Ghent, Belgium",
        linkedinUrl: "https://linkedin.com/company/acme",
        apolloOrgId: "org-1",
      },
    ]);
    expect(found.payload.total).toBe(1);
    const domain: string = found.payload.companies[0].domain;

    // The company is worth keeping on its own, before anyone is named.
    const org = await callTool("crm_org_upsert", {
      name: found.payload.companies[0].name,
      domain,
    });
    expect(org.ok).toBe(true);

    // 2. Who works there. reveal spends credits, so it is asked for by name.
    const people = await callTool("prospect_find_people", {
      orgDomains: [domain],
      titles: ["vp of sales", "head of operations"],
      reveal: true,
    });
    expect(people.ok).toBe(true);
    expect(people.payload.revealed).toBe(2);
    const [ada, grace] = people.payload.people;
    // No mask reaches the agent, revealed or not.
    expect(JSON.stringify(people.payload)).not.toContain("***");

    // 3. Apollo gave Ada an address, so her record is already the upsert call.
    expect(ada.crmContact).toEqual({
      email: "ada@acme.example",
      name: "Ada Lovelace",
      title: "VP of Sales",
      org: "Acme Logistics",
      orgDomain: "acme.example",
    });
    const savedAda = await callTool("crm_contact_upsert", ada.crmContact);
    expect(savedAda.ok).toBe(true);
    expect(savedAda.payload.contact.email).toBe("ada@acme.example");

    // 4. Grace's address is behind a credit Apollo would not spend, so it is
    // reported locked and never as the placeholder Apollo actually sent.
    expect(grace.email).toBeNull();
    expect(grace.emailStatus).toBe("locked");
    expect(grace.crmContact).toBeUndefined();
    expect(grace.crmContactPendingEmail).toEqual({
      name: "Grace Hopper",
      title: "Head of Operations",
      org: "Acme Logistics",
      orgDomain: "acme.example",
    });
    expect(grace.enrichFindEmail).toEqual({
      fullName: "Grace Hopper",
      orgDomain: "acme.example",
    });

    const address = await callTool("enrich_find_email", grace.enrichFindEmail);
    expect(address.ok).toBe(true);
    expect(address.payload.result.email).toBe("grace@acme.example");
    const checked = await callTool("enrich_verify_email", {
      email: address.payload.result.email,
    });
    expect(checked.ok).toBe(true);
    expect(checked.payload.result.status).toBe("valid");

    const savedGrace = await callTool("crm_contact_upsert", {
      ...grace.crmContactPendingEmail,
      email: address.payload.result.email,
    });
    expect(savedGrace.ok).toBe(true);
    expect(savedGrace.payload.contact.name).toBe("Grace Hopper");

    // 5. Both queued for review. Nothing here sends anything.
    const adaQueued = await callTool("outbox_queue_draft", {
      account: accountId,
      to: "ada@acme.example",
      subject: "Hi Ada",
      body: "About Acme Logistics.",
      contactId: savedAda.payload.contact.id,
    });
    expect(adaQueued.ok).toBe(true);
    const graceQueued = await callTool("outbox_queue_draft", {
      account: accountId,
      to: "grace@acme.example",
      subject: "Hi Grace",
      body: "About Acme Logistics.",
      contactId: savedGrace.payload.contact.id,
    });
    expect(graceQueued.ok).toBe(true);

    const pending = platform.outreachStore.listOutbox({ status: "pending" });
    expect(pending).toHaveLength(2);
    // Queued is not sent. A discovered prospect is still nobody's permission.
    expect(provider.getSent()).toHaveLength(0);

    // 6. One human decision, on one row.
    const adaRow = pending.find((row) => row.to === "ada@acme.example")!;
    const graceRow = pending.find((row) => row.to === "grace@acme.example")!;
    expect(adaRow.subject).toBe("Hi Ada");
    expect(adaRow.body).toBe(`About Acme Logistics.${OPT_OUT_FOOTER}`);

    expect(await approve(adaRow.id)).toBe(200);
    await platform.engine.tick();

    expect(platform.outreachStore.getOutbox(adaRow.id)?.status).toBe("sent");
    const sent = provider.getSent();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ada@acme.example");
    // The row nobody approved did not move, and no tool exists that could.
    expect(platform.outreachStore.getOutbox(graceRow.id)?.status).toBe("pending");

    // Every vendor request the chain made, in order, and no other.
    expect(vendorCalls.map((c) => c.url.split("?")[0])).toEqual([
      "https://api.apollo.io/api/v1/mixed_companies/search",
      "https://api.apollo.io/api/v1/mixed_people/api_search",
      "https://api.apollo.io/api/v1/people/match",
      "https://api.apollo.io/api/v1/people/match",
      "https://api.hunter.io/v2/email-finder",
      "https://api.hunter.io/v2/email-verifier",
      "https://api.hunter.io/v2/email-verifier",
    ]);
  });

  it("refuses both prospecting tools with no Apollo key, and calls nobody", async () => {
    const companies = await callTool("prospect_find_companies", {
      keywords: ["logistics"],
    });
    expect(companies.ok).toBe(false);
    expect(companies.payload.error).toContain("BOXAIDE_APOLLO_API_KEY");
    expect(companies.payload.error).toContain("Settings > Connectors");

    const people = await callTool("prospect_find_people", {
      orgDomains: ["acme.example"],
    });
    expect(people.ok).toBe(false);
    expect(people.payload.error).toContain("BOXAIDE_APOLLO_API_KEY");

    // The refusal happens before any HTTP, so an unconfigured install cannot
    // be made to hammer a vendor by an agent that keeps trying.
    expect(vendorCalls).toEqual([]);

    // And the rest of the outreach path is untouched by Apollo being absent.
    const rowId = await queueDraft("ada@acme.example", "Ada Lovelace");
    expect(await approve(rowId)).toBe(200);
    await platform.engine.tick();
    expect(platform.outreachStore.getOutbox(rowId)?.status).toBe("sent");
    expect(provider.getSent()).toHaveLength(1);
    expect(vendorCalls).toEqual([]);
  });
});

/**
 * The allowlist a chat launch would be started with, read through the same
 * thunk src/app.ts hands the launcher. Whether the CLI keeps its own index is
 * a live read of the connectors table, so this is the platform answer, not a
 * fixture of it.
 */
function allowedTools(platform: Platform): string {
  const ctx = {
    mcpUrl: "http://127.0.0.1:0/mcp",
    bearerToken: "t",
    dataDir: ":memory:",
    access: "full" as const,
    searchConfigured: () => platform.hasSearchConnector(),
  };
  const args = claudeTurnArgs(ctx, { prompt: "hi", system: "s", sessionId: null });
  return args[args.indexOf("--allowedTools") + 1];
}
