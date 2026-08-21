import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import { createPlatform, type Platform } from "../src/platform.js";
import type { AgentLauncher } from "../src/agent/launcher.js";
import { OutreachEngine } from "../src/outreach/engine.js";
import {
  MAX_OUTREACH_BODY_BYTES,
  OPT_OUT_FOOTER,
} from "../src/outreach/store.js";
import { OPT_OUT_KEYWORD, optOutIntent } from "../src/outreach/opt-out.js";
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
      -- Written by CRM sync from the full body (src/crm/store.ts owns the
      -- production migration); outreach only reads it.
      opt_out INTEGER NOT NULL DEFAULT 0,
      opt_out_full INTEGER NOT NULL DEFAULT 0,
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

  /**
   * Give a contact outreach history the way every real flow does: a queued
   * row. The opt-out sink only suppresses people this product mailed or was
   * about to mail.
   */
  function giveOutreachHistory(contactId: string, email: string): void {
    platform.outreachStore.queueOutbox({
      accountId,
      to: email,
      subject: "Hi",
      body: "Hello there.",
      contactId,
    });
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
    engine = new OutreachEngine(platform.outreachStore, mail, {
      now: () => new Date(clock),
      sleep: async (ms) => {
        slept.push(ms);
      },
      random: () => 0.5,
    });
  });

  afterEach(() => {
    // Only the engine is stopped: platform.start() is never called here, and
    // platform.stop() would reach into the automation scheduler, which this
    // task does not own.
    engine.stop();
    store.db.close();
  });

  it("bounds queued bodies", () => {
    expect(() =>
      platform.outreachStore.queueOutbox({
        accountId,
        to: "a@example.com",
        subject: "hello",
        body: "x".repeat(MAX_OUTREACH_BODY_BYTES + 1),
      }),
    ).toThrow(/body must be at most/);
  });

  /* ---- suppression at flag time (the platform sink) --------------------- */

  it("suppresses a 'stop' that arrives after outreach touched the contact", async () => {
    const contactId = addContact("late@example.com", "Late Stopper");
    giveOutreachHistory(contactId, "late@example.com");

    provider.seedAccount(accountId, "me@test.com", [
      {
        subject: "Re: Hi Late",
        from: "Late Stopper <late@example.com>",
        bodyText: "stop",
      },
    ]);
    await platform.crmService.syncFromMail();

    expect(platform.outreachStore.isSuppressed("late@example.com")).toBe(true);
    expect(
      platform.outreachStore.listSuppression()[0].reason,
    ).toBe("reply-stop");
  });

  it("leaves a flagged contact outreach never touched alone", async () => {
    // The flag alone is not a licence to suppress: the sink only reaches
    // people this product mailed or queued mail for.
    provider.seedAccount(accountId, "me@test.com", [
      {
        subject: "Please remove me",
        from: "Stranger <stranger@example.com>",
        bodyText: "unsubscribe",
      },
    ]);
    await platform.crmService.syncFromMail();

    expect(platform.outreachStore.isSuppressed("stranger@example.com")).toBe(
      false,
    );
  });

  it("keeps a human's un-suppression: the same old 'stop' never re-suppresses", async () => {
    const contactId = addContact("mind@changed.example", "Mind Changer");
    giveOutreachHistory(contactId, "mind@changed.example");

    provider.seedAccount(accountId, "me@test.com", [
      {
        subject: "Re: Hi Mind",
        from: "Mind Changer <mind@changed.example>",
        bodyText: "stop",
      },
    ]);
    await platform.crmService.syncFromMail();
    expect(platform.outreachStore.isSuppressed("mind@changed.example")).toBe(
      true,
    );

    // The human removes the suppression through the route — the only removal
    // surface — which also withdraws the stored flags.
    const app = new Hono();
    registerOutreachRoutes(app, platform);
    const res = await app.request(
      `/api/outreach/suppression/${encodeURIComponent("mind@changed.example")}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(platform.outreachStore.isSuppressed("mind@changed.example")).toBe(
      false,
    );

    // Neither a re-sync (same message, no fresh row) nor an engine pass may
    // resurrect the removal from the same old rows.
    await platform.crmService.syncFromMail();
    await engine.tick();
    expect(platform.outreachStore.isSuppressed("mind@changed.example")).toBe(
      false,
    );

    // A NEW "stop" is a new request and suppresses again. seedAccount
    // replaces the whole box with uids restarting at 1, so the original
    // message is re-seeded first to keep its uid — the new mail must get a
    // fresh uid or the sync sees an already-recorded row.
    provider.seedAccount(accountId, "me@test.com", [
      {
        subject: "Re: Hi Mind",
        from: "Mind Changer <mind@changed.example>",
        bodyText: "stop",
      },
      {
        subject: "Re: Hi Mind again",
        from: "Mind Changer <mind@changed.example>",
        bodyText: "stop",
      },
    ]);
    await platform.crmService.syncFromMail();
    expect(platform.outreachStore.isSuppressed("mind@changed.example")).toBe(
      true,
    );
  });

  it("retries a body fetch that failed, then suppresses from the full body", async () => {
    const contactId = addContact("late@fetch.example", "Late Fetch");
    giveOutreachHistory(contactId, "late@fetch.example");

    const longBody = `${"Thanks for the detailed note, I read all of it. ".repeat(
      5,
    )}Please unsubscribe me from this list.`;
    provider.seedAccount(accountId, "me@test.com", [
      {
        subject: "Re: Hi Late",
        from: "Late Fetch <late@fetch.example>",
        snippet: longBody.slice(0, 140),
        bodyText: longBody,
      },
    ]);
    expect(longBody.slice(0, 140)).not.toMatch(/unsubscribe/i);

    const original = provider.getMessage.bind(provider);
    provider.getMessage = async () => {
      throw new Error("imap fetch failed");
    };
    await platform.crmService.syncFromMail();
    expect(platform.outreachStore.isSuppressed("late@fetch.example")).toBe(
      false,
    );

    provider.getMessage = original;
    await platform.crmService.syncFromMail();
    expect(platform.outreachStore.isSuppressed("late@fetch.example")).toBe(
      true,
    );
  });

  it("merges a queued draft that repeats a pending one word for word", () => {
    const draft = {
      accountId,
      to: "twice@example.com",
      subject: "Quick question",
      body: "Hello there.",
    };
    const first = platform.outreachStore.queueOutbox(draft);
    // What two overlapping automation runs reaching the same conclusion look
    // like. The second gets the first row back, not a second row.
    const second = platform.outreachStore.queueOutbox(draft);

    expect(second.id).toBe(first.id);
    expect(platform.outreachStore.listOutbox({}).length).toBe(1);
  });

  it("keeps a second draft that differs, however slightly", () => {
    const base = {
      accountId,
      to: "twice@example.com",
      subject: "Quick question",
      body: "Hello there.",
    };
    platform.outreachStore.queueOutbox(base);
    // A reviewer can delete a duplicate they can see; they cannot recover a
    // draft that was never written. So anything not identical is kept.
    platform.outreachStore.queueOutbox({ ...base, body: "Hello again." });
    platform.outreachStore.queueOutbox({ ...base, subject: "Another thing" });
    platform.outreachStore.queueOutbox({ ...base, to: "other@example.com" });

    expect(platform.outreachStore.listOutbox({}).length).toBe(4);
  });

  it("stops matching a draft once the pending row has been decided", () => {
    const draft = {
      accountId,
      to: "twice@example.com",
      subject: "Quick question",
      body: "Hello there.",
    };
    const first = platform.outreachStore.queueOutbox(draft);
    platform.outreachStore.decide(first.id, "rejected");
    // The merge only ever speaks for rows still awaiting review. A rejected
    // one must not silently swallow a later attempt.
    const again = platform.outreachStore.queueOutbox(draft);

    expect(again.id).not.toBe(first.id);
    expect(platform.outreachStore.listOutbox({}).length).toBe(2);
  });

  it("fails an approved row whose address was suppressed after approval", async () => {
    const row = platform.outreachStore.queueOutbox({
      accountId,
      to: "changed@example.com",
      subject: "s",
      body: "b",
    });
    platform.outreachStore.decide(row.id, "approved");
    // The stop lands between the human's click and the send pass.
    platform.outreachStore.addSuppression("changed@example.com", "reply-stop");

    expect(await engine.sendApproved()).toBe(0);
    const after = platform.outreachStore.getOutbox(row.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("recipient suppressed");
    expect(provider.getSent()).toHaveLength(0);
  });

  /* ---- the opt-out contract --------------------------------------------- */

  it("keeps the footer and the detector in step", () => {
    // The footer invites exactly one reply. If someone rewords either side,
    // this fails instead of quietly ignoring people who did as they were told.
    expect(optOutIntent(OPT_OUT_KEYWORD, "body")).toBe(true);
    expect(OPT_OUT_FOOTER).toContain(`"${OPT_OUT_KEYWORD}"`);
  });

  it("applies the whole-match rule to subjects, after reply prefixes", () => {
    // A subject that IS the keyword opts out, whatever the mail client
    // prepended. Localized prefixes too (Aw, Sv, Antw).
    expect(optOutIntent("stop", "subject")).toBe(true);
    expect(optOutIntent("Re: stop", "subject")).toBe(true);
    expect(optOutIntent("Fwd: Stop.", "subject")).toBe(true);
    expect(optOutIntent("Aw: please stop", "subject")).toBe(true);

    // A subject that merely starts with it is a normal mail. Otherwise every
    // conference invite suppresses its sender.
    expect(optOutIntent("Stop by our booth at SaaStr", "subject")).toBe(false);
    expect(optOutIntent("Re: Should we stop", "subject")).toBe(false);
  });

  it("never fabricates an opt-out across a field seam", () => {
    // Joined, these read "Should we stop emailing lists entirely?" — a phrase
    // that exists in neither field. Callers must match each field alone; this
    // pins what each alone answers.
    expect(optOutIntent("Re: Should we stop", "subject")).toBe(false);
    expect(optOutIntent("emailing lists entirely?", "body")).toBe(false);
  });

  it("ignores 'unsubscribe' that lives in quoted thread or signature, not the reply", () => {
    // A prospect saying yes, over a quoted newsletter and a corporate footer.
    const body = [
      "Sure, Tuesday at 10 works.",
      "",
      "-- ",
      "Jane Doe | Acme",
      "To unsubscribe from Acme updates, click here.",
    ].join("\n");
    expect(optOutIntent(body, "body")).toBe(false);

    const quoted = [
      "Sounds good!",
      "",
      "On Thu, Aug 14, Boxaide Newsletter wrote:",
      "> You can opt out of future mailings at any time.",
    ].join("\n");
    expect(optOutIntent(quoted, "body")).toBe(false);

    // The sender's own words still count.
    expect(optOutIntent("Please unsubscribe me.\n\n-- \nJane", "body")).toBe(
      true,
    );
  });

  it("treats an IDN address and its punycoded form as one suppression key", async () => {
    platform.outreachStore.addSuppression("User@München.de", "reply-stop");
    // Suppressed in unicode, sent in punycode — nodemailer's form.
    expect(platform.outreachStore.isSuppressed("user@xn--mnchen-3ya.de")).toBe(
      true,
    );

    const row = platform.outreachStore.queueOutbox({
      accountId,
      to: "user@xn--mnchen-3ya.de",
      subject: "s",
      body: "b",
    });
    platform.outreachStore.decide(row.id, "approved");
    expect(await engine.sendApproved()).toBe(0);
    expect(platform.outreachStore.getOutbox(row.id)?.error).toContain(
      "recipient suppressed",
    );
    expect(provider.getSent()).toHaveLength(0);
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
    const capped = new OutreachEngine(platform.outreachStore, mail, {
      now: () => new Date(clock),
      sleep: async (ms) => {
        slept.push(ms);
      },
      random: () => 0.5,
      dailyCap: () => 2,
    });
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
    const zeroJitter = new OutreachEngine(platform.outreachStore, mail, {
      now: () => new Date(clock),
      sleep: async (ms) => {
        floorSlept.push(ms);
      },
      random: () => 0,
    });
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
    platform.outreachStore.queueOutbox({
      accountId,
      to: "ada@acme.example",
      subject: "Secret subject",
      body: "Secret body",
    });

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

  it("exposes exactly the four spec tools and no approval tool", () => {
    expect(OUTREACH_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "outbox_list",
        "outbox_queue_draft",
        "suppression_add",
        "suppression_list",
      ].sort(),
    );
    const queue = OUTREACH_TOOLS.find((t) => t.name === "outbox_queue_draft");
    expect(queue?.description).toContain(
      "the ONLY way an automation or agent gets outreach toward delivery; a human reviews it in the Boxaide Outreach view before anything is sent",
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

  it("rewrites pre-canonical suppression rows onto canonical keys at open", () => {
    // A row the pre-canonicalEmail code would have written: trim+lowercase
    // only, unicode domain. Inserted with raw SQL to bypass today's write path.
    store.db
      .prepare(`INSERT INTO suppression (email, reason, at) VALUES (?, ?, ?)`)
      .run("user@münchen.de", "manual", "2026-08-01T00:00:00.000Z");

    // Re-running the migration is what a process restart does.
    const reopened = new (platform.outreachStore.constructor as new (
      db: typeof store.db,
      masterKey: Buffer,
    ) => typeof platform.outreachStore)(store.db, masterKey);

    // Both spellings of the mailbox hit the one rewritten row.
    expect(reopened.isSuppressed("user@münchen.de")).toBe(true);
    expect(reopened.isSuppressed("user@xn--mnchen-3ya.de")).toBe(true);
    const rows = store.db
      .prepare(`SELECT email FROM suppression WHERE email LIKE '%mnchen%' OR email LIKE '%münchen%'`)
      .all() as Array<{ email: string }>;
    expect(rows).toEqual([{ email: "user@xn--mnchen-3ya.de" }]);
  });
});
