import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import { CrmStore } from "../src/crm/store.js";
import { CrmService } from "../src/crm/service.js";
import { CRM_TOOLS, dispatchCrmTool } from "../src/crm/tools.js";
import { registerCrmRoutes } from "../src/crm/routes.js";
import type { Platform } from "../src/platform.js";

const baseCreds = {
  imapHost: "fixture",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "fixture",
  smtpPort: 465,
  smtpSecure: true,
  auth: { kind: "password" as const, user: "you@work.test", pass: "ok" },
};

/**
 * Only crmStore and crmService are read by the CRM dispatcher and routes, so
 * the rest of the Platform is deliberately absent. This is a stand-in for the
 * object graph createPlatform builds, not that graph.
 */
function crmPlatform(crmStore: CrmStore, crmService: CrmService): Platform {
  return { crmStore, crmService } as unknown as Platform;
}

async function harness() {
  const masterKey = randomBytes(32);
  const store = new Store(masterKey, ":memory:");
  const provider = new FixtureProvider();
  const mail = new MailService(store, provider);
  const crmStore = new CrmStore(store.db, masterKey);
  const crmService = new CrmService(crmStore, mail);
  const account = await mail.connectAccount({
    alias: "work",
    email: "you@work.test",
    creds: baseCreds,
  });
  return {
    masterKey,
    store,
    provider,
    mail,
    crmStore,
    crmService,
    account,
    platform: crmPlatform(crmStore, crmService),
  };
}

const ACME_SUBJECT = "Quarterly renewal terms for the Acme contract";

/** One inbox that exercises every derivation rule at once. */
function seedMail(provider: FixtureProvider, accountId: string) {
  provider.seedAccount(accountId, "you@work.test", [
    {
      subject: ACME_SUBJECT,
      from: "Jane Smith <jane@acme.test>",
      bodyText: "Numbers attached for the renewal.",
    },
    {
      // Longer display name for the same address: the longest one must win.
      subject: "Re: renewal",
      from: "Jane Q Smith <jane@acme.test>",
      bodyText: "One more thought.",
    },
    {
      subject: "Weekend plans",
      from: "friend@gmail.com",
      bodyText: "Free on Saturday?",
    },
    {
      subject: "Your receipt",
      from: "no-reply@acme.test",
      bodyText: "Do not answer this.",
    },
    {
      subject: "Note to self",
      from: "you@work.test",
      to: "you@work.test",
      bodyText: "Remember the thing.",
    },
    {
      subject: "Intro to Globex",
      folder: "Sent",
      from: "you@work.test",
      to: "Bob <bob@globex.test>",
      bodyText: "Good to meet you.",
    },
  ]);
}

describe("CrmService.syncFromMail derivation", () => {
  it("derives contacts, interactions and org links from fixture mail", async () => {
    const h = await harness();
    seedMail(h.provider, h.account.id);

    const first = await h.crmService.syncFromMail();
    expect(first).toEqual({ contacts: 3, interactions: 4 });

    const jane = h.crmStore.getContactByEmail("jane@acme.test");
    expect(jane).not.toBeNull();
    // Longest non-empty display name seen, not the first one.
    expect(jane?.name).toBe("Jane Q Smith");
    expect(jane?.source).toBe("mail");
    expect(jane?.orgName).toBe("Acme");

    const acme = h.crmStore.getOrgByDomain("acme.test");
    expect(acme?.name).toBe("Acme");

    // Inbound direction and decrypted subject survive the round trip.
    const janeInteractions = h.crmStore.listInteractions(jane!.id);
    expect(janeInteractions).toHaveLength(2);
    expect(janeInteractions.every((i) => i.direction === "in")).toBe(true);
    expect(janeInteractions.map((i) => i.subject)).toContain(ACME_SUBJECT);

    // Outbound mail from the Sent folder becomes an 'out' interaction.
    const bob = h.crmStore.getContactByEmail("bob@globex.test");
    expect(bob?.name).toBe("Bob");
    const bobInteractions = h.crmStore.listInteractions(bob!.id);
    expect(bobInteractions).toHaveLength(1);
    expect(bobInteractions[0].direction).toBe("out");
    expect(h.crmStore.getOrgByDomain("globex.test")?.name).toBe("Globex");

    h.store.close();
  });

  it("skips free providers for org linking and no-reply senders entirely", async () => {
    const h = await harness();
    seedMail(h.provider, h.account.id);
    await h.crmService.syncFromMail();

    const friend = h.crmStore.getContactByEmail("friend@gmail.com");
    expect(friend).not.toBeNull();
    // A consumer mailbox says nothing about an employer.
    expect(friend?.orgId).toBeNull();
    expect(h.crmStore.getOrgByDomain("gmail.com")).toBeNull();

    expect(h.crmStore.isKnownContact("no-reply@acme.test")).toBe(false);
    // The account's own address is not a contact of itself.
    expect(h.crmStore.isKnownContact("you@work.test")).toBe(false);

    h.store.close();
  });

  it("is idempotent: a second sync adds nothing", async () => {
    const h = await harness();
    seedMail(h.provider, h.account.id);
    await h.crmService.syncFromMail();
    expect(await h.crmService.syncFromMail()).toEqual({
      contacts: 0,
      interactions: 0,
    });
    h.store.close();
  });
});

describe("CrmService opt-out detection", () => {
  /** Long enough that the opt-out sentence lands well past any snippet. */
  const LONG_REPLY = `${"Thanks for the detailed note, I read all of it. ".repeat(
    5,
  )}Please unsubscribe me from this list.`;

  /** The phrase must not be reachable from the snippet the list view carries. */
  function optOutMail(from: string, folder = "INBOX") {
    return {
      subject: "Re: renewal",
      folder,
      from,
      to: "you@work.test",
      snippet: LONG_REPLY.slice(0, 140),
      bodyText: LONG_REPLY,
    };
  }

  it("flags a new inbound message whose opt-out phrase is past the snippet", async () => {
    const h = await harness();
    // Guard the fixture itself: a snippet that already carried the phrase
    // would make this test pass without the body fetch existing.
    expect(optOutMail("x@y.test").snippet).not.toMatch(/unsubscribe/i);
    h.provider.seedAccount(h.account.id, "you@work.test", [
      optOutMail("Kim <kim@acme.test>"),
      {
        subject: "Intro",
        folder: "Sent",
        from: "you@work.test",
        to: "Bob <bob@globex.test>",
        // Same wording outbound: our own mail must never suppress anyone.
        bodyText: LONG_REPLY,
        snippet: LONG_REPLY.slice(0, 140),
      },
    ]);
    await h.crmService.syncFromMail();

    const kim = h.crmStore.getContactByEmail("kim@acme.test")!;
    expect(h.crmStore.listInteractions(kim.id)[0].optOut).toBe(true);

    const bob = h.crmStore.getContactByEmail("bob@globex.test")!;
    const outbound = h.crmStore.listInteractions(bob.id)[0];
    expect(outbound.direction).toBe("out");
    expect(outbound.optOut).toBe(false);

    h.store.close();
  });

  it("falls back to the snippet when the body fetch fails", async () => {
    const h = await harness();
    h.provider.seedAccount(h.account.id, "you@work.test", [
      {
        subject: "Re: renewal",
        from: "Kim <kim@acme.test>",
        to: "you@work.test",
        snippet: "stop",
        bodyText: LONG_REPLY,
      },
    ]);
    // A provider whose full-message read throws: the sync must still finish and
    // still decide from what the summary carries.
    h.provider.getMessage = async () => {
      throw new Error("imap fetch failed");
    };

    const res = await h.crmService.syncFromMail();
    expect(res.interactions).toBe(1);
    const kim = h.crmStore.getContactByEmail("kim@acme.test")!;
    expect(h.crmStore.listInteractions(kim.id)[0].optOut).toBe(true);

    h.store.close();
  });

  it("does not re-fetch bodies for interactions it already recorded", async () => {
    const h = await harness();
    seedMail(h.provider, h.account.id);
    await h.crmService.syncFromMail();

    let fetches = 0;
    const original = h.provider.getMessage.bind(h.provider);
    h.provider.getMessage = async (...args: Parameters<typeof original>) => {
      fetches += 1;
      return original(...args);
    };
    expect(await h.crmService.syncFromMail()).toEqual({
      contacts: 0,
      interactions: 0,
    });
    expect(fetches).toBe(0);

    h.store.close();
  });
});

describe("CRM encryption at rest", () => {
  it("stores subjects, snippets and notes as ciphertext", async () => {
    const h = await harness();
    seedMail(h.provider, h.account.id);
    await h.crmService.syncFromMail();

    const rows = h.store.db
      .prepare(`SELECT subject_enc as s, snippet_enc as n FROM interactions`)
      .all() as Array<{ s: string | null; n: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.s).toBeTruthy();
      expect(row.s).not.toContain(ACME_SUBJECT);
      expect(row.s).not.toContain("renewal");
      expect(row.n).not.toContain("Numbers attached");
    }

    const jane = h.crmStore.getContactByEmail("jane@acme.test")!;
    const secret = "Told me the budget lands in March, keep this private";
    h.crmStore.addNote(jane.id, secret);
    const noteRow = h.store.db
      .prepare(`SELECT text_enc as t FROM notes`)
      .get() as { t: string };
    expect(noteRow.t).not.toContain("budget");
    expect(h.crmStore.listNotes(jane.id)[0].text).toBe(secret);

    // Identity fields stay plaintext on purpose — they carry UNIQUE and search.
    const contactRow = h.store.db
      .prepare(`SELECT email, name FROM contacts WHERE id = ?`)
      .get(jane.id) as { email: string; name: string };
    expect(contactRow.email).toBe("jane@acme.test");
    expect(contactRow.name).toBe("Jane Q Smith");

    h.store.close();
  });
});

describe("CRM tool dispatch", () => {
  it("exposes the thirteen tools of the spec", () => {
    expect(CRM_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "crm_contact_delete",
        "crm_contact_get",
        "crm_contact_upsert",
        "crm_contacts_search",
        "crm_deal_delete",
        "crm_deal_move",
        "crm_deal_upsert",
        "crm_interactions_list",
        "crm_note_add",
        "crm_org_upsert",
        "crm_orgs_list",
        "crm_pipeline_get",
        "crm_sync",
      ].sort(),
    );
    // Every description has to tell the agent when NOT to reach for the tool.
    for (const tool of CRM_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(60);
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("round-trips upsert, search, note and get", async () => {
    const h = await harness();
    const call = (name: string, args: Record<string, unknown> = {}) =>
      dispatchCrmTool(h.platform, name, args);

    const upserted = (await call("crm_contact_upsert", {
      email: "Dana@Initech.test",
      name: "Dana Scully",
      title: "CTO",
      org: "Initech",
      orgDomain: "initech.test",
      tags: ["prospect", "eu"],
    })) as { contact: { id: string; email: string; orgName: string } };
    expect(upserted.contact.email).toBe("dana@initech.test");
    expect(upserted.contact.orgName).toBe("Initech");

    const found = (await call("crm_contacts_search", {
      query: "initech",
    })) as { contacts: Array<{ id: string }> };
    expect(found.contacts).toHaveLength(1);
    const contactId = found.contacts[0].id;

    expect(
      ((await call("crm_contacts_search", { tag: "prospect" })) as {
        contacts: unknown[];
      }).contacts,
    ).toHaveLength(1);
    expect(
      ((await call("crm_contacts_search", { tag: "nope" })) as {
        contacts: unknown[];
      }).contacts,
    ).toHaveLength(0);

    await call("crm_note_add", { contactId, text: "Wants a demo in May." });

    const detail = (await call("crm_contact_get", {
      email: "dana@initech.test",
    })) as {
      contact: { title: string };
      tags: string[];
      notes: Array<{ text: string }>;
      deals: unknown[];
    };
    expect(detail.contact.title).toBe("CTO");
    expect(detail.tags).toEqual(["eu", "prospect"]);
    expect(detail.notes[0].text).toBe("Wants a demo in May.");
    expect(detail.deals).toEqual([]);

    const orgs = (await call("crm_orgs_list")) as { orgs: Array<{ name: string }> };
    expect(orgs.orgs.map((o) => o.name)).toEqual(["Initech"]);

    // A missing contact is an error, not an empty success.
    await expect(call("crm_contact_get", { email: "ghost@nowhere.test" })).rejects.toThrow(
      /not found/i,
    );
    await expect(call("crm_note_add", { contactId: "nope", text: "x" })).rejects.toThrow(
      /not found/i,
    );

    expect(await call("crm_contact_delete", { contactId })).toEqual({
      deleted: true,
    });
    expect(h.crmStore.isKnownContact("dana@initech.test")).toBe(false);

    h.store.close();
  });

  it("keeps a mail-derived org's name when a contact upsert passes only the domain", async () => {
    const h = await harness();
    seedMail(h.provider, h.account.id);
    await h.crmService.syncFromMail();
    expect(h.crmStore.getOrgByDomain("acme.test")?.name).toBe("Acme");

    // A domain without a name points at an org; it must not rename it.
    const res = (await dispatchCrmTool(h.platform, "crm_contact_upsert", {
      email: "cfo@acme.test",
      orgDomain: "acme.test",
    })) as { contact: { orgName: string } };
    expect(res.contact.orgName).toBe("Acme");
    expect(h.crmStore.getOrgByDomain("acme.test")?.name).toBe("Acme");

    // An unseen domain gets the derived name, never the raw domain string.
    const fresh = (await dispatchCrmTool(h.platform, "crm_contact_upsert", {
      email: "kim@umbrella.test",
      orgDomain: "umbrella.test",
    })) as { contact: { orgName: string } };
    expect(fresh.contact.orgName).toBe("Umbrella");

    h.store.close();
  });

  it("syncs through the tool and lists the derived interactions", async () => {
    const h = await harness();
    seedMail(h.provider, h.account.id);
    expect(await dispatchCrmTool(h.platform, "crm_sync", {})).toEqual({
      contacts: 3,
      interactions: 4,
    });
    const jane = h.crmStore.getContactByEmail("jane@acme.test")!;
    const listed = (await dispatchCrmTool(h.platform, "crm_interactions_list", {
      contactId: jane.id,
      limit: 1,
    })) as { interactions: Array<{ subject: string }> };
    expect(listed.interactions).toHaveLength(1);
    h.store.close();
  });

  it("rejects an unknown tool name", async () => {
    const h = await harness();
    await expect(dispatchCrmTool(h.platform, "crm_nope", {})).rejects.toThrow(
      /unknown tool/,
    );
    h.store.close();
  });
});

describe("CRM pipeline and deal moves", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    dispatchCrmTool(h.platform, name, args);

  beforeEach(async () => {
    h = await harness();
  });

  it("seeds the five stages exactly once", () => {
    expect(h.crmStore.listStages().map((s) => s.id)).toEqual([
      "lead",
      "contacted",
      "replied",
      "won",
      "lost",
    ]);
    // A second store over the same database must not seed them again.
    new CrmStore(h.store.db, h.masterKey);
    expect(h.crmStore.listStages()).toHaveLength(5);
    h.store.close();
  });

  it("moves deals between stages and keeps board order dense", async () => {
    const ids: string[] = [];
    for (const title of ["Alpha", "Beta", "Gamma"]) {
      const res = (await call("crm_deal_upsert", { title, value: 1000 })) as {
        deal: { id: string; stageId: string; position: number };
      };
      ids.push(res.deal.id);
      expect(res.deal.stageId).toBe("lead");
    }
    expect(h.crmStore.listDeals("lead").map((d) => d.position)).toEqual([0, 1, 2]);

    // Beta to the top of 'contacted'.
    const moved = (await call("crm_deal_move", {
      dealId: ids[1],
      stageId: "contacted",
      position: 0,
    })) as { deal: { stageId: string; position: number } };
    expect(moved.deal.stageId).toBe("contacted");
    expect(moved.deal.position).toBe(0);
    // The hole Beta left is closed, not left as a gap.
    expect(h.crmStore.listDeals("lead").map((d) => d.title)).toEqual([
      "Alpha",
      "Gamma",
    ]);
    expect(h.crmStore.listDeals("lead").map((d) => d.position)).toEqual([0, 1]);

    // Gamma above Alpha inside the same stage.
    await call("crm_deal_move", { dealId: ids[2], stageId: "lead", position: 0 });
    expect(h.crmStore.listDeals("lead").map((d) => d.title)).toEqual([
      "Gamma",
      "Alpha",
    ]);

    const board = (await call("crm_pipeline_get")) as {
      stages: Array<{ id: string; deals: Array<{ title: string }> }>;
    };
    expect(board.stages.map((s) => s.id)).toEqual([
      "lead",
      "contacted",
      "replied",
      "won",
      "lost",
    ]);
    expect(board.stages[0].deals.map((d) => d.title)).toEqual(["Gamma", "Alpha"]);
    expect(board.stages[1].deals.map((d) => d.title)).toEqual(["Beta"]);

    // Editing by id patches instead of creating a second deal.
    const edited = (await call("crm_deal_upsert", {
      dealId: ids[0],
      title: "Alpha renewal",
      value: 2500,
      currency: "EUR",
    })) as { deal: { id: string; value: number; currency: string } };
    expect(edited.deal.id).toBe(ids[0]);
    expect(edited.deal.value).toBe(2500);
    expect(edited.deal.currency).toBe("EUR");
    expect(h.crmStore.listDeals()).toHaveLength(3);

    await expect(
      call("crm_deal_move", { dealId: ids[0], stageId: "nope" }),
    ).rejects.toThrow(/unknown stage/);
    await expect(
      call("crm_deal_upsert", { dealId: "ghost", title: "x" }),
    ).rejects.toThrow(/not found/i);

    expect(await call("crm_deal_delete", { dealId: ids[0] })).toEqual({
      deleted: true,
    });
    await expect(call("crm_deal_delete", { dealId: ids[0] })).rejects.toThrow(
      /not found/i,
    );
    h.store.close();
  });

  it("links a deal to a contact and shows it on the contact detail", async () => {
    const contact = h.crmStore.upsertContact({
      email: "eve@acme.test",
      name: "Eve",
    });
    await call("crm_deal_upsert", {
      title: "Acme pilot",
      contactId: contact.id,
      stageId: "contacted",
    });
    const detail = (await call("crm_contact_get", {
      contactId: contact.id,
    })) as { deals: Array<{ title: string; stageId: string }> };
    expect(detail.deals).toEqual([
      expect.objectContaining({ title: "Acme pilot", stageId: "contacted" }),
    ]);

    // Deleting the contact keeps the deal but clears its contact field.
    h.crmStore.deleteContact(contact.id);
    expect(h.crmStore.listDeals()[0].contactId).toBeNull();
    h.store.close();
  });
});

describe("CRM REST routes", () => {
  it("serves contacts, notes, pipeline and sync with the shipped conventions", async () => {
    const h = await harness();
    seedMail(h.provider, h.account.id);
    const app = new Hono();
    registerCrmRoutes(app, h.platform);
    const headers = { "Content-Type": "application/json" };

    const synced = await app.request("/api/crm/sync", { method: "POST", headers });
    expect(synced.status).toBe(200);
    expect(await synced.json()).toEqual({ contacts: 3, interactions: 4 });

    const list = await app.request("/api/crm/contacts?query=acme");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      contacts: Array<{ id: string; email: string }>;
    };
    expect(listBody.contacts.map((c) => c.email)).toEqual(["jane@acme.test"]);
    const janeId = listBody.contacts[0].id;

    // Limits are clamped exactly like the mail routes.
    expect((await app.request("/api/crm/contacts?limit=abc")).status).toBe(400);
    expect((await app.request("/api/crm/contacts?limit=9999")).status).toBe(400);

    const created = await app.request("/api/crm/contacts", {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: "new@initech.test",
        name: "New Person",
        org: "Initech",
        orgDomain: "initech.test",
        tags: ["manual"],
      }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).contact.orgName).toBe("Initech");
    expect(
      (await app.request("/api/crm/contacts", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "no email" }),
      })).status,
    ).toBe(400);

    const note = await app.request(`/api/crm/contacts/${janeId}/notes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "Call back Thursday." }),
    });
    expect(note.status).toBe(201);

    const detail = await app.request(`/api/crm/contacts/${janeId}`);
    const detailBody = (await detail.json()) as {
      notes: Array<{ text: string }>;
      interactions: unknown[];
    };
    expect(detailBody.notes[0].text).toBe("Call back Thursday.");
    expect(detailBody.interactions).toHaveLength(2);

    const interactions = await app.request(
      `/api/crm/contacts/${janeId}/interactions?limit=1`,
    );
    expect(((await interactions.json()) as { interactions: unknown[] }).interactions)
      .toHaveLength(1);

    // Unknown ids are 404, never a 200 with an empty shell.
    expect((await app.request("/api/crm/contacts/ghost")).status).toBe(404);
    expect(
      (await app.request("/api/crm/contacts/ghost/notes", {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "x" }),
      })).status,
    ).toBe(404);
    expect(
      (await app.request("/api/crm/contacts/ghost", { method: "DELETE" })).status,
    ).toBe(404);
    expect(
      (await app.request("/api/crm/deals/ghost", { method: "DELETE" })).status,
    ).toBe(404);
    expect(
      (await app.request("/api/crm/deals/ghost/move", {
        method: "POST",
        headers,
        body: JSON.stringify({ stageId: "won" }),
      })).status,
    ).toBe(404);

    const orgs = await app.request("/api/crm/orgs");
    expect(((await orgs.json()) as { orgs: unknown[] }).orgs.length).toBeGreaterThan(
      0,
    );

    const deal = await app.request("/api/crm/deals", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Acme renewal", contactId: janeId }),
    });
    expect(deal.status).toBe(201);
    const dealId = (await deal.json()).deal.id;

    const move = await app.request(`/api/crm/deals/${dealId}/move`, {
      method: "POST",
      headers,
      body: JSON.stringify({ stageId: "won", position: 0 }),
    });
    expect(move.status).toBe(200);
    expect((await move.json()).deal.stageId).toBe("won");

    const pipeline = await app.request("/api/crm/pipeline");
    const board = (await pipeline.json()) as {
      stages: Array<{ id: string; deals: Array<{ id: string }> }>;
    };
    expect(board.stages.find((s) => s.id === "won")?.deals[0].id).toBe(dealId);

    expect(
      (await app.request(`/api/crm/deals/${dealId}`, { method: "DELETE" })).status,
    ).toBe(200);

    h.store.close();
  });
});
