import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import type { AccountCredentials } from "../src/provider/types.js";

const baseCreds: AccountCredentials = {
  imapHost: "fixture",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "fixture",
  smtpPort: 465,
  smtpSecure: true,
  auth: { kind: "password", user: "a@test.com", pass: "ok" },
};

function asAccount(store: Store, id: string) {
  const full = store.getAccount(id)!;
  return {
    id: full.id,
    alias: full.alias,
    email: full.email,
    creds: store.credentialsFor(full),
  };
}

describe("local mail index", () => {
  let mail: MailService;
  let provider: FixtureProvider;
  let store: Store;
  let accountId: string;

  beforeEach(async () => {
    store = new Store(randomBytes(32), ":memory:");
    provider = new FixtureProvider();
    mail = new MailService(store, provider);
    const connected = await mail.connectAccount({
      alias: "personal",
      email: "you@personal.test",
      creds: {
        ...baseCreds,
        auth: { kind: "password", user: "you@personal.test", pass: "ok" },
      },
    });
    accountId = connected.id;
    provider.seedAccount(accountId, "you@personal.test", [
      {
        subject: "Secret subject",
        from: "friend@example.com",
        bodyText: "hello cache",
        seen: false,
      },
      {
        subject: "Already read",
        from: "list@example.com",
        bodyText: "newsletter",
        seen: true,
        date: new Date(Date.now() - 3600_000).toISOString(),
      },
    ]);
  });

  it("fills on the first list and serves the second from SQLite", async () => {
    let syncs = 0;
    const orig = provider.syncMailbox.bind(provider);
    provider.syncMailbox = async (account, opts) => {
      syncs += 1;
      return orig(account, opts);
    };

    const first = await mail.listMessages("personal", { limit: 20 });
    expect(first.errors).toEqual([]);
    expect(first.messages.map((m) => m.subject)).toEqual([
      "Secret subject",
      "Already read",
    ]);
    expect(syncs).toBe(1);

    const second = await mail.listMessages("personal", { limit: 20 });
    expect(second.messages.map((m) => m.subject)).toEqual([
      "Secret subject",
      "Already read",
    ]);
    expect(syncs).toBe(1);

    const row = store.db
      .prepare(`SELECT subject_enc as enc FROM message_summaries LIMIT 1`)
      .get() as { enc: string };
    expect(row.enc).not.toContain("Secret subject");
  });

  it("filters unread from the index without a second IMAP fill", async () => {
    await mail.listMessages("personal", { limit: 20 });
    let syncs = 0;
    const orig = provider.syncMailbox.bind(provider);
    provider.syncMailbox = async (account, opts) => {
      syncs += 1;
      return orig(account, opts);
    };

    const unread = await mail.listMessages("personal", {
      limit: 20,
      unreadOnly: true,
    });
    expect(unread.messages).toHaveLength(1);
    expect(unread.messages[0].subject).toBe("Secret subject");
    expect(syncs).toBe(0);
  });

  it("writes markRead through to the index", async () => {
    const listed = await mail.listMessages("personal", { limit: 20 });
    const unread = listed.messages.find((m) => !m.seen)!;
    expect(await mail.markRead("personal", unread.id, true)).toBe(true);
    const after = await mail.listMessages("personal", { limit: 20 });
    expect(after.messages.find((m) => m.id === unread.id)?.seen).toBe(true);
  });

  it("wipes the folder when uidvalidity changes", async () => {
    await mail.listMessages("personal", { limit: 20 });
    provider.setUidValidity(accountId, 99);
    provider.seedAccount(accountId, "you@personal.test", [
      {
        subject: "After rebuild",
        from: "new@example.com",
        bodyText: "rebuilt",
      },
    ]);
    const account = asAccount(store, accountId);
    const result = await provider.syncMailbox(account, {
      limit: 20,
      cursor: {
        uidvalidity: 1,
        highestModseq: "1",
        uidnext: 3,
        exists: 2,
      },
    });
    expect(result.replaced).toBe(true);
    expect(result.messages.map((m) => m.subject)).toEqual(["After rebuild"]);
    mail.index.applySync(accountId, "INBOX", result);
    const listed = mail.index.listMessages({
      accountIds: [accountId],
      folder: "INBOX",
      limit: 20,
    });
    expect(listed.map((m) => m.subject)).toEqual(["After rebuild"]);
  });

  it("unifies two accounts in one SQLite ordered list", async () => {
    const work = await mail.connectAccount({
      alias: "work",
      email: "you@work.test",
      creds: {
        ...baseCreds,
        auth: { kind: "password", user: "you@work.test", pass: "ok" },
      },
    });
    provider.seedAccount(work.id, "you@work.test", [
      {
        subject: "Work ping",
        from: "boss@work.test",
        date: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);
    const all = await mail.listMessages("all", { limit: 20 });
    expect(all.errors).toEqual([]);
    expect(all.messages[0].subject).toBe("Work ping");
    expect(all.messages.map((m) => m.subject)).toEqual(
      expect.arrayContaining(["Work ping", "Secret subject", "Already read"]),
    );
  });

  it("grows the indexed window after a tray-sized first fill", async () => {
    provider.seedAccount(accountId, "you@personal.test", [
      ...Array.from({ length: 15 }, (_, i) => ({
        subject: `Msg ${i + 1}`,
        from: "n@example.com",
        date: new Date(Date.now() - i * 1000).toISOString(),
      })),
    ]);
    const tray = await mail.listMessages("personal", { limit: 9 });
    expect(tray.messages).toHaveLength(9);
    const app = await mail.listMessages("personal", { limit: 20 });
    expect(app.messages).toHaveLength(15);
  });

  it("drops expunged messages on the next refresh", async () => {
    await mail.listMessages("personal", { limit: 20 });
    provider.seedAccount(accountId, "you@personal.test", [
      {
        subject: "Only survivor",
        from: "friend@example.com",
        bodyText: "still here",
      },
    ]);
    const after = await mail.listMessages("personal", {
      limit: 20,
      refresh: true,
    });
    expect(after.messages.map((m) => m.subject)).toEqual(["Only survivor"]);
  });

  it("does not let a thin tray sync wipe a real snippet", () => {
    mail.index.upsertSummary({
      id: `${accountId}:INBOX:1`,
      accountId,
      uid: 1,
      folder: "INBOX",
      from: "a@b.c",
      to: "you@personal.test",
      subject: "Secret subject",
      date: new Date().toISOString(),
      snippet: "hello cache",
      seen: false,
      hasAttachments: true,
    });
    mail.index.applySync(accountId, "INBOX", {
      replaced: false,
      messages: [
        {
          id: `${accountId}:INBOX:1`,
          accountId,
          uid: 1,
          folder: "INBOX",
          from: "a@b.c",
          to: "you@personal.test",
          subject: "Secret subject",
          date: new Date().toISOString(),
          snippet: "Secret subject",
          seen: false,
          hasAttachments: false,
        },
      ],
      vanishedUids: [],
      flagUpdates: [],
      cursor: {
        uidvalidity: 1,
        highestModseq: "1",
        uidnext: 2,
        exists: 1,
      },
      thin: true,
    });
    const listed = mail.index.listMessages({
      accountIds: [accountId],
      folder: "INBOX",
      limit: 5,
    });
    expect(listed[0].snippet).toBe("hello cache");
    expect(listed[0].hasAttachments).toBe(true);
  });

  it("indexes a sent copy when the provider returns a uid", async () => {
    await mail.sendMessage("personal", {
      to: "client@acme.test",
      subject: "Shipped",
      text: "hello",
    });
    const sent = mail.index.listMessages({
      accountIds: [accountId],
      folder: "Sent",
      limit: 10,
    });
    expect(sent.map((m) => m.subject)).toEqual(["Shipped"]);
  });

  it("rebuilds through listMessages when uidvalidity changes", async () => {
    await mail.listMessages("personal", { limit: 20 });
    provider.setUidValidity(accountId, 99);
    provider.seedAccount(accountId, "you@personal.test", [
      {
        subject: "After rebuild",
        from: "new@example.com",
        bodyText: "rebuilt",
      },
    ]);
    const listed = await mail.listMessages("personal", {
      limit: 20,
      refresh: true,
    });
    expect(listed.messages.map((m) => m.subject)).toEqual(["After rebuild"]);
  });
});
