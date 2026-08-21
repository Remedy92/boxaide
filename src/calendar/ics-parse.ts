/**
 * iCalendar (RFC 5545) reader for the iMIP we RECEIVE — mostly METHOD:REPLY
 * from an attendee accepting or declining an invite we sent. The mirror of
 * the hand-rolled writer in ./ics.ts, and hand-rolled for the same reason:
 * we need four fields, not a calendar engine, and a REPLY body arrives from
 * strangers, so nothing here may throw on garbage.
 *
 * Only what the RSVP flow reads is parsed: METHOD, UID, SEQUENCE and the
 * ATTENDEE lines. Everything else in the body is ignored rather than
 * rejected — clients pad a REPLY with X- properties and VTIMEZONE blocks.
 */

/** Our own RSVP vocabulary, shared by the iMIP reader and the Google poll. */
export type RsvpStatus = "accepted" | "declined" | "tentative" | "needs-action";

export type IcsAttendee = {
  email: string;
  status: RsvpStatus;
  /** CN parameter, when the sender bothered to send one. */
  commonName?: string;
};

export type ParsedIcs = {
  /** Uppercased: REPLY, REQUEST, CANCEL. Absent on a plain calendar object. */
  method?: string;
  uid?: string;
  /** Absent or unparseable SEQUENCE means 0, per RFC 5545 §3.8.7.4. */
  sequence: number;
  attendees: IcsAttendee[];
};

const EMPTY: ParsedIcs = { sequence: 0, attendees: [] };

/**
 * Maps a participation status onto our vocabulary. Takes both RFC 5545
 * PARTSTAT (ACCEPTED, NEEDS-ACTION, …) and Google's responseStatus
 * (accepted, needsAction, …) because the provider poll reads the same field
 * from a different wire format; folding case and punctuation makes the two
 * spellings of needs-action collapse onto one key. Anything we do not know —
 * DELEGATED, COMPLETED, junk — is "needs-action": the invite is still open.
 */
export function normalizeRsvp(value: string | null | undefined): RsvpStatus {
  const key = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (key === "ACCEPTED") return "accepted";
  if (key === "DECLINED") return "declined";
  if (key === "TENTATIVE") return "tentative";
  return "needs-action";
}

/** Undo TEXT escaping per RFC 5545 §3.3.11. \N is as legal as \n. */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, ch: string) =>
    ch === "n" || ch === "N" ? "\n" : ch,
  );
}

/**
 * Undo folding (§3.1) and split into content lines. A fold is a line break
 * followed by one space or tab, and the break may be CRLF or a bare LF —
 * mail transports rewrite line endings, so we accept both. Bare CR is
 * treated as a break too, since a lone \r cannot appear inside a value.
 */
function contentLines(text: string): string[] {
  return text
    .replace(/\r\n[ \t]|[\r\n][ \t]/g, "")
    .split(/\r\n|[\r\n]/)
    .filter((line) => line.trim() !== "");
}

type ContentLine = { name: string; params: Map<string, string>; value: string };

/**
 * Split one content line into name, parameters and value. Parameter values
 * may be quoted and may themselves contain ";" and ":" (a DIR=\"ldap://…\"
 * is the common case), so the scan tracks quoting rather than splitting on
 * the first delimiter it sees. Parameter and property NAMES are folded to
 * upper case; values are left alone, since an email address is
 * case-preserving even where it compares case-insensitively.
 */
function parseLine(line: string): ContentLine | undefined {
  let quoted = false;
  let colon = -1;
  const breaks: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === ";") breaks.push(i);
    else if (ch === ":") {
      colon = i;
      break;
    }
  }
  if (colon < 0) return undefined; // no value: not a content line we can use

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const cuts = breaks.filter((i) => i < colon);
  const name = head.slice(0, cuts[0] ?? head.length).trim().toUpperCase();
  if (!name) return undefined;

  const params = new Map<string, string>();
  for (let i = 0; i < cuts.length; i++) {
    const raw = head.slice(cuts[i] + 1, cuts[i + 1] ?? head.length);
    const eq = raw.indexOf("=");
    if (eq < 0) continue; // valueless parameter: nothing to record
    const key = raw.slice(0, eq).trim().toUpperCase();
    let paramValue = raw.slice(eq + 1).trim();
    if (paramValue.startsWith('"') && paramValue.endsWith('"') && paramValue.length >= 2) {
      paramValue = paramValue.slice(1, -1);
    }
    if (key && !params.has(key)) params.set(key, paramValue);
  }
  return { name, params, value };
}

/** "mailto:Ada@Acme.example" → "Ada@Acme.example"; the scheme is case-blind. */
function mailboxOf(value: string): string | undefined {
  const trimmed = unescapeText(value).trim();
  const address = /^mailto:/i.test(trimmed) ? trimmed.slice("mailto:".length) : trimmed;
  return address.includes("@") ? address.trim() : undefined;
}

/**
 * Read a calendar body. Never throws: a body we cannot make sense of yields
 * the neutral result, and the caller treats that as "no RSVP here".
 *
 * Properties are read wherever they appear rather than only inside VEVENT.
 * A REPLY carries exactly one event, so the flat scan gets the same answer
 * with far less machinery: the first METHOD and UID win, and SEQUENCE takes
 * the highest seen — a body with an override VEVENT must not be read as
 * older than the REQUEST it answers.
 */
export function parseIcs(text: string): ParsedIcs {
  if (typeof text !== "string" || text.length === 0) return { ...EMPTY };
  try {
    const result: ParsedIcs = { sequence: 0, attendees: [] };
    for (const raw of contentLines(text)) {
      const line = parseLine(raw);
      if (!line) continue;
      switch (line.name) {
        case "METHOD":
          if (result.method === undefined) result.method = line.value.trim().toUpperCase();
          break;
        case "UID":
          if (result.uid === undefined) {
            const uid = unescapeText(line.value).trim();
            if (uid) result.uid = uid;
          }
          break;
        case "SEQUENCE": {
          const n = Number.parseInt(line.value.trim(), 10);
          if (Number.isFinite(n) && n > result.sequence) result.sequence = n;
          break;
        }
        case "ATTENDEE": {
          const email = mailboxOf(line.value);
          if (!email) break;
          const commonName = line.params.get("CN");
          result.attendees.push({
            email,
            status: normalizeRsvp(line.params.get("PARTSTAT")),
            ...(commonName ? { commonName: unescapeText(commonName) } : {}),
          });
          break;
        }
      }
    }
    return result;
  } catch {
    return { ...EMPTY };
  }
}
