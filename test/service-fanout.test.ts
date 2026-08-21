import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Store } from "../src/db/store.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { MailService } from "../src/mail/service.js";
import { handleMcpJsonRpc } from "../src/mcp/server.js";
import type {
  AccountCredentials,
  ConnectionTestResult,
  DraftRef,
  ListMessagesOpts,
  MailDraft,
  MailFolder,
  MailMessage,
  MailMessageSummary,
  MailProvider,
  MoveResult,
  ProviderAccount,
  SearchMessagesOpts,
  SendMessageInput,
  SendResult,
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

function summary(accountId: string, subject: string): MailMessageSummary {
  return {
    id: `${accountId}:INBOX:1`,
    accountId,
    uid: 1,
    folder: "INBOX",
    from: "someone@example.com",
    to: "you@example.com",
    subject,
    date: "2026-01-01T00:00:00.000Z",
    snippet: subject,
    seen: false,
    hasAttachments: false,
  };
}

/**
 * Succeeds for `goodAlias` and throws for every other account, so a fan-out
 * across both must still return the good account's mail.
 */
class FlakyProvider implements MailProvider {
  constructor(private goodAlias: string) {}

  private guard(account: ProviderAccount): void {
    if (account.alias !== this.goodAlias) {
      throw new Error(`IMAP connection refused for ${account.alias}`);
    }
  }

  async testConnection(_creds: AccountCredentials): Promise<ConnectionTestResult> {
    return { ok: true };
  }

  async listMessages(
    account: ProviderAccount,
    _opts?: ListMessagesOpts,
  ): Promise<MailMessageSummary[]> {
    this.guard(account);
    return [summary(account.id, "Good account mail")];
  }

  async syncMailbox(account: ProviderAccount) {
    this.guard(account);
    const messages = [summary(account.id, "Good account mail")];
    return {
      replaced: true,
      messages,
      vanishedUids: [],
      flagUpdates: [],
      cursor: {
        uidvalidity: 1,
        highestModseq: null,
        uidnext: 2,
        exists: 1,
      },
    };
  }

  async searchMessages(
    account: ProviderAccount,
    _opts: SearchMessagesOpts,
  ): Promise<MailMessageSummary[]> {
    this.guard(account);
    return [summary(account.id, "Good account hit")];
  }

  async getMessage(): Promise<MailMessage | null> {
    return null;
  }

  async sendMessage(): Promise<SendResult> {
    throw new Error("not used");
  }

  async markRead(): Promise<boolean> {
    return false;
  }

  // A move is per-account too, for the same reason as the drafts below.
  async moveMessage(): Promise<MoveResult> {
    throw new Error("not used");
  }

  async archiveMessage(): Promise<MoveResult> {
    throw new Error("not used");
  }

  async trashMessage(): Promise<MoveResult> {
    throw new Error("not used");
  }

  async listFolders(): Promise<MailFolder[]> {
    return [];
  }

  // Drafts are per-account only, so they never reach a fan-out. Present so the
  // double still satisfies MailProvider rather than drifting from it.
  async createDraft(): Promise<DraftRef> {
    throw new Error("not used");
  }

  async updateDraft(): Promise<DraftRef> {
    throw new Error("not used");
  }

  async listDrafts(): Promise<MailDraft[]> {
    return [];
  }

  async deleteDraft(): Promise<boolean> {
    return false;
  }
}

async function connectPair(mail: MailService): Promise<void> {
  await mail.connectAccount({
    alias: "good",
    email: "good@test.com",
    creds: { ...baseCreds, auth: { kind: "password", user: "good@test.com", pass: "ok" } },
  });
  await mail.connectAccount({
    alias: "broken",
    email: "broken@test.com",
    creds: { ...baseCreds, auth: { kind: "password", user: "broken@test.com", pass: "ok" } },
  });
}

describe("MailService fan-out survives one failing account (P0)", () => {
  let mail: MailService;

  beforeEach(async () => {
    const store = new Store(randomBytes(32), ":memory:");
    mail = new MailService(store, new FlakyProvider("good"));
    await connectPair(mail);
  });

  it("returns the healthy account's messages and reports the failure", async () => {
    const res = await mail.listMessages("all", { limit: 20 });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].subject).toBe("Good account mail");
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].account).toBe("broken");
    expect(res.errors[0].error).toMatch(/connection refused/i);
  });

  it("applies the same partial-failure rule to search", async () => {
    const res = await mail.searchMessages("all", { query: "good", limit: 20 });
    expect(res.messages.map((m) => m.subject)).toEqual(["Good account hit"]);
    expect(res.errors.map((e) => e.account)).toEqual(["broken"]);
  });

  it("still rejects when a single named account is the one that fails", async () => {
    await expect(mail.listMessages("broken", { limit: 20 })).rejects.toThrow(
      /connection refused/i,
    );
  });

  it("surfaces the partial failure through the MCP tool result", async () => {
    const res = (await handleMcpJsonRpc(mail, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "messages_list", arguments: { account: "all" } },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.messages).toHaveLength(1);
    expect(payload.errors).toEqual([
      { account: "broken", error: "IMAP connection refused for broken" },
    ]);
  });
});

describe("read state: getMessage vs markRead (fixture/IMAP parity)", () => {
  let mail: MailService;
  let provider: FixtureProvider;
  let messageId: string;

  beforeEach(async () => {
    const store = new Store(randomBytes(32), ":memory:");
    provider = new FixtureProvider();
    mail = new MailService(store, provider);
    const account = await mail.connectAccount({
      alias: "personal",
      email: "you@personal.test",
      creds: { ...baseCreds, auth: { kind: "password", user: "you@personal.test", pass: "ok" } },
    });
    provider.seedAccount(account.id, "you@personal.test", [
      { subject: "Unread note", from: "friend@example.com", bodyText: "hi" },
    ]);
    const listed = await mail.listMessages("personal", { limit: 10 });
    expect(listed.messages[0].seen).toBe(false);
    messageId = listed.messages[0].id;
  });

  it("does NOT mark a message seen when reading it", async () => {
    const full = await mail.getMessage("personal", messageId);
    expect(full?.seen).toBe(false);
    const after = await mail.listMessages("personal", { limit: 10 });
    expect(after.messages[0].seen).toBe(false);
  });

  it("marks seen only through markRead, and can clear it again", async () => {
    expect(await mail.markRead("personal", messageId, true)).toBe(true);
    let after = await mail.listMessages("personal", { limit: 10 });
    expect(after.messages[0].seen).toBe(true);
    expect((await mail.getMessage("personal", messageId))?.seen).toBe(true);

    expect(await mail.markRead("personal", messageId, false)).toBe(true);
    after = await mail.listMessages("personal", { limit: 10 });
    expect(after.messages[0].seen).toBe(false);
  });

  it("reports false for an unknown message id", async () => {
    expect(await mail.markRead("personal", "no-such-id", true)).toBe(false);
  });
});

describe("MailService survives corrupted account credentials row (P0)", () => {
  it("does not crash start() on a bad account row and continues watching others", async () => {
    const store = new Store(randomBytes(32), ":memory:");
    const watched: string[] = [];
    const provider = new FixtureProvider();
    provider.watchMailbox = (account) => {
      watched.push(account.alias);
      return () => {};
    };
    const mail = new MailService(store, provider);

    await mail.connectAccount({
      alias: "good",
      email: "good@test.com",
      creds: { ...baseCreds, auth: { kind: "password", user: "good@test.com", pass: "ok" } },
    });
    store.db
      .prepare(
        `INSERT INTO accounts (
          id, alias, email, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, username, password_enc, auth_kind, created_at
        ) VALUES (
          'bad-id', 'corrupt', 'corrupt@test.com', 'imap.test', 993, 1,
          'smtp.test', 465, 1, 'corrupt@test.com', 'not-a-valid-encrypted-blob', 'password', ?
        )`,
      )
      .run(new Date().toISOString());

    expect(() => mail.start()).not.toThrow();
    expect(watched).toEqual(["good"]);
    mail.stop();
  });

  it("isolates decryption failure in listMessages('all')", async () => {
    const store = new Store(randomBytes(32), ":memory:");
    const provider = new FixtureProvider();
    const mail = new MailService(store, provider);

    const good = await mail.connectAccount({
      alias: "good",
      email: "good@test.com",
      creds: { ...baseCreds, auth: { kind: "password", user: "good@test.com", pass: "ok" } },
    });
    provider.seedAccount(good.id, "good@test.com", [
      { subject: "Good mail", from: "a@b.c", bodyText: "hi" },
    ]);
    store.db
      .prepare(
        `INSERT INTO accounts (
          id, alias, email, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, username, password_enc, auth_kind, created_at
        ) VALUES (
          'bad-id', 'corrupt', 'corrupt@test.com', 'imap.test', 993, 1,
          'smtp.test', 465, 1, 'corrupt@test.com', 'not-a-valid-encrypted-blob', 'password', ?
        )`,
      )
      .run(new Date().toISOString());

    const res = await mail.listMessages("all", { limit: 20 });
    expect(res.messages.map((m) => m.subject)).toEqual(["Good mail"]);
    expect(res.errors.map((e) => e.account)).toEqual(["corrupt"]);
  });
});

