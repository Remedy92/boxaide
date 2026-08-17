import { ImapFlow } from "imapflow";
import type { ExpungeEvent, MessageStructureObject } from "imapflow";
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
  MailboxCursor,
  MailboxSyncResult,
  ProviderAccount,
  SearchMessagesOpts,
  SendMessageInput,
  SendResult,
  SyncMailboxOpts,
} from "./types.js";

/** Idle time before a pooled IMAP connection is logged out. */
const IDLE_MS = 60_000;
/** Live mailbox watches. One dedicated connection each, outside the pool. */
const watchers = new Map<
  string,
  {
    client: ImapFlow;
    onExists: () => void;
    onFlags: () => void;
    onClose: () => void;
  }
>();
/** Reconnect backoff for a dropped watch, so an offline server is not hammered. */
const WATCH_RETRY_MIN_MS = 5_000;
const WATCH_RETRY_MAX_MS = 5 * 60_000;
/** Guards against a hung server holding a request open forever. */
const CONNECT_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 60_000;
/**
 * Ceiling on messages one incremental sync will read. A mark-all-read on a
 * large mailbox reports every message as changed; past this it is cheaper —
 * and bounded — to refill the window instead.
 */
const SYNC_FETCH_CAP = 1000;
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
    qresync: true,
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

/** Close every connection, pooled and watching. Call on shutdown. */
export async function closeAll(): Promise<void> {
  // Watch connections live outside the pool, so clearing the map is not
  // enough — each one holds an open socket that would outlive the process.
  const watching = [...watchers.values()];
  watchers.clear();
  const entries = [...pool.entries()];
  pool.clear();
  connecting.clear();
  await Promise.all([
    ...entries.map(async ([, entry]) => {
      clearIdle(entry);
      try {
        await entry.client.logout();
      } catch {
        entry.client.close();
      }
    }),
    ...watching.map(async (watch) => {
      try {
        await watch.client.logout();
      } catch {
        watch.client.close();
      }
    }),
  ]);
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
    internalDate?: Date | string;
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
    "";
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
    internalDate: source.internalDate
      ? new Date(source.internalDate).toISOString()
      : undefined,
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
  /** Server receive time. Only fetched on a since-filtered read. */
  internalDate?: Date | string;
  flags?: Set<string>;
  bodyStructure?: MessageStructureObject;
};

/** Rejects blanks and unparseable input rather than filtering on NaN. */
export function parseSince(since: string | undefined): Date | null {
  if (!since) return null;
  const at = new Date(since);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The precise half of the since filter. SINCE is day-granular, so a request
 * for "since 17:00 yesterday" comes back holding all of yesterday; this drops
 * the part of that day the caller did not ask for.
 *
 * Receive time wins over the Date header: the header is written by the sender
 * and a wrong clock on their side would otherwise hide a message that really
 * did arrive inside the window.
 */
export function withinSince(head: FetchedHead, since: Date): boolean {
  const stamp = head.internalDate ?? head.envelope?.date;
  if (!stamp) return true;
  const at = new Date(stamp);
  return Number.isNaN(at.getTime()) ? true : at.getTime() >= since.getTime();
}

/**
 * Second, bounded pass: fetch only the leading bytes of each message's text
 * part so the list view shows a real snippet instead of the subject again.
 *
 * One FETCH per distinct part key, never the union of keys over every uid:
 * Gmail answers a UID FETCH that names a body part any listed message lacks
 * with "NO Some messages could not be FETCHed" for the WHOLE command, so one
 * multipart message in the window used to kill the entire inbox load. Each
 * group asks a uid only for the part its own BODYSTRUCTURE advertised, and a
 * group that still fails is dropped alone — snippets are decoration, and
 * decoration must never take the list down with it.
 */
async function attachSnippets(
  client: ImapFlow,
  heads: FetchedHead[],
): Promise<Map<number, string>> {
  const snippets = new Map<number, string>();
  const wanted = new Map<number, StructureNode>();
  const groups = new Map<string, number[]>();
  for (const head of heads) {
    const part = pickTextPart(head.bodyStructure as StructureNode | undefined);
    if (!part) continue;
    wanted.set(head.uid, part);
    const key = partKey(part);
    const uids = groups.get(key);
    if (uids) uids.push(head.uid);
    else groups.set(key, [head.uid]);
  }
  for (const [key, uids] of groups) {
    try {
      for await (const msg of client.fetch(
        uids,
        { uid: true, bodyParts: [{ key, maxLength: SNIPPET_BYTES }] },
        { uid: true },
      )) {
        const part = wanted.get(msg.uid);
        if (!part) continue;
        const raw = lookupPart(msg.bodyParts, key);
        if (!raw || raw.length === 0) continue;
        const text = previewFromPart(
          part,
          raw,
          msg.binaryParts?.has(key) ?? false,
        );
        if (text) snippets.set(msg.uid, text);
      }
    } catch (err) {
      console.warn(
        `snippet fetch failed for part ${key} (${uids.length} messages): ${imapErrorText(err)}`,
      );
    }
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

/**
 * Span of the UIDs already indexed. Asking the server about that range keeps
 * the command one pair of numbers long however many messages are held.
 */
export function indexedUidRange(
  uids: number[] | undefined,
): { lowest: number; highest: number } | null {
  if (!uids || uids.length === 0) return null;
  let lowest = uids[0];
  let highest = uids[0];
  for (const uid of uids) {
    if (uid < lowest) lowest = uid;
    if (uid > highest) highest = uid;
  }
  return { lowest, highest };
}

/** True when the stored uidvalidity cannot be used for CHANGEDSINCE. */
export function mailboxNeedsFullResync(
  stored: { uidvalidity: number } | null | undefined,
  uidvalidity: number,
): boolean {
  if (!stored) return true;
  return stored.uidvalidity !== uidvalidity;
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

function cursorFromMailbox(mb: {
  exists: number;
  uidValidity?: bigint | number;
  uidNext?: number;
  highestModseq?: bigint;
}): MailboxCursor {
  return {
    uidvalidity: Number(mb.uidValidity ?? 0),
    highestModseq:
      mb.highestModseq != null ? String(mb.highestModseq) : null,
    uidnext: mb.uidNext ?? null,
    exists: mb.exists,
  };
}

/** With `cap`, returns null when the mailbox has more to give than that. */
async function collectHeads(
  client: ImapFlow,
  range: string | number[],
  extra: {
    uid?: boolean;
    changedSince?: bigint;
    internalDate?: boolean;
    cap: number;
  },
): Promise<FetchedHead[] | null>;
async function collectHeads(
  client: ImapFlow,
  range: string | number[],
  extra?: { uid?: boolean; changedSince?: bigint; internalDate?: boolean },
): Promise<FetchedHead[]>;
async function collectHeads(
  client: ImapFlow,
  range: string | number[],
  extra?: {
    uid?: boolean;
    changedSince?: bigint;
    internalDate?: boolean;
    cap?: number;
  },
): Promise<FetchedHead[] | null> {
  const query = {
    uid: true as const,
    envelope: true as const,
    flags: true as const,
    bodyStructure: true as const,
    ...(extra?.internalDate ? { internalDate: true as const } : {}),
  };
  const heads: FetchedHead[] = [];
  const opts =
    extra?.uid || extra?.changedSince
      ? { uid: extra.uid, changedSince: extra.changedSince }
      : undefined;
  for await (const msg of client.fetch(range, query, opts)) {
    // Null, not a truncated list: a partial answer would look like the whole
    // mailbox to the caller and quietly delete the rest of the index.
    if (extra?.cap != null && heads.length >= extra.cap) return null;
    heads.push(msg);
  }
  return heads;
}

async function headsToSummaries(
  client: ImapFlow,
  accountId: string,
  folder: string,
  heads: FetchedHead[],
): Promise<MailMessageSummary[]> {
  const snippets = await attachSnippets(client, heads);
  return heads
    .map((msg) =>
      envelopeToSummary(accountId, folder, msg, snippets.get(msg.uid)),
    )
    .reverse();
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
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? 50;
    const since = parseSince(opts.since);
    return withImap(account.id, account.creds, async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const mb = client.mailbox;
        if (!mb) return [];
        // Three reads share the rest of this method. Without `since` the
        // window is the tail of the mailbox — newest N, whatever their age.
        // With it the server picks the set by date and `limit` only caps how
        // much of that set comes back, so a quiet week returns few rows and a
        // busy one is capped rather than silently truncated to 25.
        let range: string | number[];
        if (since) {
          const uids = await client.search({ since }, { uid: true });
          if (!uids || uids.length === 0) return [];
          range = uids.slice(-limit);
        } else if (opts.unreadOnly) {
          const uids = await client.search({ seen: false }, { uid: true });
          if (!uids || uids.length === 0) return [];
          range = uids.slice(-limit);
        } else {
          const window = uidWindow(mb.exists, limit, opts.offset ?? 0);
          if (!window) return [];
          range = `${window.start}:${window.end}`;
        }
        const heads = await collectHeads(client, range, {
          uid: Array.isArray(range),
          internalDate: since != null,
        });
        // The since search is day-granular and the unread search ran before
        // this fetch, so both sets still need trimming against the exact ask.
        const kept = heads.filter((msg) => {
          if (opts.unreadOnly && msg.flags?.has("\\Seen")) return false;
          if (since && !withinSince(msg, since)) return false;
          return true;
        });
        return headsToSummaries(client, account.id, folder, kept);
      } finally {
        lock.release();
      }
    });
  }

  async syncMailbox(
    account: ProviderAccount,
    opts: SyncMailboxOpts = {},
  ): Promise<MailboxSyncResult> {
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? 50;
    return withImap(account.id, account.creds, async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const mb = client.mailbox;
        if (!mb) {
          return {
            replaced: true,
            messages: [],
            vanishedUids: [],
            flagUpdates: [],
            cursor: {
              uidvalidity: 0,
              highestModseq: null,
              uidnext: null,
              exists: 0,
            },
          };
        }
        const cursor = cursorFromMailbox(mb);
        // A since read is not a window read: the server picks the set by date,
        // and the answer is additive — it reaches further back than the newest
        // `limit` without invalidating what the index already holds.
        const sinceAt = parseSince(opts.since);
        if (sinceAt) {
          const uids =
            (await client.search({ since: sinceAt }, { uid: true })) || [];
          const picked = uids.slice(-limit);
          const heads = picked.length
            ? await collectHeads(client, picked, {
                uid: true,
                internalDate: true,
              })
            : [];
          const kept = heads.filter((msg) => withinSince(msg, sinceAt));
          const messages = await headsToSummaries(
            client,
            account.id,
            folder,
            kept,
          );
          return {
            replaced: false,
            messages,
            vanishedUids: [],
            flagUpdates: messages.map((m) => ({ uid: m.uid, seen: m.seen })),
            cursor,
            // Only claim the window we actually read to the end of. When the
            // search returned more than `limit`, the oldest of them is as far
            // back as this answer reaches.
            coveredSince:
              uids.length > limit
                ? (messages[messages.length - 1]?.internalDate ??
                  messages[messages.length - 1]?.date ??
                  opts.since)
                : opts.since,
          };
        }
        const full = async (): Promise<MailboxSyncResult> => {
          const window = uidWindow(mb.exists, limit, opts.offset ?? 0);
          if (!window) {
            return {
              replaced: true,
              messages: [],
              vanishedUids: [],
              flagUpdates: [],
              cursor,
            };
          }
          const heads = await collectHeads(
            client,
            `${window.start}:${window.end}`,
            { internalDate: true },
          );
          const messages = await headsToSummaries(
            client,
            account.id,
            folder,
            heads,
          );
          return {
            replaced: true,
            messages,
            vanishedUids: [],
            flagUpdates: [],
            cursor,
          };
        };

        if (
          opts.fullWindow ||
          mailboxNeedsFullResync(opts.cursor, cursor.uidvalidity)
        ) {
          return full();
        }

        const sinceModseq = opts.cursor?.highestModseq;
        if (sinceModseq && mb.highestModseq != null) {
          try {
            const vanishedUids: number[] = [];
            const onExpunge = (evt: ExpungeEvent) => {
              if (evt.uid != null) vanishedUids.push(evt.uid);
            };
            client.on("expunge", onExpunge);
            let heads: FetchedHead[] | null;
            const known = indexedUidRange(opts.knownUids);
            try {
              // Only the indexed range can change what a list paints, and it
              // starts at the oldest UID we hold. Anything older is not ours.
              heads = await collectHeads(
                client,
                `${known?.lowest ?? 1}:*`,
                {
                  uid: true,
                  changedSince: BigInt(sinceModseq),
                  internalDate: true,
                  cap: SYNC_FETCH_CAP,
                },
              );
            } finally {
              client.off("expunge", onExpunge);
            }
            // Too much changed to read one by one. A window refill is bounded
            // and lands in the same place.
            if (heads === null) return full();
            if (known && opts.knownUids) {
              const still = await client.search(
                { uid: `${known.lowest}:${known.highest}` },
                { uid: true },
              );
              const stillSet = new Set(still || []);
              for (const uid of opts.knownUids) {
                if (!stillSet.has(uid) && !vanishedUids.includes(uid)) {
                  vanishedUids.push(uid);
                }
              }
            }
            const messages = await headsToSummaries(
              client,
              account.id,
              folder,
              heads,
            );
            return {
              replaced: false,
              messages,
              vanishedUids,
              flagUpdates: messages.map((m) => ({
                uid: m.uid,
                seen: m.seen,
              })),
              cursor,
            };
          } catch (err) {
            const text = imapErrorText(err);
            if (/not found|expired|modseq|CONDSTORE|QRESYNC/i.test(text)) {
              return full();
            }
            throw err;
          }
        }

        return full();
      } finally {
        lock.release();
      }
    });
  }

  watchMailbox(
    account: ProviderAccount,
    folder: string,
    onChange: () => void,
  ): () => void {
    const key = account.id;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = WATCH_RETRY_MIN_MS;
    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 250);
      timer.unref?.();
    };
    const detach = (close: boolean) => {
      const prev = watchers.get(key);
      if (!prev) return;
      prev.client.off("exists", prev.onExists);
      prev.client.off("expunge", prev.onExists);
      prev.client.off("flags", prev.onFlags);
      prev.client.off("close", prev.onClose);
      watchers.delete(key);
      if (close) prev.client.logout().catch(() => prev.client.close());
    };

    /**
     * A connection of its own, not the pooled one. IDLE watches whichever
     * mailbox is selected, and the pool is shared: a CRM pass walking Sent, or
     * a send appending to it, would move the selection and take the inbox
     * watch with it. The second connection is the price of a watch that stays
     * put.
     */
    const select = async (reconnect: boolean) => {
      detach(true);
      const client = newClient(account.creds);
      // Before connect: a handshake timeout must not crash Node.
      client.on("error", () => {
        /* surfaced by the close handler below */
      });
      await client.connect();
      if (stopped) {
        await client.logout().catch(() => client.close());
        return;
      }
      const onExists = () => fire();
      const onFlags = () => fire();
      // The connection is the subscription. When it drops the listeners go
      // with it, so reconnect — otherwise this account silently stops
      // reporting new mail for the life of the process.
      const onClose = () => {
        detach(false);
        schedule();
      };
      client.on("exists", onExists);
      client.on("expunge", onExists);
      client.on("flags", onFlags);
      client.on("close", onClose);
      watchers.set(key, { client, onExists, onFlags, onClose });
      await client.mailboxOpen(folder, { readOnly: true });
      backoff = WATCH_RETRY_MIN_MS;
      // The gap is invisible from here: anything that arrived while the
      // connection was down produced no event, so ask for a sync outright.
      if (reconnect) fire();
    };

    const schedule = () => {
      if (stopped || retry) return;
      const wait = backoff;
      backoff = Math.min(backoff * 2, WATCH_RETRY_MAX_MS);
      retry = setTimeout(() => {
        retry = null;
        if (stopped) return;
        void select(true).catch((err) => {
          console.warn(
            `[imap] watch ${folder} reconnect failed for ${account.email}:`,
            err instanceof Error ? err.message : String(err),
          );
          schedule();
        });
      }, wait);
      retry.unref?.();
    };

    void select(false).catch((err) => {
      console.warn(
        `[imap] watch ${folder} failed for ${account.email}:`,
        err instanceof Error ? err.message : String(err),
      );
      schedule();
    });

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (retry) clearTimeout(retry);
      detach(true);
    };
  }

  async searchMessages(
    account: ProviderAccount,
    opts: SearchMessagesOpts,
  ): Promise<MailMessageSummary[]> {
    const accountId = account.id;
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? 50;
    const since = parseSince(opts.since);
    return withImap(accountId, account.creds, async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        // IMAP TEXT search — provider-dependent quality
        const uids = await client.search(
          since ? { text: opts.query, since } : { text: opts.query },
          { uid: true },
        );
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
            internalDate: Boolean(since),
          },
          { uid: true },
        )) {
          if (since && !withinSince(msg, since)) continue;
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
      icalEvent: input.icalEvent,
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
    let copied: MailMessageSummary | undefined;
    let sentFolder: string | undefined;
    await this.appendToSent(account, raw)
      .then((result) => {
        copied = result.summary ?? undefined;
        sentFolder = result.folder;
      })
      .catch((err: unknown) => {
      console.warn(
        `[imap] Sent copy failed for ${account.email}:`,
        err instanceof Error ? err.message : String(err),
      );
    });

    return {
      messageId: info.messageId ?? composed.messageId ?? "",
      accepted: (info.accepted ?? []).map(String),
      copied,
      sentFolder,
    };
  }

  /**
   * The folder comes back even when the uid does not: a server that withholds
   * APPENDUID still tells the caller which mailbox to refresh.
   */
  private async appendToSent(
    account: ProviderAccount,
    raw: Buffer,
  ): Promise<{ folder: string; summary: MailMessageSummary | null }> {
    return withImap(account.id, account.creds, async (client) => {
      const boxes = await client.list();
      const path = sentMailboxPath(boxes);
      if (!path) throw new Error("no Sent mailbox found");
      const appended = await client.append(path, raw, ["\\Seen"], new Date());
      if (!appended || appended.uid == null) {
        return { folder: path, summary: null };
      }
      const uid = appended.uid;
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const heads = await collectHeads(client, [uid], { uid: true });
        const messages = await headsToSummaries(
          client,
          account.id,
          path,
          heads,
        );
        return { folder: path, summary: messages[0] ?? null };
      } finally {
        lock.release();
      }
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
    calendar: body.calendar,
  };
}
