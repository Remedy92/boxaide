import { simpleParser } from "mailparser";

/** Includes MIME encoding and attachments; checked before mailparser allocates. */
export const MAX_RFC822_SOURCE_BYTES = 50 * 1024 * 1024;
/**
 * Raw sender HTML, bounded so one message cannot blow up memory.
 *
 * mailparser inlines every `cid:` image as a `data:` URI before this sees the
 * html, so a single photo is megabytes of base64. The old 250 000 cap was
 * sized when this was source-view only; against inlined images it severed
 * ordinary mail mid-document. The ceiling now bounds bytes, and the cost that
 * actually scales with tag count is bounded where it is paid, on the render
 * path in `HtmlBody` (SECURITY.md, "HTML mail rendering").
 */
export const MAX_BODY_HTML_CHARS = 4_000_000;

export type ParsedMailBody = {
  bodyText: string;
  bodyHtml?: string;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  /**
   * iMIP payload (RFC 6047) when the message carries one. `method` comes off
   * the Content-Type parameter (REQUEST/REPLY/CANCEL) and is what tells an
   * invite apart from a response; senders may omit it, hence optional.
   */
  calendar?: { method?: string; content: string };
};

/** Same reasoning as the bodyText cap: a runaway .ics must not blow up memory. */
const CALENDAR_MAX_CHARS = 100_000;

/**
 * Parse raw RFC822 into readable text/html.
 * Handles 7bit, quoted-printable, base64, multipart/alternative, etc.
 * This is the shipped body path for IMAP getMessage.
 */
export async function parseRfc822(raw: string | Buffer): Promise<ParsedMailBody> {
  const bytes = Buffer.isBuffer(raw)
    ? raw.byteLength
    : Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_RFC822_SOURCE_BYTES) {
    throw new Error(
      `message source exceeds the ${MAX_RFC822_SOURCE_BYTES}-byte safety limit`,
    );
  }
  const parsed = await simpleParser(raw);
  const bodyText =
    (typeof parsed.text === "string" && parsed.text.trim()) ||
    stripHtml(typeof parsed.html === "string" ? parsed.html : "") ||
    "";
  const bodyHtml =
    typeof parsed.html === "string" && parsed.html.trim()
      ? capHtml(parsed.html)
      : undefined;

  return {
    bodyText: bodyText.slice(0, 50_000),
    bodyHtml,
    subject: parsed.subject || undefined,
    from: formatAddress(parsed.from as unknown),
    to: formatAddress(parsed.to as unknown),
    cc: formatAddress(parsed.cc as unknown),
    bcc: formatAddress(parsed.bcc as unknown),
    date: parsed.date ? parsed.date.toISOString() : undefined,
    messageId: parsed.messageId || undefined,
    inReplyTo: parsed.inReplyTo || undefined,
    references: formatReferences(parsed.references),
    calendar: extractCalendar(parsed),
  };
}

/**
 * Cut at the last `<` so truncation never severs a tag or an attribute. The
 * HTML parser drops a tag it hits EOF inside, which is safe but silently eats
 * whatever followed on that line; cutting on a boundary keeps the loss to
 * whole elements.
 */
function capHtml(html: string): string {
  if (html.length <= MAX_BODY_HTML_CHARS) return html;
  const cut = html.slice(0, MAX_BODY_HTML_CHARS);
  const lastTag = cut.lastIndexOf("<");
  return lastTag > 0 ? cut.slice(0, lastTag) : cut;
}

/**
 * Find the text/calendar part. Mailparser routes every node that is not
 * text/plain or text/html into `attachments` regardless of disposition, so
 * one loop covers all three shapes an invite arrives in: a named .ics
 * attachment, an inline part of an iMIP multipart/alternative, and a bare
 * text/calendar message. Only `attachments` — `parsed.text` never holds it.
 */
function extractCalendar(
  parsed: Awaited<ReturnType<typeof simpleParser>>,
): { method?: string; content: string } | undefined {
  for (const att of parsed.attachments ?? []) {
    if ((att.contentType || "").toLowerCase() !== "text/calendar") continue;
    const content = bufferToUtf8(att.content);
    if (!content.trim()) continue;
    return {
      method: contentTypeParam(att.headers, "method"),
      content: content.slice(0, CALENDAR_MAX_CHARS),
    };
  }
  return undefined;
}

/** Attachment content is a Buffer; calendars are text, so decode as UTF-8. */
function bufferToUtf8(content: unknown): string {
  if (typeof content === "string") return content;
  if (Buffer.isBuffer(content)) return content.toString("utf8");
  if (content instanceof Uint8Array) return Buffer.from(content).toString("utf8");
  return "";
}

/** A Content-Type parameter, e.g. `method=REPLY` on an iMIP part. */
function contentTypeParam(headers: unknown, name: string): string | undefined {
  const params = headerObject(headers)?.params;
  if (!params || typeof params !== "object") return undefined;
  const value = (params as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim()
    ? value.trim().toUpperCase()
    : undefined;
}

/** Mailparser parses Content-Type into `{ value, params }` on a header Map. */
function headerObject(
  headers: unknown,
): { params?: unknown } | undefined {
  if (!headers || typeof (headers as Map<string, unknown>).get !== "function") {
    return undefined;
  }
  const ct = (headers as Map<string, unknown>).get("content-type");
  return ct && typeof ct === "object"
    ? (ct as { value?: unknown; params?: unknown })
    : undefined;
}

/** Flatten the References header into a single space-separated chain. */
function formatReferences(value: unknown): string | undefined {
  if (!value) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const chain = list
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  return chain.length ? chain.join(" ") : undefined;
}

export function formatAddress(value: unknown): string | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    const parts = value
      .map((v) => formatAddress(v))
      .filter((s): s is string => Boolean(s));
    return parts.length ? parts.join(", ") : undefined;
  }
  if (typeof value === "object" && value !== null) {
    const o = value as { text?: string; address?: string; name?: string };
    if (o.text) return o.text;
    if (o.address) return o.name ? `${o.name} <${o.address}>` : o.address;
  }
  if (typeof value === "string") return value;
  return undefined;
}

/** Strip tags and decode the handful of entities that show up in mail bodies. */
export function stripHtml(input: string): string {
  return input
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
