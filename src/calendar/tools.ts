/**
 * Calendar MCP tools: read the agenda, find open slots, schedule and cancel
 * meetings.
 *
 * One of these tools sends email. meeting_create mails an iMIP invite to every
 * attendee the moment it is called, so its description spends most of its words
 * on when NOT to call it — the agent's instinct is to "book" a time it merely
 * proposed in chat.
 */
import type { Platform, ToolDef } from "../platform.js";
import { agendaRangeOrThrow, MAX_AGENDA_DAYS } from "./range.js";

const RANGE_DESC =
  "ISO 8601 instant (e.g. 2026-03-04T09:00:00Z). Times are absolute instants, not wall clock.";

/** Stated on both read tools: the merge is invisible unless it is said. */
const MERGE_DESC =
  "Every connected calendar account is read and the results are merged into one timeline. An unreachable account does not fail the call — it contributes a string to `errors`, so check that field before telling the user their day is empty.";

/**
 * The whole reason this tool is dangerous: it is a send, not a draft, and there
 * is no approval step between the call and the attendees' inboxes.
 */
const CREATE_SAFETY =
  "THIS SENDS EMAIL. It mails a calendar invite to every attendee immediately, from the user's own mailbox, and writes the event to the connected calendar. There is no draft, no review step and no undo other than meeting_cancel, which mails everyone again. Call it only after the user has agreed to this exact time and this exact attendee list. To propose times, offer them in chat instead — use calendar_free_slots and say the options out loud.";

export const CALENDAR_TOOLS: ToolDef[] = [
  {
    name: "calendar_accounts_list",
    description:
      "List connected calendar accounts (id, alias, provider, email). Use the id for meeting_create's calendarAccountId when the user has more than one calendar and says which.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "agenda_view",
    description: `Read the user's agenda over a time range. ${MERGE_DESC} Ask for the smallest range that answers the question — a week of events is a lot of text.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        start: { type: "string", description: `${RANGE_DESC} Defaults to now.` },
        end: {
          type: "string",
          description: `${RANGE_DESC} Defaults to start plus \`days\`.`,
        },
        days: {
          type: "number",
          description: `Length of the range when \`end\` is omitted. Default 7, max ${MAX_AGENDA_DAYS}.`,
          default: 7,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "calendar_free_slots",
    description: `Find open meeting times. Returns candidate START times that are free on every connected calendar — they are suggestions to offer the user, nothing is booked. Working hours are the SERVER's local time zone, 09:00-17:00 by default, and slots begin on the half hour. ${MERGE_DESC}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        start: { type: "string", description: `${RANGE_DESC} Defaults to now.` },
        end: {
          type: "string",
          description: `${RANGE_DESC} Defaults to a week after start. At most ${MAX_AGENDA_DAYS} days after start.`,
        },
        durationMinutes: {
          type: "number",
          description: "How long the meeting needs to be.",
        },
        dayStartHour: {
          type: "number",
          description: "First hour of the working day, server-local. Default 9.",
          default: 9,
        },
        dayEndHour: {
          type: "number",
          description: "Hour the working day ends, server-local. Default 17.",
          default: 17,
        },
        maxSlots: { type: "number", description: "How many candidates to return. Default 10." },
      },
      required: ["durationMinutes"],
      additionalProperties: false,
    },
  },
  {
    name: "meeting_create",
    description: `Schedule a meeting and invite the attendees. ${CREATE_SAFETY}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Becomes the invite subject and event title." },
        start: { type: "string", description: RANGE_DESC },
        end: { type: "string", description: `${RANGE_DESC} Must be after start.` },
        attendees: {
          type: "array",
          description:
            "Email addresses, one per attendee. Every one of them receives the invite.",
          items: { type: "string" },
        },
        description: { type: "string", description: "Agenda or notes for the invite body." },
        location: {
          type: "string",
          description:
            "Physical location or a meeting URL you supply. Given, it replaces the generated video link in the event's location field.",
        },
        calendarAccountId: {
          type: "string",
          description:
            "From calendar_accounts_list. Omit to use the first connected calendar.",
        },
        mailAccountId: {
          type: "string",
          description:
            "Mail account alias or id the invite is sent from. Omit to use the first connected mailbox.",
        },
        includeMeetingLink: {
          type: "boolean",
          description:
            "A video meeting link is generated and included by default. Pass false for an in-person meeting.",
          default: true,
        },
      },
      required: ["title", "start", "end", "attendees"],
      additionalProperties: false,
    },
  },
  {
    name: "meeting_cancel",
    description:
      "Cancel a meeting created through Boxaide. THIS SENDS EMAIL: a cancellation notice goes to every attendee and the event is removed from the connected calendar. Confirm with the user first. Get meetingId from meetings_list.",
    inputSchema: {
      type: "object" as const,
      properties: { meetingId: { type: "string", description: "Id from meetings_list." } },
      required: ["meetingId"],
      additionalProperties: false,
    },
  },
  {
    name: "meetings_list",
    description:
      "Meetings scheduled through Boxaide, newest first, with the ids meeting_cancel needs. This is not the agenda — meetings booked elsewhere are not here; use agenda_view for those.",
    inputSchema: {
      type: "object" as const,
      properties: { limit: { type: "number", default: 50 } },
      additionalProperties: false,
    },
  },
];

export const CALENDAR_TOOL_NAMES: ReadonlySet<string> = new Set(
  CALENDAR_TOOLS.map((t) => t.name),
);

/**
 * The two tools that put mail in an attendee's inbox. Split out because
 * src/agent/launcher.ts must keep them off every allowlist it builds — a
 * scheduled run is told "never send email" and the allowlist has to make that
 * true, not merely ask for it.
 *
 * Listed here rather than in the launcher so a future sending tool is caught
 * by the module that owns it. Anything added to CALENDAR_TOOLS that mails
 * someone belongs in this set, and the read set below is derived, never typed
 * out — a tool omitted from both would otherwise silently become a read.
 */
export const CALENDAR_SEND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "meeting_create",
  "meeting_cancel",
]);

/** Everything that only looks: safe to pre-approve for any agent. */
export const CALENDAR_READ_TOOL_NAMES: ReadonlySet<string> = new Set(
  CALENDAR_TOOLS.map((t) => t.name).filter((n) => !CALENDAR_SEND_TOOL_NAMES.has(n)),
);

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function required(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (value === undefined || value === "") throw new Error(`${key} is required`);
  return value;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredNum(args: Record<string, unknown>, key: string): number {
  const value = num(args, key);
  if (value === undefined) throw new Error(`${key} is required`);
  return value;
}

function requiredEmails(args: Record<string, unknown>, key: string): string[] {
  const raw = args[key];
  if (!Array.isArray(raw)) throw new Error(`${key} must be an array of email addresses`);
  const emails = raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  if (emails.length === 0) throw new Error(`${key} must list at least one email address`);
  return emails;
}

export async function dispatchCalendarTool(
  platform: Platform,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const store = platform.calendarStore;
  const service = platform.calendarService;
  switch (name) {
    case "calendar_accounts_list":
      return { accounts: store.listAccounts() };

    case "agenda_view":
      // Same helper, same cap and same messages as GET /api/calendar/agenda.
      return service.agenda(
        agendaRangeOrThrow({
          start: str(args, "start"),
          end: str(args, "end"),
          days: num(args, "days"),
        }),
      );

    case "calendar_free_slots":
      // Same cap as agenda_view and GET /api/calendar/free-slots: the slot
      // search reads the whole window through every connected provider and
      // walks it day by day, so an uncapped explicit end fans out for years.
      return service.freeSlots({
        ...agendaRangeOrThrow({ start: str(args, "start"), end: str(args, "end") }),
        durationMinutes: requiredNum(args, "durationMinutes"),
        dayStartHour: num(args, "dayStartHour"),
        dayEndHour: num(args, "dayEndHour"),
        maxSlots: num(args, "maxSlots"),
      });

    case "meeting_create":
      return service.createMeeting({
        title: required(args, "title"),
        start: required(args, "start"),
        end: required(args, "end"),
        attendees: requiredEmails(args, "attendees"),
        description: str(args, "description"),
        location: str(args, "location"),
        calendarAccountId: str(args, "calendarAccountId"),
        mailAccountId: str(args, "mailAccountId"),
        includeMeetingLink:
          typeof args.includeMeetingLink === "boolean"
            ? (args.includeMeetingLink as boolean)
            : undefined,
      });

    case "meeting_cancel":
      return service.cancelMeeting(required(args, "meetingId"));

    case "meetings_list":
      return { meetings: store.listMeetings({ limit: num(args, "limit") }) };

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
