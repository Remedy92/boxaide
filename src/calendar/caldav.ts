/**
 * CalDAV provider (RFC 4791) over tsdav — covers iCloud, Fastmail, Nextcloud
 * and anything else with a discovery URL plus an app password.
 *
 * Recurrence: the time-range REPORT asks the server to expand (CALDAV:expand),
 * and any VEVENT that still carries an RRULE — servers are allowed to ignore
 * expand — is unrolled locally with ical.js, so callers always see instances.
 */
import { DAVClient, type DAVCalendar } from "tsdav";
import ICAL from "ical.js";
import { buildIcs } from "./ics.js";
import { parseIcs } from "./ics-parse.js";
import type {
  CalendarConfig,
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  CreateEventInput,
  EventRange,
  ProviderAttendeeStatus,
} from "./types.js";

/** Hard stop on INSTANCES RETURNED — occurrences skipped as out-of-range do
 *  not count, or a series that started years ago spends the whole budget on
 *  the past and returns nothing for the range asked about. */
const MAX_INSTANCES = 500;

/** Hard stop on iterator steps, so a sub-daily rule from decades back cannot
 *  spin forever. A range far beyond the step budget returns fewer instances
 *  than it should; nothing else in the codebase asks for such a range. */
const MAX_STEPS = 50_000;

type ParsedInstance = Omit<CalendarEvent, "accountId" | "accountAlias">;

function requireCalDav(config: CalendarConfig) {
  if (config.kind !== "caldav") throw new Error("not a CalDAV account");
  return config;
}

async function connect(config: CalendarConfig): Promise<DAVClient> {
  const { serverUrl, username, password } = requireCalDav(config);
  const client = new DAVClient({
    serverUrl,
    credentials: { username, password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  await client.login();
  return client;
}

/** Calendars that can hold events; iCloud lists inbox/outbox collections too. */
function eventCalendars(calendars: DAVCalendar[]): DAVCalendar[] {
  return calendars.filter((c) => {
    const comps = c.components;
    return !comps || comps.length === 0 || comps.includes("VEVENT");
  });
}

function toIso(time: ICAL.Time): string {
  return time.toJSDate().toISOString();
}

function instanceFrom(
  vevent: ICAL.Component,
  calendarId: string,
  objectUrl: string,
  start: ICAL.Time,
  end: ICAL.Time,
): ParsedInstance {
  const status = String(vevent.getFirstPropertyValue("status") ?? "CONFIRMED").toUpperCase();
  const transp = String(vevent.getFirstPropertyValue("transp") ?? "OPAQUE").toUpperCase();
  return {
    id: objectUrl,
    calendarId,
    title: String(vevent.getFirstPropertyValue("summary") ?? "(no title)"),
    start: toIso(start),
    end: toIso(end),
    allDay: start.isDate,
    location: (vevent.getFirstPropertyValue("location") as string | null) ?? undefined,
    status:
      status === "CANCELLED" ? "cancelled" : status === "TENTATIVE" ? "tentative" : "confirmed",
    busy: transp !== "TRANSPARENT",
  };
}

/** Unroll one .ics object (which may hold master + override VEVENTs). */
export function parseObjectInstances(
  ics: string,
  calendarId: string,
  objectUrl: string,
  range: EventRange,
): ParsedInstance[] {
  const comp = new ICAL.Component(ICAL.parse(ics));
  const vevents = comp.getAllSubcomponents("vevent");
  if (vevents.length === 0) return [];
  const rangeStart = new Date(range.start).getTime();
  const rangeEnd = new Date(range.end).getTime();
  const out: ParsedInstance[] = [];

  const master = vevents.find((v) => !v.getFirstProperty("recurrence-id")) ?? vevents[0];
  const event = new ICAL.Event(master);
  // Register overrides so the iterator substitutes them.
  for (const v of vevents) {
    if (v !== master && v.getFirstProperty("recurrence-id")) {
      try {
        event.relateException(new ICAL.Event(v));
      } catch {
        // An override that fails to relate is skipped, not fatal.
      }
    }
  }

  const push = (v: ICAL.Component, s: ICAL.Time, e: ICAL.Time) => {
    const sMs = s.toJSDate().getTime();
    if (sMs < rangeEnd && e.toJSDate().getTime() > rangeStart) {
      out.push(instanceFrom(v, calendarId, objectUrl, s, e));
    }
  };

  if (!event.isRecurring()) {
    // Server-expanded results arrive as one VEVENT per instance.
    for (const v of vevents) {
      const single = new ICAL.Event(v);
      push(v, single.startDate, single.endDate);
    }
    return out;
  }

  // The iterator MUST stay anchored at DTSTART: ical.js derives the pattern
  // (weekday, day of month, time of day) from the dtstart it is handed, so
  // seeding it at the range start would move a Monday 14:00 series onto
  // whatever day and hour the range happens to begin. Occurrences before the
  // range are stepped over instead, and only what lands in the range is
  // charged against MAX_INSTANCES.
  const iterator = event.iterator();
  const durationMs = event.endDate.toJSDate().getTime() - event.startDate.toJSDate().getTime();
  // An override can move an occurrence into the range from outside it, and
  // only getOccurrenceDetails knows where it went — so skip cheaply only when
  // this object carries no overrides at all.
  const hasOverrides = Object.keys(event.exceptions ?? {}).length > 0;
  let next: ICAL.Time | null;
  let steps = 0;
  while ((next = iterator.next()) && out.length < MAX_INSTANCES && steps < MAX_STEPS) {
    steps++;
    const startMs = next.toJSDate().getTime();
    if (startMs >= rangeEnd) break;
    if (!hasOverrides && startMs + durationMs <= rangeStart) continue;
    const occ = event.getOccurrenceDetails(next);
    // Skip, never break: the iterator is ordered by the ORIGINAL recurrence
    // ids, so an override that moved one occurrence past the range end says
    // nothing about the occurrences after it. Breaking here dropped every
    // later in-range instance of the series. The loop above still stops on the
    // unmoved pattern passing rangeEnd.
    if (occ.startDate.toJSDate().getTime() >= rangeEnd) continue;
    push(occ.item.component, occ.startDate, occ.endDate);
  }
  return out;
}

export class CalDavProvider implements CalendarProvider {
  async testConnection(config: CalendarConfig): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = await connect(config);
      const calendars = eventCalendars(await client.fetchCalendars());
      if (calendars.length === 0) return { ok: false, error: "no calendars found" };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listCalendars(config: CalendarConfig): Promise<CalendarInfo[]> {
    const client = await connect(config);
    return eventCalendars(await client.fetchCalendars()).map((c) => ({
      id: c.url,
      name: typeof c.displayName === "string" ? c.displayName : c.url,
    }));
  }

  async listEvents(config: CalendarConfig, range: EventRange): Promise<ParsedInstance[]> {
    const client = await connect(config);
    const calendars = eventCalendars(await client.fetchCalendars());
    const out: ParsedInstance[] = [];
    for (const calendar of calendars) {
      const objects = await client.fetchCalendarObjects({
        calendar,
        timeRange: { start: range.start, end: range.end },
        expand: true,
      });
      for (const object of objects) {
        if (!object.data) continue;
        try {
          out.push(
            ...parseObjectInstances(String(object.data), calendar.url, object.url, range),
          );
        } catch {
          // One malformed object must not empty the whole agenda.
        }
      }
    }
    return out;
  }

  async createEvent(
    config: CalendarConfig,
    input: CreateEventInput,
  ): Promise<{ eventId: string; calendarId: string }> {
    const client = await connect(config);
    const calendars = eventCalendars(await client.fetchCalendars());
    if (calendars.length === 0) throw new Error("no calendars found");
    const calendar = calendars[0];
    const filename = `${input.uid.replace(/[^a-zA-Z0-9@.-]/g, "")}.ics`;
    const response = await client.createCalendarObject({
      calendar,
      filename,
      // No METHOD: stored objects are plain data, not iMIP messages.
      iCalString: buildIcs(input),
    });
    if (!response.ok) {
      throw new Error(`calendar write failed: HTTP ${response.status}`);
    }
    const url = calendar.url.replace(/\/+$/, "") + "/" + filename;
    return { eventId: url, calendarId: calendar.url };
  }

  async deleteEvent(
    config: CalendarConfig,
    _calendarId: string,
    eventId: string,
  ): Promise<boolean> {
    const client = await connect(config);
    const response = await client.deleteCalendarObject({
      calendarObject: { url: eventId, etag: "" },
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`calendar delete failed: HTTP ${response.status}`);
    return true;
  }

  async getAttendeeStatus(
    config: CalendarConfig,
    calendarId: string,
    eventId: string,
  ): Promise<ProviderAttendeeStatus[]> {
    // Same idiom as listEvents: log in, list the event collections, then read
    // through the client — but by objectUrls, since eventId IS the object url
    // createEvent handed back. A login or REPORT failure propagates; only a
    // missing OBJECT is soft.
    const client = await connect(config);
    const calendars = eventCalendars(await client.fetchCalendars());
    // Fall back to a full scan when the stored calendar url no longer matches
    // (iCloud rewrites collection urls on migration); the object url is still
    // the identity, so a wrong collection just returns nothing.
    const scoped = calendars.filter((c) => c.url === calendarId);
    for (const calendar of scoped.length > 0 ? scoped : calendars) {
      const objects = await client.fetchCalendarObjects({
        calendar,
        objectUrls: [eventId],
      });
      for (const object of objects) {
        if (!object.data) continue;
        // parseIcs never throws, so a malformed stored object reads as "no
        // attendee status known" rather than breaking the RSVP sweep.
        const attendees = parseIcs(String(object.data)).attendees;
        if (attendees.length > 0) {
          return attendees.map((a) => ({ email: a.email, status: a.status }));
        }
      }
    }
    // The server did not return the object (deleted, moved, or a collection
    // we cannot read). Empty, not an error: there is nothing to top up.
    return [];
  }
}
