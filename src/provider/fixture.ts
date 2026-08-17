import { randomBytes } from "node:crypto";
import type {
  AccountCredentials,
  ConnectionTestResult,
  DraftInput,
  DraftRef,
  ListDraftsOpts,
  ListMessagesOpts,
  MailDraft,
  MailFolder,
  MailMessage,
  MailMessageSummary,
  MailProvider,
  ProviderAccount,
  MailboxSyncResult,
  SearchMessagesOpts,
  SendMessageInput,
  SendResult,
  SyncMailboxOpts,
} from "./types.js";

/** `inReplyTo` has no place on a delivered message; a draft needs to keep it. */
type Stored = MailMessage & { accountEmail: string; inReplyTo?: string };

/**
 * Drafts live in the same box as mail under this folder, mirroring IMAP: the
 * real provider APPENDs into a mailbox, so listMessages and listFolders see
 * them there too.
 */
const DRAFTS_FOLDER = "Drafts";

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeId(accountId: string, uid: number): string {
  return `${accountId}:${uid}`;
}

/** Mirrors the IMAP provider's since filter so the two agree in tests. */
function applySince<T extends { date: string }>(
  msgs: T[],
  since: string | undefined,
): T[] {
  if (!since) return msgs;
  const from = new Date(since);
  if (Number.isNaN(from.getTime())) return msgs;
  return msgs.filter((m) => new Date(m.date).getTime() >= from.getTime());
}

/**
 * In-memory multi-mailbox provider for tests and fixture mode.
 * No network. Same interface as the IMAP provider.
 */
export class FixtureProvider implements MailProvider {
  private boxes = new Map<string, Stored[]>();
  private nextUid = new Map<string, number>();
  private uidValidity = new Map<string, number>();
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
        // Carried through so a seeded iMIP part survives to getMessage. The
        // field only ever exists on a full read, which is exactly what a test
        // exercising the RSVP scanner needs to seed.
        calendar: m.calendar,
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
    this.uidValidity.clear();
    this.sent = [];
  }

  async testConnection(
    creds: AccountCredentials,
  ): Promise<ConnectionTestResult> {
    if (creds.auth.kind === "password") {
      if (!creds.auth.user || !creds.auth.pass) {
        return { ok: false, error: "username and password required" };
      }
      if (creds.auth.pass === "bad") {
        return { ok: false, error: "authentication failed" };
      }
      return { ok: true };
    }
    if (!creds.auth.user || !creds.auth.accessToken) {
      return { ok: false, error: "username and access token required" };
    }
    if (creds.auth.accessToken === "bad") {
      return { ok: false, error: "authentication failed" };
    }
    return { ok: true };
  }

  private ensureBox(accountId: string, email: string): Stored[] {
    if (!this.boxes.has(accountId)) {
      this.seedAccount(accountId, email, [
        {
          subject: "Welcome to Boxaide",
          from: "boxaide@local",
          bodyText: "Your fixture inbox is ready.",
          seen: false,
        },
      ]);
    }
    return this.boxes.get(accountId)!;
  }

  async listMessages(
    account: ProviderAccount,
    opts: ListMessagesOpts = {},
  ): Promise<MailMessageSummary[]> {
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    let msgs = this.ensureBox(account.id, account.email).filter(
      (m) => m.folder === folder,
    );
    if (opts.unreadOnly) msgs = msgs.filter((m) => !m.seen);
    // Before the slice, exactly as IMAP does it: the server selects by date
    // and `limit` only caps the result. Filtering after would reintroduce the
    // truncation bug the option exists to remove.
    msgs = applySince(msgs, opts.since);
    msgs = [...msgs].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
    return msgs.slice(offset, offset + limit).map(toSummary);
  }

  async syncMailbox(
    account: ProviderAccount,
    opts: SyncMailboxOpts = {},
  ): Promise<MailboxSyncResult> {
    const folder = opts.folder ?? "INBOX";
    const uidvalidity = this.uidValidity.get(account.id) ?? 1;
    const messages = await this.listMessages(account, {
      folder,
      limit: opts.limit,
      offset: opts.offset,
      since: opts.since,
    });
    const box = this.ensureBox(account.id, account.email).filter(
      (m) => m.folder === folder,
    );
    // A dated read only ever adds rows: it reaches past the newest window and
    // so cannot speak for what that window holds.
    const replaced =
      opts.since == null &&
      (opts.fullWindow === true ||
        !opts.cursor ||
        opts.cursor.uidvalidity !== uidvalidity);
    const currentUids = new Set(box.map((m) => m.uid));
    const vanishedUids =
      replaced || opts.since != null
        ? []
        : (opts.knownUids ?? []).filter((uid) => !currentUids.has(uid));
    return {
      replaced,
      messages,
      vanishedUids,
      flagUpdates: replaced
        ? []
        : messages.map((m) => ({ uid: m.uid, seen: m.seen })),
      cursor: {
        uidvalidity,
        highestModseq: String(this.nextUid.get(account.id) ?? 1),
        uidnext: this.nextUid.get(account.id) ?? 1,
        exists: box.length,
      },
      coveredSince: opts.since,
    };
  }

  /** Tests bump this to force a uidvalidity wipe. */
  setUidValidity(accountId: string, value: number): void {
    this.uidValidity.set(accountId, value);
  }

  async searchMessages(
    account: ProviderAccount,
    opts: SearchMessagesOpts,
  ): Promise<MailMessageSummary[]> {
    const q = opts.query.toLowerCase();
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? 50;
    const matched = this.ensureBox(account.id, account.email)
      .filter((m) => m.folder === folder)
      .filter((m) => {
        const hay = `${m.subject} ${m.from} ${m.to} ${m.bodyText}`.toLowerCase();
        return hay.includes(q);
      });
    const msgs = applySince(matched, opts.since)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);
    return msgs.map(toSummary);
  }

  async getMessage(
    account: ProviderAccount,
    messageId: string,
    _folder?: string,
  ): Promise<MailMessage | null> {
    const found = this.find(account, messageId);
    if (!found) return null;
    // Reading does NOT mark seen: the IMAP provider opens the mailbox
    // read-only. Marking read goes through markRead().
    const { accountEmail: _, ...msg } = found;
    return msg;
  }

  async sendMessage(
    account: ProviderAccount,
    input: SendMessageInput,
  ): Promise<SendResult> {
    if (!input.to || !input.subject) {
      throw new Error("to and subject are required");
    }
    const messageId = `<${randomBytes(8).toString("hex")}@fixture.local>`;
    this.sent.push({ ...input, accountId: account.id, messageId });

    // Optional: drop a copy into Sent folder of the account
    const uid = this.nextUid.get(account.id) ?? 1;
    this.nextUid.set(account.id, uid + 1);
    const box = this.ensureBox(account.id, account.email);
    box.push({
      id: makeId(account.id, uid),
      accountId: account.id,
      uid,
      messageId,
      folder: "Sent",
      from: account.email,
      to: input.to,
      subject: input.subject,
      date: nowIso(),
      snippet: input.text.slice(0, 120),
      seen: true,
      hasAttachments: false,
      bodyText: input.text,
      bodyHtml: input.html,
      accountEmail: account.email,
    });

    const copied = toSummary(box[box.length - 1]);
    return {
      messageId,
      accepted: input.to.split(",").map((s) => s.trim()),
      copied,
      sentFolder: "Sent",
    };
  }

  async markRead(
    account: ProviderAccount,
    messageId: string,
    seen: boolean,
  ): Promise<boolean> {
    const found = this.find(account, messageId);
    if (!found) return false;
    found.seen = seen;
    return true;
  }

  async listFolders(account: ProviderAccount): Promise<MailFolder[]> {
    const box = this.ensureBox(account.id, account.email);
    const names = new Set<string>(["INBOX"]);
    for (const m of box) names.add(m.folder);
    return [...names].map((name) => ({
      name,
      path: name,
      specialUse: specialUseOf(name),
    }));
  }

  async createDraft(
    account: ProviderAccount,
    input: DraftInput,
  ): Promise<DraftRef> {
    const box = this.ensureBox(account.id, account.email);
    const uid = this.nextUid.get(account.id) ?? 1;
    this.nextUid.set(account.id, uid + 1);
    const messageId = `<${randomBytes(8).toString("hex")}@fixture.local>`;
    const text = input.text ?? "";
    box.push({
      id: makeId(account.id, uid),
      accountId: account.id,
      uid,
      messageId,
      folder: DRAFTS_FOLDER,
      from: account.email,
      to: input.to ?? "",
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject ?? "(no subject)",
      date: nowIso(),
      snippet: text.slice(0, 140),
      // Your own unfinished mail is not unread mail — same call as the IMAP
      // provider, which appends \Draft together with \Seen.
      seen: true,
      hasAttachments: false,
      bodyText: text,
      bodyHtml: input.html,
      inReplyTo: input.inReplyTo,
      references: input.references,
      accountEmail: account.email,
    });
    return {
      id: makeId(account.id, uid),
      accountId: account.id,
      uid,
      folder: DRAFTS_FOLDER,
      messageId,
    };
  }

  async updateDraft(
    account: ProviderAccount,
    draftId: string,
    input: DraftInput,
  ): Promise<DraftRef> {
    const existing = this.findDraft(account, draftId);
    if (!existing) throw new Error(`draft not found: ${draftId}`);
    // Store the replacement first, then drop the old one: same order as the
    // IMAP provider, so the new id is what both surfaces hand back.
    const ref = await this.createDraft(account, input);
    await this.deleteDraft(account, draftId);
    return ref;
  }

  async listDrafts(
    account: ProviderAccount,
    opts: ListDraftsOpts = {},
  ): Promise<MailDraft[]> {
    const limit = opts.limit ?? 25;
    return this.ensureBox(account.id, account.email)
      .filter((m) => m.folder === DRAFTS_FOLDER)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit)
      .map(toDraft);
  }

  async deleteDraft(
    account: ProviderAccount,
    draftId: string,
  ): Promise<boolean> {
    const box = this.ensureBox(account.id, account.email);
    const found = this.findDraft(account, draftId);
    if (!found) return false;
    box.splice(box.indexOf(found), 1);
    return true;
  }

  private findDraft(
    account: ProviderAccount,
    draftId: string,
  ): Stored | undefined {
    const found = this.find(account, draftId);
    return found?.folder === DRAFTS_FOLDER ? found : undefined;
  }

  private find(account: ProviderAccount, messageId: string): Stored | undefined {
    const msgs = this.ensureBox(account.id, account.email);
    return (
      msgs.find((m) => m.id === messageId) ??
      msgs.find((m) => String(m.uid) === messageId)
    );
  }
}

function specialUseOf(name: string): string | undefined {
  if (name === "Sent") return "\\Sent";
  if (name === DRAFTS_FOLDER) return "\\Drafts";
  return undefined;
}

function toDraft(m: Stored): MailDraft {
  return {
    id: m.id,
    accountId: m.accountId,
    uid: m.uid,
    folder: m.folder,
    messageId: m.messageId ?? "",
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    date: m.date,
    snippet: m.snippet,
    bodyText: m.bodyText,
    bodyHtml: m.bodyHtml,
    inReplyTo: m.inReplyTo,
    references: m.references,
  };
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
