/**
 * Calendar provider contract. Two implementations: CalDAV (iCloud, Fastmail,
 * Nextcloud, anything speaking RFC 4791) and Google Calendar (REST + OAuth).
 * Both are stateless — per-account config is handed to every call, mirroring
 * how MailProvider takes ProviderAccount.
 */
import type { RsvpStatus } from "./ics-parse.js";

export type CalDavConfig = {
  kind: "caldav";
  /** Discovery URL, e.g. https://caldav.icloud.com or a full calendar home. */
  serverUrl: string;
  username: string;
  /** App-specific password for iCloud/Fastmail. */
  password: string;
};

export type GoogleConfig = {
  kind: "google";
  /** The user's own Google Cloud OAuth client — self-host, no shared secret. */
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Account email, learned from the token exchange. */
  email: string;
};

export type CalendarConfig = CalDavConfig | GoogleConfig;

export type CalendarAccountMeta = {
  id: string;
  alias: string;
  provider: "caldav" | "google";
  email: string;
  createdAt: string;
};

/** One expanded event instance — recurring events arrive already unrolled. */
export type CalendarEvent = {
  /** Provider-side id (CalDAV object url / Google event id). */
  id: string;
  accountId: string;
  accountAlias: string;
  calendarId: string;
  title: string;
  /** ISO instants. All-day events carry midnight boundaries. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  status: "confirmed" | "tentative" | "cancelled";
  /** False for events marked free/transparent — they do not block slots. */
  busy: boolean;
};

export type CalendarInfo = {
  id: string;
  name: string;
};

export type EventRange = { start: string; end: string };

export type CreateEventInput = {
  /** iCalendar UID; the same UID goes into the emailed invite. */
  uid: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  organizerEmail: string;
  attendees: string[];
};

/**
 * One attendee's participation as the CALENDAR SERVER currently reports it.
 * Deliberately the same vocabulary as the iMIP reader (RsvpStatus), because
 * the two feed one merged view: inbound METHOD:REPLY mails are the base and
 * this poll is the top-up for attendees who answered their organiser's copy
 * without ever mailing us back.
 */
export type ProviderAttendeeStatus = { email: string; status: RsvpStatus };

export interface CalendarProvider {
  testConnection(config: CalendarConfig): Promise<{ ok: boolean; error?: string }>;
  listCalendars(config: CalendarConfig): Promise<CalendarInfo[]>;
  /** Expanded instances inside [start, end), across the account's calendars. */
  listEvents(config: CalendarConfig, range: EventRange): Promise<Omit<CalendarEvent, "accountId" | "accountAlias">[]>;
  /** Write the event to the account's default (first) calendar. */
  createEvent(config: CalendarConfig, input: CreateEventInput): Promise<{ eventId: string; calendarId: string }>;
  /** Returns false when the event is already gone. */
  deleteEvent(config: CalendarConfig, calendarId: string, eventId: string): Promise<boolean>;
  /**
   * Attendee participation for one event, best effort.
   *
   * OPTIONAL because it is a top-up, never the source of truth: RSVPs are
   * complete without it (email replies carry a timestamp and win), and not
   * every server can answer. A CalDAV box that hides the organiser's copy, or
   * any provider added later that only writes, omits the method rather than
   * returning a lie; the caller checks for it and skips the top-up.
   *
   * Errors are NOT swallowed here — a 401 means the account needs
   * reconnecting, and hiding it behind an empty array would read as "nobody
   * has answered yet" forever. The caller downgrades it to a warning.
   */
  getAttendeeStatus?(
    config: CalendarConfig,
    calendarId: string,
    eventId: string,
  ): Promise<ProviderAttendeeStatus[]>;
}
