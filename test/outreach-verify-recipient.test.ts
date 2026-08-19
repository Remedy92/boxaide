/**
 * The pre-send deliverability check in OutreachEngine.sendApproved.
 *
 * The rule this file pins down is not "verify addresses". It is that the check
 * may only ever remove a send, never add one, and that a verifier which is
 * down, slow, or unconfigured leaves the queue behaving exactly as it did
 * before anyone bought a provider key.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import { createPlatform, type Platform } from "../src/platform.js";
import type { AgentLauncher } from "../src/agent/launcher.js";
import { OutreachEngine, type RecipientVerdict } from "../src/outreach/engine.js";

const baseCreds = {
  imapHost: "fixture",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "fixture",
  smtpPort: 465,
  smtpSecure: true,
  auth: { kind: "password" as const, user: "me@test.com", pass: "ok" },
};

/** CRM tables the platform's stores expect. CrmStore owns these in production. */
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
  `);
}

describe("outreach pre-send verification", () => {
  let store: Store;
  let mail: MailService;
  let provider: FixtureProvider;
  let platform: Platform;
  let accountId: string;
  let asked: string[];
  let engine: OutreachEngine | null = null;

  beforeEach(async () => {
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
    createCrmFixtureTables(store.db);
    platform = createPlatform({
      db: store.db,
      masterKey,
      mail,
      launcher: {} as AgentLauncher,
    });
    asked = [];
  });

  afterEach(() => {
    engine?.stop();
    store.db.close();
  });

  /** An engine with a verifier under the test's control and no real waiting. */
  function makeEngine(
    verify: (email: string) => Promise<RecipientVerdict | null>,
  ): OutreachEngine {
    engine = new OutreachEngine(platform.outreachStore, platform.crmStore, mail, {
      sleep: async () => {},
      random: () => 0,
      verifyRecipient: async (email) => {
        asked.push(email);
        return verify(email);
      },
    });
    return engine;
  }

  function approve(to: string): string {
    const row = platform.outreachStore.queueOutbox({
      accountId,
      to,
      subject: "s",
      body: "b",
    });
    platform.outreachStore.decide(row.id, "approved");
    return row.id;
  }

  it("fails an approved row whose address is reported invalid", async () => {
    const id = approve("gone@example.com");
    const sent = await makeEngine(async () => ({
      status: "invalid",
      confidence: 0,
    })).sendApproved();

    expect(sent).toBe(0);
    expect(provider.getSent()).toHaveLength(0);
    const row = platform.outreachStore.getOutbox(id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("gone@example.com");
    expect(row?.error).toMatch(/did not verify/);
  });

  it("sends a valid address, and sends a risky or unknown one too", async () => {
    const statuses: RecipientVerdict["status"][] = ["valid", "risky", "unknown"];
    for (const status of statuses) {
      const id = approve(`${status}@example.com`);
      const sent = await makeEngine(async () => ({
        status,
        confidence: 50,
      })).sendApproved();
      expect(sent).toBe(1);
      expect(platform.outreachStore.getOutbox(id)?.status).toBe("sent");
    }
    expect(provider.getSent()).toHaveLength(3);
  });

  it("sends when the verifier throws, and when there is none at all", async () => {
    const thrown = approve("a@example.com");
    expect(
      await makeEngine(async () => {
        throw new Error("provider 402");
      }).sendApproved(),
    ).toBe(1);
    expect(platform.outreachStore.getOutbox(thrown)?.status).toBe("sent");

    // No verifyRecipient dep at all: an install with no provider key.
    const bare = approve("b@example.com");
    engine = new OutreachEngine(platform.outreachStore, platform.crmStore, mail, {
      sleep: async () => {},
      random: () => 0,
    });
    expect(await engine.sendApproved()).toBe(1);
    expect(platform.outreachStore.getOutbox(bare)?.status).toBe("sent");
  });

  it("does not verify a row it was never going to send", async () => {
    // Suppressed at send time: the row fails on the cheaper check first, so
    // the operator is not billed for an address nobody may write to.
    const id = approve("stop@example.com");
    platform.outreachStore.addSuppression("stop@example.com", "manual");
    await makeEngine(async () => ({ status: "valid", confidence: 99 })).sendApproved();

    expect(asked).toEqual([]);
    expect(platform.outreachStore.getOutbox(id)?.status).toBe("failed");
  });
});
