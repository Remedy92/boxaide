/**
 * The calendar HTTP surface: the two zone-taking routes and the two RSVP
 * ones. Mounted on a bare Hono app rather than through createApi — these
 * assertions are about this module's paths, status codes and payloads, and
 * the auth middleware is covered where it lives (test/security-http.test.ts).
 *
 * Nothing here touches the network: calendars are a fake CalendarProvider and
 * mail is FixtureProvider, exactly as in test/calendar.test.ts.
 */
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCalendarRoutes } from "../src/calendar/routes.js";
import { CalendarService } from "../src/calendar/service.js";
import { CalendarStore } from "../src/calendar/store.js";
import type {
  CalDavConfig,
  CalendarConfig,
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  CreateEventInput,
  EventRange,
} from "../src/calendar/types.js";
import { Store } from "../src/db/store.js";
import { MailService } from "../src/mail/service.js";
import type { Platform } from "../src/platform.js";
import { FixtureProvider } from "../src/provider/fixture.js";

const CALDAV: CalDavConfig = {
  kind: "caldav",
  serverUrl: "https://caldav.example/dav",
  username: "me@test.com",
  password: "app-password",
};

type ProviderEvent = Omit<CalendarEvent, "accountId" | "accountAlias">;

/** Busy-free by default: the slot tests only care about the working grid. */
class FakeProvider implements CalendarProvider {
  events: ProviderEvent[] = [];

  async testConnection(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return [{ id: "cal-1", name: "Work" }];
  }

  async listEvents(_config: CalendarConfig, _range: EventRange): Promise<ProviderEvent[]> {
    return this.events;
  }

  async createEvent(
    _config: CalendarConfig,
    _input: CreateEventInput,
  ): Promise<{ eventId: string; calendarId: string }> {
    return { eventId: "event-1", calendarId: "cal-1" };
  }

  async deleteEvent(): Promise<boolean> {
    return true;
  }
}

const baseCreds = {
  imapHost: "fixture",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "fixture",
  smtpPort: 465,
  smtpSecure: true,
  auth: { kind: "password" as const, user: "me@test.com", pass: "ok" },
};

describe("calendar routes", () => {
  let store: Store;
  let calendarStore: CalendarStore;
  let service: CalendarService;
  let app: Hono;

  beforeEach(async () => {
    const masterKey = randomBytes(32);
    store = new Store(masterKey, ":memory:");
    const mail = new MailService(store, new FixtureProvider());
    await mail.connectAccount({ alias: "work", email: "me@test.com", creds: baseCreds });
    calendarStore = new CalendarStore(store.db, masterKey);
    service = new CalendarService(calendarStore, mail, {
      caldav: new FakeProvider(),
      google: new FakeProvider(),
    });
    app = new Hono();
    registerCalendarRoutes(app, { calendarStore, calendarService: service } as unknown as Platform, {
      host: "127.0.0.1",
      port: 8765,
    });
  });

  afterEach(() => store.db.close());

  /** Far enough ahead that "slots before now are dropped" never bites. */
  const SLOTS =
    "/api/calendar/free-slots?start=2099-08-17T00:00:00.000Z&end=2099-08-19T00:00:00.000Z&durationMinutes=60";

  /* ---- time zone ------------------------------------------------------ */

  it("searches free slots in the requested zone and echoes it back", async () => {
    const res = await app.request(`${SLOTS}&timeZone=Asia/Tokyo`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slots: Array<{ start: string }>; timeZone: string };
    expect(body.timeZone).toBe("Asia/Tokyo");
    // 09:00 in Tokyo is 00:00 UTC, whatever zone the test runner sits in.
    expect(body.slots[0].start).toBe("2099-08-17T00:00:00.000Z");
  });

  it("echoes the server's own zone when no timeZone is given", async () => {
    const res = await app.request(SLOTS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { timeZone: string };
    expect(body.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("rejects an unknown zone with a 400 naming the parameter", async () => {
    const res = await app.request(`${SLOTS}&timeZone=Europe/Bruxelles`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^timeZone must be an IANA time zone id/);
  });

  it("rejects an unknown zone on meeting creation before anything is sent", async () => {
    const create = vi.spyOn(service, "createMeeting");
    const res = await app.request("/api/calendar/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Design sync",
        start: "2026-08-19T14:00:00.000Z",
        end: "2026-08-19T15:00:00.000Z",
        attendees: ["ada@acme.example"],
        timeZone: "Mars/Olympus",
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^timeZone must be an IANA time zone id/);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a meeting in the requested zone and echoes it back", async () => {
    calendarStore.addAccount({ alias: "work", email: "me@test.com", config: CALDAV });
    const res = await app.request("/api/calendar/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Design sync",
        start: "2026-08-19T14:00:00.000Z",
        end: "2026-08-19T15:00:00.000Z",
        attendees: ["ada@acme.example"],
        timeZone: "Europe/Brussels",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { timeZone: string; meeting: { id: string } };
    expect(body.timeZone).toBe("Europe/Brussels");
    expect(body.meeting.id).toBeTruthy();
  });

  /* ---- RSVPs ---------------------------------------------------------- */

  /** A stored meeting with one guest who answered and one who has not. */
  function meetingWithOneReply(): string {
    const meeting = calendarStore.addMeeting({
      uid: "uid-1@boxaide",
      title: "Design sync",
      start: "2026-08-19T14:00:00.000Z",
      end: "2026-08-19T15:00:00.000Z",
      attendees: ["ada@acme.example", "bob@acme.example"],
      location: null,
      meetingUrl: null,
      calendarAccountId: null,
      calendarId: null,
      eventId: null,
      mailAccountId: "mail-1",
    });
    calendarStore.recordRsvp({
      meetingId: meeting.id,
      email: "ada@acme.example",
      status: "accepted",
      respondedAt: "2026-08-18T09:00:00.000Z",
      source: "email",
    });
    return meeting.id;
  }

  it("lists meetings with a status per invited guest", async () => {
    meetingWithOneReply();
    const res = await app.request("/api/calendar/meetings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meetings: Array<{ attendeeStatus: Array<{ email: string; status: string }> }>;
      refreshError: string | null;
    };
    expect(body.meetings[0].attendeeStatus).toEqual([
      expect.objectContaining({ email: "ada@acme.example", status: "accepted", source: "email" }),
      expect.objectContaining({ email: "bob@acme.example", status: "needs-action" }),
    ]);
    expect(body.refreshError).toBeNull();
  });

  it("kicks off the refresh in the background without holding the list", async () => {
    meetingWithOneReply();
    // Never settles: if the handler awaited it, the request would hang here.
    const refresh = vi
      .spyOn(service, "refreshRsvps")
      .mockReturnValue(new Promise(() => {}) as Promise<{ updated: number; errors: string[] }>);
    const res = await app.request("/api/calendar/meetings");
    expect(res.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    // A second list inside the freshness window does not scan again.
    await app.request("/api/calendar/meetings");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reports a background refresh failure on the next list instead of crashing", async () => {
    meetingWithOneReply();
    const refresh = vi
      .spyOn(service, "refreshRsvps")
      .mockRejectedValue(new Error("imap down"));
    await app.request("/api/calendar/meetings");
    // Let the swallowed rejection settle before reading the stored error.
    await new Promise((resolve) => setImmediate(resolve));
    refresh.mockResolvedValue({ updated: 0, errors: [] });
    const body = (await (await app.request("/api/calendar/meetings")).json()) as {
      refreshError: string | null;
    };
    expect(body.refreshError).toBe("imap down");
  });

  it("refreshes responses on demand and returns the counts", async () => {
    const id = meetingWithOneReply();
    vi.spyOn(service, "refreshRsvps").mockImplementation(async () => {
      calendarStore.recordRsvp({
        meetingId: id,
        email: "bob@acme.example",
        status: "declined",
        respondedAt: "2026-08-18T10:00:00.000Z",
        source: "email",
      });
      return { updated: 1, errors: ["personal: token expired"] };
    });

    const res = await app.request("/api/calendar/meetings/refresh-rsvps", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 1, errors: ["personal: token expired"] });

    const listed = (await (await app.request("/api/calendar/meetings")).json()) as {
      meetings: Array<{ attendeeStatus: Array<{ status: string }> }>;
      refreshError: string | null;
    };
    expect(listed.meetings[0].attendeeStatus.map((a) => a.status)).toEqual([
      "accepted",
      "declined",
    ]);
    // The awaited pass counts as fresh, so its errors are what the list reports.
    expect(listed.refreshError).toBe("personal: token expired");
  });

  it("answers the explicit refresh with a real pass when nothing is scheduled", async () => {
    const res = await app.request("/api/calendar/meetings/refresh-rsvps", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 0, errors: [] });
  });
});
