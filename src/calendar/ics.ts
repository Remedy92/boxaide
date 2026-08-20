/**
 * iCalendar (RFC 5545) writer for the two iMIP messages Boxaide sends:
 * METHOD:REQUEST (the invite) and METHOD:CANCEL. Hand-rolled on purpose —
 * every timestamp is emitted in UTC, which removes the whole VTIMEZONE
 * problem and keeps the output small enough to eyeball.
 */
import { randomBytes } from "node:crypto";

/** TEXT escaping per RFC 5545 §3.3.11: backslash, semicolon, comma, newline. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold lines longer than 75 octets with CRLF + space (RFC 5545 §3.1). */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    // Chunk on byte budget but never split a UTF-8 sequence.
    let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return parts.join("\r\n ");
}

/** ISO instant → 20260817T140000Z basic format. */
export function icsDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${iso}`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export type InviteEvent = {
  uid: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  organizerEmail: string;
  organizerName?: string;
  attendees: string[];
  /**
   * Bumped on every re-send of the same UID. A CANCEL must carry a higher
   * SEQUENCE than the REQUEST it cancels or clients ignore it.
   */
  sequence?: number;
};

export type IcsMethod = "REQUEST" | "CANCEL";

function vevent(event: InviteEvent, method?: IcsMethod): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${escapeText(event.uid)}`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(event.start)}`,
    `DTEND:${icsDate(event.end)}`,
    `SUMMARY:${escapeText(event.title)}`,
    `SEQUENCE:${event.sequence ?? 0}`,
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    `ORGANIZER;CN=${escapeText(event.organizerName ?? event.organizerEmail)}:mailto:${event.organizerEmail}`,
  ];
  for (const attendee of event.attendees) {
    lines.push(
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee}`,
    );
  }
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  lines.push("END:VEVENT");
  return lines;
}

/**
 * With a method this is an iMIP message for mailing; without one it is a
 * plain object for storing on a CalDAV server, which may reject METHOD.
 */
export function buildIcs(event: InviteEvent, method?: IcsMethod): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Boxaide//Calendar//EN",
    ...(method ? [`METHOD:${method}`] : []),
    ...vevent(event, method),
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/**
 * A meet.jit.si room needs no account and no API key; a random suffix keeps
 * it unguessable. BOXAIDE_JITSI_BASE points it at a self-hosted Jitsi.
 */
export function jitsiLink(title: string): string {
  const base = (process.env.BOXAIDE_JITSI_BASE ?? "https://meet.jit.si").replace(/\/+$/, "");
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = randomBytes(5).toString("hex");
  return `${base}/${slug ? slug + "-" : ""}${suffix}`;
}

export function newEventUid(): string {
  return `${randomBytes(12).toString("hex")}@boxaide`;
}
