import { simpleParser } from "mailparser";

export type ParsedMailBody = {
  bodyText: string;
  bodyHtml?: string;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  date?: string;
  messageId?: string;
};

/**
 * Parse raw RFC822 into readable text/html.
 * Handles 7bit, quoted-printable, base64, multipart/alternative, etc.
 * This is the shipped body path for IMAP getMessage.
 */
export async function parseRfc822(raw: string | Buffer): Promise<ParsedMailBody> {
  const parsed = await simpleParser(raw);
  const bodyText =
    (typeof parsed.text === "string" && parsed.text.trim()) ||
    stripHtml(typeof parsed.html === "string" ? parsed.html : "") ||
    "";
  const bodyHtml =
    typeof parsed.html === "string" && parsed.html.trim()
      ? parsed.html
      : undefined;

  return {
    bodyText: bodyText.slice(0, 50_000),
    bodyHtml,
    subject: parsed.subject || undefined,
    from: formatAddress(parsed.from as unknown),
    to: formatAddress(parsed.to as unknown),
    cc: formatAddress(parsed.cc as unknown),
    date: parsed.date ? parsed.date.toISOString() : undefined,
    messageId: parsed.messageId || undefined,
  };
}

function formatAddress(value: unknown): string | undefined {
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

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
