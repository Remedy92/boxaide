import { ImapFlow } from "imapflow";
import type { MessageStructureObject } from "imapflow";
import nodemailer from "nodemailer";
import type { SendMailOptions } from "nodemailer";
import { parseRfc822, formatAddress, stripHtml } from "./mime.js";
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
  SearchMessagesOpts,
  SendMessageInput,
  SendResult,
} from "./types.js";

/** Idle time before a pooled IMAP connection is logged out. */
const IDLE_MS = 60_000;
/** Guards against a hung server holding a request open forever. */
const CONNECT_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 60_000;
/** Bytes of a body part fetched per message to build a list snippet. */
const SNIPPET_BYTES = 1024;
/** Drafts read per listDrafts call. Each one costs a full source fetch. */
const DRAFT_LIST_LIMIT = 25;

function makeId(accountId: string, folder: string, uid: number): string {
  return `${accountId}:${encodeURIComponent(folder)}:${uid}`;
}

/** Exported for tests: the inverse of makeId, tolerant of a bare uid. */
export function parseId(
  messageId: string,
  accountId: string,
): { folder: string; uid: number } | null {
  // format: accountId:folder:uid
  const prefix = `${accountId}:`;
  if (!messageId.startsWith(prefix)) {
    // bare uid
    const uid = Number(messageId);
    if (Number.isFinite(uid)) return { folder: "INBOX", uid };
    return null;
  }
  const rest = messageId.slice(prefix.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return null;
  const folder = decodeURIComponent(rest.slice(0, lastColon));
  const uid = Number(rest.slice(lastColon + 1));
  if (!Number.isFinite(uid)) return null;
  return { folder, uid };
}

/** Envelope address -> display string. Empty when absent. */
function addr(value: unknown): string {
  return formatAddress(value) ?? "";
}

// ---------------------------------------------------------------------------
// Connection pool
//
// One authenticated ImapFlow client per account, reused across calls and
// logged out after IDLE_MS of inactivity. Without this every operation paid a
// full TCP + TLS + LOGIN, which a debounced search turns into a login storm
// that Gmail throttles.
// ---------------------------------------------------------------------------

type Pooled = {
  client: ImapFlow;
  timer: ReturnType<typeof setTimeout> | null;
  busy: number;
};

const pool = new Map<string, Pooled>();
const connecting = new Map<string, Promise<Pooled>>();

/** ImapFlow auth object for password or XOAUTH2. */
export function imapAuthOptions(
  creds: AccountCredentials,
): { user: string; pass: string } | { user: string; accessToken: string } {
  if (creds.auth.kind === "xoauth2") {
    return { user: creds.auth.user, accessToken: creds.auth.accessToken };
  }
  return { user: creds.auth.user, pass: creds.auth.pass };
}

/** Nodemailer auth object for password or XOAUTH2. */
export function smtpAuthOptions(
  creds: AccountCredentials,
):
  | { user: string; pass: string }
  | { type: "OAuth2"; user: string; accessToken: string } {
  if (creds.auth.kind === "xoauth2") {
    return {
      type: "OAuth2",
      user: creds.auth.user,
      accessToken: creds.auth.accessToken,
    };
  }
  return { user: creds.auth.user, pass: creds.auth.pass };
}

function newClient(creds: AccountCredentials): ImapFlow {
  return new ImapFlow({
    host: creds.imapHost,
    port: creds.imapPort,
    secure: creds.imapSecure,
    auth: imapAuthOptions(creds),
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
}

function clearIdle(entry: Pooled): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function scheduleIdle(key: string, entry: Pooled): void {
  clearIdle(entry);
  if (entry.busy > 0 || pool.get(key) !== entry) return;
  entry.timer = setTimeout(() => {
    if (entry.busy > 0 || pool.get(key) !== entry) return;
    pool.delete(key);
    entry.client.logout().catch(() => entry.client.close());
  }, IDLE_MS);
  entry.timer.unref?.();
}

function drop(key: string, entry: Pooled): void {
  clearIdle(entry);
  if (pool.get(key) === entry) pool.delete(key);
  try {
    entry.client.close();
  } catch {
    // already gone
  }
}

async function acquire(
  key: string,
  creds: AccountCredentials,
): Promise<Pooled> {
  const existing = pool.get(key);
  if (existing) {
    if (existing.client.usable) return existing;
    drop(key, existing);
  }
  const inFlight = connecting.get(key);
  // Concurrent callers share one connect instead of opening a second session.
  if (inFlight) return inFlight;
  const started = (async () => {
    const client = newClient(creds);
    // Attach before connect: a timeout during handshake must not crash Node.
    client.on("error", () => {
      /* surfaced on the awaited command; keeps the process alive */
    });
    await client.connect();
    const entry: Pooled = { client, timer: null, busy: 0 };
    client.on("close", () => {
      if (pool.get(key) === entry) pool.delete(key);
      clearIdle(entry);
    });
    pool.set(key, entry);
    return entry;
  })().finally(() => {
    connecting.delete(key);
  });
  connecting.set(key, started);
  return started;
}

/** Run against the pooled client for `key`, reconnecting once if it dropped. */
async function withImap<T>(
  key: string,
  creds: AccountCredentials,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const entry = await acquire(key, creds);
    entry.busy += 1;
    clearIdle(entry);
    try {
      return await fn(entry.client);
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && !entry.client.usable) {
        drop(key, entry);
        continue;
      }
      throw err;
    } finally {
      entry.busy -= 1;
      scheduleIdle(key, entry);
    }
  }
  throw lastErr;
}

/**
 * Human-readable IMAP error. ImapFlow often surfaces a bare "Command failed"
 * while the useful text sits on responseText / authenticationFailed.
 */
export function imapErrorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & {
    responseText?: string;
    authenticationFailed?: boolean;
    code?: string;
    serverResponseCode?: string;
  };
  const parts: string[] = [];
  if (e.authenticationFailed || e.code === "EAUTH") {
    parts.push("authentication failed");
  }
  if (e.responseText && e.responseText !== e.message) {
    parts.push(e.responseText);
  }
  if (e.message && e.message !== "Command failed") {
    parts.push(e.message);
  } else if (e.message === "Command failed" && parts.length === 0) {
    parts.push("IMAP command failed (check host, username, and app password)");
  }
  if (e.code && !parts.some((p) => p.includes(e.code!))) {
    parts.push(e.code);
  }
  return parts.join(": ") || e.message || "IMAP error";
}

/** One-shot connection for calls made before an account exists. */
async function withTempImap<T>(
  creds: AccountCredentials,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = newClient(creds);
  // Same as pooled clients: a late socket timeout must not kill the process.
  let lateError: Error | null = null;
  client.on("error", (err: Error) => {
    lateError = err;
  });
  try {
    await client.connect();
    if (lateError) throw lateError;
    return await fn(client);
  } catch (err) {
    throw new Error(imapErrorText(err), { cause: err });
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        // already gone
      }
    }
  }
}

/** Close every pooled connection. Call on shutdown. */
export async function closeAll(): Promise<void> {
  const entries = [...pool.entries()];
  pool.clear();
  connecting.clear();
  await Promise.all(
    entries.map(async ([, entry]) => {
      clearIdle(entry);
      try {
        await entry.client.logout();
      } catch {
        entry.client.close();
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Body structure helpers
// ---------------------------------------------------------------------------

type StructureNode = {
  part?: string;
  type?: string;
  encoding?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  childNodes?: unknown[];
};

function asNodes(children: unknown): StructureNode[] {
  return Array.isArray(children) ? (children as StructureNode[]) : [];
}

/**
 * True only for real attachments. A plain text+html message has two child
 * nodes and no attachment, so child count alone is meaningless.
 */
function structureHasAttachments(node: StructureNode | undefined): boolean {
  if (!node) return false;
  const disposition = node.disposition?.toLowerCase();
  if (disposition === "attachment") return true;
  const filename =
    node.dispositionParameters?.filename ?? node.parameters?.name;
  if (disposition === "inline" && filename) return true;
  return asNodes(node.childNodes).some((child) =>
    structureHasAttachments(child),
  );
}

/** First displayable text part — text/plain wins, text/html is the fallback. */
function pickTextPart(node: StructureNode | undefined): StructureNode | null {
  if (!node) return null;
  const children = asNodes(node.childNodes);
  if (children.length === 0) {
    const type = node.type?.toLowerCase() ?? "";
    if (!type.startsWith("text/")) return null;
    if (node.disposition?.toLowerCase() === "attachment") return null;
    return node;
  }
  let html: StructureNode | null = null;
  for (const child of children) {
    const found = pickTextPart(child);
    if (!found) continue;
    if ((found.type?.toLowerCase() ?? "") === "text/plain") return found;
    html = html ?? found;
  }
  return html;
}

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=(?:\r\n|\n|\r)/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function bufferEncoding(charset?: string): BufferEncoding {
  const cs = charset?.toLowerCase() ?? "";
  if (cs === "iso-8859-1" || cs === "latin1" || cs === "windows-1252") {
    return "latin1";
  }
  if (cs === "us-ascii" || cs === "ascii") return "ascii";
  return "utf8";
}


/** Decode a truncated body part into a one-line preview. */
function previewFromPart(
  part: StructureNode,
  raw: Buffer,
  alreadyDecoded: boolean,
): string {
  const charset = bufferEncoding(part.parameters?.charset);
  const encoding = part.encoding?.toLowerCase();
  let text: string;
  if (alreadyDecoded || !encoding || encoding === "7bit" || encoding === "8bit"
    || encoding === "binary") {
    text = raw.toString(charset);
  } else if (encoding === "base64") {
    // Truncated base64: drop the trailing partial quantum.
    const clean = raw.toString("ascii").replace(/[^A-Za-z0-9+/=]/g, "");
    const usable = clean.slice(0, clean.length - (clean.length % 4));
    text = Buffer.from(usable, "base64").toString(charset);
  } else if (encoding === "quoted-printable") {
    text = decodeQuotedPrintable(raw.toString("ascii"));
  } else {
    text = raw.toString(charset);
  }
  if ((part.type?.toLowerCase() ?? "") === "text/html") text = stripHtml(text);
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

function lookupPart(
  parts: Map<string, Buffer> | undefined,
  key: string,
): Buffer | undefined {
  if (!parts) return undefined;
  return (
    parts.get(key) ?? parts.get(key.toLowerCase()) ?? parts.get(key.toUpperCase())
  );
}

function partKey(part: StructureNode): string {
  // A single-part message has no part number; BODY[1] is its text.
  return part.part && part.part.length > 0 ? part.part : "1";
}

function envelopeToSummary(
  accountId: string,
  folder: string,
  source: {
    uid: number;
    envelope?: {
      messageId?: string;
      from?: unknown;
      to?: unknown;
      subject?: string;
      date?: Date | string;
    };
    flags?: Set<string>;
    bodyStructure?: { childNodes?: unknown[]; disposition?: string };
    source?: Buffer;
  },
  snippetOverride?: string,
): MailMessageSummary {
  const env = source.envelope ?? {};
  const subject = env.subject ?? "(no subject)";
  const snippet =
    snippetOverride ||
    source.source?.toString("utf8").replace(/\s+/g, " ").slice(0, 140) ||
    subject;
  return {
    id: makeId(accountId, folder, source.uid),
    accountId,
    uid: source.uid,
    messageId: env.messageId,
    folder,
    from: addr(env.from),
    to: addr(env.to),
    subject,
    date: env.date
      ? new Date(env.date).toISOString()
      : new Date().toISOString(),
    snippet,
    seen: source.flags?.has("\\Seen") ?? false,
    hasAttachments: structureHasAttachments(
      source.bodyStructure as StructureNode | undefined,
    ),
  };
}

type FetchedHead = {
  uid: number;
  envelope?: {
    messageId?: string;
    from?: unknown;
    to?: unknown;
    subject?: string;
    date?: Date | string;
  };
  flags?: Set<string>;
  bodyStructure?: MessageStructureObject;
};

/**
 * Second, bounded pass: fetch only the leading bytes of each message's text
 * part so the list view shows a real snippet instead of the subject again.
 */
async function attachSnippets(
  client: ImapFlow,
  heads: FetchedHead[],
): Promise<Map<number, string>> {
  const snippets = new Map<number, string>();
  const wanted = new Map<number, StructureNode>();
  const keys = new Set<string>();
  for (const head of heads) {
    const part = pickTextPart(head.bodyStructure as StructureNode | undefined);
    if (!part) continue;
    wanted.set(head.uid, part);
    keys.add(partKey(part));
  }
  if (wanted.size === 0) return snippets;
  const uids = [...wanted.keys()];
  for await (const msg of client.fetch(
    uids,
    {
      uid: true,
      bodyParts: [...keys].map((key) => ({ key, maxLength: SNIPPET_BYTES })),
    },
    { uid: true },
  )) {
    const part = wanted.get(msg.uid);
    if (!part) continue;
    const key = partKey(part);
    const raw = lookupPart(msg.bodyParts, key);
    if (!raw || raw.length === 0) continue;
    const text = previewFromPart(part, raw, msg.binaryParts?.has(key) ?? false);
    if (text) snippets.set(msg.uid, text);
  }
  return snippets;
}

/**
 * Sequence-number window for the newest `limit` messages, skipping `offset`
 * newer ones. Null when the window holds nothing — an empty mailbox, or an
 * offset that has already walked past the oldest message.
 */
export function uidWindow(
  exists: number,
  limit: number,
  offset = 0,
): { start: number; end: number } | null {
  if (exists <= 0 || limit <= 0) return null;
  const end = exists - Math.max(0, offset);
  if (end < 1) return null;
  const start = Math.max(1, end - limit + 1);
  return { start, end };
}

function sentMailboxPath(
  boxes: { name: string; path: string; specialUse?: string }[],
): string | null {
  const special = boxes.find((b) => b.specialUse === "\\Sent");
  if (special) return special.path;
  const byName = boxes.find((b) =>
    /^(sent|sent items|sent mail|sent messages|gesendet|envoy(é|e)s?)$/i.test(
      b.name,
    ),
  );
  return byName?.path ?? null;
}

/**
 * SPECIAL-USE \Drafts first; a server that does not advertise it falls back to
 * the common names. Exported for tests: picking the wrong mailbox here writes a
 * draft somewhere the user's own client will never show it.
 */
export function draftsMailboxPath(
  boxes: { name: string; path: string; specialUse?: string }[],
): string | null {
  const special = boxes.find((b) => b.specialUse === "\\Drafts");
  if (special) return special.path;
  const byPath = boxes.find((b) => /^\[gmail\]\/drafts$/i.test(b.path));
  if (byPath) return byPath.path;
  const byName = boxes.find((b) =>
    /^(drafts|draft|entw(ü|u)rfe|brouillons|borradores)$/i.test(b.name),
  );
  return byName?.path ?? null;
}

/**
 * Compose to raw RFC822 bytes without sending anything. Both IMAP write paths
 * go through it: sendMessage APPENDs to Sent the exact bytes it handed to
 * SMTP, and the draft path APPENDs bytes that are never delivered at all.
 */
async function composeMime(mail: SendMailOptions) {
  const composed = await nodemailer
    .createTransport({ streamTransport: true, buffer: true, newline: "\r\n" })
    .sendMail(mail);
  const raw = Buffer.isBuffer(composed.message)
    ? composed.message
    : Buffer.from(String(composed.message));
  return { raw, envelope: composed.envelope, messageId: composed.messageId };
}

/** A draft carries the account's own address as From, exactly like a send. */
function draftMailOptions(
  account: ProviderAccount,
  input: DraftInput,
): SendMailOptions {
  return {
    from: account.email,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    // Never undefined: a message with no body part at all is not a message.
    text: input.text ?? "",
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
  };
}

/**
 * UIDPLUS hands the new uid straight back from APPEND. Without that extension
 * the only way to name what was just written is to search for its Message-ID.
 */
async function appendedDraftUid(
  client: ImapFlow,
  path: string,
  messageId: string,
): Promise<number | null> {
  if (!messageId) return null;
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const uids = await client.search(
      { header: { "message-id": messageId } },
      { uid: true },
    );
    if (!uids || uids.length === 0) return null;
    return uids[uids.length - 1];
  } finally {
    lock.release();
  }
}

export class ImapSmtpProvider implements MailProvider {
  async testConnection(
    creds: AccountCredentials,
  ): Promise<ConnectionTestResult> {
    try {
      await withTempImap(creds, async (client) => {
        await client.mailboxOpen("INBOX", { readOnly: true });
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: imapErrorText(err),
      };
    }
  }

  async listMessages(
    account: ProviderAccount,
    opts: ListMessagesOpts = {},
  ): Promise<MailMessageSummary[]> {
    const accountId = account.id;
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? 50;
    return withImap(accountId, account.creds, async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const mb = client.mailbox;
        if (!mb) return [];
        const window = uidWindow(mb.exists, limit, opts.offset ?? 0);
        if (!window) return [];
        const range = `${window.start}:${window.end}`;
        const heads: FetchedHead[] = [];
        for await (const msg of client.fetch(range, {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
        })) {
          if (opts.unreadOnly && msg.flags?.has("\\Seen")) continue;
          heads.push(msg);
        }
        const snippets = await attachSnippets(client, heads);
        return heads
          .map((msg) =>
            envelopeToSummary(accountId, folder, msg, snippets.get(msg.uid)),
          )
          .reverse();
      } finally {
        lock.release();
      }
    });
  }

  async searchMessages(
    account: ProviderAccount,
    opts: SearchMessagesOpts,
  ): Promise<MailMessageSummary[]> {
    const accountId = account.id;
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? 50;
    return withImap(accountId, account.creds, async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        // IMAP TEXT search — provider-dependent quality
        const uids = await client.search({ text: opts.query }, { uid: true });
        if (!uids || uids.length === 0) return [];
        const slice = uids.slice(-limit);
        const heads: FetchedHead[] = [];
        for await (const msg of client.fetch(
          slice,
          {
            uid: true,
            envelope: true,
            flags: true,
            bodyStructure: true,
          },
          { uid: true },
        )) {
          heads.push(msg);
        }
        const snippets = await attachSnippets(client, heads);
        return heads
          .map((msg) =>
            envelopeToSummary(accountId, folder, msg, snippets.get(msg.uid)),
          )
          .reverse();
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(
    account: ProviderAccount,
    messageId: string,
    folderHint?: string,
  ): Promise<MailMessage | null> {
    const accountId = account.id;
    const parsed = parseId(messageId, accountId);
    const folder = parsed?.folder ?? folderHint ?? "INBOX";
    const uid = parsed?.uid;
    if (uid == null) return null;

    return withImap(accountId, account.creds, async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        let found: MailMessage | null = null;
        for await (const msg of client.fetch(
          String(uid),
          {
            uid: true,
            envelope: true,
            flags: true,
            bodyStructure: true,
            source: true,
          },
          { uid: true },
        )) {
          found = await messageFromImapSource(
            accountId,
            folder,
            msg.uid,
            msg.source ?? Buffer.from(""),
            msg,
          );
        }
        return found;
      } finally {
        lock.release();
      }
    });
  }

  async sendMessage(
    account: ProviderAccount,
    input: SendMessageInput,
  ): Promise<SendResult> {
    const creds = account.creds;
    const mail = {
      // The login name and the mailbox address differ on Fastmail and custom
      // domains, so the account's own address is the only correct From.
      from: account.email,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      inReplyTo: input.inReplyTo,
      references: input.references,
    };

    // Compose once so the bytes that go over SMTP are the exact bytes we
    // APPEND to Sent.
    const composed = await composeMime(mail);
    const raw = composed.raw;

    const transport = nodemailer.createTransport({
      host: creds.smtpHost,
      port: creds.smtpPort,
      secure: creds.smtpSecure,
      auth: smtpAuthOptions(creds),
    });
    const info = await transport.sendMail({
      envelope: composed.envelope,
      raw,
    });

    // Gmail copies SMTP sends into Sent by itself; Fastmail and generic IMAP
    // do not. A failed copy must never fail a delivered message.
    await this.appendToSent(account, raw).catch((err: unknown) => {
      console.warn(
        `[imap] Sent copy failed for ${account.email}:`,
        err instanceof Error ? err.message : String(err),
      );
    });

    return {
      messageId: info.messageId ?? composed.messageId ?? "",
      accepted: (info.accepted ?? []).map(String),
    };
  }

  private async appendToSent(
    account: ProviderAccount,
    raw: Buffer,
  ): Promise<void> {
    await withImap(account.id, account.creds, async (client) => {
      const boxes = await client.list();
      const path = sentMailboxPath(boxes);
      if (!path) throw new Error("no Sent mailbox found");
      await client.append(path, raw, ["\\Seen"], new Date());
    });
  }

  async markRead(
    account: ProviderAccount,
    messageId: string,
    seen: boolean,
  ): Promise<boolean> {
    const parsed = parseId(messageId, account.id);
    if (!parsed) return false;
    return withImap(account.id, account.creds, async (client) => {
      // Writable lock: flag changes need a read-write mailbox.
      const lock = await client.getMailboxLock(parsed.folder);
      try {
        const uid = String(parsed.uid);
        return seen
          ? await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true })
          : await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  async listFolders(account: ProviderAccount): Promise<MailFolder[]> {
    return withImap(account.id, account.creds, async (client) => {
      const boxes = await client.list();
      return boxes.map((b) => ({
        name: b.name,
        path: b.path,
        specialUse: b.specialUse,
      }));
    });
  }

  async createDraft(
    account: ProviderAccount,
    input: DraftInput,
  ): Promise<DraftRef> {
    const composed = await composeMime(draftMailOptions(account, input));
    return this.appendDraft(account, composed.raw, composed.messageId ?? "");
  }

  async updateDraft(
    account: ProviderAccount,
    draftId: string,
    input: DraftInput,
  ): Promise<DraftRef> {
    const target = parseId(draftId, account.id);
    if (!target) throw new Error(`invalid draft id: ${draftId}`);
    const composed = await composeMime(draftMailOptions(account, input));
    // Append the new copy before removing the old one. A failure between the
    // two leaves a duplicate, which the user can delete; the other order loses
    // what they wrote.
    const ref = await this.appendDraft(
      account,
      composed.raw,
      composed.messageId ?? "",
    );
    await this.removeDraft(account, target).catch((err: unknown) => {
      console.warn(
        `[imap] stale draft ${draftId} left behind for ${account.email}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
    return ref;
  }

  async listDrafts(
    account: ProviderAccount,
    opts: ListDraftsOpts = {},
  ): Promise<MailDraft[]> {
    const limit = opts.limit ?? DRAFT_LIST_LIMIT;
    return withImap(account.id, account.creds, async (client) => {
      const path = draftsMailboxPath(await client.list());
      if (!path) return [];
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const mb = client.mailbox;
        if (!mb) return [];
        const window = uidWindow(mb.exists, limit);
        if (!window) return [];
        const drafts: MailDraft[] = [];
        for await (const msg of client.fetch(`${window.start}:${window.end}`, {
          uid: true,
          envelope: true,
          source: true,
        })) {
          drafts.push(
            await draftFromImapSource(
              account.id,
              path,
              msg.uid,
              msg.source ?? Buffer.from(""),
              msg,
            ),
          );
        }
        return drafts.reverse();
      } finally {
        lock.release();
      }
    });
  }

  async deleteDraft(
    account: ProviderAccount,
    draftId: string,
  ): Promise<boolean> {
    const target = parseId(draftId, account.id);
    if (!target) return false;
    return this.removeDraft(account, target);
  }

  private async appendDraft(
    account: ProviderAccount,
    raw: Buffer,
    messageId: string,
  ): Promise<DraftRef> {
    return withImap(account.id, account.creds, async (client) => {
      const path = draftsMailboxPath(await client.list());
      if (!path) throw new Error("no Drafts mailbox found");
      // \Seen alongside \Draft: your own unfinished mail is not unread mail.
      const res = await client.append(
        path,
        raw,
        ["\\Draft", "\\Seen"],
        new Date(),
      );
      if (!res) throw new Error("Drafts APPEND was rejected by the server");
      const uid = res.uid ?? (await appendedDraftUid(client, path, messageId));
      if (uid == null) {
        throw new Error("draft was stored but its uid could not be resolved");
      }
      return {
        id: makeId(account.id, path, uid),
        accountId: account.id,
        uid,
        folder: path,
        messageId,
      };
    });
  }

  private async removeDraft(
    account: ProviderAccount,
    target: { folder: string; uid: number },
  ): Promise<boolean> {
    return withImap(account.id, account.creds, async (client) => {
      // The folder is re-checked against the Drafts mailbox on purpose.
      // parseId resolves a bare uid to INBOX, so without this a malformed
      // draft id would delete delivered mail — which is exactly what the
      // draft tools promise never to touch.
      const path = draftsMailboxPath(await client.list());
      if (!path) throw new Error("no Drafts mailbox found");
      if (target.folder !== path) {
        throw new Error(
          `refusing to delete outside the Drafts mailbox: ${target.folder}`,
        );
      }
      // Writable lock: a delete needs a read-write mailbox.
      const lock = await client.getMailboxLock(path);
      try {
        return await client.messageDelete(String(target.uid), { uid: true });
      } finally {
        lock.release();
      }
    });
  }
}

/**
 * Build a MailDraft from raw RFC822 (the body path listDrafts uses).
 * Exported so tests exercise the real decode path without a live IMAP server.
 */
export async function draftFromImapSource(
  accountId: string,
  folder: string,
  uid: number,
  source: Buffer | string,
  envelopeSource?: {
    envelope?: {
      messageId?: string;
      to?: unknown;
      cc?: unknown;
      subject?: string;
      date?: Date | string;
    };
  },
): Promise<MailDraft> {
  const body = await parseRfc822(source);
  const env = envelopeSource?.envelope ?? {};
  return {
    id: makeId(accountId, folder, uid),
    accountId,
    uid,
    folder,
    messageId: env.messageId ?? body.messageId ?? "",
    to: addr(env.to) || body.to || "",
    cc: addr(env.cc) || body.cc || undefined,
    // Bcc survives only in the stored copy; no envelope carries it.
    bcc: body.bcc,
    subject: env.subject || body.subject || "(no subject)",
    date: env.date
      ? new Date(env.date).toISOString()
      : (body.date ?? new Date().toISOString()),
    snippet: body.bodyText.slice(0, 140),
    bodyText: body.bodyText,
    bodyHtml: body.bodyHtml,
    inReplyTo: body.inReplyTo,
    references: body.references,
  };
}

/**
 * Build a MailMessage from raw RFC822 (the body path getMessage uses).
 * Exported so tests exercise the real decode path without a live IMAP server.
 */
export async function messageFromImapSource(
  accountId: string,
  folder: string,
  uid: number,
  source: Buffer | string,
  envelopeSource?: {
    envelope?: {
      messageId?: string;
      from?: unknown;
      to?: unknown;
      subject?: string;
      date?: Date | string;
    };
    flags?: Set<string>;
    bodyStructure?: { childNodes?: unknown[]; disposition?: string };
    source?: Buffer;
  },
): Promise<MailMessage> {
  const summary = envelopeSource
    ? envelopeToSummary(accountId, folder, {
        uid,
        envelope: envelopeSource.envelope,
        flags: envelopeSource.flags,
        bodyStructure: envelopeSource.bodyStructure,
        source:
          typeof source === "string" ? Buffer.from(source) : source,
      })
    : {
        id: makeId(accountId, folder, uid),
        accountId,
        uid,
        folder,
        from: "",
        to: "",
        subject: "(no subject)",
        date: new Date().toISOString(),
        snippet: "",
        seen: false,
        hasAttachments: false,
      };

  const body = await parseRfc822(source);
  const envelopeCc =
    envelopeSource &&
    envelopeSource.envelope &&
    "cc" in envelopeSource.envelope
      ? addr((envelopeSource.envelope as { cc?: unknown }).cc)
      : "";
  const preferEnvelopeSubject =
    summary.subject && summary.subject !== "(no subject)";
  return {
    ...summary,
    bodyText: body.bodyText,
    bodyHtml: body.bodyHtml,
    cc: body.cc || envelopeCc || undefined,
    from: summary.from || body.from || "",
    to: summary.to || body.to || "",
    subject: preferEnvelopeSubject
      ? summary.subject
      : body.subject || summary.subject || "(no subject)",
    messageId: summary.messageId || body.messageId,
    date: summary.date || body.date || new Date().toISOString(),
    snippet: body.bodyText.slice(0, 140) || summary.snippet,
    references: body.references,
  };
}
