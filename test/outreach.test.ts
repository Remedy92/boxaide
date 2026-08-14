import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { encryptSecret } from "../src/crypto/secrets.js";
import type Database from "better-sqlite3";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import { createPlatform, type Platform } from "../src/platform.js";
import type { AgentLauncher } from "../src/agent/launcher.js";
import { OutreachEngine, renderTemplate } from "../src/outreach/engine.js";
import { OPT_OUT_FOOTER } from "../src/outreach/store.js";
import { dispatchOutreachTool, OUTREACH_TOOLS } from "../src/outreach/tools.js";
import { registerOutreachRoutes } from "../src/outreach/routes.js";
import { Hono } from "hono";

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
 * CRM DDL, copied from docs/specs/agent-platform.md. CrmStore owns these
 * tables in production; this is a fixture standing in for it so the outreach
 * tests do not depend on another module's in-progress migration.
 */
function createCrmFixtureTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, title TEXT,
      org_id TEXT, source TEXT NOT NULL DEFAULT 'mail',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, account_id TEXT NOT NULL,
      message_id TEXT NOT NULL, direction TEXT NOT NULL, at TEXT NOT NULL,
      subject_enc TEXT, snippet_enc TEXT,
      UNIQUE (account_id, message_id, contact_id)
    );
  `);
}

const DAY = 24 * 60 * 60 * 1000;

describe("outreach", () => {
  let store: Store;
  let mail: MailService;
  let provider: FixtureProvider;
  let platform: Platform;
  let masterKey: Buffer;
  let accountId: string;
  let clock: Date;
  let slept: number[];
  let engine: OutreachEngine;

  /** Insert a CRM contact (and its org) the way CrmService would. */
  function addContact(email: string, name: string, org?: string): string {
    const id = randomUUID();
    let orgId: string | null = null;
    if (org) {
      orgId = randomUUID();
      store.db
        .prepare(
          `INSERT INTO organizations (id, name, domain, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run(orgId, org, `${org.toLowerCase()}.example`, clock.toISOString());
    }
    store.db
      .prepare(
        `INSERT INTO contacts (id, email, name, org_id, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'mail', ?, ?)`,
      )
      .run(id, email, name, orgId, clock.toISOString(), clock.toISOString());
    return id;
  }

  /** Inbound interaction with encrypted subject/snippet, as CrmService writes. */
  function addInboundInteraction(
    contactId: string,
    at: Date,
    subject: string,
    snippet: string,
  ): void {
    const enc = (t: string) => encryptSecret(masterKey, t);
    store.db
      .prepare(
        `INSERT INTO interactions
           (id, contact_id, account_id, message_id, direction, at, subject_enc, snippet_enc)
         VALUES (?, ?, ?, ?, 'in', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        contactId,
        accountId,
        `msg-${randomUUID()}`,
        at.toISOString(),
        enc(subject),
        enc(snippet),
      );
  }

  beforeEach(async () => {
    masterKey = randomBytes(32);
    store = new Store(masterKey, ":memory:");
    provider = new FixtureProvider();
    mail = new MailService(store, provider);
    const account = await mail.connectAccount({
      alias: "work",
      email: "me@test.com",
      creds: baseCreds,
    });
    accountId = account.id;
    createCrmFixtureTables(store.db);
    platform = createPlatform({
      db: store.db,
      masterKey,
      mail,
      launcher: {} as AgentLauncher,
    });
    clock = new Date("2026-08-13T09:00:00.000Z");
    slept = [];
    engine = new OutreachEngine(
      platform.outreachStore,
      platform.crmStore,
      mail,
      {
        now: () => new Date(clock),
        sleep: async (ms) => {
          slept.push(ms);
        },
        random: () => 0.5,
      },
    );
  });

  afterEach(() => {
    // Only the engine is stopped: platform.start() is never called here, and
    // platform.stop() would reach into the automation scheduler, which this
    // task does not own.
    engine.stop();
    store.db.close();
  });

  function makeCampaign(steps = [
    { subject: "Hi {{name}}", body: "About {{org}}, mail {{email}}" },
    { subject: "Following up", body: "Second touch", waitDays: 3 },
  ]) {
    const campaign = platform.outreachStore.createCampaign({
      name: `camp-${randomUUID()}`,
      accountId,
      steps,
    });
    platform.outreachStore.updateCampaign(campaign.id, { status: "active" });
    return campaign;
  }

  /* ---- lifecycle ------------------------------------------------------ */

  it("runs a full sequence over fixture time, one queued step at a time", () => {
    const campaign = makeCampaign();
    const contactId = addContact("ada@acme.example", "Ada Lovelace", "Acme");
    platform.outreachStore.addCampaignContacts(campaign.id, [contactId]);

    expect(engine.advanceSequences()).toBe(1);
    let outbox = platform.outreachStore.listOutbox({ status: "pending" });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].subject).toBe("Hi Ada");
    expect(outbox[0].body).toBe(
      `About Acme, mail ada@acme.example${OPT_OUT_FOOTER}`,
    );
    expect(outbox[0].stepPosition).toBe(0);

    // Not due yet: step 1 waits three days.
    clock = new Date(clock.getTime() + 2 * DAY);
    expect(engine.advanceSequences()).toBe(0);

    clock = new Date(clock.getTime() + 2 * DAY);
    expect(engine.advanceSequences()).toBe(1);
    outbox = platform.outreachStore.listOutbox({ status: "pending" });
    expect(outbox.map((r) => r.stepPosition)).toEqual([0, 1]);

    // Sequence exhausted: the contact is done and nothing else is queued.
    clock = new Date(clock.getTime() + 30 * DAY);
    expect(engine.advanceSequences()).toBe(0);
    expect(
      platform.outreachStore.listCampaignContacts(campaign.id)[0].state,
    ).toBe("done");
  });

  it("stops the sequence when the contact replies", () => {
    const campaign = makeCampaign();
    const contactId = addContact("grace@navy.example", "Grace Hopper");
    platform.outreachStore.addCampaignContacts(campaign.id, [contactId]);
    engine.advanceSequences();

    addInboundInteraction(
      contactId,
      new Date(clock.getTime() + 1 * DAY),
      "Re: Hi Grace",
      "Sounds good, let us talk next week.",
    );
    clock = new Date(clock.getTime() + 4 * DAY);

    expect(engine.advanceSequences()).toBe(0);
    expect(
      platform.outreachStore.listCampaignContacts(campaign.id)[0].state,
    ).toBe("replied");
    expect(platform.outreachStore.listOutbox()).toHaveLength(1);
    expect(platform.outreachStore.isSuppressed("grace@navy.example")).toBe(
      false,
    );
  });

  it("suppresses the address when the reply asks to stop", () => {
    const campaign = makeCampaign();
    const contactId = addContact("alan@bletchley.example", "Alan Turing");
    platform.outreachStore.addCampaignContacts(campaign.id, [contactId]);
    engine.advanceSequences();

    addInboundInteraction(
      contactId,
      new Date(clock.getTime() + 1 * DAY),
      "Re: Hi Alan",
      "Please stop emailing me.",
    );
    clock = new Date(clock.getTime() + 4 * DAY);

    engine.advanceSequences();
    expect(
      platform.outreachStore.listCampaignContacts(campaign.id)[0].state,
    ).toBe("opted_out");
    const suppression = platform.outreachStore.listSuppression();
    expect(suppression).toEqual([
      expect.objectContaining({
        email: "alan@bletchley.example",
        reason: "reply-stop",
      }),
    ]);
  });

  it("suppresses on the bare 'stop' reply the footer invites", () => {
    const campaign = makeCampaign();
    const contactId = addContact("ada@analytical.example", "Ada Lovelace");
    platform.outreachStore.addCampaignContacts(campaign.id, [contactId]);
    engine.advanceSequences();

    // A real mail client reply: "stop" first, quoted original underneath —
    // the snippet carries both. This is the exact reply OPT_OUT_FOOTER asks
    // for, and it must suppress, not read as engagement.
    addInboundInteraction(
      contactId,
      new Date(clock.getTime() + 1 * DAY),
      "Re: Hi Ada",
      "Stop.\n\nOn Thu, Aug 14 you wrote: Hi Ada, saw your work…",
    );
    clock = new Date(clock.getTime() + 4 * DAY);

    engine.advanceSequences();
    expect(
      platform.outreachStore.listCampaignContacts(campaign.id)[0].state,
    ).toBe("opted_out");
    expect(platform.outreachStore.isSuppressed("ada@analytical.example")).toBe(
      true,
    );
  });

  it("keeps 'stop' mid-sentence as a normal reply, not an opt-out", () => {
    const campaign = makeCampaign();
    const contactId = addContact("kay@mercury.example", "Kay McNulty");
    platform.outreachStore.addCampaignContacts(campaign.id, [contactId]);
    engine.advanceSequences();

    addInboundInteraction(
      contactId,
      new Date(clock.getTime() + 1 * DAY),
      "Re: Hi Kay",
      "Sounds interesting — we should stop by your office next week.",
    );
    clock = new Date(clock.getTime() + 4 * DAY);

    engine.advanceSequences();
    expect(
      platform.outreachStore.listCampaignContacts(campaign.id)[0].state,
    ).toBe("replied");
    expect(platform.outreachStore.isSuppressed("kay@mercury.example")).toBe(
      false,
    );
  });

  it("refuses to queue for an address already on the suppression list", () => {
    const campaign = makeCampaign();
    const contactId = addContact("no@thanks.example", "Nope");
    platform.outreachStore.addCampaignContacts(campaign.id, [contactId]);
    platform.outreachStore.addSuppression("no@thanks.example", "manual");

    expect(engine.advanceSequences()).toBe(0);
    expect(
      platform.outreachStore.listCampaignContacts(campaign.id)[0].state,
    ).toBe("suppressed");
    expect(platform.outreachStore.listOutbox()).toHaveLength(0);
  });

  /* ---- the send guard -------------------------------------------------- */

  it("blocks an approved send to a suppressed address through the guard", async () => {
    const row = platform.outreachStore.queueOutbox({
      accountId,
      to: "blocked@example.com",
      subject: "hello",
      body: "body",
    });
    platform.outreachStore.addSuppression("blocked@example.com", "manual");
    platform.outreachStore.decide(row.id, "approved");

    expect(await engine.sendApproved()).toBe(0);
    const after = platform.outreachStore.getOutbox(row.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toBe("recipient suppressed: blocked@example.com");
    expect(provider.getSent()).toHaveLength(0);
  });

  it("lets a human override the guard on the direct send path", async () => {
    platform.outreachStore.addSuppression("blocked@example.com", "manual");
    await expect(
      mail.sendMessage(accountId, {
        to: "blocked@example.com",
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow("recipient suppressed: blocked@example.com");
    await expect(
      mail.sendMessage(
        accountId,
        { to: "blocked@example.com", subject: "s", text: "t" },
        { overrideSuppression: true },
      ),
    ).resolves.toBeTruthy();
  });

  /* ---- approval state machine ------------------------------------------ */

  it("only sends what a human approved, and only once", async () => {
    const pending = platform.outreachStore.queueOutbox({
      accountId,
      to: "a@example.com",
      subject: "s",
      body: "b",
    });
    expect(await engine.sendApproved()).toBe(0);
    expect(platform.outreachStore.getOutbox(pending.id)?.status).toBe("pending");

    platform.outreachStore.decide(pending.id, "approved");
    expect(await engine.sendApproved()).toBe(1);
    expect(platform.outreachStore.getOutbox(pending.id)?.status).toBe("sent");
    expect(provider.getSent()).toHaveLength(1);

    // A sent row is out of the machine: it cannot be re-decided or re-sent.
    expect(() => platform.outreachStore.decide(pending.id, "approved")).toThrow(
      /not pending/,
    );
    expect(await engine.sendApproved()).toBe(0);
    expect(provider.getSent()).toHaveLength(1);
  });

  it("refuses to approve a rejected row", () => {
    const row = platform.outreachStore.queueOutbox({
      accountId,
      to: "a@example.com",
      subject: "s",
      body: "b",
    });
    expect(platform.outreachStore.decide(row.id, "rejected")?.status).toBe(
      "rejected",
    );
    expect(() => platform.outreachStore.decide(row.id, "approved")).toThrow(
      /not pending/,
    );
    expect(platform.outreachStore.decide("nope", "approved")).toBeNull();
  });

  /* ---- cap and spacing -------------------------------------------------- */

  it("stops at the per-account daily cap and keeps the rest approved", async () => {
    const capped = new OutreachEngine(
      platform.outreachStore,
      platform.crmStore,
      mail,
      {
        now: () => new Date(clock),
        sleep: async (ms) => {
          slept.push(ms);
        },
        random: () => 0.5,
        dailyCap: () => 2,
      },
    );
    const ids = ["a", "b", "c"].map(
      (local) =>
        platform.outreachStore.queueOutbox({
          accountId,
          to: `${local}@example.com`,
          subject: "s",
          body: "b",
        }).id,
    );
    for (const id of ids) platform.outreachStore.decide(id, "approved");

    expect(await capped.sendApproved()).toBe(2);
    expect(ids.map((id) => platform.outreachStore.getOutbox(id)?.status)).toEqual(
      ["sent", "sent", "approved"],
    );

    // Same UTC day: still capped. Next day: the leftover goes out.
    expect(await capped.sendApproved()).toBe(0);
    clock = new Date(clock.getTime() + 1 * DAY);
    expect(await capped.sendApproved()).toBe(1);
    expect(platform.outreachStore.getOutbox(ids[2])?.status).toBe("sent");
  });

  it("spaces engine sends at least 60s apart", async () => {
    const ids = ["a", "b", "c"].map(
      (local) =>
        platform.outreachStore.queueOutbox({
          accountId,
          to: `${local}@example.com`,
          subject: "s",
          body: "b",
        }).id,
    );
    for (const id of ids) platform.outreachStore.decide(id, "approved");

    await engine.sendApproved();
    // First send is immediate; each later one waits out the gap.
    expect(slept).toHaveLength(2);
    for (const ms of slept) expect(ms).toBeGreaterThanOrEqual(60_000);
    expect(Math.max(...slept)).toBeLessThanOrEqual(80_000);
  });

  it("never dips below 60s even at zero jitter", async () => {
    // random() = 0 is the adversarial draw: a symmetric +-20s jitter would
    // produce a 40s gap here, which invariant 5 forbids. The floor must hold.
    const floorSlept: number[] = [];
    const zeroJitter = new OutreachEngine(
      platform.outreachStore,
      platform.crmStore,
      mail,
      {
        now: () => new Date(clock),
        sleep: async (ms) => {
          floorSlept.push(ms);
        },
        random: () => 0,
      },
    );
    for (const local of ["a", "b"]) {
      const row = platform.outreachStore.queueOutbox({
        accountId,
        to: `${local}@example.com`,
        subject: "s",
        body: "b",
      });
      platform.outreachStore.decide(row.id, "approved");
    }
    expect(await zeroJitter.sendApproved()).toBe(2);
    expect(floorSlept).toEqual([60_000]);
  });

  /* ---- encryption at rest ----------------------------------------------- */

  it("keeps subjects and bodies encrypted at rest", () => {
    const campaign = makeCampaign([
      { subject: "Secret subject", body: "Secret body" },
    ]);
    const contactId = addContact("ada@acme.example", "Ada Lovelace", "Acme");
    platform.outreachStore.addCampaignContacts(campaign.id, [contactId]);
    engine.advanceSequences();

    const step = store.db
      .prepare(`SELECT subject_enc, body_enc FROM sequence_steps`)
      .get() as { subject_enc: string; body_enc: string };
    expect(step.subject_enc).not.toContain("Secret subject");
    expect(step.body_enc).not.toContain("Secret body");

    const row = store.db
      .prepare(`SELECT to_addr, subject_enc, body_enc FROM outbox`)
      .get() as { to_addr: string; subject_enc: string; body_enc: string };
    expect(row.subject_enc).not.toContain("Secret");
    expect(row.body_enc).not.toContain("Secret");
    // Recipient stays plaintext: the send guard and the UI both need it.
    expect(row.to_addr).toBe("ada@acme.example");

    expect(platform.outreachStore.listOutbox()[0].subject).toBe(
      "Secret subject",
    );
  });

  /* ---- tools and routes -------------------------------------------------- */

  it("exposes exactly the eight spec tools and no approval tool", () => {
    expect(OUTREACH_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "campaign_add_contacts",
        "campaign_create",
        "campaign_update",
        "campaigns_list",
        "outbox_list",
        "outbox_queue_draft",
        "suppression_add",
        "suppression_list",
      ].sort(),
    );
    const queue = OUTREACH_TOOLS.find((t) => t.name === "outbox_queue_draft");
    expect(queue?.description).toContain(
      "the ONLY way an automation or agent gets outreach toward delivery; a human reviews it in the Sley Outreach view before anything is sent",
    );
  });

  it("queues an agent draft as pending, footer included", async () => {
    const res = (await dispatchOutreachTool(platform, "outbox_queue_draft", {
      account: accountId,
      to: "someone@example.com",
      subject: "hi",
      body: "text",
    })) as { queued: { id: string; status: string; body: string } };
    expect(res.queued.status).toBe("pending");
    expect(res.queued.body).toBe(`text${OPT_OUT_FOOTER}`);
    expect(platform.outreachStore.pendingCount()).toBe(1);
  });

  it("refuses suppressed contacts when adding them to a campaign", async () => {
    const campaign = makeCampaign();
    const ok = addContact("ok@example.com", "Fine");
    const bad = addContact("bad@example.com", "Nope");
    platform.outreachStore.addSuppression("bad@example.com", "manual");
    const res = (await dispatchOutreachTool(
      platform,
      "campaign_add_contacts",
      { campaignId: campaign.id, contactIds: [ok, bad, "ghost"] },
    )) as {
      added: number;
      refused: Array<{ email: string }>;
      unknown: string[];
    };
    expect(res.added).toBe(1);
    expect(res.refused.map((r) => r.email)).toEqual(["bad@example.com"]);
    expect(res.unknown).toEqual(["ghost"]);
  });

  it("refuses to rewrite steps once the campaign is live", async () => {
    const campaign = makeCampaign();
    await expect(
      dispatchOutreachTool(platform, "campaign_update", {
        campaignId: campaign.id,
        steps: [{ subject: "new", body: "new" }],
      }),
    ).rejects.toThrow(/draft/);
  });

  it("rejects an unknown campaign status instead of writing it", async () => {
    const campaign = makeCampaign();
    await expect(
      dispatchOutreachTool(platform, "campaign_update", {
        campaignId: campaign.id,
        status: "sending",
      }),
    ).rejects.toThrow(/unknown status/);

    const app = new Hono();
    registerOutreachRoutes(app, platform);
    const res = await app.request(`/api/outreach/campaigns/${campaign.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "bogus" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(platform.outreachStore.getCampaign(campaign.id)?.status).toBe(
      "active",
    );
  });

  it("serves approve, reject and the badge over REST, and approval triggers the send", async () => {
    const app = new Hono();
    registerOutreachRoutes(app, platform);
    const row = platform.outreachStore.queueOutbox({
      accountId,
      to: "a@example.com",
      subject: "s",
      body: "b",
    });

    const badge = await app.request("/api/outreach/badge");
    expect(await badge.json()).toEqual({ pending: 1 });

    const approved = await app.request(
      `/api/outreach/outbox/${row.id}/approve`,
      { method: "POST" },
    );
    expect(approved.status).toBe(200);
    // Approval is the on-demand tick: the engine picks the row up right away
    // instead of on the next hourly pass. The kick is fire-and-forget, so
    // wait for the transition rather than asserting a transient 'approved'.
    await vi.waitFor(() => {
      expect(platform.outreachStore.getOutbox(row.id)?.status).toBe("sent");
    });
    expect(provider.getSent().map((s) => s.to)).toEqual(["a@example.com"]);

    const again = await app.request(`/api/outreach/outbox/${row.id}/reject`, {
      method: "POST",
    });
    expect(again.status).toBe(400);

    const missing = await app.request("/api/outreach/outbox/ghost/approve", {
      method: "POST",
    });
    expect(missing.status).toBe(404);

    const empty = await app.request("/api/outreach/badge");
    expect(await empty.json()).toEqual({ pending: 0 });
  });

  it("kicks the engine when a contact joins an active campaign over REST", async () => {
    const app = new Hono();
    registerOutreachRoutes(app, platform);
    const campaign = makeCampaign();
    const contactId = addContact("kick@acme.example", "Kick", "Acme");

    const res = await app.request(
      `/api/outreach/campaigns/${campaign.id}/contacts`,
      {
        method: "POST",
        body: JSON.stringify({ contactIds: [contactId] }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(await res.json()).toMatchObject({ added: 1 });
    // Step 0 lands 'pending' without waiting for the hourly tick — and it is
    // queued, never sent: no human approved anything (invariant 1).
    await vi.waitFor(() => {
      expect(platform.outreachStore.pendingCount()).toBe(1);
    });
    expect(provider.getSent()).toHaveLength(0);
  });

  it("substitutes templates with a sane fallback name", () => {
    expect(
      renderTemplate("Hi {{name}} at {{org}} <{{email}}>", {
        id: "1",
        email: "ada@acme.example",
        name: null,
        org: null,
      }),
    ).toBe("Hi ada at  <ada@acme.example>");
  });
});
