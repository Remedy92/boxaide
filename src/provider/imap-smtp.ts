import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { parseRfc822 } from "./mime.js";
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

function makeId(accountId: string, folder: string, uid: number): string {
  return `${accountId}:${encodeURIComponent(folder)}:${uid}`;
}

function parseId(
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

function addr(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === "string") return v;
        if (v && typeof v === "object" && "address" in v) {
          const o = v as { name?: string; address?: string };
          return o.name ? `${o.name} <${o.address}>` : (o.address ?? "");
        }
        return String(v);
      })
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "object" && value && "address" in value) {
    const o = value as { name?: string; address?: string };
    return o.name ? `${o.name} <${o.address}>` : (o.address ?? "");
  }
  return String(value);
}

async function withImap<T>(
  creds: AccountCredentials,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: creds.imapHost,
    port: creds.imapPort,
    secure: creds.imapSecure,
    auth: { user: creds.username, pass: creds.password },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
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
): MailMessageSummary {
  const env = source.envelope ?? {};
  const subject = env.subject ?? "(no subject)";
  const snippet =
    source.source?.toString("utf8").replace(/\s+/g, " ").slice(0, 140) ??
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
    hasAttachments: Boolean(
      source.bodyStructure?.childNodes &&
        (source.bodyStructure.childNodes as unknown[]).length > 1,
    ),
  };
}

export class ImapSmtpProvider implements MailProvider {
  async testConnection(
    creds: AccountCredentials,
  ): Promise<ConnectionTestResult> {
    try {
      await withImap(creds, async (client) => {
        await client.mailboxOpen("INBOX", { readOnly: true });
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listMessages(
    accountId: string,
    creds: AccountCredentials,
    opts: ListMessagesOpts = {},
  ): Promise<MailMessageSummary[]> {
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? 50;
    return withImap(creds, async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const mb = client.mailbox;
        if (!mb || mb.exists === 0) return [];
        const start = Math.max(1, mb.exists - limit - (opts.offset ?? 0) + 1);
        const end = Math.max(1, mb.exists - (opts.offset ?? 0));
        if (start > end) return [];
        const range = `${start}:${end}`;
        const out: MailMessageSummary[] = [];
        for await (const msg of client.fetch(range, {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
        })) {
          if (opts.unreadOnly && msg.flags?.has("\\Seen")) continue;
          out.push(envelopeToSummary(accountId, folder, msg));
        }
        return out.reverse();
      } finally {
        lock.release();
      }
    });
  }

  async searchMessages(
    accountId: string,
    creds: AccountCredentials,
    opts: SearchMessagesOpts,
  ): Promise<MailMessageSummary[]> {
    const folder = opts.folder ?? "INBOX";
    const limit = opts.limit ?? 50;
    return withImap(creds, async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        // IMAP TEXT search — provider-dependent quality
        const uids = await client.search({ text: opts.query }, { uid: true });
        if (!uids || uids.length === 0) return [];
        const slice = uids.slice(-limit);
        const out: MailMessageSummary[] = [];
        for await (const msg of client.fetch(slice, {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
        }, { uid: true })) {
          out.push(envelopeToSummary(accountId, folder, msg));
        }
        return out.reverse();
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(
    accountId: string,
    creds: AccountCredentials,
    messageId: string,
    folderHint?: string,
  ): Promise<MailMessage | null> {
    const parsed = parseId(messageId, accountId);
    const folder = parsed?.folder ?? folderHint ?? "INBOX";
    const uid = parsed?.uid;
    if (uid == null) return null;

    return withImap(creds, async (client) => {
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
    accountId: string,
    creds: AccountCredentials,
    input: SendMessageInput,
  ): Promise<SendResult> {
    void accountId;
    const transport = nodemailer.createTransport({
      host: creds.smtpHost,
      port: creds.smtpPort,
      secure: creds.smtpSecure,
      auth: { user: creds.username, pass: creds.password },
    });
    const info = await transport.sendMail({
      from: creds.username,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      inReplyTo: input.inReplyTo,
      references: input.references,
    });
    return {
      messageId: info.messageId ?? "",
      accepted: (info.accepted ?? []).map(String),
    };
  }
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
  };
}
