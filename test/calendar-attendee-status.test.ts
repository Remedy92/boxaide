/**
 * Provider-side attendee status: the optional getAttendeeStatus on both
 * CalendarProvider implementations.
 *
 * These are the only calendar tests that exercise the wire. Google speaks
 * plain fetch, so globalThis.fetch is stubbed; CalDAV speaks tsdav, so the
 * DAVClient class is stubbed instead — mocking fetch under tsdav would mean
 * hand-writing PROPFIND discovery XML for no extra coverage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// vi.mock below is hoisted above these imports, so caldav.js binds the stub.
import { CalDavProvider } from "../src/calendar/caldav.js";
import { GoogleCalendarProvider } from "../src/calendar/google.js";
import type { CalDavConfig, GoogleConfig } from "../src/calendar/types.js";

/* -- CalDAV double --------------------------------------------------------
 * Hoisted so the vi.mock factory below (which runs before the module body)
 * can close over it. */
const dav = vi.hoisted(() => ({
  calendars: [] as { url: string; components?: string[] }[],
  /** objectUrls the provider asked for, per calendar url. */
  asked: [] as { calendar: string; objectUrls?: string[] }[],
  /** calendar url -> object url -> ics body. */
  objects: new Map<string, Map<string, string>>(),
  loginError: null as Error | null,
  fetchError: null as Error | null,
}));

vi.mock("tsdav", () => ({
  DAVClient: class {
    async login() {
      if (dav.loginError) throw dav.loginError;
    }
    async fetchCalendars() {
      return dav.calendars;
    }
    async fetchCalendarObjects(params: {
      calendar: { url: string };
      objectUrls?: string[];
    }) {
      if (dav.fetchError) throw dav.fetchError;
      dav.asked.push({ calendar: params.calendar.url, objectUrls: params.objectUrls });
      const inCalendar = dav.objects.get(params.calendar.url) ?? new Map<string, string>();
      const urls = params.objectUrls ?? [...inCalendar.keys()];
      return urls
        .filter((url) => inCalendar.has(url))
        .map((url) => ({ url, etag: "1", data: inCalendar.get(url) }));
    }
  },
}));

const CALDAV: CalDavConfig = {
  kind: "caldav",
  serverUrl: "https://caldav.example/dav",
  username: "me@test.com",
  password: "app-password",
};

function ics(attendees: string): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:abc123@boxaide",
    "DTSTART:20260819T140000Z",
    "ORGANIZER;CN=Me:mailto:me@test.com",
    attendees,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

beforeEach(() => {
  dav.calendars = [{ url: "https://caldav.example/cal/home/", components: ["VEVENT"] }];
  dav.asked = [];
  dav.objects = new Map();
  dav.loginError = null;
  dav.fetchError = null;
});

describe("CalDavProvider.getAttendeeStatus", () => {
  const CAL = "https://caldav.example/cal/home/";
  const EVENT = `${CAL}abc123@boxaide.ics`;

  it("reads PARTSTAT off the stored object", async () => {
    dav.objects.set(
      CAL,
      new Map([
        [
          EVENT,
          ics(
            [
              "ATTENDEE;CN=Ada;PARTSTAT=ACCEPTED:mailto:Ada@Acme.example",
              "ATTENDEE;PARTSTAT=DECLINED:mailto:bob@acme.example",
              "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:cy@acme.example",
            ].join("\r\n"),
          ),
        ],
      ]),
    );
    const out = await new CalDavProvider().getAttendeeStatus(CALDAV, CAL, EVENT);
    expect(out).toEqual([
      // Casing is preserved; the store compares case-insensitively.
      { email: "Ada@Acme.example", status: "accepted" },
      { email: "bob@acme.example", status: "declined" },
      { email: "cy@acme.example", status: "needs-action" },
    ]);
    // Asked for exactly the one object, in the calendar it was told about.
    expect(dav.asked).toEqual([{ calendar: CAL, objectUrls: [EVENT] }]);
  });

  it("treats a missing PARTSTAT as still open", async () => {
    dav.objects.set(CAL, new Map([[EVENT, ics("ATTENDEE:mailto:ada@acme.example")]]));
    const out = await new CalDavProvider().getAttendeeStatus(CALDAV, CAL, EVENT);
    expect(out).toEqual([{ email: "ada@acme.example", status: "needs-action" }]);
  });

  it("returns empty when the server does not return the object", async () => {
    const out = await new CalDavProvider().getAttendeeStatus(CALDAV, CAL, EVENT);
    expect(out).toEqual([]);
  });

  it("returns empty rather than throwing on a malformed object", async () => {
    dav.objects.set(CAL, new Map([[EVENT, "this is not a calendar at all"]]));
    const out = await new CalDavProvider().getAttendeeStatus(CALDAV, CAL, EVENT);
    expect(out).toEqual([]);
  });

  it("falls back to the other collections when the calendar url no longer matches", async () => {
    dav.calendars = [
      { url: "https://caldav.example/cal/other/", components: ["VEVENT"] },
      { url: CAL, components: ["VEVENT"] },
    ];
    dav.objects.set(CAL, new Map([[EVENT, ics("ATTENDEE;PARTSTAT=TENTATIVE:mailto:ada@acme.example")]]));
    const out = await new CalDavProvider().getAttendeeStatus(
      CALDAV,
      "https://caldav.example/cal/stale/",
      EVENT,
    );
    expect(out).toEqual([{ email: "ada@acme.example", status: "tentative" }]);
    expect(dav.asked.map((a) => a.calendar)).toEqual([
      "https://caldav.example/cal/other/",
      CAL,
    ]);
  });

  it("propagates an auth failure instead of reporting nobody answered", async () => {
    dav.loginError = new Error("HTTP 401 Unauthorized");
    await expect(
      new CalDavProvider().getAttendeeStatus(CALDAV, CAL, EVENT),
    ).rejects.toThrow(/401/);
  });

  it("propagates a REPORT failure", async () => {
    dav.fetchError = new Error("socket hang up");
    await expect(
      new CalDavProvider().getAttendeeStatus(CALDAV, CAL, EVENT),
    ).rejects.toThrow(/socket hang up/);
  });
});

/* -- Google --------------------------------------------------------------- */

/** A fresh refresh token per test: google.ts caches access tokens by it. */
let tokenSeq = 0;
function googleConfig(): GoogleConfig {
  tokenSeq++;
  return {
    kind: "google",
    clientId: "client",
    clientSecret: "secret",
    refreshToken: `refresh-${tokenSeq}`,
    email: "me@test.com",
  };
}

type Call = { url: string; method: string };

/**
 * Stub fetch: answers the token endpoint, then hands `eventBody` (or an HTTP
 * error) to the calendar call. Returns the call log so the test can assert
 * which endpoint was hit.
 */
function stubGoogle(opts: { event?: unknown; status?: number; body?: string }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const status = opts.status ?? 200;
      if (status !== 200) return new Response(opts.body ?? "nope", { status });
      return new Response(JSON.stringify(opts.event ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GoogleCalendarProvider.getAttendeeStatus", () => {
  it("normalizes responseStatus and hits events.get for the one event", async () => {
    const calls = stubGoogle({
      event: {
        id: "evt1",
        attendees: [
          { email: "Ada@Acme.example", responseStatus: "accepted" },
          { email: "bob@acme.example", responseStatus: "declined" },
          { email: "cy@acme.example", responseStatus: "tentative" },
          // Google's camelCase spelling must fold onto our hyphenated key.
          { email: "dee@acme.example", responseStatus: "needsAction" },
        ],
      },
    });
    const out = await new GoogleCalendarProvider().getAttendeeStatus(
      googleConfig(),
      "primary",
      "evt1",
    );
    expect(out).toEqual([
      { email: "Ada@Acme.example", status: "accepted" },
      { email: "bob@acme.example", status: "declined" },
      { email: "cy@acme.example", status: "tentative" },
      { email: "dee@acme.example", status: "needs-action" },
    ]);
    expect(calls.at(-1)).toEqual({
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt1",
      method: "GET",
    });
  });

  it("url-encodes a calendar id that is an address", async () => {
    const calls = stubGoogle({ event: { id: "evt1" } });
    await new GoogleCalendarProvider().getAttendeeStatus(
      googleConfig(),
      "me@test.com",
      "evt 1",
    );
    expect(calls.at(-1)?.url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/me%40test.com/events/evt%201",
    );
  });

  it("drops resource rows that carry no email, and unknown statuses stay open", async () => {
    stubGoogle({
      event: {
        id: "evt1",
        attendees: [
          { responseStatus: "accepted" },
          { email: "room-a@resource.calendar.google.com", responseStatus: "wat" },
        ],
      },
    });
    const out = await new GoogleCalendarProvider().getAttendeeStatus(
      googleConfig(),
      "primary",
      "evt1",
    );
    expect(out).toEqual([
      { email: "room-a@resource.calendar.google.com", status: "needs-action" },
    ]);
  });

  it("returns empty for an event with no attendees", async () => {
    stubGoogle({ event: { id: "evt1" } });
    const out = await new GoogleCalendarProvider().getAttendeeStatus(
      googleConfig(),
      "primary",
      "evt1",
    );
    expect(out).toEqual([]);
  });

  it("propagates an HTTP error instead of reporting nobody answered", async () => {
    stubGoogle({ status: 401, body: "Invalid Credentials" });
    await expect(
      new GoogleCalendarProvider().getAttendeeStatus(googleConfig(), "primary", "evt1"),
    ).rejects.toThrow(/Google Calendar HTTP 401/);
  });

  it("propagates a 404 for an event that is gone", async () => {
    stubGoogle({ status: 404, body: "Not Found" });
    await expect(
      new GoogleCalendarProvider().getAttendeeStatus(googleConfig(), "primary", "gone"),
    ).rejects.toThrow(/HTTP 404/);
  });
});
