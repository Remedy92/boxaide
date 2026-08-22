import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import { MailIndexStore } from "../src/mail/index-store.js";
import type {
  AccountCredentials,
  MailMessageSummary,
} from "../src/provider/types.js";

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

  it("orders and pages a three-account unified list by date", async () => {
    // The unified list is built from one indexed branch per account, unioned.
    // Ordering, LIMIT, OFFSET and unreadOnly all have to survive that, and each
    // branch has to be asked for limit+offset rows or a later page loses
    // messages from whichever account happened to sort late.
    const ids = [accountId];
    for (const alias of ["work", "side"]) {
      const acct = await mail.connectAccount({
        alias,
        email: `you@${alias}.test`,
        creds: {
          ...baseCreds,
          auth: { kind: "password", user: `you@${alias}.test`, pass: "ok" },
        },
      });
      ids.push(acct.id);
    }
    // A folder of its own, so the seeded INBOX mail does not interleave.
    const folder = "Archive";
    const base = Date.parse("2026-03-01T00:00:00.000Z");
    // Interleaved on purpose: newest to oldest the accounts alternate, so a
    // per-account LIMIT that ignored the others would hand back the wrong page.
    ids.forEach((id, accountIndex) => {
      for (let n = 0; n < 9; n += 1) {
        const rank = n * ids.length + accountIndex;
        mail.index.upsertSummary({
          id: `${id}:${folder}:${n + 1}`,
          accountId: id,
          uid: n + 1,
          messageId: `<${id}-${n}@t>`,
          folder,
          from: "s@example.com",
          to: "you@example.com",
          subject: `rank-${String(rank).padStart(2, "0")}`,
          date: new Date(base - rank * 60_000).toISOString(),
          internalDate: new Date(base - rank * 60_000).toISOString(),
          snippet: "a line of preview text",
          seen: rank % 2 === 0,
          hasAttachments: false,
        });
      }
    });
    const rank = (i: number) => `rank-${String(i).padStart(2, "0")}`;

    expect(
      mail.index
        .listMessages({ accountIds: ids, folder, limit: 27 })
        .map((m) => m.subject),
    ).toEqual(Array.from({ length: 27 }, (_, i) => rank(i)));

    expect(
      mail.index
        .listMessages({ accountIds: ids, folder, limit: 5 })
        .map((m) => m.subject),
    ).toEqual([rank(0), rank(1), rank(2), rank(3), rank(4)]);

    expect(
      mail.index
        .listMessages({ accountIds: ids, folder, limit: 5, offset: 5 })
        .map((m) => m.subject),
    ).toEqual([rank(5), rank(6), rank(7), rank(8), rank(9)]);

    expect(
      mail.index
        .listMessages({ accountIds: ids, folder, limit: 4, unreadOnly: true })
        .map((m) => m.subject),
    ).toEqual([rank(1), rank(3), rank(5), rank(7)]);

    // One account still takes the single-branch plan.
    expect(
      mail.index
        .listMessages({ accountIds: [ids[0]], folder, limit: 3 })
        .map((m) => m.subject),
    ).toEqual([rank(0), rank(3), rank(6)]);
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

  it("populates snippet and attachments on first-seen mail during tray-sized sync", async () => {
    provider.seedAccount(accountId, "you@personal.test", [
      {
        subject: "Tray item",
        from: "tray@example.com",
        bodyText: "tray snippet text",
        hasAttachments: true,
      },
    ]);
    const tray = await mail.listMessages("personal", { limit: 9 });
    expect(tray.messages).toHaveLength(1);
    expect(tray.messages[0].snippet).toBe("tray snippet text");
    expect(tray.messages[0].hasAttachments).toBe(true);

    const app = await mail.listMessages("personal", { limit: 50 });
    expect(app.messages[0].snippet).toBe("tray snippet text");
    expect(app.messages[0].hasAttachments).toBe(true);
  });

  it("drops an undecryptable summary row instead of failing the list", async () => {
    await mail.listMessages("personal", { limit: 20 });
    store.db
      .prepare(
        `INSERT INTO message_summaries (
           account_id, folder, uid, id, message_id_enc, from_enc, to_enc,
           subject_enc, snippet_enc, date, seen, has_attachments
         ) VALUES (
           ?, 'INBOX', 999, 'corrupt-row', NULL, 'bad', 'bad', 'bad-data', 'bad', ?, 0, 0
         )`,
      )
      .run(accountId, new Date().toISOString());

    const listed = mail.index.listMessages({
      accountIds: [accountId],
      folder: "INBOX",
      limit: 20,
    });
    expect(listed.map((m) => m.subject)).toEqual([
      "Secret subject",
      "Already read",
    ]);
  });

  it("creates composite index on (account_id, folder, date DESC)", () => {
    const indexes = store.db
      .prepare(`PRAGMA index_list('message_summaries')`)
      .all() as Array<{ name: string }>;
    expect(
      indexes.some(
        (idx) => idx.name === "message_summaries_account_folder_date",
      ),
    ).toBe(true);
    expect(
      indexes.some((idx) => idx.name === "message_summaries_date"),
    ).toBe(false);
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

  it("marks the folder the server named when the sent uid is withheld", async () => {
    // Gmail and Fastmail do not call it "Sent". Guessing that name marks a
    // folder nothing reads, and the sent copy never shows up.
    const send = provider.sendMessage.bind(provider);
    provider.sendMessage = async (account, input) => {
      const result = await send(account, input);
      return {
        messageId: result.messageId,
        accepted: result.accepted,
        sentFolder: "[Gmail]/Sent Mail",
      };
    };
    mail.index.applySync(accountId, "[Gmail]/Sent Mail", {
      replaced: true,
      messages: [],
      vanishedUids: [],
      flagUpdates: [],
      cursor: { uidvalidity: 1, highestModseq: "1", uidnext: 1, exists: 0 },
    });

    await mail.sendMessage("personal", {
      to: "client@acme.test",
      subject: "Shipped",
      text: "hello",
    });
    expect(mail.index.getState(accountId, "[Gmail]/Sent Mail")?.dirty).toBe(
      true,
    );
  });

  it("reaches past the newest window for a since ask, then serves it from SQLite", async () => {
    // 30 messages an hour apart. A window of 10 cannot reach back a day.
    const base = Date.now();
    provider.seedAccount(
      accountId,
      "you@personal.test",
      Array.from({ length: 30 }, (_, i) => ({
        subject: `Hour ${i}`,
        from: "n@example.com",
        date: new Date(base - i * 3600_000).toISOString(),
      })),
    );
    let syncs = 0;
    const orig = provider.syncMailbox.bind(provider);
    provider.syncMailbox = async (account, opts) => {
      syncs += 1;
      return orig(account, opts);
    };

    // A minute of slack, so the 24-hour-old message is unambiguously inside.
    const since = new Date(base - 24 * 3600_000 - 60_000).toISOString();
    const first = await mail.listMessages("personal", { limit: 50, since });
    // The day holds 25 of them; the newest-10 window would have hidden 15.
    expect(first.messages).toHaveLength(25);
    expect(syncs).toBe(1);

    const second = await mail.listMessages("personal", { limit: 50, since });
    expect(second.messages.map((m) => m.subject)).toEqual(
      first.messages.map((m) => m.subject),
    );
    expect(syncs).toBe(1);
  });

  it("fills again when the ask reaches further back than the index covers", async () => {
    const base = Date.now();
    provider.seedAccount(
      accountId,
      "you@personal.test",
      Array.from({ length: 40 }, (_, i) => ({
        subject: `Hour ${i}`,
        from: "n@example.com",
        date: new Date(base - i * 3600_000).toISOString(),
      })),
    );
    const recent = new Date(base - 6 * 3600_000 - 60_000).toISOString();
    await mail.listMessages("personal", { limit: 50, since: recent });
    let syncs = 0;
    const orig = provider.syncMailbox.bind(provider);
    provider.syncMailbox = async (account, opts) => {
      syncs += 1;
      return orig(account, opts);
    };

    const older = new Date(base - 30 * 3600_000 - 60_000).toISOString();
    const deeper = await mail.listMessages("personal", {
      limit: 50,
      since: older,
    });
    expect(syncs).toBe(1);
    expect(deeper.messages).toHaveLength(31);
  });

  it("keeps mail whose sender clock is wrong but which arrived in the window", () => {
    mail.index.upsertSummary({
      id: `${accountId}:INBOX:900`,
      accountId,
      uid: 900,
      folder: "INBOX",
      from: "skewed@example.com",
      to: "you@personal.test",
      subject: "Wrong clock",
      // The header says last year; the server received it an hour ago.
      date: new Date(Date.now() - 365 * 24 * 3600_000).toISOString(),
      internalDate: new Date(Date.now() - 3600_000).toISOString(),
      snippet: "still recent",
      seen: false,
      hasAttachments: false,
    });
    const listed = mail.index.listMessages({
      accountIds: [accountId],
      folder: "INBOX",
      limit: 20,
      since: new Date(Date.now() - 24 * 3600_000).toISOString(),
    });
    expect(listed.map((m) => m.subject)).toContain("Wrong clock");
  });

  it("drops an archived row from the index and keeps EXISTS honest", async () => {
    const before = await mail.listMessages("personal", { limit: 20 });
    const target = before.messages.find((m) => m.subject === "Secret subject")!;
    const existsBefore = mail.index.getState(accountId, "INBOX")!.exists;

    const result = await mail.archiveMessage("personal", target.id);
    expect(result).toMatchObject({ moved: true, toFolder: "Archive" });

    // The row is gone from the index straight away, without waiting for a
    // sync, so the list cannot paint a message that has left the folder.
    expect(mail.index.count(accountId, "INBOX")).toBe(existsBefore - 1);
    const state = mail.index.getState(accountId, "INBOX")!;
    expect(state.exists).toBe(existsBefore - 1);
    expect(state.dirty).toBe(true);
  });

  it("drops a deleted row from the index and fabricates no Trash row", async () => {
    const before = await mail.listMessages("personal", { limit: 20 });
    const target = before.messages.find((m) => m.subject === "Already read")!;
    const existsBefore = mail.index.getState(accountId, "INBOX")!.exists;

    const result = await mail.trashMessage("personal", target.id);
    expect(result).toMatchObject({ moved: true, toFolder: "Trash" });

    // Delete goes through the same index bookkeeping as archive, because on
    // the server it is the same operation: the row leaves INBOX at once, so
    // the list cannot paint a message that is no longer there.
    expect(mail.index.count(accountId, "INBOX")).toBe(existsBefore - 1);
    const state = mail.index.getState(accountId, "INBOX")!;
    expect(state.exists).toBe(existsBefore - 1);
    expect(state.dirty).toBe(true);
    // Nothing is fabricated into Trash: only the server knows the uid the
    // message has there, so that mailbox stays unknown until it is listed.
    expect(mail.index.getState(accountId, "Trash")).toBeNull();
  });

  it("does not touch the index when the delete moved nothing", async () => {
    await mail.listMessages("personal", { limit: 20 });
    const countBefore = mail.index.count(accountId, "INBOX");
    const result = await mail.trashMessage("personal", `${accountId}:9999`);
    expect(result.moved).toBe(false);
    expect(mail.index.count(accountId, "INBOX")).toBe(countBefore);
  });

  it("does not touch the index when the archive moved nothing", async () => {
    await mail.listMessages("personal", { limit: 20 });
    const countBefore = mail.index.count(accountId, "INBOX");
    const result = await mail.archiveMessage("personal", `${accountId}:9999`);
    expect(result.moved).toBe(false);
    expect(mail.index.count(accountId, "INBOX")).toBe(countBefore);
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

  it("lists a message whose snippet and subject are empty", () => {
    const empty = new Store(randomBytes(32), ":memory:");
    const index = new MailIndexStore(empty.db, empty.masterKey);
    index.upsertSummary({
      id: "acct:INBOX:1",
      accountId: "acct",
      uid: 1,
      messageId: "<invite@example.com>",
      folder: "INBOX",
      // A calendar invite carries no body text and sometimes no subject.
      from: "organiser@example.com",
      to: "you@example.com",
      subject: "",
      date: new Date().toISOString(),
      snippet: "",
      seen: false,
      hasAttachments: false,
    });
    const listed = index.listMessages({
      accountIds: ["acct"],
      folder: "INBOX",
      limit: 10,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0].subject).toBe("");
    expect(listed[0].snippet).toBe("");
    expect(listed[0].from).toBe("organiser@example.com");
  });
});

describe("mail index upgrade", () => {
  it("adds the date columns to a database written before they existed", () => {
    const store = new Store(randomBytes(32), ":memory:");
    // The shape shipped before receive time and coverage were tracked.
    store.db.exec(`
      CREATE TABLE mailbox_state (
        account_id TEXT NOT NULL,
        folder TEXT NOT NULL,
        uidvalidity INTEGER NOT NULL,
        highest_modseq TEXT,
        uidnext INTEGER,
        exists_count INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT,
        last_error TEXT,
        PRIMARY KEY (account_id, folder)
      );
      CREATE TABLE message_summaries (
        account_id TEXT NOT NULL,
        folder TEXT NOT NULL,
        uid INTEGER NOT NULL,
        id TEXT NOT NULL,
        message_id_enc TEXT,
        from_enc TEXT NOT NULL,
        to_enc TEXT NOT NULL,
        subject_enc TEXT NOT NULL,
        snippet_enc TEXT NOT NULL,
        date TEXT NOT NULL,
        seen INTEGER NOT NULL DEFAULT 0,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, folder, uid)
      );
    `);

    const index = new MailIndexStore(store.db, store.masterKey);
    index.upsertSummary({
      id: "acct:INBOX:1",
      accountId: "acct",
      uid: 1,
      folder: "INBOX",
      from: "a@b.c",
      to: "you@personal.test",
      subject: "Survived the upgrade",
      date: new Date().toISOString(),
      internalDate: new Date().toISOString(),
      snippet: "still here",
      seen: false,
      hasAttachments: false,
    });
    const listed = index.listMessages({
      accountIds: ["acct"],
      folder: "INBOX",
      limit: 5,
      since: new Date(Date.now() - 3600_000).toISOString(),
    });
    expect(listed.map((m) => m.subject)).toEqual(["Survived the upgrade"]);
    expect(index.needsSinceFill(null, new Date().toISOString())).toBe(true);
  });
});

describe("unread per folder from the index", () => {
  let store: Store;
  let index: MailIndexStore;

  function summary(
    folder: string,
    uid: number,
    seen: boolean,
  ): MailMessageSummary {
    return {
      id: `acct:${folder}:${uid}`,
      accountId: "acct",
      uid,
      folder,
      from: "a@b.c",
      to: "you@personal.test",
      subject: `Message ${uid}`,
      date: new Date().toISOString(),
      internalDate: new Date().toISOString(),
      snippet: "body",
      seen,
      hasAttachments: false,
    };
  }

  /** One sync pass: writes the mailbox_state row that marks a folder synced. */
  function sync(
    folder: string,
    messages: MailMessageSummary[],
    exists = messages.length,
  ): void {
    index.applySync("acct", folder, {
      replaced: true,
      messages,
      vanishedUids: [],
      flagUpdates: [],
      cursor: {
        uidvalidity: 1,
        highestModseq: "1",
        uidnext: messages.length + 1,
        exists,
      },
    });
  }

  beforeEach(() => {
    store = new Store(randomBytes(32), ":memory:");
    index = new MailIndexStore(store.db, store.masterKey);
  });

  it("counts unseen rows for a synced folder", () => {
    sync("INBOX", [
      summary("INBOX", 1, false),
      summary("INBOX", 2, true),
      summary("INBOX", 3, false),
    ]);
    expect(index.unreadByFolder("acct").get("INBOX")).toEqual({
      count: 2,
      exact: true,
    });
  });

  it("leaves a never-synced folder OUT of the map rather than reporting zero", () => {
    sync("INBOX", [summary("INBOX", 1, false)]);
    const map = index.unreadByFolder("acct");
    // Absence, not zero: a confident 0 over a folder nobody has looked at is
    // exactly the lie the badge must never tell.
    expect(map.has("Never/Synced")).toBe(false);
    expect(map.get("Never/Synced")).toBeUndefined();
  });

  it("reports a real zero as present with count 0", () => {
    sync("Archive", [
      summary("Archive", 1, true),
      summary("Archive", 2, true),
    ]);
    const map = index.unreadByFolder("acct");
    expect(map.has("Archive")).toBe(true);
    expect(map.get("Archive")).toEqual({ count: 0, exact: true });
  });

  it("marks the count inexact when the index holds only a window", () => {
    // Two rows indexed, the server says the folder holds 500.
    sync("Big", [summary("Big", 1, false), summary("Big", 2, false)], 500);
    expect(index.unreadByFolder("acct").get("Big")).toEqual({
      count: 2,
      exact: false,
    });
  });

  it("keeps one account's folders out of another's map", () => {
    sync("INBOX", [summary("INBOX", 1, false)]);
    expect(index.unreadByFolder("other").size).toBe(0);
  });
});
