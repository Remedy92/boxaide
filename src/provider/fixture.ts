import { randomBytes } from "node:crypto";
import type {
  AccountCredentials,
  ConnectionTestResult,
  ListMessagesOpts,
  MailMessage,
  MailMessageSummary,
  MailProvider,
  SearchMessagesOpts,
  SendMessageInput,
  SendResult,
} from "./types.js";

type Stored = MailMessage & { accountEmail: string };

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeId(accountId: string, uid: number): string {
  return `${accountId}:${uid}`;
}

/**
 * In-memory multi-mailbox provider for tests and fixture mode.
 * No network. Same interface as the IMAP provider.
 */
export class FixtureProvider implements MailProvider {
  private boxes = new Map<string, Stored[]>();
  private nextUid = new Map<string, number>();
  private sent: Array<SendMessageInput & { accountId: string; messageId: string }> =
    [];

  seedAccount(
    accountId: string,
    email: string,
    messages: Array<Partial<MailMessage> & { subject: string; from: string }>,
  ): void {
    const list: Stored[] = [];
    let uid = 1;
    for (const m of messages) {
      const id = makeId(accountId, uid);
      list.push({
        id,
        accountId,
        uid,
        messageId: m.messageId ?? `<seed-${uid}@fixture.local>`,
        folder: m.folder ?? "INBOX",
        from: m.from,
        to: m.to ?? email,
        subject: m.subject,
        date: m.date ?? nowIso(-uid * 3600_000),
        snippet: m.snippet ?? (m.bodyText ?? m.subject).slice(0, 120),
        seen: m.seen ?? false,
        hasAttachments: m.hasAttachments ?? false,
        bodyText: m.bodyText ?? `Body for: ${m.subject}`,
        bodyHtml: m.bodyHtml,
        accountEmail: email,
      });
      uid += 1;
    }
    this.boxes.set(accountId, list);
    this.nextUid.set(accountId, uid);
  }

  getSent() {
    return this.sent;
  }

  clear(): void {
    this.boxes.clear();
    this.nextUid.clear();
    this.sent = [];
  }

  async testConnection(
    creds: AccountCredentials,
  ): Promise<ConnectionTestResult> {
    if (!creds.username || !creds.password) {
      return { ok: false, error: "username and password required" };
    }
    if (creds.password === "bad") {
      return { ok: false, error: "authentication failed" };
    }
    return { ok: true };
  }

  private ensureBox(accountId: string, email: string): Stored[] {
    if (!this.boxes.has(accountId)) {
      this.seedAccount(accountId, email, [
        {
          subject: "Welcome to mailmux",
          from: "mailmux@local",
          bodyText: "Your fixture inbox is ready.",
          seen: false,
        },
      ]);
    }
    return this.boxes.get(accountId)!;
  }

  async listMessages(
    accountId: string,
    creds: AccountCredentials,
    opts: ListMessagesOpts = {},
  ): Promise<MailMessageSummary[]> {
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    let msgs = this.ensureBox(accountId, creds.username).filter(
      (m) => m.folder === folder,
    );
    if (opts.unreadOnly) msgs = msgs.filter((m) => !m.seen);
    msgs = [...msgs].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
    return msgs.slice(offset, offset + limit).map(toSummary);
  }

  async searchMessages(
    accountId: string,
    creds: AccountCredentials,
    opts: SearchMessagesOpts,
  ): Promise<MailMessageSummary[]> {
    const q = opts.query.toLowerCase();
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? 50;
    const msgs = this.ensureBox(accountId, creds.username)
      .filter((m) => m.folder === folder)
      .filter((m) => {
        const hay = `${m.subject} ${m.from} ${m.to} ${m.bodyText}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);
    return msgs.map(toSummary);
  }

  async getMessage(
    accountId: string,
    creds: AccountCredentials,
    messageId: string,
    _folder?: string,
  ): Promise<MailMessage | null> {
    const msgs = this.ensureBox(accountId, creds.username);
    const found =
      msgs.find((m) => m.id === messageId) ??
      msgs.find((m) => String(m.uid) === messageId);
    if (!found) return null;
    found.seen = true;
    const { accountEmail: _, ...msg } = found;
    return msg;
  }

  async sendMessage(
    accountId: string,
    creds: AccountCredentials,
    input: SendMessageInput,
  ): Promise<SendResult> {
    if (!input.to || !input.subject) {
      throw new Error("to and subject are required");
    }
    const messageId = `<${randomBytes(8).toString("hex")}@fixture.local>`;
    this.sent.push({ ...input, accountId, messageId });

    // Optional: drop a copy into Sent folder of the account
    const uid = this.nextUid.get(accountId) ?? 1;
    this.nextUid.set(accountId, uid + 1);
    const box = this.ensureBox(accountId, creds.username);
    box.push({
      id: makeId(accountId, uid),
      accountId,
      uid,
      messageId,
      folder: "Sent",
      from: creds.username,
      to: input.to,
      subject: input.subject,
      date: nowIso(),
      snippet: input.text.slice(0, 120),
      seen: true,
      hasAttachments: false,
      bodyText: input.text,
      bodyHtml: input.html,
      accountEmail: creds.username,
    });

    return {
      messageId,
      accepted: input.to.split(",").map((s) => s.trim()),
    };
  }
}

function toSummary(m: Stored): MailMessageSummary {
  return {
    id: m.id,
    accountId: m.accountId,
    uid: m.uid,
    messageId: m.messageId,
    folder: m.folder,
    from: m.from,
    to: m.to,
    subject: m.subject,
    date: m.date,
    snippet: m.snippet,
    seen: m.seen,
    hasAttachments: m.hasAttachments,
  };
}
